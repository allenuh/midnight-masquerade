import assert from 'node:assert/strict';
import test from 'node:test';
import { EXORCISM, STEADY_FIRE, exorcismFrame } from '../src/client/exorcism.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import { STEP_SECONDS, abandonRound, secondsToTicks, setInput, startRound, stepGame, type Game } from '../src/server/game.js';
import {
  PLAYERS, assertHunterPayload, closeTo, creatureId, creatureView, groundPosition, hunterId, hunterView, input, positions, stageGame, step,
} from './helpers/game.js';

// The exorcism cutscene at its shipped length: the Creature's HP reaching zero pauses the round while
// every player watches it burn away, then the round ends. (The other rule tests run with it off; see
// helpers/game.ts.)
const SECONDS = GAMEPLAY.creature.exorcismSeconds;
const cutsceneTicks = secondsToTicks(SECONDS);
const damagePerTick = GAMEPLAY.flashlight.damagePerSecond * STEP_SECONDS;
// H1 faces east along a lane with the Creature in its beam, one lit step from dead.
const HUNTER = groundPosition(100, 60);
const CREATURE = groundPosition(160, 60);

function killGame(): Game {
  const game = stageGame(HUNTER, CREATURE, 0);
  game.tuning = { ...game.tuning, exorcismSeconds: SECONDS };
  game.creatureState.hp = damagePerTick;
  return game;
}

test('the killing light starts the exorcism: every player is told, and the round goes on until it is over', () => {
  assert.ok(cutsceneTicks > 0, 'the shipped tuning plays a cutscene');
  const game = killGame();
  step(game, 1, { light: true });
  assert.equal(game.creatureState.hp, 0);
  assert.equal(game.roundState, 'running');
  assert.equal(game.result, null);
  assert.deepEqual(game.exorcism, { ticks: cutsceneTicks, total: cutsceneTicks });
  for (let slot = 0; slot < game.hunters.length; slot++) {
    const view = hunterView(game, slot);
    assertHunterPayload(view);
    assert.deepEqual(view.exorcism, { elapsed: 0 });
    assert.ok(view.creature, `slot ${slot} sees the Creature for the cutscene`);
  }
  assert.deepEqual(creatureView(game).exorcism, { elapsed: 0 });
  assert.equal(creatureView(game).staggered, false, 'no stagger outline over the cutscene');
});

test('the exorcism pauses the whole round and drops every input, the beams stay lit, and it ends as a Hunter victory', () => {
  const game = killGame();
  step(game, 1, { light: true });
  const frozen = positions(game);
  const clock = game.timeTicks;
  const batterySpawn = game.pickup.spawnTicks;
  const battery = game.hunters[0].battery;
  const lightTicks = game.stats.lightTicks.H1;
  for (let tick = 0; tick < cutsceneTicks - 1; tick++) {
    // Everyone mashes their keys, H1 letting go of the light: accepted, and dropped.
    assert.equal(setInput(game, creatureId(game), input(game, { left: true, light: true })), true);
    assert.equal(setInput(game, hunterId(game), input(game, { up: true, light: false })), true);
    stepGame(game);
    assert.equal(game.roundState, 'running');
    assert.deepEqual(positions(game), frozen);
    assert.equal(game.timeTicks, clock);
    assert.equal(game.pickup.spawnTicks, batterySpawn);
    assert.equal(game.hunters[0].battery, battery, 'a beam left on drains nothing');
    assert.equal(game.stats.lightTicks.H1, lightTicks);
    assert.equal(hunterView(game).hunters[0].light, true, "the killer's beam stays on it");
    assert.ok(hunterView(game).creature, 'the Creature stays revealed throughout');
  }
  closeTo(hunterView(game).exorcism!.elapsed, (cutsceneTicks - 1) * STEP_SECONDS);
  stepGame(game);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'defeated');
  assert.equal(game.exorcism, null);
  assert.equal('exorcism' in hunterView(game), false, 'the key is gone once it is over');
  assert.equal(hunterView(game).hunters[0].light, false, 'the beams go out with the round');
});

test('a kill on the very last tick still plays out as a Hunter victory', () => {
  const game = killGame();
  game.timeTicks = 1;
  step(game, 1, { light: true });
  assert.equal(game.timeTicks, 0);
  assert.equal(game.result, null, 'not expired');
  step(game, cutsceneTicks);
  assert.equal(game.result, 'defeated');
});

test('a room may turn the exorcism off: the kill ends the round at once', () => {
  const game = killGame();
  game.tuning = { ...game.tuning, exorcismSeconds: 0 };
  step(game, 1, { light: true });
  assert.equal(game.exorcism, null);
  assert.equal(game.result, 'defeated');
});

test('the Creature is sent to every Hunter through the exorcism, even with no reveal linger', () => {
  const game = killGame();
  game.tuning = { ...game.tuning, visibilityLingerSeconds: 0 };
  step(game, 1, { light: true });
  assert.equal(game.creatureState.revealTicks, 0);
  assert.ok(hunterView(game).creature);
  step(game, cutsceneTicks);
  assert.equal('creature' in hunterView(game), false, 'and no longer once it is over');
});

test('a restart or a return to the lobby clears a running exorcism', () => {
  const restarted = killGame();
  step(restarted, 1, { light: true });
  startRound(restarted, PLAYERS);
  assert.equal(restarted.exorcism, null);
  const abandoned = killGame();
  step(abandoned, 1, { light: true });
  abandonRound(abandoned);
  assert.equal(abandoned.exorcism, null);
});

test('the timeline: the Creature is whole, then dissolves, then the fire swells, then it slowly dies', () => {
  const at = (share: number) => exorcismFrame(share * SECONDS, SECONDS);
  const { DISSOLVE_FROM, DISSOLVE_TO, SWELL_FROM, SWELL_TO, DIE_FROM, DIE_TO } = EXORCISM;
  assert.ok(DISSOLVE_FROM < DISSOLVE_TO && SWELL_FROM < SWELL_TO && DIE_FROM < DIE_TO, 'each beat runs forward');
  assert.ok(DISSOLVE_FROM < SWELL_FROM && DISSOLVE_TO <= SWELL_TO && SWELL_TO <= DIE_FROM, 'in the order asked for');

  assert.equal(at(0).zoom, 0);
  assert.equal(at(0).clip, 0);
  assert.deepEqual(at(0).fire, { ...STEADY_FIRE, front: EXORCISM.EARLY_FRONT }, 'it starts as an ordinary burn, kept off the pose');
  assert.equal(at(SWELL_TO).fire.front, 1, 'and ends up all over it');
  assert.equal(at(DISSOLVE_FROM).fade, 1);
  assert.ok(at((DISSOLVE_FROM + DISSOLVE_TO) / 2).fade > 0 && at((DISSOLVE_FROM + DISSOLVE_TO) / 2).fade < 1);
  assert.equal(at(DISSOLVE_TO).fade, 0, 'gone by the end of the dissolve');
  assert.equal(at(DISSOLVE_TO).clip, 1);
  assert.ok(at(DISSOLVE_TO).fire.ash >= 0);

  // The swell peaks after the body has gone, and every part of the fire only falls from there.
  const peak = at(SWELL_TO).fire;
  assert.ok(peak.rate > at(DISSOLVE_FROM).fire.rate && peak.size > at(DISSOLVE_FROM).fire.size && peak.light > at(DISSOLVE_FROM).fire.light);
  closeTo(peak.rate, EXORCISM.FIRE_RATE);
  let previous = at(DIE_FROM).fire;
  for (let share = DIE_FROM + 0.02; share < DIE_TO; share += 0.02) {
    const next = at(share).fire;
    assert.ok(next.rate <= previous.rate && next.size <= previous.size && next.light <= previous.light, `dying at ${share}`);
    previous = next;
  }

  // Burnt out before the cutscene ends: no flames, no light, no ash, with the camera back home last.
  const out = at(DIE_TO).fire;
  assert.equal(out.rate, 0);
  assert.equal(out.light, 0);
  assert.equal(out.ash, 0);
  assert.ok(out.size > 0, 'the last flames are small, not nothing');
  assert.ok(at(DIE_TO).zoom > 0, 'still zoomed in as the fire goes out');
  assert.equal(at(1).zoom, 0, 'the camera is home as the result comes up');
});

test('the zoom holds through the middle of any cutscene long enough for both moves', () => {
  for (const seconds of [3, SECONDS, 12]) {
    assert.equal(exorcismFrame(seconds / 2, seconds).zoom, 1, `${seconds} s`);
  }
  // A cutscene too short for both still starts and ends at the fixed camera, and never overshoots.
  for (let elapsed = 0; elapsed <= 1; elapsed += 0.05) {
    const { zoom } = exorcismFrame(elapsed, 1);
    assert.ok(zoom >= 0 && zoom <= 1, `at ${elapsed}`);
  }
  assert.equal(exorcismFrame(0, 1).zoom, 0);
  assert.equal(exorcismFrame(1, 1).zoom, 0);
});
