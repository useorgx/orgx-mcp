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
- Production `orgx-mcp` is already deployed at `https://mcp.useorgx.com/mcp`.
- The directory connection uses
  `https://mcp.useorgx.com/mcp?profile=claude-directory`.
- The connection advertises no prompts or skill packs, and only the eight widget families needed by the selected workflows.
- The reviewer account has a dedicated workspace marked `reviewer_only: true` (currently `Anthropic Reviewer Demo`).
- Confirm all data accessible to the reviewer identity is safe to share. A
  `reviewer_only` workspace does not restrict the account's other workspaces, and
  the directory URL does not provide workspace isolation.
- Bootstrap the exact reviewer workspace and read back its seeded initiatives.
  Directory bootstrap requires the existing owner-scoped primary workspace read;
  inaccessible workspaces return `404`, upstream failures return `503`, and the
  previous binding remains intact. A generic readiness message or empty search
  alone is insufficient evidence of reviewer access.

Before review, request `https://mcp.useorgx.com/healthz?check=upstream` and
confirm the primary upstream is healthy at `https://useorgx.com`. A
`fallback_healthy` result proves failover, not reviewer-ready primary latency;
fix or deploy the primary configuration before submitting.

## Authenticated OrgX review routes

These routes live in the OrgX app, not the MCP worker. They operate only on the currently authenticated user's dedicated reviewer workspace.

- `GET https://useorgx.com/api/review/sessions/<token>/status`
- `POST https://useorgx.com/api/review/sessions/<token>/bootstrap`
- `POST https://useorgx.com/api/review/sessions/<token>/reset`

## Operational flow

1. Sign in to `https://useorgx.com` as the dedicated Anthropic reviewer account.
2. Open `https://useorgx.com/api/review/sessions/<token>/status` in the authenticated browser session.
3. Confirm:
   - `status.seed.baselineReady === true`
   - `status.seed.workspaceIsClean === true`
   - `status.seed.counts` matches the expected baseline
4. If the workspace is missing or drifted, run in the authenticated browser console:

```js
await fetch('/api/review/sessions/<token>/bootstrap', { method: 'POST' }).then((res) =>
  res.json()
);
```

5. If the reviewer already changed data and you need a guaranteed clean baseline, run:

```js
await fetch('/api/review/sessions/<token>/reset', { method: 'POST' }).then((res) =>
  res.json()
);
```

6. Re-open `https://useorgx.com/api/review/sessions/<token>/status` and confirm the workspace is clean again.

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
   - Expected: pending decision list; opening review yields a human URL and cannot settle the decision
2. `What did we decide about Search Copilot readiness?`
   - Expected: memory search results with prior decision context
3. `Give me the pulse for the Search Copilot Readiness initiative.`
   - Expected: seeded initiative health and the initiative pulse widget
4. `Show me what the OrgX agents are doing right now.`
   - Expected: current agent roster and the agent status widget
5. `Search OrgX memory for workflow capture expansion.`
   - Expected: query results referencing the seeded workflow initiative
6. `Give me today's morning brief.`
   - Expected: morning brief with current decisions, risks, and initiatives
7. `Show me the operator chronicle for Search Copilot Readiness.`
   - Expected: read-only proof context across decisions, artifacts, and activity
8. `Inspect the Search Copilot Readiness initiative.`
   - Expected: current entity details without changing state
9. `Create a uniquely named reviewer task, update its description, and read it back.`
   - Expected: creation and patch use separate operations with durable IDs
10. `Start a reviewer plan, retrieve it, record an edit, and complete the final plan.`
   - Expected: plan content and lifecycle persist under the reviewer workspace
11. `Check execution readiness and estimate engineering delegation without starting work.`
   - Expected: execution prerequisites and routing/cost context with no dispatched run
12. `Record a reviewer decision and open its human review.`
   - Expected: durable decision plus review URL; MCP does not approve it
13. `Attach the verification URL to the test task, submit a receipt twice with the same key, and complete it with proof.`
   - Expected: linked artifact, one idempotent receipt, completion with evidence

## Response screenshot evidence

Response screenshots are pending authenticated post-deploy capture. Use the
exact prompt matrix above in Claude after connecting the deployed directory
profile, then capture 3–5 real PNG responses that are at least 1000 px wide,
cropped to the Claude app response only, and paired with the exact prompt text.
Do not use synthetic fixtures, local renders, video, or GIF as directory evidence.
Use disposable reviewer work for writes. A delegation estimate does not prove
a dispatched run; get an explicit spend cap before paid execution.

## Support notes

- `bootstrap` is safe to run repeatedly. If the workspace is already clean, it should be a no-op.
- `reset` is destructive for the dedicated reviewer workspace. It will wipe review data in that workspace before reseeding.
- The submitted profile has separate read, append, update, and execution
  operations. Verify scopes at discovery and invocation. Four informational
  operations record metered usage and advertise `readOnlyHint: false`.
- Decision approval/rejection requires the human OrgX review session. Never
  treat an opened review URL as an approved decision.
- Do not reset the workspace as routine cleanup; reset removes reviewer data.
  Preserve current evidence and use a separate authorized fixture operation.
- MCP transport requests with a present browser `Origin` are exact-allowlisted
  before auth or dispatch. An invalid origin must return `403`; Claude Code and
  other CLI clients that omit `Origin` remain supported.
- If the reviewer can authenticate but widgets fail to mount, capture:
  - the exact prompt used
  - the browser console error
  - whether `status.seed.baselineReady` and `status.seed.workspaceIsClean` were true before the run
