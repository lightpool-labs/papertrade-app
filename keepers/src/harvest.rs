// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper harvest keeper: when the payout queue is non-empty and LP has cash,
//! submit permissionless `harvest` (bounded by `max_entries`).

use anyhow::{Context, Result, bail};
use lightpool_sdk::{
    parse_token_contract, ActionBuilder, PaperHarvestParams, Signer, TransactionBuilder,
};

use crate::indexer::IndexerHttp;

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

    let sender = signer.address();
    let tx = TransactionBuilder::new()
        .sender(sender)
        .account(sender)
        .expiration(u64::MAX)
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
        %digest,
        block_num,
        "harvest submitted"
    );
    Ok(true)
}
