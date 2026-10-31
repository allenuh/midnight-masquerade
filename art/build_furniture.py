# Builds the three storage furniture props from scratch into art/furniture.blend and exports each
# as its own glb in src/client/assets/: bookshelf_1x2, dresser_1x2 and cupboard_1x3.
# Developer-only, re-run by hand after changing a shape here, or the atlases (paint them first
# with art/paint_furniture.py):
#     blender -b --factory-startup --python art/build_furniture.py
# Sizes are world units, 1:1 with the game: a tile is 20, a wall 56 tall, a Hunter about 50.
# Footprints are tiles across (X) by one tile deep (Y); each piece's origin is the middle of its
# footprint on the floor. Every piece faces -Y (+Z in the glTF, like the other models) with its
# back BACK from the origin, just short of the footprint's back edge, so a piece set on the
# tile beside a wall stands flush against it. Undersides are left out (never seen); backs are
# kept, so a piece also works turned away from the camera.
# Like a PlayStation-era prop, the pieces are blocky boxes with flat shading, and the detail
# (grain, worn edges, panels, hinges, keyholes, shadow inside the shelves) is in the texture.
# Each piece is a root mesh with its own wood material and atlas; the bookshelf's books are a
# child mesh, bookshelf_1x2_books, with their own material. Each piece has its own collection.
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from furniture_layout import (  # noqa: E402
    ATLAS_SIZE, BOOK_DESIGNS, BOOK_REGIONS, BOOKS_SIZE, EDGE_WIDTH, REGIONS, TEXELS_PER_UNIT,
)

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'art'
BLEND = ART / 'furniture.blend'
ASSETS = ROOT / 'src' / 'client' / 'assets'

BACK = 9.8
# Triangle budgets per piece (the books are counted apart); the build fails outside them.
BUDGET = {'bookshelf_1x2': (200, 450), 'dresser_1x2': (180, 400), 'cupboard_1x3': (250, 500)}
# Each piece's material and atlas.
MATERIAL = {
    'bookshelf_1x2': ('bookshelf_mahogany', 'bookshelf_atlas.png'),
    'dresser_1x2': ('dresser_walnut', 'dresser_atlas.png'),
    'cupboard_1x3': ('cupboard_faded_oak', 'cupboard_atlas.png'),
}
# Where each piece stands in the .blend, side by side on the tile grid with a tile between;
# the glbs are exported at the origin.
SHOWCASE_X = {'bookshelf_1x2': -60, 'dresser_1x2': 0, 'cupboard_1x3': 70}
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))

# Knobs: hexagonal, flaring from a neck to a flat face.
KNOB_SIDES, KNOB_NECK = 6, 0.6


class Part:
    """A mesh being built: a bmesh with one UV layer mapping into `regions` of an atlas `size`
    texels square. Wood faces get a random patch of their region, from `seed`."""

    def __init__(self, regions, size, seed):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.regions, self.size = regions, size
        self.rng = random.Random(seed)

    def face(self, points, region, u_dir, v_dir, flip_u=False, outward=None, uvs=None):
        """A face through `points`, its texture's u along `u_dir` and v along `v_dir` (for a
        wood region, the grain goes along whichever side is longer). With `outward`, it is
        wound to face that way; otherwise the points must already run anticlockwise seen from
        outside."""
        points = [Vector(p) for p in points]
        if uvs is None:
            uvs = self.map(points, region, Vector(u_dir), Vector(v_dir), flip_u)
        if outward is not None:
            n = Vector()
            for a, b in zip(points, points[1:] + points[:1]):
                n += a.cross(b)
            if n.dot(Vector(outward)) < 0:
                points, uvs = points[::-1], uvs[::-1]
        face = self.bm.faces.new([self.bm.verts.new(p) for p in points])
        for loop, uv in zip(face.loops, uvs):
            loop[self.uv].uv = uv
        return face

    def map(self, points, region, u_dir, v_dir, flip_u):
        s = [p.dot(u_dir) for p in points]
        t = [p.dot(v_dir) for p in points]
        eu, ev = max(s) - min(s), max(t) - min(t)
        fs = [(a - min(s)) / eu for a in s]
        ft = [(b - min(t)) / ev for b in t]
        if flip_u:
            fs = [1 - f for f in fs]
        x, y, w, h, mode = self.regions[region]
        if mode == 'picture':
            return [((x + f * w) / self.size, 1 - (y + h - g * h) / self.size) for f, g in zip(fs, ft)]
        if min(eu, ev) < EDGE_WIDTH and f'{region}_edge' in self.regions:
            x, y, w, h, _ = self.regions[f'{region}_edge']
        if ev > eu:
            fs, ft, eu, ev = ft, fs, ev, eu
        su, sv = min(TEXELS_PER_UNIT, (w - 1) / eu), min(TEXELS_PER_UNIT, (h - 1) / ev)
        ou, ov = self.rng.uniform(0, w - 1 - eu * su), self.rng.uniform(0, h - 1 - ev * sv)
        return [((x + 0.5 + ou + f * eu * su) / self.size, 1 - (y + h - 0.5 - ov - g * ev * sv) / self.size)
                for f, g in zip(fs, ft)]

    def box(self, x0, x1, y0, y1, z0, z1, flip_u=False, matrix=None, **faces):
        """An axis-aligned box with only the named faces (front, back, left, right, top,
        bottom), each given its region. Front faces read left to right as seen from the front."""
        corners = {
            'front': [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
            'back': [(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)],
            'left': [(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)],
            'right': [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
            'top': [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
            'bottom': [(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)],
        }
        for side, region in faces.items():
            points = [Vector(c) for c in corners[side]]
            if matrix is not None:
                points = [matrix @ p for p in points]
            self.face(points, region, (points[1] - points[0]).normalized(), (points[3] - points[0]).normalized(),
                      flip_u and side == 'front')

    def prism(self, outline, y0, y1, front, back, edge, skip_edges=()):
        """A board cut to `outline` ((x, z) points, anticlockwise seen from the front), its front
        face at y0 and back at y1 (`back` None leaves it out), with an edge face along every
        outline edge but those in `skip_edges` (edge i runs from point i to point i + 1)."""
        self.face([(x, y0, z) for x, z in outline], front, X, Z)
        if back:
            self.face([(x, y1, z) for x, z in reversed(outline)], back, X, Z)
        for i, ((ax, az), (bx, bz)) in enumerate(zip(outline, outline[1:] + outline[:1])):
            if i not in skip_edges:
                points = [(ax, y1, az), (bx, y1, bz), (bx, y0, bz), (ax, y0, az)]
                self.face(points, edge, Vector((bx - ax, 0, bz - az)).normalized(), Y)

    def knob(self, cx, y, cz, radius, depth, region):
        """A knob on a front face at y, standing `depth` out from it, mapped flat from the
        front so its whole face shows the region's dome."""
        def ring(r, at):
            return [Vector((cx + r * math.cos(a), at, cz + r * math.sin(a)))
                    for a in (2 * math.pi * k / KNOB_SIDES for k in range(KNOB_SIDES))]

        x, yy, w, h, _ = self.regions[region]

        def uv(p):
            return ((x + (0.5 + (p.x - cx) / (2 * radius)) * w) / self.size,
                    1 - (yy + h - (0.5 + (p.z - cz) / (2 * radius)) * h) / self.size)

        neck, rim = ring(radius * KNOB_NECK, y), ring(radius, y - depth)
        for k in range(KNOB_SIDES):
            kn = (k + 1) % KNOB_SIDES
            points = [neck[k], neck[kn], rim[kn], rim[k]]
            middle = sum(points, Vector()) / 4
            self.face(points, region, X, Z, outward=middle - Vector((cx, middle.y, cz)), uvs=[uv(p) for p in points])
        self.face(rim, region, X, Z, outward=-Y, uvs=[uv(p) for p in rim])


def finish(part, mesh):
    """Welds the faces' shared corners, triangulates n-gons (quads stay quads), shades flat, and
    writes the mesh. Returns its triangle count."""
    bm = part.bm
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method='BEAUTY', ngon_method='BEAUTY')
    for face in bm.faces:
        face.smooth = False
    bm.to_mesh(mesh)
    bm.free()
    return sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)


# Bookshelf: tall and shallow, five open compartments between fluted pilasters, a stepped
# cornice and an arched crest on top, a scalloped valance under the top board, block feet.
# Compartment heights run bottom to top between SHELF-thick boards.
SHELF_DEPTH, SHELF = 12, 1.1
COMPARTMENTS = [9.3, 7.6, 7.6, 7.0, 7.0]
SHELF_FLOOR = 3.4
BOOKSHELF_CREST = [(-11, 50.4), (11, 50.4), (11, 51.4), (9.5, 51.8), (6.5, 52.5), (3, 53.1), (0, 53.4),
                   (-3, 53.1), (-6.5, 52.5), (-9.5, 51.8), (-11, 51.4)]
VALANCE = [(-17.6, 44.0), (-15, 45.0), (-10, 45.6), (0, 45.9), (10, 45.6), (15, 45.0), (17.6, 44.0),
           (17.6, 46.3), (-17.6, 46.3)]


def compartments():
    """(floor, height) of each compartment, bottom to top."""
    out, z = [], SHELF_FLOOR
    for height in COMPARTMENTS:
        out.append((z, height))
        z += height + SHELF
    return out


def bookshelf(part):
    front = BACK - SHELF_DEPTH
    inner, outer = 17.6, 19.4
    rooms = compartments()
    top_board = rooms[-1][0] + rooms[-1][1]
    carcass_top = top_board + 1.2
    for s in (-1, 1):
        lo, hi = sorted((s * 16.8, s * 20.0))
        part.box(lo, hi, -3.2, -0.2, 0, 3.6, front='trim', left='trim', right='trim', top='trim')
        part.box(lo, hi, 6.8, BACK, 0, 2.2, front='trim', back='trim', **{'left' if s < 0 else 'right': 'trim'})
        lo, hi = sorted((s * 17.2, s * 19.6))
        part.box(lo, hi, -2.7, -2.2, 3.6, 44.6, front='pilaster', left='trim', right='trim')
        lo, hi = sorted((s * 16.9, s * 19.9))
        part.box(lo, hi, -3.1, -2.2, 44.6, carcass_top, front='capital', left='trim', right='trim')
        lo, hi = sorted((s * inner, s * outer))
        part.box(lo, hi, front, BACK, 2.2, carcass_top, back='board', **{'left' if s < 0 else 'right': 'board'})
        for floor, height in rooms:
            part.box(lo, hi, front, 9.0, floor, floor + height, **{'right' if s < 0 else 'left': 'compartment_side'})
    part.box(-16.8, 16.8, -2.0, -1.4, 0.4, 3.4, front='trim', top='trim')
    part.box(-inner, inner, 9.0, BACK, 2.2, carcass_top, back='board')
    for floor, height in rooms:
        part.box(-inner, inner, 9.0, BACK, floor, floor + height, front='compartment')
    part.box(-inner, inner, front + 0.2, 9.0, 2.2, SHELF_FLOOR, front='board', top='board')
    for floor, _ in rooms[1:]:
        part.box(-inner, inner, front + 0.2, 9.0, floor - SHELF, floor, front='board', top='board', bottom='board')
    part.box(-inner, inner, front + 0.2, 9.0, top_board, carcass_top, front='board', bottom='board')
    part.prism(VALANCE, front + 0.2, front + 1.0, 'valance', None, 'trim', skip_edges=(6, 7, 8))
    part.box(-19.7, 19.7, -3.1, BACK, carcass_top, 48.5, front='trim', left='trim', right='trim', back='trim')
    part.box(-20.0, 20.0, -3.6, BACK, 48.5, 49.6, front='trim', left='trim', right='trim', back='trim')
    part.box(-19.6, 19.6, -3.2, BACK, 49.6, 50.4, front='trim', left='trim', right='trim', back='trim', top='top')
    part.prism(BOOKSHELF_CREST, -2.8, -1.8, 'crest', 'trim', 'trim', skip_edges=(0,))


def books(part, seed):
    """Books along each compartment of the bookshelf: runs of upright books of mixed height,
    sometimes one leaning on the run, a lying stack now and then, and empty spaces."""
    rng = random.Random(seed)
    front = BACK - SHELF_DEPTH + 0.8
    for floor, height in compartments():
        x, end = -17.3, 17.3
        while x < end - 1.5:
            roll = rng.random()
            if roll < 0.2:
                x += rng.uniform(2.5, 6.0)
                continue
            if roll < 0.3 and end - x > 8:
                width, z = rng.uniform(6.0, 7.2), floor
                for _ in range(rng.randint(2, 3)):
                    thick = rng.uniform(0.9, 1.3)
                    book(part, rng, x, x + width + rng.uniform(-0.6, 0.6), z, z + thick, front, lying=True)
                    z += thick
                x += width + 1.2
                continue
            run = []
            for _ in range(rng.randint(3, 6)):
                width = rng.uniform(1.2, 2.2)
                if x + width > end:
                    break
                run.append((x, x + width, floor + height * rng.uniform(0.62, 0.9)))
                x += width
            # Packed side by side, a book's side shows only at the end of the run or where it
            # stands taller than its neighbour.
            for i, (x0, x1, z1) in enumerate(run):
                sides = {side for side, j in (('left', i - 1), ('right', i + 1))
                         if not 0 <= j < len(run) or run[j][2] < z1}
                book(part, rng, x0, x1, floor, z1, front, sides=sides)
            if rng.random() < 0.4 and end - x > 4:
                tall, width, lean = height * rng.uniform(0.62, 0.82), rng.uniform(1.0, 1.5), math.radians(rng.uniform(12, 22))
                base = x + tall * math.sin(lean) + 0.1
                pivot = Vector((base, 0, floor))
                matrix = Matrix.Translation(pivot) @ Matrix.Rotation(-lean, 4, 'Y') @ Matrix.Translation(-pivot)
                book(part, rng, base, base + width, floor, floor + tall, front, matrix=matrix)
                x = base + width + 0.6
            x += rng.uniform(0.0, 0.4)


def book(part, rng, x0, x1, z0, z1, front, lying=False, matrix=None, sides=('left', 'right')):
    """One book: spine to the front, page edges on top, cover on the `sides` that show."""
    design = rng.randrange(BOOK_DESIGNS)
    depth = rng.uniform(6.8, 8.2)
    y1 = front + depth
    corners = {
        'front': [(x0, front, z0), (x1, front, z0), (x1, front, z1), (x0, front, z1)],
        'top': [(x0, front, z1), (x1, front, z1), (x1, y1, z1), (x0, y1, z1)],
        'left': [(x0, y1, z0), (x0, front, z0), (x0, front, z1), (x0, y1, z1)],
        'right': [(x1, front, z0), (x1, y1, z0), (x1, y1, z1), (x1, front, z1)],
    }
    # Standing, the spine runs up the front and the page lines along the depth; lying, the
    # spine runs across, and the top is a cover.
    regions = {'front': f'spine_{design}', 'top': f'cover_{design}' if lying else 'pages',
               'left': 'pages' if lying else f'cover_{design}', 'right': 'pages' if lying else f'cover_{design}'}
    axes = {'front': (Z, X) if lying else (X, Z), 'top': (X, Y) if lying else (Y, X), 'left': (Z, Y) if lying else (Y, Z),
            'right': (Z, Y) if lying else (Y, Z)}
    for side, points in corners.items():
        if side in ('left', 'right') and side not in sides:
            continue
        points = [Vector(p) for p in points]
        u, v = axes[side]
        if matrix is not None:
            points = [matrix @ p for p in points]
            u, v = matrix.to_3x3() @ u, matrix.to_3x3() @ v
        part.face(points, regions[side], u, v)


# Dresser: low, deep and heavy: a carcass on a plinth with bracket feet, dark corner stiles,
# two small drawers over two wide ones, a thick overhanging top with a backsplash, brass knobs.
DRESSER_DEPTH = 16
DRAWERS = [(-16.6, -0.4, 20.6, 25.6, 'drawer_small'), (0.4, 16.6, 20.6, 25.6, 'drawer_small'),
           (-16.6, 16.6, 13.8, 19.8, 'drawer_wide'), (-16.6, 16.6, 7.0, 13.0, 'drawer_wide')]
DRESSER_KNOBS = [(-8.5, 23.1), (8.5, 23.1), (-9, 16.8), (9, 16.8), (-9, 10.0), (9, 10.0)]


def dresser(part):
    front = BACK - DRESSER_DEPTH
    part.box(-19.4, 19.4, front - 0.4, BACK, 0, 2.6, front='trim', left='trim', right='trim', back='trim', top='trim')
    for s in (-1, 1):
        lo, hi = sorted((s * 15.4, s * 19.9))
        part.box(lo, hi, front - 0.8, front + 3.2, 0, 3.0, front='trim', left='trim', right='trim', top='trim')
        lo, hi = sorted((s * 17.0, s * 19.2))
        part.box(lo, hi, front - 0.4, front, 2.6, 26.2, front='trim', left='trim', right='trim')
    part.box(-19.0, 19.0, front, BACK, 2.6, 26.2, front='carcass_front', left='board', right='board', back='board')
    for x0, x1, z0, z1, region in DRAWERS:
        part.box(x0, x1, front - 0.6, front, z0, z1, front=region, top='board', bottom='board', left='board', right='board')
    for x, z in DRESSER_KNOBS:
        part.knob(x, front - 0.6, z, 0.9, 1.0, 'brass')
    part.box(-19.5, 19.5, front - 0.7, BACK, 26.2, 26.8, front='trim', left='trim', right='trim', back='trim')
    part.box(-20.0, 20.0, front - 1.2, BACK, 26.8, 28.4, front='trim', left='trim', right='trim', back='trim', top='top')
    part.box(-18.6, 18.6, 8.4, BACK, 28.4, 31.0, front='board', left='board', right='board', back='board', top='top')


# Cupboard: wide and tall, a hutch: a deep base with a row of three drawers over three panelled
# doors and a countertop, and a shallow upper case with two tall doors either side of an open
# niche (a shelf, plates and a jar painted on its back), a stepped cornice and a low crest.
# Doors on the right hinge on their right (their texture flipped).
CUPBOARD_DEPTH, UPPER_DEPTH = 18, 10
BAYS = [(-27.4, -9.6), (-8.8, 8.8), (9.6, 27.4)]
NICHE = 10
UPPER_DOORS = [(-27.6, -11.4), (11.4, 27.6)]
CUPBOARD_CREST = [(-12, 53.0), (12, 53.0), (12, 54.0), (6, 54.6), (5, 55.4), (-5, 55.4), (-6, 54.6), (-12, 54.0)]


def cupboard(part):
    front, upper = BACK - CUPBOARD_DEPTH, BACK - UPPER_DEPTH
    part.box(-29.4, 29.4, front - 0.4, BACK, 0, 3.0, front='trim', left='trim', right='trim', back='trim', top='trim')
    part.box(-29.0, 29.0, front, BACK, 3.0, 24.0, front='carcass_front', left='board', right='board', back='board')
    for i, (x0, x1) in enumerate(BAYS):
        part.box(x0, x1, front - 0.5, front, 19.4, 23.0, front='drawer', top='board', bottom='board', left='board', right='board')
        part.knob((x0 + x1) / 2, front - 0.5, 21.2, 0.7, 0.9, 'iron')
        hinge_right = i == 2
        part.box(x0, x1, front - 0.5, front, 4.2, 18.6, flip_u=hinge_right, front='door_lower', top='board',
                 bottom='board', left='board', right='board')
        part.knob(x0 + 2.0 if hinge_right else x1 - 2.0, front - 0.5, 11.4, 0.7, 0.9, 'iron')
    part.box(-30.0, 30.0, front - 1.0, BACK, 24.0, 25.6, front='trim', left='trim', right='trim', back='trim', top='top')

    part.box(-29.0, -NICHE, upper, BACK, 25.6, 50.6, front='trim', left='board')
    part.box(NICHE, 29.0, upper, BACK, 25.6, 50.6, front='trim', right='board')
    part.box(-NICHE, NICHE, upper, BACK, 46.6, 50.6, front='trim')
    part.box(-29.0, 29.0, upper, BACK, 25.6, 50.6, back='board')
    # The niche's walls and ceiling face into it, from the case either side and the header.
    part.box(-29.0, -NICHE, upper, 9.0, 25.6, 46.6, right='niche_side')
    part.box(NICHE, 29.0, upper, 9.0, 25.6, 46.6, left='niche_side')
    part.box(-NICHE, NICHE, upper, 9.0, 46.6, 50.6, bottom='niche_side')
    part.box(-NICHE, NICHE, 9.0, BACK, 25.6, 35.6, front='niche')
    part.box(-NICHE, NICHE, 9.0, BACK, 36.6, 46.6, front='niche')
    part.box(-NICHE, NICHE, upper + 0.2, 9.0, 35.6, 36.6, front='board', top='board', bottom='board')
    for i, (x0, x1) in enumerate(UPPER_DOORS):
        part.box(x0, x1, upper - 0.5, upper, 27.0, 45.4, flip_u=i == 1, front='door_upper', top='board',
                 bottom='board', left='board', right='board')
        part.knob(x0 + 2.0 if i == 1 else x1 - 2.0, upper - 0.5, 36.2, 0.7, 0.9, 'iron')
    part.box(-29.5, 29.5, upper - 0.6, BACK, 50.6, 51.6, front='trim', left='trim', right='trim', back='trim')
    part.box(-30.0, 30.0, upper - 1.2, BACK, 51.6, 53.0, front='trim', left='trim', right='trim', back='trim', top='top')
    part.prism(CUPBOARD_CREST, upper - 0.8, upper + 0.2, 'crest', 'trim', 'trim', skip_edges=(0,))


def atlas_material(name, filename):
    """A rough, non-metal surface whose base colour is the atlas, sampled unfiltered."""
    image = bpy.data.images.load(str(ART / filename))
    image.pack()
    image.name = filename.removesuffix('.png')
    material = bpy.data.materials.new(name)
    if material.node_tree is None:
        material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = nodes['Principled BSDF']
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    texture.interpolation = 'Closest'
    material.node_tree.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    return material


# Run, not imported (art/build_tables.py borrows Part and the helpers above).
if __name__ == '__main__':
    for _, filename in [*MATERIAL.values(), ('', 'books_atlas.png')]:
        if not (ART / filename).exists():
            raise SystemExit(f'{ART / filename} is missing: run python art/paint_furniture.py first')
    bpy.ops.wm.read_factory_settings(use_empty=True)

    builders = {'bookshelf_1x2': bookshelf, 'dresser_1x2': dresser, 'cupboard_1x3': cupboard}
    roots = {}
    for seed, (name, build) in enumerate(builders.items()):
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
        part = Part(REGIONS[name], ATLAS_SIZE, seed)
        build(part)
        mesh = bpy.data.meshes.new(name)
        tris = finish(part, mesh)
        mesh.materials.append(atlas_material(*MATERIAL[name]))
        root = bpy.data.objects.new(name, mesh)
        collection.objects.link(root)
        low, high = BUDGET[name]
        print(f'FURNITURE {name}: {tris} tris (budget {low}-{high})')
        assert low <= tris <= high, f'{name} has {tris} triangles, outside {low}-{high}'
        roots[name] = root

    shelf_books = Part(BOOK_REGIONS, BOOKS_SIZE, 0)
    books(shelf_books, 7)
    books_mesh = bpy.data.meshes.new('bookshelf_1x2_books')
    print(f'FURNITURE bookshelf_1x2_books: {finish(shelf_books, books_mesh)} tris')
    books_mesh.materials.append(atlas_material('books_cloth', 'books_atlas.png'))
    books_object = bpy.data.objects.new('bookshelf_1x2_books', books_mesh)
    books_object.parent = roots['bookshelf_1x2']
    bpy.data.collections['bookshelf_1x2'].objects.link(books_object)

    for name, root in roots.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in [root, *root.children]:
            obj.select_set(True)
        path = ASSETS / f'{name}.glb'
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_animations=False)
        print('FURNITURE exported', path)
        root.location.x = SHOWCASE_X[name]

    bpy.context.preferences.filepaths.save_version = 0  # no furniture.blend1 backup
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND), compress=True)
    print('FURNITURE saved', BLEND)
