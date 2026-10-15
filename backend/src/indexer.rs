// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use lightpool_sdk::lightpool_types::SignedTransaction;
use lightpool_sdk::TransactionReceipt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexerOracleMark {
    pub spot_market: String,
    pub round: u64,
    pub oracle_price: String,
    pub mark_price: String,
    pub oracle_price_raw: u64,
    pub mark_price_raw: u64,
    pub block_num: u64,
    #[serde(default)]
    pub ts_ms: u64,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexerOracleHistoryTick {
    pub t: u64,
    pub mark_price: String,
    pub oracle_price: String,
    pub mark_price_raw: u64,
    pub oracle_price_raw: u64,
    pub round: u64,
    pub block_num: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexerOracleHistory {
    pub spot_market: String,
    pub ticks: Vec<IndexerOracleHistoryTick>,
}

fn urlencoding_encode(raw: &str) -> String {
    // Query-safe encoding for hex addresses / 0x… contract ids.
    let mut out = String::with_capacity(raw.len() * 3);
    for b in raw.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Debug, Deserialize)]
struct SubmitTxResponse {
    digest: String,
    #[serde(default)]
    block_num: u64,
    receipt: TransactionReceipt,
}

#[derive(Debug, Clone)]
pub struct SubmitResult {
    pub digest: String,
    pub block_num: u64,
    pub receipt: TransactionReceipt,
}

#[derive(Clone)]
pub struct IndexerClient {
    client: Client,
    base_url: String,
}

impl IndexerClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(0)
            .build()
            .expect("failed to build indexer HTTP client");
        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    pub async fn health_ok(&self) -> bool {
        let url = format!("{}/api/health/health", self.base_url);
        match self.client.get(&url).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    /// On-chain oracle/mark from indexed `oracle_committed` events.
    pub async fn get_oracle_mark(&self, spot_market: &str) -> AppResult<IndexerOracleMark> {
        let url = format!(
            "{}/api/spot/{}/oracle",
            self.base_url,
            urlencoding_encode(spot_market)
        );
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("indexer oracle mark failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer oracle HTTP {status}"),
            };
            if status.as_u16() == 404 {
                return Err(AppError::NotFound(message));
            }
            return Err(AppError::Internal(message));
        }
        response
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("decode oracle mark: {e}")))
    }

    /// Recent indexed oracle/mark ticks for tick-chart seed.
    pub async fn get_oracle_mark_history(
        &self,
        spot_market: &str,
        from_ms: Option<u64>,
        limit: Option<usize>,
    ) -> AppResult<IndexerOracleHistory> {
        let mut url = format!(
            "{}/api/spot/{}/oracle/history?",
            self.base_url,
            urlencoding_encode(spot_market)
        );
        let mut first = true;
        if let Some(from_ms) = from_ms {
            url.push_str(&format!("from_ms={from_ms}"));
            first = false;
        }
        if let Some(limit) = limit {
            if !first {
                url.push('&');
            }
            url.push_str(&format!("limit={limit}"));
        }
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("indexer oracle history failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer oracle history HTTP {status}"),
            };
            if status.as_u16() == 404 {
                return Err(AppError::NotFound(message));
            }
            return Err(AppError::Internal(message));
        }
        response
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("decode oracle history: {e}")))
    }

    pub async fn get_paper_account(
        &self,
        market: &str,
        address: &str,
    ) -> AppResult<serde_json::Value> {
        let url = format!(
            "{}/api/paper/account?market={}&address={}",
            self.base_url,
            urlencoding_encode(market),
            urlencoding_encode(address)
        );
        self.get_json(&url).await
    }

    pub async fn get_paper_positions(
        &self,
        owner: &str,
        market: Option<&str>,
        status: &str,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!(
            "{}/api/paper/positions?owner={}&status={}",
            self.base_url,
            urlencoding_encode(owner),
            urlencoding_encode(status)
        );
        if let Some(m) = market.filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&market={}", urlencoding_encode(m)));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_history(
        &self,
        owner: &str,
        market: Option<&str>,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!(
            "{}/api/paper/history?owner={}",
            self.base_url,
            urlencoding_encode(owner)
        );
        if let Some(m) = market.filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&market={}", urlencoding_encode(m)));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_house(&self, market: &str) -> AppResult<serde_json::Value> {
        let url = format!(
            "{}/api/paper/house?market={}",
            self.base_url,
            urlencoding_encode(market)
        );
        self.get_json(&url).await
    }

    pub async fn get_paper_stake(
        &self,
        market: &str,
        address: &str,
    ) -> AppResult<serde_json::Value> {
        let url = format!(
            "{}/api/paper/stake?market={}&address={}",
            self.base_url,
            urlencoding_encode(market),
            urlencoding_encode(address)
        );
        self.get_json(&url).await
    }

    pub async fn get_paper_stake_history(
        &self,
        market: &str,
        from_ms: Option<u64>,
        limit: Option<usize>,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!(
            "{}/api/paper/stake/history?market={}",
            self.base_url,
            urlencoding_encode(market)
        );
        if let Some(from_ms) = from_ms {
            url.push_str(&format!("&from_ms={from_ms}"));
        }
        if let Some(limit) = limit {
            url.push_str(&format!("&limit={limit}"));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_activity(
        &self,
        market: Option<&str>,
        limit: Option<usize>,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!("{}/api/paper/activity", self.base_url);
        let mut q = Vec::new();
        if let Some(m) = market.filter(|s| !s.trim().is_empty()) {
            q.push(format!("market={}", urlencoding_encode(m)));
        }
        if let Some(limit) = limit {
            q.push(format!("limit={limit}"));
        }
        if !q.is_empty() {
            url.push('?');
            url.push_str(&q.join("&"));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_oi_history(
        &self,
        market: &str,
        instrument: u32,
        from_ms: Option<u64>,
        limit: Option<usize>,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!(
            "{}/api/paper/house/oi/history?market={}&instrument={instrument}",
            self.base_url,
            urlencoding_encode(market)
        );
        if let Some(from_ms) = from_ms {
            url.push_str(&format!("&from_ms={from_ms}"));
        }
        if let Some(limit) = limit {
            url.push_str(&format!("&limit={limit}"));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_house_history(
        &self,
        market: &str,
        from_ms: Option<u64>,
        limit: Option<usize>,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!(
            "{}/api/paper/house/history?market={}",
            self.base_url,
            urlencoding_encode(market)
        );
        if let Some(from_ms) = from_ms {
            url.push_str(&format!("&from_ms={from_ms}"));
        }
        if let Some(limit) = limit {
            url.push_str(&format!("&limit={limit}"));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_debt_history(
        &self,
        market: &str,
        from_ms: Option<u64>,
        limit: Option<usize>,
    ) -> AppResult<serde_json::Value> {
        let mut url = format!(
            "{}/api/paper/house/queue/history?market={}",
            self.base_url,
            urlencoding_encode(market)
        );
        if let Some(from_ms) = from_ms {
            url.push_str(&format!("&from_ms={from_ms}"));
        }
        if let Some(limit) = limit {
            url.push_str(&format!("&limit={limit}"));
        }
        self.get_json(&url).await
    }

    pub async fn get_paper_queue_placement(
        &self,
        market: &str,
        owner: &str,
    ) -> AppResult<serde_json::Value> {
        let url = format!(
            "{}/api/paper/house/queue/placement?market={}&owner={}",
            self.base_url,
            urlencoding_encode(market),
            urlencoding_encode(owner)
        );
        self.get_json(&url).await
    }

    async fn get_json(&self, url: &str) -> AppResult<serde_json::Value> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("indexer GET failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer HTTP {status}"),
            };
            if status.as_u16() == 404 {
                return Err(AppError::NotFound(message));
            }
            return Err(AppError::Internal(message));
        }
        response
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("decode indexer JSON: {e}")))
    }

    pub async fn submit_transaction(&self, tx: SignedTransaction) -> AppResult<SubmitResult> {
        #[derive(Serialize)]
        struct Body {
            tx: SignedTransaction,
        }

        let url = format!("{}/api/tx/submit", self.base_url);
        let response = self
            .client
            .post(&url)
            .json(&Body { tx })
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("indexer submit failed: {e}")))?;

        let status = response.status();
        if status.is_success() {
            let body: SubmitTxResponse = response.json().await.map_err(|e| {
                AppError::Internal(format!("decode submit response: {e}"))
            })?;
            return Ok(SubmitResult {
                digest: body.digest,
                block_num: body.block_num,
                receipt: body.receipt,
            });
        }

        let message = match response.json::<ErrorBody>().await {
            Ok(body) => body.error,
            Err(_) => format!("indexer submit HTTP {status}"),
        };
        Err(AppError::Internal(message))
    }
}
