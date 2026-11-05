// The exorcism cutscene's timeline (snapshot.exorcism; the round is paused for the room's
// exorcismSeconds and ends as 'defeated' with it). A pure function of the clock, so every screen
// plays the same thing and scene.ts only has to apply it. Read every frame.
//
// The beats, as shares of the cutscene so they follow the room's length:
// - The Creature plays Exorcism (art/animate_creature_exorcism.py), stretched from the start to
//   DISSOLVE_TO: it flinches, throws its arms up and its head back, and holds there trembling, burning
//   as usual and rising LIFT units off the floor. BLEND_SECONDS takes it from and back to Float.
// - DISSOLVE_FROM..DISSOLVE_TO: it dissolves in the same ordered dither as when it hides, glowing
//   from CREATURE_BURNING_TINT to HOT_TINT and shedding ash (FIRE.ASH_*).
// - Until then the flames keep mostly behind it, EARLY_FRONT times the usual share in front, so the
//   pose and the face read.
// - SWELL_FROM..SWELL_TO: the fire takes over the space it leaves, to FIRE_RATE times as many flames,
//   FIRE_SIZE times the size and FIRE_LIGHT times the light, in front of it as much as behind.
// - DIE_FROM..DIE_TO: the fire slowly dies: fewer and fewer flames, shrinking to DYING_SIZE, and its
//   light with them.
// The camera dollies in along its own view to ZOOM times its usual distance, on the Creature's
// FOCUS_HEIGHT above the floor, over ZOOM_IN_SECONDS, and back out over the last ZOOM_OUT_SECONDS, so
// it is home as the result comes up.
export const EXORCISM = {
  ZOOM: 0.3,
  ZOOM_IN_SECONDS: 0.8,
  ZOOM_OUT_SECONDS: 0.7,
  FOCUS_HEIGHT: 32,
  BLEND_SECONDS: 0.12,
  LIFT: 7,
  DISSOLVE_FROM: 0.27,
  DISSOLVE_TO: 0.58,
  SWELL_FROM: 0.42,
  SWELL_TO: 0.62,
  DIE_FROM: 0.66,
  DIE_TO: 0.92,
  EARLY_FRONT: 0.15,
  FIRE_RATE: 3.2,
  FIRE_SIZE: 1.55,
  FIRE_LIGHT: 1.7,
  DYING_SIZE: 0.35,
  ASH_PER_SECOND: 55,
  HOT_TINT: [12, 7.5, 3.2],
};

// How the fire differs from a steady burn: flames and embers at `rate` times the usual, flames `size`
// times the usual and `front` times the usual share in front of the body, `ash` flakes a second, and
// its light at `light` times the usual.
export type FireSurge = { rate: number; size: number; front: number; ash: number; light: number };
export const STEADY_FIRE: Readonly<FireSurge> = Object.freeze({ rate: 1, size: 1, front: 1, ash: 0, light: 1 });

// Eased 0 to 1 as `value` goes from `from` to `to`, which may be the same.
function ramp(value: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / Math.max(to - from, 1e-6)));
  return t * t * (3 - 2 * t);
}

export type ExorcismFrame = {
  zoom: number; // 0 at the fixed camera, 1 fully in
  clip: number; // how far through the Exorcism clip, 0..1
  fade: number; // how much of the Creature is drawn, 0..1
  heat: number; // from its burning tint to HOT_TINT, 0..1
  lift: number; // units off its usual hover
  fire: FireSurge;
};

// The picture `elapsed` seconds into a cutscene `seconds` long.
export function exorcismFrame(elapsed: number, seconds: number): ExorcismFrame {
  const { DISSOLVE_FROM, DISSOLVE_TO, SWELL_FROM, SWELL_TO, DIE_FROM, DIE_TO } = EXORCISM;
  const share = Math.min(1, Math.max(0, elapsed / seconds));
  const dissolved = ramp(share, DISSOLVE_FROM, DISSOLVE_TO);
  const swell = ramp(share, SWELL_FROM, SWELL_TO);
  const left = 1 - ramp(share, DIE_FROM, DIE_TO);
  return {
    zoom: ramp(Math.min(elapsed / Math.max(EXORCISM.ZOOM_IN_SECONDS, 1e-6), (seconds - elapsed) / Math.max(EXORCISM.ZOOM_OUT_SECONDS, 1e-6)), 0, 1),
    clip: Math.min(1, share / Math.max(DISSOLVE_TO, 1e-6)),
    fade: 1 - dissolved,
    heat: dissolved,
    lift: EXORCISM.LIFT * ramp(share, 0, DISSOLVE_TO),
    fire: {
      rate: (1 + (EXORCISM.FIRE_RATE - 1) * swell) * left,
      size: (1 + (EXORCISM.FIRE_SIZE - 1) * swell) * (EXORCISM.DYING_SIZE + (1 - EXORCISM.DYING_SIZE) * left),
      front: EXORCISM.EARLY_FRONT + (1 - EXORCISM.EARLY_FRONT) * swell,
      // Ash only while there is a body left to shed it, and a moment after.
      ash: EXORCISM.ASH_PER_SECOND * ramp(share, DISSOLVE_FROM, (DISSOLVE_FROM + DISSOLVE_TO) / 2) * (1 - ramp(share, DISSOLVE_TO, DIE_FROM)),
      light: (1 + (EXORCISM.FIRE_LIGHT - 1) * swell) * left,
    },
  };
}
