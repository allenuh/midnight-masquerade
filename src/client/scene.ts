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
import { WALL_BOXES } from '../shared/arena.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { Position, ServerMessage } from '../shared/protocol.js';
import { wallDistance } from '../shared/raycast.js';
import { CAMERA } from './camera-config.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
// Rays across the cone for the drawn flashlight fan. Purely visual resolution.
const FAN_RAYS = 32;

export function createScene(canvas: HTMLCanvasElement) {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color('#161918');

  const camera = new PerspectiveCamera(CAMERA.fieldOfView, CAMERA.aspect, CAMERA.near, CAMERA.far);
  camera.position.set(CAMERA.position.x, CAMERA.position.y, CAMERA.position.z);
  // Target determines the fixed rotation; no client movement or input controls this camera.
  camera.lookAt(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z);

  const floor = new Mesh(
    new PlaneGeometry(GAMEPLAY.arena.width, GAMEPLAY.arena.depth),
    new MeshLambertMaterial({ color: '#303a33' }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(GAMEPLAY.arena.width / 2, GAMEPLAY.arena.floorY, GAMEPLAY.arena.depth / 2);
  scene.add(floor);

  // Render the same 3D boxes used by the authoritative collision and line-of-sight rules.
  for (const { min, max } of WALL_BOXES) {
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

  // Hunter: sphere plus a small dark nose so the facing reads even with the light off.
  // The nose points along local +X; the group is rotated to the server's facing angle.
  const hunter = new Group();
  hunter.add(new Mesh(
    new SphereGeometry(GAMEPLAY.playerRadius, 16, 12),
    new MeshLambertMaterial({ color: '#e6e7e4' }),
  ));
  const nose = new Mesh(new BoxGeometry(10, 6, 6), new MeshLambertMaterial({ color: '#2b2f2c' }));
  nose.position.set(GAMEPLAY.playerRadius, 0, 0);
  hunter.add(nose);
  hunter.visible = false;
  scene.add(hunter);

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

  function updateFan(origin: Position, facing: number): void {
    const halfAngle = (GAMEPLAY.flashlight.coneAngle / 2) * (Math.PI / 180);
    const floorHeight = GAMEPLAY.arena.floorY + 1;
    fanPositions[0] = origin.x;
    fanPositions[1] = floorHeight;
    fanPositions[2] = origin.z;
    for (let ray = 0; ray <= FAN_RAYS; ray++) {
      const angle = facing - halfAngle + (2 * halfAngle * ray) / FAN_RAYS;
      const direction = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      const reach = wallDistance(origin, direction, GAMEPLAY.flashlight.range);
      const offset = (ray + 1) * 3;
      fanPositions[offset] = origin.x + direction.x * reach;
      fanPositions[offset + 1] = floorHeight;
      fanPositions[offset + 2] = origin.z + direction.z * reach;
    }
    fanGeometry.attributes.position.needsUpdate = true;
    fanGeometry.computeBoundingSphere();
  }

  // The Creature mesh exists only while this client holds a Creature position:
  // always for the Creature itself, and for the Hunter only while the server
  // says the Creature is revealed. There is no hidden mesh, shadow, or reflection.
  let creature: { group: Group; outline: Mesh; ring: Mesh } | null = null;

  function ensureCreature(): { group: Group; outline: Mesh; ring: Mesh } {
    if (creature) return creature;
    const group = new Group();
    group.add(new Mesh(
      new OctahedronGeometry(GAMEPLAY.playerRadius),
      new MeshLambertMaterial({ color: '#df9460', flatShading: true }),
    ));
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
    creature = { group, outline, ring };
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

  function render(snapshot: Snapshot | null): void {
    const hunterPosition = snapshot?.hunter ?? null;
    const facing = snapshot?.role === 'hunter' ? snapshot.facing : snapshot?.hunterFacing ?? null;
    const lightOn = snapshot?.role === 'hunter' ? snapshot.light : snapshot?.hunterLight ?? false;
    hunter.visible = !!hunterPosition;
    if (hunterPosition) {
      hunter.position.set(hunterPosition.x, hunterPosition.y, hunterPosition.z);
      // A positive rotation about Y turns local +X toward -Z; the facing angle runs +X toward +Z.
      hunter.rotation.y = -(facing ?? 0);
    }
    fan.visible = !!hunterPosition && facing !== null && lightOn;
    if (hunterPosition && facing !== null && lightOn) updateFan(hunterPosition, facing);

    const creatureView = snapshot?.role === 'creature'
      ? { position: snapshot.creature, staggered: snapshot.staggered, sprinting: snapshot.sprinting }
      : snapshot?.creature ?? null;
    if (creatureView) {
      const { group, outline, ring } = ensureCreature();
      group.position.set(creatureView.position.x, creatureView.position.y, creatureView.position.z);
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

  function dispose(): void {
    scene.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    renderer.dispose();
  }

  return { render, resize, dispose };
}
