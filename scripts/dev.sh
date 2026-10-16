#!/usr/bin/env bash
# Local papertrader stack: Reth + USDC bridge + LightPool node + clob-indexer +
# oracle + paper bootstrap + backend + frontend + paper-keeper.
# Demo user / admin get USDC minted on Reth here; hold_opens only bridge-deposits
# admin → LP then transfers to workers (no Reth mint in hold_opens).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Anvil #0 — validator / paper market admin / keeper
MAKER_KEY="${MAKER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
MAKER_ADDR="${MAKER_ADDR:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
# Anvil #1 — default local trader (MetaMask / FE)
USER_KEY="${USER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
USER_ADDR="${USER_ADDR:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"

LP_RPC="${LP_RPC:-http://127.0.0.1:26300}"
RETH_RPC="${RETH_RPC:-http://127.0.0.1:8545}"
CLOB_HTTP="${LIGHTPOOL_CLOB_INDEX_HTTP:-http://127.0.0.1:3002}"
APP_API="${APP_API:-http://127.0.0.1:3001/api}"
# Whole USDC minted on Reth (6 decimals on-chain).
USER_RETH_USDC_WHOLE="${USER_RETH_USDC_WHOLE:-1000000}"
# Admin soak funding via hold_opens (accounts × fund-usdc); default covers large runs.
ADMIN_RETH_USDC_WHOLE="${ADMIN_RETH_USDC_WHOLE:-100000000}"

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
BRIDGE_STATE="$DATA/eth-bridge.json"
BRIDGE_CONFIG="$DATA/bridge-config.json"
RETH_DATADIR="$DATA/reth"
FORGE_DIR="$DATA/forge"
MARKETS_PATH="$APP_ROOT/data/markets.json"
CONTRACTS="$LABS/lightpool-bridge/contracts"
RETH_BIN="${RETH_BIN:-$LABS/lightpool-node/tools/reth/bin/reth}"
BRIDGE_BIN="${BRIDGE_BIN:-$LABS/lightpool-bridge/target/release/lightpool-bridge}"

NODE_DIR="$LABS/lightpool-node"
LIGHTPOOL_DIR="$LABS/lightpool"
INDEXER_DIR="$LABS/lightpool-clob-indexer"
ORACLE_DIR="$LABS/lightpool-oracle"
ORACLE_CONFIG="${ORACLE_CONFIG:-$DATA/oracle.config.json}"
HL_INFO_URL="${HYPERLIQUID_INFO_URL:-https://api.hyperliquid.xyz/info}"
HL_PROXY_FILE="${HL_PROXY_FILE:-$DATA/hl_proxy.env}"
VENUE="$LABS/lightpool-tutorials/scripts/run-venue.sh"
export PATH="${HOME}/.foundry/bin:${PATH:-}"

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

  start       Reth + USDC bridge + node + indexer + oracle + bootstrap + app + keeper
  stop        Stop app / keeper / oracle / bridge / Reth / node / indexer
  clean       Delete \$DATA (run stop first)
  status      Show PIDs
  bootstrap   Re-run paper-bootstrap only (skips if \$DATA/bootstrap.json exists)

Env:
  LABS / DATA / LIGHTPOOL_BIN / INDEXER_BIN / ORACLE_BIN / RETH_BIN / BRIDGE_BIN
  USER_RETH_USDC_WHOLE    Reth mint for demo user (default 1000000)
  ADMIN_RETH_USDC_WHOLE   Reth mint for admin / hold_opens (default 100000000)
  CARGO_WATCH=0          cargo run once instead of cargo-watch
  PAPER_KEEPER=0         skip paper-keeper
  RSS_WATCH_SEC=60       process RSS sample interval
  OPEN_MARK=10000        open-position count drawn as a chart marker

Start: Reth → node/indexer → deploy USDC+bridge → mint user+admin on Reth →
init-bridge LP USDC → bridge daemon → paper-bootstrap → oracle/app/keeper.

Demo: MetaMask Anvil #1, add Reth + USDC, Trade → Deposit.
hold_opens: admin bridge-deposit → LP transfer → paper deposit (no Reth mint).
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

mkdirs() {
  mkdir -p "$DATA" "$LOG_DIR" "$PID_DIR" "$INDEXER_DATA" "$STORE_PATH" \
    "$APP_ROOT/data" "$RETH_DATADIR" "$FORGE_DIR"
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

raw_amount() {
  python3 -c "print(int('$1') * 1_000_000)"
}

parse_labeled() {
  python3 - "$1" "$2" "$3" <<'PY'
import re, sys
text = open(sys.argv[1], errors="replace").read()
text = re.sub(r"\x1b\[[0-9;]*m", "", text)
label, prefix = sys.argv[2], sys.argv[3]
match = re.search(re.escape(label) + r"\s*:?\s*(" + prefix + r"[0-9a-fA-F]{14})", text, re.I)
if not match:
    sys.exit(1)
print(match.group(1))
PY
}

prepare_forge_home() {
  mkdir -p "$FORGE_DIR"
  cat >"$FORGE_DIR/foundry.toml" <<EOF
[profile.default]
src = "${CONTRACTS}/src"
script = "${CONTRACTS}/script"
out = "${FORGE_DIR}/out"
libs = ["${CONTRACTS}/lib"]
cache_path = "${FORGE_DIR}/cache"
broadcast = "${FORGE_DIR}/broadcast"
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200
remappings = ["forge-std/=${CONTRACTS}/lib/forge-std/src/"]
EOF
}

wait_reth() {
  local i
  echo "wait  Reth $RETH_RPC"
  for i in $(seq 1 60); do
    if cast chain-id --rpc-url "$RETH_RPC" >/dev/null 2>&1; then
      echo "ok    Reth chain-id=$(cast chain-id --rpc-url "$RETH_RPC")"
      return 0
    fi
    sleep 1
  done
  echo "Reth not ready: $RETH_RPC" >&2
  exit 1
}

start_reth() {
  if is_running reth; then
    echo "skip  Reth (already running)"
    return
  fi
  if cast chain-id --rpc-url "$RETH_RPC" >/dev/null 2>&1; then
    echo "stop  Reth on :8545 so data stays in $RETH_DATADIR"
    stop_port 8545 reth
  fi
  if [[ ! -x "$RETH_BIN" ]]; then
    echo "reth not found: $RETH_BIN" >&2
    echo "run lightpool-node/tools/reth/download.sh or set RETH_BIN" >&2
    exit 1
  fi
  echo "start Reth datadir $RETH_DATADIR"
  setsid "$RETH_BIN" node \
    --dev \
    --dev.block-time 1s \
    --datadir "$RETH_DATADIR" \
    --http \
    --http.addr 127.0.0.1 \
    --http.port 8545 \
    --http.api eth,net,web3,txpool,debug,trace \
    --http.corsdomain '*' \
    --ws \
    --ws.addr 127.0.0.1 \
    --ws.port 8546 \
    --ws.api eth,net,web3,txpool,debug,trace \
    --ws.origins '*' \
    --authrpc.addr 127.0.0.1 \
    --authrpc.port 8551 \
    --engine.persistence-threshold 0 \
    --engine.memory-block-buffer-target 0 \
    >"$LOG_DIR/reth.log" 2>&1 < /dev/null &
  echo $! >"$PID_DIR/reth.pid"
  wait_reth
}

stop_reth() {
  echo "=== stop Reth ==="
  stop_pid reth
  stop_port 8545 reth
}

stop_bridge() {
  echo "=== stop bridge ==="
  stop_pid bridge
}

lp() {
  "$LIGHTPOOL_BIN" --rpc-url "$LP_RPC" --wallet-path "$WALLET_PATH" "$@"
}

validator_stake() {
  local body stake
  body="$(curl -fsS -m 10 -X POST "$LP_RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getCommitteeInfo","params":[]}' 2>/dev/null || true)"
  stake="$(python3 -c 'import json,sys
raw=sys.stdin.read().strip()
if not raw:
    print("100"); raise SystemExit
try:
    members=(json.loads(raw).get("result") or {}).get("members") or []
except Exception:
    print("100"); raise SystemExit
want="'"$MAKER_ADDR"'".lower()
for member in members:
    if str(member.get("owner") or "").lower()==want and member.get("stake") is not None:
        print(member["stake"]); raise SystemExit
if members and members[0].get("stake") is not None:
    print(members[0]["stake"]); raise SystemExit
print("100")' <<<"$body")"
  printf '%s\n' "$stake"
}

fund_eth() {
  local to="$1" amount="$2"
  cast send "$to" --value "$amount" --rpc-url "$RETH_RPC" --private-key "$MAKER_KEY" >/dev/null \
    || echo "warning: could not send $amount ETH to $to"
}

mint_erc20() {
  local token="$1" to="$2" whole="$3"
  local raw
  raw="$(raw_amount "$whole")"
  cast send "$token" "mint(address,uint256)" "$to" "$raw" \
    --rpc-url "$RETH_RPC" --private-key "$MAKER_KEY" >/dev/null
}

deploy_usdc_and_bridge() {
  local log="$LOG_DIR/forge-usdc.log" stake
  if [[ ! -f "$CONTRACTS/lib/forge-std/src/Test.sol" ]]; then
    echo "forge-std missing under $CONTRACTS/lib. Run: forge install foundry-rs/forge-std" >&2
    echo "(from $CONTRACTS)" >&2
    exit 1
  fi
  stake="$(validator_stake)"
  echo "deploy USDC (MockUSDT) + EVM Bridge (validator stake $stake)"
  (
    cd "$CONTRACTS"
    VALIDATOR_ETH="$MAKER_ADDR" \
    VALIDATOR_STAKE="$stake" \
    USER_ETH="$USER_ADDR" \
    forge script script/DeployLocal.s.sol:DeployLocal \
      --rpc-url "$RETH_RPC" \
      --broadcast \
      --private-key "$MAKER_KEY" \
      -vv \
      --root "$CONTRACTS" \
      --config-path "$FORGE_DIR/foundry.toml" \
      --cache-path "$FORGE_DIR/cache" \
      -o "$FORGE_DIR/out"
  ) | tee "$log"
  USDC_EVM="$(python3 -c 'import re,sys; t=open(sys.argv[1],errors="replace").read(); m=re.search(r"USDT\s+(0x[0-9a-fA-F]{40})", t); print(m.group(1) if m else "")' "$log")"
  EVM_BRIDGE="$(python3 -c 'import re,sys; t=open(sys.argv[1],errors="replace").read(); m=re.search(r"BRIDGE\s+(0x[0-9a-fA-F]{40})", t); print(m.group(1) if m else "")' "$log")"
  if [[ -z "$USDC_EVM" || -z "$EVM_BRIDGE" ]]; then
    echo "failed to parse USDT / BRIDGE from $log" >&2
    exit 1
  fi
  echo "ok    USDC(EVM) $USDC_EVM"
  echo "ok    EVM Bridge $EVM_BRIDGE"
}

init_lp_usdc() {
  local log="$LOG_DIR/init-usdc.log" lp inbound
  echo "create LightPool USDC via init-bridge (foreign $USDC_EVM)"
  lp init-bridge \
    --foreign-chain-id "$EVM_CHAIN_ID" \
    --foreign-token "$USDC_EVM" \
    --name "USD Coin" \
    --symbol "USDC" >"$log" 2>&1 || true
  cat "$log"
  if grep -Eiq 'initialization failed|Failed to submit|Failed to connect|Wallet not found' "$log"; then
    echo "init-bridge failed; see $log" >&2
    exit 1
  fi
  lp="$(parse_labeled "$log" "LP token" "0x02" || true)"
  inbound="$(parse_labeled "$log" "Inbound bridge contract" "0x06" || true)"
  if [[ -z "$lp" || -z "$inbound" ]]; then
    echo "failed to parse LP USDC / inbound from $log" >&2
    exit 1
  fi
  LP_USDC="$lp"
  IN_USDC="$inbound"
  echo "ok    USDC lp=$LP_USDC inbound=$IN_USDC"
}

write_bridge_state() {
  python3 - "$BRIDGE_STATE" "$BRIDGE_CONFIG" "$WALLET_PATH" "$LP_RPC" "$RETH_RPC" \
    "$EVM_CHAIN_ID" "$EVM_BRIDGE" "$USDC_EVM" "$LP_USDC" "$IN_USDC" \
    "$MAKER_ADDR" "$USER_ADDR" <<'PY'
import json, sys
(
    state_path, config_path, wallet, lp_rpc, reth_rpc,
    chain_id, evm_bridge, usdc_evm, lp_usdc, inbound,
    maker, user,
) = sys.argv[1:]
state = {
    "evm_chain_id": int(chain_id),
    "evm_bridge": evm_bridge,
    "maker": maker,
    "user": user,
    "tokens": [
        {
            "symbol": "USDC",
            "name": "USD Coin",
            "evm": usdc_evm,
            "lp": lp_usdc,
            "inbound": inbound,
        }
    ],
}
with open(state_path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2)
    handle.write("\n")
config = {
    "wallet_path": wallet,
    "lightpool_rpc_url": lp_rpc,
    "cast_bin": "cast",
    "local": {"rpc_url": lp_rpc, "chain_id": 1},
    "routes": [
        {
            "id": "reth-usdc",
            "enabled": True,
            "local_inbound": {
                "bridge_contract": inbound,
                "lp_token": lp_usdc,
            },
            "foreign": {
                "kind": "evm",
                "rpc_url": reth_rpc,
                "chain_id": int(chain_id),
                "bridge_address": evm_bridge,
                "token_address": usdc_evm,
                "confirmations": 1,
                "start_block": 0,
            },
        }
    ],
}
with open(config_path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
print(f"wrote {state_path}")
print(f"wrote {config_path}")
PY
}

start_bridge() {
  if is_running bridge; then
    echo "skip  bridge (already running)"
    return
  fi
  if [[ ! -x "$BRIDGE_BIN" ]]; then
    echo "lightpool-bridge not found: $BRIDGE_BIN" >&2
    echo "build: (cd $LABS/lightpool-bridge && cargo build --release)" >&2
    exit 1
  fi
  if [[ ! -f "$BRIDGE_CONFIG" ]]; then
    echo "bridge config missing: $BRIDGE_CONFIG" >&2
    exit 1
  fi
  echo "start bridge"
  setsid "$BRIDGE_BIN" --config "$BRIDGE_CONFIG" \
    >"$LOG_DIR/bridge.log" 2>&1 < /dev/null &
  echo $! >"$PID_DIR/bridge.pid"
  sleep 2
  if ! is_running bridge; then
    echo "bridge exited; see $LOG_DIR/bridge.log" >&2
    exit 1
  fi
  echo "ok    bridge"
}

mint_reth_usdc_balances() {
  local usdc_evm="$1"
  echo "=== mint USDC on Reth (demo user + admin) ==="
  mint_erc20 "$usdc_evm" "$USER_ADDR" "$USER_RETH_USDC_WHOLE"
  mint_erc20 "$usdc_evm" "$MAKER_ADDR" "$ADMIN_RETH_USDC_WHOLE"
  echo "ok    user=$USER_RETH_USDC_WHOLE admin=$ADMIN_RETH_USDC_WHOLE (whole USDC)"
}

setup_usdc_bridge() {
  if [[ -f "$BRIDGE_STATE" ]]; then
    echo "skip  USDC bridge setup ($BRIDGE_STATE exists)"
    USDC_EVM="$(python3 -c 'import json,sys; t=json.load(open(sys.argv[1]))["tokens"][0]; print(t["evm"])' "$BRIDGE_STATE")"
    LP_USDC="$(python3 -c 'import json,sys; t=json.load(open(sys.argv[1]))["tokens"][0]; print(t["lp"])' "$BRIDGE_STATE")"
    IN_USDC="$(python3 -c 'import json,sys; t=json.load(open(sys.argv[1]))["tokens"][0]; print(t["inbound"])' "$BRIDGE_STATE")"
    EVM_BRIDGE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["evm_bridge"])' "$BRIDGE_STATE")"
    EVM_CHAIN_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["evm_chain_id"])' "$BRIDGE_STATE")"
    write_bridge_config_from_state
    need_cmd cast
    mint_reth_usdc_balances "$USDC_EVM"
    return
  fi
  if [[ -f "$BOOTSTRAP_STATE" ]]; then
    echo "bootstrap.json exists without eth-bridge.json." >&2
    echo "Bridged USDC must be created before paper markets. Run:" >&2
    echo "  $0 stop && $0 clean && $0 start" >&2
    exit 1
  fi
  need_cmd cast
  need_cmd forge
  prepare_forge_home
  EVM_CHAIN_ID="$(cast chain-id --rpc-url "$RETH_RPC")"
  echo "=== fund demo user on Reth (ETH gas) ==="
  fund_eth "$USER_ADDR" 10ether
  echo "=== deploy USDC + bridge on Reth ==="
  deploy_usdc_and_bridge
  mint_reth_usdc_balances "$USDC_EVM"
  echo "=== init-bridge LP USDC on LightPool ==="
  init_lp_usdc
  write_bridge_state
}

write_bridge_config_from_state() {
  python3 - "$BRIDGE_STATE" "$BRIDGE_CONFIG" "$WALLET_PATH" "$LP_RPC" "$RETH_RPC" <<'PY'
import json, sys
state_path, config_path, wallet, lp_rpc, reth_rpc = sys.argv[1:]
state = json.load(open(state_path, encoding="utf-8"))
routes = []
for token in state["tokens"]:
    routes.append({
        "id": "reth-" + token["symbol"].lower(),
        "enabled": True,
        "local_inbound": {
            "bridge_contract": token["inbound"],
            "lp_token": token["lp"],
        },
        "foreign": {
            "kind": "evm",
            "rpc_url": reth_rpc,
            "chain_id": state["evm_chain_id"],
            "bridge_address": state["evm_bridge"],
            "token_address": token["evm"],
            "confirmations": 1,
            "start_block": 0,
        },
    })
config = {
    "wallet_path": wallet,
    "lightpool_rpc_url": lp_rpc,
    "cast_bin": "cast",
    "local": {"rpc_url": lp_rpc, "chain_id": 1},
    "routes": routes,
}
with open(config_path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
print(f"wrote {config_path}")
PY
}

run_bootstrap() {
  echo "=== bootstrap tokens / spots / paper market ==="
  need_cmd cargo
  local usdc_lp="${LP_USDC:-}"
  if [[ -z "$usdc_lp" && -f "$BRIDGE_STATE" ]]; then
    usdc_lp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tokens"][0]["lp"])' "$BRIDGE_STATE")"
  fi
  (
    cd "$APP_ROOT/backend"
    INDEXER_URL="$CLOB_HTTP" \
    BOOTSTRAP_STATE="$BOOTSTRAP_STATE" \
    MARKETS_PATH="$MARKETS_PATH" \
    PAPER_FUND_KEY="${PAPER_FUND_KEY:-$USER_KEY}" \
    USDC_LP="$usdc_lp" \
    SKIP_PAPER_FUND=1 \
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

apply_proxy_url() {
  local proxy="$1"
  [[ -n "$proxy" ]] || return 1
  export HTTP_PROXY="$proxy"
  export HTTPS_PROXY="$proxy"
  export ALL_PROXY="$proxy"
  export http_proxy="$proxy"
  export https_proxy="$proxy"
  export all_proxy="$proxy"
}

load_saved_hl_proxy() {
  if [[ -n "${HL_PROXY:-}" ]]; then
    apply_proxy_url "$HL_PROXY"
    return 0
  fi
  if [[ -f "$HL_PROXY_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$HL_PROXY_FILE"
    if [[ -n "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-${ALL_PROXY:-${all_proxy:-}}}}}}" ]]; then
      local p="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-${ALL_PROXY:-$all_proxy}}}}}"
      apply_proxy_url "$p"
      echo "proxy loaded from $HL_PROXY_FILE"
      return 0
    fi
  fi
  local existing="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-${ALL_PROXY:-${all_proxy:-}}}}}}"
  if [[ -n "$existing" ]]; then
    apply_proxy_url "$existing"
  fi
}

save_hl_proxy() {
  local proxy="$1"
  mkdir -p "$(dirname "$HL_PROXY_FILE")"
  cat >"$HL_PROXY_FILE" <<EOF
# Written by $(basename "$0") when Hyperliquid required a proxy for mark price.
export HL_PROXY='$proxy'
export HTTP_PROXY='$proxy'
export HTTPS_PROXY='$proxy'
export ALL_PROXY='$proxy'
export http_proxy='$proxy'
export https_proxy='$proxy'
export all_proxy='$proxy'
EOF
}

hyperliquid_reachable() {
  local body
  body="$(
    curl -sS -m 8 -X POST "$HL_INFO_URL" \
      -H 'content-type: application/json' \
      -d '{"type":"allMids"}' 2>/dev/null || true
  )"
  [[ -n "$body" ]] || return 1
  # allMids returns a JSON object of coin -> mid string (e.g. "BTC").
  [[ "$body" == *"\"BTC\""* ]] || [[ "$body" == *'"BTC":'* ]] || [[ "$body" == *"BTC"* && "$body" == *"{"* ]]
}

ensure_hyperliquid_access() {
  need_cmd curl
  load_saved_hl_proxy

  echo "check Hyperliquid ($HL_INFO_URL)"
  if hyperliquid_reachable; then
    if [[ -n "${HTTPS_PROXY:-}" ]]; then
      echo "ok    Hyperliquid reachable (proxy=${HTTPS_PROXY})"
    else
      echo "ok    Hyperliquid reachable (direct)"
    fi
    return 0
  fi

  echo "Hyperliquid unreachable — oracle cannot publish mark price without it." >&2
  if [[ -n "${HTTPS_PROXY:-}" ]]; then
    echo "current HTTPS_PROXY=${HTTPS_PROXY} still cannot reach Hyperliquid." >&2
  else
    echo "no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/HL_PROXY in the environment." >&2
  fi

  local proxy=""
  if [[ -n "${HL_PROXY:-}" ]]; then
    proxy="$HL_PROXY"
  elif [[ -t 0 ]]; then
    echo -n "Enter proxy URL (e.g. http://127.0.0.1:7890), empty to abort: " >&2
    read -r proxy
  else
    echo "non-interactive shell: export HL_PROXY or HTTPS_PROXY and re-run." >&2
    exit 1
  fi

  proxy="$(echo "$proxy" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$proxy" ]]; then
    echo "aborted: proxy required for Hyperliquid mark feed" >&2
    exit 1
  fi

  apply_proxy_url "$proxy"
  echo "retry Hyperliquid via proxy=$proxy"
  if ! hyperliquid_reachable; then
    echo "still cannot reach Hyperliquid via $proxy; check the proxy and re-run." >&2
    exit 1
  fi

  save_hl_proxy "$proxy"
  echo "ok    Hyperliquid reachable via proxy (saved $HL_PROXY_FILE)"
}

start_oracle() {
  ensure_oracle_binary
  write_oracle_config
  ensure_hyperliquid_access

  if is_running oracle; then
    echo "restart oracle"
    stop_pid oracle
  fi

  echo "start oracle ($ORACLE_CONFIG)"
  (
    export RUST_LOG="${RUST_LOG:-info}"
    # Inherit HTTP(S)_PROXY / ALL_PROXY so reqwest allMids seed can reach HL.
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
    echo "PAPER_SIGNER_KEY=${PAPER_SIGNER_KEY:-$USER_KEY}"
    echo "HYPERLIQUID_INFO_URL=https://api.hyperliquid.xyz/info"
    echo "HYPERLIQUID_WS_URL=wss://api.hyperliquid.xyz/ws"
    echo "BRIDGE_STATE_PATH=${BRIDGE_STATE_PATH:-$DATA/eth-bridge.json}"
    echo "EVM_RPC_URL=${EVM_RPC_URL:-http://127.0.0.1:8545}"
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
    echo "NEXT_PUBLIC_DEV_ADDRESS=${NEXT_PUBLIC_DEV_ADDRESS:-$USER_ADDR}"
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
Reth      $RETH_RPC
Node      $LP_RPC
Indexer   $CLOB_HTTP
Bridge    $BRIDGE_CONFIG
Oracle    $ORACLE_CONFIG
Backend   $APP_API
Frontend  http://127.0.0.1:3000
Keeper    \$DATA/logs/keeper.log
RSS       \$DATA/logs/rss.csv
Chart     $APP_ROOT/tests/rss.html
Markets   $MARKETS_PATH
Bootstrap $BOOTSTRAP_STATE
Bridge st $BRIDGE_STATE

Accounts (import into MetaMask)
  Validator / admin (Anvil #0)
    address  $MAKER_ADDR
    key      $MAKER_KEY
  Demo user / trader (Anvil #1)
    address  $USER_ADDR
    key      $USER_KEY

Logs: $LOG_DIR
Stop: $0 stop
Clean: $0 clean   # after stop
EOF
  if [[ ! -f "$BRIDGE_STATE" ]]; then
    echo "MetaMask: eth-bridge.json missing ($BRIDGE_STATE)" >&2
    return
  fi
  python3 - "$BRIDGE_STATE" "$RETH_RPC" <<'PY'
import json, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
rpc = sys.argv[2]
print()
print("MetaMask network")
print(f"  RPC URL    {rpc}")
print(f"  Chain ID   {state.get('evm_chain_id')}")
print(f"  Bridge     {state.get('evm_bridge')}")
print("Add these ERC20 tokens in MetaMask (6 decimals):")
for token in state.get("tokens") or []:
    print(f"  {token.get('symbol'):<6} {token.get('evm')}")
print()
print("Flow: Connect MetaMask (#1) → Trade → Deposit USDC from Reth → Open.")
PY
}

rss_tree_kb() {
  local pid="$1"
  local kb=0 child ckb
  [[ -n "$pid" && -d "/proc/$pid" ]] || {
    echo 0
    return
  }
  kb="$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || echo 0)"
  [[ -n "$kb" ]] || kb=0
  for child in $(ps -o pid= --ppid "$pid" 2>/dev/null || true); do
    ckb="$(rss_tree_kb "$child")"
    kb=$((kb + ckb))
  done
  echo "$kb"
}

kb_to_mb() {
  local kb="$1"
  if [[ -z "$kb" || "$kb" -eq 0 ]]; then
    printf ''
    return
  fi
  awk -v kb="$kb" 'BEGIN { printf "%.1f", kb / 1024 }'
}

pid_of() {
  local name="$1"
  local f="$PID_DIR/$name.pid"
  local pid
  [[ -f "$f" ]] || return 0
  pid="$(cat "$f")"
  kill -0 "$pid" 2>/dev/null || return 0
  printf '%s' "$pid"
}

rss_mb_of() {
  local pid kb
  pid="$(pid_of "$1")"
  [[ -n "$pid" ]] || {
    printf ''
    return
  }
  kb="$(rss_tree_kb "$pid")"
  kb_to_mb "$kb"
}

hold_opens_mb() {
  local pids pid ppid kb=0
  pids="$(pgrep -x hold-opens 2>/dev/null || true)"
  [[ -n "$pids" ]] || pids="$(pgrep -x hold_opens 2>/dev/null || true)"
  [[ -n "$pids" ]] || {
    printf ''
    return
  }
  for pid in $pids; do
    ppid="$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || echo 0)"
    if printf '%s\n' $pids | grep -qx "$ppid"; then
      continue
    fi
    kb=$((kb + $(rss_tree_kb "$pid")))
  done
  kb_to_mb "$kb"
}

open_positions_now() {
  [[ -f "$BOOTSTRAP_STATE" ]] || {
    printf ''
    return
  }
  python3 - "$BOOTSTRAP_STATE" "$CLOB_HTTP" <<'PY' || true
import json, sys, urllib.parse, urllib.request
try:
    market = json.load(open(sys.argv[1], encoding="utf-8"))["paper_market"]
    url = sys.argv[2].rstrip("/") + "/api/paper/house?market=" + urllib.parse.quote(market)
    with urllib.request.urlopen(url, timeout=2) as resp:
        body = json.load(resp)
    print(int(body["house"]["open_positions"]))
except Exception:
    pass
PY
}

rss_watch_loop() {
  local csv="$LOG_DIR/rss.csv"
  local sec="${RSS_WATCH_SEC:-60}"
  local mark="${OPEN_MARK:-10000}"
  local ts open row name
  mkdir -p "$LOG_DIR"
  {
    echo "# open_mark=${mark}"
    echo "ts_ms,open_positions,lightpool,bridge,indexer,oracle,backend,frontend,keeper,hold_opens"
  } >"$csv"
  echo "rss-watch every ${sec}s -> $csv (open mark $mark)"
  while true; do
    ts="$(date +%s%3N)"
    open="$(open_positions_now)"
    row="$ts,$open"
    for name in lightpool bridge indexer oracle backend frontend keeper; do
      row+=",$(rss_mb_of "$name")"
    done
    row+=",$(hold_opens_mb)"
    echo "$row" >>"$csv"
    sleep "$sec"
  done
}

start_rss_watch() {
  stop_pid rss-watch
  echo "start rss-watch"
  setsid "$0" rss-watch >"$LOG_DIR/rss-watch.log" 2>&1 </dev/null &
  echo $! >"$PID_DIR/rss-watch.pid"
}

start_all() {
  need_cmd curl
  need_cmd ss
  need_cmd cargo
  need_cmd npm
  need_cmd python3
  need_cmd cast
  need_cmd forge
  mkdirs
  echo "=== start Reth ==="
  start_reth
  echo "=== start LightPool node + indexer ==="
  start_venue
  echo "=== USDC on Reth + inbound bridge ==="
  setup_usdc_bridge
  start_bridge
  run_bootstrap
  start_oracle
  start_backend
  start_frontend
  echo "=== start paper-keeper ==="
  start_keeper
  start_rss_watch
  wait_http "$APP_API/health" "backend"
  wait_http "http://127.0.0.1:3000" "frontend"
  print_summary
}

stop_all() {
  need_cmd ss
  echo "=== stop frontend / backend / keeper / oracle ==="
  stop_pid rss-watch
  stop_pid frontend
  stop_pid backend
  stop_pid keeper
  stop_pid oracle
  stop_port 3000 frontend
  stop_port 3001 backend
  stop_bridge
  stop_reth
  echo "=== stop node / indexer ==="
  stop_venue
  echo "stopped"
}

clean_all() {
  local name
  for name in frontend backend keeper oracle bridge reth lightpool indexer rss-watch; do
    if is_running "$name"; then
      echo "services still running; run: $0 stop" >&2
      exit 1
    fi
  done
  if [[ -x "$VENUE" ]]; then
    DATA="$DATA" LABS="$LABS" "$VENUE" clean || rm -rf "$DATA"
  else
    rm -rf "$DATA"
  fi
  rm -rf "$CONTRACTS/broadcast" "$CONTRACTS/cache" 2>/dev/null || true
  echo "cleaned $DATA"
}

status_all() {
  echo "LABS=$LABS"
  echo "DATA=$DATA"
  local name
  for name in reth bridge lightpool indexer oracle backend frontend keeper rss-watch; do
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
    rss-watch) rss_watch_loop ;;
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
