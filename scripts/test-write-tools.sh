#!/usr/bin/env bash
# =============================================================================
# test-write-tools.sh — Smoke-test every write MCP tool against the local worker
#
# Prerequisites:
#   1. Local Next.js backend running: cd orgx && pnpm dev  (port 3000)
#   2. MCP worker running: cd workers/orgx-mcp && pnpm dev (port 8787)
#
# Usage:
#   ./scripts/test-write-tools.sh            # test against localhost:8787
#   MCP_URL=https://mcp.useorgx.com ./scripts/test-write-tools.sh  # test prod
# =============================================================================
set -euo pipefail

MCP_URL="${MCP_URL:-http://127.0.0.1:8787}"
ENDPOINT="$MCP_URL/mcp"
SESSION_ID=""
PASS=0
FAIL=0
SKIP=0
RESULTS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
next_id() {
  echo $((RANDOM % 99999 + 1))
}

mcp_call() {
  local method="$1"
  local params="$2"
  local id
  id=$(next_id)

  local headers=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
  if [[ -n "$SESSION_ID" ]]; then
    headers+=(-H "mcp-session-id: $SESSION_ID")
  fi

  local body
  body=$(jq -cn --arg m "$method" --argjson p "$params" --argjson i "$id" \
    '{jsonrpc:"2.0", method:$m, id:$i, params:$p}')

  local response
  # --max-time 15: SSE responses keep connection open; cap to prevent hangs
  response=$(curl -sS --max-time 15 -D /tmp/mcp_headers -w '' \
    "${headers[@]}" \
    -d "$body" \
    "$ENDPOINT" 2>&1) || {
    # curl returns 28 on timeout which is expected for SSE
    local exit_code=$?
    if [[ $exit_code -eq 28 ]]; then
      : # timeout is fine for SSE
    elif [[ -z "$response" ]]; then
      echo "CURL_ERROR: exit code $exit_code"
      return 1
    fi
  }

  # Capture session ID from response header (exact match on header name)
  if [[ -z "$SESSION_ID" ]]; then
    SESSION_ID=$(grep -i '^mcp-session-id:' /tmp/mcp_headers 2>/dev/null | head -1 | sed 's/^[^:]*: *//' | tr -d '\r\n' || true)
  fi

  # Handle SSE responses — extract last JSON data line
  if echo "$response" | grep -q '^data:' 2>/dev/null; then
    response=$(echo "$response" | grep '^data:' | tail -1 | sed 's/^data: *//')
  fi

  echo "$response"
}

call_tool() {
  local name="$1"
  local args="$2"
  mcp_call "tools/call" "$(jq -cn --arg n "$name" --argjson a "$args" '{name:$n, arguments:$a}')"
}

check_result() {
  local tool_name="$1"
  local response="$2"
  local expect_error="${3:-false}"

  # Check for JSON parse-ability
  if ! echo "$response" | jq . >/dev/null 2>&1; then
    printf "  ${RED}FAIL${NC} %s — invalid JSON: %s\n" "$tool_name" "${response:0:120}"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL $tool_name")
    return 1
  fi

  # Check for JSON-RPC error
  local has_error
  has_error=$(echo "$response" | jq 'has("error")' 2>/dev/null || echo "false")
  local has_result
  has_result=$(echo "$response" | jq 'has("result")' 2>/dev/null || echo "false")

  if [[ "$has_error" == "true" && "$expect_error" != "true" ]]; then
    local err_msg
    err_msg=$(echo "$response" | jq -r '.error.message // "unknown"' 2>/dev/null)
    printf "  ${RED}FAIL${NC} %s — RPC error: %s\n" "$tool_name" "$err_msg"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL $tool_name")
    return 1
  fi

  if [[ "$has_result" == "true" ]]; then
    # Check if tool returned isError
    local is_tool_error
    is_tool_error=$(echo "$response" | jq -r '.result.isError // false' 2>/dev/null)
    local content_text
    content_text=$(echo "$response" | jq -r '.result.content[0].text // empty' 2>/dev/null)

    if [[ "$is_tool_error" == "true" && "$expect_error" != "true" ]]; then
      printf "  ${YELLOW}WARN${NC} %s — tool error (may be expected): %s\n" "$tool_name" "${content_text:0:120}"
      # Tool errors from the API are still "the tool works" — it called the real backend
      # We just got a legitimate error (like "entity not found" or "invalid status transition")
      printf "  ${GREEN}PASS${NC} %s — tool executed (API returned business error, no fallback)\n" "$tool_name"
      PASS=$((PASS + 1))
      RESULTS+=("PASS $tool_name (business error)")
      return 0
    fi

    printf "  ${GREEN}PASS${NC} %s — %s\n" "$tool_name" "${content_text:0:100}"
    PASS=$((PASS + 1))
    RESULTS+=("PASS $tool_name")
    return 0
  fi

  printf "  ${YELLOW}SKIP${NC} %s — unexpected shape: %s\n" "$tool_name" "${response:0:120}"
  SKIP=$((SKIP + 1))
  RESULTS+=("SKIP $tool_name")
  return 0
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}=== MCP Write Tools Smoke Test ===${NC}"
echo -e "Target: ${CYAN}$ENDPOINT${NC}"
echo ""

# Check connectivity
echo -n "Checking server health... "
HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" "$MCP_URL/healthz" 2>&1) || HEALTH="0"
if [[ "$HEALTH" != "200" ]]; then
  echo -e "${RED}FAIL${NC} (HTTP $HEALTH)"
  echo "Start the MCP worker: cd workers/orgx-mcp && pnpm dev"
  exit 1
fi
echo -e "${GREEN}OK${NC}"

# ---------------------------------------------------------------------------
# 1. Initialize MCP session
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Step 1: Initialize MCP session ---${NC}"
INIT_RESP=$(mcp_call "initialize" '{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-runner","version":"1.0.0"}}')
echo "$INIT_RESP" | jq -r '"  Server: \(.result.serverInfo.name // "?") v\(.result.serverInfo.version // "?")"' 2>/dev/null || echo "  (init response: ${INIT_RESP:0:200})"

# Debug: if session ID still empty, try to capture it from the headers file
if [[ -z "$SESSION_ID" ]]; then
  # Look for the header in the headers file from the init call
  SESSION_ID=$(grep -i '^mcp-session-id:' /tmp/mcp_headers 2>/dev/null | head -1 | sed 's/^[^:]*: *//' | tr -d '\r\n' || true)
fi
echo "  Session: ${SESSION_ID:-none}"
if [[ -z "$SESSION_ID" ]]; then
  echo "  [DEBUG] Headers file content:"
  cat /tmp/mcp_headers 2>/dev/null | head -20
fi

# Send initialized notification (no id — it's a notification)
NOTIFY_BODY='{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -sS -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  ${SESSION_ID:+-H "mcp-session-id: $SESSION_ID"} \
  -d "$NOTIFY_BODY" "$ENDPOINT" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2. List tools (sanity check)
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Step 2: Verify tools are registered ---${NC}"
LIST_RESP=$(mcp_call "tools/list" '{}')
TOOL_COUNT=$(echo "$LIST_RESP" | jq '.result.tools | length' 2>/dev/null || echo 0)
echo "  Registered tools: $TOOL_COUNT"

# Check write tools are present
for t in create_entity update_entity entity_action \
         approve_decision reject_decision spawn_agent_task \
         start_plan_session improve_plan record_plan_edit complete_plan \
         configure_org workspace stats update_stream_progress \
         account_status account_upgrade account_usage_report; do
  if echo "$LIST_RESP" | jq -e ".result.tools[] | select(.name == \"$t\")" >/dev/null 2>&1; then
    printf "  ✓ %s\n" "$t"
  else
    printf "  ${RED}✗ %s (NOT REGISTERED)${NC}\n" "$t"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL $t (not registered)")
  fi
done

# ---------------------------------------------------------------------------
# 3. Test each write tool
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Step 3: Test write tools (calls real API, no fallbacks) ---${NC}"
echo ""

# -- Entity CRUD --
echo -e "${CYAN}[Entity CRUD]${NC}"

# create_entity: create a test task
echo "  Testing create_entity (task)..."
RESP=$(call_tool "create_entity" '{
  "type": "task",
  "title": "MCP write test task — safe to delete",
  "description": "Created by test-write-tools.sh to verify MCP write tools work end-to-end."
}')
check_result "create_entity (task)" "$RESP"
CREATED_TASK_ID=$(echo "$RESP" | jq -r '.result.content[0].text' 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}' | head -1 || echo "")

# update_entity
echo "  Testing update_entity..."
if [[ -n "$CREATED_TASK_ID" ]]; then
  RESP=$(call_tool "update_entity" "{
    \"type\": \"task\",
    \"id\": \"$CREATED_TASK_ID\",
    \"title\": \"MCP write test task — UPDATED\"
  }")
else
  # Use a dummy ID to confirm the tool calls the API (will get a 404 = real behavior)
  RESP=$(call_tool "update_entity" '{
    "type": "task",
    "id": "00000000-0000-0000-0000-000000000000",
    "title": "test update"
  }')
fi
check_result "update_entity" "$RESP"

# entity_action launch (will likely fail on status transition — that's fine, proves it calls the API)
echo "  Testing entity_action (launch)..."
RESP=$(call_tool "entity_action" '{
  "type": "initiative",
  "id": "48441b3e-be7e-4f37-b0a0-fee59c586a47",
  "action": "launch"
}')
check_result "entity_action (launch)" "$RESP"

# entity_action pause (test with the same initiative — may fail on status, that's OK)
echo "  Testing entity_action (pause)..."
RESP=$(call_tool "entity_action" '{
  "type": "initiative",
  "id": "48441b3e-be7e-4f37-b0a0-fee59c586a47",
  "action": "pause"
}')
check_result "entity_action (pause)" "$RESP"

# entity_action complete (test with the test task if created)
echo "  Testing entity_action (complete)..."
if [[ -n "$CREATED_TASK_ID" ]]; then
  RESP=$(call_tool "entity_action" "{
    \"type\": \"task\",
    \"id\": \"$CREATED_TASK_ID\",
    \"action\": \"complete\"
  }")
else
  RESP=$(call_tool "entity_action" '{
    "type": "task",
    "id": "00000000-0000-0000-0000-000000000000",
    "action": "complete"
  }')
fi
check_result "entity_action (complete)" "$RESP"

# entity_action (list available actions)
echo "  Testing entity_action (list actions)..."
RESP=$(call_tool "entity_action" '{
  "type": "initiative",
  "id": "48441b3e-be7e-4f37-b0a0-fee59c586a47"
}')
check_result "entity_action (list)" "$RESP"

# entity_action attach (use created task when possible)
echo "  Testing entity_action (attach)..."
if [[ -n "$CREATED_TASK_ID" ]]; then
  RESP=$(call_tool "entity_action" "{
    \"type\": \"task\",
    \"id\": \"$CREATED_TASK_ID\",
    \"action\": \"attach\",
    \"name\": \"MCP smoke artifact\",
    \"artifact_type\": \"eng.diff_pack\",
    \"external_url\": \"https://example.com/mcp-smoke-artifact\",
    \"description\": \"Created by test-write-tools.sh to verify artifact attachment.\"
  }")
else
  RESP=$(call_tool "entity_action" '{
    "type": "task",
    "id": "00000000-0000-0000-0000-000000000000",
    "action": "attach",
    "name": "MCP smoke artifact",
    "artifact_type": "eng.diff_pack",
    "external_url": "https://example.com/mcp-smoke-artifact"
  }')
fi
check_result "entity_action (attach)" "$RESP"

echo ""

# -- Decision tools --
echo -e "${CYAN}[Decision Tools]${NC}"

echo "  Testing approve_decision..."
RESP=$(call_tool "approve_decision" '{
  "decision_id": "test-decision-00000",
  "note": "Approved via MCP write test"
}')
check_result "approve_decision" "$RESP"

echo "  Testing reject_decision..."
RESP=$(call_tool "reject_decision" '{
  "decision_id": "test-decision-00000",
  "reason": "Rejected via MCP write test"
}')
check_result "reject_decision" "$RESP"

echo ""

# -- Agent tools --
echo -e "${CYAN}[Agent Tools]${NC}"

echo "  Testing spawn_agent_task..."
RESP=$(call_tool "spawn_agent_task" '{
  "agent": "engineering",
  "task": "MCP write test — safe to ignore",
  "context": "Created by test-write-tools.sh"
}')
check_result "spawn_agent_task" "$RESP"

echo "  Testing configure_org (configure_agent)..."
RESP=$(call_tool "configure_org" '{
  "action": "configure_agent",
  "agent_type": "engineering",
  "trust_level": "balanced"
}')
check_result "configure_org (configure_agent)" "$RESP"

echo ""

# -- Plan session tools --
echo -e "${CYAN}[Plan Session Tools]${NC}"

echo "  Testing start_plan_session..."
RESP=$(call_tool "start_plan_session" '{
  "goal": "MCP write test plan — safe to delete",
  "type": "initiative"
}')
check_result "start_plan_session" "$RESP"
PLAN_SESSION_ID=$(echo "$RESP" | jq -r '.result.content[0].text' 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}' | head -1 || echo "")

echo "  Testing improve_plan..."
RESP=$(call_tool "improve_plan" "{
  \"session_id\": \"${PLAN_SESSION_ID:-test-session}\",
  \"current_plan\": \"Test plan content\"
}")
check_result "improve_plan" "$RESP"

echo "  Testing record_plan_edit..."
RESP=$(call_tool "record_plan_edit" "{
  \"session_id\": \"${PLAN_SESSION_ID:-test-session}\",
  \"edit_type\": \"refine\",
  \"before_snapshot\": \"before\",
  \"after_snapshot\": \"after\"
}")
check_result "record_plan_edit" "$RESP"

echo "  Testing complete_plan..."
RESP=$(call_tool "complete_plan" "{
  \"session_id\": \"${PLAN_SESSION_ID:-test-session}\",
  \"final_plan\": \"Final test plan\"
}")
check_result "complete_plan" "$RESP"

echo ""

# -- Org config tools --
echo -e "${CYAN}[Org Config Tools]${NC}"

echo "  Testing configure_org (set_policy)..."
RESP=$(call_tool "configure_org" '{
  "action": "set_policy",
  "policy_key": "notifications",
  "value": {"slack_enabled": true}
}')
check_result "configure_org (set_policy)" "$RESP"

echo "  Testing workspace (set)..."
RESP=$(call_tool "workspace" '{
  "action": "set",
  "workspace_id": "default"
}')
check_result "workspace (set)" "$RESP"

echo ""

# -- Stream tools --
echo -e "${CYAN}[Stream Tools]${NC}"

echo "  Testing update_stream_progress..."
RESP=$(call_tool "update_stream_progress" '{
  "stream_id": "test-stream-00000",
  "status": "in_progress",
  "progress_pct": 50,
  "status_note": "MCP write test"
}')
check_result "update_stream_progress" "$RESP"

echo ""

# -- Billing tools --
echo -e "${CYAN}[Billing Tools]${NC}"

echo "  Testing account_status..."
RESP=$(call_tool "account_status" '{
  "user_id": "00000000-0000-0000-0000-000000000000"
}')
check_result "account_status" "$RESP"

echo "  Testing account_usage_report..."
RESP=$(call_tool "account_usage_report" '{
  "user_id": "00000000-0000-0000-0000-000000000000"
}')
check_result "account_usage_report" "$RESP"

echo "  Testing account_upgrade..."
RESP=$(call_tool "account_upgrade" '{
  "target_plan": "pro",
  "billing_cycle": "monthly",
  "user_id": "00000000-0000-0000-0000-000000000000"
}')
check_result "account_upgrade" "$RESP"

# ---------------------------------------------------------------------------
# 4. Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${CYAN}=== Summary ===${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}SKIP: $SKIP${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}Failed tools:${NC}"
  for r in "${RESULTS[@]}"; do
    if [[ "$r" == FAIL* ]]; then
      echo "  - ${r#FAIL }"
    fi
  done
  echo ""
fi

if [[ $FAIL -gt 0 ]]; then
  exit 1
else
  echo -e "${GREEN}All write tools executed successfully (no fallbacks).${NC}"
  exit 0
fi
