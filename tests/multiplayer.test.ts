import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position } from '../src/shared/protocol.js';
import {
  HUNTER_IDS,
  PLAYER_COUNT,
  REVIVE_TICKS,
  abandonRound,
  activeHunters,
  allHuntersDown,
  createGame,
  downedHunters,
  flashlightReaches,
  isOnStaggerCooldown,
  isRevealed,
  isStaggered,
  roleOf,
  secondsToTicks,
  setInput,
  snapshotFor,
  startRound,
  stepGame,
  type Game,
} from '../src/server/game.js';
import {
  CREATURE_PAYLOAD_KEYS, HUNTER_VIEW_KEYS, PLAYERS, assertHunterPayload, closeTo, creatureId, creatureView, groundPosition,
  hold, hunterId, hunterView, input, ownView, positions, stageGame, startedGame, step,
  TEST_WORLD,
} from './helpers/game.js';

const radius = GAMEPLAY.playerRadius;
const damagePerTick = GAMEPLAY.flashlight.damagePerSecond / GAMEPLAY.tickRate;
const staggerTicks = secondsToTicks(GAMEPLAY.creature.staggerSeconds);
const cooldownTicks = secondsToTicks(GAMEPLAY.creature.staggerCooldownSeconds);
const lingerTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);
const attackCooldownTicks = secondsToTicks(GAMEPLAY.creature.attackCooldownSeconds);
const revealTicks = secondsToTicks(GAMEPLAY.roleRevealSeconds);
const EAST = 0;
const WEST = Math.PI;

// Open floor used by the encounters below (see the blockout in src/shared/arena.ts):
// the north corridor lane, both sides of the west slab, and a far corner for bystanders.
const LANE_WEST = groundPosition(100, 60);
const LANE_MIDDLE = groundPosition(200, 60);
const LANE_EAST = groundPosition(300, 60);
const FAR_CORNER = groundPosition(900, 500);
const WALL_WEST = groundPosition(280, 300);
const WALL_EAST = groundPosition(380, 300);

// Every player's view of the round: the four Hunter snapshots and the Creature's.
function allViews(game: Game) {
  return { hunters: game.hunters.map((_, slot) => hunterView(game, slot)), creature: creatureView(game) };
}

// Steps with the light held by exactly the given Hunter slots (which must be active);
// every other active Hunter releases its keys, since held input persists between steps.
function shine(game: Game, slots: number[], ticks = 1): void {
  for (let tick = 0; tick < ticks; tick++) {
    game.hunters.forEach((hunter, slot) => {
      if (!hunter.down) hold(game, hunterId(game, slot), { light: slots.includes(slot) });
    });
    stepGame(game);
  }
}

// Downs the given Hunter by contact, waiting out the attack cooldown first, and parks
// the Creature back at `retreat` afterwards.
function knockDown(game: Game, slot: number, retreat: Position): void {
  while (game.creatureState.attackCooldownTicks > 0) stepGame(game);
  game.creature!.position = { ...game.hunters[slot].position };
  stepGame(game);
  assert.equal(game.hunters[slot].down, true);
  game.creature!.position = { ...retreat };
}

test('a started round has exactly one Creature and four Hunters, each privately told its own role', () => {
  const game = createGame(TEST_WORLD);
  startRound(game, PLAYERS);
  assert.equal(PLAYER_COUNT, 5);
  assert.equal(game.hunters.length, GAMEPLAY.players.hunters);
  assert.deepEqual(game.hunters.map((hunter) => hunter.id), HUNTER_IDS);
  assert.ok(game.creature);
  assert.ok(PLAYERS.includes(game.creature.player));
  // Hunters keep the room's join order, skipping the Creature.
  assert.deepEqual(game.hunters.map((hunter) => hunter.player), PLAYERS.filter((player) => player !== game.creature!.player));
  const roles = PLAYERS.map((player) => roleOf(game, player));
  assert.equal(roles.filter((role) => role === 'creature').length, 1);
  assert.deepEqual(roles.filter((role) => role !== 'creature').sort(), [...HUNTER_IDS].sort());
  assert.equal(roleOf(game, 'someone-else'), null);
  for (const player of PLAYERS) {
    const snapshot = snapshotFor(game, player);
    assert.equal(snapshot.roundState, 'reveal');
    if (player === game.creature.player) {
      assert.equal(snapshot.role, 'creature');
    } else {
      assert.equal(snapshot.role, 'hunter');
      assert.ok(snapshot.role === 'hunter');
      assert.equal(snapshot.self, roleOf(game, player));
    }
    // Connection ids never reach any client; a Hunter cannot learn which slot a player has.
    const wire = JSON.stringify(snapshot);
    for (const id of PLAYERS) assert.equal(wire.includes(`"${id}"`), false);
  }
});

test('the Creature is chosen randomly on the server: every player is picked across repeated starts', () => {
  const game = createGame(TEST_WORLD);
  const chosen = new Set<string>();
  for (let round = 0; round < 200; round++) {
    startRound(game, PLAYERS);
    assert.equal(game.roundId, round + 1);
    chosen.add(game.creature!.player);
    assert.equal(game.hunters.length, GAMEPLAY.players.hunters);
    assert.equal(new Set([...game.hunters.map((hunter) => hunter.player), game.creature!.player]).size, PLAYER_COUNT);
  }
  assert.deepEqual([...chosen].sort(), [...PLAYERS].sort());
});

test('the role reveal counts down in simulation time, then the round runs', () => {
  const game = createGame(TEST_WORLD);
  startRound(game, PLAYERS);
  assert.equal(game.revealTicks, revealTicks);
  for (let tick = 1; tick < revealTicks; tick++) {
    stepGame(game);
    assert.equal(game.roundState, 'reveal', `still revealing at tick ${tick}`);
    assert.equal(creatureView(game).roundState, 'reveal');
  }
  stepGame(game);
  assert.equal(game.roundState, 'running');
  assert.equal(game.revealTicks, 0);
  assert.equal(hunterView(game).roundState, 'running');
});

test('each Hunter receives only its own proximity band, computed from its own distance', () => {
  const game = startedGame();
  game.creature!.position = groundPosition(480, 300);
  game.hunters[0].position = groundPosition(530, 300); // 50: IMMEDIATE
  game.hunters[1].position = groundPosition(586, 406); // 150: DANGER
  game.hunters[2].position = groundPosition(180, 300); // 300: UNEASY
  game.hunters[3].position = groundPosition(880, 300); // 400: SAFE
  const expected = ['IMMEDIATE', 'DANGER', 'UNEASY', 'SAFE'] as const;
  for (let slot = 0; slot < 4; slot++) {
    const snapshot = hunterView(game, slot);
    assert.equal(snapshot.proximity, expected[slot]);
    assertHunterPayload(snapshot);
    for (const teammate of snapshot.hunters) assert.deepEqual(Object.keys(teammate).sort(), HUNTER_VIEW_KEYS);
    const wire = JSON.stringify(snapshot);
    for (const band of expected) {
      assert.equal(wire.includes(band), band === expected[slot], `${snapshot.self} carries only its own band`);
    }
  }
  // The Creature's view carries no bands at all.
  const wire = JSON.stringify(creatureView(game));
  for (const band of expected) assert.equal(wire.includes(band), false);
});

test('no Hunter payload contains the hidden Creature transform, while every Hunter sees all four Hunters', () => {
  const game = startedGame();
  const creature = groundPosition(777, 333);
  game.creature!.position = { ...creature };
  game.hunters[0].position = groundPosition(100, 100);
  game.hunters[1].position = groundPosition(700, 560);
  game.hunters[2].position = groundPosition(760, 560);
  game.hunters[3].position = groundPosition(820, 560);
  step(game, 5, { up: true, light: true });
  for (let slot = 0; slot < 4; slot++) {
    const snapshot = hunterView(game, slot);
    assertHunterPayload(snapshot);
    assert.equal('creature' in snapshot, false);
    const wire = JSON.stringify(snapshot);
    assert.equal(wire.includes(String(creature.x)), false);
    assert.equal(wire.includes(String(creature.z)), false);
    assert.equal(/creature|velocity|rotation|transform|path/i.test(wire.replace('creatureHp', '')), false);
    assert.deepEqual(snapshot.hunters.map((hunter) => hunter.position), game.hunters.map((hunter) => hunter.position));
    assert.equal(snapshot.hunters[0].light, true);
  }
  const creatureSnapshot = creatureView(game);
  assert.deepEqual(Object.keys(creatureSnapshot).sort(), CREATURE_PAYLOAD_KEYS);
  assert.deepEqual(creatureSnapshot.hunters.map((hunter) => hunter.position), game.hunters.map((hunter) => hunter.position));
});

test('a valid Creature attack incapacitates an active Hunter without ending the round', () => {
  const game = stageGame(groundPosition(400, 300), groundPosition(400 + 2 * radius, 300));
  stepGame(game);
  assert.equal(game.hunters[0].down, true);
  assert.equal(game.hunters[0].reviveTicks, 0);
  assert.equal(game.roundState, 'running');
  assert.equal(game.result, null);
  assert.equal(activeHunters(game).length, 3);
  assert.equal(downedHunters(game).length, 1);
  assert.equal(allHuntersDown(game), false);
  assert.equal(game.creatureState.attackCooldownTicks, attackCooldownTicks);
  closeTo(creatureView(game).attackCooldown, GAMEPLAY.creature.attackCooldownSeconds);
  // Everyone in the round sees the same team state.
  const views = allViews(game);
  for (const view of [...views.hunters, views.creature]) {
    assert.deepEqual(view.hunters.map((hunter) => hunter.down), [true, false, false, false]);
    assert.equal(view.hunters[0].revive, 0);
    assert.equal(view.result, null);
  }
  assert.equal(ownView(views.hunters[0]).down, true);
  assert.equal(ownView(views.hunters[1]).down, false);
});

test('the attack cooldown downs at most one Hunter per cooldown, and hitting a downed Hunter does nothing', () => {
  const game = stageGame(groundPosition(400, 300), groundPosition(400 + 2 * radius, 300));
  // H2 shares H1's spot: both overlap the Creature in the same step.
  game.hunters[1].position = groundPosition(400, 300);
  stepGame(game);
  assert.equal(game.hunters[0].down, true, 'the lower slot is downed first');
  assert.equal(game.hunters[1].down, false);
  // Still overlapping through the cooldown: nothing more happens until it expires.
  step(game, attackCooldownTicks - 1);
  assert.equal(game.hunters[1].down, false);
  assert.equal(game.creatureState.attackCooldownTicks, 1);
  step(game, 1);
  assert.equal(game.hunters[1].down, true);
  assert.equal(game.roundState, 'running');

  // Overlapping only downed Hunters: no new cooldown, no change to their state.
  game.hunters[1].position = groundPosition(700, 560);
  step(game, attackCooldownTicks);
  assert.equal(game.creatureState.attackCooldownTicks, 0);
  step(game, 30);
  assert.equal(game.creatureState.attackCooldownTicks, 0);
  assert.deepEqual(game.hunters.map((hunter) => hunter.down), [true, true, false, false]);
  assert.equal(game.hunters[0].reviveTicks, 0);
});

test('all four Hunters down at once is a Creature victory that ends the round immediately', () => {
  const game = stageGame(groundPosition(100, 100), FAR_CORNER);
  for (let slot = 0; slot < 3; slot++) {
    knockDown(game, slot, FAR_CORNER);
    assert.equal(game.roundState, 'running', `${slot + 1} down is not a loss`);
    assert.equal(game.result, null);
  }
  assert.equal(activeHunters(game).length, 1);
  knockDown(game, 3, FAR_CORNER);
  assert.equal(allHuntersDown(game), true);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
  const views = allViews(game);
  for (const view of [...views.hunters, views.creature]) {
    assert.equal(view.roundState, 'ended');
    assert.equal(view.result, 'caught');
  }
  // Combat and movement stop; a hidden Creature stays hidden after winning.
  assert.equal(isRevealed(game.creatureState), false);
  for (const view of views.hunters) assert.equal('creature' in view, false);
  const frozen = positions(game);
  assert.equal(setInput(game, creatureId(game), input(game, { left: true })), false);
  step(game, 10);
  assert.deepEqual(positions(game), frozen);
});

test('an incapacitated Hunter cannot move, turn, shine, or revive, and its stored input is ignored', () => {
  // H1 faces east down the lane with the Creature inside its beam; H2 lies down in the beam too.
  const game = stageGame(LANE_WEST, LANE_MIDDLE, EAST);
  game.hunters[1].position = { ...LANE_EAST };
  game.hunters[1].down = true;
  knockDown(game, 0, LANE_MIDDLE);
  const downed = game.hunters[0];
  const before = { position: { ...downed.position }, facing: downed.facing };
  assert.equal(setInput(game, hunterId(game), input(game, { right: true, light: true })), false);
  assert.equal(setInput(game, hunterId(game), input(game, { up: true })), false);
  // Even input written straight into the record (a key held before going down) does nothing.
  downed.input = { up: false, down: true, left: false, right: true, light: true };
  step(game, 30);
  assert.deepEqual(downed.position, before.position);
  assert.equal(downed.facing, before.facing);
  assert.equal(flashlightReaches(TEST_WORLD, downed.position, downed.facing, game.creature!.position), true, 'the Creature sits in the dead beam');
  assert.equal(game.creatureState.lit, false);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(isRevealed(game.creatureState), false);
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(game.hunters[1].reviveTicks, 0, 'a downed Hunter revives nobody');
  for (const view of [...allViews(game).hunters, creatureView(game)]) {
    assert.equal(view.hunters[0].light, false);
    assert.equal(view.hunters[0].down, true);
  }
  assert.equal('creature' in hunterView(game), false);
});

test('flashlight exposure adds revival progress, keeps it while the light is away, and restores the Hunter', () => {
  const game = stageGame(LANE_MIDDLE, FAR_CORNER);
  game.hunters[1].position = { ...LANE_WEST };
  game.hunters[1].facing = EAST;
  knockDown(game, 0, FAR_CORNER);
  const downed = game.hunters[0];
  assert.equal(flashlightReaches(TEST_WORLD, game.hunters[1].position, game.hunters[1].facing, downed.position), true);

  shine(game, [1], 30);
  assert.equal(downed.reviveTicks, 30);
  assert.equal(downed.down, true);
  for (const view of [...allViews(game).hunters, creatureView(game)]) closeTo(view.hunters[0].revive, 30 / REVIVE_TICKS);
  closeTo(ownView(hunterView(game)).revive, 30 / REVIVE_TICKS);

  // Light off: progress stays where it is rather than resetting.
  shine(game, [], 45);
  assert.equal(downed.reviveTicks, 30);
  assert.equal(downed.down, true);
  // Facing away: the beam no longer covers the body, so nothing accrues either.
  game.hunters[1].facing = WEST;
  shine(game, [1], 10);
  assert.equal(downed.reviveTicks, 30);
  game.hunters[1].facing = EAST;

  shine(game, [1], REVIVE_TICKS - 30 - 1);
  assert.equal(downed.reviveTicks, REVIVE_TICKS - 1);
  assert.equal(downed.down, true);
  shine(game, [1], 1);
  assert.equal(downed.down, false);
  assert.equal(downed.reviveTicks, 0);
  assert.equal(activeHunters(game).length, 4);
  assert.equal(ownView(hunterView(game)).down, false);
  assert.equal(ownView(hunterView(game)).revive, 0);
  // Back in the game: inputs are accepted again and the body moves.
  const x = downed.position.x;
  step(game, 1, { right: true });
  closeTo(downed.position.x - x, GAMEPLAY.speed.hunter / GAMEPLAY.tickRate);
  // Further light on an active Hunter accrues nothing.
  shine(game, [1], 10);
  assert.equal(downed.reviveTicks, 0);
});

test('two beams on the same body stack the revival rate', () => {
  const game = stageGame(LANE_MIDDLE, FAR_CORNER);
  game.hunters[1].position = { ...LANE_WEST };
  game.hunters[1].facing = EAST;
  game.hunters[2].position = { ...LANE_EAST };
  game.hunters[2].facing = WEST;
  knockDown(game, 0, FAR_CORNER);
  const downed = game.hunters[0];
  shine(game, [1, 2], 10);
  assert.equal(downed.reviveTicks, 20);
  shine(game, [1], 10);
  assert.equal(downed.reviveTicks, 30);
  assert.ok(REVIVE_TICKS % 2 === 0, 'the check below assumes an even work total');
  shine(game, [1, 2], (REVIVE_TICKS - 30) / 2 - 1);
  assert.equal(downed.down, true);
  shine(game, [1, 2], 1);
  assert.equal(downed.down, false);
});

test('revival does not work through walls', () => {
  const game = stageGame(WALL_EAST, FAR_CORNER);
  game.hunters[1].position = { ...WALL_WEST };
  game.hunters[1].facing = EAST;
  knockDown(game, 0, FAR_CORNER);
  const downed = game.hunters[0];
  assert.equal(flashlightReaches(TEST_WORLD, game.hunters[1].position, game.hunters[1].facing, downed.position), false, 'the slab blocks the beam');
  shine(game, [1], 60);
  assert.equal(downed.reviveTicks, 0);
  assert.equal(downed.down, true);
  // Through the opening beside the slab the identical offset revives.
  downed.position = groundPosition(380, 180);
  game.hunters[1].position = groundPosition(280, 180);
  shine(game, [1], 60);
  assert.equal(downed.reviveTicks, 60);
});

test('Creature HP reaching zero under any Hunter beam is a Hunter victory for every client', () => {
  // H2, not H1, delivers the final light.
  const game = stageGame(FAR_CORNER, LANE_MIDDLE);
  game.hunters[1].position = { ...LANE_WEST };
  game.hunters[1].facing = EAST;
  game.creatureState.hp = damagePerTick * 1.5;
  shine(game, [1], 1);
  assert.equal(game.roundState, 'running');
  shine(game, [1], 1);
  assert.equal(game.creatureState.hp, 0);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'defeated');
  const views = allViews(game);
  for (const view of [...views.hunters, views.creature]) assert.equal(view.result, 'defeated');
  for (const view of views.hunters) assert.equal(view.creatureHp, 0);
  assert.equal(views.creature.hp, 0);
});

test('multiple beams damage once per step, keep the reveal fresh, and never bypass the stagger cooldown', () => {
  // H1 faces east and H2 faces west along the lane; the Creature sits between them, in both beams.
  const game = stageGame(LANE_WEST, LANE_MIDDLE, EAST);
  game.hunters[1].position = { ...LANE_EAST };
  game.hunters[1].facing = WEST;
  const state = game.creatureState;
  assert.equal(flashlightReaches(TEST_WORLD, game.hunters[1].position, game.hunters[1].facing, game.creature!.position), true);

  shine(game, [0, 1], 1);
  assert.equal(state.lit, true);
  closeTo(state.hp, GAMEPLAY.creature.maxHp - damagePerTick, 1e-9);
  assert.equal(state.staggerTicks, staggerTicks);
  assert.equal(state.staggerCooldownTicks, cooldownTicks);
  assert.equal(state.revealTicks, lingerTicks);
  for (const view of allViews(game).hunters) assert.equal(view.creature?.staggered, true);

  // Both beams held through the stagger and the whole cooldown: exactly one damage tick per
  // step, the linger refreshed every step, and no second stagger.
  let hp = state.hp;
  for (let tick = 1; tick < cooldownTicks; tick++) {
    shine(game, [0, 1], 1);
    closeTo(state.hp, hp - damagePerTick, 1e-9);
    hp = state.hp;
    assert.equal(state.revealTicks, lingerTicks);
    assert.equal(state.staggerTicks, Math.max(0, staggerTicks - tick), `no re-stagger at tick ${tick}`);
    assert.equal(isOnStaggerCooldown(state), true);
  }
  // A third beam joining in the last cooldown step changes nothing either.
  game.hunters[2].position = groundPosition(200, 130);
  game.hunters[2].facing = -Math.PI / 2;
  assert.equal(flashlightReaches(TEST_WORLD, game.hunters[2].position, game.hunters[2].facing, game.creature!.position), true);
  assert.equal(isStaggered(state), false);
  // The cooldown expires on this step, so the next lit step staggers again: once.
  shine(game, [0, 1, 2], 1);
  assert.equal(isStaggered(state), true);
  assert.equal(state.staggerTicks, staggerTicks);
  assert.equal(state.staggerCooldownTicks, cooldownTicks);
  closeTo(state.hp, hp - damagePerTick, 1e-9);
});

test('a sprinting Creature is sent to all four Hunters, and leaves all four payloads after the linger', () => {
  // Coordinates chosen so neither digit string can appear elsewhere in a Hunter payload.
  const game = stageGame(groundPosition(900, 60), groundPosition(130, 530));
  step(game, 1, {}, { light: true });
  assert.equal(game.creatureState.sprinting, true);
  const seenAt = { ...game.creature!.position };
  for (let slot = 0; slot < 4; slot++) {
    const view = hunterView(game, slot);
    assert.deepEqual(view.creature, { position: seenAt, staggered: false, sprinting: true });
    assert.equal(view.creatureHp, GAMEPLAY.creature.maxHp);
    assertHunterPayload(view);
  }
  // Release: every Hunter keeps the position for the linger, then loses the key together.
  for (let tick = 1; tick < lingerTicks; tick++) {
    step(game, 1);
    for (let slot = 0; slot < 4; slot++) {
      assert.deepEqual(hunterView(game, slot).creature, { position: seenAt, staggered: false, sprinting: false });
    }
  }
  step(game, 1);
  for (let slot = 0; slot < 4; slot++) {
    const view = hunterView(game, slot);
    assert.equal('creature' in view, false);
    const wire = JSON.stringify(view);
    assert.equal(wire.includes(String(seenAt.x)), false);
    assert.equal(wire.includes(String(seenAt.z)), false);
    assert.equal(wire.includes('sprint'), false);
  }
  assert.equal(creatureView(game).revealed, false);
});

test('a flashlight reveal reaches every Hunter and ends for every Hunter together', () => {
  const game = stageGame(LANE_WEST, LANE_MIDDLE, EAST);
  step(game, 1, { light: true });
  const seenAt = { ...game.creature!.position };
  for (let slot = 0; slot < 4; slot++) assert.deepEqual(hunterView(game, slot).creature?.position, seenAt);
  step(game, lingerTicks);
  for (let slot = 0; slot < 4; slot++) assert.equal('creature' in hunterView(game, slot), false);
});

test('abandoning a round mid-fight forgets every role and state; the next start is fresh', () => {
  const game = stageGame(LANE_MIDDLE, LANE_WEST);
  game.hunters[1].position = { ...LANE_WEST };
  game.hunters[1].facing = EAST;
  knockDown(game, 0, FAR_CORNER);
  shine(game, [1], 20);
  assert.equal(game.hunters[0].reviveTicks, 20);
  const roundId = game.roundId;
  abandonRound(game);
  assert.equal(game.roundState, 'lobby');
  assert.equal(game.roundId, roundId);
  assert.equal(game.hunters.length, 0);
  assert.ok(game.creature === null);
  assert.equal(game.result, null);
  for (const player of PLAYERS) {
    assert.equal(roleOf(game, player), null);
    assert.throws(() => snapshotFor(game, player), /without a role/);
    assert.equal(setInput(game, player, input(game, { right: true })), false);
  }
  stepGame(game);
  assert.equal(game.roundState, 'lobby');
  startRound(game, PLAYERS);
  assert.equal(game.roundId, roundId + 1);
  assert.equal(game.roundState, 'reveal');
  assert.equal(game.hunters.every((hunter) => !hunter.down && hunter.reviveTicks === 0), true);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
});
