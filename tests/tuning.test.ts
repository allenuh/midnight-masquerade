import assert from 'node:assert/strict';
import test from 'node:test';
import { flashlightRange, flashlightStage } from '../src/shared/flashlight.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import { DEFAULT_TUNING, TUNABLES, defaultTuning, tuningDifferences, validateTuning, type Tuning } from '../src/shared/tuning.js';
import {
  PLAYER_COUNT, createGame, hunterProximity, isBurning, isStaggered, secondsToTicks, startRound, stepGame, type Game,
} from '../src/server/game.js';
import { distance3D } from '../src/server/spatial.js';
import { PLAYERS, TEST_WORLD, closeTo, creatureView, groundPosition, hold, hunterView, step, PARKED, creatureId, hunterId } from './helpers/game.js';

// Host-tunable gameplay values. The table is the lobby's contract: every default is the
// number in gameplay-config.ts, the validator is the only way a tuning enters a room, and
// a game created with a tuning plays by it in every rule that reads a tunable.

const tuned = (changes: Partial<Tuning>): Tuning => ({ ...defaultTuning(), ...changes });

// A running round on the given tuning with H1 at `hunter`, the Creature at `creature`.
function stagedOn(tuning: Tuning, hunter = groundPosition(100, 60), creature = groundPosition(200, 75), facing = 0): Game {
  const game = createGame(TEST_WORLD, tuning);
  startRound(game, PLAYERS);
  while (game.roundState === 'reveal') stepGame(game);
  game.hunters[0].position = { ...hunter };
  game.hunters[0].facing = facing;
  for (let slot = 1; slot < game.hunters.length; slot++) game.hunters[slot].position = { ...PARKED[slot - 1] };
  game.creature!.position = { ...creature };
  return game;
}

test('the tunable table mirrors gameplay-config.ts and every default is inside its own bounds', () => {
  const byKey = Object.fromEntries(TUNABLES.map((tunable) => [tunable.key, tunable]));
  assert.equal(byKey.matchSeconds.default, GAMEPLAY.round.matchSeconds);
  assert.equal(byKey.hunterSpeed.default, GAMEPLAY.speed.hunter);
  assert.equal(byKey.hunterTurnSpeed.default, GAMEPLAY.hunterTurnSpeed);
  assert.equal(byKey.creatureSpeed.default, GAMEPLAY.speed.creature);
  assert.equal(byKey.sprintSpeed.default, GAMEPLAY.sprint.speed);
  assert.equal(byKey.sprintCooldownSeconds.default, GAMEPLAY.sprint.cooldownSeconds);
  assert.equal(byKey.creatureMaxHp.default, GAMEPLAY.creature.maxHp);
  assert.equal(byKey.staggerSeconds.default, GAMEPLAY.creature.staggerSeconds);
  assert.equal(byKey.staggerCooldownSeconds.default, GAMEPLAY.creature.staggerCooldownSeconds);
  assert.equal(byKey.visibilityLingerSeconds.default, GAMEPLAY.creature.visibilityLingerSeconds);
  assert.equal(byKey.attackCooldownSeconds.default, GAMEPLAY.creature.attackCooldownSeconds);
  assert.equal(byKey.burnSeconds.default, GAMEPLAY.creature.burnSeconds);
  assert.equal(byKey.flashlightDamagePerSecond.default, GAMEPLAY.flashlight.damagePerSecond);
  assert.equal(byKey.flashlightRange.default, GAMEPLAY.flashlight.range);
  assert.equal(byKey.flashlightConeAngle.default, GAMEPLAY.flashlight.coneAngle);
  assert.equal(byKey.batteryMax.default, GAMEPLAY.battery.max);
  assert.equal(byKey.batteryDrainPerSecond.default, GAMEPLAY.battery.drainPerSecond);
  assert.equal(byKey.batteryRestores.default, GAMEPLAY.batteryPickup.restores);
  assert.equal(byKey.firstBatterySeconds.default, GAMEPLAY.batteryPickup.firstSpawnSeconds);
  assert.equal(byKey.batteryRespawnSeconds.default, GAMEPLAY.batteryPickup.respawnSeconds);
  assert.equal(byKey.fullBatteryFraction.default, GAMEPLAY.battery.stages[0].minFraction);
  assert.equal(byKey.halfBatteryFraction.default, GAMEPLAY.battery.stages[1].minFraction);
  assert.equal(byKey.halfRangeMultiplier.default, GAMEPLAY.battery.stages[1].rangeMultiplier);
  assert.equal(byKey.lowRangeMultiplier.default, GAMEPLAY.battery.stages[2].rangeMultiplier);
  assert.equal(byKey.reviveSeconds.default, GAMEPLAY.revive.seconds);
  assert.equal(byKey.proximityUneasy.default, GAMEPLAY.proximity.uneasy);
  assert.equal(byKey.proximityDanger.default, GAMEPLAY.proximity.danger);
  assert.equal(byKey.proximityImmediate.default, GAMEPLAY.proximity.immediate);
  assert.equal(TUNABLES.length, 28);
  assert.equal(new Set(TUNABLES.map((tunable) => tunable.key)).size, TUNABLES.length, 'keys are unique');
  for (const tunable of TUNABLES) {
    assert.ok(tunable.min < tunable.max, tunable.key);
    assert.ok(tunable.default >= tunable.min && tunable.default <= tunable.max, `${tunable.key} default in bounds`);
    assert.ok(tunable.step > 0, tunable.key);
  }
  // A fresh default is a copy: changing it never touches the shared frozen defaults.
  const copy = defaultTuning();
  copy.creatureSpeed = 1;
  assert.equal(DEFAULT_TUNING.creatureSpeed, GAMEPLAY.speed.creature);
  assert.deepEqual(defaultTuning(), DEFAULT_TUNING);
});

test('validateTuning accepts a complete in-bounds table and rejects everything else whole', () => {
  assert.deepEqual(validateTuning(defaultTuning()), defaultTuning());
  const changed = tuned({ creatureSpeed: 300, burnSeconds: 0, fullBatteryFraction: 1 });
  assert.deepEqual(validateTuning(changed), changed);
  assert.notEqual(validateTuning(changed), changed, 'a fresh object, not the caller\'s');
  for (const bad of [
    null, undefined, 1, 'x', [], {},
    tuned({ creatureSpeed: 601 }), tuned({ creatureSpeed: 9 }), tuned({ matchSeconds: 0 }),
    tuned({ hunterSpeed: Number.NaN }), tuned({ hunterSpeed: Number.POSITIVE_INFINITY }),
    { ...defaultTuning(), extra: 1 },
    (({ reviveSeconds: _r, ...rest }) => rest)(defaultTuning()),
    { ...defaultTuning(), creatureSpeed: '150' },
    { ...defaultTuning(), creatureSpeed: true },
  ]) {
    assert.equal(validateTuning(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('tuningDifferences names only the values that differ from the defaults', () => {
  assert.equal(tuningDifferences(defaultTuning()), 'defaults');
  assert.equal(tuningDifferences(tuned({ creatureSpeed: 170, matchSeconds: 60 })), 'matchSeconds=60 creatureSpeed=170');
});

test('a room plays by its tuning: speeds, clock, HP, battery, burn, stagger, and proximity', () => {
  const tuning = tuned({
    creatureSpeed: 300, hunterSpeed: 55, sprintSpeed: 600, matchSeconds: 20, creatureMaxHp: 40,
    batteryMax: 50, batteryDrainPerSecond: 10, flashlightDamagePerSecond: 30, burnSeconds: 1,
    staggerSeconds: 0.5, staggerCooldownSeconds: 2, visibilityLingerSeconds: 2,
    proximityUneasy: 1000, proximityDanger: 500, proximityImmediate: 150,
    firstBatterySeconds: 1,
  });
  const game = stagedOn(tuning);
  assert.equal(game.tuning, tuning);
  assert.equal(game.timeTicks, secondsToTicks(20));
  assert.equal(game.creatureState.hp, 40);
  for (const hunter of game.hunters) assert.equal(hunter.battery, 50);
  assert.equal(game.pickup.spawnTicks, secondsToTicks(1) - 0, 'first battery delay from the tuning');

  // Speeds: one step each. The Creature crosses 300/30 = 10 units, the Hunter 55/30.
  const creatureBefore = { ...game.creature!.position };
  const hunterBefore = { ...game.hunters[0].position };
  hold(game, creatureId(game), { down: true });
  hold(game, hunterId(game), { down: true });
  stepGame(game);
  closeTo(distance3D(game.creature!.position, creatureBefore), 300 / GAMEPLAY.tickRate);
  closeTo(distance3D(game.hunters[0].position, hunterBefore), 55 / GAMEPLAY.tickRate);
  const sprintFrom = { ...game.creature!.position };
  hold(game, creatureId(game), { down: true, light: true });
  stepGame(game);
  closeTo(distance3D(game.creature!.position, sprintFrom), 600 / GAMEPLAY.tickRate);

  // Proximity: 120 units apart is IMMEDIATE on this tuning, DANGER on the defaults.
  game.hunters[0].position = groundPosition(100, 60);
  game.creature!.position = groundPosition(220, 60);
  assert.equal(hunterProximity(game, game.hunters[0]), 'IMMEDIATE');
  assert.equal(hunterView(game).proximity, 'IMMEDIATE');
  game.creature!.position = groundPosition(700, 60);
  assert.equal(hunterProximity(game, game.hunters[0]), 'UNEASY');

  // One lit step: 30 HP/s of damage, a 0.5 s stagger, a 1 s burn, a 2 s linger, and the
  // 50-unit battery drains at 10/s.
  game.creature!.position = groundPosition(200, 75);
  game.hunters[0].facing = 0; // the movement above turned H1 south; face east again
  hold(game, creatureId(game), {});
  step(game, 1, { light: true });
  closeTo(game.creatureState.hp, 40 - 30 / GAMEPLAY.tickRate);
  assert.equal(game.creatureState.staggerTicks, secondsToTicks(0.5));
  assert.equal(game.creatureState.staggerCooldownTicks, secondsToTicks(2));
  assert.equal(game.creatureState.burnTicks, secondsToTicks(1));
  assert.equal(game.creatureState.revealTicks, secondsToTicks(2));
  closeTo(game.hunters[0].battery, 50 - 10 / GAMEPLAY.tickRate);
  closeTo(creatureView(game).burnRemaining, 1);
  assert.equal(isStaggered(game.creatureState), true);
  assert.equal(isBurning(game.creatureState), true);
  // The burn ends after exactly one tuned second of unlit steps.
  step(game, secondsToTicks(1) - 1);
  assert.equal(isBurning(game.creatureState), true);
  step(game, 1);
  assert.equal(isBurning(game.creatureState), false);
});

test('flashlight range, cone, and stages follow the tuning on the server and in the shared helper', () => {
  // Stage thresholds and multipliers: on this tuning 50 % battery is still FULL, and LOW
  // reaches 90 % of a 300-unit range.
  const tuning = tuned({ flashlightRange: 300, fullBatteryFraction: 0.5, halfBatteryFraction: 0.1, halfRangeMultiplier: 0.5, lowRangeMultiplier: 0.9 });
  assert.equal(flashlightStage(50, tuning), 'FULL');
  assert.equal(flashlightStage(50), 'HALF');
  assert.equal(flashlightRange(50, tuning), 300);
  assert.equal(flashlightStage(20, tuning), 'HALF');
  assert.equal(flashlightRange(20, tuning), 150);
  assert.equal(flashlightStage(5, tuning), 'LOW');
  closeTo(flashlightRange(5, tuning), 270);
  assert.equal(flashlightRange(0, tuning), 0);
  closeTo(flashlightRange(100), GAMEPLAY.flashlight.range, 1e-8);

  // Range: a Creature 260 units down the open north corridor is out of the default
  // 140-unit reach and inside a tuned 300-unit one.
  const far = groundPosition(360, 60);
  const outOfReach = stagedOn(defaultTuning(), groundPosition(100, 60), far);
  step(outOfReach, 1, { light: true });
  assert.equal(outOfReach.creatureState.lit, false);
  const inReach = stagedOn(tuning, groundPosition(100, 60), far);
  step(inReach, 1, { light: true });
  assert.equal(inReach.creatureState.lit, true);

  // Cone: a Creature 100 units ahead and 60 to the side is ~31 deg off axis: outside a
  // 20 deg cone, inside a 90 deg one.
  const aside = groundPosition(200, 120);
  const narrow = stagedOn(tuned({ flashlightConeAngle: 20 }), groundPosition(100, 60), aside);
  step(narrow, 1, { light: true });
  assert.equal(narrow.creatureState.lit, false);
  const wide = stagedOn(tuned({ flashlightConeAngle: 90 }), groundPosition(100, 60), aside);
  step(wide, 1, { light: true });
  assert.equal(wide.creatureState.lit, true);
});

test('revive length, battery restore and respawn, and the match clock follow the tuning', () => {
  const tuning = tuned({ reviveSeconds: 1, batteryRestores: 30, batteryMax: 60, batteryRespawnSeconds: 2, matchSeconds: 10 });
  const game = stagedOn(tuning);
  // Down H2, then light it with H1 for one tuned second: revived after exactly 30 beam-ticks.
  game.hunters[1].down = true;
  game.hunters[1].position = groundPosition(200, 60);
  game.hunters[1].reviveTicks = 0;
  step(game, secondsToTicks(1) - 1, { light: true });
  assert.equal(game.hunters[1].down, true);
  closeTo(hunterView(game).hunters[1].revive, (secondsToTicks(1) - 1) / secondsToTicks(1));
  step(game, 1, { light: true });
  assert.equal(game.hunters[1].down, false);

  // A pickup restores 30 up to the 60 cap and the next one is due in 2 s.
  game.hunters[0].battery = 45;
  game.pickup = { at: 0, spawnTicks: 0 };
  game.hunters[0].position = { ...game.world.batterySpawns[0] };
  step(game, 1);
  assert.equal(game.hunters[0].battery, 60);
  assert.deepEqual(game.pickup, { at: null, spawnTicks: secondsToTicks(2) });

  // The clock expires after the tuned 10 seconds of running steps.
  const fresh = stagedOn(tuning, groundPosition(100, 60), groundPosition(800, 560));
  step(fresh, secondsToTicks(10) - 1);
  assert.equal(fresh.roundState, 'running');
  step(fresh, 1);
  assert.equal(fresh.roundState, 'ended');
  assert.equal(fresh.result, 'expired');
  assert.equal(PLAYER_COUNT, 5);
});
