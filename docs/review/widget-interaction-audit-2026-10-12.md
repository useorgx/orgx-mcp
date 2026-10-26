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
| Full suite and affected-file rechecks | Full two-worker run: 4,064 passed, one stale call-count assertion failed, two skipped; the assertion was corrected and all 62 tests in the four affected files passed | Verified after targeted rechecks |
| Type checking and widget build | TypeScript; regenerated inline runtime, manifest and build version | Passed |

The initial control runs exposed runner problems rather than additional confirmed product defects. The gallery flag deliberately disables host handoff, so host tests now use actual host payloads and assert the detected protocol. Menus are closed with Escape before clicking controls underneath them. A delayed first-use tutorial covered three mobile MCP panel cases; those cases were rechecked successfully with the returning-user tutorial state. The initial failing traces remain in local evidence alongside the successful rechecks.

The default-concurrency full test run passed 4,061 tests and failed four timing/async checks. A two-worker run passed 4,064 and exposed one stale snapshot call-count assertion. The panel fixtures now count the relevant focus, recovery, receipt, or workspace calls rather than unrelated tab-warming reads. All four affected test files subsequently passed (62 tests). GitHub validation passed on the first PR revision; follow-up fixture and report changes receive their own validation run.

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

## Local reconciliation — 26 October 2026

The results above record the original 12 October audit. This follow-up preserves both draft PR #524 commits through `e85c76694b973b76a26e95088fc8d8559fd96681` and merges main at `0aba3a6da2c390e3392f30720d26d8150fad3742`. It retains the scoped Decisions links, workspace `center` parameter, gallery checks, panel recovery fixtures, and interaction command. Main's later session-link and question/item behavior is retained, including the exact rendering assertion “No results on this page”. The manifest, inline runtime, theme, and build version are generated from those canonical sources.

The payload verifier now checks both allowed and blocked preflight results and rejects six deliberately invalid local fixtures: queued and in-progress executions with misleading no-start titles, a queued footer, a tool-call effect, a navigation effect, and a footer with its visible shadow content removed while its attributes remain unchanged. It also checks the selected agent's identity and current `aria-pressed` semantics.

The interaction harness adds question and item-review flows against the maintained gallery fixtures. These assert required choices, the selection maximum, review/back/edit persistence, trimmed answers, exact per-item notes and verdicts, the approval token, and a single judgment for repeated intent while a fixture response is pending. These are business-contract checks reported separately from the general control explorer's observed clicks.

The final results below use a physically independent dependency installation, Node 22.22.0, and pnpm 10.18.1. Earlier diagnostic checks under the restored runtime's Node 24.19.0 are retained locally and are not the final pinned evidence. Browser traffic is restricted to local servers and fixtures. Canonical widget/avatar assets requested under the MCP origin are supplied from this checkout when needed; other off-origin requests are aborted before transmission. Host tool replies and writes remain fixtures. These checks establish local behavior; this follow-up makes no new claim about hosted files, production writes, native desktop clients, authenticated destination pages, or deployment of this candidate.

| Check | Fresh local result |
| --- | --- |
| Full suite, two workers | 325 files passed, one file skipped; 4,422 tests passed, two skipped; exit 0 |
| Payload, pagination, disclosures and no-dispatch negative controls | 38 cases passed |
| Resource rendering | 92 of 92 cases passed |
| Error presentation, overflow and recovery | 132 cases passed |
| Gallery | Four viewport/theme/motion cases, all 15 catalog entries, no failures |
| Returning-user links and host handoff | 180 cases, 15 surfaces, 574 clicks; standalone, ChatGPT, SDK adapter, and stalled-SDK/ChatGPT fallback; no failures |
| Returning-user control and business-contract exploration | 112 cases, 15 surfaces, 1,680 controls, 240 opens and 56 named contract groups; dark theme, 1100px/375px, ChatGPT and real MCP SDK/JSON-RPC; no click or page failures |
| Type checking and build | TypeScript and SDK build passed; regenerated widget assets and build version |

The two full-suite skips are the opt-in live provider-selection test and the isolated Redis Unix-socket test. This local follow-up did not enable either. Existing first-use tour coverage remains in the passing suite: `panelPhoneChrome.spec.ts` clears the tour storage key and taps all four Next controls against both simulated phone-chrome variants; `panelV2.spec.ts` verifies that the tour's practice and dismissal write no judgments. The returning-user link and interaction matrices do not establish every first-use-tour-plus-navigation combination.

The first link run retained one timeout when the panel's delayed first-use tour overlapped a discovered link. The link explorer now initializes the same explicit returning-user state as the interaction explorer, with actual clicks, exactly-one-open checks, and route/query assertions retained. Two earlier scratch transport runs aborted canonical photo requests and returned a guard failure after all 38 payload assertions passed. The final wrapper supplies those checked-in photos locally. The failed runs are retained under `artifacts/qa/reconcile-524/` alongside final command logs and transport records.

The eight question/item scenarios contribute 96 actions and all 56 named contract groups. The general explorer retains 180 unresolved observations: 32 intentional missing-fixture replies for receipt-detail/resume and 148 unchanged light-DOM observations. They are not successful workflow-completion assertions. No scenario reached the 90-control exploration bound; the maximum observed was 42. Detailed final evidence is in `artifacts/qa/widget-interactions/reconcile-524-full-node22/`, `artifacts/qa/widget-links/reconcile-524-returning-node22.json`, and the command logs under `artifacts/qa/reconcile-524/`.
