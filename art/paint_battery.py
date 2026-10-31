# Paints the battery pickup's atlas, art/battery_atlas.png, which art/build_battery.py packs
# into the model, and its glow mask, src/client/assets/battery_glow.png, which the game loads
# beside it: how strongly each texel glows (the label, the bolt, the +, the streaks and a glint
# on the nub). Developer-only: needs numpy and Pillow, and is re-run by hand after a change:
#     python art/paint_battery.py
# The design follows the concept sketch: a silver base and ribbed cap, an orange lower half, red
# and purple bands, a saturated blue upper half, two white highlight streaks, a bolt in an
# orange circle and a + in a red circle. The "JohnBattery" label and its "Super" subtitle run
# along the length, white with a black outline, reading from the base toward the cap.
# The game samples it with nearest filtering and lights it per vertex like a PlayStation-era
# model, so the look comes from flat fills roughened by a little texel noise: shapes are drawn
# supersampled and then thresholded (hard texel edges), and the noise is applied last.
# u (x) wraps the circumference; u = 0.5 faces the camera and u grows toward screen right.
# v runs up the profile; RING_V is what build_battery.py prints for its rings.
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / 'battery_atlas.png'
GLOW_OUT = Path(__file__).resolve().parents[1] / 'src' / 'client' / 'assets' / 'battery_glow.png'
# 128 texels round, and as many up the profile as keeps them square (build_battery.py prints
# the circumference/profile ratio, 1.257). The layout below was drawn at 256 texels round;
# K scales its sizes to W.
W, H = 128, 102
K = W / 256
SS = 8
RNG = np.random.default_rng(11)
# Arial Black, sheared into an italic (Windows ships no Arial Black Italic).
FONT = 'C:/Windows/Fonts/ariblk.ttf'
ITALIC_SHEAR = 0.22
# Texel brightness noise (standard deviation, as a share of the colour).
NOISE = 0.045

# v of the rings, bottom centre to top centre. The bottom face runs to ring 1; the body's side
# from ring 1 to ring 15, painted from ring 2 to ring 14 with a silver rim either side; its flat
# top face to ring 16; the nub's side to ring 17, and its top face to the centre.
RING_V = [0.0, 0.0588, 0.098, 0.1451, 0.1922, 0.2392, 0.2863, 0.3333, 0.3804, 0.4275, 0.4745,
          0.5216, 0.5686, 0.6157, 0.6627, 0.702, 0.8078, 0.8706, 1.0]
BODY_BOTTOM, BODY_TOP = RING_V[2], RING_V[14]

SILVER = '#c4c7cc'
SILVER_MID = '#9a9ea6'
SILVER_DARK = '#62656c'
SEAM = '#45474c'
ORANGE = '#e8661a'
RED = '#c81e26'
PURPLE = '#3a1cd0'
BLUE = '#0a34d8'
CIRCLE_ORANGE = '#f08a2a'
WHITE = '#f4f4f0'
STREAK_SHEEN = 0.35
BLACK = '#000000'
# Glow mask strengths (0..1): the white symbols and letters, the streaks, the nub's glint.
GLOW_FULL, GLOW_STREAK, GLOW_NUB = 1.0, 0.55, 0.25


def hexc(value):
    return np.array([int(value[i:i + 2], 16) for i in (1, 3, 5)], np.float32)


def row(v):
    """The texel row where v sits (row 0 is the top of the battery)."""
    return int(round((1 - v) * H))


def rows(v_low, v_high):
    """The rows from v_low up to v_high, at least one."""
    top = row(v_high)
    return slice(top, max(row(v_low), top + 1))


def col(u):
    return int(round(u * W))


def body_v(share):
    """v at `share` of the way up the straight body."""
    return BODY_BOTTOM + share * (BODY_TOP - BODY_BOTTOM)


def band(img, v_low, v_high, colour):
    img[rows(v_low, v_high)] = hexc(colour)


def down(image):
    """A hard 0/1 mask from a supersampled 'L' image: box-filtered down, thresholded."""
    coverage = np.asarray(image, np.float32).reshape(H, SS, W, SS).mean(axis=(1, 3)) / 255
    return coverage >= 0.5


def mask(draw_fn):
    image = Image.new('L', (W * SS, H * SS), 0)
    draw_fn(ImageDraw.Draw(image), SS)
    return down(image)


def fill(img, m, colour):
    img[m] = hexc(colour)


def grow(m):
    """The mask grown by one texel in every direction (8-neighbourhood)."""
    out = m.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out |= np.roll(np.roll(m, dy, axis=0), dx, axis=1)
    return out


def text_mask(text, u_centre, v_start, length, height):
    """`text` in the heavy font, sheared italic and squeezed to `length` x `height` texels, then
    turned a quarter to run up the battery: it starts at v_start and reads toward the cap, with
    the tops of its letters toward -u, centred on u_centre."""
    font = ImageFont.truetype(FONT, 200)
    left, top, right, bottom = font.getbbox(text)
    lean = int(ITALIC_SHEAR * (bottom - top))
    image = Image.new('L', (right - left + lean, bottom - top), 0)
    ImageDraw.Draw(image).text((-left, -top), text, font=font, fill=255)
    # Shift each row right by its height above the baseline.
    image = image.transform(image.size, Image.AFFINE, (1, ITALIC_SHEAR, -lean, 0, 1, 0), Image.BICUBIC)
    image = image.resize((length * SS, height * SS), Image.LANCZOS).transpose(Image.ROTATE_90)
    canvas = Image.new('L', (W * SS, H * SS), 0)
    canvas.paste(image, (round((u_centre * W - height / 2) * SS), (row(v_start) - length) * SS))
    return down(canvas)


def paint():
    """The atlas (H x W x 3) and the glow mask (H x W), both uint8."""
    img = np.zeros((H, W, 3), np.float32)
    glow = np.zeros((H, W), np.float32)

    # Base: a silver rim, the bottom face darker, with a dark line where it meets the orange.
    band(img, 0.0, BODY_BOTTOM, SILVER)
    band(img, 0.0, RING_V[1], SILVER_MID)
    # Body, bottom to top, with a dark printed line between each band.
    orange_top, red_top, purple_top = body_v(0.40), body_v(0.45), body_v(0.49)
    band(img, BODY_BOTTOM, orange_top, ORANGE)
    band(img, orange_top, red_top, RED)
    band(img, red_top, purple_top, PURPLE)
    band(img, purple_top, BODY_TOP, BLUE)
    for v in (orange_top, red_top, purple_top):
        img[row(v)] = img[row(v)] * 0.7
    img[row(BODY_BOTTOM)] = hexc(SILVER_DARK)
    # Top: a dark seam under the silver rim, rings round the body's flat top face, a dark ring
    # round the foot of the nub, a darker edge round the nub's top face, and a ring inset on it,
    # which glints.
    band(img, BODY_TOP, 1.0, SILVER)
    img[row(BODY_TOP) - 1] = hexc(SEAM)
    for rib in range(row(RING_V[16]), row(RING_V[15]), 2):
        img[rib] = hexc(SILVER_MID)
    band(img, RING_V[16], RING_V[16] + 0.02, SILVER_DARK)
    band(img, RING_V[17], RING_V[17] + 0.015, SILVER_MID)
    inset = rows(RING_V[17] + 0.03, RING_V[17] + 0.045)
    img[inset] = hexc(SILVER_DARK)
    glow[inset] = GLOW_NUB

    # Highlight streaks, left of the label, from the blue down into the orange: a wide one, then
    # a thin one. Only a sheen (STREAK_SHEEN of the way to white), so the label stays the
    # brightest thing on the body.
    def streaks(draw, s):
        def quad(u0, u1, v_top, v_bottom, slant):
            top, bottom = row(v_top) * s, row(v_bottom) * s
            draw.polygon([(u0 * W * s + slant, top), (u1 * W * s + slant, top),
                          (u1 * W * s, bottom), (u0 * W * s, bottom)], fill=255)
        quad(0.330, 0.350, body_v(0.85), body_v(0.15), 4 * K * s)
        quad(0.362, 0.372, body_v(0.78), body_v(0.25), 4 * K * s)
    streak = mask(streaks)
    img[streak] += (hexc(WHITE) - img[streak]) * STREAK_SHEEN
    glow[streak] = GLOW_STREAK

    # Label up the front: "JohnBattery", then "Super" beside it (below it, as the text reads)
    # ending where the title ends, both white with a black outline.
    title_u, title_height = 0.465, round(16 * K)
    title_start = body_v(0.07)
    title_length = row(title_start) - row(body_v(0.93))
    title = text_mask('JohnBattery', title_u, title_start, title_length, title_height)
    super_height, super_length = round(10 * K), round(34 * K)
    super_u = title_u + (title_height / 2 + 2 + super_height / 2) / W
    sup = text_mask('Super', super_u, body_v(0.93) - super_length / H, super_length, super_height)
    fill(img, grow(title) | grow(sup), BLACK)
    fill(img, title | sup, WHITE)
    glow[title | sup] = GLOW_FULL

    # Orange circle with a white bolt on the blue, red circle with a white + on the orange,
    # both right of the label.
    def circle(u, v, radius):
        def draw_fn(draw, s):
            x, y = u * W * s, (1 - v) * H * s
            draw.ellipse([x - radius * s, y - radius * s, x + radius * s, y + radius * s], fill=255)
        return mask(draw_fn)

    bolt_u, bolt_v = 0.625, body_v(0.62)
    fill(img, circle(bolt_u, bolt_v, 9 * K), CIRCLE_ORANGE)

    def bolt(draw, s):
        x, y = bolt_u * W * s, (1 - bolt_v) * H * s
        points = [(2, -8), (-5, 1.5), (-0.5, 1.5), (-2.5, 8.5), (5, -2), (0.5, -2), (3.5, -8)]
        draw.polygon([(x + px * K * s, y + py * K * s) for px, py in points], fill=255)
    fill(img, mask(bolt), WHITE)
    glow[mask(bolt)] = GLOW_FULL

    plus_u, plus_v = 0.625, body_v(0.2)
    fill(img, circle(plus_u, plus_v, 9 * K), RED)

    def plus(draw, s):
        x, y = plus_u * W * s, (1 - plus_v) * H * s
        arm, half = 6 * K * s, 1.5 * K * s
        draw.rectangle([x - arm, y - half, x + arm, y + half], fill=255)
        draw.rectangle([x - half, y - arm, x + half, y + arm], fill=255)
    fill(img, mask(plus), WHITE)
    glow[mask(plus)] = GLOW_FULL

    img *= 1 + NOISE * RNG.standard_normal((H, W, 1)).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8), np.round(glow * 255).astype(np.uint8)


if __name__ == '__main__':
    atlas, glow = paint()
    Image.fromarray(atlas).save(OUT)
    Image.fromarray(glow, 'L').save(GLOW_OUT)
    print('wrote', OUT, GLOW_OUT)
