# Paints the candle props' shared atlas, art/candles_atlas.png, which art/build_candles.py packs
# into every candle model. Developer-only: needs numpy and Pillow, and is re-run by hand after a
# change (then re-run the build):
#     python art/paint_candles.py
# The layout (which region holds what) and the sconce plate shapes come from candle_layout.py.
# Two finishes after the references: a crackled cream-and-ochre glaze with a brown-violet rim
# for the wall sconces, and dark aged brass for the candelabra and the chamberstick. Wax is
# ivory with paler drips running down from the top; the flame is a short banded ramp.
# The game samples it with nearest filtering, so the look comes from flat fills, a few
# blotches and a little texel noise, like the battery's atlas.
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from candle_layout import ATLAS_SIZE, REGION, SCONCES, TEXELS_PER_UNIT, plate_outline  # noqa: E402

OUT = Path(__file__).resolve().parent / 'candles_atlas.png'
RNG = np.random.default_rng(5)
# Texel brightness noise (standard deviation, as a share of the colour), not on the flame.
NOISE = 0.05

GLAZE = '#cdb98a'
GLAZE_LIGHT = '#ddcc9c'
GLAZE_LOW = '#a3824a'
GLAZE_SPOT = '#9fb2ac'
POOL = '#6d8a8c'
RIM = '#8a5c38'
RIM_VIOLET = '#73587a'
RIM_DARK = '#57391f'
BRASS = '#7a6533'
BRASS_LIGHT = '#a89050'
BRASS_DARK = '#3e3219'
PATINA = '#56603c'
WAX = '#dac9a0'
WAX_DRIP = '#f6eed8'
WAX_SHADE = '#c6b48e'
WAX_CRATER = '#bba982'
WICK = '#221a12'
# The flame from its foot to its tip: (share of the height where the band starts, colour).
FLAME = [(0.0, '#1e1a2c'), (0.07, '#3b55c8'), (0.17, '#ffe6a0'), (0.3, '#fff8de'),
         (0.55, '#ffc848'), (0.8, '#ff7d1e')]
# The plate's rim band and the line of pooled glaze inside it, in world units.
RIM_WIDTH, POOL_WIDTH = 1.0, 0.5
# How far under the shelf its shadow is baked into the plate, and how dark at the shelf.
SHELF_SHADOW, SHELF_SHADOW_DEPTH = 1.6, 0.7


def hexc(value):
    return np.array([int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def blotches(h, w, cell):
    """Smooth 0..1 noise varying over about `cell` texels."""
    gh, gw = h // cell + 2, w // cell + 2
    small = Image.fromarray((RNG.random((gh, gw)) * 255).astype(np.uint8))
    return np.asarray(small.resize((gw * cell, gh * cell), Image.BILINEAR), np.float32)[:h, :w] / 255


def mix(a, b, t):
    return a + (b - a) * np.asarray(t, np.float32)[..., None]


def fill(h, w, colour):
    return np.broadcast_to(hexc(colour), (h, w, 3)).copy()


def boundary_distance(X, Z, outline):
    """Distance from every (X, Z) to the outline's nearest edge, and whether it is inside."""
    d = np.full(X.shape, np.inf, np.float32)
    inside = np.zeros(X.shape, bool)
    for (ax, az), (bx, bz) in zip(outline, outline[1:] + outline[:1]):
        ex, ez = bx - ax, bz - az
        t = np.clip(((X - ax) * ex + (Z - az) * ez) / (ex * ex + ez * ez), 0, 1)
        d = np.minimum(d, np.hypot(X - ax - t * ex, Z - az - t * ez))
        crosses = (az > Z) != (bz > Z)
        inside ^= crosses & (X < ax + (Z - az) * ex / np.where(ez == 0, 1, ez))
    return d, inside


def rim(h, w):
    out = mix(fill(h, w, RIM), hexc(RIM_VIOLET), blotches(h, w, 5) > 0.68)
    return mix(out, hexc(RIM_DARK), blotches(h, w, 3) > 0.85)


def glaze(h, w):
    out = mix(fill(h, w, GLAZE), hexc(GLAZE_LIGHT), blotches(h, w, 6))
    return mix(out, hexc(GLAZE_SPOT), blotches(h, w, 4) > 0.85)


def plate(name):
    """A back plate's front face, texel for texel at TEXELS_PER_UNIT: the rim band round the
    outline, a line of pooled glaze inside it, cream glaze above the shelf and darker ochre
    below it, where the shelf's shadow falls."""
    spec = SCONCES[name]
    _, _, w, h = REGION[spec['region']]
    outline = plate_outline(spec)
    half_width = max(x for x, _ in outline)
    top = max(z for _, z in outline)
    X = np.broadcast_to(-half_width + (np.arange(w) + 0.5) / TEXELS_PER_UNIT, (h, w))
    Z = np.broadcast_to(top - (np.arange(h)[:, None] + 0.5) / TEXELS_PER_UNIT, (h, w))
    d, inside = boundary_distance(X, Z, outline)
    shelf_bottom = spec['shelf_top'] - spec['shelf_thickness']
    below = Z < shelf_bottom
    out = glaze(h, w)
    out[below] = mix(out, hexc(GLAZE_LOW), 0.75)[below]
    shade = np.clip((shelf_bottom - Z) / SHELF_SHADOW, 0, 1)
    out *= np.where(below, SHELF_SHADOW_DEPTH + (1 - SHELF_SHADOW_DEPTH) * shade, 1)[..., None]
    out[d < RIM_WIDTH + POOL_WIDTH] = hexc(POOL)
    edge = (d < RIM_WIDTH) | ~inside
    out[edge] = rim(h, w)[edge]
    return out


def brass(h, w):
    out = mix(fill(h, w, BRASS), hexc(BRASS_LIGHT), blotches(h, w, 5) ** 2)
    out = mix(out, hexc(PATINA), blotches(h, w, 6) > 0.84)
    return mix(out, hexc(BRASS_DARK), blotches(h, w, 2) > 0.88)


def wax(h, w):
    """A candle's side, its top at row 0 and u round the circumference: drips of paler wax run
    down from the top, each with a shaded edge and a bead at its end; the foot is shaded."""
    out = mix(fill(h, w, WAX), hexc(WAX_SHADE), np.linspace(0, 0.6, h)[:, None] ** 2 * np.ones((1, w)))
    for column in range(0, w, 2):
        length = int(RNG.integers(2, 14))
        x = (column + int(RNG.integers(0, 2))) % w
        out[:length, x] = hexc(WAX_DRIP)
        out[:length, (x + 1) % w] = hexc(WAX_SHADE)
        out[length, x] = hexc(WAX_DRIP)
    out[0] = hexc(WAX_DRIP)
    return out


def wax_top(h, w):
    """A candle's top, seen from above: a melted crater, darker toward the wick."""
    r = np.hypot(np.arange(w) + 0.5 - w / 2, np.arange(h)[:, None] + 0.5 - h / 2) / (w / 2)
    out = mix(fill(h, w, WAX_DRIP), hexc(WAX_CRATER), np.clip(1.2 - r, 0, 1))
    out[r < 0.2] = hexc(WICK)
    return out


def flame(h, w):
    out = np.zeros((h, w, 3), np.float32)
    for start, colour in FLAME:
        out[:h - int(round(start * h))] = hexc(colour)  # row 0 is the tip
    return out


atlas = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 3), np.float32)
atlas[:] = hexc(RIM_DARK)
painters = {
    'plate_1tile': lambda h, w: plate('wall_candle_1tile'),
    'plate_2tile': lambda h, w: plate('wall_candle_2tile'),
    'brass': brass, 'wax': wax, 'wax_top': wax_top, 'glaze': glaze, 'rim': rim,
}
for name, painter in painters.items():
    x, y, w, h = REGION[name]
    atlas[y:y + h, x:x + w] = painter(h, w)
atlas *= 1 + NOISE * RNG.standard_normal((ATLAS_SIZE, ATLAS_SIZE, 1)).astype(np.float32)
x, y, w, h = REGION['flame']
atlas[y:y + h, x:x + w] = flame(h, w)
Image.fromarray((np.clip(atlas, 0, 1) * 255).round().astype(np.uint8)).save(OUT)
print('CANDLES atlas', OUT)
