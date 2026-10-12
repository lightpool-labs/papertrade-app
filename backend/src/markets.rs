// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::fs;
use std::path::Path;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentRecord {
    pub id: u32,
    pub slug: String,
    pub name: String,
    pub hl_symbol: String,
    #[serde(default)]
    pub price_market: String,
    pub max_leverage: u64,
    pub min_margin: u64,
    #[serde(default)]
    pub retired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketsFile {
    #[serde(default)]
    pub paper_market: String,
    #[serde(default = "default_quote_decimals")]
    pub quote_decimals: u32,
    #[serde(default = "default_liq_buffer_ppm")]
    pub liq_buffer_ppm: u64,
    pub instruments: Vec<InstrumentRecord>,
}

fn default_quote_decimals() -> u32 {
    6
}

fn default_liq_buffer_ppm() -> u64 {
    500
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketView {
    pub paper_market: String,
    pub quote_decimals: u32,
    pub liq_buffer_ppm: u64,
    pub id: u32,
    pub slug: String,
    pub name: String,
    pub hl_symbol: String,
    pub price_market: String,
    pub max_leverage: u64,
    pub min_margin: u64,
    pub retired: bool,
}

pub struct MarketRegistry {
    inner: RwLock<MarketsFile>,
}

impl MarketRegistry {
    pub fn load(path: &Path) -> AppResult<Self> {
        let raw = fs::read_to_string(path).map_err(|e| {
            AppError::Internal(format!("read markets file {}: {e}", path.display()))
        })?;
        let file: MarketsFile = serde_json::from_str(&raw)
            .map_err(|e| AppError::Internal(format!("parse markets file: {e}")))?;
        Ok(Self {
            inner: RwLock::new(file),
        })
    }

    pub fn list(&self) -> Vec<MarketView> {
        let file = self.inner.read().expect("markets lock");
        file.instruments
            .iter()
            .filter(|i| !i.retired)
            .map(|i| MarketView {
                paper_market: file.paper_market.clone(),
                quote_decimals: file.quote_decimals,
                liq_buffer_ppm: file.liq_buffer_ppm,
                id: i.id,
                slug: i.slug.clone(),
                name: i.name.clone(),
                hl_symbol: i.hl_symbol.clone(),
                price_market: i.price_market.clone(),
                max_leverage: i.max_leverage,
                min_margin: i.min_margin,
                retired: i.retired,
            })
            .collect()
    }

    pub fn get_by_slug(&self, slug: &str) -> AppResult<MarketView> {
        let needle = slug.trim().to_ascii_lowercase();
        self.list()
            .into_iter()
            .find(|m| m.slug.to_ascii_lowercase() == needle)
            .ok_or_else(|| AppError::NotFound(format!("instrument '{slug}' not found")))
    }

    pub fn config_snapshot(&self) -> MarketsFile {
        self.inner.read().expect("markets lock").clone()
    }
}
