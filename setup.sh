#!/bin/sh
# AIVault setup for macOS / Linux
cd "$(dirname "$0")" || exit 1
chmod +x vault setup.sh 2>/dev/null
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org (or: brew install node)"
  exit 1
fi
exec node engine/cli.mjs setup "$@"
