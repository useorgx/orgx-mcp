#!/usr/bin/env bash
#
# release.sh
#
# Creates a new release for the MCP worker.
# Updates version in server.json and package.json, commits, and creates a git tag.
#
# Usage:
#   ./scripts/release.sh <version>
#   ./scripts/release.sh patch|minor|major
#
# Examples:
#   ./scripts/release.sh 1.0.0        # Set specific version
#   ./scripts/release.sh patch        # 1.0.0 -> 1.0.1
#   ./scripts/release.sh minor        # 1.0.0 -> 1.1.0
#   ./scripts/release.sh major        # 1.0.0 -> 2.0.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

die() { echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
info() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }

# Get current version from server.json
get_current_version() {
  jq -r '.version' "$WORKER_DIR/server.json"
}

# Increment version
increment_version() {
  local version=$1
  local bump=$2
  
  IFS='.' read -ra parts <<< "$version"
  local major="${parts[0]}"
  local minor="${parts[1]}"
  local patch="${parts[2]}"
  
  case "$bump" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *) die "Invalid bump type: $bump" ;;
  esac
}

# Validate version format
validate_version() {
  local version=$1
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "Invalid version format: $version (expected X.Y.Z)"
  fi
}

# Main
main() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <version|patch|minor|major>"
    echo ""
    echo "Current version: $(get_current_version)"
    exit 1
  fi

  local input=$1
  local current_version
  current_version=$(get_current_version)
  
  info "📦 Current version: $current_version"
  
  # Determine new version
  local new_version
  case "$input" in
    patch|minor|major)
      new_version=$(increment_version "$current_version" "$input")
      ;;
    *)
      new_version="$input"
      ;;
  esac
  
  validate_version "$new_version"
  
  if [[ "$new_version" == "$current_version" ]]; then
    die "New version ($new_version) is the same as current version"
  fi
  
  info "🚀 Releasing version: $new_version"
  
  # Check for uncommitted changes
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "⚠️  You have uncommitted changes. They will be included in the release commit."
    read -p "Continue? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      die "Aborted"
    fi
  fi
  
  # Update server.json
  info "📝 Updating server.json..."
  jq --arg v "$new_version" '.version = $v' "$WORKER_DIR/server.json" > tmp.json
  mv tmp.json "$WORKER_DIR/server.json"
  
  # Update package.json
  info "📝 Updating package.json..."
  jq --arg v "$new_version" '.version = $v' "$WORKER_DIR/package.json" > tmp.json
  mv tmp.json "$WORKER_DIR/package.json"
  
  # Create commit
  info "📝 Creating commit..."
  git add "$WORKER_DIR/server.json" "$WORKER_DIR/package.json"
  git commit -m "chore(mcp): release v$new_version"
  
  # Create tag
  local tag="mcp-v$new_version"
  info "🏷️  Creating tag: $tag"
  git tag -a "$tag" -m "OrgX MCP Server v$new_version"
  
  info ""
  info "✅ Release prepared!"
  info ""
  info "Next steps:"
  info "  1. Review the changes:"
  info "     git show HEAD"
  info "     git show $tag"
  info ""
  info "  2. Push to trigger deployment:"
  info "     git push && git push origin $tag"
  info ""
  info "  3. Create GitHub Release:"
  info "     gh release create $tag --generate-notes --title \"OrgX MCP v$new_version\""
  info ""
  info "The GitHub Action will:"
  info "  - Deploy to Cloudflare Workers"
  info "  - Publish to MCP Registry"
  info "  - Update release notes"
}

main "$@"
