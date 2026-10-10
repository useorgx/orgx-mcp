# OrgX panel: receipts that would not read, and a speed pass — 2026-10-10

Two reports from a phone after the detail pass shipped: Done › Work still
said "Work receipts could not be read right now", and the whole panel felt
slow. This note records what each turned out to be and what changed.

## Receipts: the ledger refused what the panel allowed

Calling `orgx_list_work_receipts` through the same server from a connector
session with no selected workspace returned:

    Select an authenticated workspace before using the receipt ledger.

while `orgx_get_workspace_context` on the same session resolved a workspace
fine. The receipt tools took the workspace from `sessionContext.workspaceId`
only; the panel's own reads infer the authenticated workspace when nothing
is selected (`inferSessionWorkspace`). A ChatGPT session usually has nothing
selected, so the panel could draw its snapshot and then fail every ledger
read beneath it.

Two changes, either of which alone fixes the panel:

- `src/index.ts`: the receipt tools resolve the workspace the way every
  other read does: the caller's `workspace_id`, else the session's, else the
  inferred one.
- `panel-app.js`: every ledger read (`orgx_list_work_receipts`,
  `orgx_get_work_receipt`, the "work behind this merge" lookup) names the
  panel's workspace, since the panel always knows it.

## Speed: where the time went

Measured in Chromium with a 390×736 view and a 4× CPU throttle (a
mid-range phone), on the gallery's "merges" state, with the ChatGPT phone
profile.

| | Before | After |
| --- | --- | --- |
| Tab switch, Needs you → In progress | 732 ms | 242 ms |
| Tab switch, → Done | 596 ms | 117 ms |
| Tab switch, → Start | 601 ms | 146 ms |
| Tab switch, → Needs you | 604 ms | 198 ms |

A CPU profile of three tab switches put 747 ms of the 2,965 ms sampled in
the browser's own work (`(program)`), almost all of it the document view
transition snapshotting the whole page twice per switch, and 71 ms in
`focus()` forcing layout. Switching the transitions off on the phone profile
alone took the switches from ~600 ms to 115–230 ms, so that is what shipped:

- **No document view transition on phones and touch devices.** The CSS
  enter animation on the incoming view (`.pn-enter`, already the
  reduced-motion path) keeps the direction and the feel at a tenth of the
  cost. Desktop hosts keep the view transitions.
- **Focus without scrolling** (`focus({ preventScroll: true })`) on tab
  focus, focus restoration after a render and `focusFirst`.
- **The viewer's time zone is read once.** `Intl.DateTimeFormat().resolvedOptions()`
  cost 50 ms on startup and 16 ms per switch; it was called for every time
  shown.
- **In progress and Done › Work warm up in the background** once the first
  snapshot is painted and the browser is idle, so the first tap on either
  tab lands on content instead of a skeleton. One read per range at a time:
  a tap that lands while the warm-up is in flight waits for it instead of
  reading again.
- **A lesser read leaves the decide-here tokens alone.** The warm-up
  surfaced this: a read whose result carries no approval metadata used to
  wipe the tokens the first snapshot brought, and the decision's footer fell
  back to "Decide in OrgX". The host's first result still decides whether
  this host can decide here at all; later reads replace the tokens only when
  they bring their own.
- **Shared scripts serve from cache.** ChatGPT loads the panel's two dozen
  shared scripts and styles from this origin one by one, and every one was
  `max-age=0, must-revalidate`: two dozen round trips before first paint on
  every open. `/widgets/shared/*` now serves from cache for five minutes and
  stale-while-revalidate for a week; a deploy shows on the open after it
  lands. The URLs carry no version, so nothing is marked immutable.

## Not done, with the number that argues for it

The startup profile puts 275 ms in parsing and 180 ms in evaluating
`shared/mcp-apps-sdk.umd.js` (315 KB, 74 KB gzipped) at the 4× throttle.
The panel asks for the MCP Apps bridge even when `window.openai` exists
(`bridge: 'mcp-apps-sdk'` in `initWidget`, so it can read MCP Apps host
context), which means ChatGPT really does route tool calls through that SDK
today. Dropping it from the ChatGPT page would be the single largest
startup win left, but it changes which bridge production uses in ChatGPT,
and that needs a check in the real app rather than a profile. Left for a
pass of its own.

The other startup hotspot is inside the vendored UI kit: the footer
element's fit check (`#x` in `ox-elements-footer.js`) spent 145 ms on
startup measuring `scrollHeight` and `clientWidth` on every render and
resize. That belongs in the kit.
