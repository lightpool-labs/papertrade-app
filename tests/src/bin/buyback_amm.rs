// Copyright (c) LightPool Labs
//! Seed PAPER/USDC AMM liquidity, then run admin `buyback` (swap USDC → PAPER → burn).
//!
//! Admin PAPER for liquidity comes from `hold-opens` liquidations (admin trades
//! and keeps PAPER; workers stake theirs).
//!
//! Standalone CLI — not wired into `scripts/dev.sh`.
//!
//! Example:
//! ```text
//! cargo run --release --bin buyback-amm -- \
//!   --liquidity 45000000000000 \
//!   --buyback-usdc 2000000 \
//!   --push-fees
//! ```

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::Parser;
use lightpool_sdk::lightpool_types::SignedTransaction;
use lightpool_sdk::{
    extract_paper_buyback_spent, parse_token_contract, ActionBuilder, AmmAddLiquidityParams,
    PaperBuybackSpendParams, PaperPushFeesParams, Signer, TransactionBuilder, TOKEN_SCALE,
};
use reqwest::Client;
use serde::Deserialize;
const DEFAULT_ADMIN_KEY: &str =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const DEFAULT_TICK_LOWER: i32 = -1000;
const DEFAULT_TICK_UPPER: i32 = 1000;

#[derive(Debug, Parser)]
#[command(
    name = "buyback-amm",
    about = "Add AMM liquidity (admin PAPER from hold-opens liqd), optionally push_fees, then buyback+burn"
)]
struct Args {
    #[arg(long, env = "INDEXER_URL", default_value = "http://127.0.0.1:3002")]
    indexer_url: String,

    #[arg(long, env = "MARKETS_PATH", default_value = "../data/markets.json")]
    markets_path: PathBuf,

    #[arg(
        long,
        env = "BOOTSTRAP_PATH",
        default_value = "../../data/papertrader/bootstrap.json"
    )]
    bootstrap_path: PathBuf,

    #[arg(long, env = "ADMIN_KEY", default_value = DEFAULT_ADMIN_KEY)]
    admin_key: String,

    /// AMM liquidity units to add (0 = skip). Tick spacing is 10.
    /// Default ticks [-1000, 1000]; L≈4.5e13 needs ~2.2M PAPER+USDC each and
    /// can absorb a ~2M USDC buyback in one swap (needs hold-opens 1.2M×2 seed).
    #[arg(long, default_value_t = 45_000_000_000_000u128)]
    liquidity: u128,

    #[arg(long, default_value_t = DEFAULT_TICK_LOWER)]
    tick_lower: i32,

    #[arg(long, default_value_t = DEFAULT_TICK_UPPER)]
    tick_upper: i32,

    /// Whole USDC to spend from buyback_cash (0 = spend all available buyback_cash).
    #[arg(long, default_value_t = 0u64)]
    buyback_usdc: u64,

    /// Skip the buyback step.
    #[arg(long, default_value_t = false)]
    skip_buyback: bool,

    /// Call push_fees before buyback (accrue fees + excess sweep into buyback_cash).
    #[arg(long, default_value_t = false)]
    push_fees: bool,
}

#[derive(Debug, Deserialize)]
struct MarketsFile {
    paper_market: String,
    #[serde(default)]
    amm_pool: String,
}

#[derive(Debug, Deserialize)]
struct BootstrapState {
    usdc: String,
    paper_token: String,
    #[serde(default)]
    paper_market: String,
    #[serde(default)]
    amm_pool: String,
}

#[derive(Debug, Deserialize)]
struct SubmitTxResponse {
    #[allow(dead_code)]
    digest: String,
    #[serde(default)]
    block_num: u64,
    receipt: lightpool_sdk::TransactionReceipt,
}

#[derive(Debug, Deserialize)]
struct HouseBody {
    house: HouseSnap,
}

#[derive(Debug, Deserialize)]
struct HouseSnap {
    #[serde(default)]
    buyback_cash_raw: u64,
}

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

    async fn buyback_cash_raw(&self, market: &str) -> Result<u64> {
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
        Ok(body.house.buyback_cash_raw)
    }

    async fn token_available_raw(&self, address: &str, token: &str) -> Result<u64> {
        let url = format!(
            "{}/api/accounts/{}/balances",
            self.base_url,
            urlencoding_encode(address.trim())
        );
        let body = serde_json::json!({
            "tokens": [{ "symbol": "TKN", "address": token }]
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
        #[derive(Deserialize)]
        struct Entry {
            available: String,
        }
        let entries: Vec<Entry> = serde_json::from_str(&text).context("decode balances")?;
        let avail = entries
            .first()
            .map(|e| e.available.as_str())
            .unwrap_or("0");
        parse_human_amount6_raw(avail)
    }
}

fn parse_human_amount6_raw(s: &str) -> Result<u64> {
    let t = s.trim().replace(',', "");
    if t.is_empty() {
        return Ok(0);
    }
    let neg = t.starts_with('-');
    let t = t.trim_start_matches('-');
    let (whole, frac) = match t.split_once('.') {
        Some((w, f)) => (w, f),
        None => (t, ""),
    };
    let whole_n: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().context("parse whole")?
    };
    let mut frac_digits = frac.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    while frac_digits.len() < 6 {
        frac_digits.push('0');
    }
    frac_digits.truncate(6);
    let frac_n: u64 = if frac_digits.is_empty() {
        0
    } else {
        frac_digits.parse().context("parse frac")?
    };
    let raw = whole_n
        .checked_mul(TOKEN_SCALE)
        .and_then(|v| v.checked_add(frac_n))
        .context("amount overflow")?;
    Ok(if neg { 0 } else { raw })
}

fn urlencoding_encode(raw: &str) -> String {
    raw.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn resolve_path(path: &PathBuf) -> PathBuf {
    if path.is_absolute() {
        path.clone()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn load_signer(raw: &str) -> Result<Signer> {
    let hex_body = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(hex_body).context("decode admin key")?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("ADMIN key must be 32 bytes"))?;
    Ok(Signer::from_secret_key_bytes(&key)?)
}

fn ordered_pair(
    a: lightpool_sdk::ContractAddress,
    b: lightpool_sdk::ContractAddress,
) -> (lightpool_sdk::ContractAddress, lightpool_sdk::ContractAddress) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

async fn submit_ok(
    client: &IndexerHttp,
    signer: &Signer,
    label: &str,
    action: lightpool_sdk::lightpool_types::Action,
) -> Result<SubmitTxResponse> {
    let sender = signer.address();
    let tx = TransactionBuilder::new()
        .sender(sender)
        .account(sender)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)
        .map_err(|e| anyhow::anyhow!("sign {label}: {e}"))?;
    let resp = client.submit(tx).await?;
    if !resp.receipt.is_success() {
        bail!("{label} failed status={:?} block={}", resp.receipt.status, resp.block_num);
    }
    println!("ok    {label} block={}", resp.block_num);
    Ok(resp)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    if args.tick_lower >= args.tick_upper {
        bail!("--tick-lower must be < --tick-upper");
    }
    if args.tick_lower % 10 != 0 || args.tick_upper % 10 != 0 {
        bail!("ticks must be multiples of pool tick_spacing (10)");
    }

    let markets_path = resolve_path(&args.markets_path);
    let bootstrap_path = resolve_path(&args.bootstrap_path);

    let markets: MarketsFile = serde_json::from_str(
        &std::fs::read_to_string(&markets_path)
            .with_context(|| format!("read markets {}", markets_path.display()))?,
    )
    .context("parse markets.json")?;
    let bootstrap: BootstrapState = serde_json::from_str(
        &std::fs::read_to_string(&bootstrap_path)
            .with_context(|| format!("read bootstrap {}", bootstrap_path.display()))?,
    )
    .context("parse bootstrap.json")?;

    let paper_market_raw = if !markets.paper_market.trim().is_empty() {
        markets.paper_market.trim()
    } else {
        bootstrap.paper_market.trim()
    };
    if paper_market_raw.is_empty() {
        bail!("paper_market missing in markets.json / bootstrap.json");
    }
    let amm_pool_raw = if !markets.amm_pool.trim().is_empty() {
        markets.amm_pool.trim()
    } else {
        bootstrap.amm_pool.trim()
    };
    if amm_pool_raw.is_empty() {
        bail!("amm_pool missing in markets.json / bootstrap.json");
    }
    if bootstrap.usdc.trim().is_empty() || bootstrap.paper_token.trim().is_empty() {
        bail!("bootstrap.json missing usdc / paper_token");
    }

    let paper_market = parse_token_contract(paper_market_raw)
        .map_err(|e| anyhow::anyhow!("paper_market: {e}"))?;
    let amm_pool =
        parse_token_contract(amm_pool_raw).map_err(|e| anyhow::anyhow!("amm_pool: {e}"))?;
    let usdc =
        parse_token_contract(bootstrap.usdc.trim()).map_err(|e| anyhow::anyhow!("usdc: {e}"))?;
    let paper_token = parse_token_contract(bootstrap.paper_token.trim())
        .map_err(|e| anyhow::anyhow!("paper_token: {e}"))?;
    let (token0, token1) = ordered_pair(paper_token, usdc);

    let client = IndexerHttp::new(&args.indexer_url)?;
    let admin = load_signer(&args.admin_key)?;
    let admin_addr = admin.address();

    println!("paper_market {paper_market_raw}");
    println!("amm_pool     {amm_pool_raw}");
    println!("paper_token  {}", bootstrap.paper_token.trim());
    println!("usdc         {}", bootstrap.usdc.trim());
    println!("admin        {admin_addr}");

    if args.liquidity > 0 {
        let paper_bal = client
            .token_available_raw(&admin_addr.to_string(), bootstrap.paper_token.trim())
            .await
            .unwrap_or(0);
        let usdc_bal = client
            .token_available_raw(&admin_addr.to_string(), bootstrap.usdc.trim())
            .await
            .unwrap_or(0);
        println!("admin paper_raw={paper_bal} usdc_raw={usdc_bal}");
        if paper_bal == 0 {
            bail!(
                "admin has no PAPER — run hold-opens so admin positions get liquidated \
                 (admin keeps PAPER; workers stake theirs)"
            );
        }
        let action = ActionBuilder::add_amm_liquidity(
            amm_pool,
            AmmAddLiquidityParams {
                whitelist: None,
                token0,
                token1,
                tick_lower: args.tick_lower,
                tick_upper: args.tick_upper,
                liquidity: args.liquidity,
            },
        )
        .map_err(|e| anyhow::anyhow!("build add_amm_liquidity: {e}"))?;
        submit_ok(&client, &admin, "add_amm_liquidity", action).await?;
    }

    if args.push_fees {
        let action = ActionBuilder::push_paper_fees(paper_market, PaperPushFeesParams {})
            .map_err(|e| anyhow::anyhow!("build push_fees: {e}"))?;
        submit_ok(&client, &admin, "push_fees", action).await?;
    }

    if !args.skip_buyback {
        let available = client.buyback_cash_raw(paper_market_raw).await?;
        let spend = if args.buyback_usdc > 0 {
            let want = args
                .buyback_usdc
                .checked_mul(TOKEN_SCALE)
                .context("buyback_usdc overflow")?;
            want.min(available)
        } else {
            available
        };
        if spend == 0 {
            println!("skip  buyback (buyback_cash_raw=0)");
        } else {
            println!("buyback spend_raw={spend} (available={available})");
            let action = ActionBuilder::buyback_paper(
                paper_market,
                PaperBuybackSpendParams { amount: spend },
            )
            .map_err(|e| anyhow::anyhow!("build buyback_paper: {e}"))?;
            let resp = submit_ok(&client, &admin, "buyback", action).await?;
            if let Some(ev) = extract_paper_buyback_spent(&resp.receipt) {
                println!(
                    "      quote_spent={} paper_burned={}",
                    ev.quote_spent, ev.paper_burned
                );
            } else {
                println!("      (paper_buyback event missing)");
            }
        }
    }

    println!("done");
    Ok(())
}
