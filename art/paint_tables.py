# Paints the table atlases into art/: dining_table_atlas.png, side_table_atlas.png,
# storage_table_atlas.png and tablecloth_atlas.png, which art/build_tables.py packs into the
# models. Developer-only: needs numpy and Pillow, and is re-run by hand after a change (then
# re-run the build):
#     python art/paint_tables.py
# The layout comes from furniture_layout.py; the grain, wear, drawer and panel painters are
# art/paint_furniture.py's, so the tables match the storage furniture. Each table has its own
# wood, grain and wear:
#   dining   deep warm red-brown planks run lengthwise, rubbed pale where plates went, cup
#            rings and a crack; near-black legs;
#   side     faded honey, fine straight grain, edges worn pale, dark walnut drawer and case;
#   storage  heavy grey-brown, broad planks run across the top, scuffed; tarnished brass pulls.
# The cloth is dusty burgundy with a dark hem and a faded cream line above it.
# Tops are kept lighter than the legs and bases, so each table stands off dark wooden floors.
import sys
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from furniture_layout import ATLAS_SIZE, CLOTH_REGIONS, CLOTH_SIZE, REGIONS  # noqa: E402
from paint_furniture import (  # noqa: E402
    RNG, SHADOW, blotches, door, drawer, grain, hexc, knob, mix, paint, worn,
)

ART = Path(__file__).resolve().parent

DINING = {'base': '#5e2a20', 'dark': '#3e1610', 'light': '#7a3a28', 'worn': '#965a40'}
DINING_LEGS = {'base': '#3a1c14', 'dark': '#26100a', 'light': '#4e281c', 'worn': '#6a3e2c'}
SIDE = {'base': '#a07a44', 'dark': '#7c5a32', 'light': '#b8925a', 'worn': '#cdb07e'}
SIDE_ACCENT = {'base': '#5a3e24', 'dark': '#3e2a18', 'light': '#6e4e30', 'worn': '#8a6a48'}
STORAGE = {'base': '#5c5249', 'dark': '#3e3832', 'light': '#706659', 'worn': '#8c8274'}
STORAGE_TRIM = {'base': '#3e3630', 'dark': '#2a2420', 'light': '#4e4640', 'worn': '#6a6058'}
TARNISHED = {'base': '#6e6242', 'dark': '#3c3626', 'light': '#9c8e64'}
PATINA = '#56604a'
CLOTH = {'base': '#6a2c34', 'dark': '#4c1e25', 'light': '#7e3c44', 'dust': '#86686a'}
HEM, HEM_LINE = '#3a161c', '#ad9e82'


def planks(h, w, pal, count, rubbed=0.3, rings=2, crack=True):
    """A tabletop of `count` planks running along u, each its own grain, with dark seams
    between them; pale rubbed patches, a pale rubbed rim, cup rings, and maybe a crack."""
    out = np.zeros((h, w, 3), np.float32)
    edges = np.linspace(0, h, count + 1).round().astype(int)
    for y0, y1 in zip(edges, edges[1:]):
        out[y0:y1] = grain(y1 - y0, w, pal, knots=1)
        out[y0] = mix(out[y0], hexc(pal['dark']) * 0.6, 0.85)
    out = mix(out, hexc(pal['worn']), rubbed * (blotches(h, w, 9) > 0.62))
    for rim in (out[0], out[-1], out[:, 0], out[:, -1]):
        rim[:] = mix(rim, hexc(pal['worn']), 0.6)
    x, y = np.arange(w)[None, :], np.arange(h)[:, None]
    for _ in range(rings):
        cx, cy, r = RNG.uniform(10, w - 10), RNG.uniform(5, h - 5), RNG.uniform(2.2, 3.2)
        ring = np.abs(np.hypot(x + 0.5 - cx, y + 0.5 - cy) - r) < 0.6
        out[ring] = mix(out[ring], hexc(SHADOW), 0.5)
    if crack:
        cy, x0 = RNG.integers(3, h - 3), RNG.integers(5, w // 2)
        for step in range(int(RNG.integers(14, 26))):
            out[cy, x0 + step] = hexc(SHADOW)
            cy = int(np.clip(cy + RNG.integers(-1, 2) * (RNG.random() < 0.25), 1, h - 2))
    return out


def apron(h, w, pal):
    """An apron board: grain, a groove near its foot with a pale lip, a dark bottom edge."""
    out = grain(h, w, pal, knots=0)
    out[h - 3] = hexc(SHADOW)
    out[h - 4] = hexc(pal['worn'])
    out[h - 1] = hexc(pal['dark'])
    return out


def pull_drawer(h, w, pal):
    """A drawer front with a tarnished backplate behind its bar pull (the pull is a model),
    a bolt at either end."""
    out = drawer(h, w, pal, keyhole=False)
    pw, ph = int(w * 0.32), max(4, h // 2)
    x0, y0 = (w - pw) // 2, (h - ph) // 2
    out[y0:y0 + ph, x0:x0 + pw] = mix(np.broadcast_to(hexc(TARNISHED['dark']), (ph, pw, 3)), hexc(PATINA),
                                      blotches(ph, pw, 2) > 0.6)
    out[y0 + ph // 2, x0 + 1] = hexc(TARNISHED['light'])
    out[y0 + ph // 2, x0 + pw - 2] = hexc(TARNISHED['light'])
    return out


def tarnished(h, w):
    """A bar pull's metal: a pale top edge, dull brass going green in patches, a dark foot."""
    out = mix(np.broadcast_to(hexc(TARNISHED['base']), (h, w, 3)), hexc(PATINA), blotches(h, w, 3) > 0.55)
    out[: max(1, h // 5)] = hexc(TARNISHED['light'])
    out[-max(1, h // 5):] = hexc(TARNISHED['dark'])
    return out


def cloth(h, w, hem=False):
    """Woven cloth: alternate rows a shade apart, dust in drifts; with `hem`, a dark hem along
    the bottom and a faded line above it."""
    out = np.broadcast_to(hexc(CLOTH['base']), (h, w, 3)).copy()
    out[::2] = hexc(CLOTH['light']) * 0.5 + out[::2] * 0.5
    out = mix(out, hexc(CLOTH['dark']), 0.6 * (blotches(h, w, 5) > 0.78))
    out = mix(out, hexc(CLOTH['dust']), 0.25 * (blotches(h, w, 8) > 0.68))
    if hem:
        out[h - 4:] = hexc(HEM)
        out[h - 6] = hexc(HEM_LINE)
    return out


ATLASES = {
    'dining_table_atlas.png': (REGIONS['dining_table_1x4'], ATLAS_SIZE, {
        'top': lambda h, w: planks(h, w, DINING, 4),
        'board': lambda h, w: grain(h, w, DINING, wave=1.0, period=40),
        'board_edge': lambda h, w: worn(h, w, DINING, 0.35),
        'apron': lambda h, w: apron(h, w, DINING),
        'leg_edge': lambda h, w: worn(h, w, DINING_LEGS, 0.25),
        'leg': lambda h, w: grain(h, w, DINING_LEGS, wave=0.6, period=50, knots=0),
    }),
    'side_table_atlas.png': (REGIONS['side_table_1x2'], ATLAS_SIZE, {
        'top': lambda h, w: mix(grain(h, w, SIDE, wave=0.5, period=60, knots=1), hexc(SIDE['worn']),
                                0.3 * (blotches(h, w, 10) > 0.6)),
        'top_edge': lambda h, w: worn(h, w, SIDE, 0.55),
        'board': lambda h, w: grain(h, w, SIDE, wave=0.5, period=60, knots=0),
        'board_edge': lambda h, w: worn(h, w, SIDE, 0.55),
        'accent_edge': lambda h, w: worn(h, w, SIDE_ACCENT, 0.3),
        'accent': lambda h, w: grain(h, w, SIDE_ACCENT, wave=1.0, period=30, knots=0),
        'drawer': lambda h, w: drawer(h, w, SIDE_ACCENT, keyhole=False),
        'brass': lambda h, w: knob(h, w, TARNISHED),
    }),
    'storage_table_atlas.png': (REGIONS['storage_table_2x4'], ATLAS_SIZE, {
        # Planks run across the table: painted along u, then turned to run along v.
        'top': lambda h, w: np.transpose(planks(w, h, STORAGE, 6, rubbed=0.25, rings=1, crack=False), (1, 0, 2)),
        'board': lambda h, w: grain(h, w, STORAGE, wave=1.2, period=30, knots=2),
        'board_edge': lambda h, w: worn(h, w, STORAGE, 0.3),
        'trim': lambda h, w: grain(h, w, STORAGE_TRIM, wave=1.2, period=30, knots=1),
        'trim_edge': lambda h, w: worn(h, w, STORAGE_TRIM, 0.3),
        'drawer': lambda h, w: pull_drawer(h, w, STORAGE),
        'end_panel': lambda h, w: door(h, w, STORAGE, hinges=False),
        'metal': lambda h, w: tarnished(h, w),
    }),
    'tablecloth_atlas.png': (CLOTH_REGIONS, CLOTH_SIZE, {
        'cloth': lambda h, w: cloth(h, w),
        'cloth_hang': lambda h, w: cloth(h, w, hem=True),
    }),
}

for filename, (regions, size, painters) in ATLASES.items():
    paint(regions, size, painters).save(ART / filename)
    print('TABLES atlas', ART / filename)
