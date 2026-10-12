// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper push_fees keeper: when fee accumulators are non-zero (or a sweep may
//! apply), submit permissionless `push_fees`.

use anyhow::{Context, Result, bail};
use lightpool_sdk::{
    parse_token_contract, ActionBuilder, PaperPushFeesParams, Signer, TransactionBuilder,
};

use crate::indexer::IndexerHttp;

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

    let sender = signer.address();
    let tx = TransactionBuilder::new()
        .sender(sender)
        .account(sender)
        .expiration(u64::MAX)
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
