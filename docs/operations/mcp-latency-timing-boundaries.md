# MCP latency timing boundaries

Measure a useful completed tool response, alongside the installed host's end-to-end duration. Opening an SSE stream or returning headers is not the completed result. A long-running command needs a durable acknowledgement after commit; its execution duration is separate.

Worker transport events preserve the existing `full_response_ms`: it starts at the authenticated MCP handler, **after** OAuth verification and outer request-body checks. It must not be subtracted from an installed host duration to label the remainder entirely as host overhead.

The new `worker_full_response_ms` starts at the exported Worker fetch entry, outside Sentry and OAuth, and ends when the bounded response observer consumes the response stream. `worker_pre_transport_ms` records time from that entry to the authenticated transport. `worker_response_headers_ms` and `worker_first_response_byte_ms` use the same entry boundary. These are server observations; they do not measure delivery through the client network or host processing. Long-lived/resumed event streams and unobserved results are unsuitable completed-tool samples.

`session_contract_ms` measures the fresh persisted identity/grant/profile preflight. Its `mcp_session_contract` Server-Timing entry is also returned on successful dispatch. The preflight uses one direct read-only Durable Object RPC; the MCP SDK owns transport naming and initialization. No authority is cached.

The origin emits these fixed numeric Server-Timing stages when executed:

- `orgx_mcp_identity`, `orgx_mcp_run_binding`, `orgx_mcp_rate_limit`
- `orgx_mcp_metering`, `orgx_mcp_allowance`, `orgx_mcp_envelope`
- `orgx_mcp_execution`, `orgx_mcp_delegation`, `orgx_mcp_total`

The Worker exposes `origin_<stage>_ms` and `origin_<stage>_count` in `orgx/performance` and transport telemetry. The duration is a **sum across timed API attempts**, including retries and concurrent calls. The count is per phase: absent or malformed stages are absent, never zero. These sums are not wall-clock critical paths and must not be added to one another; `total` includes its origin sub-stages. Origin total ends at Response creation, before body transfer. Likewise, existing `api_headers_ms` is summed across API attempts. `tool_execution_ms` retains its independent handler wall-clock measurement.

For `orgx_get_next_actions`, inspect `origin_execution_ms`, `origin_total_ms` and their sample counts for the ranking request through the tool executor. For hydrated `orgx_inspect`, match the tool result’s `orgx/diagnostics.trace_id` to the Worker’s `orgx_api_attempt` logs. An attempt on the context-pack route can report `context_prepare_ms` for the app’s preparation timer and `context_scope_ms` for the owner and ancestry check inside it. Each duration belongs to that single upstream attempt. A missing phase has no sample. The app starts its preparation timer on handler entry and captures it when building the response headers. Serialization and delivery observation can still run afterward. Use `worker_full_response_ms` for the complete observed Worker response.

Header projection accepts only the listed canonical stages and finite nonnegative durations up to 300 seconds. Oversized headers, quoted values/descriptions, duplicates, and malformed durations contribute no corresponding samples. Arbitrary names and server text are not retained.

Use `source_revision` (the deployment-injected full Git SHA) for source cohorts and `cloudflare_version` for the independent Worker version UUID. A secret synchronization can publish another Worker version for the same source. A semver label with an abbreviated SHA is not accepted as an exact source revision. Older events without source revision need an explicit deployment-version mapping.

Before claiming a sub-500ms p95, collect representative, release-bound warm and cold samples for each relevant tool, with errors and authorization refusals identified. Report the sample count and whether the SLI is origin, complete Worker response, or installed host end-to-end. A single canary cannot establish a percentile or prove a speedup.
