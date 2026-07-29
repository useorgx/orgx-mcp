# Widget control-surface redesign — 2026-07-28

## Scope and truth boundary

This pass redesigns five local MCP widget surfaces:

| Entry point | Family | Type | Mode | Attention | Primary user | Journey move | Data / action owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/widgets/artifact-review.html` | MCP widget | Action | Escalation | Needs You | Reviewer | Prove / Decide | Artifact payload / `orgx_act`, `orgx_decide` |
| `/widgets/task-spawned.html` | MCP widget | State | Command | Progressing | Operator | Execute / Continue | Spawn payload / deep link only |
| `/widgets/search-results.html` | MCP widget | State | Readout | Progressing | Returning operator | Orient / Continue | Search payload / result navigation |
| `/widgets/decisions.html` | MCP widget | Action | Escalation | Needs You | Operator | Decide / Execute | Decision queue / approve and reject tools |
| `/widgets/index.html` | Internal/dev | State | Command | Complete-Idle | Builder / reviewer | Prove | Static widget registry / preview controls |

Evidence in this document is local fixture evidence unless explicitly labeled
otherwise. It does not prove merge, deployment, production payloads, or real
operator outcomes.

## Existing / new / missing

### Existing

- Shared widget runtime already owns ChatGPT, MCP Apps, standalone, theme, size,
  tool-call, navigation, and persisted-state behavior.
- Every target has a populated demo. Search, task, and decisions already expose
  a loading fixture; the gallery can switch demo/loading/empty.
- Decision and artifact actions already have inline mutation paths.

### New in this pass

- Artifact Review becomes a compact review desk: evidence and consequence share
  the first fold, the preview can expand, and review status replaces decoration.
- Task Spawned becomes a dispatch receipt: owner, route, proof link, and live
  state form one scan line instead of nested metadata cards.
- Search Results becomes a compact ranked result stack with one leading match,
  two quiet follow-ups, and a small continuation rail.
- Decisions shows one consequential decision at a time, with supporting evidence
  behind a disclosure and a compact queue rail.
- The gallery becomes a single workbench with search, widget/state/theme/
  viewport controls, one live preview, and a compact catalog drawer.
- Deterministic loading, empty, degraded/error, urgent, long, and resolved
  fixtures are addressable through query state where applicable.
- Pending, success, error, disclosure, keyboard, focus, and reduced-motion
  feedback are explicitly designed.

### Still outside this pass

- Production telemetry and live operator outcome evidence.
- Changes to server payload schemas or MCP tool contracts.
- Full application routes behind widget deep links.

## Live initiative artifact-viewer contract

The authenticated `/live/[initiativeId]` viewer in `Code/orgx/orgx` is the
reference product, but it is not copied wholesale into the widget. The portable
contract is:

| Live viewer behavior | Widget adaptation | Why it belongs |
| --- | --- | --- |
| Content-first renderer routing | Prefer image, video, diff, code, readable document, then structured data | The artifact should read like the deliverable, not a database row |
| Score, threshold, eval state, and completion impact | A compact Evidence view states Cleared, Held, Pending, or Not scored and names the next consequence | Approval authority must not outrun verification evidence |
| Producer, source, reviewer kind, and review status | A provenance readout distinguishes named human review, policy auto-approval, anonymous recorded review, and no review | Raw identities and system approvals must not masquerade as human sign-off |
| Preview / history separation | Preview remains first paint; Evidence and History are progressively disclosed in the same frame | The widget keeps the live viewer's information model without importing its page weight |
| Recovery and private/public boundaries | Errors preserve the review boundary; internal raw JSON is never exposed in the widget | A compact embedded surface should fail honestly and reveal no unnecessary internals |

The widget intentionally does not import the live viewer's raw metadata tab,
PDF export, eval-configuration sheet, visual-proof completion form, decision
drawer, or multi-artifact pager. Those require full application context and
would turn the widget back into a dense miniature page.

Acceptance additions:

- A verification block disables approval and points the reviewer to the live
  initiative surface without inventing a widget-side eval mutation.
- Preview routing covers visual, video, diff, code, document, and structured
  payloads, with readable content winning over metadata.
- Evidence and History views use real tab semantics and keyboard navigation;
  version rows are history, not inert controls pretending to change versions.
- The live route uses the initiative deep link when `entity_type` is
  `initiative`, preserving the selected organizational context.

## Single-glance contracts

| Surface | Two-second question | Dominant signal | Primary action | Quiet / urgent behavior | OrgX-only move |
| --- | --- | --- | --- | --- | --- |
| Artifact Review | What needs my sign-off, and what evidence am I judging? | Artifact name + review consequence beside the evidence | Approve artifact | Resolved compresses to receipt; review expands the action edge | Evidence/action split with amber edge-light and hold progress |
| Task Spawned | Was work actually dispatched, to whom, and where can I follow it? | Dispatch receipt: task + owner + live state | Open execution | Healthy stays two compact bands; degraded context opens a sync notice | A live route spine connecting owner, execution surface, and proof |
| Search Results | Which result is the right organizational answer? | Top match + why it matched | Open top result | Weak/empty results collapse into a recovery prompt | Ranked memory spine with confidence as signal, not badge decoration |
| Decisions | What judgment blocks execution now? | Selected decision + consequence | Approve path | Only selected decision expands; queue remains compressed | Urgency reshapes one decision while the rest become a queue rail |
| Gallery | Can I find and exercise any widget state quickly? | Selected widget identity + live preview | Open preview | Catalog collapses when previewing; errors stay in the workbench | Instrument-style state matrix controlling one production-faithful frame |

## Layout alternatives considered

1. **Equal preview cards / queue cards.** Rejected because it preserves the
   current equal-volume hierarchy and multiplies borders, controls, and scroll.
2. **Tabbed detail panels.** Rejected because tabs hide the urgent action and
   make search and gallery selection feel like generic SaaS navigation.
3. **Selected operating surface + compressed rail.** Chosen. One artifact,
   result, decision, or widget is dominant; the remaining context becomes rows,
   a rail, or a disclosure. This preserves consequence while reducing height.

## State contract

Each target must render loading, empty, populated, long, degraded/error,
urgent/Needs You, and resolved/idle where meaningful. Loading skeletons mirror
the final geometry and use one shimmer. Actions acknowledge within 400ms,
disable double activation, preserve recoverable input, and expose textual
pending/error/success states. Reduced motion removes transforms and shimmer
without hiding state.

## Acceptance evidence

- Render and inspect 1440px, 768px, and 375px in light and dark.
- Inspect 200% zoom, long labels, keyboard order/focus, reduced motion, and no
  horizontal overflow.
- Exercise every deterministic state fixture for the five changed surfaces.
- Run targeted widget contract tests, MCP Apps/ChatGPT/standalone render checks,
  theme audit, full repository verification, and the complete test suite.
- Score each surface with the OrgX scorecard; total must be at least 85,
  hierarchy at least 90%, signal clarity at least 80%, and distinctiveness at
  least 80%.

## Final local evidence

- `widget:audit-redesign`: **184 / 184** deterministic state and contract cases
  passed across light/dark and 1440px, 768px, and 375px. The added artifact
  contract cases cover diff, structured data, video, neutral unscored evidence,
  and policy auto-review in both themes.
- Theme/viewport sweep: **96 / 96** cases passed across every public widget,
  both themes, desktop/tablet/phone, and 200% zoom. **0 / 96** cases contain a
  visible target below 44px; no horizontal overflow or sampled rendered-text
  contrast failure remained.
- Host rendering: **60 / 60** standalone, MCP resource, and ChatGPT cases
  passed at 1280px and 375px.
- Focused widget tests: **36 / 36** passed.
- Repository verification: TypeScript, **218 / 218** MCP contract tests
  (1 skipped fixture), widget build, and SDK build passed.
- Full suite: **835 / 835** tests passed (1 skipped fixture).
- Screenshot evidence:
  `/Users/hopeatina/.codex/visualizations/2026/07/28/019fa8ec-9deb-73b0-be52-9003c37191b1/widget-redesign-merged-scope`
  and
  `/Users/hopeatina/.codex/visualizations/2026/07/28/019fa8ec-9deb-73b0-be52-9003c37191b1/widget-theme-merged-scope`.

The live initiative viewer was source-inspected in the current
`Code/orgx/orgx` checkout. This pass does not claim authenticated production
rendering of that application route; the screenshots above are deterministic
MCP-widget fixture evidence.

## OrgX scorecard

Scores are local rendered judgments, supported by the automated measurements
above. Each sub-score is a percentage before weighting.

| Surface | Signal | Hierarchy | Action | Distinctive | Quiet | Motion | Access | Discipline | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Artifact Review | 95 | 94 | 96 | 92 | 91 | 92 | 98 | 96 | **94.15** |
| Task Spawned | 96 | 95 | 88 | 92 | 96 | 90 | 98 | 96 | **93.80** |
| Search Results | 96 | 94 | 89 | 88 | 95 | 90 | 98 | 96 | **93.05** |
| Decisions | 98 | 96 | 98 | 94 | 92 | 94 | 98 | 96 | **96.10** |
| Widget Gallery | 96 | 94 | 94 | 88 | 93 | 90 | 98 | 96 | **93.60** |

All surfaces clear the 85 total gate, 90 hierarchy gate, 80 signal gate, and
80 distinctiveness gate. OrgX artifact quality scoring is not claimed because
this local review document was not submitted as an OrgX artifact. Merge,
deployment, production payload behavior, and observed operator outcomes remain
separate future evidence layers.
