// Test-only steering for integration tests: turns "go to this point" into held
// WASD keys using a coarse grid search over the shared wall boxes. Straight-line
// chasing gets stuck on the interior blockout, so both the socket and browser
// tests drive the players with this. Nothing here is used by the game itself.
import { GAMEPLAY } from '../../src/shared/gameplay-config.js';
import type { Position } from '../../src/shared/protocol.js';
import { TEST_WORLD } from './game.js';

export type Keys = { up: boolean; down: boolean; left: boolean; right: boolean };
type Options = { avoid?: Position[]; arrive?: number };

const CELL = 20;
const WORLD = TEST_WORLD;
const COLUMNS = Math.ceil(WORLD.width / CELL);
const ROWS = Math.ceil(WORLD.depth / CELL);
const CLEARANCE = GAMEPLAY.playerRadius + 4;
const AVOID_RADIUS = 60;
const groundY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;

const cellCenter = (column: number, row: number): Position => ({
  x: (column + 0.5) * CELL, y: groundY, z: (row + 0.5) * CELL,
});

function clearOfWalls(point: Position): boolean {
  return WORLD.wallBoxes.every((box) => {
    const nearestX = Math.max(box.min.x, Math.min(box.max.x, point.x));
    const nearestZ = Math.max(box.min.z, Math.min(box.max.z, point.z));
    return Math.hypot(point.x - nearestX, point.z - nearestZ) >= CLEARANCE;
  });
}

const wallFree: boolean[] = [];
for (let row = 0; row < ROWS; row++) {
  for (let column = 0; column < COLUMNS; column++) wallFree[row * COLUMNS + column] = clearOfWalls(cellCenter(column, row));
}

function freeCells(avoid: Position[]): boolean[] {
  if (avoid.length === 0) return wallFree;
  return wallFree.map((free, index) => free && avoid.every((other) => {
    const center = cellCenter(index % COLUMNS, Math.floor(index / COLUMNS));
    return Math.hypot(center.x - other.x, center.z - other.z) > AVOID_RADIUS;
  }));
}

const cellOf = (point: Position) => ({
  column: Math.max(0, Math.min(COLUMNS - 1, Math.floor(point.x / CELL))),
  row: Math.max(0, Math.min(ROWS - 1, Math.floor(point.z / CELL))),
});

// Breadth-first distances (in steps) from the goal cell over free cells.
// Diagonal steps require both orthogonal neighbours to be free, so a path never
// clips a wall corner.
function distancesFrom(goal: { column: number; row: number }, free: boolean[]): number[] {
  const distances = new Array<number>(COLUMNS * ROWS).fill(Infinity);
  const queue: number[] = [];
  const start = goal.row * COLUMNS + goal.column;
  distances[start] = 0;
  queue.push(start);
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nextColumn = column + dc;
      const nextRow = row + dr;
      if (nextColumn < 0 || nextColumn >= COLUMNS || nextRow < 0 || nextRow >= ROWS) continue;
      const next = nextRow * COLUMNS + nextColumn;
      if (!free[next] || distances[next] !== Infinity) continue;
      if (dc !== 0 && dr !== 0 && !(free[row * COLUMNS + nextColumn] && free[nextRow * COLUMNS + column])) continue;
      distances[next] = distances[index] + 1;
      queue.push(next);
    }
  }
  return distances;
}

const keysFor = (dx: number, dz: number, deadband: number): Keys => ({
  up: dz < -deadband, down: dz > deadband, left: dx < -deadband, right: dx > deadband,
});

// Held keys that move `from` toward `to`, detouring around walls. `avoid` marks
// positions to keep clear of (other players); `arrive` stops within that distance.
// Steering always follows the grid search until the goal is one cell away, then
// heads straight for it. Mixing straight-line and grid modes earlier oscillates
// at openings, so it is deliberately not done.
export function keysToward(from: Position, to: Position, options: Options = {}): Keys {
  const arrive = options.arrive ?? 0;
  if (Math.hypot(to.x - from.x, to.z - from.z) <= arrive) return keysFor(0, 0, 0);
  const goal = cellOf(to);
  const current = cellOf(from);
  if (Math.abs(goal.column - current.column) <= 1 && Math.abs(goal.row - current.row) <= 1) {
    return keysFor(to.x - from.x, to.z - from.z, 0.5);
  }
  const free = freeCells(options.avoid ?? []);
  const distances = distancesFrom(goal, free);
  let best: { column: number; row: number; distance: number } | null = null;
  for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const column = current.column + dc;
    const row = current.row + dr;
    if (column < 0 || column >= COLUMNS || row < 0 || row >= ROWS) continue;
    if (dc !== 0 && dr !== 0 && !(free[current.row * COLUMNS + column] && free[row * COLUMNS + current.column])) continue;
    const distance = distances[row * COLUMNS + column];
    if (best === null || distance < best.distance) best = { column, row, distance };
  }
  // No route (an opening is occupied): head straight and let wall sliding sort it out.
  if (best === null || best.distance === Infinity) return keysFor(to.x - from.x, to.z - from.z, 0.5);
  const target = cellCenter(best.column, best.row);
  return keysFor(target.x - from.x, target.z - from.z, 0.5);
}

// A straight open lane running toward +X: every point along it is clear of walls
// and at least AVOID_RADIUS from the `avoid` positions. Used to stage a flashlight test.
export function findLane(length: number, avoid: Position[] = []): { start: Position; end: Position } {
  const free = freeCells(avoid);
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const cells = Math.ceil(length / CELL);
      if (column + cells >= COLUMNS) break;
      let clear = true;
      for (let step = 0; step <= cells && clear; step++) clear = free[row * COLUMNS + column + step];
      if (clear) {
        const start = cellCenter(column, row);
        return { start, end: { ...start, x: start.x + length } };
      }
    }
  }
  throw new Error(`No open lane of length ${length} exists in the arena blockout`);
}
