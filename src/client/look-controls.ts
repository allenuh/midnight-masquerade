// DEBUG-MENU: what the debug menu (debug-menu.ts) can tune live, one entry per value: the plain
// object that holds it in its own module, and the range its slider covers (the number box beside
// it takes any value). Every object here is read by its module every frame, so an edit shows at
// once. Adding a value: put it in its module's object, read it from there each frame, list it here.
import { FEAR_STAGES, FEAR_TIMING, type FearLevels } from './fear.js';
import { BLOOM, FEAR_LINE_COLOR, FEAR_PASS, GRADE } from './post.js';
import { CANDLE_FLAMES } from './props.js';
import { BATTERY_LOOK, CATCH, CHARACTERS, NIGHT, VIEW } from './scene.js';
import {
  BATTERY_LIGHT, BATTERY_LIGHT_REACH, CANDLE_LIGHT, CANDLE_LIGHT_REACH, FLASHLIGHT, SHADING,
} from './vfx.js';

type Values = Record<string | number, unknown>;
export type LookControl = {
  // The menu section it is listed under, the source file that holds its default, and its name
  // there (shown on hover and by "Copy changes").
  section: string; file: string; path: string; label: string;
  object: Values; key: string | number;
} & ({ kind: 'number'; min: number; max: number; step: number } | { kind: 'color' } | { kind: 'boolean' });

// A slider's [min, max, step], or a colour picker, or a checkbox.
type Spec = readonly [number, number, number] | 'color' | 'boolean';

export const LOOK_CONTROLS: LookControl[] = [];

// Lists `object`'s values named in `specs`, in that order, under `section`. `name` is the object's
// name in `file`.
function add(section: string, file: string, name: string, object: object, specs: Record<string, Spec>): void {
  for (const [key, spec] of Object.entries(specs)) {
    const base = { section, file, path: `${name}.${key}`, label: key, object: object as Values, key };
    if (spec === 'color' || spec === 'boolean') LOOK_CONTROLS.push({ ...base, kind: spec });
    else LOOK_CONTROLS.push({ ...base, kind: 'number', min: spec[0], max: spec[1], step: spec[2] });
  }
}

// An (r, g, b) multiplier held as an array, one slider per channel.
function addRgb(section: string, file: string, name: string, values: number[], range: readonly [number, number, number]): void {
  for (const [index, channel] of ['r', 'g', 'b'].entries()) {
    LOOK_CONTROLS.push({
      section, file, path: `${name}[${index}]`, label: `${name.split('.').pop()} ${channel}`,
      object: values as unknown as Values, key: index, kind: 'number', min: range[0], max: range[1], step: range[2],
    });
  }
}

const unit = [0, 1, 0.01] as const;
const intensity = [0, 5, 0.01] as const;

add('Night lighting', 'scene.ts', 'NIGHT', NIGHT, {
  AMBIENT_SKY: 'color', AMBIENT_GROUND: 'color', AMBIENT_INTENSITY: [0, 3, 0.01],
  MOONLIGHT_COLOR: 'color', MOONLIGHT_INTENSITY: [0, 3, 0.01],
  MOON_X: [-1500, 1500, 10], MOON_Y: [0, 2000, 10], MOON_Z: [-1500, 1500, 10],
  BACKGROUND_COLOR: 'color',
});

add('Flashlight', 'vfx.ts', 'FLASHLIGHT', FLASHLIGHT, {
  LIGHT_COLOR: 'color',
  BEAM_INTENSITY: [0, 2, 0.01], BEAM_FADE_START: unit, BEAM_FLOOR_SOFT: [0, 60, 1], GLOW_INTENSITY: intensity,
  POOL_SPREAD: [1, 4, 0.05], POOL_MAX_ANGLE: [10, 180, 1], POOL_REACH: [0.5, 3, 0.05],
  POOL_INTENSITY: intensity, POOL_FALLOFF: [0.1, 5, 0.05], POOL_SOFT_SIDES: unit, POOL_CORE_BOOST: [0, 3, 0.01],
  FAN_COLOR: 'color', FAN_OPACITY: unit,
});
add('Flashlight', 'scene.ts', 'CHARACTERS', CHARACTERS, { LENS_GLOW_RADIUS: [0, 30, 0.5] });

add('Candles', 'vfx.ts', 'CANDLE_LIGHT', CANDLE_LIGHT, {
  CANDLE_LIGHT_COLOR: 'color', CANDLE_LIGHT_RADIUS: [0, CANDLE_LIGHT_REACH, 1],
  CANDLE_LIGHT_INTENSITY: [0, 8, 0.05], CANDLE_LIGHT_MAX: intensity, CANDLE_HALO_INTENSITY: [0, 8, 0.05],
});
add('Candles', 'props.ts', 'CANDLE_FLAMES', CANDLE_FLAMES, {
  HALO_RADIUS: [0, 40, 0.5], FLICKER_STRETCH: [0, 0.5, 0.01], LIGHT_FLICKER: unit,
});

add('Battery glow', 'vfx.ts', 'BATTERY_LIGHT', BATTERY_LIGHT, {
  BATTERY_LIGHT_COLOR: 'color', BATTERY_LIGHT_RADIUS: [0, BATTERY_LIGHT_REACH, 1],
  BATTERY_LIGHT_INTENSITY: [0, 8, 0.05], HALO_INTENSITY: [0, 8, 0.05], MOTE_INTENSITY: [0, 6, 0.05],
});
add('Battery glow', 'scene.ts', 'BATTERY_LOOK', BATTERY_LOOK, {
  BATTERY_HALO_RADIUS: [0, 100, 0.5], BATTERY_PULSE_DEPTH: unit, BATTERY_PULSE_RATE: [0, 4, 0.05],
  BATTERY_CHARGE_FLASH: [0, 2, 0.01], BATTERY_SHADOW_RADIUS: [0, 40, 0.5],
});

// Each fear band's values, from its outer edge to its inner edge (fear.ts). The fear preview in
// the Round section shows any point of any band without a Creature.
const FEAR_RANGES: Record<keyof FearLevels, readonly [number, number, number]> = {
  radius: [0, 600, 1], softness: [0, 400, 1], darkness: [0, 0.98, 0.01], desaturation: unit,
  heartRate: [0, 200, 1], heartStrength: [0, 2, 0.01], tendrils: [0, 2, 0.01], aberration: [0, 3, 0.01],
  tvStatic: [0, 3, 0.01], flicker: unit,
  lines: [0, 32, 1], lineLength: [0, 50, 0.05], lineWidth: [0, 10, 0.05], lineWave: [0, 6, 0.05],
  lineWaves: [0, 6, 0.05], lineSpeed: [0, 10, 0.1],
};
for (const [stage, band] of ['UNEASY', 'DANGER', 'IMMEDIATE'].entries()) {
  for (const [key, [min, max, step]] of Object.entries(FEAR_RANGES)) {
    const range = FEAR_STAGES[stage][key as keyof FearLevels];
    for (const [edge, side] of ['outer', 'inner'].entries()) {
      LOOK_CONTROLS.push({
        section: `Fear band: ${band}`, file: 'fear.ts', path: `FEAR_STAGES[${stage}].${key}[${edge}]`,
        label: `${key} ${side}`, object: range as unknown as Values, key: edge, kind: 'number', min, max, step,
      });
    }
  }
}
add('Fear timing', 'fear.ts', 'FEAR_TIMING', FEAR_TIMING, {
  EASE_SECONDS: [0.01, 1, 0.01], STINGER_SECONDS: [0.01, 2, 0.01],
  LUB: unit, DUB: unit, DUB_STRENGTH: [0, 2, 0.01], BEAT_WIDTH: [0.005, 0.3, 0.005],
  ABERRATION_PULSE: [0, 3, 0.01], STINGER_ABERRATION: [0, 3, 0.01], LINE_GROW_SECONDS: [0.01, 1, 0.005],
  FLICKER_INTERVAL: [0.01, 0.5, 0.01], FLICKER_CHANCE: unit, FLICKER_LOW: unit, FLICKER_HIGH: unit,
});
add('Fear picture', 'post.ts', 'FEAR_PASS', FEAR_PASS, {
  PULSE_SQUEEZE: [0, 0.5, 0.01], PULSE_DARKEN: [0, 0.5, 0.01], TENDRIL_REACH: [0, 3, 0.01], TENDRIL_MAX: unit,
  ABERRATION_SHIFT: [0, 0.1, 0.001], ABERRATION_SATURATION: [0, 5, 0.05], ABERRATION_THROUGH_DARK: unit,
  ABERRATION_RING: [1, 6, 0.05],
  STATIC_PIXEL: [1, 8, 1], STATIC_FPS: [1, 60, 1], STATIC_AMOUNT: [0, 0.5, 0.005], STATIC_SCANLINES: unit,
  STATIC_BAND_HEIGHT: [0.01, 0.5, 0.01], STATIC_ROLL_SPEED: [0, 2, 0.01], STATIC_BAND: [1, 5, 0.05],
  LINE_INNER: [0, 60, 0.5], LINE_JITTER: [0, 20, 0.5], LINE_PULSE: [0, 10, 0.1], LINE_LENGTH_JITTER: unit,
  LINE_TIP: [1, 5, 0.05], LINE_EMERGE_FROM: unit, LINE_OUTLINE: [0, 2, 0.01], LINE_OUTLINE_MIN_PX: [0, 3, 0.05],
});
add('Fear picture', 'post.ts', 'FEAR_LINE_COLOR', FEAR_LINE_COLOR, { LINE_COLOR: 'color' });

add('Bloom', 'post.ts', 'BLOOM', BLOOM, { BLOOM_STRENGTH: [0, 3, 0.01], BLOOM_RADIUS: unit, BLOOM_THRESHOLD: [0, 2, 0.01] });
add('Night grade', 'post.ts', 'GRADE', GRADE, {
  VIGNETTE_START: [0, 2, 0.01], VIGNETTE_END: [0, 3, 0.01], VIGNETTE_STRENGTH: unit,
  SHADOW_DESATURATION: unit, HIGHLIGHT_SATURATION: unit, GRADE_CONTRAST: [0.5, 2, 0.01], GRADE_PIVOT: [0.01, 1, 0.01],
});

add('Characters', 'scene.ts', 'CHARACTERS', CHARACTERS, {
  SELF_COLOR: 'color', TEAMMATE_COLOR: 'color', DOWN_COLOR: 'color',
  WALK_RATE_SPEED: [5, 150, 0.5], FLOAT_RATE_MOVING: [0, 5, 0.05], FLOAT_RATE_SPRINT: [0, 5, 0.05],
  FLOAT_RATE_EASE: [0.01, 2, 0.01], CREATURE_TURN_SPEED: [0.5, 30, 0.1], CREATURE_LEAN: [0, 0.8, 0.01], CREATURE_SPRINT_LEAN: [0, 0.8, 0.01],
  HUNTER_SHADOW_RADIUS: [0, 40, 0.5], CREATURE_SHADOW_RADIUS: [0, 60, 0.5],
  CREATURE_FADE_IN_SECONDS: [0, 1, 0.01], CREATURE_FADE_OUT_SECONDS: [0, 2, 0.01],
});
addRgb('Characters', 'scene.ts', 'CHARACTERS.CREATURE_TINT', CHARACTERS.CREATURE_TINT, [0, 3, 0.01]);
addRgb('Characters', 'scene.ts', 'CHARACTERS.CREATURE_BURNING_TINT', CHARACTERS.CREATURE_BURNING_TINT, [0, 10, 0.05]);
add('Characters', 'vfx.ts', 'SHADING', SHADING, {
  OUTLINE_WIDTH: [0, 0.01, 0.0001], STAGGER_OUTLINE_COLOR: 'color', STAGGER_OUTLINE_WIDTH: [0, 0.02, 0.0001],
  SHADOW_STRENGTH: unit, DITHER_START: [-1, 1, 0.01], DITHER_WIDTH: [0.01, 2, 0.01],
  BLOB_SHADOW_OPACITY: unit, CREATURE_BLOB_SHADOW_OPACITY: unit,
});

add('Catch cutscene', 'scene.ts', 'CATCH', CATCH, {
  ZOOM: [0.1, 1, 0.01], ZOOM_IN_SECONDS: [0, 1.5, 0.01], ZOOM_OUT_SECONDS: [0, 1.5, 0.01],
  LUNGE_FROM: unit, LUNGE_TO: unit, RELEASE_FROM: unit, GRAB_DISTANCE: [10, 40, 0.5], STRUGGLE: [0, 4, 0.05],
  FALL_SECONDS: [0, 1.5, 0.01],
});

add('View', 'scene.ts', 'VIEW', VIEW, { RENDER_SCALE: [0.25, 2, 0.05], SHOW_PROPS: 'boolean', SHOW_SURFACES: 'boolean' });
