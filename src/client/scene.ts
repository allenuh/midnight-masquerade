import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { ARENA_WALLS } from '../shared/arena.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { ServerMessage } from '../shared/protocol.js';
import { CAMERA } from './camera-config.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;

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

  // Render the same 3D boundary boxes used by the authoritative collision rules.
  for (const { min, max } of Object.values(ARENA_WALLS)) {
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

  const hunter = new Mesh(
    new SphereGeometry(GAMEPLAY.playerRadius, 16, 12),
    new MeshLambertMaterial({ color: '#e6e7e4' }),
  );
  hunter.visible = false;
  scene.add(hunter);
  let creature: Mesh<OctahedronGeometry, MeshLambertMaterial> | null = null;

  function render(snapshot: Snapshot | null): void {
    hunter.visible = !!snapshot?.hunter;
    if (snapshot?.hunter) {
      hunter.position.set(snapshot.hunter.x, snapshot.hunter.y, snapshot.hunter.z);
    }

    // Hunter payloads contain no Creature transform. Only the Creature role creates its mesh;
    // there is no hidden mesh, shadow, or reflection on a Hunter client.
    if (snapshot?.role === 'creature') {
      if (!creature) {
        creature = new Mesh(
          new OctahedronGeometry(GAMEPLAY.playerRadius),
          new MeshLambertMaterial({ color: '#df9460', flatShading: true }),
        );
        scene.add(creature);
      }
      creature.position.set(snapshot.creature.x, snapshot.creature.y, snapshot.creature.z);
    } else if (creature) {
      scene.remove(creature);
      creature.geometry.dispose();
      creature.material.dispose();
      creature = null;
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
