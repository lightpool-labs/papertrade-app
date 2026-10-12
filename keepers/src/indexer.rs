// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::time::Duration;

use anyhow::{Context, Result, bail};
use lightpool_sdk::lightpool_types::SignedTransaction;
use lightpool_sdk::TransactionReceipt;
use reqwest::Client;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct OracleMark {
    pub spot_market: String,
    pub oracle_price_raw: u64,
    pub mark_price_raw: u64,
    #[serde(default)]
    pub oracle_price: String,
    #[serde(default)]
    pub mark_price: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaperPositionOpen {
    pub market: String,
    pub position: u64,
    pub owner: String,
    pub instrument: u32,
    pub is_long: bool,
    pub bust_price_raw: u64,
    #[serde(default)]
    pub bust_price: String,
    #[serde(default)]
    pub entry_price: String,
}

#[derive(Debug, Deserialize)]
struct PositionsResponse {
    #[serde(default)]
    open: Vec<PaperPositionOpen>,
    #[serde(default)]
    total: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaperHouse {
    pub market: String,
    pub free_cash_raw: u64,
    pub side_bucket_raw: u64,
    pub total_queued_raw: u64,
    pub staker_fee_acc_raw: u64,
    pub dev_fee_acc_raw: u64,
    pub queue_nonempty: bool,
    #[serde(default)]
    pub queue_head: u64,
    #[serde(default)]
    pub queue_tail: u64,
}

#[derive(Debug, Deserialize)]
struct HouseResponse {
    house: PaperHouse,
}

#[derive(Debug, Deserialize)]
struct SubmitTxResponse {
    digest: String,
    #[serde(default)]
    block_num: u64,
    receipt: TransactionReceipt,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Clone)]
pub struct IndexerHttp {
    client: Client,
    base_url: String,
}

impl IndexerHttp {
    pub fn new(base_url: &str) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .context("build http client")?,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn health_ok(&self) -> bool {
        let url = format!("{}/api/health/health", self.base_url);
        match self.client.get(&url).send().await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn get_oracle_mark(&self, spot_market: &str) -> Result<OracleMark> {
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
            .with_context(|| format!("GET oracle {spot_market}"))?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer oracle HTTP {status}"),
            };
            bail!("{message}");
        }
        response
            .json()
            .await
            .context("decode oracle mark")
    }

    /// All open paper positions (no owner filter), paginated.
    pub async fn list_open_positions(
        &self,
        market: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<PaperPositionOpen>, u32)> {
        let mut url = format!(
            "{}/api/paper/positions?status=open&limit={limit}&offset={offset}",
            self.base_url
        );
        if let Some(m) = market.filter(|s| !s.trim().is_empty()) {
            url.push_str(&format!("&market={}", urlencoding_encode(m)));
        }
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .context("GET paper positions")?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer positions HTTP {status}"),
            };
            bail!("{message}");
        }
        let body: PositionsResponse = response.json().await.context("decode positions")?;
        Ok((body.open, body.total))
    }

    pub async fn list_all_open_positions(
        &self,
        market: Option<&str>,
        page_limit: u32,
    ) -> Result<Vec<PaperPositionOpen>> {
        let mut out = Vec::new();
        let mut offset = 0u32;
        loop {
            let (page, total) = self
                .list_open_positions(market, page_limit, offset)
                .await?;
            let n = page.len() as u32;
            out.extend(page);
            offset = offset.saturating_add(n);
            if n == 0 || offset >= total {
                break;
            }
        }
        Ok(out)
    }

    pub async fn get_paper_house(&self, market: &str) -> Result<PaperHouse> {
        let url = format!(
            "{}/api/paper/house?market={}",
            self.base_url,
            urlencoding_encode(market.trim())
        );
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .context("GET paper house")?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer house HTTP {status}"),
            };
            bail!("{message}");
        }
        let body: HouseResponse = response.json().await.context("decode paper house")?;
        Ok(body.house)
    }

    pub async fn submit(
        &self,
        tx: SignedTransaction,
    ) -> Result<(String, u64, TransactionReceipt)> {
        #[derive(serde::Serialize)]
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
            .context("POST tx/submit")?;
        let status = response.status();
        if !status.is_success() {
            let message = match response.json::<ErrorBody>().await {
                Ok(body) => body.error,
                Err(_) => format!("indexer submit HTTP {status}"),
            };
            bail!("{message}");
        }
        let body: SubmitTxResponse = response.json().await.context("decode submit")?;
        Ok((body.digest, body.block_num, body.receipt))
    }
}

fn urlencoding_encode(raw: &str) -> String {
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
