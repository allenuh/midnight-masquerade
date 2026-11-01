import assert from 'node:assert/strict';
import test from 'node:test';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import {
  PLAYER_COUNT, abandonRound, isRevealed, secondsToTicks, setInput, startRound, stepGame, type Game,
} from '../src/server/game.js';
import {
  PLAYERS, assertHunterPayload, closeTo, creatureId, creatureView, groundPosition, hunterId, hunterView, input, positions,
  stageGame, step,
} from './helpers/game.js';

// The catch cutscene at its shipped length: a tag pauses the whole round while every player
// watches the Creature grab the Hunter. (The other rule tests run with it off; see helpers/game.ts.)
const cutsceneTicks = secondsToTicks(GAMEPLAY.creature.catchSeconds);
const lingerTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);
const HUNTER = groundPosition(100, 60);
// Touching H1 from the east: tagged on the first step.
const TOUCHING = groundPosition(100 + 20, 60);

function catchGame(): Game {
  const game = stageGame(HUNTER, TOUCHING);
  game.tuning = { ...game.tuning, catchSeconds: GAMEPLAY.creature.catchSeconds };
  return game;
}

test('a tag starts the catch cutscene: every player is told, the Creature is revealed, and the two face each other', () => {
  assert.ok(cutsceneTicks > 0, 'the shipped tuning plays a cutscene');
  const game = catchGame();
  step(game, 1);
  assert.equal(game.hunters[0].down, true);
  assert.equal(game.roundState, 'running');
  assert.deepEqual(game.catch, { hunter: 'H1', ticks: cutsceneTicks, total: cutsceneTicks, endsRound: false });
  // Every Hunter and the Creature learn which Hunter was caught and how far into it they are.
  for (let slot = 0; slot < game.hunters.length; slot++) {
    const view = hunterView(game, slot);
    assertHunterPayload(view);
    assert.deepEqual(view.catch, { hunter: 'H1', elapsed: 0 });
    assert.ok(view.creature, `slot ${slot} sees the Creature for the cutscene`);
  }
  assert.deepEqual(creatureView(game).catch, { hunter: 'H1', elapsed: 0 });
  assert.equal(isRevealed(game.creatureState), true);
  // The Creature is east of the Hunter: the Hunter faces east (0), the Creature west (pi).
  closeTo(game.hunters[0].facing, 0);
  closeTo(Math.abs(game.creature!.facing), Math.PI);
});

test('the cutscene pauses the whole round and drops every input, then play resumes', () => {
  const game = catchGame();
  step(game, 1);
  const frozen = positions(game);
  const clock = game.timeTicks;
  const attackCooldown = game.creatureState.attackCooldownTicks;
  const reveal = game.creatureState.revealTicks;
  const batterySpawn = game.pickup.spawnTicks;
  const teammateBattery = game.hunters[1].battery;
  assert.ok(attackCooldown > 0);
  const press = () => {
    // Everyone mashes their keys: accepted, and dropped.
    assert.equal(setInput(game, creatureId(game), input(game, { left: true, light: true })), true);
    assert.equal(setInput(game, hunterId(game, 1), input(game, { up: true, light: true })), true);
  };
  for (let tick = 1; tick < cutsceneTicks; tick++) {
    press();
    stepGame(game);
    assert.deepEqual(positions(game), frozen, `nothing moves, tick ${tick}`);
    assert.equal(game.timeTicks, clock, 'the match clock is paused');
    assert.equal(game.creatureState.attackCooldownTicks, attackCooldown);
    assert.equal(game.creatureState.revealTicks, reveal);
    assert.equal(game.pickup.spawnTicks, batterySpawn);
    assert.equal(game.hunters[1].battery, teammateBattery, 'no beam, no drain');
    assert.deepEqual(game.creature!.input, { up: false, down: false, left: false, right: false, light: false });
    closeTo(hunterView(game, 1).catch!.elapsed, tick / GAMEPLAY.tickRate);
  }
  // The last paused step ends the cutscene; play resumes on the next.
  stepGame(game);
  assert.equal(game.catch, null);
  assert.equal('catch' in hunterView(game, 1), false, 'the key is gone once it is over');
  assert.equal(game.timeTicks, clock);
  assert.deepEqual(positions(game), frozen);
  const before = game.creature!.position.x;
  step(game, 1, {}, { left: true });
  assert.equal(game.timeTicks, clock - 1, 'the clock runs again');
  assert.equal(game.creatureState.attackCooldownTicks, attackCooldown - 1, 'the attack cooldown runs from the end of the cutscene');
  assert.ok(game.creature!.position.x < before, 'the Creature moves again');
  // The Creature stays revealed for the linger after the cutscene, then is hidden again.
  step(game, lingerTicks - 2);
  assert.ok(hunterView(game, 1).creature);
  step(game, 1);
  assert.equal('creature' in hunterView(game, 1), false);
});

test('the last catch plays its cutscene, then ends the round as caught', () => {
  const game = catchGame();
  for (const hunter of game.hunters.slice(1)) hunter.down = true;
  step(game, 1);
  assert.equal(game.catch?.endsRound, true);
  for (let tick = 1; tick < cutsceneTicks; tick++) {
    stepGame(game);
    assert.equal(game.roundState, 'running', `still watching, tick ${tick}`);
    assert.equal(game.result, null);
  }
  stepGame(game);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
  assert.equal(game.catch, null);
  assert.equal(hunterView(game, 1).result, 'caught');
});

test('a restart or an abandoned round in the middle of a cutscene clears it', () => {
  const restarted = catchGame();
  step(restarted, 1);
  assert.ok(restarted.catch);
  startRound(restarted, PLAYERS);
  assert.equal(restarted.catch, null);

  const abandoned = catchGame();
  step(abandoned, 1);
  assert.ok(abandoned.catch);
  abandonRound(abandoned);
  assert.equal(abandoned.catch, null);
  assert.equal(PLAYER_COUNT, PLAYERS.length);
});
