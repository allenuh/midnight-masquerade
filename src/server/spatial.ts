import { ARENA_OBSTACLES, ARENA_WALLS, type WallBox } from '../shared/arena.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { Position } from '../shared/protocol.js';

export function distance3D(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function constrainToArena(position: Position): Position {
  const radius = GAMEPLAY.playerRadius;
  // Grounded spheres against the inward faces of four axis-aligned 3D boxes.
  // For the rectangular boundary, clamping is the exact solution: it also
  // prevents crossing a thin wall in one step. No general physics engine
  // is needed. Y remains grounded; the prototype has no jump or gravity mechanic.
  return {
    x: Math.max(ARENA_WALLS.west.max.x + radius, Math.min(ARENA_WALLS.east.min.x - radius, position.x)),
    y: GAMEPLAY.arena.floorY + radius,
    z: Math.max(ARENA_WALLS.north.max.z + radius, Math.min(ARENA_WALLS.south.min.z - radius, position.z)),
  };
}

function pushSphereOutOfBox(position: Position, box: WallBox, radius: number): Position {
  const closest = {
    x: Math.max(box.min.x, Math.min(box.max.x, position.x)),
    y: Math.max(box.min.y, Math.min(box.max.y, position.y)),
    z: Math.max(box.min.z, Math.min(box.max.z, position.z)),
  };
  const gap = distance3D(position, closest);
  if (gap >= radius) return position;
  if (gap > 0) {
    // Push straight away from the nearest face or edge. The movement component
    // parallel to the face survives, so players slide along walls.
    const push = (radius - gap) / gap;
    return {
      x: position.x + (position.x - closest.x) * push,
      y: position.y + (position.y - closest.y) * push,
      z: position.z + (position.z - closest.z) * push,
    };
  }
  // Center inside the box (cannot happen with per-tick steps shorter than the
  // radius, but stay safe): leave through the nearest face on the ground plane.
  const exits = [
    { axis: 'x' as const, value: box.min.x - radius, depth: position.x - box.min.x },
    { axis: 'x' as const, value: box.max.x + radius, depth: box.max.x - position.x },
    { axis: 'z' as const, value: box.min.z - radius, depth: position.z - box.min.z },
    { axis: 'z' as const, value: box.max.z + radius, depth: box.max.z - position.z },
  ];
  const exit = exits.reduce((best, candidate) => (candidate.depth < best.depth ? candidate : best));
  return { ...position, [exit.axis]: exit.value };
}

export function constrainToWalls(position: Position): Position {
  let constrained = constrainToArena(position);
  // Two passes settle a sphere touching two obstacles at once (an inside corner).
  // Per-tick steps are shorter than every wall thickness, so nothing tunnels.
  for (let pass = 0; pass < 2; pass++) {
    for (const box of ARENA_OBSTACLES) {
      constrained = pushSphereOutOfBox(constrained, box, GAMEPLAY.playerRadius);
    }
  }
  return constrainToArena(constrained);
}

// True when a sphere overlaps the flashlight cone: it starts within range and
// its angular extent reaches inside the cone's half angle. Walls are checked
// separately with a line-of-sight segment to the sphere center.
export function sphereInCone(origin: Position, facing: number, center: Position, radius: number): boolean {
  const distance = distance3D(origin, center);
  if (distance - radius > GAMEPLAY.flashlight.range) return false;
  if (distance <= radius) return true;
  const cosine = ((center.x - origin.x) * Math.cos(facing) + (center.z - origin.z) * Math.sin(facing)) / distance;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const halfAngle = (GAMEPLAY.flashlight.coneAngle / 2) * (Math.PI / 180);
  return angle <= halfAngle + Math.asin(radius / distance);
}

export function spheresTouchDuringStep(
  hunter: Position, nextHunter: Position, creature: Position, nextCreature: Position,
): boolean {
  // Sweep the relative 3D center segment against the combined sphere radius.
  // This catches glancing contact between snapshots as well as exact touching.
  const startX = creature.x - hunter.x;
  const startY = creature.y - hunter.y;
  const startZ = creature.z - hunter.z;
  const dx = (nextCreature.x - nextHunter.x) - startX;
  const dy = (nextCreature.y - nextHunter.y) - startY;
  const dz = (nextCreature.z - nextHunter.z) - startZ;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const projection = -(startX * dx + startY * dy + startZ * dz);
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, projection / lengthSquared));
  return Math.hypot(startX + t * dx, startY + t * dy, startZ + t * dz) <= 2 * GAMEPLAY.playerRadius;
}
