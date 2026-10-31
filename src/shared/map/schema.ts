// The tile map format, shared by the game runtime and the developer map editor.
// Serialized maps use short integer IDs; every one of them is named here, so no
// other file needs a magic number. Bump MAP_VERSION for any breaking change and
// teach the validator which versions it still understands.
import { GAMEPLAY } from '../gameplay-config.js';

// Version 2 added the floor and wallpaper layers. A version 1 file still loads, with
// every tile's floor and wallpaper Plain. Version 3 added props; an older file loads with none.
export const MAP_VERSION = 3;
export const SUPPORTED_MAP_VERSIONS: readonly number[] = [1, 2, 3];

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

// Finishes are looks only: they never change collision, which `terrain` alone decides.
// Floor is read on every tile that shows floor (today, Open tiles). Wallpaper is read on
// Wall tiles, on every side that faces an Open tile; each tile carries its own, so the two
// faces of a wall two tiles thick can differ. Plain is the untextured blockout colour.
// New finishes get the next free id.
// Two floors are special to the renderer: a Runner draws a border along its region's edge,
// and a Doorway (the threshold rug) also frames the walls beside it with door jambs.
export const FLOOR = {
  plain: 0, starTile: 1, marbleDiamond: 2, terracotta: 3, redCarpet: 4, beigeCarpet: 5, runner: 6, doorway: 7, checker: 8,
} as const;
export type FloorId = (typeof FLOOR)[keyof typeof FLOOR];

export const WALLPAPER = { plain: 0, greenDamask: 1, creamFloral: 2 } as const;
export type WallpaperId = (typeof WALLPAPER)[keyof typeof WALLPAPER];

export const FLOOR_LABELS: Record<FloorId, string> = {
  [FLOOR.plain]: 'Plain',
  [FLOOR.starTile]: 'Star tile',
  [FLOOR.marbleDiamond]: 'Marble diamonds',
  [FLOOR.terracotta]: 'Terracotta',
  [FLOOR.redCarpet]: 'Red carpet',
  [FLOOR.beigeCarpet]: 'Beige carpet',
  [FLOOR.runner]: 'Green runner',
  [FLOOR.doorway]: 'Doorway rug',
  [FLOOR.checker]: 'Mustard check',
};

export const WALLPAPER_LABELS: Record<WallpaperId, string> = {
  [WALLPAPER.plain]: 'Plain',
  [WALLPAPER.greenDamask]: 'Green damask',
  [WALLPAPER.creamFloral]: 'Cream floral',
};

// Props are the furniture and clutter in props.ts, which describes each one. Every tile a
// prop stands on blocks movement and sight like a Wall tile; wall props (the sconces) hang on
// a wall face and block nothing. New props get the next free id.
export const PROP = {
  bookshelf: 1, dresser: 2, cupboard: 3, diningTable: 4, sideTable: 5, storageTable: 6, chair: 7, stool: 8,
  barrelStandard: 9, barrelWeathered: 10, crateStandard: 11, crateDark: 12, candelabra: 13, chamberstick: 14,
  wallCandle: 15, wallCandleDouble: 16,
} as const;
export type PropId = (typeof PROP)[keyof typeof PROP];

// The wall a wall prop hangs on, seen from the Open tile in front of it: north is toward row 0.
export const WALL_SIDES = ['north', 'east', 'south', 'west'] as const;
export type WallSide = (typeof WALL_SIDES)[number];

export const TERRAIN_IDS: readonly TerrainId[] = Object.values(TERRAIN);
export const MARKER_IDS: readonly MarkerId[] = Object.values(MARKER);
export const FLOOR_IDS: readonly FloorId[] = Object.values(FLOOR);
export const WALLPAPER_IDS: readonly WallpaperId[] = Object.values(WALLPAPER);
export const PROP_IDS: readonly PropId[] = Object.values(PROP);

// A playable map must be able to seat a full lobby: one Creature and every Hunter slot,
// each on its own marker. A round may use fewer Hunter spawns than the map declares.
export const MIN_CREATURE_SPAWNS = 1;
export const MIN_HUNTER_SPAWNS = GAMEPLAY.players.hunters;

export const isTerrainId = (value: unknown): value is TerrainId => TERRAIN_IDS.includes(value as TerrainId);
export const isMarkerId = (value: unknown): value is MarkerId => MARKER_IDS.includes(value as MarkerId);
export const isFloorId = (value: unknown): value is FloorId => FLOOR_IDS.includes(value as FloorId);
export const isWallpaperId = (value: unknown): value is WallpaperId => WALLPAPER_IDS.includes(value as WallpaperId);
export const isPropId = (value: unknown): value is PropId => PROP_IDS.includes(value as PropId);
export const isWallSide = (value: unknown): value is WallSide => WALL_SIDES.includes(value as WallSide);

// `x` is the column (0 .. width - 1) and `y` the row (0 .. height - 1).
export type MapMarker = { type: MarkerId; x: number; y: number };

// A prop standing on the floor or on another prop: (x, y) is the top-left tile of its
// footprint as turned, and `rotation` is degrees clockwise as seen from above (in the editor),
// 0 facing +Z, down the grid toward the camera. It stands on whatever an earlier prop in the
// list left on top of its tiles, or on the floor (props.ts).
export type MapProp = { type: PropId; x: number; y: number; rotation: number };
// A wall prop: (x, y) is the Open tile in front of the wall and `side` the wall it hangs on.
export type MapWallProp = { type: PropId; x: number; y: number; side: WallSide };

// `terrain`, `floor` and `wallpaper` are each `height` rows of `width` ids: terrain[y][x].
// Every tile has all three, whatever its terrain, so repainting terrain never loses a
// finish. `boundaryWallpaper` covers the implicit arena boundary's inner faces. `props` are in
// stacking order: a prop is listed after the one it stands on.
export type GameMap = {
  version: number;
  name: string;
  width: number;
  height: number;
  terrain: TerrainId[][];
  floor: FloorId[][];
  wallpaper: WallpaperId[][];
  boundaryWallpaper: WallpaperId;
  markers: MapMarker[];
  props: MapProp[];
  wallProps: MapWallProp[];
};

// The one place grid coordinates become world coordinates. A tile spans
// [x * TILE_SIZE, (x + 1) * TILE_SIZE] on X and the same on Z from its row.
export const tileOrigin = (grid: number): number => grid * TILE_SIZE;
export const tileCenter = (grid: number): number => grid * TILE_SIZE + TILE_SIZE / 2;

export const terrainAt = (map: GameMap, x: number, y: number): TerrainId => map.terrain[y][x];

// A width x height grid holding one value everywhere.
export const filledGrid = <T>(width: number, height: number, value: T): T[][] =>
  Array.from({ length: height }, () => Array.from({ length: width }, () => value));
export const countMarkers = (map: GameMap, type: MarkerId): number =>
  map.markers.filter((marker) => marker.type === type).length;

// A blank map: every tile Open and Plain, no markers or props. The arena's boundary wall is implicit
// (the runtime builds it around the grid), so an all-Open map is already enclosed.
export function createEmptyMap(name: string, width: number, height: number): GameMap {
  return {
    version: MAP_VERSION,
    name,
    width,
    height,
    terrain: filledGrid<TerrainId>(width, height, TERRAIN.open),
    floor: filledGrid<FloorId>(width, height, FLOOR.plain),
    wallpaper: filledGrid<WallpaperId>(width, height, WALLPAPER.plain),
    boundaryWallpaper: WALLPAPER.plain,
    markers: [],
    props: [],
    wallProps: [],
  };
}
