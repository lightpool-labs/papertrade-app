// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper liquidation keeper: snapshot + `paper.positions` WS + oracle WS driven.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use lightpool_sdk::{
    parse_token_contract, ActionBuilder, PaperLiquidateParams, Signer, TransactionBuilder,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use crate::config::{InstrumentRecord, MarketsFile};
use crate::indexer::{IndexerHttp, PaperPositionOpen};
use crate::ws::{indexer_ws_url, spawn_reconnect_loop};

pub fn load_signer(raw: &str) -> Result<Signer> {
    let hex_body = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(hex_body).context("decode keeper private key")?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("keeper key must be 32 bytes"))?;
    Signer::from_secret_key_bytes(&key).context("load Signer")
}

/// Long busts when oracle falls through bust; short when oracle rises through bust.
pub fn is_bustable(is_long: bool, oracle_price_raw: u64, bust_price_raw: u64) -> bool {
    if oracle_price_raw == 0 || bust_price_raw == 0 {
        return false;
    }
    if is_long {
        oracle_price_raw <= bust_price_raw
    } else {
        oracle_price_raw >= bust_price_raw
    }
}

fn price_market_by_instrument(markets: &MarketsFile) -> HashMap<u32, String> {
    markets
        .instruments
        .iter()
        .filter(|i| !i.retired && !i.price_market.trim().is_empty())
        .map(|i: &InstrumentRecord| (i.id, i.price_market.trim().to_string()))
        .collect()
}

fn pos_key(market: &str, position: u64) -> String {
    format!("{}:{position}", market.trim().to_ascii_lowercase())
}

#[derive(Debug, Clone)]
struct TrackedPos {
    market: String,
    position: u64,
    owner: String,
    instrument: u32,
    is_long: bool,
    bust_price_raw: u64,
    price_market: String,
}

#[derive(Default)]
struct OpenBook {
    by_key: HashMap<String, TrackedPos>,
    by_spot: HashMap<String, HashSet<String>>,
    /// In-flight / recently submitted liqd keys to avoid double-submit.
    pending: HashSet<String>,
}

impl OpenBook {
    fn upsert(&mut self, pos: TrackedPos) {
        let key = pos_key(&pos.market, pos.position);
        let spot = pos.price_market.trim().to_ascii_lowercase();
        if let Some(old) = self.by_key.insert(key.clone(), pos) {
            let old_spot = old.price_market.trim().to_ascii_lowercase();
            if old_spot != spot {
                if let Some(set) = self.by_spot.get_mut(&old_spot) {
                    set.remove(&key);
                }
            }
        }
        self.by_spot.entry(spot).or_default().insert(key);
    }

    fn remove(&mut self, market: &str, position: u64) {
        let key = pos_key(market, position);
        self.pending.remove(&key);
        if let Some(old) = self.by_key.remove(&key) {
            let spot = old.price_market.trim().to_ascii_lowercase();
            if let Some(set) = self.by_spot.get_mut(&spot) {
                set.remove(&key);
                if set.is_empty() {
                    self.by_spot.remove(&spot);
                }
            }
        }
    }

    fn replace_all(&mut self, rows: Vec<TrackedPos>) {
        self.by_key.clear();
        self.by_spot.clear();
        self.pending.clear();
        for row in rows {
            self.upsert(row);
        }
    }

    fn for_spot(&self, spot: &str) -> Vec<TrackedPos> {
        let spot = spot.trim().to_ascii_lowercase();
        let Some(keys) = self.by_spot.get(&spot) else {
            return Vec::new();
        };
        keys.iter()
            .filter_map(|k| self.by_key.get(k).cloned())
            .collect()
    }
}

#[derive(Debug, Deserialize)]
struct PaperPositionEvent {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    event: Option<String>,
    user_address: Option<String>,
    market: Option<String>,
    position: Option<u64>,
    instrument: Option<u32>,
    is_long: Option<bool>,
    bust_price_raw: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OracleEvent {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    spot_market: Option<String>,
    oracle_price_raw: Option<u64>,
    mark_price_raw: Option<u64>,
}

#[derive(Clone, Copy)]
pub struct SideLoops {
    pub enable_harvest: bool,
    pub enable_push_fees: bool,
    pub harvest_max_entries: u32,
    pub side_poll: Duration,
}

/// Event-driven liqd loop: HTTP snapshot, `paper.positions` + `oracle` WS, slow reconcile.
/// Optionally runs harvest / push_fees on `side_poll` in the same task (Signer is !Send).
pub async fn run_loop(
    client: IndexerHttp,
    signer: &Signer,
    markets_path: std::path::PathBuf,
    initial_markets: MarketsFile,
    page_limit: u32,
    reconcile_every: Duration,
    side: SideLoops,
) -> Result<()> {
    let mut markets = initial_markets;
    let mut price_map = price_market_by_instrument(&markets);
    if price_map.is_empty() {
        bail!("no instruments with price_market in markets.json");
    }

    let book = Arc::new(Mutex::new(OpenBook::default()));
    load_snapshot(&client, &markets, &price_map, page_limit, &book).await?;

    let ws_url = indexer_ws_url(client.base_url());
    let (pos_tx, mut pos_rx) = mpsc::channel::<Value>(256);
    let (oracle_tx, mut oracle_rx) = mpsc::channel::<Value>(256);

    let pos_subs = vec![json!({
        "op": "subscribe",
        "channel": "paper.positions",
    })];
    let _pos_ws = spawn_reconnect_loop(ws_url.clone(), pos_subs, pos_tx);

    let mut oracle_subs = Vec::new();
    let mut seen_spots = HashSet::new();
    for spot in price_map.values() {
        let key = spot.trim().to_ascii_lowercase();
        if seen_spots.insert(key) {
            oracle_subs.push(json!({
                "op": "subscribe",
                "channel": "oracle",
                "spot_market": spot.trim(),
            }));
        }
    }
    let _oracle_ws = spawn_reconnect_loop(ws_url, oracle_subs, oracle_tx);

    tracing::info!(
        opens = book.lock().await.by_key.len(),
        spots = seen_spots.len(),
        "liqd event loop ready (paper.positions + oracle)"
    );

    let mut reconcile = tokio::time::interval(reconcile_every);
    reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut side_tick = tokio::time::interval(side.side_poll.max(Duration::from_millis(100)));
    side_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            Some(msg) = pos_rx.recv() => {
                handle_position_event(&msg, &price_map, &book).await;
            }
            Some(msg) = oracle_rx.recv() => {
                if let Err(err) = handle_oracle_tick(
                    &msg,
                    &client,
                    signer,
                    &book,
                ).await {
                    tracing::error!(error = %err, "liqd oracle tick failed");
                }
            }
            _ = reconcile.tick() => {
                if let Ok(next) = crate::config::load_markets_file(&markets_path) {
                    markets = next;
                    price_map = price_market_by_instrument(&markets);
                }
                if let Err(err) = load_snapshot(
                    &client,
                    &markets,
                    &price_map,
                    page_limit,
                    &book,
                ).await {
                    tracing::warn!(error = %err, "liqd reconcile snapshot failed");
                } else {
                    let spots: Vec<String> = book.lock().await.by_spot.keys().cloned().collect();
                    for spot in spots {
                        match client.get_oracle_mark(&spot).await {
                            Ok(mark) => {
                                let price_raw = if mark.mark_price_raw > 0 {
                                    mark.mark_price_raw
                                } else {
                                    mark.oracle_price_raw
                                };
                                if let Err(err) = scan_spot(
                                    &client,
                                    signer,
                                    &book,
                                    &spot,
                                    price_raw,
                                ).await {
                                    tracing::warn!(%spot, error = %err, "liqd reconcile scan failed");
                                }
                            }
                            Err(err) => {
                                tracing::debug!(%spot, error = %err, "reconcile oracle miss");
                            }
                        }
                    }
                }
            }
            _ = side_tick.tick(), if side.enable_harvest || side.enable_push_fees => {
                let paper = markets.paper_market.trim();
                if paper.is_empty() {
                    continue;
                }
                if side.enable_harvest {
                    match crate::harvest::run_once(
                        &client,
                        signer,
                        paper,
                        side.harvest_max_entries,
                    ).await {
                        Ok(true) => tracing::info!("harvest tick done"),
                        Ok(false) => tracing::debug!("harvest tick: nothing to pay"),
                        Err(err) => tracing::error!(error = %err, "harvest tick failed"),
                    }
                }
                if side.enable_push_fees {
                    match crate::push_fees::run_once(&client, signer, paper).await {
                        Ok(true) => tracing::info!("push_fees tick done"),
                        Ok(false) => tracing::debug!("push_fees tick: nothing to distribute"),
                        Err(err) => tracing::error!(error = %err, "push_fees tick failed"),
                    }
                }
            }
        }
    }
}

async fn load_snapshot(
    client: &IndexerHttp,
    markets: &MarketsFile,
    price_map: &HashMap<u32, String>,
    page_limit: u32,
    book: &Arc<Mutex<OpenBook>>,
) -> Result<()> {
    let open = client
        .list_all_open_positions(Some(markets.paper_market.trim()), page_limit)
        .await
        .context("list open positions")?;
    let mut rows = Vec::new();
    for row in open {
        let Some(spot) = price_map.get(&row.instrument) else {
            continue;
        };
        rows.push(tracked_from_open(&row, spot));
    }
    let n = rows.len();
    book.lock().await.replace_all(rows);
    tracing::info!(opens = n, "liqd open book snapshot loaded");
    Ok(())
}

fn tracked_from_open(row: &PaperPositionOpen, price_market: &str) -> TrackedPos {
    TrackedPos {
        market: row.market.clone(),
        position: row.position,
        owner: row.owner.clone(),
        instrument: row.instrument,
        is_long: row.is_long,
        bust_price_raw: row.bust_price_raw,
        price_market: price_market.to_string(),
    }
}

async fn handle_position_event(
    msg: &Value,
    price_map: &HashMap<u32, String>,
    book: &Arc<Mutex<OpenBook>>,
) {
    let Ok(ev) = serde_json::from_value::<PaperPositionEvent>(msg.clone()) else {
        return;
    };
    let msg_type = ev.msg_type.as_deref().unwrap_or("");
    if msg_type == "subscribed" || msg_type == "unsubscribed" || msg_type == "error" {
        return;
    }
    if msg_type != "paper_position" && ev.event.is_none() {
        return;
    }
    let event = ev.event.as_deref().unwrap_or("");
    let market = ev.market.as_deref().unwrap_or("").trim();
    let Some(position) = ev.position else {
        return;
    };
    if market.is_empty() {
        return;
    }

    match event {
        "opened" => {
            let Some(instrument) = ev.instrument else {
                return;
            };
            let Some(is_long) = ev.is_long else {
                return;
            };
            let Some(bust) = ev.bust_price_raw else {
                return;
            };
            let Some(spot) = price_map.get(&instrument) else {
                return;
            };
            book.lock().await.upsert(TrackedPos {
                market: market.to_string(),
                position,
                owner: ev.user_address.unwrap_or_default(),
                instrument,
                is_long,
                bust_price_raw: bust,
                price_market: spot.clone(),
            });
            tracing::debug!(%market, position, "liqd book: opened");
        }
        "closed" | "liquidated" => {
            book.lock().await.remove(market, position);
            tracing::debug!(%market, position, event, "liqd book: removed");
        }
        _ => {}
    }
}

async fn handle_oracle_tick(
    msg: &Value,
    client: &IndexerHttp,
    signer: &Signer,
    book: &Arc<Mutex<OpenBook>>,
) -> Result<()> {
    let Ok(ev) = serde_json::from_value::<OracleEvent>(msg.clone()) else {
        return Ok(());
    };
    let msg_type = ev.msg_type.as_deref().unwrap_or("");
    if msg_type == "subscribed" || msg_type == "unsubscribed" || msg_type == "error" {
        return Ok(());
    }
    let spot = ev.spot_market.as_deref().unwrap_or("").trim();
    if spot.is_empty() {
        return Ok(());
    }
    // Chain liqd reads the clamped price stored on the spot market.
    // The event reports that value as mark_price; oracle_price is the unclamped median.
    let price_raw = ev
        .mark_price_raw
        .filter(|price| *price > 0)
        .or(ev.oracle_price_raw)
        .filter(|price| *price > 0);
    let Some(price_raw) = price_raw else {
        return Ok(());
    };
    scan_spot(client, signer, book, spot, price_raw).await
}

async fn scan_spot(
    client: &IndexerHttp,
    signer: &Signer,
    book: &Arc<Mutex<OpenBook>>,
    spot: &str,
    oracle_raw: u64,
) -> Result<()> {
    let candidates = {
        let mut guard = book.lock().await;
        let rows = guard.for_spot(spot);
        rows.into_iter()
            .filter(|row| {
                if !is_bustable(row.is_long, oracle_raw, row.bust_price_raw) {
                    return false;
                }
                let key = pos_key(&row.market, row.position);
                if guard.pending.contains(&key) {
                    return false;
                }
                guard.pending.insert(key);
                true
            })
            .collect::<Vec<_>>()
    };

    for row in candidates {
        let key = pos_key(&row.market, row.position);
        match liquidate_one(client, signer, &row, oracle_raw).await {
            Ok(digest) => {
                tracing::info!(
                    position = row.position,
                    instrument = row.instrument,
                    owner = %row.owner,
                    is_long = row.is_long,
                    oracle_raw,
                    bust_raw = row.bust_price_raw,
                    %digest,
                    "liqd submitted"
                );
                // Keep pending until closed/liquidated WS or reconcile removes it.
            }
            Err(err) => {
                book.lock().await.pending.remove(&key);
                tracing::warn!(
                    position = row.position,
                    owner = %row.owner,
                    error = %err,
                    "liqd failed"
                );
            }
        }
    }
    Ok(())
}

async fn liquidate_one(
    client: &IndexerHttp,
    signer: &Signer,
    row: &TrackedPos,
    oracle_raw: u64,
) -> Result<String> {
    let paper = parse_token_contract(&row.market).map_err(|e| {
        anyhow::anyhow!("parse paper market {}: {e}", row.market)
    })?;
    let action = ActionBuilder::liquidate_paper(
        paper,
        PaperLiquidateParams {
            position: row.position,
        },
    )
    .map_err(|e| anyhow::anyhow!("build liquidate_paper: {e}"))?;

    let sender = signer.address();
    let tx = TransactionBuilder::new()
        .sender(sender)
        .account(sender)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)
        .map_err(|e| anyhow::anyhow!("sign liquidate_paper: {e}"))?;

    let (digest, block_num, receipt) = client.submit(tx).await?;
    if !receipt.is_success() {
        bail!(
            "liqd receipt failed position={} oracle={} bust={} status={:?} block={block_num}",
            row.position,
            oracle_raw,
            row.bust_price_raw,
            receipt.status
        );
    }
    Ok(digest)
}
