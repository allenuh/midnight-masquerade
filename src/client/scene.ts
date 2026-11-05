import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NearestMipmapNearestFilter,
  NoColorSpace,
  Object3D,
  PerspectiveCamera,
  Points,
  RingGeometry,
  Scene,
  type ShaderMaterial,
  SphereGeometry,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneModel } from 'three/examples/jsm/utils/SkeletonUtils.js';
import batteryModelUrl from './assets/battery.glb?url';
import batteryGlowUrl from './assets/battery_glow.png?url';
import creatureModelUrl from './assets/creature.glb?url';
import hunterModelUrl from './assets/hunter.glb?url';
import { flashlightRange } from '../shared/flashlight.js';
import type { Tuning } from '../shared/tuning.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import { lightOccluders, type World } from '../shared/map/world.js';
import type { HunterId, Position, ServerMessage } from '../shared/protocol.js';
import { wallDistance } from '../shared/raycast.js';
import { cameraFor } from './camera-config.js';
import { createFear, hunterFear, previewInput } from './fear.js';
import { createFire, createSparkles, pickupChanges } from './particles.js';
import { createPost } from './post.js';
import { buildProps, type PropModels } from './props.js';
import { buildSurfaceMeshes, setPixelTextures, type SurfaceTextures } from './surface-meshes.js';
import {
  BATTERY_LIGHT, BATTERY_LIGHT_REACH, BATTERY_LIGHT_RAYS, BATTERY_LIGHT_UNIFORMS, BATTERY_SPAWN, FIRE_LIGHT, FIRE_LIGHT_RAYS, FIRE_LIGHT_REACH,
  FIRE_LIGHT_UNIFORMS, FLASHLIGHT, MAX_BATTERY_LIGHTS, OUTLINE_MATERIAL, POOL_RAYS, POOL_UNIFORMS, SHADING, VFX, VFX_UNIFORMS, BATTERY_BODY_UNIFORMS, MOTE_COUNT, MOTE_PIXELS,
  batteryChargeFlash, batterySpawnPose, createBatteryMaterial, createBeamMaterial, createBlobShadowMaterial, createGlowMaterial,
  createHaloMaterial, createMoteMaterial, createOutlineMaterial, ditheredBody, syncVfxUniforms,
} from './vfx.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
// Rays across the cone for the drawn flashlight fan. Purely visual resolution.
const FAN_RAYS = 32;
// The Hunter model is scaled to this height: 1.8x the collision sphere's diameter, so it
// reads clearly from the camera. Presentation only; collision still uses playerRadius.
// Walk fades in and out over WALK_FADE_SECONDS; at zero weight the model is in its rest
// pose, which is the idle.
const HUNTER_HEIGHT = 1.8 * 2 * GAMEPLAY.playerRadius;
const WALK_FADE_SECONDS = 0.15;
// The Creature model is scaled to this height (2.4x the collision sphere's diameter, towering
// over a Hunter) and hovers with its lowest point CREATURE_HOVER above the floor.
// Presentation only, like the Hunter's.
const CREATURE_HEIGHT = 2.4 * 2 * GAMEPLAY.playerRadius;
const CREATURE_HOVER = 3;
// How the players look and move, read every frame (the debug menu edits them live):
// - Flat Hunter colours: SELF_COLOR for the viewer's own Hunter, TEAMMATE_COLOR for every other,
//   DOWN_COLOR for a downed one.
// - WALK_RATE_SPEED: the Hunter speed (units/s) at which Walk plays at its authored rate.
//   Playback scales with the room's tuned hunterSpeed, so a speed of 60 plays it at about 1.56x.
//   Lower this for a faster walk.
// - The Creature's Float always plays: at its authored rate while still, FLOAT_RATE_MOVING while
//   moving, FLOAT_RATE_SPRINT while sprinting, easing between rates over FLOAT_RATE_EASE seconds.
// - The server's Creature facing jumps straight to the held direction, so the model eases round
//   to it at CREATURE_TURN_SPEED (radians per second), and leans CREATURE_LEAN radians into its
//   travel while moving, CREATURE_SPRINT_LEAN while sprinting.
// - The emissive multiplier (r, g, b) on the Creature's texture: CREATURE_TINT, its own colours,
//   and CREATURE_BURNING_TINT, the ember glow it takes while burning (unable to tag). Components
//   above 1 brighten it; the charcoal robe needs a strong red to glow.
// - Blob shadow radii: under a Hunter and under the hovering Creature. A downed Hunter's
//   stretches along its body.
// - LENS_GLOW_RADIUS: the soft glow drawn at the flashlight's lens.
// - On a Hunter's screen the Creature dissolves in (an ordered dither, vfx.ts) over
//   CREATURE_FADE_IN_SECONDS when it is revealed, and out over the last CREATURE_FADE_OUT_SECONDS
//   of the server's reveal linger, still following it, so it is gone the moment the server stops
//   sending it. The fade-out can be no longer than the room's linger (visibilityLingerSeconds).
export const CHARACTERS = {
  SELF_COLOR: '#dddfdb',
  TEAMMATE_COLOR: '#8fa3b8',
  DOWN_COLOR: '#563a3a',
  WALK_RATE_SPEED: 38.5,
  FLOAT_RATE_MOVING: 1.6,
  FLOAT_RATE_SPRINT: 2.4,
  FLOAT_RATE_EASE: 0.25,
  CREATURE_TURN_SPEED: 7,
  CREATURE_LEAN: 0.08,
  CREATURE_SPRINT_LEAN: 0.14,
  CREATURE_TINT: [1, 1, 1],
  CREATURE_BURNING_TINT: [7.3, 3.3, 1],
  HUNTER_SHADOW_RADIUS: 14.5,
  CREATURE_SHADOW_RADIUS: 1.6 * GAMEPLAY.playerRadius,
  LENS_GLOW_RADIUS: 5,
  CREATURE_FADE_IN_SECONDS: 0.2,
  CREATURE_FADE_OUT_SECONDS: 0.5,
};
// Battery pickup: battery.glb scaled to BATTERY_HEIGHT and posed for the fixed camera. It is
// tipped back until its face (the label) looks at the camera, short of square-on by
// BATTERY_TOP_SHOW so a sliver of its cap shows, then leaned BATTERY_LEAN on screen, right
// and left on alternate spawn points. Its lowest point rests BATTERY_HOVER above the floor.
// It is lit by a key from its own glow (vfx.ts), from a point BATTERY_KEY_FRONT in front of
// its middle (toward the camera) and BATTERY_KEY_UP above it on screen, in battery heights.
const BATTERY_HEIGHT = 28;
const BATTERY_TOP_SHOW = 15 * (Math.PI / 180);
const BATTERY_LEAN = 30 * (Math.PI / 180);
const BATTERY_HOVER = 1;
const BATTERY_KEY_FRONT = 0.7;
const BATTERY_KEY_UP = 0.35;
// Battery glow (VFX.batteryGlow), read every frame: the halo's radius, and its pulse, shared by
// every battery and its light: brightness swings between 1 - BATTERY_PULSE_DEPTH and 1,
// BATTERY_PULSE_RATE times a second, and flashes up by BATTERY_CHARGE_FLASH as each charge reaches
// the cap (vfx.ts). BATTERY_SHADOW_RADIUS is the blob shadow under each battery.
export const BATTERY_LOOK = {
  BATTERY_HALO_RADIUS: 1.1 * BATTERY_HEIGHT,
  BATTERY_PULSE_DEPTH: 0.12,
  BATTERY_PULSE_RATE: 0.35,
  BATTERY_CHARGE_FLASH: 0,
  BATTERY_SHADOW_RADIUS: 11,
};
// Draw order among the opaque meshes: a battery's halo after everything else at the default
// order 0, then the battery, so the battery covers the halo's middle, then its motes, which
// the battery hides when they pass behind it.
const HALO_RENDER_ORDER = 1;
const BATTERY_RENDER_ORDER = 2;
const MOTE_RENDER_ORDER = 3;
// Night: a dim, cool moonlight over the mansion, so the flashlights are what light it. The sky
// and ground colours of the hemisphere light and its intensity, the directional light's colour,
// intensity and position (MOON_X, MOON_Y, MOON_Z: only its direction matters), and the background
// beyond the map. The bodies of the Hunters and the Creature are unlit, so they stay readable in
// the dark, though the moon's direction shades them (VFX.ditherShading); the batteries are lit by
// their own glow. Read every frame.
export const NIGHT = {
  AMBIENT_SKY: '#1437c5',
  AMBIENT_GROUND: '#27244d',
  AMBIENT_INTENSITY: 0.69,
  MOONLIGHT_COLOR: '#b1c2fc',
  MOONLIGHT_INTENSITY: 0.45,
  MOON_X: -300,
  MOON_Y: 900,
  MOON_Z: 500,
  BACKGROUND_COLOR: '#0c0d10',
};
// Debugging views, read every frame: RENDER_SCALE multiplies the canvas's pixel ratio (below 1
// renders fewer pixels, stretched up); SHOW_PROPS and SHOW_SURFACES hide the furniture and the
// floors and walls.
export const VIEW = { RENDER_SCALE: 1, SHOW_PROPS: true, SHOW_SURFACES: true };
// The catch cutscene (snapshot.catch; the round is paused for the room's catchSeconds), read
// every frame. The fixed camera dollies in on the pair, keeping its angle (the halos are posed
// to it), to ZOOM times its usual distance, over ZOOM_IN_SECONDS, and back out over the last
// ZOOM_OUT_SECONDS. The Creature plays Grab, stretched over the cutscene; LUNGE_FROM..LUNGE_TO
// and RELEASE_FROM are where its lunge and release fall in that clip (as shares of it, from
// art/animate_creature_grab.py), and it slides in over the lunge until its centre is
// GRAB_DISTANCE from the Hunter's, and back over the release. The caught Hunter stands while it
// is held, struggling by up to STRUGGLE units, and falls onto its back over the last
// FALL_SECONDS. Fear effects ease out while it plays.
export const CATCH = {
  ZOOM: 0.4,
  ZOOM_IN_SECONDS: 0.35,
  ZOOM_OUT_SECONDS: 0.4,
  LUNGE_FROM: 0.19,
  LUNGE_TO: 0.29,
  RELEASE_FROM: 0.79,
  GRAB_DISTANCE: 25,
  STRUGGLE: 0.8,
  FALL_SECONDS: 0.35,
};
// Blob shadows sit this far above the floor, under the flat flashlight fan.
const SHADOW_LIFT = 0.5;
// A battery's own long axis, cap up, which its entrance turns it about with WORLD_AXIS off.
const LOCAL_UP = new Vector3(0, 1, 0);

// The Hunter model and its Walk clip, loaded once per page and cloned for every Hunter.
// `scale` fits it to HUNTER_HEIGHT; `backDepth` is how far its back sticks out behind the
// feet after scaling, which is how high a downed Hunter lying on its back must be lifted.
// `bodyMaterial` is the emissive white body ('Material' in the file), tinted per Hunter.
// `lens` is the front of the model's flashlight in the Hunter group's space (facing +X,
// origin at the collision sphere's centre): where the drawn beam starts.
export type HunterModel = {
  scene: Object3D; walk: AnimationClip; bodyMaterial: MeshStandardMaterial; scale: number; backDepth: number;
  lens: Vector3;
};

export async function loadHunterModel(): Promise<HunterModel> {
  const gltf = await new GLTFLoader().loadAsync(hunterModelUrl);
  const walk = AnimationClip.findByName(gltf.animations, 'Walk');
  if (!walk) throw new Error('hunter.glb has no Walk animation');
  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  const bodyMaterial = meshes.map((mesh) => mesh.material as unknown).find((material): material is MeshStandardMaterial =>
    material instanceof MeshStandardMaterial && material.name === 'Material');
  if (!bodyMaterial) throw new Error('hunter.glb has no body material');
  const bounds = new Box3().setFromObject(gltf.scene);
  const scale = HUNTER_HEIGHT / (bounds.max.y - bounds.min.y);
  // The flashlight ('Cylinder' in the file) points along the model's +Z, so its lens is the
  // front of its bounds. The model faces +Z and the Hunter group +X, hence the axis swap.
  const flashlight = gltf.scene.getObjectByName('Cylinder');
  const lensBounds = new Box3().setFromObject(flashlight ?? gltf.scene);
  const lensCenter = lensBounds.getCenter(new Vector3());
  const lens = new Vector3(lensBounds.max.z * scale, -GAMEPLAY.playerRadius + lensCenter.y * scale, -lensCenter.x * scale);
  addOutlineHulls(meshes);
  return { scene: gltf.scene, walk, bodyMaterial, scale, backDepth: -bounds.min.z * scale, lens };
}

// The Creature model and its clips, loaded once per page and cloned each time the Creature
// appears: Float, always playing, and Grab, the catch cutscene (art/animate_creature_grab.py).
// `material` is its one textured emissive material ('Creature' in the file), tinted
// while burning. `scale` fits it to CREATURE_HEIGHT; `lift` raises it so its lowest point
// hovers CREATURE_HOVER above the floor. Like the Hunter, it faces +Z in the file.
export type CreatureModel = {
  scene: Object3D; float: AnimationClip; grab: AnimationClip; material: MeshStandardMaterial; scale: number; lift: number;
};

export async function loadCreatureModel(): Promise<CreatureModel> {
  const gltf = await new GLTFLoader().loadAsync(creatureModelUrl);
  const float = AnimationClip.findByName(gltf.animations, 'Float');
  if (!float) throw new Error('creature.glb has no Float animation');
  const grab = AnimationClip.findByName(gltf.animations, 'Grab');
  if (!grab) throw new Error('creature.glb has no Grab animation');
  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  const material = meshes.map((mesh) => mesh.material as unknown).find((candidate): candidate is MeshStandardMaterial =>
    candidate instanceof MeshStandardMaterial && candidate.name === 'Creature');
  if (!material) throw new Error('creature.glb has no Creature material');
  const bounds = new Box3().setFromObject(gltf.scene);
  const scale = CREATURE_HEIGHT / (bounds.max.y - bounds.min.y);
  addOutlineHulls(meshes);
  return { scene: gltf.scene, float, grab, material, scale, lift: CREATURE_HOVER - bounds.min.y * scale };
}

// The battery pickup model, loaded once per page and cloned per spawn point. `map` is its
// texture (the emissive map in the file) and `glow` its glow mask (battery_glow.png, same
// layout), which each battery's own lit material (vfx.ts) draws with; it has no outline,
// unlike the players. `scale` fits it to BATTERY_HEIGHT; `center` is
// its middle in the file, the point it is posed around. Like the players, it faces +Z in the
// file, cap up.
export type BatteryModel = { scene: Object3D; map: Texture; glow: Texture; scale: number; center: Vector3 };

export async function loadBatteryModel(): Promise<BatteryModel> {
  const [gltf, glow] = await Promise.all([
    new GLTFLoader().loadAsync(batteryModelUrl), new TextureLoader().loadAsync(batteryGlowUrl),
  ]);
  // Sampled like the glb's own texture: glTF's v runs down the image, unfiltered texels.
  glow.flipY = false;
  glow.colorSpace = NoColorSpace;
  glow.magFilter = NearestFilter;
  glow.minFilter = NearestMipmapNearestFilter;
  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  const material = meshes[0]?.material;
  if (!(material instanceof MeshStandardMaterial) || !material.emissiveMap) throw new Error('battery.glb has no battery mesh');
  const bounds = new Box3().setFromObject(gltf.scene);
  return {
    scene: gltf.scene, map: material.emissiveMap, glow, scale: BATTERY_HEIGHT / (bounds.max.y - bounds.min.y),
    center: bounds.getCenter(new Vector3()),
  };
}

// Gives each model part an outline hull (vfx.ts) drawn with OUTLINE_MATERIAL. Call after the
// model's world matrices are current (computing its bounds does that).
function addOutlineHulls(meshes: Mesh[]): void {
  for (const mesh of meshes) {
    // Outline hull for this part, a child so it follows the animation. Its vertices are
    // welded and given smooth normals so the pushed-out hull does not split at hard edges.
    const hull = new BufferGeometry().setAttribute('position', mesh.geometry.getAttribute('position'));
    hull.setIndex(mesh.geometry.getIndex());
    const outlineGeometry = mergeVertices(hull);
    // Mirrored parts (negative scale: the feet and the flashlight) are wound the other way
    // round. Left as is, their hull's normals point inward and its faces cull the wrong way,
    // so the outline vanishes; reversing every triangle fixes both.
    const index = outlineGeometry.getIndex();
    if (index && mesh.matrixWorld.determinant() < 0) {
      for (let corner = 0; corner < index.count; corner += 3) {
        const second = index.getX(corner + 1);
        index.setX(corner + 1, index.getX(corner + 2));
        index.setX(corner + 2, second);
      }
    }
    outlineGeometry.computeVertexNormals();
    mesh.add(new Mesh(outlineGeometry, OUTLINE_MATERIAL));
  }
}

// An angle wrapped into -pi..pi.
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// One scene per map: the world the room plays on is fixed for the scene's lifetime, and a
// map change disposes it and builds another (see main.ts). `renderer` may be handed over
// from the previous scene so a map switch never creates a second WebGL context.
export function createScene(
  canvas: HTMLCanvasElement, world: World, hunterModel: HunterModel, creatureModel: CreatureModel,
  batteryModel: BatteryModel, surfaceTextures: SurfaceTextures, propModels: PropModels, existingRenderer?: WebGLRenderer,
) {
  const renderer = existingRenderer ?? new WebGLRenderer({ canvas, antialias: true });
  // The canvas's pixel ratio, scaled by VIEW.RENDER_SCALE; render() re-applies it when that changes.
  let renderScale = VIEW.RENDER_SCALE;
  const pixelRatio = () => Math.min(window.devicePixelRatio, 2) * renderScale;
  renderer.setPixelRatio(pixelRatio());
  const scene = new Scene();
  const background = new Color(NIGHT.BACKGROUND_COLOR);
  scene.background = background;

  const CAMERA = cameraFor(world);
  const camera = new PerspectiveCamera(CAMERA.fieldOfView, CAMERA.aspect, CAMERA.near, CAMERA.far);
  camera.position.set(CAMERA.position.x, CAMERA.position.y, CAMERA.position.z);
  // Target determines the fixed rotation; no client movement or input controls this camera. Only
  // the catch cutscene moves it, along its own view (see CATCH), from and back to this place.
  camera.lookAt(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z);
  const cameraHome = camera.position.clone();
  const cameraAim = new Vector3(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z);

  // Bloom, the night grade and a Hunter's fear effects (post.ts) between the rendered scene and
  // the canvas. The fear animator (fear.ts) eases the effects and keeps the heartbeat.
  const post = createPost(renderer, scene, camera);
  const fear = createFear();
  const startTime = performance.now();

  // Floor and walls come from the room's map, tile by tile with each tile's floor and
  // wallpaper. They cover exactly the tiles the server's collision and line-of-sight boxes
  // are built from, so what is drawn is what the server simulates.
  const surfaces = buildSurfaceMeshes(world, surfaceTextures);
  scene.add(surfaces.group);
  // The furniture and clutter standing on the floor, and the candles on the walls (props.ts).
  const props = buildProps(world, propModels, camera.quaternion);
  scene.add(props.group);

  const ambient = new HemisphereLight();
  const light = new DirectionalLight();
  scene.add(ambient, light);
  camera.updateMatrixWorld();
  // The night's lights from NIGHT, every frame. The batteries' own lighting follows them, and the
  // Hunter's dithered shading uses the moon's direction, in the fixed camera's view space.
  function syncNight(): void {
    background.set(NIGHT.BACKGROUND_COLOR);
    ambient.color.set(NIGHT.AMBIENT_SKY);
    ambient.groundColor.set(NIGHT.AMBIENT_GROUND);
    ambient.intensity = NIGHT.AMBIENT_INTENSITY;
    light.color.set(NIGHT.MOONLIGHT_COLOR);
    light.intensity = NIGHT.MOONLIGHT_INTENSITY;
    light.position.set(NIGHT.MOON_X, NIGHT.MOON_Y, NIGHT.MOON_Z);
    BATTERY_BODY_UNIFORMS.batteryAmbientSky.value.copy(ambient.color).multiplyScalar(NIGHT.AMBIENT_INTENSITY);
    BATTERY_BODY_UNIFORMS.batteryAmbientGround.value.copy(ambient.groundColor).multiplyScalar(NIGHT.AMBIENT_INTENSITY);
    BATTERY_BODY_UNIFORMS.batteryMoonColor.value.copy(light.color).multiplyScalar(NIGHT.MOONLIGHT_INTENSITY);
    BATTERY_BODY_UNIFORMS.batteryMoonDirection.value.copy(light.position).normalize();
    VFX_UNIFORMS.vfxLightDirection.value.copy(light.position).normalize().transformDirection(camera.matrixWorldInverse);
  }
  syncNight();

  // Blob shadows (VFX.blobShadows): one flat unit circle, scaled per use. The Creature's is its
  // own fainter material.
  const shadowGeometry = new CircleGeometry(1, 32).rotateX(-Math.PI / 2);
  const shadowMaterial = createBlobShadowMaterial();
  const creatureShadowMaterial = createBlobShadowMaterial(true);
  function blobShadow(radius: number, material = shadowMaterial): Mesh {
    const shadow = new Mesh(shadowGeometry, material);
    shadow.scale.set(radius, 1, radius);
    return shadow;
  }

  // Battery pickups: one battery per Battery Spawn marker the map declares, shown while the
  // server lists that point as active. Both roles see the same set, in the same order the
  // server uses, so a pickup index means the same thing on every client. Each has a halo, rising
  // motes and (the first MAX_BATTERY_LIGHTS) a light slot (vfx.ts), whose wall reaches are
  // measured once here, out to the largest radius the light may be given: the batteries never
  // move. The halo is a unit disc, scaled to BATTERY_HALO_RADIUS every frame.
  const haloGeometry = new CircleGeometry(1, 32);
  const haloMaterial = createHaloMaterial();
  const moteGeometry = new BufferGeometry();
  moteGeometry.setAttribute('position', new BufferAttribute(new Float32Array(3 * MOTE_COUNT), 3));
  moteGeometry.setAttribute('seed', new BufferAttribute(Float32Array.from({ length: 2 * MOTE_COUNT }, (_, i) =>
    i % 2 === 0 ? Math.random() * 2 * Math.PI : Math.floor(i / 2) / MOTE_COUNT), 2));
  const moteMaterial = createMoteMaterial(MOTE_PIXELS * renderer.getPixelRatio(), BATTERY_HEIGHT);
  const lightReaches = BATTERY_LIGHT_UNIFORMS.batteryLightReach.value;
  const reachData = lightReaches.image.data as Float32Array;
  // Slots left over from the previous map's batteries go dark.
  for (const light of BATTERY_LIGHT_UNIFORMS.batteryLights.value) light.set(0, 0, 0, 0);
  const pickups = world.batterySpawns.map(({ x, z }, index) => {
    const model = batteryModel.scene.clone();
    model.scale.setScalar(batteryModel.scale);
    model.position.copy(batteryModel.center).multiplyScalar(-batteryModel.scale);
    model.traverse((object) => {
      object.renderOrder = BATTERY_RENDER_ORDER;
    });
    // `pose` turns and leans the battery about its middle: turned like the camera, so its face is
    // parallel to the screen with the cap up, then leaned about the line of sight, then the cap
    // tipped toward the camera. Every battery leans the same on screen wherever it stands. `spin`,
    // inside it, carries the entrance's growth and turn (batterySpawnPose), also about its middle.
    const spin = new Group().add(model);
    const pose = new Group().add(spin);
    pose.position.set(x, world.floorY, z);
    pose.quaternion.copy(camera.quaternion);
    pose.rotateZ((index % 2 === 0 ? -1 : 1) * BATTERY_LEAN);
    pose.rotateX(BATTERY_TOP_SHOW);
    pose.updateMatrixWorld(true);
    pose.position.y += world.floorY + BATTERY_HOVER - new Box3().setFromObject(pose, true).min.y;
    const keyPosition = new Vector3().subVectors(camera.position, pose.position).normalize()
      .multiplyScalar(BATTERY_KEY_FRONT * BATTERY_HEIGHT)
      .addScaledVector(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion), BATTERY_KEY_UP * BATTERY_HEIGHT)
      .add(pose.position);
    const material = createBatteryMaterial(batteryModel.map, batteryModel.glow, keyPosition);
    model.traverse((object) => {
      if (object instanceof Mesh) object.material = material;
    });
    pose.visible = false;
    scene.add(pose);
    const shadow = blobShadow(BATTERY_LOOK.BATTERY_SHADOW_RADIUS);
    shadow.position.set(x, world.floorY + SHADOW_LIFT, z);
    scene.add(shadow);
    const halo = new Mesh(haloGeometry, haloMaterial);
    halo.position.copy(pose.position);
    halo.quaternion.copy(camera.quaternion);
    halo.renderOrder = HALO_RENDER_ORDER;
    halo.visible = false;
    scene.add(halo);
    const motes = new Points(moteGeometry, moteMaterial);
    motes.position.copy(pose.position);
    motes.renderOrder = MOTE_RENDER_ORDER;
    motes.frustumCulled = false;
    motes.visible = false;
    scene.add(motes);
    if (index < MAX_BATTERY_LIGHTS) {
      BATTERY_LIGHT_UNIFORMS.batteryLights.value[index].set(x, z, 0, 0);
      BATTERY_LIGHT_UNIFORMS.batteryLightY.value = pose.position.y;
      const origin = { x, y: pose.position.y, z };
      for (let ray = 0; ray < BATTERY_LIGHT_RAYS; ray++) {
        const angle = (2 * Math.PI * ray) / BATTERY_LIGHT_RAYS;
        const direction = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
        reachData[index * BATTERY_LIGHT_RAYS + ray] =
          wallDistance(origin, direction, BATTERY_LIGHT_REACH, world.wallBoxes);
      }
    }
    // The world's upright as `spin` sees it, and when this battery's entrance began (null: none playing).
    const worldUp = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion.clone().invert());
    return { pose, spin, worldUp, spawnedAt: null as number | null, shadow, halo, motes };
  });
  lightReaches.needsUpdate = true;

  // The sparkle as a battery appears or is collected, the burning Creature's flames (particles.ts)
  // and their light. `lastPickups` is the pickup list last seen; `fireGlow` is the light's 0..1.
  const sparkles = createSparkles(camera.quaternion);
  const fire = createFire();
  scene.add(sparkles.mesh, fire.mesh);
  let lastPickups: readonly number[] | null = null;
  let fireGlow = 0;
  const fireOccluders = lightOccluders(world);
  const fireReaches = FIRE_LIGHT_UNIFORMS.fireLightReach.value;
  const fireReachData = fireReaches.image.data as Float32Array;
  FIRE_LIGHT_UNIFORMS.fireLight.value.set(0, 0, 0, 0);
  const fireFloor = { x: 0, y: 0, z: 0 };

  // The light follows `fireFloor` while it glows, cut at the walls and the tall props like a candle's.
  function updateFireLight(seconds: number, deltaSeconds: number, burning: boolean): void {
    const step = deltaSeconds / Math.max(burning ? FIRE_LIGHT.FIRE_LIGHT_UP : FIRE_LIGHT.FIRE_LIGHT_DOWN, 1e-3);
    fireGlow = Math.min(1, Math.max(0, fireGlow + (burning ? step : -step)));
    const light = FIRE_LIGHT_UNIFORMS.fireLight.value;
    if (fireGlow === 0) {
      light.w = 0;
      return;
    }
    const origin = {
      x: fireFloor.x, z: fireFloor.z, y: Math.min(fireFloor.y + FIRE_LIGHT.FIRE_LIGHT_HEIGHT, world.floorY + world.wallHeight - 1),
    };
    for (let ray = 0; ray < FIRE_LIGHT_RAYS; ray++) {
      const angle = (2 * Math.PI * ray) / FIRE_LIGHT_RAYS;
      fireReachData[ray] = wallDistance(origin, { x: Math.cos(angle), y: 0, z: Math.sin(angle) }, FIRE_LIGHT_REACH, fireOccluders);
    }
    fireReaches.needsUpdate = true;
    const wave = (Math.sin(seconds * 11.3) + Math.sin(seconds * 23.7 + 1.1) + Math.sin(seconds * 6.1 + 2.3)) / 3;
    light.set(origin.x, origin.y, origin.z, fireGlow * (1 + FIRE_LIGHT.FIRE_LIGHT_FLICKER * wave));
  }

  // Flashlight effects (vfx.ts), shared by every Hunter. The beam is a unit cone with its tip
  // at the origin opening along +X, scaled each frame to the light's range and width. The lens
  // glow is a unit sphere, scaled to LENS_GLOW_RADIUS each frame.
  const beamGeometry = new ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0).rotateZ(Math.PI / 2);
  const glowGeometry = new SphereGeometry(1, 16, 12);

  // Hunter: the hunter.glb model plus a flashlight fan of its own. The group sits at the
  // server's position (the collision sphere's center) and is rotated to its facing, which
  // points along local +X. Inside it, `pose` is at the feet: it tips over when the Hunter
  // is down. One set per Hunter slot, created on demand.
  type HunterMesh = {
    group: Group; pose: Group; material: MeshStandardMaterial;
    mixer: AnimationMixer; walk: AnimationAction; walkWeight: number; moving: boolean; lastPosition: Position | null;
    fan: Mesh; fanMaterial: MeshBasicMaterial; fanPositions: Float32Array; fanGeometry: BufferGeometry;
    beam: Mesh; beamMaterial: ShaderMaterial; glow: Mesh; shadow: Mesh;
  };
  const hunters = new Map<HunterId, HunterMesh>();

  function ensureHunter(id: HunterId): HunterMesh {
    const existing = hunters.get(id);
    if (existing) return existing;
    const group = new Group();
    const pose = new Group();
    pose.position.y = -GAMEPLAY.playerRadius;
    group.add(pose);
    const model = cloneModel(hunterModel.scene);
    // The model faces +Z; a quarter turn about Y points it along the group's +X facing.
    model.rotation.y = Math.PI / 2;
    model.scale.setScalar(hunterModel.scale);
    pose.add(model);
    // Each Hunter gets its own copy of the body material so its emissive colour can show
    // self, teammate, or down. Eyes and flashlight keep the shared originals.
    const material = ditheredBody(hunterModel.bodyMaterial.clone());
    model.traverse((object) => {
      if (object instanceof Mesh && object.material === hunterModel.bodyMaterial) object.material = material;
    });
    const mixer = new AnimationMixer(model);
    const walk = mixer.clipAction(hunterModel.walk);
    walk.setEffectiveWeight(0).play();
    const shadow = blobShadow(CHARACTERS.HUNTER_SHADOW_RADIUS);
    shadow.position.y = -GAMEPLAY.playerRadius + SHADOW_LIFT;
    group.add(shadow);
    group.visible = false;
    scene.add(group);

    // Flashlight: a translucent fan on the floor, drawn when the light pool (which lights the
    // floor itself) is off. Each ray is cut by the same wall boxes the server uses for line of
    // sight, so the drawn light stops where hits stop. Its colour and opacity are set each frame.
    const fanPositions = new Float32Array((FAN_RAYS + 2) * 3);
    const fanGeometry = new BufferGeometry();
    fanGeometry.setAttribute('position', new BufferAttribute(fanPositions, 3));
    const fanIndex: number[] = [];
    for (let ray = 1; ray <= FAN_RAYS; ray++) fanIndex.push(0, ray, ray + 1);
    fanGeometry.setIndex(fanIndex);
    const flatFan = new MeshBasicMaterial({
      color: FLASHLIGHT.FAN_COLOR, transparent: true, opacity: FLASHLIGHT.FAN_OPACITY, side: DoubleSide, depthWrite: false,
    });
    const fan = new Mesh(fanGeometry, flatFan);
    fan.visible = false;
    scene.add(fan);

    // Beam and lens glow (VFX.beam), carried by the group so they turn with the Hunter.
    const beamMaterial = createBeamMaterial(FAN_RAYS);
    const beam = new Mesh(beamGeometry, beamMaterial);
    beam.position.copy(hunterModel.lens);
    beam.visible = false;
    group.add(beam);
    const glow = new Mesh(glowGeometry, createGlowMaterial());
    glow.position.copy(hunterModel.lens);
    glow.visible = false;
    group.add(glow);

    const mesh = {
      group, pose, material, mixer, walk, walkWeight: 0, moving: false, lastPosition: null,
      fan, fanMaterial: flatFan, fanPositions, fanGeometry, beam, beamMaterial, glow, shadow,
    };
    hunters.set(id, mesh);
    return mesh;
  }

  // `range` is the battery stage's reach, so the drawn fan shortens exactly when the
  // authoritative cone does: that shortening is the stage feedback. Each ray's reach is also
  // handed to the beam, which is cut at the same walls.
  function updateFan(mesh: HunterMesh, origin: Position, facing: number, range: number, coneAngle: number): void {
    const halfAngle = (coneAngle / 2) * (Math.PI / 180);
    const reaches = mesh.beamMaterial.uniforms.reaches.value as Float32Array;
    const floorHeight = GAMEPLAY.arena.floorY + 1;
    const { fanPositions, fanGeometry } = mesh;
    fanPositions[0] = origin.x;
    fanPositions[1] = floorHeight;
    fanPositions[2] = origin.z;
    for (let ray = 0; ray <= FAN_RAYS; ray++) {
      const angle = facing - halfAngle + (2 * halfAngle * ray) / FAN_RAYS;
      const direction = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      const reach = wallDistance(origin, direction, range, world.wallBoxes);
      reaches[ray] = reach;
      const offset = (ray + 1) * 3;
      fanPositions[offset] = origin.x + direction.x * reach;
      fanPositions[offset + 1] = floorHeight;
      fanPositions[offset + 2] = origin.z + direction.z * reach;
    }
    fanGeometry.attributes.position.needsUpdate = true;
    fanGeometry.computeBoundingSphere();
  }

  // Points the beam at this frame's light. It is sized to the range and cone angle; its apex is
  // the lens in world space, from the group's position and facing.
  function updateLight(mesh: HunterMesh, origin: Position, facing: number, range: number, coneAngle: number): void {
    const halfAngle = (coneAngle / 2) * (Math.PI / 180);
    const radius = range * Math.tan(halfAngle);
    mesh.beam.scale.set(range, radius, radius);
    const { lens } = hunterModel;
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const material = mesh.beamMaterial;
    material.uniforms.lightOrigin.value.set(origin.x, origin.y, origin.z);
    material.uniforms.lightFacing.value = facing;
    material.uniforms.lightRange.value = range;
    material.uniforms.lightHalfAngle.value = halfAngle;
    mesh.beamMaterial.uniforms.lightApex.value.set(
      origin.x + lens.x * cos - lens.z * sin, origin.y + lens.y, origin.z + lens.x * sin + lens.z * cos,
    );
    mesh.beamMaterial.uniforms.floorY.value = world.floorY;
  }

  // The pool angle for the room's cone angle, in degrees.
  const poolAngle = (coneAngle: number) => Math.min(coneAngle * FLASHLIGHT.POOL_SPREAD, FLASHLIGHT.POOL_MAX_ANGLE);

  // Turns on this Hunter's slot of the light pool (vfx.ts) for this frame at `brightness`: where
  // it stands, its facing, how far the pool reaches at this battery stage, and how far each of
  // its rays gets before a wall, by the same wall test as the fan.
  function updatePool(
    slot: number, origin: Position, facing: number, range: number, coneAngle: number, brightness: number,
  ): void {
    const halfAngle = (poolAngle(coneAngle) / 2) * (Math.PI / 180);
    const reach = range * FLASHLIGHT.POOL_REACH;
    const component = (['x', 'y', 'z', 'w'] as const)[slot];
    POOL_UNIFORMS.flashOrigin.value[slot].set(origin.x, origin.z, facing, reach);
    POOL_UNIFORMS.flashOn.value[component] = brightness;
    for (let ray = 0; ray <= POOL_RAYS; ray++) {
      const angle = facing - halfAngle + (2 * halfAngle * ray) / POOL_RAYS;
      const direction = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      POOL_UNIFORMS.flashReach.value[ray][component] = wallDistance(origin, direction, reach, world.wallBoxes);
    }
  }

  // The Creature mesh exists only while this client holds a Creature position:
  // always for the Creature itself, and for a Hunter only while the server
  // says the Creature is revealed. There is no hidden mesh, shadow, or reflection.
  // It is the creature.glb model, cloned on each appearance with its own copy of the textured
  // material (for the burn tint) and of the outline material (for the stagger), and its own
  // Float mixer. Like a Hunter's, the group sits at the server's position and turns to the
  // facing along local +X; `pose`, at the floor, carries the model and leans it into its travel.
  // `fade` (0..1) is how much of it is drawn while it dissolves in or out; its body and outline
  // share `fadeUniform`. `grab` is the catch cutscene's clip, posed by hand from the cutscene's
  // progress rather than played, and `grabWeight` how much of it shows over Float.
  type CreatureMesh = {
    group: Group; pose: Group; material: MeshStandardMaterial; outline: ShaderMaterial; ring: Mesh;
    ringMaterial: MeshBasicMaterial; shadow: Mesh; mixer: AnimationMixer; float: AnimationAction;
    grab: AnimationAction; grabWeight: number; fade: number; fadeUniform: { value: number };
  };
  let creature: CreatureMesh | null = null;
  // Movement and the eased facing outlive the mesh, so a Creature revealed again keeps the way
  // it faced. It starts facing +Z, toward the camera, as the server spawns it.
  let creatureFacing = Math.PI / 2;
  let creatureLastPosition: Position | null = null;
  let creatureMoving = false;
  let creatureLean = 0;

  function ensureCreature(): CreatureMesh {
    if (creature) return creature;
    const group = new Group();
    const pose = new Group();
    pose.position.y = -GAMEPLAY.playerRadius;
    group.add(pose);
    const model = cloneModel(creatureModel.scene);
    // The model faces +Z; a quarter turn about Y points it along the group's +X facing.
    model.rotation.y = Math.PI / 2;
    model.scale.setScalar(creatureModel.scale);
    model.position.y = creatureModel.lift;
    pose.add(model);
    // Each appearance starts fully dissolved and fades in (render).
    const fadeUniform = { value: 0 };
    const material = ditheredBody(creatureModel.material.clone(), fadeUniform);
    const outline = createOutlineMaterial(fadeUniform);
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (object.material === creatureModel.material) object.material = material;
      else if (object.material === OUTLINE_MATERIAL) object.material = outline;
    });
    const mixer = new AnimationMixer(model);
    const float = mixer.clipAction(creatureModel.float).play();
    // Grab runs but never advances on its own: render sets its time from the cutscene.
    const grab = mixer.clipAction(creatureModel.grab).play();
    grab.paused = true;
    grab.setEffectiveWeight(0);
    // Sprint feedback: a flat ring on the floor under the Creature, fading with it.
    const ringMaterial = new MeshBasicMaterial({ color: '#e46448', transparent: true });
    const ring = new Mesh(new RingGeometry(GAMEPLAY.playerRadius + 2, GAMEPLAY.playerRadius + 6, 24), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -(GAMEPLAY.playerRadius - 2);
    ring.visible = false;
    group.add(ring);
    // Its blob shadow is part of the group, so it exists exactly while the Creature mesh does.
    const shadow = blobShadow(CHARACTERS.CREATURE_SHADOW_RADIUS, creatureShadowMaterial);
    shadow.position.y = -GAMEPLAY.playerRadius + SHADOW_LIFT;
    group.add(shadow);
    scene.add(group);
    // The first snapshot after a reveal has nothing to compare with: no movement yet.
    creatureLastPosition = null;
    creature = { group, pose, material, outline, ring, ringMaterial, shadow, mixer, float, grab, grabWeight: 0, fade: 0, fadeUniform };
    return creature;
  }

  // Frees only what this appearance made; the model's geometry and texture, and the shadow's,
  // are shared with the next one.
  function removeCreature(): void {
    if (!creature) return;
    scene.remove(creature.group);
    creature.material.dispose();
    creature.outline.dispose();
    creature.ring.geometry.dispose();
    creature.ringMaterial.dispose();
    creature = null;
  }

  // Snapshots arrive at the tick rate while frames run faster, so "moving" is decided only
  // when a new snapshot arrives: did this Hunter's position change since the previous one.
  let lastSnapshot: Snapshot | null = null;
  let lastFrameTime = performance.now();

  // Where the fear effects centre: the viewer's own Hunter on screen, and screen heights per world
  // unit there (measured across FOCUS_SPAN units). The panic lines centre on the middle of the
  // model instead (its feet are the floor; lying down, it is no taller than the sphere).
  const FOCUS_SPAN = 100;
  const projected = new Vector3();
  function fearFocus(position: Position, down: boolean) {
    const at = projected.set(position.x, position.y, position.z).project(camera);
    const x = (at.x + 1) / 2;
    const y = (at.y + 1) / 2;
    const across = projected.set(position.x + FOCUS_SPAN, position.y, position.z).project(camera);
    const scale = Math.hypot(((across.x + 1) / 2 - x) * CAMERA.aspect, (across.y + 1) / 2 - y) / FOCUS_SPAN;
    const middle = down ? position.y : position.y - GAMEPLAY.playerRadius + HUNTER_HEIGHT / 2;
    const model = projected.set(position.x, middle, position.z).project(camera);
    return { x, y, scale, lineX: (model.x + 1) / 2, lineY: (model.y + 1) / 2 };
  }

  // The last size the canvas was given, so a change of VIEW.RENDER_SCALE can re-apply it.
  let lastWidth = 1;
  let lastHeight = 1;

  // The catch cutscene's clock in seconds (null while none plays), the camera's aim on the pair
  // (CATCH_FOCUS_HEIGHT above the floor, about mid-body) and its place there.
  let catchClock: number | null = null;
  const CATCH_FOCUS_HEIGHT = 25;
  const GRAB_BLEND_SECONDS = 0.1;
  const catchFocus = new Vector3();
  const catchCamera = new Vector3();
  const smooth = (x: number) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  };

  // `tuning` is the room's: the fan's length and width follow the values the server plays by.
  // `fearPreview` (the debug menu's fear preview) replaces a Hunter's band and dread. `firePreview`
  // (the debug menu's too) sets a Creature this client can already see burning, on this screen only.
  function render(snapshot: Snapshot | null, tuning: Tuning, fearPreview: number | null = null, firePreview = false): void {
    // The look values (NIGHT, CHARACTERS, BATTERY_LOOK, VIEW and vfx.ts's) may have been edited
    // in the debug menu since the last frame.
    syncNight();
    syncVfxUniforms();
    if (renderScale !== VIEW.RENDER_SCALE) {
      renderScale = VIEW.RENDER_SCALE;
      renderer.setPixelRatio(pixelRatio());
      resize(lastWidth, lastHeight);
    }
    props.group.visible = VIEW.SHOW_PROPS;
    surfaces.group.visible = VIEW.SHOW_SURFACES;
    shadowMaterial.uniforms.opacity.value = SHADING.BLOB_SHADOW_OPACITY;
    creatureShadowMaterial.uniforms.opacity.value = SHADING.CREATURE_BLOB_SHADOW_OPACITY;
    OUTLINE_MATERIAL.visible = VFX.outline;
    setPixelTextures(surfaceTextures, VFX.pixelTextures);
    VFX_UNIFORMS.vfxDitherShading.value = VFX.ditherShading ? 1 : 0;
    const now = performance.now();
    // Capped so a backgrounded tab does not jump the walk cycle when it returns.
    const deltaSeconds = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    const newSnapshot = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    props.update(now / 1000);
    for (const mesh of hunters.values()) {
      mesh.group.visible = false;
      mesh.fan.visible = false;
    }
    // Every slot of the light pool starts dark; each Hunter whose light is on turns its own on.
    POOL_UNIFORMS.flashOn.value.set(0, 0, 0, 0);
    POOL_UNIFORMS.flashHalfAngle.value = (poolAngle(tuning.flashlightConeAngle) / 2) * (Math.PI / 180);
    POOL_UNIFORMS.flashCoreHalfAngle.value = (tuning.flashlightConeAngle / 2) * (Math.PI / 180);
    POOL_UNIFORMS.flashFloorY.value = world.floorY;
    const self = snapshot?.role === 'hunter' ? snapshot.self : null;

    // The catch cutscene: how far into it this frame is, from the server's count at each snapshot
    // and the frame clock between them, and where the pair stand.
    const caught = snapshot?.catch ?? null;
    if (!caught) catchClock = null;
    else catchClock = newSnapshot || catchClock === null ? caught.elapsed : catchClock + deltaSeconds;
    const catchSeconds = Math.max(tuning.catchSeconds, 1e-3);
    const catchProgress = catchClock === null ? 0 : Math.min(1, catchClock / catchSeconds);
    const caughtHunter = caught ? snapshot?.hunters.find((view) => view.id === caught.hunter) : undefined;
    const caughtCreature = snapshot?.role === 'creature' ? snapshot.creature : snapshot?.creature?.position;
    // The camera dollies in on the pair along its own view, so its angle never changes.
    camera.position.copy(cameraHome);
    if (catchClock !== null && caughtHunter && caughtCreature) {
      const zoom = smooth(Math.min(1, catchClock / CATCH.ZOOM_IN_SECONDS, (catchSeconds - catchClock) / CATCH.ZOOM_OUT_SECONDS));
      const focus = catchFocus.set(
        (caughtHunter.position.x + caughtCreature.x) / 2, world.floorY + CATCH_FOCUS_HEIGHT, (caughtHunter.position.z + caughtCreature.z) / 2,
      );
      camera.position.lerp(catchCamera.subVectors(cameraHome, cameraAim).multiplyScalar(CATCH.ZOOM).add(focus), zoom);
    }
    camera.updateMatrixWorld();

    // Fear: only an active Hunter feels it, only while the round runs, from its own band and
    // dread. It eases out while a catch plays, so a Hunter's darkness never hides the cutscene,
    // once a Hunter is down (an incapacitated Hunter feels nothing until it is revived), and while
    // the Creature burns (hunterFear). (The debug menu's fear preview still shows, for tuning.)
    const selfView = snapshot?.hunters.find((view) => view.id === self);
    const feeling = snapshot?.role !== 'hunter' || caught ? null
      : fearPreview !== null ? previewInput(fearPreview)
        : hunterFear(snapshot, tuning);
    const fearFrame = fear.update(feeling ?? { stage: 0, t: 0 }, deltaSeconds);
    if (selfView) post.setFear(fearFrame, fearFocus(selfView.position, selfView.down), (now - startTime) / 1000);
    else post.setFear({ ...fearFrame, active: false }, { x: 0.5, y: 0.5, scale: 1, lineX: 0.5, lineY: 0.5 }, 0);
    for (const view of snapshot?.hunters ?? []) {
      const mesh = ensureHunter(view.id);
      mesh.group.visible = true;
      mesh.group.position.set(view.position.x, view.position.y, view.position.z);
      // A positive rotation about Y turns local +X toward -Z; the facing angle runs +X toward +Z.
      mesh.group.rotation.y = -view.facing;
      // How far down it lies, 0 standing to 1 on its back. The Hunter being caught is held up by
      // the Creature, struggling, and falls over the last CATCH.FALL_SECONDS of the cutscene.
      const held = catchClock !== null && caught?.hunter === view.id;
      const downAmount = held ? smooth((catchClock! - (catchSeconds - CATCH.FALL_SECONDS)) / Math.max(CATCH.FALL_SECONDS, 1e-3))
        : view.down ? 1 : 0;
      const struggling = held && catchProgress > CATCH.LUNGE_TO && catchProgress < CATCH.RELEASE_FROM;
      mesh.pose.position.x = struggling ? CATCH.STRUGGLE * Math.sin(now * 0.047) : 0;
      mesh.pose.position.z = struggling ? CATCH.STRUGGLE * Math.sin(now * 0.061 + 1.3) : 0;
      mesh.material.emissive.set(downAmount >= 0.5 ? CHARACTERS.DOWN_COLOR : view.id === self ? CHARACTERS.SELF_COLOR : CHARACTERS.TEAMMATE_COLOR);
      // The shadow follows the body: round under a standing Hunter, stretched along a downed one,
      // whose head points away from its facing.
      mesh.shadow.visible = VFX.blobShadows;
      mesh.shadow.position.x = (-HUNTER_HEIGHT / 2) * downAmount;
      mesh.shadow.scale.x = CHARACTERS.HUNTER_SHADOW_RADIUS + (HUNTER_HEIGHT * 0.6 - CHARACTERS.HUNTER_SHADOW_RADIUS) * downAmount;
      mesh.shadow.scale.z = CHARACTERS.HUNTER_SHADOW_RADIUS;
      // Down: tipped onto its back (face up, head away from its facing), lifted so the back
      // rests on the floor. It cannot move, turn, or shine.
      mesh.pose.rotation.z = (Math.PI / 2) * downAmount;
      mesh.pose.position.y = -GAMEPLAY.playerRadius + hunterModel.backDepth * downAmount;
      // Walk plays while the Hunter moves and fades back to the rest pose when it stops.
      if (newSnapshot) {
        const last = mesh.lastPosition;
        mesh.moving = last !== null && (last.x !== view.position.x || last.z !== view.position.z);
        mesh.lastPosition = { ...view.position };
      }
      const targetWeight = mesh.moving && !view.down ? 1 : 0;
      const step = deltaSeconds / WALK_FADE_SECONDS;
      mesh.walkWeight += Math.max(-step, Math.min(step, targetWeight - mesh.walkWeight));
      mesh.walk.setEffectiveWeight(mesh.walkWeight);
      mesh.walk.timeScale = tuning.hunterSpeed / CHARACTERS.WALK_RATE_SPEED;
      mesh.mixer.update(deltaSeconds);
      // `light` is already false on an empty battery, so a depleted flashlight draws nothing.
      // The light pool lights the floor itself; without it, the flat fan shows the reach.
      mesh.fan.visible = view.light && !VFX.lightPool;
      mesh.fanMaterial.color.set(FLASHLIGHT.FAN_COLOR);
      mesh.fanMaterial.opacity = FLASHLIGHT.FAN_OPACITY;
      mesh.beam.visible = mesh.glow.visible = view.light && VFX.beam;
      mesh.glow.scale.setScalar(CHARACTERS.LENS_GLOW_RADIUS);
      if (view.light) {
        const range = flashlightRange(view.battery, tuning);
        updateFan(mesh, view.position, view.facing, range, tuning.flashlightConeAngle);
        updateLight(mesh, view.position, view.facing, range, tuning.flashlightConeAngle);
        // Near the Creature your own light stutters, on your own screen only, so it never tells a
        // teammate your band.
        const brightness = view.id === self ? fearFrame.flicker : 1;
        mesh.beamMaterial.uniforms.lightColor.value.set(FLASHLIGHT.LIGHT_COLOR).multiplyScalar(brightness);
        (mesh.glow.material as ShaderMaterial).uniforms.lightColor.value.set(FLASHLIGHT.LIGHT_COLOR).multiplyScalar(brightness);
        if (VFX.lightPool) {
          POOL_UNIFORMS.flashLensY.value = view.position.y + hunterModel.lens.y;
          updatePool(Number(view.id.slice(1)) - 1, view.position, view.facing, range, tuning.flashlightConeAngle, brightness);
        }
      }
    }
    // Every battery glows and charges in step; a taken one, or every one with the glow off, is dark.
    const seconds = (now - startTime) / 1000;
    const pulse = 1 - BATTERY_LOOK.BATTERY_PULSE_DEPTH * (0.5 + 0.5 * Math.sin(seconds * 2 * Math.PI * BATTERY_LOOK.BATTERY_PULSE_RATE))
      + BATTERY_LOOK.BATTERY_CHARGE_FLASH * batteryChargeFlash(seconds);
    haloMaterial.uniforms.haloPulse.value = pulse;
    haloMaterial.uniforms.haloColor.value.set(BATTERY_LIGHT.BATTERY_LIGHT_COLOR);
    haloMaterial.uniforms.haloIntensity.value = BATTERY_LIGHT.HALO_INTENSITY;
    moteMaterial.uniforms.moteColor.value.set(BATTERY_LIGHT.BATTERY_LIGHT_COLOR).multiplyScalar(BATTERY_LIGHT.MOTE_INTENSITY);
    BATTERY_BODY_UNIFORMS.batteryGlowPulse.value = VFX.batteryGlow ? pulse : 1;
    BATTERY_BODY_UNIFORMS.batteryGlowOn.value = VFX.batteryGlow ? 1 : 0;
    BATTERY_BODY_UNIFORMS.batteryTime.value = seconds;
    // Both roles see the same list, so both see the same entrances and sparkles. A battery already
    // out when this client joined just stands there.
    if (snapshot && newSnapshot) {
      const { spawned, taken } = pickupChanges(lastPickups, snapshot.pickups, snapshot.roundState);
      for (const index of spawned) pickups[index].spawnedAt = seconds;
      if (VFX.sparkles) {
        for (const index of spawned) sparkles.burst('spawn', pickups[index].pose.position, seconds);
        for (const index of taken) sparkles.burst('pickup', pickups[index].pose.position, seconds);
      }
    }
    lastPickups = snapshot?.pickups ?? null;
    sparkles.update(seconds);
    for (const [index, pickup] of pickups.entries()) {
      pickup.pose.visible = snapshot?.pickups.includes(index) ?? false;
      // Its entrance, if one is playing. A battery collected partway through is simply gone.
      if (!pickup.pose.visible) pickup.spawnedAt = null;
      const entrance = batterySpawnPose(pickup.spawnedAt === null ? Infinity : seconds - pickup.spawnedAt);
      if (entrance.done) pickup.spawnedAt = null;
      pickup.spin.scale.setScalar(entrance.scale);
      pickup.spin.quaternion.setFromAxisAngle(BATTERY_SPAWN.WORLD_AXIS ? pickup.worldUp : LOCAL_UP, entrance.turn);
      // What it casts grows with it, but its light never goes past full on the overshoot.
      const grown = Math.min(entrance.scale, 1);
      pickup.shadow.visible = pickup.pose.visible && VFX.blobShadows;
      pickup.shadow.scale.set(BATTERY_LOOK.BATTERY_SHADOW_RADIUS * grown, 1, BATTERY_LOOK.BATTERY_SHADOW_RADIUS * grown);
      pickup.halo.visible = pickup.pose.visible && VFX.batteryGlow;
      pickup.halo.scale.setScalar(BATTERY_LOOK.BATTERY_HALO_RADIUS * grown);
      pickup.motes.visible = pickup.halo.visible;
      pickup.motes.scale.setScalar(grown);
      if (index < MAX_BATTERY_LIGHTS) BATTERY_LIGHT_UNIFORMS.batteryLights.value[index].z = pickup.halo.visible ? pulse * grown : 0;
    }

    const creatureView = snapshot?.role === 'creature'
      ? { position: snapshot.creature, facing: snapshot.facing, staggered: snapshot.staggered, sprinting: snapshot.sprinting, burning: snapshot.burning || firePreview }
      : snapshot?.creature ? { ...snapshot.creature, burning: snapshot.creature.burning || firePreview } : null;
    if (creatureView) {
      const mesh = ensureCreature();
      const { position } = creatureView;
      mesh.group.position.set(position.x, position.y, position.z);
      // In a catch it slides in over its lunge until it is CATCH.GRAB_DISTANCE from the Hunter
      // (its arms reach the Hunter's sides from there), and back over the release.
      if (catchClock !== null && caughtHunter) {
        const dx = caughtHunter.position.x - position.x;
        const dz = caughtHunter.position.z - position.z;
        const apart = Math.hypot(dx, dz);
        const reach = smooth((catchProgress - CATCH.LUNGE_FROM) / Math.max(CATCH.LUNGE_TO - CATCH.LUNGE_FROM, 1e-3))
          * (1 - smooth((catchProgress - CATCH.RELEASE_FROM) / Math.max(1 - CATCH.RELEASE_FROM, 1e-3)));
        const slide = Math.max(0, apart - CATCH.GRAB_DISTANCE) * reach;
        if (apart > 1e-6) mesh.group.position.add(catchFocus.set((dx / apart) * slide, 0, (dz / apart) * slide));
      }
      // Moving: did the position change between two snapshots. The facing comes from the
      // server, so it turns even while a wall stops the Creature, eased at a fixed rate.
      if (newSnapshot) {
        const last = creatureLastPosition;
        creatureMoving = last !== null && (last.x !== position.x || last.z !== position.z);
        creatureLastPosition = { ...position };
      }
      const turn = wrapAngle(creatureView.facing - creatureFacing);
      const { CREATURE_LEAN, CREATURE_SPRINT_LEAN, FLOAT_RATE_EASE } = CHARACTERS;
      // In a catch it faces the Hunter at once (the server turned it there).
      creatureFacing = catchClock !== null ? creatureView.facing
        : wrapAngle(creatureFacing + Math.sign(turn) * Math.min(Math.abs(turn), CHARACTERS.CREATURE_TURN_SPEED * deltaSeconds));
      mesh.group.rotation.y = -creatureFacing;
      // Leaning forward is a negative turn about the pose's Z (its +X is the facing). It eases to
      // the sprint lean, the moving lean or upright, at a rate that reaches the deepest one in
      // FLOAT_RATE_EASE. Grab does its own leaning.
      const leanTarget = catchClock !== null ? 0 : creatureView.sprinting ? CREATURE_SPRINT_LEAN : creatureMoving ? CREATURE_LEAN : 0;
      const leanStep = (Math.max(CREATURE_LEAN, CREATURE_SPRINT_LEAN) * deltaSeconds) / FLOAT_RATE_EASE;
      creatureLean += Math.max(-leanStep, Math.min(leanStep, leanTarget - creatureLean));
      mesh.pose.rotation.z = -creatureLean;
      const rate = creatureView.sprinting ? CHARACTERS.FLOAT_RATE_SPRINT : creatureMoving ? CHARACTERS.FLOAT_RATE_MOVING : 1;
      mesh.float.timeScale += (rate - mesh.float.timeScale) * Math.min(1, deltaSeconds / FLOAT_RATE_EASE);
      // Grab follows the cutscene's progress, taking over from Float within GRAB_BLEND_SECONDS
      // and handing back as quickly once it is over (Grab ends in Float's rest pose).
      const grabStep = deltaSeconds / GRAB_BLEND_SECONDS;
      mesh.grabWeight = Math.min(1, Math.max(0, mesh.grabWeight + (catchClock !== null ? grabStep : -grabStep)));
      if (catchClock !== null) mesh.grab.time = catchProgress * creatureModel.grab.duration;
      mesh.grab.setEffectiveWeight(mesh.grabWeight);
      mesh.float.setEffectiveWeight(1 - mesh.grabWeight);
      mesh.mixer.update(deltaSeconds);
      // Burning feedback: the whole model glows ember red while the Creature cannot tag.
      const [red, green, blue] = creatureView.burning ? CHARACTERS.CREATURE_BURNING_TINT : CHARACTERS.CREATURE_TINT;
      mesh.material.emissive.setRGB(red, green, blue);
      // Stagger feedback: a thick white outline, drawn even with the outline experiment off.
      mesh.outline.visible = VFX.outline || creatureView.staggered;
      mesh.outline.uniforms.vfxOutlineColor.value.set(creatureView.staggered ? SHADING.STAGGER_OUTLINE_COLOR : '#000000');
      mesh.outline.uniforms.vfxOutlineWidth.value = creatureView.staggered ? SHADING.STAGGER_OUTLINE_WIDTH : SHADING.OUTLINE_WIDTH;
      mesh.ring.visible = creatureView.sprinting;
      mesh.shadow.visible = VFX.blobShadows;
      mesh.shadow.scale.set(CHARACTERS.CREATURE_SHADOW_RADIUS, 1, CHARACTERS.CREATURE_SHADOW_RADIUS);
      // The fade, on a Hunter's screen only: it dissolves in over CREATURE_FADE_IN_SECONDS, and out
      // with the server's reveal countdown over its last CREATURE_FADE_OUT_SECONDS, so it is all but
      // gone by the step the server stops sending it. The Creature always sees itself whole.
      const fadeTarget = snapshot?.role === 'creature' ? 1
        : Math.min(1, (snapshot?.creature?.revealRemaining ?? 0) / Math.max(CHARACTERS.CREATURE_FADE_OUT_SECONDS, 1e-3));
      mesh.fade = snapshot?.role === 'creature' ? 1
        : Math.min(fadeTarget, mesh.fade + deltaSeconds / Math.max(CHARACTERS.CREATURE_FADE_IN_SECONDS, 1e-3));
      mesh.fadeUniform.value = mesh.fade;
      mesh.ringMaterial.opacity = mesh.fade;
      creatureShadowMaterial.uniforms.opacity.value = SHADING.CREATURE_BLOB_SHADOW_OPACITY * mesh.fade;
    } else {
      removeCreature();
    }
    // The fire stands wherever the Creature's body is drawn, the catch's slide included.
    const burning = VFX.fire && (creatureView?.burning ?? false);
    if (creature) {
      const { x, y, z } = creature.group.position;
      Object.assign(fireFloor, { x, y: y - GAMEPLAY.playerRadius, z });
    }
    fire.update(seconds, deltaSeconds, burning, creature ? fireFloor : null, CREATURE_HEIGHT);
    updateFireLight(seconds, deltaSeconds, burning);
    post.render();
  }

  function resize(width: number, height: number): void {
    lastWidth = width;
    lastHeight = height;
    renderer.setSize(width, height, false);
    post.setSize(width, height);
    // The outline is a fixed fraction of the view height; its width is corrected by this.
    VFX_UNIFORMS.vfxAspect.value = width / height;
  }

  // The debug menu's replay, at the battery on the map, or the first battery point if there is none
  // (just the sparkle then, with no can to grow).
  function previewSparkle(kind: 'spawn' | 'pickup'): void {
    const pickup = pickups[lastPickups?.[0] ?? 0];
    if (!pickup) return;
    const seconds = (performance.now() - startTime) / 1000;
    sparkles.burst(kind, pickup.pose.position, seconds);
    if (kind === 'spawn') pickup.spawnedAt = seconds;
  }

  // Frees this scene's geometry; the renderer is kept when the caller will reuse it for
  // the next map and disposed only when the page goes away.
  function dispose(keepRenderer = false): void {
    FIRE_LIGHT_UNIFORMS.fireLight.value.set(0, 0, 0, 0);
    props.dispose();
    surfaces.dispose();
    post.dispose();
    // Shared by meshes that may already have left the scene (a Creature that was hidden).
    shadowGeometry.dispose();
    shadowMaterial.dispose();
    creatureShadowMaterial.dispose();
    scene.traverse((object) => {
      if (object instanceof Mesh || object instanceof Points) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    if (!keepRenderer) renderer.dispose();
  }

  return { render, resize, dispose, previewSparkle, renderer, aspect: CAMERA.aspect };
}
