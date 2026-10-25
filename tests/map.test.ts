import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import { distance3D } from '../src/server/spatial.js';
import {
  FLOOR, MAP_VERSION, MARKER, MIN_HUNTER_SPAWNS, TERRAIN, TILE_SIZE, WALLPAPER, countMarkers, createEmptyMap, filledGrid,
  tileCenter, tileOrigin, type GameMap,
} from '../src/shared/map/schema.js';
import { validateMap } from '../src/shared/map/validate.js';
import { buildWorld } from '../src/shared/map/world.js';
import { DEFAULT_MAP_ID, loadMapCatalog } from '../src/server/maps.js';
import {
  PICKUP_FIRST_SPAWN_TICKS, activePickups, chooseSpawns, createGame, pickupPositions, startRound, stepGame,
} from '../src/server/game.js';
import { PLAYERS, TEST_MAP, TEST_WORLD, step } from './helpers/game.js';

const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

// A small hand-written, playable map: a wall block, a lone wall tile, one battery, one
// Creature Spawn and exactly the minimum number of Hunter Spawns.
function sampleMap(): GameMap {
  const map = createEmptyMap('Sample', 6, 5);
  map.terrain[1][1] = TERRAIN.wall;
  map.terrain[1][2] = TERRAIN.wall;
  map.terrain[2][1] = TERRAIN.wall;
  map.terrain[2][2] = TERRAIN.wall;
  map.terrain[4][4] = TERRAIN.wall;
  map.markers = [
    { type: MARKER.batterySpawn, x: 4, y: 1 },
    { type: MARKER.creatureSpawn, x: 0, y: 4 },
    { type: MARKER.hunterSpawn, x: 5, y: 0 },
    { type: MARKER.hunterSpawn, x: 4, y: 0 },
    { type: MARKER.hunterSpawn, x: 3, y: 0 },
    { type: MARKER.hunterSpawn, x: 2, y: 0 },
  ];
  return map;
}

// Mutates a copy of the sample map and returns the errors validation reports.
function errorsFor(mutate: (map: GameMap) => void): string[] {
  const map = structuredClone(sampleMap()) as GameMap;
  mutate(map);
  const result = validateMap(map);
  assert.equal(result.ok, false, 'the map should have been rejected');
  return result.ok ? [] : result.errors;
}

test('a valid map passes validation and keeps its terrain, finishes and markers', () => {
  const result = validateMap(sampleMap());
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.map.version, MAP_VERSION);
  assert.equal(result.map.width, 6);
  assert.equal(result.map.height, 5);
  assert.equal(result.map.terrain.length, 5);
  assert.equal(result.map.markers.length, 6);
  // A round-trip through JSON is what the editor exports and the runtime reads.
  const roundTripped = validateMap(JSON.parse(JSON.stringify(sampleMap())));
  assert.ok(roundTripped.ok);
  assert.deepEqual(roundTripped.map, sampleMap());
  // Finishes survive the round trip too.
  const finished = sampleMap();
  finished.floor[0][3] = FLOOR.starTile;
  finished.floor[3][0] = FLOOR.runner;
  finished.floor[3][1] = FLOOR.doorway;
  finished.floor[3][2] = FLOOR.checker;
  finished.wallpaper[1][1] = WALLPAPER.greenDamask;
  finished.boundaryWallpaper = WALLPAPER.creamFloral;
  const reloaded = validateMap(JSON.parse(JSON.stringify(finished)));
  assert.ok(reloaded.ok);
  assert.deepEqual(reloaded.map, finished);
});

test('a version 1 map, which predates finishes, loads as version 2 with every finish Plain', () => {
  const legacy: Record<string, unknown> = { ...sampleMap(), version: 1 };
  delete legacy.floor;
  delete legacy.wallpaper;
  delete legacy.boundaryWallpaper;
  const result = validateMap(legacy);
  assert.ok(result.ok);
  assert.equal(result.map.version, MAP_VERSION);
  assert.deepEqual(result.map.floor, filledGrid(6, 5, FLOOR.plain));
  assert.deepEqual(result.map.wallpaper, filledGrid(6, 5, WALLPAPER.plain));
  assert.equal(result.map.boundaryWallpaper, WALLPAPER.plain);
  assert.deepEqual(result.map.terrain, sampleMap().terrain);
});

test('validation rejects malformed maps with a readable reason and never repairs them', () => {
  assert.match(errorsFor((map) => { (map as { version: number }).version = 3; }).join(), /unsupported map version 3/);
  assert.match(errorsFor((map) => { delete (map as Partial<GameMap>).version; }).join(), /missing "version"/);
  assert.match(errorsFor((map) => { map.terrain[0][0] = 7 as never; }).join(), /terrain \(0, 0\) has unknown id 7/);
  assert.match(errorsFor((map) => { map.markers[0].type = 9 as never; }).join(), /marker 0 has unknown type 9/);
  // A version 2 map must carry both finish layers, grid-shaped, with known ids.
  assert.match(errorsFor((map) => { delete (map as Partial<GameMap>).floor; }).join(), /"floor" must be an array of rows/);
  assert.match(errorsFor((map) => { map.floor[1][2] = 42 as never; }).join(), /floor \(2, 1\) has unknown id 42/);
  assert.match(errorsFor((map) => { map.wallpaper.pop(); }).join(), /"wallpaper" has 4 rows but "height" is 5/);
  assert.match(errorsFor((map) => { map.wallpaper[0].push(WALLPAPER.plain); }).join(), /wallpaper row 0 has 7 tiles/);
  assert.match(errorsFor((map) => { map.boundaryWallpaper = 8 as never; }).join(), /"boundaryWallpaper" has unknown id 8/);
  assert.match(errorsFor((map) => { map.terrain[2].pop(); }).join(), /terrain row 2 has 5 tiles but "width" is 6/);
  assert.match(errorsFor((map) => { map.terrain.pop(); }).join(), /has 4 rows but "height" is 5/);
  assert.match(errorsFor((map) => { map.markers[0].x = 6; }).join(), /marker 0 at \(6, 1\) is outside the 6 x 5 grid/);
  assert.match(errorsFor((map) => { map.markers[0].y = -1; }).join(), /outside the 6 x 5 grid/);
  // A marker is "Open terrain plus a marker", so a Battery Spawn on Wall is invalid.
  assert.match(errorsFor((map) => { map.markers[0] = { type: MARKER.batterySpawn, x: 1, y: 1 }; }).join(),
    /marker 0 \(Battery Spawn\) at \(1, 1\) is not on Open terrain/);
  assert.match(errorsFor((map) => { map.width = 2; }).join(), /"width" must be a whole number from 3 to 100/);
  assert.match(errorsFor((map) => { map.height = 101; }).join(), /"height" must be a whole number from 3 to 100/);
  assert.match(errorsFor((map) => { (map as { width: unknown }).width = 6.5; }).join(), /"width" must be a whole number/);
  assert.equal(validateMap('not a map').ok, false);
  assert.equal(validateMap(null).ok, false);
});

test('grid coordinates convert to world coordinates through one shared rule', () => {
  assert.equal(tileOrigin(0), 0);
  assert.equal(tileOrigin(3), 3 * TILE_SIZE);
  assert.equal(tileCenter(0), TILE_SIZE / 2);
  assert.equal(tileCenter(3), 3 * TILE_SIZE + TILE_SIZE / 2);

  const world = buildWorld(sampleMap());
  // The grid is the playable floor: its size is the tile count times the tile size.
  assert.equal(world.width, 6 * TILE_SIZE);
  assert.equal(world.depth, 5 * TILE_SIZE);
  // y is the row and maps to world Z; x is the column and maps to world X.
  assert.equal(world.hunterSpawns.length, MIN_HUNTER_SPAWNS);
  assert.deepEqual(world.hunterSpawns[0], { x: tileCenter(5), y: GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius, z: tileCenter(0) });
  assert.deepEqual(world.creatureSpawns, [{ x: tileCenter(0), y: GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius, z: tileCenter(4) }]);
});

test('the loader turns wall tiles into merged boxes and encloses the grid', () => {
  const world = buildWorld(sampleMap());
  const { floorY, wallThickness, wallHeight } = GAMEPLAY.arena;
  const top = floorY + wallHeight;

  // The 2x2 block of wall tiles becomes one box, not four.
  const block = world.obstacles.find((box) => box.min.x === tileOrigin(1) && box.min.z === tileOrigin(1));
  assert.ok(block, 'the 2x2 wall block is present');
  assert.deepEqual(block, {
    min: { x: tileOrigin(1), y: floorY, z: tileOrigin(1) },
    max: { x: tileOrigin(3), y: top, z: tileOrigin(3) },
  });
  const lone = world.obstacles.find((box) => box.min.x === tileOrigin(4) && box.min.z === tileOrigin(4));
  assert.deepEqual(lone, {
    min: { x: tileOrigin(4), y: floorY, z: tileOrigin(4) },
    max: { x: tileOrigin(5), y: top, z: tileOrigin(5) },
  });
  assert.equal(world.obstacles.length, 2, 'five wall tiles merge into two boxes');

  // The arena boundary is implicit: the map describes the floor, the loader encloses it.
  assert.equal(world.walls.west.max.x, 0);
  assert.equal(world.walls.east.min.x, world.width);
  assert.equal(world.walls.north.max.z, 0);
  assert.equal(world.walls.south.min.z, world.depth);
  assert.equal(world.walls.west.min.x, -wallThickness);
  assert.equal(world.wallBoxes.length, 4 + world.obstacles.length);

  // An all-Open map has no interior walls at all, and is still enclosed.
  const empty = buildWorld(createEmptyMap('Empty', 3, 3));
  assert.deepEqual(empty.obstacles, []);
  assert.equal(empty.wallBoxes.length, 4);
});

test('Battery Spawn markers register as eligible spawn positions, in file order', () => {
  const world = buildWorld(sampleMap());
  assert.deepEqual(world.batterySpawns, [
    { x: tileCenter(4), y: GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius, z: tileCenter(1) },
  ]);
  assert.equal(world.creatureSpawns.length, 1);
  assert.equal(world.hunterSpawns.length, MIN_HUNTER_SPAWNS);

  // A room's game offers batteries at exactly its map's markers.
  const game = createGame(TEST_WORLD);
  assert.equal(pickupPositions(game).length, countMarkers(TEST_MAP, MARKER.batterySpawn));
  assert.deepEqual([...pickupPositions(game)], [...TEST_WORLD.batterySpawns]);
  for (const point of pickupPositions(game)) {
    const x = Math.floor(point.x / TILE_SIZE);
    const y = Math.floor(point.z / TILE_SIZE);
    assert.equal(TEST_MAP.terrain[y][x], TERRAIN.open, 'every battery point sits on Open terrain');
    assert.ok(TEST_MAP.markers.some((marker) => marker.type === MARKER.batterySpawn && marker.x === x && marker.y === y));
  }
});

test('loading a map spawns no battery: the server still owns the delay and the choice', () => {
  const game = createGame(TEST_WORLD);
  startRound(game, PLAYERS);
  assert.equal(game.pickup.at, null, 'a map declares where batteries may appear, not that one exists');
  while (game.roundState === 'reveal') stepGame(game);
  assert.deepEqual(activePickups(game), []);

  step(game, PICKUP_FIRST_SPAWN_TICKS - 1);
  assert.equal(game.pickup.at, null);
  step(game, 1);
  assert.notEqual(game.pickup.at, null, 'the existing first-spawn timer is what puts one out');
  // Whatever it chose is one of the map's Battery Spawn markers.
  const chosen = pickupPositions(game)[game.pickup.at!];
  assert.ok(chosen, 'the chosen index addresses a registered map position');
  assert.ok(TEST_WORLD.batterySpawns.includes(chosen));
});

test('the map catalogue loads every playable file, names a default, and skips broken ones with a warning', () => {
  // The real maps/ directory: the test arena must be there and be the default.
  const real = loadMapCatalog();
  assert.equal(real.default.id, DEFAULT_MAP_ID);
  assert.deepEqual(real.default.map, TEST_MAP);
  assert.equal(real.default.world.width, TEST_MAP.width * TILE_SIZE);
  assert.ok(real.entries.every((entry) => validateMap(entry.map).ok), 'only valid maps are catalogued');
  assert.deepEqual(real.summaries, real.entries.map(({ id, name }) => ({ id, name })));

  // A scratch directory: one good map, one invalid, one not even JSON.
  const directory = mkdtempSync(join(tmpdir(), 'ccc-maps-'));
  writeFileSync(join(directory, 'good.json'), JSON.stringify(sampleMap()));
  writeFileSync(join(directory, 'short.json'), JSON.stringify({ ...sampleMap(), markers: [] }));
  writeFileSync(join(directory, 'broken.json'), '{ not json');
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const scratch = loadMapCatalog(directory, 'good');
    assert.deepEqual(scratch.entries.map((entry) => entry.id), ['good']);
    assert.equal(scratch.default.name, 'Sample');
    assert.equal(warnings.length, 2, 'one warning per skipped file');
    assert.match(warnings.join('|'), /short\.json[^|]*Hunter Spawn/);
    assert.match(warnings.join('|'), /broken\.json[^|]*not valid JSON/);
    // A missing or invalid default is the one thing that must stop the server.
    assert.throws(() => loadMapCatalog(directory, 'short'), /Default map "short" is missing[^]*playable maps: good/);
    assert.throws(() => loadMapCatalog(directory, 'nope'), /Default map "nope"/);
  } finally {
    console.warn = warn;
  }
});

test('the player build cannot reach the map editor', () => {
  // Walk the client's import graph: if nothing reachable from main.ts imports tools/,
  // the editor cannot be in the player bundle, whatever the bundler is asked to do.
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith('.')) continue;
      assert.ok(!specifier.includes('tools/'), `${file} imports editor code: ${specifier}`);
      const resolved = fileURLToPath(new URL(specifier.replace(/\.js$/, '.ts'), `file://${file.replaceAll('\\', '/')}`));
      if (resolved.endsWith('.ts')) visit(resolved);
    }
  };
  visit(repoFile('src/client/main.ts'));
  assert.ok(seen.size > 3, 'the client graph was actually walked');
  assert.ok([...seen].every((file) => !file.includes('tools')), 'no editor module is reachable from the client');

  // The served client HTML names only its own entry point.
  const html = readFileSync(repoFile('src/client/index.html'), 'utf8');
  assert.equal(html.includes('map-editor'), false);
  assert.match(html, /src="\/main\.ts"/);

  const gameConfig = readFileSync(repoFile('vite.config.ts'), 'utf8');
  assert.equal(gameConfig.includes('tools'), false, 'the game build config never mentions the editor');
  assert.match(gameConfig, /root: fromRoot\('\.\/src\/client'\)/);

  // The editor is a separate build target with its own root and output directory. This
  // part is skipped when tools/ is absent on purpose: deleting the editor must leave the
  // game and its tests working, which is the whole point of keeping them apart.
  const editorConfigPath = repoFile('tools/map-editor/vite.config.ts');
  if (existsSync(editorConfigPath)) {
    const editorConfig = readFileSync(editorConfigPath, 'utf8');
    assert.match(editorConfig, /dist\/map-editor/);
    assert.match(editorConfig, /root: fileURLToPath\(new URL\('\.', import\.meta\.url\)\)/);
  }
});

// --- Player spawns from markers -------------------------------------------------------

const groundedY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;
const at = (x: number, y: number) => ({ x: tileCenter(x), y: groundedY, z: tileCenter(y) });
const samePoint = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x === b.x && a.z === b.z;

test('a playable map needs at least one Creature Spawn and a full team of Hunter Spawns', () => {
  const withoutHunters = errorsFor((map) => { map.markers = map.markers.filter((marker) => marker.type !== MARKER.hunterSpawn); });
  assert.match(withoutHunters.join(), /needs at least 4 Hunter Spawn markers, has 0/);
  const threeHunters = errorsFor((map) => { map.markers.pop(); });
  assert.match(threeHunters.join(), /needs at least 4 Hunter Spawn markers, has 3/);
  const noCreature = errorsFor((map) => { map.markers = map.markers.filter((marker) => marker.type !== MARKER.creatureSpawn); });
  assert.match(noCreature.join(), /needs at least 1 Creature Spawn marker\(s\), has 0/);
  assert.ok(!noCreature.join().includes('Hunter Spawn'), 'only the missing kind is reported');

  // Exactly the minimum passes, and so does a surplus of both kinds.
  assert.ok(validateMap(sampleMap()).ok);
  const generous = sampleMap();
  generous.markers.push({ type: MARKER.hunterSpawn, x: 1, y: 0 }, { type: MARKER.creatureSpawn, x: 3, y: 4 });
  assert.ok(validateMap(generous).ok);
  assert.equal(countMarkers(generous, MARKER.hunterSpawn), 5);
  assert.equal(countMarkers(generous, MARKER.creatureSpawn), 2);
});

test('a Hunter Spawn or Creature Spawn on Wall terrain is rejected, naming the marker kind', () => {
  assert.match(errorsFor((map) => { map.markers[2] = { type: MARKER.hunterSpawn, x: 4, y: 4 }; }).join(),
    /marker 2 \(Hunter Spawn\) at \(4, 4\) is not on Open terrain/);
  assert.match(errorsFor((map) => { map.markers[1] = { type: MARKER.creatureSpawn, x: 2, y: 2 }; }).join(),
    /marker 1 \(Creature Spawn\) at \(2, 2\) is not on Open terrain/);
});

test('the Creature starts on one of the map\'s Creature Spawn markers, chosen at random each time', () => {
  const map = sampleMap();
  map.markers.push({ type: MARKER.creatureSpawn, x: 3, y: 4 }, { type: MARKER.creatureSpawn, x: 5, y: 4 });
  const world = buildWorld(map);
  assert.equal(world.creatureSpawns.length, 3);
  const chosen = new Set<string>();
  for (let round = 0; round < 200; round++) {
    const { creature } = chooseSpawns(world.creatureSpawns, world.hunterSpawns, 4);
    assert.ok(world.creatureSpawns.some((spawn) => samePoint(spawn, creature)), 'always one of the markers');
    chosen.add(`${creature.x},${creature.z}`);
  }
  assert.equal(chosen.size, 3, 'every Creature Spawn is used across 200 rolls');
  // A single marker is simply always used.
  const single = buildWorld(sampleMap());
  for (let round = 0; round < 10; round++) assert.deepEqual(chooseSpawns(single.creatureSpawns, single.hunterSpawns, 4).creature, at(0, 4));
});

test('each Hunter gets a distinct Hunter Spawn; fewer Hunters than markers leave the rest empty', () => {
  const map = sampleMap();
  map.markers.push({ type: MARKER.hunterSpawn, x: 1, y: 0 }, { type: MARKER.hunterSpawn, x: 0, y: 0 });
  const world = buildWorld(map);
  assert.equal(world.hunterSpawns.length, 6);
  for (const hunterCount of [4, 3, 2, 1, 0]) {
    for (let round = 0; round < 50; round++) {
      const { hunters } = chooseSpawns(world.creatureSpawns, world.hunterSpawns, hunterCount);
      assert.equal(hunters.length, hunterCount);
      assert.equal(new Set(hunters.map((spawn) => `${spawn.x},${spawn.z}`)).size, hunterCount, 'no two Hunters share a spawn');
      for (const spawn of hunters) assert.ok(world.hunterSpawns.some((marker) => samePoint(marker, spawn)));
    }
  }
  // The assignment is a shuffle: over many rounds the first Hunter is not always on the same marker.
  const firsts = new Set<string>();
  for (let round = 0; round < 200; round++) {
    const { hunters } = chooseSpawns(world.creatureSpawns, world.hunterSpawns, 4);
    firsts.add(`${hunters[0].x},${hunters[0].z}`);
  }
  assert.ok(firsts.size > 1, 'H1 is not pinned to one marker');
  // Spawns are copies: a round moving a player never edits the map's table.
  const { creature } = chooseSpawns(world.creatureSpawns, world.hunterSpawns, 4);
  creature.x += 1;
  assert.equal(world.creatureSpawns[0].x, at(0, 4).x);
});

test('more Hunters than Hunter Spawns fails clearly instead of stacking players', () => {
  const world = buildWorld(sampleMap());
  assert.equal(world.hunterSpawns.length, 4);
  assert.throws(() => chooseSpawns(world.creatureSpawns, world.hunterSpawns, 5),
    /Map has 4 Hunter Spawn marker\(s\) but the round needs 5/);
  assert.throws(() => chooseSpawns([], world.hunterSpawns, 4), /no Creature Spawn marker/);
  // A round on such a map cannot start at all.
  const short = buildWorld({ ...sampleMap(), markers: sampleMap().markers.slice(0, 3) });
  const game = createGame(short);
  assert.throws(() => startRound(game, PLAYERS), /Hunter Spawn marker\(s\) but the round needs 4/);
});

test('every round start rolls the spawns again on the test arena, and nobody starts uneasy', () => {
  const game = createGame(TEST_WORLD);
  const creatureStarts = new Set<string>();
  const firstHunterStarts = new Set<string>();
  for (let round = 0; round < 200; round++) {
    startRound(game, PLAYERS);
    const creature = game.creature!.position;
    assert.ok(TEST_WORLD.creatureSpawns.some((spawn) => samePoint(spawn, creature)), 'the Creature is on a Creature Spawn');
    creatureStarts.add(`${creature.x},${creature.z}`);
    const taken = new Set<string>();
    for (const hunter of game.hunters) {
      assert.ok(TEST_WORLD.hunterSpawns.some((spawn) => samePoint(spawn, hunter.position)), `${hunter.id} is on a Hunter Spawn`);
      taken.add(`${hunter.position.x},${hunter.position.z}`);
      // The default arena's layout keeps every opening quiet: no warning at the whistle.
      assert.ok(distance3D(hunter.position, creature) > GAMEPLAY.proximity.uneasy, `${hunter.id} starts SAFE`);
    }
    assert.equal(taken.size, game.hunters.length);
    firstHunterStarts.add(`${game.hunters[0].position.x},${game.hunters[0].position.z}`);
  }
  assert.equal(creatureStarts.size, TEST_WORLD.creatureSpawns.length, 'every Creature Spawn on the arena is used');
  assert.ok(firstHunterStarts.size > 1, 'H1 lands on different markers across restarts');
});
