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

## Model and budget routing controls

When delegating to OrgX agents, let OrgX route by task complexity unless the
user, workspace policy, or verification plan intentionally constrains routing.

- Use `orgx_spawn` with `action: "estimate"` before dispatch when the user asks
  for a cost comparison, budget fit, or cheapest valid validation route.
- Omit `model_tier`, `provider`, and `model` for normal agent work so OrgX can
  auto-route.
- Add `max_cost_usd` when the user gives a daily or per-task cap.
- Add `provider` or `model` only when the user asks for a specific provider or
  a prior cost/quality comparison selected one.
- Use `model_tier: "standard"` and `budget_mode: "cheapest_valid"` for
  controlled reliability validation runs while the execution loop is being
  proven.
- Escalate or override routing only when the task, user instruction, policy, or
  validation evidence justifies it.
- Do not mark agent work complete with prose alone. Require an artifact,
  verification evidence, or a structured blocker.

Expected specialist receipts:

- Engineering: PR URL or blocker with repo, branch, command, and exact error.
- Sales: ICP, offer, target segment/list, sequence, objections, and send plan.
- Marketing: campaign asset, channel hypothesis, publish/review status.
- Product: PRD/decision/roadmap slice with measurable success criteria.
- Design: audit/spec/token/component artifact with validation notes.
- Operations: runbook, budget report, incident status, or reliability fix.

## Practical founder and team artifacts

All OrgX agents should shape output around the next useful company artifact,
not around generic analysis. Decide whether the user is an early founder, an
existing founder-led company, or an operating team, then return the artifact
that advances the business now:

- Orchestrator: next valuable initiative with owners, dependencies, and gates.
- Engineering: PR, deploy proof, technical blocker, or rollback-ready fix.
- Sales: sales strategy with ICP, offer, list/segment, sequence, objections,
  and send plan.
- Marketing: launch or campaign asset with channel hypothesis and review state.
- Product: customer discovery synthesis, PRD, pricing/packaging hypothesis, or
  decision record.
- Design: UX audit, component spec, accessibility finding, or design token
  package.
- Operations: weekly operator brief, runbook, budget/cost envelope, incident
  status, or reliability fix.

Cost controls are execution constraints, not an agent mindset. Use the
cheapest valid routing only for controlled reliability verification or explicit
budget pressure; otherwise let OrgX select the right route for the task.

For loop validation, close each rung with `orgx_submit_receipt` using
`loop_validation: true`, `validation_rung`, `artifact_type`, `agent_type`,
`business_outcome`, `verification_status`, `model_tier`, `budget_mode`, and
evidence. Only promote to the next rung when the returned
`loop_validation.promotable` value is true.

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
