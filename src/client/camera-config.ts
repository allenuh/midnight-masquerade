import { GAMEPLAY } from '../shared/gameplay-config.js';

// World axes: X is left/right, Y is height, Z is north/south.
// The fixed aspect ratio is letterboxed on resize, so the camera never tracks or crops the arena.
export const CAMERA = {
  aspect: GAMEPLAY.arena.width / GAMEPLAY.arena.depth,
  position: {
    x: GAMEPLAY.arena.width / 2,
    y: GAMEPLAY.arena.floorY + GAMEPLAY.arena.depth * 1.5,
    z: GAMEPLAY.arena.depth * 1.75,
  },
  target: {
    x: GAMEPLAY.arena.width / 2,
    y: GAMEPLAY.arena.floorY,
    z: GAMEPLAY.arena.depth / 2,
  },
  fieldOfView: 50,
  near: 1,
  far: 5000,
} as const;
