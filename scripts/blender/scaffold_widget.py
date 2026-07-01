"""
scaffold_widget.py — DEPRECATED hand-coded 3D port of the scaffold widget.

⚠️  This file is kept for reference only. The maintained pipeline lives in
    scripts/3d-widgets/ and renders ALL widgets mechanically from their HTML
    source. See scripts/3d-widgets/README.md for usage:

      pnpm widget3d:scaffold        # flat ortho
      pnpm widget3d:scaffold:hero   # angled marketing shot

    The new pipeline produces higher-fidelity output and extends to other
    widgets without code changes. Edit the HTML source and re-run; the 3D
    follows.

----- Original docstring (for reference) -----

Reproduces the visual language of src/scaffoldWidget.ts as a Blender scene:
  - Dark shell with teal-tinted top accent
  - Initiative hero (eyebrow, title, status pill, progress bar)
  - WORK BREAKDOWN STRUCTURE label
  - Stacked workstream cards with domain-colored top accents,
    agent avatar, "WS N" pill, title, domain label, milestone rows
  - SYNCED · LIVE footer + Open Live View button

Run:
  /Applications/Blender.app/Contents/MacOS/Blender \\
      --background --factory-startup \\
      --python scripts/blender/scaffold_widget.py

Outputs (override with OX_OUT_DIR env):
  public/widgets-3d/scaffold_widget.png
  public/widgets-3d/scaffold_widget.blend
"""

from __future__ import annotations

import math
import os
import sys
from typing import Iterable, Tuple

import bpy

# ── Output paths ─────────────────────────────────────────────
REPO = os.environ.get(
    "OX_REPO",
    "/Users/hopeatina/Code/orgx-mcp/.claude/worktrees/adoring-keller-a62d0d",
)
OUT_DIR = os.environ.get("OX_OUT_DIR", os.path.join(REPO, "public/widgets-3d"))
os.makedirs(OUT_DIR, exist_ok=True)
RENDER_PATH = os.path.join(OUT_DIR, "scaffold_widget.png")
BLEND_PATH = os.path.join(OUT_DIR, "scaffold_widget.blend")

# ── Fonts (macOS) ────────────────────────────────────────────
FONT_SANS = "/System/Library/Fonts/HelveticaNeue.ttc"
FONT_SANS_BOLD = "/System/Library/Fonts/HelveticaNeue.ttc"  # same TTC, regular only
FONT_MONO = "/System/Library/Fonts/SFNSMono.ttf"

# ── Color helpers ────────────────────────────────────────────

def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexc(h: str, a: float = 1.0) -> Tuple[float, float, float, float]:
    """Hex sRGB -> linear RGBA tuple Blender expects."""
    h = h.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), a)


# Matches src/scaffoldWidget.ts token system.
C = {
    "bg":          hexc("#02040a"),
    "shell":       hexc("#0a1018"),
    "card":        hexc("#0e131e"),
    "well":        hexc("#060a12"),
    "border":      hexc("#1a2230"),
    "text":        hexc("#f2f7ff"),
    "muted":       hexc("#94a3b8"),
    "sub":         hexc("#5b6478"),
    "primary":     hexc("#00c9a7"),
    "success":     hexc("#22c55e"),
    "warn":        hexc("#fbbf24"),
    # domain palette (rgb-* in CSS)
    "engineering": hexc("#06b6d4"),
    "product":     hexc("#16a34a"),
    "marketing":   hexc("#f97316"),
    "design":      hexc("#ec4899"),
    "sales":       hexc("#a855f7"),
    "operations":  hexc("#f59e0b"),
}

# ── Scene reset ──────────────────────────────────────────────

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.name = "ScaffoldWidget"

# World — match dark widget background.
# Blender 5.x: use_nodes is implicit; setting it is a deprecated no-op.
world = bpy.data.worlds.new("OrgXWorld")
scn.world = world
wnodes = world.node_tree.nodes
wlinks = world.node_tree.links
wnodes.clear()
wout = wnodes.new("ShaderNodeOutputWorld")
wbg = wnodes.new("ShaderNodeBackground")
wbg.inputs["Color"].default_value = C["bg"]
wbg.inputs["Strength"].default_value = 0.35
wlinks.new(wbg.outputs[0], wout.inputs[0])

# ── Material factory ─────────────────────────────────────────

_mat_cache: dict = {}


def mat_pbr(name: str, color, *, roughness=0.55, metallic=0.0, clearcoat=0.0):
    key = ("pbr", name)
    if key in _mat_cache:
        return _mat_cache[key]
    m = bpy.data.materials.new(name)
    # Blender 5.x: materials use nodes by default; setting is a deprecated no-op.
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic
    # Clearcoat input renamed across versions; try both.
    for k in ("Coat Weight", "Clearcoat", "Clearcoat Weight"):
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = clearcoat
            break
    links.new(bsdf.outputs[0], out.inputs[0])
    _mat_cache[key] = m
    return m


def mat_emit(name: str, color, *, strength=4.0, alpha=1.0):
    key = ("emit", name, strength, alpha)
    if key in _mat_cache:
        return _mat_cache[key]
    m = bpy.data.materials.new(name)
    # Blender 5.x: materials use nodes by default; setting is a deprecated no-op.
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    if alpha < 1.0:
        # Mix emission with transparent for translucent pills/badges.
        emis = nodes.new("ShaderNodeEmission")
        emis.inputs["Color"].default_value = color
        emis.inputs["Strength"].default_value = strength
        trans = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        mix.inputs[0].default_value = alpha
        links.new(trans.outputs[0], mix.inputs[1])
        links.new(emis.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], out.inputs[0])
        m.blend_method = "BLEND"
    else:
        emis = nodes.new("ShaderNodeEmission")
        emis.inputs["Color"].default_value = color
        emis.inputs["Strength"].default_value = strength
        links.new(emis.outputs[0], out.inputs[0])
    _mat_cache[key] = m
    return m


def assign(o, m):
    if o.type == "FONT":
        if o.data.materials:
            o.data.materials[0] = m
        else:
            o.data.materials.append(m)
        return
    if o.data.materials:
        o.data.materials[0] = m
    else:
        o.data.materials.append(m)


# ── Geometry helpers ─────────────────────────────────────────

def rounded_panel(name, w, h, d, *, bevel=0.04, segs=4, location=(0, 0, 0)):
    """Beveled cuboid (rounded corners) — used for shell/cards/pills.

    primitive_cube_add(size=1) creates a unit cube from -0.5..+0.5 on each
    axis (extent = 1). Scaling by (w, h, d) gives final extents (w, h, d).
    """
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    o = bpy.context.active_object
    o.name = name
    o.scale = (w, h, d)
    bpy.ops.object.transform_apply(scale=True)
    bev = o.modifiers.new("Bevel", "BEVEL")
    bev.width = bevel
    bev.segments = segs
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(30)
    return o


def capsule(name, w, h, d, *, location=(0, 0, 0)):
    """Long pill: beveled cube with bevel = h/2 so ends are round."""
    return rounded_panel(name, w, h, d, bevel=h / 2 - 0.001, segs=8, location=location)


def thin_strip(name, w, h, d, *, location=(0, 0, 0)):
    """Flat strip (for accent bars / progress bar) — no bevel."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    o = bpy.context.active_object
    o.name = name
    o.scale = (w, h, d)
    bpy.ops.object.transform_apply(scale=True)
    return o


def disc(name, radius, depth, *, location=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, vertices=48, location=location
    )
    o = bpy.context.active_object
    o.name = name
    return o


def text(
    name,
    body,
    *,
    size=0.18,
    location=(0, 0, 0),
    align="LEFT",
    extrude=0.004,
    font_path=FONT_SANS,
    bold=False,
):
    bpy.ops.object.text_add(location=location)
    o = bpy.context.active_object
    o.name = name
    o.data.body = body
    o.data.size = size
    o.data.align_x = align
    o.data.extrude = extrude
    o.data.space_character = 1.0
    o.data.space_word = 1.0
    if font_path and os.path.exists(font_path):
        try:
            f = bpy.data.fonts.load(font_path, check_existing=True)
            o.data.font = f
            if bold:
                # HelveticaNeue.ttc lacks a bold sub-face by default in Blender;
                # fake bold by adding a small bevel.
                o.data.bevel_depth = 0.0035
                o.data.bevel_resolution = 2
        except Exception:
            pass
    # Center vertically by aligning Y to MIDDLE for predictable layout.
    o.data.align_y = "BOTTOM_BASELINE"
    return o


# ── Layout constants ─────────────────────────────────────────
# Units: 1 unit ≈ 1cm. The whole widget is ~6 wide × 9 tall.

SHELL_W = 6.0
SHELL_H = 8.0
SHELL_D = 0.18

CARD_W = 5.6
CARD_H = 1.45
CARD_D = 0.10
CARD_GAP = 0.12

# Z stacking — keeps elements legible from camera
Z_SHELL_TOP = SHELL_D / 2          # 0.09
Z_HERO_BAR = Z_SHELL_TOP + 0.005   # accent line on shell
Z_CARD_BASE = Z_SHELL_TOP + 0.001
Z_CARD_TOP = Z_CARD_BASE + CARD_D  # 0.20
Z_CARD_DECO = Z_CARD_TOP + 0.002
Z_TEXT = Z_CARD_TOP + 0.005

# Vertical layout (Y axis):
#   shell top  ──── y = +SHELL_H/2 = 4.0
#     padding 0.35
#   eyebrow    ──── y ≈ 3.45
#   title      ──── y ≈ 2.95
#   pill       ──── y ≈ 2.45
#   prog bar   ──── y ≈ 2.10
#   wbs label  ──── y ≈ 1.85
#   wbs divid. ──── y ≈ 2.00
#   cards top  ──── y ≈ 1.65
#   footer     ──── y ≈ -3.45
#   shell bot  ──── y = -SHELL_H/2 = -4.0
HERO_TOP_PAD = 0.35
EYEBROW_Y = SHELL_H / 2 - HERO_TOP_PAD - 0.20
TITLE_Y = EYEBROW_Y - 0.55
PILL_Y = TITLE_Y - 0.50
PROG_Y = PILL_Y - 0.36
WBS_LABEL_Y = PROG_Y - 0.30
WBS_DIV_Y = WBS_LABEL_Y + 0.18
CARD_TOP_Y = WBS_LABEL_Y - 0.22  # first card top edge
FOOTER_Y = -SHELL_H / 2 + 0.50

# ── Build: shell ─────────────────────────────────────────────

shell = rounded_panel(
    "Shell", SHELL_W, SHELL_H, SHELL_D, bevel=0.18, segs=6, location=(0, 0, 0)
)
assign(shell, mat_pbr("MatShell", C["shell"], roughness=0.45, clearcoat=0.4))

# Subtle teal "shine line" along the top of the shell.
shine = thin_strip(
    "ShellShine",
    SHELL_W * 0.86,
    0.012,
    0.012,
    location=(0, SHELL_H / 2 - 0.04, Z_HERO_BAR),
)
assign(shine, mat_emit("MatShine", C["primary"], strength=6.0))

# ── Build: hero (eyebrow, live dot, title, status pill, progress) ──

# Live dot (pulsing teal in the original widget; here a glowing puck).
live_x = -SHELL_W / 2 + 0.45
ldot = disc("LiveDot", 0.045, 0.04, location=(live_x, EYEBROW_Y, Z_TEXT + 0.01))
ldot.rotation_euler = (math.radians(90), 0, 0)
assign(ldot, mat_emit("MatLiveDot", C["primary"], strength=8.0))

# Eyebrow text "INITIATIVE SCAFFOLDED"
eyebrow = text(
    "Eyebrow",
    "INITIATIVE SCAFFOLDED",
    size=0.13,
    location=(live_x + 0.18, EYEBROW_Y - 0.045, Z_TEXT),
    font_path=FONT_MONO,
)
assign(eyebrow, mat_pbr("MatEyebrow", C["muted"], roughness=0.7))

# Hero title
hero_title = text(
    "HeroTitle",
    "OrgX Production Launch",
    size=0.32,
    location=(-SHELL_W / 2 + 0.45, TITLE_Y, Z_TEXT),
    font_path=FONT_SANS,
    bold=True,
)
assign(hero_title, mat_pbr("MatHeroTitle", C["text"], roughness=0.6))

# Status pill
pill_w, pill_h, pill_d = 1.05, 0.26, 0.05
pill_x = -SHELL_W / 2 + 0.45 + pill_w / 2
pill = capsule(
    "StatusPill", pill_w, pill_h, pill_d, location=(pill_x, PILL_Y, Z_TEXT)
)
# Subtle translucent fill + visible thin border ring around it.
assign(pill, mat_emit("MatStatusPill", C["primary"], strength=0.25, alpha=0.18))

pill_border = capsule(
    "StatusPillBorder",
    pill_w + 0.012,
    pill_h + 0.012,
    pill_d - 0.008,
    location=(pill_x, PILL_Y, Z_TEXT - 0.001),
)
assign(pill_border, mat_emit("MatPillBorder", C["primary"], strength=0.9, alpha=0.45))

# Pill dot (small bright marker on the left of the pill)
pill_dot = disc(
    "StatusDot",
    0.035,
    0.04,
    location=(pill_x - pill_w / 2 + 0.14, PILL_Y, Z_TEXT + 0.04),
)
pill_dot.rotation_euler = (math.radians(90), 0, 0)
assign(pill_dot, mat_emit("MatStatusDot", C["primary"], strength=6.0))

# Pill text
pill_text = text(
    "StatusText",
    "BUILDING…",
    size=0.105,
    location=(pill_x - pill_w / 2 + 0.24, PILL_Y - 0.04, Z_TEXT + 0.03),
    font_path=FONT_MONO,
    bold=True,
)
assign(pill_text, mat_emit("MatStatusTextMat", C["primary"], strength=1.6))

# Progress bar (well + fill)
prog_well = thin_strip(
    "ProgWell",
    SHELL_W - 0.9,
    0.035,
    0.018,
    location=(0, PROG_Y, Z_HERO_BAR + 0.002),
)
assign(prog_well, mat_pbr("MatProgWell", C["border"], roughness=0.85))

prog_fill_w = (SHELL_W - 0.9) * 0.62
prog_fill = thin_strip(
    "ProgFill",
    prog_fill_w,
    0.035,
    0.022,
    location=(
        -(SHELL_W - 0.9) / 2 + prog_fill_w / 2,
        PROG_Y,
        Z_HERO_BAR + 0.004,
    ),
)
assign(prog_fill, mat_emit("MatProgFill", C["primary"], strength=2.6))

# ── WBS section header ───────────────────────────────────────

wbs_label = text(
    "WBSLabel",
    "WORK BREAKDOWN STRUCTURE",
    size=0.115,
    location=(-SHELL_W / 2 + 0.45, WBS_LABEL_Y, Z_TEXT),
    font_path=FONT_MONO,
    bold=True,
)
assign(wbs_label, mat_pbr("MatWBSLabel", C["sub"], roughness=0.75))

wbs_count = text(
    "WBSCount",
    "3 WORKSTREAMS · 18 ENTITIES",
    size=0.105,
    location=(SHELL_W / 2 - 0.45, WBS_LABEL_Y, Z_TEXT),
    align="RIGHT",
    font_path=FONT_MONO,
)
assign(wbs_count, mat_pbr("MatWBSCount", C["muted"], roughness=0.75))

# Divider above WBS
div = thin_strip(
    "WBSDivider",
    SHELL_W - 0.4,
    0.005,
    0.005,
    location=(0, WBS_DIV_Y, Z_HERO_BAR + 0.001),
)
assign(div, mat_pbr("MatDivider", C["border"], roughness=0.9))


# ── Workstream cards ─────────────────────────────────────────

WORKSTREAMS = [
    {
        "n": 1,
        "title": "SSE Infrastructure",
        "domain": "engineering",
        "milestones": [
            "LiveFeedDO shipped",
            "Stream coalescing + replay",
        ],
    },
    {
        "n": 2,
        "title": "Widget Polish",
        "domain": "design",
        "milestones": [
            "Production visual parity",
            "Domain-colored card accents",
        ],
    },
    {
        "n": 3,
        "title": "Go-to-Market",
        "domain": "marketing",
        "milestones": [
            "Product Hunt launch",
            "Demo video + landing page",
        ],
    },
]


def build_card(ws, top_y):
    """Build one workstream card with its top edge at top_y. Returns bottom_y."""
    n = ws["n"]
    domain = ws["domain"]
    title = ws["title"]
    milestones = ws["milestones"]
    accent = C[domain]

    # Card height grows with milestone count.
    rows = len(milestones)
    h = 0.78 + 0.32 * rows
    cy = top_y - h / 2

    card = rounded_panel(
        f"Card_{n}",
        CARD_W,
        h,
        CARD_D,
        bevel=0.08,
        segs=4,
        location=(0, cy, Z_CARD_BASE + CARD_D / 2),
    )
    assign(card, mat_pbr(f"MatCard_{n}", C["card"], roughness=0.5, clearcoat=0.25))

    # Domain-colored top accent bar
    accent_bar = thin_strip(
        f"CardAccent_{n}",
        CARD_W - 0.04,
        0.025,
        0.025,
        location=(0, top_y - 0.025, Z_CARD_DECO),
    )
    assign(accent_bar, mat_emit(f"MatAccent_{n}", accent, strength=5.5))

    # Card border outline (thin frame around the card via slightly larger dim panel)
    border = rounded_panel(
        f"CardBorder_{n}",
        CARD_W + 0.015,
        h + 0.015,
        CARD_D - 0.005,
        bevel=0.08,
        segs=4,
        location=(0, cy, Z_CARD_BASE + CARD_D / 2 - 0.0015),
    )
    assign(border, mat_pbr(f"MatCardBorder_{n}", C["border"], roughness=0.85))

    # Header strip Y reference
    header_y = top_y - 0.34
    body_top_y = top_y - 0.62

    # Agent avatar — small rounded square on the left
    av_size = 0.42
    av_x = -CARD_W / 2 + 0.32
    avatar = rounded_panel(
        f"Avatar_{n}",
        av_size,
        av_size,
        0.04,
        bevel=0.08,
        segs=4,
        location=(av_x, header_y, Z_CARD_DECO + 0.01),
    )
    assign(avatar, mat_emit(f"MatAvatar_{n}", accent, strength=0.7, alpha=0.35))

    # Avatar initial letter (domain first char uppercase)
    avatar_letter = text(
        f"AvatarLetter_{n}",
        domain[0].upper(),
        size=0.22,
        location=(av_x - 0.07, header_y - 0.08, Z_CARD_DECO + 0.04),
        font_path=FONT_MONO,
        bold=True,
    )
    assign(avatar_letter, mat_emit(f"MatAvatarLetter_{n}", accent, strength=3.0))

    # WS pill (small capsule)
    ws_pill_w, ws_pill_h = 0.85, 0.21
    ws_pill_x = av_x + av_size / 2 + 0.18 + ws_pill_w / 2
    ws_pill = capsule(
        f"WSPill_{n}",
        ws_pill_w,
        ws_pill_h,
        0.04,
        location=(ws_pill_x, header_y, Z_CARD_DECO + 0.01),
    )
    assign(ws_pill, mat_emit(f"MatWSPill_{n}", accent, strength=0.4, alpha=0.22))

    ws_pill_text = text(
        f"WSPillText_{n}",
        f"WS {n}",
        size=0.1,
        location=(
            ws_pill_x - ws_pill_w / 2 + 0.12,
            header_y - 0.038,
            Z_CARD_DECO + 0.04,
        ),
        font_path=FONT_MONO,
        bold=True,
    )
    assign(ws_pill_text, mat_emit(f"MatWSPillText_{n}", accent, strength=2.5))

    # Title text
    title_x = ws_pill_x + ws_pill_w / 2 + 0.18
    title_obj = text(
        f"WSTitle_{n}",
        title,
        size=0.18,
        location=(title_x, header_y - 0.07, Z_CARD_DECO + 0.01),
        font_path=FONT_SANS,
        bold=True,
    )
    assign(title_obj, mat_pbr(f"MatWSTitle_{n}", C["text"], roughness=0.55))

    # Domain label (right-aligned)
    domain_label = text(
        f"WSDomain_{n}",
        domain.upper(),
        size=0.1,
        location=(CARD_W / 2 - 0.28, header_y - 0.04, Z_CARD_DECO + 0.01),
        align="RIGHT",
        font_path=FONT_MONO,
        bold=True,
    )
    assign(domain_label, mat_pbr(f"MatWSDomain_{n}", C["sub"], roughness=0.8))

    # Header divider
    hdiv = thin_strip(
        f"WSHDiv_{n}",
        CARD_W - 0.05,
        0.004,
        0.004,
        location=(0, top_y - 0.62, Z_CARD_DECO),
    )
    assign(hdiv, mat_pbr(f"MatWSHDiv_{n}", C["border"], roughness=0.9))

    # Milestone rows
    for i, ms in enumerate(milestones):
        my = body_top_y - 0.18 - i * 0.32
        # Milestone icon (small warn-amber square)
        ms_icon = rounded_panel(
            f"MSIcon_{n}_{i}",
            0.22,
            0.22,
            0.03,
            bevel=0.05,
            segs=3,
            location=(-CARD_W / 2 + 0.32, my, Z_CARD_DECO + 0.005),
        )
        assign(
            ms_icon,
            mat_emit(f"MatMSIcon_{n}_{i}", C["warn"], strength=0.5, alpha=0.4),
        )
        # Milestone title
        ms_text = text(
            f"MSText_{n}_{i}",
            ms,
            size=0.13,
            location=(-CARD_W / 2 + 0.55, my - 0.05, Z_CARD_DECO + 0.005),
            font_path=FONT_SANS,
        )
        assign(ms_text, mat_pbr(f"MatMSText_{n}_{i}", C["text"], roughness=0.65))

    return top_y - h


cur_y = CARD_TOP_Y
for ws in WORKSTREAMS:
    cur_y = build_card(ws, cur_y) - CARD_GAP

# ── Footer ───────────────────────────────────────────────────

# Divider above footer
foot_div = thin_strip(
    "FootDivider",
    SHELL_W - 0.4,
    0.005,
    0.005,
    location=(0, FOOTER_Y + 0.28, Z_HERO_BAR + 0.001),
)
assign(foot_div, mat_pbr("MatFootDiv", C["border"], roughness=0.9))

foot_meta = text(
    "FootMeta",
    "SYNCED · LIVE",
    size=0.115,
    location=(-SHELL_W / 2 + 0.45, FOOTER_Y, Z_TEXT),
    font_path=FONT_MONO,
    bold=True,
)
assign(foot_meta, mat_pbr("MatFootMeta", C["sub"], roughness=0.8))

# Footer button (capsule)
fb_w, fb_h, fb_d = 1.55, 0.32, 0.05
fb_x = SHELL_W / 2 - 0.45 - fb_w / 2
fb_btn = capsule(
    "FootBtn", fb_w, fb_h, fb_d, location=(fb_x, FOOTER_Y + 0.04, Z_TEXT)
)
assign(fb_btn, mat_emit("MatFootBtn", C["primary"], strength=0.45, alpha=0.22))

fb_btn_border = capsule(
    "FootBtnBorder",
    fb_w + 0.012,
    fb_h + 0.012,
    fb_d - 0.005,
    location=(fb_x, FOOTER_Y + 0.04, Z_TEXT - 0.001),
)
assign(fb_btn_border, mat_emit("MatFootBtnBorder", C["primary"], strength=1.6, alpha=0.45))

fb_text = text(
    "FootBtnText",
    "OPEN LIVE VIEW →",
    size=0.115,
    location=(fb_x - fb_w / 2 + 0.18, FOOTER_Y + 0.0, Z_TEXT + 0.03),
    font_path=FONT_MONO,
    bold=True,
)
assign(fb_text, mat_emit("MatFootBtnText", C["primary"], strength=4.5))

# ── Ground plane ─────────────────────────────────────────────
# Adds a subtle dark reflective surface beneath the widget so it reads as
# a floating object rather than a flat overlay on the world background.
floor_mesh = bpy.data.meshes.new("FloorMesh")
_s = 20.0
floor_mesh.from_pydata(
    [(-_s, -_s, 0), (_s, -_s, 0), (_s, _s, 0), (-_s, _s, 0)],
    [],
    [(0, 1, 2, 3)],
)
floor_mesh.update()
floor = bpy.data.objects.new("Floor", floor_mesh)
floor.location = (0, 0, -0.5)
scn.collection.objects.link(floor)
fmat = bpy.data.materials.new("MatFloor")
_fnodes, _flinks = fmat.node_tree.nodes, fmat.node_tree.links
_fnodes.clear()
_fout = _fnodes.new("ShaderNodeOutputMaterial")
_fbsdf = _fnodes.new("ShaderNodeBsdfPrincipled")
_fbsdf.inputs["Base Color"].default_value = (0.0, 0.005, 0.012, 1)
_fbsdf.inputs["Roughness"].default_value = 0.35
if "Metallic" in _fbsdf.inputs:
    _fbsdf.inputs["Metallic"].default_value = 0.5
_flinks.new(_fbsdf.outputs[0], _fout.inputs[0])
floor.data.materials.append(fmat)

# ── Camera ───────────────────────────────────────────────────

# Widget lies on the XY plane (normal +Z). Camera is positioned almost head-on
# from above, with a slight offset for 3/4 perspective. A Track-To constraint
# keeps it pointed at the widget center.
bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0.05))
cam_target = bpy.context.active_object
cam_target.name = "CamTarget"

# Frame the 6×8 panel comfortably with a slight 3/4 tilt.
bpy.ops.object.camera_add(location=(0.7, -1.4, 12.4))
cam = bpy.context.active_object
cam.name = "Cam"
cam.data.lens = 50  # mm — neutral
cam.data.sensor_width = 36
cam.data.clip_start = 0.05
cam.data.clip_end = 200
con = cam.constraints.new("TRACK_TO")
con.target = cam_target
con.track_axis = "TRACK_NEGATIVE_Z"
con.up_axis = "UP_Y"
scn.camera = cam

# ── Lights ───────────────────────────────────────────────────

def add_area(name, location, rotation, energy, size=4.0, color=(1, 1, 1, 1)):
    bpy.ops.object.light_add(type="AREA", location=location, rotation=rotation)
    o = bpy.context.active_object
    o.name = name
    o.data.energy = energy
    o.data.size = size
    o.data.color = color[:3]
    return o


# Key — above-right, neutral warm
add_area(
    "KeyLight",
    location=(2.5, -3.0, 9.0),
    rotation=(math.radians(35), math.radians(-12), math.radians(15)),
    energy=600,
    size=5.0,
    color=hexc("#ffffff"),
)
# Fill — above-left, cool
add_area(
    "FillLight",
    location=(-3.0, -1.0, 8.0),
    rotation=(math.radians(30), math.radians(15), math.radians(-15)),
    energy=280,
    size=6.0,
    color=hexc("#bfe5ff"),
)
# Rim — behind/above, teal kicker
add_area(
    "RimLight",
    location=(0, 4.5, 6.5),
    rotation=(math.radians(110), 0, 0),
    energy=320,
    size=5.0,
    color=hexc("#00c9a7"),
)

# ── Render settings ──────────────────────────────────────────

scn.render.resolution_x = 1400
scn.render.resolution_y = 1750  # 4:5 portrait
scn.render.resolution_percentage = 100
scn.render.film_transparent = False

# Prefer Eevee Next (Blender 4.2+/5.x) for a fast, clean UI render.
preferred_engines = ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]
for eng in preferred_engines:
    try:
        scn.render.engine = eng
        break
    except TypeError:
        continue

if scn.render.engine in {"BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"}:
    ee = scn.eevee
    # Bloom (Eevee classic) — Eevee Next handles glow via compositor.
    if hasattr(ee, "use_bloom"):
        ee.use_bloom = True
        ee.bloom_intensity = 0.06
        ee.bloom_threshold = 0.9
    if hasattr(ee, "use_ssr"):
        ee.use_ssr = True
    # Eevee Next: enable raytracing/ambient occlusion if available
    if hasattr(ee, "use_raytracing"):
        try:
            ee.use_raytracing = True
        except Exception:
            pass
    if hasattr(ee, "use_gtao"):
        ee.use_gtao = True

# Color management — filmic for cinematic falloff on emissive elements.
scn.view_settings.view_transform = "AgX" if "AgX" in {
    v.identifier for v in scn.view_settings.bl_rna.properties["view_transform"].enum_items
} else "Filmic"
scn.view_settings.look = "AgX - Base Contrast" if scn.view_settings.view_transform == "AgX" else "Medium High Contrast"
scn.view_settings.exposure = 0.2
scn.view_settings.gamma = 1.0

# Compositor glow for emissive UI bits.
# Blender 5.x: scene.node_tree was removed; use scene.compositing_node_group.
scn.render.use_compositing = True
ctree = bpy.data.node_groups.new("ScaffoldComp", "CompositorNodeTree")
scn.compositing_node_group = ctree
for n in list(ctree.nodes):
    ctree.nodes.remove(n)
rl = ctree.nodes.new("CompositorNodeRLayers")
glare = ctree.nodes.new("CompositorNodeGlare")
# Blender 5.x: Glare params are now sockets (NodeSocketMenu strings).
glare.inputs["Type"].default_value = "Fog Glow"
glare.inputs["Quality"].default_value = "High"
glare.inputs["Threshold"].default_value = 1.4
glare.inputs["Size"].default_value = 0.55
glare.inputs["Strength"].default_value = 0.18
# Blender 5.x compositor: output via the node group's interface +
# NodeGroupOutput, instead of the removed CompositorNodeComposite.
ctree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
group_out = ctree.nodes.new("NodeGroupOutput")
ctree.links.new(rl.outputs["Image"], glare.inputs[0])
ctree.links.new(glare.outputs[0], group_out.inputs[0])

scn.render.image_settings.file_format = "PNG"
scn.render.image_settings.color_mode = "RGBA"
scn.render.image_settings.color_depth = "16"
scn.render.filepath = RENDER_PATH

# ── Save .blend before render so we have it even if render fails ──
bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
print(f"[scaffold_widget] saved blend → {BLEND_PATH}")

# ── Render only if not invoked as no-render ──────────────────
if "--no-render" not in sys.argv:
    print(f"[scaffold_widget] rendering → {RENDER_PATH}")
    bpy.ops.render.render(write_still=True)
    print(f"[scaffold_widget] done")
