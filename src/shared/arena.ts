import { GAMEPLAY } from './gameplay-config.js';
import type { Position } from './protocol.js';

export type WallBox = { min: Position; max: Position };
const { width, depth, floorY, wallThickness: thickness, wallHeight } = GAMEPLAY.arena;
const top = floorY + wallHeight;

// The renderer and server use the same world-space boxes. The playable floor
// spans X=[0,width], Z=[0,depth]; the four boundary walls sit just outside it.
export const ARENA_WALLS: Record<'west' | 'east' | 'north' | 'south', WallBox> = {
  west: {
    min: { x: -thickness, y: floorY, z: -thickness },
    max: { x: 0, y: top, z: depth + thickness },
  },
  east: {
    min: { x: width, y: floorY, z: -thickness },
    max: { x: width + thickness, y: top, z: depth + thickness },
  },
  north: {
    min: { x: 0, y: floorY, z: -thickness },
    max: { x: width, y: top, z: 0 },
  },
  south: {
    min: { x: 0, y: floorY, z: depth },
    max: { x: width, y: top, z: depth + thickness },
  },
};

const slab = (minX: number, minZ: number, maxX: number, maxZ: number): WallBox => ({
  min: { x: minX, y: floorY, z: minZ },
  max: { x: maxX, y: top, z: maxZ },
});

// Interior blockout: a pinwheel of four slabs around the arena center. Each slab
// stops short of the next one, leaving a 64-unit opening at each corner of the
// central room, so every slab can be circled. This gives corners to ambush from,
// walls that break flashlight line of sight, and loops so nobody is cornered.
// It is a test layout, not the final map.
export const ARENA_OBSTACLES: readonly WallBox[] = [
  slab(320, 140, 560, 140 + thickness), // north slab, opening at its east end
  slab(640 - thickness, 140, 640, 380), // east slab, opening at its south end
  slab(400, 460 - thickness, 640, 460), // south slab, opening at its west end
  slab(320, 220, 320 + thickness, 460), // west slab, opening at its north end
];

// Every solid box: boundary walls first, then obstacles. Used for line of sight,
// rendering, and obstacle collision. Boundary clamping keeps using ARENA_WALLS.
export const WALL_BOXES: readonly WallBox[] = [...Object.values(ARENA_WALLS), ...ARENA_OBSTACLES];
