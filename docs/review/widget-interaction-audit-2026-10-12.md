# Widget link and interaction verification — 12 October 2026

The audit covered every widget HTML surface in the current manifest: 14 production resources, the streaming demo, and the gallery. It found one navigation defect: the Decisions widget said “more in this initiative” but opened the general decisions queue. The fix opens the named initiative's live view; workspace queue links retain the workspace through the supported `center` parameter.

## Results

| Check | Coverage | Result |
| --- | --- | --- |
| Links and host handoff | 180 cases, 15 surfaces, 574 clicks; standalone, ChatGPT, SDK adapter, and a stalled SDK handshake with ChatGPT fallback | No handoff, destination-route, or JavaScript failures |
| Control exploration | 104 cases, 15 surfaces, 1,612 controls and 228 link opens; 1100px and 375px; ChatGPT and a real MCP Apps SDK/JSON-RPC handshake | No remaining click or JavaScript failures |
| Hosted files | 16 widget pages and 37 shared dependencies | All 53 returned HTTP 200; widget source matched the baseline after excluding Cloudflare's injected analytics script |
| Real tool-result replay | 32 cases, eight widgets, desktop/mobile, dark/light; 212 link clicks in copies of the hosted files | No click or JavaScript failures |
| Resource rendering | 92 cases, including structured errors, empty results, absent responses and malformed responses | Passed |
| Pagination and disclosures | 28 browser cases | Passed |
| Error presentation and recovery | 132 browser cases across desktop/tablet/mobile and both themes | Passed |
| Gallery | Four viewport/theme/motion cases; all 15 catalog entries; desktop search and keyboard navigation, mobile native picker | Passed |
| Focused regression and contract tests | 176 tests, including the scoped-link fix, widget registration, host negotiation and decision read races | Passed |
| Type checking and widget build | TypeScript; regenerated inline runtime, manifest and build version | Passed |

The initial control runs exposed runner problems rather than additional confirmed product defects. The gallery flag deliberately disables host handoff, so host tests now use actual host payloads and assert the detected protocol. Menus are closed with Escape before clicking controls underneath them. A delayed first-use tutorial covered three mobile MCP panel cases; those cases were rechecked successfully with the returning-user tutorial state. The initial failing traces remain in local evidence alongside the successful rechecks.

Eleven real read operations succeeded: workspace context, initiative progress, agent status, pending decisions, operator brief, receipt list, receipt detail, artifact review opener, decision review opener, entity inspection, and typed search. The real-result replays covered Initiative Pulse, Agent Status, Decisions, Artifact Review, Entity Card, Search Results, Work Ledger, and Workspace Map.

The first HTTP destination sample contained 28 unique URLs: 27 responded with HTTP 200. The remaining URL was a private GitHub PR; authenticated GitHub inspection confirmed it exists and is merged. HTTP reachability and registered route matching do not establish that every authenticated destination page has been exercised after navigation.

## Coverage boundaries

This is browser and protocol verification, not a native Claude Code Desktop or Codex desktop walkthrough. This session provided no desktop screen-control tool. The MCP checks use the actual SDK handshake with a fixture-backed host; they establish browser bridge behavior rather than native application behavior.

Production approvals, rejections, receipt judgments, launches and resumes were not performed. Their UI and operation contracts were exercised with fixtures and focused tests. The control explorer distinguishes observed clicks from workflow completion: 32 control instances received a deliberate missing-fixture reply, involving receipt detail or resume, and 142 clicks produced no change in its light-DOM observation. The latter include shadow-DOM agent popovers, idempotent controls and unchanged selection state. These observations are retained for inspection, not represented as proof that every production write succeeds. The real receipt-detail read was separately verified.

The gallery is exercised separately from the 15 widget surfaces. The control explorer is bounded to 90 previously unseen control signatures per case; these runs did not reach that limit. Its scenario list includes populated surfaces, stalled/blocked agents, artifact review, decision options, scaffold agreement, and panel option, multiselect, agreement, work, done and signed-out states. It is not an exhaustive combination of every possible payload, permission, network failure and user state.

## Reproduce

Use the repository's pinned pnpm 10.18.1 and install Chromium's headless shell. Build the widgets first, then run:

```sh
pnpm audit:widget-links
pnpm audit:widget-interactions
pnpm audit:widget-gallery
pnpm widget:verify-rendering
pnpm widget:verify-payloads
node scripts/verify-widget-errors.mjs
```

`audit:widget-interactions` accepts `WIDGET_INTERACTION_WIDGETS`, `WIDGET_INTERACTION_STATES`, `WIDGET_INTERACTION_MODES`, `WIDGET_INTERACTION_WIDTHS`, and `WIDGET_INTERACTION_LABEL` for focused rechecks. Its host replies stay local and never forward mutations to OrgX.

Detailed JSON, screenshots, hosted file copies and sanitized real tool results are retained locally under `artifacts/qa/full-widget-audit/`, `artifacts/qa/widget-links/`, `artifacts/qa/widget-interactions/`, and `artifacts/widget-gallery/current/`. Live payloads are intentionally excluded from the public repository. The combined control summary uses the successful rechecks in place of the three tutorial-covered cases, retaining all 104 unique cases.

The production snapshot was checked against source baseline `5b74f49`. The scoped destination repair is a local follow-up until its PR is merged and deployed; it must not be described as already live.
