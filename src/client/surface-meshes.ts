// Floor and wall finishes as three.js meshes: the textures in assets/textures/ (painted by
// art/textures/paint_textures.py) on the quads mapSurfaces() lays out. Plain finishes keep
// the blockout colours, so an untextured map such as the test arena looks exactly as before.
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, Group, LinearFilter, LinearMipmapLinearFilter, Mesh,
  MeshLambertMaterial, NearestFilter, NearestMipmapNearestFilter, RedFormat, RepeatWrapping, SRGBColorSpace,
  type Texture, TextureLoader, type WebGLProgramParametersWithUniforms,
} from 'three';
import { FLOOR, TERRAIN, TILE_SIZE, WALLPAPER, type FloorId, type WallpaperId } from '../shared/map/schema.js';
import type { World } from '../shared/map/world.js';
import { mapSurfaces, regionMask, type Quad, type RegionMask } from './surfaces.js';
import starTileUrl from './assets/textures/floor-star-tile.png?url';
import marbleDiamondUrl from './assets/textures/floor-marble-diamond.png?url';
import terracottaUrl from './assets/textures/floor-terracotta.png?url';
import redCarpetUrl from './assets/textures/floor-red-carpet.png?url';
import beigeCarpetUrl from './assets/textures/floor-beige-carpet.png?url';
import runnerUrl from './assets/textures/floor-runner.png?url';
import doorwayUrl from './assets/textures/floor-doorway.png?url';
import checkerUrl from './assets/textures/floor-checker.png?url';
import greenDamaskUrl from './assets/textures/wall-green-damask.png?url';
import creamFloralUrl from './assets/textures/wall-cream-floral.png?url';
import doorFrameUrl from './assets/textures/wall-door-frame.png?url';
import wallTopUrl from './assets/textures/wall-top-wood.png?url';
import runnerProfileUrl from './assets/textures/profile-runner.png?url';
import doorwayProfileUrl from './assets/textures/profile-doorway.png?url';
import capProfileUrl from './assets/textures/profile-cap.png?url';

const PLAIN_FLOOR = '#303a33';
const PLAIN_WALL = '#7c857d';
// Textured surfaces are multiplied by this grey, so cream tile and paper sit in the same dim
// range as the blockout and the flashlights' pools of light still read on them.
const SURFACE_TINT = new Color(0.45, 0.45, 0.45);
// Border bands, in world units from the region's edge: the runner's gold border, the doorway
// rug's dark edge, and the crown moulding seen along the top of every textured wall.
const RUNNER_BORDER = 9;
const DOORWAY_BORDER = 4;
const CAP_MOULDING = 4;

const FLOOR_URLS: Record<Exclude<FloorId, typeof FLOOR.plain>, string> = {
  [FLOOR.starTile]: starTileUrl,
  [FLOOR.marbleDiamond]: marbleDiamondUrl,
  [FLOOR.terracotta]: terracottaUrl,
  [FLOOR.redCarpet]: redCarpetUrl,
  [FLOOR.beigeCarpet]: beigeCarpetUrl,
  [FLOOR.runner]: runnerUrl,
  [FLOOR.doorway]: doorwayUrl,
  [FLOOR.checker]: checkerUrl,
};
const WALLPAPER_URLS: Record<Exclude<WallpaperId, typeof WALLPAPER.plain>, string> = {
  [WALLPAPER.greenDamask]: greenDamaskUrl,
  [WALLPAPER.creamFloral]: creamFloralUrl,
};

// Loaded once per page and shared by every scene: a map change disposes its materials and
// geometry but never these.
export type SurfaceTextures = {
  floor: Map<FloorId, Texture>;
  wallpaper: Map<WallpaperId, Texture>;
  // Door jambs and casings cut into any textured wallpaper.
  frame: Texture;
  // The cap on top of every textured wall, and around the boundary of a textured map.
  cap: Texture;
  // Border profiles: 32 x 1 strips read across a border band (see bordered()).
  profiles: { runner: Texture; doorway: Texture; cap: Texture };
};

export async function loadSurfaceTextures(): Promise<SurfaceTextures> {
  const loader = new TextureLoader();
  const load = async (url: string) => {
    const texture = await loader.loadAsync(url);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    return texture;
  };
  // A profile is read once across, never tiled or seen from far off: no wrap, no mipmaps.
  const loadProfile = async (url: string) => {
    const texture = await loader.loadAsync(url);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    return texture;
  };
  const entries = async <K>(urls: Record<number, string>) =>
    new Map(await Promise.all(Object.entries(urls).map(async ([id, url]) => [Number(id) as K, await load(url)] as const)));
  const [floor, wallpaper, frame, cap, runner, doorway, capProfile] = await Promise.all([
    entries<FloorId>(FLOOR_URLS), entries<WallpaperId>(WALLPAPER_URLS), load(doorFrameUrl), load(wallTopUrl),
    loadProfile(runnerProfileUrl), loadProfile(doorwayProfileUrl), loadProfile(capProfileUrl),
  ]);
  return { floor, wallpaper, frame, cap, profiles: { runner, doorway, cap: capProfile } };
}

// Bilinear with mipmaps (soft, PS2 / Wii era) or nearest (hard texels, PS1 era). Applied to
// the shared textures, so it takes effect in every scene at once.
let pixelated: boolean | null = null;
export function setPixelTextures(textures: SurfaceTextures, pixel: boolean): void {
  if (pixel === pixelated) return;
  pixelated = pixel;
  for (const texture of [...textures.floor.values(), ...textures.wallpaper.values(), textures.frame, textures.cap]) {
    texture.magFilter = pixel ? NearestFilter : LinearFilter;
    texture.minFilter = pixel ? NearestMipmapNearestFilter : LinearMipmapLinearFilter;
    texture.needsUpdate = true;
  }
}

function geometryOf(quads: Quad[]): BufferGeometry {
  const positions = new Float32Array(quads.length * 12);
  const normals = new Float32Array(quads.length * 12);
  const uvs = new Float32Array(quads.length * 8);
  const index = new Uint32Array(quads.length * 6);
  quads.forEach((quad, q) => {
    quad.corners.forEach((corner, c) => {
      positions.set([corner.x, corner.y, corner.z], q * 12 + c * 3);
      normals.set([quad.normal.x, quad.normal.y, quad.normal.z], q * 12 + c * 3);
      uvs.set(quad.uv[c], q * 8 + c * 2);
    });
    index.set([0, 1, 2, 0, 2, 3].map((corner) => q * 4 + corner), q * 6);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

const textured = (map: Texture) => new MeshLambertMaterial({ map, color: SURFACE_TINT });

function maskTexture(mask: RegionMask): DataTexture {
  const texture = new DataTexture(mask.data.map((flag) => flag * 255), mask.width, mask.height, RedFormat);
  texture.needsUpdate = true;
  return texture;
}

// A band along the edge of a tile region, drawn into a textured material: each fragment finds
// its tile, looks at the region mask in the 3 x 3 tiles around it, and takes its distance to
// the nearest tile outside the region (to that tile's edge, or for a diagonal one to its
// corner, which squares off inside corners). Within `width` of the edge the colour comes from
// the profile strip at that distance, keeping the field texture's grain; the profile's alpha
// lets the field show through where it ends. `outside` is what the mask reads beyond the grid.
function bordered(material: MeshLambertMaterial, mask: DataTexture, profile: Texture, width: number, outside: number) {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, {
      borderMask: { value: mask },
      borderProfile: { value: profile },
      borderWidth: { value: width },
      borderOutside: { value: outside },
      borderTile: { value: TILE_SIZE },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBorderWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvBorderWorld = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vBorderWorld;
uniform sampler2D borderMask;
uniform sampler2D borderProfile;
uniform float borderWidth;
uniform float borderOutside;
uniform float borderTile;
float borderIn(ivec2 cell) {
  ivec2 size = textureSize(borderMask, 0);
  if (cell.x < 0 || cell.y < 0 || cell.x >= size.x || cell.y >= size.y) return borderOutside;
  return texelFetch(borderMask, cell, 0).r;
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 inTiles = vBorderWorld / borderTile;
  ivec2 cell = ivec2(floor(inTiles));
  vec2 f = (inTiles - vec2(cell)) * borderTile;
  vec2 g = vec2(borderTile) - f;
  float d = 1e4;
  if (borderIn(cell + ivec2(-1, 0)) < 0.5) d = min(d, f.x);
  if (borderIn(cell + ivec2(1, 0)) < 0.5) d = min(d, g.x);
  if (borderIn(cell + ivec2(0, -1)) < 0.5) d = min(d, f.y);
  if (borderIn(cell + ivec2(0, 1)) < 0.5) d = min(d, g.y);
  if (borderIn(cell + ivec2(-1, -1)) < 0.5) d = min(d, max(f.x, f.y));
  if (borderIn(cell + ivec2(1, -1)) < 0.5) d = min(d, max(g.x, f.y));
  if (borderIn(cell + ivec2(-1, 1)) < 0.5) d = min(d, max(f.x, g.y));
  if (borderIn(cell + ivec2(1, 1)) < 0.5) d = min(d, max(g.x, g.y));
  if (d < borderWidth) {
    vec4 band = texture2D(borderProfile, vec2(d / borderWidth, 0.5));
    const vec3 luma = vec3(0.299, 0.587, 0.114);
    float grain = dot(texture2D(map, vMapUv).rgb, luma) / max(dot(textureLod(map, vMapUv, 12.0).rgb, luma), 1e-3);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * band.rgb * clamp(grain, 0.6, 1.4), band.a);
  }
}`);
  };
  return material;
}

// One mesh per finish: every floor tile of one style, every wall face of one wallpaper, and
// every cap of one wallpaper are each a single draw. `dispose` frees what this map made (its
// region masks); the shared textures stay.
export function buildSurfaceMeshes(world: World, textures: SurfaceTextures): { group: Group; dispose: () => void } {
  const { map } = world;
  const surfaces = mapSurfaces(world);
  const group = new Group();
  const masks: DataTexture[] = [];
  const maskOf = (inRegion: (x: number, y: number) => boolean) => {
    const texture = maskTexture(regionMask(map, inRegion));
    masks.push(texture);
    return texture;
  };
  const add = (quads: Quad[], material: MeshLambertMaterial) => group.add(new Mesh(geometryOf(quads), material));
  for (const [floor, quads] of surfaces.floor) {
    const texture = textures.floor.get(floor);
    if (!texture) {
      add(quads, new MeshLambertMaterial({ color: PLAIN_FLOOR }));
      continue;
    }
    const material = textured(texture);
    const inFinish = (x: number, y: number) => map.terrain[y][x] === TERRAIN.open && map.floor[y][x] === floor;
    if (floor === FLOOR.runner) bordered(material, maskOf(inFinish), textures.profiles.runner, RUNNER_BORDER, 0);
    if (floor === FLOOR.doorway) bordered(material, maskOf(inFinish), textures.profiles.doorway, DOORWAY_BORDER, 0);
    add(quads, material);
  }
  for (const [wallpaper, quads] of surfaces.wall) {
    const texture = textures.wallpaper.get(wallpaper);
    add(quads, texture ? textured(texture) : new MeshLambertMaterial({ color: PLAIN_WALL }));
  }
  for (const [wallpaper, quads] of surfaces.frame) {
    add(quads, wallpaper === WALLPAPER.plain ? new MeshLambertMaterial({ color: PLAIN_WALL }) : textured(textures.frame));
  }
  // Caps share one mask: every Wall tile, with the boundary beyond the grid counting as wall,
  // so the moulding runs along every cap edge above an exposed face and nowhere else.
  let walls: DataTexture | null = null;
  for (const [wallpaper, quads] of surfaces.top) {
    if (wallpaper === WALLPAPER.plain) {
      add(quads, new MeshLambertMaterial({ color: PLAIN_WALL }));
      continue;
    }
    walls ??= maskOf((x, y) => map.terrain[y][x] === TERRAIN.wall);
    add(quads, bordered(textured(textures.cap), walls, textures.profiles.cap, CAP_MOULDING, 1));
  }
  return { group, dispose: () => { for (const texture of masks) texture.dispose(); } };
}
