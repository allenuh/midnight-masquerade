# Shared by art/paint_furniture.py and art/build_furniture.py: where everything sits in the
# furniture atlases. Plain data, no bpy, numpy or Pillow.
# Each piece has its own 128 x 128 atlas (its own wood, so no two share a brown) and the books
# a 64 x 64 one. Regions are (x, y, width, height, mode) in texels, y down from the top of the
# image. A 'wood' region is grain running along u: a board's faces are wrapped into it with
# their long side along the grain, at TEXELS_PER_UNIT or squeezed to fit. A face thinner than
# EDGE_WIDTH whose region has an '_edge' twin uses the twin instead, which is painted worn, so
# every exposed board edge reads as rubbed. A 'picture' region is one whole face, stretched
# onto it (a drawer front, a door, a carved crest), u left to right and v bottom to top.

ATLAS_SIZE = 128
BOOKS_SIZE = 64
TEXELS_PER_UNIT = 1.6
EDGE_WIDTH = 2.5

REGIONS = {
    'bookshelf_1x2': {
        'board': (0, 0, 64, 32, 'wood'),
        'board_edge': (64, 0, 64, 8, 'wood'),
        'top': (64, 8, 64, 24, 'wood'),
        'compartment': (16, 32, 48, 20, 'picture'),
        'compartment_side': (64, 32, 24, 20, 'picture'),
        'pilaster': (88, 32, 12, 64, 'picture'),
        'capital': (100, 32, 16, 12, 'picture'),
        'trim': (0, 52, 64, 16, 'wood'),
        'crest': (0, 68, 64, 20, 'picture'),
        'valance': (0, 88, 64, 12, 'picture'),
        'trim_edge': (0, 100, 64, 8, 'wood'),
    },
    'dresser_1x2': {
        'board': (0, 0, 64, 32, 'wood'),
        'board_edge': (64, 0, 64, 8, 'wood'),
        'top': (64, 8, 64, 24, 'wood'),
        'trim': (0, 32, 64, 16, 'wood'),
        'trim_edge': (64, 32, 64, 8, 'wood'),
        'drawer_small': (0, 48, 40, 12, 'picture'),
        'drawer_wide': (40, 48, 72, 14, 'picture'),
        'carcass_front': (0, 62, 64, 40, 'picture'),
        'brass': (64, 62, 16, 16, 'picture'),
    },
    'cupboard_1x3': {
        'board': (0, 0, 64, 32, 'wood'),
        'board_edge': (64, 0, 64, 8, 'wood'),
        'top': (64, 8, 64, 24, 'wood'),
        'trim': (0, 32, 64, 16, 'wood'),
        'trim_edge': (64, 32, 64, 8, 'wood'),
        'door_lower': (0, 48, 24, 20, 'picture'),
        'door_upper': (24, 48, 22, 26, 'picture'),
        'drawer': (46, 48, 36, 8, 'picture'),
        'niche': (82, 48, 40, 20, 'picture'),
        'niche_side': (46, 56, 16, 16, 'picture'),
        'iron': (62, 56, 16, 16, 'picture'),
        'carcass_front': (0, 76, 64, 24, 'picture'),
        'crest': (64, 76, 64, 8, 'picture'),
    },
    # The tables (art/paint_tables.py, art/build_tables.py). A 'top' picture is the whole
    # tabletop, planks and all.
    'dining_table_1x4': {
        'top': (0, 0, 128, 32, 'picture'),
        'board': (0, 32, 64, 32, 'wood'),
        'board_edge': (64, 32, 64, 8, 'wood'),
        'apron': (64, 40, 64, 12, 'picture'),
        'leg_edge': (64, 52, 64, 8, 'wood'),
        'leg': (0, 64, 64, 32, 'wood'),
    },
    'side_table_1x2': {
        'top': (0, 0, 64, 32, 'wood'),
        'top_edge': (64, 0, 64, 8, 'wood'),
        'board': (64, 8, 64, 24, 'wood'),
        'board_edge': (0, 32, 64, 8, 'wood'),
        'accent_edge': (64, 32, 64, 8, 'wood'),
        'accent': (0, 40, 64, 16, 'wood'),
        'drawer': (64, 40, 32, 12, 'picture'),
        'brass': (96, 40, 16, 16, 'picture'),
    },
    'storage_table_2x4': {
        'top': (0, 0, 128, 64, 'picture'),
        'board': (0, 64, 64, 32, 'wood'),
        'board_edge': (64, 64, 64, 8, 'wood'),
        'trim': (64, 72, 64, 16, 'wood'),
        'trim_edge': (64, 88, 64, 8, 'wood'),
        'drawer': (0, 96, 48, 16, 'picture'),
        'end_panel': (48, 96, 40, 24, 'picture'),
        'metal': (88, 96, 16, 16, 'picture'),
    },
}

# The storage table's cloth, its own 64 x 64 texture so it can be swapped: the cloth itself,
# and its hanging lower edge, one face at a time, with the hem along the bottom.
CLOTH_SIZE = 64
CLOTH_REGIONS = {
    'cloth': (0, 0, 64, 32, 'wood'),
    'cloth_hang': (0, 32, 64, 32, 'picture'),
}

# Books: eight spine designs side by side, a strip of page edges for their tops, and a swatch of
# each spine's cover colour for their sides.
BOOK_DESIGNS = 8
BOOK_REGIONS = {
    **{f'spine_{i}': (8 * i, 0, 8, 48, 'picture') for i in range(BOOK_DESIGNS)},
    'pages': (0, 48, 64, 8, 'picture'),
    **{f'cover_{i}': (8 * i, 56, 8, 8, 'picture') for i in range(BOOK_DESIGNS)},
}


def check(regions, size):
    """Every region inside the atlas and none overlapping."""
    boxes = list(regions.items())
    for name, (x, y, w, h, _) in boxes:
        assert 0 <= x and 0 <= y and x + w <= size and y + h <= size, f'{name} leaves the atlas'
    for i, (a, (ax, ay, aw, ah, _)) in enumerate(boxes):
        for b, (bx, by, bw, bh, _) in boxes[i + 1:]:
            assert ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay, f'{a} overlaps {b}'


# The seating (art/paint_seating.py, art/build_seating.py): small pieces, 64 x 64 atlases. The
# 'seat' picture is the whole top of the seat. Legs and slats have no '_edge' twin, so though
# they are thin they keep their plain grain; only the seat's edges wear.
SEATING_SIZE = 64
SEATING_REGIONS = {
    'chair_1x1': {
        'seat': (0, 0, 32, 32, 'picture'),
        'board': (32, 0, 32, 16, 'wood'),
        'board_edge': (32, 16, 32, 8, 'wood'),
        'rail': (32, 24, 32, 8, 'picture'),
        'slat': (0, 32, 32, 32, 'wood'),
        'leg': (32, 32, 32, 32, 'wood'),
    },
    'stool_1x1': {
        'seat': (0, 0, 32, 32, 'picture'),
        'board': (32, 0, 32, 16, 'wood'),
        'board_edge': (32, 16, 32, 8, 'wood'),
        'leg': (0, 32, 64, 32, 'wood'),
    },
}

# Barrels and crates (art/paint_containers.py, art/build_containers.py): one mesh per shape,
# shared by its variants, so every variant's 64 x 64 atlas has the same layout. The barrel's
# staves are one picture wrapped once round (u round from +X, v up the side, by height); its
# iron bands are painted at BARREL_BANDS, (bottom, top) heights. Each side of a crate is a
# framed panel: its frame strips and panel are pictures, its lid another.
CONTAINER_SIZE = 64
BARREL_HEIGHT = 28.0
BARREL_BANDS = [(1.5, 4.1), (12.7, 15.3), (23.9, 26.5)]
CONTAINER_REGIONS = {
    'barrel': {
        'stave': (0, 0, 64, 40, 'picture'),
        'lid': (0, 40, 24, 24, 'picture'),
        'rim': (24, 40, 32, 8, 'wood'),
    },
    'crate': {
        'panel': (0, 0, 24, 24, 'picture'),
        'lid': (24, 0, 24, 24, 'picture'),
        'recess': (48, 0, 8, 8, 'wood'),
        'frame': (0, 24, 32, 6, 'picture'),
    },
}

for _regions in REGIONS.values():
    check(_regions, ATLAS_SIZE)
for _regions in CONTAINER_REGIONS.values():
    check(_regions, CONTAINER_SIZE)
for _regions in SEATING_REGIONS.values():
    check(_regions, SEATING_SIZE)
check(BOOK_REGIONS, BOOKS_SIZE)
check(CLOTH_REGIONS, CLOTH_SIZE)
