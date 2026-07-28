#!/usr/bin/env bash
# Basic MCP test - tests read tools first, then write tools
set -euo pipefail

MCP_URL="${MCP_URL:-http://127.0.0.1:8787}"
BASE_URL="${MCP_URL%/}"
ENDPOINT="$BASE_URL"
MCP_HEALTH_URL="${MCP_HEALTH_URL:-${BASE_URL%/mcp}/healthz}"
MCP_ACCESS_TOKEN="${MCP_ACCESS_TOKEN:-}"
SESSION_ID=""
HEADERS_FILE="$(mktemp)"
trap 'rm -f "$HEADERS_FILE"' EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

next_id() { echo $((RANDOM % 99999 + 1)); }

mcp_call() {
  local method="$1"
  local params="$2"
  local timeout="${3:-30}"
  local id=$(next_id)

  local headers=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
  if [[ -n "$MCP_ACCESS_TOKEN" ]]; then
    headers+=(-H "Authorization: Bearer $MCP_ACCESS_TOKEN")
  fi
  if [[ -n "$SESSION_ID" ]]; then
    headers+=(-H "mcp-session-id: $SESSION_ID")
  fi

  local body=$(jq -cn --arg m "$method" --argjson p "$params" --argjson i "$id" \
    '{jsonrpc:"2.0", method:$m, id:$i, params:$p}')

  local response
  response=$(curl -sS --max-time "$timeout" -D "$HEADERS_FILE" \
    "${headers[@]}" \
    -d "$body" \
    "$ENDPOINT" 2>&1) || {
    local exit_code=$?
    if [[ $exit_code -eq 28 ]]; then
      echo "TIMEOUT after ${timeout}s"
      return 1
    fi
    echo "HTTP request failed with curl exit ${exit_code}"
    return "$exit_code"
  }

  if [[ -z "$SESSION_ID" ]]; then
    # Extract session ID from headers - match exact header name at start of line
    SESSION_ID=$(grep -i '^mcp-session-id:' "$HEADERS_FILE" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r\n' || true)
  fi

  # Handle SSE responses
  if echo "$response" | grep -q '^data:' 2>/dev/null; then
    response=$(echo "$response" | grep '^data:' | tail -1 | sed 's/^data: *//')
  fi

  echo "$response"
}

call_tool() {
  local name="$1"
  local args="$2"
  local timeout="${3:-30}"
  mcp_call "tools/call" "$(jq -cn --arg n "$name" --argjson a "$args" '{name:$n, arguments:$a}')" "$timeout"
}

echo -e "\n${CYAN}=== Basic MCP Test ===${NC}"
echo -e "Target: ${CYAN}$ENDPOINT${NC}\n"

# Health check
echo -n "Health check... "
HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" "$MCP_HEALTH_URL" 2>&1) || HEALTH="0"
if [[ "$HEALTH" != "200" ]]; then
  echo -e "${RED}FAIL${NC} (HTTP $HEALTH)"
  exit 1
fi
echo -e "${GREEN}OK${NC}"

# Initialize
echo -e "\n${CYAN}1. Initialize MCP session${NC}"
INIT_RESP=$(mcp_call "initialize" '{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"basic-test","version":"1.0.0"}}')
echo "  Response: ${INIT_RESP:0:200}"

# Extract session ID from the headers file (function sets it but subshell may not preserve)
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID=$(grep -i '^mcp-session-id:' "$HEADERS_FILE" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r\n' || true)
fi
echo "  Session: ${SESSION_ID:-none}"

if [[ -z "$SESSION_ID" ]]; then
  echo -e "${RED}FAIL: No session ID received${NC}"
  echo "  Debug - headers file:"
  head -20 "$HEADERS_FILE" 2>/dev/null
  exit 1
fi

# Send initialized notification
NOTIFICATION_HEADERS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
if [[ -n "$MCP_ACCESS_TOKEN" ]]; then
  NOTIFICATION_HEADERS+=(-H "Authorization: Bearer $MCP_ACCESS_TOKEN")
fi
curl -sS "${NOTIFICATION_HEADERS[@]}" -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$ENDPOINT" >/dev/null 2>&1 || true

# List tools
echo -e "\n${CYAN}2. List tools${NC}"
LIST_RESP=$(mcp_call "tools/list" '{}')
TOOL_COUNT=$(echo "$LIST_RESP" | jq '.result.tools | length' 2>/dev/null || echo 0)
echo "  Tool count: $TOOL_COUNT"

# Test a read tool first (get_agent_status)
echo -e "\n${CYAN}3. Test read tool (get_agent_status)${NC}"
echo "  Calling get_agent_status with 60s timeout..."
READ_RESP=$(call_tool "get_agent_status" '{}' 60)
echo "  Response: ${READ_RESP:0:300}"

# Check if it's an error or success
if echo "$READ_RESP" | jq -e '.result' >/dev/null 2>&1; then
  IS_ERROR=$(echo "$READ_RESP" | jq -r '.result.isError // false')
  CONTENT=$(echo "$READ_RESP" | jq -r '.result.content[0].text // empty' 2>/dev/null)
  if [[ "$IS_ERROR" == "true" ]]; then
    echo -e "  ${YELLOW}Tool returned error:${NC} ${CONTENT:0:200}"
  else
    echo -e "  ${GREEN}SUCCESS${NC}: ${CONTENT:0:200}"
  fi
elif echo "$READ_RESP" | jq -e '.error' >/dev/null 2>&1; then
  ERR_MSG=$(echo "$READ_RESP" | jq -r '.error.message // "unknown"')
  echo -e "  ${RED}RPC Error:${NC} $ERR_MSG"
else
  echo -e "  ${YELLOW}Unexpected response${NC}"
fi

# Test canonical bootstrap rather than the removed legacy workspace wrapper
echo -e "\n${CYAN}4. Test canonical bootstrap${NC}"
echo "  Calling orgx_bootstrap with 60s timeout..."
WS_RESP=$(call_tool "orgx_bootstrap" '{}' 60)
echo "  Response: ${WS_RESP:0:300}"

if echo "$WS_RESP" | jq -e '.result' >/dev/null 2>&1; then
  IS_ERROR=$(echo "$WS_RESP" | jq -r '.result.isError // false')
  CONTENT=$(echo "$WS_RESP" | jq -r '.result.content[0].text // empty' 2>/dev/null)
  if [[ "$IS_ERROR" == "true" ]]; then
    echo -e "  ${YELLOW}Tool returned error:${NC} ${CONTENT:0:200}"
  else
    echo -e "  ${GREEN}SUCCESS${NC}: ${CONTENT:0:200}"
  fi
elif echo "$WS_RESP" | jq -e '.error' >/dev/null 2>&1; then
  ERR_MSG=$(echo "$WS_RESP" | jq -r '.error.message // "unknown"')
  echo -e "  ${RED}RPC Error:${NC} $ERR_MSG"
fi

assert_tool_rejected() {
  local label="$1"
  local response="$2"
  if echo "$response" | jq -e \
    '(.error != null) or (.result.isError == true)' >/dev/null 2>&1; then
    echo -e "  ${GREEN}REJECTED${NC}: $label"
    return 0
  fi
  echo -e "  ${RED}FAIL${NC}: $label was accepted"
  echo "  Response: ${response:0:300}"
  return 1
}

echo -e "\n${CYAN}5. Adversarial contract checks${NC}"
if [[ -z "$MCP_ACCESS_TOKEN" ]]; then
  echo -e "  ${YELLOW}SKIP${NC}: set MCP_ACCESS_TOKEN to prove authenticated validation paths"
  echo -e "\n${CYAN}=== Test Complete ===${NC}\n"
  exit 0
fi

START_SECONDS=$SECONDS
BAD_LIMIT_RESP=$(call_tool "orgx_search" '{"type":"initiative","limit":-1}' 15)
assert_tool_rejected "negative orgx_search limit" "$BAD_LIMIT_RESP"
if (( SECONDS - START_SECONDS >= 15 )); then
  echo -e "  ${RED}FAIL${NC}: negative limit reached the timeout boundary"
  exit 1
fi

BAD_UUID_RESP=$(call_tool "get_agent_status" '{"workspace_id":"not-a-uuid"}' 15)
assert_tool_rejected "malformed get_agent_status workspace UUID" "$BAD_UUID_RESP"

echo -e "\n${CYAN}=== Test Complete ===${NC}\n"
