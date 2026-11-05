// Short-lived effects in the world, client-only and drawn from what the snapshot already says: the
// sparkle when a battery appears or is collected, and the fire on a burning Creature. Both are flat,
// hard-edged shapes in a few flat colours, faded in the game's ordered dither rather than with soft
// textures, so they sit with the low-poly models. The look values are read as each particle is made
// or every frame (update), so the debug menu edits them live.
//
// Each effect is one instanced mesh with a fixed ring of particles. A particle is written once, when
// it is made, with where it starts, how it moves and how long it lives; the vertex shader works out
// the rest from the clock, so a frame with nothing new costs no CPU and uploads nothing, and a mesh
// with nothing alive is not drawn at all.
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { RoundState } from '../shared/protocol.js';
import { STEADY_FIRE, type FireSurge } from './exorcism.js';
import { BAYER_GLSL } from './vfx.js';

// The sparkle. Lemon, white and the can's powder blue, never as orange as the fire, so the two never
// read as one thing (the browser tests also count that orange as the burning Creature):
// - A flash: one large star at the battery's middle, SPAWN_FLASH or PICKUP_FLASH across its arms,
//   gone in FLASH_LIFE seconds.
// - A thin diamond ring opening to SPAWN_RING or PICKUP_RING over RING_LIFE seconds, as the title
//   wipe's diamonds do, at RING_BRIGHTNESS; a pickup has a second one RING_DELAY later.
// - Glints: small twinkling stars thrown out at up to SPAWN_SPEED or PICKUP_SPEED units a second,
//   slowed by DRAG and pulled down the screen by GRAVITY, each living up to GLINT_LIFE. A spawn
//   lets its few rise gently; a pickup throws more, harder.
// - Flakes (pickup only): tumbling diamonds of confetti, because it is a party.
export const SPARKLE = {
  COLOR_LEMON: '#fff0a0',
  COLOR_WHITE: '#fffdf2',
  COLOR_POWDER: '#a9dcff',
  INTENSITY: 1.5,
  FLASH_LIFE: 0.38,
  RING_LIFE: 0.5,
  RING_DELAY: 0.09,
  RING_THICKNESS: 0.13,
  RING_BRIGHTNESS: 0.55,
  GLINT_SIZE: 11,
  GLINT_LIFE: 1.05,
  FLAKE_SIZE: 6,
  FLAKE_LIFE: 1.15,
  DRAG: 3.2,
  GRAVITY: 30,
  SPAWN_FLASH: 20,
  SPAWN_RING: 30,
  SPAWN_GLINTS: 10,
  SPAWN_SPEED: 125,
  SPAWN_RISE: 40,
  PICKUP_FLASH: 48,
  PICKUP_RING: 46,
  PICKUP_GLINTS: 16,
  PICKUP_FLAKES: 16,
  PICKUP_SPEED: 270,
};

// The fire. Flames: FLAMES_PER_SECOND kite-shaped shards all over the Creature, each FLAME_WIDTH wide
// and FLAME_LENGTH long at most, posed for the fixed camera like the batteries: flat to it, point up
// the screen, rising up it at FLAME_RISE units a second. (The camera looks so steeply down that
// straight up in the world runs almost sideways near the bottom corners and hardly moves on screen.)
// They start hot and step down COLOR_HOT, COLOR_MID, COLOR_LOW, COLOR_DYING as they age, and dissolve
// from DISSOLVE_FROM of their life. A burst of IGNITE_FLAMES marks the moment it catches. Embers:
// EMBERS_PER_SECOND small sparks going higher and living longer, EMBER_DRIFT to either side, and
// SNUFF_EMBERS thrown off as the burn ends, so the moment the Creature can catch again shows too. The
// shards stay where they were born, so a moving Creature trails fire. Ash (the exorcism only; see
// exorcism.ts, which also makes the fire swell and die): grey flakes of COLOR_ASH, ASH_SIZE across,
// lifting off the body at ASH_RISE and drifting ASH_DRIFT to either side for ASH_LIFE seconds.
//
// The light: the fire lights the floors and walls round it (vfx.ts) by FIRE_LIGHT.
export const FIRE = {
  COLOR_HOT: '#fff0a8',
  COLOR_MID: '#ffae2c',
  COLOR_LOW: '#f2541b',
  COLOR_DYING: '#9c1c12',
  COLOR_ASH: '#8f8c88',
  INTENSITY: 1.2,
  FACET_SHADE: 0.74,
  FLAMES_PER_SECOND: 90,
  FLAME_WIDTH: 12,
  FLAME_LENGTH: 25,
  FLAME_LIFE: 0.46,
  FLAME_RISE: 46,
  FLAME_FLUTTER: 0.5,
  BODY_RADIUS: 21,
  FRONT_SHARE: 0.34,
  FRONT_SCALE: 0.72,
  DISSOLVE_FROM: 0.62,
  IGNITE_FLAMES: 22,
  EMBERS_PER_SECOND: 16,
  EMBER_SIZE: 2.4,
  EMBER_LIFE: 1,
  EMBER_RISE: 95,
  EMBER_DRIFT: 26,
  SNUFF_EMBERS: 16,
  ASH_SIZE: 3.5,
  ASH_LIFE: 1.7,
  ASH_RISE: 62,
  ASH_DRIFT: 34,
};

const SPARKLE_CAPACITY = 128;
// Room for a steady burn three times over: the exorcism's swell, and its ash.
const FIRE_CAPACITY = 448;
// World units straight up per unit up the screen, for a camera about 72 degrees down (camera-config.ts).
const UPRIGHT = 3;
// How far forward a front flame draws, in Creature heights: enough to clear the head from the floor.
const FIRE_FRONT_DEPTH = 1.2;

// Drawn with nothing alive once, on the first frame, so its shader is compiled while the scene loads
// rather than in the middle of a round the first time it is needed.
const DEAD = { birth: -1e6, life: 1 };

// What changed between two snapshots' pickup lists. `previous` null means there is nothing to compare
// with (the first snapshot after joining or a map change). A new round starts with an empty map and
// a list emptied that way was not collected, so only a round in play or just ended reports changes.
export function pickupChanges(
  previous: readonly number[] | null, current: readonly number[], roundState: RoundState,
): { spawned: number[]; taken: number[] } {
  if (previous === null || (roundState !== 'running' && roundState !== 'ended')) return { spawned: [], taken: [] };
  return {
    spawned: current.filter((index) => !previous.includes(index)),
    taken: previous.filter((index) => !current.includes(index)),
  };
}

// A ring of `capacity` particles, each four vec4 attributes at most: writing one past the end
// overwrites the oldest. `aliveUntil` is when the last one written dies.
function createPool(geometry: InstancedBufferGeometry, capacity: number, names: readonly string[], lifeAttribute: string) {
  const attributes = new Map(names.map((name) => {
    const array = new Float32Array(capacity * 4);
    const attribute = new InstancedBufferAttribute(array, 4).setUsage(DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
    return [name, attribute] as const;
  }));
  // Every particle starts long dead (see DEAD).
  attributes.get(lifeAttribute)!.array.fill(DEAD.life);
  attributes.get('aStart')!.array.fill(DEAD.birth);
  geometry.instanceCount = capacity;
  let next = 0;
  let dirty = false;
  return {
    attributes,
    aliveUntil: -Infinity,
    // `values` holds each attribute's four numbers. Returns the slot written.
    write(values: Record<string, readonly [number, number, number, number]>, diesAt: number): number {
      const slot = next;
      next = (next + 1) % capacity;
      for (const [name, numbers] of Object.entries(values)) attributes.get(name)!.array.set(numbers, slot * 4);
      this.aliveUntil = Math.max(this.aliveUntil, diesAt);
      dirty = true;
      return slot;
    },
    flush(): void {
      if (!dirty) return;
      for (const attribute of attributes.values()) attribute.needsUpdate = true;
      dirty = false;
    },
  };
}

// One flat star on the camera's plane: a fan of eight triangles round its centre. `aRim` is 0 at a
// tip, on the unit circle, and 1 between two tips, pulled in by the particle's pinch, so one mesh
// draws thin stars and, at a pinch of 0.707, plain diamonds. `aEdge` runs 0 at the centre to 1 on the
// outline, for the white core and the rings.
function starGeometry(): InstancedBufferGeometry {
  const positions: number[] = [];
  const rims: number[] = [];
  const edges: number[] = [];
  const corner = (index: number) => {
    const angle = (index * Math.PI) / 4;
    return [Math.cos(angle), Math.sin(angle), index % 2];
  };
  for (let side = 0; side < 8; side++) {
    const [x1, y1, rim1] = corner(side);
    const [x2, y2, rim2] = corner(side + 1);
    positions.push(0, 0, 0, x1, y1, 0, x2, y2, 0);
    rims.push(0, rim1, rim2);
    edges.push(0, 1, 1);
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aRim', new BufferAttribute(new Float32Array(rims), 1));
  geometry.setAttribute('aEdge', new BufferAttribute(new Float32Array(edges), 1));
  return geometry;
}

// One flame: a faceted kite, split down its long axis so one half can be shaded darker, with a
// smaller hot core in front of it. x runs across (-1..1), y along (0 at the root, 1 at the tip); z is
// 0 for the shell and 1 for the core; `aFacet` is 1 on the darker half.
function flameGeometry(): InstancedBufferGeometry {
  const positions: number[] = [];
  const facets: number[] = [];
  const outline = [[0, -0.08], [0.62, 0.08], [1, 0.34], [0.5, 0.68], [0, 1]];
  const layer = (width: number, length: number, z: number) => {
    for (const side of [-1, 1]) {
      for (let piece = 1; piece < outline.length - 1; piece++) {
        for (const [x, y] of [outline[0], outline[piece], outline[piece + 1]]) {
          positions.push(side * x * width, y * length, z);
          facets.push(side > 0 ? 1 : 0);
        }
      }
    }
  };
  layer(1, 1, 0);
  layer(0.52, 0.6, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aFacet', new BufferAttribute(new Float32Array(facets), 1));
  return geometry;
}

// `facing` is the fixed camera's turn: the bursts are thrown across its plane, so they read round
// however steeply it looks down. `random` is only replaced by the tests.
export function createSparkles(facing: Quaternion, random: () => number = Math.random) {
  const right = new Vector3(1, 0, 0).applyQuaternion(facing);
  const up = new Vector3(0, 1, 0).applyQuaternion(facing);
  const geometry = starGeometry();
  const pool = createPool(geometry, SPARKLE_CAPACITY, ['aStart', 'aMotion', 'aShape', 'aTint'], 'aMotion');
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // Above whatever stands round it: a battery is public, and a burst is over in a moment.
    depthTest: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uDrag: { value: SPARKLE.DRAG },
      uGravity: { value: new Vector3() },
      uIntensity: { value: SPARKLE.INTENSITY },
    },
    vertexShader: /* glsl */ `
attribute float aRim;
attribute float aEdge;
attribute vec4 aStart;  // where it starts, and when
attribute vec4 aMotion; // its velocity, and how long it lives
attribute vec4 aShape;  // size, pinch, ring thickness (0: not a ring), tumble rate
attribute vec4 aTint;   // colour, and a random 0..1
uniform float uTime;
uniform float uDrag;
uniform vec3 uGravity;
varying vec3 vTint;
varying float vEdge;
varying float vInner;
varying float vLife;
const float TAU = 6.2831853;
void main() {
  float age = uTime - aStart.w;
  float life = age / aMotion.w;
  if (life < 0.0 || life >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float travel = (1.0 - exp(-uDrag * age)) / uDrag;
  vec4 view = viewMatrix * vec4(aStart.xyz + aMotion.xyz * travel + uGravity * age * age * 0.5, 1.0);
  float ring = aShape.z;
  float size;
  if (ring > 0.0) {
    // A ring opens fast and settles, thinning as it goes.
    size = aShape.x * (1.0 - (1.0 - life) * (1.0 - life) * (1.0 - life));
    vInner = 1.0 - ring * (1.0 - life);
  } else {
    // Up quickly, down slowly, with a twinkle on the way.
    size = aShape.x * sin(3.14159 * pow(life, 0.55)) * (0.72 + 0.28 * sin(age * 21.0 + aTint.w * TAU));
    vInner = 0.0;
  }
  vec2 shape = position.xy * mix(1.0, aShape.y, aRim) * size;
  // A flake tumbles about its long axis, so it shows narrow and wide in turn.
  if (aShape.w != 0.0) shape.x *= 0.62 * cos(age * aShape.w + aTint.w * TAU);
  float turn = ring > 0.0 ? 0.0 : aTint.w * TAU * step(0.0001, aShape.w) + (aTint.w - 0.5) * 2.0 * age;
  view.xy += vec2(shape.x * cos(turn) - shape.y * sin(turn), shape.x * sin(turn) + shape.y * cos(turn));
  gl_Position = projectionMatrix * view;
  vTint = aTint.rgb;
  vEdge = aEdge;
  vLife = life;
}`,
    fragmentShader: /* glsl */ `
uniform float uIntensity;
varying vec3 vTint;
varying float vEdge;
varying float vInner;
varying float vLife;
${BAYER_GLSL}
void main() {
  if (vEdge < vInner) discard;
  if (vLife > 0.7 && (vLife - 0.7) / 0.3 > vfxBayer4(gl_FragCoord.xy)) discard;
  // A hard white core on a star; a ring is one colour.
  vec3 color = vInner < 0.001 && vEdge < 0.42 ? vec3(1.0) : vTint;
  gl_FragColor = vec4(color * uIntensity, 1.0);
}`,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  const lemon = new Color();
  const white = new Color();
  const powder = new Color();
  const dimmed = new Color();
  const STAR = 0.2;
  const DIAMOND = 0.707;

  function particle(
    at: Vector3, seconds: number, velocity: Vector3, life: number, size: number, pinch: number, ring: number, tumble: number, tint: Color,
    delay = 0,
  ): void {
    const birth = seconds + delay;
    pool.write({
      aStart: [at.x, at.y, at.z, birth],
      aMotion: [velocity.x, velocity.y, velocity.z, life],
      aShape: [size, pinch, ring, tumble],
      aTint: [tint.r, tint.g, tint.b, random()],
    }, birth + life);
  }

  const still = new Vector3();
  const thrown = new Vector3();
  function burst(kind: 'spawn' | 'pickup', at: Vector3, seconds: number): void {
    lemon.set(SPARKLE.COLOR_LEMON);
    white.set(SPARKLE.COLOR_WHITE);
    powder.set(SPARKLE.COLOR_POWDER);
    const pickup = kind === 'pickup';
    particle(at, seconds, still, SPARKLE.FLASH_LIFE, pickup ? SPARKLE.PICKUP_FLASH : SPARKLE.SPAWN_FLASH, STAR, 0, 0, lemon);
    const ringSize = pickup ? SPARKLE.PICKUP_RING : SPARKLE.SPAWN_RING;
    // Dimmer than the stars, so the stars are what the eye follows.
    const ringLemon = dimmed.copy(lemon).multiplyScalar(SPARKLE.RING_BRIGHTNESS);
    particle(at, seconds, still, SPARKLE.RING_LIFE, ringSize, DIAMOND, SPARKLE.RING_THICKNESS, 0, ringLemon);
    if (pickup) {
      const ringPowder = dimmed.copy(powder).multiplyScalar(SPARKLE.RING_BRIGHTNESS);
      particle(at, seconds, still, SPARKLE.RING_LIFE, ringSize * 0.62, DIAMOND, SPARKLE.RING_THICKNESS, 0, ringPowder, SPARKLE.RING_DELAY);
    }
    const glints = pickup ? SPARKLE.PICKUP_GLINTS : SPARKLE.SPAWN_GLINTS;
    const speed = pickup ? SPARKLE.PICKUP_SPEED : SPARKLE.SPAWN_SPEED;
    for (let index = 0; index < glints; index++) {
      // Spread evenly round the circle, then shaken, so a burst never leaves a side empty.
      const angle = ((index + random() * 0.8) / glints) * 2 * Math.PI;
      const pace = speed * (0.45 + 0.55 * random());
      thrown.copy(right).multiplyScalar(Math.cos(angle) * pace).addScaledVector(up, Math.sin(angle) * pace);
      if (!pickup) thrown.addScaledVector(up, SPARKLE.SPAWN_RISE);
      const tint = index % 3 === 0 ? powder : index % 3 === 1 ? white : lemon;
      particle(at, seconds, thrown, SPARKLE.GLINT_LIFE * (0.6 + 0.4 * random()), SPARKLE.GLINT_SIZE * (0.65 + 0.35 * random()), STAR, 0, 0, tint);
    }
    if (!pickup) return;
    for (let index = 0; index < SPARKLE.PICKUP_FLAKES; index++) {
      const angle = random() * 2 * Math.PI;
      const pace = speed * (0.3 + 0.5 * random());
      thrown.copy(right).multiplyScalar(Math.cos(angle) * pace).addScaledVector(up, Math.sin(angle) * pace + speed * 0.14);
      particle(at, seconds, thrown, SPARKLE.FLAKE_LIFE * (0.65 + 0.35 * random()), SPARKLE.FLAKE_SIZE * (0.7 + 0.3 * random()), DIAMOND, 0,
        9 + 8 * random(), index % 2 === 0 ? lemon : powder);
    }
  }

  let drawnOnce = false;
  function update(seconds: number): void {
    material.uniforms.uTime.value = seconds;
    material.uniforms.uDrag.value = Math.max(SPARKLE.DRAG, 1e-3);
    (material.uniforms.uGravity.value as Vector3).copy(up).multiplyScalar(-SPARKLE.GRAVITY);
    material.uniforms.uIntensity.value = SPARKLE.INTENSITY;
    pool.flush();
    mesh.visible = !drawnOnce || seconds < pool.aliveUntil;
    drawnOnce = true;
  }

  return { mesh, burst, update, geometry, material };
}

// `random` is only replaced by the tests.
export function createFire(random: () => number = Math.random) {
  const geometry = flameGeometry();
  const pool = createPool(geometry, FIRE_CAPACITY, ['aStart', 'aMotion', 'aLook'], 'aMotion');
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlutter: { value: FIRE.FLAME_FLUTTER },
      uDissolve: { value: FIRE.DISSOLVE_FROM },
      uFacet: { value: FIRE.FACET_SHADE },
      uHot: { value: new Color() },
      uMid: { value: new Color() },
      uLow: { value: new Color() },
      uDying: { value: new Color() },
      uAsh: { value: new Color() },
    },
    vertexShader: /* glsl */ `
attribute float aFacet;
attribute vec4 aStart;  // where it starts, and when
attribute vec4 aMotion; // its velocity across and up the screen, how far forward it draws, how long it lives
attribute vec4 aLook;   // width, length, starting heat (below 0: ash, which has none), a random 0..1
uniform float uTime;
uniform float uFlutter;
varying float vHeat;
varying float vLife;
varying float vFacet;
void main() {
  float age = uTime - aStart.w;
  float life = age / aMotion.w;
  if (life < 0.0 || life >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 view = viewMatrix * vec4(aStart.xyz, 1.0);
  view.xy += aMotion.xy * age;
  float grow = smoothstep(0.0, 0.2, life);
  float width = aLook.x * grow * (1.0 - life * life);
  float tall = aLook.y * grow * (1.0 - 0.35 * life);
  // The tip flutters; the root stays put.
  float flutter = uFlutter * width * sin(uTime * 13.0 + aLook.w * 40.0) * position.y * position.y;
  view.xy += vec2(position.x * width + flutter, position.y * tall);
  gl_Position = projectionMatrix * view;
  // Its depth is that of a flame truly rising (climbing a unit up the screen takes about UPRIGHT
  // units straight up), so it clears a wall behind the Creature that its path up the screen crosses.
  // A front flame is that much further forward, and a core in front of its own shell. Only the depth
  // test sees this: moved in view, it would drift outward with the camera's perspective.
  view.z += aMotion.z + position.z * 0.5 + aMotion.y * age * ${UPRIGHT.toFixed(2)};
  vec4 depth = projectionMatrix * view;
  gl_Position.z = (depth.z / depth.w) * gl_Position.w;
  vHeat = aLook.z < 0.0 ? -1.0 : (aLook.z + position.z * 0.35) * (1.0 - life);
  vLife = life;
  vFacet = aFacet;
}`,
    fragmentShader: /* glsl */ `
uniform float uDissolve;
uniform float uFacet;
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uLow;
uniform vec3 uDying;
uniform vec3 uAsh;
varying float vHeat;
varying float vLife;
varying float vFacet;
${BAYER_GLSL}
void main() {
  float threshold = vfxBayer4(gl_FragCoord.xy);
  if (vLife > uDissolve && (vLife - uDissolve) / (1.0 - uDissolve) > threshold) discard;
  // Hard colour bands, dithered where they meet like the shading on the bodies.
  float band = vHeat * 3.0 + (threshold - 0.5) * 0.3;
  vec3 color = vHeat < -0.5 ? uAsh : band > 2.0 ? uHot : band > 1.15 ? uMid : band > 0.45 ? uLow : uDying;
  gl_FragColor = vec4(color * mix(1.0, uFacet, vFacet), 1.0);
}`,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  function flame(floor: Position3, height: number, seconds: number, surge: Readonly<FireSurge>): void {
    const along = random() ** 1.3;
    const angle = random() * 2 * Math.PI;
    const radius = FIRE.BODY_RADIUS * (1 - 0.3 * along) * Math.sqrt(random());
    // Some lick up in front of the body, smaller so its shape still shows; the rest stand behind it.
    const front = random() < FIRE.FRONT_SHARE * surge.front;
    const scale = surge.size * (0.6 + 0.4 * random()) * (1 - 0.35 * along) * (front ? FIRE.FRONT_SCALE : 1);
    const life = FIRE.FLAME_LIFE * (0.7 + 0.3 * random());
    pool.write({
      aStart: [floor.x + Math.cos(angle) * radius, floor.y + along * height, floor.z + Math.sin(angle) * radius, seconds],
      aMotion: [0, FIRE.FLAME_RISE * surge.size * (0.75 + 0.25 * random()), front ? height * FIRE_FRONT_DEPTH : 0, life],
      aLook: [FIRE.FLAME_WIDTH * scale, FIRE.FLAME_LENGTH * scale, 0.5 + 0.16 * random(), random()],
    }, seconds + life);
  }

  function ember(floor: Position3, height: number, seconds: number): void {
    const angle = random() * 2 * Math.PI;
    const radius = FIRE.BODY_RADIUS * random();
    const life = FIRE.EMBER_LIFE * (0.55 + 0.45 * random());
    const size = FIRE.EMBER_SIZE * (0.7 + 0.3 * random());
    pool.write({
      aStart: [floor.x + Math.cos(angle) * radius, floor.y + random() * height, floor.z + Math.sin(angle) * radius, seconds],
      aMotion: [(random() - 0.5) * 2 * FIRE.EMBER_DRIFT, FIRE.EMBER_RISE * (0.7 + 0.3 * random()), 0, life],
      // An ember keeps its shape: as wide as it is long, and hot for longer than a flame.
      aLook: [size, size * 2, 1.15, random()],
    }, seconds + life);
  }

  // A flake of ash off the body, drawn in front of it.
  function ash(floor: Position3, height: number, seconds: number): void {
    const angle = random() * 2 * Math.PI;
    const radius = FIRE.BODY_RADIUS * Math.sqrt(random());
    const life = FIRE.ASH_LIFE * (0.6 + 0.4 * random());
    const size = FIRE.ASH_SIZE * (0.6 + 0.4 * random());
    pool.write({
      aStart: [floor.x + Math.cos(angle) * radius, floor.y + random() * height, floor.z + Math.sin(angle) * radius, seconds],
      aMotion: [(random() - 0.5) * 2 * FIRE.ASH_DRIFT, FIRE.ASH_RISE * (0.6 + 0.4 * random()), height * FIRE_FRONT_DEPTH, life],
      aLook: [size, size * 1.4, -1, random()],
    }, seconds + life);
  }

  let burning = false;
  let lastRate = 0;
  let flameDebt = 0;
  let emberDebt = 0;
  let ashDebt = 0;
  let drawnOnce = false;
  const lastFloor: Position3 = { x: 0, y: 0, z: 0 };
  let lastHeight = 0;

  // Once a frame. `floor` is the point on the floor under the Creature and `height` how tall it stands,
  // or null with `burning` false once it has gone. Burning makes flames; the fire already made burns
  // out where it is, wherever the Creature has got to. `surge` is the exorcism's (exorcism.ts).
  function update(
    seconds: number, deltaSeconds: number, isBurning: boolean, floor: Position3 | null, height: number, surge: Readonly<FireSurge> = STEADY_FIRE,
  ): void {
    const uniforms = material.uniforms;
    uniforms.uTime.value = seconds;
    uniforms.uFlutter.value = FIRE.FLAME_FLUTTER;
    uniforms.uDissolve.value = Math.min(FIRE.DISSOLVE_FROM, 0.999);
    uniforms.uFacet.value = FIRE.FACET_SHADE;
    (uniforms.uHot.value as Color).set(FIRE.COLOR_HOT).multiplyScalar(FIRE.INTENSITY);
    (uniforms.uMid.value as Color).set(FIRE.COLOR_MID).multiplyScalar(FIRE.INTENSITY);
    (uniforms.uLow.value as Color).set(FIRE.COLOR_LOW).multiplyScalar(FIRE.INTENSITY);
    (uniforms.uDying.value as Color).set(FIRE.COLOR_DYING).multiplyScalar(FIRE.INTENSITY);
    (uniforms.uAsh.value as Color).set(FIRE.COLOR_ASH);

    const lit = isBurning && floor !== null;
    if (lit) {
      Object.assign(lastFloor, floor);
      lastHeight = height;
      if (!burning) for (let index = 0; index < FIRE.IGNITE_FLAMES; index++) flame(floor, height, seconds, surge);
      flameDebt += FIRE.FLAMES_PER_SECOND * surge.rate * deltaSeconds;
      emberDebt += FIRE.EMBERS_PER_SECOND * surge.rate * deltaSeconds;
      ashDebt += surge.ash * deltaSeconds;
      for (; flameDebt >= 1; flameDebt -= 1) flame(floor, height, seconds, surge);
      for (; emberDebt >= 1; emberDebt -= 1) ember(floor, height, seconds);
      for (; ashDebt >= 1; ashDebt -= 1) ash(floor, height, seconds);
    } else if (burning) {
      // A fire that has already died down, as the exorcism's has, ends without a puff.
      if (lastRate > 0) for (let index = 0; index < FIRE.SNUFF_EMBERS; index++) ember(lastFloor, lastHeight, seconds);
      flameDebt = emberDebt = ashDebt = 0;
    }
    burning = lit;
    lastRate = lit ? surge.rate : 0;
    pool.flush();
    mesh.visible = !drawnOnce || seconds < pool.aliveUntil;
    drawnOnce = true;
  }

  return { mesh, update, geometry, material };
}

type Position3 = { x: number; y: number; z: number };
