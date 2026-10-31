# Builds the four candle props from scratch into art/candles.blend and exports each one as its
# own glb in src/client/assets/: wall_candle_1tile, wall_candle_2tile, candelabra_3candle and
# chamberstick. Developer-only, re-run by hand after changing a shape here or in
# candle_layout.py, or the atlas (paint it first with art/paint_candles.py):
#     blender -b --factory-startup --python art/build_candles.py
# Sizes are world units, 1:1 with the game (a tile is 20 wide, a wall 56 tall), Blender Z up,
# each prop facing -Y (+Z in the glTF, like the other models). Like a PlayStation-era prop,
# round parts are lathes of 6 or 8 sides and bent parts square bars; edges where faces turn
# by more than SHARP_ANGLE are hard, so the hexagonal sides still shade round.
# Every prop is a root mesh (holder and wax, the 'candle_props' material) with, per candle:
#   <prop>_flame_<i>  a small flame mesh (unlit 'candle_flame' material), its origin at the
#                     wick, so scaling it flickers the flame up from the wick;
#   <prop>_light_<i>  an empty in the flame's middle, where the game should put its light.
# Wall sconces have their origin on the wall plane at the middle of the back plate, 1-tile
# centred on a tile and 2-tile on the seam between two. Tabletop props have theirs at the
# centre of the base, on the table. Both materials sample candles_atlas.png unfiltered.
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from candle_layout import (  # noqa: E402
    ATLAS_SIZE, REGION, SCONCES, TEXELS_PER_UNIT, plate_outline, shelf_outline,
)

ROOT = Path(__file__).resolve().parents[1]
ATLAS = ROOT / 'art' / 'candles_atlas.png'
BLEND = ROOT / 'art' / 'candles.blend'
ASSETS = ROOT / 'src' / 'client' / 'assets'

# Triangle budgets per prop, flames included; the build fails outside them.
BUDGET = {
    'wall_candle_1tile': (80, 180),
    'wall_candle_2tile': (120, 250),
    'candelabra_3candle': (250, 500),
    'chamberstick': (100, 220),
}
# Where each prop sits in the .blend, side by side; the glbs are exported at the origin.
SHOWCASE_X = {'wall_candle_1tile': -45, 'wall_candle_2tile': -12, 'candelabra_3candle': 25, 'chamberstick': 50}
SHARP_ANGLE = math.radians(61)

# Candles: hexagonal, a face to the front, the top melted into a shallow crater.
CANDLE_RADIUS, CANDLE_SIDES, CRATER = 1.3, 6, 0.35
# Flame: a four-sided double pyramid, widest WAIST of the way up, its foot WICK_GAP above the
# candle's rim (just below it, over the crater, so the wick shows beneath). The light sits
# LIGHT_AT of the way up.
FLAME_HEIGHT, FLAME_RADIUS, FLAME_WAIST, WICK_GAP, LIGHT_AT = 3.4, 0.95, 0.33, -0.1, 0.4
# The sconces' candle cups: hexagonal, on the shelf.
CUP_RADIUS, CUP_HEIGHT = 1.9, 2.6
SCONCE_CANDLE_HEIGHT = 9.5
# The 2-tile sconce's corbel under the middle of its shelf, (out from the plate, down from the
# shelf's underside), back top round to back bottom, HALF_WIDTH either side of the middle.
BRACKET = [(-0.1, 0), (4.2, 0), (3.6, 1.4), (1.6, 3.4), (-0.1, 5.0)]
BRACKET_HALF_WIDTH = 1.0

# Candelabra (brass, after the three-candle reference): a hexagonal domed foot, a baluster stem
# and a centre cup, as (radius, height) from the bottom centre up to the top centre; two arms,
# square bars dipping out and down from the stem and turning up into the side cups.
COLUMN = [(0, 0), (6.0, 0), (6.0, 1.0), (3.0, 2.4), (1.1, 3.8), (2.0, 5.4), (1.0, 7.0),
          (1.6, 10.5), (0.8, 14.0), (1.5, 15.0), (0.9, 16.0), (0.9, 18.0), (2.6, 18.8),
          (2.6, 19.3), (1.5, 19.6), (1.6, 21.6), (2.0, 22.1), (0, 22.1)]
SIDE_CUP = [(0, 0), (2.2, 0), (2.2, 0.5), (1.4, 0.8), (1.5, 2.8), (1.9, 3.2), (0, 3.2)]
ARM = [(0.3, 16.8), (2.8, 17.6), (5.0, 16.2), (7.2, 14.3), (9.0, 14.4), (9.8, 15.8), (9.8, 17.8)]
ARM_SIZE = 1.1
SIDE_CUP_AT = (9.8, 17.6)
CENTRE_CANDLE_HEIGHT, SIDE_CANDLE_HEIGHT = 9.0, 8.0

# Chamberstick (brass, after the chamberstick reference): an octagonal dish whose rim alternates
# between two radii (a hint of scallops), a hexagonal socket on a short stem, a stub of candle,
# and a handle bar rising from the stem into a six-sided ring loop.
TRAY = [(0, 0), (5.4, 0), (6.4, 0.9, 6.0), (5.9, 1.2), (5.0, 0.6), (0, 0.6)]
SOCKET = [(0.75, 0.6), (0.75, 1.8), (1.9, 2.8), (1.7, 4.2), (2.1, 4.6), (0, 4.6)]
HANDLE_ARM = [(1.0, 1.0), (3.0, 1.6)]
LOOP_CENTRE, LOOP_RADIUS, LOOP_START = (5.4, 4.0), 1.7, 210
HANDLE_SIZE = 0.9
CHAMBER_CANDLE_HEIGHT = 5.0


def region_uv(region, fu, fv):
    """A point in an atlas region, fu across and fv up (0..1), kept half a texel inside."""
    x, y, w, h = REGION[region]
    return ((x + 0.5 + fu * (w - 1)) / ATLAS_SIZE, 1 - (y + 0.5 + (1 - fv) * (h - 1)) / ATLAS_SIZE)


def newell(points):
    n = Vector()
    for a, b in zip(points, points[1:] + points[:1]):
        n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
    return n


def arc_fractions(points):
    """How far along a polyline each point is, as a share of its length."""
    lengths = [0.0]
    for a, b in zip(points, points[1:]):
        lengths.append(lengths[-1] + math.dist(a[:2], b[:2]))
    return [length / lengths[-1] for length in lengths]


def outward_edges(outline):
    """For a closed 2D outline, each edge's outward normal (the edge from point i to i + 1)."""
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(outline, outline[1:] + outline[:1]))
    sign = 1 if area > 0 else -1
    return [(sign * (b[1] - a[1]), -sign * (b[0] - a[0])) for a, b in zip(outline, outline[1:] + outline[:1])]


class Part:
    """A mesh being built: a bmesh with one UV layer, and the faces still to be box-mapped
    into a region (flat faces of glaze or rim, mapped along their main axis)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.boxed = []

    def vert(self, co):
        return self.bm.verts.new(Vector(co))

    def face(self, verts, uvs, outward=None):
        """A face through `verts`, wound so its normal agrees with `outward` when given."""
        if outward is not None and newell([v.co for v in verts]).dot(Vector(outward)) < 0:
            verts, uvs = verts[::-1], uvs[::-1]
        face = self.bm.faces.new(verts)
        for loop, uv in zip(face.loops, uvs):
            loop[self.uv].uv = uv
        return face

    def boxed_face(self, verts, region, outward):
        self.boxed.append((self.face(verts, [(0, 0)] * len(verts), outward), region))

    def box_map(self):
        """Projects each boxed face along its normal's main axis at TEXELS_PER_UNIT, or smaller
        if that would not fit its region, from the region's bottom left corner."""
        for face, region in self.boxed:
            n = newell([v.co for v in face.verts])
            a, b = {0: (1, 2), 1: (0, 2), 2: (0, 1)}[max(range(3), key=lambda i: abs(n[i]))]
            us = [loop.vert.co[a] for loop in face.loops]
            vs = [loop.vert.co[b] for loop in face.loops]
            x, y, w, h = REGION[region]
            scale = min(TEXELS_PER_UNIT, (w - 1) / max(max(us) - min(us), 1e-6), (h - 1) / max(max(vs) - min(vs), 1e-6))
            for loop, u, v in zip(face.loops, us, vs):
                loop[self.uv].uv = ((x + 0.5 + (u - min(us)) * scale) / ATLAS_SIZE,
                                    1 - (y + h - 0.5 - (v - min(vs)) * scale) / ATLAS_SIZE)

    def lathe(self, profile, sides, origin, uv, angle0=0.0):
        """Turns `profile` round the Z axis through `origin`: (radius, height) points from the
        bottom outside up to the top, radius 0 closing at the axis; a third value is the radius
        of every odd vertex of that ring. uv(segment, ring, j) gives the uv of the j-th vertex
        (j may be fractional at the axis, and reaches `sides` at the seam) of the ring as used by
        the faces of profile segment `segment`."""
        origin = Vector(origin)
        rings = []
        for point in profile:
            radius, z = point[0], point[1]
            if radius == 0:
                rings.append([self.vert(origin + Vector((0, 0, z)))])
                continue
            ring = []
            for j in range(sides):
                r = point[2] if len(point) > 2 and j % 2 else radius
                angle = angle0 + 2 * math.pi * j / sides
                ring.append(self.vert(origin + Vector((r * math.cos(angle), r * math.sin(angle), z))))
            rings.append(ring)
        for k, (low, high) in enumerate(zip(rings, rings[1:])):
            for j in range(sides):
                jn = (j + 1) % sides
                if len(low) == 1:
                    self.face([low[0], high[jn], high[j]], [uv(k, k, j + 0.5), uv(k, k + 1, j + 1), uv(k, k + 1, j)])
                elif len(high) == 1:
                    self.face([low[j], low[jn], high[0]], [uv(k, k, j), uv(k, k, j + 1), uv(k, k + 1, j + 0.5)])
                else:
                    self.face([low[j], low[jn], high[jn], high[j]],
                              [uv(k, k, j), uv(k, k, j + 1), uv(k, k + 1, j + 1), uv(k, k + 1, j)])

    def brass_lathe(self, profile, sides, origin, angle0=0.0):
        v = arc_fractions(profile)
        self.lathe(profile, sides, origin, lambda _, k, j: region_uv('brass', j / sides, v[k]), angle0)

    def tube(self, path, size, binormal, sides=4):
        """A square brass bar `size` thick along a polyline lying in the plane whose normal is
        `binormal`, two faces flat to that plane, mitred at the bends; its ends are open (buried
        in what it joins)."""
        path = [Vector(p) for p in path]
        b = Vector(binormal).normalized()
        dirs = [(q - p).normalized() for p, q in zip(path, path[1:])]
        lengths = [0.0]
        for p, q in zip(path, path[1:]):
            lengths.append(lengths[-1] + (q - p).length)
        v = [length / lengths[-1] for length in lengths]
        rings = []
        for i, p in enumerate(path):
            d_in, d_out = dirs[max(i - 1, 0)], dirs[min(i, len(dirs) - 1)]
            t = (d_in + d_out).normalized()
            n = b.cross(t).normalized() / max(t.dot(d_out), 0.3)
            rings.append([self.vert(p + (n * math.cos(a) + b * math.sin(a)) * size / math.sqrt(2))
                          for a in (math.pi / 4 + math.pi / 2 * k for k in range(sides))])
        for i, (low, high) in enumerate(zip(rings, rings[1:])):
            middle = (path[i] + path[i + 1]) / 2
            for k in range(sides):
                kn = (k + 1) % sides
                verts = [low[k], low[kn], high[kn], high[k]]
                uvs = [region_uv('brass', k / sides, v[i]), region_uv('brass', (k + 1) / sides, v[i]),
                       region_uv('brass', (k + 1) / sides, v[i + 1]), region_uv('brass', k / sides, v[i + 1])]
                self.face(verts, uvs, sum((x.co for x in verts), Vector()) / 4 - middle)

    def candle(self, base, height):
        """A candle standing on `base`; returns where its flame's foot goes."""
        base = Vector(base)
        _, _, _, region_height = REGION['wax']
        side_v = [1 - height * TEXELS_PER_UNIT / (region_height - 1), 1.0]

        def uv(segment, ring, j):
            if segment == 0:
                return region_uv('wax', j / CANDLE_SIDES, side_v[ring])
            if ring == 2:
                return region_uv('wax_top', 0.5, 0.5)
            angle = 2 * math.pi * j / CANDLE_SIDES
            return region_uv('wax_top', 0.5 + 0.5 * math.cos(angle), 0.5 + 0.5 * math.sin(angle))

        self.lathe([(CANDLE_RADIUS, 0), (CANDLE_RADIUS, height), (0, height - CRATER)], CANDLE_SIDES, base, uv)
        return base + Vector((0, 0, height + WICK_GAP))


def glaze_lathe(part, profile, sides, origin):
    v = arc_fractions(profile)
    part.lathe(profile, sides, origin, lambda _, k, j: region_uv('glaze', j / sides, v[k]))


def sconce(name):
    """A wall sconce after the ceramic reference: a glazed back plate with an arched top and a
    rounded foot, a D-shaped shelf, and a hexagonal cup and candle per entry of `candles_x`."""
    spec = SCONCES[name]
    part = Part()
    t = spec['plate_thickness']
    outline = plate_outline(spec)
    half_width = max(x for x, _ in outline)
    top = max(z for _, z in outline)
    px, py, _, _ = REGION[spec['region']]
    front = [part.vert((x, -t, z)) for x, z in outline]
    back = [part.vert((x, 0, z)) for x, z in outline]
    part.face(front, [((px + (x + half_width) * TEXELS_PER_UNIT) / ATLAS_SIZE,
                       1 - (py + (top - z) * TEXELS_PER_UNIT) / ATLAS_SIZE) for x, z in outline], (0, -1, 0))
    for i, (nx, nz) in enumerate(outward_edges(outline)):
        j = (i + 1) % len(outline)
        part.boxed_face([back[i], back[j], front[j], front[i]], 'rim', (nx, 0, nz))

    shelf = shelf_outline(spec)
    shelf_top = spec['shelf_top']
    shelf_bottom = shelf_top - spec['shelf_thickness']
    upper = [part.vert((x, -t + y, shelf_top)) for x, y in shelf]
    lower = [part.vert((x, -t + y, shelf_bottom)) for x, y in shelf]
    part.boxed_face(upper, 'glaze', (0, 0, 1))
    part.boxed_face(lower, 'rim', (0, 0, -1))
    for i, (nx, ny) in enumerate(outward_edges(shelf)[:-1]):  # the last edge is the back
        part.boxed_face([lower[i], lower[i + 1], upper[i + 1], upper[i]], 'rim', (nx, ny, 0))

    if spec['bracket']:
        sides = {s: [part.vert((s * BRACKET_HALF_WIDTH, -t - out, shelf_bottom - down)) for out, down in BRACKET]
                 for s in (-1, 1)}
        for s, verts in sides.items():
            part.boxed_face(verts, 'rim', (s, 0, 0))
        centre = sum((v.co for v in sides[1]), Vector()) / len(BRACKET)
        for i in range(1, len(BRACKET) - 1):  # the front faces; top and back are against the shelf and plate
            verts = [sides[-1][i], sides[-1][i + 1], sides[1][i + 1], sides[1][i]]
            middle = sum((v.co for v in verts), Vector()) / 4
            part.boxed_face(verts, 'rim', (0, middle.y - centre.y, middle.z - centre.z))

    feet = []
    for x in spec['candles_x']:
        cup = (x, -t - spec['cup_depth'], shelf_top)
        glaze_lathe(part, [(CUP_RADIUS, 0), (CUP_RADIUS, CUP_HEIGHT), (0, CUP_HEIGHT)], 6, cup)
        feet.append(part.candle((x, cup[1], shelf_top + CUP_HEIGHT), SCONCE_CANDLE_HEIGHT))
    return part, feet


def candelabra():
    part = Part()
    part.brass_lathe(COLUMN, 6, (0, 0, 0))
    feet = [part.candle((0, 0, COLUMN[-1][1]), CENTRE_CANDLE_HEIGHT)]
    for s in (-1, 1):
        part.tube([(s * x, 0, z) for x, z in ARM], ARM_SIZE, (0, 1, 0))
        cup = (s * SIDE_CUP_AT[0], 0, SIDE_CUP_AT[1])
        part.brass_lathe(SIDE_CUP, 6, cup)
        feet.append(part.candle((cup[0], 0, cup[2] + SIDE_CUP[-1][1]), SIDE_CANDLE_HEIGHT))
    return part, feet


def chamberstick():
    part = Part()
    part.brass_lathe(TRAY, 8, (0, 0, 0), math.pi / 8)
    part.brass_lathe(SOCKET, 6, (0, 0, 0))
    cx, cz = LOOP_CENTRE
    loop = [(cx + LOOP_RADIUS * math.cos(math.radians(LOOP_START - 60 * k)), 0,
             cz + LOOP_RADIUS * math.sin(math.radians(LOOP_START - 60 * k))) for k in range(7)]
    part.tube([(x, 0, z) for x, z in HANDLE_ARM] + loop, HANDLE_SIZE, (0, 1, 0))
    return part, [part.candle((0, 0, SOCKET[-1][1]), CHAMBER_CANDLE_HEIGHT)]


def finish(part, mesh):
    """Box-maps, triangulates n-gons (quads stay quads), shades smooth with hard edges past
    SHARP_ANGLE, and writes the mesh."""
    bm = part.bm
    part.box_map()
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.normal_update()
    for face in bm.faces:
        face.smooth = True
    for edge in bm.edges:
        edge.smooth = not (edge.is_manifold and edge.calc_face_angle(0) > SHARP_ANGLE)
    bm.to_mesh(mesh)
    bm.free()
    return sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)


def flame_mesh():
    part = Part()
    foot, tip = part.vert((0, 0, 0)), part.vert((0, 0, FLAME_HEIGHT))
    ring = [part.vert((FLAME_RADIUS * math.cos(a), FLAME_RADIUS * math.sin(a), FLAME_WAIST * FLAME_HEIGHT))
            for a in (math.pi / 4 + math.pi / 2 * k for k in range(4))]
    middle = Vector((0, 0, FLAME_WAIST * FLAME_HEIGHT))
    uv_foot, uv_waist, uv_tip = (region_uv('flame', 0.5, v) for v in (0, FLAME_WAIST, 1))
    for k in range(4):
        a, b = ring[k], ring[(k + 1) % 4]
        for third, uv in ((foot, uv_foot), (tip, uv_tip)):
            verts = [a, b, third]
            part.face(verts, [uv_waist, uv_waist, uv], sum((v.co for v in verts), Vector()) / 3 - middle)
    mesh = bpy.data.meshes.new('candle_flame')
    return mesh, finish(part, mesh)


def atlas_material(name, image, unlit):
    """The atlas, sampled unfiltered: as the base colour of a rough, non-metal surface, or
    straight into the output, which the glTF exporter writes as KHR_materials_unlit."""
    material = bpy.data.materials.new(name)
    if material.node_tree is None:
        material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf, output = nodes['Principled BSDF'], nodes['Material Output']
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    texture.interpolation = 'Closest'
    if unlit:
        nodes.remove(bsdf)
        links.new(texture.outputs['Color'], output.inputs['Surface'])
    else:
        links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 1.0
        bsdf.inputs['Metallic'].default_value = 0.0
    return material


if not ATLAS.exists():
    raise SystemExit(f'{ATLAS} is missing: run python art/paint_candles.py first')
bpy.ops.wm.read_factory_settings(use_empty=True)
atlas = bpy.data.images.load(str(ATLAS))
atlas.pack()
atlas.name = 'CandleAtlas'
props_material = atlas_material('candle_props', atlas, unlit=False)
flame_material = atlas_material('candle_flame', atlas, unlit=True)
flame, flame_tris = flame_mesh()
flame.materials.append(flame_material)

builders = {
    'wall_candle_1tile': lambda: sconce('wall_candle_1tile'),
    'wall_candle_2tile': lambda: sconce('wall_candle_2tile'),
    'candelabra_3candle': candelabra,
    'chamberstick': chamberstick,
}
roots = {}
for name, build in builders.items():
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    part, feet = build()
    mesh = bpy.data.meshes.new(name)
    tris = finish(part, mesh) + flame_tris * len(feet)
    mesh.materials.append(props_material)
    root = bpy.data.objects.new(name, mesh)
    collection.objects.link(root)
    for i, foot in enumerate(feet):
        flame_object = bpy.data.objects.new(f'{name}_flame_{i}', flame)
        flame_object.parent = root
        flame_object.location = foot
        light = bpy.data.objects.new(f'{name}_light_{i}', None)
        light.empty_display_type = 'SPHERE'
        light.empty_display_size = 0.6
        light.parent = root
        light.location = foot + Vector((0, 0, LIGHT_AT * FLAME_HEIGHT))
        collection.objects.link(flame_object)
        collection.objects.link(light)
    low, high = BUDGET[name]
    print(f'CANDLES {name}: {tris} tris (budget {low}-{high}), {len(feet)} flame(s)')
    assert low <= tris <= high, f'{name} has {tris} triangles, outside {low}-{high}'
    roots[name] = root

for name, root in roots.items():
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [root, *root.children]:
        obj.select_set(True)
    path = ASSETS / f'{name}.glb'
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False)
    print('CANDLES exported', path)
    root.location.x = SHOWCASE_X[name]

bpy.context.preferences.filepaths.save_version = 0  # no candles.blend1 backup
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), compress=True)
print('CANDLES saved', BLEND)
