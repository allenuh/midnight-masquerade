// 3D world units, seconds, and center-to-center distances. Y is up; X/Z is ground.
// No spawn coordinates or private randomness belong in this shared file.
export const GAMEPLAY = {
  // A round is exactly one Creature plus this many Hunters; a room holds hunters + 1 players.
  players: { hunters: 4 },
  // Seconds each client shows its private role before the round starts running.
  roleRevealSeconds: 3,
  arena: { width: 960, depth: 600, floorY: 0, wallThickness: 26, wallHeight: 28 },
  // Shared collision radius for both roles. A tag is sphere contact: distance <= 2 * playerRadius.
  playerRadius: 14,
  speed: { hunter: 110, creature: 150 },
  // Degrees per second. The flashlight follows this facing; movement itself is not delayed.
  hunterTurnSpeed: 720,
  // coneAngle is the full cone width in degrees. Range is measured from the Hunter's center.
  // damagePerSecond applies once per step while any beam reaches the Creature; beams do not stack.
  flashlight: { range: 140, coneAngle: 60, damagePerSecond: 6 },
  // The stagger cooldown starts at the same moment as the stagger, so with these values the
  // Creature is frozen for 1 s and then has 5 s of light exposure that cannot stagger it again.
  // attackCooldownSeconds follows every successful tag: one Hunter can go down per cooldown.
  creature: {
    maxHp: 100, staggerSeconds: 1, staggerCooldownSeconds: 6, visibilityLingerSeconds: 0.5, attackCooldownSeconds: 1,
  },
  // Creature sprint (the GDD's Dash): held Space / left mouse button replaces speed.creature with
  // sprint.speed and reveals the Creature. The cooldown runs after every sprint before the next.
  // Keep speed / tickRate below arena.wallThickness so one step can never cross a wall.
  sprint: { speed: 240, cooldownSeconds: 0.2 },
  // Total beam-seconds of teammate flashlight exposure that revives a downed Hunter. Beams
  // stack (two beams revive in half the time) and progress is kept when the light leaves.
  revive: { seconds: 10 },
  proximity: { uneasy: 360, danger: 220, immediate: 90 },
  tickRate: 30,
  inputTimeoutMs: 300,
} as const;
