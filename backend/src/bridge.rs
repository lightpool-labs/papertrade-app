// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::fs;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
struct BridgeFile {
    evm_chain_id: u64,
    evm_bridge: String,
    tokens: Vec<BridgeTokenFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgeTokenFile {
    symbol: String,
    evm: String,
    lp: String,
    inbound: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeToken {
    pub symbol: String,
    pub evm: String,
    pub lp: String,
    pub inbound: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeConfigResponse {
    pub configured: bool,
    pub evm_chain_id: u64,
    pub evm_rpc: String,
    pub evm_bridge: String,
    pub tokens: Vec<BridgeToken>,
}

pub fn load_bridge(state: &AppState) -> AppResult<BridgeConfigResponse> {
    let path = &state.config.bridge_state_path;
    if !path.exists() {
        return Ok(BridgeConfigResponse {
            configured: false,
            evm_chain_id: 0,
            evm_rpc: state.config.evm_rpc_url.clone(),
            evm_bridge: String::new(),
            tokens: Vec::new(),
        });
    }
    let raw = fs::read_to_string(path).map_err(|e| {
        AppError::Internal(format!("failed to read {}: {e}", path.display()))
    })?;
    let file: BridgeFile = serde_json::from_str(&raw).map_err(|e| {
        AppError::Internal(format!("invalid eth-bridge.json: {e}"))
    })?;
    Ok(BridgeConfigResponse {
        configured: true,
        evm_chain_id: file.evm_chain_id,
        evm_rpc: state.config.evm_rpc_url.clone(),
        evm_bridge: file.evm_bridge,
        tokens: file
            .tokens
            .into_iter()
            .map(|token| BridgeToken {
                symbol: token.symbol,
                evm: token.evm,
                lp: token.lp,
                inbound: token.inbound,
            })
            .collect(),
    })
}

pub async fn get_bridge(State(state): State<AppState>) -> AppResult<Json<BridgeConfigResponse>> {
    Ok(Json(load_bridge(&state)?))
}
