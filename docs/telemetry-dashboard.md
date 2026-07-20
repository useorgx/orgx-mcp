# MCP Agent-Journey Telemetry Dashboard

Production dashboard contract for the canonical `mcp_tool_invocation` event.
The dashboard intentionally does not depend on the older handler-local
`mcp_tool_called`, `mcp_tool_succeeded`, `mcp_tool_failed`, or
`mcp_tool_invalid_input` events. Those events may remain during migration, but
they do not contain the transport, client, response, or logical MCP outcome
needed to measure the agent/user experience end to end.

## Canonical event

One `mcp_tool_invocation` event is emitted for each completed `tools/call`
request after a worker-side clone of the finite MCP response has been observed.
The original response is returned without waiting for telemetry delivery.

| Property | Meaning |
|---|---|
| `tool_id`, `tool_family` | Selected tool and stable functional family |
| `status` | `success` or `error`, including HTTP-200 MCP logical failures |
| `mcp_logical_error` | True for JSON-RPC errors, `CallToolResult.isError`, `structuredContent.ok=false`, or a non-empty structured error without an explicit success marker |
| `error_code`, `error_kind` | Bounded machine-readable failure labels; no raw error prose |
| `source_client`, `profile` | Normalized client (including OpenCode) and effective MCP tool profile after fail-closed negotiation |
| `conversation_id`, `step_id`, `step_index` | Journey correlation fields when supplied by the client |
| `previous_tool_id`, `expected_next_tool_id` | Declared chain edges for calls-to-outcome analysis |
| `previous_expected_next_tool_id`, `followed_expected_next_tool` | Whether this call followed the prior response's guidance |
| `auth_ms`, `session_ms`, `request_normalization_ms` | Request-entry stages |
| `handler_ms`, `response_shaping_ms`, `response_headers_ms` | Execution and response-construction stages |
| `first_response_byte_ms`, `full_response_ms` | Worker observation of first and complete response bytes |
| `response_size_bytes`, `response_size_source` | Actual cloned-body bytes, or `Content-Length` fallback |
| `response_read_error`, `response_parse_truncated` | Measurement-quality flags |
| `argument_count`, `argument_keys`, `estimated_argument_bytes` | Input-shape and schema-cost indicators |
| `http_status`, `auth_scope`, `session_present` | Transport and authorization context |
| `edge_rate_limit_*` | Edge/rate-limit stages from `Server-Timing` |

`first_response_byte_ms` and `full_response_ms` are measured at
`response_measurement_point=worker_response_clone`; they include server work but
not the final network hop or host widget-render time. Hosts should emit their
own render/first-useful-paint receipt keyed by `request_id` when that signal is
available.

## Saved queries

All examples use the single canonical event and `journey_phase='complete'` so
legacy or future phase events cannot double-count invocations.

### 1. Per-tool call volume and logical success

```sql
SELECT properties.tool_id AS tool_id,
       count() AS calls,
       countIf(properties.status = 'success') AS successes,
       countIf(properties.status = 'error') AS errors,
       round(100.0 * successes / nullif(calls, 0), 1) AS success_pct
  FROM events
 WHERE event = 'mcp_tool_invocation'
   AND properties.journey_phase = 'complete'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY tool_id
 ORDER BY calls DESC
```

### 2. Client and profile selection quality

```sql
SELECT properties.source_client AS source_client,
       properties.profile AS profile,
       properties.tool_id AS tool_id,
       count() AS calls,
       countIf(properties.status = 'error') AS failures,
       round(100.0 * failures / nullif(calls, 0), 1) AS failure_pct
  FROM events
 WHERE event = 'mcp_tool_invocation'
   AND properties.journey_phase = 'complete'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY source_client, profile, tool_id
 ORDER BY failures DESC, calls DESC
```

Do not substitute `tool_family` for `source_client`: `tool_family` describes the
operation, while `source_client` identifies ChatGPT, Claude, Codex, Cursor,
OpenClaw, or another host.

### 3. Full-response latency and stage attribution

```sql
SELECT properties.tool_id AS tool_id,
       quantile(0.5)(toFloat64(properties.full_response_ms)) AS full_p50,
       quantile(0.95)(toFloat64(properties.full_response_ms)) AS full_p95,
       quantile(0.95)(toFloat64(properties.auth_ms)) AS auth_p95,
       quantile(0.95)(toFloat64(properties.handler_ms)) AS handler_p95,
       quantile(0.95)(toFloat64(properties.response_shaping_ms)) AS shaping_p95,
       quantile(0.95)(toFloat64(properties.first_response_byte_ms)) AS first_byte_p95
  FROM events
 WHERE event = 'mcp_tool_invocation'
   AND properties.journey_phase = 'complete'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY tool_id
 ORDER BY full_p95 DESC
```

### 4. Payload cost by client and tool

```sql
SELECT properties.source_client AS source_client,
       properties.tool_id AS tool_id,
       count() AS calls,
       quantile(0.5)(toFloat64(properties.response_size_bytes)) AS bytes_p50,
       quantile(0.95)(toFloat64(properties.response_size_bytes)) AS bytes_p95,
       sum(toUInt64(properties.response_size_bytes)) AS bytes_total,
       countIf(properties.response_read_error = true) AS measurement_errors
  FROM events
 WHERE event = 'mcp_tool_invocation'
   AND properties.journey_phase = 'complete'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY source_client, tool_id
 ORDER BY bytes_total DESC
```

### 5. Most common logical and input failures

```sql
SELECT properties.source_client AS source_client,
       properties.profile AS profile,
       properties.tool_id AS tool_id,
       coalesce(properties.error_kind, '<no_kind>') AS error_kind,
       coalesce(properties.error_code, '<no_code>') AS error_code,
       count() AS failures
  FROM events
 WHERE event = 'mcp_tool_invocation'
   AND properties.journey_phase = 'complete'
   AND properties.status = 'error'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY source_client, profile, tool_id, error_kind, error_code
 ORDER BY failures DESC
 LIMIT 100
```

Use `error_kind='invalid_input'` for the schema-friction board. The canonical
event classifies the final MCP result, so this query includes failures that
arrive in HTTP-200 JSON-RPC responses rather than relying on HTTP status.

### 6. Calls-to-outcome and next-call follow-through

```sql
SELECT properties.source_client AS source_client,
       properties.previous_expected_next_tool_id AS recommended_tool,
       properties.tool_id AS actual_next_tool,
       count() AS observed_edges,
       countIf(properties.followed_expected_next_tool = true) AS followed,
       round(100.0 * followed / nullif(observed_edges, 0), 1) AS follow_pct
  FROM events
 WHERE event = 'mcp_tool_invocation'
   AND properties.journey_phase = 'complete'
   AND properties.previous_expected_next_tool_id IS NOT NULL
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY source_client, recommended_tool, actual_next_tool
 ORDER BY observed_edges DESC
```

For clients that cannot send chain fields, reconstruct the sequence by
`conversation_id`, ordered by `step_index` and timestamp. Join the final
`orgx_submit_receipt` or runtime outcome by conversation/request IDs to compute:

- median tool calls to first useful result;
- median tool calls to evidence-bearing completion;
- retry loops by repeated `(conversation_id, tool_id, error_kind)`;
- abandonment after a truncated result or invalid next-call recommendation.

### 7. Weekly drift alert

```sql
WITH this_week AS (
  SELECT properties.source_client AS source_client,
         properties.profile AS profile,
         properties.tool_id AS tool_id,
         coalesce(properties.error_kind, '<no_kind>') AS error_kind,
         count() AS n
    FROM events
   WHERE event = 'mcp_tool_invocation'
     AND properties.journey_phase = 'complete'
     AND properties.status = 'error'
     AND timestamp >= now() - INTERVAL 7 DAY
   GROUP BY 1, 2, 3, 4
), last_week AS (
  SELECT properties.source_client AS source_client,
         properties.profile AS profile,
         properties.tool_id AS tool_id,
         coalesce(properties.error_kind, '<no_kind>') AS error_kind,
         count() AS n
    FROM events
   WHERE event = 'mcp_tool_invocation'
     AND properties.journey_phase = 'complete'
     AND properties.status = 'error'
     AND timestamp >= now() - INTERVAL 14 DAY
     AND timestamp < now() - INTERVAL 7 DAY
   GROUP BY 1, 2, 3, 4
)
SELECT t.source_client, t.profile, t.tool_id, t.error_kind,
       l.n AS last_week_count,
       t.n AS this_week_count,
       round(100.0 * (t.n - l.n) / nullif(l.n, 0), 1) AS pct_change
  FROM this_week t
  LEFT JOIN last_week l USING (source_client, profile, tool_id, error_kind)
 WHERE t.n >= 5
   AND (l.n IS NULL OR t.n > 1.5 * l.n)
 ORDER BY pct_change DESC NULLS LAST
```

## Dashboard layout

1. Outcome: calls, logical success, calls-to-receipt, abandonment.
2. Selection: client × profile × tool, wrong-tool and invalid-input rates.
3. Experience: first/full response p50/p95 and stage attribution.
4. Payload: tools/list size, argument bytes, response bytes, widget-render joins.
5. Recovery: retries, repeated errors, and recommended-next-call follow-through.

## Production wiring checklist

- [ ] Verify `mcp_tool_invocation` with `journey_phase=complete` in PostHog.
- [ ] Confirm HTTP-200 `isError:true` canaries arrive as `status=error`.
- [ ] Confirm `response_size_bytes` is populated when `Content-Length` is absent.
- [ ] Pin queries 1–7 as saved insights and subscribe an owner to weekly drift.
- [ ] Add host-render receipts keyed by `request_id` for true user-visible render time.
- [ ] Join final OrgX receipts/outcomes to compute calls-to-evidence, not calls alone.
