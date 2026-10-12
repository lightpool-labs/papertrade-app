// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub indexer_url: String,
    pub markets_path: PathBuf,
    pub hyperliquid_info_url: String,
    pub hyperliquid_ws_url: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3001),
            indexer_url: env::var("INDEXER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3002".into()),
            markets_path: env::var("MARKETS_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("../data/markets.json")),
            hyperliquid_info_url: env::var("HYPERLIQUID_INFO_URL")
                .unwrap_or_else(|_| "https://api.hyperliquid.xyz/info".into()),
            hyperliquid_ws_url: env::var("HYPERLIQUID_WS_URL")
                .unwrap_or_else(|_| "wss://api.hyperliquid.xyz/ws".into()),
        }
    }
}
