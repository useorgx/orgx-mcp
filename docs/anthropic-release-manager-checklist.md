# Anthropic Release Manager Checklist

This is the final release and support checklist for OrgX MCP directory submission and follow-up review.

## Before deploy

Run from `Code/orgx-mcp`:

```bash
pnpm type-check
pnpm screenshots:anthropic
pnpm test:anthropic-review
pnpm build
pnpm directory:preflight
```

Run the OrgX-side reviewer support verification from the deployed app:

1. Sign in to `https://useorgx.com` as the dedicated Anthropic reviewer account.
2. Visit `https://useorgx.com/api/review/sessions/<token>/status`.
3. If the workspace is missing or drifted, run `bootstrap` or `reset` per the reviewer runbook.

## After deploy

Run against the deployed worker:

```bash
MCP_BASE_URL=https://mcp.useorgx.com pnpm directory:preflight
```

Then verify the reviewer environment:

1. `GET /api/review/sessions/<token>/status`
2. Confirm `baselineReady === true`
3. Confirm `workspaceIsClean === true`
4. Confirm the seeded counts still match the expected baseline
5. Connect to `https://mcp.useorgx.com/mcp?profile=claude-directory`
6. Confirm `tools/list` exposes exactly the eight documented read-only tools
7. Confirm `prompts/list` is empty and `resources/list` exposes only the four
   selected read-only widget families
8. Confirm an invalid-Origin POST returns `403`, trusted Claude Origin receives
   `Access-Control-Allow-Origin: https://claude.ai`, and no-Origin CLI traffic
   reaches the normal OAuth challenge

## Claude smoke

Use the reviewer account in Claude and run the read-only prompt matrix from
[docs/anthropic-reviewer-runbook.md](./anthropic-reviewer-runbook.md).

Capture evidence for:

- workspace bootstrap returned without mutation
- memory search results returned
- initiative pulse widget mounted
- agent status widget mounted
- morning brief widget mounted
- operator chronicle returned proof context
- each of the four response screenshots matches its paired prompt:
  - `anthropic-memory-search-response.png` — `What did we decide about Search Copilot readiness?`
  - `anthropic-agent-status-response.png` — `Show me what the OrgX agents are doing right now.`
  - `anthropic-initiative-pulse-response.png` — `Give me the pulse for the Search Copilot Readiness initiative.`
  - `anthropic-morning-brief-response.png` — `Give me today's morning brief.`

## Submission package

Confirm all of the following are ready:

- reviewer credentials shared out of band
- hosted Claude and random-port Claude Code OAuth callbacks verified with fresh evidence
- protected MCP request returned `401` with `WWW-Authenticate`
- PKCE `S256` and Dynamic Client Registration verified
- privacy, support, and security docs reachable
- reviewer runbook linked in the internal handoff
- one support owner assigned during the review window
- directory scan contains no write-capable or mixed-mode tools
- directory scan contains no mutation prompts, skill packs, or unrelated widgets
- HTTPS Origin validation receipt captured for invalid, trusted, and no-Origin requests
- four response-only PNGs are deployed, return `200`, and are at least 1000 px on both axes

## During review

- Keep the reviewer account active.
- Do not repurpose the dedicated review workspace.
- If the reviewer mutates the workspace, use the authenticated `reset` route to restore baseline data before the next session.
