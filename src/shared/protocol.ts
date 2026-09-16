export type Role = 'hunter' | 'creature';
export type ProximityState = 'SAFE' | 'UNEASY' | 'DANGER' | 'IMMEDIATE';
export type RoundState = 'waiting' | 'running' | 'ended';
// 'caught': the Creature tagged the Hunter (Creature wins).
// 'defeated': Creature HP reached zero under the flashlight (Hunter wins).
export type RoundResult = 'caught' | 'defeated';
// Authoritative world-space sphere center. Y is height, not a screen coordinate.
export type Position = { x: number; y: number; z: number };
// Held keys only. `light` is the Space / left mouse button held flag: the flashlight for the
// Hunter, the sprint for the Creature.
export type InputState = { up: boolean; down: boolean; left: boolean; right: boolean; light: boolean };

export type ClientMessage =
  | ({ type: 'input'; roundId: number } & InputState)
  | { type: 'restart' };

type RoundSnapshot = {
  type: 'snapshot';
  roundId: number;
  roundState: RoundState;
  result: RoundResult | null;
};

// Separate shapes make accidental hidden-state serialization harder to introduce.
export type HunterSnapshot = RoundSnapshot & {
  role: 'hunter';
  hunter: Position;
  // Facing angle in radians on the ground plane: direction = (cos, 0, sin). W (up) is -PI/2.
  facing: number;
  // Whether the server currently counts the flashlight as on.
  light: boolean;
  proximity: ProximityState;
  creatureHp: number;
  // Present only while the Creature is revealed (lit or sprinting, or inside the visibility
  // linger). The key is absent otherwise: the Hunter never holds a hidden Creature transform.
  creature?: { position: Position; staggered: boolean; sprinting: boolean };
};
export type CreatureSnapshot = RoundSnapshot & {
  role: 'creature';
  creature: Position;
  hunter: Position | null;
  hunterFacing: number | null;
  hunterLight: boolean;
  hp: number;
  // lit: the flashlight reached you this tick. revealed: the Hunter is receiving your position.
  // staggered: you cannot move or tag. staggerCooldown: seconds until a hit can stagger again.
  // sprinting: you moved at sprint speed this tick. sprintCooldown: seconds until you can sprint.
  lit: boolean;
  revealed: boolean;
  staggered: boolean;
  staggerCooldown: number;
  sprinting: boolean;
  sprintCooldown: number;
};
export type ServerMessage = HunterSnapshot | CreatureSnapshot | { type: 'full' };
