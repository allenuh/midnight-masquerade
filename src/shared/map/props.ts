// The prop catalogue and the rules for placing props, shared by the validator, the world
// builder, the map editor and the renderer, so all four agree on where every prop is. Pure: no
// three.js and no asset URLs (the client maps each `asset` to its glb).
//
// A standing prop covers a footprint of whole tiles, `size` tiles across its front (its local
// X) by tiles deep (its local Z); a quarter turn swaps the two. Every tile it covers blocks
// movement and sight like a Wall tile, whatever the prop's height. It stands on the floor, or
// on the prop an earlier entry left on top of its tiles, if that prop is one it `standsOn`: it
// then rests on that prop's `surface`. A tabletop prop only ever stands on another prop. Wall
// props hang on a wall face with their origin (the middle of the back plate) WALL_PROP_HEIGHT
// above the floor, and take no tiles.
// Heights are the models' (art/build_*.py): `height` is the top of the model above its base,
// and for a wall prop its full height, centred on the mount.
import { GAMEPLAY } from '../gameplay-config.js';
import type { Position } from '../protocol.js';
import {
  PROP, TERRAIN, TILE_SIZE, tileOrigin, type GameMap, type MapProp, type MapWallProp, type PropId, type WallSide,
} from './schema.js';

export type PropKind = 'standing' | 'tabletop' | 'wall';
export type PropGroup = 'Furniture' | 'Tables' | 'Seating' | 'Containers' | 'Tabletop' | 'Wall';
export type PropSpec = {
  label: string;
  // The model's basename in src/client/assets/ (`${asset}.glb`).
  asset: string;
  group: PropGroup;
  kind: PropKind;
  // Tiles across the front by tiles deep, unturned; a wall prop's is tiles along the wall.
  size: readonly [number, number];
  height: number;
  // The height another prop stands at on top of this one, when any may.
  surface?: number;
  // Turns to any whole degree, not just quarter turns (round, so it stays inside its tile).
  freeRotation?: boolean;
  standsOn?: readonly PropId[];
  // How many props high it may stand, itself included.
  maxStack?: number;
};

// The origin of a wall prop above the floor: the 1-tile sconce spans 28 to 54 and the 2-tile one
// 26.4 to 55.6, inside the 56 tall wall.
export const WALL_PROP_HEIGHT = 41;

const CRATES: readonly PropId[] = [PROP.crateStandard, PROP.crateDark];
// What a candle may stand on: the tables, the dresser, a crate, or a barrel's lid (inside its rim).
const TABLETOPS: readonly PropId[] = [
  PROP.diningTable, PROP.sideTable, PROP.storageTable, PROP.dresser, ...CRATES, PROP.barrelStandard, PROP.barrelWeathered,
];

export const PROP_SPECS: Record<PropId, PropSpec> = {
  [PROP.bookshelf]: { label: 'Bookshelf', asset: 'bookshelf_1x2', group: 'Furniture', kind: 'standing', size: [2, 1], height: 53.4 },
  [PROP.dresser]: { label: 'Dresser', asset: 'dresser_1x2', group: 'Furniture', kind: 'standing', size: [2, 1], height: 31, surface: 31 },
  [PROP.cupboard]: { label: 'Cupboard', asset: 'cupboard_1x3', group: 'Furniture', kind: 'standing', size: [3, 1], height: 55.4 },
  [PROP.diningTable]: {
    label: 'Dining table', asset: 'dining_table_1x4', group: 'Tables', kind: 'standing', size: [4, 1], height: 24, surface: 24,
  },
  [PROP.sideTable]: {
    label: 'Side table', asset: 'side_table_1x2', group: 'Tables', kind: 'standing', size: [2, 1], height: 20, surface: 20,
  },
  // The cloth's ridges are the highest part of its top.
  [PROP.storageTable]: {
    label: 'Storage table', asset: 'storage_table_2x4', group: 'Tables', kind: 'standing', size: [4, 2], height: 25.87, surface: 25.72,
  },
  [PROP.chair]: { label: 'Chair', asset: 'chair_1x1', group: 'Seating', kind: 'standing', size: [1, 1], height: 27.9 },
  [PROP.stool]: { label: 'Stool', asset: 'stool_1x1', group: 'Seating', kind: 'standing', size: [1, 1], height: 10.4 },
  // The lid sits a unit down inside the rim.
  [PROP.barrelStandard]: {
    label: 'Barrel', asset: 'barrel_standard', group: 'Containers', kind: 'standing', size: [1, 1], height: 28, surface: 27,
    freeRotation: true,
  },
  [PROP.barrelWeathered]: {
    label: 'Weathered barrel', asset: 'barrel_weathered', group: 'Containers', kind: 'standing', size: [1, 1], height: 28,
    surface: 27, freeRotation: true,
  },
  // Three crates are 54 high, just under a wall.
  [PROP.crateStandard]: {
    label: 'Crate', asset: 'crate_standard', group: 'Containers', kind: 'standing', size: [1, 1], height: 18, surface: 18,
    standsOn: CRATES, maxStack: 3,
  },
  [PROP.crateDark]: {
    label: 'Dark crate', asset: 'crate_dark', group: 'Containers', kind: 'standing', size: [1, 1], height: 18, surface: 18,
    standsOn: CRATES, maxStack: 3,
  },
  [PROP.candelabra]: {
    label: 'Candelabra', asset: 'candelabra_3candle', group: 'Tabletop', kind: 'tabletop', size: [1, 1], height: 34.4,
    standsOn: TABLETOPS,
  },
  [PROP.chamberstick]: {
    label: 'Chamberstick', asset: 'chamberstick', group: 'Tabletop', kind: 'tabletop', size: [1, 1], height: 12.9, standsOn: TABLETOPS,
  },
  [PROP.wallCandle]: { label: 'Wall candle', asset: 'wall_candle_1tile', group: 'Wall', kind: 'wall', size: [1, 1], height: 26 },
  [PROP.wallCandleDouble]: {
    label: 'Double wall candle', asset: 'wall_candle_2tile', group: 'Wall', kind: 'wall', size: [2, 1], height: 29.2,
  },
};

export type Tile = { x: number; y: number };

// The footprint's width and depth in tiles as the prop is turned.
export function footprintSize(prop: MapProp): [number, number] {
  const [wide, deep] = PROP_SPECS[prop.type].size;
  return prop.rotation % 180 === 90 ? [deep, wide] : [wide, deep];
}

export function footprint(prop: MapProp): Tile[] {
  const [width, depth] = footprintSize(prop);
  const tiles: Tile[] = [];
  for (let y = prop.y; y < prop.y + depth; y++) {
    for (let x = prop.x; x < prop.x + width; x++) tiles.push({ x, y });
  }
  return tiles;
}

// What each prop stands on, in list order: `base` is the index of the prop under it (-1 for the
// floor), `baseHeight` how far above the floor it stands, and `level` how many props high it is.
// `top` is the topmost prop on each tile, -1 for none. `errors` are sentences for the validator
// and the editor; a prop with an error takes no tiles, so later props are checked without it.
export type PropStack = { base: number; baseHeight: number; level: number };
export type PropLayout = { stacks: PropStack[]; top: number[][]; errors: string[] };

const describe = (map: GameMap, index: number): string => {
  const prop = map.props[index];
  return `prop ${index} (${PROP_SPECS[prop.type].label}) at (${prop.x}, ${prop.y})`;
};

// Expects every prop to be well formed (a known type, whole-number tile and rotation).
export function layoutProps(map: GameMap): PropLayout {
  const top = map.terrain.map((row) => row.map(() => -1));
  const stacks: PropStack[] = [];
  const errors: string[] = [];
  map.props.forEach((prop, index) => {
    const spec = PROP_SPECS[prop.type];
    const name = describe(map, index);
    const stack: PropStack = { base: -1, baseHeight: 0, level: 1 };
    stacks.push(stack);
    if (spec.kind === 'wall') {
      errors.push(`${name} hangs on a wall, so it belongs in "wallProps"`);
      return;
    }
    if (prop.rotation < 0 || prop.rotation >= 360 || (!spec.freeRotation && prop.rotation % 90 !== 0)) {
      errors.push(`${name} has rotation ${prop.rotation}: it turns in ${spec.freeRotation ? 'whole degrees from 0 to 359' : 'quarter turns (0, 90, 180 or 270)'}`);
      return;
    }
    const tiles = footprint(prop);
    if (tiles.some(({ x, y }) => x < 0 || y < 0 || x >= map.width || y >= map.height)) {
      errors.push(`${name} reaches outside the ${map.width} x ${map.height} grid`);
      return;
    }
    const walled = tiles.find(({ x, y }) => map.terrain[y][x] !== TERRAIN.open);
    if (walled) {
      errors.push(`${name} covers Wall terrain at (${walled.x}, ${walled.y})`);
      return;
    }
    const bases = [...new Set(tiles.map(({ x, y }) => top[y][x]))];
    const base = bases[0];
    if (bases.length > 1 || (base >= 0 && !spec.standsOn?.includes(map.props[base].type))) {
      errors.push(`${name} overlaps ${describe(map, bases.find((other) => other >= 0)!)}`);
      return;
    }
    if (base >= 0) {
      const under = stacks[base];
      stack.base = base;
      stack.baseHeight = under.baseHeight + PROP_SPECS[map.props[base].type].surface!;
      stack.level = under.level + 1;
      if (spec.maxStack !== undefined && stack.level > spec.maxStack) {
        errors.push(`${name} would stand ${stack.level} high; a ${spec.label.toLowerCase()} stacks at most ${spec.maxStack} high`);
        return;
      }
    } else if (spec.kind === 'tabletop') {
      errors.push(`${name} must stand on a table, a dresser, a crate or a barrel`);
      return;
    }
    for (const { x, y } of tiles) top[y][x] = index;
  });
  return { stacks, top, errors };
}

// How high the props on a tile reach above the floor, 0 for none.
export function stackTop(map: GameMap, layout: PropLayout, x: number, y: number): number {
  const index = layout.top[y][x];
  return index < 0 ? 0 : layout.stacks[index].baseHeight + PROP_SPECS[map.props[index].type].height;
}

// One step toward the wall from the tile in front of it, and one step along it.
const TOWARD: Record<WallSide, Tile> = { north: { x: 0, y: -1 }, east: { x: 1, y: 0 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 } };
const along = (side: WallSide): Tile => (side === 'north' || side === 'south' ? { x: 1, y: 0 } : { x: 0, y: 1 });

// The Open tiles in front of the wall a wall prop hangs over: one, or two running along it
// (east along a north or south wall, south along an east or west one).
export function wallPropTiles(wallProp: MapWallProp): Tile[] {
  const step = along(wallProp.side);
  return Array.from({ length: PROP_SPECS[wallProp.type].size[0] }, (_, i) => ({
    x: wallProp.x + step.x * i, y: wallProp.y + step.y * i,
  }));
}

// Problems with the wall props, given the standing props' layout. Expects each wall prop to be
// well formed (a known type and side, whole-number tile).
export function wallPropErrors(map: GameMap, layout: PropLayout): string[] {
  const errors: string[] = [];
  const faces = new Map<string, number>();
  map.wallProps.forEach((wallProp, index) => {
    const spec = PROP_SPECS[wallProp.type];
    const name = `wall prop ${index} (${spec.label}) at (${wallProp.x}, ${wallProp.y})`;
    if (spec.kind !== 'wall') {
      errors.push(`${name} does not hang on a wall, so it belongs in "props"`);
      return;
    }
    const lowest = WALL_PROP_HEIGHT - spec.height / 2;
    for (const { x, y } of wallPropTiles(wallProp)) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height || map.terrain[y][x] !== TERRAIN.open) {
        errors.push(`${name} needs Open terrain in front of its wall at (${x}, ${y})`);
        return;
      }
      const wallX = x + TOWARD[wallProp.side].x;
      const wallY = y + TOWARD[wallProp.side].y;
      const inside = wallX >= 0 && wallY >= 0 && wallX < map.width && wallY < map.height;
      if (inside && map.terrain[wallY][wallX] !== TERRAIN.wall) {
        errors.push(`${name} has no wall on its ${wallProp.side} side at (${x}, ${y})`);
        return;
      }
      const face = `${x},${y},${wallProp.side}`;
      const other = faces.get(face);
      if (other !== undefined) {
        errors.push(`${name} overlaps wall prop ${other} on the same wall`);
        return;
      }
      faces.set(face, index);
      const reach = stackTop(map, layout, x, y);
      if (reach > lowest) {
        errors.push(`${name} would clip ${describe(map, layout.top[y][x])}, which is ${reach} high; it hangs down to ${lowest}`);
        return;
      }
    }
  });
  return errors;
}

// Where a prop's model goes in the world: its origin, and its turn about +Y in radians (three.js
// turns counter-clockwise seen from above, the maps clockwise).
export type PropPlacement = { type: PropId; position: Position; rotation: number };

export function propPlacements(map: GameMap, layout: PropLayout = layoutProps(map)): PropPlacement[] {
  return map.props.map((prop, index) => {
    const [width, depth] = footprintSize(prop);
    return {
      type: prop.type,
      position: {
        x: tileOrigin(prop.x) + (width * TILE_SIZE) / 2,
        y: GAMEPLAY.arena.floorY + layout.stacks[index].baseHeight,
        z: tileOrigin(prop.y) + (depth * TILE_SIZE) / 2,
      },
      rotation: (-prop.rotation * Math.PI) / 180,
    };
  });
}

// A wall prop faces out of its wall: away from north is +Z, the unturned facing.
const FACING: Record<WallSide, number> = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };

export function wallPropPlacements(map: GameMap): PropPlacement[] {
  return map.wallProps.map((wallProp) => {
    const length = PROP_SPECS[wallProp.type].size[0] * TILE_SIZE;
    const { side, x, y } = wallProp;
    const runsAlongX = side === 'north' || side === 'south';
    return {
      type: wallProp.type,
      position: {
        x: runsAlongX ? tileOrigin(x) + length / 2 : tileOrigin(side === 'east' ? x + 1 : x),
        y: GAMEPLAY.arena.floorY + WALL_PROP_HEIGHT,
        z: runsAlongX ? tileOrigin(side === 'south' ? y + 1 : y) : tileOrigin(y) + length / 2,
      },
      rotation: FACING[side],
    };
  });
}
