# Widget gallery design brief — 2026-07-17

- **Family:** internal/dev and public-proof support surface.
- **Type / mode:** State surface in Command mode.
- **Primary user:** OrgX operator, designer, reviewer, or MCP host integrator.
- **Two-second question:** Which widgets exist, and how does the selected widget behave in the state and viewport I need to verify?
- **Journey move:** Prove. The gallery shortens the path from widget implementation to inspectable state evidence.
- **Data owner:** generated `public/widgets/_manifest.json`, reconciled with the gallery metadata registry.
- **Action owner:** one gallery controller owns selected widget, fixture state, viewport, and theme in URL query state.
- **Dominant signal:** selected widget rendered at the requested state and viewport.
- **Primary action:** open the exact selected preview in a standalone tab.
- **Healthy compression:** unselected widgets collapse to compact registry rows.
- **Urgent expansion:** urgent/degraded fixture states become the selected preview rather than adding alert chrome to the gallery.
- **OrgX-only move:** one matte-instrument workbench with a signal rail, not an equal-card dashboard; the selected surface receives the edge-light and all detail.
- **Proof:** every manifest widget appears once, every supported fixture state is selectable, selection survives reload/share, and desktop/tablet/phone plus keyboard/reduced-motion checks pass.

## State model

- Gallery: loading manifest, complete registry, filtered/no-match, manifest degraded.
- Preview: populated, loading, empty, plus widget-specific long, urgent, resolved, idle, and alternate-lens fixtures.
- Viewport: wide, tablet 768px, phone 375px.
- Theme: light and dark, propagated into the preview URL.

## Rejected structures

1. **Retain the equal-card grid and add missing cards.** Rejected because coverage would improve while the page would remain noisy, repetitive, and disconnected from the actual preview job.
2. **A large thumbnail gallery.** Rejected because thumbnails cannot prove loading, urgent, responsive, focus, or interactive behavior.
3. **Selected registry rail + live workbench.** Chosen because it keeps all surfaces discoverable while one operational question dominates at a time.

## Implemented registry

The workbench surfaces every generated widget except the gallery itself:

1. Pending decisions
2. Agent status
3. Search results
4. Scaffolded initiative
5. Initiative pulse
6. Task spawned
7. Morning brief
8. Artifact review
9. Plan session live
10. Daily brief + trust loop
11. Scaffold stream harness

Each row carries the two-second question and mode. The selected detail exposes the exact tool binding, MCP resource URI, manifest hash/size, supported fixture states, theme, and viewport. Daily Brief is labeled `Registered · binding pending`; Scaffold Stream is labeled `Development harness` so prepared and production-bound states are not conflated.

## Verification

- `pnpm audit:widget-gallery`: 4 rendered viewport/theme cases, 0 failures.
- Viewports: 1440px desktop, 768px tablet, 375px phone, plus desktop reduced motion.
- Coverage: 11/11 manifest surfaces, manifest mismatch warning absent.
- Interaction: filter contract, Arrow-key registry navigation, visible focus, URL-restored selection, state switching, viewport switching, theme propagation, and standalone preview link.
- Geometry: 0 page-level overflow and 0 targets below 44px.
- Runtime: 0 gallery console errors and 0 page errors.
- Focused widget contracts: 28/28 tests passed across manifest, resource, primary-palette, and shared-inline coverage.
- Screenshots and report: `artifacts/widget-gallery/2026-07-17/final/`.

## Scorecard

| Dimension | Score | Weighted |
|---|---:|---:|
| Signal clarity | 94 | 23.5 / 25 |
| Hierarchy / glanceability | 94 | 18.8 / 20 |
| Actionability | 92 | 13.8 / 15 |
| OrgX distinctiveness | 90 | 13.5 / 15 |
| Quiet-state composure | 93 | 9.3 / 10 |
| Motion / interaction | 90 | 4.5 / 5 |
| Accessibility / legibility | 95 | 4.75 / 5 |
| Implementation discipline | 95 | 4.75 / 5 |
| **Total** |  | **92.9 / 100** |

Hierarchy and distinctiveness both clear their required sub-gates.
