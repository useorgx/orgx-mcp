# Anthropic Reviewer Runbook

This runbook is the human-facing guide for preparing and validating the OrgX review environment before or during Anthropic directory review.

## Scope

Use this when you need to:

- confirm the reviewer account is still healthy,
- restore the seeded review workspace to a deterministic baseline,
- verify which prompts and widgets Anthropic should see,
- support a reviewer who is blocked after auth or after the first tool call.

## Prerequisites

- The reviewer is signed in to the OrgX web app with the dedicated Anthropic review account.
- Production `orgx-mcp` is already deployed at `https://mcp.useorgx.com/`.
- The reviewer account has a dedicated workspace named `Anthropic Review Workspace`.

## Authenticated OrgX review routes

These routes live in the OrgX app, not the MCP worker. They operate only on the currently authenticated user's dedicated reviewer workspace.

- `GET https://useorgx.com/api/review/anthropic/status`
- `POST https://useorgx.com/api/review/anthropic/bootstrap`
- `POST https://useorgx.com/api/review/anthropic/reset`

## Operational flow

1. Sign in to `https://useorgx.com` as the dedicated Anthropic reviewer account.
2. Open `https://useorgx.com/api/review/anthropic/status` in the authenticated browser session.
3. Confirm:
   - `status.seed.baselineReady === true`
   - `status.seed.workspaceIsClean === true`
   - `status.seed.counts` matches the expected baseline
4. If the workspace is missing or drifted, run in the authenticated browser console:

```js
await fetch('/api/review/anthropic/bootstrap', { method: 'POST' }).then((res) =>
  res.json()
);
```

5. If the reviewer already changed data and you need a guaranteed clean baseline, run:

```js
await fetch('/api/review/anthropic/reset', { method: 'POST' }).then((res) =>
  res.json()
);
```

6. Re-open `https://useorgx.com/api/review/anthropic/status` and confirm the workspace is clean again.

## Baseline data

The seeded workspace should contain:

- 2 initiatives
- 3 workstreams
- 3 milestones
- 5 tasks
- 3 pending decisions

Key seeded initiative titles:

- `Search Copilot Readiness`
- `Workflow Capture Expansion`

Key seeded pending decisions:

- `Approve Search Copilot prompt pack`
- `Approve reviewer workspace reset policy`
- `Confirm widget parity sign-off threshold`

## Reviewer prompt matrix

Use these exact prompts during reviewer QA:

1. `Show me the pending decisions that need approval today.`
   - Expected: pending decisions list and the pending decisions widget
2. `Give me the pulse for the Search Copilot Readiness initiative.`
   - Expected: seeded initiative health and the initiative pulse widget
3. `Show me what the OrgX agents are doing right now.`
   - Expected: current agent roster and the agent status widget
4. `Search OrgX memory for workflow capture expansion.`
   - Expected: query results referencing the seeded workflow initiative
5. `Scaffold a launch initiative with two workstreams, one milestone each, and two tasks per milestone.`
   - Expected: created hierarchy and the scaffolded initiative widget

## Support notes

- `bootstrap` is safe to run repeatedly. If the workspace is already clean, it should be a no-op.
- `reset` is destructive for the dedicated reviewer workspace. It will wipe review data in that workspace before reseeding.
- If the reviewer can authenticate but widgets fail to mount, capture:
  - the exact prompt used
  - the browser console error
  - whether `status.seed.baselineReady` and `status.seed.workspaceIsClean` were true before the run
