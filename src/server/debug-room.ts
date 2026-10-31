// DEBUG-ROOM: a temporary, developer-only room that starts a round without a full party. The
// empty slots are filled with dummy players: ids with no connection, so they never send input
// and stand still at their spawn all round. The round itself is an ordinary one (startRound is
// unchanged); only the host's role is chosen instead of rolled. To remove: delete this file,
// src/client/debug-room.ts and tests/debug-room.test.ts, then every line marked DEBUG-ROOM.
import type { DebugRole } from '../shared/protocol.js';
import { PLAYER_COUNT, startRound, type Game, type PlayerId } from './game.js';

export const DEBUG_ROLES: readonly DebugRole[] = ['hunter', 'creature', 'random'];
export const isDebugRole = (value: unknown): value is DebugRole => DEBUG_ROLES.includes(value as DebugRole);

// The real players, then dummies up to a full roster. Real ids are `p<n>`, so these never clash.
export function debugRoster(players: readonly PlayerId[]): PlayerId[] {
  const roster = [...players];
  for (let dummy = 1; roster.length < PLAYER_COUNT; dummy++) roster.push(`debug-dummy-${dummy}`);
  return roster;
}

// Starts a round for whoever is in the room plus dummies, then swaps the host into `role`: with
// the Creature for 'creature', with the first Hunter slot for 'hunter'. Positions stay with the
// slots, so the swap only changes who controls what.
export function startDebugRound(game: Game, players: readonly PlayerId[], host: PlayerId, role: DebugRole): void {
  startRound(game, debugRoster(players));
  const creature = game.creature!;
  const hostIsCreature = creature.player === host;
  if (role === 'creature' && !hostIsCreature) {
    const hunter = game.hunters.find((candidate) => candidate.player === host)!;
    hunter.player = creature.player;
    creature.player = host;
  } else if (role === 'hunter' && hostIsCreature) {
    creature.player = game.hunters[0].player;
    game.hunters[0].player = host;
  }
}
