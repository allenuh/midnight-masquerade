import type { World } from '../shared/map/world.js';

// Camera offset from its target, in multiples of the map depth: `height` up and `back`
// toward +Z. `distance` scales that offset (smaller = closer). `targetShift` moves the aim
// point toward +Z so the perspective trapezoid sits centred. `aspectStretch` widens the
// canvas past the map's own width/depth, because the tilted floor projects shorter than it
// is wide. With these values every map in maps/ fills about 93% of the canvas, walls included.
const FRAMING = { height: 1.5, back: 0.65, distance: 0.71, targetShift: 0.075, aspectStretch: 1.3 };

// World axes: X is left/right, Y is height, Z is north/south.
// The fixed aspect ratio is letterboxed on resize, so the camera never tracks or crops the
// arena. Framing follows the room's map, so any map the host picks is fully in view.
export function cameraFor(world: World) {
  const { width, depth, floorY } = world;
  const targetZ = depth / 2 + FRAMING.targetShift * depth;
  return {
    aspect: (width / depth) * FRAMING.aspectStretch,
    position: {
      x: width / 2,
      y: floorY + FRAMING.height * FRAMING.distance * depth,
      z: targetZ + FRAMING.back * FRAMING.distance * depth,
    },
    target: {
      x: width / 2,
      y: floorY,
      z: targetZ,
    },
    fieldOfView: 50,
    near: 1,
    far: 5000,
  } as const;
}

export type Camera = ReturnType<typeof cameraFor>;
