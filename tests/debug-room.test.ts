// DEBUG-ROOM: delete this file along with src/server/debug-room.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { debugRoster, startDebugRound } from '../src/server/debug-room.js';
import { PLAYER_COUNT, createGame, roleOf, snapshotFor, stepGame } from '../src/server/game.js';
import { TEST_WORLD } from './helpers/game.js';

test('a debug roster fills the empty slots with distinct dummies', () => {
  for (const players of [['p1'], ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3', 'p4', 'p5']]) {
    const roster = debugRoster(players);
    assert.equal(roster.length, PLAYER_COUNT);
    assert.equal(new Set(roster).size, PLAYER_COUNT);
    assert.deepEqual(roster.slice(0, players.length), players);
  }
});

test('a debug round puts the host in the chosen role, however the roll fell', () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const asHunter = createGame(TEST_WORLD);
    startDebugRound(asHunter, ['p1'], 'p1', 'hunter');
    assert.equal(roleOf(asHunter, 'p1'), 'H1');
    assert.equal(snapshotFor(asHunter, 'p1').role, 'hunter');

    const asCreature = createGame(TEST_WORLD);
    startDebugRound(asCreature, ['p1', 'p2'], 'p1', 'creature');
    assert.equal(roleOf(asCreature, 'p1'), 'creature');
    assert.notEqual(roleOf(asCreature, 'p2'), null);
    assert.equal(snapshotFor(asCreature, 'p1').role, 'creature');
  }
});

test('a debug round runs like any other', () => {
  const game = createGame(TEST_WORLD);
  startDebugRound(game, ['p1'], 'p1', 'random');
  for (let step = 0; step < 200; step++) stepGame(game);
  assert.equal(game.roundState, 'running');
});
