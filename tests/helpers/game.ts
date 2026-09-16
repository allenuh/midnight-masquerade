// Test-only builders for five-player rounds: a started round, a staged encounter
// with H1 and the Creature at chosen positions, and role-specific snapshot readers.
// Nothing here is used by the game itself.
import assert from 'node:assert/strict';
import { GAMEPLAY } from '../../src/shared/gameplay-config.js';
import type { HunterSnapshot, HunterView, Position } from '../../src/shared/protocol.js';
import {
  createGame, setInput, snapshotFor, startRound, stepGame, type Game, type PlayerId,
} from '../../src/server/game.js';

export type Keys = { up: boolean; down: boolean; left: boolean; right: boolean; light: boolean };

export const PLAYERS: readonly PlayerId[] = ['p1', 'p2', 'p3', 'p4', 'p5'];
export const groundedY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;
export const groundPosition = (x: number, z: number): Position => ({ x, y: groundedY, z });

// Open floor at the east end of the south corridor, away from every position the tests
// stage, so idle Hunters never touch, light, or block anything.
export const PARKED: readonly Position[] = [groundPosition(700, 560), groundPosition(760, 560), groundPosition(820, 560)];

// A round for the five test players, stepped through the role reveal so it is running.
export function startedGame(): Game {
  const game = createGame();
  startRound(game, PLAYERS);
  while (game.roundState === 'reveal') stepGame(game);
  assert.equal(game.roundState, 'running');
  return game;
}

// A running round with H1 at `hunter`, the Creature at `creature`, and H2..H4 parked.
export function stageGame(hunter: Position, creature: Position, facing?: number): Game {
  const game = startedGame();
  game.hunters[0].position = { ...hunter };
  if (facing !== undefined) game.hunters[0].facing = facing;
  for (let slot = 1; slot < game.hunters.length; slot++) game.hunters[slot].position = { ...PARKED[slot - 1] };
  game.creature!.position = { ...creature };
  return game;
}

export const creatureId = (game: Game): PlayerId => game.creature!.player;
export const hunterId = (game: Game, slot = 0): PlayerId => game.hunters[slot].player;

// Every authoritative position, for "nothing moved" comparisons.
export function positions(game: Game) {
  return structuredClone({ hunters: game.hunters.map((hunter) => hunter.position), creature: game.creature?.position ?? null });
}

export function input(game: Game, keys: Partial<Keys> = {}) {
  return {
    type: 'input', roundId: game.roundId,
    up: false, down: false, left: false, right: false, light: false, ...keys,
  };
}

export function hold(game: Game, player: PlayerId, keys: Partial<Keys> = {}): void {
  assert.equal(setInput(game, player, input(game, keys)), true);
}

// Steps the round with H1 (while active) and the Creature holding the given keys; parked
// Hunters idle. A downed H1 has no input to hold, so its keys are simply not sent.
export function step(game: Game, ticks = 1, hunterKeys: Partial<Keys> = {}, creatureKeys: Partial<Keys> = {}): void {
  for (let tick = 0; tick < ticks; tick++) {
    if (game.roundState === 'running' && !game.hunters[0].down) hold(game, hunterId(game), hunterKeys);
    if (game.roundState === 'running') hold(game, creatureId(game), creatureKeys);
    stepGame(game);
  }
}

export function hunterView(game: Game, slot = 0): HunterSnapshot {
  const snapshot = snapshotFor(game, hunterId(game, slot));
  assert.ok(snapshot.role === 'hunter');
  return snapshot;
}

export function creatureView(game: Game) {
  const snapshot = snapshotFor(game, creatureId(game));
  assert.ok(snapshot.role === 'creature');
  return snapshot;
}

// The Hunter's own entry in its snapshot's team list.
export function ownView(snapshot: HunterSnapshot): HunterView {
  const own = snapshot.hunters.find((hunter) => hunter.id === snapshot.self);
  assert.ok(own, 'the snapshot lists its own Hunter');
  return own;
}

export function closeTo(actual: number, expected: number, tolerance = 1e-8): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
}

export const HUNTER_PAYLOAD_KEYS = [
  'type', 'role', 'roundId', 'roundState', 'result', 'hunters', 'timeRemaining', 'pickups',
  'self', 'proximity', 'creatureHp',
].sort();
export const CREATURE_PAYLOAD_KEYS = [
  'type', 'role', 'roundId', 'roundState', 'result', 'hunters', 'timeRemaining', 'pickups',
  'creature', 'hp', 'lit', 'revealed', 'staggered',
  'staggerCooldown', 'sprinting', 'sprintCooldown', 'attackCooldown',
].sort();
export const HUNTER_VIEW_KEYS = ['id', 'position', 'facing', 'light', 'battery', 'down', 'revive'].sort();

// Strict allowlist over the serialized Hunter payload, including every teammate entry.
// `creature` is optional: present only while the Creature is revealed.
export function assertHunterPayload(value: unknown): void {
  const payload = JSON.parse(JSON.stringify(value));
  const keys = Object.keys(payload).filter((key) => key !== 'creature').sort();
  assert.deepEqual(keys, HUNTER_PAYLOAD_KEYS);
  assert.equal(payload.type, 'snapshot');
  assert.equal(payload.role, 'hunter');
  assert.equal(typeof payload.roundId, 'number');
  assert.ok(['reveal', 'running', 'ended'].includes(payload.roundState));
  assert.ok(payload.result === null || ['caught', 'defeated', 'expired'].includes(payload.result));
  assert.ok(['H1', 'H2', 'H3', 'H4'].includes(payload.self));
  assert.ok(['SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE'].includes(payload.proximity));
  assert.equal(typeof payload.creatureHp, 'number');
  // The clock and the public pickup list: seconds and spawn-point indices, never positions.
  assert.equal(typeof payload.timeRemaining, 'number');
  assert.ok(payload.timeRemaining >= 0);
  assert.ok(Array.isArray(payload.pickups));
  // The map holds at most one battery, so this is either empty or a single valid point.
  assert.ok(payload.pickups.length <= 1, 'at most one battery is ever on the map');
  for (const index of payload.pickups) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < GAMEPLAY.batteryPickup.spawns.length);
  }
  assert.equal(payload.hunters.length, GAMEPLAY.players.hunters);
  assert.deepEqual(payload.hunters.map((hunter: { id: string }) => hunter.id), ['H1', 'H2', 'H3', 'H4']);
  for (const hunter of payload.hunters) {
    assert.deepEqual(Object.keys(hunter).sort(), HUNTER_VIEW_KEYS);
    assert.deepEqual(Object.keys(hunter.position).sort(), ['x', 'y', 'z']);
    assert.equal(typeof hunter.position.x, 'number');
    assert.equal(typeof hunter.position.y, 'number');
    assert.equal(typeof hunter.position.z, 'number');
    assert.equal(typeof hunter.facing, 'number');
    assert.equal(typeof hunter.light, 'boolean');
    assert.equal(typeof hunter.battery, 'number');
    assert.ok(hunter.battery >= 0 && hunter.battery <= GAMEPLAY.battery.max);
    if (hunter.battery === 0) assert.equal(hunter.light, false, 'an empty battery is never lit');
    assert.equal(typeof hunter.down, 'boolean');
    assert.equal(typeof hunter.revive, 'number');
    assert.ok(hunter.revive >= 0 && hunter.revive <= 1);
    if (!hunter.down) assert.equal(hunter.revive, 0);
  }
  if ('creature' in payload) {
    assert.deepEqual(Object.keys(payload.creature).sort(), ['position', 'sprinting', 'staggered']);
    assert.deepEqual(Object.keys(payload.creature.position).sort(), ['x', 'y', 'z']);
    assert.equal(typeof payload.creature.staggered, 'boolean');
    assert.equal(typeof payload.creature.sprinting, 'boolean');
  }
}
