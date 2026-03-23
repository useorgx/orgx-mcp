#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/sync-to-orgx-monorepo.sh [--check] [--dry-run] [destination]

Mirror the canonical orgx-mcp worker into the vendored monorepo copy at
orgx/workers/orgx-mcp.

Defaults:
  destination: ../orgx-clean/orgx/workers/orgx-mcp
  override via ORGX_MONOREPO_WORKER_DIR

Notes:
  - README.md stays monorepo-local so the vendored copy can warn contributors.
  - .github/, .wrangler/, node_modules/, dist/, and local .dev.vars are excluded.
EOF
}

check_only=0
dry_run=0
destination_arg=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      check_only=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$destination_arg" ]]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      destination_arg="$1"
      ;;
  esac
  shift
done

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_destination="${source_root}/../orgx-clean/orgx/workers/orgx-mcp"
destination_root="${destination_arg:-${ORGX_MONOREPO_WORKER_DIR:-$default_destination}}"

if [[ ! -d "$source_root/.github" ]]; then
  echo "This script must be run from the canonical orgx-mcp repository." >&2
  exit 1
fi

if [[ ! -d "$destination_root" ]]; then
  echo "Destination does not exist: $destination_root" >&2
  exit 1
fi

if [[ ! -f "$destination_root/package.json" ]]; then
  echo "Destination does not look like the monorepo worker package: $destination_root" >&2
  exit 1
fi

if [[ "$source_root" == "$destination_root" ]]; then
  echo "Source and destination resolve to the same path." >&2
  exit 1
fi

rsync_args=(
  -r
  --checksum
  --delete
  --itemize-changes
  --perms
  --links
  --exclude=.git
  --exclude=.git/
  --exclude=.github/
  --exclude=.wrangler/
  --exclude=node_modules/
  --exclude=dist/
  --exclude=.dev.vars
  --exclude=README.md
)

if [[ $dry_run -eq 1 || $check_only -eq 1 ]]; then
  rsync_args+=(--dry-run)
fi

tmp_output="$(mktemp)"
trap 'rm -f "$tmp_output"' EXIT

if [[ $check_only -eq 1 ]]; then
  set +e
  diff -qr \
    --exclude=.git \
    --exclude=.github \
    --exclude=.wrangler \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=.dev.vars \
    --exclude=README.md \
    "$source_root" "$destination_root" >"$tmp_output"
  diff_status=$?
  set -e

  if [[ $diff_status -eq 0 ]]; then
    echo "Monorepo worker is in sync with canonical orgx-mcp."
    exit 0
  fi

  if [[ $diff_status -ne 1 ]]; then
    cat "$tmp_output" >&2
    exit "$diff_status"
  fi

  cat "$tmp_output" >&2
  if [[ -s "$tmp_output" ]]; then
    echo "Monorepo worker is out of sync with canonical orgx-mcp." >&2
    exit 1
  fi
fi

rsync "${rsync_args[@]}" "$source_root/" "$destination_root/" | tee "$tmp_output"

if [[ $dry_run -eq 1 ]]; then
  echo "Dry run complete."
  exit 0
fi

echo "Synced canonical orgx-mcp into: $destination_root"
