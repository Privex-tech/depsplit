#!/usr/bin/env bash
# Build and test everything in DepSplit. Run from anywhere.
#   scripts/build.sh            contract tests + wasm + app tests
#   scripts/build.sh --no-app   skip the TypeScript app
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== split_router: cargo test"
cargo test

echo "== split_router: stellar contract build (wasm32v1-none)"
stellar contract build
WASM="$ROOT/target/wasm32v1-none/release/split_router.wasm"
if [[ -f "$WASM" ]]; then
  echo "wasm: $WASM ($(stat -c %s "$WASM") bytes)"
else
  echo "wasm not found at $WASM" >&2
  exit 1
fi

if [[ "${1:-}" != "--no-app" ]]; then
  echo "== app: npm install + npm test (offline)"
  cd "$ROOT/app"
  if [[ ! -d node_modules ]]; then
    npm install --no-audit --no-fund
  fi
  npm test
fi

echo "== done"
