#!/usr/bin/env bash
#
# publish-to-registry.sh
#
# Publishes OrgX MCP server to the official MCP Registry.
# Requires:
#   - mcp-publisher CLI installed
#   - Domain verification set up (DNS or HTTP)
#   - Private key generated via generate-registry-keys.sh
#
# Usage:
#   ./scripts/publish-to-registry.sh [--dry-run]
#
# Options:
#   --dry-run    Validate without publishing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/.."
KEYS_DIR="$WORKER_DIR/keys"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "🔍 Running in dry-run mode (validation only)"
fi

# Check for mcp-publisher
if ! command -v mcp-publisher &> /dev/null; then
  echo "❌ mcp-publisher not found. Install it with:"
  echo ""
  echo "   # macOS/Linux"
  echo '   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr "[:upper:]" "[:lower:]")_$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/").tar.gz" | tar xz mcp-publisher'
  echo "   sudo mv mcp-publisher /usr/local/bin/"
  echo ""
  echo "   # Or via Homebrew"
  echo "   brew install modelcontextprotocol/tap/mcp-publisher"
  exit 1
fi

# Check for server.json
if [[ ! -f "$WORKER_DIR/server.json" ]]; then
  echo "❌ server.json not found in $WORKER_DIR"
  exit 1
fi

# Check for private key
if [[ ! -f "$KEYS_DIR/private-key-hex.txt" ]]; then
  echo "❌ Private key not found. Generate it first:"
  echo "   ./scripts/generate-registry-keys.sh"
  exit 1
fi

# Read private key (skip comment lines)
PRIVKEY_HEX=$(grep -v '^#' "$KEYS_DIR/private-key-hex.txt" | tr -d '[:space:]')

if [[ -z "$PRIVKEY_HEX" ]]; then
  echo "❌ Could not read private key from $KEYS_DIR/private-key-hex.txt"
  exit 1
fi

echo "📦 Publishing OrgX MCP to registry..."
echo ""

# Change to worker directory for relative paths
cd "$WORKER_DIR"

# Check if logged in, if not, login with HTTP verification
if ! mcp-publisher whoami &> /dev/null 2>&1; then
  echo "🔐 Logging in with HTTP domain verification..."
  mcp-publisher login http --domain=useorgx.com --private-key="$PRIVKEY_HEX"
fi

# Validate server.json
echo "✅ Validating server.json..."
mcp-publisher validate

# Publish (or dry-run)
if [[ -n "$DRY_RUN" ]]; then
  echo ""
  echo "🔍 Dry run - validating without publishing..."
  mcp-publisher publish --dry-run
  echo ""
  echo "✅ Validation passed! Run without --dry-run to publish."
else
  echo ""
  echo "🚀 Publishing to MCP Registry..."
  mcp-publisher publish
  echo ""
  echo "✅ Successfully published to MCP Registry!"
  echo ""
  echo "📍 Your server should now be discoverable at:"
  echo "   https://registry.modelcontextprotocol.io/?q=com.useorgx%2Forgx-mcp"
  echo ""
  echo "📝 Note: The registry may take a few minutes to update."
fi
