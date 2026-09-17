// The tile map format, shared by the game runtime and the developer map editor.
// Serialized maps use short integer IDs; every one of them is named here, so no
// other file needs a magic number. Bump MAP_VERSION for any breaking change and
// teach the validator which versions it still understands.
import { GAMEPLAY } from '../gameplay-config.js';

export const MAP_VERSION = 1;
export const SUPPORTED_MAP_VERSIONS: readonly number[] = [1];

// One tile is this many world units on both ground axes. The grid is the playable
// floor: X grows with the column, Z grows with the row, and Y is height.
export const TILE_SIZE = 20;

// Guard rails against an accidental enormous grid, enforced by the validator.
export const MIN_DIMENSION = 3;
export const MAX_DIMENSION = 100;

// Terrain fills every tile: exactly one id per cell of the grid.
export const TERRAIN = { open: 0, wall: 1 } as const;
export type TerrainId = (typeof TERRAIN)[keyof typeof TERRAIN];

// Markers sit on top of Open terrain; they are never terrain themselves. A tile with
// a battery point is "Open terrain + Battery Spawn marker", which is why they are two
// separate fields in the file. New marker kinds get the next free id.
export const MARKER = { batterySpawn: 1, creatureSpawn: 2, hunterSpawn: 3 } as const;
export type MarkerId = (typeof MARKER)[keyof typeof MARKER];

export const TERRAIN_LABELS: Record<TerrainId, string> = {
  [TERRAIN.open]: 'Open',
  [TERRAIN.wall]: 'Wall',
};

export const MARKER_LABELS: Record<MarkerId, string> = {
  [MARKER.batterySpawn]: 'Battery Spawn',
  [MARKER.creatureSpawn]: 'Creature Spawn',
  [MARKER.hunterSpawn]: 'Hunter Spawn',
};

export const TERRAIN_IDS: readonly TerrainId[] = Object.values(TERRAIN);
export const MARKER_IDS: readonly MarkerId[] = Object.values(MARKER);

// A playable map must be able to seat a full lobby: one Creature and every Hunter slot,
// each on its own marker. A round may use fewer Hunter spawns than the map declares.
export const MIN_CREATURE_SPAWNS = 1;
export const MIN_HUNTER_SPAWNS = GAMEPLAY.players.hunters;

export const isTerrainId = (value: unknown): value is TerrainId => TERRAIN_IDS.includes(value as TerrainId);
export const isMarkerId = (value: unknown): value is MarkerId => MARKER_IDS.includes(value as MarkerId);

// `x` is the column (0 .. width - 1) and `y` the row (0 .. height - 1).
export type MapMarker = { type: MarkerId; x: number; y: number };

// `terrain` is `height` rows, each `width` ids long: terrain[y][x].
export type GameMap = {
  version: number;
  name: string;
  width: number;
  height: number;
  terrain: TerrainId[][];
  markers: MapMarker[];
};

// The one place grid coordinates become world coordinates. A tile spans
// [x * TILE_SIZE, (x + 1) * TILE_SIZE] on X and the same on Z from its row.
export const tileOrigin = (grid: number): number => grid * TILE_SIZE;
export const tileCenter = (grid: number): number => grid * TILE_SIZE + TILE_SIZE / 2;

export const terrainAt = (map: GameMap, x: number, y: number): TerrainId => map.terrain[y][x];
export const countMarkers = (map: GameMap, type: MarkerId): number =>
  map.markers.filter((marker) => marker.type === type).length;

// A blank map: every tile Open, no markers. The arena's boundary wall is implicit
// (the runtime builds it around the grid), so an all-Open map is already enclosed.
export function createEmptyMap(name: string, width: number, height: number): GameMap {
  return {
    version: MAP_VERSION,
    name,
    width,
    height,
    terrain: Array.from({ length: height }, () => Array.from({ length: width }, (): TerrainId => TERRAIN.open)),
    markers: [],
  };
}
