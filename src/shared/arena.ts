import { GAMEPLAY } from './gameplay-config.js';
import type { Position } from './protocol.js';

type WallBox = { min: Position; max: Position };
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
