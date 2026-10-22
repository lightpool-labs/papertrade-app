// Copyright (c) LightPool Labs
//! Fill then hold ~N open paper positions across worker accounts.
//! Admin is separate: seeds one long + one short (1.2M margin each, high leverage);
//! when those liquidate, PAPER stays in the admin wallet for `buyback-amm`.
//! Optional take-profit: subscribe indexer oracle mark and close when ROE ≥ threshold.
//! `paper.positions` keeps the local open count (opened +1, closed/liquidated −1).
//! Worker liquidations stake minted PAPER immediately.
//! Indexer `open_positions()` replaces that count every `--reconcile-mins` (default 10).
//! One task signs at `--rate`; a pool of `--senders` tasks submits and waits for receipts.
//!
//! Standalone CLI — not wired into `scripts/dev.sh`.
//!
//! Funding (--fund-usdc > 0): admin bridge-deposits Reth USDC (minted in
//! scripts/dev.sh) into LightPool → transfers to workers (open uses LP USDC).
//! Requires eth-bridge.json + running Reth/bridge + admin Reth USDC.
//!
//! Example:
//! ```text
//! cargo run --release --bin hold-opens -- \
//!   --accounts 100 --target 10000 --rate 100 \
//!   --fund-usdc 200000 --margin-min 5 --margin-max 1000 \
//!   --leverage-min 1000 --leverage-max 1000 \
//!   --take-profit-pct 50
//! ```

use std::collections::{HashMap, HashSet};
use std::f64::consts::TAU;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use clap::Parser;
use futures_util::{future::try_join_all, SinkExt, StreamExt};
use lightpool_sdk::lightpool_types::SignedTransaction;
use lightpool_sdk::{
    extract_paper_opened, parse_token_contract, ActionBuilder, PaperCloseParams,
    PaperOpenParams, PaperStakeParams, Signer, TransactionBuilder, TransferParams, TOKEN_SCALE,
};
use std::process::Command;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::time::{interval, MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Anvil / Hardhat account #0 — bootstrap USDC minter / holder.
const DEFAULT_ADMIN_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/// Admin buyback seed: one long + one short at this whole-USDC margin each.
/// Sized so two liqds leave ~2.4M PAPER for AMM L≈4.5e13 on ticks [-1000,1000]
/// (enough depth for a ~2M USDC buyback swap in one tx).
const ADMIN_SEED_MARGIN_USDC: u64 = 1_200_000;
/// Extra whole USDC left on admin after seed opens (for AMM add_liquidity).
const ADMIN_BUYBACK_USDC_RESERVE: u64 = 2_500_000;
const ADMIN_SEED_LEVERAGE: u64 = 1_000;

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

    /// eth-bridge.json (Reth USDC + bridge). Required when --fund-usdc > 0.
    #[arg(
        long,
        env = "BRIDGE_STATE_PATH",
        default_value = "../../data/papertrader/eth-bridge.json"
    )]
    bridge_state_path: PathBuf,

    /// Reth HTTP RPC (admin bridge deposit; mint is done in scripts/dev.sh).
    #[arg(long, env = "RETH_RPC", default_value = "http://127.0.0.1:8545")]
    reth_rpc: String,

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
    #[arg(long, default_value_t = 20.0)]
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

    /// Replace the local open count with indexer `open_positions` every N minutes.
    #[arg(long, default_value_t = 10)]
    reconcile_mins: u64,

    /// Parallel submit tasks waiting on receipts. Signing stays one task at `--rate`.
    #[arg(long, default_value_t = 8)]
    senders: u32,

    /// Close when unrealized ROE (raw pnl / margin) ≥ this percent. 0 = disabled.
    /// Example: 50 → close when position is up ~50% of margin.
    #[arg(long, default_value_t = 50.0)]
    take_profit_pct: f64,

    /// Max take-profit closes submitted per mark tick (backpressure).
    #[arg(long, default_value_t = 32)]
    take_profit_batch: u32,

    /// Kept for CLI compat (paper deposit step removed; transfers are batched).
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
    #[serde(default)]
    paper_token: String,
}

#[derive(Debug, Deserialize)]
struct BridgeStateFile {
    evm_bridge: String,
    tokens: Vec<BridgeTokenFile>,
}

#[derive(Debug, Deserialize)]
struct BridgeTokenFile {
    symbol: String,
    evm: String,
    lp: String,
}

#[derive(Debug, Deserialize)]
struct BalanceEntry {
    available: String,
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

    /// LP token available (6-decimal raw) via indexer balances.
    async fn lp_available_raw(&self, address: &str, lp_token: &str) -> Result<u64> {
        let url = format!(
            "{}/api/accounts/{}/balances",
            self.base_url,
            urlencoding_encode(address.trim())
        );
        let body = json!({
            "tokens": [{ "symbol": "USDC", "address": lp_token }]
        });
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("get balances")?;
        let status = response.status();
        let text = response.text().await.context("balances body")?;
        if !status.is_success() {
            bail!("balances HTTP {status}: {text}");
        }
        let entries: Vec<BalanceEntry> =
            serde_json::from_str(&text).context("decode balances")?;
        let avail = entries
            .first()
            .map(|e| e.available.as_str())
            .unwrap_or("0");
        parse_human_amount6_raw(avail)
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

/// Local open-count. `live` follows `paper.positions`. `inflight` covers opens
/// signed but not yet reflected by that stream (or already reflected, matched by id).
struct CountState {
    live: u32,
    inflight: u32,
    /// Receipt succeeded; the matching `opened` event has not been applied.
    waiting_ws: HashSet<u64>,
    /// Recent `opened` ids so a receipt that lands after the event does not stick in inflight.
    ws_seen: HashMap<u64, Instant>,
}

const WS_SEEN_TTL: Duration = Duration::from_secs(180);

impl CountState {
    fn seed(live: u32) -> Self {
        Self {
            live,
            inflight: 0,
            waiting_ws: HashSet::new(),
            ws_seen: HashMap::new(),
        }
    }

    fn effective(&self) -> u32 {
        self.live.saturating_add(self.inflight)
    }

    fn prune_ws_seen(&mut self) {
        let cutoff = Instant::now() - WS_SEEN_TTL;
        self.ws_seen.retain(|_, seen_at| *seen_at >= cutoff);
    }

    fn on_submit_open(&mut self) {
        self.inflight = self.inflight.saturating_add(1);
    }

    fn on_open_fail(&mut self) {
        self.inflight = self.inflight.saturating_sub(1);
    }

    fn on_open_receipt(&mut self, position: u64) {
        self.prune_ws_seen();
        if self.ws_seen.remove(&position).is_some() {
            self.inflight = self.inflight.saturating_sub(1);
        } else {
            self.waiting_ws.insert(position);
        }
    }

    fn on_ws_opened(&mut self, position: u64) {
        self.live = self.live.saturating_add(1);
        if self.waiting_ws.remove(&position) {
            self.inflight = self.inflight.saturating_sub(1);
        } else {
            self.prune_ws_seen();
            self.ws_seen.insert(position, Instant::now());
        }
    }

    fn on_ws_closed(&mut self, position: u64) {
        self.live = self.live.saturating_sub(1);
        self.waiting_ws.remove(&position);
        self.ws_seen.remove(&position);
    }

    fn reconcile(&mut self, http_open: u32) {
        self.live = http_open;
        self.inflight = 0;
        self.waiting_ws.clear();
        self.ws_seen.clear();
    }
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

fn parse_human_amount6_raw(raw: &str) -> Result<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let (whole, frac) = match trimmed.split_once('.') {
        Some((w, f)) => (w, f),
        None => (trimmed, ""),
    };
    if !whole.chars().all(|c| c.is_ascii_digit())
        || frac.len() > 6
        || !frac.chars().all(|c| c.is_ascii_digit())
    {
        bail!("invalid amount string: {raw}");
    }
    let whole_u: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().context("amount whole")?
    };
    let frac_padded = format!("{frac:0<6}");
    let frac_u: u64 = frac_padded.parse().context("amount frac")?;
    whole_u
        .checked_mul(TOKEN_SCALE)
        .and_then(|v| v.checked_add(frac_u))
        .context("amount overflow")
}

fn run_cast(args: &[&str]) -> Result<()> {
    let out = Command::new("cast")
        .args(args)
        .output()
        .context("spawn cast (is foundry cast on PATH?)")?;
    if !out.status.success() {
        bail!(
            "cast {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(())
}

/// Bridge-deposit admin's Reth USDC into LightPool (mint is scripts/dev.sh), wait for credit.
async fn ensure_admin_lp_usdc(
    client: &IndexerHttp,
    admin_key: &str,
    admin_addr: &str,
    reth_rpc: &str,
    bridge: &BridgeStateFile,
    need_raw: u64,
) -> Result<()> {
    let token = bridge
        .tokens
        .iter()
        .find(|t| t.symbol.eq_ignore_ascii_case("USDC") || t.symbol.eq_ignore_ascii_case("USDT"))
        .or_else(|| bridge.tokens.first())
        .context("eth-bridge.json has no tokens")?;
    let usdc_evm = token.evm.trim();
    let lp = token.lp.trim();
    let evm_bridge = bridge.evm_bridge.trim();
    let admin = admin_addr.trim();
    let key = admin_key.trim();

    let have = client.lp_available_raw(admin, lp).await.unwrap_or(0);
    if have >= need_raw {
        tracing::info!(have, need_raw, "admin already has enough LP USDC");
        return Ok(());
    }
    let deficit = need_raw.saturating_sub(have);
    tracing::info!(
        have,
        need_raw,
        deficit,
        usdc_evm,
        evm_bridge,
        "admin LP USDC short — bridge deposit from Reth (mint via scripts/dev.sh)"
    );

    run_cast(&[
        "send",
        usdc_evm,
        "approve(address,uint256)",
        evm_bridge,
        &deficit.to_string(),
        "--rpc-url",
        reth_rpc,
        "--private-key",
        key,
    ])
    .context("reth approve bridge")?;

    run_cast(&[
        "send",
        evm_bridge,
        "deposit(address,uint64,address)",
        usdc_evm,
        &deficit.to_string(),
        admin,
        "--rpc-url",
        reth_rpc,
        "--private-key",
        key,
    ])
    .with_context(|| {
        format!(
            "reth bridge deposit failed (need {deficit} raw USDC on Reth for admin; \
             mint via scripts/dev.sh ADMIN_RETH_USDC_WHOLE)"
        )
    })?;

    let target = have.saturating_add(deficit);
    for i in 1..=60 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let now = client.lp_available_raw(admin, lp).await.unwrap_or(0);
        if now >= target {
            tracing::info!(now, elapsed_secs = i * 2, "admin LP USDC credited");
            return Ok(());
        }
        if i % 5 == 0 {
            tracing::info!(now, target, attempt = i, "waiting for bridge credit…");
        }
    }
    bail!("timed out waiting for admin LP USDC after bridge deposit (need {target})");
}

async fn fund_workers(
    client: &IndexerHttp,
    admin: &Signer,
    admin_key: &str,
    workers: Arc<Vec<Signer>>,
    usdc: &str,
    amount_usdc: u64,
    reth_rpc: &str,
    bridge: &BridgeStateFile,
) -> Result<()> {
    let amount = amount_usdc
        .checked_mul(TOKEN_SCALE)
        .context("fund amount overflow")?;
    let usdc_addr = parse_token_contract(usdc).map_err(|e| anyhow::anyhow!("usdc: {e}"))?;
    let admin_addr = admin.address();
    let admin_addr_s = admin_addr.to_string();
    let t0 = Instant::now();

    // Workers get transfers; admin keeps seed opens (2×1.2M) + AMM USDC reserve.
    let n_fund = workers
        .iter()
        .filter(|w| w.address() != admin_addr)
        .count() as u64;
    let admin_keep_usdc = ADMIN_SEED_MARGIN_USDC
        .saturating_mul(2)
        .saturating_add(ADMIN_BUYBACK_USDC_RESERVE);
    let admin_keep_raw = admin_keep_usdc
        .checked_mul(TOKEN_SCALE)
        .context("admin keep overflow")?;
    let workers_raw = amount
        .checked_mul(n_fund)
        .context("workers fund overflow")?;
    let need_raw = workers_raw
        .checked_add(admin_keep_raw)
        .context("total fund overflow")?;
    ensure_admin_lp_usdc(
        client,
        admin_key,
        &admin_addr_s,
        reth_rpc,
        bridge,
        need_raw,
    )
    .await
    .context("admin Reth→LP USDC")?;

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
    tracing::info!(
        accounts = workers.len(),
        elapsed_ms = t0.elapsed().as_millis() as u64,
        "fund workers done (LP USDC only; open pulls margin from token balance)"
    );
    Ok(())
}

async fn admin_seed_buyback_positions(
    client: &IndexerHttp,
    admin: &Signer,
    paper_market: &str,
    instrument: u32,
) -> Result<()> {
    let margin_raw = ADMIN_SEED_MARGIN_USDC
        .checked_mul(TOKEN_SCALE)
        .context("admin seed margin overflow")?;
    for is_long in [true, false] {
        let tx = sign_open(
            admin,
            paper_market,
            instrument,
            is_long,
            margin_raw,
            ADMIN_SEED_LEVERAGE,
        )
        .context("sign admin seed open")?;
        let response = client.submit(tx).await.context("submit admin seed open")?;
        if !response.receipt.is_success() {
            bail!(
                "admin seed open (is_long={is_long}) failed: {:?}",
                response.receipt.status
            );
        }
        tracing::info!(
            is_long,
            margin_usdc = ADMIN_SEED_MARGIN_USDC,
            leverage = ADMIN_SEED_LEVERAGE,
            "admin seed open for buyback PAPER (liqd keeps PAPER, no stake)"
        );
    }
    Ok(())
}

fn sign_open(
    signer: &Signer,
    paper_market: &str,
    instrument: u32,
    is_long: bool,
    margin_raw: u64,
    leverage: u64,
) -> Result<SignedTransaction> {
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
    TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)
        .context("sign open")
}

fn sign_close(signer: &Signer, paper_market: &str, position: u64) -> Result<SignedTransaction> {
    let paper =
        parse_token_contract(paper_market).map_err(|e| anyhow::anyhow!("paper market: {e}"))?;
    let owner = signer.address();
    let action = ActionBuilder::close_paper(paper, PaperCloseParams { positions: vec![position] })
        .context("build close")?;
    TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)
        .context("sign close")
}

static STAKE_TX_SEQ: AtomicU64 = AtomicU64::new(0);

fn sign_stake(signer: &Signer, paper_market: &str, amount: u64) -> Result<SignedTransaction> {
    let paper =
        parse_token_contract(paper_market).map_err(|e| anyhow::anyhow!("paper market: {e}"))?;
    let owner = signer.address();
    let action = ActionBuilder::stake_paper(paper, PaperStakeParams { amount })
        .context("build stake")?;
    // Unique expiration so identical stake amounts do not share a digest.
    let expiration = u64::MAX - STAKE_TX_SEQ.fetch_add(1, Ordering::Relaxed);
    TransactionBuilder::new()
        .sender(owner)
        .account(owner)
        .expiration(expiration)
        .add_action(action)
        .build_and_sign_only(signer)
        .context("sign stake")
}

struct CloseReq {
    account_idx: usize,
    position: u64,
    roe: f64,
}

struct StakeReq {
    account_idx: usize,
    position: u64,
}

struct SendPool {
    client: IndexerHttp,
    permits: Arc<Semaphore>,
}

fn spawn_open_submit(
    pool: &SendPool,
    tx: SignedTransaction,
    draw: OpenDraw,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
    counts: Arc<Mutex<CountState>>,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    let client = pool.client.clone();
    tokio::spawn(async move {
        let _permit = permit;
        match client.submit(tx).await {
            Ok(response) if response.receipt.is_success() => {
                let Some(ev) = extract_paper_opened(&response.receipt) else {
                    counts.lock().await.on_open_fail();
                    tracing::warn!("open ok but missing paper_opened event");
                    return;
                };
                counts.lock().await.on_open_receipt(ev.position);
                book.lock().await.insert(
                    ev.position,
                    TrackedOpen {
                        account_idx: draw.account_idx,
                        position: ev.position,
                        is_long: ev.is_long,
                        margin: ev.margin,
                        notional: ev.notional,
                        entry_price: ev.entry_price,
                        closing: false,
                    },
                );
            }
            Ok(response) => {
                counts.lock().await.on_open_fail();
                tracing::warn!(status = ?response.receipt.status, "open receipt failed");
            }
            Err(err) => {
                counts.lock().await.on_open_fail();
                tracing::warn!(error = %err, "open submit failed");
            }
        }
    });
}

fn spawn_close_submit(
    pool: &SendPool,
    tx: SignedTransaction,
    req: CloseReq,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
    mark: u64,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    let client = pool.client.clone();
    tokio::spawn(async move {
        let _permit = permit;
        match client.submit(tx).await {
            Ok(response) if response.receipt.is_success() => {
                book.lock().await.remove(&req.position);
                tracing::info!(
                    position = req.position,
                    account_idx = req.account_idx,
                    roe = format!("{:.2}", req.roe),
                    mark,
                    "take-profit close ok"
                );
            }
            other => {
                let err_s = match &other {
                    Ok(response) => format!("receipt {:?}", response.receipt.status),
                    Err(err) => err.to_string(),
                };
                let gone = err_s.contains("not found")
                    || err_s.contains("Not found")
                    || err_s.contains("not liquidatable")
                    || err_s.contains("already");
                if gone {
                    book.lock().await.remove(&req.position);
                    tracing::info!(
                        position = req.position,
                        account_idx = req.account_idx,
                        error = %err_s,
                        "drop from book after close miss (likely already liqd/closed)"
                    );
                } else if let Some(pos) = book.lock().await.get_mut(&req.position) {
                    pos.closing = false;
                    tracing::warn!(
                        position = req.position,
                        account_idx = req.account_idx,
                        error = %err_s,
                        "take-profit close failed"
                    );
                }
            }
        }
    });
}

fn spawn_stake_submit(
    pool: &SendPool,
    tx: SignedTransaction,
    req: StakeReq,
    amount: u64,
    permit: tokio::sync::OwnedSemaphorePermit,
    stake_pending: Arc<Mutex<HashSet<usize>>>,
) {
    let client = pool.client.clone();
    tokio::spawn(async move {
        let _permit = permit;
        match client.submit(tx).await {
            Ok(response) if response.receipt.is_success() => {
                tracing::info!(
                    position = req.position,
                    account_idx = req.account_idx,
                    amount,
                    "liqd stake ok"
                );
            }
            Ok(response) => {
                tracing::warn!(
                    position = req.position,
                    account_idx = req.account_idx,
                    amount,
                    status = ?response.receipt.status,
                    "liqd stake receipt failed"
                );
            }
            Err(err) => {
                tracing::warn!(
                    position = req.position,
                    account_idx = req.account_idx,
                    amount,
                    error = %err,
                    "liqd stake submit failed"
                );
            }
        }
        stake_pending.lock().await.remove(&req.account_idx);
    });
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

fn position_event(msg: &Value) -> Option<&'static str> {
    let ev = msg.get("event")?.as_str()?;
    match ev.to_ascii_lowercase().as_str() {
        "opened" | "open" => Some("opened"),
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

/// Count every open/close/liquidation on this market. Drop tracked rows on close/liqd.
/// Queue one paper stake per worker account while a stake is already pending.
/// Liquidations for `admin_addr` keep PAPER (no stake) for buyback-amm.
fn spawn_positions_ws(
    ws_url: String,
    paper_market: String,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
    counts: Arc<Mutex<CountState>>,
    worker_by_addr: Arc<HashMap<String, usize>>,
    stake_tx: mpsc::Sender<StakeReq>,
    stake_pending: Arc<Mutex<HashSet<usize>>>,
    admin_addr: String,
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
                    tracing::info!(%ws_url, "paper.positions ws subscribed");
                    while let Some(msg) = read.next().await {
                        let Ok(msg) = msg else { break };
                        match msg {
                            Message::Text(text) => {
                                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                                    continue;
                                };
                                let Some(kind) = position_event(&value) else {
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
                                if kind == "opened" {
                                    counts.lock().await.on_ws_opened(position);
                                    continue;
                                }
                                counts.lock().await.on_ws_closed(position);
                                let tracked = book.lock().await.remove(&position);
                                if tracked.is_some() {
                                    tracing::info!(
                                        position,
                                        event = kind,
                                        "removed from book (indexer lifecycle)"
                                    );
                                }
                                if kind != "liquidated" {
                                    continue;
                                }
                                let owner = value
                                    .get("user_address")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .trim()
                                    .to_ascii_lowercase();
                                if !admin_addr.is_empty() && owner == admin_addr {
                                    tracing::info!(
                                        position,
                                        %owner,
                                        "admin liqd — keep PAPER for buyback-amm (no stake)"
                                    );
                                    continue;
                                }
                                let account_idx = tracked
                                    .map(|t| t.account_idx)
                                    .or_else(|| worker_by_addr.get(&owner).copied());
                                let Some(account_idx) = account_idx else {
                                    continue;
                                };
                                {
                                    let mut pending = stake_pending.lock().await;
                                    if !pending.insert(account_idx) {
                                        tracing::debug!(
                                            position,
                                            account_idx,
                                            "liqd stake coalesced (account already pending)"
                                        );
                                        continue;
                                    }
                                }
                                if stake_tx
                                    .try_send(StakeReq {
                                        account_idx,
                                        position,
                                    })
                                    .is_err()
                                {
                                    stake_pending.lock().await.remove(&account_idx);
                                    tracing::warn!(
                                        position,
                                        account_idx,
                                        "liqd stake queue full"
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
    spot_market: String,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
    mark_raw: Arc<AtomicU64>,
    take_profit_pct: f64,
    batch: u32,
    close_tx: mpsc::Sender<CloseReq>,
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
                if close_tx
                    .try_send(CloseReq {
                        account_idx,
                        position,
                        roe,
                    })
                    .is_err()
                {
                    if let Some(pos) = book.lock().await.get_mut(&position) {
                        pos.closing = false;
                    }
                }
            }
        }
    });
}

fn spawn_reconcile(
    client: Arc<IndexerHttp>,
    paper_market: String,
    counts: Arc<Mutex<CountState>>,
    every: Duration,
) {
    tokio::spawn(async move {
        let mut tick = interval(every);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            match client.open_positions(&paper_market).await {
                Ok(open) => {
                    let mut guard = counts.lock().await;
                    let before = guard.live;
                    let inflight = guard.inflight;
                    guard.reconcile(open);
                    tracing::info!(before, inflight, open, "reconcile open_positions");
                }
                Err(err) => {
                    tracing::warn!(error = %err, "reconcile open_positions failed");
                }
            }
        }
    });
}

fn sync_open_phase(
    phase_fill: &mut bool,
    topping: &mut bool,
    live: u32,
    args: &Args,
    floor: u32,
    fill_start: Instant,
    mark: u64,
) {
    if *topping && live >= args.target {
        *topping = false;
        if *phase_fill {
            *phase_fill = false;
            tracing::info!(
                open = live,
                elapsed_s = fill_start.elapsed().as_secs(),
                "fill done"
            );
            tracing::info!(
                poll_ms = args.hold_poll_ms,
                band = args.band,
                "phase=HOLD (Ctrl-C to stop)"
            );
        } else {
            tracing::info!(open = live, "top-up done");
        }
    } else if !*phase_fill && !*topping && live < floor {
        *topping = true;
        tracing::info!(open = live, floor, target = args.target, "top-up");
    } else if !*phase_fill && !*topping {
        tracing::debug!(open = live, floor, mark, "hold ok");
    }
}

enum SignWork {
    Stake(StakeReq),
    Close(CloseReq),
    Open,
}

async fn run_sign_loop(
    client: Arc<IndexerHttp>,
    traders: Arc<Vec<Signer>>,
    paper_market: String,
    paper_token: String,
    args: &Args,
    book: Arc<Mutex<HashMap<u64, TrackedOpen>>>,
    counts: Arc<Mutex<CountState>>,
    mark_raw: Arc<AtomicU64>,
    mut stake_rx: mpsc::Receiver<StakeReq>,
    mut close_rx: mpsc::Receiver<CloseReq>,
    stake_pending: Arc<Mutex<HashSet<usize>>>,
    mut rng: StdRng,
    soak_start: Instant,
) {
    let senders = args.senders.clamp(1, 64) as usize;
    let pool = SendPool {
        client: (*client).clone(),
        permits: Arc::new(Semaphore::new(senders)),
    };
    let mut rate = RateLimiter::new(args.rate);
    let floor = args.target.saturating_sub(args.band);
    let idle = Duration::from_millis(args.hold_poll_ms.max(200));
    let mut phase_fill = counts.lock().await.live < args.target;
    let mut topping = phase_fill;
    let fill_start = Instant::now();
    let mut signed = 0u32;
    if phase_fill {
        tracing::info!("phase=FILL");
    } else {
        tracing::info!(
            open = counts.lock().await.live,
            "already at/above target; skip FILL"
        );
        tracing::info!(
            poll_ms = args.hold_poll_ms,
            band = args.band,
            "phase=HOLD (Ctrl-C to stop)"
        );
    }

    loop {
        let work = if let Ok(req) = stake_rx.try_recv() {
            SignWork::Stake(req)
        } else if let Ok(req) = close_rx.try_recv() {
            SignWork::Close(req)
        } else {
            let need_open = {
                let guard = counts.lock().await;
                topping && guard.effective() < args.target
            };
            if need_open {
                SignWork::Open
            } else {
                tokio::select! {
                    req = stake_rx.recv() => {
                        match req {
                            Some(req) => SignWork::Stake(req),
                            None => {
                                tokio::time::sleep(idle).await;
                                let live = counts.lock().await.live;
                                sync_open_phase(
                                    &mut phase_fill,
                                    &mut topping,
                                    live,
                                    args,
                                    floor,
                                    fill_start,
                                    mark_raw.load(Ordering::Relaxed),
                                );
                                continue;
                            }
                        }
                    }
                    req = close_rx.recv() => {
                        match req {
                            Some(req) => SignWork::Close(req),
                            None => {
                                tokio::time::sleep(idle).await;
                                let live = counts.lock().await.live;
                                sync_open_phase(
                                    &mut phase_fill,
                                    &mut topping,
                                    live,
                                    args,
                                    floor,
                                    fill_start,
                                    mark_raw.load(Ordering::Relaxed),
                                );
                                continue;
                            }
                        }
                    }
                    _ = tokio::time::sleep(idle) => {
                        let live = counts.lock().await.live;
                        sync_open_phase(
                            &mut phase_fill,
                            &mut topping,
                            live,
                            args,
                            floor,
                            fill_start,
                            mark_raw.load(Ordering::Relaxed),
                        );
                        continue;
                    }
                }
            }
        };

        if matches!(work, SignWork::Open | SignWork::Close(_)) {
            rate.wait().await;
        }

        match work {
            SignWork::Stake(req) => {
                let clear_pending = |pending: &Arc<Mutex<HashSet<usize>>>, idx: usize| {
                    let pending = Arc::clone(pending);
                    async move {
                        pending.lock().await.remove(&idx);
                    }
                };
                let Some(signer) = traders.get(req.account_idx) else {
                    clear_pending(&stake_pending, req.account_idx).await;
                    continue;
                };
                if paper_token.is_empty() {
                    tracing::warn!(
                        position = req.position,
                        "skip liqd stake: paper_token missing from bootstrap"
                    );
                    clear_pending(&stake_pending, req.account_idx).await;
                    continue;
                }
                let owner = signer.address().to_string();
                let mut amount = 0u64;
                let mut last_err: Option<String> = None;
                for attempt in 0..5u32 {
                    match client.lp_available_raw(&owner, &paper_token).await {
                        Ok(raw) if raw > 0 => {
                            amount = raw;
                            break;
                        }
                        Ok(_) => {}
                        Err(err) => last_err = Some(err.to_string()),
                    }
                    if attempt + 1 < 5 {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
                if amount == 0 {
                    if let Some(err) = last_err {
                        tracing::warn!(
                            position = req.position,
                            account_idx = req.account_idx,
                            error = %err,
                            "liqd stake balance failed"
                        );
                    } else {
                        tracing::debug!(
                            position = req.position,
                            account_idx = req.account_idx,
                            "liqd stake skipped (no paper balance)"
                        );
                    }
                    clear_pending(&stake_pending, req.account_idx).await;
                    continue;
                }
                let tx = match sign_stake(signer, &paper_market, amount) {
                    Ok(tx) => tx,
                    Err(err) => {
                        tracing::warn!(
                            position = req.position,
                            account_idx = req.account_idx,
                            amount,
                            error = %err,
                            "sign stake failed"
                        );
                        clear_pending(&stake_pending, req.account_idx).await;
                        continue;
                    }
                };
                let Ok(permit) = pool.permits.clone().acquire_owned().await else {
                    clear_pending(&stake_pending, req.account_idx).await;
                    continue;
                };
                spawn_stake_submit(
                    &pool,
                    tx,
                    req,
                    amount,
                    permit,
                    Arc::clone(&stake_pending),
                );
                continue;
            }
            SignWork::Close(req) => {
                let Some(signer) = traders.get(req.account_idx) else {
                    if let Some(pos) = book.lock().await.get_mut(&req.position) {
                        pos.closing = false;
                    }
                    continue;
                };
                let tx = match sign_close(signer, &paper_market, req.position) {
                    Ok(tx) => tx,
                    Err(err) => {
                        if let Some(pos) = book.lock().await.get_mut(&req.position) {
                            pos.closing = false;
                        }
                        tracing::warn!(position = req.position, error = %err, "sign close failed");
                        continue;
                    }
                };
                let Ok(permit) = pool.permits.clone().acquire_owned().await else {
                    if let Some(pos) = book.lock().await.get_mut(&req.position) {
                        pos.closing = false;
                    }
                    continue;
                };
                let mark = mark_raw.load(Ordering::Relaxed);
                spawn_close_submit(&pool, tx, req, Arc::clone(&book), mark, permit);
                continue;
            }
            SignWork::Open => {}
        }

        let draw = match draw_open(&mut rng, args, traders.len(), soak_start) {
            Ok(draw) => draw,
            Err(err) => {
                tracing::warn!(error = %err, "draw open failed");
                continue;
            }
        };
        let signer = &traders[draw.account_idx];
        counts.lock().await.on_submit_open();
        let tx = match sign_open(
            signer,
            &paper_market,
            args.instrument,
            draw.is_long,
            draw.margin_raw,
            draw.leverage,
        ) {
            Ok(tx) => tx,
            Err(err) => {
                counts.lock().await.on_open_fail();
                tracing::warn!(error = %err, "sign open failed");
                continue;
            }
        };
        let Ok(permit) = pool.permits.clone().acquire_owned().await else {
            counts.lock().await.on_open_fail();
            continue;
        };
        spawn_open_submit(
            &pool,
            tx,
            draw,
            Arc::clone(&book),
            Arc::clone(&counts),
            permit,
        );
        signed += 1;
        if signed % 50 == 0 {
            let guard = counts.lock().await;
            let tracked = book.lock().await.len();
            tracing::info!(
                open = guard.live,
                inflight = guard.inflight,
                tracked,
                target = args.target,
                elapsed_s = fill_start.elapsed().as_secs(),
                p_long = format!("{:.2}", long_prob_at(args, soak_start)),
                "open progress"
            );
        }

        let live = counts.lock().await.live;
        sync_open_phase(
            &mut phase_fill,
            &mut topping,
            live,
            args,
            floor,
            fill_start,
            mark_raw.load(Ordering::Relaxed),
        );
    }
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
    if args.reconcile_mins == 0 {
        bail!("--reconcile-mins must be >= 1");
    }
    if args.senders == 0 {
        bail!("--senders must be >= 1");
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
    let admin_addr = admin.address().to_string().to_ascii_lowercase();
    // Workers only in the soak loop; admin seeds two positions separately.
    let mut workers_vec = Vec::with_capacity(args.accounts as usize);
    for i in 0..args.accounts {
        workers_vec.push(worker_signer(i)?);
    }
    let workers = Arc::new(workers_vec);
    let mut worker_by_addr = HashMap::with_capacity(workers.len());
    for (idx, signer) in workers.iter().enumerate() {
        worker_by_addr.insert(signer.address().to_string().to_ascii_lowercase(), idx);
    }
    let worker_by_addr = Arc::new(worker_by_addr);
    let rng = StdRng::from_entropy();
    let book: Arc<Mutex<HashMap<u64, TrackedOpen>>> = Arc::new(Mutex::new(HashMap::new()));
    let mark_raw = Arc::new(AtomicU64::new(0));
    let running = Arc::new(AtomicBool::new(true));
    let soak_start = Instant::now();

    let bootstrap_path = resolve_path(&args.bootstrap_path);
    let bootstrap: BootstrapFile = serde_json::from_str(
        &std::fs::read_to_string(&bootstrap_path)
            .with_context(|| format!("read bootstrap {}", bootstrap_path.display()))?,
    )
    .context("parse bootstrap.json")?;
    let paper_token = bootstrap.paper_token.trim().to_string();

    tracing::info!(
        indexer = %args.indexer_url,
        paper_market = %paper_market,
        paper_token = %paper_token,
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
        senders = args.senders.clamp(1, 64),
        reconcile_mins = args.reconcile_mins,
        "hold-opens starting"
    );

    if args.fund_usdc > 0 {
        let bridge_path = resolve_path(&args.bridge_state_path);
        let bridge: BridgeStateFile = serde_json::from_str(
            &std::fs::read_to_string(&bridge_path)
                .with_context(|| format!("read bridge state {}", bridge_path.display()))?,
        )
        .context("parse eth-bridge.json")?;
        let usdc = bootstrap.usdc.trim();
        if usdc.is_empty() {
            bail!("bootstrap.json missing usdc");
        }
        let _ = args.fund_concurrency;
        tracing::info!(
            accounts = args.accounts,
            fund_usdc = args.fund_usdc,
            reth_rpc = %args.reth_rpc,
            "funding: admin Reth→LP deposit → LP transfer to workers"
        );
        fund_workers(
            &client,
            &admin,
            &args.admin_key,
            Arc::clone(&workers),
            usdc,
            args.fund_usdc,
            &args.reth_rpc,
            &bridge,
        )
        .await
        .context("fund workers")?;
    }

    admin_seed_buyback_positions(&client, &admin, &paper_market, args.instrument)
        .await
        .context("admin seed long+short for buyback PAPER")?;

    let open = client.open_positions(&paper_market).await?;
    let counts = Arc::new(Mutex::new(CountState::seed(open)));
    tracing::info!(open, target = args.target, "seeded open count from indexer");

    let (stake_tx, stake_rx) = mpsc::channel::<StakeReq>(1024);
    let stake_pending: Arc<Mutex<HashSet<usize>>> = Arc::new(Mutex::new(HashSet::new()));
    spawn_positions_ws(
        client.ws_url(),
        paper_market.clone(),
        Arc::clone(&book),
        Arc::clone(&counts),
        Arc::clone(&worker_by_addr),
        stake_tx,
        Arc::clone(&stake_pending),
        admin_addr,
    );
    spawn_reconcile(
        Arc::clone(&client),
        paper_market.clone(),
        Arc::clone(&counts),
        Duration::from_secs(args.reconcile_mins.saturating_mul(60)),
    );

    if let Ok(raw) = client.oracle_mark_raw(&spot_market).await {
        mark_raw.store(raw, Ordering::Relaxed);
        tracing::info!(mark_raw = raw, %spot_market, "seeded oracle mark");
    }
    spawn_oracle_ws(client.ws_url(), spot_market.clone(), Arc::clone(&mark_raw));

    let (close_tx, close_rx) = mpsc::channel::<CloseReq>(256);
    if args.take_profit_pct > 0.0 {
        spawn_take_profit_loop(
            Arc::clone(&client),
            spot_market.clone(),
            Arc::clone(&book),
            Arc::clone(&mark_raw),
            args.take_profit_pct,
            args.take_profit_batch.max(1),
            close_tx.clone(),
            Arc::clone(&running),
        );
        tracing::info!(
            take_profit_pct = args.take_profit_pct,
            "take-profit enabled (close when ROE >= pct)"
        );
    } else {
        tracing::info!("take-profit disabled (--take-profit-pct 0)");
    }
    let _keep_close_tx = close_tx;

    run_sign_loop(
        client,
        workers,
        paper_market,
        paper_token,
        &args,
        book,
        counts,
        mark_raw,
        stake_rx,
        close_rx,
        stake_pending,
        rng,
        soak_start,
    )
    .await;
    Ok(())
}
