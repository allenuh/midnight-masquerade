import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOOR, TERRAIN, TILE_SIZE, WALLPAPER, createEmptyMap, type GameMap } from '../src/shared/map/schema.js';
import { buildWorld } from '../src/shared/map/world.js';
import { CASING_WIDTH, mapSurfaces, regionMask, type Quad } from '../src/client/surfaces.js';

// A 5 x 4 grid: a two-tile wall at (1, 1)-(2, 1), a wall tile in the north-east corner (4, 0),
// and everything else Open.
function finishedMap(): GameMap {
  const map = createEmptyMap('Surfaces', 5, 4);
  map.terrain[1][1] = TERRAIN.wall;
  map.terrain[1][2] = TERRAIN.wall;
  map.terrain[0][4] = TERRAIN.wall;
  map.wallpaper[1][1] = WALLPAPER.greenDamask;
  map.wallpaper[1][2] = WALLPAPER.creamFloral;
  map.floor[3][0] = FLOOR.redCarpet;
  map.floor[3][1] = FLOOR.redCarpet;
  map.boundaryWallpaper = WALLPAPER.creamFloral;
  return map;
}

const count = (groups: Map<number, Quad[]>) => [...groups.values()].reduce((total, quads) => total + quads.length, 0);
const sub = (a: Quad['normal'], b: Quad['normal']) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

test('every Open tile gets one floor quad, grouped by its floor', () => {
  const surfaces = mapSurfaces(buildWorld(finishedMap()));
  assert.equal(count(surfaces.floor), 5 * 4 - 3);
  assert.equal(surfaces.floor.get(FLOOR.redCarpet)?.length, 2);
  assert.equal(surfaces.floor.get(FLOOR.plain)?.length, 15);
});

test('wall sides appear only where a Wall tile faces an Open tile, in that tile\'s wallpaper', () => {
  const surfaces = mapSurfaces(buildWorld(finishedMap()));
  // The two-tile wall shows 6 sides (none between its tiles); the corner tile (4, 0) shows its
  // west and south sides, not the two against the boundary.
  const damask = surfaces.wall.get(WALLPAPER.greenDamask) ?? [];
  assert.equal(damask.length, 3, 'tile (1, 1): north, south and west');
  const plain = surfaces.wall.get(WALLPAPER.plain) ?? [];
  assert.equal(plain.length, 2, 'tile (4, 0): west and south');
  // Cream floral is tile (2, 1)'s three sides plus the boundary's inner faces: one per Open
  // tile side on the grid's edge (18 sides of the 5 x 4 perimeter, less the north and east
  // sides of the walled corner tile).
  assert.equal(surfaces.wall.get(WALLPAPER.creamFloral)?.length, 3 + 16);
  for (const quad of damask) {
    const xs = quad.corners.map((corner) => corner.x);
    assert.ok(!(quad.normal.x === 1 && Math.min(...xs) === 2 * TILE_SIZE), 'no face between the two wall tiles');
  }
});

test('every wall tile and the boundary get a cap, in the cap of their wallpaper', () => {
  const surfaces = mapSurfaces(buildWorld(finishedMap()));
  assert.equal(surfaces.top.get(WALLPAPER.greenDamask)?.length, 1);
  assert.equal(surfaces.top.get(WALLPAPER.plain)?.length, 1);
  // Tile (2, 1), plus the boundary's four tops and four outer faces.
  assert.equal(surfaces.top.get(WALLPAPER.creamFloral)?.length, 1 + 8);
});

test('every quad winds toward its normal, and floor and wall UVs run on across tiles', () => {
  const world = buildWorld(finishedMap());
  const surfaces = mapSurfaces(world);
  for (const quad of [surfaces.floor, surfaces.wall, surfaces.top].flatMap((groups) => [...groups.values()].flat())) {
    const [a, b, c] = quad.corners;
    const u = sub(b, a);
    const v = sub(c, a);
    const cross = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
    assert.ok(cross.x * quad.normal.x + cross.y * quad.normal.y + cross.z * quad.normal.z > 0, 'front faces along the normal');
  }
  // Two neighbouring floor tiles give their shared corners the same UVs.
  const at = (quads: Quad[], x: number, z: number) => quads.flatMap((quad) =>
    quad.corners.flatMap((corner, index) => (corner.x === x && corner.z === z ? [quad.uv[index]] : [])));
  const carpet = surfaces.floor.get(FLOOR.redCarpet)!;
  const shared = at(carpet, TILE_SIZE, 4 * TILE_SIZE);
  assert.equal(shared.length, 2);
  assert.deepEqual(shared[0], shared[1]);
  // The south faces of the two wall tiles continue one another: u at their shared edge matches.
  const south = [...surfaces.wall.values()].flat().filter((quad) => quad.normal.z === 1 && quad.corners[0].z === 2 * TILE_SIZE);
  const edge = south.flatMap((quad) => quad.corners.flatMap((corner, index) =>
    (corner.x === 2 * TILE_SIZE && corner.y === world.floorY ? [quad.uv[index][0]] : [])));
  assert.equal(edge.length, 2);
  assert.equal(edge[0], edge[1]);
});

// A 6 x 5 grid split by a wall along row 2 with a two-tile doorway at (2, 2)-(3, 2): the
// shape of every doorway in the mansion maps, one wall thick.
function doorwayMap(): GameMap {
  const map = createEmptyMap('Doorway', 6, 5);
  for (let x = 0; x < 6; x++) {
    if (x === 2 || x === 3) map.floor[2][x] = FLOOR.doorway;
    else map.terrain[2][x] = TERRAIN.wall;
    map.wallpaper[2][x] = WALLPAPER.greenDamask;
  }
  return map;
}

const span = (quad: Quad, axis: 'x' | 'z') =>
  Math.max(...quad.corners.map((corner) => corner[axis])) - Math.min(...quad.corners.map((corner) => corner[axis]));

test('a map without doorways has no door frames', () => {
  assert.equal(mapSurfaces(buildWorld(finishedMap())).frame.size, 0);
});

test('walls facing a doorway are jambs, and room faces beside it end in a casing', () => {
  const surfaces = mapSurfaces(buildWorld(doorwayMap()));
  const frames = surfaces.frame.get(WALLPAPER.greenDamask) ?? [];
  // Two jambs (the sides of (1, 2) and (4, 2) facing into the doorway), each a whole tile
  // deep, and a casing on both room faces of both of those tiles.
  const jambs = frames.filter((quad) => quad.normal.x !== 0);
  assert.equal(jambs.length, 2);
  for (const jamb of jambs) assert.equal(span(jamb, 'z'), TILE_SIZE);
  const casings = frames.filter((quad) => quad.normal.z !== 0);
  assert.equal(casings.length, 4);
  for (const casing of casings) {
    assert.equal(span(casing, 'x'), CASING_WIDTH);
    const xs = casing.corners.map((corner) => corner.x);
    // Each casing sits against the doorway: x 36..40 beside (2, 2), 80..84 beside (3, 2).
    assert.ok(Math.max(...xs) === 2 * TILE_SIZE || Math.min(...xs) === 4 * TILE_SIZE, `casing at ${xs}`);
  }
  // The rest of those room faces is still wallpaper, and runs on from the next tile's paper.
  const paper = surfaces.wall.get(WALLPAPER.greenDamask) ?? [];
  const north = paper.filter((quad) => quad.normal.z === -1);
  const cut = north.find((quad) => Math.min(...quad.corners.map((corner) => corner.x)) === TILE_SIZE)!;
  assert.equal(span(cut, 'x'), TILE_SIZE - CASING_WIDTH);
  const before = north.find((quad) => Math.max(...quad.corners.map((corner) => corner.x)) === TILE_SIZE)!;
  const uAt = (quad: Quad, x: number) => quad.uv[quad.corners.findIndex((corner) => corner.x === x && corner.y === 0)][0];
  assert.equal(uAt(cut, TILE_SIZE), uAt(before, TILE_SIZE));
  // Nothing of the doorway's own tiles is papered: the jambs replaced those faces.
  assert.equal(paper.filter((quad) => quad.normal.x !== 0).length, 0);
});

test('a region mask flags exactly the tiles in the region', () => {
  const map = doorwayMap();
  const mask = regionMask(map, (x, y) => map.floor[y][x] === FLOOR.doorway);
  assert.equal(mask.width, 6);
  assert.equal(mask.height, 5);
  assert.deepEqual([...mask.data].flatMap((flag, index) => (flag ? [index] : [])), [2 * 6 + 2, 2 * 6 + 3]);
});
