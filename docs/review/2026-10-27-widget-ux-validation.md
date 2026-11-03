# Widget UX review: validation record

October 27, 2026. Companion to [the component review](2026-10-27-widget-ux-audit.md).

| Check | Result | What it establishes |
| --- | --- | --- |
| Existing render sweep | 160 cases; zero reported failures | Current fixture rendering across desktop, tablet, phone and reduced motion, within this harness's assertions |
| Existing cross-host interaction sweep | 112 cases; 15 widgets; 1,680 controls; 56 contract assertions; 240 navigations; zero click failures/page errors | Local ChatGPT and MCP Apps fixture-host behavior for covered controls |
| Focused Vitest suites | 7 files; 84 tests passed | Existing state, receipt, race, time, disclosure, explorer and proof tests |
| Additional capture matrix | 86 captures; zero page exceptions or document horizontal overflows | Current 800px and 375px local states; screenshot acceptance caveats below |
| Receipt list/detail flow | Four additional captures reached through actual tab and row clicks | Loaded list/detail presentation rather than the gallery's direct-Done skeleton |
| Adapted delayed-read scenario | Four light/dark, 800/375 cases passed; initial feedback about 12–26ms locally | Coalescing, stale-response suppression, read failure/retry and preserved content under synthetic delays; no write calls |
| Targeted data probes | F01, F02, F06 and F07 reproduced | Lossy mixed-state grouping, Unverified→Verified, calendar-date shift and hidden exception pips |
| Ledger keyboard probes | Focus retained after explorer entry and filtering | Avoids claiming a suspected focus bug that did not reproduce |
| Live read-only data | Operator brief, 30d; receipt list, 120d, same authorized validation workspace | Real returned payload differences; not representative production coverage |

The interaction sweep reports **182 unresolved observations**, including **32 fixture refusals**. They are not converted into either passing behavior or confirmed product bugs. Counts by widget: Agent Status 32; Artifact Review 8; Decisions 32; Morning Brief 14; Org panel 44; Proof Receipt 4; Scaffolded Initiative 36; Search Results 8; Task Spawned 4. Examples include avatar popovers whose changes are inside shadow DOM, already-selected rows, filter controls where the generic probe observed no semantic change, and unavailable synthetic responses for receipt detail/resume. Plan Session Live had zero exercised controls in its hosted fixture; its specific guidance workflow remains unverified by this sweep.

The broad render sweep tests 12 widgets rather than deriving the full set from the manifest. The cross-host sweep supplies all 15, and the additional capture matrix supplies the panel's expanded state coverage. A zero-failure render report alone therefore does not prove complete interaction coverage.

The fast additional captures for Decisions at 800px and 375px were transient and rejected; the report uses stable render-sweep screenshots. Direct `gallery=true&state=done` showed a skeleton and was rejected as a loaded Work receipt state. The accepted Work receipt captures were reached by clicking Done and a receipt. Loading states intentionally captured as such remain valid evidence of their loading design. The streaming scaffold image represents one timed demo phase only.

Two pre-existing panel scripts failed on their original assumptions. `audit-panel-read-interaction.mjs` counted warm-up reads as the first focused read. `audit-panel-experience.mjs` did not reach its expected “Allowed once” confirmation with the current fixture/initialization behavior. An initial adaptation of the read script then hit the first-use tour overlay. These are recorded as harness/coverage limitations, not proof of a production write defect. The successful audit-local copy routes background reads separately, suppresses the tour as a returning user, and checks that the scenario performs no writes. Product files and checked-in test scripts were not changed.

## Reproduction commands

The following checks can be reproduced from the repository root with the installed Node dependencies and Playwright Chromium:

```sh
node scripts/audit-widgets.mjs --label=ux-deep-pass-2026-10-27
WIDGET_INTERACTION_LABEL=ux-deep-pass-2026-10-27 node scripts/audit-widget-interactions.mjs
node node_modules/vitest/vitest.mjs run tests/panelInteractionState.spec.ts tests/panelReceipts.spec.ts tests/panelOutputSummaryRace.spec.ts tests/workLedgerExplorer.spec.ts tests/widgetTime.spec.ts tests/widgetDisclosureUx.spec.ts tests/proofReceiptWidget.spec.ts
```

The additional audit-local `capture.mjs`, `probes.mjs` and `read-interaction-current.mjs` are not included in this documentation PR; they require the saved live brief JSON or local audit fixtures. Their result summary is included in [validation-summary.json](assets/widget-ux-2026-10-27/validation-summary.json). They block outbound HTTP and simulate host methods. The grouping/tier probe uses a constructed payload to isolate an edge case; it is not a claim about a specific live receipt.

## Included evidence

The 53 screenshots linked by the review are committed in [`assets/widget-ux-2026-10-27/`](assets/widget-ux-2026-10-27/), together with a compact validation summary. They include synthetic fixture screens and local rendering of the validation workspace summary. Raw live payloads are excluded.

## Local run artifacts (not included in the PR)

- Live inputs: `artifacts/qa/ux-deep-pass-2026-10-27/live-brief.json`, `live-receipt-list.json`.
- Additional matrix and text/geometry/control diagnostics: `artifacts/qa/ux-deep-pass-2026-10-27/captures.json` and `screens/`.
- Targeted reproductions: `artifacts/qa/ux-deep-pass-2026-10-27/probes.json`.
- Delayed-read screenshots and measurements: `artifacts/qa/ux-deep-pass-2026-10-27/transitions/`.
- Interaction results and unresolved controls: `artifacts/qa/widget-interactions/ux-deep-pass-2026-10-27/results.json`, `summary.json`.
- Existing render results: `artifacts/widget-audit/2026-07-17/ux-deep-pass-2026-10-27/report.json`. The July date is a hardcoded directory in the script; the results were generated October 27.

The original full run captures, live payloads and run scripts remain local, ignored QA artifacts. This PR includes the two review documents, the 53 referenced screenshots and the compact validation summary; it changes no product or test implementation. The review is evidence-backed for the checkout and the returned payloads, with no claim of deployed-version parity, production mutation success, production latency, measured CLS or complete accessibility compliance.
