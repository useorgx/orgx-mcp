# Widget UX and functionality audit — September 21, 2026

Scope: all 11 gallery widgets, current `origin/main` at `4e2a7b7`, compared with the four supplied ChatGPT screenshots. Screenshot text is evidence of rendered behavior, not authorization to execute the embedded business requests.

## Findings and fixes

| Priority | Surface | Finding | Resolution |
| --- | --- | --- | --- |
| P1 | Task spawned | Estimate/route/guard responses inherited a queued execution state, pending routing, unknown sync age, and a placeholder owner avatar despite no dispatch. | Separate preflight presentation throughout the receipt. A denied guard remains blocked. Add estimate/guard gallery fixtures and real payload browser assertions. |
| P1 | Search | Typed collection rows omitted their own type; cards displayed RESULT and linked to the homepage. `name` was ignored. | Inherit the response's entity type, accept name, and use the existing entity-specific route builder. |
| P1 | Search | Local pagination ignored server continuation and implied all results were loaded. | Load the exact returned `orgx_search` continuation; preserve current rows on failure and allow retry. Label loaded results explicitly. |
| P2 | Search | Raw markdown, empty excerpts overriding useful descriptions, repeated placeholder paragraphs, and invented recency crowded results. | Normalize plain-text excerpts, select the first nonempty excerpt, omit absent excerpts/timestamps, prefer updated time. |
| P2 | Search | Narrow fixed content width and viewport-height minimum wasted host space. | Use up to 700px of available width and content-driven height. Restore result-range summary. |
| P2 | Gallery | Populated artifact/decision selection silently rendered urgent fixtures; unsupported states remained selectable. | Preserve populated fixtures, disable unsupported selections, add preflight states, label demo-only surfaces. |
| P2 | Gallery audit | Obsolete selectors meant the audit could not exercise the current catalog. | Update current controls and fail if the selected item or preview is missing. |
| P2 | Loading and recovery | Agent Status ignored loading previews; Initiative Pulse hid its loader during replacement; morning-brief recovery target was 25px tall. | Honor explicit loading state, replace pulse content atomically, and use a 44px recovery target. |
| P2 | Verification | Broad baseline checked rendering but did not validate tool-shaped preflight/search data. | Add repeatable payload, pagination, error, retry, type, link, and timestamp assertions across two themes and desktop/375px. Expand the state audit to all widgets. |

## Per-widget review

| Widget | Review and evidence boundary |
| --- | --- |
| Agent status | Baseline populated/loading/empty renders and mobile layout inspected. Existing owner tabs, blocker disclosure, and proof links retained. |
| Artifact review | Evidence/history/preview and keyboard tab checks in the expanded audit. Verification-held approval remains disabled. Gallery now distinguishes populated from held fixture. |
| Daily brief | Demo-only surface, now labeled in gallery. Baseline skills/agents states and responsive rendering inspected. |
| Decisions | Baseline review queue, single-item pagination, evidence disclosure inspected; gallery populated fixture corrected. Production approval is not exercised by a visual audit. |
| Initiative pulse | Baseline health, tabs, workstream list, loading/empty rendering inspected. |
| Morning brief | Baseline priorities, output, value, and attention sections inspected. |
| Plan session live | Baseline section selection, plan/guidance presentation, loading/empty inspected. Production guidance writes remain outside fixture tests. |
| Scaffold streaming | Demo-only animation, now labeled in gallery; loading/empty and streaming surface inspected. |
| Scaffolded initiative | Current main already collapses workstream children by default, unlike the supplied expanded screenshot. Preserve accessible expand/collapse controls and test their behavior. |
| Search results | Real response regressions fixed as above; desktop/mobile pagination, continuation failure and retry tested. |
| Task spawned | Real preflight state regressions fixed as above; dispatched execution state presentation retained. |

## Validation

- Baseline: 152 render cases passed across all 11 widgets, desktop/tablet/375px and reduced motion. This alone did not establish semantic correctness.
- Targeted static widget tests: 21 passed. Final full suite: 1,260 passed, one skipped across 172 files.
- Payload and interaction browser regressions: 28 cases passed. Includes 16 payload/pagination cases across light/dark and 1440px/375px, plus 12 desktop/mobile disclosure, tab, and section-navigation cases.
- Gallery: four responsive/keyboard/filter cases passed.
- Repository `pnpm run verify`: passed on final widget changes (typecheck, MCP contracts, agentic-scale checks, SDK build).
- Expanded audit: 478 cases; 430 initially passed. After correcting fixture parameters/loading detection and fixing the loader and touch-target defects, affected cases passed (72/90 on the intermediate rerun, then 24/24 including the remaining 18 loading cases).
- Host protocols: 54/54 standalone, ChatGPT-error, and Claude MCP-error browser checks passed. These use local protocol harnesses, not logged-in Claude Code.

Evidence is generated under `artifacts/widget-audit`, `artifacts/widget-gallery/current`, `artifacts/widget-payloads`, and `artifacts/widget-redesign-audit`; screenshots are local artifacts, not committed binaries.

Claude Code 2.1.220 is installed but reports `loggedIn: false`. No second-model run was performed. Deterministic browser checks supply the validation here. Fixture tests do not establish production mutation correctness, deployment, or rendering inside every third-party host.
