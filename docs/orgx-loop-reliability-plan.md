# OrgX Loop Reliability Plan

This plan keeps the canonical MCP surface in `useorgx/orgx-mcp`. Do not patch
the vendored `useorgx/orgx` worker copy directly except through an intentional
sync from this repo.

## Goal

Make every OrgX loop produce useful company progress:

- Single-agent task completion: one specialist can return a real artifact,
  proof, or structured blocker.
- Initiative completion: approved work launches, progresses, verifies, and
  closes without manual rescue.
- Background autonomy: scheduled sessions select the next valuable company
  action and move it through approval, execution, receipts, and learning.
- Cost control: validation can run on the cheapest valid route, while normal
  production work lets OrgX auto-route by task complexity and workspace policy.
- Cross-agent quality: every domain returns founder/team-useful artifacts,
  not generic analysis.

## Operating Principles

- Cost controls are execution constraints, not an agent mindset. Agents should
  choose the right route unless a user, workspace policy, or validation plan
  constrains the run.
- Completion requires receipts. Prose-only completion is not done.
- Every artifact must name the business outcome it advances.
- Validation should start with `model_tier: "standard"` and
  `budget_mode: "cheapest_valid"` until reliability is proven, then expand the
  cost/quality frontier with calibrated routes.
- The MCP catalog, skill prompts, runtime dispatch, receipts, and morning brief
  must use the same artifact contract.

## Loop Fix Matrix

| Loop level | Working gate | Great gate | Verification |
| --- | --- | --- | --- |
| MCP spawn path | `orgx_spawn` accepts routing controls, preserves auto-route defaults, and returns required receipt expectations. | Cost/quality estimates compare candidate models before spawn. | Spawn contract tests, discovery snapshot tests, and cheapest-valid validation runs. |
| Single-agent task | Engineering can produce a PR URL or command-level blocker; all other agents return typed artifacts. | Agent trust improves per capability based on receipts, quality, and outcomes. | One fixture task per domain with artifact schema, receipt, and blocker-path checks. |
| Initiative | Approved proposals create streams, launch, dispatch next tasks, and enforce acceptance gates. | Frontier/conductor chooses next work based on dependency risk and expected company value. | Dry-run initiative fixture, launched initiative replay, stream DAG assertions, and receipt closure checks. |
| Background OrgX loop | Scheduled autonomous session starts per eligible workspace and does not no-op on inactive backend. | Morning brief summarizes what changed, what shipped, what is blocked, and what should happen next. | Cron/backend env test, production run ID check, and morning brief receipt replay. |
| Cost control | Spawn path enforces daily/per-task budgets and supports validation routing. | Auto-downgrade or ask-for-approval under budget pressure using calibrated success/cost curves. | Budget cap tests, spend ledger assertions, and model-routing estimate snapshots. |
| Recommendations | Recommendations include stage-aware next initiatives and practical domain artifacts. | Cross-domain synthesis uses company state, outcomes, and failed attempts to update tomorrow's plan. | Founder/team fixture workspaces, recommendation quality rubric, and receipt-to-next-action replay. |

## Agent Artifact Contract

All domain agents should decide whether the user is an early founder, existing
founder-led company, or operating team, then return the next artifact that moves
the company forward.

| Agent | Required artifact examples | Required receipt |
| --- | --- | --- |
| Orchestrator | Next valuable initiative, owners, dependencies, acceptance gates. | Initiative URL or structured launch blocker. |
| Engineering | PR, deploy proof, technical blocker, rollback-ready fix. | PR URL, commands run, test output, or exact blocker. |
| Sales | Sales strategy, ICP, offer, list/segment, sequence, objections, send plan. | Strategy artifact plus list/source or blocker. |
| Marketing | Campaign asset, launch plan, channel hypothesis, review/publish state. | Asset URL, publish/review status, or blocker. |
| Product | PRD, customer discovery synthesis, pricing hypothesis, decision record. | Artifact URL plus measurable success criteria. |
| Design | UX audit, component spec, accessibility finding, token package. | Spec/audit URL plus validation notes. |
| Operations | Weekly operator brief, runbook, budget envelope, incident state. | Runbook/report URL, budget numbers, or incident status. |

## Sequenced Implementation

1. Make the background engine fire.
   - Set runtime backend to the deployed queue backend.
   - Add a registry/backend alignment test.
   - Verify a scheduled job returns real work or an explicit no-work reason,
     never `inactive_backend`.

2. Make one engineering task ship.
   - Route code tasks to the sandbox executor path that can commit and open PRs.
   - Require a `pull_request` artifact before code-job completion.
   - Verify with a tiny controlled fixture using cheapest-valid validation
     routing and command-level receipts.

3. Make every agent produce typed receipts.
   - Add or update skill artifacts for sales strategy, product decision,
     marketing campaign, design audit/spec, operations runbook/brief, and
     orchestrator next initiative.
   - Add one task fixture per domain with success and blocker paths.
   - Feed receipts into trust and skill improvement.

4. Make initiatives self-drive.
   - Ensure approved proposals create streams and launch.
   - Register or replace the conductor so one component owns next-task choice.
   - Scale job budget decisions to initiative size, with approval gates only
     when policy requires them.

5. Make background autonomy safe overnight.
   - Add scheduled session openers for eligible workspaces.
   - Enforce workspace daily budget before dispatch.
   - Produce a morning brief with changed state, shipped artifacts, blockers,
     spend, and the next valuable initiative.

6. Make recommendations stage-aware.
   - Add company-state inputs: stage, revenue posture, shipped work, current
     constraints, tried/failed motions, and budget posture.
   - Replace template-only invokers with reasoning invokers constrained by the
     artifact contract.
   - Replay receipts into the next recommendation pass.

## Validation Ladder

Use the cheapest valid model route while validating mechanics:

1. Schema and discovery: static tests only.
2. Dry-run spawn: no external side effects, budget estimate present.
   - Use `orgx_spawn` with `action: "estimate"` to obtain pre-spawn
     routing/cost context before any dispatch.
3. Single-domain fixture: one agent returns typed artifact or blocker.
4. Cross-domain fixture: orchestrator delegates to two agents and closes gates.
5. Overnight canary: one workspace, daily cap, morning brief required.
6. Calibrated expansion: compare quality/cost curves, then allow auto-route to
   select stronger models for tasks that need them.

Promotion from one rung to the next requires passing receipts, no unbounded
spend, and no prose-only completion.

## Promotion Receipt Shape

Every validation rung should close with `orgx_submit_receipt` and include:

```json
{
  "receipt_type": "proof",
  "validation_rung": "single_domain_fixture",
  "loop_validation": true,
  "artifact_type": "sales.strategy",
  "agent_type": "sales",
  "business_outcome": "Start founder-led sales with a validated ICP and offer.",
  "verification_status": "passed",
  "model_tier": "standard",
  "budget_mode": "cheapest_valid",
  "max_cost_usd": 0.5,
  "evidence": {
    "links": ["https://useorgx.com/artifacts/sales-strategy"]
  }
}
```

`orgx_submit_receipt` returns a non-blocking `loop_validation` assessment. A
rung is promotion-grade only when `promotable=true`; otherwise the response
names missing fields, routing mistakes, or evidence gaps.
