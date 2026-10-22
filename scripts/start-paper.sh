#!/usr/bin/env bash
# Start the local paper stack by calling scripts/dev.sh.
#
# Paper market create params live in backend paper-bootstrap (via dev.sh):
#   flat_threshold ($x) = $1M, staker_cap ($y) = $2M (faster buyback soak; was $2M/$5M)
#   Change A — tail_decay_scale = 111_111_111_111 (~1% mint rate at y)
#   Change C — loss_fee_ppm = 0
# Rebuild the market after changing those (clean + start).
#
# Buyback AMM depth (after soak + hold-opens admin seed liqd):
#   hold-opens admin: one long + one short @ 1.2M USDC margin each → ~2.4M PAPER;
#     admin keeps +2.5M USDC reserve for add_liquidity.
#   buyback-amm default: ticks [-1000, 1000], L=4.5e13 (~2.2M each side) so a
#     ~2M USDC buyback can complete in one swap without leaving the bitmap window.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/dev.sh"

if [[ ! -x "$TARGET" ]]; then
  echo "start script not found: $TARGET" >&2
  echo "run ./scripts/download-and-build.sh first" >&2
  exit 1
fi

exec "$TARGET" "$@"
