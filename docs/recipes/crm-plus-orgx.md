# CRM + OrgX: account changes with a why, an approval, and a receipt

Your MCP gives the agent a capability. OrgX remembers why it acted, who
approved it, what it produced, and what happens next.

CRM servers let an agent read and update accounts, contacts, and
opportunities. OrgX — organizational continuity for AI agents — adds why the
account decision was made, who approved it, and the receipts that prove what
changed. The outcome: Make AI work resumable, reviewable, and provable
across agents.

## The problem this pairing solves

An agent changes an account's tier, closes an opportunity, or rewrites a
renewal plan. The CRM faithfully records the new value — and nothing else.
A quarter later, a rev-ops teammate (or their agent) asks "why is Acme on
the enterprise tier, and who signed off on the discount?" The CRM shows the
state; the judgment, the approval, and the alternatives considered are gone.

## The continuity gap without OrgX

The task outlives the chat. CRM fields hold *what*; the *why*, the approval,
and the follow-up owner lived in the conversation that ended. The next agent
either guesses, re-opens a settled negotiation internally, or pings the
account owner to be re-briefed. OrgX lets the next agent continue from the
decisions, artifacts, approvals, owners, and proof the last agent left
behind.

## Wiring

Connect your CRM server per its own docs. For OrgX:

```bash
npx -y @useorgx/wizard setup
```

or connect the remote MCP URL: `https://mcp.useorgx.com/mcp`. Per-client
detail: [`llms-install.md`](../../llms-install.md).

## Worked example

**Session 1 — Claude Code.** The user asks the agent to move Acme Corp to
the enterprise tier with a 15% first-year discount.

1. `orgx_bootstrap` — establish session context.
2. `orgx_decide` — record the account decision and route it for approval
   before touching the CRM:
   ```json
   {
     "action": "create",
     "title": "Acme Corp: enterprise tier at 15% first-year discount",
     "decision": "Move Acme Corp to enterprise tier with a 15% first-year discount, renewing at list.",
     "context": "Acme tripled seat usage in Q2 and asked for SSO and audit logs; 15% matches the concession band for 3-year commitments."
   }
   ```
3. The account executive approves it:
   ```json
   {
     "action": "approve",
     "decision_id": "<decision uuid>",
     "note": "Approved. Discount is within band; confirm the 3-year term in the order form."
   }
   ```
4. Apply the change in the CRM with the CRM server's tools (update the
   account tier and opportunity terms).
5. `orgx_submit_receipt` — prove what changed and anchor it to the decision:
   ```json
   {
     "receipt_type": "outcome",
     "summary": "Acme Corp moved to enterprise tier at 15% first-year discount after approval.",
     "entity_type": "decision",
     "entity_id": "<decision uuid>",
     "evidence": {
       "links": ["https://crm.example.com/accounts/acme-corp"],
       "notes": "Tier and opportunity updated after AE approval; order form to reference the 3-year term."
     }
   }
   ```

The session ends.

**Session 2 — a different client, next quarter.** Rev-ops asks their agent:
"Why is Acme on enterprise pricing, and who approved the discount?"

1. `orgx_bootstrap`
2. `orgx_search` — `{ "query": "Acme enterprise discount", "type": "decision" }`
3. `orgx_inspect` — hydrate the decision: the rationale, the approval with
   the approver's note, and the receipt linking to the CRM record.

The answer arrives with provenance instead of archaeology — and the settled
discount is not relitigated.

## Validation: run the Agent Amnesia Test

The validation step for this recipe is literally the
[Agent Amnesia Test](../benchmarks/agent-amnesia-test/README.md): run the
workflow above as Session 1 in one client and Session 2 in another, and score
the five recovery dimensions (decision, provenance, owner, artifact, next
action) as x/5. A 5/5 run earns the
[Continuity Verified badge](../continuity/continuity-verified.md), which
links to the evidence run.
