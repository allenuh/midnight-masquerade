# Shared by art/paint_candles.py and art/build_candles.py: the candle props' atlas layout and the
# wall sconces' shapes, which the painter needs too (each back plate's front face is painted as
# one picture, rim and all). Plain data and arithmetic, no bpy, numpy or Pillow.
# Sizes are world units (a tile is 20 wide, a wall 56 tall), Blender Z up. A sconce's back plate
# lies on the wall plane y = 0 and the sconce stands out toward -Y (+Z in the exported glTF),
# its origin at the middle of the plate's back; outlines are (x, z) about that origin.

ATLAS_SIZE = 128
TEXELS_PER_UNIT = 2

# Atlas regions as (x, y, width, height) in texels, y down from the top of the image. The
# plates are drawn at TEXELS_PER_UNIT; everything else is wrapped into its region.
REGION = {
    'plate_2tile': (2, 2, 60, 60),
    'plate_1tile': (66, 2, 26, 52),
    'brass': (96, 2, 30, 60),
    'wax': (2, 66, 16, 32),
    'wax_top': (22, 66, 12, 12),
    'glaze': (38, 66, 28, 28),
    'rim': (70, 66, 28, 28),
    'flame': (102, 66, 4, 60),
}

# Each back plate's right half, from the top centre down to the bottom centre: straight sides, a
# small inward notch at the top corners, then a shallow arch, and the same below the shelf down
# to a rounded point (after the ceramic reference). The left half mirrors it.
# The shelf's right half is (x, y from the plate's front face), from its back corner round to the
# front centre; y is negative, out from the wall. Candles stand on the shelf at `candles_x`,
# `cup_depth` out from the plate's front face. `bracket` adds a corbel under the shelf's middle.
SCONCES = {
    'wall_candle_1tile': {
        'region': 'plate_1tile',
        'plate': [(0, 13.0), (2.6, 12.0), (4.6, 10.6), (5.2, 9.4), (6.5, 8.6), (6.5, -7.6),
                  (5.2, -8.6), (4.9, -10.2), (2.8, -12.1), (0, -13.0)],
        'plate_thickness': 1.0,
        'shelf': [(6.2, 0), (6.0, -1.6), (4.6, -3.2), (2.4, -4.0), (0, -4.3)],
        'shelf_top': -5.0,
        'shelf_thickness': 1.2,
        'candles_x': [0.0],
        'cup_depth': 2.2,
        'bracket': False,
    },
    'wall_candle_2tile': {
        'region': 'plate_2tile',
        'plate': [(0, 14.6), (4.5, 13.6), (9.0, 12.2), (12.6, 10.6), (13.4, 9.2), (15.0, 8.4),
                  (15.0, -7.8), (13.6, -8.8), (13.0, -10.4), (9.0, -12.8), (4.0, -14.1), (0, -14.6)],
        'plate_thickness': 1.2,
        'shelf': [(14.6, 0), (14.3, -2.0), (12.0, -3.8), (8.0, -4.9), (4.0, -5.3), (0, -5.4)],
        'shelf_top': -6.1,
        'shelf_thickness': 1.4,
        'candles_x': [-7.5, 7.5],
        'cup_depth': 2.6,
        'bracket': True,
    },
}


def mirrored(right_half):
    """A closed outline from its right half (first and last points on x = 0): the half as given,
    then its mirror image back the other way, the centre points not repeated."""
    return list(right_half) + [(-x, y) for x, y in reversed(right_half[1:-1])]


def plate_outline(spec):
    return mirrored(spec['plate'])


def shelf_outline(spec):
    """The shelf seen from above, (x, y from the plate's front face): back corner, round the
    front, to the other back corner. Its closing edge is the back, against the plate."""
    half = spec['shelf']
    return list(half) + [(-x, y) for x, y in reversed(half[:-1])]
