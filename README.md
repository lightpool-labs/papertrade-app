# Papertrade App

papertrade-app implements a Papertrade-style synthetic perpetuals exchange on LightPool—Long/Short up to 1000x against the house as counterparty, with CEX-smooth trading and no wallet popups on every order. Losers farm PAPER to become shareholders of the exchange, and stake PAPER to earn fees. Educational and research use only — not for production.

```bash
mkdir -p lightpool-labs && cd lightpool-labs
git clone git@github.com:lightpool-labs/papertrade-app.git
cd papertrade-app
```

## Step 1

Install the toolchain. Tools that are already installed are skipped.

```bash
./scripts/download-toolchain.sh
```

## Step 2

Download the other repositories and build them. Repositories that are already cloned are skipped.

```bash
./scripts/download-and-build.sh
```

The script clones these repositories next to this app: `lightpool`, `lightpool-node`, `lightpool-crypto`, `lightpool-sdk-rust`, `lightpool-clob-indexer`, `lightpool-bridge`, `lightpool-oracle`, and `lightpool-tutorials`. It then downloads Reth and builds the node (paper module), indexer, bridge, oracle, and paper-keeper.

## Step 3

Start the local stack (Reth + USDC bridge + node + indexer + oracle + bootstrap + app + keeper).

```bash
./scripts/start-paper.sh start
```

At the end it prints MetaMask accounts, Reth RPC / chain id, bridge, and USDC ERC20.
Import Anvil #1, add the Reth network + USDC token, open http://127.0.0.1:3000/trade/btc → Connect → Deposit.

To generate trading, start `hold-opens` after the stack is up. Run it from `tests/` so the default paths resolve.

```bash
cd tests
cargo run --release --bin hold-opens
```

Stop:

```bash
./scripts/start-paper.sh stop
```

Status / clean runtime data (stop first):

```bash
./scripts/start-paper.sh status
./scripts/start-paper.sh clean
```

## Song demo (Fireworks video)

Record the Fireworks / liquidation-ash UI driven by an MP3: upload a song to
the demo sidecar, then open `/trade/btc?demo=<session_id>` for a deterministic
fake mark + liquidation timeline that erupts at the song climax. No chain, no
wallet transactions. See [`demo/README.md`](./demo/README.md).
