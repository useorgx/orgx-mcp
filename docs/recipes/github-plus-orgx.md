# GitHub + OrgX: pull requests with provenance

Your MCP gives the agent a capability. OrgX remembers why it acted, who
approved it, what it produced, and what happens next.

GitHub tooling lets an agent open PRs, review diffs, and file issues. OrgX —
organizational continuity for AI agents — adds decision provenance,
`consolidate_pr` review receipts, and approval state. The outcome: Make AI
work resumable, reviewable, and provable across agents.

## The problem this pairing solves

An agent ships a PR today. Three weeks later a different agent — or a
teammate's agent, in a different client — is asked to extend that work. The
PR exists on GitHub, but the decision that shaped it, the alternatives that
were rejected, who approved the approach, and what was supposed to happen
next all lived in a chat that no longer exists.

## The continuity gap without OrgX

The task outlives the chat. GitHub keeps the diff; the *why* dies with the
session. The next agent re-derives the approach, sometimes relitigating a
decision a human already made. OrgX lets the next agent continue from the
decisions, artifacts, approvals, owners, and proof the last agent left
behind.

## Wiring

Connect both servers in the same client (see the GitHub server's own docs for
its setup). For OrgX:

```bash
npx -y @useorgx/wizard setup
```

or connect the remote MCP URL: `https://mcp.useorgx.com/mcp`. Per-client
detail: [`llms-install.md`](../../llms-install.md).

## Worked example

**Session 1 — Claude Code.** The user asks for rate limiting on the public
API.

1. `orgx_bootstrap` — establish session context.
2. `orgx_decide` — record the decision before implementing:
   ```json
   {
     "action": "create",
     "title": "Public API rate limiting approach",
     "decision": "Use sliding-window rate limiting at the edge.",
     "context": "Fixed-window allowed 2x burst at window boundaries in load tests; sliding-window held p95 flat."
   }
   ```
3. Implement and open the PR with the GitHub server's tools.
4. `consolidate_pr` — persist a durable review receipt for the PR:
   ```json
   {
     "pr_url": "https://github.com/acme/api/pull/142",
     "decision_id": "<decision uuid from step 2>"
   }
   ```
   This produces an `orchestration.consolidation_pass` artifact with reading
   order, existence evidence, deduped findings, and a verdict — attached to
   the decision.
5. `orgx_submit_receipt` — close the loop with proof:
   ```json
   {
     "receipt_type": "proof",
     "summary": "Merged PR #142 adds sliding-window rate limiting to the public API.",
     "entity_type": "decision",
     "entity_id": "<decision uuid>",
     "evidence": { "prs": ["https://github.com/acme/api/pull/142"] }
   }
   ```

The session ends.

**Session 2 — Cursor, days later.** A different agent is asked to extend
rate limiting to the partner API.

1. `orgx_bootstrap`
2. `orgx_search` — `{ "query": "rate limiting", "type": "decision" }`
3. `orgx_inspect` — `{ "type": "decision", "id": "<decision uuid>" }`

The second agent gets the decision, the rationale, the approval state, the
consolidation receipt, and the PR link — without anyone re-briefing it, and
without relitigating sliding-window vs fixed-window.

## Validation: run the Agent Amnesia Test

The validation step for this recipe is literally the
[Agent Amnesia Test](../benchmarks/agent-amnesia-test/README.md): run the
protocol above as Session 1 in one client and Session 2 in another, and score
the five recovery dimensions (decision, provenance, owner, artifact, next
action) as x/5. A 5/5 run earns the
[Continuity Verified badge](../continuity/continuity-verified.md), which
links to the evidence run.
