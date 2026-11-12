#!/usr/bin/env bash
# Development-only local companion: expose the full miodesk tool schema.
# Privileged tools still require the WebMCP content-script approval dialog.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${WEBMCP_BRIDGE_TOKEN:-}" ]; then
  export WEBMCP_BRIDGE_TOKEN_FILE="${WEBMCP_BRIDGE_TOKEN_FILE:-$ROOT/artifacts/dev-token.txt}"
fi
export WEBMCP_ALLOW_EXEC=1
export WEBMCP_ALLOW_WRITE=1
exec node "$ROOT/bridge/server.mjs"
