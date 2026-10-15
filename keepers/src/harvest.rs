// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper harvest keeper: when the payout queue is non-empty and LP has cash,
//! submit permissionless `harvest` (bounded by `max_entries`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};

static HARVEST_TX_SEQ: AtomicU64 = AtomicU64::new(0);
use lightpool_sdk::{
    parse_token_contract, ActionBuilder, PaperHarvestParams, Signer, TransactionBuilder,
};

use crate::config::load_markets_file;
use crate::indexer::IndexerHttp;
use crate::liqd::load_signer;

pub async fn run_once(
    client: &IndexerHttp,
    signer: &Signer,
    paper_market: &str,
    max_entries: u32,
) -> Result<bool> {
    let market_raw = paper_market.trim();
    if market_raw.is_empty() {
        bail!("paper_market is empty");
    }
    if max_entries == 0 {
        bail!("harvest max_entries must be > 0");
    }

    let house = client
        .get_paper_house(market_raw)
        .await
        .context("get paper house")?;

    let cash = house
        .free_cash_raw
        .saturating_add(house.side_bucket_raw);
    if !house.queue_nonempty || house.total_queued_raw == 0 || cash == 0 {
        tracing::debug!(
            market = %market_raw,
            queued = house.total_queued_raw,
            cash,
            "harvest: nothing to pay"
        );
        return Ok(false);
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| anyhow::anyhow!("parse paper market {market_raw}: {e}"))?;
    let action = ActionBuilder::harvest_paper(
        paper,
        PaperHarvestParams { max_entries },
    )
    .map_err(|e| anyhow::anyhow!("build harvest_paper: {e}"))?;

    // Unique expiration so digests differ — identical harvest txs collide in the
    // indexer submit waiter ("waiter dropped for transaction …").
    let expiration = u64::MAX - HARVEST_TX_SEQ.fetch_add(1, Ordering::Relaxed);
    let sender = signer.address();
    let tx = TransactionBuilder::new()
        .sender(sender)
        .account(sender)
        .expiration(expiration)
        .add_action(action)
        .build_and_sign_only(signer)
        .map_err(|e| anyhow::anyhow!("sign harvest_paper: {e}"))?;

    let (digest, block_num, receipt) = client.submit(tx).await?;
    if !receipt.is_success() {
        bail!(
            "harvest receipt failed market={market_raw} queued={} cash={cash} status={:?} block={block_num}",
            house.total_queued_raw,
            receipt.status
        );
    }
    tracing::info!(
        market = %market_raw,
        queued = house.total_queued_raw,
        cash,
        max_entries,
        queue_head = house.queue_head,
        queue_tail = house.queue_tail,
        %digest,
        block_num,
        "harvest submitted"
    );
    Ok(true)
}

/// Dedicated thread: drain the FIFO queue as fast as the chain accepts (no liqd starvation).
pub fn spawn_drain_thread(
    indexer_url: String,
    markets_path: PathBuf,
    private_key: String,
    max_entries: u32,
    idle_poll: Duration,
) -> Result<()> {
    std::thread::Builder::new()
        .name("paper-harvest".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    tracing::error!(error = %err, "harvest runtime build failed");
                    return;
                }
            };
            rt.block_on(async move {
                let signer = match load_signer(&private_key) {
                    Ok(s) => s,
                    Err(err) => {
                        tracing::error!(error = %err, "harvest signer failed");
                        return;
                    }
                };
                let client = match IndexerHttp::new(&indexer_url) {
                    Ok(c) => c,
                    Err(err) => {
                        tracing::error!(error = %err, "harvest indexer client failed");
                        return;
                    }
                };
                tracing::info!(
                    max_entries,
                    idle_ms = idle_poll.as_millis(),
                    "harvest drain thread ready"
                );
                loop {
                    let paper = match load_markets_file(&markets_path) {
                        Ok(m) => m.paper_market,
                        Err(err) => {
                            tracing::error!(error = %err, "harvest reload markets failed");
                            tokio::time::sleep(idle_poll).await;
                            continue;
                        }
                    };
                    let paper = paper.trim();
                    if paper.is_empty() {
                        tokio::time::sleep(idle_poll).await;
                        continue;
                    }

                    let mut paid = 0u32;
                    let mut errors = 0u32;
                    loop {
                        match run_once(&client, &signer, paper, max_entries).await {
                            Ok(true) => {
                                paid = paid.saturating_add(1);
                                errors = 0;
                                continue;
                            }
                            Ok(false) => break,
                            Err(err) => {
                                errors = errors.saturating_add(1);
                                tracing::error!(error = %err, errors, "harvest drain tick failed");
                                // Transient submit races: brief pause then keep draining.
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                if errors >= 8 {
                                    break;
                                }
                            }
                        }
                    }
                    if paid > 0 {
                        tracing::info!(batches = paid, "harvest drain burst done");
                    }
                    tokio::time::sleep(idle_poll).await;
                }
            });
        })
        .context("spawn harvest drain thread")?;
    Ok(())
}
