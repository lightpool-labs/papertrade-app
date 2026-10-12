#!/usr/bin/env bash
# Local papertrader stack: LightPool node + clob-indexer + lightpool-oracle +
# paper bootstrap + Rust backend (cargo watch) + Next.js frontend + paper-keeper.
# No Reth / bridge / liquidity-maker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MAKER_KEY="${MAKER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
MAKER_ADDR="${MAKER_ADDR:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"

LP_RPC="${LP_RPC:-http://127.0.0.1:26300}"
CLOB_HTTP="${LIGHTPOOL_CLOB_INDEX_HTTP:-http://127.0.0.1:3002}"
APP_API="${APP_API:-http://127.0.0.1:3001/api}"

resolve_labs() {
  if [[ -n "${LABS:-}" ]]; then
    printf '%s\n' "$LABS"
    return
  fi
  local candidate
  candidate="$(cd "$APP_ROOT/.." && pwd)"
  if [[ -d "$candidate/lightpool-node" || -d "$candidate/lightpool" ]]; then
    printf '%s\n' "$candidate"
    return
  fi
  printf '%s\n' "$(pwd)/lightpool-labs"
}

LABS="$(resolve_labs)"
DATA="${DATA:-$LABS/data/papertrader}"
export LABS DATA
LOG_DIR="$DATA/logs"
PID_DIR="$DATA/pids"
WALLET_PATH="$DATA/wallet.json"
STORE_PATH="$DATA/store"
VALIDATOR_PATH="$DATA/validator.json"
INDEXER_DATA="$DATA/indexer"
BOOTSTRAP_STATE="$DATA/bootstrap.json"
MARKETS_PATH="$APP_ROOT/data/markets.json"

NODE_DIR="$LABS/lightpool-node"
LIGHTPOOL_DIR="$LABS/lightpool"
INDEXER_DIR="$LABS/lightpool-clob-indexer"
ORACLE_DIR="$LABS/lightpool-oracle"
ORACLE_CONFIG="${ORACLE_CONFIG:-$DATA/oracle.config.json}"
VENUE="$LABS/lightpool-tutorials/scripts/run-venue.sh"

if [[ -z "${LIGHTPOOL_BIN:-}" ]]; then
  if [[ -x "$LIGHTPOOL_DIR/target/release/lightpool" ]]; then
    LIGHTPOOL_BIN="$LIGHTPOOL_DIR/target/release/lightpool"
  else
    LIGHTPOOL_BIN="$NODE_DIR/bin/lightpool"
  fi
fi
if [[ -z "${INDEXER_BIN:-}" ]]; then
  if [[ -x "$INDEXER_DIR/target/release/lightpool-clob-indexer" ]]; then
    INDEXER_BIN="$INDEXER_DIR/target/release/lightpool-clob-indexer"
  else
    INDEXER_BIN="$NODE_DIR/bin/lightpool-clob-indexer"
  fi
fi
if [[ -z "${ORACLE_BIN:-}" ]]; then
  if [[ -x "$ORACLE_DIR/target/release/lightpool-oracle" ]]; then
    ORACLE_BIN="$ORACLE_DIR/target/release/lightpool-oracle"
  else
    ORACLE_BIN=""
  fi
fi

# Avoid `strings | grep -q` under `set -o pipefail`: grep -q exits early,
# strings gets SIGPIPE, and the check falsely fails so start never continues.
binary_has_paper() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  grep -a -F -q "PaperMarket" "$bin"
}

# True if any lightpool crate source / Cargo.toml is newer than the binary.
lightpool_sources_newer_than() {
  local bin="$1"
  [[ -x "$bin" ]] || return 0
  local hit
  hit="$(
    find "$LIGHTPOOL_DIR" \
      \( -path '*/target/*' -o -path '*/.git/*' \) -prune -o \
      \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) \
      -type f -newer "$bin" -print 2>/dev/null | head -n 1
  )"
  [[ -n "$hit" ]]
}

rebuild_lightpool_release() {
  need_cmd cargo
  if [[ ! -f "$LIGHTPOOL_DIR/Cargo.toml" ]]; then
    echo "lightpool source not found: $LIGHTPOOL_DIR" >&2
    exit 1
  fi
  echo "build lightpool --release (paper module)"
  (
    cd "$LIGHTPOOL_DIR"
    # Cursor/sandbox may set CARGO_TARGET_DIR elsewhere; force local target/.
    unset CARGO_TARGET_DIR
    cargo build --release -p lightpool
  )
  LIGHTPOOL_BIN="$LIGHTPOOL_DIR/target/release/lightpool"
  if ! binary_has_paper "$LIGHTPOOL_BIN"; then
    echo "rebuild finished but binary still lacks paper: $LIGHTPOOL_BIN" >&2
    exit 1
  fi
}

# Prefer local release binary; rebuild when missing, lacks paper, or source is newer.
ensure_paper_binary() {
  local release_bin="$LIGHTPOOL_DIR/target/release/lightpool"
  local reason=""

  if [[ -x "$release_bin" ]]; then
    LIGHTPOOL_BIN="$release_bin"
  fi

  if [[ ! -x "$LIGHTPOOL_BIN" ]]; then
    reason="missing"
  elif ! binary_has_paper "$LIGHTPOOL_BIN"; then
    reason="no paper module"
  elif [[ -d "$LIGHTPOOL_DIR" ]] && lightpool_sources_newer_than "$LIGHTPOOL_BIN"; then
    reason="source newer than binary"
  else
    echo "bin   lightpool=$LIGHTPOOL_BIN"
    return 0
  fi

  echo "lightpool rebuild ($reason)"
  rebuild_lightpool_release
  echo "bin   lightpool=$LIGHTPOOL_BIN"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [start|stop|clean|status|bootstrap]

  start       Node + indexer + oracle + bootstrap + backend + frontend + paper-keeper
  stop        Stop frontend/backend/keeper/oracle/node/indexer
  clean       Delete \$DATA (run stop first)
  status      Show PIDs
  bootstrap   Re-run paper-bootstrap only (skips if \$DATA/bootstrap.json exists)

Env:
  LABS / DATA / LIGHTPOOL_BIN / INDEXER_BIN / ORACLE_BIN / INDEXER_URL
  ORACLE_CONFIG   default \$DATA/oracle.config.json
  CARGO_WATCH=0   use cargo run once instead of cargo watch
  PAPER_KEEPER=0  skip paper-keeper; default starts liqd+harvest+push_fees

On start, rebuilds lightpool --release if the binary is missing, lacks paper,
or any lightpool source/Cargo.toml is newer than the binary.

Creates on chain (via indexer submit):
  tokens USDC, BTC, ETH, LPL
  spot   BTC/USDC, ETH/USDC
  paper  market + BTC instrument (price_market = BTC spot)
  stake  init + register + bond/allocate Committee (no prom_*;
         RunningCommittee fills after ~1000 blocks via epoch epilogue)
  fund   paper deposit ~1_000_000 USDC for anvil #0 (MetaMask local);
         no ETH bridge until ~P6. Override: PAPER_FUND_USDC / PAPER_FUND_KEY

Oracle: HL trades → ora_commit (open-mode until RunningCommittee exists);
FE mark via indexer WS oracle.

Does NOT start: Reth, bridge, liquidity-maker.
Paper-keeper (liqd / harvest / push_fees) starts by default.
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

mkdirs() {
  mkdir -p "$DATA" "$LOG_DIR" "$PID_DIR" "$INDEXER_DATA" "$STORE_PATH" "$APP_ROOT/data"
}

is_running() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"
  [[ -f "$pid_file" ]] || return 1
  kill -0 "$(cat "$pid_file")" 2>/dev/null
}

stop_pid() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "stop  $name (pid $pid)"
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    local _
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

stop_port() {
  local port="$1"
  local name="$2"
  local pids pid
  pids="$(ss -lptnH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  [[ -n "$pids" ]] || return 0
  for pid in $pids; do
    echo "stop  $name (pid $pid port $port)"
    kill "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null || continue
    kill -9 "$pid" 2>/dev/null || true
  done
}

wait_http() {
  local url="$1"
  local name="$2"
  local i body
  echo "wait  $name $url"
  for i in $(seq 1 90); do
    body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      echo "ok    $name"
      return 0
    fi
    sleep 1
  done
  echo "$name not ready: $url" >&2
  exit 1
}

start_venue() {
  ensure_paper_binary
  if [[ -x "$VENUE" ]]; then
    echo "=== start LightPool node + indexer (run-venue) ==="
    DATA="$DATA" LABS="$LABS" LIGHTPOOL_BIN="$LIGHTPOOL_BIN" INDEXER_BIN="$INDEXER_BIN" \
      "$VENUE" start
    return
  fi

  echo "=== start LightPool node + indexer (inline) ==="
  need_cmd curl
  if [[ ! -x "$INDEXER_BIN" ]]; then
    echo "indexer binary not found: $INDEXER_BIN" >&2
    exit 1
  fi

  "$LIGHTPOOL_BIN" --wallet-path "$WALLET_PATH" import-wallet --private-key "$MAKER_KEY" --force >/dev/null

  if ! is_running lightpool; then
    echo "start lightpool"
    nohup "$LIGHTPOOL_BIN" node --role validator \
      --wallet "$WALLET_PATH" \
      --store "$STORE_PATH" \
      --validator "$VALIDATOR_PATH" \
      >"$LOG_DIR/lightpool.log" 2>&1 &
    echo $! >"$PID_DIR/lightpool.pid"
  else
    echo "skip  lightpool (already running)"
  fi

  echo "wait  lightpool RPC $LP_RPC"
  local i body
  for i in $(seq 1 60); do
    body="$(curl -fsS -X POST "$LP_RPC" \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getClientVersion","params":[]}' 2>/dev/null || true)"
    if echo "$body" | grep -Eq '"result"[[:space:]]*:[[:space:]]*"[^"]+"'; then
      echo "ok    lightpool RPC"
      break
    fi
    if [[ "$i" -eq 60 ]]; then
      echo "lightpool RPC not ready; see $LOG_DIR/lightpool.log" >&2
      exit 1
    fi
    sleep 1
  done

  if ! is_running indexer; then
    echo "start indexer"
    (
      export LIGHTPOOL_RPC_URL="$LP_RPC"
      export LIGHTPOOL_WS_URL=ws://127.0.0.1:26400
      export ENABLE_INDEXER=true
      export ENABLE_SQLITE=true
      export SQLITE_PATH="$INDEXER_DATA/clob-index.sqlite3"
      nohup "$INDEXER_BIN" >"$LOG_DIR/indexer.log" 2>&1 &
      echo $! >"$PID_DIR/indexer.pid"
    )
  else
    echo "skip  indexer (already running)"
  fi
  wait_http "$CLOB_HTTP/api/health/client_version" "clob-indexer"
}

stop_venue() {
  if [[ -x "$VENUE" ]]; then
    DATA="$DATA" LABS="$LABS" "$VENUE" stop || true
  fi
  stop_pid indexer
  stop_pid lightpool
}

ensure_cargo_watch() {
  if [[ "${CARGO_WATCH:-1}" == "0" ]]; then
    return 1
  fi
  if command -v cargo-watch >/dev/null 2>&1; then
    return 0
  fi
  echo "install cargo-watch (rebuild backend on change)"
  cargo install cargo-watch --locked
  command -v cargo-watch >/dev/null 2>&1
}

run_bootstrap() {
  echo "=== bootstrap tokens / spots / paper market ==="
  need_cmd cargo
  (
    cd "$APP_ROOT/backend"
    INDEXER_URL="$CLOB_HTTP" \
    BOOTSTRAP_STATE="$BOOTSTRAP_STATE" \
    MARKETS_PATH="$MARKETS_PATH" \
      cargo run --bin paper-bootstrap
  )
}

ensure_oracle_binary() {
  if [[ -n "${ORACLE_BIN:-}" && -x "$ORACLE_BIN" ]]; then
    echo "bin   oracle=$ORACLE_BIN"
    return 0
  fi
  local release_bin="$ORACLE_DIR/target/release/lightpool-oracle"
  if [[ -x "$release_bin" ]]; then
    ORACLE_BIN="$release_bin"
    echo "bin   oracle=$ORACLE_BIN"
    return 0
  fi
  if [[ ! -f "$ORACLE_DIR/Cargo.toml" ]]; then
    echo "lightpool-oracle source not found: $ORACLE_DIR" >&2
    exit 1
  fi
  need_cmd cargo
  echo "build lightpool-oracle --release"
  (
    cd "$ORACLE_DIR"
    unset CARGO_TARGET_DIR
    cargo build --release -p lightpool-oracle
  )
  ORACLE_BIN="$release_bin"
  if [[ ! -x "$ORACLE_BIN" ]]; then
    echo "oracle binary missing after build: $ORACLE_BIN" >&2
    exit 1
  fi
  echo "bin   oracle=$ORACLE_BIN"
}

# Rewrite \$DATA/oracle.config.json from markets.json (price_market + hl_symbol).
write_oracle_config() {
  need_cmd python3
  if [[ ! -f "$MARKETS_PATH" ]]; then
    echo "markets file missing: $MARKETS_PATH" >&2
    exit 1
  fi
  if [[ ! -f "$WALLET_PATH" ]]; then
    echo "oracle wallet missing: $WALLET_PATH (start node first)" >&2
    exit 1
  fi
  ORACLE_CONFIG="$ORACLE_CONFIG" \
  MARKETS_PATH="$MARKETS_PATH" \
  WALLET_PATH="$WALLET_PATH" \
  LP_RPC="$LP_RPC" \
  python3 - <<'PY'
import json, os, sys

markets_path = os.environ["MARKETS_PATH"]
wallet_path = os.environ["WALLET_PATH"]
out_path = os.environ["ORACLE_CONFIG"]
rpc = os.environ["LP_RPC"]

with open(markets_path) as f:
    catalog = json.load(f)

markets = []
for inst in catalog.get("instruments", []):
    if inst.get("retired"):
        continue
    spot = (inst.get("price_market") or "").strip()
    coin = (inst.get("hl_symbol") or inst.get("name") or "").strip()
    if not spot or not coin:
        continue
    markets.append({
        "spot_market": spot,
        "hl_coin": coin.upper(),
        "price_scale": 1_000_000,
        # Match paper-bootstrap CreateMarketParams.tick_size
        "tick_size": 10_000,
    })

if not markets:
    print("no active instruments with price_market in markets.json", file=sys.stderr)
    sys.exit(1)

cfg = {
    "wallet_path": wallet_path,
    "lightpool_rpc_url": rpc,
    "hyperliquid_ws_url": "wss://api.hyperliquid.xyz/ws",
    "hyperliquid_info_url": "https://api.hyperliquid.xyz/info",
    "round_ms": 100,
    "collect_wait_ms": 50,
    "peer_listen": "127.0.0.1:9100",
    "peers": [],
    "markets": markets,
}
os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
with open(out_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"wrote {out_path} markets={len(markets)}")
PY
}

start_oracle() {
  ensure_oracle_binary
  write_oracle_config

  if is_running oracle; then
    echo "restart oracle"
    stop_pid oracle
  fi

  echo "start oracle ($ORACLE_CONFIG)"
  (
    export RUST_LOG="${RUST_LOG:-info}"
    setsid "$ORACLE_BIN" --config "$ORACLE_CONFIG" \
      >"$LOG_DIR/oracle.log" 2>&1 < /dev/null &
    echo $! >"$PID_DIR/oracle.pid"
  )
  sleep 0.5
  if ! is_running oracle; then
    echo "oracle failed to start; see $LOG_DIR/oracle.log" >&2
    exit 1
  fi
  echo "ok    oracle pid=$(cat "$PID_DIR/oracle.pid")"
}

start_backend() {
  need_cmd cargo
  if [[ ! -f "$APP_ROOT/backend/.env" && -f "$APP_ROOT/backend/.env.example" ]]; then
    cp "$APP_ROOT/backend/.env.example" "$APP_ROOT/backend/.env"
  fi
  # Point runtime markets + indexer at this stack.
  {
    echo "HOST=0.0.0.0"
    echo "PORT=3001"
    echo "INDEXER_URL=$CLOB_HTTP"
    echo "MARKETS_PATH=$MARKETS_PATH"
    echo "HYPERLIQUID_INFO_URL=https://api.hyperliquid.xyz/info"
    echo "HYPERLIQUID_WS_URL=wss://api.hyperliquid.xyz/ws"
  } >"$APP_ROOT/backend/.env"

  if is_running backend; then
    echo "restart backend"
    stop_pid backend
    stop_port 3001 backend
  fi

  echo "start backend"
  (
    cd "$APP_ROOT/backend"
    if ensure_cargo_watch; then
      echo "watch backend (cargo watch -x 'run --bin papertrader-backend')"
      setsid cargo watch -q -w src -w Cargo.toml -x 'run --bin papertrader-backend' \
        >"$LOG_DIR/backend.log" 2>&1 < /dev/null &
    else
      echo "build + run backend (set CARGO_WATCH=1 and install cargo-watch for rebuild-on-change)"
      cargo build --bin papertrader-backend
      setsid cargo run --bin papertrader-backend \
        >"$LOG_DIR/backend.log" 2>&1 < /dev/null &
    fi
    echo $! >"$PID_DIR/backend.pid"
  )
}

start_frontend() {
  need_cmd npm
  if [[ ! -d "$APP_ROOT/frontend/node_modules" ]]; then
    echo "npm install (frontend)"
    (cd "$APP_ROOT/frontend" && npm install)
  fi
  mkdir -p "$APP_ROOT/frontend"
  {
    echo "NEXT_PUBLIC_API_URL=$APP_API"
    echo "NEXT_PUBLIC_INDEXER_URL=$CLOB_HTTP"
    echo "NEXT_PUBLIC_INDEXER_WS_URL=ws://127.0.0.1:3002/api/ws"
    echo "NEXT_PUBLIC_DEV_ADDRESS=$MAKER_ADDR"
  } >"$APP_ROOT/frontend/.env.local"

  if is_running frontend; then
    echo "restart frontend"
    stop_pid frontend
    stop_port 3000 frontend
  fi

  echo "start frontend (next dev — HMR on change)"
  (
    cd "$APP_ROOT/frontend"
    setsid npm run dev >"$LOG_DIR/frontend.log" 2>&1 < /dev/null &
    echo $! >"$PID_DIR/frontend.pid"
  )
}

start_keeper() {
  if [[ "${PAPER_KEEPER:-1}" == "0" ]]; then
    echo "skip  paper-keeper (PAPER_KEEPER=0)"
    return
  fi
  need_cmd cargo
  local keeper_bin="$APP_ROOT/keepers/target/release/paper-keeper"
  if is_running keeper; then
    echo "restart paper-keeper"
    stop_pid keeper
  fi

  echo "build paper-keeper (release)"
  (
    cd "$APP_ROOT/keepers"
    cargo build --release --bin paper-keeper
  ) >>"$LOG_DIR/keeper.log" 2>&1
  if [[ ! -x "$keeper_bin" ]]; then
    echo "paper-keeper binary missing after build; see $LOG_DIR/keeper.log" >&2
    exit 1
  fi

  echo "start paper-keeper (liqd/harvest/push_fees)"
  (
    export INDEXER_URL="$CLOB_HTTP"
    export MARKETS_PATH="$MARKETS_PATH"
    export PAPER_KEEPER_KEY="${PAPER_KEEPER_KEY:-$MAKER_KEY}"
    export PAPER_KEEPER_POLL_MS="${PAPER_KEEPER_POLL_MS:-2000}"
    export PAPER_KEEPER_LIQD_RECONCILE_MS="${PAPER_KEEPER_LIQD_RECONCILE_MS:-60000}"
    export PAPER_KEEPER_LIQD="${PAPER_KEEPER_LIQD:-1}"
    export PAPER_KEEPER_HARVEST="${PAPER_KEEPER_HARVEST:-1}"
    export PAPER_KEEPER_PUSH_FEES="${PAPER_KEEPER_PUSH_FEES:-1}"
    export PAPER_KEEPER_HARVEST_MAX="${PAPER_KEEPER_HARVEST_MAX:-64}"
    export RUST_LOG="${RUST_LOG:-info}"
    setsid "$keeper_bin" >"$LOG_DIR/keeper.log" 2>&1 < /dev/null &
    echo $! >"$PID_DIR/keeper.pid"
  )
  local i
  for i in $(seq 1 20); do
    if is_running keeper; then
      echo "ok    paper-keeper pid=$(cat "$PID_DIR/keeper.pid")"
      return
    fi
    sleep 0.25
  done
  echo "paper-keeper failed to start; see $LOG_DIR/keeper.log" >&2
  exit 1
}

print_summary() {
  cat <<EOF

=== papertrade-app ===
LABS      $LABS
DATA      $DATA
Node      $LP_RPC
Indexer   $CLOB_HTTP
Oracle    $ORACLE_CONFIG
Backend   $APP_API
Frontend  http://127.0.0.1:3000
Keeper    paper-keeper (liqd/harvest/push_fees); log \$DATA/logs/keeper.log
Markets   $MARKETS_PATH
Bootstrap $BOOTSTRAP_STATE

Validator / admin (Anvil #0):
  address  $MAKER_ADDR
  key      $MAKER_KEY

Mark: FE → indexer WS channel oracle (spot_market from markets.json)

Logs: $LOG_DIR
Stop: $0 stop
Clean: $0 clean   # after stop

No bridge / liquidity-maker / Reth in this script.
EOF
}

start_all() {
  need_cmd curl
  need_cmd ss
  need_cmd cargo
  need_cmd npm
  need_cmd python3
  mkdirs
  start_venue
  run_bootstrap
  start_oracle
  start_backend
  start_frontend
  echo "=== start paper-keeper ==="
  start_keeper
  wait_http "$APP_API/health" "backend"
  wait_http "http://127.0.0.1:3000" "frontend"
  print_summary
}

stop_all() {
  need_cmd ss
  echo "=== stop frontend / backend / keeper / oracle ==="
  stop_pid frontend
  stop_pid backend
  stop_pid keeper
  stop_pid oracle
  stop_port 3000 frontend
  stop_port 3001 backend
  echo "=== stop node / indexer ==="
  stop_venue
  echo "stopped"
}

clean_all() {
  local name
  for name in frontend backend keeper oracle lightpool indexer; do
    if is_running "$name"; then
      echo "services still running; run: $0 stop" >&2
      exit 1
    fi
  done
  # Venue clean if helper exists
  if [[ -x "$VENUE" ]]; then
    DATA="$DATA" LABS="$LABS" "$VENUE" clean || rm -rf "$DATA"
  else
    rm -rf "$DATA"
  fi
  # Keep markets.json template; bootstrap will rewrite addresses next start
  echo "cleaned $DATA"
}

status_all() {
  echo "LABS=$LABS"
  echo "DATA=$DATA"
  local name
  for name in lightpool indexer oracle backend frontend keeper; do
    if is_running "$name"; then
      echo "UP   $name pid=$(cat "$PID_DIR/$name.pid")"
    else
      echo "DOWN $name"
    fi
  done
}

main() {
  case "${1:-start}" in
    start) start_all ;;
    stop) stop_all ;;
    clean) clean_all ;;
    status) status_all ;;
    bootstrap)
      mkdirs
      run_bootstrap
      ;;
    -h|--help|help) usage ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
