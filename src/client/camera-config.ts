import type { World } from '../shared/map/world.js';

// `pitchDegrees` is how steeply the camera looks down (90 = straight down). `fieldOfView` is
// the vertical lens angle: narrower means less perspective stretch toward the edges and less
// outward lean on tall models, from a camera further away. `distance` is how far it sits
// from its target, in multiples of the map depth (smaller = closer). `targetShift` moves the
// aim point toward +Z so the perspective trapezoid sits centred. `aspectStretch` widens the
// canvas past the map's own width/depth, because the tilted floor projects shorter than it is
// wide. Change the pitch or the field of view and the last three need refitting together:
// with these values every map in maps/ fills about 94% of the canvas, walls included.
const FRAMING = { pitchDegrees: 71.6, fieldOfView: 30, distance: 2.15, targetShift: 0.015, aspectStretch: 1.11 };

// World axes: X is left/right, Y is height, Z is north/south.
// The fixed aspect ratio is letterboxed on resize, so the camera never tracks or crops the
// arena. Framing follows the room's map, so any map the host picks is fully in view.
export function cameraFor(world: World) {
  const { width, depth, floorY } = world;
  const targetZ = depth / 2 + FRAMING.targetShift * depth;
  const pitch = FRAMING.pitchDegrees * (Math.PI / 180);
  return {
    aspect: (width / depth) * FRAMING.aspectStretch,
    position: {
      x: width / 2,
      y: floorY + Math.sin(pitch) * FRAMING.distance * depth,
      z: targetZ + Math.cos(pitch) * FRAMING.distance * depth,
    },
    target: {
      x: width / 2,
      y: floorY,
      z: targetZ,
    },
    fieldOfView: FRAMING.fieldOfView,
    near: 1,
    far: 5000,
  } as const;
}

export type Camera = ReturnType<typeof cameraFor>;
