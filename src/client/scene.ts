import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  type ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneModel } from 'three/examples/jsm/utils/SkeletonUtils.js';
import batteryModelUrl from './assets/battery.glb?url';
import creatureModelUrl from './assets/creature.glb?url';
import hunterModelUrl from './assets/hunter.glb?url';
import { flashlightRange } from '../shared/flashlight.js';
import type { Tuning } from '../shared/tuning.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { World } from '../shared/map/world.js';
import type { HunterId, Position, ServerMessage } from '../shared/protocol.js';
import { wallDistance } from '../shared/raycast.js';
import { cameraFor } from './camera-config.js';
import {
  OUTLINE_MATERIAL, OUTLINE_WIDTH, STAGGER_OUTLINE_COLOR, STAGGER_OUTLINE_WIDTH, VFX, VFX_UNIFORMS,
  createBeamMaterial, createGlowMaterial, createLightPoolMaterial, createOutlineMaterial, ditheredBody,
} from './vfx.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
// Rays across the cone for the drawn flashlight fan. Purely visual resolution.
const FAN_RAYS = 32;
// Flat Hunter colours: the viewer's own Hunter, every other Hunter, and a downed Hunter.
const SELF_COLOR = '#e6e7e4';
const TEAMMATE_COLOR = '#8fa3b8';
const DOWN_COLOR = '#8a3a4a';
// The Hunter model is scaled to this height: 1.8x the collision sphere's diameter, so it
// reads clearly from the camera. Presentation only; collision still uses playerRadius.
// Walk fades in and out over WALK_FADE_SECONDS; at zero weight the model is in its rest
// pose, which is the idle.
const HUNTER_HEIGHT = 1.8 * 2 * GAMEPLAY.playerRadius;
const WALK_FADE_SECONDS = 0.15;
// The Hunter speed (units/s) at which Walk plays at its authored rate. Playback scales with
// the room's tuned hunterSpeed, so a speed of 60 plays it at about 1.56x. Lower this for a
// faster walk.
const WALK_RATE_SPEED = 38.5;
// The Creature model is scaled to this height (3x the collision sphere's diameter, towering
// over a Hunter) and hovers with its lowest point CREATURE_HOVER above the floor.
// Presentation only, like the Hunter's.
const CREATURE_HEIGHT = 3 * 2 * GAMEPLAY.playerRadius;
const CREATURE_HOVER = 3;
// Float always plays: at its authored rate while still, faster while moving, faster still while
// sprinting, easing between rates over FLOAT_RATE_EASE seconds.
const FLOAT_RATE_MOVING = 1.6;
const FLOAT_RATE_SPRINT = 2.4;
const FLOAT_RATE_EASE = 0.25;
// The server sends no Creature facing, so the model turns toward its direction of travel at
// CREATURE_TURN_SPEED (radians per second), and leans CREATURE_LEAN radians into it while moving.
const CREATURE_TURN_SPEED = 3 * Math.PI;
const CREATURE_LEAN = 0.15;
// The emissive multiplier on the Creature's texture: its own colours, and the ember glow it
// takes while burning (unable to tag). Components above 1 brighten it; the charcoal robe needs
// a strong red to glow.
const CREATURE_TINT = new Color(1, 1, 1);
const CREATURE_BURNING_TINT = new Color(6, 2, 0.8);
// Battery pickup: battery.glb scaled to BATTERY_HEIGHT and posed for the fixed camera. It is
// tipped back until its face (the bolt) looks at the camera, short of square-on by
// BATTERY_TOP_SHOW so a sliver of its cap shows, then leaned BATTERY_LEAN on screen, right
// and left on alternate spawn points. Its lowest point rests BATTERY_HOVER above the floor.
const BATTERY_HEIGHT = 30;
const BATTERY_TOP_SHOW = 15 * (Math.PI / 180);
const BATTERY_LEAN = 30 * (Math.PI / 180);
const BATTERY_HOVER = 1;
// Radius of the soft glow drawn at the flashlight's lens.
const LENS_GLOW_RADIUS = 5;

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

// The Creature model and its Float clip, loaded once per page and cloned each time the Creature
// appears. `material` is its one textured emissive material ('Creature' in the file), tinted
// while burning. `scale` fits it to CREATURE_HEIGHT; `lift` raises it so its lowest point
// hovers CREATURE_HOVER above the floor. Like the Hunter, it faces +Z in the file.
export type CreatureModel = {
  scene: Object3D; float: AnimationClip; material: MeshStandardMaterial; scale: number; lift: number;
};

export async function loadCreatureModel(): Promise<CreatureModel> {
  const gltf = await new GLTFLoader().loadAsync(creatureModelUrl);
  const float = AnimationClip.findByName(gltf.animations, 'Float');
  if (!float) throw new Error('creature.glb has no Float animation');
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
  return { scene: gltf.scene, float, material, scale, lift: CREATURE_HOVER - bounds.min.y * scale };
}

// The battery pickup model, loaded once per page and cloned per spawn point. Its one material
// gets the dithered shading in place, since every battery looks the same. `scale` fits it to
// BATTERY_HEIGHT; `center` is its middle in the file, the point it is posed around. Like the
// players, it faces +Z in the file, cap up.
export type BatteryModel = { scene: Object3D; scale: number; center: Vector3 };

export async function loadBatteryModel(): Promise<BatteryModel> {
  const gltf = await new GLTFLoader().loadAsync(batteryModelUrl);
  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  const material = meshes[0]?.material;
  if (!(material instanceof MeshStandardMaterial)) throw new Error('battery.glb has no battery mesh');
  ditheredBody(material);
  const bounds = new Box3().setFromObject(gltf.scene);
  addOutlineHulls(meshes);
  return { scene: gltf.scene, scale: BATTERY_HEIGHT / (bounds.max.y - bounds.min.y), center: bounds.getCenter(new Vector3()) };
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
  batteryModel: BatteryModel, existingRenderer?: WebGLRenderer,
) {
  const renderer = existingRenderer ?? new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color('#161918');

  const CAMERA = cameraFor(world);
  const camera = new PerspectiveCamera(CAMERA.fieldOfView, CAMERA.aspect, CAMERA.near, CAMERA.far);
  camera.position.set(CAMERA.position.x, CAMERA.position.y, CAMERA.position.z);
  // Target determines the fixed rotation; no client movement or input controls this camera.
  camera.lookAt(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z);

  // Floor and walls come from the room's map: the same boxes the authoritative collision
  // and line-of-sight rules use, so what is drawn is exactly what the server simulates.
  const floor = new Mesh(
    new PlaneGeometry(world.width, world.depth),
    new MeshLambertMaterial({ color: '#303a33' }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(world.width / 2, world.floorY, world.depth / 2);
  scene.add(floor);

  for (const { min, max } of world.wallBoxes) {
    const wall = new Mesh(
      new BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z),
      new MeshLambertMaterial({ color: '#7c857d' }),
    );
    wall.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    scene.add(wall);
  }

  scene.add(new HemisphereLight('#ffffff', '#5b665d', 1.8));
  const light = new DirectionalLight('#ffffff', 1.8);
  light.position.set(-300, 900, 500);
  scene.add(light);
  // The Hunter's dithered shading uses this light's direction, in the fixed camera's view space.
  camera.updateMatrixWorld();
  VFX_UNIFORMS.vfxLightDirection.value.copy(light.position).normalize().transformDirection(camera.matrixWorldInverse);

  // Battery pickups: one battery per Battery Spawn marker the map declares, shown while the
  // server lists that point as active. Both roles see the same set, in the same order the
  // server uses, so a pickup index means the same thing on every client.
  const pickups = world.batterySpawns.map(({ x, z }, index) => {
    const model = batteryModel.scene.clone();
    model.scale.setScalar(batteryModel.scale);
    model.position.copy(batteryModel.center).multiplyScalar(-batteryModel.scale);
    // `pose` turns and leans the battery about its middle: turned like the camera, so its face is
    // parallel to the screen with the cap up, then leaned about the line of sight, then the cap
    // tipped toward the camera. Every battery leans the same on screen wherever it stands.
    const pose = new Group().add(model);
    pose.position.set(x, world.floorY, z);
    pose.quaternion.copy(camera.quaternion);
    pose.rotateZ((index % 2 === 0 ? -1 : 1) * BATTERY_LEAN);
    pose.rotateX(BATTERY_TOP_SHOW);
    pose.updateMatrixWorld(true);
    pose.position.y += world.floorY + BATTERY_HOVER - new Box3().setFromObject(pose, true).min.y;
    pose.visible = false;
    scene.add(pose);
    return pose;
  });

  // Flashlight effects (vfx.ts), shared by every Hunter. The beam is a unit cone with its tip
  // at the origin opening along +X, scaled each frame to the light's range and width.
  const beamGeometry = new ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0).rotateZ(Math.PI / 2);
  const glowGeometry = new SphereGeometry(LENS_GLOW_RADIUS, 16, 12);

  // Hunter: the hunter.glb model plus a flashlight fan of its own. The group sits at the
  // server's position (the collision sphere's center) and is rotated to its facing, which
  // points along local +X. Inside it, `pose` is at the feet: it tips over when the Hunter
  // is down. One set per Hunter slot, created on demand.
  type HunterMesh = {
    group: Group; pose: Group; material: MeshStandardMaterial;
    mixer: AnimationMixer; walk: AnimationAction; walkWeight: number; moving: boolean; lastPosition: Position | null;
    fan: Mesh; fanPositions: Float32Array; fanGeometry: BufferGeometry;
    flatFan: MeshBasicMaterial; lightPool: ShaderMaterial; beam: Mesh; beamMaterial: ShaderMaterial; glow: Mesh;
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
    group.visible = false;
    scene.add(group);

    // Flashlight: a translucent fan on the floor. Each ray is cut by the same wall
    // boxes the server uses for line of sight, so the drawn light stops where hits stop.
    // This is gameplay feedback, not lighting.
    const fanPositions = new Float32Array((FAN_RAYS + 2) * 3);
    const fanGeometry = new BufferGeometry();
    fanGeometry.setAttribute('position', new BufferAttribute(fanPositions, 3));
    const fanIndex: number[] = [];
    for (let ray = 1; ray <= FAN_RAYS; ray++) fanIndex.push(0, ray, ray + 1);
    fanGeometry.setIndex(fanIndex);
    // The plain fan, or the same fan drawn as a pool of light (VFX.lightPool).
    const flatFan = new MeshBasicMaterial({
      color: '#f2e8a8', transparent: true, opacity: 0.35, side: DoubleSide, depthWrite: false,
    });
    const lightPool = createLightPoolMaterial();
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
      fan, fanPositions, fanGeometry, flatFan, lightPool, beam, beamMaterial, glow,
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

  // Points the beam and the light pool at this frame's light. The beam is sized to the range
  // and cone angle; its apex is the lens in world space, from the group's position and facing.
  function updateLight(mesh: HunterMesh, origin: Position, facing: number, range: number, coneAngle: number): void {
    const halfAngle = (coneAngle / 2) * (Math.PI / 180);
    const radius = range * Math.tan(halfAngle);
    mesh.beam.scale.set(range, radius, radius);
    const { lens } = hunterModel;
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    for (const material of [mesh.beamMaterial, mesh.lightPool]) {
      material.uniforms.lightOrigin.value.set(origin.x, origin.y, origin.z);
      material.uniforms.lightFacing.value = facing;
      material.uniforms.lightRange.value = range;
      material.uniforms.lightHalfAngle.value = halfAngle;
    }
    mesh.beamMaterial.uniforms.lightApex.value.set(
      origin.x + lens.x * cos - lens.z * sin, origin.y + lens.y, origin.z + lens.x * sin + lens.z * cos,
    );
    mesh.beamMaterial.uniforms.floorY.value = world.floorY;
  }

  // The Creature mesh exists only while this client holds a Creature position:
  // always for the Creature itself, and for a Hunter only while the server
  // says the Creature is revealed. There is no hidden mesh, shadow, or reflection.
  // It is the creature.glb model, cloned on each appearance with its own copy of the textured
  // material (for the burn tint) and of the outline material (for the stagger), and its own
  // Float mixer. Like a Hunter's, the group sits at the server's position and turns to the
  // facing along local +X; `pose`, at the floor, carries the model and leans it into its travel.
  type CreatureMesh = {
    group: Group; pose: Group; material: MeshStandardMaterial; outline: ShaderMaterial; ring: Mesh;
    mixer: AnimationMixer; float: AnimationAction;
  };
  let creature: CreatureMesh | null = null;
  // Movement and facing outlive the mesh, so a Creature revealed again keeps the way it faced.
  // It starts facing +Z, toward the camera.
  let creatureFacing = Math.PI / 2;
  let creatureTargetFacing = creatureFacing;
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
    const material = ditheredBody(creatureModel.material.clone());
    const outline = createOutlineMaterial();
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (object.material === creatureModel.material) object.material = material;
      else if (object.material === OUTLINE_MATERIAL) object.material = outline;
    });
    const mixer = new AnimationMixer(model);
    const float = mixer.clipAction(creatureModel.float).play();
    // Sprint feedback: a flat ring on the floor under the Creature.
    const ring = new Mesh(
      new RingGeometry(GAMEPLAY.playerRadius + 2, GAMEPLAY.playerRadius + 6, 24),
      new MeshBasicMaterial({ color: '#e46448' }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -(GAMEPLAY.playerRadius - 2);
    ring.visible = false;
    group.add(ring);
    scene.add(group);
    // The first snapshot after a reveal has nothing to compare with: no movement yet.
    creatureLastPosition = null;
    creature = { group, pose, material, outline, ring, mixer, float };
    return creature;
  }

  // Frees only what this appearance made; the model's geometry and texture are shared with the
  // next one.
  function removeCreature(): void {
    if (!creature) return;
    scene.remove(creature.group);
    creature.material.dispose();
    creature.outline.dispose();
    creature.ring.geometry.dispose();
    (creature.ring.material as MeshBasicMaterial).dispose();
    creature = null;
  }

  // Snapshots arrive at the tick rate while frames run faster, so "moving" is decided only
  // when a new snapshot arrives: did this Hunter's position change since the previous one.
  let lastSnapshot: Snapshot | null = null;
  let lastFrameTime = performance.now();

  // `tuning` is the room's: the fan's length and width follow the values the server plays by.
  function render(snapshot: Snapshot | null, tuning: Tuning): void {
    OUTLINE_MATERIAL.visible = VFX.outline;
    VFX_UNIFORMS.vfxDitherShading.value = VFX.ditherShading ? 1 : 0;
    const now = performance.now();
    // Capped so a backgrounded tab does not jump the walk cycle when it returns.
    const deltaSeconds = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    const newSnapshot = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    for (const mesh of hunters.values()) {
      mesh.group.visible = false;
      mesh.fan.visible = false;
    }
    const self = snapshot?.role === 'hunter' ? snapshot.self : null;
    for (const view of snapshot?.hunters ?? []) {
      const mesh = ensureHunter(view.id);
      mesh.group.visible = true;
      mesh.group.position.set(view.position.x, view.position.y, view.position.z);
      // A positive rotation about Y turns local +X toward -Z; the facing angle runs +X toward +Z.
      mesh.group.rotation.y = -view.facing;
      mesh.material.emissive.set(view.down ? DOWN_COLOR : view.id === self ? SELF_COLOR : TEAMMATE_COLOR);
      // Down: tipped onto its back (face up, head away from its facing), lifted so the back
      // rests on the floor. It cannot move, turn, or shine.
      mesh.pose.rotation.z = view.down ? Math.PI / 2 : 0;
      mesh.pose.position.y = -GAMEPLAY.playerRadius + (view.down ? hunterModel.backDepth : 0);
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
      mesh.walk.timeScale = tuning.hunterSpeed / WALK_RATE_SPEED;
      mesh.mixer.update(deltaSeconds);
      // `light` is already false on an empty battery, so a depleted flashlight draws nothing.
      mesh.fan.visible = view.light;
      mesh.beam.visible = mesh.glow.visible = view.light && VFX.beam;
      mesh.fan.material = VFX.lightPool ? mesh.lightPool : mesh.flatFan;
      if (view.light) {
        const range = flashlightRange(view.battery, tuning);
        updateFan(mesh, view.position, view.facing, range, tuning.flashlightConeAngle);
        updateLight(mesh, view.position, view.facing, range, tuning.flashlightConeAngle);
      }
    }
    for (const [index, pickup] of pickups.entries()) pickup.visible = snapshot?.pickups.includes(index) ?? false;

    const creatureView = snapshot?.role === 'creature'
      ? { position: snapshot.creature, staggered: snapshot.staggered, sprinting: snapshot.sprinting, burning: snapshot.burning }
      : snapshot?.creature ?? null;
    if (creatureView) {
      const mesh = ensureCreature();
      const { position } = creatureView;
      mesh.group.position.set(position.x, position.y, position.z);
      // Facing: toward the last movement between two snapshots, turned at a fixed rate.
      if (newSnapshot) {
        const last = creatureLastPosition;
        creatureMoving = last !== null && (last.x !== position.x || last.z !== position.z);
        if (last && creatureMoving) creatureTargetFacing = Math.atan2(position.z - last.z, position.x - last.x);
        creatureLastPosition = { ...position };
      }
      const turn = wrapAngle(creatureTargetFacing - creatureFacing);
      creatureFacing = wrapAngle(creatureFacing + Math.sign(turn) * Math.min(Math.abs(turn), CREATURE_TURN_SPEED * deltaSeconds));
      mesh.group.rotation.y = -creatureFacing;
      // Leaning forward is a negative turn about the pose's Z (its +X is the facing).
      const leanStep = (CREATURE_LEAN * deltaSeconds) / FLOAT_RATE_EASE;
      creatureLean += Math.max(-leanStep, Math.min(leanStep, (creatureMoving ? CREATURE_LEAN : 0) - creatureLean));
      mesh.pose.rotation.z = -creatureLean;
      const rate = creatureView.sprinting ? FLOAT_RATE_SPRINT : creatureMoving ? FLOAT_RATE_MOVING : 1;
      mesh.float.timeScale += (rate - mesh.float.timeScale) * Math.min(1, deltaSeconds / FLOAT_RATE_EASE);
      mesh.mixer.update(deltaSeconds);
      // Burning feedback: the whole model glows ember red while the Creature cannot tag.
      mesh.material.emissive.copy(creatureView.burning ? CREATURE_BURNING_TINT : CREATURE_TINT);
      // Stagger feedback: a thick white outline, drawn even with the outline experiment off.
      mesh.outline.visible = VFX.outline || creatureView.staggered;
      mesh.outline.uniforms.vfxOutlineColor.value.set(creatureView.staggered ? STAGGER_OUTLINE_COLOR : '#000000');
      mesh.outline.uniforms.vfxOutlineWidth.value = creatureView.staggered ? STAGGER_OUTLINE_WIDTH : OUTLINE_WIDTH;
      mesh.ring.visible = creatureView.sprinting;
    } else {
      removeCreature();
    }
    renderer.render(scene, camera);
  }

  function resize(width: number, height: number): void {
    renderer.setSize(width, height, false);
    // The outline is a fixed fraction of the view height; its width is corrected by this.
    VFX_UNIFORMS.vfxAspect.value = width / height;
  }

  // Frees this scene's geometry; the renderer is kept when the caller will reuse it for
  // the next map and disposed only when the page goes away.
  function dispose(keepRenderer = false): void {
    // Each fan holds two materials and only one is in the scene at a time.
    for (const mesh of hunters.values()) {
      mesh.flatFan.dispose();
      mesh.lightPool.dispose();
    }
    scene.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    if (!keepRenderer) renderer.dispose();
  }

  return { render, resize, dispose, renderer, aspect: CAMERA.aspect };
}
