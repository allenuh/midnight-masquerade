# Builds the barrels and crates from scratch, exports each variant as its own glb in
# src/client/assets/ (barrel_standard, barrel_weathered, crate_standard, crate_dark) and saves
# them in a scene called 'containers' to art/containers.blend. Developer-only, re-run by hand
# after changing a shape here, or the atlases (paint them first with art/paint_containers.py).
# Either headless:
#     blender -b --factory-startup --python art/build_containers.py
# or inside a running Blender (through its MCP add-on, or the Text Editor), where it only builds
# the 'containers' scene into the open file to look at, replacing the one an earlier run made
# and leaving every other scene alone (data calls only: see build_tables.py); the glbs and the
# .blend come from the headless run.
# Conventions are the furniture's (art/build_furniture.py, whose Part and helpers this borrows):
# world units 1:1 with the game (a tile is 20), Z up, the origin at the middle of the base on
# the floor. Each prop fills its tile but for TILE_MARGIN of floor on every side, 5% of the
# tile: the barrel at its belly, at any angle about the vertical (it is round); the crate only
# square to the grid, so it turns in quarter turns (at other angles its corners leave the tile).
# Undersides are left out; the crate's top and its base are flat, so crates stack.
# The variants of a shape share one mesh ('barrel', 'crate'): the variant's object carries its
# own material in an object-linked slot, and all variants of a shape use one atlas layout.
# The scene also shows a crate stacked on a crate and both barrels turned, as further objects
# sharing the meshes, in a 'containers_preview' collection that is never exported.
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_furniture import X, Y, Z, Part, atlas_material, finish  # noqa: E402
from furniture_layout import BARREL_HEIGHT, CONTAINER_REGIONS, CONTAINER_SIZE  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'art'
BLEND = ART / 'containers.blend'
ASSETS = ROOT / 'src' / 'client' / 'assets'
SCENE, PREVIEW = 'containers', 'containers_preview'

# Each variant: its shape (mesh), material and atlas.
VARIANTS = {
    'barrel_standard': ('barrel', 'barrel_standard_oak', 'barrel_standard_atlas.png'),
    'barrel_weathered': ('barrel', 'barrel_weathered_oak', 'barrel_weathered_atlas.png'),
    'crate_standard': ('crate', 'crate_standard_pine', 'crate_standard_atlas.png'),
    'crate_dark': ('crate', 'crate_dark_stained', 'crate_dark_atlas.png'),
}
BUDGET = {'barrel': (80, 180), 'crate': (50, 140)}
# Where each variant stands in the .blend, side by side on the tile grid; then the preview
# copies: (name, shape, variant whose material it wears, (x, y, z), turn in degrees).
SHOWCASE = {'barrel_standard': (-50, 0), 'barrel_weathered': (-30, 0), 'crate_standard': (-10, 0), 'crate_dark': (10, 0)}
PREVIEW_COPIES = [
    ('barrel_standard_turned', 'barrel_standard', (30, 0, 0), 140),
    ('barrel_weathered_turned', 'barrel_weathered', (50, 0, 0), 230),
    ('crate_stack_base', 'crate_standard', (70, 0, 0), 0),
    ('crate_stack_top', 'crate_dark', (70, 0, 18.0), 90),
]
SHARP_ANGLE = math.radians(50)
TILE_MARGIN = 1.0  # of the tile's 20 on each side


def region_uv(regions, region, fu, fv):
    x, y, w, h, _ = regions[region]
    return ((x + fu * w) / CONTAINER_SIZE, 1 - (y + h - fv * h) / CONTAINER_SIZE)


# Barrel: a lathe of BARREL_SIDES, bulging from the chimes to the belly, its head sunk inside
# a rim. Profile as (radius, height) from the foot up to the middle of the head; the staves
# (with their painted bands) run up the side by height, the rim is end grain, the head a disc.
BARREL_SIDES = 10
BARREL_BELLY = 10 - TILE_MARGIN
BARREL_PROFILE = [(7.4, 0), (8.4, 7.0), (BARREL_BELLY, BARREL_HEIGHT / 2), (8.4, 21.0), (7.4, BARREL_HEIGHT),
                  (6.4, BARREL_HEIGHT), (6.4, BARREL_HEIGHT - 1.0), (0, BARREL_HEIGHT - 1.0)]
BARREL_SIDE_SEGMENTS = 4  # the first four profile segments are the staves


def barrel(part):
    regions, n = CONTAINER_REGIONS['barrel'], BARREL_SIDES
    head = BARREL_PROFILE[-2][0]

    def ring(radius, z):
        if radius == 0:
            return [Vector((0, 0, z))]
        return [Vector((radius * math.cos(a), radius * math.sin(a), z)) for a in (2 * math.pi * j / n for j in range(n))]

    def uv(segment, point, j):
        if segment < BARREL_SIDE_SEGMENTS:
            return region_uv(regions, 'stave', j / n, point[1] / BARREL_HEIGHT)
        if segment < len(BARREL_PROFILE) - 2:
            return region_uv(regions, 'rim', j / n, float(point is BARREL_PROFILE[segment + 1]))
        a = 2 * math.pi * j / n
        r = point[0] / head / 2
        return region_uv(regions, 'lid', 0.5 + r * math.cos(a), 0.5 + r * math.sin(a))

    rings = [ring(*point) for point in BARREL_PROFILE]
    for k, (low, high) in enumerate(zip(rings, rings[1:])):
        p0, p1 = BARREL_PROFILE[k], BARREL_PROFILE[k + 1]
        for j in range(n):
            jn = (j + 1) % n
            if len(high) == 1:
                part.face([low[j], low[jn], high[0]], 'lid', X, Y, uvs=[uv(k, p0, j), uv(k, p0, j + 1), uv(k, p1, j + 0.5)])
            else:
                part.face([low[j], low[jn], high[jn], high[j]], 'stave', X, Z,
                          uvs=[uv(k, p0, j), uv(k, p0, j + 1), uv(k, p1, j + 1), uv(k, p1, j)])


# Crate: a cube CRATE_HALF either side of its middle and twice that tall. Each side and the
# top is a framed panel: a mitred frame CRATE_FRAME wide in the face's plane, and the panel
# sunk CRATE_RECESS inside it, with short walls between.
CRATE_HALF, CRATE_FRAME, CRATE_RECESS = 10 - TILE_MARGIN, 2.0, 0.5


def framed_face(part, centre, n, t, b, region):
    """One framed side of the crate, facing n, with t across it and b up it (t x b = n)."""
    centre, h = Vector(centre), CRATE_HALF
    inner = h - CRATE_FRAME
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    outer = [centre + t * (sx * h) + b * (sy * h) for sx, sy in corners]
    rim = [centre + t * (sx * inner) + b * (sy * inner) for sx, sy in corners]
    sunk = [p - n * CRATE_RECESS for p in rim]
    for k in range(4):
        kn = (k + 1) % 4
        along = (outer[kn] - outer[k]).normalized()
        inward = (centre - (outer[k] + outer[kn]) / 2).normalized()
        # The frame picture's top row (rubbed) at the crate's edge, its bottom (shadow) at the panel.
        part.face([outer[k], outer[kn], rim[kn], rim[k]], 'frame', along, -inward, outward=n)
        part.face([rim[k], rim[kn], sunk[kn], sunk[k]], 'recess', along, n, outward=inward)
    part.face(sunk, region, t, b, outward=n)


def crate(part):
    h = CRATE_HALF
    for n, t in ((-Y, X), (X, Y), (Y, -X), (-X, -Y)):
        framed_face(part, n * h + Z * h, n, t, Z, 'panel')
    framed_face(part, Z * 2 * h, Z, X, Y, 'lid')


def finish_smooth(part, mesh):
    """Like finish(), but shades smooth with hard edges past SHARP_ANGLE, so the barrel's ten
    sides round off and its rims stay crisp."""
    bm = part.bm
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for face in bm.faces:
        face.smooth = True
    for edge in bm.edges:
        edge.smooth = not (edge.is_manifold and edge.calc_face_angle(0) > SHARP_ANGLE)
    bm.to_mesh(mesh)
    bm.free()
    return sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)


SHAPES = {'barrel': (barrel, finish_smooth), 'crate': (crate, finish)}


def wear(obj, material):
    """Gives `obj` its own material over its shared mesh's (an object-linked slot)."""
    slot = obj.material_slots[0]
    slot.link = 'OBJECT'
    slot.material = material


def build(scene):
    """Builds each shape once and each variant as an object over it, in its own collection;
    then the preview copies. Returns the variants' objects."""
    meshes, materials, objects = {}, {}, {}
    for seed, (shape, (build_shape, finish_shape)) in enumerate(SHAPES.items()):
        part = Part(CONTAINER_REGIONS[shape], CONTAINER_SIZE, 40 + seed)
        build_shape(part)
        meshes[shape] = bpy.data.meshes.new(shape)
        tris = finish_shape(part, meshes[shape])
        low, high = BUDGET[shape]
        print(f'CONTAINERS {shape}: {tris} tris (budget {low}-{high})')
        assert low <= tris <= high, f'{shape} has {tris} triangles, outside {low}-{high}'
    for name, (shape, material, atlas) in VARIANTS.items():
        materials[name] = atlas_material(material, atlas)
        mesh = meshes[shape]
        if not mesh.materials:
            mesh.materials.append(materials[name])  # the shape's first variant is its mesh's own
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        objects[name] = bpy.data.objects.new(name, mesh)
        collection.objects.link(objects[name])
        if mesh.materials[0] != materials[name]:
            wear(objects[name], materials[name])
    preview = bpy.data.collections.new(PREVIEW)
    scene.collection.children.link(preview)
    for name, variant, at, turn in PREVIEW_COPIES:
        copy = bpy.data.objects.new(name, meshes[VARIANTS[variant][0]])
        preview.objects.link(copy)
        if copy.material_slots[0].material != materials[variant]:
            wear(copy, materials[variant])
        copy.location = at
        copy.rotation_euler.z = math.radians(turn)
    return objects


def place(objects):
    for name, at in SHOWCASE.items():
        objects[name].location.xy = at


def clear_earlier_run():
    """In a running Blender: removes the 'containers' scene an earlier run made, and its
    objects, collections, meshes, materials and images (only those, by name)."""
    old = bpy.data.scenes.get(SCENE)
    if old is None:
        return
    window = bpy.context.window
    if window and window.scene == old:
        window.scene = next(s for s in bpy.data.scenes if s != old) if len(bpy.data.scenes) > 1 else bpy.data.scenes.new('Scene')
    objects = {*VARIANTS, *(name for name, *_ in PREVIEW_COPIES)}
    for obj in list(old.objects):
        if obj.name in objects:
            bpy.data.objects.remove(obj)
    for collection in list(old.collection.children):
        if collection.name in {*VARIANTS, PREVIEW}:
            bpy.data.collections.remove(collection)
    bpy.data.scenes.remove(old)
    materials = {material for _, material, _ in VARIANTS.values()}
    images = {atlas.removesuffix('.png') for *_, atlas in VARIANTS.values()}
    for datablocks, wanted in ((bpy.data.meshes, set(SHAPES)), (bpy.data.materials, materials), (bpy.data.images, images)):
        for block in list(datablocks):
            if block.name in wanted and block.users == 0:
                datablocks.remove(block)


def main():
    for *_, atlas in VARIANTS.values():
        if not (ART / atlas).exists():
            raise RuntimeError(f'{ART / atlas} is missing: run python art/paint_containers.py first')
    if not bpy.app.background:
        clear_earlier_run()
        scene = bpy.data.scenes.new(SCENE)
        place(build(scene))
        bpy.context.window.scene = scene
        print('CONTAINERS built in the open file; export and save with the headless command')
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = SCENE
    objects = build(scene)
    for name, obj in objects.items():
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        path = ASSETS / f'{name}.glb'
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False)
        print('CONTAINERS exported', path)
    bpy.ops.object.select_all(action='DESELECT')
    place(objects)
    bpy.context.preferences.filepaths.save_version = 0  # no containers.blend1 backup
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), compress=True)
    print('CONTAINERS saved', BLEND)


if __name__ == '__main__':
    main()
