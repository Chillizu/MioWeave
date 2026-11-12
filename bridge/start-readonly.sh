#!/usr/bin/env bash
# Start the loopback-only bridge with read-only MCP tools.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${WEBMCP_BRIDGE_TOKEN:-}" ]; then
  export WEBMCP_BRIDGE_TOKEN_FILE="${WEBMCP_BRIDGE_TOKEN_FILE:-$ROOT/artifacts/dev-token.txt}"
fi
export WEBMCP_ALLOW_EXEC=0
export WEBMCP_ALLOW_WRITE=0
exec node "$ROOT/bridge/server.mjs"
