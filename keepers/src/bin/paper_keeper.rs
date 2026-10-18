// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Paper keepers runner: liqd (WS-driven) + harvest + push_fees.
//!
//! Talks to LightPool only through clob-indexer HTTP/WS — same path as paper-bootstrap
//! and the strategy BFF.
//!
//! Harvest and push_fees each run on a **dedicated OS thread** so liqd bust spam
//! cannot starve payouts or fee drains.
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
    /// Idle poll when harvest queue is empty / push_fees interval (ms).
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
    let keeper_addr = load_signer(&cfg.private_key)?.address();
    let health_client = IndexerHttp::new(&cfg.indexer_url)?;

    tracing::info!(
        indexer = %cfg.indexer_url,
        markets = %cfg.markets_path.display(),
        paper_market = %paper_market,
        keeper = %keeper_addr,
        liqd = cfg.enable_liqd,
        harvest = cfg.enable_harvest,
        push_fees = cfg.enable_push_fees,
        harvest_max = cfg.harvest_max_entries,
        poll_ms = cfg.poll_interval.as_millis(),
        liqd_reconcile_ms = cfg.liqd_reconcile_interval.as_millis(),
        liqd_senders = cfg.liqd_senders,
        "paper-keeper starting"
    );

    for i in 1..=60 {
        if health_client.health_ok().await {
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

    // Harvest / push_fees never share the liqd select — drain on own threads.
    if cfg.enable_harvest {
        harvest::spawn_drain_thread(
            cfg.indexer_url.clone(),
            cfg.markets_path.clone(),
            cfg.private_key.clone(),
            cfg.harvest_max_entries,
            Duration::from_millis(250),
        )
        .context("start harvest drain thread")?;
    }
    if cfg.enable_push_fees {
        push_fees::spawn_drain_thread(
            cfg.indexer_url.clone(),
            cfg.markets_path.clone(),
            cfg.private_key.clone(),
            cfg.poll_interval,
        )
        .context("start push_fees drain thread")?;
    }

    if cfg.enable_liqd {
        let signer = load_signer(&cfg.private_key)?;
        let client = IndexerHttp::new(&cfg.indexer_url)?;
        return liqd::run_loop(
            client,
            &signer,
            cfg.markets_path.clone(),
            markets,
            cfg.page_limit,
            cfg.liqd_reconcile_interval,
            cfg.liqd_senders,
            SideLoops {
                // Harvest + push_fees are on dedicated threads above.
                enable_harvest: false,
                enable_push_fees: false,
                harvest_max_entries: cfg.harvest_max_entries,
                side_poll: cfg.poll_interval,
            },
        )
        .await;
    }

    // No liqd: harvest / push_fees threads already running — park main.
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
