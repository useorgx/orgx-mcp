# Browser automation + OrgX: web actions that leave a trail

Your MCP gives the agent a capability. OrgX remembers why it acted, who
approved it, what it produced, and what happens next.

Browser-automation servers let an agent act on the live web: fill forms,
work admin consoles, complete portal workflows. OrgX — organizational
continuity for AI agents — adds the record of what was done, the evidence
artifacts, the owner, and the next action. The outcome: Make AI work
resumable, reviewable, and provable across agents.

## The problem this pairing solves

Web actions are the most ephemeral thing an agent does. The browser session
closes, the portal shows only its own partial state, and the only complete
account of what happened was the conversation. When someone asks "did we
finish the vendor questionnaire, and who's handling the follow-up?", nobody
— human or agent — can answer from the systems that remain.

## The continuity gap without OrgX

The task outlives the chat. The form was submitted, but the confirmation
number, the screenshot, the fields that were left pending, and who owns the
follow-up all evaporate with the session. The next agent either redoes the
workflow (sometimes dangerously — double submissions are real) or gives up.
OrgX lets the next agent continue from the decisions, artifacts, approvals,
owners, and proof the last agent left behind.

## Wiring

Connect your browser-automation server per its own docs. For OrgX:

```bash
npx -y @useorgx/wizard setup
```

or connect the remote MCP URL: `https://mcp.useorgx.com/mcp`. Per-client
detail: [`llms-install.md`](../../llms-install.md).

## Worked example

**Session 1 — Claude Code.** The user asks the agent to complete a vendor
security questionnaire in a web portal.

1. `orgx_bootstrap` — establish session context.
2. Drive the portal with the browser server's tools; capture a screenshot of
   the submission confirmation and note the two questions that require legal
   review.
3. `orgx_attach` — attach the evidence, with the owner of the follow-up:
   ```json
   {
     "type": "task",
     "id": "<task uuid>",
     "name": "Vendor questionnaire submission confirmation",
     "artifact_type": "compliance.evidence",
     "external_url": "https://portal.vendor.example/submissions/8841",
     "description": "Submitted 34 of 36 answers. Q17 and Q22 flagged for legal review before final attestation.",
     "owner": "legal-team",
     "review_date": "2026-07-14"
   }
   ```
4. `orgx_submit_receipt` — record what was actually done:
   ```json
   {
     "receipt_type": "proof",
     "summary": "Submitted vendor security questionnaire (34/36 answers); Q17 and Q22 pending legal review.",
     "entity_type": "task",
     "entity_id": "<task uuid>",
     "evidence": {
       "links": ["https://portal.vendor.example/submissions/8841"],
       "notes": "Confirmation number VQ-8841. Screenshot attached as artifact."
     }
   }
   ```

The session ends. Nothing depends on the browser session or the chat
surviving.

**Session 2 — a different client, next week.** Someone asks their agent:
"Where did the vendor questionnaire land?"

1. `orgx_bootstrap`
2. `orgx_search` — `{ "query": "vendor questionnaire" }`
3. `orgx_inspect` — hydrate the task: what was done, the confirmation link
   and screenshot, the owner (legal-team), and the next action (review Q17
   and Q22 before the July 14 attestation).

No portal re-login, no double submission, no re-briefing.

## Validation: run the Agent Amnesia Test

The validation step for this recipe is literally the
[Agent Amnesia Test](../benchmarks/agent-amnesia-test/README.md): run the
workflow above as Session 1 in one client and Session 2 in another, and score
the five recovery dimensions (decision, provenance, owner, artifact, next
action) as x/5. A 5/5 run earns the
[Continuity Verified badge](../continuity/continuity-verified.md), which
links to the evidence run.
