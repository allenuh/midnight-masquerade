import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MARKER, MIN_HUNTER_SPAWNS, PROP, PROP_IDS, TERRAIN, TILE_SIZE, createEmptyMap, tileOrigin, type GameMap, type MapProp,
} from '../src/shared/map/schema.js';
import {
  PROP_SPECS, WALL_PROP_HEIGHT, footprint, layoutProps, propPlacements, wallPropPlacements,
} from '../src/shared/map/props.js';
import { validateMap } from '../src/shared/map/validate.js';
import { buildWorld, lightOccluders } from '../src/shared/map/world.js';
import { segmentBlocked, wallDistance } from '../src/shared/raycast.js';
import { MAX_CANDLE_LIGHTS } from '../src/client/vfx.js';

// An 8 x 6 room: one Wall tile in the top-right corner, the spawns along the bottom row.
function roomMap(): GameMap {
  const map = createEmptyMap('Props', 8, 6);
  map.terrain[0][7] = TERRAIN.wall;
  map.markers = [{ type: MARKER.creatureSpawn, x: 0, y: 5 }];
  for (let i = 0; i < MIN_HUNTER_SPAWNS; i++) map.markers.push({ type: MARKER.hunterSpawn, x: i + 1, y: 5 });
  return map;
}

const prop = (type: MapProp['type'], x: number, y: number, rotation = 0): MapProp => ({ type, x, y, rotation });

const errorsOf = (map: GameMap): string => {
  const result = validateMap(map);
  return result.ok ? '' : result.errors.join(' | ');
};

function errorsFor(mutate: (map: GameMap) => void): string {
  const map = roomMap();
  mutate(map);
  assert.equal(validateMap(map).ok, false, 'the map should have been rejected');
  return errorsOf(map);
}

test('a footprint covers its tiles from the top-left one, and a quarter turn swaps its sides', () => {
  const tiles = (p: MapProp) => footprint(p).map(({ x, y }) => `${x},${y}`).join(' ');
  assert.equal(tiles(prop(PROP.diningTable, 1, 1)), '1,1 2,1 3,1 4,1');
  assert.equal(tiles(prop(PROP.diningTable, 1, 1, 180)), '1,1 2,1 3,1 4,1');
  assert.equal(tiles(prop(PROP.diningTable, 1, 1, 90)), '1,1 1,2 1,3 1,4');
  assert.equal(tiles(prop(PROP.diningTable, 1, 1, 270)), '1,1 1,2 1,3 1,4');
  assert.equal(tiles(prop(PROP.storageTable, 0, 0, 90)), '0,0 1,0 0,1 1,1 0,2 1,2 0,3 1,3');
  assert.equal(tiles(prop(PROP.barrelStandard, 3, 2, 137)), '3,2');
});

test('props and wall props survive a round trip; a version 2 map loads with none', () => {
  const map = roomMap();
  map.props = [prop(PROP.diningTable, 1, 1), prop(PROP.candelabra, 2, 1, 90), prop(PROP.barrelWeathered, 6, 3, 200)];
  map.wallProps = [{ type: PROP.wallCandleDouble, x: 2, y: 0, side: 'north' }];
  const result = validateMap(JSON.parse(JSON.stringify(map)));
  assert.ok(result.ok, errorsOf(map));
  assert.deepEqual(result.map, map);

  const older: Record<string, unknown> = { ...roomMap(), version: 2 };
  delete older.props;
  delete older.wallProps;
  const loaded = validateMap(older);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.map.props, []);
  assert.deepEqual(loaded.map.wallProps, []);
});

test('a candle stands on the table under it, and crates stack at most three high', () => {
  const map = roomMap();
  map.props = [
    prop(PROP.storageTable, 0, 0), prop(PROP.chamberstick, 3, 1),
    prop(PROP.crateStandard, 6, 2), prop(PROP.crateDark, 6, 2, 90), prop(PROP.crateStandard, 6, 2), prop(PROP.candelabra, 6, 2),
    prop(PROP.barrelStandard, 5, 3, 33), prop(PROP.chamberstick, 5, 3),
  ];
  assert.equal(errorsOf(map), '');
  const layout = layoutProps(map);
  assert.deepEqual(layout.stacks.map((stack) => stack.base), [-1, 0, -1, 2, 3, 4, -1, 6]);
  assert.equal(layout.stacks[1].baseHeight, PROP_SPECS[PROP.storageTable].surface);
  assert.deepEqual(layout.stacks.slice(2, 6).map((stack) => stack.baseHeight), [0, 18, 36, 54]);
  assert.equal(layout.stacks[7].baseHeight, PROP_SPECS[PROP.barrelStandard].surface);
  assert.equal(layout.top[2][6], 5, 'the candelabra is on top of the crate stack');

  map.props.splice(5, 1, prop(PROP.crateDark, 6, 2));
  assert.match(errorsOf(map), /stand 4 high; a dark crate stacks at most 3 high/);
});

test('misplaced props are rejected with a readable reason', () => {
  assert.match(errorsFor((map) => { map.props = [{ type: 99, x: 0, y: 0, rotation: 0 } as never]; }), /prop 0 has unknown type 99/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.chair, 1.5, 0)]; }), /needs whole-number "x" and "y"/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.diningTable, 1, 1, 45)]; }), /rotation 45: it turns in quarter turns/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.barrelStandard, 1, 1, 360)]; }), /whole degrees from 0 to 359/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.diningTable, 5, 1)]; }), /reaches outside the 8 x 6 grid/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.dresser, 6, 0)]; }), /covers Wall terrain at \(7, 0\)/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.cupboard, 0, 0), prop(PROP.bookshelf, 2, 0)]; }),
    /prop 1 \(Bookshelf\) at \(2, 0\) overlaps prop 0 \(Cupboard\)/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.chamberstick, 2, 2)]; }), /must stand on a table, a dresser, a crate or a barrel/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.chair, 2, 2), prop(PROP.candelabra, 2, 2)]; }), /overlaps prop 0 \(Chair\)/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.diningTable, 0, 0), prop(PROP.chamberstick, 1, 0), prop(PROP.chamberstick, 1, 0)]; }),
    /prop 2 \(Chamberstick\) at \(1, 0\) overlaps prop 1/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.wallCandle, 2, 2)]; }), /belongs in "wallProps"/);
  assert.match(errorsFor((map) => { map.props = [prop(PROP.stool, 1, 5)]; }), /marker 1 \(Hunter Spawn\) at \(1, 5\) is under prop 0/);
  assert.match(errorsFor((map) => { delete (map as Partial<GameMap>).props; }), /"props" must be an array/);
});

test('a wall prop needs a wall behind it and room below it', () => {
  // The boundary counts as a wall: the top row's north side, the left column's west side.
  const fine = roomMap();
  fine.wallProps = [
    { type: PROP.wallCandle, x: 0, y: 2, side: 'west' }, { type: PROP.wallCandle, x: 6, y: 0, side: 'east' },
    { type: PROP.wallCandle, x: 7, y: 1, side: 'north' },
  ];
  fine.props = [prop(PROP.sideTable, 0, 1, 90)];
  assert.equal(errorsOf(fine), '');

  assert.match(errorsFor((map) => { map.wallProps = [{ type: PROP.wallCandle, x: 3, y: 2, side: 'north' }]; }), /has no wall on its north side/);
  assert.match(errorsFor((map) => { map.wallProps = [{ type: PROP.wallCandle, x: 7, y: 0, side: 'south' }]; }), /needs Open terrain/);
  assert.match(errorsFor((map) => { map.wallProps = [{ type: PROP.wallCandleDouble, x: 6, y: 0, side: 'north' }]; }), /needs Open terrain .* at \(7, 0\)/);
  assert.match(errorsFor((map) => {
    map.wallProps = [{ type: PROP.wallCandleDouble, x: 1, y: 0, side: 'north' }, { type: PROP.wallCandle, x: 2, y: 0, side: 'north' }];
  }), /wall prop 1 \(Wall candle\) .* overlaps wall prop 0/);
  assert.match(errorsFor((map) => {
    map.props = [prop(PROP.dresser, 2, 0)];
    map.wallProps = [{ type: PROP.wallCandle, x: 3, y: 0, side: 'north' }];
  }), /would clip prop 0 \(Dresser\) at \(2, 0\), which is 31 high; it hangs down to 28/);
  assert.match(errorsFor((map) => { map.wallProps = [{ type: PROP.chair, x: 0, y: 0, side: 'north' }]; }), /belongs in "props"/);
  assert.match(errorsFor((map) => { map.wallProps = [{ type: PROP.wallCandle, x: 0, y: 0, side: 'up' as never }]; }), /unknown side "up"/);
});

test('every tile a prop stands on blocks movement and sight like a wall, low props included', () => {
  const map = roomMap();
  map.props = [prop(PROP.stool, 2, 2), prop(PROP.crateStandard, 3, 2), prop(PROP.crateDark, 3, 2)];
  const world = buildWorld(map);
  // The Wall tile, and the stool and crate merged into one box two tiles wide.
  assert.equal(world.obstacles.length, 2);
  const props = world.obstacles.find((box) => box.min.x === tileOrigin(2))!;
  assert.deepEqual(props.max, { x: tileOrigin(4), y: world.floorY + world.wallHeight, z: tileOrigin(3) });
  const eye = (x: number) => ({ x, y: 10, z: tileOrigin(2) + TILE_SIZE / 2 });
  assert.ok(segmentBlocked(eye(tileOrigin(1)), eye(tileOrigin(5)), world.wallBoxes), 'nobody sees over a stool');
  assert.ok(!segmentBlocked(eye(tileOrigin(1)), eye(tileOrigin(1) + 15), world.wallBoxes));
});

test('candle light stops at walls and at props taller than its flame, not at a candle or a table', () => {
  const map = roomMap();
  // A dining table along row 1 with a chamberstick on its first tile, a chair beside it and a
  // bookshelf across the room on the same row.
  map.props = [prop(PROP.diningTable, 0, 1), prop(PROP.chamberstick, 0, 1), prop(PROP.chair, 4, 1), prop(PROP.bookshelf, 5, 1)];
  const world = buildWorld(map);
  const occluders = lightOccluders(world);
  const boxAt = (x: number, y: number) => occluders.find(({ min, max }) =>
    min.x <= tileOrigin(x) && max.x >= tileOrigin(x + 1) && min.z <= tileOrigin(y) && max.z >= tileOrigin(y + 1));
  assert.equal(boxAt(0, 1)?.max.y, PROP_SPECS[PROP.diningTable].surface, "the candle's tile is only as tall as its table");
  assert.equal(boxAt(4, 1)?.max.y, PROP_SPECS[PROP.chair].height);
  assert.equal(boxAt(7, 0)?.max.y, world.floorY + world.wallHeight, 'a Wall tile is full height');
  assert.equal(boxAt(2, 3), undefined);
  const flame = { x: tileOrigin(0) + TILE_SIZE / 2, y: PROP_SPECS[PROP.diningTable].surface! + 11, z: tileOrigin(1) + TILE_SIZE / 2 };
  const east = { x: 1, y: 0, z: 0 };
  assert.equal(wallDistance(flame, east, 200, occluders), tileOrigin(5) - flame.x, 'over the table and the chair, up to the bookshelf');
  assert.equal(wallDistance(flame, { x: 0, y: 0, z: -1 }, 200, occluders), flame.z, 'up to the boundary');
});

test('placements centre a prop on its footprint at its base, turned clockwise as the editor shows it', () => {
  const map = roomMap();
  map.props = [prop(PROP.diningTable, 1, 1, 90), prop(PROP.candelabra, 1, 3)];
  map.wallProps = [
    { type: PROP.wallCandleDouble, x: 2, y: 0, side: 'north' }, { type: PROP.wallCandle, x: 6, y: 0, side: 'east' },
    { type: PROP.wallCandle, x: 5, y: 4, side: 'south' }, { type: PROP.wallCandle, x: 0, y: 3, side: 'west' },
  ];
  const [table, candle] = propPlacements(map);
  assert.deepEqual(table.position, { x: tileOrigin(1) + TILE_SIZE / 2, y: 0, z: tileOrigin(1) + 2 * TILE_SIZE });
  // Clockwise from facing down the grid is facing -X; three.js turns the other way.
  assert.equal(table.rotation, -Math.PI / 2);
  assert.deepEqual(candle.position, { x: tileOrigin(1) + TILE_SIZE / 2, y: 24, z: tileOrigin(3) + TILE_SIZE / 2 });

  const [double, east, south, west] = wallPropPlacements(map).map((placement) => placement.position);
  assert.deepEqual(double, { x: tileOrigin(3), y: WALL_PROP_HEIGHT, z: 0 }, 'on the seam between its two tiles');
  assert.deepEqual(east, { x: tileOrigin(7), y: WALL_PROP_HEIGHT, z: tileOrigin(0) + TILE_SIZE / 2 });
  assert.deepEqual(south, { x: tileOrigin(5) + TILE_SIZE / 2, y: WALL_PROP_HEIGHT, z: tileOrigin(5) });
  assert.deepEqual(west, { x: 0, y: WALL_PROP_HEIGHT, z: tileOrigin(3) + TILE_SIZE / 2 });
});

// The catalogue against the models themselves: each glb's JSON chunk, its meshes' bounds offset
// by their nodes (the props only translate their parts).
function modelBounds(asset: string): { min: number[]; max: number[]; nodes: string[] } {
  const file = readFileSync(fileURLToPath(new URL(`../src/client/assets/${asset}.glb`, import.meta.url)));
  const gltf = JSON.parse(file.subarray(20, 20 + file.readUInt32LE(12)).toString('utf8'));
  const parent = new Map<number, number>();
  gltf.nodes.forEach((node: { children?: number[] }, index: number) => node.children?.forEach((child) => parent.set(child, index)));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  gltf.nodes.forEach((node: { mesh?: number }, index: number) => {
    if (node.mesh === undefined) return;
    const offset = [0, 0, 0];
    for (let at: number | undefined = index; at !== undefined; at = parent.get(at)) {
      const { translation = [0, 0, 0], rotation, scale } = gltf.nodes[at];
      assert.ok(!rotation && !scale, `${asset}.glb only translates its parts`);
      translation.forEach((value: number, axis: number) => { offset[axis] += value; });
    }
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], accessor.min[axis] + offset[axis]);
        max[axis] = Math.max(max[axis], accessor.max[axis] + offset[axis]);
      }
    }
  });
  return { min, max, nodes: gltf.nodes.map((node: { name: string }) => node.name) };
}

test('every prop in the catalogue has a model that fits its footprint and height', () => {
  for (const id of PROP_IDS) {
    const spec = PROP_SPECS[id];
    const { min, max, nodes } = modelBounds(spec.asset);
    const close = (actual: number, expected: number, what: string) =>
      assert.ok(Math.abs(actual - expected) < 0.01, `${spec.asset} ${what} is ${actual}, the catalogue says ${expected}`);
    if (spec.kind === 'wall') {
      close(max[1] - min[1], spec.height, 'height');
      assert.ok(max[0] - min[0] <= spec.size[0] * TILE_SIZE, `${spec.asset} fits along its wall`);
      assert.ok(min[2] >= -0.01, `${spec.asset} stands out of the wall, not into it`);
    } else {
      close(min[1], 0, 'base');
      close(max[1], spec.height, 'top');
      if (spec.kind === 'standing') {
        assert.ok(Math.max(-min[0], max[0]) <= (spec.size[0] * TILE_SIZE) / 2, `${spec.asset} fits its footprint across`);
        assert.ok(Math.max(-min[2], max[2]) <= (spec.size[1] * TILE_SIZE) / 2, `${spec.asset} fits its footprint deep`);
      }
    }
    if (spec.surface !== undefined) assert.ok(spec.surface <= spec.height, `${spec.asset}'s surface is on the model`);
    if (spec.group === 'Tabletop' || spec.group === 'Wall') {
      assert.ok(nodes.some((name) => name.startsWith(`${spec.asset}_flame_`)), `${spec.asset} has its flames`);
      assert.ok(nodes.some((name) => name.startsWith(`${spec.asset}_light_`)), `${spec.asset} marks where its light goes`);
    }
  }
});

// The client lights only the first MAX_CANDLE_LIGHTS candle lights (one per `_light_` point in a
// model); any more keep their halo but light nothing round them.
test('every map\'s candles fit in the candle light slots, so every candle lights its surroundings', () => {
  const lightsIn = new Map(PROP_IDS.map((id) => [id, modelBounds(PROP_SPECS[id].asset).nodes.filter((name) => /_light_\d+$/.test(name)).length]));
  const mapsFolder = new URL('../maps/', import.meta.url);
  for (const file of readdirSync(mapsFolder).filter((name) => name.endsWith('.json'))) {
    const result = validateMap(JSON.parse(readFileSync(new URL(file, mapsFolder), 'utf8')));
    assert.ok(result.ok, `${file} is a valid map`);
    const placements = [...propPlacements(result.map), ...wallPropPlacements(result.map)];
    const lights = placements.reduce((total, { type }) => total + lightsIn.get(type)!, 0);
    assert.ok(lights <= MAX_CANDLE_LIGHTS, `${file} has ${lights} candle lights; MAX_CANDLE_LIGHTS is ${MAX_CANDLE_LIGHTS}`);
  }
});
