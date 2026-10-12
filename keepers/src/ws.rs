// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Reconnecting indexer WebSocket helper (subscribe JSON frames).

use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub fn indexer_ws_url(indexer_http: &str) -> String {
    let base = indexer_http.trim().trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}/api/ws")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}/api/ws")
    } else if base.starts_with("ws://") || base.starts_with("wss://") {
        if base.ends_with("/api/ws") {
            base.to_string()
        } else {
            format!("{base}/api/ws")
        }
    } else {
        format!("ws://{base}/api/ws")
    }
}

/// Connect, send `subscribe` frames, forward text JSON messages until disconnect.
pub async fn run_subscribed(
    ws_url: &str,
    subscribe_frames: Vec<Value>,
    out: mpsc::Sender<Value>,
) -> Result<()> {
    let (ws, _) = connect_async(ws_url)
        .await
        .with_context(|| format!("connect ws {ws_url}"))?;
    let (mut write, mut read) = ws.split();

    for frame in &subscribe_frames {
        write
            .send(Message::Text(frame.to_string().into()))
            .await
            .context("send subscribe")?;
    }

    while let Some(msg) = read.next().await {
        let msg = msg.context("ws read")?;
        match msg {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if out.send(value).await.is_err() {
                        break;
                    }
                }
            }
            Message::Ping(p) => {
                let _ = write.send(Message::Pong(p)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

/// Spawn a reconnect loop; drops messages if `out` is full/closed.
pub fn spawn_reconnect_loop(
    ws_url: String,
    subscribe_frames: Vec<Value>,
    out: mpsc::Sender<Value>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut backoff_ms = 500u64;
        loop {
            if out.is_closed() {
                break;
            }
            match run_subscribed(&ws_url, subscribe_frames.clone(), out.clone()).await {
                Ok(()) => tracing::warn!(%ws_url, "ws disconnected"),
                Err(err) => tracing::warn!(%ws_url, error = %err, "ws error"),
            }
            if out.is_closed() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms.saturating_mul(2)).min(8_000);
        }
    })
}
