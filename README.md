# Papertrader App

LightPool Papertrade-style product (prediction / paper perps UI): Next.js frontend +
Rust BFF. Design: [`../tools/paper/DESIGN.md`](../tools/paper/DESIGN.md).
App plan: [`../tools/paper/APP.md`](../tools/paper/APP.md).

```bash
mkdir -p lightpool-labs && cd lightpool-labs
git clone git@github.com:lightpool-labs/papertrade-app.git
cd papertrade-app
```

Requires sibling repos under `lightpool-labs/` (same layout as tokenized-stocks):
`lightpool-node`, `lightpool-sdk-rust`, `lightpool-clob-indexer`, `lightpool-oracle`
(and `lightpool-crypto` / `lightpool-tutorials` if you follow the stocks download
scripts). Chain access is **BFF → indexer → node** only — no direct LightPool RPC
from the backend.

## Step 1

Install toolchain / deps as needed (Rust, Node, `cargo-watch` optional for backend HMR).

```bash
# frontend
cd frontend && npm install && cd ..
```

## Step 2

Build or obtain LightPool node (with paper module), indexer, and oracle binaries
(e.g. via `lightpool-node` release build, or the stocks `download-and-build.sh`
layout). `./scripts/dev.sh start` uses `lightpool-node/bin/lightpool` when present.

## Step 3

Start the local stack (node + indexer + oracle + paper-bootstrap + backend + frontend).
No Reth or bridge.

```bash
./scripts/dev.sh start
```

Open http://127.0.0.1:3000 → `/trade/btc`.

Stop:

```bash
./scripts/dev.sh stop
```

Status / clean runtime data (stop first):

```bash
./scripts/dev.sh status
./scripts/dev.sh clean
```

Set `CARGO_WATCH=0` to run the backend once instead of `cargo watch`.

## What bootstrap creates

Via indexer submit (idempotent when `$DATA/bootstrap.json` exists):

- tokens: **USDC**, **BTC**, **ETH**, **LPL**
- spots: **BTC/USDC**, **ETH/USDC**
- paper market + **BTC** instrument (`price_market` = BTC spot)
- stake init + Committee bond/allocate
- ~1M USDC paper deposit for anvil #0 (`PAPER_FUND_USDC` / `PAPER_FUND_KEY` to override)
- writes `data/markets.json` and `$DATA/bootstrap.json`

## Layout

```
papertrade-app/
  backend/           # Rust BFF (INDEXER_URL only)
  frontend/          # Next.js (Trade / Portfolio / House)
  data/markets.json  # instrument registry (filled by bootstrap)
  scripts/dev.sh     # local stack
```
