import { randomInt } from 'node:crypto';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import { constrainToArena, distance3D, spheresTouchDuringStep } from './spatial.js';
import type {
  CreatureSnapshot, HunterSnapshot, InputState, Position, ProximityState, Role, RoundState,
} from '../shared/protocol.js';

export type Game = {
  players: Record<Role, Position | null>;
  inputs: Record<Role, InputState>;
  roundId: number;
  roundState: RoundState;
  result: 'caught' | null;
};

export const emptyInput = (): InputState => ({ up: false, down: false, left: false, right: false });

export function createGame(): Game {
  return {
    players: { hunter: null, creature: null },
    inputs: { hunter: emptyInput(), creature: emptyInput() },
    roundId: 0,
    roundState: 'waiting',
    result: null,
  };
}

function randomPosition(): Position {
  const { arena, playerRadius } = GAMEPLAY;
  return {
    x: randomInt(playerRadius, arena.width - playerRadius + 1),
    y: arena.floorY + playerRadius,
    z: randomInt(playerRadius, arena.depth - playerRadius + 1),
  };
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
  game.roundId += 1;
  game.roundState = 'running';
  game.result = null;
  clearInputs(game);
}

export function setInput(game: Game, role: Role, raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  const allowedKeys = ['type', 'roundId', 'up', 'down', 'left', 'right'];
  if (
    Object.keys(message).length !== allowedKeys.length ||
    Object.keys(message).some((key) => !allowedKeys.includes(key)) ||
    message.type !== 'input' || message.roundId !== game.roundId ||
    game.roundState !== 'running' || !game.players[role] ||
    typeof message.up !== 'boolean' || typeof message.down !== 'boolean' ||
    typeof message.left !== 'boolean' || typeof message.right !== 'boolean'
  ) return false;

  // A message only replaces held keys. It never advances time or trusts a position.
  game.inputs[role] = {
    up: message.up, down: message.down, left: message.left, right: message.right,
  };
  return true;
}

function move(position: Position, input: InputState, role: Role): Position {
  const dx = Number(input.right) - Number(input.left);
  const dz = Number(input.down) - Number(input.up);
  const length = Math.hypot(dx, dz);
  if (length === 0) return constrainToArena(position);
  const step = GAMEPLAY.speed[role] / GAMEPLAY.tickRate;
  return constrainToArena({ x: position.x + dx / length * step, y: position.y, z: position.z + dz / length * step });
}

export function proximityForDistance(value: number): ProximityState {
  if (value <= GAMEPLAY.proximity.immediate) return 'IMMEDIATE';
  if (value <= GAMEPLAY.proximity.danger) return 'DANGER';
  if (value <= GAMEPLAY.proximity.uneasy) return 'UNEASY';
  return 'SAFE';
}

export function stepGame(game: Game): void {
  const hunter = game.players.hunter;
  const creature = game.players.creature;
  if (game.roundState !== 'running' || !hunter || !creature) return;
  const nextHunter = move(hunter, game.inputs.hunter, 'hunter');
  const nextCreature = move(creature, game.inputs.creature, 'creature');

  const caught = spheresTouchDuringStep(hunter, nextHunter, creature, nextCreature);

  game.players.hunter = nextHunter;
  game.players.creature = nextCreature;
  if (caught) {
    game.roundState = 'ended';
    game.result = 'caught';
    clearInputs(game);
  }
}

export function snapshotFor(game: Game, role: Role): HunterSnapshot | CreatureSnapshot {
  const ownPosition = game.players[role];
  if (!ownPosition) throw new Error('Cannot create snapshot for an empty player slot');
  const round = {
    type: 'snapshot' as const,
    roundId: game.roundId,
    roundState: game.roundState,
    result: game.result,
  };

  // SECURITY: construct an allowlist for each role. Never serialize game.players,
  // spread private simulation state, or reveal the Creature even after a catch.
  if (role === 'hunter') {
    return {
      ...round,
      role: 'hunter',
      hunter: { x: ownPosition.x, y: ownPosition.y, z: ownPosition.z },
      proximity: game.players.creature
        ? proximityForDistance(distance3D(ownPosition, game.players.creature))
        : 'SAFE',
    };
  }
  return {
    ...round,
    role: 'creature',
    creature: { x: ownPosition.x, y: ownPosition.y, z: ownPosition.z },
    hunter: game.players.hunter ? { x: game.players.hunter.x, y: game.players.hunter.y, z: game.players.hunter.z } : null,
  };
}
