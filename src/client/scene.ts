import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { flashlightRange } from '../shared/flashlight.js';
import type { Tuning } from '../shared/tuning.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { World } from '../shared/map/world.js';
import type { HunterId, Position, ServerMessage } from '../shared/protocol.js';
import { wallDistance } from '../shared/raycast.js';
import { cameraFor } from './camera-config.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
// Rays across the cone for the drawn flashlight fan. Purely visual resolution.
const FAN_RAYS = 32;
// Flat Hunter colours: the viewer's own Hunter, every other Hunter, and a downed Hunter.
const SELF_COLOR = '#e6e7e4';
const TEAMMATE_COLOR = '#8fa3b8';
const DOWN_COLOR = '#8a3a4a';
// A downed Hunter is the same sphere squashed flat onto the floor.
const DOWN_HEIGHT = 0.35;
// The Creature's body, and the red it turns while burning (unable to tag).
const CREATURE_COLOR = '#df9460';
const CREATURE_BURNING_COLOR = '#d23a2a';
// Battery pickup: a small upright block, deliberately unlike any player colour.
const PICKUP_COLOR = '#6f9a52';
const PICKUP_SIZE = { x: 14, y: 18, z: 14 };

// One scene per map: the world the room plays on is fixed for the scene's lifetime, and a
// map change disposes it and builds another (see main.ts). `renderer` may be handed over
// from the previous scene so a map switch never creates a second WebGL context.
export function createScene(canvas: HTMLCanvasElement, world: World, existingRenderer?: WebGLRenderer) {
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

  // Battery pickups: one block per Battery Spawn marker the map declares, shown while the
  // server lists that point as active. Both roles see the same set, in the same order the
  // server uses, so a pickup index means the same thing on every client.
  const pickups = world.batterySpawns.map(({ x, z }) => {
    const mesh = new Mesh(
      new BoxGeometry(PICKUP_SIZE.x, PICKUP_SIZE.y, PICKUP_SIZE.z),
      new MeshLambertMaterial({ color: PICKUP_COLOR }),
    );
    mesh.position.set(x, world.floorY + PICKUP_SIZE.y / 2, z);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });

  // Hunter: sphere plus a small dark nose so the facing reads even with the light off,
  // and a flashlight fan of its own. The nose points along local +X; the group is
  // rotated to the server's facing angle. One set per Hunter slot, created on demand.
  type HunterMesh = {
    group: Group; body: Mesh; material: MeshLambertMaterial; nose: Mesh;
    fan: Mesh; fanPositions: Float32Array; fanGeometry: BufferGeometry;
  };
  const hunters = new Map<HunterId, HunterMesh>();

  function ensureHunter(id: HunterId): HunterMesh {
    const existing = hunters.get(id);
    if (existing) return existing;
    const group = new Group();
    const material = new MeshLambertMaterial({ color: SELF_COLOR });
    const body = new Mesh(new SphereGeometry(GAMEPLAY.playerRadius, 16, 12), material);
    group.add(body);
    const nose = new Mesh(new BoxGeometry(10, 6, 6), new MeshLambertMaterial({ color: '#2b2f2c' }));
    nose.position.set(GAMEPLAY.playerRadius, 0, 0);
    group.add(nose);
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
    const fan = new Mesh(fanGeometry, new MeshBasicMaterial({
      color: '#f2e8a8', transparent: true, opacity: 0.35, side: DoubleSide, depthWrite: false,
    }));
    fan.visible = false;
    scene.add(fan);

    const mesh = { group, body, material, nose, fan, fanPositions, fanGeometry };
    hunters.set(id, mesh);
    return mesh;
  }

  // `range` is the battery stage's reach, so the drawn fan shortens exactly when the
  // authoritative cone does: that shortening is the stage feedback.
  function updateFan(mesh: HunterMesh, origin: Position, facing: number, range: number, coneAngle: number): void {
    const halfAngle = (coneAngle / 2) * (Math.PI / 180);
    const floorHeight = GAMEPLAY.arena.floorY + 1;
    const { fanPositions, fanGeometry } = mesh;
    fanPositions[0] = origin.x;
    fanPositions[1] = floorHeight;
    fanPositions[2] = origin.z;
    for (let ray = 0; ray <= FAN_RAYS; ray++) {
      const angle = facing - halfAngle + (2 * halfAngle * ray) / FAN_RAYS;
      const direction = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      const reach = wallDistance(origin, direction, range, world.wallBoxes);
      const offset = (ray + 1) * 3;
      fanPositions[offset] = origin.x + direction.x * reach;
      fanPositions[offset + 1] = floorHeight;
      fanPositions[offset + 2] = origin.z + direction.z * reach;
    }
    fanGeometry.attributes.position.needsUpdate = true;
    fanGeometry.computeBoundingSphere();
  }

  // The Creature mesh exists only while this client holds a Creature position:
  // always for the Creature itself, and for a Hunter only while the server
  // says the Creature is revealed. There is no hidden mesh, shadow, or reflection.
  let creature: { group: Group; material: MeshLambertMaterial; outline: Mesh; ring: Mesh } | null = null;

  function ensureCreature(): { group: Group; material: MeshLambertMaterial; outline: Mesh; ring: Mesh } {
    if (creature) return creature;
    const group = new Group();
    const material = new MeshLambertMaterial({ color: CREATURE_COLOR, flatShading: true });
    group.add(new Mesh(new OctahedronGeometry(GAMEPLAY.playerRadius), material));
    // Stagger feedback: a white wireframe shell around the same shape.
    const outline = new Mesh(
      new OctahedronGeometry(GAMEPLAY.playerRadius + 3),
      new MeshBasicMaterial({ color: '#ffffff', wireframe: true }),
    );
    outline.visible = false;
    group.add(outline);
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
    creature = { group, material, outline, ring };
    return creature;
  }

  function removeCreature(): void {
    if (!creature) return;
    scene.remove(creature.group);
    creature.group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    creature = null;
  }

  // `tuning` is the room's: the fan's length and width follow the values the server plays by.
  function render(snapshot: Snapshot | null, tuning: Tuning): void {
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
      mesh.material.color.set(view.down ? DOWN_COLOR : view.id === self ? SELF_COLOR : TEAMMATE_COLOR);
      // Down: squash the sphere onto the floor and hide the nose; it cannot turn or shine.
      mesh.body.scale.y = view.down ? DOWN_HEIGHT : 1;
      mesh.body.position.y = view.down ? -GAMEPLAY.playerRadius * (1 - DOWN_HEIGHT) : 0;
      mesh.nose.visible = !view.down;
      // `light` is already false on an empty battery, so a depleted flashlight draws nothing.
      mesh.fan.visible = view.light;
      if (view.light) updateFan(mesh, view.position, view.facing, flashlightRange(view.battery, tuning), tuning.flashlightConeAngle);
    }
    for (const [index, mesh] of pickups.entries()) mesh.visible = snapshot?.pickups.includes(index) ?? false;

    const creatureView = snapshot?.role === 'creature'
      ? { position: snapshot.creature, staggered: snapshot.staggered, sprinting: snapshot.sprinting, burning: snapshot.burning }
      : snapshot?.creature ?? null;
    if (creatureView) {
      const { group, material, outline, ring } = ensureCreature();
      group.position.set(creatureView.position.x, creatureView.position.y, creatureView.position.z);
      // Burning feedback: the body itself turns red while the Creature cannot tag.
      material.color.set(creatureView.burning ? CREATURE_BURNING_COLOR : CREATURE_COLOR);
      outline.visible = creatureView.staggered;
      ring.visible = creatureView.sprinting;
    } else {
      removeCreature();
    }
    renderer.render(scene, camera);
  }

  function resize(width: number, height: number): void {
    renderer.setSize(width, height, false);
  }

  // Frees this scene's geometry; the renderer is kept when the caller will reuse it for
  // the next map and disposed only when the page goes away.
  function dispose(keepRenderer = false): void {
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
