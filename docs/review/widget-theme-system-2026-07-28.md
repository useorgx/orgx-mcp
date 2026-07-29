# Widget theme system review — 2026-07-28

## Outcome

The twelve public OrgX widgets and the two generated live widget templates now
share one semantic light/dark contract. Explicit URL or MCP host theme wins over
OS preference, system preference remains the standalone fallback, and live host
theme changes update an already-mounted widget.

The implementation preserves each widget's domain accent while separating the
accent used for identity, the accessible foreground, and the primary-action
fill. Legacy `app-color-*` components now resolve through the same semantic
tokens, preventing OS media queries from overriding an explicit host theme.

## Surface inventory

Public gallery and resource widgets:

- agent status
- artifact review
- daily brief
- decisions
- widget gallery
- initiative pulse
- morning brief
- live plan session
- scaffold streaming
- scaffolded initiative
- search results
- task spawned

Generated templates:

- live feed widget
- scaffold widget

## Modes and accessibility

- Light and dark define independent surface, text, border, control, focus,
  status, skeleton, placeholder, and shadow behavior.
- Lime, teal, iris, amber, and neutral accents retain canonical identity RGB
  while using accessible visible foregrounds.
- Reduced motion removes animation without dimming controls; only a frozen
  spinner mark is softened.
- Quiet controls do not paint decorative glints, including full-width mobile
  links.
- Every visible interactive target in the rendered matrix is at least 44px in
  both dimensions.
- The plan loading skeleton exposes a live status label in ChatGPT and other
  data-waiting hosts.
- Forced-colors focus treatment is defined in the shared theme.

## Rendered verification

Fixture proof:

| Matrix | Result |
| --- | --- |
| 12 widgets × light/dark × 1440/768/375/200% zoom | 96/96 passed |
| Explicit theme against opposite OS preference | 96/96 passed |
| Rendered text and semantic token contrast | 96/96 passed |
| Horizontal overflow | 0 failures |
| Visible targets below 44px | 0 |
| Standalone/MCP-resource/ChatGPT × 1280/375 | 60/60 passed |

The contrast audit requires at least 4.5:1 for normal text and checks the
primary-action foreground separately. The lowest semantic normal-text result is
4.92:1; primary-action contrast is at least 6.29:1 for the affected action
palettes.

Screenshots are stored outside the repository at:

`/Users/hopeatina/.codex/visualizations/2026/07/28/019fa8ec-9deb-73b0-be52-9003c37191b1/widget-theme-merged-scope`

That directory contains 48 full-page captures: every widget in light and dark
at desktop and phone widths.

## OrgX design critique

Two-second, squint, and blur tests pass on the representative plan, morning
brief, scaffold, task, decision, and status surfaces. Each retains one dominant
read, quiet metadata, and instrument-panel materiality in both themes.

The OrgX-only moves remain intact: gradient edge signals, compressed operational
metadata, state-led accent rails, governed action zones, and healthy-state
quietness. Theme changes do not flatten domain identity into a generic blue SaaS
palette.

The screenshot pass caught two issues that source inspection did not:

1. Legacy app tokens made morning-brief text follow dark OS preference inside an
   explicitly light host.
2. Transparent quiet-control borders painted a stray edge artifact on
   full-width mobile links.

Both were corrected in the shared layer and re-rendered.

## Scorecard

| Dimension | Score | Weighted |
| --- | ---: | ---: |
| Signal clarity | 94 | 23.50 / 25 |
| Hierarchy / glanceability | 93 | 18.60 / 20 |
| Actionability | 91 | 13.65 / 15 |
| OrgX brand distinctiveness | 88 | 13.20 / 15 |
| Composure in quiet state | 92 | 9.20 / 10 |
| Motion / interaction elegance | 90 | 4.50 / 5 |
| Accessibility / legibility | 98 | 4.90 / 5 |
| Implementation discipline | 96 | 4.80 / 5 |
| **Total** |  | **92.35 / 100** |

Hierarchy is above the 90 redesign gate, distinctiveness is above 80, signal
clarity is above 80, and the total is above the 85 ship gate.

## Repository verification

Pinned validation runtime: Node 22.21.1 and pnpm 10.18.1.

- `pnpm run verify`: passed
  - typecheck passed
  - 31 MCP contract files passed
  - 218 tests passed, 1 skipped
  - production SDK build passed
- full Vitest suite: 126 files passed
  - 829 tests passed, 1 skipped
- focused theme/runtime/widget suite: 7 files passed
  - 47 tests passed

## Evidence boundary

This proves source implementation, deterministic fixtures, local browser
rendering, host-protocol compatibility, typecheck, tests, and build. It does not
prove a commit, PR checks, merge, deployment, or production-host behavior; those
remain separate shipping steps.
