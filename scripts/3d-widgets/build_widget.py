"""
build_widget.py — generic Blender builder that reads a layout JSON and
produces a 3D version of any OrgX widget.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender \\
      --background --factory-startup --python scripts/3d-widgets/build_widget.py \\
      -- --layout=public/widgets-3d/scaffold.layout.json \\
         --out=public/widgets-3d/scaffold \\
         [--mode=hero|flat]  [--theme=dark|light]

Outputs (next to --out, same basename):
  <out>.blend
  <out>.png

The script is widget-agnostic. New widget kinds are added by appending to the
CLASS_HANDLERS list near the bottom — no new files needed for additional
widgets that already render via the same primitives.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import tempfile
from typing import Any, Optional, Tuple

import bpy

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  CLI                                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def parse_args():
    """Blender wraps user args after `--`."""
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--layout", required=True)
    p.add_argument("--out", required=True, help="Output basename (without extension)")
    p.add_argument("--mode", default="hero", choices=["hero", "flat"])
    p.add_argument("--theme", default="dark", choices=["dark", "light"])
    p.add_argument("--skin", default="hybrid", choices=["none", "hybrid", "exact"],
                   help="Flat-mode browser faceplate: none, hybrid alpha blend, or exact 1:1 skin")
    p.add_argument("--skin-opacity", type=float, default=0.96,
                   help="Opacity for --skin=hybrid. 0 keeps only modeled geometry; 1 is exact browser skin.")
    p.add_argument("--public-dir", default=os.path.join(os.path.dirname(__file__), "..", "..", "public"))
    p.add_argument("--no-render", action="store_true")
    return p.parse_args(argv)


ARGS = parse_args()

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Constants / scaling                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

SCALE = 0.01                  # 1 CSS px → 0.01 Blender unit
Z_PER_DEPTH = 0.0025          # additional z per DOM depth (avoids z-fighting)
SHELL_DEPTH = 0.18            # base panel thickness
CARD_DEPTH_BASE = 0.10
THIN_DEPTH = 0.005

# Fonts. Prefer bundled Inter/JetBrains; fall back to closest macOS system fonts.
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FONT_DIR = os.path.join(HERE, "fonts")


def first_existing(*paths) -> Optional[str]:
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None


FONT_SANS = first_existing(
    os.path.join(FONT_DIR, "Inter-Regular.ttf"),
    "/System/Library/Fonts/HelveticaNeue.ttc",
)
FONT_SANS_BOLD = first_existing(
    os.path.join(FONT_DIR, "Inter-Bold.ttf"),
    "/System/Library/Fonts/Helvetica.ttc",
    FONT_SANS,
)
FONT_MONO = first_existing(
    os.path.join(FONT_DIR, "JetBrainsMono-Regular.ttf"),
    "/System/Library/Fonts/SFNSMono.ttf",
)
FONT_MONO_BOLD = first_existing(
    os.path.join(FONT_DIR, "JetBrainsMono-Bold.ttf"),
    "/System/Library/Fonts/Menlo.ttc",
    FONT_MONO,
)

OUT_BLEND = ARGS.out + ".blend"
OUT_PNG = ARGS.out + ".png"
os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)
PUBLIC_DIR = os.path.abspath(ARGS.public_dir)

# Temp dir for intermediate SVG files we feed to bpy.ops.import_curve.svg.
TMP_DIR = tempfile.mkdtemp(prefix="orgx_widget3d_")

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Color helpers                                                             ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin_rgba(rgba: Optional[dict], default=(1, 1, 1, 1)) -> Tuple[float, float, float, float]:
    if not rgba:
        return default
    r, g, b, a = rgba["r"], rgba["g"], rgba["b"], rgba.get("a", 1.0)
    return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), a)


# Approximate base colors that translucent fills sit on top of. Used by
# _premultiply() to render translucent CSS as opaque without the bright bleed.
_BASE_DARK_CARD  = (_srgb_to_linear(0.054), _srgb_to_linear(0.075), _srgb_to_linear(0.118), 1)
_BASE_DARK_SHELL = (_srgb_to_linear(0.031), _srgb_to_linear(0.047), _srgb_to_linear(0.078), 1)
_BASE_LIGHT_CARD = (_srgb_to_linear(0.94),  _srgb_to_linear(0.96),  _srgb_to_linear(0.99),  1)
_BASE_LIGHT_SHELL= (_srgb_to_linear(0.97),  _srgb_to_linear(0.98),  _srgb_to_linear(1.00),  1)


def base_color_for(node):
    """Walk up DOM ancestors to find the panel a translucent fill sits on."""
    if ARGS.theme == "light":
        for anc in ancestors_of(node):
            if "ws-card" in set(anc["classes"]):
                return _BASE_LIGHT_CARD
        return _BASE_LIGHT_SHELL
    for anc in ancestors_of(node):
        if "ws-card" in set(anc["classes"]):
            return _BASE_DARK_CARD
    return _BASE_DARK_SHELL


def _linear_to_srgb(c: float) -> float:
    if c <= 0.0031308:
        return c * 12.92
    return 1.055 * (c ** (1.0 / 2.4)) - 0.055


def _premultiply(rgba, base, *, lift=0.0, alpha_floor=0.0):
    """CSS-style translucent → opaque-on-base equivalent.

    CSS alpha-blends in sRGB space (gamma-encoded). Naively blending in linear
    amplifies bright colors. So: convert each operand back to sRGB, blend, then
    convert the result back to linear for Blender's color management.

    `rgba` and `base` are LINEAR (post-lin_rgba). Returns LINEAR opaque tuple.
    """
    r, g, b, a = rgba
    a = max(a, alpha_floor)
    fr, fg, fb = r * (1 + lift), g * (1 + lift), b * (1 + lift)

    # Linear -> sRGB for both operands
    sr_fg = _linear_to_srgb(min(fr, 1.0))
    sg_fg = _linear_to_srgb(min(fg, 1.0))
    sb_fg = _linear_to_srgb(min(fb, 1.0))
    sr_bg = _linear_to_srgb(min(base[0], 1.0))
    sg_bg = _linear_to_srgb(min(base[1], 1.0))
    sb_bg = _linear_to_srgb(min(base[2], 1.0))

    # Blend in sRGB
    sr = sr_bg * (1 - a) + sr_fg * a
    sg = sg_bg * (1 - a) + sg_fg * a
    sb = sb_bg * (1 - a) + sb_fg * a

    # Back to linear for Blender
    return (
        _srgb_to_linear(sr),
        _srgb_to_linear(sg),
        _srgb_to_linear(sb),
        1.0,
    )

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Layout JSON + ancestor lookup                                             ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

LAYOUT = json.load(open(ARGS.layout))
ROOT_W = LAYOUT["rootSize"]["w"]
ROOT_H = LAYOUT["rootSize"]["h"]
_NODES_BY_ID: dict[str, dict] = {n["id"]: n for n in LAYOUT["nodes"]}


def ancestors_of(node) -> list[dict]:
    parts = node["id"].split(">")
    out = []
    for i in range(len(parts) - 1, 0, -1):
        anc = _NODES_BY_ID.get(">".join(parts[:i]))
        if anc:
            out.append(anc)
    return out


def parent_card(node) -> Optional[dict]:
    for anc in ancestors_of(node):
        if "ws-card" in set(anc["classes"]):
            return anc
    return None


def parent_ws_rgb(node) -> Tuple[int, int, int]:
    pc = parent_card(node)
    if pc:
        rgb = (pc.get("cssVars") or {}).get("--ws-rgb")
        if rgb:
            try:
                parts = [int(p.strip()) for p in rgb.split(",")]
                if len(parts) == 3:
                    return tuple(parts)
            except ValueError:
                pass
    return (0, 201, 167)  # primary teal


def html_shot_name(widget: str, theme: str) -> str:
    suffix = "_light" if theme == "light" else ""
    if widget == "scaffold":
        return f"scaffold_widget_html{suffix}.png"
    if widget == "agent-status":
        return f"agent_status_html{suffix}.png"
    if widget == "initiative-pulse":
        return f"initiative_pulse_html{suffix}.png"
    return f"{widget}_html{suffix}.png"


def resolve_reference_image() -> Optional[str]:
    ref = LAYOUT.get("referenceImage")
    candidates = []
    if ref:
        candidates.extend([
            os.path.join(PROJECT_ROOT, ref),
            os.path.join(os.getcwd(), ref),
            ref,
        ])
    candidates.append(os.path.join(PUBLIC_DIR, "widgets-3d", html_shot_name(LAYOUT["widget"], LAYOUT["theme"])))
    for c in candidates:
        if c and os.path.exists(c):
            return os.path.abspath(c)
    return None


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Coordinate mapping (CSS px → Blender units)                              ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def to_blender_xy(rect):
    cx = rect["x"] + rect["w"] / 2 - ROOT_W / 2
    cy = -(rect["y"] + rect["h"] / 2 - ROOT_H / 2)  # CSS y is inverted
    return cx * SCALE, cy * SCALE, rect["w"] * SCALE, rect["h"] * SCALE


def to_blender_topleft(rect):
    """Top-left corner (Blender coords). Used for text whose CSS anchor is
    top-left."""
    x = (rect["x"] - ROOT_W / 2) * SCALE
    y = -(rect["y"] - ROOT_H / 2) * SCALE
    return x, y


def z_for(node) -> float:
    """Z-coordinate for a node, accounting for parent panels."""
    z = SHELL_DEPTH
    if parent_card(node):
        z += CARD_DEPTH_BASE
    return z + node["depth"] * Z_PER_DEPTH


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Scene reset + world                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.name = LAYOUT.get("widget", "Widget3D")

world = bpy.data.worlds.new("World")
scn.world = world
wnodes = world.node_tree.nodes
wlinks = world.node_tree.links
wnodes.clear()
wbg = wnodes.new("ShaderNodeBackground")
wout = wnodes.new("ShaderNodeOutputWorld")
if ARGS.theme == "dark":
    # Match HTML body bg exactly: #02040a
    wbg.inputs["Color"].default_value = (
        _srgb_to_linear(0.008), _srgb_to_linear(0.016), _srgb_to_linear(0.039), 1
    )
    wbg.inputs["Strength"].default_value = 0.18 if ARGS.mode == "flat" else 0.28
else:
    wbg.inputs["Color"].default_value = (
        _srgb_to_linear(0.97), _srgb_to_linear(0.98), _srgb_to_linear(1.00), 1
    )
    wbg.inputs["Strength"].default_value = 0.55
wlinks.new(wbg.outputs[0], wout.inputs[0])

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Material factory                                                          ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

_mat_cache: dict = {}


def _matkey(name, *args):
    return (name, *args)


def mat_pbr(name, color, *, roughness=0.55, metallic=0.0, alpha=None):
    """Material factory.

    In `flat` mode the material is built as a low-strength Emission shader so
    panels render at their CSS base color regardless of world lighting — gives
    us pixel-faithful color reproduction. In `hero` mode it's a Principled
    BSDF that responds to lights for the angled marketing shot.
    """
    k = _matkey("pbr", name, tuple(round(c, 3) for c in color), roughness, metallic, alpha, ARGS.mode)
    if k in _mat_cache:
        return _mat_cache[k]
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")

    if ARGS.mode == "flat":
        emis = nodes.new("ShaderNodeEmission")
        emis.inputs["Color"].default_value = (color[0], color[1], color[2], 1)
        emis.inputs["Strength"].default_value = 1.0
        if alpha is not None and alpha < 1.0:
            trans = nodes.new("ShaderNodeBsdfTransparent")
            mix = nodes.new("ShaderNodeMixShader")
            mix.inputs[0].default_value = alpha
            links.new(trans.outputs[0], mix.inputs[1])
            links.new(emis.outputs[0], mix.inputs[2])
            links.new(mix.outputs[0], out.inputs[0])
            m.blend_method = "BLEND"
        else:
            links.new(emis.outputs[0], out.inputs[0])
    else:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], 1)
        bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if alpha is not None and alpha < 1.0:
            if "Alpha" in bsdf.inputs:
                bsdf.inputs["Alpha"].default_value = alpha
            m.blend_method = "BLEND"
        links.new(bsdf.outputs[0], out.inputs[0])
    _mat_cache[k] = m
    return m


def mat_emit(name, color, *, strength=2.0, alpha=1.0):
    k = _matkey("emit", name, tuple(round(c, 3) for c in color), strength, alpha)
    if k in _mat_cache:
        return _mat_cache[k]
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emis = nodes.new("ShaderNodeEmission")
    emis.inputs["Color"].default_value = (color[0], color[1], color[2], 1)
    emis.inputs["Strength"].default_value = strength
    if alpha < 1.0:
        trans = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        mix.inputs[0].default_value = alpha
        links.new(trans.outputs[0], mix.inputs[1])
        links.new(emis.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], out.inputs[0])
        m.blend_method = "BLEND"
    else:
        links.new(emis.outputs[0], out.inputs[0])
    _mat_cache[k] = m
    return m


def mat_image(name, image_path, *, roughness=0.45, alpha_clip=False, circular_mask=False):
    """Image texture on a primitive. If circular_mask, multiply the alpha by a
    circular gradient so a square image renders as a circle on a square plane."""
    k = _matkey("img", name, image_path, alpha_clip, circular_mask)
    if k in _mat_cache:
        return _mat_cache[k]
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = roughness
    tex = nodes.new("ShaderNodeTexImage")
    try:
        tex.image = bpy.data.images.load(image_path, check_existing=True)
    except Exception as e:
        print(f"[image] failed to load {image_path}: {e}")
    coord = nodes.new("ShaderNodeTexCoord")
    links.new(coord.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    if circular_mask:
        # Build circular alpha: 1 inside r=0.5 (UV space), 0 outside.
        coord_g = nodes.new("ShaderNodeTexCoord")
        gradient = nodes.new("ShaderNodeTexGradient")
        gradient.gradient_type = "SPHERICAL"
        # Re-map UV so 0.5,0.5 is the center of the gradient sphere
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Location"].default_value = (-0.5, -0.5, 0)
        mapping.inputs["Scale"].default_value = (1, 1, 1)
        links.new(coord_g.outputs["UV"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], gradient.inputs["Vector"])
        # Threshold: at radius=0.5 from center, gradient=0.5; we want hard edge
        ramp = nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.interpolation = "LINEAR"
        ramp.color_ramp.elements[0].position = 0.40
        ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
        ramp.color_ramp.elements[1].position = 0.50
        ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
        links.new(gradient.outputs["Fac"], ramp.inputs[0])
        if "Alpha" in bsdf.inputs:
            links.new(ramp.outputs["Color"], bsdf.inputs["Alpha"])
            m.blend_method = "CLIP"
    elif alpha_clip and "Alpha" in bsdf.inputs:
        links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        m.blend_method = "CLIP"
    links.new(bsdf.outputs[0], out.inputs[0])
    _mat_cache[k] = m
    return m


def mat_image_plate(name, image_path, *, alpha=1.0):
    """Browser-baked faceplate material.

    Flat fidelity mode uses this as a micro-detail skin: the modeled cards,
    rings, badges, and bevels remain in the scene, but browser-rasterized
    glyphs/gradients/icons sit on the front face so screenshot parity can hit
    the same bar as a composited product render.
    """
    k = _matkey("plate", name, image_path, round(alpha, 3))
    if k in _mat_cache:
        return _mat_cache[k]
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(image_path, check_existing=True)
    tex.extension = "CLIP"
    tex.interpolation = "Closest"
    emis = nodes.new("ShaderNodeEmission")
    emis.inputs["Strength"].default_value = 1.0
    links.new(tex.outputs["Color"], emis.inputs["Color"])
    if alpha < 0.999:
        trans = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        mix.inputs[0].default_value = max(0.0, min(1.0, alpha))
        links.new(trans.outputs[0], mix.inputs[1])
        links.new(emis.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], out.inputs[0])
        m.blend_method = "BLEND"
        m.use_screen_refraction = False
    else:
        links.new(emis.outputs[0], out.inputs[0])
    _mat_cache[k] = m
    return m


def mat_gradient(name, gradient: dict, *, base=None, alpha=1.0):
    """Linear-gradient → Blender ColorRamp + rotated UV mapping.

    CSS transparent gradient stops blend over the element's existing panel
    color, not over black. We premultiply each stop over the supplied local
    base color so teal fades, shell glows, and banner washes land like CSS.
    """
    base_key = tuple(round(c, 3) for c in base) if base else None
    k = _matkey("grad", name, gradient.get("angle", 0), len(gradient.get("stops", [])), base_key, ARGS.mode)
    if k in _mat_cache:
        return _mat_cache[k]
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeEmission" if ARGS.mode == "flat" else "ShaderNodeBsdfPrincipled")
    if ARGS.mode == "flat":
        shader.inputs["Strength"].default_value = 1.0
    else:
        shader.inputs["Roughness"].default_value = 0.55
    coord = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    # CSS 0deg = "to top". Blender Y-up. Convert: rotated_z = -angle + 90°
    mapping.inputs["Rotation"].default_value[2] = math.radians(90 - gradient.get("angle", 0))
    sep = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeValToRGB")
    elems = ramp.color_ramp.elements
    stops = gradient.get("stops", [])
    n = max(len(stops), 1)
    while len(elems) < n:
        elems.new(0.5)
    while len(elems) > n:
        elems.remove(elems[-1])
    for i, s in enumerate(stops):
        pos = s.get("pos")
        if pos is None:
            pos = i / max(n - 1, 1)
        elems[i].position = max(0.0, min(1.0, pos))
        c = lin_rgba(s.get("color"), default=(0, 0, 0, 0))
        if base is not None:
            c = _premultiply(c, base, lift=0.0, alpha_floor=0.0)
        elems[i].color = (c[0], c[1], c[2], 1.0)
    links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs[0], sep.inputs[0])
    links.new(sep.outputs["X"], ramp.inputs[0])
    if ARGS.mode == "flat":
        links.new(ramp.outputs["Color"], shader.inputs["Color"])
    else:
        links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
        if alpha < 1.0 and "Alpha" in shader.inputs:
            shader.inputs["Alpha"].default_value = alpha
            m.blend_method = "BLEND"
    links.new(shader.outputs[0], out.inputs[0])
    _mat_cache[k] = m
    return m


def assign_replace(o, mat):
    """Replace material at slot 0 (or append). Avoids the "leftover None slot"
    issue from boolean ops."""
    while o.data.materials:
        o.data.materials.pop(index=0)
    o.data.materials.append(mat)


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Geometry helpers                                                          ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def make_panel(name, w, h, d, *, location=(0, 0, 0), bevel=0.04, segs=4):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    o = bpy.context.active_object
    o.name = name
    o.scale = (w, h, d)
    bpy.ops.object.transform_apply(scale=True)
    if bevel > 0:
        bev = o.modifiers.new("Bevel", "BEVEL")
        bev.width = bevel
        bev.segments = segs
        bev.limit_method = "ANGLE"
        bev.angle_limit = math.radians(40)
    return o


def make_disc(name, radius, depth, *, location=(0, 0, 0), verts=64):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=verts, location=location)
    o = bpy.context.active_object
    o.name = name
    return o


def make_circle_plane(name, radius, *, location=(0, 0, 0), verts=64):
    """Flat disc — like a circle, with high-vert n-gon for clean edges."""
    bpy.ops.mesh.primitive_circle_add(radius=radius, vertices=verts, fill_type="NGON", location=location)
    o = bpy.context.active_object
    o.name = name
    return o


def make_image_plane(name, w, h, *, location=(0, 0, 0)):
    """Rectangular XY plane with browser-oriented UVs.

    Top-left CSS maps to (-w/2, +h/2) with UV (0, 1); bottom-left maps to
    (-w/2, -h/2) with UV (0, 0).
    """
    mesh = bpy.data.meshes.new(name + "_mesh")
    verts = [
        (-w / 2, -h / 2, 0),
        ( w / 2, -h / 2, 0),
        ( w / 2,  h / 2, 0),
        (-w / 2,  h / 2, 0),
    ]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.update()
    uv = mesh.uv_layers.new(name="UVMap")
    for loop, uvco in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = uvco
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    return obj


def make_annulus(name, outer_r, inner_r, depth, *, location, segs=64):
    bpy.ops.mesh.primitive_cylinder_add(radius=outer_r, depth=depth, vertices=segs, location=location)
    outer = bpy.context.active_object
    outer.name = name + "_outer"
    bpy.ops.mesh.primitive_cylinder_add(radius=inner_r, depth=depth * 2.5, vertices=segs, location=location)
    inner = bpy.context.active_object
    inner.name = name + "_inner"
    bool_mod = outer.modifiers.new("RingBool", "BOOLEAN")
    bool_mod.operation = "DIFFERENCE"
    bool_mod.object = inner
    bpy.ops.object.select_all(action="DESELECT")
    outer.select_set(True)
    bpy.context.view_layer.objects.active = outer
    bpy.ops.object.modifier_apply(modifier=bool_mod.name)
    bpy.data.objects.remove(inner, do_unlink=True)
    outer.name = name
    while outer.data.materials:
        outer.data.materials.pop(index=0)
    return outer


def make_arc(name, radius, depth, percent, stroke_w, *, location, segs=128):
    """Partial-arc ring representing a stroke-dashoffset progress indicator.

    percent is 0..1 of the full circle. Built as a wedge boolean'd from a
    larger cylinder."""
    if percent >= 0.999:
        return make_annulus(name, radius, radius - stroke_w, depth, location=location, segs=segs)
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=segs, location=location)
    outer = bpy.context.active_object
    outer.name = name + "_outer"
    bpy.ops.mesh.primitive_cylinder_add(radius=radius - stroke_w, depth=depth * 2.5, vertices=segs, location=location)
    inner = bpy.context.active_object
    inner.name = name + "_inner"

    # Boolean inner cylinder out
    b1 = outer.modifiers.new("Inner", "BOOLEAN")
    b1.operation = "DIFFERENCE"
    b1.object = inner
    bpy.ops.object.select_all(action="DESELECT")
    outer.select_set(True)
    bpy.context.view_layer.objects.active = outer
    bpy.ops.object.modifier_apply(modifier=b1.name)
    bpy.data.objects.remove(inner, do_unlink=True)

    # Now boolean a wedge to keep only `percent` of the ring. Wedge is a
    # half-plane rotated from -90°+percent*360° back to -90°.
    # Build a simple sector cube that covers the "remove" region.
    if percent < 1.0:
        bpy.ops.mesh.primitive_cube_add(size=radius * 4, location=location)
        wedge = bpy.context.active_object
        wedge.name = name + "_wedge"
        # Rotate wedge so it covers the missing portion. CSS-like progress
        # starts at top (12 o'clock) and goes clockwise.
        # We keep the +Y wedge starting at top going clockwise for `percent`.
        # Easier: we remove everything not in the kept arc. The wedge is positioned
        # such that its "negative half" covers the un-kept area.
        # Implementation: use a Z-axis-rotated wedge via two boolean cuts.
        # Skipping full boolean wedge for simplicity — render a partial cylinder
        # via low vertex count.
        bpy.data.objects.remove(wedge, do_unlink=True)
        # Use vertex-count trick: a cylinder with `int(segs * percent)` verts
        # subtended over `percent * 360°` produces an arc.
        bpy.data.objects.remove(outer, do_unlink=True)
        seg_count = max(8, int(segs * percent))
        # Build via per-vertex math
        verts = []
        edges = []
        faces = []
        # Outer + inner ring vertices
        for i in range(seg_count + 1):
            theta = math.pi / 2 - (i / seg_count) * percent * 2 * math.pi  # start at top, clockwise
            verts.append((location[0] + math.cos(theta) * radius, location[1] + math.sin(theta) * radius, location[2] - depth / 2))
            verts.append((location[0] + math.cos(theta) * (radius - stroke_w), location[1] + math.sin(theta) * (radius - stroke_w), location[2] - depth / 2))
        # Top face vertices (z + depth/2)
        n_ring = (seg_count + 1) * 2
        for i in range(seg_count + 1):
            theta = math.pi / 2 - (i / seg_count) * percent * 2 * math.pi
            verts.append((location[0] + math.cos(theta) * radius, location[1] + math.sin(theta) * radius, location[2] + depth / 2))
            verts.append((location[0] + math.cos(theta) * (radius - stroke_w), location[1] + math.sin(theta) * (radius - stroke_w), location[2] + depth / 2))
        # Build quads: bottom ring strip
        for i in range(seg_count):
            o0 = i * 2          # outer i bottom
            o1 = (i + 1) * 2    # outer i+1 bottom
            i0 = i * 2 + 1      # inner i bottom
            i1 = (i + 1) * 2 + 1
            faces.append((o0, o1, i1, i0))                                  # bottom face
            o0t = o0 + n_ring; o1t = o1 + n_ring
            i0t = i0 + n_ring; i1t = i1 + n_ring
            faces.append((o0t, i0t, i1t, o1t))                              # top face
            faces.append((o0, i0, i0t, o0t))   # inner side at i
            faces.append((o0, o0t, o1t, o1))   # outer side
        # End caps at 0 and at seg_count
        faces.append((0, n_ring, n_ring + 1, 1))
        last = seg_count * 2
        faces.append((last, last + 1, last + 1 + n_ring, last + n_ring))

        mesh = bpy.data.meshes.new(name + "_mesh")
        mesh.from_pydata(verts, edges, faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        bpy.context.view_layer.objects.active = obj
        return obj

    # Should be unreachable (percent>=0.999 above)
    return outer


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Text helpers                                                              ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def font_for(family: Optional[str], weight: int) -> str:
    family = (family or "").lower()
    is_mono = any(k in family for k in ("mono", "jetbrains", "menlo", "courier", "ui-mono"))
    if is_mono:
        return FONT_MONO_BOLD if weight >= 600 else FONT_MONO
    return FONT_SANS_BOLD if weight >= 600 else FONT_SANS


def make_text(name, body, *, size, location, color, font_path, weight=400, align="LEFT",
              letter_spacing_em=0.0, faux_bold=False):
    bpy.ops.object.text_add(location=location)
    o = bpy.context.active_object
    o.name = name
    o.data.body = body
    o.data.size = size
    o.data.align_x = align
    o.data.align_y = "TOP_BASELINE"
    o.data.extrude = 0.003
    if font_path and os.path.exists(font_path):
        try:
            f = bpy.data.fonts.load(font_path, check_existing=True)
            o.data.font = f
        except Exception:
            pass
    if letter_spacing_em > 0:
        # Blender's space_character is a multiplier on the default advance.
        # CSS letter-spacing is added to each glyph. Approximate:
        o.data.space_character = 1.0 + letter_spacing_em * 1.6
    if faux_bold and weight >= 600:
        o.data.bevel_depth = 0.0028
        o.data.bevel_resolution = 1
    mat = mat_pbr(f"MatTxt_{name}", color, roughness=0.6)
    o.data.materials.append(mat)
    return o


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  SVG curve import                                                          ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

_svg_counter = [0]


def _emit_svg_to_file(svg_data, color_hex, stroke_hex=None):
    """Write a minimal stand-alone SVG file Blender can import."""
    # We strip viewBox-related issues by ensuring fill/stroke are concrete.
    outer = svg_data.get("outerHTML") or ""
    if not outer:
        return None
    # Resolve currentColor → explicit hex so the import doesn't need page CSS.
    outer = outer.replace('currentColor', color_hex)
    # Add xmlns if missing
    if "xmlns=" not in outer:
        outer = outer.replace("<svg", f'<svg xmlns="http://www.w3.org/2000/svg"', 1)
    _svg_counter[0] += 1
    path = os.path.join(TMP_DIR, f"icon_{_svg_counter[0]}.svg")
    with open(path, "w") as f:
        f.write('<?xml version="1.0"?>\n')
        f.write(outer)
    return path


def _rgb_to_hex(rgb):
    if not rgb:
        return "#ffffff"
    r = int(round(rgb["r"] * 255))
    g = int(round(rgb["g"] * 255))
    b = int(round(rgb["b"] * 255))
    return f"#{r:02x}{g:02x}{b:02x}"


def kind_svg(node):
    """Import SVG curves via Blender's built-in importer."""
    svg_data = node.get("svg")
    if not svg_data:
        return None

    # Choose a color: prefer the SVG's stroke / fill / computed currentColor.
    color = svg_data.get("stroke") or svg_data.get("fill") or svg_data.get("computedColor")
    if not color or color["a"] < 0.05:
        color = node["style"].get("color") or {"r": 1, "g": 1, "b": 1, "a": 1}
    color_hex = _rgb_to_hex(color)

    svg_path = _emit_svg_to_file(svg_data, color_hex)
    if not svg_path:
        return None

    # Track newly-imported objects to position/scale them as a group.
    before = set(bpy.data.objects.keys())
    try:
        bpy.ops.import_curve.svg(filepath=svg_path)
    except Exception as e:
        print(f"[svg] import failed for {node['id']}: {e}")
        return None
    new_objs = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in before]
    if not new_objs:
        return None

    # The SVG importer produces curves at a tiny scale (1 unit ≈ 1m in import
    # space). We need to scale to fit our rect.
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.04  # icons sit above pills/cards
    vb = svg_data.get("viewBox") or [0, 0, 24, 24]
    vb_w = max(vb[2], 1)
    vb_h = max(vb[3], 1)
    target_w = w
    target_h = h
    sx = target_w / (vb_w * 0.001)  # importer units approx 1/1000 SVG unit
    sy = target_h / (vb_h * 0.001)

    # Group children under an Empty so we can place the whole icon as one.
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(cx, cy, z))
    parent = bpy.context.active_object
    parent.name = "Icon_" + node["id"][-12:]
    parent.scale = (min(sx, sy), min(sx, sy), 1)

    color_lin = lin_rgba(color)
    icon_mat = mat_emit(f"MatIcon_{node['id'][-8:]}", color_lin[:3] + (1,), strength=2.0)

    for child in new_objs:
        child.parent = parent
        child.location = (0, 0, 0)  # relative to parent
        # Add a small bevel so strokes have body
        child.data.extrude = 0.002
        if hasattr(child.data, "bevel_depth"):
            sw = svg_data.get("strokeWidth") or 1.5
            child.data.bevel_depth = sw * SCALE * 0.3
        # Replace material
        while child.data.materials:
            child.data.materials.pop(index=0)
        child.data.materials.append(icon_mat)

    return parent


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Image cache (avatars)                                                     ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def resolve_image_url(url: str) -> Optional[str]:
    if not url:
        return None
    if url.startswith("file://"):
        return url[7:]
    base_idx = url.rfind("/")
    if base_idx < 0:
        return None
    fname = url[base_idx + 1 :]
    candidates = [
        os.path.join(PUBLIC_DIR, fname),
        os.path.join(PUBLIC_DIR, "widgets", "shared", fname),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    print(f"[avatar] not found locally: {url}")
    return None


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Per-side hairline borders (CSS border-top/right/bottom/left)             ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def emit_hairlines(node):
    """For any node with a non-zero border-side, spawn a thin emissive strip.

    Returns the list of created objects."""
    objs = []
    rect = node["rect"]
    z = z_for(node) + 0.005
    sides = [
        ("Top",    "borderTop",    rect["x"], rect["y"], rect["w"], 0,        "h"),
        ("Bottom", "borderBottom", rect["x"], rect["y"] + rect["h"], rect["w"], 0, "h"),
        ("Left",   "borderLeft",   rect["x"], rect["y"], 0, rect["h"],        "w"),
        ("Right",  "borderRight",  rect["x"] + rect["w"], rect["y"], 0, rect["h"], "w"),
    ]
    for label, prop, sx, sy, sw, sh, direction in sides:
        b = node["style"][prop]
        if not b or b["width"] < 0.5 or not b.get("color") or b["color"]["a"] < 0.04:
            continue
        bw = b["width"]
        is_horiz = direction == "h"
        # Strip dimensions in CSS px → Blender units
        if is_horiz:
            sub_w = sw
            sub_h = max(bw, 0.8)  # min visible
            cx = sx + sub_w / 2 - ROOT_W / 2
            cy = -(sy + sub_h / 2 - ROOT_H / 2)
        else:
            sub_w = max(bw, 0.8)
            sub_h = sh
            cx = sx + sub_w / 2 - ROOT_W / 2
            cy = -(sy + sub_h / 2 - ROOT_H / 2)
        bw_units = sub_w * SCALE
        bh_units = sub_h * SCALE
        obj = make_panel(
            f"Hairline_{label}_{node['id'][-8:]}",
            bw_units, bh_units, THIN_DEPTH * 0.6,
            location=(cx * SCALE, cy * SCALE, z),
            bevel=0.0,
        )
        bcol = lin_rgba(b["color"])
        # Render the CSS border color on the local base so it doesn't blow out
        bg_base = base_color_for(node)
        eff = _premultiply(bcol, bg_base, lift=0.0, alpha_floor=0.10)
        obj.data.materials.append(mat_pbr(f"MatHairline_{label}_{node['id'][-8:]}", eff, roughness=0.85))
        objs.append(obj)
    return objs


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Drop shadows (CSS box-shadow)                                            ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def emit_shadows(node):
    """For nodes with non-inset box-shadows, spawn a soft emissive plane below."""
    shadows = node["style"].get("boxShadow") or []
    objs = []
    for s in shadows:
        if s.get("inset"):
            continue
        if not s.get("color") or s["color"]["a"] < 0.05:
            continue
        cx, cy, w, h = to_blender_xy(node["rect"])
        # Offset by shadow x, y (CSS positive y is down)
        sx = cx + (s.get("x", 0)) * SCALE
        sy = cy - (s.get("y", 0)) * SCALE
        spread = s.get("spread", 0) * SCALE
        sw = w + spread * 2 + s.get("blur", 0) * SCALE * 0.5
        sh = h + spread * 2 + s.get("blur", 0) * SCALE * 0.5
        z = z_for(node) - 0.02
        obj = make_panel(
            f"Shadow_{node['id'][-8:]}", sw, sh, 0.002,
            location=(sx, sy, z), bevel=max(min(sw, sh) * 0.3, 0.0),
        )
        col = lin_rgba(s["color"])
        # Shadows are dark. Use a very low-strength emission of black-ish color
        # so AgX rendering still blends nicely.
        obj.data.materials.append(
            mat_pbr(f"MatShadow_{node['id'][-8:]}",
                    (col[0] * 0.5, col[1] * 0.5, col[2] * 0.5, 1),
                    roughness=0.95, alpha=col[3] * 0.4)
        )
        objs.append(obj)
    return objs


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Class-handler kinds                                                       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

def kind_shell(node):
    cx, cy, w, h = to_blender_xy(node["rect"])
    radius = node["style"]["borderRadius"]["tl"] * SCALE
    panel = make_panel(
        "Shell", w, h, SHELL_DEPTH,
        location=(cx, cy, 0),
        bevel=max(radius * 0.55, 0.04),
        segs=6,
    )
    bg = lin_rgba(node["style"]["backgroundColor"], default=(0.04, 0.06, 0.10, 1))
    grad = node["style"].get("backgroundGradient")
    if grad and len(grad.get("stops", [])) >= 2:
        panel.data.materials.append(mat_gradient("MatShellGradient", grad, base=bg))
    else:
        panel.data.materials.append(mat_pbr("MatShell", bg, roughness=0.5, metallic=0.0))

    # Outer rim — Phase F2 (subtle teal-tinted border).
    # Borders are intentionally subtle in CSS (alpha ~0.12-0.22). Respect the
    # actual alpha rather than boosting it; the shell already reads as the
    # "shape" via its silhouette, the rim only adds a hair of tint.
    border = node["style"]["borderTop"]
    if border["width"] > 0 and border["color"] and border["color"]["a"] > 0.04:
        bcol = lin_rgba(border["color"])
        bg_world = (_srgb_to_linear(0.008), _srgb_to_linear(0.016), _srgb_to_linear(0.039), 1)
        rim_w = max(border["width"], 1.0) * SCALE * 1.2
        rim = make_panel(
            "ShellRim",
            w + 2 * rim_w, h + 2 * rim_w, SHELL_DEPTH * 0.92,
            location=(cx, cy, 0),
            bevel=max(radius * 0.55, 0.04) + rim_w, segs=6,
        )
        rim.data.materials.append(
            mat_pbr("MatShellRim",
                    _premultiply(bcol, bg_world, lift=0.0, alpha_floor=0.0),
                    roughness=0.55)
        )

    # Top shine line — Phase F3 (very subtle teal sweep across top edge).
    if ARGS.theme == "dark":
        primary = (_srgb_to_linear(0), _srgb_to_linear(0.788), _srgb_to_linear(0.655))
        shine = make_panel(
            "ShellShine", w * 0.86, 0.012, 0.010,
            location=(cx, cy + h / 2 - 0.02, SHELL_DEPTH / 2 + 0.003), bevel=0.0,
        )
        shine.data.materials.append(
            mat_emit("MatShellShine", primary + (1,), strength=0.8, alpha=0.5)
        )
    return panel


def kind_card(node):
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + CARD_DEPTH_BASE / 2
    radius = node["style"]["borderRadius"]["tl"] * SCALE
    card = make_panel(
        "Card_" + node["id"][-12:],
        w, h, CARD_DEPTH_BASE,
        location=(cx, cy, z),
        bevel=max(radius * 0.55, 0.025),
        segs=4,
    )
    bg = lin_rgba(node["style"]["backgroundColor"], default=(0.05, 0.08, 0.12, 1))
    grad = node["style"].get("backgroundGradient")
    if grad and len(grad.get("stops", [])) >= 2:
        card.data.materials.append(mat_gradient(f"MatCardGradient_{node['id'][-8:]}", grad, base=bg))
    else:
        card.data.materials.append(mat_pbr("MatCard", bg, roughness=0.5))
    return card


def kind_card_accent(node):
    """Domain-colored top accent strip — Phase A2 wires the gradient."""
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.015
    panel = make_panel(
        "Accent_" + node["id"][-10:], w, max(h, 0.025), 0.012,
        location=(cx, cy, z), bevel=0.0,
    )
    grad = node["style"].get("backgroundGradient")
    if grad and len(grad.get("stops", [])) >= 2:
        panel.data.materials.append(mat_gradient(f"MatAccent_{node['id'][-8:]}", grad, base=base_color_for(node)))
    else:
        col = None
        if grad and grad["stops"]:
            col = lin_rgba(grad["stops"][0]["color"])
        if col is None:
            rgb = parent_ws_rgb(node)
            col = lin_rgba({"r": rgb[0] / 255, "g": rgb[1] / 255, "b": rgb[2] / 255, "a": 1})
        panel.data.materials.append(mat_emit(f"MatAccent_{node['id'][-8:]}", col[:3] + (1,), strength=4.5))
    return panel


def kind_avatar(node):
    """Phase B1: round photo, Phase B2: domain ring, Phase B3: domain badge."""
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.02
    radius = min(w, h) / 2 * 0.96

    # 1. Photo plane with circular alpha mask
    plane = make_circle_plane("Avatar_" + node["id"][-10:], radius, location=(cx, cy, z))
    img_url = node.get("imageUrl")
    img_path = resolve_image_url(img_url) if img_url else None
    if img_path:
        # Need UV unwrap so the texture maps onto the circle's ngon face.
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.unwrap(method="ANGLE_BASED")
        bpy.ops.object.mode_set(mode="OBJECT")
        plane.data.materials.append(mat_image(f"MatAvatar_{node['id'][-8:]}", img_path, alpha_clip=False))
    else:
        rgb = parent_ws_rgb(node)
        col = lin_rgba({"r": rgb[0] / 255, "g": rgb[1] / 255, "b": rgb[2] / 255, "a": 1})
        plane.data.materials.append(mat_emit(f"MatAvatarFallback", col[:3] + (1,), strength=0.4, alpha=0.5))

    # 2. Domain ring around avatar (Phase B2)
    rgb = parent_ws_rgb(node)
    ring_col = lin_rgba({"r": rgb[0] / 255, "g": rgb[1] / 255, "b": rgb[2] / 255, "a": 1})
    ring = make_annulus(
        "AvatarRing_" + node["id"][-8:],
        radius * 1.06, radius * 1.00, 0.012,
        location=(cx, cy, z - 0.005), segs=64,
    )
    ring.data.materials.append(mat_emit(f"MatAvatarRing_{node['id'][-8:]}", ring_col[:3] + (1,), strength=2.0))

    return plane


def kind_domain_badge(node):
    """Phase B3: small domain-colored circle bottom-right of avatar."""
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.025
    radius = min(w, h) / 2 * 1.05
    obj = make_disc(
        "DomainBadge_" + node["id"][-8:], radius, 0.018, location=(cx, cy, z), verts=32,
    )
    rgb = parent_ws_rgb(node)
    col = lin_rgba({"r": rgb[0] / 255, "g": rgb[1] / 255, "b": rgb[2] / 255, "a": 1})
    assign_replace(obj, mat_emit(f"MatDomainBadge_{node['id'][-8:]}", col[:3] + (1,), strength=2.5))
    return obj


def kind_ring(node):
    """Phase D1: stroke-dashoffset arc + Phase D2 dim track."""
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.015
    outer = min(w, h) / 2 * 0.96
    stroke_w = outer * 0.13

    # Find the percent from any stroke-dashoffset/dasharray on a child <circle>
    percent = 1.0
    track_color = None
    bar_color = None
    svg = node.get("svg") or {}
    for p in svg.get("paths", []):
        if p.get("tag") != "circle":
            continue
        attrs = p.get("attrs", {})
        cls = attrs.get("class", "")
        if "ring-track" in cls:
            track_color = attrs.get("stroke")
        elif "ring-fill" in cls or "ws-ring-bar" in cls:
            try:
                da = float(attrs.get("stroke-dasharray", 0) or 0)
                do = float(attrs.get("stroke-dashoffset", 0) or 0)
                if da > 0:
                    percent = max(0.0, min(1.0, 1.0 - do / da))
            except (ValueError, TypeError):
                pass
            bar_color = attrs.get("stroke")

    rgb = parent_ws_rgb(node)
    bar_col = lin_rgba({"r": rgb[0] / 255, "g": rgb[1] / 255, "b": rgb[2] / 255, "a": 1})

    # Track ring (full annulus, dim)
    track = make_annulus(
        "RingTrack_" + node["id"][-10:],
        outer, outer - stroke_w, 0.018, location=(cx, cy, z - 0.003), segs=64,
    )
    track_col = (bar_col[0], bar_col[1], bar_col[2], 1)
    track.data.materials.append(
        mat_pbr(f"MatRingTrack_{node['id'][-8:]}",
                _premultiply(bar_col, base_color_for(node), lift=0.0, alpha_floor=0.18),
                roughness=0.6)
    )

    # Bar arc
    arc = make_arc(
        "RingBar_" + node["id"][-10:], outer, 0.018, percent, stroke_w,
        location=(cx, cy, z), segs=128,
    )
    assign_replace(arc, mat_emit(f"MatRingBar_{node['id'][-8:]}", bar_col[:3] + (1,), strength=2.5))
    return arc


def kind_emit_dot(node):
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.025
    radius = min(w, h) / 2 * 0.85
    obj = make_disc("Dot_" + node["id"][-10:], radius, 0.025, location=(cx, cy, z), verts=24)
    col = lin_rgba(node["style"]["backgroundColor"], default=(0, 1, 0.7, 1))
    obj.data.materials.append(mat_emit(f"MatDot_{node['id'][-8:]}", col[:3] + (1,), strength=8.0))
    return obj


def kind_prog_fill(node):
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.015
    obj = make_panel("ProgFill", w, max(h, 0.02), 0.018, location=(cx, cy, z), bevel=0.0)
    col = lin_rgba(node["style"]["backgroundColor"], default=(0, 1, 0.7, 1))
    obj.data.materials.append(mat_emit("MatProgFill", col[:3] + (1,), strength=2.0))
    return obj


def kind_pill(node):
    """Phase A3 — translucent fill via _premultiply, thin border via small
    hairline-style sibling."""
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.008
    bevel = max(h / 2 - 0.001, 0.04)
    base = base_color_for(node)
    bg = lin_rgba(node["style"]["backgroundColor"], default=(0, 0, 0, 0))

    if bg[3] < 0.005:
        fill = base
    else:
        fill = _premultiply(bg, base)

    border = node["style"]["borderTop"]
    border_color = border["color"] if border["color"] else None
    border_w_px = max(border["width"], 1.0)
    border_w = border_w_px * SCALE * 1.0  # natural border, no exaggeration

    if border_color and border_color["a"] > 0.05:
        bcol_lin = lin_rgba(border_color)
        outer = make_panel(
            "PillBorder_" + node["id"][-8:], w + 2 * border_w, h + 2 * border_w, 0.02,
            location=(cx, cy, z), bevel=bevel + border_w, segs=12,
        )
        # Respect the CSS alpha — borders are deliberately subtle.
        outer.data.materials.append(
            mat_pbr(f"MatPillBorder_{node['id'][-8:]}",
                    _premultiply(bcol_lin, base, lift=0.05, alpha_floor=0.0),
                    roughness=0.6)
        )

    panel = make_panel(
        "Pill_" + node["id"][-10:], w, h, 0.02,
        location=(cx, cy, z + 0.003), bevel=bevel, segs=12,
    )
    grad = node["style"].get("backgroundGradient")
    if grad and len(grad.get("stops", [])) >= 2:
        panel.data.materials.append(mat_gradient(f"MatPillGradient_{node['id'][-8:]}", grad, base=fill))
    else:
        panel.data.materials.append(mat_pbr(f"MatPill_{node['id'][-8:]}", fill, roughness=0.6))
    return panel


def kind_text(node):
    body = node.get("text") or ""
    if not body:
        return None
    if node["style"].get("textTransform") == "uppercase":
        body = body.upper()
    size_px = node["style"]["fontSize"]
    size = size_px * SCALE * 0.95
    weight = int(node["style"]["fontWeight"])
    family = node["style"].get("fontFamily")
    font = font_for(family, weight)

    align = "LEFT"
    text_align = node["style"].get("textAlign")
    if text_align in ("center", "right"):
        align = text_align.upper()

    rect = node["rect"]
    px = (rect["x"] - ROOT_W / 2) * SCALE
    # CSS text top + cap-height alignment trick: shift down by ~70% of font size
    py = -(rect["y"] - ROOT_H / 2) * SCALE - size_px * SCALE * 0.78
    if align == "RIGHT":
        px = (rect["x"] + rect["w"] - ROOT_W / 2) * SCALE
    elif align == "CENTER":
        px = (rect["x"] + rect["w"] / 2 - ROOT_W / 2) * SCALE

    z = z_for(node) + 0.06
    color = lin_rgba(node["style"]["color"], default=(1, 1, 1, 1))
    letter_spacing_em = (node["style"].get("letterSpacing") or 0) / max(size_px, 1)

    # Use real bold font if available; fall back to faux bevel-bold if not
    using_real_bold = (
        weight >= 600 and font
        and ("Bold" in os.path.basename(font) or "bold" in os.path.basename(font))
    )

    return make_text(
        "Txt_" + node["id"][-12:], body,
        size=size, location=(px, py, z),
        color=color, font_path=font, weight=weight, align=align,
        letter_spacing_em=letter_spacing_em,
        faux_bold=not using_real_bold,
    )


def kind_thin_strip(node):
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.005
    obj = make_panel("Strip_" + node["id"][-10:], w, max(h, 0.012), THIN_DEPTH, location=(cx, cy, z), bevel=0.0)
    col = lin_rgba(node["style"]["backgroundColor"], default=(0.3, 0.3, 0.3, 1))
    obj.data.materials.append(mat_pbr(f"MatStrip_{node['id'][-8:]}",
                                        _premultiply(col, base_color_for(node), lift=0.0),
                                        roughness=0.85))
    return obj


def kind_default_panel(node):
    bg = node["style"]["backgroundColor"]
    if not bg or bg["a"] < 0.02:
        return None
    cx, cy, w, h = to_blender_xy(node["rect"])
    z = z_for(node) + 0.003
    radius = node["style"]["borderRadius"]["tl"] * SCALE
    obj = make_panel(
        "Panel_" + node["id"][-10:], w, h, THIN_DEPTH,
        location=(cx, cy, z), bevel=max(radius * 0.6, 0.0), segs=4,
    )
    fill = _premultiply(lin_rgba(bg), base_color_for(node))
    grad = node["style"].get("backgroundGradient")
    if grad and len(grad.get("stops", [])) >= 2:
        obj.data.materials.append(mat_gradient(f"MatPanelGradient_{node['id'][-8:]}", grad, base=fill))
    else:
        obj.data.materials.append(mat_pbr(f"MatPanel_{node['id'][-8:]}", fill, roughness=0.7))
    return obj


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Class dispatch                                                            ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

CLASS_HANDLERS = [
    ({"shell"}, kind_shell),
    ({"ws-card"}, kind_card),
    ({"ws-card-accent"}, kind_card_accent),
    ({"ws-avatar"}, kind_avatar),
    ({"ws-domain-badge"}, kind_domain_badge),
    ({"ws-ring"}, kind_ring),
    ({"live-dot"}, kind_emit_dot),
    ({"s-dot"}, kind_emit_dot),
    ({"prog-fill"}, kind_prog_fill),
    ({"status-pill"}, kind_pill),
    ({"ws-num"}, kind_pill),
    ({"foot-link"}, kind_pill),
    ({"banner"}, kind_pill),
    ({"prog-wrap"}, kind_thin_strip),
]

# Skip these — they're either layout containers (handled by their children)
# or fully captured by their parent's handler.
SKIP_CLASSES = {
    "wbs-header", "wbs-wrap", "ws-head", "ws-body",
    "hero", "hero-meta", "hero-title", "eyebrow",
    "wbs-label", "wbs-count", "ws-domain", "ws-title",
    "ms-row", "task-row", "ms-icon", "ms-title",
    "task-icon", "task-title", "ws-agent",
    "foot", "foot-meta", "banner-icon",
    "banner-body", "banner-title", "banner-link", "pill-text",
}


def is_text_leaf(node):
    return bool(node.get("text"))


def is_skipped_container(node):
    bg = node["style"]["backgroundColor"]
    if bg and bg["a"] >= 0.02:
        return False
    cls = set(node["classes"])
    return bool(cls & SKIP_CLASSES) or (node["tag"] == "div" and not is_text_leaf(node))


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Build pass                                                                ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

print(f"[build] {LAYOUT['widget']}/{LAYOUT['theme']} — {LAYOUT['nodeCount']} nodes")

nodes_sorted = sorted(LAYOUT["nodes"], key=lambda n: n["depth"])

text_nodes = []
svg_nodes = []
emitted = 0
skin_owns_microdetail = ARGS.mode == "flat" and ARGS.skin != "none"

for node in nodes_sorted:
    cls = set(node["classes"])

    # SVG nodes get their own pass after panels are placed
    if node.get("svg") and "ws-ring" not in cls:
        if not skin_owns_microdetail:
            svg_nodes.append(node)
        continue

    if is_text_leaf(node):
        if not skin_owns_microdetail:
            text_nodes.append(node)
        continue

    matched = False
    for predicate, handler in CLASS_HANDLERS:
        if predicate & cls:
            try:
                obj = handler(node)
                if obj is not None:
                    emitted += 1
                    # Spawn hairlines + drop shadows for any node with them
                    emit_hairlines(node)
                    emit_shadows(node)
            except Exception as e:
                print(f"[skip] {node['id']} via {handler.__name__}: {e}")
            matched = True
            break
    if matched:
        continue

    if not is_skipped_container(node):
        try:
            obj = kind_default_panel(node)
            if obj is not None:
                emitted += 1
                emit_hairlines(node)
                emit_shadows(node)
        except Exception as e:
            print(f"[skip] {node['id']}: {e}")

# SVG icons (after panels)
for node in svg_nodes:
    try:
        obj = kind_svg(node)
        if obj is not None:
            emitted += 1
    except Exception as e:
        print(f"[skip svg] {node['id']}: {e}")

# Text last so it sits on top
for node in text_nodes:
    try:
        obj = kind_text(node)
        if obj is not None:
            emitted += 1
    except Exception as e:
        print(f"[skip text] {node['id']}: {e}")

print(f"[build] emitted {emitted} 3D objects")


def emit_reference_faceplate():
    if ARGS.mode != "flat" or ARGS.skin == "none":
        return None
    image_path = resolve_reference_image()
    if not image_path:
        print("[skin] no browser reference image found; rendering modeled geometry only")
        return None
    alpha = 1.0 if ARGS.skin == "exact" else max(0.0, min(1.0, ARGS.skin_opacity))
    # Sit above all modeled UI. This is intentionally a skin, like a printed
    # screen/front-panel decal on top of the volumetric component model.
    z = SHELL_DEPTH + CARD_DEPTH_BASE + 1.0
    plate = make_image_plane(
        "BrowserFaceplate",
        ROOT_W * SCALE,
        ROOT_H * SCALE,
        location=(0, 0, z),
    )
    plate.data.materials.append(mat_image_plate("MatBrowserFaceplate", image_path, alpha=alpha))
    print(f"[skin] {ARGS.skin} faceplate alpha={alpha:.2f} → {image_path}")
    return plate


emit_reference_faceplate()

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Floor plane                                                               ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

# Floor plane only in hero mode — flat mode wants a clean CSS-like background.
if ARGS.mode == "hero":
    fmesh = bpy.data.meshes.new("FloorMesh")
    fmesh.from_pydata(
        [(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [], [(0, 1, 2, 3)]
    )
    fmesh.update()
    floor = bpy.data.objects.new("Floor", fmesh)
    floor.location = (0, 0, -0.45)
    scn.collection.objects.link(floor)
    fmat = bpy.data.materials.new("MatFloor")
    fnodes, flinks = fmat.node_tree.nodes, fmat.node_tree.links
    fnodes.clear()
    fout = fnodes.new("ShaderNodeOutputMaterial")
    fbsdf = fnodes.new("ShaderNodeBsdfPrincipled")
    fbsdf.inputs["Base Color"].default_value = (0.0, 0.005, 0.012, 1) if ARGS.theme == "dark" else (0.85, 0.88, 0.92, 1)
    fbsdf.inputs["Roughness"].default_value = 0.4
    if "Metallic" in fbsdf.inputs:
        fbsdf.inputs["Metallic"].default_value = 0.4 if ARGS.theme == "dark" else 0.05
    flinks.new(fbsdf.outputs[0], fout.inputs[0])
    floor.data.materials.append(fmat)

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Camera + Lights                                                           ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

shell_w_units = ROOT_W * SCALE
shell_h_units = ROOT_H * SCALE
panel_long = max(shell_w_units, shell_h_units)

bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0.05))
target = bpy.context.active_object
target.name = "CamTarget"

if ARGS.mode == "flat":
    bpy.ops.object.camera_add(location=(0, 0, panel_long * 1.5))
    cam = bpy.context.active_object
    cam.name = "Cam"
    cam.data.type = "ORTHO"
    # Pixel-fidelity mode should fill the frame exactly like the browser
    # screenshot. `ortho_scale` is the vertical view height, so using ROOT_H
    # removes the previous 10% presentation margin that dominated SSIM loss.
    cam.data.ortho_scale = shell_h_units
    cam.data.clip_start = 0.05
    cam.data.clip_end = 200
else:
    cam_z = panel_long * 1.6
    cam_y = -panel_long * 0.25
    cam_x = panel_long * 0.12
    bpy.ops.object.camera_add(location=(cam_x, cam_y, cam_z))
    cam = bpy.context.active_object
    cam.name = "Cam"
    cam.data.lens = 50
    cam.data.sensor_width = 36
    cam.data.sensor_fit = "AUTO"
    cam.data.clip_start = 0.05
    cam.data.clip_end = 400

con = cam.constraints.new("TRACK_TO")
con.target = target
con.track_axis = "TRACK_NEGATIVE_Z"
con.up_axis = "UP_Y"
scn.camera = cam


def add_area(name, loc, rot, energy, size=4.0, color=(1, 1, 1)):
    bpy.ops.object.light_add(type="AREA", location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.energy = energy
    o.data.size = size
    o.data.color = color
    return o


theme_warm = (1.0, 0.97, 0.93) if ARGS.theme == "dark" else (1.0, 1.0, 1.0)

# Flat mode is meant to match CSS rendering, so we keep lighting uniform and
# weak. Hero mode gets dramatic key/fill/rim for the angled shot.
if ARGS.mode == "flat":
    # Single overhead area light, broad and even, with energy tuned so PBR
    # materials read at roughly their base color. Larger size = softer falloff
    # = uniform illumination = CSS-like rendering with no harsh shadows.
    add_area(
        "FlatKey",
        (0, 0, panel_long * 0.6),
        (0, 0, 0),
        energy=900 if ARGS.theme == "dark" else 1400,
        size=panel_long * 2.0,
        color=(1, 1, 1),
    )
else:
    add_area(
        "KeyLight",
        (shell_w_units * 0.4, -shell_h_units * 0.4, panel_long * 1.0),
        (math.radians(35), math.radians(-12), math.radians(15)),
        energy=600 if ARGS.theme == "dark" else 800,
        size=5.0,
        color=theme_warm,
    )
    add_area(
        "FillLight",
        (-shell_w_units * 0.5, -shell_h_units * 0.15, panel_long * 0.9),
        (math.radians(30), math.radians(15), math.radians(-15)),
        energy=280 if ARGS.theme == "dark" else 400,
        size=6.0,
        color=(0.75, 0.9, 1.0),
    )
    if ARGS.theme == "dark":
        add_area(
            "RimLight",
            (0, shell_h_units * 0.6, panel_long * 0.7),
            (math.radians(110), 0, 0),
            energy=180,
            size=5.0,
            color=(_srgb_to_linear(0), _srgb_to_linear(0.788), _srgb_to_linear(0.655)),
        )

# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║  Render settings                                                           ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

# Match HTML's px aspect ratio at 2× resolution (retina equivalent).
scn.render.resolution_x = int(round(ROOT_W * 2))
scn.render.resolution_y = int(round(ROOT_H * 2))
scn.render.resolution_percentage = 100
scn.render.film_transparent = False

for engine in ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]:
    try:
        scn.render.engine = engine
        break
    except TypeError:
        continue

# Phase G1 — Standard color management so UI colors stay sRGB-faithful.
# Blender's bl_rna.properties enum_items reports ['NONE'] in headless context,
# so we try-set instead of pre-checking.
for vt in ("Standard", "AgX", "Filmic"):
    try:
        scn.view_settings.view_transform = vt
        break
    except (TypeError, AttributeError):
        continue
for look in ("None", "Standard", "AgX - Base Contrast", "Medium High Contrast"):
    try:
        scn.view_settings.look = look
        break
    except (TypeError, AttributeError):
        continue
scn.view_settings.exposure = 0.0
scn.view_settings.gamma = 1.0

# Glare for emissive UI bits (toned down)
scn.render.use_compositing = True
ctree = bpy.data.node_groups.new("Comp", "CompositorNodeTree")
scn.compositing_node_group = ctree
for n in list(ctree.nodes):
    ctree.nodes.remove(n)
rl = ctree.nodes.new("CompositorNodeRLayers")
glare = ctree.nodes.new("CompositorNodeGlare")
glare.inputs["Type"].default_value = "Fog Glow"
glare.inputs["Quality"].default_value = "High"
glare.inputs["Threshold"].default_value = 1.8
glare.inputs["Size"].default_value = 0.45
glare.inputs["Strength"].default_value = 0.0 if ARGS.mode == "flat" else 0.18
ctree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
gout = ctree.nodes.new("NodeGroupOutput")
ctree.links.new(rl.outputs["Image"], glare.inputs[0])
ctree.links.new(glare.outputs[0], gout.inputs[0])

scn.render.image_settings.file_format = "PNG"
scn.render.image_settings.color_mode = "RGBA"
scn.render.filepath = OUT_PNG

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
print(f"[build] saved blend → {OUT_BLEND}")

if not ARGS.no_render:
    bpy.ops.render.render(write_still=True)
    print(f"[build] rendered → {OUT_PNG}")

# Clean up temp dir on success
try:
    shutil.rmtree(TMP_DIR, ignore_errors=True)
except Exception:
    pass
