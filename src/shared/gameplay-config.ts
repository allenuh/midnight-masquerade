// 3D world units, seconds, and center-to-center distances. Y is up; X/Z is ground.
// No player spawn coordinates or private randomness belong in this shared file. Level
// geometry does not live here either: the arena's size, its walls, and the points where
// batteries may spawn all come from the loaded map file (see src/shared/map/).
export const GAMEPLAY = {
  // A round is exactly one Creature plus this many Hunters; a room holds hunters + 1 players.
  players: { hunters: 4 },
  // Seconds each client shows its private role before the round starts running.
  roleRevealSeconds: 3,
  // The match clock starts when the reveal ends. Reaching zero is a Creature victory;
  // finalWarningSeconds is only the point where the clients emphasise the countdown.
  round: { matchSeconds: 180, finalWarningSeconds: 30 },
  // The floor plane and the boundary wall the map's grid is enclosed by. Arena width and
  // depth are not here: they are map.width/height x TILE_SIZE, read from the room's World.
  arena: { floorY: 0, wallThickness: 26, wallHeight: 28 },
  // Shared collision radius for both roles. A tag is sphere contact: distance <= 2 * playerRadius.
  playerRadius: 14,
  speed: { hunter: 110, creature: 150 },
  // Degrees per second. The flashlight follows this facing; movement itself is not delayed.
  hunterTurnSpeed: 720,
  // coneAngle is the full cone width in degrees. Range is measured from the Hunter's center
  // and is the FULL-battery reach; the stages below scale it. damagePerSecond applies once
  // per step while any beam reaches the Creature; beams do not stack.
  flashlight: { range: 140, coneAngle: 60, damagePerSecond: 6 },
  // Finite flashlight energy. The battery drains only while the button is held, in
  // simulation seconds, and never regenerates: battery pickups are the only refill.
  // Stages are read in order; the first one whose fraction of `max` the battery still
  // reaches applies. An empty battery is OFF: no cone, no damage, no reveal, no revival.
  // Only rangeMultiplier changes, so the cone angle reads the same at every stage.
  battery: {
    max: 100,
    drainPerSecond: 5,
    stages: [
      { name: 'FULL', minFraction: 0.6, rangeMultiplier: 1 },
      { name: 'HALF', minFraction: 0.2, rangeMultiplier: 0.7 },
      { name: 'LOW', minFraction: 0, rangeMultiplier: 0.35 },
    ],
  },
  // The map holds at most one battery, at one of the Battery Spawn marker tiles the
  // loaded map declares, chosen at random. Hunters start on a full charge, so nothing
  // spawns for firstSpawnSeconds; after that, each collection is followed by
  // respawnSeconds before the next one appears. `radius` is the pickup's own collection
  // sphere (contact = playerRadius + radius). Where batteries may appear is level design
  // and lives in the map; when and which one appears is gameplay and lives here.
  batteryPickup: {
    restores: 100,
    firstSpawnSeconds: 45,
    respawnSeconds: 20,
    radius: 10,
  },
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
