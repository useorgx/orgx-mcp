# Cinematic OrgX Widget Pipeline

This is the production path for MCP demo videos that move from a familiar
Claude-style chat surface into a dimensional OrgX widget world.

## Goal

Create a repeatable Blender scene that keeps product truth intact while adding
cinematic depth:

- the source widget still comes from the real HTML/widget pipeline
- text stays readable through decal textures, not fragile Blender text layout
- interface chrome is rebuilt as physical matte geometry
- the OrgX widget is appended as a reusable world module
- the camera path, lights, and material system are editable in Blender

## Pipeline

```text
extract_layout.mjs
  -> scaffold.layout.json
  -> scaffold_widget_html.png

build_widget.py --mode=hero
  -> scaffold_hero.blend

render_demo_textures.mjs
  -> demo-scene/textures/*.png
  -> demo-scene/textures/manifest.json

build_demo_scene.py --mode=styleframe
  -> demo-scene/orgx_mcp_demo_scene.blend
  -> demo-scene/orgx_mcp_demo_styleframe.png

build_demo_scene.py --mode=animation
  -> demo-scene/frames/frame_####.png
  -> demo-scene/orgx_mcp_demo_preview.mp4
```

## Commands

```bash
pnpm widget3d:server &
pnpm widget3d:demo-scaffold
pnpm widget3d:demo-scene
pnpm widget3d:demo-encode
pnpm widget3d:demo-encode:full
```

`widget3d:demo-scaffold` needs the static server because it reuses the
Playwright extraction path. `widget3d:demo-scene` and `widget3d:demo-encode`
can run after the scaffold assets already exist.

`widget3d:demo-encode` is the fast 720p preview profile for iteration.
`widget3d:demo-encode:full` runs the Python defaults: 1920x1080, 20 seconds,
24 fps, and higher samples.

## Design Rules

- Use the real scaffold widget as the hero asset. Do not replace it with
  generic abstract panels.
- Keep the Claude surface shallow and matte. It should feel like an instrument
  panel, not a neon room.
- Let accent color behave like status light: teal for active OrgX state, iris
  for MCP/user request, amber only for warnings or pending states.
- Put dimensional depth where the story needs it: portal recess, widget shell,
  card relief, edge rails, and camera parallax.
- Keep readable copy in texture decals so motion tests do not fail because of
  Blender font hinting or baseline drift.

## Component Modules

- `ClaudeInterfaceRoot`: browser/app chrome, rail, project title, prompt,
  response, composer, portal frame, and spatial grid.
- `OrgXWidgetWorldRoot`: appended scaffold hero scene, screenshot faceplate,
  and dimensional widget edge rails.
- `CinematicCamera`: keyed 20-second push-in path from chat to widget world.
- `Portal_InternalGlow`: animated signal light that sells the world transition.

## Next Production Pass

After the preview render is working, the designer pass should improve the
blend in this order:

1. Add bevel-specific materials for chrome, cards, widget frame, and portal.
2. Add animated widget state changes inside `OrgXWidgetWorldRoot`.
3. Add a second and third shot: orbit inside the widget, then return to the
   full operating surface.
4. Render final with motion blur, higher samples, and final audio timing.
