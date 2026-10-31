import {
  AdditiveBlending,
  BackSide,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  type Material,
  RedFormat,
  ShaderMaterial,
  type Texture,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { TILE_SIZE } from '../shared/map/schema.js';

// Visual experiments, client-only and individually switchable. On the Hunter and the Creature: a
// black cartoon outline, and shading from the scene's light with a dithered edge between light
// and shadow.
// On the flashlight: a soft volumetric beam with a glow at the lens, and the light itself
// lighting the floors and walls it reaches. None of it changes what the light hits; the server
// decides that.
// On the floors and walls: hard, unfiltered texels instead of smooth filtering.
// On the battery pickups: a pale yellow halo and rising motes, the same light on the floors and
// walls round them, and glowing symbols with a charge sweeping up the can.
// On the candles (props.ts): a warm, flickering light on everything round them, and a small halo
// round each flame.
// On the whole picture (post.ts): a soft bloom, and a night grade with a vignette. Under the
// players and batteries: soft round blob shadows.
export const VFX = {
  outline: true,
  ditherShading: true,
  beam: true,
  lightPool: true,
  blobShadows: true,
  bloom: true,
  grade: true,
  pixelTextures: false,
  batteryGlow: true,
  candleLight: true,
};
export type VfxKey = keyof typeof VFX;

// The look values below are plain objects, read every frame (syncVfxUniforms, scene.ts and
// props.ts push them to the shaders), so the debug menu can edit them live. The counts that size
// the shaders' arrays and the reach textures stay constants.

// The Hunter and the Creature:
// - OUTLINE_WIDTH: outline thickness as a fraction of the viewport height, so it reads the same at
//   any resolution. The staggered Creature's outline is STAGGER_OUTLINE_COLOR and
//   STAGGER_OUTLINE_WIDTH thick, shown even with the outline toggled off.
// - SHADOW_STRENGTH: the dithered shading's shadow tone as a multiple of the body colour.
//   DITHER_START and DITHER_WIDTH: where the dithered edge between light and shadow sits on N·L,
//   and how wide it is.
// - Blob shadows: their darkness at the centre, under the Hunters and batteries
//   (BLOB_SHADOW_OPACITY) and under the hovering Creature (CREATURE_BLOB_SHADOW_OPACITY).
export const SHADING = {
  OUTLINE_WIDTH: 1 / 600,
  STAGGER_OUTLINE_COLOR: '#ffffff',
  STAGGER_OUTLINE_WIDTH: 3.5 / 600,
  SHADOW_STRENGTH: 0.55,
  DITHER_START: -0.15,
  DITHER_WIDTH: 0.5,
  BLOB_SHADOW_OPACITY: 0.45,
  CREATURE_BLOB_SHADOW_OPACITY: 0.3,
};

// The flashlight:
// - LIGHT_COLOR, shared by the beam, the lens glow and the light pool.
// - The beam's brightness where it is densest (BEAM_INTENSITY), the share of its length after
//   which it fades out (BEAM_FADE_START), and the height over which it fades into the floor
//   (BEAM_FLOOR_SOFT, so the edge where the cone's lower half meets the floor is soft instead of a
//   hard step in brightness). GLOW_INTENSITY: the lens glow's brightness at its centre.
// - The light pool, the flashlight lighting the floors and walls it reaches. It spreads wider than
//   the hit cone (POOL_SPREAD times its angle, at most POOL_MAX_ANGLE degrees) and further
//   (POOL_REACH times the battery stage's range), so it shortens with the battery like the beam.
//   Its brightness, as a share of the surface's own colour, is POOL_INTENSITY at the Hunter, fading
//   smoothly to nothing at its reach (sharpened by POOL_FALLOFF above 1) and softened toward its
//   sides from POOL_SOFT_SIDES of its half-angle. Inside the real hit cone it is brighter by
//   POOL_CORE_BOOST, so the aim still reads.
// - The flat fan drawn on the floor instead when the light pool is off: FAN_COLOR at FAN_OPACITY.
export const FLASHLIGHT = {
  LIGHT_COLOR: '#ffe9a8',
  BEAM_INTENSITY: 0.27,
  BEAM_FADE_START: 0.8,
  BEAM_FLOOR_SOFT: 14,
  GLOW_INTENSITY: 0.9,
  POOL_SPREAD: 1.8,
  POOL_MAX_ANGLE: 170,
  POOL_REACH: 1.5,
  POOL_INTENSITY: 1.3,
  POOL_FALLOFF: 1.0,
  POOL_SOFT_SIDES: 0.35,
  POOL_CORE_BOOST: 0.35,
  FAN_COLOR: '#f2e8a8',
  FAN_OPACITY: 0.35,
};
// POOL_RAYS rays measure where walls stop the pool, like the fan. Pool slots: one per Hunter,
// each in one component of a vec4.
export const POOL_RAYS = 32;
export const POOL_SLOTS = 4;

// Battery glow: each pickup lights the floors and walls within BATTERY_LIGHT_RADIUS in
// BATTERY_LIGHT_COLOR, a pale yellow lighter than the flashlight's, at BATTERY_LIGHT_INTENSITY
// times the surface's own colour beside it, fading to nothing at the radius. Its halo is
// HALO_INTENSITY bright at its centre (hidden behind the battery) before it fades out, before the
// pulse (scene.ts) scales it; its motes are MOTE_INTENSITY times the glow colour (past the bloom
// threshold).
export const BATTERY_LIGHT = {
  BATTERY_LIGHT_COLOR: '#fff4c4',
  BATTERY_LIGHT_RADIUS: 60,
  BATTERY_LIGHT_INTENSITY: 2.6,
  HALO_INTENSITY: 2.6,
  MOTE_INTENSITY: 2.0,
};
// BATTERY_LIGHT_RAYS rays around each battery measure where walls stop its light, so it never
// shows on the far side of a wall; they are measured out to BATTERY_LIGHT_REACH, the largest radius
// the light may be given. Up to MAX_BATTERY_LIGHTS batteries light their surroundings; any further
// spawn points on a map only get the halo.
export const BATTERY_LIGHT_RAYS = 24;
export const BATTERY_LIGHT_REACH = 180;
export const MAX_BATTERY_LIGHTS = 16;

// Candle light: each candle flame lights what is within CANDLE_LIGHT_RADIUS of it in
// CANDLE_LIGHT_COLOR, a warm amber, at CANDLE_LIGHT_INTENSITY times the surface's own colour times
// its share of its candle's brightness (props.ts), fading to nothing at the radius. All the candles
// together light a surface by at most CANDLE_LIGHT_MAX times its colour, so the holder or wallpaper
// right by a flame stays a warm colour rather than blowing out. Each flame's halo (props.ts) is
// CANDLE_HALO_INTENSITY bright at its centre.
export const CANDLE_LIGHT = {
  CANDLE_LIGHT_COLOR: '#ffa04a',
  CANDLE_LIGHT_RADIUS: 100,
  CANDLE_LIGHT_INTENSITY: 2.2,
  CANDLE_LIGHT_MAX: 1.3,
  CANDLE_HALO_INTENSITY: 2.6,
};
// CANDLE_LIGHT_RAYS rays round each light measure where walls and props taller than its flames stop
// it, out to CANDLE_LIGHT_REACH, the largest radius it may be given. Up to MAX_CANDLE_LIGHTS flames
// light their surroundings; any more only glow.
export const CANDLE_LIGHT_RAYS = 24;
export const CANDLE_LIGHT_REACH = 300;
export const MAX_CANDLE_LIGHTS = 48;

// The battery's own body is lit, PlayStation style (createBatteryMaterial): by the night's
// ambient and moonlight like the floors and, with the glow off, a key, BATTERY_KEY_COLOR at
// BATTERY_KEY_INTENSITY, falling to half at BATTERY_KEY_FALLOFF units from the key's point.
// With the glow on, its lampshade glow takes the key's place.
const BATTERY_KEY_COLOR = '#fff6dc';
const BATTERY_KEY_INTENSITY = 1.1;
const BATTERY_KEY_FALLOFF = 30;
// The battery glows from inside like a lampshade over a bulb, so it reads as charged: its paint
// shines at BATTERY_SHADE_LIGHT, tinted toward BATTERY_SHADE_COLOR by BATTERY_SHADE_TINT the
// way pigments mix (a weighted geometric mean, so its blue turns teal rather than grey). It is
// full where it faces the view and dims to BATTERY_SHADE_EDGE at its silhouette, so it still
// looks round. Its glow mask (the label, the symbols, the streaks) shines brighter still in
// BATTERY_LIGHT_COLOR at BATTERY_EMISSION, past the bloom threshold. Every
// BATTERY_CHARGE_PERIOD seconds a charge, a band BATTERY_CHARGE_WIDTH of the profile tall,
// sweeps up from the base to the cap in the first BATTERY_CHARGE_SWEEP of the period: it lights
// the paint it crosses by BATTERY_CHARGE_SELF_LIGHT more and the mask by BATTERY_CHARGE_BOOST.
// When it reaches the cap the halo and the floor light flash (batteryChargeFlash) and fade.
const BATTERY_SHADE_COLOR = '#ffd860';
const BATTERY_SHADE_TINT = 0.5;
const BATTERY_SHADE_LIGHT = 1.3;
const BATTERY_SHADE_EDGE = 0.45;
const BATTERY_EMISSION = 1.3;
const BATTERY_CHARGE_PERIOD = 2.4;
const BATTERY_CHARGE_SWEEP = 0.6;
const BATTERY_CHARGE_WIDTH = 0.07;
const BATTERY_CHARGE_SELF_LIGHT = 0.6;
const BATTERY_CHARGE_BOOST = 1.8;
// Motes of light rising round each battery: MOTE_COUNT of them, each MOTE_PIXELS CSS pixels
// square, climbing from MOTE_FROM to MOTE_TO (battery heights from its middle) over
// MOTE_LIFE seconds on a ring MOTE_RADIUS battery heights out.
export const MOTE_COUNT = 8;
export const MOTE_PIXELS = 2;
const MOTE_FROM = -0.4;
const MOTE_TO = 1.3;
const MOTE_LIFE = 2.6;
const MOTE_RADIUS = 0.36;
// PlayStation colour depth: levels per channel, in display (sRGB) space.
const PS1_COLOR_LEVELS = 32;

// Shared by the patched materials. Only one scene exists at a time, so these are module-level.
export const VFX_UNIFORMS = {
  vfxLightDirection: { value: new Vector3(0, 1, 0) },
  vfxDitherShading: { value: 1 },
  vfxAspect: { value: 1 },
  vfxShadowStrength: { value: SHADING.SHADOW_STRENGTH },
  vfxDitherStart: { value: SHADING.DITHER_START },
  vfxDitherWidth: { value: SHADING.DITHER_WIDTH },
};

// 4x4 ordered-dither threshold in [0, 1) for a pixel coordinate, built from the 2x2 Bayer matrix.
const BAYER_GLSL = /* glsl */ `
float vfxBayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float vfxBayer4(vec2 a) { return vfxBayer2(0.5 * a) * 0.25 + vfxBayer2(a) + 1.0 / 32.0; }
`;

// The Hunter and Creature bodies: emissive (unlit) in their model files. This shades them from
// the scene's light, light or shadow per screen pixel, with the edge between them broken up by
// an ordered dither.
function ditheredBodyShader(shader: WebGLProgramParametersWithUniforms): void {
  shader.uniforms.vfxLightDirection = VFX_UNIFORMS.vfxLightDirection;
  shader.uniforms.vfxDitherShading = VFX_UNIFORMS.vfxDitherShading;
  shader.uniforms.vfxShadowStrength = VFX_UNIFORMS.vfxShadowStrength;
  shader.uniforms.vfxDitherStart = VFX_UNIFORMS.vfxDitherStart;
  shader.uniforms.vfxDitherWidth = VFX_UNIFORMS.vfxDitherWidth;
  shader.fragmentShader = /* glsl */ `
uniform vec3 vfxLightDirection;
uniform float vfxDitherShading;
uniform float vfxShadowStrength;
uniform float vfxDitherStart;
uniform float vfxDitherWidth;
${BAYER_GLSL}
` + shader.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
  float vfxLight = clamp((dot(normal, vfxLightDirection) - vfxDitherStart) / vfxDitherWidth, 0.0, 1.0);
  float vfxShade = vfxLight > vfxBayer4(gl_FragCoord.xy) ? 1.0 : vfxShadowStrength;
  totalEmissiveRadiance *= mix(1.0, vfxShade, vfxDitherShading);
}`);
}

export function ditheredBody<T extends Material>(material: T): T {
  material.onBeforeCompile = ditheredBodyShader;
  return material;
}

// Inverted-hull outline: the model drawn again, back faces only, each vertex pushed out along
// its normal in screen space so the line has the same width everywhere on screen. Black at
// OUTLINE_WIDTH; each material has its own colour and width so the Creature's can change.
export function createOutlineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    uniforms: {
      vfxOutlineWidth: { value: SHADING.OUTLINE_WIDTH },
      vfxOutlineColor: { value: new Color('#000000') },
      vfxAspect: VFX_UNIFORMS.vfxAspect,
    },
    vertexShader: /* glsl */ `
uniform float vfxOutlineWidth;
uniform float vfxAspect;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec2 vfxNormal = (projectionMatrix * vec4(normalize(normalMatrix * normal), 0.0)).xy;
  vec2 vfxPush = normalize(vfxNormal + vec2(1e-6)) * vec2(1.0 / vfxAspect, 1.0);
  gl_Position.xy += vfxPush * vfxOutlineWidth * 2.0 * gl_Position.w;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 vfxOutlineColor;
void main() {
  gl_FragColor = vec4(vfxOutlineColor, 1.0);
}`,
  });
}

// The Hunters' outline, shared by all of them.
export const OUTLINE_MATERIAL = createOutlineMaterial();

// Shared by the flashlight shaders: wraps an angle into -pi..pi.
const ANGLE_GLSL = /* glsl */ `
float vfxWrapAngle(float a) { return atan(sin(a), cos(a)); }
`;

// How much a round light centred on `center` lights a fragment, before its brightness: row `slot`
// of `reaches` holds how far each of its `rays` rays travels before something stops it; ray i
// points at angle 2*pi*i/rays from +X toward +Z. Needs FLASH_MARGIN.
const ROUND_LIGHT_GLSL = /* glsl */ `
float vfxRoundLight(vec3 world, vec3 normal, vec3 center, float radius, sampler2D reaches, int slot, int rays) {
  vec2 offset = world.xz - center.xz;
  float across = length(offset);
  if (across > radius + 2.0) return 0.0;
  float ray = fract(atan(offset.y, offset.x) / (2.0 * PI)) * float(rays);
  int first = min(int(floor(ray)), rays - 1);
  float reach = mix(texelFetch(reaches, ivec2(first, slot), 0).r,
    texelFetch(reaches, ivec2((first + 1) % rays, slot), 0).r, ray - float(first));
  float wall = 1.0 - smoothstep(reach + FLASH_MARGIN, reach + FLASH_MARGIN + 2.0, across);
  vec3 toLight = center - world;
  float fade = 1.0 - smoothstep(0.0, 1.0, length(toLight) / radius);
  float facing = smoothstep(-0.1, 0.3, dot(normal, normalize(toLight)));
  return fade * fade * wall * facing;
}
`;

// The light pool's per-frame state, shared by every floor and wall material (one scene at a
// time). Each Hunter slot is one component: `flashOrigin[slot]` is (x, z, facing, pool reach)
// and `flashOn` is how bright each slot's light is: 0 when off, 1 when on, in between while the
// viewer's own light stutters near the Creature (fear.ts). `flashReach[ray]` is how far each slot's ray
// travels before a wall, across the pool's angle (the same wall test as the fan and the server).
// The angles and heights are the same for every Hunter; the rest is FLASHLIGHT's.
export const POOL_UNIFORMS = {
  flashOrigin: { value: Array.from({ length: POOL_SLOTS }, () => new Vector4()) },
  flashOn: { value: new Vector4() },
  flashReach: { value: Array.from({ length: POOL_RAYS + 1 }, () => new Vector4()) },
  flashHalfAngle: { value: 1 },
  flashCoreHalfAngle: { value: 1 },
  flashLensY: { value: 0 },
  flashFloorY: { value: 0 },
  flashColor: { value: new Color(FLASHLIGHT.LIGHT_COLOR) },
  flashIntensity: { value: FLASHLIGHT.POOL_INTENSITY },
  flashFalloff: { value: FLASHLIGHT.POOL_FALLOFF },
  flashSoftSides: { value: FLASHLIGHT.POOL_SOFT_SIDES },
  flashCoreBoost: { value: FLASHLIGHT.POOL_CORE_BOOST },
  flashPoolReach: { value: FLASHLIGHT.POOL_REACH },
};

// The battery lights' state, shared by every floor and wall material like POOL_UNIFORMS. Each
// slot of `batteryLights` is (x, z, brightness, unused): brightness 0 while that pickup is
// taken. `batteryLightReach` holds, per slot (row), how far each ray (column) travels before a
// wall; ray i points at angle 2*pi*i/BATTERY_LIGHT_RAYS from +X toward +Z. `batteryLightY` is
// the height of the batteries' middles.
export const BATTERY_LIGHT_UNIFORMS = {
  batteryLights: { value: Array.from({ length: MAX_BATTERY_LIGHTS }, () => new Vector4()) },
  batteryLightReach: {
    value: new DataTexture(new Float32Array(BATTERY_LIGHT_RAYS * MAX_BATTERY_LIGHTS), BATTERY_LIGHT_RAYS,
      MAX_BATTERY_LIGHTS, RedFormat, FloatType),
  },
  batteryLightY: { value: 0 },
  batteryLightColor: { value: new Color(BATTERY_LIGHT.BATTERY_LIGHT_COLOR) },
  batteryLightRadius: { value: BATTERY_LIGHT.BATTERY_LIGHT_RADIUS },
  batteryLightIntensity: { value: BATTERY_LIGHT.BATTERY_LIGHT_INTENSITY },
};

// The candle lights' state, shared like BATTERY_LIGHT_UNIFORMS. Each slot of `candleLights` is
// (x, y, z, brightness), set by props.ts: brightness 0 for an unused slot or with the light
// toggled off. `candleLightReach` is laid out like `batteryLightReach`.
export const CANDLE_LIGHT_UNIFORMS = {
  candleLights: { value: Array.from({ length: MAX_CANDLE_LIGHTS }, () => new Vector4()) },
  candleLightReach: {
    value: new DataTexture(new Float32Array(CANDLE_LIGHT_RAYS * MAX_CANDLE_LIGHTS), CANDLE_LIGHT_RAYS,
      MAX_CANDLE_LIGHTS, RedFormat, FloatType),
  },
  candleLightColor: { value: new Color(CANDLE_LIGHT.CANDLE_LIGHT_COLOR) },
  candleLightRadius: { value: CANDLE_LIGHT.CANDLE_LIGHT_RADIUS },
  candleLightIntensity: { value: CANDLE_LIGHT.CANDLE_LIGHT_INTENSITY },
  candleLightMax: { value: CANDLE_LIGHT.CANDLE_LIGHT_MAX },
};

// The flashlight lighting a floor or wall material (MeshLambertMaterial): every lit slot adds
// warm light to the surface's own colour, brightest near the Hunter and fading with distance,
// with soft sides and a brighter core inside the hit cone. A fragment further than its ray's
// reach is behind a wall and gets nothing; the small margin lets the wall face the ray stops at
// catch the light, while wall tops stay dark. Positions and normals are world space (the
// surface meshes are untransformed). The battery and candle lights are added the same way, each
// a round pool cut at its walls. Called first by every surface material's onBeforeCompile.
export function flashlitSurfaceShader(shader: WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, POOL_UNIFORMS, BATTERY_LIGHT_UNIFORMS, CANDLE_LIGHT_UNIFORMS);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFlashWorld;\nvarying vec3 vFlashNormal;')
    .replace('#include <project_vertex>', `#include <project_vertex>
vFlashWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFlashNormal = normalize(mat3(modelMatrix) * objectNormal);`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', /* glsl */ `#include <common>
varying vec3 vFlashWorld;
varying vec3 vFlashNormal;
uniform vec4 flashOrigin[${POOL_SLOTS}];
uniform vec4 flashOn;
uniform vec4 flashReach[${POOL_RAYS + 1}];
uniform float flashHalfAngle;
uniform float flashCoreHalfAngle;
uniform float flashLensY;
uniform float flashFloorY;
uniform vec3 flashColor;
uniform float flashIntensity;
uniform float flashFalloff;
uniform float flashSoftSides;
uniform float flashCoreBoost;
uniform float flashPoolReach;
uniform vec4 batteryLights[${MAX_BATTERY_LIGHTS}];
uniform sampler2D batteryLightReach;
uniform float batteryLightY;
uniform vec3 batteryLightColor;
uniform float batteryLightRadius;
uniform float batteryLightIntensity;
uniform vec4 candleLights[${MAX_CANDLE_LIGHTS}];
uniform sampler2D candleLightReach;
uniform vec3 candleLightColor;
uniform float candleLightRadius;
uniform float candleLightIntensity;
uniform float candleLightMax;
${ANGLE_GLSL}
#ifdef FLASHLIT_PROP
#define FLASH_MARGIN ${PROP_LIGHT_MARGIN.toFixed(1)}
#else
#define FLASH_MARGIN 0.0
#endif
${ROUND_LIGHT_GLSL}float vfxFlashlight(vec3 world, vec3 normal) {
#ifndef FLASHLIT_PROP
  // Wall tops are never lit: the light stops at the face below them.
  if (normal.y > 0.5 && world.y > flashFloorY + 1.0) return 0.0;
#endif
  float total = 0.0;
  for (int slot = 0; slot < ${POOL_SLOTS}; slot++) {
    if (flashOn[slot] <= 0.0) continue;
    vec4 origin = flashOrigin[slot];
    vec2 offset = world.xz - origin.xy;
    float distance = length(offset);
    if (distance > origin.w + 2.0) continue;
    float angle = vfxWrapAngle(atan(offset.y, offset.x) - origin.z);
    float across = angle / flashHalfAngle;
    if (abs(across) > 1.0) continue;
    float ray = (across * 0.5 + 0.5) * float(${POOL_RAYS});
    int first = int(min(floor(ray), float(${POOL_RAYS - 1})));
    float reach = mix(flashReach[first][slot], flashReach[first + 1][slot], ray - float(first));
    float wall = 1.0 - smoothstep(reach + FLASH_MARGIN, reach + FLASH_MARGIN + 2.0, distance);
    float fade = pow(1.0 - smoothstep(0.0, 1.0, distance / origin.w), flashFalloff);
    float sides = 1.0 - smoothstep(flashSoftSides, 1.0, abs(across));
    // The core: the hit cone, out to the battery stage's range.
    float core = (1.0 - smoothstep(flashCoreHalfAngle * 0.75, flashCoreHalfAngle, abs(angle)))
      * (1.0 - smoothstep(0.8, 1.0, distance * flashPoolReach / origin.w));
    vec3 toLens = normalize(vec3(origin.x, flashLensY, origin.y) - world);
    float facing = smoothstep(-0.1, 0.3, dot(normal, toLens));
    total += (flashIntensity * sides + flashCoreBoost * core) * fade * wall * facing * flashOn[slot];
  }
  return total;
}
float vfxBatteryLight(vec3 world, vec3 normal) {
#ifndef FLASHLIT_PROP
  if (normal.y > 0.5 && world.y > flashFloorY + 1.0) return 0.0;
#endif
  float total = 0.0;
  for (int slot = 0; slot < ${MAX_BATTERY_LIGHTS}; slot++) {
    vec4 light = batteryLights[slot];
    if (light.z <= 0.0) continue;
    total += batteryLightIntensity * light.z * vfxRoundLight(world, normal,
      vec3(light.x, batteryLightY, light.y), batteryLightRadius, batteryLightReach, slot, ${BATTERY_LIGHT_RAYS});
  }
  return total;
}
float vfxCandleLight(vec3 world, vec3 normal) {
#ifndef FLASHLIT_PROP
  if (normal.y > 0.5 && world.y > flashFloorY + 1.0) return 0.0;
#endif
  float total = 0.0;
  for (int slot = 0; slot < ${MAX_CANDLE_LIGHTS}; slot++) {
    vec4 light = candleLights[slot];
    if (light.w <= 0.0) continue;
    total += candleLightIntensity * light.w * vfxRoundLight(world, normal,
      light.xyz, candleLightRadius, candleLightReach, slot, ${CANDLE_LIGHT_RAYS});
  }
  return min(total, candleLightMax);
}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse += diffuseColor.rgb * flashColor * vfxFlashlight(vFlashWorld, normalize(vFlashNormal));
reflectedLight.directDiffuse += diffuseColor.rgb * batteryLightColor * vfxBatteryLight(vFlashWorld, normalize(vFlashNormal));
reflectedLight.directDiffuse += diffuseColor.rgb * candleLightColor * vfxCandleLight(vFlashWorld, normalize(vFlashNormal));`);
}

// The same lighting on a prop's material. A prop stands inside the tile it blocks, so a ray stops
// at the tile's edge, short of the prop: its light carries PROP_LIGHT_MARGIN further, across the
// prop's own tile but not through a wall tile to a prop beyond (a prop right behind another one
// does catch some). Upward faces are lit too, so table tops show.
const PROP_LIGHT_MARGIN = TILE_SIZE - 2;
export function flashlitPropShader(shader: WebGLProgramParametersWithUniforms): void {
  flashlitSurfaceShader(shader);
  shader.fragmentShader = `#define FLASHLIT_PROP\n${shader.fragmentShader}`;
}

// A soft round shadow on the floor: black, fading out from the centre. Drawn on a unit circle
// lying flat, scaled to the thing it sits under. Its opacity is set every frame (scene.ts).
export function createBlobShadowMaterial(creature = false): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { opacity: { value: creature ? SHADING.CREATURE_BLOB_SHADOW_OPACITY : SHADING.BLOB_SHADOW_OPACITY } },
    vertexShader: /* glsl */ `
varying vec2 vOffset;
void main() {
  vOffset = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float opacity;
varying vec2 vOffset;
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, opacity * (1.0 - smoothstep(0.35, 1.0, length(vOffset))));
}`,
  });
}

// The beam's shape, shared by every Hunter's beam material.
const BEAM_UNIFORMS = {
  beamIntensity: { value: FLASHLIGHT.BEAM_INTENSITY },
  beamFadeStart: { value: FLASHLIGHT.BEAM_FADE_START },
  beamFloorSoft: { value: FLASHLIGHT.BEAM_FLOOR_SOFT },
  glowIntensity: { value: FLASHLIGHT.GLOW_INTENSITY },
};

// The volumetric beam: an open cone from the lens, drawn additively on both sides. It is
// densest where the view looks straight through it, fades toward its silhouette and over the
// last part of its length (from BEAM_FADE_START) and into the floor, and is cut where the flashlight's rays meet a wall: `reaches` holds the distance
// each of the fan's rays travels before a wall (the same wall test as the server's line of
// sight), measured from the Hunter's centre across the cone's width.
export function createBeamMaterial(rays: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    defines: { BEAM_RAYS: rays },
    uniforms: {
      ...BEAM_UNIFORMS,
      lightColor: { value: new Color(FLASHLIGHT.LIGHT_COLOR) },
      lightOrigin: { value: new Vector3() },
      lightApex: { value: new Vector3() },
      lightFacing: { value: 0 },
      lightRange: { value: 1 },
      lightHalfAngle: { value: 1 },
      floorY: { value: 0 },
      reaches: { value: new Float32Array(rays + 1) },
    },
    vertexShader: /* glsl */ `
varying vec3 vWorld;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewPosition;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 lightColor;
uniform vec3 lightOrigin;
uniform vec3 lightApex;
uniform float lightFacing;
uniform float lightRange;
uniform float lightHalfAngle;
uniform float floorY;
uniform float reaches[BEAM_RAYS + 1];
uniform float beamIntensity;
uniform float beamFadeStart;
uniform float beamFloorSoft;
varying vec3 vWorld;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
${ANGLE_GLSL}
void main() {
  if (vWorld.y < floorY) discard;
  // Wall cut: compare this point's distance from the Hunter with its ray's reach.
  vec2 offset = vWorld.xz - lightOrigin.xz;
  float across = vfxWrapAngle(atan(offset.y, offset.x) - lightFacing) / lightHalfAngle;
  float ray = clamp((across * 0.5 + 0.5) * float(BEAM_RAYS), 0.0, float(BEAM_RAYS));
  int first = int(min(floor(ray), float(BEAM_RAYS - 1)));
  float reach = mix(reaches[first], reaches[first + 1], ray - float(first));
  float distance = length(offset);
  if (distance > reach) discard;
  float wall = 1.0 - smoothstep(reach - 8.0, reach, distance);
  float along = clamp(length(vWorld - lightApex) / lightRange, 0.0, 1.0);
  float fade = 1.0 - smoothstep(beamFadeStart, 1.0, along);
  float facingView = abs(dot(normalize(vViewNormal), normalize(-vViewPosition)));
  float floorFade = smoothstep(0.0, beamFloorSoft, vWorld.y - floorY);
  float strength = beamIntensity * facingView * facingView * fade * wall * floorFade;
  gl_FragColor = vec4(lightColor * strength, 1.0);
}`,
  });
}

// The lens glow: a small sphere drawn additively, bright where it faces the view and fading
// to nothing at its silhouette, so it reads as a soft point of light.
export function createGlowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { lightColor: { value: new Color(FLASHLIGHT.LIGHT_COLOR) }, glowIntensity: BEAM_UNIFORMS.glowIntensity },
    vertexShader: /* glsl */ `
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewPosition;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 lightColor;
uniform float glowIntensity;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  float facingView = abs(dot(normalize(vViewNormal), normalize(-vViewPosition)));
  gl_FragColor = vec4(lightColor * glowIntensity * pow(facingView, 3.0), 1.0);
}`,
  });
}

// A battery's halo (or, in another `color`, a candle flame's): a flat disc facing the camera
// through the battery's middle, drawn additively and brightest at its centre, fading out to its
// rim. Drawn on a unit circle, scaled to the halo's radius. It is drawn before the battery
// (scene.ts orders them), which then covers its middle, so only the glow round the battery
// shows; it still sits behind anything nearer the camera. Not `transparent`, so it is drawn in
// that order with the opaque meshes. Its colour and `haloIntensity` are set every frame.
export function createHaloMaterial(color = BATTERY_LIGHT.BATTERY_LIGHT_COLOR, intensity = BATTERY_LIGHT.HALO_INTENSITY): ShaderMaterial {
  return new ShaderMaterial({
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      haloColor: { value: new Color(color) },
      haloIntensity: { value: intensity },
      haloPulse: { value: 1 },
    },
    vertexShader: /* glsl */ `
varying vec2 vOffset;
void main() {
  vOffset = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 haloColor;
uniform float haloIntensity;
uniform float haloPulse;
varying vec2 vOffset;
void main() {
  float fade = 1.0 - min(length(vOffset), 1.0);
  gl_FragColor = vec4(haloColor * haloIntensity * haloPulse * fade * fade, 1.0);
}`,
  });
}

// The lighting the battery bodies share: the hemisphere light's sky and ground colours and the
// moonlight's colour (each already times its intensity) and world direction, set by scene.ts
// from its own lights; the glow's pulse, whether the glow is on (1 or 0), its colour, and the
// seconds the charge sweep and the motes run on.
export const BATTERY_BODY_UNIFORMS = {
  batteryAmbientSky: { value: new Color() },
  batteryAmbientGround: { value: new Color() },
  batteryMoonColor: { value: new Color() },
  batteryMoonDirection: { value: new Vector3(0, 1, 0) },
  batteryGlowPulse: { value: 1 },
  batteryGlowOn: { value: 1 },
  batteryGlowColor: { value: new Color(BATTERY_LIGHT.BATTERY_LIGHT_COLOR) },
  batteryTime: { value: 0 },
};

// Pushes the look values above into the uniforms every material shares. Once a frame, from
// scene.ts; the per-material ones (halos, motes, blob shadows, the Creature's outline) are set
// where those materials are used.
export function syncVfxUniforms(): void {
  VFX_UNIFORMS.vfxShadowStrength.value = SHADING.SHADOW_STRENGTH;
  VFX_UNIFORMS.vfxDitherStart.value = SHADING.DITHER_START;
  VFX_UNIFORMS.vfxDitherWidth.value = SHADING.DITHER_WIDTH;
  OUTLINE_MATERIAL.uniforms.vfxOutlineWidth.value = SHADING.OUTLINE_WIDTH;
  POOL_UNIFORMS.flashColor.value.set(FLASHLIGHT.LIGHT_COLOR);
  POOL_UNIFORMS.flashIntensity.value = FLASHLIGHT.POOL_INTENSITY;
  POOL_UNIFORMS.flashFalloff.value = FLASHLIGHT.POOL_FALLOFF;
  POOL_UNIFORMS.flashSoftSides.value = FLASHLIGHT.POOL_SOFT_SIDES;
  POOL_UNIFORMS.flashCoreBoost.value = FLASHLIGHT.POOL_CORE_BOOST;
  POOL_UNIFORMS.flashPoolReach.value = FLASHLIGHT.POOL_REACH;
  BEAM_UNIFORMS.beamIntensity.value = FLASHLIGHT.BEAM_INTENSITY;
  BEAM_UNIFORMS.beamFadeStart.value = FLASHLIGHT.BEAM_FADE_START;
  BEAM_UNIFORMS.beamFloorSoft.value = FLASHLIGHT.BEAM_FLOOR_SOFT;
  BEAM_UNIFORMS.glowIntensity.value = FLASHLIGHT.GLOW_INTENSITY;
  BATTERY_LIGHT_UNIFORMS.batteryLightColor.value.set(BATTERY_LIGHT.BATTERY_LIGHT_COLOR);
  // The reaches were measured out to BATTERY_LIGHT_REACH, so the light never goes past it.
  BATTERY_LIGHT_UNIFORMS.batteryLightRadius.value = Math.min(BATTERY_LIGHT.BATTERY_LIGHT_RADIUS, BATTERY_LIGHT_REACH);
  BATTERY_LIGHT_UNIFORMS.batteryLightIntensity.value = BATTERY_LIGHT.BATTERY_LIGHT_INTENSITY;
  BATTERY_BODY_UNIFORMS.batteryGlowColor.value.set(BATTERY_LIGHT.BATTERY_LIGHT_COLOR);
  CANDLE_LIGHT_UNIFORMS.candleLightColor.value.set(CANDLE_LIGHT.CANDLE_LIGHT_COLOR);
  CANDLE_LIGHT_UNIFORMS.candleLightRadius.value = Math.min(CANDLE_LIGHT.CANDLE_LIGHT_RADIUS, CANDLE_LIGHT_REACH);
  CANDLE_LIGHT_UNIFORMS.candleLightIntensity.value = CANDLE_LIGHT.CANDLE_LIGHT_INTENSITY;
  CANDLE_LIGHT_UNIFORMS.candleLightMax.value = CANDLE_LIGHT.CANDLE_LIGHT_MAX;
}

// The flash as a charge reaches the cap: 1 that moment, fading to 0 by the next sweep.
export function batteryChargeFlash(seconds: number): number {
  const phase = (seconds / BATTERY_CHARGE_PERIOD) % 1;
  return phase < BATTERY_CHARGE_SWEEP ? 0 : (1 - (phase - BATTERY_CHARGE_SWEEP) / (1 - BATTERY_CHARGE_SWEEP)) ** 2;
}

// A battery body drawn the way a PlayStation would: lit per vertex and blended across each
// face (Gouraud), the texture stretched straight across the screen instead of in perspective
// (affine), and the colour cut to 15 bits with an ordered dither. The ambient and moonlight
// follow three's Lambert maths so the battery sits in the same night as the floors;
// `keyPosition` is where its glow key lights it from, in world space. On top comes its own
// light: the lampshade glow, the glow mask `glow` and the charge sweep.
export function createBatteryMaterial(map: Texture, glow: Texture, keyPosition: Vector3): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      ...BATTERY_BODY_UNIFORMS,
      map: { value: map },
      glow: { value: glow },
      batteryKeyPosition: { value: keyPosition.clone() },
      batteryKeyColor: { value: new Color(BATTERY_KEY_COLOR).multiplyScalar(BATTERY_KEY_INTENSITY) },
      batteryShadeColor: { value: new Color(BATTERY_SHADE_COLOR) },
    },
    vertexShader: /* glsl */ `
#include <common>
uniform vec3 batteryAmbientSky;
uniform vec3 batteryAmbientGround;
uniform vec3 batteryMoonColor;
uniform vec3 batteryMoonDirection;
uniform float batteryGlowOn;
uniform vec3 batteryKeyPosition;
uniform vec3 batteryKeyColor;
varying vec3 vLight;
varying vec3 vAffineUv;
varying float vFacing;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
  vFacing = max(dot(worldNormal, normalize(cameraPosition - world.xyz)), 0.0);
  vec3 ambient = mix(batteryAmbientGround, batteryAmbientSky, 0.5 * worldNormal.y + 0.5);
  vec3 moon = batteryMoonColor * max(dot(worldNormal, batteryMoonDirection), 0.0);
  vec3 toKey = batteryKeyPosition - world.xyz;
  float keyDistance = length(toKey) / ${BATTERY_KEY_FALLOFF.toFixed(1)};
  float key = max(dot(worldNormal, normalize(toKey)), 0.0) / (1.0 + keyDistance * keyDistance);
  // With the glow on, the lampshade glow (below) stands in for the key.
  vLight = (ambient + moon) * RECIPROCAL_PI + batteryKeyColor * key * (1.0 - batteryGlowOn);
  gl_Position = projectionMatrix * viewMatrix * world;
  // Interpolated in perspective and divided back by w, this comes out screen-linear: affine.
  vAffineUv = vec3(uv * gl_Position.w, gl_Position.w);
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D map;
uniform sampler2D glow;
uniform float batteryGlowPulse;
uniform float batteryGlowOn;
uniform vec3 batteryGlowColor;
uniform float batteryTime;
uniform vec3 batteryShadeColor;
varying vec3 vLight;
varying vec3 vAffineUv;
varying float vFacing;
${BAYER_GLSL}
void main() {
  vec2 uv = vAffineUv.xy / vAffineUv.z;
  vec3 paint = texture2D(map, uv).rgb;
  // The charge band's middle runs from below the base to above the cap; up the profile is
  // 1 - uv.y (glTF's v runs down from the top).
  float phase = fract(batteryTime / ${BATTERY_CHARGE_PERIOD.toFixed(3)});
  float head = mix(-2.0, 2.0 + 1.0 / ${BATTERY_CHARGE_WIDTH.toFixed(3)}, phase / ${BATTERY_CHARGE_SWEEP.toFixed(3)});
  float across = (1.0 - uv.y) / ${BATTERY_CHARGE_WIDTH.toFixed(3)} - head;
  float charge = phase < ${BATTERY_CHARGE_SWEEP.toFixed(3)} ? exp(-across * across) * batteryGlowOn : 0.0;
  float shadeLight = batteryGlowOn * batteryGlowPulse * ${BATTERY_SHADE_LIGHT.toFixed(3)}
    * mix(${BATTERY_SHADE_EDGE.toFixed(3)}, 1.0, vFacing);
  vec3 tinted = pow(paint, vec3(${(1 - BATTERY_SHADE_TINT).toFixed(3)})) * pow(batteryShadeColor, vec3(${BATTERY_SHADE_TINT.toFixed(3)}));
  vec3 shade = tinted * (shadeLight + charge * ${BATTERY_CHARGE_SELF_LIGHT.toFixed(3)});
  float emission = texture2D(glow, uv).r * batteryGlowOn
    * (${BATTERY_EMISSION.toFixed(3)} * batteryGlowPulse + charge * ${BATTERY_CHARGE_BOOST.toFixed(3)});
  vec3 color = paint * vLight + shade + batteryGlowColor * emission;
  vec3 display = pow(max(color, 0.0), vec3(1.0 / 2.2)) * ${(PS1_COLOR_LEVELS - 1).toFixed(1)};
  display = floor(display + vfxBayer4(gl_FragCoord.xy)) / ${(PS1_COLOR_LEVELS - 1).toFixed(1)};
  gl_FragColor = vec4(pow(display, vec3(2.2)), 1.0);
}`,
  });
}

// The motes rising round a battery (see MOTE_COUNT): `Points` at the battery's middle, each
// point's `seed` its angle round the battery and its phase in the climb. Square, unsmoothed
// points, the PlayStation way, drawn additively; `pointSize` is MOTE_PIXELS in device pixels.
// `batteryHeight` scales the climb and the ring. Its colour is set every frame (scene.ts).
export function createMoteMaterial(pointSize: number, batteryHeight: number): ShaderMaterial {
  return new ShaderMaterial({
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      batteryTime: BATTERY_BODY_UNIFORMS.batteryTime,
      moteColor: { value: new Color(BATTERY_LIGHT.BATTERY_LIGHT_COLOR).multiplyScalar(BATTERY_LIGHT.MOTE_INTENSITY) },
      moteSize: { value: pointSize },
    },
    vertexShader: /* glsl */ `
#include <common>
attribute vec2 seed;
uniform float batteryTime;
uniform float moteSize;
varying float vFade;
void main() {
  float life = fract(batteryTime / ${MOTE_LIFE.toFixed(3)} + seed.y);
  float angle = seed.x + life * 1.5;
  float radius = ${(MOTE_RADIUS * batteryHeight).toFixed(3)} * (1.0 - 0.4 * life);
  vec3 offset = vec3(cos(angle) * radius, mix(${MOTE_FROM.toFixed(3)}, ${MOTE_TO.toFixed(3)}, life) * ${batteryHeight.toFixed(3)}, sin(angle) * radius);
  vFade = sin(PI * life);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + offset, 1.0);
  gl_PointSize = moteSize;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 moteColor;
varying float vFade;
void main() {
  gl_FragColor = vec4(moteColor * vFade, 1.0);
}`,
  });
}
