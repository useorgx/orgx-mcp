#!/usr/bin/env bash
#
# smoke-endpoints.sh
#
# Smoke checks for OrgX MCP production endpoints.
#
# Usage:
#   ./scripts/smoke-endpoints.sh
#   ./scripts/smoke-endpoints.sh https://mcp.useorgx.com https://useorgx.com

set -euo pipefail

MCP_BASE="${1:-https://mcp.useorgx.com}"
APEX_BASE="${2:-https://useorgx.com}"

PASS_COUNT=0
FAIL_COUNT=0

check_endpoint() {
  local name="$1"
  local url="$2"
  local expected_status="$3"
  local expected_pattern="${4:-}"

  local tmp
  tmp="$(mktemp)"

  local status
  status="$(curl -sS -o "$tmp" -w '%{http_code}' "$url")"

  if [[ "$status" != "$expected_status" ]]; then
    echo "FAIL: $name"
    echo "   URL: $url"
    echo "   Expected HTTP $expected_status, got $status"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$tmp"
    return
  fi

  if [[ -n "$expected_pattern" ]] && ! grep -q "$expected_pattern" "$tmp"; then
    echo "FAIL: $name"
    echo "   URL: $url"
    echo "   Expected body to include pattern: $expected_pattern"
    echo "   Body preview:"
    head -c 200 "$tmp" || true
    echo
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$tmp"
    return
  fi

  echo "PASS: $name ($status)"
  PASS_COUNT=$((PASS_COUNT + 1))
  rm -f "$tmp"
}

echo "Running OrgX MCP endpoint smoke checks..."
echo "   MCP base:  $MCP_BASE"
echo "   Apex base: $APEX_BASE"
echo

check_endpoint "Health check" "$MCP_BASE/healthz" "200" "ok"
check_endpoint "OAuth authorization server discovery" "$MCP_BASE/.well-known/oauth-authorization-server" "200" "authorization_endpoint"
check_endpoint "OAuth protected resource metadata" "$MCP_BASE/.well-known/oauth-protected-resource" "200" "authorization_servers"
check_endpoint "Registry auth on MCP subdomain" "$MCP_BASE/.well-known/mcp-registry-auth" "200" "v=MCPv1; k=ed25519; p="
check_endpoint "Registry auth on apex" "$APEX_BASE/.well-known/mcp-registry-auth" "200" "v=MCPv1; k=ed25519; p="

echo
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "Smoke checks failed ($FAIL_COUNT failed, $PASS_COUNT passed)."
  exit 1
fi

echo "All endpoint smoke checks passed ($PASS_COUNT checks)."
