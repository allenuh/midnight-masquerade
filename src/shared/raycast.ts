import { WALL_BOXES, type WallBox } from './arena.js';
import type { Position } from './protocol.js';

// Straight-line queries against axis-aligned wall boxes. Shared so the server's
// flashlight line of sight and the client's drawn light cone use identical geometry.
// Nothing here knows about players or hidden state.

const AXES = ['x', 'y', 'z'] as const;

// Distance along a unit-length ray to where it enters the box, or Infinity for a
// miss. A ray starting inside the box returns 0. Standard slab method.
export function rayBoxDistance(origin: Position, direction: Position, box: WallBox): number {
  let entry = 0;
  let exit = Infinity;
  for (const axis of AXES) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return Infinity;
      continue;
    }
    const near = (box.min[axis] - origin[axis]) / direction[axis];
    const far = (box.max[axis] - origin[axis]) / direction[axis];
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry > exit) return Infinity;
  }
  return entry;
}

// Distance the ray can travel before hitting a box, capped at maxDistance.
export function wallDistance(
  origin: Position, direction: Position, maxDistance: number, boxes: readonly WallBox[] = WALL_BOXES,
): number {
  let nearest = maxDistance;
  for (const box of boxes) nearest = Math.min(nearest, rayBoxDistance(origin, direction, box));
  return nearest;
}

export function segmentBlocked(from: Position, to: Position, boxes: readonly WallBox[] = WALL_BOXES): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  if (length === 0) return false;
  const direction = { x: (to.x - from.x) / length, y: (to.y - from.y) / length, z: (to.z - from.z) / length };
  return wallDistance(from, direction, length, boxes) < length;
}
