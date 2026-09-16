import { GAMEPLAY } from './gameplay-config.js';

// The battery-dependent power of one flashlight. Shared so the authoritative cone test
// and the drawn fan shorten together; neither holds its own copy of the thresholds.
export type FlashlightStage = (typeof GAMEPLAY.battery.stages)[number]['name'] | 'OFF';

// The first stage whose fraction of the maximum the battery still reaches. An empty
// battery is OFF, so 60 % is FULL, 20 % is HALF, anything above 0 is at least LOW.
export function flashlightStage(battery: number): FlashlightStage {
  if (battery <= 0) return 'OFF';
  const stage = GAMEPLAY.battery.stages.find(({ minFraction }) => battery >= minFraction * GAMEPLAY.battery.max);
  return stage?.name ?? 'OFF';
}

// Effective flashlight range in world units, and zero when the battery is empty.
export function flashlightRange(battery: number): number {
  if (battery <= 0) return 0;
  const stage = GAMEPLAY.battery.stages.find(({ minFraction }) => battery >= minFraction * GAMEPLAY.battery.max);
  return stage ? GAMEPLAY.flashlight.range * stage.rangeMultiplier : 0;
}
