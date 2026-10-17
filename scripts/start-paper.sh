#!/usr/bin/env bash
# Start the local paper stack by calling scripts/dev.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/dev.sh"

if [[ ! -x "$TARGET" ]]; then
  echo "start script not found: $TARGET" >&2
  echo "run ./scripts/download-and-build.sh first" >&2
  exit 1
fi

exec "$TARGET" "$@"
