// Copyright (c) LightPool Labs
//! Fill then hold ~N open paper positions across many accounts.
//! Optional take-profit: subscribe indexer oracle mark and close when ROE ≥ threshold.
//! Also subscribe `paper.positions` so liquidated/closed rows are dropped from the
//! local book (no take-profit close retry after keeper liqd).
//!
//! Standalone CLI — not wired into `scripts/dev.sh`.
//!
//! Example:
//! ```text
//! cargo run --release --bin hold-opens -- \
//!   --accounts 100 --target 10000 --rate 100 \
//!   --fund-usdc 2000000 --margin-min 5 --margin-max 1000 \
//!   --leverage-min 1000 --leverage-max 1000 \
//!   --take-profit-pct 50
//! ```

use std::collections::HashMap;
use std::f64::consts::TAU;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use clap::Parser;
use futures_util::{future::try_join_all, stream, SinkExt, StreamExt, TryStreamExt};
use tokio::sync::Semaphore;
use lightpool_sdk::lightpool_types::SignedTransaction;
use lightpool_sdk::{
    extract_paper_opened, parse_token_contract, ActionBuilder, PaperCloseParams,
    PaperDepositParams, PaperOpenParams, Signer, TransactionBuilder, TransferParams, TOKEN_SCALE,
};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio::time::{interval, MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Anvil / Hardhat account #0 — bootstrap USDC minter / holder.
const DEFAULT_ADMIN_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

#[derive(Debug, Parser)]
#[command(
    name = "hold-opens",
    about = "Multi-account paper open soak: fill to --target, hold, optional mark take-profit close"
)]
struct Args {
    /// Indexer HTTP base (submit + house poll + oracle WS).
    #[arg(long, env = "INDEXER_URL", default_value = "http://127.0.0.1:3002")]
    indexer_url: String,

    /// markets.json (paper_market + instruments).
    #[arg(long, env = "MARKETS_PATH", default_value = "../data/markets.json")]
    markets_path: PathBuf,

    /// bootstrap.json for USDC address (required when --fund-usdc > 0).
    #[arg(
        long,
        env = "BOOTSTRAP_PATH",
        default_value = "../../data/papertrader/bootstrap.json"
    )]
    bootstrap_path: PathBuf,

    /// Admin / USDC holder private key (hex).
    #[arg(long, env = "ADMIN_KEY", default_value = DEFAULT_ADMIN_KEY)]
    admin_key: String,

    /// Number of worker accounts (deterministic keys, not admin).
    #[arg(long, default_value_t = 1000)]
    accounts: u32,

    /// Target open position count.
    #[arg(long, default_value_t = 10_000)]
    target: u32,

    /// Hold band: top up only when open < target - band.
    #[arg(long, default_value_t = 500)]
    band: u32,

    /// Open sends per second (Fill + Hold top-up).
    #[arg(long, default_value_t = 100.0)]
    rate: f64,

    /// Min whole USDC margin per open (human units); each open draws uniformly in [min, max].
    #[arg(long, default_value_t = 5.0)]
    margin_min: f64,

    /// Max whole USDC margin per open (human units).
    #[arg(long, default_value_t = 1000.0)]
    margin_max: f64,

    /// Min leverage per open (inclusive); each open draws uniformly in [min, max].
    #[arg(long, default_value_t = 1000)]
    leverage_min: u64,

    /// Max leverage per open (inclusive). Default 1000x so positions bust easily.
    #[arg(long, default_value_t = 1000)]
    leverage_max: u64,

    /// Instrument id (BTC = 0).
    #[arg(long, default_value_t = 0)]
    instrument: u32,

    /// Per-account paper Available credit (whole USDC). 0 = skip funding.
    #[arg(long, default_value_t = 200_000)]
    fund_usdc: u64,

    /// Hold loop poll interval.
    #[arg(long, default_value_t = 2000)]
    hold_poll_ms: u64,

    /// How often to refresh open_positions during Fill (opens between polls).
    #[arg(long, default_value_t = 50)]
    refresh_every: u32,

    /// Close when unrealized ROE (raw pnl / margin) ≥ this percent. 0 = disabled.
    /// Example: 50 → close when position is up ~50% of margin.
    #[arg(long, default_value_t = 50.0)]
    take_profit_pct: f64,

    /// Max take-profit closes submitted per mark tick (backpressure).
    #[arg(long, default_value_t = 32)]
    take_profit_batch: u32,

    /// Concurrent paper-deposit submits while funding (transfers are batched).
    #[arg(long, default_value_t = 512)]
    fund_concurrency: u32,

    /// Oscillate P(long) over wall time so L/S OI diverge then cross (seconds).
    /// 0 = flat 50/50. Default 30s per full long↔short cycle.
    #[arg(long, default_value_t = 30.0)]
    side_period_secs: f64,

    /// How far P(long) swings from 0.5 (0..0.5). Example 0.35 → P(long) in [0.15, 0.85].
    #[arg(long, default_value_t = 0.35)]
    side_amplitude: f64,
}

#[derive(Debug, Deserialize)]
struct MarketsFile {
    paper_market: String,
    #[serde(default)]
    instruments: Vec<InstrumentFile>,
}

#[derive(Debug, Deserialize)]
struct InstrumentFile {
    id: u32,
    #[serde(default)]
    price_market: String,
    #[serde(default)]
    retired: bool,
}

#[derive(Debug, Deserialize)]
struct BootstrapFile {
    usdc: String,
    paper_market: String,
}

#[derive(Debug, Deserialize)]
struct HouseBody {
    house: HouseView,
}

#[derive(Debug, Deserialize)]
struct HouseView {
    open_positions: u32,
}

#[derive(Debug, Deserialize)]
struct SubmitTxResponse {
    receipt: lightpool_sdk::TransactionReceipt,
}

#[derive(Debug, Deserialize)]
struct OracleHttpBody {
    mark_price_raw: u64,
    #[serde(default)]
    oracle_price_raw: u64,
}

#[derive(Clone)]
struct IndexerHttp {
    client: Client,
    base_url: String,
}

impl IndexerHttp {
    fn new(base_url: &str) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .context("http client")?,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    fn ws_url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}/api/ws")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}/api/ws")
        } else {
            format!("ws://{base}/api/ws")
        }
    }

    async fn submit(&self, tx: SignedTransaction) -> Result<SubmitTxResponse> {
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
            .context("submit tx")?;
        let status = response.status();
        let text = response.text().await.context("submit body")?;
        if !status.is_success() {
            bail!("indexer submit HTTP {status}: {text}");
        }
        Ok(serde_json::from_str(&text).context("decode submit")?)
    }

    async fn open_positions(&self, market: &str) -> Result<u32> {
        let url = format!(
            "{}/api/paper/house?market={}",
            self.base_url,
            urlencoding_encode(market)
        );
        let response = self.client.get(&url).send().await.context("get house")?;
        let status = response.status();
        let text = response.text().await.context("house body")?;
        if !status.is_success() {
            bail!("house HTTP {status}: {text}");
        }
        let body: HouseBody = serde_json::from_str(&text).context("decode house")?;
        Ok(body.house.open_positions)
    }

    async fn oracle_mark_raw(&self, spot_market: &str) -> Result<u64> {
        let url = format!(
            "{}/api/spot/{}/oracle",
            self.base_url,
            urlencoding_encode(spot_market)
        );
        let response = self.client.get(&url).send().await.context("get oracle")?;
        let status = response.status();
        let text = response.text().await.context("oracle body")?;
        if !status.is_success() {
            bail!("oracle HTTP {status}: {text}");
        }
        let body: OracleHttpBody = serde_json::from_str(&text).context("decode oracle")?;
        let raw = if body.mark_price_raw > 0 {
            body.mark_price_raw
        } else {
            body.oracle_price_raw
        };
        if raw == 0 {
            bail!("oracle mark is zero");
        }
        Ok(raw)
    }
}

struct TrackedOpen {
    account_idx: usize,
    position: u64,
    is_long: bool,
    margin: u64,
    notional: u64,
    entry_price: u64,
    closing: bool,
}

fn urlencoding_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn load_signer(raw: &str) -> Result<Signer> {
    let hex_body = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(hex_body).context("admin key hex")?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("key must be 32 bytes"))?;
    Signer::from_secret_key_bytes(&key).context("load signer")
}

fn worker_signer(index: u32) -> Result<Signer> {
    let mut hasher = Sha256::new();
    hasher.update(b"papertrade-hold-opens/v1/");
    hasher.update(index.to_le_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    Signer::from_secret_key_bytes(&key).context("worker signer")
}

fn resolve_path(path: &PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path.clone();
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidate = cwd.join(path);
    if candidate.exists() {
        return candidate;
    }
    let from_tests = cwd.join("tests").join(path);
    if from_tests.exists() {
        return from_tests;
    }
    let from_app = cwd.join("papertrade-app").join(path);
    if from_app.exists() {
        return from_app;
    }
    candidate
}

fn price_market_for_instrument(markets: &MarketsFile, instrument: u32) -> Result<String> {
    let spot = markets
        .instruments
        .iter()
        .find(|i| i.id == instrument && !i.retired)
        .map(|i| i.price_market.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            markets
                .instruments
                .iter()
                .find(|i| !i.retired && !i.price_market.trim().is_empty())
                .map(|i| i.price_market.trim().to_string())
        });
    spot.ok_or_else(|| anyhow::anyhow!("no price_market for instrument {instrument}"))
}

/// Raw unrealized ROE percent: pnl/margin*100 (no impact/fee).
fn roe_pct(is_long: bool, entry: u64, mark: u64, notional: u64, margin: u64) -> Option<f64> {
    if entry == 0 || mark == 0 || margin == 0 || notional == 0 {
        return None;
    }
    let delta = if is_long {
        mark as i128 - entry as i128
    } else {
        entry as i128 - mark as i128
    };
    let pnl = notional as i128 * delta / entry as i128;
    Some((pnl as f64) / (margin as f64) * 100.0)
}

const FUND_TRANSFER_BATCH: usize = 100;

async fn fund_workers(
    client: &IndexerHttp,
    admin: &Signer,
    workers: Arc<Vec<Signer>>,
    usdc: &str,
    paper_market: &str,
    amount_usdc: u64,
    concurrency: usize,
) -> Result<()> {
    let amount = amount_usdc
        .checked_mul(TOKEN_SCALE)
        .context("fund amount overflow")?;
    let usdc_addr = parse_token_contract(usdc).map_err(|e| anyhow::anyhow!("usdc: {e}"))?;
    let paper = parse_token_contract(paper_market).map_err(|e| anyhow::anyhow!("paper: {e}"))?;
    let admin_addr = admin.address();
    let t0 = Instant::now();

    let mut transfer_batches: Vec<SignedTransaction> = Vec::new();
    let mut batch = TransactionBuilder::new()
        .sender(admin_addr)
        .expiration(u64::MAX);
    let mut batch_len = 0usize;
    for user in workers.iter() {
        let user_addr = user.address();
        if user_addr == admin_addr {
            continue;
        }
        let transfer = ActionBuilder::transfer_token(
            usdc_addr,
            TransferParams {
                to: user_addr,
                amount,
            },
        )
        .context("build transfer")?;
        batch = batch.add_action(transfer);
        batch_len += 1;
        if batch_len >= FUND_TRANSFER_BATCH {
            transfer_batches.push(
                batch
                    .build_and_sign_only(admin)
                    .context("sign transfer batch")?,
            );
            batch = TransactionBuilder::new()
                .sender(admin_addr)
                .expiration(u64::MAX);
            batch_len = 0;
        }
    }
    if batch_len > 0 {
        transfer_batches.push(
            batch
                .build_and_sign_only(admin)
                .context("sign transfer batch")?,
        );
    }

    let n_transfer_batches = transfer_batches.len();
    let transfer_futs = transfer_batches.into_iter().enumerate().map(|(bi, tx)| {
        let client = client.clone();
        async move {
            let response = client.submit(tx).await?;
            if !response.receipt.is_success() {
                bail!(
                    "USDC transfer batch {bi} failed: {:?}",
                    response.receipt.status
                );
            }
            Ok::<(), anyhow::Error>(())
        }
    });
    try_join_all(transfer_futs)
        .await
        .context("USDC transfer batches")?;
    tracing::info!(
        transfer_batches = n_transfer_batches,
        elapsed_ms = t0.elapsed().as_millis() as u64,
        "fund transfers done"
    );

    let concurrency = concurrency.max(1);
    let sem = Arc::new(Semaphore::new(concurrency));
    let done = Arc::new(AtomicU64::new(0));
    let total = workers.len() as u64;
    let n_workers = workers.len();
    stream::iter(0..n_workers)
        .map(|i| {
            let client = client.clone();
            let sem = Arc::clone(&sem);
            let done = Arc::clone(&done);
            let workers = Arc::clone(&workers);
            async move {
                let _permit = sem
                    .acquire()
                    .await
                    .map_err(|e| anyhow::anyhow!("fund semaphore: {e}"))?;
                let user = &workers[i];
                let user_addr = user.address();
                let deposit = ActionBuilder::deposit_paper(paper, PaperDepositParams { amount })
                    .context("build deposit")?;
                let tx = TransactionBuilder::new()
                    .sender(user_addr)
                    .account(user_addr)
                    .expiration(u64::MAX)
                    .add_action(deposit)
                    .build_and_sign_only(user)
                    .context("sign deposit")?;
                let response = client.submit(tx).await?;
                if !response.receipt.is_success() {
                    bail!(
                        "paper deposit for worker {i} ({user_addr}) failed: {:?}",
                        response.receipt.status
                    );
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 100 == 0 || n == total {
                    tracing::info!(done = n, total, "fund deposit progress");
                }
                Ok::<(), anyhow::Error>(())
            }
        })
        .buffer_unordered(concurrency)
        .try_collect::<Vec<()>>()
        .await
        .context("paper deposits")?;
    tracing::info!(
        accounts = n_workers,
        elapsed_ms = t0.elapsed().as_millis() as u64,
        "fund workers done"
    );
    Ok(())
}

async fn submit_open(
    client: &IndexerHttp,
    signer: &Signer,
    paper_market: &str,
    instrument: u32,
    is_long: bool,
    margin_raw: u64,
    leverage: u64,
    account_idx: usize,
) -> Result<Option<TrackedOpen>> {
    let paper =
        parse_token_contract(paper_market).map_err(|e| anyhow::anyhow!("paper market: {e}"))?;
    let owner = signer.address();
    let action = ActionBuilder::open_paper(
        paper,
        PaperOpenParams {
            instrument,
            is_long,
            margin: margin_raw,
            leverage,
            fund_from_queued: false,
        },
    )
    .context("build open")?;
    let tx = TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)
        .context("sign open")?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        bail!("open_paper failed: {:?}", response.receipt.status);
    }
    let Some(ev) = extract_paper_opened(&response.receipt) else {
        return Ok(None);
    };
    Ok(Some(TrackedOpen {
        account_idx,
        position: ev.position,
        is_long: ev.is_long,
        margin: ev.margin,
        notional: ev.notional,
        entry_price: ev.entry_price,
        closing: false,
    }))
}

async fn submit_close(
    client: &IndexerHttp,
    signer: &Signer,
    paper_market: &str,
    position: u64,
) -> Result<()> {
    let paper =
        parse_token_contract(paper_market).map_err(|e| anyhow::anyhow!("paper market: {e}"))?;
    let owner = signer.address();
    let action = ActionBuilder::close_paper(paper, PaperCloseParams { position })
        .context("build close")?;
    let tx = TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)
        .context("sign close")?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        bail!(
            "close_paper pos={position} failed: {:?}",
            response.receipt.status
        );
    }
    Ok(())
}

struct RateLimiter {
    interval: tokio::time::Interval,
}

impl RateLimiter {
    fn new(rate: f64) -> Self {
        let period = if rate <= 0.0 {
            Duration::from_secs(1)
        } else {
            Duration::from_secs_f64(1.0 / rate)
        };
        let mut interval = interval(period);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Self { interval }
    }

    async fn wait(&mut self) {
        self.interval.tick().await;
    }
}

struct OpenDraw {
    is_long: bool,
    margin_raw: u64,
    leverage: u64,
    account_idx: usize,
}

fn long_prob_at(args: &Args, started: Instant) -> f64 {
    if !(args.side_period_secs > 0.0 && args.side_amplitude > 0.0) {
        return 0.5;
    }
    let amp = args.side_amplitude.clamp(0.0, 0.5);
    let phase = TAU * started.elapsed().as_secs_f64() / args.side_period_secs;
    (0.5 + amp * phase.sin()).clamp(0.0, 1.0)
}

fn draw_open(
    rng: &mut StdRng,
    args: &Args,
    n_accounts: usize,
    started: Instant,
) -> Result<OpenDraw> {
    let is_long = rng.gen_bool(long_prob_at(args, started));
    let margin = if (args.margin_max - args.margin_min).abs() < f64::EPSILON {
        args.margin_min
    } else {
        rng.gen_range(args.margin_min..=args.margin_max)
    };
    let margin_raw = (margin * TOKEN_SCALE as f64).round() as u64;
    if margin_raw == 0 {
        bail!("drawn margin too small after scale");
    }
    let leverage = if args.leverage_min == args.leverage_max {
        args.leverage_min
    } else {
        rng.gen_range(args.leverage_min..=args.leverage_max)
    };
    let account_idx = rng.gen_range(0..n_accounts.max(1));
    Ok(OpenDraw {
        is_long,
        margin_raw,
        leverage,
        account_idx,
    })
}

fn mark_raw_from_ws(msg: &Value) -> Option<u64> {
    let raw = msg
        .get("mark_price_raw")
        .or_else(|| msg.get("oracle_price_raw"))
        .and_then(|v| v.as_u64())?;
    if raw == 0 {
        None
    } else {
        Some(raw)
    }
}

fn spawn_oracle_ws(ws_url: String, spot_market: String, mark_raw: Arc<AtomicU64>) {
    tokio::spawn(async move {
        let mut backoff_ms = 500u64;
        let sub = json!({
            "op": "subscribe",
            "channel": "oracle",
            "spot_market": spot_market,
        });
        loop {
            match connect_async(&ws_url).await {
                Ok((ws, _)) => {
                    backoff_ms = 500;
                    let (mut write, mut read) = ws.split();
                    if write
                        .send(Message::Text(sub.to_string().into()))
                        .await
                        .is_err()
                    {
                        continue;
                    }
                    tracing::info!(%ws_url, %spot_market, "oracle ws subscribed");
                    while let Some(msg) = read.next().await {
                        let Ok(msg) = msg else { break };
                        match msg {
                            Message::Text(text) => {
                                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                    if let Some(raw) = mark_raw_from_ws(&value) {
                                        mark_raw.store(raw, Ordering::Relaxed);
                                    }
                                }
                            }
                            Message::Ping(p) => {
                                let _ = write.send(Message::Pong(p)).await;
                            }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                    tracing::warn!(%spot_market, "oracle ws disconnected");
                }
                Err(err) => {
                    tracing::warn!(%ws_url, error = %err, "oracle ws connect failed");
                }
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms.saturating_mul(2)).min(8_000);
        }
    });
}

fn lifecycle_event(msg: &Value) -> Option<&str> {
    let ev = msg.get("event")?.as_str()?;
    match ev.to_ascii_lowercase().as_str() {
        "liquidated" | "liqd" | "liquidation" => Some("liquidated"),
        "closed" | "close" => Some("closed"),
        _ => None,
    }
}

fn position_id_from_ws(msg: &Value) -> Option<u64> {
    msg.get("position")
        .and_then(|v| v.as_u64())
        .or_else(|| msg.get("position").and_then(|v| v.as_str()?.parse().ok()))
}

/// Drop tracked rows when indexer reports liquidated/closed so take-profit won't retry.
fn spawn_positions_ws(
    ws_url: String,
    paper_market: String,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
) {
    tokio::spawn(async move {
        let market_key = paper_market.trim().to_ascii_lowercase();
        let mut backoff_ms = 500u64;
        let sub = json!({
            "op": "subscribe",
            "channel": "paper.positions",
        });
        loop {
            match connect_async(&ws_url).await {
                Ok((ws, _)) => {
                    backoff_ms = 500;
                    let (mut write, mut read) = ws.split();
                    if write
                        .send(Message::Text(sub.to_string().into()))
                        .await
                        .is_err()
                    {
                        continue;
                    }
                    tracing::info!(%ws_url, "paper.positions ws subscribed (liqd/close book sync)");
                    while let Some(msg) = read.next().await {
                        let Ok(msg) = msg else { break };
                        match msg {
                            Message::Text(text) => {
                                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                                    continue;
                                };
                                let Some(kind) = lifecycle_event(&value) else {
                                    continue;
                                };
                                let m = value
                                    .get("market")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .trim()
                                    .to_ascii_lowercase();
                                if !market_key.is_empty() && !m.is_empty() && m != market_key {
                                    continue;
                                }
                                let Some(position) = position_id_from_ws(&value) else {
                                    continue;
                                };
                                let removed = book.lock().await.remove(&position).is_some();
                                if removed {
                                    tracing::info!(
                                        position,
                                        event = kind,
                                        "removed from book (indexer lifecycle)"
                                    );
                                }
                            }
                            Message::Ping(p) => {
                                let _ = write.send(Message::Pong(p)).await;
                            }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                    tracing::warn!("paper.positions ws disconnected");
                }
                Err(err) => {
                    tracing::warn!(%ws_url, error = %err, "paper.positions ws connect failed");
                }
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms.saturating_mul(2)).min(8_000);
        }
    });
}

fn spawn_take_profit_loop(
    client: Arc<IndexerHttp>,
    workers: Arc<Vec<Signer>>,
    paper_market: String,
    spot_market: String,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
    mark_raw: Arc<AtomicU64>,
    take_profit_pct: f64,
    batch: u32,
    running: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let mut last_mark = 0u64;
        let mut poll = interval(Duration::from_millis(200));
        poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
        while running.load(Ordering::Relaxed) {
            poll.tick().await;
            let mut mark = mark_raw.load(Ordering::Relaxed);
            if mark == 0 {
                if let Ok(raw) = client.oracle_mark_raw(&spot_market).await {
                    mark_raw.store(raw, Ordering::Relaxed);
                    mark = raw;
                } else {
                    continue;
                }
            }
            if mark == last_mark {
                // Still scan occasionally in case we missed a move while mark flat.
            }
            last_mark = mark;

            let mut to_close: Vec<(usize, u64, f64)> = Vec::new();
            {
                let mut guard = book.lock().await;
                for pos in guard.values_mut() {
                    if pos.closing {
                        continue;
                    }
                    let Some(roe) =
                        roe_pct(pos.is_long, pos.entry_price, mark, pos.notional, pos.margin)
                    else {
                        continue;
                    };
                    if roe >= take_profit_pct {
                        pos.closing = true;
                        to_close.push((pos.account_idx, pos.position, roe));
                        if to_close.len() >= batch as usize {
                            break;
                        }
                    }
                }
            }

            for (account_idx, position, roe) in to_close {
                let Some(signer) = workers.get(account_idx) else {
                    continue;
                };
                match submit_close(&client, signer, &paper_market, position).await {
                    Ok(()) => {
                        book.lock().await.remove(&position);
                        tracing::info!(
                            position,
                            account_idx,
                            roe = format!("{roe:.2}"),
                            mark,
                            "take-profit close ok"
                        );
                    }
                    Err(err) => {
                        let err_s = err.to_string();
                        let gone = err_s.contains("not found")
                            || err_s.contains("Not found")
                            || err_s.contains("not liquidatable")
                            || err_s.contains("already");
                        if gone {
                            book.lock().await.remove(&position);
                            tracing::info!(
                                position,
                                account_idx,
                                error = %err_s,
                                "drop from book after close miss (likely already liqd/closed)"
                            );
                        } else if let Some(pos) = book.lock().await.get_mut(&position) {
                            pos.closing = false;
                            tracing::warn!(
                                position,
                                account_idx,
                                error = %err_s,
                                "take-profit close failed"
                            );
                        }
                    }
                }
            }
        }
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hold_opens=info".into()),
        )
        .init();

    let args = Args::parse();
    if args.accounts == 0 {
        bail!("--accounts must be >= 1");
    }
    if args.target == 0 {
        bail!("--target must be >= 1");
    }
    if !(args.rate > 0.0) {
        bail!("--rate must be > 0");
    }
    if !(args.margin_min.is_finite() && args.margin_min > 0.0) {
        bail!("--margin-min must be a positive number");
    }
    if !(args.margin_max.is_finite() && args.margin_max >= args.margin_min) {
        bail!("--margin-max must be >= --margin-min");
    }
    if args.leverage_min == 0 {
        bail!("--leverage-min must be >= 1");
    }
    if args.leverage_max < args.leverage_min {
        bail!("--leverage-max must be >= --leverage-min");
    }
    if !(args.take_profit_pct.is_finite() && args.take_profit_pct >= 0.0) {
        bail!("--take-profit-pct must be >= 0");
    }
    if !(args.side_period_secs.is_finite() && args.side_period_secs >= 0.0) {
        bail!("--side-period-secs must be >= 0");
    }
    if !(args.side_amplitude.is_finite() && (0.0..=0.5).contains(&args.side_amplitude)) {
        bail!("--side-amplitude must be in [0, 0.5]");
    }

    let markets_path = resolve_path(&args.markets_path);
    let markets: MarketsFile = serde_json::from_str(
        &std::fs::read_to_string(&markets_path)
            .with_context(|| format!("read markets {}", markets_path.display()))?,
    )
    .context("parse markets.json")?;
    let paper_market = markets.paper_market.trim().to_string();
    if paper_market.is_empty() {
        bail!("markets.json missing paper_market");
    }
    let spot_market = price_market_for_instrument(&markets, args.instrument)?;

    let client = Arc::new(IndexerHttp::new(&args.indexer_url)?);
    let admin = load_signer(&args.admin_key)?;
    let mut workers_vec = Vec::with_capacity(args.accounts as usize);
    for i in 0..args.accounts {
        workers_vec.push(worker_signer(i)?);
    }
    let workers = Arc::new(workers_vec);
    let mut rng = StdRng::from_entropy();
    let book: Arc<Mutex<HashMap<u64, TrackedOpen>>> = Arc::new(Mutex::new(HashMap::new()));
    let mark_raw = Arc::new(AtomicU64::new(0));
    let running = Arc::new(AtomicBool::new(true));
    let soak_start = Instant::now();

    tracing::info!(
        indexer = %args.indexer_url,
        paper_market = %paper_market,
        spot_market = %spot_market,
        accounts = args.accounts,
        target = args.target,
        band = args.band,
        rate = args.rate,
        margin_min = args.margin_min,
        margin_max = args.margin_max,
        leverage_min = args.leverage_min,
        leverage_max = args.leverage_max,
        instrument = args.instrument,
        take_profit_pct = args.take_profit_pct,
        side_period_secs = args.side_period_secs,
        side_amplitude = args.side_amplitude,
        "hold-opens starting"
    );

    if args.fund_usdc > 0 {
        let bootstrap_path = resolve_path(&args.bootstrap_path);
        let bootstrap: BootstrapFile = serde_json::from_str(
            &std::fs::read_to_string(&bootstrap_path)
                .with_context(|| format!("read bootstrap {}", bootstrap_path.display()))?,
        )
        .context("parse bootstrap.json")?;
        let usdc = bootstrap.usdc.trim();
        if usdc.is_empty() {
            bail!("bootstrap.json missing usdc");
        }
        let paper = if bootstrap.paper_market.trim().is_empty() {
            paper_market.as_str()
        } else {
            bootstrap.paper_market.trim()
        };
        tracing::info!(
            accounts = args.accounts,
            fund_usdc = args.fund_usdc,
            fund_concurrency = args.fund_concurrency,
            "funding worker paper Available"
        );
        fund_workers(
            &client,
            &admin,
            Arc::clone(&workers),
            usdc,
            paper,
            args.fund_usdc,
            args.fund_concurrency.max(1) as usize,
        )
        .await
        .context("fund workers")?;
    }

    // Always sync book from indexer lifecycle so keeper liqd cannot be closed again.
    spawn_positions_ws(
        client.ws_url(),
        paper_market.clone(),
        Arc::clone(&book),
    );

    if args.take_profit_pct > 0.0 {
        if let Ok(raw) = client.oracle_mark_raw(&spot_market).await {
            mark_raw.store(raw, Ordering::Relaxed);
            tracing::info!(mark_raw = raw, %spot_market, "seeded oracle mark");
        }
        spawn_oracle_ws(client.ws_url(), spot_market.clone(), Arc::clone(&mark_raw));
        spawn_take_profit_loop(
            Arc::clone(&client),
            Arc::clone(&workers),
            paper_market.clone(),
            spot_market.clone(),
            Arc::clone(&book),
            Arc::clone(&mark_raw),
            args.take_profit_pct,
            args.take_profit_batch.max(1),
            Arc::clone(&running),
        );
        tracing::info!(
            take_profit_pct = args.take_profit_pct,
            "take-profit enabled (close when ROE >= pct)"
        );
    } else {
        tracing::info!("take-profit disabled (--take-profit-pct 0)");
    }

    let mut rate = RateLimiter::new(args.rate);

    let track_open = |book: &Arc<Mutex<HashMap<u64, TrackedOpen>>>, tracked: TrackedOpen| {
        let book = Arc::clone(book);
        async move {
            book.lock().await.insert(tracked.position, tracked);
        }
    };

    let mut open = client.open_positions(&paper_market).await?;
    tracing::info!(open, target = args.target, "current open_positions");

    if open < args.target {
        tracing::info!("phase=FILL");
        let fill_start = Instant::now();
        let mut since_refresh = 0u32;
        while open < args.target {
            rate.wait().await;
            let draw = match draw_open(&mut rng, &args, workers.len(), soak_start) {
                Ok(d) => d,
                Err(err) => {
                    tracing::warn!(error = %err, "draw open failed");
                    continue;
                }
            };
            let signer = &workers[draw.account_idx];
            match submit_open(
                &client,
                signer,
                &paper_market,
                args.instrument,
                draw.is_long,
                draw.margin_raw,
                draw.leverage,
                draw.account_idx,
            )
            .await
            {
                Ok(Some(tracked)) => track_open(&book, tracked).await,
                Ok(None) => tracing::warn!("open ok but missing paper_opened event"),
                Err(err) => tracing::warn!(error = %err, "open failed (continuing)"),
            }
            since_refresh += 1;
            if since_refresh >= args.refresh_every {
                open = client.open_positions(&paper_market).await.unwrap_or(open);
                since_refresh = 0;
                tracing::info!(
                    open,
                    tracked = book.lock().await.len(),
                    target = args.target,
                    elapsed_s = fill_start.elapsed().as_secs(),
                    p_long = format!("{:.2}", long_prob_at(&args, soak_start)),
                    "fill progress"
                );
            }
        }
        open = client.open_positions(&paper_market).await?;
        tracing::info!(
            open,
            tracked = book.lock().await.len(),
            elapsed_s = fill_start.elapsed().as_secs(),
            "fill done"
        );
    } else {
        tracing::info!(open, "already at/above target; skip FILL");
    }

    tracing::info!(
        poll_ms = args.hold_poll_ms,
        band = args.band,
        "phase=HOLD (Ctrl-C to stop)"
    );
    let floor = args.target.saturating_sub(args.band);
    loop {
        tokio::time::sleep(Duration::from_millis(args.hold_poll_ms.max(200))).await;
        open = match client.open_positions(&paper_market).await {
            Ok(n) => n,
            Err(err) => {
                tracing::warn!(error = %err, "house poll failed");
                continue;
            }
        };
        if open >= floor {
            tracing::debug!(
                open,
                floor,
                tracked = book.lock().await.len(),
                mark = mark_raw.load(Ordering::Relaxed),
                "hold ok"
            );
            continue;
        }
        tracing::info!(open, floor, target = args.target, "top-up");
        let mut since_refresh = 0u32;
        while open < args.target {
            rate.wait().await;
            let draw = match draw_open(&mut rng, &args, workers.len(), soak_start) {
                Ok(d) => d,
                Err(err) => {
                    tracing::warn!(error = %err, "draw open failed");
                    continue;
                }
            };
            let signer = &workers[draw.account_idx];
            match submit_open(
                &client,
                signer,
                &paper_market,
                args.instrument,
                draw.is_long,
                draw.margin_raw,
                draw.leverage,
                draw.account_idx,
            )
            .await
            {
                Ok(Some(tracked)) => track_open(&book, tracked).await,
                Ok(None) => {}
                Err(err) => tracing::warn!(error = %err, "top-up open failed"),
            }
            since_refresh += 1;
            if since_refresh >= args.refresh_every {
                open = client.open_positions(&paper_market).await.unwrap_or(open);
                since_refresh = 0;
            }
        }
        open = client.open_positions(&paper_market).await.unwrap_or(open);
        tracing::info!(open, "top-up done");
    }
}
