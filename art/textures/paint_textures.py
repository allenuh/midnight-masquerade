# Paints every floor and wall texture the game uses into src/client/assets/textures/.
# Developer-only: needs numpy and Pillow, and is re-run by hand after a change:
#     python art/textures/paint_textures.py [preview.png]
# Every texture is original, painted here from simple shapes and periodic noise, modelled
# on the reference photos without using their pixels. Each one tiles exactly: noise is
# generated periodic, and every shape near an edge is also drawn wrapped to the far side.
# Shapes are drawn at SS times the final size and box-filtered down, so edges stay clean
# at the low resolutions the game wants (32 texels per 20-unit floor tile).
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / 'src' / 'client' / 'assets' / 'textures'
SS = 4
RNG = np.random.default_rng(7)


def hexc(value):
    return np.array([int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def noise(h, w, sigma):
    """Periodic gaussian-filtered noise, about unit standard deviation. `sigma` is in pixels."""
    white = RNG.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    smooth = np.real(np.fft.ifft2(np.fft.fft2(white) * np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))))
    return (smooth / (smooth.std() + 1e-9)).astype(np.float32)


def ridges(h, w, sigma, width):
    """Thin wandering lines (marble veins, cracks): where periodic noise crosses zero."""
    return np.clip(1 - np.abs(noise(h, w, sigma)) / width, 0, 1)


def mask(h, w, draw_fn, wrap=True):
    """A 0..1 coverage mask at full (supersampled) size; with `wrap`, shapes are drawn at
    every 3x3 offset so anything crossing an edge reappears on the opposite side."""
    image = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(image)
    offsets = [(dx, dy) for dx in (-w, 0, w) for dy in (-h, 0, h)] if wrap else [(0, 0)]
    for dx, dy in offsets:
        draw_fn(draw, dx, dy)
    return np.asarray(image, np.float32) / 255


def blend(img, m, colour):
    img[:] = img * (1 - m[..., None]) + np.asarray(colour, np.float32) * m[..., None]


def shade(img, amount):
    """Multiply brightness by (1 + amount), amount per pixel."""
    img[:] = img * (1 + amount)[..., None]


def down(img):
    h, w = img.shape[0] // SS, img.shape[1] // SS
    return img.reshape(h, SS, w, SS, 3).mean(axis=(1, 3))


def save(name, img):
    OUT.mkdir(parents=True, exist_ok=True)
    data = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(data, 'RGB').save(OUT / f'{name}.png', optimize=True)
    return data


def poly(points, dx, dy, scale):
    return [(x * scale + dx, y * scale + dy) for x, y in points]


# ------------------------------------------------------------------ floors (32 texels a tile)

def star_tile():
    """Cream crackled stone with a black eight-point compass star. Its diagonal points meet
    kites in the tile corners, so four tiles form a second, smaller star where they meet."""
    n = 32 * SS
    img = np.empty((n, n, 3), np.float32)
    img[:] = hexc('#d9d0bb')
    shade(img, 0.05 * noise(n, n, 10) + 0.025 * noise(n, n, 2))
    blend(img, 0.35 * ridges(n, n, 9, 0.05), hexc('#b9ad94'))  # fine crackle
    blend(img, 0.25 * np.clip(noise(n, n, 16), 0, 1), hexc('#c8b896'))  # yellowed patches

    light = np.array([-0.6, -0.8])  # facets facing up-left (toward the screen's top-left) are lit
    lit, dark = hexc('#4a4a4d'), hexc('#161617')

    def arm(angle, length, side, half_width, centre=(0.5, 0.5)):
        direction = np.array([np.cos(angle), np.sin(angle)])
        normal = np.array([-direction[1], direction[0]])
        c = np.array(centre)
        tip = c + direction * length
        base = c + direction * side
        facets = []
        for sign in (1, -1):
            edge = base + sign * normal * half_width
            facing = sign * normal
            facets.append(([tuple(c), tuple(edge), tuple(tip)], lit if facing @ light > 0 else dark))
        return facets

    facets = []
    for k in range(4):  # long points to the edge midpoints
        facets += arm(k * np.pi / 2, 0.5, 0.11, 0.085)
    for k in range(4):  # diagonal points
        facets += arm(np.pi / 4 + k * np.pi / 2, 0.30, 0.07, 0.055)
    for cx in (0, 1):  # corner kites pointing inward: a quarter of the neighbours' star each
        for cy in (0, 1):
            angle = np.arctan2(0.5 - cy, 0.5 - cx)
            for a in (angle, angle + np.pi):
                facets += arm(a, 0.20, 0.06, 0.045, centre=(cx, cy))
    for points, colour in facets:
        m = mask(n, n, lambda d, dx, dy: d.polygon(poly(points, dx, dy, n), fill=255))
        blend(img, m, colour)
    # Thin inlaid lines from each diagonal point out to the corner kite.
    for k in range(4):
        angle = np.pi / 4 + k * np.pi / 2
        a = np.array([0.5, 0.5]) + 0.30 * np.array([np.cos(angle), np.sin(angle)])
        b = np.array([0.5, 0.5]) + (0.707 - 0.20) * np.array([np.cos(angle), np.sin(angle)])
        m = mask(n, n, lambda d, dx, dy: d.line(poly([tuple(a), tuple(b)], dx, dy, n), fill=255, width=SS))
        blend(img, 0.45 * m, dark)
    # A worn grout edge: dark line on the tile border, chipped by noise.
    u = (np.arange(n) + 0.5) / n
    edge = np.minimum(np.minimum(u[None, :], 1 - u[None, :]), np.minimum(u[:, None], 1 - u[:, None]))
    grout = np.clip(1 - edge * n / (0.8 * SS) + 0.15 * noise(n, n, 3), 0, 1)
    blend(img, 0.85 * grout, hexc('#857663'))
    shade(img, -0.06 * np.clip(1 - edge * 8, 0, 1))  # grime toward the grout
    return down(img)


def marble_diamond():
    """White marble with a black marble diamond centred on each tile; 2 x 2 tiles."""
    n = 64 * SS
    t = n // 2
    img = np.empty((n, n, 3), np.float32)
    img[:] = hexc('#e2e1dc')
    shade(img, 0.025 * noise(n, n, 12))
    blend(img, 0.45 * ridges(n, n, 14, 0.05), hexc('#a9a8a6'))
    blend(img, 0.25 * ridges(n, n, 6, 0.04), hexc('#c2c1bd'))

    black = np.empty_like(img)
    black[:] = hexc('#26272a')
    shade(black, 0.12 * noise(n, n, 10))
    blend(black, 0.55 * ridges(n, n, 12, 0.035), hexc('#b8b8b6'))
    blend(black, 0.35 * ridges(n, n, 5, 0.03), hexc('#5d5e62'))

    def diamonds(d, dx, dy):
        for ty in range(2):
            for tx in range(2):
                cx, cy = tx * t + t / 2 + dx, ty * t + t / 2 + dy
                d.polygon([(cx, cy - t / 2), (cx + t / 2, cy), (cx, cy + t / 2), (cx - t / 2, cy)], fill=255)
    m = mask(n, n, diamonds)
    blend(img, m, 0)
    img += black * m[..., None]
    # Grout along every diamond edge: the lines x +/- y = constant through the tile corners.
    y, x = np.mgrid[0:n, 0:n] + 0.5
    for value in (x + y, x - y):
        distance = np.abs((value % t) - t / 2)  # diamond edges sit where (x +/- y) is a tile midpoint
        blend(img, np.clip(1 - np.abs(distance - t / 2) / (0.6 * SS), 0, 1) * 0.9, hexc('#8d8c88'))
    return down(img)


def terracotta():
    """One large fired-clay tile per game tile across a 2 x 2 repeat, each a slightly different colour."""
    n = 64 * SS
    s = 32 * SS
    img = np.empty((n, n, 3), np.float32)
    base = [['#a4553a', '#93492f'], ['#9a4c33', '#ad5e40']]  # a different clay on each, never a row of one
    for ty in range(2):
        for tx in range(2):
            img[ty * s:(ty + 1) * s, tx * s:(tx + 1) * s] = hexc(base[ty][tx])
    shade(img, 0.06 * noise(n, n, 8) + 0.04 * noise(n, n, 1.5))
    blend(img, 0.25 * np.clip(noise(n, n, 3) - 1.2, 0, 1), hexc('#5e2c1d'))  # dark speckles
    y, x = np.mgrid[0:n, 0:n] + 0.5
    edge = np.minimum(np.minimum(x % s, s - x % s), np.minimum(y % s, s - y % s)) / SS  # texels to the edge
    blend(img, np.clip(1.6 - edge, 0, 1) * np.clip(0.75 + 0.2 * noise(n, n, 3), 0, 1), hexc('#c39a7b'))  # pale worn rim
    blend(img, np.clip(1 - edge / 0.7, 0, 1), hexc('#5b3a2b'))  # grout
    return down(img)


def checker():
    """Four glazed ceramic squares on one game tile: dark mustard top left, off-white bottom
    right, near-black green in the other two, with dark grout and a lit bevel on each."""
    n = 32 * SS
    s = n // 2
    colours = {(0, 0): '#8f6d1c', (1, 1): '#d8d2c2', (1, 0): '#0e1f15', (0, 1): '#0e1f15'}  # (column, row)
    img = np.empty((n, n, 3), np.float32)
    for (cx, cy), colour in colours.items():
        img[cy * s:(cy + 1) * s, cx * s:(cx + 1) * s] = hexc(colour)
    shade(img, 0.05 * noise(n, n, 10) + 0.03 * noise(n, n, 2))
    white = np.zeros((n, n), np.float32)
    white[s:, s:] = 1
    blend(img, white * 0.4 * ridges(n, n, 8, 0.05), hexc('#a9a291'))  # crazed glaze on the white
    blend(img, white * 0.3 * np.clip(noise(n, n, 14), 0, 1), hexc('#c9bd9c'))  # yellowed with age
    y, x = np.mgrid[0:n, 0:n] + 0.5
    u, v = (x % s) / SS, (y % s) / SS  # texels into each square
    w = s / SS
    # Bevel: the up-left edges catch the light, the down-right edges fall into shadow.
    shade(img, 0.18 * np.clip(1.5 - np.minimum(u, v), 0, 1) - 0.22 * np.clip(1.5 - np.minimum(w - u, w - v), 0, 1))
    edge = np.minimum(np.minimum(u, w - u), np.minimum(v, w - v))
    blend(img, np.clip(1 - edge / 0.6, 0, 1), hexc('#2a2620'))  # grout
    return down(img)


def carpet(colour, dark, loop, mottle, fuzz):
    """Looped pile on a 2 x 2 tile repeat: soft round loops `loop` texels apart in offset rows."""
    return down(carpet_base(64 * SS, colour, dark, loop, mottle, fuzz))


# ------------------------------------------------------------------ walls (64 x 128, top = ceiling)

W, H = 64, 128
PAPER_END = 82  # rows above this are wallpaper; below, the wainscot (36% of the wall)


def wood(h, w, colour, grain_axis=0, streak=0.08):
    img = np.empty((h, w, 3), np.float32)
    img[:] = hexc(colour)
    stretch = noise(h, w * 8, 1.0 * SS)[:, ::8] if grain_axis == 0 else noise(h * 8, w, 1.0 * SS)[::8, :]
    shade(img, streak * stretch + 0.04 * noise(h, w, 4 * SS))
    return img


def damask_motif(d, cx, cy, u, v):
    """One mirrored damask ornament centred on (cx, cy); `u`, `v` are its half width and height."""
    def e(x0, y0, rx, ry):
        for sign in (1, -1) if x0 else (1,):
            d.ellipse([cx + sign * x0 * u - rx * u, cy + y0 * v - ry * v, cx + sign * x0 * u + rx * u, cy + y0 * v + ry * v], fill=255)

    def p(points):
        for sign in (1, -1):
            d.polygon([(cx + sign * x * u, cy + y * v) for x, y in points], fill=255)

    p([(0, -0.95), (0.16, -0.55), (0.0, -0.35)])           # top spire
    e(0, -0.25, 0.20, 0.16)                               # crown bud
    p([(0, -0.15), (0.34, 0.05), (0.12, 0.45), (0, 0.55)])  # central shield
    p([(0.12, -0.20), (0.62, -0.42), (0.80, -0.10), (0.45, 0.02)])  # upper leaves
    p([(0.20, 0.25), (0.75, 0.30), (0.88, 0.70), (0.30, 0.55)])     # lower leaves
    e(0.82, -0.62, 0.10, 0.07)                            # curl tips
    e(0.55, 0.88, 0.09, 0.06)
    p([(0, 0.50), (0.10, 0.95), (0, 1.0)])                # stem
    e(0.95, 0.15, 0.05, 0.04)                             # dots


CROWN = 5  # rows of crown moulding at the top of every wall texture
BASE = 7   # rows of baseboard at the bottom


def trim(img, wood_colour):
    """Crown moulding along the top and a baseboard along the bottom, shared by every wall
    texture (wallpapers and the door frame) so the trim runs on unbroken from one to the next."""
    w = img.shape[1]
    img[:CROWN * SS] = wood(CROWN * SS, w, wood_colour, grain_axis=1)
    img[0:SS] *= 0.55                       # where the moulding meets the ceiling line
    img[SS:2 * SS] *= 1.55                  # its lit lip
    img[3 * SS:4 * SS] *= 1.2
    img[(CROWN - 1) * SS:CROWN * SS] *= 0.5  # the shadow it casts on the paper
    shade(img, -0.30 * np.clip(1 - (np.arange(img.shape[0])[:, None] - CROWN * SS) / (3 * SS), 0, 1)
          * (np.arange(img.shape[0])[:, None] >= CROWN * SS) * np.ones((1, w)))
    base = (H - BASE) * SS
    img[base:] = wood(BASE * SS, w, '#2c180e', grain_axis=1)
    img[base:base + SS] = hexc('#7a5234')   # top bead
    img[base + SS:base + 2 * SS] *= 0.6
    img[-SS:] *= 0.5


def green_damask():
    w, h = W * SS, H * SS
    img = np.empty((h, w, 3), np.float32)
    paper_end = PAPER_END * SS
    img[:] = hexc('#3d4f35')
    shade(img, 0.05 * noise(h, w, 6 * SS))
    # Two columns of ornaments, the second dropped half a repeat (a half-drop pattern).
    cell_h = paper_end / 2
    def motifs(d, dx, dy):
        for column, drop in ((0, 0.0), (1, 0.5)):
            cx = (column + 0.5) * w / 2 + dx
            for k in range(-1, 3):
                damask_motif(d, cx, (k + 0.5 + drop) * cell_h + dy, w / 4 * 0.95, cell_h / 2 * 0.92)
                # A small four-petal rosette fills the gap beside each ornament.
                fx, fy, r = cx + w / 4, (k + drop) * cell_h + dy, w / 40
                for ox, oy in ((0, -2), (0, 2), (-2, 0), (2, 0)):
                    d.ellipse([fx + ox * r - r, fy + oy * r - r * 1.3, fx + ox * r + r, fy + oy * r + r * 1.3], fill=255)
    m = mask(h, w, motifs)
    m[paper_end:] = 0
    blend(img, m * np.clip(0.85 + 0.2 * noise(h, w, 3 * SS), 0, 1)[...], hexc('#8e8a5c'))
    # Faded streaks running down from the ceiling and a grimy band above the rail.
    shade(img, -0.10 * np.clip(noise(h, w * 6, 2 * SS)[:, ::6], 0, 1) * np.linspace(1, 0.3, h)[:, None])
    shade(img, -0.18 * np.clip((np.arange(h)[:, None] - (paper_end - 10 * SS)) / (10 * SS), 0, 1) * np.ones((1, w)))
    # Wainscot: chair rail, then beadboard with a groove every 8 texels, then a skirting board.
    rail = slice(paper_end, paper_end + 4 * SS)
    img[rail] = wood(4 * SS, w, '#4c2b1b')
    img[paper_end:paper_end + SS] = hexc('#7d5236')
    img[paper_end + 3 * SS:paper_end + 4 * SS] = hexc('#24130b')
    board_top, skirting = paper_end + 4 * SS, (H - BASE) * SS
    img[board_top:skirting] = wood(skirting - board_top, w, '#4a2a1b', streak=0.12)
    x = np.arange(w) / SS
    groove = (x % 8) < 1
    ridge = ((x % 8) >= 1) & ((x % 8) < 2)
    img[board_top:skirting, groove] *= 0.45
    img[board_top:skirting, ridge] *= 1.25
    trim(img, '#4c2b1b')
    shade(img, -0.25 * np.clip((np.arange(h)[:, None] - (H - 24) * SS) / (24 * SS), 0, 1) * np.ones((1, w)))
    return down(img)


def cream_floral():
    w, h = W * SS, H * SS
    img = np.empty((h, w, 3), np.float32)
    paper_end = PAPER_END * SS
    img[:] = hexc('#d4c9ab')
    shade(img, 0.03 * noise(h, w, 8 * SS))
    rng = np.random.default_rng(11)
    petals = Image.new('L', (w, h), 0)
    centres = Image.new('L', (w, h), 0)
    stems = Image.new('L', (w, h), 0)
    dp, dc, ds = ImageDraw.Draw(petals), ImageDraw.Draw(centres), ImageDraw.Draw(stems)
    # Peony clusters: rings of overlapping petal blobs, joined by thin branches.
    blooms = [(0.25, 0.20, 1.0), (0.75, 0.42, 0.8), (0.18, 0.72, 0.75), (0.62, 0.05, 0.55), (0.92, 0.85, 0.6),
              (0.48, 0.62, 0.5)]
    for bx, by, size in blooms:
        cx, cy, r = bx * w, by * paper_end, size * 9 * SS
        for dx in (-w, 0, w):
            for k in range(9):
                a = k / 9 * 2 * np.pi + rng.random() * 0.4
                px, py = cx + dx + np.cos(a) * r * 0.75, cy + np.sin(a) * r * 0.75
                pr = r * (0.45 + 0.15 * rng.random())
                dp.ellipse([px - pr, py - pr, px + pr, py + pr], fill=255)
            dc.ellipse([cx + dx - r * 0.35, cy - r * 0.35, cx + dx + r * 0.35, cy + r * 0.35], fill=255)
    for (ax, ay, _), (bx, by, _) in zip(blooms, blooms[1:] + blooms[:1]):
        start, end = np.array([ax * w, ay * paper_end]), np.array([bx * w, by * paper_end])
        if abs(end[0] - start[0]) > w / 2:
            end[0] += -w if end[0] > start[0] else w
        bend = np.array([-(end - start)[1], (end - start)[0]]) * 0.25
        points = [tuple(start + (end - start) * t + bend * np.sin(np.pi * t)) for t in np.linspace(0, 1, 24)]
        for dx in (-w, 0, w):
            ds.line([(x + dx, y) for x, y in points], fill=255, width=SS)
    blend(img, np.asarray(stems, np.float32) / 255 * 0.55, hexc('#b8ab8a'))
    blend(img, np.asarray(petals, np.float32) / 255 * np.clip(0.6 + 0.3 * noise(h, w, 2 * SS), 0, 1), hexc('#c0b393'))
    blend(img, np.asarray(centres, np.float32) / 255 * 0.7, hexc('#ad9f7f'))
    img[paper_end:] = hexc('#d4c9ab')
    shade(img, -0.10 * np.clip(noise(h, w, 10 * SS) - 0.8, 0, 1))  # water stains
    # Walnut wainscot: dentil rail, short upper panels, mid rail, tall lower panels, base.
    walnut = '#5a3925'
    rows = {'dentil': (PAPER_END, PAPER_END + 6), 'upper': (PAPER_END + 6, PAPER_END + 16),
            'mid': (PAPER_END + 16, PAPER_END + 19), 'lower': (PAPER_END + 19, H - BASE)}
    top, bottom = rows['dentil'][0] * SS, H * SS
    img[top:bottom] = wood(bottom - top, w, walnut, streak=0.10)
    a, b = rows['dentil']
    img[a * SS:(a + 1) * SS] = hexc('#8a5f40')
    dentils = ((np.arange(w) / SS) % 4) < 2
    img[(a + 2) * SS:(b - 1) * SS, dentils] *= 1.3
    img[(b - 1) * SS:b * SS] *= 0.55
    pilaster = 8  # texels wide, every 32 texels: two panels per repeat
    x = np.arange(w) / SS
    for name in ('upper', 'lower'):
        a, b = rows[name]
        inner = ((x % 32) >= pilaster + 2) & ((x % 32) < 32 - 2)
        sub = img[(a + 2) * SS:(b - 2) * SS]
        sub[:, inner] *= 1.12
        img[(a + 2) * SS:(a + 3) * SS, inner] *= 1.25   # lit top bevel
        img[(b - 3) * SS:(b - 2) * SS, inner] *= 0.6    # shadowed bottom bevel
        left = ((x % 32) >= pilaster + 2) & ((x % 32) < pilaster + 3)
        right = ((x % 32) >= 30) & ((x % 32) < 31)
        img[(a + 2) * SS:(b - 2) * SS, left] *= 1.2
        img[(a + 2) * SS:(b - 2) * SS, right] *= 0.65
    a, b = rows['mid']
    img[a * SS:(a + 1) * SS] *= 1.3
    img[(b - 1) * SS:b * SS] *= 0.6
    # Carved pilasters: a raised strip with a chain of beads down its middle.
    a, b = rows['upper'][0], rows['lower'][1]
    strip = (x % 32) < pilaster
    img[a * SS:b * SS, strip] *= 0.85
    beads = mask(h, w, lambda d, dx, dy: [
        d.ellipse([c * SS + dx - 2 * SS, r * SS + dy - 1.5 * SS, c * SS + dx + 2 * SS, r * SS + dy + 1.5 * SS], fill=255)
        for c in (pilaster / 2, 32 + pilaster / 2) for r in range(a + 3, b - 2, 4)])
    blend(img, beads * 0.8, hexc('#8c6243'))
    trim(img, walnut)
    shade(img, -0.25 * np.clip((np.arange(h)[:, None] - (H - 24) * SS) / (24 * SS), 0, 1) * np.ones((1, w)))
    return down(img)


def wall_top():
    """Dark stained planks along X, 8 texels wide, with staggered butt joints; 2 x 2 tiles."""
    n = 64 * SS
    img = wood(n, n, '#2c1c13', grain_axis=1, streak=0.14)
    plank = 8 * SS
    for k in range(n // plank):
        rows = slice(k * plank, (k + 1) * plank)
        img[rows] *= 0.88 + 0.24 * RNG.random()
        img[k * plank:k * plank + SS // 2] = hexc('#120a06')
        joint = int((k * 23 % 64) * SS)
        img[rows, joint:joint + SS // 2] = hexc('#120a06')
    return down(img)


def runner():
    """The field of the royal-green runner: wool with a lattice of small gold-green rosettes
    and diamonds; 2 x 2 tiles. Its border is not in here: the game draws it along the
    runner's edge, wherever that runs (see profile-runner)."""
    n = 64 * SS
    img = carpet_base(n, '#1d4a30', '#12301f', 1.5, 0.05, 0.45)
    cell = 16 * SS  # lattice repeat: 4 x 4 per texture

    def lattice(d, dx, dy):
        for gy in range(4):
            for gx in range(4):
                cx, cy = gx * cell + cell / 2 + dx, gy * cell + cell / 2 + dy
                r = cell * 0.13
                for ox, oy in ((0, -1), (0, 1), (-1, 0), (1, 0)):  # four-petal rosette
                    d.ellipse([cx + ox * r - r, cy + oy * r - r, cx + ox * r + r, cy + oy * r + r], fill=255)
                # A small diamond on each lattice corner, between four rosettes.
                qx, qy, q = gx * cell + dx, gy * cell + dy, cell * 0.12
                d.polygon([(qx, qy - q), (qx + q, qy), (qx, qy + q), (qx - q, qy)], fill=255)
    blend(img, mask(n, n, lattice) * 0.55, hexc('#6f7438'))
    # Thin darker lattice lines on the diagonals between the motifs.
    y, x = np.mgrid[0:n, 0:n] + 0.5
    for value in (x + y, x - y):
        line = np.abs(((value + cell / 2) % cell) - cell / 2)
        blend(img, np.clip(1 - line / (0.5 * SS), 0, 1) * 0.5, hexc('#0f2618'))
    return down(img)


def doorway():
    """The threshold rug a doorway is painted with: warm brown short pile woven with faint
    diamonds; 1 tile. Its darker edge band comes from profile-doorway."""
    n = 32 * SS
    img = carpet_base(n, '#6e4329', '#47291a', 1.5, 0.04, 0.5)
    y, x = np.mgrid[0:n, 0:n] / SS
    diamonds = np.abs(((x + y) % 8) - 4) + np.abs(((x - y) % 8) - 4)
    blend(img, np.clip(1 - np.abs(diamonds - 4) / 0.8, 0, 1) * 0.35, hexc('#8a5a37'))
    return down(img)


def door_frame():
    """Door jambs and casings: dark varnished wood with a moulding every 8 texels, and the same
    crown and baseboard as the wallpapers; 32 x 128, one tile wide."""
    w, h = 32 * SS, H * SS
    img = wood(h, w, '#3a2216', streak=0.14)
    x = np.arange(w) / SS
    img[:, (x % 8) < 1] *= 1.45   # lit bead
    img[:, ((x % 8) >= 1) & ((x % 8) < 2)] *= 0.55  # groove beside it
    img[:, ((x % 8) >= 6) & ((x % 8) < 7)] *= 0.8
    trim(img, '#4c2b1b')
    shade(img, -0.20 * np.clip((np.arange(h)[:, None] - (H - 24) * SS) / (24 * SS), 0, 1) * np.ones((1, w)))
    return down(img)


def profile(stops):
    """A 32 x 1 RGBA strip read across a border, from the region's edge (left) inward:
    `stops` is [(until, colour, alpha)]. Alpha 0 lets the field texture show."""
    strip = np.zeros((1, 32, 4), np.float32)
    t = (np.arange(32) + 0.5) / 32
    start = 0
    for until, colour, alpha in stops:
        m = (t >= start) & (t < until)
        strip[0, m, :3] = hexc(colour)
        strip[0, m, 3] = alpha
        start = until
    return strip


PROFILES = {
    # Runner (9 units): a dark margin, a broad gold band, a green gap, a thin gold line, then the field.
    'profile-runner': [(0.08, '#0d2416', 1), (0.42, '#b39046', 1), (0.62, '#163c27', 1), (0.74, '#9a7d3c', 1),
                       (1.01, '#000000', 0)],
    # Doorway rug (4 units): a dark fringe edge, a light woven line, a darker brown band.
    'profile-doorway': [(0.18, '#24140b', 1), (0.30, '#9a6a42', 1), (0.72, '#4a2a18', 1), (1.01, '#000000', 0)],
    # Wall caps (4 units): the crown moulding seen from above, a pale lip at the cap's edge, a
    # wood fillet, then a shadow line where it meets the cap.
    'profile-cap': [(0.16, '#d0b088', 1), (0.30, '#8a6040', 1), (0.55, '#5a3a26', 1), (0.70, '#140b06', 1),
                    (1.01, '#000000', 0)],
}


def carpet_base(n, colour, dark, loop, mottle, fuzz):
    """carpet() at full supersampled size, for textures that paint more on top of the pile."""
    img = np.empty((n, n, 3), np.float32)
    img[:] = hexc(colour)
    y, x = np.mgrid[0:n, 0:n] / SS
    row = np.floor(y / loop)
    loops = np.cos(np.pi * 2 * (x / loop + 0.5 * row)) * np.cos(np.pi * 2 * y / loop) + fuzz * noise(n, n, 0.8 * SS)
    blend(img, np.clip(-loops, 0, 1) * 0.65, hexc(dark))
    shade(img, 0.10 * np.clip(loops, 0, 1) + mottle * noise(n, n, 8 * SS))
    return img


def main():
    for name, stops in PROFILES.items():
        OUT.mkdir(parents=True, exist_ok=True)
        data = (np.clip(profile(stops), 0, 1) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(data, 'RGBA').save(OUT / f'{name}.png')
    textures = {
        'floor-star-tile': star_tile(),
        'floor-marble-diamond': marble_diamond(),
        'floor-terracotta': terracotta(),
        'floor-red-carpet': carpet('#982820', '#5e140f', 2, 0.07, 0.35),
        'floor-beige-carpet': carpet('#c3b190', '#97835f', 1.5, 0.05, 0.6),
        'floor-runner': runner(),
        'floor-doorway': doorway(),
        'floor-checker': checker(),
        'wall-green-damask': green_damask(),
        'wall-cream-floral': cream_floral(),
        'wall-door-frame': door_frame(),
        'wall-top-wood': wall_top(),
    }
    saved = {name: save(name, img) for name, img in textures.items()}
    if len(sys.argv) > 1:
        # Contact sheet: each texture tiled 3 x 3 (walls 3 x 1) and scaled 4x without smoothing,
        # so seams and the true texel size are both visible.
        tiles = []
        for name, data in saved.items():
            reps = (1, 3) if name.startswith('wall-') and name != 'wall-top-wood' else (3, 3)
            tiled = np.tile(data, (reps[0], reps[1], 1))
            tiles.append(Image.fromarray(tiled).resize((tiled.shape[1] * 4, tiled.shape[0] * 4), Image.NEAREST))
        width = sum(tile.width for tile in tiles) + 8 * (len(tiles) + 1)
        sheet = Image.new('RGB', (width, max(tile.height for tile in tiles) + 16), (24, 24, 24))
        x = 8
        for tile in tiles:
            sheet.paste(tile, (x, 8))
            x += tile.width + 8
        sheet.save(sys.argv[1])


if __name__ == '__main__':
    main()
