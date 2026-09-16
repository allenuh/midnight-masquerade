import { randomInt } from 'node:crypto';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import { segmentBlocked } from '../shared/raycast.js';
import { constrainToWalls, distance3D, sphereInCone, spheresTouchDuringStep } from './spatial.js';
import type {
  CreatureSnapshot, HunterSnapshot, InputState, Position, ProximityState, Role, RoundResult, RoundState,
} from '../shared/protocol.js';

// Distinct Creature conditions, each its own countdown:
//   revealed  (revealTicks > 0)          the Hunter receives the Creature position
//   staggered (staggerTicks > 0)         the Creature cannot move or tag
//   cooldown  (staggerCooldownTicks > 0) a flashlight hit damages and reveals but cannot stagger
//   sprint cooldown (sprintCooldownTicks > 0) the held sprint button does nothing
export type CreatureState = {
  hp: number;
  lit: boolean; // the flashlight reached the Creature during the last step
  sprinting: boolean; // the last step moved the Creature at sprint speed
  revealTicks: number;
  staggerTicks: number;
  staggerCooldownTicks: number;
  sprintCooldownTicks: number;
};

export type Game = {
  players: Record<Role, Position | null>;
  inputs: Record<Role, InputState>;
  hunterFacing: number;
  creatureState: CreatureState;
  roundId: number;
  roundState: RoundState;
  result: RoundResult | null;
};

// One fixed simulation step. Movement, damage, and countdowns all use it, so
// gameplay is measured in simulation seconds rather than frames or client clocks.
export const STEP_SECONDS = 1 / GAMEPLAY.tickRate;
export const secondsToTicks = (seconds: number): number => Math.round(seconds * GAMEPLAY.tickRate);
// Radians on the ground plane: direction = (cos, 0, sin). -PI/2 is -Z, "up" on screen.
export const SPAWN_FACING = -Math.PI / 2;

export const emptyInput = (): InputState => ({ up: false, down: false, left: false, right: false, light: false });
export const isRevealed = (state: CreatureState): boolean => state.revealTicks > 0;
export const isStaggered = (state: CreatureState): boolean => state.staggerTicks > 0;
export const isOnStaggerCooldown = (state: CreatureState): boolean => state.staggerCooldownTicks > 0;

const freshCreatureState = (): CreatureState => ({
  hp: GAMEPLAY.creature.maxHp, lit: false, sprinting: false,
  revealTicks: 0, staggerTicks: 0, staggerCooldownTicks: 0, sprintCooldownTicks: 0,
});

export function createGame(): Game {
  return {
    players: { hunter: null, creature: null },
    inputs: { hunter: emptyInput(), creature: emptyInput() },
    hunterFacing: SPAWN_FACING,
    creatureState: freshCreatureState(),
    roundId: 0,
    roundState: 'waiting',
    result: null,
  };
}

function randomPosition(): Position {
  const { arena, playerRadius } = GAMEPLAY;
  let candidate: Position;
  let attempts = 0;
  do {
    candidate = {
      x: randomInt(playerRadius, arena.width - playerRadius + 1),
      y: arena.floorY + playerRadius,
      z: randomInt(playerRadius, arena.depth - playerRadius + 1),
    };
    attempts += 1;
    // Reject spawns overlapping an obstacle; constraining a clear spawn changes nothing.
  } while (distance3D(candidate, constrainToWalls(candidate)) > 0 && attempts < 100);
  return constrainToWalls(candidate);
}

function clearInputs(game: Game): void {
  game.inputs.hunter = emptyInput();
  game.inputs.creature = emptyInput();
}

export function joinGame(game: Game, role: Role): void {
  if (game.players[role]) return;
  game.players[role] = randomPosition();
  restartGame(game);
}

export function leaveGame(game: Game, role: Role): void {
  game.players[role] = null;
  game.roundState = 'waiting';
  game.result = null;
  game.creatureState = freshCreatureState();
  clearInputs(game);
}

export function restartGame(game: Game): void {
  if (!game.players.hunter || !game.players.creature) return;
  // Private independent randomness: Hunter coordinates / public round IDs do not
  // determine the Creature's spawn. No seed or spawn table is sent to clients.
  game.players.hunter = randomPosition();
  let attempts = 0;
  do {
    game.players.creature = randomPosition();
    attempts += 1;
  } while (distance3D(game.players.hunter, game.players.creature) <= GAMEPLAY.proximity.uneasy && attempts < 100);
  game.hunterFacing = SPAWN_FACING;
  game.creatureState = freshCreatureState();
  game.roundId += 1;
  game.roundState = 'running';
  game.result = null;
  clearInputs(game);
}

export function setInput(game: Game, role: Role, raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  const allowedKeys = ['type', 'roundId', 'up', 'down', 'left', 'right', 'light'];
  if (
    Object.keys(message).length !== allowedKeys.length ||
    Object.keys(message).some((key) => !allowedKeys.includes(key)) ||
    message.type !== 'input' || message.roundId !== game.roundId ||
    game.roundState !== 'running' || !game.players[role] ||
    typeof message.up !== 'boolean' || typeof message.down !== 'boolean' ||
    typeof message.left !== 'boolean' || typeof message.right !== 'boolean' ||
    typeof message.light !== 'boolean'
  ) return false;

  // A message only replaces held keys. It never advances time or trusts a position.
  // The same `light` flag is the Hunter's flashlight and the Creature's sprint button.
  game.inputs[role] = {
    up: message.up, down: message.down, left: message.left, right: message.right, light: message.light,
  };
  return true;
}

function move(position: Position, input: InputState, speed: number): Position {
  const dx = Number(input.right) - Number(input.left);
  const dz = Number(input.down) - Number(input.up);
  const length = Math.hypot(dx, dz);
  if (length === 0) return constrainToWalls(position);
  const step = speed * STEP_SECONDS;
  return constrainToWalls({ x: position.x + dx / length * step, y: position.y, z: position.z + dz / length * step });
}

// Wrap to [-PI, PI).
function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
}

// The facing chases the held movement direction at a fixed angular speed. It
// turns even when a wall stops the body, and keeps its value with no input.
export function turnToward(facing: number, input: InputState): number {
  const dx = Number(input.right) - Number(input.left);
  const dz = Number(input.down) - Number(input.up);
  if (dx === 0 && dz === 0) return facing;
  const desired = Math.atan2(dz, dx);
  const maxStep = GAMEPLAY.hunterTurnSpeed * (Math.PI / 180) * STEP_SECONDS;
  let difference = wrapAngle(desired - facing);
  // An exact reversal has no shorter side; always turn in the positive direction.
  if (difference < -Math.PI + 1e-9) difference = Math.PI;
  if (Math.abs(difference) <= maxStep) return desired;
  return wrapAngle(facing + Math.sign(difference) * maxStep);
}

export function proximityForDistance(value: number): ProximityState {
  if (value <= GAMEPLAY.proximity.immediate) return 'IMMEDIATE';
  if (value <= GAMEPLAY.proximity.danger) return 'DANGER';
  if (value <= GAMEPLAY.proximity.uneasy) return 'UNEASY';
  return 'SAFE';
}

// The flashlight originates at the Hunter's center, which collision keeps out of
// every wall. The Creature is lit when its sphere overlaps the cone and the
// straight line from the origin to its center crosses no wall box.
export function flashlightHitsCreature(hunter: Position, facing: number, creature: Position): boolean {
  return sphereInCone(hunter, facing, creature, GAMEPLAY.playerRadius) && !segmentBlocked(hunter, creature);
}

function endRound(game: Game, result: RoundResult): void {
  game.roundState = 'ended';
  game.result = result;
  clearInputs(game);
}

// Step order: countdowns expire, both players move (the Creature at sprint speed
// while sprinting), a tag is resolved, then the flashlight and the sprint reveal
// are applied. A tag that occurs this step therefore still defeats the Hunter
// even when the same step would have revealed the Creature.
export function stepGame(game: Game): void {
  const hunter = game.players.hunter;
  const creature = game.players.creature;
  if (game.roundState !== 'running' || !hunter || !creature) return;
  const state = game.creatureState;

  state.revealTicks = Math.max(0, state.revealTicks - 1);
  state.staggerTicks = Math.max(0, state.staggerTicks - 1);
  state.staggerCooldownTicks = Math.max(0, state.staggerCooldownTicks - 1);
  state.sprintCooldownTicks = Math.max(0, state.sprintCooldownTicks - 1);

  game.hunterFacing = turnToward(game.hunterFacing, game.inputs.hunter);
  const nextHunter = move(hunter, game.inputs.hunter, GAMEPLAY.speed.hunter);

  // The sprint is re-evaluated every step from the held button: it cannot run while
  // staggered or during the cooldown that follows every sprint, and a button held
  // through that cooldown resumes sprinting on the step the cooldown expires.
  const sprinting = game.inputs.creature.light && !isStaggered(state) && state.sprintCooldownTicks === 0;
  if (state.sprinting && !sprinting) state.sprintCooldownTicks = secondsToTicks(GAMEPLAY.sprint.cooldownSeconds);
  state.sprinting = sprinting;
  const nextCreature = isStaggered(state)
    ? constrainToWalls(creature)
    : move(creature, game.inputs.creature, sprinting ? GAMEPLAY.sprint.speed : GAMEPLAY.speed.creature);
  game.players.hunter = nextHunter;
  game.players.creature = nextCreature;

  // A staggered Creature cannot attack, so contact with it is not a tag.
  if (!isStaggered(state) && spheresTouchDuringStep(hunter, nextHunter, creature, nextCreature)) {
    endRound(game, 'caught');
    return;
  }

  state.lit = game.inputs.hunter.light && flashlightHitsCreature(nextHunter, game.hunterFacing, nextCreature);
  if (state.lit) {
    state.hp = Math.max(0, state.hp - GAMEPLAY.flashlight.damagePerSecond * STEP_SECONDS);
    // Every lit step refreshes the linger. Only a hit outside the cooldown staggers,
    // and that hit also starts the cooldown, so continuous light never re-staggers
    // until the cooldown has fully expired.
    state.revealTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);
    if (!isOnStaggerCooldown(state)) {
      state.staggerTicks = secondsToTicks(GAMEPLAY.creature.staggerSeconds);
      state.staggerCooldownTicks = secondsToTicks(GAMEPLAY.creature.staggerCooldownSeconds);
    }
  }
  // A sprinting Creature is revealed exactly like a lit one and shares its linger, so
  // tapping the button cannot flicker it in and out of the Hunter's view. Sprinting
  // itself never damages or staggers.
  if (state.sprinting) state.revealTicks = secondsToTicks(GAMEPLAY.creature.visibilityLingerSeconds);
  if (state.hp <= 0) endRound(game, 'defeated');
}

const copyPosition = (position: Position): Position => ({ x: position.x, y: position.y, z: position.z });

export function snapshotFor(game: Game, role: Role): HunterSnapshot | CreatureSnapshot {
  const ownPosition = game.players[role];
  if (!ownPosition) throw new Error('Cannot create snapshot for an empty player slot');
  const state = game.creatureState;
  const round = {
    type: 'snapshot' as const,
    roundId: game.roundId,
    roundState: game.roundState,
    result: game.result,
  };

  // SECURITY: construct an allowlist for each role. Never serialize game.players,
  // spread private simulation state, or reveal the Creature after a catch.
  if (role === 'hunter') {
    const snapshot: HunterSnapshot = {
      ...round,
      role: 'hunter',
      hunter: copyPosition(ownPosition),
      facing: game.hunterFacing,
      light: game.inputs.hunter.light,
      proximity: game.players.creature
        ? proximityForDistance(distance3D(ownPosition, game.players.creature))
        : 'SAFE',
      creatureHp: state.hp,
    };
    // The Creature position exists in this payload only while revealed. Once the
    // linger expires the key is gone, not merely flagged invisible.
    if (game.players.creature && isRevealed(state)) {
      snapshot.creature = {
        position: copyPosition(game.players.creature), staggered: isStaggered(state), sprinting: state.sprinting,
      };
    }
    return snapshot;
  }
  return {
    ...round,
    role: 'creature',
    creature: copyPosition(ownPosition),
    hunter: game.players.hunter ? copyPosition(game.players.hunter) : null,
    hunterFacing: game.players.hunter ? game.hunterFacing : null,
    hunterLight: !!game.players.hunter && game.inputs.hunter.light,
    hp: state.hp,
    lit: state.lit,
    revealed: isRevealed(state),
    staggered: isStaggered(state),
    staggerCooldown: state.staggerCooldownTicks * STEP_SECONDS,
    sprinting: state.sprinting,
    sprintCooldown: state.sprintCooldownTicks * STEP_SECONDS,
  };
}
