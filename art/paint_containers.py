# Paints the barrel and crate atlases into art/: barrel_standard_atlas.png,
# barrel_weathered_atlas.png, crate_standard_atlas.png and crate_dark_atlas.png, which
# art/build_containers.py packs into the models. Developer-only: needs numpy and Pillow, and is
# re-run by hand after a change (then re-run the build):
#     python art/paint_containers.py
# The layout comes from furniture_layout.py (each shape's variants share one) and the painters
# are art/paint_furniture.py's. The variants differ only in paint:
#   barrel standard   warm brown staves, each a shade apart, dark grey iron bands touched with rust;
#   barrel weathered  faded grey-brown staves with dark grain, rubbed patches and a split stave,
#                     iron gone to orange rust that has run down the wood below each band;
#   crate standard    dusty tan pine, three planks across, one diagonal brace, dark strips;
#   crate dark        dark stained wood, four planks up, a heavy cross brace, iron straps on the
#                     lid, stains, near-black strips.
# Lids and tops are kept a little lighter than the sides, so the props read from above against
# dark floors.
import sys
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from furniture_layout import BARREL_BANDS, BARREL_HEIGHT, CONTAINER_REGIONS, CONTAINER_SIZE  # noqa: E402
from paint_furniture import RNG, SHADOW, blotches, grain, hexc, mix, paint, worn  # noqa: E402

ART = Path(__file__).resolve().parent

BARREL = {'base': '#6a4a2e', 'dark': '#4a321c', 'light': '#7e5a38', 'worn': '#957252'}
BARREL_OLD = {'base': '#6e665a', 'dark': '#4a443a', 'light': '#857c6c', 'worn': '#9c9484'}
IRON = {'base': '#4e4a46', 'dark': '#2e2b28', 'light': '#6e6862', 'rust': '#6e4a32'}
IRON_RUSTED = {'base': '#6a4630', 'dark': '#3e2818', 'light': '#8a5e40', 'rust': '#8e5a34'}
CRATE = {'base': '#9a8462', 'dark': '#776444', 'light': '#ae9a74', 'worn': '#c0ae88', 'dust': '#aca08a'}
CRATE_STRIPS = {'base': '#5e4a34', 'dark': '#40321f', 'light': '#725c42', 'worn': '#8a7458'}
CRATE_DARK = {'base': '#4e4236', 'dark': '#342c24', 'light': '#5e5244', 'worn': '#7a6e5e', 'dust': '#6e665c'}
CRATE_DARK_STRIPS = {'base': '#2e2620', 'dark': '#1e1814', 'light': '#3c332a', 'worn': '#564a3e'}
STAVES = 16


def bands_rows(h):
    """The rows each barrel band covers, from its heights."""
    return [(int(round(h * (1 - top / BARREL_HEIGHT))), int(round(h * (1 - bottom / BARREL_HEIGHT))))
            for bottom, top in BARREL_BANDS]


def staves(h, w, wood, iron, weathered=False):
    """A barrel's side, unrolled: STAVES staves with the grain running up, each a shade apart,
    dark seams between, grime toward the foot, and the iron bands with rivets and rust. Weathered,
    the shades swing wider, patches are rubbed pale, one stave is split, and rust runs down
    from the bands."""
    out = np.zeros((h, w, 3), np.float32)
    sw = w // STAVES
    spread = (0.78, 1.1) if weathered else (0.9, 1.06)
    for i in range(STAVES):
        stave = np.transpose(grain(sw, h, wood, knots=int(weathered)), (1, 0, 2)) * RNG.uniform(*spread)
        out[:, i * sw:(i + 1) * sw] = stave
        out[:, i * sw] = hexc(wood['dark']) * 0.6
    grime = np.clip((np.arange(h) / h - 0.75) * 2.5, 0, 0.6)[:, None]
    out = mix(out, hexc(SHADOW), grime * np.ones((1, w)))
    if weathered:
        out = mix(out, hexc(wood['worn']), 0.5 * (blotches(h, w, 5) > 0.72))
        split = int(RNG.integers(2, STAVES - 2)) * sw + sw // 2
        y0 = int(RNG.integers(h // 5, h // 2))
        out[y0:y0 + int(RNG.integers(8, 16)), split] = hexc(SHADOW)
    for r0, r1 in bands_rows(h):
        band = mix(np.broadcast_to(hexc(iron['base']), (r1 - r0, w, 3)), hexc(iron['rust']),
                   blotches(r1 - r0, w, 3) > (0.35 if weathered else 0.7))
        band[0] = hexc(iron['light'])
        band[-1] = hexc(iron['dark'])
        band[(r1 - r0) // 2, 2::8] = hexc(iron['light'])
        out[r0:r1] = band
        if weathered:
            for x in RNG.choice(w, 10, replace=False):
                length = int(RNG.integers(2, 8))
                out[r1:r1 + length, x] = mix(out[r1:r1 + length, x], hexc(iron['rust']), 0.6)
    return out


def barrel_lid(h, w, wood, iron, weathered=False):
    """The barrel's head from above: three boards across, darker toward the rim, a bung hole
    with a dark plug; weathered, a crack along the grain and a stain (kept apart from the bung,
    or the three read as a face)."""
    out = np.zeros((h, w, 3), np.float32)
    edges = np.linspace(0, w, 4).round().astype(int)
    for x0, x1 in zip(edges, edges[1:]):
        out[:, x0:x1] = np.transpose(grain(x1 - x0, h, wood, knots=1), (1, 0, 2))
        out[:, x0] = hexc(wood['dark']) * 0.6
    x, y = np.arange(w)[None, :] + 0.5 - w / 2, np.arange(h)[:, None] + 0.5 - h / 2
    r = np.hypot(x, y) / (w / 2)
    out = mix(out, hexc(SHADOW), np.clip((r - 0.7) * 2, 0, 0.7))
    out[r > 0.95] = hexc(iron['dark'])
    bung = np.hypot(x - w * 0.18, y + h * 0.12) / (w / 2)
    out[bung < 0.16] = hexc(wood['light'])
    out[bung < 0.1] = hexc(SHADOW)
    out = mix(out, hexc(wood['worn']), 0.35 * (blotches(h, w, 4) > 0.7))
    if weathered:
        out[h // 5:3 * h // 5, int(w * 0.62)] = hexc(SHADOW)
        out = mix(out, hexc(SHADOW), 0.3 * (np.hypot(x + w * 0.05, y - h * 0.28) < w * 0.12))
    return out


def brace(out, pal, x0, y0, x1, y1, width):
    """A board nailed across a panel from (x0, y0) to (x1, y1), in texels: grain, a rubbed
    edge on one side and a shadow on the other, a nail at either end."""
    h, w = out.shape[:2]
    x, y = np.arange(w)[None, :] + 0.5, np.arange(h)[:, None] + 0.5
    dx, dy = x1 - x0, y1 - y0
    side = ((x - x0) * dy - (y - y0) * dx) / np.hypot(dx, dy)
    d = np.abs(side)
    board = grain(h, w, pal, knots=0)
    out[d < width / 2] = board[d < width / 2]
    edge = (d >= width / 2) & (d < width / 2 + 1)
    out[edge & (side < 0)] = hexc(pal['worn'])
    out[edge & (side > 0)] = hexc(SHADOW)
    for nx, ny in ((x0 + 0.12 * dx, y0 + 0.12 * dy), (x0 + 0.88 * dx, y0 + 0.88 * dy)):
        out[int(ny), int(nx)] = hexc('#8a8478')


def planked(h, w, pal, count, upright=False):
    """`count` planks with dark seams, running across, or up when `upright`."""
    if upright:
        return np.transpose(planked(w, h, pal, count), (1, 0, 2))
    out = np.zeros((h, w, 3), np.float32)
    edges = np.linspace(0, h, count + 1).round().astype(int)
    for y0, y1 in zip(edges, edges[1:]):
        out[y0:y1] = grain(y1 - y0, w, pal, knots=1) * RNG.uniform(0.92, 1.06)
        out[y0] = hexc(pal['dark']) * 0.6
    return out


def crate_panel(h, w, pal, strips, dark=False):
    """A crate side's panel: three planks across and one diagonal brace, dusty; dark, four
    planks up, a heavy cross brace, and stains."""
    out = planked(h, w, pal, 4 if dark else 3, upright=dark)
    out = mix(out, hexc(pal['dust']), 0.3 * (blotches(h, w, 5) > 0.6))
    brace(out, strips, 0, h, w, 0, 6)
    if dark:
        brace(out, strips, 0, 0, w, h, 6)
        out = mix(out, hexc(SHADOW), 0.25 * (blotches(h, w, 4) > 0.78))
    return out


def crate_lid(h, w, pal, strips, dark=False):
    """A crate's lid: planks across, rubbed pale; standard, a faded stencil mark; dark, two iron
    straps across with rivets."""
    out = planked(h, w, pal, 3)
    out = mix(out, hexc(pal['worn']), 0.35 * (blotches(h, w, 6) > 0.6))
    if dark:
        for y in (h // 4, 3 * h // 4 - 2):
            out[y:y + 3] = hexc('#3a3a36')
            out[y] = hexc('#5a5a54')
            out[y + 1, 2::6] = hexc('#7a7a72')
    else:
        m = w // 4
        mark = np.zeros((h, w), bool)
        mark[m, m:w - m] = mark[h - m - 1, m:w - m] = True
        mark[m:h - m, m] = mark[m:h - m, w - m - 1] = True
        for i in range(m + 2, w - m - 2):
            mark[i, i] = mark[i, w - 1 - i] = True
        faded = mark & (RNG.random((h, w)) < 0.7)
        out[faded] = mix(out, hexc(SHADOW), 0.45)[faded]
    return out


def frame(h, w, strips, dark=False):
    """A crate's frame strip: grain along it, rubbed edges, a nail every few texels."""
    out = worn(h, w, strips, 0.3)
    out[0] = hexc(strips['worn'])
    out[-1] = hexc(SHADOW)
    out[h // 2, 3::6] = hexc('#7a7468' if not dark else '#5a564e')
    return out


ATLASES = {
    'barrel_standard_atlas.png': ('barrel', {
        'stave': lambda h, w: staves(h, w, BARREL, IRON),
        'lid': lambda h, w: barrel_lid(h, w, BARREL, IRON),
        'rim': lambda h, w: worn(h, w, BARREL, 0.3),
    }),
    'barrel_weathered_atlas.png': ('barrel', {
        'stave': lambda h, w: staves(h, w, BARREL_OLD, IRON_RUSTED, weathered=True),
        'lid': lambda h, w: barrel_lid(h, w, BARREL_OLD, IRON_RUSTED, weathered=True),
        'rim': lambda h, w: worn(h, w, BARREL_OLD, 0.5),
    }),
    'crate_standard_atlas.png': ('crate', {
        'panel': lambda h, w: crate_panel(h, w, CRATE, CRATE_STRIPS),
        'lid': lambda h, w: crate_lid(h, w, CRATE, CRATE_STRIPS),
        'recess': lambda h, w: mix(grain(h, w, CRATE_STRIPS, knots=0), hexc(SHADOW), 0.5),
        'frame': lambda h, w: frame(h, w, CRATE_STRIPS),
    }),
    'crate_dark_atlas.png': ('crate', {
        'panel': lambda h, w: crate_panel(h, w, CRATE_DARK, CRATE_DARK_STRIPS, dark=True),
        'lid': lambda h, w: crate_lid(h, w, CRATE_DARK, CRATE_DARK_STRIPS, dark=True),
        'recess': lambda h, w: mix(grain(h, w, CRATE_DARK_STRIPS, knots=0), hexc(SHADOW), 0.5),
        'frame': lambda h, w: frame(h, w, CRATE_DARK_STRIPS, dark=True),
    }),
}

for filename, (shape, painters) in ATLASES.items():
    paint(CONTAINER_REGIONS[shape], CONTAINER_SIZE, painters).save(ART / filename)
    print('CONTAINERS atlas', ART / filename)
