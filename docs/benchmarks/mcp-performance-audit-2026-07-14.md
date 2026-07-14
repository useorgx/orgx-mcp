# OrgX MCP performance audit — 2026-07-14

## Outcome

The production MCP worker has 76 catalogued tools. Twenty catalog tools had
durable production samples in the seven-day audit window; 56 had no traffic and
therefore cannot honestly be assigned a production latency percentile yet.
Two additional legacy transport names appeared only as failed telemetry rows.

The sampled tool calls were generally within the existing 1.5 s read / 5 s
write budgets, but the tail is too close to the read budget and three concrete
paths were slow:

1. `scaffold_initiative` spent nearly all of its time creating entities.
2. Status/pulse/brief tools fetched artifact proof serially per initiative.
3. Every MCP request resolved OAuth identity and billing tier before applying a
   rate limit, even when the request was well inside the free allowance.

The local patch removes those serial or redundant waits and adds stage timings
to the durable invocation ledger. It has not been deployed by this audit.

## Sources and method

- Inventory: `docs/generated/tool-catalog.json`, generated 2026-07-10.
- Production tool latency: `agent_tool_invocations`, source `mcp_worker`, from
  2026-07-07 00:00 UTC through the audit run on 2026-07-14.
- Scaffold stages: existing timing fields in durable invocation metadata.
- Edge/runtime behavior: production Cloudflare tail plus source inspection.
- Public unauthenticated baseline: `pnpm benchmark:mcp`, 10 requests/scenario.
- Percentiles use nearest-rank over recorded `latency_ms` values. Small-sample
  percentiles should be read as individual observations, not stable estimates.

PostHog did not contain MCP invocation events, and the production worker does
not currently have `POSTHOG_KEY` configured. The durable invocation ledger was
therefore the authoritative metric source. The patch keeps that source and adds
the missing edge-stage fields.

## Seven-day production result

Overall: 455 completed rows, 22 recorded names, 16 errors, p50 120 ms, p95
1,239 ms, p99 1,986 ms. Four errors belong to legacy transport names with zero
recorded latency; the catalogue coverage is 20 of 76 tools (26.3%).

| Tool | n | p50 ms | p95 ms | p99 ms | errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| `scaffold_initiative` | 1 | 4,072 | 4,072 | 4,072 | 0 |
| `track_project_progress` | 9 | 898 | 1,986 | 1,986 | 0 |
| `get_morning_brief` | 4 | 34 | 1,644 | 1,644 | 0 |
| `orgx_decide` | 6 | 29 | 1,397 | 1,397 | 1 |
| `recommend_next_action` | 12 | 42 | 1,336 | 1,336 | 0 |
| `query_org_memory` | 49 | 114 | 1,319 | 2,329 | 2 |
| `orgx_bootstrap` | 33 | 129 | 1,298 | 1,452 | 4 |
| `orgx_recommend` | 24 | 126 | 1,287 | 1,308 | 0 |
| `get_agent_status` | 42 | 53 | 1,239 | 2,178 | 1 |
| `orgx_plan` | 12 | 122 | 1,182 | 1,182 | 0 |
| `spawn_agent_task` | 4 | 42 | 1,150 | 1,150 | 0 |
| `orgx_search` | 86 | 115 | 985 | 2,216 | 1 |
| `get_initiative_pulse` | 82 | 121 | 970 | 1,630 | 3 |
| `orgx_inspect` | 72 | 122 | 920 | 1,189 | 0 |
| `handoff_task` | 4 | 62 | 850 | 850 | 0 |
| `approve_agent_work` | 6 | 40 | 175 | 175 | 0 |
| `delegate_agent_task` | 1 | 135 | 135 | 135 | 0 |
| `review_artifact` | 2 | 40 | 120 | 120 | 0 |
| `get_operator_chronicle` | 1 | 28 | 28 | 28 | 0 |
| `recall_memory` | 1 | 18 | 18 | 18 | 0 |
| `mcp_orgx` (legacy transport name) | 3 | 0 | 0 | 0 | 3 |
| `mcp_useorgx_orgx_mcp` (legacy transport name) | 1 | 0 | 0 | 0 | 1 |

### Cold/idle correlation

The first call after more than 30 minutes idle had p50 142 ms and p95 1,250
ms. Calls within 60 seconds of the prior invocation had p50 97 ms and p95 1,148
ms. The sample supports a cold/idle contribution, but the new stage fields are
required to distinguish edge preflight, rate-limit backend, and tool/origin
time on subsequent audits.

### Scaffold stages

The most recent four-entity scaffold took 4,072 ms: 358 ms billing precheck and
3,714 ms entity creation. Historical successful runs show the same shape:

| requested | created | billing ms | entity create ms | total ms |
| ---: | ---: | ---: | ---: | ---: |
| 23 | 23 | 1,081 | 7,145 | 8,226 |
| 21 | 21 | 530 | 21,807 | 22,337 |
| 31 | 26 | 1,022 | 16,690 | 17,712 |
| 11 | 11 | 499 | 5,472 | 6,790 |
| 38 | 38 | 997 | 10,064 | 11,061 |

Source inspection found a pre-create idempotency search for every entity. The
core `/api/entities` create route already performs initiative idempotency replay
and scoped hierarchy deduplication, so the MCP search duplicated one or two
origin reads before every create.

## Fixes applied locally

### All 76 tools: lazy rate-limit plan resolution

The common edge path now applies a 100-request base allowance using only the
token hash/IP bucket. OAuth unwrap and billing usage lookup occur only after
that allowance is exhausted. Pro accounts then receive a 900-request paid
bucket (preserving the existing total of 1,000/hour); enterprise accounts
bypass after the base bucket. Focused tests prove zero OAuth and billing calls
on the normal path and preserve concurrent lookup deduplication beyond it.

Every decision now emits sanitized `Server-Timing` values for total edge rate
limit, backend, identity, and billing durations plus a strategy label. The MCP
transport copies those fields into PostHog when enabled and the durable
`agent_tool_invocations.metadata` payload.

### Status, pulse, progress, and brief paths

Artifact proof reads now execute in bounded groups of eight instead of
serially. This directly addresses `get_agent_status`,
`get_initiative_pulse`, `track_project_progress`, and `get_morning_brief`.

### Inspect path

`orgx_inspect` now fetches the entity record and its independent context pack
concurrently.

### Scaffold path

`scaffold_initiative` no longer runs the redundant MCP pre-create lookup. Retry
safety remains in the core create API, and generic `batch_create_entities`
keeps its broader client-side replay lookup for non-hierarchy payloads.

## Current public baseline

The 2026-07-14 live public benchmark passed all 30 requests:

| Scenario | p50 ms | p95 ms | success |
| --- | ---: | ---: | ---: |
| `/health` | 39 | 375 | 100% |
| `/server.json` | 45 | 61 | 100% |
| unauthenticated `tools/list` | 47 | 73 | 100% |

The detailed samples are in `docs/benchmarks/mcp-performance-latest.json`.
These scenarios prove public edge health only; they do not replace authenticated
per-tool measurements.

## Transport observation

Two connector calls made during the audit stalled for more than 70 seconds.
Cloudflare tail showed root content negotiation, OAuth unwrap, and stream/session
setup, but no completed tool invocation for those attempts. That means the
delay cannot be assigned to `query_org_memory` or `get_agent_status` execution.
It is tracked separately as a client/session transport issue; the durable tool
ledger correctly has no false tool-duration row for it.

## Unobserved catalogue paths

These 56 tools had no production invocation row in the audit window. The common
rate-limit fix and new stage instrumentation cover them structurally, but they
need real traffic before per-tool SLO claims can be made.

- **Billing (3):** `account_status`, `account_upgrade`, `account_usage_report`
- **Client Integration (7):** `check_spawn_guard`, `classify_task_model`, `consolidate_pr`, `orgx_apply_changeset`, `orgx_emit_activity`, `record_quality_score`, `sync_client_state`
- **Decisions (4):** `approve_decision`, `get_decision_history`, `get_pending_decisions`, `reject_decision`
- **Entity Management (10):** `batch_create_entities`, `batch_delete_entities`, `comment_on_entity`, `create_entity`, `entity_action`, `get_task_with_context`, `list_entities`, `list_entity_comments`, `update_entity`, `verify_entity_completion`
- **Intelligence Flywheel (6):** `get_my_trust_context`, `get_outcome_attribution`, `get_relevant_learnings`, `record_outcome`, `start_autonomous_session`, `submit_learning`
- **MCP v2 Public Surface (5):** `orgx_act`, `orgx_attach`, `orgx_spawn`, `orgx_submit_receipt`, `orgx_write`
- **Onboarding (1):** `configure_org`
- **Organization (1):** `get_org_snapshot`
- **Other (7):** `check_execution_readiness`, `configure_outcome_type`, `manage_lifecycle`, `orgx_emit_execution_graph`, `orgx_free_audit`, `queue_action`, `scoring_config`
- **Planning (5):** `complete_plan`, `get_active_sessions`, `improve_plan`, `record_plan_edit`, `start_plan_session`
- **Recommended Entry Points (1):** `remember_decision`
- **Scoring & Queue (2):** `get_scoring_signals`, `score_next_up_queue`
- **Stats (1):** `stats`
- **Streams (2):** `get_initiative_stream_state`, `update_stream_progress`
- **Workspace (1):** `workspace`

## Verification and rollout boundary

- Focused tests: 37 passed across edge rate limiting, MCP transport telemetry,
  and batch-create retry contracts.
- MCP contract suite: 152/152 tests passed.
- Full test suite: 690 passed, 1 skipped.
- TypeScript: `pnpm exec tsc --noEmit` passed.
- MCP Apps SDK production build passed.
- Public live benchmark: 30/30 requests passed.
- Production deployment: not performed. Production percentiles above describe
  the pre-fix worker and should be re-measured after deployment with the new
  edge-stage metadata.
