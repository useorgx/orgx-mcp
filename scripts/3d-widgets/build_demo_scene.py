"""
build_demo_scene.py

Cinematic OrgX MCP demo scene:
- rebuilt Claude-style interface as dimensional matte geometry
- readable Claude copy as decal textures
- deep scaffold widget world from the existing 3D widget pipeline
- 16:9 camera move from Claude workspace into the OrgX widget world

Run through npm scripts:
  pnpm widget3d:demo-scene     # styleframe + .blend
  pnpm widget3d:demo-encode    # frame sequence + mp4
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from typing import Optional, Tuple

import bpy


def parse_args():
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["styleframe", "animation", "no-render"], default="styleframe")
    p.add_argument("--out-dir", default="public/widgets-3d/demo-scene")
    p.add_argument("--texture-manifest", default="public/widgets-3d/demo-scene/textures/manifest.json")
    p.add_argument("--scaffold-blend", default="public/widgets-3d/scaffold_hero.blend")
    p.add_argument("--scaffold-layout", default="public/widgets-3d/scaffold.layout.json")
    p.add_argument("--scaffold-faceplate", default="public/widgets-3d/scaffold_widget_html.png")
    p.add_argument("--width", type=int, default=1920)
    p.add_argument("--height", type=int, default=1080)
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--seconds", type=float, default=20.0)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--styleframe-frame", type=int, default=336)
    return p.parse_args(argv)


ARGS = parse_args()
ROOT = os.getcwd()
OUT_DIR = os.path.abspath(ARGS.out_dir)
FRAME_DIR = os.path.join(OUT_DIR, "frames")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(FRAME_DIR, exist_ok=True)


def abspath(path: str) -> str:
    return path if os.path.isabs(path) else os.path.abspath(os.path.join(ROOT, path))


TEXTURE_MANIFEST = abspath(ARGS.texture_manifest)
SCAFFOLD_BLEND = abspath(ARGS.scaffold_blend)
SCAFFOLD_LAYOUT = abspath(ARGS.scaffold_layout)
SCAFFOLD_FACEPLATE = abspath(ARGS.scaffold_faceplate)
BLEND_OUT = os.path.join(OUT_DIR, "orgx_mcp_demo_scene.blend")
STYLEFRAME_OUT = os.path.join(OUT_DIR, "orgx_mcp_demo_styleframe.png")
MP4_OUT = os.path.join(OUT_DIR, "orgx_mcp_demo_preview.mp4")


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(value: str, alpha: float = 1.0) -> Tuple[float, float, float, float]:
    value = value.strip().lstrip("#")
    r = int(value[0:2], 16) / 255.0
    g = int(value[2:4], 16) / 255.0
    b = int(value[4:6], 16) / 255.0
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


COLORS = {
    "bg": hex_rgba("#02040a"),
    "panel": hex_rgba("#0a0f16"),
    "panel_2": hex_rgba("#0d131d"),
    "well": hex_rgba("#050912"),
    "border": hex_rgba("#1b2532"),
    "muted": hex_rgba("#64748b"),
    "text": hex_rgba("#f8fafc"),
    "teal": hex_rgba("#00c9a7"),
    "iris": hex_rgba("#6366f1"),
    "lime": hex_rgba("#d4ed31"),
    "amber": hex_rgba("#fbbf24"),
}


def make_mat(name, color, *, roughness=0.72, metallic=0.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], alpha)
    bsdf.inputs["Roughness"].default_value = roughness
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic
    if alpha < 1.0 and "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
    links.new(bsdf.outputs[0], out.inputs[0])
    return mat


def make_emit(name, color, *, strength=1.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (color[0], color[1], color[2], 1)
    emit.inputs["Strength"].default_value = strength
    if alpha < 1.0:
        trans = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        mix.inputs[0].default_value = alpha
        links.new(trans.outputs[0], mix.inputs[1])
        links.new(emit.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], out.inputs[0])
        mat.blend_method = "BLEND"
    else:
        links.new(emit.outputs[0], out.inputs[0])
    return mat


MAT_BG = None
MAT_PANEL = None
MAT_PANEL_2 = None
MAT_WELL = None
MAT_BORDER = None
MAT_TEAL = None
MAT_IRIS = None
MAT_DIM_TEAL = None


def build_materials():
    global MAT_BG, MAT_PANEL, MAT_PANEL_2, MAT_WELL, MAT_BORDER, MAT_TEAL, MAT_IRIS, MAT_DIM_TEAL
    MAT_BG = make_mat("Mat_MatteBackground", COLORS["bg"], roughness=0.9)
    MAT_PANEL = make_mat("Mat_MattePanel", COLORS["panel"], roughness=0.82, metallic=0.15)
    MAT_PANEL_2 = make_mat("Mat_ClaudeCard", COLORS["panel_2"], roughness=0.8, metallic=0.08)
    MAT_WELL = make_mat("Mat_RecessedWell", COLORS["well"], roughness=0.9, metallic=0.05)
    MAT_BORDER = make_mat("Mat_SubtleBorder", COLORS["border"], roughness=0.86)
    MAT_TEAL = make_emit("Mat_TealEdgeLight", COLORS["teal"], strength=1.4)
    MAT_IRIS = make_emit("Mat_IrisSignal", COLORS["iris"], strength=1.1)
    MAT_DIM_TEAL = make_emit("Mat_DimTeal", COLORS["teal"], strength=0.45, alpha=0.55)


def panel(name, w, h, d, *, loc=(0, 0, 0), bevel=0.035, mat=None, segs=5):
    if mat is None:
        mat = MAT_PANEL
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (w, h, d)
    bpy.ops.object.transform_apply(scale=True)
    if bevel > 0:
        mod = obj.modifiers.new(name="SoftBevel", type="BEVEL")
        mod.width = bevel
        mod.segments = segs
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(35)
        obj.modifiers.new(name="WeightedPanelNormals", type="WEIGHTED_NORMAL")
    obj.data.materials.append(mat)
    return obj


def image_material(name, image_path, *, alpha=1.0, closest=True, strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(image_path, check_existing=True)
    tex.extension = "CLIP"
    tex.interpolation = "Closest" if closest else "Linear"
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = strength
    links.new(tex.outputs["Color"], emit.inputs["Color"])
    trans = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = alpha
    alpha_mix = nodes.new("ShaderNodeMath")
    alpha_mix.operation = "MULTIPLY"
    alpha_mix.inputs[1].default_value = alpha
    links.new(tex.outputs["Alpha"], alpha_mix.inputs[0])
    links.new(alpha_mix.outputs[0], mix.inputs[0])
    links.new(trans.outputs[0], mix.inputs[1])
    links.new(emit.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs[0])
    mat.blend_method = "BLEND"
    if hasattr(mat, "use_screen_refraction"):
        mat.use_screen_refraction = False
    return mat


def image_plane(name, w, h, image_path, *, loc=(0, 0, 0), alpha=1.0, closest=True, strength=1.0):
    mesh = bpy.data.meshes.new(name + "_mesh")
    verts = [(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.update()
    uv = mesh.uv_layers.new(name="UVMap")
    for loop, uvco in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = uvco
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(image_material("Mat_" + name, image_path, alpha=alpha, closest=closest, strength=strength))
    return obj


def add_edge_line(name, x, y, z, w, *, mat=None):
    if mat is None:
        mat = MAT_TEAL
    obj = panel(name, w, 0.018, 0.012, loc=(x, y, z), bevel=0.0, mat=mat)
    return obj


def add_empty(name, loc=(0, 0, 0)):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def key(obj, frame, loc=None, scale=None, lens=None):
    bpy.context.scene.frame_set(frame)
    if loc is not None:
        obj.location = loc
        obj.keyframe_insert(data_path="location", frame=frame)
    if scale is not None:
        obj.scale = scale
        obj.keyframe_insert(data_path="scale", frame=frame)
    if lens is not None:
        obj.data.lens = lens
        obj.data.keyframe_insert(data_path="lens", frame=frame)


def set_bezier_interpolation():
    for action in bpy.data.actions:
        if not hasattr(action, "fcurves"):
            continue
        for fc in action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"
                kp.easing = "AUTO"


def load_manifest():
    with open(TEXTURE_MANIFEST, "r") as f:
        data = json.load(f)
    return data["textures"]


def texture_path(texture):
    return abspath(texture["path"])


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.name = "OrgX MCP Cinematic Demo"

    world = bpy.data.worlds.new("OrgX Cinematic World")
    world.use_nodes = True
    scn.world = world
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    bg = nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = COLORS["bg"]
    bg.inputs["Strength"].default_value = 0.20
    out = nodes.new("ShaderNodeOutputWorld")
    links.new(bg.outputs[0], out.inputs[0])

    for engine in ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]:
        try:
            scn.render.engine = engine
            break
        except TypeError:
            continue

    try:
        scn.eevee.taa_render_samples = max(1, ARGS.samples)
    except Exception:
        pass

    scn.render.resolution_x = ARGS.width
    scn.render.resolution_y = ARGS.height
    scn.render.resolution_percentage = 100
    scn.render.fps = ARGS.fps
    scn.frame_start = 1
    scn.frame_end = max(1, int(ARGS.fps * ARGS.seconds))
    scn.render.film_transparent = False
    scn.render.image_settings.file_format = "PNG"
    scn.render.image_settings.color_mode = "RGBA"

    for vt in ("AgX", "Standard", "Filmic"):
        try:
            scn.view_settings.view_transform = vt
            break
        except Exception:
            continue
    for look in ("Medium High Contrast", "AgX - Base Contrast", "None"):
        try:
            scn.view_settings.look = look
            break
        except Exception:
            continue
    scn.view_settings.exposure = -0.15
    scn.view_settings.gamma = 1.0
    return scn


def build_claude_interface(textures):
    root = add_empty("ClaudeInterfaceRoot")

    panel("Workspace_Backplate", 14.4, 8.15, 0.08, loc=(0, 0, -0.08), bevel=0.08, mat=MAT_BG, segs=10).parent = root
    panel("Claude_TopChrome", 14.4, 0.58, 0.09, loc=(0, 3.62, 0.02), bevel=0.03, mat=MAT_PANEL).parent = root
    panel("Claude_LeftRail", 0.58, 7.25, 0.10, loc=(-6.82, -0.08, 0.04), bevel=0.025, mat=MAT_PANEL).parent = root
    panel("Claude_ProjectBar", 5.1, 0.42, 0.06, loc=(-2.85, 3.10, 0.08), bevel=0.035, mat=MAT_WELL).parent = root
    panel("Claude_URLWell", 4.5, 0.20, 0.035, loc=(0.95, 3.62, 0.10), bevel=0.10, mat=MAT_WELL).parent = root

    for i, y in enumerate([2.85, 2.35, 1.85, 1.35, 0.85, 0.35, -0.15]):
        panel(f"Claude_RailGlyph_{i}", 0.16, 0.16, 0.04, loc=(-6.82, y, 0.13), bevel=0.035, mat=MAT_BORDER).parent = root

    project = image_plane("Decal_ProjectTitle", 2.85, 0.28, texture_path(textures["projectTitle"]), loc=(-4.40, 3.10, 0.14), alpha=0.92, strength=1.0)
    project.parent = root

    prompt_card = panel("Claude_UserPrompt_Card", 5.95, 1.28, 0.12, loc=(1.05, 2.15, 0.15), bevel=0.075, mat=MAT_WELL, segs=9)
    prompt_card.parent = root
    prompt = image_plane("Decal_UserPrompt", 5.22, 1.36, texture_path(textures["userPrompt"]), loc=(1.07, 2.15, 0.25), alpha=0.98, strength=1.0)
    prompt.parent = root

    response_card = panel("Claude_Response_Card", 6.85, 1.58, 0.12, loc=(0.25, 0.62, 0.13), bevel=0.055, mat=MAT_PANEL_2, segs=8)
    response_card.parent = root
    response = image_plane("Decal_AssistantPlan", 6.08, 1.75, texture_path(textures["assistantPlan"]), loc=(0.25, 0.60, 0.24), alpha=0.96, strength=1.0)
    response.parent = root

    composer = panel("Claude_Composer", 6.95, 0.74, 0.11, loc=(0.05, -3.42, 0.14), bevel=0.13, mat=MAT_PANEL_2, segs=14)
    composer.parent = root
    composer_decal = image_plane("Decal_Composer", 5.95, 0.73, texture_path(textures["composer"]), loc=(-0.06, -3.43, 0.25), alpha=0.80, strength=0.9)
    composer_decal.parent = root

    portal_frame = panel("OrgX_Portal_Recess", 4.35, 5.25, 0.15, loc=(2.55, -0.76, 0.02), bevel=0.055, mat=MAT_WELL, segs=8)
    portal_frame.parent = root
    add_edge_line("Portal_TopEdge", 2.55, 1.88, 0.17, 4.02, mat=MAT_TEAL).parent = root
    label = image_plane("Decal_PortalLabel", 2.00, 0.34, texture_path(textures["portalLabel"]), loc=(1.45, 1.56, 0.24), alpha=0.95, strength=1.0)
    label.parent = root

    final_label = image_plane("Decal_FinalLabel", 3.25, 0.55, texture_path(textures["finalLabel"]), loc=(2.55, -3.02, 0.26), alpha=0.0, strength=1.0)
    final_label.name = "Decal_FinalLabel_FadeIn"
    final_label.parent = root
    final_label["fade_in"] = True

    # Sparse spatial grid, very low contrast. It grounds the scene without
    # becoming a decorative pattern.
    for i, x in enumerate([v * 0.8 for v in range(-7, 8)]):
        grid = panel(f"SpatialGrid_V_{i}", 0.008, 7.0, 0.003, loc=(x, -0.20, -0.02), bevel=0, mat=MAT_BORDER)
        grid.parent = root
        grid.hide_render = i % 3 != 0
    for i, y in enumerate([v * 0.8 - 0.2 for v in range(-4, 5)]):
        grid = panel(f"SpatialGrid_H_{i}", 11.2, 0.008, 0.003, loc=(0.05, y, -0.021), bevel=0, mat=MAT_BORDER)
        grid.parent = root
        grid.hide_render = i % 3 != 0

    return root


def append_scaffold_world():
    if not os.path.exists(SCAFFOLD_BLEND):
        raise FileNotFoundError(f"Missing scaffold blend: {SCAFFOLD_BLEND}")
    if not os.path.exists(SCAFFOLD_LAYOUT):
        raise FileNotFoundError(f"Missing scaffold layout: {SCAFFOLD_LAYOUT}")
    if not os.path.exists(SCAFFOLD_FACEPLATE):
        raise FileNotFoundError(f"Missing scaffold faceplate: {SCAFFOLD_FACEPLATE}")

    with open(SCAFFOLD_LAYOUT, "r") as f:
        layout = json.load(f)
    root_w = float(layout["rootSize"]["w"]) * 0.01
    root_h = float(layout["rootSize"]["h"]) * 0.01

    anchor = add_empty("OrgXWidgetWorldRoot", loc=(2.55, -0.76, 0.43))
    anchor.scale = (0.50, 0.50, 0.50)

    excluded = {"Cam", "CamTarget", "Floor", "KeyLight", "FillLight", "RimLight", "FlatKey"}
    with bpy.data.libraries.load(SCAFFOLD_BLEND, link=False) as (data_from, data_to):
        data_to.objects = [name for name in data_from.objects if name not in excluded and not name.endswith("_inner")]

    appended = []
    for obj in data_to.objects:
        if obj is None:
            continue
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = anchor
        appended.append(obj)

    faceplate = image_plane(
        "OrgXWidget_Faceplate",
        root_w,
        root_h,
        SCAFFOLD_FACEPLATE,
        loc=(0, 0, 0.58),
        alpha=0.93,
        closest=True,
        strength=1.0,
    )
    faceplate.parent = anchor

    # Dimensional edge rails around the widget world: this gives the push-in
    # a physical silhouette even when the faceplate owns text/icon detail.
    edge_z = 0.42
    for name, x, y, w, h in [
        ("WidgetEdge_Top", 0, root_h / 2 + 0.05, root_w + 0.10, 0.018),
        ("WidgetEdge_Bottom", 0, -root_h / 2 - 0.05, root_w + 0.10, 0.018),
        ("WidgetEdge_Left", -root_w / 2 - 0.05, 0, 0.018, root_h + 0.10),
        ("WidgetEdge_Right", root_w / 2 + 0.05, 0, 0.018, root_h + 0.10),
    ]:
        rail = panel(name, w, h, 0.018, loc=(x, y, edge_z), bevel=0.0, mat=MAT_DIM_TEAL)
        rail.parent = anchor

    return anchor, appended


def add_lighting():
    bpy.ops.object.light_add(type="AREA", location=(-2.9, 3.6, 6.6), rotation=(math.radians(45), 0, math.radians(-18)))
    key = bpy.context.active_object
    key.name = "Key_SoftInstrumentPanel"
    key.data.energy = 460
    key.data.size = 5.0
    key.data.color = (1.0, 0.97, 0.93)

    bpy.ops.object.light_add(type="AREA", location=(4.6, -2.7, 4.0), rotation=(math.radians(52), 0, math.radians(22)))
    rim = bpy.context.active_object
    rim.name = "Rim_OrgXTeal"
    rim.data.energy = 120
    rim.data.size = 4.0
    rim.data.color = (0.0, 0.78, 0.65)

    bpy.ops.object.light_add(type="POINT", location=(2.55, -0.75, 1.85))
    pulse = bpy.context.active_object
    pulse.name = "Portal_InternalGlow"
    pulse.data.energy = 46
    pulse.data.color = (0.0, 0.78, 0.65)
    pulse.data.shadow_soft_size = 5.0


def add_camera(scene):
    target = add_empty("CameraTarget", loc=(0.05, 0.05, 0.05))
    bpy.ops.object.camera_add(location=(0.0, -0.05, 10.6), rotation=(0, 0, 0))
    cam = bpy.context.active_object
    cam.name = "CinematicCamera"
    cam.data.lens = 42
    cam.data.sensor_width = 36
    cam.data.clip_start = 0.03
    cam.data.clip_end = 200
    scene.camera = cam

    end = scene.frame_end
    frames = {
        "wide": 1,
        "prompt": int(end * 0.20),
        "response": int(end * 0.38),
        "portal": int(end * 0.56),
        "world": int(end * 0.78),
        "lock": end,
    }

    key(cam, frames["wide"], loc=(0.0, -0.04, 18.0), lens=32)
    key(target, frames["wide"], loc=(0.0, 0.0, 0.06))

    key(cam, frames["prompt"], loc=(0.58, 0.70, 14.0), lens=36)
    key(target, frames["prompt"], loc=(0.75, 1.88, 0.10))

    key(cam, frames["response"], loc=(0.65, 0.18, 13.0), lens=38)
    key(target, frames["response"], loc=(0.35, 0.40, 0.14))

    key(cam, frames["portal"], loc=(1.75, -0.35, 11.5), lens=42)
    key(target, frames["portal"], loc=(2.15, -0.50, 0.25))

    key(cam, frames["world"], loc=(2.43, -0.72, 10.5), lens=48)
    key(target, frames["world"], loc=(2.55, -0.76, 0.62))

    key(cam, frames["lock"], loc=(2.55, -0.72, 9.5), lens=50)
    key(target, frames["lock"], loc=(2.55, -0.76, 0.62))

    set_bezier_interpolation()
    return cam, target


def animate_reveals(scene):
    final_label = bpy.data.objects.get("Decal_FinalLabel_FadeIn")
    if final_label:
        start = int(scene.frame_end * 0.68)
        end = int(scene.frame_end * 0.78)
        mat = final_label.data.materials[0]
        mix = None
        for node in mat.node_tree.nodes:
            if node.bl_idname == "ShaderNodeMath" and node.operation == "MULTIPLY":
                mix = node
                break
        if mix:
            scene.frame_set(start)
            mix.inputs[1].default_value = 0.0
            mix.inputs[1].keyframe_insert("default_value", frame=start)
            scene.frame_set(end)
            mix.inputs[1].default_value = 0.88
            mix.inputs[1].keyframe_insert("default_value", frame=end)

    portal = bpy.data.objects.get("Portal_InternalGlow")
    if portal:
        for frame, energy in [(1, 16), (int(scene.frame_end * 0.55), 72), (scene.frame_end, 42)]:
            scene.frame_set(frame)
            portal.data.energy = energy
            portal.data.keyframe_insert(data_path="energy", frame=frame)


def encode_frames(scene):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("[encode] ffmpeg not found; frames rendered but mp4 skipped")
        return
    cmd = [
        ffmpeg,
        "-y",
        "-framerate",
        str(scene.render.fps),
        "-i",
        os.path.join(FRAME_DIR, "frame_%04d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-movflags",
        "+faststart",
        MP4_OUT,
    ]
    subprocess.run(cmd, check=True)
    print(f"[encode] {MP4_OUT}")


scene = setup_scene()
build_materials()
textures = load_manifest()
build_claude_interface(textures)
append_scaffold_world()
add_lighting()
add_camera(scene)
animate_reveals(scene)

bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)
print(f"[demo] blend -> {BLEND_OUT}")

if ARGS.mode == "styleframe":
    scene.frame_set(max(scene.frame_start, min(ARGS.styleframe_frame, scene.frame_end)))
    scene.render.filepath = STYLEFRAME_OUT
    bpy.ops.render.render(write_still=True)
    print(f"[demo] styleframe -> {STYLEFRAME_OUT}")
elif ARGS.mode == "animation":
    for name in os.listdir(FRAME_DIR):
        if name.startswith("frame_") and name.endswith(".png"):
            os.remove(os.path.join(FRAME_DIR, name))
    scene.render.filepath = os.path.join(FRAME_DIR, "frame_")
    bpy.ops.render.render(animation=True)
    encode_frames(scene)
else:
    print("[demo] no render requested")
