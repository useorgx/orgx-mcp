# MCP weekly performance profile — November 6, 2026

Window: `2026-10-30T19:00:00Z` inclusive through `2026-11-06T19:00:00Z` exclusive (exactly seven days). Source: production `agent_tool_invocations` filtered to `source='mcp_worker'`. Handler and execution-ingress observations overlap and are not added.

1,146 worker observations covered 27 names with 79 non-success outcomes (including input/auth refusals). The catalog has 164 legacy/current/widget entries; unobserved tools have no measured latency. PostHog independently had 1,136 complete canonical events; the 10-row delivery/ingestion discrepancy remains unresolved.

| Tool | n | Non-success | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `orgx_start_agent_task` | 6 | 0 | 18869 | 21513 | 21513 |
| `orgx_get_next_actions` | 11 | 0 | 11347 | 14528 | 14528 |
| `orgx_panel_snapshot` | 32 | 1 | 3746 | 11966 | 13671 |
| `orgx_search` | 182 | 33 | 1021 | 10656 | 18518 |
| `orgx_get_receipt_review_queue` | 7 | 1 | 3663 | 10502 | 10502 |
| `orgx_list_work_receipts` | 91 | 11 | 2671 | 7366 | 9380 |
| `orgx_get_agent_status` | 14 | 0 | 5226 | 6296 | 6296 |
| `orgx_submit_work_receipt` | 6 | 6 | 3962 | 5735 | 5735 |
| `orgx_get_initiative_progress` | 24 | 0 | 4123 | 5423 | 5955 |
| `orgx_get_workspace_context` | 92 | 9 | 3283 | 4944 | 8460 |
| `orgx_get_operator_brief` | 16 | 0 | 2958 | 4677 | 4677 |
| `orgx_create_task` | 2 | 1 | 1847 | 4497 | 4497 |
| `orgx_get_work_receipt` | 29 | 0 | 3068 | 3811 | 4844 |
| `orgx_inspect` | 430 | 6 | 1103 | 3782 | 4405 |
| `orgx_update_work` | 50 | 3 | 1084 | 3516 | 10859 |
| `orgx_cancel_work` | 3 | 0 | 3049 | 3353 | 3353 |
| `orgx_get_operation_status` | 60 | 0 | 1221 | 2923 | 18955 |
| `orgx_create_initiative_hierarchy` | 3 | 0 | 1084 | 2608 | 2608 |
| `orgx_widget_decide` | 30 | 1 | 1935 | 2515 | 3694 |
| `orgx_list_pending_decisions` | 2 | 0 | 2349 | 2373 | 2373 |
| `orgx_capture_decision` | 5 | 1 | 1270 | 2064 | 2064 |
| `orgx_attach_artifact` | 1 | 0 | 1510 | 1510 | 1510 |
| `orgx_open_decision_review` | 7 | 3 | 924 | 1447 | 1447 |
| `orgx_check_execution_readiness` | 31 | 0 | 842 | 1215 | 1295 |
| `orgx_validate_work_receipt` | 9 | 3 | 385 | 987 | 987 |
| `orgx_read_plan` | 1 | 0 | 965 | 965 | 965 |
| `orgx_estimate_agent_task` | 2 | 0 | 289 | 307 | 307 |

Percentiles use PostgreSQL nearest-rank `percentile_disc`, include failures, and are unstable for small samples. These are observed server response timings, not final network delivery or host render.

## Profiling repair

Transport `handler_ms` measures the time to obtain the streaming Response, not the complete tool execution. The named-operation wrapper now returns content-free numeric measurements in `result._meta['orgx/performance']`:

- `tool_execution_ms`: wrapper entry to resolved tool result, before telemetry delivery.
- `api_calls`, `api_attempts`, `api_fallbacks`, `api_failures`, `api_timeouts`: per-invocation upstream diagnostics.
- `api_headers_ms`, `api_body_ms`: sums across upstream attempts and body reads, not wall-clock components when operations overlap.

Only finite nonnegative numeric allowlisted values reach canonical PostHog and durable metadata. Batch responses match JSON-RPC IDs before projecting measurements. Missing, thrown, truncated or unmatched measurements remain absent rather than fabricated zero. Public/local tools with no upstream calls retain their prior metadata.

The wrapper snapshots before reporting completion, so recording telemetry never counts as tool work. No URLs, arguments, body data or error prose are included. Existing support references and widget metadata remain intact.

## Public baseline

A production probe with ten sequential requests per scenario succeeded 30/30 times: health p50 68 ms / p95 742 ms; server metadata 80 / 116 ms; unauthenticated tools/list 55 / 79 ms. The ten-sample p95 is also the maximum. This pre-change run measures public edge health; authenticated tool performance needs deployed follow-up traffic.

## Remaining limits

The main backend audit also observed 1,314,373 Supabase edge requests over 346 method/path combinations. Database-origin timing does not establish application-route latency. The largest historical recomposition hotspot recovered after the existing November 1 dependency-projection repair; current capsule-sync and memory-wake RPC timeouts remain open. No state-of-the-art, load-capacity or comparative improvement claim is supported yet.

Verification: 44 focused diagnostics/transport/privacy tests and TypeScript passed locally. PR CI is authoritative before merge.
