import { ARENA_WALLS } from '../shared/arena.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { Position } from '../shared/protocol.js';

export function distance3D(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function constrainToArena(position: Position): Position {
  const radius = GAMEPLAY.playerRadius;
  // Grounded spheres against the inward faces of four axis-aligned 3D boxes.
  // For this empty rectangular room, clamping is the exact boundary solution:
  // it also prevents crossing a thin wall in one step. No general physics engine
  // is needed. Y remains grounded; the prototype has no jump or gravity mechanic.
  return {
    x: Math.max(ARENA_WALLS.west.max.x + radius, Math.min(ARENA_WALLS.east.min.x - radius, position.x)),
    y: GAMEPLAY.arena.floorY + radius,
    z: Math.max(ARENA_WALLS.north.max.z + radius, Math.min(ARENA_WALLS.south.min.z - radius, position.z)),
  };
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
