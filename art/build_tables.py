# Builds the three tables from scratch, exports each as its own glb in src/client/assets/
# (dining_table_1x4, side_table_1x2, storage_table_2x4) and saves them, side by side in a scene
# called 'tables', to art/tables.blend. Developer-only, re-run by hand after changing a shape
# here, or the atlases (paint them first with art/paint_tables.py). Either headless:
#     blender -b --factory-startup --python art/build_tables.py
# or inside a running Blender (through its MCP add-on, or the Text Editor), where it only builds
# the 'tables' scene into the open file to look at, replacing the one an earlier run made and
# leaving every other scene alone; the glbs and the .blend come from the headless run.
# Conventions are the storage furniture's (art/build_furniture.py, whose Part and helpers this
# borrows): world units 1:1 with the game (a tile is 20), Z up, the long side along X, the
# front toward -Y (+Z in the glTF), the origin at the middle of the footprint on the floor.
# Tables stand free in a room, so they are centred in their footprints, and everything,
# the cloth included, stays inside them. Undersides are left out. Each table is a root mesh
# with its own wood material and atlas; the storage table's cloth is a child mesh,
# storage_table_2x4_cloth, with its own material and texture so it can be hidden or swapped.
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_furniture import X, Y, Z, Part, atlas_material, finish  # noqa: E402
from furniture_layout import ATLAS_SIZE, CLOTH_REGIONS, CLOTH_SIZE, REGIONS  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'art'
BLEND = ART / 'tables.blend'
ASSETS = ROOT / 'src' / 'client' / 'assets'
SCENE = 'tables'

# Triangle budgets per table (the storage table's counts its cloth); the build fails outside.
BUDGET = {'dining_table_1x4': (150, 300), 'side_table_1x2': (100, 220), 'storage_table_2x4': (250, 550)}
MATERIAL = {
    'dining_table_1x4': ('dining_table_redwood', 'dining_table_atlas.png'),
    'side_table_1x2': ('side_table_honey_pine', 'side_table_atlas.png'),
    'storage_table_2x4': ('storage_table_grey_oak', 'storage_table_atlas.png'),
}
CLOTH = 'storage_table_2x4_cloth'
CLOTH_MATERIAL = ('tablecloth_burgundy', 'tablecloth_atlas.png')
# Where each table stands in the .blend, (x, y) on the tile grid with a tile between them and
# their fronts in line; the glbs are exported at the origin.
SHOWCASE = {'dining_table_1x4': (-80, -10), 'side_table_1x2': (0, -10), 'storage_table_2x4': (80, 0)}


def post(part, rings, cx, cy, region):
    """A square post (a leg) centred on (cx, cy) through `rings` of (height, half width),
    bottom to top: its four sides only (it stands on the floor and into what it holds up)."""
    centre = Vector((cx, cy, 0))
    for (z0, a0), (z1, a1) in zip(rings, rings[1:]):
        for n in (-Y, X, Y, -X):
            t = Z.cross(n)
            points = [centre + n * a0 - t * a0 + Z * z0, centre + n * a0 + t * a0 + Z * z0,
                      centre + n * a1 + t * a1 + Z * z1, centre + n * a1 - t * a1 + Z * z1]
            part.face(points, region, t, Z, outward=n)


def frame_inside(part, outer_x, outer_y, inner_x, inner_y, z0, z1, region):
    """The inside faces and the underside of a rectangular frame (a table's apron), whose
    outside faces are a box `outer_x` by `outer_y` (half sizes) and inside `inner_x` by `inner_y`."""
    for n, half, along, span in ((-Y, inner_y, X, inner_x), (Y, inner_y, X, inner_x),
                                 (-X, inner_x, Y, inner_y), (X, inner_x, Y, inner_y)):
        points = [n * half - along * span + Z * z0, n * half + along * span + Z * z0,
                  n * half + along * span + Z * z1, n * half - along * span + Z * z1]
        part.face(points, region, along, Z, outward=-n)
    for n, outer, inner, along, span in ((-Y, outer_y, inner_y, X, outer_x), (Y, outer_y, inner_y, X, outer_x),
                                         (-X, outer_x, inner_x, Y, outer_y), (X, outer_x, inner_x, Y, outer_y)):
        points = [n * outer - along * span + Z * z0, n * outer + along * span + Z * z0,
                  n * inner + along * span + Z * z0, n * inner - along * span + Z * z0]
        part.face(points, region, along, n, outward=-Z)


# Dining table: long and narrow, a thick planked top on a deep apron, four chunky square legs
# swelling to a block under the apron and tapering to a foot, and a low H stretcher.
DINING_TOP = (39.5, 9.5, 21.6, 24.0)  # half length, half width, underside, top
DINING_APRON = (35.6, 7.6, 34.4, 6.4, 18.4)  # outside half sizes, inside half sizes, foot
DINING_LEG_AT = (33.5, 5.5)
DINING_LEG = [(0, 1.9), (1.4, 1.9), (2.4, 1.35), (11.0, 1.6), (12.0, 2.1), (21.6, 2.1)]


def dining_table(part):
    hx, hy, z0, z1 = DINING_TOP
    part.box(-hx, hx, -hy, hy, z0, z1, top='top', front='board', back='board', left='board', right='board')
    ox, oy, ix, iy, foot = DINING_APRON
    part.box(-ox, ox, -oy, oy, foot, z0, front='apron', back='apron', left='apron', right='apron')
    frame_inside(part, ox, oy, ix, iy, foot, z0, 'board')
    lx, ly = DINING_LEG_AT
    for sx in (-1, 1):
        for sy in (-1, 1):
            post(part, DINING_LEG, sx * lx, sy * ly, 'leg')
        part.box(sx * lx - 0.7, sx * lx + 0.7, -ly, ly, 4.2, 5.6, left='leg', right='leg', top='leg', bottom='leg')
    part.box(-lx, lx, -0.7, 0.7, 4.4, 5.4, front='leg', back='leg', top='leg', bottom='leg')


# Side table: light and lower, a thin top over a dark case with one small drawer and a knob,
# four slender legs tapering to small feet, and a low shelf between them.
SIDE_TOP = (18.5, 8.5, 18.5, 20.0)
SIDE_CASE = (15.5, 6.5, 14.6)
SIDE_LEG_AT = (14.4, 5.4)
SIDE_LEG = [(0, 0.8), (0.8, 0.8), (1.2, 0.65), (14.6, 1.1)]


def side_table(part):
    hx, hy, z0, z1 = SIDE_TOP
    part.box(-hx, hx, -hy, hy, z0, z1, top='top', front='top', back='top', left='top', right='top')
    cx, cy, foot = SIDE_CASE
    part.box(-cx, cx, -cy, cy, foot, z0, front='accent', back='accent', left='accent', right='accent', bottom='accent')
    part.box(-8.5, 8.5, -cy - 0.4, -cy, foot + 0.5, z0 - 0.5, front='drawer', top='accent', bottom='accent',
             left='accent', right='accent')
    part.knob(0, -cy - 0.4, (foot + z0) / 2, 0.75, 0.9, 'brass')
    lx, ly = SIDE_LEG_AT
    for sx in (-1, 1):
        for sy in (-1, 1):
            post(part, SIDE_LEG, sx * lx, sy * ly, 'board')
    part.box(-lx, lx, -ly, ly, 4.0, 5.0, top='board', bottom='board', front='board', back='board', left='board',
             right='board')


# Storage table: broad and heavy, after an antique chest of drawers: a thick top on a moulding,
# a carcass with three drawers over three along both long sides (each with a tarnished bar pull
# on a painted backplate), framed panels at the ends, a plinth and block feet. A cloth lies
# across its middle and hangs over both long sides in big angular folds, short of the floor.
STORAGE_TOP = (39.5, 19.5, 22.0, 25.0)
STORAGE_BAYS = [(-35.8, -12.4), (-11.6, 11.6), (12.4, 35.8)]
STORAGE_ROWS = [(13.0, 20.2), (4.4, 11.6)]
PULL = (2.5, 0.5, 0.9)  # half width, half height, depth


def storage_table(part):
    hx, hy, z0, z1 = STORAGE_TOP
    part.box(-hx, hx, -hy, hy, z0, z1, top='top', front='trim', back='trim', left='trim', right='trim')
    part.box(-38.6, 38.6, -18.6, 18.6, 21.0, z0, front='trim', back='trim', left='trim', right='trim')
    part.box(-37.0, 37.0, -17.0, 17.0, 3.5, 21.0, front='trim', back='trim', left='end_panel', right='end_panel')
    part.box(-38.0, 38.0, -18.0, 18.0, 1.5, 3.5, front='trim', back='trim', left='trim', right='trim', top='trim')
    for sx in (-1, 1):
        for sy in (-1, 1):
            x0, x1 = sorted((sx * 34.2, sx * 38.4))
            y0, y1 = sorted((sy * 14.2, sy * 18.4))
            part.box(x0, x1, y0, y1, 0, 1.5, front='trim', back='trim', left='trim', right='trim')
    pw, ph, pd = PULL
    for x0, x1 in STORAGE_BAYS:
        for z0_, z1_ in STORAGE_ROWS:
            cx, cz = (x0 + x1) / 2, (z0_ + z1_) / 2
            part.box(x0, x1, -17.6, -17.0, z0_, z1_, front='drawer', top='board', bottom='board', left='board', right='board')
            part.box(x0, x1, 17.0, 17.6, z0_, z1_, back='drawer', top='board', bottom='board', left='board', right='board')
            part.box(cx - pw, cx + pw, -17.6 - pd, -17.6, cz - ph, cz + ph, front='metal', top='metal', bottom='metal',
                     left='metal', right='metal')
            part.box(cx - pw, cx + pw, 17.6, 17.6 + pd, cz - ph, cz + ph, back='metal', top='metal', bottom='metal',
                     left='metal', right='metal')


# The cloth: CLOTH_COLUMNS columns of vertices across the table's middle, CLOTH_HALF either side
# of it. On top it rides CLOTH_LIFT above the wood, every other column raised into a ridge; it
# rolls over each long edge, then hangs in folds: the ridges swing out, the columns between
# tuck in, deeper toward the hem, and the hem zigzags with them. The roll is (height, out),
# the fold (height, out at a ridge, out at a tuck).
CLOTH_COLUMNS, CLOTH_HALF, CLOTH_LIFT, CLOTH_RIDGE = 7, 16.0, 0.12, 0.6
CLOTH_ROLL = (24.5, 19.85)
CLOTH_FOLD = (20.5, 19.9, 18.9)
CLOTH_HEM = ((17.2, 19.95), (16.0, 18.7))  # (height, out) at a ridge, at a tuck (clear of the pulls)


def tablecloth(part):
    n = CLOTH_COLUMNS
    xs = [-CLOTH_HALF + 2 * CLOTH_HALF * i / (n - 1) for i in range(n)]
    top, hy = STORAGE_TOP[3], STORAGE_TOP[1]
    ys = [-hy, 0, hy]

    def on_top(i, j):
        return Vector((xs[i], ys[j], top + CLOTH_LIFT + CLOTH_RIDGE * (i % 2) + 0.15 * (j == 1)))

    for i in range(n - 1):
        for j in range(2):
            part.face([on_top(i, j), on_top(i + 1, j), on_top(i + 1, j + 1), on_top(i, j + 1)], 'cloth', X, Y, outward=Z)
    x, y, w, h, _ = CLOTH_REGIONS['cloth_hang']

    def hang_uv(u, v):
        return ((x + u * w) / CLOTH_SIZE, 1 - (y + h - v * h) / CLOTH_SIZE)

    for s in (-1, 1):
        edge = [on_top(i, 0 if s < 0 else 2) for i in range(n)]
        roll = [Vector((xs[i], s * CLOTH_ROLL[1], CLOTH_ROLL[0])) for i in range(n)]
        fold = [Vector((xs[i], s * (CLOTH_FOLD[1] if i % 2 else CLOTH_FOLD[2]), CLOTH_FOLD[0])) for i in range(n)]
        hem = [Vector((xs[i], s * CLOTH_HEM[1 - i % 2][1], CLOTH_HEM[1 - i % 2][0])) for i in range(n)]
        for i in range(n - 1):
            part.face([edge[i], edge[i + 1], roll[i + 1], roll[i]], 'cloth', X, Z, outward=Vector((0, s, 1)))
            part.face([roll[i], roll[i + 1], fold[i + 1], fold[i]], 'cloth', X, Z, outward=s * Y)
            u0, u1 = i / (n - 1), (i + 1) / (n - 1)
            part.face([fold[i], fold[i + 1], hem[i + 1], hem[i]], 'cloth_hang', X, Z, outward=s * Y,
                      uvs=[hang_uv(u0, 1), hang_uv(u1, 1), hang_uv(u1, 0), hang_uv(u0, 0)])


BUILDERS = {'dining_table_1x4': dining_table, 'side_table_1x2': side_table, 'storage_table_2x4': storage_table}


def build(scene):
    """Builds every table into `scene`, each in its own collection; returns the roots."""
    roots = {}
    for seed, (name, build_table) in enumerate(BUILDERS.items()):
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        part = Part(REGIONS[name], ATLAS_SIZE, 10 + seed)
        build_table(part)
        mesh = bpy.data.meshes.new(name)
        tris = finish(part, mesh)
        mesh.materials.append(atlas_material(*MATERIAL[name]))
        root = bpy.data.objects.new(name, mesh)
        collection.objects.link(root)
        if name == 'storage_table_2x4':
            cloth_part = Part(CLOTH_REGIONS, CLOTH_SIZE, 20)
            tablecloth(cloth_part)
            cloth_mesh = bpy.data.meshes.new(CLOTH)
            cloth_tris = finish(cloth_part, cloth_mesh)
            cloth_mesh.materials.append(atlas_material(*CLOTH_MATERIAL))
            cloth = bpy.data.objects.new(CLOTH, cloth_mesh)
            cloth.parent = root
            collection.objects.link(cloth)
            print(f'TABLES {CLOTH}: {cloth_tris} tris')
            tris += cloth_tris
        low, high = BUDGET[name]
        print(f'TABLES {name}: {tris} tris (budget {low}-{high})')
        assert low <= tris <= high, f'{name} has {tris} triangles, outside {low}-{high}'
        roots[name] = root
    return roots


def clear_earlier_run():
    """In a running Blender: removes the 'tables' scene an earlier run made, and its objects,
    meshes, materials and images (only those, by name)."""
    old = bpy.data.scenes.get(SCENE)
    if old is None:
        return
    window = bpy.context.window
    if window and window.scene == old:
        window.scene = next(s for s in bpy.data.scenes if s != old) if len(bpy.data.scenes) > 1 else bpy.data.scenes.new('Scene')
    names = {*BUILDERS, CLOTH}
    for obj in list(old.objects):
        if obj.name in names:
            bpy.data.objects.remove(obj)
    for collection in list(old.collection.children):
        if collection.name in BUILDERS:
            bpy.data.collections.remove(collection)
    bpy.data.scenes.remove(old)
    materials = {m for m, _ in [*MATERIAL.values(), CLOTH_MATERIAL]}
    images = {f.removesuffix('.png') for _, f in [*MATERIAL.values(), CLOTH_MATERIAL]}
    for datablocks, wanted in ((bpy.data.meshes, names), (bpy.data.materials, materials), (bpy.data.images, images)):
        for block in list(datablocks):
            if block.name in wanted and block.users == 0:
                datablocks.remove(block)


def main():
    for _, filename in [*MATERIAL.values(), CLOTH_MATERIAL]:
        if not (ART / filename).exists():
            raise RuntimeError(f'{ART / filename} is missing: run python art/paint_tables.py first')
    if not bpy.app.background:
        # In a running Blender only data calls: the glTF exporter, run from an add-on's timer
        # against a scene made in the same call, crashed Blender 5.2 in its depsgraph update.
        clear_earlier_run()
        scene = bpy.data.scenes.new(SCENE)
        for name, root in build(scene).items():
            root.location.xy = SHOWCASE[name]
        bpy.context.window.scene = scene
        print('TABLES built in the open file; export and save with the headless command')
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = SCENE
    for name, root in build(scene).items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in [root, *root.children]:
            obj.select_set(True)
        path = ASSETS / f'{name}.glb'
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False)
        print('TABLES exported', path)
        root.location.xy = SHOWCASE[name]
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.preferences.filepaths.save_version = 0  # no tables.blend1 backup
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), compress=True)
    print('TABLES saved', BLEND)


if __name__ == '__main__':
    main()
