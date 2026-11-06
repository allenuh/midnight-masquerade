// The map's props (src/shared/map/props.ts) as three.js objects: every model in the catalogue is
// loaded once per page, and each scene clones the ones its map places, where props.ts places
// them. Wood, cloth and candle holders are lit like the floors and walls, by the night's light,
// the flashlights and the candles (vfx.ts). Flames keep the file's unlit material, so they glow,
// and each flickers by scaling up and down from its wick (its origin).
import {
  CircleGeometry, Group, MeshLambertMaterial, MeshStandardMaterial, Mesh, type Object3D, type Quaternion, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PROP_IDS, type PropId } from '../shared/map/schema.js';
import { PROP_SPECS, propPlacements, wallPropPlacements } from '../shared/map/props.js';
import { lightOccluders, type World } from '../shared/map/world.js';
import { wallDistance } from '../shared/raycast.js';
import {
  CANDLE_LIGHT, CANDLE_LIGHT_REACH, CANDLE_LIGHT_RAYS, CANDLE_LIGHT_UNIFORMS, MAX_CANDLE_LIGHTS, VFX,
  createHaloMaterial, flashlitPropShader, setCandleLightLists,
} from './vfx.js';

const MODEL_URLS = import.meta.glob<string>('./assets/*.glb', { query: '?url', import: 'default', eager: true });
// The flames, read every frame. Flicker: a flame's height swings by up to FLICKER_STRETCH either
// way, from two waves at FLICKER_RATES (per second) so it never settles into a visible beat; it
// narrows as it stretches. Its light swings by up to LIGHT_FLICKER with the same wave. Each
// candle's halo is a camera-facing disc HALO_RADIUS across its flames' middle, drawn after the
// opaque meshes like the battery halos (scene.ts).
const FLICKER_RATES = [7.3, 17.9];
export const CANDLE_FLAMES = { FLICKER_STRETCH: 0, LIGHT_FLICKER: 0.06, HALO_RADIUS: 2 };
const HALO_RENDER_ORDER = 1;
// A candle's light is cast from no higher than this below the wall tops, so one standing high
// (a candelabra on a table, or on crates) never shines over a wall.
const LIGHT_BELOW_WALL_TOP = 1;

// One model per prop, shared by every scene: a map change removes its clones but never these.
export type PropModels = ReadonlyMap<PropId, Object3D>;

export async function loadPropModels(): Promise<PropModels> {
  const loader = new GLTFLoader();
  const lit = new Map<MeshStandardMaterial, MeshLambertMaterial>();
  const models = await Promise.all(PROP_IDS.map(async (id) => {
    const asset = PROP_SPECS[id].asset;
    const url = MODEL_URLS[`./assets/${asset}.glb`];
    if (!url) throw new Error(`${asset}.glb is missing from src/client/assets/`);
    const { scene } = await loader.loadAsync(url);
    scene.traverse((part) => {
      if (!(part instanceof Mesh) || !(part.material instanceof MeshStandardMaterial)) return;
      const source = part.material;
      if (!lit.has(source)) {
        const material = new MeshLambertMaterial({ name: source.name, map: source.map, color: source.color, side: source.side });
        material.onBeforeCompile = flashlitPropShader;
        lit.set(source, material);
      }
      part.material = lit.get(source)!;
    });
    return [id, scene] as const;
  }));
  return new Map(models);
}

// The flicker of one flame, from -1 to 1.
function flicker(seconds: number, phase: number): number {
  return FLICKER_RATES.reduce((sum, rate, i) => sum + Math.sin(seconds * rate + phase * (i + 1)), 0) / FLICKER_RATES.length;
}

// A scene's props: `update` flickers the flames and their light, and `dispose` takes them out of
// the scene (before the scene frees its own meshes, as the models' are shared). `facing` is the
// camera's turn, which the halos copy.
export function buildProps(world: World, models: PropModels, facing: Quaternion) {
  const group = new Group();
  const flames: { flame: Object3D; phase: number }[] = [];
  // One light and halo per flame, at its `_light_<i>` point (build_candles.py), flickering with
  // `_flame_<i>`. A candle's brightness grows with the square root of its flames, shared between
  // them, so three flames together are brighter than one but not three times as bright.
  const lights: { position: Vector3; flame: number; strength: number; halo: Mesh }[] = [];
  const haloGeometry = new CircleGeometry(1, 16);
  const haloMaterial = createHaloMaterial(CANDLE_LIGHT.CANDLE_LIGHT_COLOR, CANDLE_LIGHT.CANDLE_HALO_INTENSITY);
  for (const placement of [...propPlacements(world.map), ...wallPropPlacements(world.map)]) {
    const model = models.get(placement.type)!.clone();
    model.position.set(placement.position.x, placement.position.y, placement.position.z);
    model.rotation.y = placement.rotation;
    model.updateMatrixWorld(true);
    // Flames and light points by their number.
    const ownFlames = new Map<string, number>();
    const points = new Map<string, Vector3>();
    model.traverse((part) => {
      const [, kind, number] = /_(flame|light)_(\d+)$/.exec(part.name) ?? [];
      if (kind === 'flame') {
        ownFlames.set(number, flames.length);
        flames.push({ flame: part, phase: Math.random() * 2 * Math.PI });
      } else if (kind === 'light') {
        points.set(number, part.getWorldPosition(new Vector3()));
      }
    });
    group.add(model);
    for (const [number, position] of points) {
      const halo = new Mesh(haloGeometry, haloMaterial);
      halo.position.copy(position);
      halo.quaternion.copy(facing);
      halo.renderOrder = HALO_RENDER_ORDER;
      group.add(halo);
      lights.push({ position, flame: ownFlames.get(number) ?? -1, strength: 1 / Math.sqrt(points.size), halo });
    }
  }

  // The first MAX_CANDLE_LIGHTS flames light their surroundings (vfx.ts). They never move, so
  // their rays are measured once, against the walls and the props taller than their flames, out to
  // the largest radius the light may be given.
  if (lights.length > MAX_CANDLE_LIGHTS) {
    console.warn(`This map has ${lights.length} candle lights; only the first ${MAX_CANDLE_LIGHTS} light their surroundings (MAX_CANDLE_LIGHTS in vfx.ts).`);
  }
  const slots = CANDLE_LIGHT_UNIFORMS.candleLights.value;
  for (const slot of slots) slot.set(0, 0, 0, 0);
  const reachData = CANDLE_LIGHT_UNIFORMS.candleLightReach.value.image.data as Float32Array;
  const occluders = lightOccluders(world);
  for (const [index, { position }] of lights.slice(0, MAX_CANDLE_LIGHTS).entries()) {
    const origin = { x: position.x, y: Math.min(position.y, world.floorY + world.wallHeight - LIGHT_BELOW_WALL_TOP), z: position.z };
    for (let ray = 0; ray < CANDLE_LIGHT_RAYS; ray++) {
      const angle = (2 * Math.PI * ray) / CANDLE_LIGHT_RAYS;
      const direction = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      reachData[index * CANDLE_LIGHT_RAYS + ray] = wallDistance(origin, direction, CANDLE_LIGHT_REACH, occluders);
    }
  }
  CANDLE_LIGHT_UNIFORMS.candleLightReach.value.needsUpdate = true;
  // Which of those lights each tile looks at, redone only if the debug menu changes their radius.
  const litPositions = lights.slice(0, MAX_CANDLE_LIGHTS).map(({ position }) => position);
  let listedRadius = -1;

  function update(seconds: number): void {
    const radius = Math.min(CANDLE_LIGHT.CANDLE_LIGHT_RADIUS, CANDLE_LIGHT_REACH);
    if (radius !== listedRadius) {
      listedRadius = radius;
      setCandleLightLists(litPositions, world.map.width, world.map.height, radius);
    }
    haloMaterial.uniforms.haloColor.value.set(CANDLE_LIGHT.CANDLE_LIGHT_COLOR);
    haloMaterial.uniforms.haloIntensity.value = CANDLE_LIGHT.CANDLE_HALO_INTENSITY;
    const waves = flames.map(({ flame, phase }) => {
      const wave = flicker(seconds, phase);
      const stretch = 1 + CANDLE_FLAMES.FLICKER_STRETCH * wave;
      flame.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
      return wave;
    });
    for (const [index, light] of lights.entries()) {
      light.halo.visible = VFX.candleLight;
      light.halo.scale.setScalar(CANDLE_FLAMES.HALO_RADIUS);
      if (index >= MAX_CANDLE_LIGHTS) continue;
      const wave = waves[light.flame] ?? 0;
      const brightness = VFX.candleLight ? light.strength * (1 + CANDLE_FLAMES.LIGHT_FLICKER * wave) : 0;
      slots[index].set(light.position.x, light.position.y, light.position.z, brightness);
    }
  }

  function dispose(): void {
    group.removeFromParent();
    haloGeometry.dispose();
    haloMaterial.dispose();
    for (const slot of slots) slot.set(0, 0, 0, 0);
    CANDLE_LIGHT_UNIFORMS.candleGrid.value.dispose();
  }

  return { group, update, dispose };
}
