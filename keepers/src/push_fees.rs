// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper push_fees keeper: when fee accumulators are non-zero (or a sweep may
//! apply), submit permissionless `push_fees`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use lightpool_sdk::{
    parse_token_contract, ActionBuilder, PaperPushFeesParams, Signer, TransactionBuilder,
};

use crate::config::load_markets_file;
use crate::indexer::IndexerHttp;
use crate::liqd::load_signer;

static PUSH_FEES_TX_SEQ: AtomicU64 = AtomicU64::new(0);

pub async fn run_once(
    client: &IndexerHttp,
    signer: &Signer,
    paper_market: &str,
) -> Result<bool> {
    let market_raw = paper_market.trim();
    if market_raw.is_empty() {
        bail!("paper_market is empty");
    }

    let house = client
        .get_paper_house(market_raw)
        .await
        .context("get paper house")?;

    // House view has no total_staked / staker_cap; gate on visible fee accruals.
    // On-chain push_fees is a no-op when there is nothing to distribute/sweep.
    if house.staker_fee_acc_raw == 0 && house.dev_fee_acc_raw == 0 {
        tracing::debug!(
            market = %market_raw,
            "push_fees: no fee accruals"
        );
        return Ok(false);
    }

    let paper = parse_token_contract(market_raw)
        .map_err(|e| anyhow::anyhow!("parse paper market {market_raw}: {e}"))?;
    let action = ActionBuilder::push_paper_fees(paper, PaperPushFeesParams {})
        .map_err(|e| anyhow::anyhow!("build push_paper_fees: {e}"))?;

    // Unique expiration so digests differ under rapid retries.
    let expiration = u64::MAX - PUSH_FEES_TX_SEQ.fetch_add(1, Ordering::Relaxed);
    let sender = signer.address();
    let tx = TransactionBuilder::new()
        .sender(sender)
        .account(sender)
        .expiration(expiration)
        .add_action(action)
        .build_and_sign_only(signer)
        .map_err(|e| anyhow::anyhow!("sign push_paper_fees: {e}"))?;

    let (digest, block_num, receipt) = client.submit(tx).await?;
    if !receipt.is_success() {
        bail!(
            "push_fees receipt failed market={market_raw} staker_fee={} dev_fee={} status={:?} block={block_num}",
            house.staker_fee_acc_raw,
            house.dev_fee_acc_raw,
            receipt.status
        );
    }
    tracing::info!(
        market = %market_raw,
        staker_fee = house.staker_fee_acc_raw,
        dev_fee = house.dev_fee_acc_raw,
        %digest,
        block_num,
        "push_fees submitted"
    );
    Ok(true)
}

/// Dedicated thread: push fee accruals without waiting on the liqd select loop.
pub fn spawn_drain_thread(
    indexer_url: String,
    markets_path: PathBuf,
    private_key: String,
    idle_poll: Duration,
) -> Result<()> {
    std::thread::Builder::new()
        .name("paper-push-fees".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    tracing::error!(error = %err, "push_fees runtime build failed");
                    return;
                }
            };
            rt.block_on(async move {
                let signer = match load_signer(&private_key) {
                    Ok(s) => s,
                    Err(err) => {
                        tracing::error!(error = %err, "push_fees signer failed");
                        return;
                    }
                };
                let client = match IndexerHttp::new(&indexer_url) {
                    Ok(c) => c,
                    Err(err) => {
                        tracing::error!(error = %err, "push_fees indexer client failed");
                        return;
                    }
                };
                tracing::info!(
                    idle_ms = idle_poll.as_millis(),
                    "push_fees drain thread ready"
                );
                loop {
                    let paper = match load_markets_file(&markets_path) {
                        Ok(m) => m.paper_market,
                        Err(err) => {
                            tracing::error!(error = %err, "push_fees reload markets failed");
                            tokio::time::sleep(idle_poll).await;
                            continue;
                        }
                    };
                    let paper = paper.trim();
                    if paper.is_empty() {
                        tokio::time::sleep(idle_poll).await;
                        continue;
                    }

                    match run_once(&client, &signer, paper).await {
                        Ok(true) => tracing::info!("push_fees tick done"),
                        Ok(false) => tracing::debug!("push_fees tick: nothing to distribute"),
                        Err(err) => tracing::error!(error = %err, "push_fees tick failed"),
                    }
                    tokio::time::sleep(idle_poll).await;
                }
            });
        })
        .context("spawn push_fees drain thread")?;
    Ok(())
}
