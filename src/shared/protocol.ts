import type { GameMap } from './map/schema.js';
import type { Tuning } from './tuning.js';

export type Role = 'hunter' | 'creature';
// Hunter slot labels, assigned in room join order when a round starts.
export type HunterId = 'H1' | 'H2' | 'H3' | 'H4';
export type ProximityState = 'SAFE' | 'UNEASY' | 'DANGER' | 'IMMEDIATE';
// 'lobby': no round; players wait in the room. 'reveal': roles are assigned and shown, nobody
// moves yet. 'running': the round is played. 'ended': a result is shown until the host starts again.
export type RoundState = 'lobby' | 'reveal' | 'running' | 'ended';
// 'caught': every Hunter is incapacitated at once (Creature wins).
// 'defeated': Creature HP reached zero under the flashlight (Hunters win).
// 'expired': the match clock ran out with the Creature alive (Creature wins).
export type RoundResult = 'caught' | 'defeated' | 'expired';
// Authoritative world-space sphere center. Y is height, not a screen coordinate.
export type Position = { x: number; y: number; z: number };
// Held keys only. `light` is the Space / left mouse button held flag: the flashlight for the
// Hunter, the sprint for the Creature.
export type InputState = { up: boolean; down: boolean; left: boolean; right: boolean; light: boolean };

export type ClientMessage =
  | { type: 'create' }
  | { type: 'join'; code: string }
  // Host only: starts a round (or restarts the current one) once the room is full.
  | { type: 'start' }
  // Host only, and only between rounds: switch the room to another catalogued map.
  | { type: 'selectMap'; id: string }
  // Host only, and only between rounds: replace the room's gameplay tuning (every value,
  // validated and bounded on the server; see src/shared/tuning.ts).
  | { type: 'tune'; tuning: Tuning }
  | ({ type: 'input'; roundId: number } & InputState)
  // DEBUG-MENU: host only, while a round runs: set the match clock (0 ends the round as expired).
  | { type: 'setClock'; seconds: number }
  // DEBUG-ROOM: a room that can start without a full party, and its start with the host's role.
  | { type: 'debugCreate' }
  | { type: 'debugStart'; role: DebugRole };

// DEBUG-ROOM: the role the host takes in a debug room (src/server/debug-room.ts).
export type DebugRole = 'hunter' | 'creature' | 'random';

// What every player in a round learns about each Hunter: public position and facing,
// whether the server counts its flashlight as on, its remaining battery, and its team
// state. Never a proximity band or anything about the Creature.
export type HunterView = {
  id: HunterId;
  position: Position;
  // Facing angle in radians on the ground plane: direction = (cos, 0, sin). W (up) is -PI/2.
  facing: number;
  // False while down or out of battery: a beam that produces no gameplay effect is not drawn.
  light: boolean;
  // Remaining battery, 0..GAMEPLAY.battery.max. Public because the beam it powers is
  // visible in the world: every client derives this Hunter's cone length from it.
  battery: number;
  down: boolean;
  // Revival progress 0..1 while down; always 0 while active.
  revive: number;
};

// One entry of the server's map catalogue: enough for a picker, not the map itself.
export type MapSummary = { id: string; name: string };

// Room membership, sent whenever it changes, whenever a round is abandoned, and whenever
// the host switches map. `host` is per recipient. `notice` explains why a round was cut
// short. `maps` lists every playable map on the server and `mapId` is the room's choice.
export type RoomMessage = {
  type: 'room';
  code: string;
  players: number;
  host: boolean;
  notice: 'disconnected' | null;
  maps: MapSummary[];
  mapId: string;
  // The room's gameplay values, the same for everyone in it: the defaults unless the host
  // changed them. Public room data, so every client draws cones and stages to match.
  tuning: Tuning;
};

// The room's full map, sent on join and whenever the host switches. The client builds
// its scene from this and nothing else: it bundles no map of its own.
export type MapMessage = { type: 'map'; map: GameMap };

export type ErrorMessage = { type: 'error'; reason: 'not-found' | 'full' | 'host-left' };

type RoundSnapshot = {
  type: 'snapshot';
  roundId: number;
  roundState: Exclude<RoundState, 'lobby'>;
  result: RoundResult | null;
  hunters: HunterView[];
  // Authoritative seconds left on the match clock. It is full during the reveal, counts
  // down only while running, and holds its final value once the round ends. Clients display
  // it; they never decide expiration.
  timeRemaining: number;
  // Indices into the map's Battery Spawn markers (file order) that currently hold a pickup. The points
  // themselves are public map data both roles already have, so no coordinates are sent.
  pickups: number[];
};

// Separate shapes make accidental hidden-state serialization harder to introduce.
export type HunterSnapshot = RoundSnapshot & {
  role: 'hunter';
  // Which entry of `hunters` is this client.
  self: HunterId;
  // This client's own band only; teammates' bands are never shared.
  proximity: ProximityState;
  // This client's own distance to the Creature, coarsely: whole steps of the UNEASY radius, from
  // 0 (SAFE) to GAMEPLAY.proximity.dreadSteps (touching). Never sent to teammates or the Creature.
  dread: number;
  creatureHp: number;
  // Present only while the Creature is revealed (lit or sprinting, or inside the visibility
  // linger). The key is absent otherwise: the Hunter never holds a hidden Creature transform.
  // `facing` is the Creature's last held movement direction, in the same angle as a Hunter's.
  creature?: { position: Position; facing: number; staggered: boolean; sprinting: boolean; burning: boolean };
};
export type CreatureSnapshot = RoundSnapshot & {
  role: 'creature';
  creature: Position;
  // Your last held movement direction (as HunterView.facing), kept while a wall stops you.
  facing: number;
  hp: number;
  // lit: a flashlight reached you this tick. revealed: the Hunters are receiving your position.
  // staggered: you cannot move or tag. staggerCooldown: seconds until a hit can stagger again.
  // sprinting: you moved at sprint speed this tick. sprintCooldown: seconds until you can sprint.
  // attackCooldown: seconds until contact can incapacitate another Hunter.
  // burning: a recent flashlight hit; contact cannot incapacitate. burnRemaining: seconds left.
  lit: boolean;
  revealed: boolean;
  staggered: boolean;
  staggerCooldown: number;
  sprinting: boolean;
  sprintCooldown: number;
  attackCooldown: number;
  burning: boolean;
  burnRemaining: number;
};
export type ServerMessage = RoomMessage | MapMessage | HunterSnapshot | CreatureSnapshot | ErrorMessage;
