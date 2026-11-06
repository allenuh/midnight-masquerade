import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOOR_IDS, MARKER, PROP_IDS, WALLPAPER_IDS, countMarkers } from '../src/shared/map/schema.js';
import { validateMap } from '../src/shared/map/validate.js';
import { buildWorld } from '../src/shared/map/world.js';
import { mapSurfaces } from '../src/client/surfaces.js';
import { warmUpMap } from '../src/client/warm-up-map.js';

// The opening cover compiles the game's shaders on this map (src/client/main.ts), so whatever a real
// map can draw has to be on it. It is generated from the catalogues, and this keeps it that way.

test('the warm-up map is a valid map', () => {
  const result = validateMap(JSON.parse(JSON.stringify(warmUpMap())));
  assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
});

test('it holds every prop in the catalogue', () => {
  const map = warmUpMap();
  const placed = new Set([...map.props, ...map.wallProps].map((prop) => prop.type));
  for (const id of PROP_IDS) assert.ok(placed.has(id), `prop ${id} is missing`);
});

test('it draws every floor, and every wallpaper as a wall, a door frame and a wall top', () => {
  const surfaces = mapSurfaces(buildWorld(warmUpMap()));
  for (const id of FLOOR_IDS) assert.ok(surfaces.floor.has(id), `floor ${id} is missing`);
  for (const id of WALLPAPER_IDS) {
    assert.ok(surfaces.wall.has(id), `wallpaper ${id} is on no wall`);
    assert.ok(surfaces.frame.has(id), `wallpaper ${id} has no door frame`);
    assert.ok(surfaces.top.has(id), `wallpaper ${id} has no wall top`);
  }
});

test('it has a battery to draw', () => {
  assert.ok(countMarkers(warmUpMap(), MARKER.batterySpawn) >= 1);
  assert.ok(buildWorld(warmUpMap()).batterySpawns.length >= 1);
});
