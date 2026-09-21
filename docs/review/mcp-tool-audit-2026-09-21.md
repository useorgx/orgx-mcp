# OrgX MCP tool audit — 2026-09-21

Status: local repairs validated; **not an all-tools production certification**.

## Scope and evidence

- Canonical worker: useorgx/orgx-mcp, fetched origin/main `b126f02`.
- Worktree: `codex/mcp-tool-audit-20260921`.
- Canonical backend: hopeatina/orgx, fetched origin/main `d210b4e39`; read only.
- Live bootstrap reports server `0.3.0-ec32ca7`, manifest `1.1.5`, workspace OrgX Business. This does not establish the worker deployment SHA.
- Both installed OrgX connections reached the same workspace. No production business records were changed.
- Live manifest: 41 tools. Installed connector: 20 tools. Catalog: 88 definitions across public/compatibility/internal profiles; these are different inventories.
- Existing full local suite passed: 172 files, 1,257 tests passed, 1 skipped. This includes registration, contracts, transport and UI tests; it is not a successful live invocation of every tool.
- New SDK morning-brief and status regression cases both fail against original source and pass with the repairs. They are included in the verify gate.

## Repairs in this worktree

1. Morning brief: extend the closed output contract with the 13 fields actually produced by the canonical backend: workspace_id, artifacts_produced, review_items, top_priorities, metrics, topPriorities, rollups, decisionChronology, artifactLedger, continuity, prVelocity, initiatives, message. Preserve the session ROI field. Use the existing portable nested-schema strategy.
2. Agent status: regenerate narrative and stalled-agent list from normalized agents, and update the text response after normalization. Count unique active tasks across task lanes rather than the pre-normalization duplicated workload.
3. Agent status payload: return at most six artifact index entries per agent, retaining IDs, task/run references and artifact links; expose total and preview counts. Full metadata/content remains retrievable through orgx_inspect. This bounds the reproduced artifact expansion, not arbitrary future task payload sizes.

## Live tool matrix

| Tool | Evidence state | Observation |
| --- | --- | --- |
| orgx_bootstrap | Live read passed | Both connections returned OrgX Business and the same 41-tool manifest. |
| orgx_search | Live read passed; connector pagination blocked | Five initiative records returned. next_call uses offset, absent from installed connector schema. |
| get_agent_status | Live inconsistency reproduced; local patch passed | 7 stalled agents / 0 blocked, but message said 4 blocked; 1,535,061 serialized characters including duplicated payload. Artifact preview is now bounded. |
| get_morning_brief | Live failed; local patch passed | MCP -32602 output validation rejected 13 backend fields. Exact named fields now accepted. |
| get_initiative_pulse | Live response received; semantic discrepancy unresolved | 35% completion agrees with 6/17 tasks. Derived status running differs from stored blocked; all three streams blocked. |
| track_project_progress | Live alias matched pulse | Same initiative summary as get_initiative_pulse. |
| orgx_inspect | Live read passed for initiative | Stored initiative status blocked; contextual evidence returned. Not every entity type exercised. |
| orgx_recommend | Live responses received | next_action and morning_brief modes returned data. Recommendation relevance not independently certified. |
| query_org_memory | Live known-record lookup passed | Found the same accepted recovery decision as bootstrap. Follow-up text still mentions unavailable get_memory_item. |
| recall_memory | Live alias matched memory lookup | Same decision found. |
| approve_agent_work | Live list passed only | Zero pending decisions within selected initiative. Approve/reject not exercised. |
| orgx_decide | Live list_pending passed only | One workspace pending decision. Write actions not exercised. |
| recommend_next_action | Live alias returned recommendations | No dispatch performed. |
| review_artifact | Live read passed | Returned artifact with explicit missing canonical quality evidence; no approval performed. |
| orgx_plan | Live resume passed only | Existing plan loaded; start/improve/record_edit/complete not exercised. |
| approve_decision | Live write not exercised | Requires disposable sandbox records and explicit write-test scope. |
| delegate_agent_task | Live write not exercised | Requires disposable sandbox records and explicit write-test scope. |
| handoff_task | Live write not exercised | Requires disposable sandbox records and explicit write-test scope. |
| reject_decision | Live write not exercised | Requires disposable sandbox records and explicit write-test scope. |
| spawn_agent_task | Live write not exercised | Requires disposable sandbox records and explicit write-test scope. |
| check_execution_readiness | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| consolidate_pr | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| get_operator_chronicle | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| manage_lifecycle | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_ack_attention | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_act | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_attach | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_controller_status | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_emit_activity | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_emit_execution_graph | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_expect | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_poll_attention | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_poll_question | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_request_attention | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_request_question | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_spawn | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_submit_receipt | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_tail | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| orgx_write | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| request_independent_artifact_review | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |
| scaffold_initiative | Unavailable in installed connector | Advertised by bootstrap, but no callable tool in this client. |

## Remaining issues and qualification

- Refresh/reconnect the client connector and verify tools/list matches the manifest. Current orgx_search source already supports offset/cursor, but installed arguments omit both; changing correct server code will not refresh that client schema.
- Deploy this patch, then rerun morning brief through a strict SDK client and reconcile agent message/summary/stalled list. Measure serialized payload before/after.
- Stored initiative status and derived pulse status disagree. The pulse explicitly derives continuity from workstream tasks, so changing production status rows or redefining that projection without a chosen authority would be unsafe. Report this discrepancy; do not label the initiative actively executing based on the pulse alone.
- Two initiatives share the runtime-recovery title and the same historical idempotency metadata. They are distinct records; no deduplication or deletion was performed.
- Memory aliases still suggest get_memory_item, which is absent from the manifest. The usable path is orgx_inspect with the returned type and ID.
- Initial authenticated probes ranged roughly 5–41 seconds; later alias calls took roughly 6–16 seconds. Calls were batched and include connector/queue overhead. These are individual elapsed samples, not endpoint p95 or a proven root cause.
- Public benchmark (5 samples per route): health p95 233 ms, server.json 85 ms, public tools/list 70 ms; all HTTP calls succeeded. Health exceeded its 150 ms target in this small sample. HTTP 200 is not proof of authenticated tool correctness.
- Direct unauthenticated /mcp discovery returned HTTP 403; /public exposes three discovery tools. No authentication boundary was bypassed.
- Live write qualification must use a verified system sandbox and current authenticated full tool surface. Exercise disposable create/update/readback, dry-run non-mutation, idempotency, plan lifecycle, artifact/receipt, approval/rejection, lifecycle and handoff paths. Dispatch and external effects need an explicit budget and scope. The existing test-write-tools script is not safe to run blindly: inspect its legacy endpoint/auth behavior and fixture targets first.
- At the initial audit, CI, PR, merge, deployment and live post-fix verification had not run. Shipping evidence must come from the subsequent PR/workflow receipts; this matrix is not universal data-correctness certification.

## Additional catalog definitions

The checked-in generated catalog lists 88 definitions. See `docs/generated/tool-catalog.json` and `tests/toolCoverageMatrix.spec.ts` for profile and historical coverage. Historical live checks in that matrix are not current verification. Tools outside the 41-tool manifest were covered only by the local suite to the extent asserted there; no fresh live invocation was possible through this connector.


## Plugin retry before shipping

- OrgX for Codex 0.1.20 is installed with an HTTP server named orgx at https://mcp.useorgx.com/mcp. Its direct server tools are not exposed to this task. The installed hosted connector still bootstraps OrgX Business successfully with 41 advertised tools and 20 callable wrappers.
- The separate OpenClaw bridge returned organization status, but orgx_get_morning_brief returned a text error containing HTTP 401 Authentication required while isError was false. This is a distinct integration failure; the worker patch does not claim to repair OpenClaw credentials or error envelopes.
- Final review preserved primary_url in compact artifact entries so the existing status widget retains clickable proof links.
