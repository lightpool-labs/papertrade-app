# Papertrade App

papertrade-app implements a Papertrade-style synthetic perpetuals exchange on LightPool—Long/Short up to 1000x against the house as counterparty, with CEX-smooth trading and no wallet popups on every order. Losers farm PAPER to become shareholders of the exchange, and stake PAPER to earn fees. Educational use only — not for production.

```bash
mkdir -p lightpool-labs && cd lightpool-labs
git clone git@github.com:lightpool-labs/papertrade-app.git
cd papertrade-app
```

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

Open http://127.0.0.1:3000/trade/btc` 

Stop:

```bash
./scripts/dev.sh stop
```

Status / clean runtime data (stop first):

```bash
./scripts/dev.sh status
./scripts/dev.sh clean
```