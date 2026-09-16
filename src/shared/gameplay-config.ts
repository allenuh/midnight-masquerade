// 3D world units, seconds, and center-to-center distances. Y is up; X/Z is ground.
// No spawn coordinates or private randomness belong in this shared file.
export const GAMEPLAY = {
  arena: { width: 960, depth: 600, floorY: 0, wallThickness: 26, wallHeight: 28 },
  // Shared collision radius for both roles. A tag is sphere contact: distance <= 2 * playerRadius.
  playerRadius: 14,
  speed: { hunter: 110, creature: 150 },
  // Degrees per second. The flashlight follows this facing; movement itself is not delayed.
  hunterTurnSpeed: 720,
  // coneAngle is the full cone width in degrees. Range is measured from the Hunter's center.
  flashlight: { range: 140, coneAngle: 60, damagePerSecond: 6 },
  // The stagger cooldown starts at the same moment as the stagger, so with these values the
  // Creature is frozen for 3 s and then has 3 s of light exposure that cannot stagger it again.
  creature: { maxHp: 100, staggerSeconds: 1, staggerCooldownSeconds: 6, visibilityLingerSeconds: 0.5 },
  // Creature sprint (the GDD's Dash): held Space / left mouse button replaces speed.creature with
  // sprint.speed and reveals the Creature. The cooldown runs after every sprint before the next.
  // Keep speed / tickRate below arena.wallThickness so one step can never cross a wall.
  sprint: { speed: 240, cooldownSeconds: 0.2 },
  proximity: { uneasy: 360, danger: 220, immediate: 90 },
  tickRate: 30,
  inputTimeoutMs: 300,
} as const;
