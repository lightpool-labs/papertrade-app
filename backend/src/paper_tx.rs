// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Prepare paper actions for client/agent signing (no server-side trader key).

use axum::extract::State;
use axum::Json;
use lightpool_sdk::{
    parse_token_contract, Action, ActionBuilder, Address, PaperClaimParams, PaperCloseParams,
    PaperOpenParams, PaperStakeParams, PaperUnstakeParams, TransactionBuilder, TOKEN_SCALE,
};
use serde::Deserialize;
use std::str::FromStr;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::user_tx::{prepared_from_tx, PreparedTxResponse};

#[derive(Debug, Deserialize)]
pub struct PrepareOpenPaperBody {
    pub user: String,
    pub agent: String,
    pub market: String,
    pub instrument: u32,
    pub is_long: bool,
    /// Human USDC margin (e.g. 100 → 100 * TOKEN_SCALE on chain).
    pub margin: f64,
    pub leverage: u64,
    #[serde(default)]
    pub fund_from_queued: bool,
}

#[derive(Debug, Deserialize)]
pub struct PrepareClosePaperBody {
    pub user: String,
    pub agent: String,
    pub market: String,
    pub position: u64,
}

#[derive(Debug, Deserialize)]
pub struct PrepareStakePaperBody {
    pub user: String,
    pub agent: String,
    pub market: String,
    /// Human PAPER amount (scaled by TOKEN_SCALE on chain).
    pub amount: f64,
}

#[derive(Debug, Deserialize)]
pub struct PrepareUnstakePaperBody {
    pub user: String,
    pub agent: String,
    pub market: String,
    pub amount: f64,
}

#[derive(Debug, Deserialize)]
pub struct PrepareClaimPaperBody {
    pub user: String,
    pub agent: String,
    pub market: String,
}

fn parse_address(raw: &str) -> AppResult<Address> {
    Address::from_str(raw.trim())
        .map_err(|e| AppError::BadRequest(format!("invalid address: {e}")))
}

fn agent_tx(user: Address, agent: Address, action: Action) -> AppResult<PreparedTxResponse> {
    let tx = TransactionBuilder::new()
        .sender(agent)
        .account(user)
        .expiration(u64::MAX)
        .add_action(action)
        .build()
        .map_err(|e| AppError::Internal(format!("build agent tx: {e}")))?;
    prepared_from_tx(tx, Some("native"))
}

pub async fn prepare_open_paper(
    State(state): State<AppState>,
    Json(req): Json<PrepareOpenPaperBody>,
) -> AppResult<Json<PreparedTxResponse>> {
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
    let user = parse_address(&req.user)?;
    let agent = parse_address(&req.agent)?;

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

    Ok(Json(agent_tx(user, agent, action)?))
}

pub async fn prepare_close_paper(
    Json(req): Json<PrepareClosePaperBody>,
) -> AppResult<Json<PreparedTxResponse>> {
    let market_raw = req.market.trim();
    if market_raw.is_empty() {
        return Err(AppError::BadRequest("market is required".into()));
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| AppError::BadRequest(format!("invalid paper market: {e}")))?;
    let user = parse_address(&req.user)?;
    let agent = parse_address(&req.agent)?;

    let action = ActionBuilder::close_paper(
        paper,
        PaperCloseParams {
            position: req.position,
        },
    )
    .map_err(|e| AppError::Internal(format!("build close_paper: {e}")))?;

    Ok(Json(agent_tx(user, agent, action)?))
}

pub async fn prepare_stake_paper(
    Json(req): Json<PrepareStakePaperBody>,
) -> AppResult<Json<PreparedTxResponse>> {
    let market_raw = req.market.trim();
    if market_raw.is_empty() {
        return Err(AppError::BadRequest("market is required".into()));
    }
    if !req.amount.is_finite() || req.amount <= 0.0 {
        return Err(AppError::BadRequest("amount must be a positive number".into()));
    }
    let amount_raw = (req.amount * TOKEN_SCALE as f64).round() as u64;
    if amount_raw == 0 {
        return Err(AppError::BadRequest("amount too small after scale".into()));
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| AppError::BadRequest(format!("invalid paper market: {e}")))?;
    let user = parse_address(&req.user)?;
    let agent = parse_address(&req.agent)?;

    let action = ActionBuilder::stake_paper(paper, PaperStakeParams { amount: amount_raw })
        .map_err(|e| AppError::Internal(format!("build stake_paper: {e}")))?;

    Ok(Json(agent_tx(user, agent, action)?))
}

pub async fn prepare_unstake_paper(
    Json(req): Json<PrepareUnstakePaperBody>,
) -> AppResult<Json<PreparedTxResponse>> {
    let market_raw = req.market.trim();
    if market_raw.is_empty() {
        return Err(AppError::BadRequest("market is required".into()));
    }
    if !req.amount.is_finite() || req.amount <= 0.0 {
        return Err(AppError::BadRequest("amount must be a positive number".into()));
    }
    let amount_raw = (req.amount * TOKEN_SCALE as f64).round() as u64;
    if amount_raw == 0 {
        return Err(AppError::BadRequest("amount too small after scale".into()));
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| AppError::BadRequest(format!("invalid paper market: {e}")))?;
    let user = parse_address(&req.user)?;
    let agent = parse_address(&req.agent)?;

    let action =
        ActionBuilder::unstake_paper(paper, PaperUnstakeParams { amount: amount_raw })
            .map_err(|e| AppError::Internal(format!("build unstake_paper: {e}")))?;

    Ok(Json(agent_tx(user, agent, action)?))
}

pub async fn prepare_claim_paper(
    Json(req): Json<PrepareClaimPaperBody>,
) -> AppResult<Json<PreparedTxResponse>> {
    let market_raw = req.market.trim();
    if market_raw.is_empty() {
        return Err(AppError::BadRequest("market is required".into()));
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| AppError::BadRequest(format!("invalid paper market: {e}")))?;
    let user = parse_address(&req.user)?;
    let agent = parse_address(&req.agent)?;

    let action = ActionBuilder::claim_paper(paper, PaperClaimParams {})
        .map_err(|e| AppError::Internal(format!("build claim_paper: {e}")))?;

    Ok(Json(agent_tx(user, agent, action)?))
}
