// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// Anvil / Hardhat #0 — paper market admin / keeper (not the default trader).
pub const DEFAULT_KEEPER_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

#[derive(Debug, Clone, Deserialize)]
pub struct MarketsFile {
    #[serde(default)]
    pub paper_market: String,
    pub instruments: Vec<InstrumentRecord>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InstrumentRecord {
    pub id: u32,
    pub slug: String,
    #[serde(default)]
    pub price_market: String,
    #[serde(default)]
    pub retired: bool,
}

#[derive(Debug, Clone)]
pub struct KeeperConfig {
    pub indexer_url: String,
    pub markets_path: PathBuf,
    pub private_key: String,
    pub poll_interval: Duration,
    /// Slow HTTP reconcile for liqd open-book (event path is WS-driven).
    pub liqd_reconcile_interval: Duration,
    pub enable_liqd: bool,
    pub enable_harvest: bool,
    pub enable_push_fees: bool,
    pub page_limit: u32,
    /// Bound for each harvest tx (chain caps at 64).
    pub harvest_max_entries: u32,
}

impl KeeperConfig {
    pub fn from_env() -> Result<Self> {
        let markets_path = env::var("MARKETS_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("../data/markets.json"));
        Ok(Self {
            indexer_url: env::var("INDEXER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3002".into()),
            markets_path,
            private_key: env::var("PAPER_KEEPER_KEY")
                .or_else(|_| env::var("PAPER_SIGNER_KEY"))
                .unwrap_or_else(|_| DEFAULT_KEEPER_KEY.to_string()),
            poll_interval: Duration::from_millis(
                env::var("PAPER_KEEPER_POLL_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(2_000),
            ),
            liqd_reconcile_interval: Duration::from_millis(
                env::var("PAPER_KEEPER_LIQD_RECONCILE_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(60_000),
            ),
            enable_liqd: env_flag("PAPER_KEEPER_LIQD", true),
            enable_harvest: env_flag("PAPER_KEEPER_HARVEST", true),
            enable_push_fees: env_flag("PAPER_KEEPER_PUSH_FEES", true),
            page_limit: env::var("PAPER_KEEPER_PAGE_LIMIT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(200)
                .clamp(1, 500),
            harvest_max_entries: env::var("PAPER_KEEPER_HARVEST_MAX")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(64)
                .clamp(1, 64),
        })
    }

    pub fn load_markets(&self) -> Result<MarketsFile> {
        load_markets_file(&self.markets_path)
    }
}

fn env_flag(name: &str, default: bool) -> bool {
    match env::var(name) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

pub fn load_markets_file(path: &Path) -> Result<MarketsFile> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read markets file {}", path.display()))?;
    let file: MarketsFile = serde_json::from_str(&raw)
        .with_context(|| format!("parse markets file {}", path.display()))?;
    if file.paper_market.trim().is_empty() {
        bail!("markets.json missing paper_market");
    }
    Ok(file)
}
