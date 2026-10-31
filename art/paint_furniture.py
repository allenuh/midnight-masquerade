# Paints the furniture atlases into art/: bookshelf_atlas.png, dresser_atlas.png,
# cupboard_atlas.png and books_atlas.png, which art/build_furniture.py packs into the models.
# Developer-only: needs numpy and Pillow, and is re-run by hand after a change (then re-run
# the build):
#     python art/paint_furniture.py
# The layout comes from furniture_layout.py. Each piece has its own wood and its own wear:
#   bookshelf  reddish mahogany, edges rubbed pale, the tops grey with dust (neglected);
#   dresser    dark desaturated walnut with near-black trim and brass knobs, lightly worn;
#   cupboard   faded oak gone grey-green, iron knobs and hinges, worn and sun-bleached.
# Like the candles' atlas, the look is flat fills: grain is a few posterised bands of colour
# warped along the board, details are hard-edged texels, and a little texel noise goes on last.
# The tops (what the near-overhead game camera sees most) are kept lighter than the fronts, so
# every piece stands off dark wooden floors.
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from furniture_layout import ATLAS_SIZE, BOOK_DESIGNS, BOOK_REGIONS, BOOKS_SIZE, REGIONS  # noqa: E402

ART = Path(__file__).resolve().parent
RNG = np.random.default_rng(23)
NOISE = 0.045

# Wood palettes: the board's main colour, its dark and light grain, and the rubbed colour of
# its worn edges; `dust` greys the tops.
BOOKSHELF = {'base': '#6e3b2a', 'dark': '#4b2419', 'light': '#86503a', 'worn': '#a47454', 'dust': '#8d8075'}
BOOKSHELF_TRIM = {'base': '#572c20', 'dark': '#3a1a12', 'light': '#6e3b2a', 'worn': '#94664a'}
DRESSER = {'base': '#564538', 'dark': '#3a2e24', 'light': '#6a5645', 'worn': '#7e6a56', 'dust': '#7c7064'}
DRESSER_TRIM = {'base': '#2c221b', 'dark': '#1e1712', 'light': '#3a2e25', 'worn': '#4e3f33'}
CUPBOARD = {'base': '#6f6550', 'dark': '#4f4a3a', 'light': '#857c62', 'worn': '#a09a80', 'dust': '#8e8a7c'}
CUPBOARD_TRIM = {'base': '#524c3c', 'dark': '#3a372c', 'light': '#645e4b', 'worn': '#827c66'}
BRASS = {'base': '#8c7442', 'dark': '#4e3f22', 'light': '#c4a865'}
IRON = {'base': '#4a4a43', 'dark': '#26261f', 'light': '#73736a'}
SHADOW = '#140d09'
# Muted cloth and leather for the book spines, one per design, and the gilt of their bands.
SPINES = ['#5a2424', '#2e4a36', '#2a3550', '#7e6230', '#4a2e48', '#4a5a64', '#5a4030', '#24302a']
GILT, PAGES, PAGE_LINE = '#9a8648', '#cbbf9c', '#a89c7c'


def hexc(value):
    return np.array([int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def smooth(n, cell):
    """1D noise, 0..1, varying over about `cell` samples."""
    points = RNG.random(n // cell + 2)
    return np.interp(np.arange(n) / cell, np.arange(len(points)), points)


def blotches(h, w, cell):
    gh, gw = h // cell + 2, w // cell + 2
    small = Image.fromarray((RNG.random((gh, gw)) * 255).astype(np.uint8))
    return np.asarray(small.resize((gw * cell, gh * cell), Image.BILINEAR), np.float32)[:h, :w] / 255


def mix(a, b, t):
    return a + (b - a) * np.asarray(t, np.float32)[..., None]


def grain(h, w, pal, wave=1.2, period=34, knots=1):
    """Boards with the grain along u: wavy bands posterised to the palette's three colours,
    and a few dark knots."""
    x = np.arange(w)[None, :]
    y = np.arange(h)[:, None]
    warp = (wave * np.sin(2 * np.pi * x / period + RNG.uniform(0, 6)) + 3.0 * smooth(w, 13)[None, :]
            + 1.2 * (blotches(h, w, 8) - 0.5))
    bands = smooth(h * 4 + 40, 3)
    value = bands[np.clip(((y + warp) * 4).astype(int) + 20, 0, len(bands) - 1)]
    value = value + 0.25 * (blotches(h, w, 6) - 0.5)
    out = np.where((value < 0.32)[..., None], hexc(pal['dark']),
                   np.where((value > 0.72)[..., None], hexc(pal['light']), hexc(pal['base'])))
    for _ in range(knots):
        cx, cy = RNG.uniform(4, w - 4), RNG.uniform(2, h - 2)
        r = np.hypot((x - cx) / 2.2, y - cy)
        out[(r > 0.6) & (r < 1.4)] = hexc(pal['dark'])
    return out


def worn(h, w, pal, chips=0.35):
    """An exposed board edge: grain, rubbed pale in short streaks along it (squeezed onto a
    thin face, round blotches would read as lettering)."""
    out = grain(h, w, pal, knots=0)
    dashes = np.repeat(RNG.random((h, w // 5 + 1)) < chips * 0.6, 5, axis=1)[:, :w]
    rub = dashes | (RNG.random((h, w)) < chips / 4)
    out[rub] = hexc(pal['worn'])
    return out


def top(h, w, pal, dust):
    """A top surface: grain, greyed by `dust` in drifts, with a rubbed pale front edge."""
    out = mix(grain(h, w, pal, knots=2), hexc(pal['dust']), dust * (0.6 + 0.6 * blotches(h, w, 7)))
    out[-1] = mix(out[-1], hexc(pal['worn']), 0.7)
    return out


def shadowed(h, w, pal, shade=0.45):
    """The inside of a compartment: dark grain, stepping darker toward the shelf above."""
    out = mix(grain(h, w, pal, knots=0), hexc(SHADOW), shade)
    steps = np.minimum(np.arange(h) // max(h // 5, 1), 3)
    for step, amount in enumerate((0.6, 0.35, 0.15)):
        out[steps == step] = mix(out[steps == step], hexc(SHADOW), amount)
    return out


def bevel(out, x0, y0, x1, y1, light, dark):
    """A one-texel bevel round a rectangle: light along its top and left, dark bottom and right."""
    out[y0, x0:x1] = light
    out[y0:y1, x0] = light
    out[y1 - 1, x0:x1] = dark
    out[y0:y1, x1 - 1] = dark


def drawer(h, w, pal, keyhole=True):
    """A drawer front: a board with a bevelled lip and an inset line, and a small escutcheon."""
    out = grain(h, w, pal, knots=1)
    bevel(out, 0, 0, w, h, hexc(pal['worn']), hexc(pal['dark']) * 0.7)
    bevel(out, 2, 2, w - 2, h - 2, hexc(pal['dark']), hexc(pal['light']))
    if keyhole:
        cx, cy = w // 2, h // 2
        out[cy - 2:cy + 2, cx - 1:cx + 2] = hexc(BRASS['dark'])
        out[cy - 1:cy + 1, cx] = hexc(SHADOW)
    return out


def door(h, w, pal, hinges=True):
    """A frame-and-panel door: stiles and rails round a raised panel, bevelled light at the top
    left and dark at the bottom right, two iron hinge straps on its left edge."""
    out = np.transpose(grain(w, h, pal, knots=0), (1, 0, 2))  # stiles: grain runs up
    m = max(3, w // 6)
    rail = grain(m, w, pal, knots=0)
    out[:m], out[h - m:] = rail, rail[::-1]
    panel = grain(h - 2 * m - 2, w - 2 * m - 2, pal, knots=1)
    out[m + 1:h - m - 1, m + 1:w - m - 1] = mix(panel, hexc(pal['light']), 0.08)
    bevel(out, m, m, w - m, h - m, hexc(pal['dark']), hexc(pal['light']))
    bevel(out, m + 1, m + 1, w - m - 1, h - m - 1, hexc(pal['light']), hexc(pal['dark']))
    bevel(out, 0, 0, w, h, hexc(pal['worn']), hexc(pal['dark']) * 0.7)
    if hinges:
        for y in (m - 1, h - m - 2):
            out[y:y + 3, 0:3] = hexc(IRON['base'])
            out[y + 2, 0:3] = hexc(IRON['dark'])
            out[y + 1, 1] = hexc(IRON['light'])
    return out


def knob(h, w, pal):
    """A knob seen from the front: a dome in four flat steps, lit from the top left."""
    r = np.hypot(np.arange(w)[None, :] + 0.5 - w * 0.38, np.arange(h)[:, None] + 0.5 - h * 0.38) / (w * 0.75)
    out = np.where((r < 0.18)[..., None], hexc(pal['light']),
                   np.where((r < 0.5)[..., None], hexc(pal['base']), hexc(pal['dark'])))
    return mix(out, hexc(pal['light']), (r > 0.3) & (r < 0.36))


def pilaster(h, w, pal):
    """A pilaster face: grain running up, two flutes (dark grooves with a pale lip)."""
    out = np.transpose(worn(w, h, pal, 0.2), (1, 0, 2))
    for x in (w // 3, 2 * w // 3):
        out[2:-2, x] = hexc(SHADOW)
        out[2:-2, x + 1] = hexc(pal['worn'])
    return out


def capital(h, w, pal):
    out = worn(h, w, pal, 0.3)
    out[h // 2 - 1:h // 2 + 1] = hexc(pal['dark'])
    out[0] = hexc(pal['worn'])
    return out


def carved(h, w, pal):
    """A carved board (the valance): two grooves along it and a lozenge at the
    middle, each groove with a pale upper lip."""
    out = worn(h, w, pal, 0.2)
    for y in (h // 4, 3 * h // 4):
        out[y] = hexc(SHADOW)
        out[y - 1] = hexc(pal['worn'])
    cx, cy = w // 2, h // 2
    d = np.abs(np.arange(w)[None, :] - cx) / 2 + np.abs(np.arange(h)[:, None] - cy)
    out[d < h / 4] = hexc(pal['dark'])
    out[(d >= h / 4) & (d < h / 4 + 1)] = hexc(pal['worn'])
    return out


def crest(h, w, pal):
    """A crest's front: one groove along its foot with a pale lip, and a diamond outline carved
    at its middle."""
    out = worn(h, w, pal, 0.2)
    y = h - max(2, h // 5)
    out[y] = hexc(SHADOW)
    out[y - 1] = hexc(pal['worn'])
    d = np.abs(np.arange(w)[None, :] - w / 2) / 3 + np.abs(np.arange(h)[:, None] - h * 0.45)
    out[(d > h * 0.18) & (d < h * 0.18 + 1)] = hexc(SHADOW)
    return out


def carcass_front(h, w, pal, apron):
    """The carcass front behind the drawers (seen in the gaps): dark grain, and along the
    bottom `apron` share of it a scalloped skirt, cut away into shadow below the scallops."""
    out = mix(grain(h, w, pal, knots=0), hexc(SHADOW), 0.25)
    top_row = int(h * (1 - apron))
    x = np.arange(w)
    edge = h - 1 - (h - top_row) * 0.45 * np.abs(np.cos(np.pi * (x - w / 2) / (w / 3)))
    cut = np.arange(h)[:, None] > edge[None, :]
    out[top_row] = hexc(pal['worn'])
    out[cut] = hexc(SHADOW)
    return out


def niche(h, w, pal):
    """The back of the cupboard's open niche: shadowed boards, with two plates standing on edge
    and a squat jar between them."""
    out = shadowed(h, w, pal, 0.5)
    x, y = np.arange(w)[None, :], np.arange(h)[:, None]
    for cx in (w * 0.25, w * 0.75):
        r = np.hypot(x + 0.5 - cx, y + 0.5 - h * 0.55) / (h * 0.4)
        out[r < 1] = hexc('#a7a796')
        out[(r < 0.8) & (r > 0.62)] = hexc('#5c6a78')
        out[r < 0.45] = hexc('#bdbba8')
    jar = (np.abs(x + 0.5 - w / 2) < w * 0.09) & (y > h * 0.45)
    out[jar] = hexc('#3e5244')
    out[jar & (y < h * 0.55)] = hexc('#6a7a62')
    return out


def spine(h, w, colour):
    """A book spine: cloth with gilt bands at head and foot, and a title block in some."""
    base = hexc(colour)
    out = np.broadcast_to(base, (h, w, 3)).copy()
    out[:, 0] = base * 0.7
    out[:, -1] = base * 0.7
    for y in (3, 5, h - 6, h - 4):
        out[y, 1:-1] = hexc(GILT) * RNG.uniform(0.7, 1.0)
    if RNG.random() < 0.6:
        y0 = int(RNG.integers(10, 18))
        out[y0:y0 + 6, 2:-2] = mix(np.broadcast_to(base, (6, w - 4, 3)), hexc(GILT), 0.45)
    return out


def paint(regions, size, painters):
    atlas = np.zeros((size, size, 3), np.float32)
    atlas[:] = hexc(SHADOW)
    for name, painter in painters.items():
        x, y, w, h, _ = regions[name]
        atlas[y:y + h, x:x + w] = painter(h, w)
    assert set(painters) == set(regions), set(regions) ^ set(painters)
    atlas *= 1 + NOISE * RNG.standard_normal((size, size, 1)).astype(np.float32)
    return Image.fromarray((np.clip(atlas, 0, 1) * 255).round().astype(np.uint8))


ATLASES = {
    'bookshelf_atlas.png': (REGIONS['bookshelf_1x2'], ATLAS_SIZE, {
        'board': lambda h, w: grain(h, w, BOOKSHELF),
        'board_edge': lambda h, w: worn(h, w, BOOKSHELF, 0.35),
        'top': lambda h, w: top(h, w, BOOKSHELF, 0.45),
        'compartment': lambda h, w: shadowed(h, w, BOOKSHELF),
        'compartment_side': lambda h, w: shadowed(h, w, BOOKSHELF),
        'pilaster': lambda h, w: pilaster(h, w, BOOKSHELF_TRIM),
        'capital': lambda h, w: capital(h, w, BOOKSHELF_TRIM),
        'trim': lambda h, w: grain(h, w, BOOKSHELF_TRIM),
        'crest': lambda h, w: crest(h, w, BOOKSHELF_TRIM),
        'valance': lambda h, w: carved(h, w, BOOKSHELF_TRIM),
        'trim_edge': lambda h, w: worn(h, w, BOOKSHELF_TRIM, 0.35),
    }),
    'dresser_atlas.png': (REGIONS['dresser_1x2'], ATLAS_SIZE, {
        'board': lambda h, w: grain(h, w, DRESSER, wave=1.5, period=40),
        'board_edge': lambda h, w: worn(h, w, DRESSER, 0.2),
        'top': lambda h, w: top(h, w, DRESSER, 0.3),
        'trim': lambda h, w: grain(h, w, DRESSER_TRIM, wave=1.5, period=40, knots=0),
        'trim_edge': lambda h, w: worn(h, w, DRESSER_TRIM, 0.2),
        'drawer_small': lambda h, w: drawer(h, w, DRESSER, keyhole=False),
        'drawer_wide': lambda h, w: drawer(h, w, DRESSER),
        'carcass_front': lambda h, w: carcass_front(h, w, DRESSER_TRIM, 0.19),
        'brass': lambda h, w: knob(h, w, BRASS),
    }),
    'cupboard_atlas.png': (REGIONS['cupboard_1x3'], ATLAS_SIZE, {
        'board': lambda h, w: grain(h, w, CUPBOARD, wave=2.0, period=22, knots=2),
        'board_edge': lambda h, w: worn(h, w, CUPBOARD, 0.4),
        'top': lambda h, w: top(h, w, CUPBOARD, 0.3),
        'trim': lambda h, w: grain(h, w, CUPBOARD_TRIM, wave=2.0, period=22),
        'trim_edge': lambda h, w: worn(h, w, CUPBOARD_TRIM, 0.4),
        'door_lower': lambda h, w: door(h, w, CUPBOARD),
        'door_upper': lambda h, w: door(h, w, CUPBOARD),
        'drawer': lambda h, w: drawer(h, w, CUPBOARD, keyhole=False),
        'niche': lambda h, w: niche(h, w, CUPBOARD_TRIM),
        'niche_side': lambda h, w: shadowed(h, w, CUPBOARD_TRIM, 0.2),
        'iron': lambda h, w: knob(h, w, IRON),
        'carcass_front': lambda h, w: mix(grain(h, w, CUPBOARD_TRIM), hexc(SHADOW), 0.3),
        'crest': lambda h, w: crest(h, w, CUPBOARD_TRIM),
    }),
    'books_atlas.png': (BOOK_REGIONS, BOOKS_SIZE, {
        **{f'spine_{i}': (lambda c: lambda h, w: spine(h, w, c))(SPINES[i]) for i in range(BOOK_DESIGNS)},
        'pages': lambda h, w: np.where((np.arange(h) % 2 == 0)[:, None, None], hexc(PAGES), hexc(PAGE_LINE))
        * np.ones((1, w, 1), np.float32),
        **{f'cover_{i}': (lambda c: lambda h, w: np.broadcast_to(hexc(c), (h, w, 3)).copy())(SPINES[i])
           for i in range(BOOK_DESIGNS)},
    }),
}

# Run, not imported (art/paint_tables.py borrows the painters above).
if __name__ == '__main__':
    for filename, (regions, size, painters) in ATLASES.items():
        paint(regions, size, painters).save(ART / filename)
        print('FURNITURE atlas', ART / filename)
