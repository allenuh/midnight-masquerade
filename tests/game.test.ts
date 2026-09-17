import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import { constrainToArena, distance3D, spheresTouchDuringStep } from '../src/server/spatial.js';
import {
  abandonRound,
  createGame,
  proximityForDistance,
  setInput,
  snapshotFor,
  startRound,
  stepGame,
  type Game,
} from '../src/server/game.js';
import {
  CREATURE_PAYLOAD_KEYS, PLAYERS, assertHunterPayload, closeTo, creatureId, creatureView, groundPosition, groundedY,
  hunterId, hunterView, input, ownView, positions, stageGame, type Keys,
  TEST_WORLD,
} from './helpers/game.js';

type Role = 'hunter' | 'creature';

// The Prototype 1 chase, staged in a five-player round: H1 is "the Hunter", the other
// three Hunters stand parked on open floor of the obstacle blockout (see src/shared/arena.ts).
function runningGame(): Game {
  return stageGame(groundPosition(100, 100), groundPosition(660, 300));
}

const playerOf = (game: Game, role: Role) => (role === 'hunter' ? hunterId(game) : creatureId(game));
const positionOf = (game: Game, role: Role) => (role === 'hunter' ? game.hunters[0].position : game.creature!.position);
function place(game: Game, role: Role, position: { x: number; y: number; z: number }): void {
  if (role === 'hunter') game.hunters[0].position = position;
  else game.creature!.position = position;
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
  const hunter = game.hunters[0].position;
  // Exercise the spatial calculation directly, before movement constrains Y.
  // Equal X/Z must not make vertically separated players immediately close.
  const { immediate, danger, uneasy } = GAMEPLAY.proximity;
  for (const [verticalGap, expected] of [
    [immediate, 'IMMEDIATE'], [immediate + 1, 'DANGER'],
    [danger + 1, 'UNEASY'], [uneasy + 1, 'SAFE'],
  ] as const) {
    game.creature!.position = { ...hunter, y: hunter.y + verticalGap };
    const snapshot = hunterView(game);
    assert.equal(snapshot.proximity, expected);
    assertHunterPayload(snapshot);
    assert.deepEqual(creatureView(game).creature, game.creature!.position);
  }
});

test('both roles move at configured speed, including diagonal movement', () => {
  for (const role of ['hunter', 'creature'] as const) {
    for (const keys of [{ right: true }, { right: true, down: true }]) {
      const game = runningGame();
      const start = { ...positionOf(game, role) };
      for (let tick = 0; tick < GAMEPLAY.tickRate; tick++) {
        assert.equal(setInput(game, playerOf(game, role), input(game, keys)), true);
        stepGame(game);
      }
      const end = positionOf(game, role);
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
    const start = { ...game.hunters[0].position };
    setInput(game, hunterId(game), input(game, keys));
    stepGame(game);
    const step = GAMEPLAY.speed.hunter / GAMEPLAY.tickRate;
    closeTo(game.hunters[0].position.x - start.x, dx * step);
    closeTo(game.hunters[0].position.z - start.z, dz * step);
    assert.equal(game.hunters[0].position.y, groundedY);
  }
});

test('the entire player shape stays within all four arena boundaries', () => {
  const { width, depth } = TEST_WORLD;
  const radius = GAMEPLAY.playerRadius;
  for (const role of ['hunter', 'creature'] as const) {
    const other = role === 'hunter' ? 'creature' : 'hunter';
    for (const low of [true, false]) {
      const game = runningGame();
      place(game, role, low
        ? groundPosition(radius, radius)
        : groundPosition(width - radius, depth - radius));
      place(game, other, groundPosition(width / 2, depth / 2));
      const expected = { ...positionOf(game, role) };
      for (let tick = 0; tick < GAMEPLAY.tickRate; tick++) {
        setInput(game, playerOf(game, role), input(game, low
          ? { up: true, left: true } : { down: true, right: true }));
        stepGame(game);
      }
      assert.deepEqual(positionOf(game, role), expected);
      assert.equal(game.roundState, 'running');
    }
  }
});

test('sphere collision matches the four shared wall boxes even across a large step', () => {
  const { width, depth, walls } = TEST_WORLD;
  const radius = GAMEPLAY.playerRadius;
  const cases = [
    { position: groundPosition(-10_000, depth / 2), axis: 'x', sign: -1, face: walls.west.max.x },
    { position: groundPosition(width + 10_000, depth / 2), axis: 'x', sign: 1, face: walls.east.min.x },
    { position: groundPosition(width / 2, -10_000), axis: 'z', sign: -1, face: walls.north.max.z },
    { position: groundPosition(width / 2, depth + 10_000), axis: 'z', sign: 1, face: walls.south.min.z },
  ] as const;
  for (const { position, axis, sign, face } of cases) {
    const corrected = constrainToArena(TEST_WORLD, position);
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
      positionOf(game, role).y += 100;
      assert.equal(setInput(game, playerOf(game, role), { ...input(game, keys), y: -1_000 }), false);
      assert.equal(setInput(game, playerOf(game, role), { ...input(game, keys), z: 10_000 }), false);
      assert.equal(setInput(game, playerOf(game, role), input(game, keys)), true);
    }
    stepGame(game);
    assert.equal(game.hunters[0].position.y, groundedY);
    assert.equal(game.creature!.position.y, groundedY);
    assert.equal(game.roundState, 'running');
  }
});

test('touching downs the Hunter, a small gap does not, the last Hunter down ends the round, and ended players cannot move', () => {
  const game = runningGame();
  game.hunters[0].position = groundPosition(400, 300);
  game.creature!.position = groundPosition(400 + 2 * GAMEPLAY.playerRadius + 0.01, 300);
  stepGame(game);
  assert.equal(game.hunters[0].down, false);
  assert.equal(game.roundState, 'running');
  game.creature!.position.x = 400 + 2 * GAMEPLAY.playerRadius;
  stepGame(game);
  // Prototype 3: contact incapacitates rather than ending the round.
  assert.equal(game.hunters[0].down, true);
  assert.equal(game.roundState, 'running');
  assert.equal(game.result, null);
  assert.equal(ownView(hunterView(game)).down, true);
  assert.equal(creatureView(game).hunters[0].down, true);

  // With every other Hunter already down, the same contact rule ends the round.
  for (const hunter of game.hunters.slice(1, 3)) hunter.down = true;
  const last = game.hunters[3];
  game.creature!.position = groundPosition(last.position.x - 2 * GAMEPLAY.playerRadius - 0.01, last.position.z);
  stepGame(game);
  assert.equal(game.roundState, 'running');
  // The attack cooldown from the first tag must have expired; wait it out, then touch.
  while (game.creatureState.attackCooldownTicks > 0) stepGame(game);
  game.creature!.position = groundPosition(last.position.x - 2 * GAMEPLAY.playerRadius, last.position.z);
  stepGame(game);
  assert.equal(last.down, true);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
  assert.equal(hunterView(game).result, 'caught');
  assert.equal(creatureView(game).result, 'caught');
  const finalPositions = positions(game);
  for (let tick = 0; tick < 10; tick++) {
    setInput(game, hunterId(game), input(game, { right: true }));
    setInput(game, creatureId(game), input(game, { left: true }));
    stepGame(game);
  }
  assert.deepEqual(positions(game), finalPositions);
});

test('inputs cannot supply positions, role, speed, elapsed time, or stale round commands', () => {
  const game = runningGame();
  const initialPositions = positions(game);
  const initialInput = structuredClone(game.hunters[0].input);
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
    { ...input(game), self: 'H2' },
    { ...input(game), speed: 99_999 },
    { ...input(game), deltaTime: 99_999 },
    { ...input(game), velocity: { x: 99_999, y: 99_999, z: 99_999 } },
    { ...input(game), revive: 1 },
  ];
  for (const raw of invalid) {
    assert.equal(setInput(game, hunterId(game), raw), false);
    assert.deepEqual(game.hunters[0].input, initialInput);
    assert.deepEqual(positions(game), initialPositions);
  }
  // A connection that is not in the round has no role and no input.
  assert.equal(setInput(game, 'p999', input(game, { right: true })), false);
});

test('input flooding does not advance simulation or increase one tick of movement', () => {
  const game = runningGame();
  const start = { ...game.hunters[0].position };
  for (let message = 0; message < 1_000; message++) {
    assert.equal(setInput(game, hunterId(game), input(game, { right: true })), true);
  }
  assert.deepEqual(game.hunters[0].position, start);
  stepGame(game);
  closeTo(game.hunters[0].position.x - start.x, GAMEPLAY.speed.hunter / GAMEPLAY.tickRate);
  closeTo(game.hunters[0].position.y, start.y);
  closeTo(game.hunters[0].position.z, start.z);
});

test('starting, abandoning, and restarting rounds preserve the primitive round rules', () => {
  const game = createGame(TEST_WORLD);
  assert.equal(game.roundState, 'lobby');
  assert.equal(game.hunters.length, 0);
  assert.ok(game.creature === null);
  assert.throws(() => startRound(game, PLAYERS.slice(0, 4)), /exactly 5 distinct players/);
  assert.throws(() => startRound(game, [...PLAYERS.slice(0, 4), 'p1']), /exactly 5 distinct players/);
  assert.equal(game.roundState, 'lobby');

  startRound(game, PLAYERS);
  assert.equal(game.roundState, 'reveal');
  assert.equal(game.roundId, 1);
  // Nobody moves during the role reveal: inputs are rejected and positions hold.
  const revealPositions = positions(game);
  assert.equal(setInput(game, hunterId(game), input(game, { right: true })), false);
  assert.equal(setInput(game, creatureId(game), input(game, { left: true })), false);
  stepGame(game);
  assert.deepEqual(positions(game), revealPositions);
  while (game.roundState === 'reveal') stepGame(game);
  assert.equal(game.roundState, 'running');
  assert.deepEqual(positions(game), revealPositions);

  const oldRoundId = game.roundId;
  setInput(game, hunterId(game), input(game, { right: true }));
  setInput(game, creatureId(game), input(game, { left: true }));
  startRound(game, PLAYERS);
  assert.equal(game.roundId, oldRoundId + 1);
  assert.equal(game.roundState, 'reveal');
  assert.equal(game.result, null);
  for (const hunter of game.hunters) {
    assert.ok(distance3D(hunter.position, game.creature!.position) > 2 * GAMEPLAY.playerRadius);
    assert.equal(hunter.position.y, groundedY);
  }
  assert.equal(game.creature!.position.y, groundedY);
  while (game.roundState === 'reveal') stepGame(game);
  const spawns = positions(game);
  stepGame(game);
  assert.deepEqual(positions(game), spawns, 'restart clears held inputs');
  assert.equal(setInput(game, hunterId(game), { ...input(game), roundId: oldRoundId }), false);

  abandonRound(game);
  assert.equal(game.roundState, 'lobby');
  assert.equal(game.hunters.length, 0);
  assert.ok(game.creature === null);
  assert.equal(game.result, null);
  assert.throws(() => snapshotFor(game, PLAYERS[0]), /without a role/);
  startRound(game, PLAYERS);
  assert.equal(game.roundId, oldRoundId + 2);
  while (game.roundState === 'reveal') stepGame(game);
  assert.equal(game.roundState, 'running');
  const rejoinedSpawns = positions(game);
  stepGame(game);
  assert.deepEqual(positions(game), rejoinedSpawns);
});

test('Hunter payload contains only permitted data in every round state', () => {
  const game = createGame(TEST_WORLD);
  assert.throws(() => snapshotFor(game, PLAYERS[0]), /without a role/);
  startRound(game, PLAYERS);
  for (let slot = 0; slot < game.hunters.length; slot++) assertHunterPayload(hunterView(game, slot));
  while (game.roundState === 'reveal') stepGame(game);
  for (let slot = 0; slot < game.hunters.length; slot++) assertHunterPayload(hunterView(game, slot));
  const creaturePayload = creatureView(game);
  assert.deepEqual(Object.keys(creaturePayload).sort(), CREATURE_PAYLOAD_KEYS);
  assert.deepEqual(creaturePayload.creature, game.creature!.position);
  assert.deepEqual(creaturePayload.hunters.map((hunter) => hunter.position), game.hunters.map((hunter) => hunter.position));
  // Down every Hunter by contact, one per attack cooldown, checking the payload throughout.
  for (const hunter of game.hunters) {
    while (game.creatureState.attackCooldownTicks > 0) stepGame(game);
    game.creature!.position = { ...hunter.position };
    stepGame(game);
    assert.equal(hunter.down, true);
    for (let slot = 0; slot < game.hunters.length; slot++) assertHunterPayload(hunterView(game, slot));
  }
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
  startRound(game, PLAYERS);
  for (let slot = 0; slot < game.hunters.length; slot++) assertHunterPayload(hunterView(game, slot));
  abandonRound(game);
  assert.throws(() => snapshotFor(game, PLAYERS[0]), /without a role/);
});

test('glancing contact between tick endpoints still downs the Hunter', () => {
  const game = runningGame();
  const radius = GAMEPLAY.playerRadius * 2;
  // One Creature step centred on the Hunter's X, passing so close that only the
  // mid-step approach is inside the contact radius. Derived from the configured
  // speed so retuning cannot move either endpoint into contact.
  const halfStep = GAMEPLAY.speed.creature / GAMEPLAY.tickRate / 2;
  const sideOffset = Math.sqrt(radius * radius - (halfStep / 2) ** 2);
  game.hunters[0].position = groundPosition(400, 300);
  game.creature!.position = groundPosition(400 - halfStep, 300 + sideOffset);
  assert.ok(Math.hypot(halfStep, sideOffset) > radius);
  setInput(game, creatureId(game), input(game, { right: true }));
  stepGame(game);
  assert.ok(distance3D(game.creature!.position, game.hunters[0].position) > radius,
    'neither tick endpoint overlaps');
  assert.equal(game.hunters[0].down, true);
  assert.equal(game.roundState, 'running');
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
  game.hunters[0].position = groundPosition(TEST_WORLD.width / 2, TEST_WORLD.depth / 2);
  for (const distance of [40, 150, 280, 400]) {
    game.creature!.position = groundPosition(game.hunters[0].position.x + distance, game.hunters[0].position.z);
    const first = JSON.stringify(hunterView(game));
    // Change direction and exact distance without crossing a warning threshold.
    game.creature!.position = groundPosition(game.hunters[0].position.x - distance - 1, game.hunters[0].position.z);
    const second = JSON.stringify(hunterView(game));
    assert.equal(second, first);
  }
});

test('role snapshots cannot mutate or alias authoritative player positions', () => {
  const game = runningGame();
  const hunterSnapshot = hunterView(game);
  const creatureSnapshot = creatureView(game);
  const originalSnapshots = structuredClone([hunterSnapshot, creatureSnapshot]);

  game.hunters[0].position.x += 10;
  game.hunters[0].position.y += 20;
  game.hunters[0].position.z += 30;
  game.creature!.position.x -= 10;
  game.creature!.position.y -= 20;
  game.creature!.position.z -= 30;
  assert.deepEqual([hunterSnapshot, creatureSnapshot], originalSnapshots,
    'later authoritative mutations do not rewrite snapshots already constructed');

  const authoritativePositions = positions(game);
  ownView(hunterSnapshot).position.x = 999;
  hunterSnapshot.hunters[1].position.z = 999;
  creatureSnapshot.hunters[0].position.y = 999;
  creatureSnapshot.creature.x = 999;
  creatureSnapshot.creature.z = 999;
  assert.deepEqual(positions(game), authoritativePositions,
    'mutating outbound objects does not alter the simulation');
  assert.notEqual(creatureSnapshot.hunters[0].position.x, ownView(hunterSnapshot).position.x,
    'the two roles do not share a mutable Hunter position object');
  assert.notEqual(hunterView(game, 1).hunters[0].position, hunterView(game).hunters[0].position,
    'two Hunters do not share a mutable teammate position object');
});
