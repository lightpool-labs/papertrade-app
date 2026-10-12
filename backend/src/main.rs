// Copyright (c) LightPool Labs
// Author: xiaoyu1998

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, Method};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use lightpool_sdk::lightpool_types::SignedTransaction;
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

mod config;
mod error;
mod hyperliquid;
mod indexer;
mod markets;
mod paper_tx;
mod state;
mod ws_bars;

use config::Config;
use error::AppResult;
use hyperliquid::{BarsResponse, MarkResponse};
use markets::{MarketRegistry, MarketView};
use state::AppState;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Serialize)]
struct ReadyResponse {
    status: &'static str,
    indexer: bool,
}

#[derive(Serialize)]
struct ConfigResponse {
    paper_market: String,
    quote_decimals: u32,
    liq_buffer_ppm: u64,
    indexer_url: String,
}

#[derive(Serialize)]
struct MarketsResponse {
    markets: Vec<MarketView>,
}

#[derive(Deserialize)]
struct BarsQuery {
    interval: Option<String>,
    limit: Option<u64>,
    from: Option<u64>,
    to: Option<u64>,
}

#[derive(Deserialize)]
struct AccountQuery {
    market: Option<String>,
    address: String,
}

#[derive(Deserialize)]
struct PositionsQuery {
    address: String,
    market: Option<String>,
    status: Option<String>,
}

#[derive(Deserialize)]
struct HistoryQuery {
    address: String,
    market: Option<String>,
}

#[derive(Deserialize)]
struct HouseQuery {
    market: Option<String>,
}

#[derive(Deserialize)]
struct SubmitTxRequest {
    tx: SignedTransaction,
}

#[derive(Serialize)]
struct SubmitTxResponse {
    digest: String,
    block_num: u64,
    status: String,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "papertrader_backend=debug,tower_http=debug".into()
            }),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    let markets = MarketRegistry::load(&config.markets_path).unwrap_or_else(|e| {
        tracing::error!(error = %e, "failed to load markets registry");
        panic!("markets registry required: {e}");
    });

    let state = AppState::new(config.clone(), markets);

    let cors = CorsLayer::new()
        .allow_origin([
            HeaderValue::from_static("http://localhost:3000"),
            HeaderValue::from_static("http://127.0.0.1:3000"),
        ])
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE]);

    let app = Router::new()
        .nest(
            "/api",
            Router::new()
                .route("/health", get(health))
                .route("/ready", get(ready))
                .route("/config", get(get_config))
                .route("/markets", get(list_markets))
                .route("/markets/:slug", get(get_market))
                .route("/markets/:slug/bars", get(get_bars))
                .route("/markets/:slug/mark/history", get(get_mark_history))
                .route("/markets/:slug/mark", get(get_mark))
                .route("/account", get(get_account))
                .route("/positions", get(get_positions))
                .route("/history", get(get_history))
                .route("/house", get(get_house))
                .route("/paper/open", post(open_paper))
                .route("/paper/close", post(close_paper))
                .route("/tx/submit", post(submit_tx))
                .route("/ws", get(ws_upgrade)),
        )
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("invalid listen address");

    tracing::info!("papertrader backend listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");

    axum::serve(listener, app)
        .await
        .expect("server failed");
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn ready(State(state): State<AppState>) -> Json<ReadyResponse> {
    let indexer = state.indexer.health_ok().await;
    Json(ReadyResponse {
        status: if indexer { "ready" } else { "degraded" },
        indexer,
    })
}

async fn get_config(State(state): State<AppState>) -> Json<ConfigResponse> {
    let snap = state.markets.config_snapshot();
    Json(ConfigResponse {
        paper_market: snap.paper_market,
        quote_decimals: snap.quote_decimals,
        liq_buffer_ppm: snap.liq_buffer_ppm,
        indexer_url: state.config.indexer_url.clone(),
    })
}

async fn list_markets(State(state): State<AppState>) -> Json<MarketsResponse> {
    Json(MarketsResponse {
        markets: state.markets.list(),
    })
}

async fn get_market(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Json<MarketView>> {
    Ok(Json(state.markets.get_by_slug(&slug)?))
}

async fn get_bars(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(query): Query<BarsQuery>,
) -> AppResult<Json<BarsResponse>> {
    let market = state.markets.get_by_slug(&slug)?;
    let bars = state
        .hl
        .candle_snapshot(
            &market.hl_symbol,
            query.interval.as_deref().unwrap_or("1m"),
            query.limit,
            query.from,
            query.to,
        )
        .await?;
    Ok(Json(bars))
}

async fn get_mark(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Json<MarkResponse>> {
    let market = state.markets.get_by_slug(&slug)?;
    if market.price_market.trim().is_empty() {
        return Err(error::AppError::NotFound(format!(
            "no price_market for {slug}"
        )));
    }
    let oracle = state.indexer.get_oracle_mark(&market.price_market).await?;
    Ok(Json(MarkResponse {
        slug: market.slug,
        symbol: market.hl_symbol.clone(),
        hl_coin: hyperliquid::hl_coin_for_symbol(&market.hl_symbol),
        mark: oracle.mark_price,
        source: "indexer_oracle",
    }))
}

#[derive(Debug, Deserialize)]
struct MarkHistoryQuery {
    from_ms: Option<u64>,
    limit: Option<usize>,
}

async fn get_mark_history(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(query): Query<MarkHistoryQuery>,
) -> AppResult<Json<indexer::IndexerOracleHistory>> {
    let market = state.markets.get_by_slug(&slug)?;
    if market.price_market.trim().is_empty() {
        return Err(error::AppError::NotFound(format!(
            "no price_market for {slug}"
        )));
    }
    let history = state
        .indexer
        .get_oracle_mark_history(&market.price_market, query.from_ms, query.limit)
        .await?;
    Ok(Json(history))
}

async fn get_account(
    State(state): State<AppState>,
    Query(query): Query<AccountQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let market = query
        .market
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| state.markets.config_snapshot().paper_market);
    if market.trim().is_empty() {
        return Err(error::AppError::BadRequest(
            "paper market is required (set markets.json paper_market or pass ?market=)".into(),
        ));
    }
    let body = state
        .indexer
        .get_paper_account(&market, query.address.trim())
        .await?;
    Ok(Json(body))
}

async fn get_positions(
    State(state): State<AppState>,
    Query(query): Query<PositionsQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let status = query.status.as_deref().unwrap_or("open");
    let market = query.market.as_deref();
    let body = state
        .indexer
        .get_paper_positions(query.address.trim(), market, status)
        .await?;
    Ok(Json(body))
}

async fn get_history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let body = state
        .indexer
        .get_paper_history(query.address.trim(), query.market.as_deref())
        .await?;
    Ok(Json(body))
}

async fn get_house(
    State(state): State<AppState>,
    Query(query): Query<HouseQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let market = query
        .market
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| state.markets.config_snapshot().paper_market);
    if market.trim().is_empty() {
        return Err(error::AppError::BadRequest(
            "paper market is required (set markets.json paper_market or pass ?market=)".into(),
        ));
    }
    let body = state.indexer.get_paper_house(market.trim()).await?;
    Ok(Json(body))
}

async fn open_paper(
    State(state): State<AppState>,
    Json(body): Json<paper_tx::OpenPaperRequest>,
) -> AppResult<Json<paper_tx::OpenPaperResponse>> {
    Ok(Json(paper_tx::open_paper(&state, body).await?))
}

async fn close_paper(
    State(state): State<AppState>,
    Json(body): Json<paper_tx::ClosePaperRequest>,
) -> AppResult<Json<paper_tx::ClosePaperResponse>> {
    Ok(Json(paper_tx::close_paper(&state, body).await?))
}

async fn submit_tx(
    State(state): State<AppState>,
    Json(body): Json<SubmitTxRequest>,
) -> AppResult<Json<SubmitTxResponse>> {
    let result = state.indexer.submit_transaction(body.tx).await?;
    let status = if result.receipt.is_success() {
        "ok"
    } else {
        "failed"
    };
    Ok(Json(SubmitTxResponse {
        digest: result.digest,
        block_num: result.block_num,
        status: status.into(),
    }))
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let hl_ws_url = Arc::clone(&state.hl_ws_url);
    ws.on_upgrade(move |socket| ws_bars::handle_client_socket(socket, hl_ws_url))
}
