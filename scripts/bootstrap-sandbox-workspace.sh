#!/usr/bin/env bash
# =============================================================================
# bootstrap-sandbox-workspace.sh
#
# Idempotently creates (or finds) the MCP sandbox workspace in the target
# OrgX deployment and prints its ID. Run this once per environment before
# running test-write-tools.sh so test writes land somewhere harmless.
#
# The sandbox workspace carries metadata.system_role = 'mcp_sandbox' and is
# excluded from cross-workspace aggregations by
# lib/server/sandboxWorkspaces.ts.
#
# Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment, or
# a path to an env file passed as the first argument.
#
# Usage:
#   ./scripts/bootstrap-sandbox-workspace.sh
#   ./scripts/bootstrap-sandbox-workspace.sh ../orgx/orgx/.env
#   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ./scripts/bootstrap-sandbox-workspace.sh
# =============================================================================
set -euo pipefail

ENV_FILE="${1:-}"
if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "env file not found: $ENV_FILE" >&2
    exit 1
  fi
  # Extract the two keys we need without sourcing the whole file (which may
  # contain shell-hostile content like unquoted special characters).
  SUPABASE_URL="$(grep -E '^SUPABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  SUPABASE_SERVICE_ROLE_KEY="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
fi

: "${SUPABASE_URL:?SUPABASE_URL must be set (or pass an env file)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be set (or pass an env file)}"

BASE="${SUPABASE_URL%/}/rest/v1"
AUTH_HDRS=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

echo "→ Checking for existing sandbox workspace..."
existing=$(curl -sS --fail \
  "${AUTH_HDRS[@]}" \
  "${BASE}/workspaces?metadata->>system_role=eq.mcp_sandbox&select=id,slug,name" )

existing_id=$(echo "$existing" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")

if [[ -n "$existing_id" ]]; then
  echo "✓ Sandbox workspace already exists: $existing_id"
  echo ""
  echo "Export this to enable write tests:"
  echo "  export MCP_SANDBOX_WORKSPACE_ID=$existing_id"
  exit 0
fi

echo "→ No sandbox workspace found. Creating one..."

# Find an owner — use the first service-level user we can find, or fail
# clearly. The owner just has to satisfy the FK; the workspace is system-
# owned in practice.
owner_resp=$(curl -sS --fail \
  "${AUTH_HDRS[@]}" \
  "${BASE}/profiles?select=id&limit=1" 2>/dev/null || echo "[]")
OWNER_ID=$(echo "$owner_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")

if [[ -z "$OWNER_ID" ]]; then
  echo "❌ No owner_id could be resolved from profiles table. Set SANDBOX_OWNER_ID manually." >&2
  exit 1
fi

payload=$(python3 <<PY
import json
print(json.dumps({
  "owner_id": "$OWNER_ID",
  "name": "MCP Sandbox (System)",
  "slug": "mcp-sandbox-system",
  "metadata": {
    "system_role": "mcp_sandbox",
    "purpose": "Isolates MCP self-test + exploratory writes from real org data",
    "created_by": "bootstrap-sandbox-workspace.sh"
  }
}))
PY
)

create_resp=$(curl -sS --fail \
  "${AUTH_HDRS[@]}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d "$payload" \
  "${BASE}/workspaces")

new_id=$(echo "$create_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'])")

echo "✓ Created sandbox workspace: $new_id"
echo ""
echo "Export this to enable write tests:"
echo "  export MCP_SANDBOX_WORKSPACE_ID=$new_id"
