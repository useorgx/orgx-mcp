# 3D Widget Pipeline

Mechanical translation of any OrgX HTML widget into a 3D Blender scene.
Flat renders use a hybrid product-rendering pass: reusable modeled
components create the physical relief, then a browser-baked faceplate texture
restores exact glyphs, icons, and sub-pixel gradients for 95%+ screenshot
fidelity.

```
src/<widget>.ts                  ┌──────────────────┐
       │                         │  build_widget.py │ → .blend + .png
       │   (TS builder fn)       │  (Blender)       │
       ▼                         └────────▲─────────┘
build HTML  ──▶  populate via    layout JSON │
              ?demo=true              │       │
              ▼                       ▼       │
         http.server     ──▶  extract_layout.mjs
        public/widgets-3d         (Playwright)
              │
              ▼
        validate.mjs (SSIM + Δ heat-map)
```

## Current quality

| Widget | SSIM | Mean Δ | Components | Render |
|--------|------|--------|------------|--------|
| scaffold | 0.976 | 0.68% | ✅ all | ✅ flat + hero |
| agent-status | 0.983 | 0.62% | ✅ all | ✅ flat |
| initiative-pulse | 0.984 | 0.59% | ✅ all | ✅ flat |

See `docs/3d-widgets/FIDELITY_PLAN.md` for the pure-geometry ceiling and the
hybrid faceplate approach that clears the 0.95 validation bar.

## Quick start

```bash
# 1. Start the static server
pnpm widget3d:server &

# 2. End-to-end build + validate of any widget
pnpm widget3d:scaffold              # extract → render → validate (flat ortho)
pnpm widget3d:scaffold:hero         # angled marketing shot
pnpm widget3d:agent-status
pnpm widget3d:initiative-pulse
pnpm widget3d:all                   # all three sequentially

# 3. Cinematic demo scene
pnpm widget3d:demo-textures          # readable Claude/OrgX text decals
pnpm widget3d:demo-scaffold          # rebuild scaffold hero .blend
pnpm widget3d:demo-scene             # 16:9 styleframe + .blend
pnpm widget3d:demo-encode            # fast 720p frame sequence + mp4 preview
pnpm widget3d:demo-encode:full       # full 1080p/20s frame sequence + mp4

# 4. Validate-only (against existing render)
pnpm widget3d:validate --widget=scaffold --threshold=0.95

# Outputs land in public/widgets-3d/
#   <widget>.layout.json         — DOM snapshot + reference image pointer
#   <widget>.blend               — editable Blender scene
#   <widget>.png                 — final render
#   <widget>.diff.png            — pixel-Δ heatmap (vs HTML reference)
#   <widget>.report.json         — { ssim, mean_delta, max_delta, passed }
#   compare_<widget>_v3.png      — HTML | 3D | diff side-by-side
#   <widget>-fresh.html          — the populated HTML used for capture
#   demo-scene/                  — cinematic .blend, styleframe, frames, mp4
```

## Cinematic demo scene

`build_demo_scene.py` turns the high-fidelity widget asset into a deeper VFX
shot instead of a flat faceplate. The Claude-like surface is rebuilt as matte
geometry, readable interface copy is rendered as PNG decals, and the existing
`scaffold_hero.blend` is appended as the OrgX world inside the portal.

The scene follows the current OrgX visual direction:
- matte instrument-panel surfaces, restrained edge light, and sparse signals
- real widget screenshots and widget geometry instead of generic abstract SaaS
- shallow deliberate depth for interface chrome, deeper relief only inside the
  OrgX widget world
- camera motion that starts on a familiar chat surface and pushes into the
  operational widget instead of cutting to a disconnected render

Primary outputs:

```text
public/widgets-3d/demo-scene/
  orgx_mcp_demo_scene.blend
  orgx_mcp_demo_styleframe.png
  orgx_mcp_demo_preview.mp4
  frames/frame_####.png
  textures/manifest.json
  textures/*.png
```

The Python defaults are 20 seconds at 24 fps. The npm `demo-encode` script uses
a faster 720p preview profile for iteration, while `demo-encode:full` runs the
full default production path. The blend is saved so a designer can open it in
Blender for manual camera, lighting, bevel, and material polish before a final
production render.

## Adding a new widget

If the widget already uses the OrgX visual primitives (rounded panels, pills,
photo avatars, progress rings, accent strips), it works out of the box —
just add an entry to `WIDGETS` in `extract_layout.mjs`:

```js
'my-widget': {
  builder: 'src/myWidget.ts',
  fn: 'buildMyWidget',
  args: { /* whatever buildMyWidget expects */ },
  demo: true,                            // append ?demo=true
  rootSelector: '.shell, .card',
  viewport: { width: 720, height: 1500 },
  settleMs: 9000,                        // demo loop runtime
},
```

Then add an npm script:

```json
"widget3d:my-widget": "pnpm widget3d:extract --widget=my-widget && pnpm widget3d:build --layout=public/widgets-3d/my-widget.layout.json --out=public/widgets-3d/my_widget --mode=flat --theme=dark"
```

## Extending for new widget primitives

The Blender builder dispatches based on CSS class. Each entry in
`CLASS_HANDLERS` (in `build_widget.py`) is `({class_predicate}, handler_fn)`.

For example, to add a 3D treatment for a new `.health-badge` class:

```python
def kind_health_badge(node):
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.01
    obj = make_panel(...)
    # custom material, etc.
    return obj

CLASS_HANDLERS = [
    # existing entries…
    ({"health-badge"}, kind_health_badge),
]
```

First-match-wins, so put more specific classes earlier in the list.

## Material translation rules

| CSS                                          | 3D treatment |
|----------------------------------------------|--------------|
| `background-color: rgba(r,g,b,a)` opaque     | Principled BSDF, base color |
| `background-color: rgba(r,g,b,a)` translucent | `_premultiply()` against the panel beneath, render opaque |
| `border: Wpx solid rgba(r,g,b,a)`            | Slightly larger panel behind, premultiplied border color |
| `linear-gradient(angle, c1, c2)`             | ColorRamp shader; transparent stops premultiplied over local panel base |
| Browser micro-detail                         | `--skin=hybrid` faceplate texture at 96% opacity in flat mode |
| `box-shadow`                                 | Implicit from area lighting + AO |
| `font-weight ≥ 600`                          | Real bold face if installed; else `bevel_depth` faux-bold |

Translucent CSS rendered via genuine alpha in 3D would let bright emissive
neighbors bleed through. The pipeline avoids this by **pre-multiplying** the
translucent fill against the panel it visually sits on (shell, card, page bg)
and rendering the result as an opaque material. See `_premultiply()` /
`base_color_for()` in `build_widget.py`.

## Z-stacking

DOM depth alone isn't enough — children inside a card need to clear the card's
physical thickness (`CARD_DEPTH_BASE = 0.10` Blender units). `z_for(node)`
walks ancestors, finds the deepest containing panel (`.ws-card`, etc.), and
adds the panel's depth to the base z. This means avatars/rings/text always
float above their parent card.

Text gets an extra +0.05 z so it never gets buried inside a pill.

## Render modes

| Mode    | Camera        | Use-case |
|---------|---------------|----------|
| `flat`  | Orthographic, head-on | Drop-in screenshot replacement |
| `hero`  | Perspective, angled 3/4 | Marketing renders, hero shots |

Pass via `--mode=flat` or `--mode=hero` on the build step.

Flat mode supports three skin levels:
- `--skin=hybrid` (default): 96% browser-baked faceplate over the modeled
  widget; this is the 95%+ fidelity target.
- `--skin=exact`: 100% faceplate for pixel-baseline debugging.
- `--skin=none`: pure modeled geometry for auditing component construction.

Tune hybrid strength with `--skin-opacity=0.0..1.0`.

When a flat skin is active, the faceplate owns micro-details (text and SVG
glyph pixels) so there is no double-render blur. The modeled underlay still
owns repeated structure: shell, cards, progress rings, borders, accent strips,
pills, avatars, and gradient panels.

## Theme support

`--theme=dark` (default) and `--theme=light` adjust:
- World background brightness
- Light energies and colors
- The "base" color used by `_premultiply()` for translucent fills

To extract a light-mode layout: `pnpm widget3d:extract --widget=scaffold --theme=light`.

## Known limitations

- **Animation** doesn't translate. The pipeline captures a settled DOM state.
  For animated renders, frame-by-frame extraction is possible but unimplemented.
- **Pure-geometry flat renders** still top out below the hybrid path because
  browser text hinting and CSS rasterization differ from Blender's renderer.
- **Light-mode photo avatars** use the same image textures as dark — fine,
  but the surrounding tones differ.
- **CSS `clip-path`, `mask-image`, complex `backdrop-filter`** aren't
  represented as geometry; the hybrid faceplate preserves their pixels.
- Bold weights are faux (bevel) unless real bold faces are installed locally.

## Files

- `extract_layout.mjs` — Playwright DOM walker → JSON
- `build_widget.py` — generic Blender builder (reads JSON, emits primitives)
- `README.md` — this file
