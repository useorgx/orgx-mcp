# 3D Widget Translation Plan

Goal: produce 3D Blender ports of OrgX widgets at >95% visual parity with the
HTML source — and re-port each widget mechanically as the source evolves.

Reference comparison (see `public/widgets-3d/compare_scaffold.png`):

- LEFT: actual `buildScaffoldWidget()` output, populated via `?demo=true`
- RIGHT: current `scripts/blender/scaffold_widget.py` output

## 1. Gap inventory — Scaffold widget

Tracked from the side-by-side. Items grouped by impact.

### A. Missing components (structural — re-render not enough to fix)

| # | Component | HTML | 3D | Notes |
|---|---|---|---|---|
| A1 | Per-card **radial progress ring** | ✅ teal/domain stroke arc with `%` in center, top-right of card header | ❌ | Curve-based annulus or Bevel-Object stroke |
| A2 | **Task rows** (3 per workstream) | ✅ check-circle icon + light text, indented under milestone | ❌ | Need second-tier rows below milestones |
| A3 | **Avatars** (round photos) | ✅ round, photo-textured, domain-colored ring | ❌ flat letter tile | Image texture on disc; photos already in `DOMAIN_AVATAR` |
| A4 | **Domain badge** on avatar | ✅ small circle bottom-right of avatar with domain icon | ❌ | Tiny disc + SVG icon |
| A5 | **Completion banner** | ✅ "✅ 18 entities created successfully" with link | ❌ | Translucent panel + check icon + link |
| A6 | **Eyebrow reticle icon** | ✅ concentric SVG | ❌ live dot only | Import SVG curve |
| A7 | **Card header divider** below WS row | ✅ 1px hairline separating header from milestones | ❌ | Thin emissive strip we already use for shell — apply to cards |
| A8 | **Milestone bracket icon** | ✅ angled bracket SVG | ❌ flat warn-amber square | Import SVG curve |
| A9 | **Task check icon** | ✅ circle outline | ❌ | Import SVG curve |
| A10 | **Footer arrow** in button | ✅ `→` glyph next to label | ⚠️ baked into text | OK as text glyph |

### B. Style fidelity (handle in materials/shaders)

| # | Property | HTML | 3D | Fix |
|---|---|---|---|---|
| B1 | Shell top fade | `linear-gradient(180deg, rgba(primary,.05), transparent 40%)` | ❌ | Vertical gradient via `ShaderNodeTexCoord` + `ColorRamp` |
| B2 | Shell `::after` shine | `linear-gradient(90deg, transparent, rgba(primary,.55), transparent)` | ✅ approximated | Already have it; gradient should fade at sides |
| B3 | Pill bg fill | `rgba(primary,.10)` translucent | ⚠️ emission mix | Use shader with alpha in render layer, drop emission |
| B4 | Pill inset highlight | `inset 0 1px 0 rgba(255,255,255,.05)` | ❌ | Top edge bright bevel via `ShaderNodeBevel` |
| B5 | Card border | `1px solid rgba(255,255,255,.07)` | ⚠️ separate object | Replace with material outline or freestyle |
| B6 | Card resting shadow | `0 28px 56px -24px rgba(0,0,0,.7)` | ❌ relies on lights | Bake AO or ground projection |
| B7 | Active-receive glow | `box-shadow: 0 8px 28px -8px rgba(domain,.14)` | ❌ | Optional — only needed for streaming animation |
| B8 | Status-dot pulse | animated CSS keyframe | ❌ static | Out of scope for static render |
| B9 | Progress fill glow | `box-shadow 0 0 8px rgba(primary,.5)` | ✅ via emission + glare | Tone down glare so it doesn't bloom into other elements |

### C. Geometry / proportions

| # | Item | HTML (px @580 wide) | 3D (current) | Action |
|---|---|---|---|---|
| C1 | Shell radius | 18px | 0.18 (0.36 in normalized = 3.1% of width) | Map: `bevel = px * scale` (1px = 0.01 unit if shell width=5.8) |
| C2 | Card radius | 12px | 0.08 | Same mapping |
| C3 | Avatar radius | 9px | rectangle, no radius | Make rounded (avatar is now a SQUARE in 3D) |
| C4 | Card width | 552px (580 - 14*2) | 5.6 (93% of shell) | Match: 5.52 of 5.80 |
| C5 | Padding | 14px | 0.20 | 0.14 if scale=0.01 |
| C6 | Card height (1ms + 3 tasks) | ~146px | only 1.42 (no tasks) | Recompute with task rows |

### D. Typography

| # | Item | HTML | 3D | Action |
|---|---|---|---|---|
| D1 | Title font | Inter 700 | Helvetica + fake bevel-bold | Install Inter; use real bold face |
| D2 | Mono font | JetBrains Mono | SFNSMono | Install JetBrains Mono |
| D3 | Title size | clamp(15-20px) → ~20px @580 | 0.32 (≈32px) | Halve to 0.20 (with scale=0.01) |
| D4 | Mono labels | 0.54-0.62rem (~7-8px @ 13px base) | 0.10-0.13 | Same scale fix |
| D5 | Letter spacing | mono labels: 0.16em | not modeled | `text.data.space_character` |

### E. Color palette (current 3D)

All match the source `:root` token block in `src/scaffoldWidget.ts`. ✅

The skeleton-state HTML capture (`scaffold_widget_html.png` before populated)
showed `#6366f1` indigo because `public/widgets/scaffold-streaming.html` is a
**stale build** generated from an older source. The current 3D port already
uses the correct `#00c9a7` teal. **Action:** rerun `node tmp/widget-test/gen.mjs`
or replace it as part of the build pipeline so the public widgets stay fresh.

---

## 2. Translation pipeline (the "no more hand-coded coordinates" plan)

Hand-positioning Python coordinates against a CSS spec is the bottleneck.
Replace it with an automated extract → 3D scene description → Blender build.

```
                 ┌───────────────────────┐
   widget.ts ──▶ │ render in Chromium    │ ──▶ HTML screenshot (ground truth)
                 │  + populate via demo  │
                 └──────────┬────────────┘
                            │
                            ▼
                 ┌───────────────────────┐
                 │ extract_layout_tree   │ ──▶ scaffold.layout.json
                 │  (DOM + getComputedStyle│
                 │   + getBoundingClient) │
                 └──────────┬────────────┘
                            │
                            ▼
                 ┌───────────────────────┐
                 │ Blender builder       │ ──▶ scaffold_widget.blend
                 │  reads JSON, emits     │ ──▶ scaffold_widget.png
                 │  primitives + shaders  │
                 └───────────────────────┘
```

### 2a. `extract_layout_tree.mjs`

Run inside Playwright after the demo loop completes. For every visible element
in `.shell`, record:

```ts
type Node = {
  id: string;                  // unique path-based id
  tag: string;                 // 'div' | 'span' | ...
  classes: string[];           // for debugging/material lookup
  text?: string;               // textContent if leaf
  rect: { x, y, w, h };        // px relative to shell
  z: number;                   // DOM depth (used for stacking)
  style: {
    backgroundColor: string;     // rgba()
    backgroundImage?: string;    // gradient / url() (parsed)
    color: string;               // text color
    borderColor: string;
    borderWidth: number;
    borderRadius: number;
    boxShadow?: ParsedShadow[];  // [{x,y,blur,spread,color,inset}]
    opacity: number;
    fontFamily: string;
    fontSize: number;            // px
    fontWeight: number;
    letterSpacing: number;
    textTransform?: string;
  };
  svg?: { paths: string[]; viewBox: [number, number] };  // for icon nodes
  imageUrl?: string;             // for avatars, etc.
};
```

Output: a single `scaffold.layout.json` keyed by stable selectors.

### 2b. Scene description schema

A layer between extract and Blender — lets us add small overrides without
touching the extractor.

```ts
type Scene = {
  unit_per_px: number;     // e.g. 0.01 → 580px shell becomes 5.8 units
  bevel_per_radius: number;// e.g. 0.6 → CSS 18px radius → 0.108 unit bevel
  z_per_layer: number;     // e.g. 0.005 → each DOM depth gets +z
  shell: { id: string };
  nodes: Node[];           // from extractor, with per-node 3D overrides
};
```

### 2c. Blender builder (`scripts/blender/build_widget.py`)

Generic builder that consumes the scene description. Pseudocode:

```python
for node in scene.nodes:
    obj = make_panel(node.rect, depth=card_depth(node))
    apply_radius(obj, node.style.borderRadius)
    apply_material(obj, node.style)
    if node.text: spawn_text(node.text, font, size, color, position)
    if node.svg:  spawn_svg_curves(node.svg.paths, color)
    if node.imageUrl: apply_texture(obj, node.imageUrl)
    if node.style.boxShadow: spawn_shadow_plane(obj, shadow)
```

Per-node "kind" detection rules (CSS class → 3D treatment):

| Class | 3D treatment |
|---|---|
| `.shell` | rounded panel, vertical gradient bg, top-edge emissive shine |
| `.ws-card` | rounded panel + accent strip from `--ws-rgb` |
| `.ws-avatar` | rounded square OR cylinder if `border-radius >= h/2` + image texture |
| `.ws-ring` | annulus curve, stroke = `--ws-rgb` |
| `.status-pill`, `.foot-link`, `.ws-num` | capsule + emissive border + text |
| `.ms-row`, `.task-row` | thin row plate with leading icon + text |
| `.live-dot`, `.s-dot`, `.pill-dot` | tiny emissive disc |
| `.prog-fill` | thin emissive strip |
| `*[data-svg]` | curve import |
| anything else (`.eyebrow`, `.foot-meta`, …) | text only |

### 2d. Material translation rules

| CSS | Blender |
|---|---|
| `background-color: rgba(r,g,b,a)` | `Principled BSDF` base color = (r,g,b); if a<1: mix with `Transparent` by (1-a) |
| `linear-gradient(angle, c1, c2 …)` | `TexCoord.Generated` + rotation + `ColorRamp` w/ stops |
| `border: Wpx solid rgba(...)` | sibling shell, slightly bigger XY, slightly less Z, dim emissive |
| `box-shadow: x y blur spread rgba` | flat plane offset by (x,y), `Emission` strength = a × 0.5, `Bevel` blur factor = `blur` |
| `color` (text) | text material base color (linear-converted) |
| `font-weight 700` | use a true bold face if available; fall back to `bevel_depth ≈ 0.003 * size` |

### 2e. Render pass

Match HTML rendering by:
- Camera looking straight-on (orthographic or near-ortho `lens=120`) for "flat-screen" feel.
- A single soft area light + ambient occlusion for the same "subtle depth" CSS shadows give.
- AgX color management.
- Glare disabled (or threshold raised so it doesn't bloom small emissive elements).

For "hero shot" renders we keep the angled camera + glare; for "spec sheet"
parity renders we use the flat camera. Both modes from one builder.

---

## STATUS — what shipped

✅ **Pipeline live.** `scripts/3d-widgets/extract_layout.mjs` + `scripts/3d-widgets/build_widget.py` produce reproducible 3D ports from any populated widget DOM.

Validated on three widgets without touching the builder:
- `scaffold` — full hero, WBS, cards (avatars, rings, pills, milestones, tasks), banner, footer
- `agent-status` — agent list with photo avatars + status pills
- `initiative-pulse` — metric cards + workstream list

Outputs in `public/widgets-3d/`:
- `<widget>.layout.json` — DOM snapshot (~100-200 nodes per widget)
- `<widget>.blend` — editable scene
- `<widget>.png` — flat ortho render
- `compare_*.png` — HTML / 3D side-by-side

Phase-1 fixes that landed:
- ✅ A1 Per-card progress rings (annulus mesh, domain-colored emission)
- ✅ A2 Task rows (caught by default panel handler + text leaves)
- ✅ A3 Photo avatars (image-textured discs from `public/<file>.png`)
- ✅ A5 Completion banner (caught by `.banner` pill handler)
- ✅ B3 Translucent pill fills via `_premultiply()` against base panel
- ✅ B9 Glare toned down (Threshold 1.8, Strength 0.10/0.18)
- ✅ C1-C4 Geometry mapped 1:1 from CSS px (1px → 0.01 unit)
- ✅ Avatar shape (rounded vs. square) — now disc-based
- ✅ Z-stacking (children float above parent panels)
- ✅ Two render modes (`--mode=flat` ortho, `--mode=hero` angled)
- ✅ npm scripts: `widget3d:scaffold`, `:agent-status`, `:initiative-pulse`, `:scaffold:hero`

Still incremental work (additive — no architectural changes needed):
- A4 Domain badges on avatars (small bottom-right circle with icon)
- A6 / A8 / A9 SVG icon import (concentric reticle, milestone bracket, task check) — currently render as colored squares
- D1 / D2 Real Inter / JetBrains Mono fonts (currently Helvetica + SFNSMono)
- B1 Shell vertical gradient fade (parser hooked, disabled — too subtle to add value at this scale)
- Light-mode parity passes for the other widgets

These are TODOs in `CLASS_HANDLERS` / material rules — not blocking.

See `scripts/3d-widgets/README.md` for usage and extension instructions.

---

## 3. Concrete plan — what to ship next

In rough priority order, with the gap items they unblock.

### Phase 1 — Make the current scaffold port look like the real widget

These do NOT require the full pipeline. Targeted Python edits.

1. **Add per-card progress ring** (A1) — annulus curve via `bpy.ops.curve.primitive_bezier_circle_add` + Bevel-Object shaped as the stroke; emissive in domain color.
2. **Add task rows below milestones** (A2) — extend `build_card` with a `tasks: list[str]` field and add second-tier rows.
3. **Replace letter avatars with photo discs** (A3) — load `DOMAIN_AVATAR[domain]` URLs, fetch into local cache, apply as image texture on a cylinder.
4. **Add completion banner at the bottom** (A5) — translucent panel + check icon + link text.
5. **Header divider line under WS header row** (A7).
6. **Tone glare way down** (B9) so emissive elements don't blob together.
7. **Fix avatar to round corners** (C3).
8. **Use Inter + JetBrains Mono fonts** (D1, D2) — fetch and bundle in `scripts/blender/fonts/`.

### Phase 2 — Pipeline foundation

9. Build `scripts/extract_layout_tree.mjs` — Playwright + DOM walker.
10. Define `scene.layout.json` schema and a JSON Schema file for it.
11. Rewrite `scripts/blender/scaffold_widget.py` to read `scaffold.layout.json` instead of hard-coding positions.
12. Add a Make target / npm script: `npm run widget3d:scaffold` that does extract → build → render.

### Phase 3 — The other widgets

Once the pipeline works for scaffold, we get these largely "for free":

- `liveFeedWidget` (agent-status, initiative-pulse) — same primitives.
- decision card, plan-session-live, daily-brief, etc.

Each new widget is: extract once + add any kind-detection rules for new classes.

### Phase 4 — Higher-fidelity passes (optional)

- SVG icon import (real check / bracket / arrow shapes).
- Animated renders — drive the demo loop frame-by-frame, snapshot DOM, render each frame, stitch to MP4.
- Light-mode parity render (already capturing it for reference).

---

## 4. Tradeoffs worth surfacing

- **3D adds visual weight CSS doesn't have.** Even with everything matched,
  a 3D extruded text glyph and a rendered text glyph aren't pixel-identical.
  We'll accept ≥95% parity as "done."
- **CSS animation won't translate** without explicit shot lists. The plan
  treats the static rendered state as ground truth.
- **Photo avatars need a CDN allow-list** — extract step has to cache them
  locally before Blender reads them, since headless Blender can't fetch URLs.
- **Pipeline cost:** Phase 2 is 1-2 days of work. Phase 1 fixes alone close
  ~70% of the visible gap and need ~half a day. Recommend doing Phase 1 first
  to validate the look, then build the pipeline so the next 5 widgets are cheap.

---

## 5. Open questions

1. Do we want the 3D renders as **hero marketing shots** (angled, dramatic)
   or **drop-in replacements** for the screenshots (flat, head-on)? Pipeline
   supports both — but it changes camera/lighting defaults.
2. **Light mode parity** — same priority as dark, or skip until later?
3. **Animation** — is a static hero PNG enough, or do we need a Veo3-style
   build-up sequence per widget?
