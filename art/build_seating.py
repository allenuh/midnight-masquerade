# Builds the seating from scratch, exports each piece as its own glb in src/client/assets/
# (chair_1x1, stool_1x1) and saves them in a scene called 'seating' to art/seating.blend.
# Developer-only, re-run by hand after changing a shape here, or the atlases (paint them first
# with art/paint_seating.py). Either headless:
#     blender -b --factory-startup --python art/build_seating.py
# or inside a running Blender (through its MCP add-on, or the Text Editor), where it only builds
# the 'seating' scene into the open file to look at, replacing the one an earlier run made and
# leaving every other scene alone (data calls only: see build_tables.py); the glbs and the
# .blend come from the headless run.
# Conventions are the furniture's (art/build_furniture.py, whose Part and helpers this borrows):
# world units 1:1 with the game (a tile is 20), Z up, the chair facing -Y (+Z in the glTF),
# the origin at the middle of the footprint on the floor, the feet on it. Both pieces sit well
# inside one tile, centred, so any quarter turn about the vertical stays inside it too.
# Undersides are left out. Each piece is one mesh with its own material and 64 x 64 atlas.
# The scene also shows each piece a quarter turn round, as a second object sharing its mesh,
# in a 'seating_preview' collection that is never exported.
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_furniture import X, Y, Z, Part, atlas_material, finish  # noqa: E402
from build_tables import post  # noqa: E402
from furniture_layout import SEATING_REGIONS, SEATING_SIZE  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'art'
BLEND = ART / 'seating.blend'
ASSETS = ROOT / 'src' / 'client' / 'assets'
SCENE, PREVIEW = 'seating', 'seating_preview'

BUDGET = {'chair_1x1': (120, 250), 'stool_1x1': (60, 160)}
MATERIAL = {'chair_1x1': ('chair_chestnut', 'chair_atlas.png'), 'stool_1x1': ('stool_weathered_oak', 'stool_atlas.png')}
# Where each piece and its quarter-turned copy stand in the .blend, one tile apart on the grid.
SHOWCASE = {'chair_1x1': ((-30, 0), (-10, 0)), 'stool_1x1': ((10, 0), (30, 0))}


def strut(part, foot, head, half_foot, half_head, region):
    """A square leg from `foot` to `head` (it may lean), its section square to the axes: its
    four sides only."""
    foot, head = Vector(foot), Vector(head)
    for n in (-Y, X, Y, -X):
        t = Z.cross(n)
        points = [foot + (n - t) * half_foot, foot + (n + t) * half_foot,
                  head + (n + t) * half_head, head + (n - t) * half_head]
        part.face(points, region, t, (head - foot).normalized(), outward=n)


def finial(part, cx, cy, z, half, tip, region):
    """A four-sided pyramid capping a square post of half width `half` at height z."""
    apex = Vector((cx, cy, z + tip))
    for n in (-Y, X, Y, -X):
        t = Z.cross(n)
        base = Vector((cx, cy, z)) + n * half
        points = [base - t * half, base + t * half, apex]
        part.face(points, region, t, Z, outward=n + Z)


# Chair: an old dining or hall chair, angular and sturdy: a thick square seat on four square
# legs with stretchers, the back legs running on up as posts with pyramid finials, holding an
# arched crest rail, a lower rail and three thick slats between them.
CHAIR_SEAT = (7.0, 6.5, 11.0, 12.4)  # half width, half depth, underside, top
CHAIR_LEG_AT = (5.6, 5.1)
FRONT_LEG = [(0, 0.95), (11.0, 1.05)]
BACK_POST = [(0, 0.95), (11.0, 1.05), (27.0, 0.9)]
FINIAL = 0.9
CREST_RAIL = [(-4.6, 23.2), (4.6, 23.2), (4.6, 25.6), (2.5, 26.4), (0, 26.8), (-2.5, 26.4), (-4.6, 25.6)]
SLATS_X, SLAT_HALF = (-2.6, 0, 2.6), 0.7
BACK_RAIL = (14.6, 15.8)  # the lower back rail's underside and top


def chair(part):
    hx, hy, z0, z1 = CHAIR_SEAT
    part.box(-hx, hx, -hy, hy, z0, z1, top='seat', front='board', back='board', left='board', right='board')
    lx, ly = CHAIR_LEG_AT
    for sx in (-1, 1):
        post(part, FRONT_LEG, sx * lx, -ly, 'leg')
        post(part, BACK_POST, sx * lx, ly, 'leg')
        finial(part, sx * lx, ly, BACK_POST[-1][0], BACK_POST[-1][1], FINIAL, 'leg')
        part.box(sx * lx - 0.5, sx * lx + 0.5, -ly, ly, 3.2, 4.2, left='leg', right='leg', top='leg', bottom='leg')
    part.box(-lx, lx, -ly - 0.5, -ly + 0.5, 5.0, 6.0, front='leg', back='leg', top='leg', bottom='leg')
    back0, back1 = ly - 0.5, ly + 0.5
    part.prism(CREST_RAIL, back0, back1, 'rail', 'rail', 'slat', skip_edges=(1, 6))
    rail0, rail1 = BACK_RAIL
    part.box(-4.6, 4.6, back0 + 0.1, back1 - 0.1, rail0, rail1, front='slat', back='slat', top='slat', bottom='slat')
    for x in SLATS_X:
        part.box(x - SLAT_HALF, x + SLAT_HALF, back0 + 0.15, back1 - 0.15, rail1, CREST_RAIL[0][1],
                 front='slat', back='slat', left='slat', right='slat')


# Stool: low and compact, a thick octagonal seat (a round seat cut angular) on four legs that
# splay out to the floor at the diagonals, braced by rungs at two heights.
STOOL_SEAT = (6.6, 9.0, 10.4)  # radius to the corners, underside, top
STOOL_LEG = (3.6, 5.6, 0.9, 0.75)  # radius at the seat and at the floor, half widths there
STOOL_RUNGS = [(3.0, 4.0, X), (5.4, 6.4, Y)]  # underside, top, and which way they run


def stool(part):
    radius, z0, z1 = STOOL_SEAT
    corners = [(radius * math.cos(a), radius * math.sin(a)) for a in (math.pi / 8 + math.pi / 4 * k for k in range(8))]
    part.face([(x, y, z1) for x, y in corners], 'seat', X, Y, outward=Z)
    for (ax, ay), (bx, by) in zip(corners, corners[1:] + corners[:1]):
        points = [(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)]
        middle = Vector(((ax + bx) / 2, (ay + by) / 2, 0))
        part.face(points, 'board', Vector((bx - ax, by - ay, 0)).normalized(), Z, outward=middle)
    top_r, foot_r, top_half, foot_half = STOOL_LEG

    def leg_centre(z):
        """How far out along each axis a leg's centre is at height z."""
        return (foot_r + (top_r - foot_r) * z / z0) / math.sqrt(2)

    for sx in (-1, 1):
        for sy in (-1, 1):
            strut(part, (sx * leg_centre(0), sy * leg_centre(0), 0), (sx * leg_centre(z0), sy * leg_centre(z0), z0),
                  foot_half, top_half, 'leg')
    for r0, r1, along in STOOL_RUNGS:
        c = leg_centre((r0 + r1) / 2)
        for s in (-1, 1):
            if along == X:
                part.box(-c, c, s * c - 0.5, s * c + 0.5, r0, r1, front='leg', back='leg', top='leg', bottom='leg')
            else:
                part.box(s * c - 0.5, s * c + 0.5, -c, c, r0, r1, left='leg', right='leg', top='leg', bottom='leg')


BUILDERS = {'chair_1x1': chair, 'stool_1x1': stool}


def build(scene):
    """Builds each piece into `scene` in its own collection, and its quarter-turned copy into
    the preview collection; returns the pieces and the copies."""
    preview = bpy.data.collections.new(PREVIEW)
    roots, copies = {}, {}
    for seed, (name, build_piece) in enumerate(BUILDERS.items()):
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        part = Part(SEATING_REGIONS[name], SEATING_SIZE, 30 + seed)
        build_piece(part)
        mesh = bpy.data.meshes.new(name)
        tris = finish(part, mesh)
        mesh.materials.append(atlas_material(*MATERIAL[name]))
        roots[name] = bpy.data.objects.new(name, mesh)
        collection.objects.link(roots[name])
        copies[name] = bpy.data.objects.new(f'{name}_rot90', mesh)
        copies[name].rotation_euler.z = math.pi / 2
        preview.objects.link(copies[name])
        low, high = BUDGET[name]
        print(f'SEATING {name}: {tris} tris (budget {low}-{high})')
        assert low <= tris <= high, f'{name} has {tris} triangles, outside {low}-{high}'
    scene.collection.children.link(preview)
    return roots, copies


def place(roots, copies):
    for name, (at, turned_at) in SHOWCASE.items():
        roots[name].location.xy = at
        copies[name].location.xy = turned_at


def clear_earlier_run():
    """In a running Blender: removes the 'seating' scene an earlier run made, and its objects,
    collections, meshes, materials and images (only those, by name)."""
    old = bpy.data.scenes.get(SCENE)
    if old is None:
        return
    window = bpy.context.window
    if window and window.scene == old:
        window.scene = next(s for s in bpy.data.scenes if s != old) if len(bpy.data.scenes) > 1 else bpy.data.scenes.new('Scene')
    objects = {*BUILDERS, *(f'{name}_rot90' for name in BUILDERS)}
    for obj in list(old.objects):
        if obj.name in objects:
            bpy.data.objects.remove(obj)
    for collection in list(old.collection.children):
        if collection.name in {*BUILDERS, PREVIEW}:
            bpy.data.collections.remove(collection)
    bpy.data.scenes.remove(old)
    materials = {m for m, _ in MATERIAL.values()}
    images = {f.removesuffix('.png') for _, f in MATERIAL.values()}
    for datablocks, wanted in ((bpy.data.meshes, set(BUILDERS)), (bpy.data.materials, materials), (bpy.data.images, images)):
        for block in list(datablocks):
            if block.name in wanted and block.users == 0:
                datablocks.remove(block)


def main():
    for _, filename in MATERIAL.values():
        if not (ART / filename).exists():
            raise RuntimeError(f'{ART / filename} is missing: run python art/paint_seating.py first')
    if not bpy.app.background:
        clear_earlier_run()
        scene = bpy.data.scenes.new(SCENE)
        place(*build(scene))
        bpy.context.window.scene = scene
        print('SEATING built in the open file; export and save with the headless command')
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = SCENE
    roots, copies = build(scene)
    for name, root in roots.items():
        bpy.ops.object.select_all(action='DESELECT')
        root.select_set(True)
        path = ASSETS / f'{name}.glb'
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False)
        print('SEATING exported', path)
    bpy.ops.object.select_all(action='DESELECT')
    place(roots, copies)
    bpy.context.preferences.filepaths.save_version = 0  # no seating.blend1 backup
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), compress=True)
    print('SEATING saved', BLEND)


if __name__ == '__main__':
    main()
