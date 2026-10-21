#!/usr/bin/env bash
# Start the local paper stack by calling scripts/dev.sh.
#
# Paper market create params live in backend paper-bootstrap (via dev.sh):
#   Change A — tail_decay_scale = 333_000_000_000 (~1% mint rate at staker_cap)
#   Change C — loss_fee_ppm = 0
# Rebuild the market after changing those (clean + start).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/dev.sh"

if [[ ! -x "$TARGET" ]]; then
  echo "start script not found: $TARGET" >&2
  echo "run ./scripts/download-and-build.sh first" >&2
  exit 1
fi

exec "$TARGET" "$@"
