# Paints the seating atlases into art/: chair_atlas.png and stool_atlas.png, which
# art/build_seating.py packs into the models. Developer-only: needs numpy and Pillow, and is
# re-run by hand after a change (then re-run the build):
#     python art/paint_seating.py
# The layout comes from furniture_layout.py and the painters are art/paint_furniture.py's, so
# the seating matches the rest of the furniture:
#   chair  warm chestnut, its seat rubbed pale in the middle and chipped round the rim, darker
#          legs, a carved crest rail;
#   stool  weathered grey-brown, uneven, with warmer blotches where the grey has worn through,
#          its round seat rubbed pale and split by a crack.
# Seats (the near-overhead game camera sees them most) are kept lighter than the legs, so
# both pieces stand off dark wooden floors and the darker furniture beside them.
import sys
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from furniture_layout import SEATING_REGIONS, SEATING_SIZE  # noqa: E402
from paint_furniture import RNG, SHADOW, blotches, crest, grain, hexc, mix, paint, worn  # noqa: E402

ART = Path(__file__).resolve().parent

CHAIR = {'base': '#704a2c', 'dark': '#4e3018', 'light': '#8a5e3a', 'worn': '#a8805a'}
CHAIR_LEGS = {'base': '#4c2e1c', 'dark': '#341e10', 'light': '#603c26', 'worn': '#7c5840'}
STOOL = {'base': '#7a7062', 'dark': '#5a5246', 'light': '#908676', 'worn': '#ada392'}
STOOL_WARM = '#7c6650'


def seat(h, w, pal, round_=False, warm=None):
    """A seat from above: grain, rubbed pale toward the middle where people sat, chips of
    rubbed wood round the rim (the inscribed circle, for a round seat), and with `warm` uneven
    warmer patches; a round seat is split by a crack along the grain."""
    out = grain(h, w, pal, knots=1)
    if warm:
        out = mix(out, hexc(warm), 0.5 * (blotches(h, w, 5) > 0.6))
    x, y = np.arange(w)[None, :] + 0.5 - w / 2, np.arange(h)[:, None] + 0.5 - h / 2
    r = np.hypot(x / (w / 2), y / (h / 2))
    out = mix(out, hexc(pal['worn']), 0.45 * np.clip(1.1 - 1.6 * r, 0, 1) ** 0.5 * (RNG.random((h, w)) > 0.25))
    rim = (r > 0.86) & (r < 1.0) if round_ else (np.maximum(np.abs(x) / (w / 2), np.abs(y) / (h / 2)) > 0.88)
    out[rim & (RNG.random((h, w)) < 0.4)] = hexc(pal['worn'])
    if round_:
        cy = int(h * 0.35)
        for step in range(int(w * 0.25), int(w * 0.6)):
            out[cy, step] = hexc(SHADOW)
            cy = int(np.clip(cy + (RNG.random() < 0.2) * RNG.integers(-1, 2), 1, h - 2))
    return out


ATLASES = {
    'chair_atlas.png': (SEATING_REGIONS['chair_1x1'], SEATING_SIZE, {
        'seat': lambda h, w: seat(h, w, CHAIR),
        'board': lambda h, w: grain(h, w, CHAIR, wave=0.8, period=30),
        'board_edge': lambda h, w: worn(h, w, CHAIR, 0.35),
        'rail': lambda h, w: crest(h, w, CHAIR),
        'slat': lambda h, w: worn(h, w, CHAIR, 0.12),
        'leg': lambda h, w: worn(h, w, CHAIR_LEGS, 0.1),
    }),
    'stool_atlas.png': (SEATING_REGIONS['stool_1x1'], SEATING_SIZE, {
        'seat': lambda h, w: seat(h, w, STOOL, round_=True, warm=STOOL_WARM),
        'board': lambda h, w: mix(grain(h, w, STOOL, wave=2.0, period=14), hexc(STOOL_WARM), 0.5 * (blotches(h, w, 4) > 0.6)),
        'board_edge': lambda h, w: worn(h, w, STOOL, 0.45),
        'leg': lambda h, w: mix(worn(h, w, STOOL, 0.15), hexc(STOOL_WARM), 0.45 * (blotches(h, w, 6) > 0.62)),
    }),
}

for filename, (regions, size, painters) in ATLASES.items():
    paint(regions, size, painters).save(ART / filename)
    print('SEATING atlas', ART / filename)
