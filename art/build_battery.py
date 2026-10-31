# Rebuilds the battery pickup from art/battery.blend and exports src/client/assets/battery.glb.
# Developer-only, re-run by hand after changing the profile or the atlas:
#     blender -b art/battery.blend --python art/build_battery.py
# The mesh is a lathe: rings of 18 vertices around Blender's Z, with one centre vertex closing
# the bottom and one closing the top. Each ring's height and radius come from PROFILE, and its
# edges' sharpness from the profile's turn there, so the script gives the same result however
# often it runs. The atlas is wrapped once around the circumference (u, unchanged here) and
# runs up the profile by arc length (v, 0 at the bottom centre, 1 at the top centre), so its
# texels are close to square. The ring v values are printed for art/paint_battery.py, which
# paints the atlas in those rows. When
# art/battery_atlas.png exists it is packed into the .blend with nearest ("Closest") sampling,
# the glb is exported and the .blend saved; otherwise the script only prints.
import math
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
ATLAS = ROOT / 'art' / 'battery_atlas.png'
GLB = ROOT / 'src' / 'client' / 'assets' / 'battery.glb'

# (height, radius) of every ring, bottom centre to top centre: two plain cylinders stacked, the
# body and the nub (the + terminal), with flat faces and square edges. The body's straight side
# carries extra rings where the atlas's silver rims meet the paint (BODY_PAINT), which also
# smooth its lighting. 1.5 times as tall as it is wide. Where the profile turns by more than
# SHARP_TURN, the ring's edges are marked sharp, so every rim lights as a hard edge while the
# cylinders themselves stay round.
BODY_RADIUS, NUB_RADIUS = 0.6, 0.33
BODY_HEIGHT, HEIGHT = 1.64, 1.8
BODY_PAINT = [0.10 + i * (1.54 - 0.10) / 12 for i in range(13)]
PROFILE = [
    (0.0, 0.0),
    (0.0, BODY_RADIUS),
    *[(z, BODY_RADIUS) for z in BODY_PAINT],
    (BODY_HEIGHT, BODY_RADIUS),
    (BODY_HEIGHT, NUB_RADIUS),
    (HEIGHT, NUB_RADIUS),
    (HEIGHT, 0.0),
]
SHARP_TURN = math.radians(30)
# The base is never seen from the game's camera, so its disc takes this share of its arc
# length in v, leaving more of the atlas for the sides.
BASE_WEIGHT = 0.25


def ring_order(mesh):
    """Vertex indices grouped by ring, bottom centre to top centre. Rings at the same height
    (the two discs) are told apart by radius: outward at the bottom, inward at the top."""
    rings = {}
    for vertex in mesh.vertices:
        key = (round(vertex.co.z, 4), round(math.hypot(vertex.co.x, vertex.co.y), 4))
        rings.setdefault(key, []).append(vertex.index)
    bottom = min(z for z, _ in rings)
    keys = sorted(rings, key=lambda k: (k[0], k[1] if k[0] == bottom else -k[1]))
    return [rings[key] for key in keys]


def ring_v():
    lengths = [math.dist(a, b) for a, b in zip(PROFILE, PROFILE[1:])]
    lengths[0] *= BASE_WEIGHT
    total = sum(lengths)
    v = [0.0]
    for length in lengths:
        v.append(v[-1] + length / total)
    return v


battery = bpy.data.objects['Battery']
mesh = battery.data
rings = ring_order(mesh)
assert len(rings) == len(PROFILE), f'expected {len(PROFILE)} rings, found {len(rings)}'

ring_of = {}
for ring, (indices, (z, radius)) in enumerate(zip(rings, PROFILE)):
    for index in indices:
        vertex = mesh.vertices[index]
        angle = math.atan2(vertex.co.y, vertex.co.x)
        vertex.co = (radius * math.cos(angle), radius * math.sin(angle), z)
        ring_of[index] = ring


def sharp_rings():
    """Rings where the profile turns by more than SHARP_TURN (never the centres)."""
    sharp = set()
    for ring in range(1, len(PROFILE) - 1):
        (z0, r0), (z1, r1), (z2, r2) = PROFILE[ring - 1:ring + 2]
        turn = abs(math.atan2(r2 - r1, z2 - z1) - math.atan2(r1 - r0, z1 - z0))
        if min(turn, 2 * math.pi - turn) > SHARP_TURN:
            sharp.add(ring)
    return sharp


sharp = sharp_rings()
for edge in mesh.edges:
    a, b = (ring_of[index] for index in edge.vertices)
    edge.use_edge_sharp = a == b and a in sharp
for polygon in mesh.polygons:
    polygon.use_smooth = True

v = ring_v()
uv = mesh.uv_layers.active.data
for polygon in mesh.polygons:
    for loop in polygon.loop_indices:
        uv[loop].uv.y = v[ring_of[mesh.loops[loop].vertex_index]]
mesh.update()

print('BATTERY ring v', [round(value, 4) for value in v])
print('BATTERY sharp rings', sorted(sharp))
height = PROFILE[-1][0]
diameter = 2 * max(radius for _, radius in PROFILE)
print('BATTERY height/diameter', round(height / diameter, 3), 'circumference/profile',
      round(math.pi * diameter / (sum(math.dist(a, b) for a, b in zip(PROFILE, PROFILE[1:]))), 3))

if ATLAS.exists():
    node = bpy.data.materials['Battery'].node_tree.nodes['Image Texture']
    old = node.image
    image = bpy.data.images.load(str(ATLAS))
    image.pack()
    node.image = image
    node.interpolation = 'Closest'
    if old and old != image:
        bpy.data.images.remove(old)
    image.name = 'BatteryAtlas'
    bpy.ops.export_scene.gltf(filepath=str(GLB), export_format='GLB', use_selection=False, export_animations=False)
    bpy.context.preferences.filepaths.save_version = 0  # no battery.blend1 backup
    bpy.ops.wm.save_mainfile()
    print('BATTERY exported', GLB)
