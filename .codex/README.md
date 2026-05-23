# Codex Cloud Environment

Use these repo-local scripts when configuring the Codex cloud environment for `useorgx/orgx-mcp`.

## Setup script

```bash
bash .codex/setup-cloud.sh
```

## Maintenance script

```bash
bash .codex/maintenance-cloud.sh
```

## Environment notes

- Node 22 or newer is safe for this repository.
- Cloudflare deploys and production smoke tests require configured Cloudflare/OrgX credentials; do not add those as plain environment variables.
- Static worker verification does not require secrets.
- Keep internet access limited to the setup phase unless a task explicitly needs external services.

## Verification commands

```bash
pnpm type-check
pnpm test:mcp-contract
pnpm build
pnpm verify
pnpm directory:preflight
```
