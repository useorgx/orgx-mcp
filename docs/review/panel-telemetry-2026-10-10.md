# OrgX panel telemetry: what the extension reports, and where — 2026-10-10

The panel (`ui://widget/orgx-panel.html`) ran blind: the worker recorded
each MCP tool call (`mcp_tool_invocation`, with latency and error kind at the
transport), the app recorded each tool execution in `agent_tool_invocations`,
and nothing recorded what the person in ChatGPT or Claude actually did, how
long a tab took to answer, or which upstream source made a snapshot slow.
This pass closes that from three sides. Every event lands in PostHog; the
ones that are failures also land in Sentry.

## 1. The widget: UX events (`mcp_panel_*`)

The widget cannot reach PostHog itself (its CSP allows only this origin), so
it posts small batches to `POST /telemetry/widget` on the worker with a
signed grant, and the worker forwards them. The grant travels in the panel
tool's result `_meta['orgx/widgetTelemetry']`, lives four hours, names the
viewer and the workspace the panel was read for, and is refreshed by every
snapshot read. A request without a valid grant is refused; a grant may send
at most 400 events; a batch is at most 25 events and 8 KB; a closing page
flushes with `keepalive`.

The schema is closed on both ends (`src/widgetTelemetry.ts` names the
events and the keys each may carry; `src/workerTelemetryPrivacy.ts` names
the values a key may take). Decision titles, prompts, receipt text and error
messages never travel; a tool error is reduced to its code.

| Event | Properties | When |
| --- | --- | --- |
| `mcp_panel_opened` | `host`, `platform`, `display_mode`, `safe_source`, `cold`, `ttfc_ms` | The first snapshot is on screen. `ttfc_ms` is time to first content from document start; `cold` is true when the widget had to read for itself (an MCP Apps host) rather than being handed the result (ChatGPT). |
| `mcp_panel_tab_switched` | `panel_from_tab`, `panel_tab`, `latency_ms`, `warm` | A tab answers a tap. `warm` says its data was already there (the background warm-up, or a previous visit). |
| `mcp_panel_read` | `panel_read_kind`, `panel_trigger`, `latency_ms`, `ok`, `error_code` | Every read the panel makes: snapshot (open, refresh, live, switch, after a ruling, focus), work, receipts, history, one receipt, the work behind a merge. |
| `mcp_panel_decision` | `panel_decision_action`, `panel_outcome`, `latency_ms`, `ok`, `error_code` | From the press on Approve or Send back to the settled ruling (confirmed, rejected, elsewhere, recorded, validation, failed). |
| `mcp_panel_start_sent` | `panel_verb`, `agent_picked`, `panel_outcome` | Start sent its sentence to the host (sent, copied, unsent). |
| `mcp_panel_workspace_switched` | `ok`, `latency_ms`, `error_code` | The workspace switcher. |
| `mcp_panel_error` | `panel_error_code`, `panel_read_kind`, `error_code` | A page error (at most three per life), an auth or scope refusal, a failed decide, going offline. Also a Sentry message, fingerprinted by code. |
| `mcp_panel_tour` | `panel_tour_outcome`, `step_index` | The first-use tour started, finished, was skipped or closed. |

Each carries `widget: orgx-panel`, `widget_protocol` (chatgpt, mcp-apps,
mcp-apps-sdk) and, from the grant, `workspace_id` and the viewer as the
PostHog distinct id, so a panel session reads in one person timeline next
to the tool calls behind it.

Client side: `OrgXWidgetRuntime.reportWidgetEvent(name, props)` and
`flushWidgetEvents()`; the panel's own hooks are the `track(...)` calls in
`panel-app.js`.

## 2. The panel tool: where a snapshot's time went (`mcp_panel_snapshot_read`)

`orgx_panel_snapshot` reads up to seven upstream sources and swallows any
that fail into a `degraded` list so the panel can still draw. Each read now
reports one event with the milliseconds per source (`decisions_ms`,
`artifacts_ms`, `work_ms`, `history_ms`, `ledger_ms`, `receipt_ms`,
`workspaces_ms`), the total, `degraded_count`, and for a failed source its
name and error kind. A failed source is also a Sentry exception,
fingerprinted by source, so a ledger that starts failing is one issue with a
count rather than a silent `degraded` entry.

The mechanism is a `PanelSurfaceHost.observe` callback and a stopwatch
around each source (`timedSource`) in `src/panelSurface.ts`; the worker
implements the callback in `observePanelSnapshot`.

## 3. The app's routes the panel depends on

In the app repository (hopeatina/orgx):

- `work_ledger_call_succeeded` / `work_ledger_call_failed`: every
  `/api/v1/work-ledger/*` call, with `route`, `write`, `http_status`,
  `latency_ms`, `workspace_id`, `actor_type`, on the viewer. The failure
  path already reached Sentry through `logger.error`; now a slow or failing
  ledger shows in PostHog before it shows as "Work receipts could not be
  read right now".
- `mcp_tool_succeeded` / `mcp_tool_failed`: every `/api/tools/execute`
  execution, with `tool_id`, `latency_ms`, `source_client`, `workspace_id`
  and a short `error_code`. The MCP worker records the same call from its
  side; the two clocks together tell a slow tool from a slow hop.

Both are delivered with Next's `after()` so the response never waits on
PostHog.

## Reading it

- Slow panel on phones: `mcp_panel_opened.ttfc_ms` by `host` and
  `platform`; `mcp_panel_tab_switched.latency_ms` split by `warm`.
- Reads that fail: `mcp_panel_read` where `ok = false`, by
  `panel_read_kind` and `error_code`; the matching upstream side is
  `mcp_panel_snapshot_read` (which source) and `work_ledger_call_failed`
  (which route).
- Decisions: `mcp_panel_decision.latency_ms` by `panel_outcome`; a
  `validation` outcome is the form asking for more, not a failure.
- Funnel: `mcp_panel_opened` → `mcp_panel_tab_switched` →
  `mcp_panel_decision` or `mcp_panel_start_sent`, per person.
