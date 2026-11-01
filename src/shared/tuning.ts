import { GAMEPLAY } from './gameplay-config.js';

// The gameplay values a room's host may change between rounds, so balance variants can
// be played back to back without a rebuild. Every default is the number in
// gameplay-config.ts, which stays the single place to edit the game's actual tuning;
// this table only says which of those numbers the lobby exposes and within what bounds.
// The bounds reject nonsense (negative speeds, a zero-second match), not bad balance.
// Structural values (player count, tick rate, radii, arena geometry) are not here.
export type TunableKey =
  | 'matchSeconds'
  | 'hunterSpeed' | 'hunterTurnSpeed'
  | 'creatureSpeed' | 'sprintSpeed' | 'sprintCooldownSeconds' | 'creatureMaxHp'
  | 'staggerSeconds' | 'staggerCooldownSeconds' | 'visibilityLingerSeconds' | 'attackCooldownSeconds' | 'burnSeconds'
  | 'catchSeconds'
  | 'flashlightDamagePerSecond' | 'flashlightRange' | 'flashlightConeAngle' | 'lightEffectDelaySeconds'
  | 'batteryMax' | 'batteryDrainPerSecond' | 'batteryRestores' | 'firstBatterySeconds' | 'batteryRespawnSeconds'
  | 'fullBatteryFraction' | 'halfBatteryFraction' | 'halfRangeMultiplier' | 'lowRangeMultiplier'
  | 'reviveSeconds'
  | 'proximityUneasy' | 'proximityDanger' | 'proximityImmediate';

export type Tunable = { key: TunableKey; label: string; group: string; min: number; max: number; step: number; default: number };
export type Tuning = Record<TunableKey, number>;

const { round, speed, hunterTurnSpeed, sprint, creature, flashlight, battery, batteryPickup, revive, proximity } = GAMEPLAY;
const [full, half, low] = battery.stages;

export const TUNABLES: readonly Tunable[] = [
  { key: 'matchSeconds', label: 'Match length (s)', group: 'Round', min: 10, max: 900, step: 5, default: round.matchSeconds },
  { key: 'hunterSpeed', label: 'Hunter speed', group: 'Hunter', min: 10, max: 600, step: 5, default: speed.hunter },
  { key: 'hunterTurnSpeed', label: 'Hunter turn speed (deg/s)', group: 'Hunter', min: 30, max: 3600, step: 30, default: hunterTurnSpeed },
  { key: 'creatureSpeed', label: 'Creature speed', group: 'Creature', min: 10, max: 600, step: 5, default: speed.creature },
  { key: 'sprintSpeed', label: 'Sprint speed', group: 'Creature', min: 10, max: 900, step: 5, default: sprint.speed },
  { key: 'sprintCooldownSeconds', label: 'Sprint cooldown (s)', group: 'Creature', min: 0, max: 30, step: 0.1, default: sprint.cooldownSeconds },
  { key: 'creatureMaxHp', label: 'Creature HP', group: 'Creature', min: 1, max: 1000, step: 5, default: creature.maxHp },
  { key: 'staggerSeconds', label: 'Stagger (s)', group: 'Creature', min: 0, max: 10, step: 0.1, default: creature.staggerSeconds },
  { key: 'staggerCooldownSeconds', label: 'Stagger cooldown (s)', group: 'Creature', min: 0, max: 60, step: 0.5, default: creature.staggerCooldownSeconds },
  { key: 'visibilityLingerSeconds', label: 'Reveal linger (s)', group: 'Creature', min: 0, max: 10, step: 0.1, default: creature.visibilityLingerSeconds },
  { key: 'attackCooldownSeconds', label: 'Attack cooldown (s)', group: 'Creature', min: 0, max: 10, step: 0.1, default: creature.attackCooldownSeconds },
  { key: 'burnSeconds', label: 'Burn (s)', group: 'Creature', min: 0, max: 60, step: 0.5, default: creature.burnSeconds },
  { key: 'catchSeconds', label: 'Catch cutscene (s)', group: 'Creature', min: 0, max: 10, step: 0.1, default: creature.catchSeconds },
  { key: 'flashlightDamagePerSecond', label: 'Flashlight damage (HP/s)', group: 'Flashlight', min: 0, max: 200, step: 0.5, default: flashlight.damagePerSecond },
  { key: 'flashlightRange', label: 'Flashlight range', group: 'Flashlight', min: 10, max: 800, step: 5, default: flashlight.range },
  { key: 'flashlightConeAngle', label: 'Flashlight cone (deg)', group: 'Flashlight', min: 5, max: 180, step: 5, default: flashlight.coneAngle },
  { key: 'lightEffectDelaySeconds', label: 'Effect delay (s)', group: 'Flashlight', min: 0, max: 10, step: 0.1, default: flashlight.effectDelaySeconds },
  { key: 'batteryMax', label: 'Battery capacity', group: 'Battery', min: 1, max: 1000, step: 5, default: battery.max },
  { key: 'batteryDrainPerSecond', label: 'Battery drain (per s)', group: 'Battery', min: 0, max: 200, step: 0.5, default: battery.drainPerSecond },
  { key: 'batteryRestores', label: 'Pickup restores', group: 'Battery', min: 1, max: 1000, step: 5, default: batteryPickup.restores },
  { key: 'firstBatterySeconds', label: 'First battery after (s)', group: 'Battery', min: 0, max: 600, step: 5, default: batteryPickup.firstSpawnSeconds },
  { key: 'batteryRespawnSeconds', label: 'Battery respawn (s)', group: 'Battery', min: 0, max: 600, step: 5, default: batteryPickup.respawnSeconds },
  { key: 'fullBatteryFraction', label: 'FULL stage above (fraction)', group: 'Battery', min: 0, max: 1, step: 0.05, default: full.minFraction },
  { key: 'halfBatteryFraction', label: 'HALF stage above (fraction)', group: 'Battery', min: 0, max: 1, step: 0.05, default: half.minFraction },
  { key: 'halfRangeMultiplier', label: 'HALF range multiplier', group: 'Battery', min: 0, max: 1, step: 0.05, default: half.rangeMultiplier },
  { key: 'lowRangeMultiplier', label: 'LOW range multiplier', group: 'Battery', min: 0, max: 1, step: 0.05, default: low.rangeMultiplier },
  { key: 'reviveSeconds', label: 'Revive (beam-s)', group: 'Revive', min: 0.5, max: 120, step: 0.5, default: revive.seconds },
  { key: 'proximityUneasy', label: 'UNEASY within', group: 'Proximity', min: 0, max: 2000, step: 10, default: proximity.uneasy },
  { key: 'proximityDanger', label: 'DANGER within', group: 'Proximity', min: 0, max: 2000, step: 10, default: proximity.danger },
  { key: 'proximityImmediate', label: 'IMMEDIATE within', group: 'Proximity', min: 0, max: 2000, step: 10, default: proximity.immediate },
];

export function defaultTuning(): Tuning {
  return Object.fromEntries(TUNABLES.map((tunable) => [tunable.key, tunable.default])) as Tuning;
}

// The defaults, shared by every function that takes an optional tuning. Frozen: a room
// gets its own copy from defaultTuning() and changes only that.
export const DEFAULT_TUNING: Readonly<Tuning> = Object.freeze(defaultTuning());

// The one acceptance path for a tuning sent over the wire: every key, no other key,
// every value a finite number inside its bounds. Returns a fresh object or null.
export function validateTuning(value: unknown): Tuning | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== TUNABLES.length) return null;
  const tuning: Partial<Tuning> = {};
  for (const tunable of TUNABLES) {
    const number = fields[tunable.key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < tunable.min || number > tunable.max) return null;
    tuning[tunable.key] = number;
  }
  return tuning as Tuning;
}

// The values that differ from the defaults, for the server log: `creatureSpeed=170
// matchSeconds=60`, or `defaults` when nothing does.
export function tuningDifferences(tuning: Tuning): string {
  const changed = TUNABLES.filter((tunable) => tuning[tunable.key] !== tunable.default)
    .map((tunable) => `${tunable.key}=${tuning[tunable.key]}`);
  return changed.length === 0 ? 'defaults' : changed.join(' ');
}
