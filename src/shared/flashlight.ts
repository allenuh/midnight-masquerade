import { GAMEPLAY } from './gameplay-config.js';
import { DEFAULT_TUNING, type Tuning } from './tuning.js';

// The battery-dependent power of one flashlight. Shared so the authoritative cone test
// and the drawn fan shorten together; neither holds its own copy of the thresholds.
// The thresholds and multipliers come from the room's tuning (the defaults are
// gameplay-config.ts); only the stage names are fixed.
export type FlashlightStage = (typeof GAMEPLAY.battery.stages)[number]['name'] | 'OFF';

type Stage = { name: FlashlightStage; minFraction: number; rangeMultiplier: number };
const stages = (tuning: Tuning): Stage[] => [
  { name: 'FULL', minFraction: tuning.fullBatteryFraction, rangeMultiplier: 1 },
  { name: 'HALF', minFraction: tuning.halfBatteryFraction, rangeMultiplier: tuning.halfRangeMultiplier },
  { name: 'LOW', minFraction: 0, rangeMultiplier: tuning.lowRangeMultiplier },
];

const stageFor = (battery: number, tuning: Tuning): Stage | undefined =>
  stages(tuning).find(({ minFraction }) => battery >= minFraction * tuning.batteryMax);

// The first stage whose fraction of the maximum the battery still reaches. An empty
// battery is OFF, so 60 % is FULL, 20 % is HALF, anything above 0 is at least LOW.
export function flashlightStage(battery: number, tuning: Tuning = DEFAULT_TUNING): FlashlightStage {
  if (battery <= 0) return 'OFF';
  return stageFor(battery, tuning)?.name ?? 'OFF';
}

// Effective flashlight range in world units, and zero when the battery is empty.
export function flashlightRange(battery: number, tuning: Tuning = DEFAULT_TUNING): number {
  if (battery <= 0) return 0;
  const stage = stageFor(battery, tuning);
  return stage ? tuning.flashlightRange * stage.rangeMultiplier : 0;
}
