// Copyright (c) LightPool Labs
// Author: xiaoyu1998
//! Bootstrap local paper stack: USDC + BTC + ETH tokens, BTC/USDC + ETH/USDC spots,
//! paper market with BTC instrument, LPL + stake (Committee).
//!
//! When `USDC_LP` is set (dev.sh Reth bridge path), reuse that bridged LP USDC as
//! quote instead of `create_token`. Set `SKIP_PAPER_FUND=1` so the demo user funds
//! shared LP USDC Available via Reth → bridge (not admin transfer).
//! Submits via clob-indexer (no direct node RPC). Does **not** call prom_*;
//! RunningCommittee fills after the first epoch (~1000 blocks) via epoch epilogue.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use compact_str::CompactString;
use lightpool_sdk::{
    extract_market_address_from_events, extract_paper_market_created,
    extract_token_address_from_events, parse_token_contract, ActionBuilder, AllocateStakeParams,
    BondLplParams, CreateMarketParams, CreateTokenParams, InitStakingConfigParams, MarketState,
    PaperAddInstrumentParams, PaperCreateMarketParams, RegisterValidatorParams,
    SegmentSize, Signer, StakePurpose, TransferParams, TOKEN_SCALE, TransactionBuilder,
};
use lightpool_sdk::lightpool_types::SignedTransaction;
use lightpool_sdk::TransactionReceipt;
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// Anvil / Hardhat #0 — creates markets; paper `admin`.
const ADMIN_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/// Anvil / Hardhat #1 — default local trader (MetaMask / FE), not admin.
const DEFAULT_USER_KEY: &str =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN_SUPPLY_WHOLE: u64 = 1_000_000_000;
const MIN_ORDER_SIZE: u64 = 100_000;
const TICK_SIZE: u64 = 10_000;
const MIN_BOND: u64 = 10_000 * TOKEN_SCALE;
const BOND_AMOUNT: u64 = 50_000 * TOKEN_SCALE;
/// Default paper available credit for local MetaMask (anvil account #1).
const DEFAULT_PAPER_FUND_USDC: u64 = 1_000_000;

#[derive(Serialize, Deserialize)]
struct BootstrapState {
    usdc: String,
    btc: String,
    eth: String,
    spot_btc: String,
    spot_eth: String,
    paper_market: String,
    paper_token: String,
    #[serde(default)]
    lpl: Option<String>,
    /// True after paper USDC deposit for the local trade wallet.
    #[serde(default)]
    paper_funded: bool,
    /// Lowercase address last funded via `PAPER_FUND_KEY` (empty = never / legacy).
    #[serde(default)]
    paper_funded_for: String,
    /// Lowercase Anvil #2 address last funded via `PAPER_FUND_USER2_*`.
    #[serde(default)]
    paper_funded_user2_for: String,
}

#[derive(Serialize, Deserialize)]
struct MarketsFile {
    paper_market: String,
    quote_decimals: u32,
    liq_buffer_ppm: u64,
    instruments: Vec<InstrumentRecord>,
}

#[derive(Serialize, Deserialize)]
struct InstrumentRecord {
    id: u32,
    slug: String,
    name: String,
    hl_symbol: String,
    price_market: String,
    max_leverage: u64,
    min_margin: u64,
    retired: bool,
}

#[derive(Deserialize)]
struct SubmitTxResponse {
    digest: String,
    #[serde(default)]
    block_num: u64,
    receipt: TransactionReceipt,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let indexer_url = env::var("INDEXER_URL").unwrap_or_else(|_| "http://127.0.0.1:3002".into());
    let state_path = PathBuf::from(
        env::var("BOOTSTRAP_STATE").unwrap_or_else(|_| "../data/bootstrap.json".into()),
    );
    let markets_path = PathBuf::from(
        env::var("MARKETS_PATH").unwrap_or_else(|_| "../data/markets.json".into()),
    );

    let signer = load_signer(ADMIN_KEY)?;
    let client = IndexerHttp::new(&indexer_url);

    let mut state = if state_path.exists() {
        println!("skip  markets bootstrap ({})", state_path.display());
        sync_markets_from_state(&state_path, &markets_path)?;
        serde_json::from_str::<BootstrapState>(&fs::read_to_string(&state_path)?)?
    } else {
        let usdc = match env::var("USDC_LP") {
            Ok(raw) if !raw.trim().is_empty() => {
                let usdc = raw.trim().to_string();
                println!("use    bridged LP USDC {usdc}");
                usdc
            }
            _ => {
                println!("create token USDC");
                let usdc = create_token(&client, &signer, "USD Coin", "USDC").await?;
                println!("ok    USDC {usdc}");
                usdc
            }
        };

        println!("create token BTC");
        let btc = create_token(&client, &signer, "Bitcoin", "BTC").await?;
        println!("ok    BTC {btc}");

        println!("create token ETH");
        let eth = create_token(&client, &signer, "Ether", "ETH").await?;
        println!("ok    ETH {eth}");

        let usdc_addr = parse_token_contract(&usdc)?;
        let btc_addr = parse_token_contract(&btc)?;
        let eth_addr = parse_token_contract(&eth)?;

        println!("create spot BTC/USDC");
        let spot_btc = create_spot(&client, &signer, "BTC_USDC", btc_addr, usdc_addr).await?;
        println!("ok    spot BTC {spot_btc}");

        println!("create spot ETH/USDC");
        let spot_eth = create_spot(&client, &signer, "ETH_USDC", eth_addr, usdc_addr).await?;
        println!("ok    spot ETH {spot_eth}");

        println!("create paper market");
        let (paper_market, paper_token) = create_paper_market(&client, &signer, usdc_addr).await?;
        println!("ok    paper market {paper_market}");
        println!("ok    paper token {paper_token}");

        println!("add BTC instrument");
        let price_market = parse_token_contract(&spot_btc)?;
        let paper = parse_token_contract(&paper_market)?;
        add_btc_instrument(&client, &signer, paper, price_market).await?;
        println!("ok    BTC instrument id=0");

        let state = BootstrapState {
            usdc,
            btc,
            eth,
            spot_btc: spot_btc.clone(),
            spot_eth,
            paper_market: paper_market.clone(),
            paper_token,
            lpl: None,
            paper_funded: false,
            paper_funded_for: String::new(),
            paper_funded_user2_for: String::new(),
        };
        write_markets_file(&markets_path, &paper_market, &spot_btc)?;
        println!("wrote {}", markets_path.display());
        state
    };

    // LPL + stake so epoch epilogue can fill RunningCommittee after ~1000 blocks.
    // Until then ora_commit runs in open-mode (no committee).
    if state.lpl.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
        let lpl = setup_lpl_stake(&client, &signer).await?;
        state.lpl = Some(lpl);
    } else {
        println!("skip  LPL stake (already {})", state.lpl.as_deref().unwrap_or(""));
    }

    // Optional admin → paper Available credit. Skip when Reth bridge funds the user.
    let skip_paper_fund = env::var("SKIP_PAPER_FUND")
        .map(|v| v.trim() == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if skip_paper_fund {
        println!("skip  paper USDC fund (SKIP_PAPER_FUND=1; use Reth deposit)");
    } else {
        let fund_usdc = env::var("PAPER_FUND_USDC")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(DEFAULT_PAPER_FUND_USDC);
        let fund_key = env::var("PAPER_FUND_KEY").unwrap_or_else(|_| DEFAULT_USER_KEY.to_string());
        let user = load_signer(&fund_key)?;
        let fund_addr = user.address().to_string();
        let already_funded = !state.paper_funded_for.is_empty()
            && state
                .paper_funded_for
                .eq_ignore_ascii_case(fund_addr.trim());
        if already_funded {
            println!("skip  paper USDC fund (already funded {fund_addr})");
        } else {
            fund_paper_usdc(
                &client,
                &signer,
                &user,
                &state.usdc,
                &state.paper_market,
                fund_usdc,
            )
            .await?;
            state.paper_funded = true;
            state.paper_funded_for = fund_addr;
        }
    }

    // Anvil #2: admin LP USDC transfer (dev.sh bridges admin first).
    if let Some(fund_usdc) = env::var("PAPER_FUND_USER2_USDC")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
    {
        let fund_key = env::var("PAPER_FUND_USER2_KEY").unwrap_or_else(|_| {
            "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a".into()
        });
        let user2 = load_signer(&fund_key)?;
        let fund_addr = user2.address().to_string();
        let already = !state.paper_funded_user2_for.is_empty()
            && state
                .paper_funded_user2_for
                .eq_ignore_ascii_case(fund_addr.trim());
        if already {
            println!("skip  Anvil #2 LP fund (already funded {fund_addr})");
        } else {
            println!("fund  Anvil #2 {fund_usdc} USDC on LightPool → {fund_addr}");
            fund_paper_usdc(
                &client,
                &signer,
                &user2,
                &state.usdc,
                &state.paper_market,
                fund_usdc,
            )
            .await?;
            state.paper_funded_user2_for = fund_addr;
        }
    }

    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&state_path, serde_json::to_string_pretty(&state)? + "\n")?;
    println!("wrote {}", state_path.display());
    Ok(())
}

fn sync_markets_from_state(
    state_path: &PathBuf,
    markets_path: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let state: BootstrapState = serde_json::from_str(&fs::read_to_string(state_path)?)?;
    write_markets_file(markets_path, &state.paper_market, &state.spot_btc)?;
    println!("synced {}", markets_path.display());
    Ok(())
}

fn write_markets_file(
    path: &PathBuf,
    paper_market: &str,
    spot_btc: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let file = MarketsFile {
        paper_market: paper_market.to_string(),
        quote_decimals: 6,
        liq_buffer_ppm: 500,
        instruments: vec![
            InstrumentRecord {
                id: 0,
                slug: "btc".into(),
                name: "BTC".into(),
                hl_symbol: "BTC".into(),
                price_market: spot_btc.to_string(),
                max_leverage: 1000,
                min_margin: 1,
                retired: false,
            },
            InstrumentRecord {
                id: 1,
                slug: "eth".into(),
                name: "ETH".into(),
                hl_symbol: "ETH".into(),
                price_market: String::new(),
                max_leverage: 1000,
                min_margin: 1,
                retired: true,
            },
        ],
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(&file)? + "\n")?;
    Ok(())
}

fn load_signer(raw: &str) -> Result<Signer, Box<dyn std::error::Error>> {
    let hex_body = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(hex_body)?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "ADMIN key must be 32 bytes")?;
    Ok(Signer::from_secret_key_bytes(&key)?)
}

struct IndexerHttp {
    client: Client,
    base_url: String,
}

impl IndexerHttp {
    fn new(base_url: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("http client"),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    async fn submit(&self, tx: SignedTransaction) -> Result<SubmitTxResponse, Box<dyn std::error::Error>> {
        #[derive(Serialize)]
        struct Body {
            tx: SignedTransaction,
        }
        let url = format!("{}/api/tx/submit", self.base_url);
        let response = self.client.post(&url).json(&Body { tx }).send().await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            return Err(format!("indexer submit HTTP {status}: {text}").into());
        }
        Ok(serde_json::from_str(&text)?)
    }
}

async fn create_token(
    client: &IndexerHttp,
    signer: &Signer,
    name: &str,
    symbol: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let sender = signer.address();
    let params = CreateTokenParams {
        name: name.into(),
        symbol: symbol.into(),
        total_supply: TOKEN_SUPPLY_WHOLE
            .checked_mul(TOKEN_SCALE)
            .ok_or("supply overflow")?,
        mintable: true,
        to: sender,
    };
    let action = ActionBuilder::create_token(params)?;
    let tx = TransactionBuilder::new()
        .sender(sender)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        return Err(format!("create_token {symbol} failed: {:?}", response.receipt.status).into());
    }
    let token = extract_token_address_from_events(&response.receipt)
        .ok_or("token address missing from receipt")?;
    Ok(token.to_string())
}

async fn create_spot(
    client: &IndexerHttp,
    signer: &Signer,
    pair_name: &str,
    base: lightpool_sdk::ContractAddress,
    quote: lightpool_sdk::ContractAddress,
) -> Result<String, Box<dyn std::error::Error>> {
    let sender = signer.address();
    let params = CreateMarketParams {
        name: pair_name.into(),
        base_token: base,
        quote_token: quote,
        min_order_size: MIN_ORDER_SIZE,
        tick_size: TICK_SIZE,
        maker_fee_bps: 10,
        taker_fee_bps: 20,
        allow_market_orders: true,
        state: MarketState::Active,
        limit_order: true,
        side_book_size: SegmentSize::Large,
        creator: sender,
        access: Default::default(),
        whitelist: None,
    };
    let action = ActionBuilder::create_market(params)?;
    let tx = TransactionBuilder::new()
        .sender(sender)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        return Err(format!("create_spot {pair_name} failed: {:?}", response.receipt.status).into());
    }
    let market = extract_market_address_from_events(&response.receipt)
        .ok_or("spot market address missing")?;
    Ok(market.to_string())
}

async fn create_paper_market(
    client: &IndexerHttp,
    signer: &Signer,
    quote: lightpool_sdk::ContractAddress,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let sender = signer.address();
    let params = PaperCreateMarketParams {
        admin: sender,
        quote_token: quote,
        paper_name: CompactString::new("Paper"),
        paper_symbol: CompactString::new("PAPER"),
        win_fee_ppm: 20_000,
        loss_fee_ppm: 20_000,
        staker_share_ppm: 500_000,
        deadband_ppm: 20,
        liq_buffer_ppm: 500,
        flat_threshold: 2_000_000_000_000,
        flat_rate_ppm: 100_000_000,
        tail_decay_scale: 1_000_000_000_000,
        staker_cap: 5_000_000_000_000,
        max_oracle_staleness: 100,
    };
    let action = ActionBuilder::create_paper_market(params)?;
    let tx = TransactionBuilder::new()
        .sender(sender)
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        return Err(format!("create_paper_market failed: {:?}", response.receipt.status).into());
    }
    let created = extract_paper_market_created(&response.receipt)
        .ok_or("paper_market_created event missing")?;
    Ok((created.market.to_string(), created.paper_token.to_string()))
}

async fn submit_actions(
    client: &IndexerHttp,
    signer: &Signer,
    actions: Vec<lightpool_sdk::lightpool_types::Action>,
) -> Result<SubmitTxResponse, Box<dyn std::error::Error>> {
    let mut builder = TransactionBuilder::new()
        .sender(signer.address())
        .expiration(u64::MAX);
    for action in actions {
        builder = builder.add_action(action);
    }
    let tx = builder.build_and_sign_only(signer)?;
    client.submit(tx).await
}

/// Create LPL, init staking, register validator, bond + allocate Committee.
/// Does **not** prom_pending/prom_running — node epoch epilogue does that (~1000 blocks).
async fn setup_lpl_stake(
    client: &IndexerHttp,
    signer: &Signer,
) -> Result<String, Box<dyn std::error::Error>> {
    println!("create token LPL (staking)");
    let lpl = create_token(client, signer, "LightPool", "LPL").await?;
    println!("ok    LPL {lpl}");
    let lpl_addr = parse_token_contract(&lpl)?;

    println!("init_staking_config");
    let init = ActionBuilder::init_staking_config(InitStakingConfigParams {
        lpl_token: lpl_addr,
        min_bond: MIN_BOND,
        committee_size: 1,
        unbonding_period_blocks: 0,
    })?;
    let init_resp = submit_actions(client, signer, vec![init]).await?;
    if !init_resp.receipt.is_success() {
        println!(
            "warn  init_staking_config: {:?} (continuing if already init)",
            init_resp.receipt.status
        );
    } else {
        println!("ok    init_staking_config");
    }

    println!("register_validator");
    let register = ActionBuilder::register_validator(RegisterValidatorParams {
        consensus_pubkey: *signer.public_key(),
    })?;
    let reg_resp = submit_actions(client, signer, vec![register]).await?;
    if !reg_resp.receipt.is_success() {
        println!(
            "warn  register_validator: {:?} (continuing)",
            reg_resp.receipt.status
        );
    } else {
        println!("ok    register_validator");
    }

    println!("bond_lpl + allocate Committee");
    let bond = ActionBuilder::bond_lpl(BondLplParams {
        lpl_token: lpl_addr,
        amount: BOND_AMOUNT,
    })?;
    let bond_resp = submit_actions(client, signer, vec![bond]).await?;
    if !bond_resp.receipt.is_success() {
        return Err(format!("bond_lpl failed: {:?}", bond_resp.receipt.status).into());
    }
    let allocate = ActionBuilder::allocate_stake(AllocateStakeParams {
        purpose: StakePurpose::Committee,
        amount: BOND_AMOUNT,
    })?;
    let alloc_resp = submit_actions(client, signer, vec![allocate]).await?;
    if !alloc_resp.receipt.is_success() {
        return Err(format!("allocate_stake failed: {:?}", alloc_resp.receipt.status).into());
    }
    println!(
        "ok    bonded+allocated {} LPL (RunningCommittee after ~1000 blocks / epoch epilogue)",
        BOND_AMOUNT / TOKEN_SCALE
    );
    Ok(lpl)
}

/// Credit `user` LP USDC (shared Available) with `amount_usdc` whole USDC (6 decimals).
/// Open pulls margin from token balance; no `deposit_paper` custody step.
async fn fund_paper_usdc(
    client: &IndexerHttp,
    admin: &Signer,
    user: &Signer,
    usdc: &str,
    _paper_market: &str,
    amount_usdc: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let amount = amount_usdc
        .checked_mul(TOKEN_SCALE)
        .ok_or("paper fund amount overflow")?;
    let usdc_addr = parse_token_contract(usdc)?;
    let admin_addr = admin.address();
    let user_addr = user.address();

    if user_addr == admin_addr {
        println!("skip  USDC transfer (user is admin holder)");
        println!("ok    paper Available = LP USDC for {user_addr}");
        return Ok(());
    }

    println!("transfer {amount_usdc} USDC → {user_addr}");
    let transfer = ActionBuilder::transfer_token(
        usdc_addr,
        TransferParams {
            to: user_addr,
            amount,
        },
    )?;
    let tx = TransactionBuilder::new()
        .sender(admin_addr)
        .expiration(u64::MAX)
        .add_action(transfer)
        .build_and_sign_only(admin)?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        return Err(format!(
            "USDC transfer for paper fund failed: {:?}",
            response.receipt.status
        )
        .into());
    }
    println!("ok    paper funded {amount_usdc} USDC (shared LP token Available)");
    Ok(())
}

async fn add_btc_instrument(
    client: &IndexerHttp,
    signer: &Signer,
    paper_market: lightpool_sdk::ContractAddress,
    price_market: lightpool_sdk::ContractAddress,
) -> Result<(), Box<dyn std::error::Error>> {
    let params = PaperAddInstrumentParams {
        name: CompactString::new("BTC"),
        price_market,
        max_leverage: 1000,
        min_margin: 1,
        min_notional: 1,
        max_notional: u64::MAX / 2,
        long_cap: u64::MAX / 2,
        short_cap: u64::MAX / 2,
        base_rate_ppm: 100_000,
        rate_multiplier: 15_000,
        position_multiplier_ppm: 814_598_000,
        reference_notional: 100_000_000_000,
    };
    let action = ActionBuilder::add_paper_instrument(paper_market, params)?;
    let tx = TransactionBuilder::new()
        .sender(signer.address())
        .expiration(u64::MAX)
        .add_action(action)
        .build_and_sign_only(signer)?;
    let response = client.submit(tx).await?;
    if !response.receipt.is_success() {
        return Err(format!("add_ins failed: {:?}", response.receipt.status).into());
    }
    Ok(())
}
