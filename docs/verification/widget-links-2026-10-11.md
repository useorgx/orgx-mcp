# Widget navigation audit — 11 October 2026

The audit covers all 15 product widget documents (the gallery index is a preview, not a product widget), their shared navigation runtime, server deep links, and the current OrgX app routes. Broken links came from both incorrect destinations and clicks that never reached the host.

| Failure | Correction |
| --- | --- |
| An opted-in MCP SDK handshake could stall while ChatGPT already supplied the widget data. Clicks queued behind it. | Use ChatGPT's opening capability immediately until the SDK connects. The panel also observes ChatGPT globals while waiting. |
| Missing or throwing host capabilities swallowed native anchor navigation. Asynchronous fallback popups could be blocked. | Preserve native anchors, open button fallbacks during the user gesture, and show a real recovery anchor on host refusal or missing acknowledgement. |
| Shared and widget-specific component listeners opened the same receipt or agent link twice. | Let the shared runtime own component links, and mark a handled event to prevent repeated opens. |
| Inline click handlers and shadow-DOM event retargeting bypassed shared routing. | Route search and initiative links through delegated handlers that inspect the composed event path. |
| Projects opened Command; nested and memory-backed search records lost their actual entity ID. | Add the project route and preserve nested IDs, entity types, and workspace/initiative context. |
| Legacy mission-control task URLs opened the old view; other obsolete routes remained in payloads. | Rewrite known old URLs to supported destinations, including native component fallbacks. Invalid percent escapes no longer crash routing. |
| Standalone panel, artifact, and streaming-scaffold buttons ignored the runtime's browser fallback. | Complete the browser open when the runtime returns the native-fallback signal. |
| A link labeled “Open plan” went to an initiative or Runs because no plan-session page exists. | Name the actual destination: “Open initiative” or “Open runs.” |
| The route fixture still claimed removed query parameters worked, and omitted the ledger's range parameter. | Regenerate from 280 current app routes and verify query readers, including the ledger parser. |

## Verification

`scripts/audit-widget-links.mjs` clicks actual anchors, buttons, and agent popover links in Chromium, including shadow DOM. It simulates standalone, ChatGPT, connected MCP SDK, and pending-SDK-with-ChatGPT hosts. It intercepts navigation and tool calls so the audit cannot mutate real decisions or tasks. Every observed OrgX destination must match the app-generated route and its supported query parameters, and each click must open exactly once. Internal section anchors are excluded from external navigation checks.

The source-asset audit passed 586 clicks across 180 widget/host/state cases. The generated minified assets passed another 222 clicks across 60 populated cases in sandboxed iframes where embedded. Together: 808 clicks, no navigation failures, duplicate opens, or browser exceptions. States cover populated, blocked, and long fixtures where those fixtures exist; unsupported or empty states expose no links. The standalone panel has no incoming snapshot; its populated links are exercised in the host modes.

The targeted runtime, route, widget interaction, resource-serving, and payload suites passed 505 distinct tests across 31 files. Worker TypeScript, widget builds, generated asset consistency, and payload budgets pass. The initiative-pulse budget increases by 2 KiB to accommodate the shared recovery/navigation code; other budgets are unchanged.

These checks establish route and click-handler correctness using deterministic fixtures. They do not establish that every production record exists or is visible to a particular signed-in user. Deployment and authenticated production readback remain separate steps. Browser evidence is generated locally under `artifacts/qa/widget-links/` and is excluded from release source.

To repeat:

```sh
ORGX_APP_DIR=/path/to/orgx/app-root node scripts/generate-app-routes.mjs
CHROMIUM_PATH=/path/to/chromium node scripts/audit-widget-links.mjs
CHROMIUM_PATH=/path/to/chromium WIDGET_LINK_ASSETS=inline \
  WIDGET_LINK_AUDIT_LABEL=inline WIDGET_LINK_STATES=populated \
  node scripts/audit-widget-links.mjs
```
