import type { World } from '../shared/map/world.js';

// World axes: X is left/right, Y is height, Z is north/south.
// The fixed aspect ratio is letterboxed on resize, so the camera never tracks or crops the
// arena. Framing follows the room's map, so any map the host picks is fully in view.
export function cameraFor(world: World) {
  const { width, depth, floorY } = world;
  return {
    aspect: width / depth,
    position: {
      x: width / 2,
      y: floorY + depth * 1.5,
      z: depth * 1.15,
    },
    target: {
      x: width / 2,
      y: floorY,
      z: depth / 2,
    },
    fieldOfView: 50,
    near: 1,
    far: 5000,
  } as const;
}

export type Camera = ReturnType<typeof cameraFor>;
