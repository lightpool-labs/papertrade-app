// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::sync::Arc;

use crate::config::Config;
use crate::hyperliquid::HyperliquidClient;
use crate::indexer::IndexerClient;
use crate::markets::MarketRegistry;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub indexer: IndexerClient,
    pub hl: HyperliquidClient,
    pub markets: Arc<MarketRegistry>,
    pub hl_ws_url: Arc<String>,
}

impl AppState {
    pub fn new(config: Config, markets: MarketRegistry) -> Self {
        let hl_ws_url = Arc::new(config.hyperliquid_ws_url.clone());
        let indexer = IndexerClient::new(config.indexer_url.clone());
        let hl = HyperliquidClient::new(config.hyperliquid_info_url.clone());
        Self {
            config,
            indexer,
            hl,
            markets: Arc::new(markets),
            hl_ws_url,
        }
    }
}
