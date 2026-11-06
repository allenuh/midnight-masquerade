// The map the page compiles its shaders on, under the opening cover: the client has no real map until
// it joins a room (the server sends it), and a shader compiling then would freeze the wipe to the room.
// Nobody ever sees or plays this map. It only has to hold one of everything a real map can draw, so it
// is generated from the catalogues: a new floor, wallpaper or prop is on it without anyone adding it.
// Pure (no three.js), so tests/warm-up-map.test.ts can check it is valid and complete.
import {
  FLOOR, FLOOR_IDS, MARKER, MIN_HUNTER_SPAWNS, PROP_IDS, TERRAIN, WALLPAPER_IDS, createEmptyMap, filledGrid, type FloorId, type GameMap,
  type MapMarker, type MapProp, type MapWallProp, type TerrainId, type WallpaperId,
} from '../shared/map/schema.js';
import { PROP_SPECS, footprint } from '../shared/map/props.js';

const WIDTH = 24;

export function warmUpMap(): GameMap {
  // Row 0: every floor in turn, and the wall props on the boundary above it. Row 1: a wall of every
  // wallpaper in turn. Row 2: doorway rugs, which frame that wall with door jambs.
  const wallProps: MapWallProp[] = [];
  let column = 0;
  for (const type of PROP_IDS) {
    if (PROP_SPECS[type].kind !== 'wall') continue;
    wallProps.push({ type, x: column, y: 0, side: 'north' });
    column += PROP_SPECS[type].size[0];
  }

  // Below those, every standing prop on the floor, in rows.
  const props: MapProp[] = [];
  let x = 0;
  let y = 4;
  let rowDepth = 0;
  for (const type of PROP_IDS) {
    const { kind, size: [wide, deep] } = PROP_SPECS[type];
    if (kind !== 'standing') continue;
    if (x + wide > WIDTH) {
      x = 0;
      y += rowDepth + 1;
      rowDepth = 0;
    }
    props.push({ type, x, y, rotation: 0 });
    x += wide + 1;
    rowDepth = Math.max(rowDepth, deep);
  }
  const standing = [...props];

  // Every tabletop prop on a free tile of something it may stand on.
  const taken = new Set<string>();
  for (const type of PROP_IDS) {
    const { kind, standsOn } = PROP_SPECS[type];
    if (kind !== 'tabletop') continue;
    const tile = standing.filter((base) => standsOn?.includes(base.type)).flatMap(footprint)
      .find((candidate) => !taken.has(`${candidate.x},${candidate.y}`));
    if (!tile) throw new Error(`The warm-up map has nothing for a ${PROP_SPECS[type].label} to stand on`);
    taken.add(`${tile.x},${tile.y}`);
    props.push({ type, x: tile.x, y: tile.y, rotation: 0 });
  }

  // A clear row below the props for the spawn markers and a battery.
  const markersRow = y + rowDepth + 1;
  const markers: MapMarker[] = [
    { type: MARKER.creatureSpawn, x: 0, y: markersRow },
    ...Array.from({ length: MIN_HUNTER_SPAWNS }, (_, index) => ({ type: MARKER.hunterSpawn, x: index + 1, y: markersRow })),
    { type: MARKER.batterySpawn, x: MIN_HUNTER_SPAWNS + 1, y: markersRow },
  ];

  const height = markersRow + 1;
  const map = createEmptyMap('Warm-up', WIDTH, height);
  const floor = filledGrid<FloorId>(WIDTH, height, FLOOR.plain);
  const terrain = filledGrid<TerrainId>(WIDTH, height, TERRAIN.open);
  const wallpaper = filledGrid<WallpaperId>(WIDTH, height, WALLPAPER_IDS[0]);
  for (let tile = 0; tile < WIDTH; tile++) {
    floor[0][tile] = FLOOR_IDS[tile % FLOOR_IDS.length];
    terrain[1][tile] = TERRAIN.wall;
    wallpaper[1][tile] = WALLPAPER_IDS[tile % WALLPAPER_IDS.length];
    floor[2][tile] = FLOOR.doorway;
  }
  // The boundary wears a textured wallpaper, as the plain one is on the wall above.
  return { ...map, floor, terrain, wallpaper, boundaryWallpaper: WALLPAPER_IDS[WALLPAPER_IDS.length - 1], markers, props, wallProps };
}
