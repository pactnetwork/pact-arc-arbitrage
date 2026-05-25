#!/usr/bin/env bash
# Drives the Pact protocol demo end-to-end on Arc Testnet.
# Requires .env populated (see .env.example) and node_modules installed.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example to .env and populate the three private keys." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (one-time)…" >&2
  if command -v pnpm >/dev/null 2>&1; then pnpm install --silent
  elif command -v bun >/dev/null 2>&1; then bun install --silent
  else npm install --silent
  fi
fi

exec npx tsx src/demo.ts "$@"
