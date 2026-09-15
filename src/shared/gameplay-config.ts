// 3D world units, seconds, and center-to-center distances. Y is up; X/Z is ground.
// No spawn coordinates or private randomness belong in this shared file.
export const GAMEPLAY = {
  arena: { width: 960, depth: 600, floorY: 0, wallThickness: 16, wallHeight: 24 },
  playerRadius: 14,
  speed: { hunter: 220, creature: 250 },
  proximity: { uneasy: 360, danger: 220, immediate: 90 },
  tickRate: 30,
  inputTimeoutMs: 300,
} as const;
