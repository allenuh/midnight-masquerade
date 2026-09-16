import assert from 'node:assert/strict';
import test from 'node:test';
import { ARENA_OBSTACLES } from '../src/shared/arena.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position } from '../src/shared/protocol.js';
import { constrainToWalls, distance3D, sphereInCone } from '../src/server/spatial.js';
import {
  createGame,
  flashlightHitsCreature,
  isOnStaggerCooldown,
  isRevealed,
  isStaggered,
  joinGame,
  restartGame,
  secondsToTicks,
  setInput,
  snapshotFor,
  stepGame,
  turnToward,
  type Game,
} from '../src/server/game.js';

type Keys = { up: boolean; down: boolean; left: boolean; right: boolean; light: boolean };

const radius = GAMEPLAY.playerRadius;
const groundedY = GAMEPLAY.arena.floorY + radius;
const groundPosition = (x: number, z: number): Position => ({ x, y: groundedY, z });
const damagePerTick = GAMEPLAY.flashlight.damagePerSecond / GAMEPLAY.tickRate;
const staggerTicks = secondsToTicks(GAMEPLAY.creature.staggerSeconds);
const cooldownTicks = secondsToTicks(GAMEPLAY.creature.staggerCooldownSeconds);
const lingerTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);
const sprintCooldownTicks = secondsToTicks(GAMEPLAY.sprint.cooldownSeconds);
const creatureStep = GAMEPLAY.speed.creature / GAMEPLAY.tickRate;
const sprintStep = GAMEPLAY.sprint.speed / GAMEPLAY.tickRate;
const turnStep = GAMEPLAY.hunterTurnSpeed * (Math.PI / 180) / GAMEPLAY.tickRate;
const EAST = 0;

// The north corridor (Z 0..140) is open for the whole arena width: a Hunter at
// (100, 60) facing east has an unobstructed lane longer than the flashlight range.
// The lane Creature sits slightly off-axis so its coordinates differ from the Hunter's.
const LANE_HUNTER = groundPosition(100, 60);
const LANE_CREATURE = groundPosition(200, 75);
// The west slab (X 320..336, Z 220..460) separates these two; the opening north of
// it (Z 156..220) lets the same east-facing light through at Z = 180.
const WALL_HUNTER = groundPosition(280, 300);
const WALL_CREATURE = groundPosition(380, 300);

function huntGame(hunter: Position, creature: Position, facing = EAST): Game {
  const game = createGame();
  joinGame(game, 'hunter');
  joinGame(game, 'creature');
  game.players.hunter = { ...hunter };
  game.players.creature = { ...creature };
  game.hunterFacing = facing;
  return game;
}

function input(game: Game, keys: Partial<Keys> = {}) {
  return {
    type: 'input', roundId: game.roundId,
    up: false, down: false, left: false, right: false, light: false, ...keys,
  };
}

function hold(game: Game, role: 'hunter' | 'creature', keys: Partial<Keys>): void {
  assert.equal(setInput(game, role, input(game, keys)), true);
}

function step(game: Game, ticks = 1, hunterKeys: Partial<Keys> = {}, creatureKeys: Partial<Keys> = {}): void {
  for (let tick = 0; tick < ticks; tick++) {
    hold(game, 'hunter', hunterKeys);
    hold(game, 'creature', creatureKeys);
    stepGame(game);
  }
}

function closeTo(actual: number, expected: number, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
}

function hunterView(game: Game) {
  const snapshot = snapshotFor(game, 'hunter');
  assert.ok(snapshot.role === 'hunter');
  return snapshot;
}

function creatureView(game: Game) {
  const snapshot = snapshotFor(game, 'creature');
  assert.ok(snapshot.role === 'creature');
  return snapshot;
}

test('a Creature inside the flashlight cone and range is detected', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  assert.equal(flashlightHitsCreature(game.players.hunter!, game.hunterFacing, game.players.creature!), true);
  // The cone edge counts when any part of the sphere overlaps it.
  const halfAngle = (GAMEPLAY.flashlight.coneAngle / 2) * (Math.PI / 180);
  const onEdge = groundPosition(LANE_HUNTER.x + 100 * Math.cos(halfAngle), LANE_HUNTER.z + 100 * Math.sin(halfAngle));
  assert.equal(flashlightHitsCreature(LANE_HUNTER, EAST, onEdge), true);
  const justInsideRange = groundPosition(LANE_HUNTER.x + GAMEPLAY.flashlight.range + radius - 1, LANE_HUNTER.z);
  assert.equal(flashlightHitsCreature(LANE_HUNTER, EAST, justInsideRange), true);
  step(game, 1, { light: true });
  assert.equal(game.creatureState.lit, true);
  assert.equal(isRevealed(game.creatureState), true);
});

test('a Creature outside the cone angle, beyond range, or behind the Hunter is not detected', () => {
  const wide = 45 * (Math.PI / 180);
  const outsideAngle = groundPosition(LANE_HUNTER.x + 100 * Math.cos(wide), LANE_HUNTER.z + 100 * Math.sin(wide));
  assert.equal(sphereInCone(LANE_HUNTER, EAST, outsideAngle, radius), false);
  assert.equal(flashlightHitsCreature(LANE_HUNTER, EAST, outsideAngle), false);
  const beyondRange = groundPosition(LANE_HUNTER.x + GAMEPLAY.flashlight.range + radius + 1, LANE_HUNTER.z);
  assert.equal(flashlightHitsCreature(LANE_HUNTER, EAST, beyondRange), false);
  const behind = groundPosition(LANE_HUNTER.x - 60, LANE_HUNTER.z);
  assert.equal(flashlightHitsCreature(LANE_HUNTER, EAST, behind), false);
  // Facing north instead: the same east-side Creature is now outside the cone.
  assert.equal(flashlightHitsCreature(LANE_HUNTER, -Math.PI / 2, LANE_CREATURE), false);

  const game = huntGame(LANE_HUNTER, beyondRange);
  step(game, 30, { light: true });
  assert.equal(game.creatureState.lit, false);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(isRevealed(game.creatureState), false);
  assert.equal('creature' in hunterView(game), false);
});

test('a wall blocks the flashlight even when the Creature is inside the cone geometry', () => {
  assert.equal(sphereInCone(WALL_HUNTER, EAST, WALL_CREATURE, radius), true, 'cone geometry alone would hit');
  assert.equal(flashlightHitsCreature(WALL_HUNTER, EAST, WALL_CREATURE), false, 'the slab blocks line of sight');
  // Through the opening beside the slab the identical offset is lit.
  assert.equal(flashlightHitsCreature(groundPosition(280, 180), EAST, groundPosition(380, 180)), true);

  const game = huntGame(WALL_HUNTER, WALL_CREATURE);
  step(game, 30, { light: true });
  assert.equal(game.creatureState.lit, false);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(isRevealed(game.creatureState), false);
  assert.equal('creature' in hunterView(game), false);
  assert.equal(creatureView(game).revealed, false);
});

test('an illuminated Creature takes server-authoritative damage measured in simulation time', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  step(game, GAMEPLAY.tickRate, { light: true });
  closeTo(game.creatureState.hp, GAMEPLAY.creature.maxHp - GAMEPLAY.flashlight.damagePerSecond);
  closeTo(hunterView(game).creatureHp, game.creatureState.hp);
  closeTo(creatureView(game).hp, game.creatureState.hp);
  // Releasing the light stops damage; inputs never carry damage or HP.
  const hpAfterLight = game.creatureState.hp;
  step(game, 30);
  assert.equal(game.creatureState.hp, hpAfterLight);
  assert.equal(setInput(game, 'hunter', { ...input(game, { light: true }), damage: 1_000 }), false);
  assert.equal(setInput(game, 'creature', { ...input(game), hp: 1_000 }), false);
  assert.equal(game.creatureState.hp, hpAfterLight);
});

test('the first flashlight hit staggers the Creature: it cannot move or tag until the stagger expires', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  step(game, 1, { light: true });
  assert.equal(isStaggered(game.creatureState), true);
  assert.equal(isOnStaggerCooldown(game.creatureState), true);
  assert.equal(hunterView(game).creature?.staggered, true);
  assert.equal(creatureView(game).staggered, true);
  closeTo(creatureView(game).staggerCooldown, GAMEPLAY.creature.staggerCooldownSeconds);

  const frozen = { ...game.players.creature! };
  step(game, staggerTicks - 1, {}, { right: true });
  assert.deepEqual(game.players.creature, frozen, 'no movement while staggered');
  assert.equal(isStaggered(game.creatureState), true);
  step(game, 1, {}, { right: true });
  assert.equal(isStaggered(game.creatureState), false);
  closeTo(game.players.creature!.x - frozen.x, GAMEPLAY.speed.creature / GAMEPLAY.tickRate);
});

test('contact with a staggered Creature is not a tag, but it can tag again once free', () => {
  // The Creature starts a short gap in front of the Hunter, inside the beam.
  const gap = 10;
  const game = huntGame(LANE_HUNTER, groundPosition(LANE_HUNTER.x + 2 * radius + gap, LANE_HUNTER.z));
  step(game, 1, { light: true });
  assert.equal(isStaggered(game.creatureState), true);
  // Walk the Hunter straight into the frozen Creature, closing the gap and a little more.
  const walkTicks = Math.ceil((gap + 1) / (GAMEPLAY.speed.hunter / GAMEPLAY.tickRate));
  assert.ok(walkTicks + 1 < staggerTicks, 'the walk must finish inside the stagger');
  step(game, walkTicks, { right: true });
  assert.ok(distance3D(game.players.hunter!, game.players.creature!) <= 2 * radius, 'spheres overlap');
  assert.equal(game.roundState, 'running');
  assert.equal(game.result, null);
  // Still overlapping on the last staggered tick: no tag. The tick the stagger expires: tagged.
  step(game, staggerTicks - walkTicks - 1);
  assert.equal(isStaggered(game.creatureState), true);
  assert.equal(game.roundState, 'running');
  step(game, 1);
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'caught');
});

test('continuous light during the stagger cooldown keeps damaging and revealing but never re-staggers', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  step(game, 1, { light: true });
  const hpAtReveal = game.creatureState.hp;
  // The stagger ends while the cooldown is still running; the light stays on throughout.
  step(game, staggerTicks - 1, { light: true });
  assert.equal(isStaggered(game.creatureState), true);
  step(game, 1, { light: true });
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(isOnStaggerCooldown(game.creatureState), true);
  const hpAtFreedom = game.creatureState.hp;
  assert.ok(hpAtFreedom < hpAtReveal, 'damage continued through the stagger');

  let hp = hpAtFreedom;
  for (let tick = staggerTicks + 1; tick < cooldownTicks; tick++) {
    // Once, mid-cooldown, prove the lit Creature is free to move (and therefore attack).
    const moving = tick === staggerTicks + 10;
    const before = game.players.creature!.x;
    step(game, 1, { light: true }, moving ? { right: true } : {});
    if (moving) closeTo(game.players.creature!.x - before, GAMEPLAY.speed.creature / GAMEPLAY.tickRate);
    assert.equal(game.creatureState.lit, true);
    assert.equal(isStaggered(game.creatureState), false, `no re-stagger at tick ${tick}`);
    assert.equal(isOnStaggerCooldown(game.creatureState), true);
    assert.equal(isRevealed(game.creatureState), true);
    assert.equal(hunterView(game).creature?.staggered, false);
    closeTo(game.creatureState.hp, hp - damagePerTick);
    hp = game.creatureState.hp;
  }
  // The cooldown expires on the next step, so that lit step staggers again.
  step(game, 1, { light: true });
  assert.equal(isStaggered(game.creatureState), true);
  assert.equal(isOnStaggerCooldown(game.creatureState), true);
  closeTo(creatureView(game).staggerCooldown, GAMEPLAY.creature.staggerCooldownSeconds);
});

test('the Creature stays visible for the linger period, then leaves the Hunter payload entirely', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  step(game, 1, { light: true });
  const revealedAt = { ...game.players.creature! };
  const revealed = hunterView(game);
  assert.deepEqual(revealed.creature, { position: revealedAt, staggered: true, sprinting: false });
  assert.equal(creatureView(game).revealed, true);

  // Light off: every step of the linger still carries the position.
  for (let tick = 1; tick < lingerTicks; tick++) {
    step(game, 1);
    const view = hunterView(game);
    assert.deepEqual(view.creature?.position, revealedAt, `visible during linger tick ${tick}`);
    assert.equal(creatureView(game).revealed, true);
    assert.equal(creatureView(game).lit, false);
  }
  step(game, 1);
  const hidden = hunterView(game);
  assert.equal('creature' in hidden, false, 'the key is removed, not flagged');
  assert.equal(creatureView(game).revealed, false);
  const wire = JSON.stringify(hidden);
  assert.equal(wire.includes(String(revealedAt.x)), false);
  assert.equal(wire.includes(String(revealedAt.z)), false);
  assert.equal(wire.includes('staggered'), false);
  assert.equal(wire.includes('sprinting'), false);
  // Still staggered and hidden: the Hunter learns nothing further about the stagger either.
  assert.equal(isStaggered(game.creatureState), true);
  assert.deepEqual(Object.keys(hidden).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'hunter', 'facing', 'light', 'proximity', 'creatureHp',
  ].sort());
});

test('illuminating the Creature again refreshes the visibility linger', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  step(game, 1, { light: true });
  step(game, lingerTicks - 3);
  assert.ok(hunterView(game).creature);
  step(game, 1, { light: true });
  assert.equal(game.creatureState.revealTicks, lingerTicks);
  step(game, lingerTicks - 1);
  assert.ok(hunterView(game).creature, 'visible until the refreshed linger ends');
  step(game, 1);
  assert.equal('creature' in hunterView(game), false);
});

test('Creature HP reaching zero ends the round with a Hunter victory and freezes both players', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  game.creatureState.hp = damagePerTick * 2.5;
  step(game, 2, { light: true });
  assert.equal(game.roundState, 'running');
  step(game, 1, { light: true });
  assert.equal(game.creatureState.hp, 0);
  assert.equal(game.roundState, 'ended');
  assert.equal(game.result, 'defeated');
  assert.equal(hunterView(game).result, 'defeated');
  assert.equal(creatureView(game).result, 'defeated');
  assert.equal(hunterView(game).creatureHp, 0);

  const finalPositions = structuredClone(game.players);
  for (let tick = 0; tick < 10; tick++) {
    assert.equal(setInput(game, 'hunter', input(game, { right: true, light: true })), false);
    assert.equal(setInput(game, 'creature', input(game, { left: true })), false);
    stepGame(game);
  }
  assert.deepEqual(game.players, finalPositions);
  assert.equal(game.creatureState.hp, 0);

  restartGame(game);
  assert.equal(game.roundState, 'running');
  assert.equal(game.result, null);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(isRevealed(game.creatureState), false);
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(isOnStaggerCooldown(game.creatureState), false);
  assert.equal(game.inputs.hunter.light, false);
  assert.equal('creature' in hunterView(game), false);
});

test('the Creature tagging the Hunter still wins, even in the same step the light would reveal it', () => {
  // Plain tag with the light off.
  const plain = huntGame(LANE_HUNTER, groundPosition(LANE_HUNTER.x + 2 * radius + 5, LANE_HUNTER.z));
  step(plain, 1, {}, { left: true });
  assert.equal(plain.result, 'caught');
  assert.equal(hunterView(plain).result, 'caught');
  assert.equal(creatureView(plain).result, 'caught');

  // Same geometry with the light held: the Creature is in the cone, yet the tag
  // resolves first and the flashlight is never applied.
  const raced = huntGame(LANE_HUNTER, groundPosition(LANE_HUNTER.x + 2 * radius + 5, LANE_HUNTER.z));
  assert.equal(flashlightHitsCreature(raced.players.hunter!, raced.hunterFacing, raced.players.creature!), true);
  step(raced, 1, { light: true }, { left: true });
  assert.equal(raced.roundState, 'ended');
  assert.equal(raced.result, 'caught');
  assert.equal(raced.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(raced.creatureState.lit, false);
  assert.equal(isStaggered(raced.creatureState), false);
  assert.equal('creature' in hunterView(raced), false, 'a hidden Creature stays hidden after catching');
});

test('players collide with interior walls, slide along them, and are never placed inside one', () => {
  const [northSlab, , , westSlab] = ARENA_OBSTACLES;
  for (const role of ['hunter', 'creature'] as const) {
    // Straight into the west face of the west slab: stops with the sphere touching it.
    const game = role === 'hunter'
      ? huntGame(groundPosition(300, 300), groundPosition(900, 60))
      : huntGame(groundPosition(900, 60), groundPosition(300, 300));
    step(game, 30, role === 'hunter' ? { right: true } : {}, role === 'creature' ? { right: true } : {});
    assert.equal(game.roundState, 'running');
    closeTo(game.players[role]!.x, westSlab.min.x - radius);
    assert.equal(game.players[role]!.z, 300);

    // Diagonal input against the same face keeps the parallel component: sliding.
    const sliding = role === 'hunter'
      ? huntGame(groundPosition(300, 300), groundPosition(900, 60))
      : huntGame(groundPosition(900, 60), groundPosition(300, 300));
    const keys = { right: true, down: true };
    step(sliding, 20, role === 'hunter' ? keys : {}, role === 'creature' ? keys : {});
    closeTo(sliding.players[role]!.x, westSlab.min.x - radius);
    closeTo(sliding.players[role]!.z, 300 + 20 * (GAMEPLAY.speed[role] / GAMEPLAY.tickRate) * Math.SQRT1_2);
  }

  // Pressing up beneath the north slab stops the sphere on its south face.
  const cornered = huntGame(groundPosition(540, 175), groundPosition(900, 60));
  step(cornered, 30, { up: true });
  closeTo(cornered.players.hunter!.z, northSlab.max.z + radius);
  assert.equal(cornered.players.hunter!.x, 540);

  // A position overlapping a slab is pushed out to a non-overlapping one.
  const inside = constrainToWalls(groundPosition(328, 300));
  assert.ok(inside.x <= westSlab.min.x - radius || inside.x >= westSlab.max.x + radius);
  assert.equal(inside.y, groundedY);
  // Clear positions are returned unchanged, so idle steps never drift.
  assert.deepEqual(constrainToWalls(groundPosition(300, 300)), groundPosition(300, 300));

  for (let round = 0; round < 200; round++) {
    restartGame(cornered);
    for (const role of ['hunter', 'creature'] as const) {
      const spawn = cornered.players[role]!;
      assert.deepEqual(constrainToWalls(spawn), spawn, `${role} spawn overlaps a wall: ${JSON.stringify(spawn)}`);
      assert.equal(spawn.y, groundedY);
    }
  }
});

test('the Hunter turns gradually toward the held direction at the configured speed', () => {
  const idle = { up: false, down: false, left: false, right: false, light: false };
  // Quarter turn from the spawn facing (up) to right: 90 degrees, one capped step per
  // tick, with the final tick landing exactly on the target when it is not a multiple.
  let facing = -Math.PI / 2;
  const quarterTicks = Math.ceil((Math.PI / 2) / turnStep - 1e-9);
  for (let tick = 1; tick <= quarterTicks; tick++) {
    facing = turnToward(facing, { ...idle, right: true });
    closeTo(facing, Math.min(-Math.PI / 2 + tick * turnStep, EAST));
  }
  closeTo(facing, EAST);
  assert.equal(turnToward(EAST, { ...idle, right: true }), EAST, 'aligned facing does not overshoot');
  assert.equal(turnToward(0.3, idle), 0.3, 'no input keeps the facing');
  assert.equal(turnToward(0.3, { ...idle, up: true, down: true }), 0.3, 'cancelled input keeps the facing');
  closeTo(turnToward(EAST, { ...idle, up: true, right: true }), Math.max(-Math.PI / 4, -turnStep), 1e-12);

  // A reversal is a full half turn, always in the positive direction.
  facing = EAST;
  const halfTicks = Math.ceil(Math.PI / turnStep - 1e-9);
  for (let tick = 1; tick <= halfTicks; tick++) {
    const previous = facing;
    facing = turnToward(facing, { ...idle, left: true });
    assert.ok(Math.sin(facing - previous) >= 0, 'turns the positive way');
  }
  closeTo(Math.cos(facing), -1);
  closeTo(Math.sin(facing), 0);

  // In the simulation the body moves immediately while the light lags behind; a
  // wall may stop the body without stopping the turn.
  const game = huntGame(groundPosition(GAMEPLAY.arena.width - radius, 300), groundPosition(100, 60), -Math.PI / 2);
  step(game, 3, { right: true });
  assert.equal(game.players.hunter!.x, GAMEPLAY.arena.width - radius);
  closeTo(game.hunterFacing, Math.min(-Math.PI / 2 + 3 * turnStep, EAST));
  closeTo(hunterView(game).facing, game.hunterFacing);
  closeTo(creatureView(game).hunterFacing!, game.hunterFacing);
  const moving = huntGame(groundPosition(100, 60), groundPosition(900, 500), -Math.PI / 2);
  step(moving, 1, { right: true });
  closeTo(moving.players.hunter!.x, 100 + GAMEPLAY.speed.hunter / GAMEPLAY.tickRate);
  closeTo(moving.hunterFacing, Math.min(-Math.PI / 2 + turnStep, EAST));
  step(moving, 1);
  closeTo(moving.hunterFacing, Math.min(-Math.PI / 2 + turnStep, EAST), 1e-12);
});

test('the action flag must be a boolean; the Creature press sprints but never lights anything', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  for (const light of [1, 'true', null, undefined]) {
    assert.equal(setInput(game, 'hunter', { ...input(game), light }), false);
  }
  const { light: _omitted, ...withoutLight } = input(game);
  assert.equal(setInput(game, 'hunter', withoutLight), false);
  assert.equal(game.inputs.hunter.light, false);
  assert.equal(hunterView(game).light, false);
  assert.equal(creatureView(game).hunterLight, false);

  hold(game, 'creature', { light: true });
  stepGame(game);
  assert.equal(game.creatureState.sprinting, true);
  assert.equal(game.creatureState.lit, false);
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(creatureView(game).hunterLight, false);

  hold(game, 'hunter', { light: true });
  assert.equal(hunterView(game).light, true);
  assert.equal(creatureView(game).hunterLight, true);
});

// Sprint: the Creature's own use of the Space / left mouse button.
// Hunter at the north-east corner, Creature on the open south corridor: no tag, no light.
const SPRINT_HUNTER = groundPosition(900, 60);
const SPRINT_CREATURE = groundPosition(100, 540);

test('holding the action button sprints the Creature at the configured speed, and only the Creature', () => {
  assert.ok(sprintStep > creatureStep, 'sprint must be faster than walking');
  assert.ok(sprintStep < GAMEPLAY.arena.wallThickness, 'one sprint step must not cross a wall');
  const game = huntGame(SPRINT_HUNTER, SPRINT_CREATURE);
  let x = game.players.creature!.x;
  step(game, 1, {}, { right: true });
  closeTo(game.players.creature!.x - x, creatureStep);
  assert.equal(game.creatureState.sprinting, false);
  x = game.players.creature!.x;
  step(game, 1, {}, { right: true, light: true });
  closeTo(game.players.creature!.x - x, sprintStep);
  assert.equal(game.creatureState.sprinting, true);
  assert.equal(creatureView(game).sprinting, true);
  // Diagonal sprinting is normalized like walking.
  const before = { ...game.players.creature! };
  step(game, 1, {}, { right: true, down: true, light: true });
  closeTo(distance3D(game.players.creature!, before), sprintStep);
  assert.equal(game.players.creature!.y, groundedY);
  // The Hunter's button is the flashlight; the Hunter's speed never changes.
  const hunterX = game.players.hunter!.x;
  step(game, 1, { left: true, light: true }, { right: true, light: true });
  closeTo(hunterX - game.players.hunter!.x, GAMEPLAY.speed.hunter / GAMEPLAY.tickRate);
  assert.equal(hunterView(game).light, true);
  assert.equal(game.creatureState.lit, false, 'the Creature is far outside the beam');
});

test('a sprinting Creature is revealed to the Hunter without any light, then lingers and vanishes', () => {
  const game = huntGame(SPRINT_HUNTER, SPRINT_CREATURE);
  // A stationary hold is still a sprint: visible, for no gain.
  step(game, 1, {}, { light: true });
  assert.equal(game.creatureState.sprinting, true);
  assert.equal(isRevealed(game.creatureState), true);
  const seen = hunterView(game);
  assert.equal(seen.light, false);
  assert.deepEqual(seen.creature, { position: { ...game.players.creature! }, staggered: false, sprinting: true });
  assert.equal(seen.creatureHp, GAMEPLAY.creature.maxHp);
  const own = creatureView(game);
  assert.equal(own.sprinting, true);
  assert.equal(own.revealed, true);
  assert.equal(own.lit, false);
  assert.equal(own.staggered, false);
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(isOnStaggerCooldown(game.creatureState), false);

  // Every sprinting step refreshes the linger; sprinting costs no HP.
  step(game, 10, {}, { right: true, light: true });
  assert.equal(game.creatureState.hp, GAMEPLAY.creature.maxHp);
  assert.equal(game.creatureState.revealTicks, lingerTicks);
  assert.equal(hunterView(game).creature?.sprinting, true);
  const lastSeen = { ...game.players.creature! };

  // Release: the same linger as after the light, then the key is gone entirely.
  for (let tick = 1; tick < lingerTicks; tick++) {
    step(game, 1);
    assert.deepEqual(hunterView(game).creature, { position: lastSeen, staggered: false, sprinting: false }, `linger tick ${tick}`);
    assert.equal(creatureView(game).revealed, true);
    assert.equal(creatureView(game).sprinting, false);
  }
  step(game, 1);
  const hidden = hunterView(game);
  assert.equal('creature' in hidden, false);
  const wire = JSON.stringify(hidden);
  assert.equal(wire.includes(String(lastSeen.x)), false);
  assert.equal(wire.includes(String(lastSeen.z)), false);
  assert.equal(wire.includes('sprint'), false);
  assert.equal(creatureView(game).revealed, false);
});

test('a sprint that ends starts a short cooldown, and a held button resumes sprinting when it expires', () => {
  const game = huntGame(SPRINT_HUNTER, SPRINT_CREATURE);
  step(game, 3, {}, { right: true, light: true });
  assert.equal(creatureView(game).sprintCooldown, 0);
  // Release for one step: walking speed, and the cooldown begins.
  let x = game.players.creature!.x;
  step(game, 1, {}, { right: true });
  closeTo(game.players.creature!.x - x, creatureStep);
  assert.equal(game.creatureState.sprinting, false);
  closeTo(creatureView(game).sprintCooldown, GAMEPLAY.sprint.cooldownSeconds);
  // Holding again during the cooldown does nothing except show the timer. The linger
  // outlasts the cooldown, so a tap-tap never blinks the Creature out of view.
  assert.ok(sprintCooldownTicks < lingerTicks, 'cooldown must be shorter than the visibility linger');
  for (let tick = 1; tick < sprintCooldownTicks; tick++) {
    x = game.players.creature!.x;
    step(game, 1, {}, { right: true, light: true });
    closeTo(game.players.creature!.x - x, creatureStep);
    assert.equal(game.creatureState.sprinting, false, `blocked at cooldown tick ${tick}`);
    assert.equal(creatureView(game).sprinting, false);
    assert.ok(creatureView(game).sprintCooldown > 0);
    assert.ok(hunterView(game).creature, 'still visible through the cooldown');
  }
  // The step the cooldown reaches zero, the held button sprints again without a re-press.
  x = game.players.creature!.x;
  step(game, 1, {}, { right: true, light: true });
  closeTo(game.players.creature!.x - x, sprintStep);
  assert.equal(game.creatureState.sprinting, true);
  assert.equal(creatureView(game).sprintCooldown, 0);

  // Restart clears the sprint, its cooldown, and the reveal along with the held button.
  step(game, 1, {}, { right: true });
  assert.ok(game.creatureState.sprintCooldownTicks > 0);
  restartGame(game);
  assert.equal(game.creatureState.sprinting, false);
  assert.equal(game.creatureState.sprintCooldownTicks, 0);
  assert.equal(creatureView(game).sprintCooldown, 0);
  assert.equal('creature' in hunterView(game), false);
});

test('a flashlight hit ends the sprint: a staggered Creature cannot sprint, and it resumes once free', () => {
  const game = huntGame(LANE_HUNTER, LANE_CREATURE);
  // Sprinting east, away from the Hunter but still inside the beam's reach.
  step(game, 1, {}, { right: true, light: true });
  assert.equal(game.creatureState.sprinting, true);
  step(game, 1, { light: true }, { right: true, light: true });
  // Movement precedes the flashlight, so the hit step itself still moved at sprint speed...
  assert.equal(game.creatureState.lit, true);
  assert.equal(isStaggered(game.creatureState), true);
  assert.equal(game.creatureState.sprinting, true);
  // ...and from the next step the stagger freezes the Creature and the sprint is over.
  const frozen = { ...game.players.creature! };
  step(game, 1, {}, { right: true, light: true });
  assert.deepEqual(game.players.creature, frozen);
  assert.equal(game.creatureState.sprinting, false);
  assert.equal(creatureView(game).sprinting, false);
  assert.equal(hunterView(game).creature?.sprinting, false);
  assert.equal(hunterView(game).creature?.staggered, true);
  closeTo(creatureView(game).sprintCooldown, GAMEPLAY.sprint.cooldownSeconds);
  // Held for the rest of the stagger: still frozen, never sprinting.
  step(game, staggerTicks - 2, {}, { right: true, light: true });
  assert.deepEqual(game.players.creature, frozen);
  assert.equal(isStaggered(game.creatureState), true);
  assert.equal(game.creatureState.sprinting, false);
  // The step the stagger expires, the held button sprints at once: the cooldown ended long ago.
  step(game, 1, {}, { right: true, light: true });
  assert.equal(isStaggered(game.creatureState), false);
  assert.equal(game.creatureState.sprinting, true);
  closeTo(game.players.creature!.x - frozen.x, sprintStep);
});

test('a sprinting Creature can still tag, and a sprint begun in the tag step reveals nothing', () => {
  // A gap one walking step cannot close in a single step, but one sprint step can.
  const gap = (creatureStep + sprintStep) / 2;
  const start = groundPosition(LANE_HUNTER.x + 2 * radius + gap, LANE_HUNTER.z);
  const walking = huntGame(LANE_HUNTER, start);
  step(walking, 1, {}, { left: true });
  assert.equal(walking.roundState, 'running');
  const sprinting = huntGame(LANE_HUNTER, start);
  step(sprinting, 1, {}, { left: true, light: true });
  assert.equal(sprinting.roundState, 'ended');
  assert.equal(sprinting.result, 'caught');
  assert.equal(hunterView(sprinting).result, 'caught');
  assert.equal(creatureView(sprinting).result, 'caught');
  // The tag resolves before the sprint reveal: the Hunter never learns where it came from.
  assert.equal(isRevealed(sprinting.creatureState), false);
  assert.equal('creature' in hunterView(sprinting), false);
});
