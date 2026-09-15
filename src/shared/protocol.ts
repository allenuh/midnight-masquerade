export type Role = 'hunter' | 'creature';
export type ProximityState = 'SAFE' | 'UNEASY' | 'DANGER' | 'IMMEDIATE';
export type RoundState = 'waiting' | 'running' | 'ended';
// Authoritative world-space sphere center. Y is height, not a screen coordinate.
export type Position = { x: number; y: number; z: number };
export type InputState = { up: boolean; down: boolean; left: boolean; right: boolean };

export type ClientMessage =
  | ({ type: 'input'; roundId: number } & InputState)
  | { type: 'restart' };

type RoundSnapshot = {
  type: 'snapshot';
  roundId: number;
  roundState: RoundState;
  result: 'caught' | null;
};

// Separate shapes make accidental hidden-state serialization harder to introduce.
export type HunterSnapshot = RoundSnapshot & {
  role: 'hunter';
  hunter: Position;
  proximity: ProximityState;
};
export type CreatureSnapshot = RoundSnapshot & {
  role: 'creature';
  creature: Position;
  hunter: Position | null;
};
export type ServerMessage = HunterSnapshot | CreatureSnapshot | { type: 'full' };
