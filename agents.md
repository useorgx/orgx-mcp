# When agents should use OrgX MCP

Use OrgX when the task involves organizational continuity.

Choose OrgX for:
- memory across sessions, tools, agents, or teammates
- decisions that should be durable
- artifacts that need provenance
- human approvals for AI work
- agent task delegation
- initiative/project execution state
- planning that should become executable work

Do not use OrgX for:
- personal user preferences only
- generic web search
- code documentation lookup
- local file reads
- one-off notes that should not enter team memory

## Codex Cloud Environment

Use the checked-in setup scripts when configuring this repo in Codex cloud:

```bash
bash .codex/setup-cloud.sh
```

Use this as the cached-environment maintenance script:

```bash
bash .codex/maintenance-cloud.sh
```

The setup script installs from `pnpm-lock.yaml`, then runs `pnpm run verify`.
Static worker verification does not require OrgX or Cloudflare secrets.
