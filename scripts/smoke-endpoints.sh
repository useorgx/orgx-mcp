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

check_redirected_endpoint() {
  local name="$1"
  local url="$2"
  local expected_status="$3"
  local expected_pattern="$4"
  local expected_location_prefix="$5"

  local headers_tmp
  local body_tmp
  headers_tmp="$(mktemp)"
  body_tmp="$(mktemp)"

  local final_status
  final_status="$(curl -sS -L -D "$headers_tmp" -o "$body_tmp" -w '%{http_code}' "$url")"

  if [[ "$final_status" != "$expected_status" ]]; then
    echo "FAIL: $name"
    echo "   URL: $url"
    echo "   Expected final HTTP $expected_status, got $final_status"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$headers_tmp" "$body_tmp"
    return
  fi

  if ! grep -q "$expected_pattern" "$body_tmp"; then
    echo "FAIL: $name"
    echo "   URL: $url"
    echo "   Expected body to include pattern: $expected_pattern"
    echo "   Body preview:"
    head -c 200 "$body_tmp" || true
    echo
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$headers_tmp" "$body_tmp"
    return
  fi

  local first_location
  first_location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {print $2; exit}' "$headers_tmp" | tr -d '\r')"
  if [[ -n "$expected_location_prefix" && -n "$first_location" && "$first_location" != "$expected_location_prefix"* ]]; then
    echo "FAIL: $name"
    echo "   URL: $url"
    echo "   Expected redirect location to start with: $expected_location_prefix"
    echo "   Got: $first_location"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$headers_tmp" "$body_tmp"
    return
  fi

  if [[ -n "$first_location" ]]; then
    echo "PASS: $name ($final_status via redirect)"
  else
    echo "PASS: $name ($final_status)"
  fi
  PASS_COUNT=$((PASS_COUNT + 1))
  rm -f "$headers_tmp" "$body_tmp"
}

echo "Running OrgX MCP endpoint smoke checks..."
echo "   MCP base:  $MCP_BASE"
echo "   Apex base: $APEX_BASE"
echo

check_endpoint "Health check" "$MCP_BASE/healthz" "200" "ok"
check_endpoint "OAuth authorization server discovery" "$MCP_BASE/.well-known/oauth-authorization-server" "200" "authorization_endpoint"
check_endpoint "OAuth protected resource metadata" "$MCP_BASE/.well-known/oauth-protected-resource" "200" "authorization_servers"
check_endpoint "Registry auth on MCP subdomain" "$MCP_BASE/.well-known/mcp-registry-auth" "200" "v=MCPv1; k=ed25519; p="
check_redirected_endpoint \
  "Registry auth on apex" \
  "$APEX_BASE/.well-known/mcp-registry-auth" \
  "200" \
  "v=MCPv1; k=ed25519; p=" \
  "https://www.useorgx.com/.well-known/mcp-registry-auth"

echo
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "Smoke checks failed ($FAIL_COUNT failed, $PASS_COUNT passed)."
  exit 1
fi

echo "All endpoint smoke checks passed ($PASS_COUNT checks)."
