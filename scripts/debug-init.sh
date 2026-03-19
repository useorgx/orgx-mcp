#!/usr/bin/env bash
# Debug MCP initialize to capture session headers
set -euo pipefail

ENDPOINT="${MCP_URL:-http://127.0.0.1:8787}/mcp"
HEADERS_FILE="/tmp/mcp_debug_headers.txt"

echo "Sending initialize to $ENDPOINT..."
RESP=$(curl -sS -D "$HEADERS_FILE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-debug","version":"1.0.0"}}}' \
  "$ENDPOINT" 2>&1)

echo ""
echo "=== Response Headers ==="
cat "$HEADERS_FILE"
echo ""
echo "=== Response Body ==="
echo "$RESP" | head -20
echo ""

# Try to extract session ID
SID=$(grep -i 'mcp-session-id\|session' "$HEADERS_FILE" | head -5 || echo "(none found)")
echo "=== Session ID candidates ==="
echo "$SID"
