// Fear effects: how a Hunter feels the Creature closing in. They replace the old coloured border
// and say the same thing, magnitude and never direction, but scale with the coarse distance the
// server sends (`dread`) inside each band, and every band adds a layer, so each threshold is a
// clear jump. The picture side is the fear pass in post.ts; this module decides the values.
// No three.js here: the mapping is pure, and tested in tests/fear.test.ts.
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { HunterSnapshot, ProximityState } from '../shared/protocol.js';
import type { Tuning } from '../shared/tuning.js';

// Stage 0..3 (SAFE, UNEASY, DANGER, IMMEDIATE) and how far through it the Hunter is, from its
// outer edge (0) to its inner edge (1). SAFE is always 0.
export type FearInput = { stage: number; t: number };

// Everything the effects are driven by. Distances are world units, so the darkness closes to
// the same size on screen whatever the map: `radius` is the clear area around the Hunter and
// `softness` how far beyond it the darkness takes to reach `darkness` (0..1, the share of light
// taken away). `desaturation` drains colour (strongest far from the Hunter). The heartbeat beats
// at `heartRate` BPM (0: none) with `heartStrength`. `tendrils` (0..1) breaks the edge of the
// darkness into creeping ink, `aberration` (0..2) splits the colours around the Hunter,
// `tvStatic` (0..1) lays black-and-white TV static over the screen, and `flicker` (0..1) is how
// often the Hunter's own flashlight stutters. The comic panic lines around the Hunter: `lines`
// jagged strokes (a whole number), each `lineLength` long and `lineWidth` thick at
// its widest, zigzagging sideways by `lineWave` with `lineWaves` zigs along it, travelling along
// it `lineSpeed` times a second.
export type FearLevels = {
  radius: number; softness: number; darkness: number; desaturation: number;
  heartRate: number; heartStrength: number; tendrils: number; aberration: number; tvStatic: number; flicker: number;
  lines: number; lineLength: number; lineWidth: number; lineWave: number; lineWaves: number; lineSpeed: number;
};
// Mutable so the debug menu can edit the bands live; fearLevels reads them every frame.
type Range = [number, number];
type StageTable = { [K in keyof FearLevels]: Range };

export const NO_FEAR: FearLevels = {
  radius: 600, softness: 300, darkness: 0, desaturation: 0,
  heartRate: 0, heartStrength: 0, tendrils: 0, aberration: 0, tvStatic: 0, flicker: 0,
  lines: 0, lineLength: 0, lineWidth: 0, lineWave: 0, lineWaves: 0, lineSpeed: 0,
};

// Per band, each value from the band's outer edge to its inner edge. Every band has the comic
// panic lines; they are the same throughout a band and step up only at each threshold (more,
// longer, bigger and faster strokes). Each band adds a layer:
// UNEASY the closing darkness, draining colour and a slow heartbeat; DANGER a faster heartbeat,
// creeping tendrils, a faint colour split and a flashlight that stutters often; IMMEDIATE a
// stronger colour split, TV static, a racing heart and a failing light. The darkness jumps at every
// boundary by more than it changes inside a band, so crossing a threshold is felt.
export const FEAR_STAGES: StageTable[] = [
  // UNEASY
  {
    radius: [456, 324], softness: [224, 196], darkness: [0.48, 0.62], desaturation: [0.25, 0.42],
    heartRate: [55, 65], heartStrength: [0.3, 0.4], tendrils: [0, 0], aberration: [0, 0], tvStatic: [0, 0], flicker: [0, 0],
    lines: [8, 8], lineLength: [9.75, 9.75], lineWidth: [2.4, 2.4], lineWave: [0.9, 0.9], lineWaves: [1.5, 1.5], lineSpeed: [1.4, 1.4],
  },
  // DANGER
  {
    radius: [179, 162], softness: [168, 147], darkness: [0.72, 0.81], desaturation: [0.74, 0.83],
    heartRate: [84, 102], heartStrength: [0.92, 1.16], tendrils: [0.5, 0.8], aberration: [0.06, 0.09], tvStatic: [0, 0], flicker: [0.7, 0.57],
    lines: [12, 12], lineLength: [11.9, 11.9], lineWidth: [2.95, 2.95], lineWave: [1.4, 1.4], lineWaves: [2, 2], lineSpeed: [2.6, 2.6],
  },
  // IMMEDIATE: dark beyond a tight clear area (0.98 is the most the pass ever darkens). The clear
  // radius stays above one and a half times the tag reach (31.71 by default, so 47.6), so the
  // Creature about to reach the Hunter is in view.
  {
    radius: [95, 48], softness: [100, 85], darkness: [0.85, 0.88], desaturation: [0.87, 0.87],
    heartRate: [120, 150], heartStrength: [1.12, 1.36], tendrils: [0.94, 0.94], aberration: [0.1, 0.39], tvStatic: [0.42, 1.05], flicker: [0.45, 0.7],
    lines: [16, 16], lineLength: [17, 17], lineWidth: [3.45, 3.45], lineWave: [2.05, 2.05], lineWaves: [2.5, 2.5], lineSpeed: [4.4, 4.4],
  },
];

const STAGE_OF: Record<ProximityState, number> = { SAFE: 0, UNEASY: 1, DANGER: 2, IMMEDIATE: 3 };

// Where in its band a Hunter is, from the server's band and coarse dread (whole steps of the
// UNEASY radius). The band decides the stage; dread only places the Hunter inside it.
export function fearInput(band: ProximityState, dread: number, tuning: Tuning): FearInput {
  const stage = STAGE_OF[band];
  if (stage === 0) return { stage: 0, t: 0 };
  const distance = (1 - dread / GAMEPLAY.proximity.dreadSteps) * tuning.proximityUneasy;
  const edges = [tuning.proximityUneasy, tuning.proximityDanger, tuning.proximityImmediate, 0];
  const outer = edges[stage - 1];
  const inner = edges[stage];
  const t = outer > inner ? (outer - distance) / (outer - inner) : 1;
  return { stage, t: Math.min(1, Math.max(0, t)) };
}

// What a Hunter feels now, or null for nothing. Fear is a warning, so it goes when there is nothing
// to warn of: outside a running round, once the Hunter is down, and while the Creature burns and so
// cannot catch anyone. `burning` says nothing about a hidden Creature: the server keeps a burning one
// revealed for the whole burn, with its exact position on every Hunter's screen. When the burn ends
// the fear comes straight back, with the stinger of entering a deeper band, as the Creature can
// catch again from that very step.
export function hunterFear(snapshot: HunterSnapshot, tuning: Tuning): FearInput | null {
  if (snapshot.roundState !== 'running' || snapshot.creature?.burning) return null;
  if (snapshot.hunters.find((view) => view.id === snapshot.self)?.down) return null;
  return fearInput(snapshot.proximity, snapshot.dread, tuning);
}

// The ?debug=1&fear=x preview: x from 0 (SAFE) to 3 (the innermost IMMEDIATE). Up to 1 is UNEASY,
// up to 2 DANGER and up to 3 IMMEDIATE, so 1.5 is halfway through DANGER and 2.05 just inside
// IMMEDIATE.
export function previewInput(value: number): FearInput {
  const x = Math.min(3, Math.max(0, value));
  if (x === 0) return { stage: 0, t: 0 };
  const stage = Math.ceil(x);
  return { stage, t: x - (stage - 1) };
}

export function fearLevels({ stage, t }: FearInput): FearLevels {
  if (stage <= 0) return { ...NO_FEAR };
  const table = FEAR_STAGES[Math.min(stage, 3) - 1];
  const levels = { ...NO_FEAR };
  for (const key of Object.keys(table) as (keyof FearLevels)[]) {
    const [from, to] = table[key];
    levels[key] = from + (to - from) * t;
  }
  return levels;
}

// The animator's timing, read every frame (the debug menu edits it live):
// - EASE_SECONDS: how quickly the effects follow a change (seconds to cover about two thirds of
//   it), so a threshold reads as a lurch rather than a pop. The stinger, a hard thump on entering a
//   deeper band, decays over STINGER_SECONDS.
// - The heartbeat: a lub at LUB and a quieter dub (DUB_STRENGTH) at DUB in each beat (fractions of
//   the beat), each BEAT_WIDTH wide.
// - The colour split swells by ABERRATION_PULSE at each thump, and a stinger flashes it by
//   STINGER_ABERRATION even where there is none yet.
// - When the band changes the stroke count, all the new strokes grow out together (or all the
//   removed ones shrink back) over LINE_GROW_SECONDS.
// - The flashlight stutter: every FLICKER_INTERVAL seconds (randomised up to twice that), the light
//   dips to between FLICKER_LOW and FLICKER_HIGH with a chance of `flicker * FLICKER_CHANCE`.
export const FEAR_TIMING = {
  EASE_SECONDS: 0.12,
  STINGER_SECONDS: 0.25,
  LUB: 0.06,
  DUB: 0.26,
  DUB_STRENGTH: 0.6,
  BEAT_WIDTH: 0.05,
  ABERRATION_PULSE: 0.39,
  STINGER_ABERRATION: 0.09,
  LINE_GROW_SECONDS: 0.125,
  FLICKER_INTERVAL: 0.06,
  FLICKER_CHANCE: 0.45,
  FLICKER_LOW: 0.15,
  FLICKER_HIGH: 0.6,
};

// What the fear pass and the flashlight read each frame. `pulse` is the heartbeat plus the
// stinger. The panic lines: `lines` strokes are drawn, the first `linesSettled` in full and the
// rest grown out by `lineEmerge` (0..1, all together); `linePhase` is how far their zigzags have
// travelled (in cycles, kept by the animator so a change of speed never makes them jump).
// `active` is false once everything has faded out, so the pass can be skipped.
export type FearFrame = {
  radius: number; softness: number; darkness: number; desaturation: number; tendrils: number;
  aberration: number; tvStatic: number; pulse: number; stinger: number; flicker: number;
  lines: number; linesSettled: number; lineEmerge: number;
  lineLength: number; lineWidth: number; lineWave: number; lineWaves: number; linePhase: number;
  active: boolean;
};

export function createFear() {
  const levels: FearLevels = { ...NO_FEAR };
  let lastStage = 0;
  let beat = 0;
  let linePhase = 0;
  // The stroke count changing from `linesFrom` to `linesTo`, `lineGrow` (0..1) of the way.
  let linesFrom = 0;
  let linesTo = 0;
  let lineGrow = 1;
  let stinger = 0;
  let flickerTimer = 0;
  let flicker = 1;

  function update(input: FearInput, deltaSeconds: number): FearFrame {
    const {
      EASE_SECONDS, STINGER_SECONDS, LUB, DUB, DUB_STRENGTH, BEAT_WIDTH, ABERRATION_PULSE, STINGER_ABERRATION,
      LINE_GROW_SECONDS, FLICKER_INTERVAL, FLICKER_CHANCE, FLICKER_LOW, FLICKER_HIGH,
    } = FEAR_TIMING;
    const target = fearLevels(input);
    const ease = 1 - Math.exp(-deltaSeconds / EASE_SECONDS);
    for (const key of Object.keys(levels) as (keyof FearLevels)[]) levels[key] += (target[key] - levels[key]) * ease;
    if (input.stage > lastStage) stinger = 1;
    lastStage = input.stage;
    stinger *= Math.exp(-deltaSeconds / STINGER_SECONDS);

    beat = (beat + (deltaSeconds * levels.heartRate) / 60) % 1;
    linePhase = (linePhase + deltaSeconds * levels.lineSpeed) % 1;
    const lineTarget = Math.round(target.lines);
    if (lineTarget !== linesTo) {
      // A change mid-way starts from whichever count is mostly showing.
      linesFrom = lineGrow >= 0.5 ? linesTo : linesFrom;
      linesTo = lineTarget;
      lineGrow = 0;
    }
    lineGrow = Math.min(1, lineGrow + deltaSeconds / LINE_GROW_SECONDS);
    if (lineGrow >= 1) linesFrom = linesTo;
    const thump = (centre: number) => Math.exp(-(((beat - centre) / BEAT_WIDTH) ** 2));
    const heart = levels.heartStrength * (thump(LUB) + DUB_STRENGTH * thump(DUB));

    flickerTimer -= deltaSeconds;
    if (flickerTimer <= 0) {
      flickerTimer = FLICKER_INTERVAL * (1 + Math.random());
      flicker = Math.random() < levels.flicker * FLICKER_CHANCE
        ? FLICKER_LOW + (FLICKER_HIGH - FLICKER_LOW) * Math.random()
        : 1;
    }

    return {
      radius: levels.radius, softness: levels.softness, darkness: levels.darkness,
      desaturation: levels.desaturation, tendrils: levels.tendrils,
      aberration: levels.aberration * (1 + ABERRATION_PULSE * heart) + STINGER_ABERRATION * stinger,
      tvStatic: levels.tvStatic,
      lines: Math.max(linesFrom, linesTo), linesSettled: Math.min(linesFrom, linesTo),
      lineEmerge: linesTo >= linesFrom ? lineGrow : 1 - lineGrow,
      lineLength: levels.lineLength, lineWidth: levels.lineWidth,
      lineWave: levels.lineWave, lineWaves: levels.lineWaves, linePhase,
      pulse: heart + stinger, stinger,
      flicker: levels.flicker > 0.01 ? flicker : 1,
      active: levels.darkness > 0.002 || stinger > 0.002,
    };
  }

  return { update };
}
