import assert from 'node:assert/strict';
import test from 'node:test';
import { flashlightRange, flashlightStage } from '../src/shared/flashlight.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position } from '../src/shared/protocol.js';
import {
  MATCH_SECONDS,
  MATCH_TICKS,
  PICKUP_FIRST_SPAWN_TICKS,
  PICKUP_REACH,
  PICKUP_RESPAWN_TICKS,
  REVIVE_TICKS,
  STEP_SECONDS,
  abandonRound,
  activePickups,
  createGame,
  flashlightReaches,
  isRevealed,
  isStaggered,
  snapshotFor,
  startRound,
  stepGame,
  type Game,
} from '../src/server/game.js';
import {
  PLAYERS, assertHunterPayload, closeTo, creatureView, groundPosition, hold, hunterId, hunterView, ownView, positions,
  stageGame, startedGame, step,
  TEST_WORLD,
} from './helpers/game.js';

const { max: maxBattery, drainPerSecond } = GAMEPLAY.battery;
const drainPerTick = drainPerSecond / GAMEPLAY.tickRate;
const damagePerTick = GAMEPLAY.flashlight.damagePerSecond / GAMEPLAY.tickRate;
const fullRange = GAMEPLAY.flashlight.range;
const EAST = 0;

// The north corridor lane (see maps/test-arena.json): open for the whole arena width.
const LANE_HUNTER = groundPosition(100, 60);
// 90 units ahead: inside the FULL cone (90 - radius <= 90) but outside the HALF one
// (90 - radius > 63), so the same geometry reads differently per battery stage.
const STAGE_CREATURE = groundPosition(190, 60);
// 60 units ahead: inside FULL and HALF, outside LOW (60 - radius > 31.5).
const LANE_CREATURE = groundPosition(160, 60);
const FAR_CORNER = groundPosition(900, 500);

const batteryOf = (game: Game, slot = 0): number => game.hunters[slot].battery;
const pickupAt = (index: number): Position => TEST_WORLD.batterySpawns[index];

// A running round with the battery forced onto the given point, H1 standing on it, and
// the Creature parked far away. Forcing `at` skips the spawn delay and the randomness.
function pickupGame(index: number): Game {
  const game = stageGame(pickupAt(index), FAR_CORNER);
  game.pickup.at = index;
  return game;
}

test('the flashlight stages follow the configured battery thresholds, and an empty battery is OFF', () => {
  assert.equal(flashlightStage(maxBattery), 'FULL');
  assert.equal(flashlightStage(0.6 * maxBattery), 'FULL', '60% is still FULL');
  assert.equal(flashlightStage(0.6 * maxBattery - 0.01), 'HALF');
  assert.equal(flashlightStage(0.2 * maxBattery), 'HALF', '20% is still HALF');
  assert.equal(flashlightStage(0.2 * maxBattery - 0.01), 'LOW');
  assert.equal(flashlightStage(0.01), 'LOW');
  assert.equal(flashlightStage(0), 'OFF');

  const [full, half, low] = GAMEPLAY.battery.stages;
  closeTo(flashlightRange(maxBattery), fullRange * full.rangeMultiplier);
  closeTo(flashlightRange(0.6 * maxBattery), fullRange * full.rangeMultiplier);
  closeTo(flashlightRange(0.6 * maxBattery - 0.01), fullRange * half.rangeMultiplier);
  closeTo(flashlightRange(0.2 * maxBattery), fullRange * half.rangeMultiplier);
  closeTo(flashlightRange(0.2 * maxBattery - 0.01), fullRange * low.rangeMultiplier);
  assert.equal(flashlightRange(0), 0);
  assert.ok(full.rangeMultiplier > half.rangeMultiplier && half.rangeMultiplier > low.rangeMultiplier);
});

test('the flashlight reaches exactly as far as the current battery stage allows', () => {
  // The same Creature, the same facing: only the battery changes.
  const reaches = (battery: number, target: Position) =>
    flashlightReaches(TEST_WORLD, LANE_HUNTER, EAST, target, flashlightRange(battery));
  assert.equal(reaches(maxBattery, STAGE_CREATURE), true, 'FULL reaches 90 units');
  assert.equal(reaches(0.6 * maxBattery - 0.01, STAGE_CREATURE), false, 'HALF does not');
  assert.equal(reaches(0.6 * maxBattery - 0.01, LANE_CREATURE), true, 'HALF still reaches 60 units');
  assert.equal(reaches(0.2 * maxBattery - 0.01, LANE_CREATURE), false, 'LOW does not');

  // And through the simulation: a full battery lights the Creature, a HALF one cannot.
  const lit = stageGame(LANE_HUNTER, STAGE_CREATURE, EAST);
  step(lit, 1, { light: true });
  assert.equal(lit.creatureState.lit, true);
  assert.ok(lit.creatureState.hp < GAMEPLAY.creature.maxHp);

  const dim = stageGame(LANE_HUNTER, STAGE_CREATURE, EAST);
  dim.hunters[0].battery = 0.6 * maxBattery - 0.01;
  step(dim, 1, { light: true });
  assert.equal(dim.creatureState.lit, false);
  assert.equal(dim.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(isRevealed(dim.creatureState), false);
  assert.equal('creature' in hunterView(dim), false);
});

test('battery drains in simulation time only while the flashlight is held, and never below zero', () => {
  // The Creature is parked in the far corner: the button costs battery whether or not the
  // beam finds anything, and nothing here can be interrupted by a tag.
  const game = stageGame(LANE_HUNTER, FAR_CORNER, EAST);
  assert.equal(batteryOf(game), maxBattery, 'a round starts at full battery');

  // Idle: no drain at all, and no passive recharge either.
  step(game, GAMEPLAY.tickRate, { up: false });
  assert.equal(batteryOf(game), maxBattery);

  // One second of light is exactly one second of drain.
  step(game, GAMEPLAY.tickRate, { light: true });
  closeTo(batteryOf(game), maxBattery - drainPerSecond, 1e-9);
  const afterLight = batteryOf(game);
  for (const view of [hunterView(game), hunterView(game, 1), creatureView(game)]) {
    closeTo(view.hunters[0].battery, afterLight);
  }

  // Released: the level holds where it is, with no regeneration over time.
  step(game, 60);
  assert.equal(batteryOf(game), afterLight);

  // Moving without the button costs nothing.
  step(game, 30, { right: true });
  assert.equal(batteryOf(game), afterLight);

  // A downed Hunter has no input at all, so a held button drains nothing.
  game.hunters[0].down = true;
  game.hunters[0].input = { up: false, down: false, left: false, right: false, light: true };
  step(game, 30);
  assert.equal(batteryOf(game), afterLight);
  game.hunters[0].down = false;

  // Held past the end of the battery: it stops at zero rather than going negative.
  game.hunters[0].battery = 2 * drainPerTick;
  step(game, 60, { light: true });
  assert.equal(batteryOf(game), 0);
  assert.equal(ownView(hunterView(game)).battery, 0);
});

test('an empty battery produces no gameplay effect: no reveal, no damage, no revival, no drawn beam', () => {
  const game = stageGame(LANE_HUNTER, LANE_CREATURE, EAST);
  // H2 lies down inside the same beam, so the one test covers both uses of the light.
  game.hunters[1].position = groundPosition(160, 60);
  game.hunters[1].down = true;
  game.hunters[0].battery = 0;
  assert.equal(flashlightReaches(TEST_WORLD, game.hunters[0].position, game.hunters[0].facing, game.creature!.position), true,
    'the Creature sits inside the full-battery cone');

  step(game, 60, { light: true });
  assert.equal(game.creatureState.lit, false);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(isRevealed(game.creatureState), false);
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(game.hunters[1].reviveTicks, 0, 'an empty flashlight revives nobody');
  assert.equal(batteryOf(game), 0);
  assert.equal('creature' in hunterView(game), false);
  // Every client is told the beam is off, so no client draws a cone that does nothing.
  for (const view of [hunterView(game), hunterView(game, 2), creatureView(game)]) {
    assert.equal(view.hunters[0].light, false);
    assert.equal(view.hunters[0].battery, 0);
  }
  assert.equal(creatureView(game).lit, false);

  // A refill restores every one of those effects.
  game.hunters[0].battery = maxBattery;
  step(game, 1, { light: true });
  assert.equal(game.creatureState.lit, true);
  assert.equal(isRevealed(game.creatureState), true);
  assert.equal(game.hunters[1].reviveTicks, 1);
  assert.equal(ownView(hunterView(game)).light, true);
});

test('no battery exists until the first-spawn delay has run, and then exactly one appears', () => {
  const game = createGame(TEST_WORLD);
  startRound(game, PLAYERS);
  assert.equal(game.pickup.at, null, 'a round starts with an empty map');
  assert.equal(game.pickup.spawnTicks, PICKUP_FIRST_SPAWN_TICKS);
  // The role reveal spends no spawn time, exactly as it spends no match time.
  while (game.roundState === 'reveal') {
    stepGame(game);
    assert.equal(game.pickup.spawnTicks, PICKUP_FIRST_SPAWN_TICKS, 'the reveal does not run the spawn delay');
  }

  step(game, PICKUP_FIRST_SPAWN_TICKS - 1);
  assert.equal(game.pickup.at, null, 'still nothing one tick before the delay expires');
  assert.equal(game.pickup.spawnTicks, 1);
  for (const view of [hunterView(game), creatureView(game)]) {
    assert.deepEqual(view.pickups, [], 'neither role is shown a battery that does not exist');
  }

  step(game, 1);
  assert.notEqual(game.pickup.at, null, 'the first battery arrives after exactly the configured delay');
  assert.ok(game.pickup.at! >= 0 && game.pickup.at! < TEST_WORLD.batterySpawns.length);
  assert.deepEqual(activePickups(game), [game.pickup.at]);
  for (const view of [hunterView(game), hunterView(game, 1), creatureView(game)]) {
    assert.deepEqual(view.pickups, [game.pickup.at], 'both roles see the same one battery');
  }
});

test('an active Hunter collects the battery: it fills, leaves every payload, and the next one follows', () => {
  const index = 0;
  const game = pickupGame(index);
  game.hunters[0].battery = 10;
  assert.deepEqual(activePickups(game), [index]);
  for (const view of [hunterView(game), creatureView(game)]) {
    assert.deepEqual(view.pickups, [index], 'both roles see the same public pickup list');
  }

  step(game, 1);
  assert.equal(batteryOf(game), maxBattery, 'collection fills the battery');
  assert.equal(game.pickup.at, null);
  assert.equal(game.pickup.spawnTicks, PICKUP_RESPAWN_TICKS);
  assert.equal(game.stats.pickupsCollected, 1);
  for (const view of [hunterView(game), hunterView(game, 1), creatureView(game)]) {
    assert.deepEqual(view.pickups, [], 'the collected battery leaves every payload');
  }

  // Step off the point so the next battery is observable rather than instantly re-collected.
  game.hunters[0].position = groundPosition(700, 60);
  step(game, PICKUP_RESPAWN_TICKS - 1);
  assert.equal(game.pickup.at, null, 'still gone one tick before the respawn expires');
  assert.equal(game.pickup.spawnTicks, 1);
  step(game, 1);
  assert.notEqual(game.pickup.at, null, 'back after exactly the configured delay');
  assert.ok(game.pickup.at! >= 0 && game.pickup.at! < TEST_WORLD.batterySpawns.length);
  assert.deepEqual(hunterView(game).pickups, activePickups(game));

  // Collecting at full battery still consumes it, and the clamp keeps the maximum.
  game.hunters[0].position = { ...pickupAt(game.pickup.at!) };
  step(game, 1);
  assert.equal(batteryOf(game), maxBattery);
  assert.equal(game.pickup.at, null);
  assert.equal(game.stats.pickupsCollected, 2);
});

test('collection is by contact with an active Hunter only: out of reach or incapacitated collects nothing', () => {
  const index = 1;
  const reach = PICKUP_REACH;
  const outside = { ...pickupAt(index), x: pickupAt(index).x + reach + 1 };
  const game = stageGame(outside, FAR_CORNER);
  game.pickup.at = index;
  game.hunters[0].battery = 10;
  step(game, 1);
  assert.equal(game.pickup.at, index, 'just out of reach is not a collection');
  assert.equal(batteryOf(game), 10);

  // Just inside the reach is.
  game.hunters[0].position = { ...pickupAt(index), x: pickupAt(index).x + reach - 1 };
  step(game, 1);
  assert.equal(game.pickup.at, null);
  assert.equal(batteryOf(game), maxBattery);

  // An incapacitated Hunter lying on the battery never picks it up.
  const downed = pickupGame(2);
  downed.hunters[0].battery = 10;
  downed.hunters[0].down = true;
  step(downed, 60);
  assert.equal(downed.pickup.at, 2, 'the battery is still there');
  assert.equal(batteryOf(downed), 10, 'a downed Hunter collects nothing');
  assert.equal(downed.stats.pickupsCollected, 0);
  // Revived on the spot, it collects on the next step.
  downed.hunters[0].down = false;
  step(downed, 1);
  assert.equal(downed.pickup.at, null);
  assert.equal(batteryOf(downed), maxBattery);
});

test('the map never holds more than one battery, and every point is used across many spawns', () => {
  const game = pickupGame(0);
  const seen = new Set<number>();
  // Collect repeatedly: the Hunter walks onto whichever point the next battery lands on.
  // The exact respawn timing is checked in the test above; here the wait is cut short so
  // the loop can sample far more spawns than one match would contain.
  for (let spawn = 0; spawn < 200; spawn++) {
    game.timeTicks = MATCH_TICKS; // this loop outlasts a real match many times over
    assert.deepEqual(activePickups(game), [game.pickup.at], 'the public list mirrors the one battery');
    assert.ok(activePickups(game).length <= 1);
    seen.add(game.pickup.at!);
    game.hunters[0].position = { ...pickupAt(game.pickup.at!) };
    step(game, 1);
    assert.equal(game.pickup.at, null, 'collected, so the map is empty again');
    // The Hunter waits on open lane floor: clear of every point, and clear of the Creature.
    game.hunters[0].position = groundPosition(700, 60);
    step(game, 5);
    assert.equal(game.pickup.at, null, 'no second battery appears while one is pending');
    assert.deepEqual(hunterView(game).pickups, [], 'and nobody is shown one');
    game.pickup.spawnTicks = 1;
    step(game, 1);
    assert.notEqual(game.pickup.at, null);
  }
  assert.equal(game.stats.pickupsCollected, 200);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'every point is chosen across 200 spawns');
});

test('the match clock starts when the round starts running, not during the role reveal', () => {
  const game = createGame(TEST_WORLD);
  startRound(game, PLAYERS);
  assert.equal(game.timeTicks, MATCH_TICKS);
  while (game.roundState === 'reveal') {
    stepGame(game);
    assert.equal(game.timeTicks, MATCH_TICKS, 'the reveal does not spend match time');
  }
  assert.equal(game.roundState, 'running');
  closeTo(hunterView(game).timeRemaining, MATCH_SECONDS, 1e-6);
  closeTo(creatureView(game).timeRemaining, MATCH_SECONDS, 1e-6);

  // From here every simulation step is one tick of the clock, for both roles alike.
  for (let tick = 1; tick <= 30; tick++) {
    stepGame(game);
    assert.equal(game.timeTicks, MATCH_TICKS - tick);
    closeTo(hunterView(game).timeRemaining, (MATCH_TICKS - tick) * STEP_SECONDS, 0.005);
    closeTo(creatureView(game).timeRemaining, hunterView(game).timeRemaining);
  }
});

test('the clock running out is a Creature victory, and the clock then stops', () => {
  const game = stageGame(LANE_HUNTER, FAR_CORNER, EAST);
  game.timeTicks = 2;
  step(game, 1, { light: true });
  assert.equal(game.roundState, 'running', 'one tick left is not over yet');
  assert.equal(game.result, null);
  assert.equal(game.timeTicks, 1);

  step(game, 1, { light: true });
  assert.equal(game.timeTicks, 0);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'expired');
  assert.ok(game.creatureState.hp > 0, 'the Creature survived the match');
  for (const view of [hunterView(game), hunterView(game, 1), creatureView(game)]) {
    assert.equal(view.result, 'expired');
    assert.equal(view.roundState, 'ended');
    assert.equal(view.timeRemaining, 0);
  }
  assertHunterPayload(hunterView(game));

  // Ended means ended: no more clock, no more drain, no more movement.
  const frozen = positions(game);
  const battery = batteryOf(game);
  step(game, 30, { right: true, light: true });
  assert.equal(game.timeTicks, 0);
  assert.equal(batteryOf(game), battery);
  assert.deepEqual(positions(game), frozen);
  assert.equal(game.result, 'expired');
});

test('the round-end priority is caught, then defeated, then expired', () => {
  // Creature HP reaching zero with time left is a Hunter victory.
  const early = stageGame(LANE_HUNTER, LANE_CREATURE, EAST);
  early.creatureState.hp = damagePerTick;
  step(early, 1, { light: true });
  assert.equal(early.result, 'defeated');
  assert.ok(early.timeTicks > 0, 'the clock still had time on it');

  // The same kill landing on the very last tick still wins for the Hunters.
  const photoFinish = stageGame(LANE_HUNTER, LANE_CREATURE, EAST);
  photoFinish.creatureState.hp = damagePerTick;
  photoFinish.timeTicks = 1;
  step(photoFinish, 1, { light: true });
  assert.equal(photoFinish.timeTicks, 0);
  assert.equal(photoFinish.result, 'defeated');

  // Every Hunter down is a Creature victory whatever the clock says, and it is
  // resolved before the clock is consulted at all.
  const caught = stageGame(groundPosition(400, 300), groundPosition(400 + 2 * GAMEPLAY.playerRadius, 300));
  for (const hunter of caught.hunters.slice(1)) hunter.down = true;
  caught.timeTicks = 1;
  stepGame(caught);
  assert.equal(caught.result, 'caught');
  assert.equal(isRevealed(caught.creatureState), false, 'a hidden Creature stays hidden after winning');
  assert.equal('creature' in hunterView(caught), false);
});

test('a rematch resets every Prototype 4 resource: batteries, the battery on the map, its timer, the clock, and statistics', () => {
  const game = stageGame(pickupAt(3), LANE_CREATURE, EAST);
  game.pickup.at = 3;
  // Spend the round: collect the battery, burn charge, take time off the clock, down a Hunter.
  step(game, 1);
  assert.equal(game.pickup.at, null);
  game.hunters[0].position = { ...LANE_HUNTER };
  step(game, 90, { light: true });
  game.hunters[1].down = true;
  game.hunters[1].reviveTicks = 40;
  assert.ok(batteryOf(game) < maxBattery);
  assert.ok(game.timeTicks < MATCH_TICKS);
  assert.ok(game.creatureState.hp < GAMEPLAY.creature.maxHp);
  assert.ok(game.stats.pickupsCollected > 0 && game.stats.lightTicks.H1 > 0);

  startRound(game, PLAYERS);
  assert.equal(game.timeTicks, MATCH_TICKS);
  assert.equal(game.pickup.at, null, 'a rematch starts with an empty map again');
  assert.equal(game.pickup.spawnTicks, PICKUP_FIRST_SPAWN_TICKS, 'and waits out the full first-spawn delay');
  assert.deepEqual(game.hunters.map((hunter) => hunter.battery), game.hunters.map(() => maxBattery));
  assert.equal(game.hunters.every((hunter) => !hunter.down && hunter.reviveTicks === 0 && !hunter.input.light), true);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.deepEqual(game.stats, {
    incapacitations: 0, revives: 0, pickupsCollected: 0, lightTicks: { H1: 0, H2: 0, H3: 0, H4: 0 },
  });
  while (game.roundState === 'reveal') stepGame(game);
  for (const view of [hunterView(game), creatureView(game)]) {
    closeTo(view.timeRemaining, MATCH_SECONDS, 1e-6);
    assert.deepEqual(view.pickups, []);
    assert.deepEqual(view.hunters.map((hunter) => hunter.battery), [maxBattery, maxBattery, maxBattery, maxBattery]);
  }

  // Abandoning a round returns the same fresh resources to the lobby.
  step(game, 30, { light: true });
  abandonRound(game);
  assert.equal(game.timeTicks, MATCH_TICKS);
  assert.equal(game.pickup.at, null);
  assert.equal(game.pickup.spawnTicks, PICKUP_FIRST_SPAWN_TICKS);
  assert.equal(game.stats.pickupsCollected, 0);
});

test('the battery, clock, and pickup fields carry no hidden Creature information', () => {
  // Coordinates whose digit strings appear nowhere else in a Hunter payload.
  const creature = groundPosition(717, 341);
  const game = startedGame();
  game.creature!.position = { ...creature };
  game.hunters[0].position = groundPosition(100, 100);
  game.hunters[1].position = groundPosition(700, 560);
  game.hunters[2].position = groundPosition(760, 560);
  game.hunters[3].position = groundPosition(820, 560);
  // Burn some battery and put a battery on the map so all three new fields are in flight.
  game.hunters[0].battery = 30;
  game.pickup.at = 4;
  step(game, 45, { light: true });
  assert.equal(game.pickup.at, 4, 'the battery is still out, so `pickups` is not empty');

  for (let slot = 0; slot < 4; slot++) {
    const snapshot = hunterView(game, slot);
    assertHunterPayload(snapshot);
    assert.equal('creature' in snapshot, false);
    const wire = JSON.stringify(snapshot);
    assert.equal(wire.includes(String(creature.x)), false);
    assert.equal(wire.includes(String(creature.z)), false);
    // The pickup list is indices into the public spawn table: no coordinates at all.
    for (const point of TEST_WORLD.batterySpawns) {
      assert.equal(wire.includes(`"x":${point.x}`), false, 'no pickup position is serialized');
    }
    assert.deepEqual(snapshot.pickups, [4]);
  }
  // Both roles agree on the public state, and only the Creature payload holds its position.
  const creatureSnapshot = creatureView(game);
  assert.deepEqual(creatureSnapshot.pickups, hunterView(game).pickups);
  closeTo(creatureSnapshot.timeRemaining, hunterView(game).timeRemaining);
  assert.deepEqual(creatureSnapshot.creature, creature);
});

test('revival still costs the reviver battery, so a rescue and a hunt compete for the same resource', () => {
  const game = stageGame(groundPosition(160, 60), FAR_CORNER, EAST);
  game.hunters[1].position = groundPosition(100, 60);
  game.hunters[1].facing = EAST;
  game.hunters[0].down = true;
  const reviver = game.hunters[1];

  for (let tick = 0; tick < 30; tick++) {
    hold(game, hunterId(game, 1), { light: true });
    stepGame(game);
  }
  assert.equal(game.hunters[0].reviveTicks, 30);
  closeTo(reviver.battery, maxBattery - drainPerSecond, 1e-9);
  // A full revival costs the configured share of one battery.
  closeTo(REVIVE_TICKS * drainPerTick, GAMEPLAY.revive.seconds * drainPerSecond, 1e-9);

  // With an empty battery the same beam does nothing, and progress simply stops.
  reviver.battery = 0;
  for (let tick = 0; tick < 30; tick++) {
    hold(game, hunterId(game, 1), { light: true });
    stepGame(game);
  }
  assert.equal(game.hunters[0].reviveTicks, 30, 'no further progress without battery');
  assert.equal(game.hunters[0].down, true);
});
