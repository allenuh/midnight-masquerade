import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PROP_IDS, TILE_SIZE } from '../src/shared/map/schema.js';
import { PROP_SPECS, propPlacements, wallPropPlacements } from '../src/shared/map/props.js';
import { validateMap } from '../src/shared/map/validate.js';
import { CANDLE_LIGHT, MAX_CANDLE_LIGHTS, candleLightLists } from '../src/client/vfx.js';

type Light = { x: number; z: number };

// The list a pixel at (x, z) reads, the way the surface shader finds it.
function listAt({ data, longest }: ReturnType<typeof candleLightLists>, columns: number, rows: number, x: number, z: number): number[] {
  const column = Math.min(columns - 1, Math.max(0, Math.floor(x / TILE_SIZE)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(z / TILE_SIZE)));
  const start = (row * columns + column) * longest;
  const list: number[] = [];
  for (let entry = 0; entry < longest; entry++) {
    const slot = data[start + entry];
    if (slot < 0) break;
    list.push(slot);
  }
  return list;
}

// Every point that any light can add to, checked against the old way of looking at every slot. The
// grid is walked well past its edge, where the boundary walls' caps are.
function assertNothingMissed(lights: readonly Light[], columns: number, rows: number, radius: number): void {
  const lists = candleLightLists(lights, columns, rows, radius);
  const margin = 3 * TILE_SIZE;
  for (let x = -margin; x <= columns * TILE_SIZE + margin; x += 3.7) {
    for (let z = -margin; z <= rows * TILE_SIZE + margin; z += 3.7) {
      const listed = new Set(listAt(lists, columns, rows, x, z));
      lights.forEach((light, slot) => {
        if (Math.hypot(light.x - x, light.z - z) < radius) assert.ok(listed.has(slot), `light ${slot} reaches (${x}, ${z}) but is not listed there`);
      });
    }
  }
}

test('a tile lists the lights that can reach it, in slot order, and ends its list with -1', () => {
  // On a 6 x 1 strip: one in the first tile, one in the last, and one far enough from both that no
  // tile can reach two of them at this radius.
  const lights = [{ x: 10, z: 10 }, { x: 110, z: 10 }, { x: 60, z: 10 }];
  const lists = candleLightLists(lights, 6, 1, 15);
  assert.equal(lists.longest, 1);
  assert.equal(lists.data.length, 6);
  assert.deepEqual(listAt(lists, 6, 1, 10, 10), [0]);
  assert.deepEqual(listAt(lists, 6, 1, 30, 10), [0], 'its neighbour is within reach');
  assert.deepEqual(listAt(lists, 6, 1, 50, 10), [2]);
  assert.deepEqual(listAt(lists, 6, 1, 70, 10), [2]);
  assert.deepEqual(listAt(lists, 6, 1, 90, 10), [1]);
  // A wider radius reaches further, and the tile's list comes back in slot order.
  assert.deepEqual(listAt(candleLightLists(lights, 6, 1, 40), 6, 1, 30, 10), [0, 2]);
});

test('no light is ever missed, wherever it stands and however large the radius', () => {
  let seed = 7;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const lights = Array.from({ length: 40 }, () => ({ x: next() * 16 * TILE_SIZE, z: next() * 10 * TILE_SIZE }));
  for (const radius of [0, 7, 40, 105, 300]) assertNothingMissed(lights, 16, 10, radius);
});

test('a light just beyond the grid still reaches into it, and a map with none costs one lookup', () => {
  assertNothingMissed([{ x: -10, z: 30 }, { x: 8 * TILE_SIZE + 5, z: -4 }], 8, 6, 30);
  const empty = candleLightLists([], 8, 6, 105);
  assert.equal(empty.longest, 1);
  assert.equal(empty.data.length, 8 * 6);
  assert.ok(empty.data.every((slot) => slot === -1));
});

test('when every light can reach every tile, the lists hold them all and nothing is cut short', () => {
  const lights = Array.from({ length: MAX_CANDLE_LIGHTS }, (_, slot) => ({ x: (slot % 8) * TILE_SIZE, z: 0 }));
  const lists = candleLightLists(lights, 8, 6, 10_000);
  assert.equal(lists.longest, MAX_CANDLE_LIGHTS);
  assert.deepEqual(listAt(lists, 8, 6, 5, 5), lights.map((_, slot) => slot));
});

test('on every real map, a tile looks at a small part of the map\'s candles', () => {
  const lightsIn = (asset: string) => {
    const file = readFileSync(fileURLToPath(new URL(`../src/client/assets/${asset}.glb`, import.meta.url)));
    const gltf = JSON.parse(file.subarray(20, 20 + file.readUInt32LE(12)).toString('utf8')) as { nodes: { name: string }[] };
    return gltf.nodes.filter((node) => /_light_\d+$/.test(node.name)).length;
  };
  const counts = new Map(PROP_IDS.map((id) => [id, lightsIn(PROP_SPECS[id].asset)]));
  const mapsFolder = new URL('../maps/', import.meta.url);
  for (const file of readdirSync(mapsFolder).filter((name) => name.endsWith('.json'))) {
    const result = validateMap(JSON.parse(readFileSync(new URL(file, mapsFolder), 'utf8')));
    assert.ok(result.ok, file);
    const { map } = result;
    const lights: Light[] = [];
    for (const { type, position } of [...propPlacements(map), ...wallPropPlacements(map)]) {
      for (let index = 0; index < counts.get(type)!; index++) lights.push(position);
    }
    const { longest } = candleLightLists(lights, map.width, map.height, CANDLE_LIGHT.CANDLE_LIGHT_RADIUS);
    if (lights.length > 0) assert.ok(longest <= 24, `${file}: ${longest} of ${lights.length} candles can reach one tile`);
    assert.ok(longest * map.width <= 2048, `${file}: the lists must fit the texture size WebGL 2 guarantees`);
  }
});
