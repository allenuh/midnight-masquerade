import { GAMEPLAY } from '../gameplay-config.js';
import type { Position } from '../protocol.js';
import { MARKER, TERRAIN, TILE_SIZE, tileCenter, tileOrigin, type GameMap, type MarkerId } from './schema.js';

// Turns a validated map into the 3D world the game already knows how to use: axis
// aligned wall boxes plus the world positions each marker kind declares. Pure, so the
// editor could preview it and the tests can build a world from a literal map.

export type WallBox = { min: Position; max: Position };
export type BoundaryWalls = Record<'west' | 'east' | 'north' | 'south', WallBox>;

export type World = {
  map: GameMap;
  // Playable floor size in world units; the grid is the floor, the boundary is outside it.
  width: number;
  depth: number;
  floorY: number;
  wallThickness: number;
  wallHeight: number;
  walls: BoundaryWalls;
  // Interior walls from the map's Wall tiles, merged into as few boxes as possible.
  obstacles: readonly WallBox[];
  // Boundary walls first, then obstacles: line of sight, rendering, and collision.
  wallBoxes: readonly WallBox[];
  batterySpawns: readonly Position[];
  creatureSpawns: readonly Position[];
  hunterSpawns: readonly Position[];
};

// Greedy rectangle merge over the Wall tiles: take the first unclaimed tile, extend it
// right while the row stays wall, then down while the whole run stays wall. A slab of
// 200 tiles becomes one box, which keeps the per-tick collision loop and the flashlight
// fan cheap and leaves no seams inside a wall for the sphere push-out to catch on.
function mergeWallRectangles(map: GameMap): { x: number; y: number; width: number; height: number }[] {
  const claimed = map.terrain.map((row) => row.map(() => false));
  const rectangles: { x: number; y: number; width: number; height: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.terrain[y][x] !== TERRAIN.wall || claimed[y][x]) continue;
      let width = 1;
      while (x + width < map.width && map.terrain[y][x + width] === TERRAIN.wall && !claimed[y][x + width]) width++;
      let height = 1;
      while (y + height < map.height) {
        let full = true;
        for (let step = 0; step < width && full; step++) {
          full = map.terrain[y + height][x + step] === TERRAIN.wall && !claimed[y + height][x + step];
        }
        if (!full) break;
        height++;
      }
      for (let row = y; row < y + height; row++) {
        for (let column = x; column < x + width; column++) claimed[row][column] = true;
      }
      rectangles.push({ x, y, width, height });
    }
  }
  return rectangles;
}

export function buildWorld(map: GameMap): World {
  const { floorY, wallThickness: thickness, wallHeight } = GAMEPLAY.arena;
  const width = map.width * TILE_SIZE;
  const depth = map.height * TILE_SIZE;
  const top = floorY + wallHeight;

  // The boundary is implicit: maps describe the floor, and these four walls enclose it.
  const walls: BoundaryWalls = {
    west: { min: { x: -thickness, y: floorY, z: -thickness }, max: { x: 0, y: top, z: depth + thickness } },
    east: { min: { x: width, y: floorY, z: -thickness }, max: { x: width + thickness, y: top, z: depth + thickness } },
    north: { min: { x: 0, y: floorY, z: -thickness }, max: { x: width, y: top, z: 0 } },
    south: { min: { x: 0, y: floorY, z: depth }, max: { x: width, y: top, z: depth + thickness } },
  };

  const obstacles: WallBox[] = mergeWallRectangles(map).map((rectangle) => ({
    min: { x: tileOrigin(rectangle.x), y: floorY, z: tileOrigin(rectangle.y) },
    max: { x: tileOrigin(rectangle.x + rectangle.width), y: top, z: tileOrigin(rectangle.y + rectangle.height) },
  }));

  // Markers become grounded world positions at the centre of their tile, in file order:
  // that order is what the battery pickup index on the wire refers to.
  const positionsOf = (type: MarkerId): Position[] => map.markers
    .filter((marker) => marker.type === type)
    .map((marker) => ({ x: tileCenter(marker.x), y: floorY + GAMEPLAY.playerRadius, z: tileCenter(marker.y) }));

  return {
    map,
    width,
    depth,
    floorY,
    wallThickness: thickness,
    wallHeight,
    walls,
    obstacles,
    wallBoxes: [...Object.values(walls), ...obstacles],
    batterySpawns: positionsOf(MARKER.batterySpawn),
    creatureSpawns: positionsOf(MARKER.creatureSpawn),
    hunterSpawns: positionsOf(MARKER.hunterSpawn),
  };
}
