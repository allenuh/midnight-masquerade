export type Role = 'hunter' | 'creature';
// Hunter slot labels, assigned in room join order when a round starts.
export type HunterId = 'H1' | 'H2' | 'H3' | 'H4';
export type ProximityState = 'SAFE' | 'UNEASY' | 'DANGER' | 'IMMEDIATE';
// 'lobby': no round; players wait in the room. 'reveal': roles are assigned and shown, nobody
// moves yet. 'running': the round is played. 'ended': a result is shown until the host starts again.
export type RoundState = 'lobby' | 'reveal' | 'running' | 'ended';
// 'caught': every Hunter is incapacitated at once (Creature wins).
// 'defeated': Creature HP reached zero under the flashlight (Hunters win).
export type RoundResult = 'caught' | 'defeated';
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
  | ({ type: 'input'; roundId: number } & InputState);

// What every player in a round learns about each Hunter: public position and facing,
// whether the server counts its flashlight as on, and its team state. Never a proximity
// band or anything about the Creature.
export type HunterView = {
  id: HunterId;
  position: Position;
  // Facing angle in radians on the ground plane: direction = (cos, 0, sin). W (up) is -PI/2.
  facing: number;
  light: boolean;
  down: boolean;
  // Revival progress 0..1 while down; always 0 while active.
  revive: number;
};

// Room membership, sent whenever it changes and whenever a round is abandoned.
// `host` is per recipient. `notice` explains why a round was cut short.
export type RoomMessage = {
  type: 'room';
  code: string;
  players: number;
  host: boolean;
  notice: 'disconnected' | null;
};

export type ErrorMessage = { type: 'error'; reason: 'not-found' | 'full' | 'host-left' };

type RoundSnapshot = {
  type: 'snapshot';
  roundId: number;
  roundState: Exclude<RoundState, 'lobby'>;
  result: RoundResult | null;
  hunters: HunterView[];
};

// Separate shapes make accidental hidden-state serialization harder to introduce.
export type HunterSnapshot = RoundSnapshot & {
  role: 'hunter';
  // Which entry of `hunters` is this client.
  self: HunterId;
  // This client's own band only; teammates' bands are never shared.
  proximity: ProximityState;
  creatureHp: number;
  // Present only while the Creature is revealed (lit or sprinting, or inside the visibility
  // linger). The key is absent otherwise: the Hunter never holds a hidden Creature transform.
  creature?: { position: Position; staggered: boolean; sprinting: boolean };
};
export type CreatureSnapshot = RoundSnapshot & {
  role: 'creature';
  creature: Position;
  hp: number;
  // lit: a flashlight reached you this tick. revealed: the Hunters are receiving your position.
  // staggered: you cannot move or tag. staggerCooldown: seconds until a hit can stagger again.
  // sprinting: you moved at sprint speed this tick. sprintCooldown: seconds until you can sprint.
  // attackCooldown: seconds until contact can incapacitate another Hunter.
  lit: boolean;
  revealed: boolean;
  staggered: boolean;
  staggerCooldown: number;
  sprinting: boolean;
  sprintCooldown: number;
  attackCooldown: number;
};
export type ServerMessage = RoomMessage | HunterSnapshot | CreatureSnapshot | ErrorMessage;
