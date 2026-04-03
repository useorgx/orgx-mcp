# Anthropic Release Manager Checklist

This is the final release and support checklist for OrgX MCP directory submission and follow-up review.

## Before deploy

Run from `Code/orgx-mcp`:

```bash
pnpm type-check
pnpm vitest run
pnpm build
pnpm directory:preflight
```

Run the OrgX-side reviewer support verification from the deployed app:

1. Sign in to `https://useorgx.com` as the dedicated Anthropic reviewer account.
2. Visit `https://useorgx.com/api/review/anthropic/status`.
3. If the workspace is missing or drifted, run `bootstrap` or `reset` per the reviewer runbook.

## After deploy

Run against the deployed worker:

```bash
MCP_BASE_URL=https://mcp.useorgx.com pnpm directory:preflight
```

Then verify the reviewer environment:

1. `GET /api/review/anthropic/status`
2. Confirm `baselineReady === true`
3. Confirm `workspaceIsClean === true`
4. Confirm the seeded counts still match the expected baseline

## Claude smoke

Use the reviewer account in Claude and run the prompt matrix from [docs/anthropic-reviewer-runbook.md](./anthropic-reviewer-runbook.md).

Capture evidence for:

- pending decisions widget mounted
- initiative pulse widget mounted
- agent status widget mounted
- scaffolded initiative widget mounted

## Submission package

Confirm all of the following are ready:

- reviewer credentials shared out of band
- callback URLs allowlisted
- privacy, support, and security docs reachable
- reviewer runbook linked in the internal handoff
- one support owner assigned during the review window

## During review

- Keep the reviewer account active.
- Do not repurpose the dedicated review workspace.
- If the reviewer mutates the workspace, use the authenticated `reset` route to restore baseline data before the next session.
