// The visible surfaces of a map, as plain quads grouped by finish: floor under every Open
// tile, wallpaper on every Wall side that faces an Open tile, and a cap on top of every wall.
// Pure (no three.js), so the tests can check it; surface-meshes.ts turns it into meshes.
// This is drawing only. Collision and line of sight keep using the World's merged boxes.
import {
  FLOOR, TERRAIN, TILE_SIZE, type FloorId, type GameMap, type WallpaperId,
} from '../shared/map/schema.js';
import type { World } from '../shared/map/world.js';

export type Point = { x: number; y: number; z: number };

// Corners counter-clockwise seen from the front (bottom left, bottom right, top right, top
// left), so the two triangles (0, 1, 2) and (0, 2, 3) face along `normal`. `uv` is per corner.
export type Quad = { corners: [Point, Point, Point, Point]; normal: Point; uv: [number, number][] };

export type MapSurfaces = {
  floor: Map<FloorId, Quad[]>;
  // Wall sides and the boundary's inner faces, by wallpaper.
  wall: Map<WallpaperId, Quad[]>;
  // Door frames, by the wallpaper of the wall they are cut into: the jambs (wall sides facing
  // a Doorway tile) and a casing strip CASING_WIDTH wide where a room face meets a doorway.
  frame: Map<WallpaperId, Quad[]>;
  // Wall tops and the boundary's top and outer faces, by the wallpaper whose cap they wear.
  top: Map<WallpaperId, Quad[]>;
};

// World units one repeat of each texture covers. Every UV is taken from world coordinates,
// so a pattern runs on across tiles and along a wall instead of restarting on each tile.
// A floor texture is 32 texels a tile; a wallpaper covers WALLPAPER_SPAN of wall length and
// the full wall height.
export const FLOOR_SPAN: Record<FloorId, number> = {
  [FLOOR.plain]: TILE_SIZE,
  [FLOOR.starTile]: TILE_SIZE,
  [FLOOR.marbleDiamond]: 2 * TILE_SIZE,
  [FLOOR.terracotta]: 2 * TILE_SIZE,
  [FLOOR.redCarpet]: 2 * TILE_SIZE,
  [FLOOR.beigeCarpet]: 2 * TILE_SIZE,
  [FLOOR.runner]: 2 * TILE_SIZE,
  [FLOOR.doorway]: TILE_SIZE,
  [FLOOR.checker]: TILE_SIZE,
};
export const WALLPAPER_SPAN = 28;
export const CAP_SPAN = 2 * TILE_SIZE;
export const FRAME_SPAN = TILE_SIZE;
// How far the casing reaches along a room face from the doorway's edge, in world units.
export const CASING_WIDTH = 4;

// One flag per tile (row-major, y * width + x): 1 inside the region. The renderer uploads it
// as a texture and draws a border band along the region's edge (runners, doorway rugs, the
// moulding on wall tops), so the border turns every corner wherever the region runs.
export type RegionMask = { width: number; height: number; data: Uint8Array };

export function regionMask(map: GameMap, inRegion: (x: number, y: number) => boolean): RegionMask {
  const data = new Uint8Array(map.width * map.height);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) data[y * map.width + x] = inRegion(x, y) ? 1 : 0;
  }
  return { width: map.width, height: map.height, data };
}

const UP: Point = { x: 0, y: 1, z: 0 };

function push<K>(groups: Map<K, Quad[]>, key: K, quad: Quad): void {
  const list = groups.get(key);
  if (list) list.push(quad);
  else groups.set(key, [quad]);
}

// A horizontal rectangle facing up, textured with `span`: u along +X, v along -Z, so the
// top of a texture points up the screen.
function flat(x0: number, x1: number, z0: number, z1: number, y: number, span: number): Quad {
  const corners: Quad['corners'] = [{ x: x0, y, z: z1 }, { x: x1, y, z: z1 }, { x: x1, y, z: z0 }, { x: x0, y, z: z0 }];
  return { corners, normal: UP, uv: corners.map((p) => [p.x / span, -p.z / span]) };
}

// A vertical rectangle from y0 to y1 along the ground segment `from` → `to`, facing `normal`
// (horizontal, pointing out of the wall). Seen from the front, `from` is on the left. u runs
// left to right in world units / `span`, measured along the face's own right-hand direction so
// a pattern is never mirrored; v runs 0..1 over `vSpan` above y0.
function upright(from: Point, to: Point, y0: number, y1: number, normal: Point, span: number, vSpan: number): Quad {
  const right = { x: normal.z, z: -normal.x };
  const along = (p: Point) => (p.x * right.x + p.z * right.z) / span;
  const corners: Quad['corners'] = [
    { x: from.x, y: y0, z: from.z }, { x: to.x, y: y0, z: to.z }, { x: to.x, y: y1, z: to.z }, { x: from.x, y: y1, z: from.z },
  ];
  return { corners, normal, uv: corners.map((p) => [along(p), (p.y - y0) / vSpan]) };
}

// The four sides of a tile, each with its outward normal and its ground segment left to right
// as seen from outside.
const SIDES = [
  { dx: 0, dz: 1, normal: { x: 0, y: 0, z: 1 }, from: [0, 1], to: [1, 1] },
  { dx: 0, dz: -1, normal: { x: 0, y: 0, z: -1 }, from: [1, 0], to: [0, 0] },
  { dx: 1, dz: 0, normal: { x: 1, y: 0, z: 0 }, from: [1, 1], to: [1, 0] },
  { dx: -1, dz: 0, normal: { x: -1, y: 0, z: 0 }, from: [0, 0], to: [0, 1] },
] as const;

export function mapSurfaces(world: World): MapSurfaces {
  const { map, floorY, wallHeight } = world;
  const top = floorY + wallHeight;
  const surfaces: MapSurfaces = { floor: new Map(), wall: new Map(), frame: new Map(), top: new Map() };
  const open = (x: number, y: number) => map.terrain[y][x] === TERRAIN.open;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height;
  const doorway = (x: number, y: number) => inside(x, y) && open(x, y) && map.floor[y][x] === FLOOR.doorway;
  const corner = (x: number, y: number, [cx, cz]: readonly [number, number]): Point =>
    ({ x: (x + cx) * TILE_SIZE, y: floorY, z: (y + cz) * TILE_SIZE });

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const x0 = x * TILE_SIZE;
      const z0 = y * TILE_SIZE;
      if (open(x, y)) {
        const floor = map.floor[y][x];
        push(surfaces.floor, floor, flat(x0, x0 + TILE_SIZE, z0, z0 + TILE_SIZE, floorY, FLOOR_SPAN[floor]));
        // An Open tile on the grid's edge looks at the implicit boundary wall there.
        for (const side of SIDES) {
          if (inside(x + side.dx, y + side.dz)) continue;
          const normal = { x: -side.normal.x, y: 0, z: -side.normal.z };
          push(surfaces.wall, map.boundaryWallpaper,
            upright(corner(x, y, side.to), corner(x, y, side.from), floorY, top, normal, WALLPAPER_SPAN, wallHeight));
        }
        continue;
      }
      const wallpaper = map.wallpaper[y][x];
      push(surfaces.top, wallpaper, flat(x0, x0 + TILE_SIZE, z0, z0 + TILE_SIZE, top, CAP_SPAN));
      for (const side of SIDES) {
        if (!inside(x + side.dx, y + side.dz) || !open(x + side.dx, y + side.dz)) continue;
        const from = corner(x, y, side.from);
        const to = corner(x, y, side.to);
        // A jamb: this side faces into a doorway, so it is all door frame.
        if (doorway(x + side.dx, y + side.dz)) {
          push(surfaces.frame, wallpaper, upright(from, to, floorY, top, side.normal, FRAME_SPAN, wallHeight));
          continue;
        }
        // A room face whose neighbour along the wall line is a doorway ends at the door: the
        // last CASING_WIDTH of it nearest the doorway is casing, the rest wallpaper.
        const right = { x: side.normal.z, z: -side.normal.x };
        const casedLeft = doorway(x - right.x, y - right.z);
        const casedRight = doorway(x + right.x, y + right.z);
        const at = (t: number): Point => ({ x: from.x + (to.x - from.x) * t, y: floorY, z: from.z + (to.z - from.z) * t });
        const cut = CASING_WIDTH / TILE_SIZE;
        const start = casedLeft ? cut : 0;
        const end = casedRight ? 1 - cut : 1;
        push(surfaces.wall, wallpaper, upright(at(start), at(end), floorY, top, side.normal, WALLPAPER_SPAN, wallHeight));
        if (casedLeft) push(surfaces.frame, wallpaper, upright(from, at(cut), floorY, top, side.normal, FRAME_SPAN, wallHeight));
        if (casedRight) push(surfaces.frame, wallpaper, upright(at(1 - cut), to, floorY, top, side.normal, FRAME_SPAN, wallHeight));
      }
    }
  }

  // The boundary: a cap on each of its four boxes, and their outer faces (the south one
  // faces the camera along the bottom of the screen) in the same material.
  const { west, east, north, south } = world.walls;
  for (const box of [west, east, north, south]) {
    push(surfaces.top, map.boundaryWallpaper, flat(box.min.x, box.max.x, box.min.z, box.max.z, top, CAP_SPAN));
  }
  const outer = (from: Point, to: Point, normal: Point) =>
    push(surfaces.top, map.boundaryWallpaper, upright(from, to, floorY, top, normal, CAP_SPAN, CAP_SPAN));
  const minX = west.min.x, maxX = east.max.x, minZ = north.min.z, maxZ = south.max.z;
  outer({ x: minX, y: 0, z: maxZ }, { x: maxX, y: 0, z: maxZ }, { x: 0, y: 0, z: 1 });
  outer({ x: maxX, y: 0, z: minZ }, { x: minX, y: 0, z: minZ }, { x: 0, y: 0, z: -1 });
  outer({ x: maxX, y: 0, z: maxZ }, { x: maxX, y: 0, z: minZ }, { x: 1, y: 0, z: 0 });
  outer({ x: minX, y: 0, z: minZ }, { x: minX, y: 0, z: maxZ }, { x: -1, y: 0, z: 0 });
  return surfaces;
}
