# MCP Apps runtime verification

Verified locally on 2026-07-16 against the built widget bundle.

## Contract gates

- Widget build passed for all 12 surfaces: 11 host-backed widgets are `official-sdk`; the gallery is intentionally `standalone`.
- Full TypeScript check and 36 focused runtime, bridge, manifest, inlining, link-helper, metadata, and decision-contract tests passed.
- The build rejects a host-backed widget that loads only one half of the SDK/runtime pair, uses direct host `postMessage`, or calls host tool/link methods outside the shared runtime.
- Decision actions call the server tool before publishing widget/model context. Host-backed state covers the open feedback panel, drafts, page, widget session, and last resolution.

## Browser gates

- The gallery rendered at desktop and 375px without horizontal overflow or page errors.
- All 11 host-backed widgets rendered their demo/data state at 375px without horizontal overflow: Agent Status, Artifact Review, Daily Brief, Decisions, Initiative Pulse, Morning Brief, Plan Session Live, Scaffold Streaming, Scaffolded Initiative, Search Results, and Task Spawned.
- Decision revision opened, accepted a draft, and remained fully usable at desktop and 375px. All visible controls and links met the 44px interaction-target check; decision links and pagination controls were raised to that bar during verification.

## Evidence

- `widget-gallery-desktop.png`
- `widget-gallery-mobile-375.png`
- `decisions-revision-desktop.png`
- `decisions-revision-mobile-375.png`
