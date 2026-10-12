// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use lightpool_sdk::{
    extract_paper_closed, extract_paper_opened, parse_token_contract, ActionBuilder,
    PaperCloseParams, PaperOpenParams, Signer, TransactionBuilder, TOKEN_SCALE,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Anvil / Hardhat account #0 — same key paper-bootstrap funds.
const DEFAULT_PAPER_SIGNER_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

#[derive(Debug, Deserialize)]
pub struct OpenPaperRequest {
    pub market: String,
    pub instrument: u32,
    pub is_long: bool,
    /// Human USDC margin (e.g. 100 → 100 * TOKEN_SCALE on chain).
    pub margin: f64,
    pub leverage: u64,
    #[serde(default)]
    pub fund_from_queued: bool,
}

#[derive(Debug, Serialize)]
pub struct OpenPaperResponse {
    pub digest: String,
    pub block_num: u64,
    pub status: String,
    pub position: Option<u64>,
    pub owner: String,
}

fn load_signer(raw: &str) -> AppResult<Signer> {
    let hex_body = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(hex_body)
        .map_err(|e| AppError::Internal(format!("invalid PAPER_SIGNER_KEY hex: {e}")))?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal("PAPER_SIGNER_KEY must be 32 bytes".into()))?;
    Signer::from_secret_key_bytes(&key)
        .map_err(|e| AppError::Internal(format!("load paper signer: {e}")))
}

pub fn paper_signer() -> AppResult<Signer> {
    let key = std::env::var("PAPER_SIGNER_KEY")
        .unwrap_or_else(|_| DEFAULT_PAPER_SIGNER_KEY.to_string());
    load_signer(&key)
}

pub async fn open_paper(state: &AppState, req: OpenPaperRequest) -> AppResult<OpenPaperResponse> {
    let market_raw = req.market.trim();
    if market_raw.is_empty() {
        return Err(AppError::BadRequest("market is required".into()));
    }
    if !req.margin.is_finite() || req.margin <= 0.0 {
        return Err(AppError::BadRequest("margin must be a positive number".into()));
    }
    if req.leverage == 0 {
        return Err(AppError::BadRequest("leverage must be >= 1".into()));
    }

    let instrument = state
        .markets
        .list()
        .into_iter()
        .find(|m| m.id == req.instrument && m.paper_market == market_raw)
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "instrument {} not found for market {market_raw}",
                req.instrument
            ))
        })?;
    if req.leverage > instrument.max_leverage {
        return Err(AppError::BadRequest(format!(
            "leverage {} exceeds max {}",
            req.leverage, instrument.max_leverage
        )));
    }

    let margin_raw = (req.margin * TOKEN_SCALE as f64).round() as u64;
    if margin_raw == 0 {
        return Err(AppError::BadRequest("margin too small after scale".into()));
    }
    if margin_raw < instrument.min_margin {
        return Err(AppError::BadRequest(format!(
            "margin below min_margin ({})",
            instrument.min_margin
        )));
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| AppError::BadRequest(format!("invalid paper market: {e}")))?;
    let signer = paper_signer()?;
    let owner = signer.address();

    let action = ActionBuilder::open_paper(
        paper,
        PaperOpenParams {
            instrument: req.instrument,
            is_long: req.is_long,
            margin: margin_raw,
            leverage: req.leverage,
            fund_from_queued: req.fund_from_queued,
        },
    )
    .map_err(|e| AppError::Internal(format!("build open_paper: {e}")))?;

    let tx = TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(&signer)
        .map_err(|e| AppError::Internal(format!("sign open_paper: {e}")))?;

    let result = state.indexer.submit_transaction(tx).await?;
    if !result.receipt.is_success() {
        return Err(AppError::BadRequest(format!(
            "open_paper failed: {:?}",
            result.receipt.status
        )));
    }

    let position = extract_paper_opened(&result.receipt).map(|e| e.position);

    Ok(OpenPaperResponse {
        digest: result.digest,
        block_num: result.block_num,
        status: "ok".into(),
        position,
        owner: owner.to_string(),
    })
}

#[derive(Debug, Deserialize)]
pub struct ClosePaperRequest {
    pub market: String,
    pub position: u64,
}

#[derive(Debug, Serialize)]
pub struct ClosePaperResponse {
    pub digest: String,
    pub block_num: u64,
    pub status: String,
    pub position: u64,
    pub owner: String,
}

pub async fn close_paper(
    state: &AppState,
    req: ClosePaperRequest,
) -> AppResult<ClosePaperResponse> {
    let market_raw = req.market.trim();
    if market_raw.is_empty() {
        return Err(AppError::BadRequest("market is required".into()));
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| AppError::BadRequest(format!("invalid paper market: {e}")))?;
    let signer = paper_signer()?;
    let owner = signer.address();

    let action = ActionBuilder::close_paper(
        paper,
        PaperCloseParams {
            position: req.position,
        },
    )
    .map_err(|e| AppError::Internal(format!("build close_paper: {e}")))?;

    let tx = TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(&signer)
        .map_err(|e| AppError::Internal(format!("sign close_paper: {e}")))?;

    let result = state.indexer.submit_transaction(tx).await?;
    if !result.receipt.is_success() {
        return Err(AppError::BadRequest(format!(
            "close_paper failed: {:?}",
            result.receipt.status
        )));
    }

    let _ = extract_paper_closed(&result.receipt);

    Ok(ClosePaperResponse {
        digest: result.digest,
        block_num: result.block_num,
        status: "ok".into(),
        position: req.position,
        owner: owner.to_string(),
    })
}
