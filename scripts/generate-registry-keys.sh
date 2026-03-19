#!/usr/bin/env bash
#
# generate-registry-keys.sh
# 
# Generates Ed25519 keypair for MCP Registry domain authentication.
# The public key is used for DNS TXT records or HTTP well-known endpoint.
# The private key is used with mcp-publisher CLI to sign registry submissions.
#
# Usage:
#   ./scripts/generate-registry-keys.sh
#
# Output:
#   - keys/mcp-registry.pem       - Private key (keep secure!)
#   - keys/mcp-registry.pub       - Public key for reference
#   - keys/dns-record.txt         - DNS TXT record format
#   - keys/http-well-known.txt    - HTTP well-known format
#   - keys/private-key-hex.txt    - Hex-encoded private key for mcp-publisher

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS_DIR="$SCRIPT_DIR/../keys"

# Create keys directory
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

echo "🔑 Generating Ed25519 keypair for MCP Registry..."

# Generate Ed25519 private key
openssl genpkey -algorithm Ed25519 -out "$KEYS_DIR/mcp-registry.pem"
chmod 600 "$KEYS_DIR/mcp-registry.pem"

# Extract public key in PEM format
openssl pkey -in "$KEYS_DIR/mcp-registry.pem" -pubout -out "$KEYS_DIR/mcp-registry.pub"

# Get raw 32-byte public key and base64 encode it
# Ed25519 public keys are 32 bytes; the DER format adds 12 bytes of header
PUBKEY_BASE64=$(openssl pkey -in "$KEYS_DIR/mcp-registry.pem" -pubout -outform DER | tail -c 32 | base64)

# Get private key in hex format for mcp-publisher
# Ed25519 private keys are 32 bytes; skip the 16-byte DER header
PRIVKEY_HEX=$(openssl pkey -in "$KEYS_DIR/mcp-registry.pem" -outform DER | tail -c 32 | xxd -p -c 64)

# Create DNS TXT record format
cat > "$KEYS_DIR/dns-record.txt" << EOF
# DNS TXT Record for MCP Registry Domain Verification
# Add this TXT record to useorgx.com:

useorgx.com. IN TXT "v=MCPv1; k=ed25519; p=$PUBKEY_BASE64"

# Or for Cloudflare/most DNS providers, just add:
# Type: TXT
# Name: @ (or useorgx.com)
# Content: v=MCPv1; k=ed25519; p=$PUBKEY_BASE64
EOF

# Create HTTP well-known format
cat > "$KEYS_DIR/http-well-known.txt" << EOF
v=MCPv1; k=ed25519; p=$PUBKEY_BASE64
EOF

# Save private key hex for mcp-publisher
cat > "$KEYS_DIR/private-key-hex.txt" << EOF
# Private key in hex format for mcp-publisher CLI
# Keep this SECURE - do not commit to version control!

$PRIVKEY_HEX
EOF
chmod 600 "$KEYS_DIR/private-key-hex.txt"

echo ""
echo "✅ Keys generated successfully!"
echo ""
echo "📁 Files created in $KEYS_DIR:"
echo "   - mcp-registry.pem      - Private key (PEM format)"
echo "   - mcp-registry.pub      - Public key (PEM format)"
echo "   - dns-record.txt        - DNS TXT record to add"
echo "   - http-well-known.txt   - Content for /.well-known/mcp-registry-auth"
echo "   - private-key-hex.txt   - Hex key for mcp-publisher"
echo ""
echo "🔐 Public Key (base64):"
echo "   $PUBKEY_BASE64"
echo ""
echo "📝 Next steps:"
echo ""
echo "   OPTION A: DNS Verification"
echo "   Add this TXT record to useorgx.com:"
echo "   v=MCPv1; k=ed25519; p=$PUBKEY_BASE64"
echo ""
echo "   OPTION B: HTTP Well-Known (recommended)"
echo "   Set the MCP_REGISTRY_PUBKEY Cloudflare secret:"
echo "   wrangler secret put MCP_REGISTRY_PUBKEY"
echo "   # Paste: $PUBKEY_BASE64"
echo ""
echo "   Then verify it works:"
echo "   curl https://mcp.useorgx.com/.well-known/mcp-registry-auth"
echo ""
echo "⚠️  IMPORTANT: Keep mcp-registry.pem and private-key-hex.txt SECURE!"
echo "   These files are already in .gitignore but double-check before committing."
