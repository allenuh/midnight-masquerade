import assert from 'node:assert/strict';
import test from 'node:test';
import { ARENA_WALLS } from '../src/shared/arena.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position } from '../src/shared/protocol.js';
import { constrainToArena, distance3D, spheresTouchDuringStep } from '../src/server/spatial.js';
import {
  createGame,
  joinGame,
  leaveGame,
  proximityForDistance,
  restartGame,
  setInput,
  snapshotFor,
  stepGame,
} from '../src/server/game.js';

type Game = ReturnType<typeof createGame>;
type Role = 'hunter' | 'creature';
type Keys = { up: boolean; down: boolean; left: boolean; right: boolean };

const groundedY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;
const groundPosition = (x: number, z: number): Position => ({ x, y: groundedY, z });

function runningGame(): Game {
  const game = createGame();
  joinGame(game, 'hunter');
  joinGame(game, 'creature');
  game.players.hunter = groundPosition(100, 100);
  game.players.creature = groundPosition(500, 300);
  return game;
}

function input(game: Game, keys: Partial<Keys> = {}) {
  return {
    type: 'input', roundId: game.roundId,
    up: false, down: false, left: false, right: false, ...keys,
  };
}

function closeTo(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
}

function assertHunterPayload(value: unknown) {
  const payload = JSON.parse(JSON.stringify(value));
  // An allowlist checks every exposed field, including additions made later.
  assert.deepEqual(Object.keys(payload).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'hunter', 'proximity',
  ].sort());
  assert.equal(payload.type, 'snapshot');
  assert.equal(payload.role, 'hunter');
  assert.equal(typeof payload.roundId, 'number');
  assert.ok(['waiting', 'running', 'ended'].includes(payload.roundState));
  assert.ok(payload.result === null || payload.result === 'caught');
  assert.ok(['SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE'].includes(payload.proximity));
  if (payload.hunter !== null) {
    assert.deepEqual(Object.keys(payload.hunter).sort(), ['x', 'y', 'z']);
    assert.equal(typeof payload.hunter.x, 'number');
    assert.equal(typeof payload.hunter.y, 'number');
    assert.equal(typeof payload.hunter.z, 'number');
  }
}

test('proximity uses inclusive configured boundaries and four discrete bands', () => {
  const { uneasy, danger, immediate } = GAMEPLAY.proximity;
  assert.ok(immediate < danger && danger < uneasy);
  assert.equal(proximityForDistance(0), 'IMMEDIATE');
  assert.equal(proximityForDistance(immediate - 0.01), 'IMMEDIATE');
  assert.equal(proximityForDistance(immediate), 'IMMEDIATE');
  assert.equal(proximityForDistance(immediate + 0.01), 'DANGER');
  assert.equal(proximityForDistance(danger - 0.01), 'DANGER');
  assert.equal(proximityForDistance(danger), 'DANGER');
  assert.equal(proximityForDistance(danger + 0.01), 'UNEASY');
  assert.equal(proximityForDistance(uneasy - 0.01), 'UNEASY');
  assert.equal(proximityForDistance(uneasy), 'UNEASY');
  assert.equal(proximityForDistance(uneasy + 0.01), 'SAFE');
  assert.equal(proximityForDistance(10_000), 'SAFE');
});

test('distance and server proximity use all three world axes', () => {
  const a = { x: 10, y: 20, z: 30 };
  const b = { x: 13, y: 24, z: 42 };
  closeTo(distance3D(a, b), 13);
  closeTo(distance3D(b, a), 13);

  const game = runningGame();
  const hunter = game.players.hunter!;
  // Exercise the spatial calculation directly, before movement constrains Y.
  // Equal X/Z must not make vertically separated players immediately close.
  const { immediate, danger, uneasy } = GAMEPLAY.proximity;
  for (const [verticalGap, expected] of [
    [immediate, 'IMMEDIATE'], [immediate + 1, 'DANGER'],
    [danger + 1, 'UNEASY'], [uneasy + 1, 'SAFE'],
  ] as const) {
    game.players.creature = { ...hunter, y: hunter.y + verticalGap };
    const snapshot = snapshotFor(game, 'hunter');
    assert.ok(snapshot.role === 'hunter');
    assert.equal(snapshot.proximity, expected);
    assertHunterPayload(snapshot);
    const creatureSnapshot = snapshotFor(game, 'creature');
    assert.ok(creatureSnapshot.role === 'creature');
    assert.deepEqual(creatureSnapshot.creature, game.players.creature);
  }
});

test('both roles move at configured speed, including diagonal movement', () => {
  for (const role of ['hunter', 'creature'] as const) {
    for (const keys of [{ right: true }, { right: true, down: true }]) {
      const game = runningGame();
      const start = { ...game.players[role]! };
      for (let tick = 0; tick < GAMEPLAY.tickRate; tick++) {
        assert.equal(setInput(game, role, input(game, keys)), true);
        stepGame(game);
      }
      const end = game.players[role]!;
      closeTo(distance3D(end, start), GAMEPLAY.speed[role]);
      assert.equal(end.y, groundedY);
      assert.equal(game.roundState, 'running');
    }
  }
});

test('opposing keys cancel and WASD moves along X/Z while staying grounded on Y', () => {
  const cases: Array<[Partial<Keys>, number, number]> = [
    [{ up: true }, 0, -1], [{ down: true }, 0, 1],
    [{ left: true }, -1, 0], [{ right: true }, 1, 0],
    [{ up: true, down: true }, 0, 0],
    [{ left: true, right: true }, 0, 0],
    [{ up: true, down: true, left: true, right: true }, 0, 0],
  ];
  for (const [keys, dx, dz] of cases) {
    const game = runningGame();
    const start = { ...game.players.hunter! };
    setInput(game, 'hunter', input(game, keys));
    stepGame(game);
    const step = GAMEPLAY.speed.hunter / GAMEPLAY.tickRate;
    closeTo(game.players.hunter!.x - start.x, dx * step);
    closeTo(game.players.hunter!.z - start.z, dz * step);
    assert.equal(game.players.hunter!.y, groundedY);
  }
});

test('the entire player shape stays within all four arena boundaries', () => {
  const { width, depth } = GAMEPLAY.arena;
  const radius = GAMEPLAY.playerRadius;
  for (const role of ['hunter', 'creature'] as const) {
    const other = role === 'hunter' ? 'creature' : 'hunter';
    for (const low of [true, false]) {
      const game = runningGame();
      game.players[role] = low
        ? groundPosition(radius, radius)
        : groundPosition(width - radius, depth - radius);
      game.players[other] = groundPosition(width / 2, depth / 2);
      const expected = { ...game.players[role]! };
      for (let tick = 0; tick < GAMEPLAY.tickRate; tick++) {
        setInput(game, role, input(game, low
          ? { up: true, left: true } : { down: true, right: true }));
        stepGame(game);
      }
      assert.deepEqual(game.players[role], expected);
      assert.equal(game.roundState, 'running');
    }
  }
});

test('sphere collision matches the four shared wall boxes even across a large step', () => {
  const { width, depth } = GAMEPLAY.arena;
  const radius = GAMEPLAY.playerRadius;
  const cases = [
    { position: groundPosition(-10_000, depth / 2), axis: 'x', sign: -1, face: ARENA_WALLS.west.max.x },
    { position: groundPosition(width + 10_000, depth / 2), axis: 'x', sign: 1, face: ARENA_WALLS.east.min.x },
    { position: groundPosition(width / 2, -10_000), axis: 'z', sign: -1, face: ARENA_WALLS.north.max.z },
    { position: groundPosition(width / 2, depth + 10_000), axis: 'z', sign: 1, face: ARENA_WALLS.south.min.z },
  ] as const;
  for (const { position, axis, sign, face } of cases) {
    const corrected = constrainToArena(position);
    closeTo(corrected[axis] + sign * radius, face);
    assert.equal(corrected.y, groundedY);
    assert.ok(corrected.x >= radius && corrected.x <= width - radius);
    assert.ok(corrected.z >= radius && corrected.z <= depth - radius);
  }
});

test('the server owns ground height with both held and released movement keys', () => {
  for (const keys of [{}, { right: true, down: true }]) {
    const game = runningGame();
    for (const role of ['hunter', 'creature'] as const) {
      game.players[role]!.y += 100;
      assert.equal(setInput(game, role, { ...input(game, keys), y: -1_000 }), false);
      assert.equal(setInput(game, role, { ...input(game, keys), z: 10_000 }), false);
      assert.equal(setInput(game, role, input(game, keys)), true);
    }
    stepGame(game);
    assert.equal(game.players.hunter!.y, groundedY);
    assert.equal(game.players.creature!.y, groundedY);
    assert.equal(game.roundState, 'running');
  }
});

test('touching ends the round, a small gap does not, and ended players cannot move', () => {
  const game = runningGame();
  game.players.hunter = groundPosition(400, 300);
  game.players.creature = groundPosition(400 + 2 * GAMEPLAY.playerRadius + 0.01, 300);
  stepGame(game);
  assert.equal(game.roundState, 'running');
  game.players.creature.x = 400 + 2 * GAMEPLAY.playerRadius;
  stepGame(game);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
  assert.equal(snapshotFor(game, 'hunter').result, 'caught');
  assert.equal(snapshotFor(game, 'creature').result, 'caught');
  const finalPositions = structuredClone(game.players);
  for (let tick = 0; tick < 10; tick++) {
    setInput(game, 'hunter', input(game, { right: true }));
    setInput(game, 'creature', input(game, { left: true }));
    stepGame(game);
  }
  assert.deepEqual(game.players, finalPositions);
});

test('inputs cannot supply positions, role, speed, elapsed time, or stale round commands', () => {
  const game = runningGame();
  const initialPlayers = structuredClone(game.players);
  const initialInput = structuredClone(game.inputs.hunter);
  const invalid: unknown[] = [
    null, [], true, 'right', {},
    { ...input(game), up: 1 }, { ...input(game), down: 'false' },
    { ...input(game), left: undefined },
    { ...input(game), roundId: game.roundId - 1 },
    { ...input(game), type: 'position', x: 900, y: 500, z: 500 },
    { ...input(game), x: 900, y: 500, z: 500 },
    { ...input(game), y: 500 },
    { ...input(game), z: 500 },
    { ...input(game), role: 'creature' },
    { ...input(game), speed: 99_999 },
    { ...input(game), deltaTime: 99_999 },
    { ...input(game), velocity: { x: 99_999, y: 99_999, z: 99_999 } },
  ];
  for (const raw of invalid) {
    assert.equal(setInput(game, 'hunter', raw), false);
    assert.deepEqual(game.inputs.hunter, initialInput);
    assert.deepEqual(game.players, initialPlayers);
  }
});

test('input flooding does not advance simulation or increase one tick of movement', () => {
  const game = runningGame();
  const start = { ...game.players.hunter! };
  for (let message = 0; message < 1_000; message++) {
    assert.equal(setInput(game, 'hunter', input(game, { right: true })), true);
  }
  assert.deepEqual(game.players.hunter, start);
  stepGame(game);
  closeTo(game.players.hunter!.x - start.x, GAMEPLAY.speed.hunter / GAMEPLAY.tickRate);
  closeTo(game.players.hunter!.y, start.y);
  closeTo(game.players.hunter!.z, start.z);
});

test('joining, leaving, and restarting preserve primitive two-player round rules', () => {
  const game = createGame();
  assert.equal(game.roundState, 'waiting');
  joinGame(game, 'hunter');
  const waitingPosition = { ...game.players.hunter! };
  setInput(game, 'hunter', input(game, { right: true }));
  stepGame(game);
  assert.deepEqual(game.players.hunter, waitingPosition);
  assert.equal(game.roundState, 'waiting');
  joinGame(game, 'creature');
  assert.equal(game.roundState, 'running');
  const oldRoundId = game.roundId;
  setInput(game, 'hunter', input(game, { right: true }));
  setInput(game, 'creature', input(game, { left: true }));
  restartGame(game);
  assert.equal(game.roundId, oldRoundId + 1);
  assert.equal(game.roundState, 'running');
  assert.equal(game.result, null);
  assert.ok(distance3D(game.players.hunter!, game.players.creature!) > 2 * GAMEPLAY.playerRadius);
  assert.equal(game.players.hunter!.y, groundedY);
  assert.equal(game.players.creature!.y, groundedY);
  const spawns = structuredClone(game.players);
  stepGame(game);
  assert.deepEqual(game.players, spawns, 'restart clears held inputs');
  assert.equal(setInput(game, 'hunter', { ...input(game), roundId: oldRoundId }), false);
  leaveGame(game, 'creature');
  assert.equal(game.players.creature, null);
  assert.equal(game.roundState, 'waiting');
  assert.equal(game.result, null);
  assertHunterPayload(snapshotFor(game, 'hunter'));
  joinGame(game, 'creature');
  assert.equal(game.roundState, 'running');
  const rejoinedSpawns = structuredClone(game.players);
  stepGame(game);
  assert.deepEqual(game.players, rejoinedSpawns);
});

test('Hunter payload contains only permitted data in every round state', () => {
  const game = createGame();
  assert.throws(() => snapshotFor(game, 'hunter'), /empty player slot/);
  joinGame(game, 'hunter');
  assertHunterPayload(snapshotFor(game, 'hunter'));
  joinGame(game, 'creature');
  assertHunterPayload(snapshotFor(game, 'hunter'));
  const creaturePayload = snapshotFor(game, 'creature');
  assert.ok(creaturePayload.role === 'creature');
  assert.deepEqual(Object.keys(creaturePayload).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'creature', 'hunter',
  ].sort());
  assert.deepEqual(creaturePayload.creature, game.players.creature);
  assert.deepEqual(creaturePayload.hunter, game.players.hunter);
  game.players.creature = { ...game.players.hunter! };
  stepGame(game);
  assert.equal(game.roundState, 'ended');
  assertHunterPayload(snapshotFor(game, 'hunter'));
  restartGame(game);
  assertHunterPayload(snapshotFor(game, 'hunter'));
  leaveGame(game, 'creature');
  assertHunterPayload(snapshotFor(game, 'hunter'));
});

test('glancing contact between tick endpoints still catches the Hunter', () => {
  const game = runningGame();
  const radius = GAMEPLAY.playerRadius * 2;
  game.players.hunter = groundPosition(400, 300);
  game.players.creature = groundPosition(396, 300 + radius - 0.1);
  assert.ok(Math.hypot(4, radius - 0.1) > radius);
  setInput(game, 'creature', input(game, { right: true }));
  stepGame(game);
  assert.ok(distance3D(game.players.creature!, game.players.hunter!) > radius,
    'neither tick endpoint overlaps');
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
});

test('swept sphere contact considers vertical separation and vertical crossings', () => {
  const hunter = groundPosition(400, 300);
  const diameter = 2 * GAMEPLAY.playerRadius;
  const separatedStart = { ...hunter, x: hunter.x - 80, y: hunter.y + diameter + 0.01 };
  const separatedEnd = { ...separatedStart, x: hunter.x + 80 };
  assert.equal(spheresTouchDuringStep(hunter, hunter, separatedStart, separatedEnd), false,
    'crossing in X/Z with a vertical gap cannot tag');
  assert.equal(spheresTouchDuringStep(hunter, hunter,
    { ...separatedStart, y: hunter.y + diameter },
    { ...separatedEnd, y: hunter.y + diameter }), true,
  'vertical tangency between endpoints counts as contact');
  assert.equal(spheresTouchDuringStep(hunter, hunter,
    { ...hunter, y: hunter.y + 80 }, { ...hunter, y: hunter.y - 80 }), true,
  'a vertical crossing is detected even when neither endpoint overlaps');
});

test('different hidden positions in the same proximity band produce identical Hunter messages', () => {
  const game = runningGame();
  game.players.hunter = groundPosition(GAMEPLAY.arena.width / 2, GAMEPLAY.arena.depth / 2);
  for (const distance of [40, 150, 280, 400]) {
    game.players.creature = groundPosition(game.players.hunter.x + distance, game.players.hunter.z);
    const first = JSON.stringify(snapshotFor(game, 'hunter'));
    // Change direction and exact distance without crossing a warning threshold.
    game.players.creature = groundPosition(game.players.hunter.x - distance - 1, game.players.hunter.z);
    const second = JSON.stringify(snapshotFor(game, 'hunter'));
    assert.equal(second, first);
  }
});

test('role snapshots cannot mutate or alias authoritative player positions', () => {
  const game = runningGame();
  const hunterSnapshot = snapshotFor(game, 'hunter');
  const creatureSnapshot = snapshotFor(game, 'creature');
  assert.ok(hunterSnapshot.role === 'hunter');
  assert.ok(creatureSnapshot.role === 'creature');
  const originalSnapshots = structuredClone([hunterSnapshot, creatureSnapshot]);

  game.players.hunter!.x += 10;
  game.players.hunter!.y += 20;
  game.players.hunter!.z += 30;
  game.players.creature!.x -= 10;
  game.players.creature!.y -= 20;
  game.players.creature!.z -= 30;
  assert.deepEqual([hunterSnapshot, creatureSnapshot], originalSnapshots,
    'later authoritative mutations do not rewrite snapshots already constructed');

  const authoritativePositions = structuredClone(game.players);
  hunterSnapshot.hunter.x = 999;
  creatureSnapshot.hunter!.y = 999;
  creatureSnapshot.creature.x = 999;
  creatureSnapshot.creature.z = 999;
  assert.deepEqual(game.players, authoritativePositions,
    'mutating outbound objects does not alter the simulation');
  assert.notEqual(creatureSnapshot.hunter!.x, hunterSnapshot.hunter.x,
    'the two roles do not share a mutable Hunter position object');
});
