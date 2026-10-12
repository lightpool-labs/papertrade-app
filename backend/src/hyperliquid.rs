// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};

pub const HL_DEX_PREFIX: &str = "xyz:";

const DEFAULT_LIMIT: u64 = 300;
const MAX_LIMIT: u64 = 1000;

#[derive(Clone)]
pub struct HyperliquidClient {
    client: Client,
    info_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    pub time: u64,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
}

#[derive(Debug, Serialize)]
pub struct BarsResponse {
    pub symbol: String,
    pub hl_coin: String,
    pub interval: String,
    pub bars: Vec<Bar>,
}

#[derive(Debug, Serialize)]
pub struct MarkResponse {
    pub slug: String,
    pub symbol: String,
    pub hl_coin: String,
    pub mark: String,
    pub source: &'static str,
}

#[derive(Debug, Deserialize)]
struct HlCandle {
    t: u64,
    o: Value,
    h: Value,
    l: Value,
    c: Value,
    v: Value,
}

impl HyperliquidClient {
    pub fn new(info_url: impl Into<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("failed to build Hyperliquid HTTP client");
        Self {
            client,
            info_url: info_url.into(),
        }
    }

    pub async fn candle_snapshot(
        &self,
        symbol: &str,
        interval: &str,
        limit: Option<u64>,
        from_ms: Option<u64>,
        to_ms: Option<u64>,
    ) -> AppResult<BarsResponse> {
        let symbol = normalize_symbol(symbol)?;
        let interval = normalize_interval(interval)?;
        let hl_coin = hl_coin_for_symbol(&symbol);

        let end_ms = to_ms.unwrap_or_else(now_ms);
        let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let start_ms = from_ms.unwrap_or_else(|| {
            end_ms.saturating_sub(limit.saturating_mul(interval_ms(interval)))
        });

        let body = json!({
            "type": "candleSnapshot",
            "req": {
                "coin": hl_coin,
                "interval": interval,
                "startTime": start_ms,
                "endTime": end_ms,
            }
        });

        let response = self
            .client
            .post(&self.info_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("Hyperliquid info request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "Hyperliquid info HTTP {status}: {text}"
            )));
        }

        let value: Value = response
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("decode Hyperliquid candles: {e}")))?;

        if value.is_null() {
            return Err(AppError::NotFound(format!(
                "no Hyperliquid candles for {hl_coin}"
            )));
        }

        let candles: Vec<HlCandle> = serde_json::from_value(value).map_err(|e| {
            AppError::Internal(format!("parse Hyperliquid candleSnapshot: {e}"))
        })?;

        let mut bars: Vec<Bar> = candles
            .into_iter()
            .map(|c| Bar {
                time: c.t / 1000,
                open: value_to_string(&c.o),
                high: value_to_string(&c.h),
                low: value_to_string(&c.l),
                close: value_to_string(&c.c),
                volume: value_to_string(&c.v),
            })
            .collect();

        bars.sort_by_key(|b| b.time);
        bars.dedup_by_key(|b| b.time);

        Ok(BarsResponse {
            symbol,
            hl_coin,
            interval: interval.to_string(),
            bars,
        })
    }

    pub async fn latest_mark(&self, symbol: &str) -> AppResult<String> {
        let bars = self
            .candle_snapshot(symbol, "1m", Some(2), None, None)
            .await?;
        bars.bars
            .last()
            .map(|b| b.close.clone())
            .ok_or_else(|| AppError::NotFound(format!("no mark for {symbol}")))
    }
}

pub fn hl_coin_for_symbol(symbol: &str) -> String {
    format!("{HL_DEX_PREFIX}{symbol}")
}

pub fn normalize_symbol(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    let symbol = trimmed
        .strip_prefix("xyz:")
        .or_else(|| trimmed.strip_prefix("XYZ:"))
        .unwrap_or(trimmed)
        .split('/')
        .next()
        .unwrap_or("")
        .trim()
        .to_uppercase();

    if symbol.is_empty() {
        return Err(AppError::BadRequest("symbol is required".into()));
    }
    if !symbol
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(AppError::BadRequest(format!("invalid symbol '{raw}'")));
    }
    Ok(symbol)
}

pub fn normalize_interval(raw: &str) -> AppResult<&'static str> {
    match raw.trim() {
        "1m" => Ok("1m"),
        "5m" => Ok("5m"),
        "15m" => Ok("15m"),
        "1h" => Ok("1h"),
        other => Err(AppError::BadRequest(format!(
            "unsupported interval '{other}' (use 1m, 5m, 15m, 1h)"
        ))),
    }
}

fn interval_ms(interval: &str) -> u64 {
    match interval {
        "1m" => 60_000,
        "5m" => 300_000,
        "15m" => 900_000,
        "1h" => 3_600_000,
        _ => 60_000,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

pub fn bar_from_hl_json(data: &Value) -> Option<Bar> {
    let obj = if data.is_array() {
        data.as_array()?.first()?
    } else {
        data
    };

    let t = obj.get("t")?.as_u64()?;
    Some(Bar {
        time: t / 1000,
        open: value_to_string(obj.get("o")?),
        high: value_to_string(obj.get("h")?),
        low: value_to_string(obj.get("l")?),
        close: value_to_string(obj.get("c")?),
        volume: value_to_string(obj.get("v").unwrap_or(&Value::String("0".into()))),
    })
}
