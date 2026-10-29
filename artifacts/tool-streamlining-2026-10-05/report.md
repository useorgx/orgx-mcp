# OrgX tool streamlining audit — 2026-10-05

OrgX presents overlapping choices to the model, and its guidance normalization currently treats several different operations as equivalent. The first repair should preserve request meaning; hiding duplicate names comes next.

This is a read-only architecture audit of shipped commit `e109306e183da3514fb5b5f13273bfff423873f4`. The title corrections in PR #461 were already merged and deployed. No tool behavior, visibility, grants, or production business records were changed during this inspection.

## Scope and evidence

- OpenAI portal: 27 listed tools. Source profile: 24 model-visible and 3 app-only tools.
- General v2 profile: 45 listed tools. Registry: 103 unique known contracts across all families. These counts describe different surfaces.
- Traced schemas, handler routing, guidance rewriting, authorization, widget calls, compatibility aliases, and catalog generation.
- Executed five deterministic guidance reproductions using synthetic IDs; no upstream requests or real decisions.
- Existing focused suite: 166 tests passed across 7 files. These passing tests do not cover the semantic losses reproduced here.
- Input-schema measurements below come from known source contracts, without injected client context or output schemas. They are bytes, not tokenizer measurements or observed latency.

## Confirmed defects in guidance normalization

The registration wrapper applies `sanitizeToolResultGuidance` to tool results. It rewrites continuation instructions, rather than changing the current tool call. Consequently, a model following a returned continuation can receive a materially different request.

| Priority | Original instruction | Actual normalized instruction | Consequence |
| --- | --- | --- | --- |
| P1 | `get_initiative_pulse(initiative_name="Search Copilot Readiness")` | `orgx_recommend(mode="next_action", entity_type="initiative")` | Removes the named target and replaces health/status with a priority recommendation. With an ID, the target survives but the operation still changes. |
| P1 | `get_morning_brief(workspace_id, session_id)` | `orgx_recommend(mode="morning_brief", period="30d", workspace_id, session_id)` | The target handler reads the operator chronicle and does not put session_id in that endpoint's query. The session-specific autonomous recap is replaced by a reporting window. |
| P2 | `approve_agent_work(action="list", limit=1, urgency_filter="critical")` | `orgx_decide(action="list_pending")` | Both filters disappear. The canonical advertised schema lacks those fields even though the underlying list handler supports them. |
| P2 | `recommend_next_action(agent_id, domain, canonical_only, limit)` | `orgx_recommend(mode="next_action", limit)` | Agent ownership/domain/canonical filters disappear. The canonical schema and forwarding handler also lack them. |

Evidence: `guidance-reproductions.json` and `reproduce-guidance.ts` beside this report. The output passes the canonical schema check because that check validates shape, not preservation of intent. Production occurrence and user impact frequency were not measured.

Source:
- [Guidance mappings and validation](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/toolGuidance.ts:78).
- [Wrapper applies normalization to registered handlers](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/toolResultRegistration.ts:53).
- [Canonical chronicle/recommendation routing](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/index.ts:5699).
- [Session-specific brief endpoint](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/index.ts:13654).
- [Chronicle query omits session_id](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/operatorChronicleFallback.ts:21).

The safe normalization rule is: preserve a visible tool when there is no proven equivalent; translate an alias only when scope, arguments, effect, authorization, and result semantics are preserved. If neither the original nor an equivalent is available, omit the unsafe continuation and explain the missing capability. Do not broaden its scope silently.

## Where exposure genuinely overlaps

| Family | Repeated choices | Actual relationship | Required migration |
| --- | --- | --- | --- |
| Decisions | orgx_decide, approve_agent_work, approve_decision, reject_decision | orgx_decide routes list/approve/reject through approve_agent_work. Legacy approval/rejection use another execution path and expose option_id. | Make orgx_decide carry list filters; account for legacy options, scopes, and error/result differences. Preserve human-session review and the separate widget click authority. Then retire the three narrower names from model discovery. |
| Delegation | orgx_spawn(action=handoff), handoff_task | Canonical spawn forwards to the same handoff backend. Shared dispatch budget, deadline, acceptance, and idempotency shape is already centralized. | Preserve reassignment without spawning (`spawn=false`) and custom agent targets. Those are advertised by handoff_task but not by orgx_spawn. Then retire handoff_task from model discovery. |
| Operator reporting | orgx_recommend(mode=morning_brief), get_operator_chronicle | Both read /api/operator/chronicle, with different presentation metadata. | Preserve legacy command-center scoping and the work-ledger widget refresh route. Expose one clearly named reporting operation to the model. |
| Lifecycle | orgx_act(pause/resume/cancel), manage_lifecycle | They reach different backend operations. manage_lifecycle coordinates descendant tasks and active runs; orgx_act executes entity actions. | Make execution controls route through the authoritative cascade operation, or sharply distinguish metadata/state edits from running-work control. Descriptions alone leave overlapping valid choices. Keep manage_lifecycle until parity is demonstrated. |
| Updates | orgx_act(action=update), orgx_write(operation=update) | Normal updates in orgx_act delegate to orgx_write; dry_run deliberately takes a different path. | Pick orgx_write as the primary entity-patch operation and retain compatible dry-run behavior before narrowing orgx_act. No need for another tool. |

Decision review is not decision resolution: orgx_decide and approve_agent_work return `needs_human` with a review URL. Legacy refusal is mapped to a human-action-required error. orgx_widget_decide is app-only and requires a widget approval token. Consolidation must retain that authority boundary.

Sources:
- [Decision routing](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/index.ts:6395).
- [Review/list implementation](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/index.ts:7082).
- [Human authority results](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/directHumanDecisionAction.ts:7).
- [Handoff fields](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/toolDefinitions.ts:956).
- [Spawn translation](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/spawnContract.ts:93).
- [Lifecycle endpoint](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/index.ts:3976).
- [orgx_act update delegation](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/index.ts:6055).

## Boundaries worth retaining

| Tools | Why they remain separate |
| --- | --- |
| orgx_bootstrap / orgx_search / orgx_inspect | Bind/orient the session, retrieve a collection, and hydrate one record. |
| orgx_plan / scaffold_initiative / orgx_write | Iterate a plan, create a nested owned hierarchy, and add or patch one record. Scaffold provides stable references and creation/launch behavior beyond a simple write. |
| orgx_attach / orgx_submit_receipt / orgx_act(complete_with_proof) | Store an artifact, record verification/provenance, and transition work through completion gates. An attached URL alone should not prove completion. |
| get_morning_brief / operator chronicle | Autonomous-session recap versus an operator reporting window. Rename or clarify their use cases; do not normalize one into the other. |
| get_initiative_pulse / orgx_recommend | Execution health and blockers versus ranked next work. |
| get_agent_status / orgx_command_status | Agent/run overview versus one asynchronous command's status. |
| review_artifact / orgx_inspect | Review queue, preview, versions, and human review affordances versus generic entity context. |
| check_execution_readiness / orgx_spawn(guard, estimate) | Workspace credentials versus per-task dispatch policy and budget. Prefer a shared internal readiness check where equivalent, but retain distinct results. |

The app-only tools orgx_widget_decide, orgx_panel_snapshot, and resume_agent_run are already hidden from the model. They are required UI operations, not three redundant model choices. The work-ledger widget currently calls get_operator_chronicle, so its callable route must remain even if its model exposure changes.

[Profile](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/toolProfiles.ts:94) and [widget contracts](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/widgetToolContract.ts:20) define these surfaces.

## Proposed model surface

A conditional migration target is **19 model-visible tools**, removing these five choices only after the gaps above are closed:

`approve_decision`, `reject_decision`, `approve_agent_work`, `handoff_task`, `get_operator_chronicle`.

That is 5 fewer choices (20.8%). Their current source descriptors contain 7,109 input-schema bytes and 3,080 description bytes. Current 24-tool source input schemas total 47,561 bytes. Canonical tools would gain some fields, so these figures are gross removable bytes, not net savings.

Retain the 19:
- Orientation: orgx_bootstrap, orgx_search, orgx_inspect.
- Priorities and status: orgx_recommend, get_agent_status, get_initiative_pulse, get_morning_brief, orgx_command_status.
- Planning: orgx_plan, scaffold_initiative.
- Records and proof: orgx_write, orgx_attach, orgx_submit_receipt.
- Execution: orgx_act, manage_lifecycle, orgx_spawn, check_execution_readiness.
- Human review: orgx_decide, review_artifact.

This is not a requirement to pack every operation into a universal router. orgx_act currently advertises 21 actions and orgx_write has 39 fields. Merging more functions into them can reduce name count while increasing ambiguity. Guard/classify/estimate previews also share orgx_spawn's state-changing annotation; inspect that tradeoff before adding more read operations to write routers.

## Registry and test gaps

Runtime inline registrations, known contracts, server.json, submission metadata, generated catalog entries, profiles, widget aliases, and guidance mappings all describe portions of the surface. Existing parity tests protect names, annotations, visibility, widget resources, and selected catalog fields, but do not prove semantic equivalence for guidance transformations.

A concrete input-validation difference remains: get_morning_brief's flywheel contract permits a string workspace_id, while the runtime registration requires a UUID. The inventory therefore should not be mistaken for the exact live schema payload.

Use existing registries and generators as the authority, reducing manually duplicated inline descriptors where possible. Extend parity coverage to runtime input constraints and per-action continuation meaning. The existing handler-alias pattern in deprecatedTools.ts is a good precedent: it explicitly requires argument, effect, auth, and result parity while retaining transport compatibility, and deliberately excludes decision approval/rejection.

[Existing handler alias policy](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/src/deprecatedTools.ts:106).

## Implementation order and acceptance

1. Repair guidance meaning before changing discovery. Add regression cases for both pulse name/ID, autonomous session briefs, approval filters, and agent recommendation filters. Verify preservation rather than merely validating the canonical output schema.
2. Close canonical input gaps and clarify operations. Normalize deprecated workspace aliases, preserve handoff-without-spawn, and define one authoritative execution-control route.
3. Hide the five redundant model choices in the ChatGPT profile while retaining compatibility registrations and UI-callable routes where needed. Update metadata, widget grants/refresh bindings, output schemas, and submission fixtures together.
4. Run typecheck, focused behavioral regressions, the surface/widget suite, and pnpm verify. Check installed-client discovery, current deployment SHA, and the OpenAI scan independently.
5. Submit the hosted MCP review appeal against the resulting deployed definitions and retain the portal receipt.

No discovery changes or behavioral fixes from this audit have been implemented. There is no measured production latency, call-frequency, or wrong-tool selection rate in this report.

Current OpenAI [annotation guidance](https://developers.openai.com/plugins/plugin-guidelines#correct-annotation) requires explicit booleans reflecting actual effects. Consolidation does not justify weakening hints or merging human authorization into a model-callable tool.

## Submission state

PR [#461](https://github.com/useorgx/orgx-mcp/pull/461) corrected three review titles, merged as e109306, and [production deployment](https://github.com/useorgx/orgx-mcp/actions/runs/37312770220) succeeded. CI passed 2,436 tests with 2 skipped. The new portal scan cleared all three name warnings. Eight tools still have a generic further-review hold, with earlier versions live:

manage_lifecycle, orgx_write, orgx_act, orgx_plan, orgx_spawn, orgx_decide, approve_agent_work, scaffold_initiative.

The generic hold does not identify duplication as its cause. The portal was rescanned; the manual review appeal has not been submitted. The appeal note was prepared before the user steered into this deeper inspection. Resolve or explicitly scope the confirmed semantic defects before asserting that the upgraded tool surface is fully streamlined.

Portal screenshot: [eight remaining review holds](/Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp/artifacts/openai-review-2026-10-05/portal-eight-review-holds.jpg).

Package publication 1.0.0 and MCP server manifest 1.1.5 are separate version states.

## Reproduction commands

Run from /Users/hopeatina/.codex/worktrees/openai-resubmission-audit/orgx-mcp:

```sh
pnpm exec tsx artifacts/tool-streamlining-2026-10-05/inventory.ts
pnpm exec tsx artifacts/tool-streamlining-2026-10-05/reproduce-guidance.ts
pnpm exec vitest run tests/toolGuidance.spec.ts tests/toolArgumentAliases.spec.ts tests/dispatchContractParity.spec.ts tests/surfaceContract.spec.ts tests/toolProfiles.compat.spec.ts tests/decisionToolsContract.spec.ts tests/reporting.mcp-tools.spec.ts
```

