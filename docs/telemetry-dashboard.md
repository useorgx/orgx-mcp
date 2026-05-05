# MCP Tool Telemetry Dashboard

Saved-query reference for the **Agent ↔ OrgX intersection verification**
initiative ([live view](https://useorgx.com/live/96826b82-7ba6-45f4-9a55-b4891c58082d)),
Pass 4. The orgx-mcp worker emits four PostHog event types — this doc names
them, lists the properties each event carries, and gives the saved queries
that compose into the production dashboard.

All wiring already exists; this doc is the cookbook for setting up the
PostHog board so the events become an actionable signal.

## Events emitted by orgx-mcp

| Event | When it fires | Where in code |
|---|---|---|
| `mcp_tool_called` | Tool invocation enters our handler | `src/index.ts` `captureMcpToolEvent('mcp_tool_called', …)` |
| `mcp_tool_succeeded` | Handler returned a non-error result | same |
| `mcp_tool_failed` | Handler caught an error or returned `isError:true` | same |
| `mcp_tool_invalid_input` | **Auto-emitted alongside `mcp_tool_failed`** when the error message matches Zod-flavored patterns or `errorKind:'invalid_input'` is set explicitly | `captureMcpToolEvent` auto-detects via `isZodFlavoredErrorMessage` |

### Common properties (all four events)

| Property | Type | Notes |
|---|---|---|
| `tool_id` | string | The MCP tool name, e.g. `scaffold_initiative` |
| `tool_family` | enum | `chatgpt` \| `stream` \| `plan_session` \| `client_integration` |
| `auth_source` | enum | `request` \| `session` \| `none` |
| `has_user_id` | boolean | Whether the call was authenticated |
| `is_widget_tool` | boolean | True when the tool returns a widget resource |
| `$lib` | string | Always `orgx-mcp` |
| `$lib_version` | string | Mirror of `MCP_SERVER_VERSION` (matches `package.json` version) |

### Properties on `mcp_tool_succeeded` / `mcp_tool_failed`

| Property | Type | Notes |
|---|---|---|
| `latency_ms` | number | Wall-clock time inside the handler |
| `ok` | boolean | Mirrors success; redundant with event name but useful in joined queries |
| `error` | string | Failure message (failed only) |
| `error_kind` | string | Optional structured tag: `invalid_input`, `spawn_guard_blocked`, `stream_creation_failed`, `launch_failed`, `auth_required`, `credential_missing`, etc. |

### Extra properties on `mcp_tool_invalid_input`

| Property | Type | Notes |
|---|---|---|
| `error` | string | The original Zod-flavored message |
| `error_kind` | string | Always at least `'invalid_input'`; may be more specific |
| `error_path` | string \| null | Field path extracted from the message (e.g. `"title"`, `"metadata.checklist[0].item"`); `null` when unrecognised so you can group "no_path" as its own bucket |

`mcp_tool_invalid_input` is **additive** — `mcp_tool_failed` still fires.
This lets the dashboard slice both ways: "all failures" via the parent
event, "input-shape failures" via the dedicated event without
substring-matching arbitrary error text.

## Dashboard queries (HogQL / SQL form)

Adapt to your PostHog project's query DSL. Property names are stable;
event names are listed above.

### 1. Per-tool call rate (last 7d)

```sql
SELECT properties.tool_id AS tool_id,
       count() AS calls
  FROM events
 WHERE event = 'mcp_tool_called'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY tool_id
 ORDER BY calls DESC
```

### 2. Per-tool success rate

```sql
WITH base AS (
  SELECT properties.tool_id AS tool_id,
         countIf(event = 'mcp_tool_succeeded') AS ok,
         countIf(event = 'mcp_tool_failed')   AS fail
    FROM events
   WHERE event IN ('mcp_tool_succeeded', 'mcp_tool_failed')
     AND timestamp >= now() - INTERVAL 7 DAY
   GROUP BY tool_id
)
SELECT tool_id,
       ok + fail AS total,
       round(100.0 * ok / nullif(ok + fail, 0), 1) AS success_pct,
       fail
  FROM base
 ORDER BY total DESC
```

### 3. Source-client breakdown for a single tool

For tracking "Cursor agents have a 12% error rate on `entity_action`
while Claude has 0.3%". Replace `<TOOL>` with the tool you're auditing.

```sql
SELECT properties.tool_id     AS tool_id,
       properties.tool_family AS source_client,
       countIf(event = 'mcp_tool_succeeded') AS ok,
       countIf(event = 'mcp_tool_failed')   AS fail,
       round(100.0 * countIf(event = 'mcp_tool_failed')
                  / nullif(count(), 0), 1) AS fail_pct
  FROM events
 WHERE properties.tool_id = '<TOOL>'
   AND event IN ('mcp_tool_called', 'mcp_tool_succeeded', 'mcp_tool_failed')
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY tool_id, source_client
 ORDER BY fail DESC
```

### 4. Latency p50 / p95 per tool

```sql
SELECT properties.tool_id AS tool_id,
       quantile(0.5)(toFloat64(properties.latency_ms))  AS p50,
       quantile(0.95)(toFloat64(properties.latency_ms)) AS p95,
       max(toFloat64(properties.latency_ms))            AS max_ms
  FROM events
 WHERE event = 'mcp_tool_succeeded'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY tool_id
HAVING p95 > 0
 ORDER BY p95 DESC
```

Alert on this query when `p95` exceeds a threshold. A reasonable starting
budget: 5 s for write-heavy tools, 1.5 s for read tools.

### 5. Most common ways agents fail to call X (Zod failures by tool + path)

The Pass 4 deliverable. Surfaces exactly which fields agents most often
mis-shape, sliced by source client. Use this output to either fix the
description or extend `agentErgonomics` to normalise the synonym.

```sql
SELECT properties.tool_id     AS tool_id,
       properties.tool_family AS source_client,
       coalesce(properties.error_path, '<no_path>') AS error_path,
       count() AS occurrences
  FROM events
 WHERE event = 'mcp_tool_invalid_input'
   AND timestamp >= now() - INTERVAL 7 DAY
 GROUP BY tool_id, source_client, error_path
 ORDER BY occurrences DESC
 LIMIT 50
```

### 6. Weekly drift digest (saved alert)

Run weekly. Compare to last week. If any (tool_id, source_client,
error_path) tuple jumps by more than 50%, fire a notification.

```sql
WITH this_week AS (
  SELECT properties.tool_id, properties.tool_family AS source_client,
         coalesce(properties.error_path, '<no_path>') AS error_path,
         count() AS n
    FROM events
   WHERE event = 'mcp_tool_invalid_input'
     AND timestamp >= now() - INTERVAL 7 DAY
   GROUP BY 1, 2, 3
), last_week AS (
  SELECT properties.tool_id, properties.tool_family AS source_client,
         coalesce(properties.error_path, '<no_path>') AS error_path,
         count() AS n
    FROM events
   WHERE event = 'mcp_tool_invalid_input'
     AND timestamp >= now() - INTERVAL 14 DAY
     AND timestamp <  now() - INTERVAL 7 DAY
   GROUP BY 1, 2, 3
)
SELECT t.tool_id, t.source_client, t.error_path,
       l.n AS last_week_count,
       t.n AS this_week_count,
       round(100.0 * (t.n - l.n) / nullif(l.n, 0), 1) AS pct_change
  FROM this_week t
  LEFT JOIN last_week l USING (tool_id, source_client, error_path)
 WHERE t.n >= 5
   AND (l.n IS NULL OR t.n > 1.5 * l.n)
 ORDER BY pct_change DESC NULLS LAST
```

## Recommended dashboard layout

Four boards, one row each:

1. **Headline** — overall MCP traffic. (1) call rate sparkline + (2) success
   rate gauge across all tools.
2. **Per-tool health** — tile for each tool with success rate + p95 latency.
   Sort by call volume.
3. **Source-client split** — same per-tool tiles, split by `tool_family`.
   Pivot when investigating a client-specific regression.
4. **Input-shape drift** — query 5 (most common Zod paths) and the weekly
   drift digest from query 6.

## Wiring checklist

- [ ] PostHog project receiving events from `https://us.i.posthog.com` (this
      is the default `POSTHOG_HOST`)
- [ ] `POSTHOG_KEY` set in worker env (or per-environment `.dev.vars`)
- [ ] Verify ingestion: trigger a tool call locally and look for
      `mcp_tool_called` in PostHog Live → Events
- [ ] Pin queries 1-6 above as a saved insight set
- [ ] Subscribe at least one engineer to the weekly drift digest

## Cross-repo note

orgx-web also emits PostHog events from agent runtimes (run start /
complete, artifact promoted, decision created — see
`lib/server/agentRuns/` and `lib/server/agentLifecycle.ts`). The agent
runtime events compose with these MCP-side events to build the full
"work the agent did via OrgX" picture. The dashboard should pull from
both projects when correlating "agent invoked tool X → run completed".
