// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper keepers runner: liqd (WS-driven) + harvest + push_fees.
//!
//! Talks to LightPool only through clob-indexer HTTP/WS — same path as paper-bootstrap
//! and the strategy BFF.
//!
//! ```sh
//! cd papertrade-app/keepers
//! INDEXER_URL=http://127.0.0.1:3002 \
//! MARKETS_PATH=../data/markets.json \
//! cargo run --release --bin paper-keeper
//! ```

use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use papertrader_keepers::config::KeeperConfig;
use papertrader_keepers::harvest;
use papertrader_keepers::indexer::IndexerHttp;
use papertrader_keepers::liqd::{self, load_signer, SideLoops};
use papertrader_keepers::push_fees;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(about = "Paper market keepers: liqd (WS), harvest, push_fees")]
struct Args {
    /// Override INDEXER_URL.
    #[arg(long, env = "INDEXER_URL")]
    indexer_url: Option<String>,
    /// Override MARKETS_PATH.
    #[arg(long, env = "MARKETS_PATH")]
    markets_path: Option<String>,
    /// Poll interval for harvest / push_fees (ms).
    #[arg(long, env = "PAPER_KEEPER_POLL_MS")]
    poll_ms: Option<u64>,
    /// Disable liquidation loop.
    #[arg(long, default_value_t = false)]
    no_liqd: bool,
    /// Disable harvest loop.
    #[arg(long, default_value_t = false)]
    no_harvest: bool,
    /// Disable push_fees loop.
    #[arg(long, default_value_t = false)]
    no_push_fees: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let mut cfg = KeeperConfig::from_env().context("load keeper config")?;
    if let Some(url) = args.indexer_url {
        cfg.indexer_url = url;
    }
    if let Some(path) = args.markets_path {
        cfg.markets_path = path.into();
    }
    if let Some(ms) = args.poll_ms {
        cfg.poll_interval = Duration::from_millis(ms.max(100));
    }
    if args.no_liqd {
        cfg.enable_liqd = false;
    }
    if args.no_harvest {
        cfg.enable_harvest = false;
    }
    if args.no_push_fees {
        cfg.enable_push_fees = false;
    }

    let markets = cfg.load_markets().context("load markets.json")?;
    let paper_market = markets.paper_market.clone();
    let signer = load_signer(&cfg.private_key)?;
    let client = IndexerHttp::new(&cfg.indexer_url)?;

    tracing::info!(
        indexer = %cfg.indexer_url,
        markets = %cfg.markets_path.display(),
        paper_market = %paper_market,
        keeper = %signer.address(),
        liqd = cfg.enable_liqd,
        harvest = cfg.enable_harvest,
        push_fees = cfg.enable_push_fees,
        harvest_max = cfg.harvest_max_entries,
        poll_ms = cfg.poll_interval.as_millis(),
        liqd_reconcile_ms = cfg.liqd_reconcile_interval.as_millis(),
        "paper-keeper starting"
    );

    for i in 1..=60 {
        if client.health_ok().await {
            tracing::info!("indexer ready");
            break;
        }
        if i == 60 {
            anyhow::bail!("indexer not ready at {}", cfg.indexer_url);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if !cfg.enable_liqd && !cfg.enable_harvest && !cfg.enable_push_fees {
        anyhow::bail!("all keeper modules disabled");
    }

    if cfg.enable_liqd {
        return liqd::run_loop(
            client,
            &signer,
            cfg.markets_path.clone(),
            markets,
            cfg.page_limit,
            cfg.liqd_reconcile_interval,
            SideLoops {
                enable_harvest: cfg.enable_harvest,
                enable_push_fees: cfg.enable_push_fees,
                harvest_max_entries: cfg.harvest_max_entries,
                side_poll: cfg.poll_interval,
            },
        )
        .await;
    }

    // Harvest / push_fees only (no liqd).
    loop {
        let markets = match cfg.load_markets() {
            Ok(m) => m,
            Err(err) => {
                tracing::error!(error = %err, "reload markets.json failed");
                tokio::time::sleep(cfg.poll_interval).await;
                continue;
            }
        };
        let paper = markets.paper_market.trim();

        if cfg.enable_harvest && !paper.is_empty() {
            match harvest::run_once(&client, &signer, paper, cfg.harvest_max_entries).await {
                Ok(true) => tracing::info!("harvest tick done"),
                Ok(false) => tracing::debug!("harvest tick: nothing to pay"),
                Err(err) => tracing::error!(error = %err, "harvest tick failed"),
            }
        }

        if cfg.enable_push_fees && !paper.is_empty() {
            match push_fees::run_once(&client, &signer, paper).await {
                Ok(true) => tracing::info!("push_fees tick done"),
                Ok(false) => tracing::debug!("push_fees tick: nothing to distribute"),
                Err(err) => tracing::error!(error = %err, "push_fees tick failed"),
            }
        }

        tokio::time::sleep(cfg.poll_interval).await;
    }
}
