// Developer-only tile map editor. It shares the map schema, the prop rules and the validator
// with the game (src/shared/map) and knows nothing else about it: no gameplay, no networking,
// no 3D. Everything here is local — files are read and written through the browser only.
import {
  FLOOR, FLOOR_IDS, FLOOR_LABELS, MAP_VERSION, MARKER, MARKER_LABELS, MAX_DIMENSION, MIN_CREATURE_SPAWNS, MIN_DIMENSION,
  MIN_HUNTER_SPAWNS, PROP, PROP_IDS, TERRAIN, TERRAIN_LABELS, TILE_SIZE, WALLPAPER, WALLPAPER_IDS, WALLPAPER_LABELS,
  countMarkers, createEmptyMap, type FloorId, type GameMap, type MarkerId, type PropId, type TerrainId, type WallSide,
  type WallpaperId,
} from '../../src/shared/map/schema.js';
import {
  PROP_SPECS, footprintSize, layoutProps, wallPropErrors, wallPropTiles, type PropGroup,
} from '../../src/shared/map/props.js';
import { validateMap } from '../../src/shared/map/validate.js';
import starTileUrl from '../../src/client/assets/textures/floor-star-tile.png?url';
import marbleDiamondUrl from '../../src/client/assets/textures/floor-marble-diamond.png?url';
import terracottaUrl from '../../src/client/assets/textures/floor-terracotta.png?url';
import redCarpetUrl from '../../src/client/assets/textures/floor-red-carpet.png?url';
import beigeCarpetUrl from '../../src/client/assets/textures/floor-beige-carpet.png?url';
import runnerUrl from '../../src/client/assets/textures/floor-runner.png?url';
import doorwayUrl from '../../src/client/assets/textures/floor-doorway.png?url';
import checkerUrl from '../../src/client/assets/textures/floor-checker.png?url';
import './style.css';

const CELL = 16;
// How much bigger the grid is drawn than CELL, for legibility: appearance only. Everything is
// drawn in CELL units under this scale, and the pointer is read back through the canvas's
// on-screen size.
const ZOOM = 2;
const COLORS = {
  open: '#2f3733',
  wall: '#8b938c',
  grid: '#1b1f1d',
  [MARKER.batterySpawn]: '#6f9a52',
  [MARKER.creatureSpawn]: '#c9713f',
  [MARKER.hunterSpawn]: '#7f93ad',
} as const;

// Floors are previewed with the game's own textures, scaled so one repeat covers as many
// tiles as it does in the game (texture texels / 32 per tile) and anchored at the grid origin,
// as the game anchors them at the world origin. Plain keeps the blockout colour.
const FLOOR_URLS: Partial<Record<FloorId, string>> = {
  [FLOOR.starTile]: starTileUrl,
  [FLOOR.marbleDiamond]: marbleDiamondUrl,
  [FLOOR.terracotta]: terracottaUrl,
  [FLOOR.redCarpet]: redCarpetUrl,
  [FLOOR.beigeCarpet]: beigeCarpetUrl,
  [FLOOR.runner]: runnerUrl,
  [FLOOR.doorway]: doorwayUrl,
  [FLOOR.checker]: checkerUrl,
};
const TEXELS_PER_TILE = 32;
// The game draws a border along the edge of every runner and doorway rug; the editor outlines
// those edges in the border's colour so a region's shape reads before it is played.
const BORDER_COLORS: Partial<Record<FloorId, string>> = {
  [FLOOR.runner]: '#c9a24e',
  [FLOOR.doorway]: '#2a160b',
};
// Wall tiles show their wallpaper's average paper colour (the paper is seen from the side in
// the game, so a top-down pattern would mislead).
const WALLPAPER_COLORS: Record<WallpaperId, string> = {
  [WALLPAPER.plain]: COLORS.wall,
  [WALLPAPER.greenDamask]: '#4f5b3d',
  [WALLPAPER.creamFloral]: '#d2c7a8',
};
// Props are drawn as their footprint in their group's colour with a two-letter tag, a dot by the
// side they face and, when stacked, how many high they stand; tabletop props as a disc on their
// tile, wall props as a bar along their wall. The placement preview is outlined, red where the
// prop cannot go.
const PROP_COLORS: Record<PropGroup, string> = {
  Furniture: '#8a5a3c', Tables: '#a8784a', Seating: '#7c6c4c', Containers: '#6c5c42', Tabletop: '#f0c35a', Wall: '#f0c35a',
};
const PROP_TAGS: Record<PropId, string> = {
  [PROP.bookshelf]: 'Bk', [PROP.dresser]: 'Dr', [PROP.cupboard]: 'Cb', [PROP.diningTable]: 'Dt', [PROP.sideTable]: 'St',
  [PROP.storageTable]: 'Tt', [PROP.chair]: 'Ch', [PROP.stool]: 'Sl', [PROP.barrelStandard]: 'Ba', [PROP.barrelWeathered]: 'Bw',
  [PROP.crateStandard]: 'Cr', [PROP.crateDark]: 'Cd', [PROP.candelabra]: 'Ca', [PROP.chamberstick]: 'Cs',
  [PROP.wallCandle]: 'W1', [PROP.wallCandleDouble]: 'W2',
};
const PREVIEW_COLORS = { fits: '#e6e7e4', blocked: '#e0533d' };

// The grid is edited one layer at a time: terrain and markers, the floor finish, the wallpaper
// finish, or the props. Each layer has its own tools; finishes never change collision.
type Layer = 'terrain' | 'floor' | 'wallpaper' | 'props';
type Tool =
  | { kind: 'terrain'; id: TerrainId } | { kind: 'marker'; id: MarkerId } | { kind: 'erase' }
  | { kind: 'floor'; id: FloorId } | { kind: 'wallpaper'; id: WallpaperId } | { kind: 'prop'; id: PropId };
const TOOLS: Record<Layer, { label: string; tool: Tool }[]> = {
  terrain: [
    { label: TERRAIN_LABELS[TERRAIN.open], tool: { kind: 'terrain', id: TERRAIN.open } },
    { label: TERRAIN_LABELS[TERRAIN.wall], tool: { kind: 'terrain', id: TERRAIN.wall } },
    { label: MARKER_LABELS[MARKER.batterySpawn], tool: { kind: 'marker', id: MARKER.batterySpawn } },
    { label: MARKER_LABELS[MARKER.creatureSpawn], tool: { kind: 'marker', id: MARKER.creatureSpawn } },
    { label: MARKER_LABELS[MARKER.hunterSpawn], tool: { kind: 'marker', id: MARKER.hunterSpawn } },
    { label: 'Erase', tool: { kind: 'erase' } },
  ],
  floor: FLOOR_IDS.map((id) => ({ label: FLOOR_LABELS[id], tool: { kind: 'floor', id } })),
  wallpaper: WALLPAPER_IDS.map((id) => ({ label: WALLPAPER_LABELS[id], tool: { kind: 'wallpaper', id } })),
  props: PROP_IDS.map((id) => ({ label: PROP_SPECS[id].label, tool: { kind: 'prop', id } })),
};
const LAYER_LABELS: Record<Layer, string> = { terrain: 'Terrain & markers', floor: 'Floor', wallpaper: 'Wallpaper', props: 'Props' };
const PROPS_HINT = 'Click places the prop with its top-left on the tile; R turns it a quarter (Shift+R turns a barrel 15°). '
  + 'Candles stand on tables, dressers, crates and barrels; wall candles hang on the tile edge nearest the cursor. '
  + 'Right click removes the top prop and whatever stands on it.';
const MARKER_LETTERS: Record<MarkerId, string> = {
  [MARKER.batterySpawn]: 'B',
  [MARKER.creatureSpawn]: 'C',
  [MARKER.hunterSpawn]: 'H',
};

const element = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const canvas = element<HTMLCanvasElement>('#grid');
const context = canvas.getContext('2d')!;
const nameInput = element<HTMLInputElement>('#name');
const widthInput = element<HTMLInputElement>('#width');
const heightInput = element<HTMLInputElement>('#height');
const fileInput = element<HTMLInputElement>('#file');
const layerBar = element('#layers');
const toolBar = element('#tools');
const boundaryLabel = element('#boundary-label');
const boundarySelect = element<HTMLSelectElement>('#boundary');
const statusText = element('#status');

let map: GameMap = createEmptyMap('New Map', 48, 30);
let layer: Layer = 'terrain';
const selected: Record<Layer, Tool> = {
  terrain: TOOLS.terrain[1].tool, floor: TOOLS.floor[1].tool, wallpaper: TOOLS.wallpaper[1].tool, props: TOOLS.props[0].tool,
};
// The props tool's turn, in degrees clockwise; a prop that only takes quarter turns uses the
// quarter turn at or below it.
let rotation = 0;

// Marker tally with the playability minimums, so an author can see when Export will work.
function tally(): string {
  const creatures = countMarkers(map, MARKER.creatureSpawn);
  const hunters = countMarkers(map, MARKER.hunterSpawn);
  return `Battery ${countMarkers(map, MARKER.batterySpawn)} · Creature ${creatures}/${MIN_CREATURE_SPAWNS}`
    + ` · Hunter ${hunters}/${MIN_HUNTER_SPAWNS} · Props ${map.props.length + map.wallProps.length}`
    + `${creatures >= MIN_CREATURE_SPAWNS && hunters >= MIN_HUNTER_SPAWNS ? '' : ' — not yet playable'}`;
}

function say(message: string): void {
  statusText.textContent = `${message}  [${tally()}]`;
}

const markerAt = (x: number, y: number) => map.markers.find((marker) => marker.x === x && marker.y === y);

// The prop the props tool would place with its top-left (or, for a wall prop, its tile and wall)
// under the pointer, as the map with it added last, so it stands on whatever is on top there.
type Pointer = { x: number; y: number; edge: WallSide };
let hover: Pointer | null = null;

const propTool = (): PropId => (selected.props as { id: PropId }).id;
const turnFor = (id: PropId): number => (PROP_SPECS[id].freeRotation ? rotation : rotation - (rotation % 90));

function withPending(at: Pointer): GameMap {
  const type = propTool();
  return PROP_SPECS[type].kind === 'wall'
    ? { ...map, wallProps: [...map.wallProps, { type, x: at.x, y: at.y, side: at.edge }] }
    : { ...map, props: [...map.props, { type, x: at.x, y: at.y, rotation: turnFor(type) }] };
}

// Why a candidate map cannot have its new prop: the first thing the shared validator says about
// it that it did not already say about the map without it.
const problems = (candidate: GameMap): string[] => {
  const result = validateMap(candidate);
  return result.ok ? [] : result.errors;
};
function placementProblem(candidate: GameMap): string | null {
  const before = new Set(problems(map));
  return problems(candidate).find((error) => !before.has(error)) ?? null;
}

// Drops whatever props an edit has left invalid, as walling a tile drops its marker: a prop on a
// tile that became Wall or left the grid, a candle whose table went with it, a wall prop whose
// wall was opened up. Returns how many went.
function pruneProps(): number {
  const { props, wallProps } = map;
  map.props = [];
  map.wallProps = [];
  for (const prop of props) {
    map.props.push(prop);
    if (layoutProps(map).errors.length > 0) map.props.pop();
  }
  const layout = layoutProps(map);
  for (const wallProp of wallProps) {
    map.wallProps.push(wallProp);
    if (wallPropErrors(map, layout).length > 0) map.wallProps.pop();
  }
  return props.length + wallProps.length - map.props.length - map.wallProps.length;
}

const droppedMessage = (count: number): string => (count > 0 ? ` Removed ${count} prop(s) that no longer fit.` : '');

function placeProp(at: Pointer): string {
  const label = PROP_SPECS[propTool()].label;
  const candidate = withPending(at);
  const problem = placementProblem(candidate);
  if (problem) return `Cannot place the ${label} there: ${problem}.`;
  map.props = candidate.props;
  map.wallProps = candidate.wallProps;
  const base = layoutProps(map).stacks.at(-1)?.base ?? -1;
  const on = PROP_SPECS[propTool()].kind !== 'wall' && base >= 0 ? ` on the ${PROP_SPECS[map.props[base].type].label}` : '';
  return `Placed the ${label} at (${at.x}, ${at.y})${on}.`;
}

// Takes away the wall prop on the edge under the pointer, or else the prop on top of the tile and
// everything standing on it (a table takes its candles with it).
function removeProp(at: Pointer): string {
  const hung = map.wallProps.findIndex((wallProp) =>
    wallProp.side === at.edge && wallPropTiles(wallProp).some((tile) => tile.x === at.x && tile.y === at.y));
  if (hung >= 0) {
    const [gone] = map.wallProps.splice(hung, 1);
    return `Removed the ${PROP_SPECS[gone.type].label} on the ${at.edge} wall of (${at.x}, ${at.y}).`;
  }
  const layout = layoutProps(map);
  const top = layout.top[at.y][at.x];
  if (top < 0) return `Nothing to remove at (${at.x}, ${at.y}).`;
  const gone = new Set([top]);
  layout.stacks.forEach((stack, index) => {
    if (gone.has(stack.base)) gone.add(index);
  });
  const label = PROP_SPECS[map.props[top].type].label;
  map.props = map.props.filter((_, index) => !gone.has(index));
  const dropped = pruneProps();
  const riders = gone.size - 1 + dropped;
  return `Removed the ${label}${riders > 0 ? ` and ${riders} prop(s) that stood on it` : ''}.`;
}

// Floor previews as canvas patterns, filled in as each texture loads.
const floorPatterns = new Map<FloorId, CanvasPattern>();
for (const [id, url] of Object.entries(FLOOR_URLS)) {
  const image = new Image();
  image.onload = () => {
    const pattern = context.createPattern(image, 'repeat')!;
    pattern.setTransform(new DOMMatrix().scale(CELL / TEXELS_PER_TILE));
    floorPatterns.set(Number(id) as FloorId, pattern);
    draw();
  };
  image.src = url;
}

// A wall prop's bar: along the given side of `length` tiles from (x, y), just inside them.
function wallEdge(x: number, y: number, length: number, side: WallSide): [number, number, number, number] {
  const inset = 2;
  if (side === 'north') return [x * CELL, y * CELL + inset, (x + length) * CELL, y * CELL + inset];
  if (side === 'south') return [x * CELL, (y + 1) * CELL - inset, (x + length) * CELL, (y + 1) * CELL - inset];
  if (side === 'west') return [x * CELL + inset, y * CELL, x * CELL + inset, (y + length) * CELL];
  return [(x + 1) * CELL - inset, y * CELL, (x + 1) * CELL - inset, (y + length) * CELL];
}

function strokeLine([x0, y0, x1, y1]: [number, number, number, number]): void {
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
}

function drawProps(): void {
  const layout = layoutProps(map);
  context.globalAlpha = layer === 'props' ? 1 : 0.5;
  context.font = '9px monospace';
  map.props.forEach((prop, index) => {
    const spec = PROP_SPECS[prop.type];
    const [width, depth] = footprintSize(prop);
    const [left, top, w, h] = [prop.x * CELL, prop.y * CELL, width * CELL, depth * CELL];
    const [cx, cy] = [left + w / 2, top + h / 2];
    context.fillStyle = PROP_COLORS[spec.group];
    context.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    if (spec.kind === 'tabletop') {
      context.beginPath();
      context.arc(cx, cy, CELL * 0.3, 0, 2 * Math.PI);
      context.fill();
      context.stroke();
      return;
    }
    context.fillRect(left + 1, top + 1, w - 2, h - 2);
    context.strokeRect(left + 1.5, top + 1.5, w - 3, h - 3);
    // The front: unturned it faces down the grid, and turns clockwise from there.
    const angle = (prop.rotation * Math.PI) / 180;
    context.fillStyle = '#f2efe6';
    context.fillRect(cx - Math.sin(angle) * (w / 2 - 3) - 1, cy + Math.cos(angle) * (h / 2 - 3) - 1, 2, 2);
    context.fillStyle = '#12160f';
    context.fillText(PROP_TAGS[prop.type], cx, cy + 1);
    const level = layout.stacks[index].level;
    if (level > 1) {
      context.fillStyle = '#f2efe6';
      context.fillText(String(level), left + 4, top + 5);
    }
  });
  context.lineWidth = 3;
  context.strokeStyle = PROP_COLORS.Wall;
  for (const wallProp of map.wallProps) {
    strokeLine(wallEdge(wallProp.x, wallProp.y, PROP_SPECS[wallProp.type].size[0], wallProp.side));
  }
  context.lineWidth = 1;
  context.globalAlpha = 1;
}

// The props tool's preview under the pointer.
function drawPreview(): void {
  if (layer !== 'props' || !hover) return;
  const candidate = withPending(hover);
  context.strokeStyle = placementProblem(candidate) ? PREVIEW_COLORS.blocked : PREVIEW_COLORS.fits;
  context.lineWidth = 2;
  const type = propTool();
  if (PROP_SPECS[type].kind === 'wall') {
    context.lineWidth = 3;
    strokeLine(wallEdge(hover.x, hover.y, PROP_SPECS[type].size[0], hover.edge));
  } else {
    const [width, depth] = footprintSize(candidate.props.at(-1)!);
    context.strokeRect(hover.x * CELL + 1, hover.y * CELL + 1, width * CELL - 2, depth * CELL - 2);
  }
  context.lineWidth = 1;
}

function draw(): void {
  // Resizing the canvas resets its transform, so the zoom is set again every draw.
  canvas.width = map.width * CELL * ZOOM;
  canvas.height = map.height * CELL * ZOOM;
  context.setTransform(ZOOM, 0, 0, ZOOM, 0, 0);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const wall = map.terrain[y][x] === TERRAIN.wall;
      context.fillStyle = wall
        ? WALLPAPER_COLORS[map.wallpaper[y][x]]
        : floorPatterns.get(map.floor[y][x]) ?? COLORS.open;
      context.fillRect(x * CELL, y * CELL, CELL, CELL);
      if (wall) {
        // A dark inner edge tells a wall from a floor of a similar colour.
        context.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        context.strokeRect(x * CELL + 1.5, y * CELL + 1.5, CELL - 3, CELL - 3);
      }
      // Dim whatever the current finish layer cannot paint.
      if ((layer === 'floor' && wall) || (layer === 'wallpaper' && !wall)) {
        context.fillStyle = 'rgba(10, 12, 11, 0.6)';
        context.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }
  const floorAt = (x: number, y: number) =>
    (x >= 0 && y >= 0 && x < map.width && y < map.height && map.terrain[y][x] === TERRAIN.open ? map.floor[y][x] : null);
  context.lineWidth = 2;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const floor = floorAt(x, y);
      const color = floor === null ? undefined : BORDER_COLORS[floor];
      if (!color) continue;
      context.strokeStyle = color;
      context.beginPath();
      const [left, top, right, bottom] = [x * CELL + 1, y * CELL + 1, (x + 1) * CELL - 1, (y + 1) * CELL - 1];
      if (floorAt(x, y - 1) !== floor) { context.moveTo(left, top); context.lineTo(right + 1, top); }
      if (floorAt(x, y + 1) !== floor) { context.moveTo(left, bottom); context.lineTo(right + 1, bottom); }
      if (floorAt(x - 1, y) !== floor) { context.moveTo(left, top); context.lineTo(left, bottom + 1); }
      if (floorAt(x + 1, y) !== floor) { context.moveTo(right, top); context.lineTo(right, bottom + 1); }
      context.stroke();
    }
  }
  context.lineWidth = 1;
  // Markers sit on top of their Open tile, drawn as a filled square with a letter.
  context.font = '10px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const marker of map.markers) {
    context.fillStyle = COLORS[marker.type];
    context.fillRect(marker.x * CELL + 2, marker.y * CELL + 2, CELL - 4, CELL - 4);
    context.fillStyle = '#12160f';
    context.fillText(MARKER_LETTERS[marker.type], marker.x * CELL + CELL / 2, marker.y * CELL + CELL / 2 + 1);
  }
  drawProps();
  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;
  for (let x = 0; x <= map.width; x++) {
    context.beginPath();
    context.moveTo(x * CELL + 0.5, 0);
    context.lineTo(x * CELL + 0.5, map.height * CELL);
    context.stroke();
  }
  for (let y = 0; y <= map.height; y++) {
    context.beginPath();
    context.moveTo(0, y * CELL + 0.5);
    context.lineTo(map.width * CELL, y * CELL + 0.5);
    context.stroke();
  }
  drawPreview();
}

function syncFields(): void {
  nameInput.value = map.name;
  widthInput.value = String(map.width);
  heightInput.value = String(map.height);
  boundarySelect.value = String(map.boundaryWallpaper);
}

// One finish on one tile. A floor goes on Open tiles and a wallpaper on Wall tiles: those are
// the only places the game shows them. Erasing puts the finish back to Plain.
function paintFinish(x: number, y: number, erasing: boolean): string | null {
  const wall = map.terrain[y][x] === TERRAIN.wall;
  if (layer === 'floor') {
    if (wall) return `(${x}, ${y}) is Wall: floors show only on Open tiles. Switch layer to paint its wallpaper.`;
    map.floor[y][x] = erasing ? FLOOR.plain : (selected.floor as { id: FloorId }).id;
    return null;
  }
  if (!wall) return `(${x}, ${y}) is Open: wallpaper shows only on Wall tiles, on their sides facing Open tiles.`;
  map.wallpaper[y][x] = erasing ? WALLPAPER.plain : (selected.wallpaper as { id: WallpaperId }).id;
  return null;
}

// Shift+click: the same finish over every connected tile that shares this tile's terrain and
// current finish, which is one click per room.
function fillFinish(x: number, y: number, erasing: boolean): string {
  const grid: number[][] = layer === 'floor' ? map.floor : map.wallpaper;
  const terrain = map.terrain[y][x];
  const from = grid[y][x];
  const message = paintFinish(x, y, erasing);
  if (message) return message;
  const to = grid[y][x];
  grid[y][x] = from;
  if (from === to) return `Nothing to fill: (${x}, ${y}) already has that ${LAYER_LABELS[layer].toLowerCase()}.`;
  const stack = [[x, y]];
  let count = 0;
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) continue;
    if (map.terrain[cy][cx] !== terrain || grid[cy][cx] !== from) continue;
    grid[cy][cx] = to;
    count++;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return `Filled ${count} tile(s) from (${x}, ${y}).`;
}

// One painting action on one tile. Returns a message when something notable happened.
function paint(x: number, y: number, erasing: boolean): string | null {
  if (layer !== 'terrain') return paintFinish(x, y, erasing);
  const tool = selected.terrain;
  const existing = markerAt(x, y);
  if (erasing || tool.kind === 'erase') {
    // Erase takes the marker first, so a mis-stroke does not also wipe the terrain.
    if (existing) {
      map.markers = map.markers.filter((marker) => marker !== existing);
      return null;
    }
    map.terrain[y][x] = TERRAIN.open;
    return droppedMessage(pruneProps()).trim() || null;
  }
  if (tool.kind === 'terrain') {
    if (map.terrain[y][x] === tool.id) return null;
    map.terrain[y][x] = tool.id;
    // Props and markers may only stand on Open terrain (and wall props need their wall), so
    // repainting drops whatever no longer fits rather than leaving the map in a state its own
    // validator would reject.
    const dropped = droppedMessage(pruneProps());
    if (tool.id === TERRAIN.wall && existing) {
      map.markers = map.markers.filter((marker) => marker !== existing);
      return `Removed the ${MARKER_LABELS[existing.type]} marker at (${x}, ${y}): markers cannot sit on Wall.${dropped}`;
    }
    return dropped.trim() || null;
  }
  if (tool.kind !== 'marker') return null;
  if (map.terrain[y][x] !== TERRAIN.open) {
    return `(${x}, ${y}) is Wall. Markers can only be placed on Open terrain.`;
  }
  if (layoutProps(map).top[y][x] >= 0) return `(${x}, ${y}) has a prop on it. Markers need a free tile.`;
  if (existing?.type === tool.id) return null;
  if (existing) map.markers = map.markers.filter((marker) => marker !== existing);
  map.markers.push({ type: tool.id, x, y });
  return null;
}

let painting = false;
let lastCell = '';

// The tile under the mouse, and which of its edges the mouse is nearest.
function pointerFrom(event: MouseEvent): Pointer | null {
  const bounds = canvas.getBoundingClientRect();
  const px = ((event.clientX - bounds.left) / bounds.width) * map.width;
  const py = ((event.clientY - bounds.top) / bounds.height) * map.height;
  const x = Math.floor(px);
  const y = Math.floor(py);
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  const [fx, fy] = [px - x, py - y];
  const distances: [WallSide, number][] = [['north', fy], ['east', 1 - fx], ['south', 1 - fy], ['west', fx]];
  const edge = distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
  return { x, y, edge };
}

function apply(event: MouseEvent, erasing: boolean): void {
  const cell = pointerFrom(event);
  if (!cell) return;
  const key = `${cell.x},${cell.y}`;
  if (key === lastCell) return;
  lastCell = key;
  const message = paint(cell.x, cell.y, erasing);
  draw();
  say(message ?? `Painted (${cell.x}, ${cell.y}).`);
}

// Moves the props preview, saying why it cannot go where it is when it cannot.
function hoverAt(at: Pointer | null, force = false): void {
  const same = at && hover && at.x === hover.x && at.y === hover.y && at.edge === hover.edge;
  if ((same || (!at && !hover)) && !force) return;
  hover = at;
  draw();
  if (!at) return;
  const problem = placementProblem(withPending(at));
  if (problem) say(`Cannot place here: ${problem}.`);
  else say(`${PROP_SPECS[propTool()].label} at (${at.x}, ${at.y}), turned ${turnFor(propTool())}°.`);
}

canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  event.preventDefault();
  if (layer === 'props') {
    const at = pointerFrom(event);
    if (!at) return;
    const message = event.button === 2 ? removeProp(at) : placeProp(at);
    draw();
    say(message);
    return;
  }
  if (event.shiftKey && layer !== 'terrain') {
    const cell = pointerFrom(event);
    if (!cell) return;
    const message = fillFinish(cell.x, cell.y, event.button === 2);
    draw();
    say(message);
    return;
  }
  painting = true;
  lastCell = '';
  apply(event, event.button === 2);
});
canvas.addEventListener('mousemove', (event) => {
  if (layer === 'props') {
    hoverAt(pointerFrom(event));
    return;
  }
  if (!painting) return;
  apply(event, (event.buttons & 2) !== 0);
});
canvas.addEventListener('mouseleave', () => hoverAt(null));
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('mouseup', () => { painting = false; });

// R turns the props tool a quarter clockwise; Shift+R turns a barrel 15°.
window.addEventListener('keydown', (event) => {
  if (layer !== 'props' || event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const step = event.shiftKey && PROP_SPECS[propTool()].freeRotation ? 15 : 90;
  rotation = (turnFor(propTool()) + step) % 360;
  if (hover) hoverAt(hover, true);
  else say(`${PROP_SPECS[propTool()].label} turned ${turnFor(propTool())}°.`);
});

function showTools(): void {
  toolBar.replaceChildren();
  let group: PropGroup | null = null;
  for (const entry of TOOLS[layer]) {
    // The props come in groups, each headed by its name.
    if (entry.tool.kind === 'prop' && PROP_SPECS[entry.tool.id].group !== group) {
      group = PROP_SPECS[entry.tool.id].group;
      const heading = document.createElement('span');
      heading.className = 'tool-group';
      heading.textContent = group;
      toolBar.append(heading);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.label;
    button.addEventListener('click', () => {
      selected[layer] = entry.tool;
      for (const other of toolBar.querySelectorAll('button')) other.classList.toggle('selected', other === button);
      say(entry.tool.kind === 'prop' ? `Tool: ${entry.label}, turned ${turnFor(entry.tool.id)}°.` : `Tool: ${entry.label}`);
    });
    if (entry.tool === selected[layer]) button.classList.add('selected');
    toolBar.append(button);
  }
  boundaryLabel.hidden = layer !== 'wallpaper';
}

for (const entry of Object.keys(LAYER_LABELS) as Layer[]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = LAYER_LABELS[entry];
  button.addEventListener('click', () => {
    layer = entry;
    hover = null;
    for (const other of layerBar.children) other.classList.toggle('selected', other === button);
    showTools();
    draw();
    say(entry === 'terrain'
      ? 'Layer: terrain and markers.'
      : entry === 'props'
        ? `Layer: props. ${PROPS_HINT}`
        : `Layer: ${LAYER_LABELS[entry].toLowerCase()}. Shift+click fills the connected area; right click resets to Plain.`);
  });
  if (entry === layer) button.classList.add('selected');
  layerBar.append(button);
}

for (const id of WALLPAPER_IDS) boundarySelect.append(new Option(WALLPAPER_LABELS[id], String(id)));
boundarySelect.addEventListener('change', () => {
  map.boundaryWallpaper = Number(boundarySelect.value) as WallpaperId;
  say(`Boundary wallpaper: ${WALLPAPER_LABELS[map.boundaryWallpaper]}.`);
});

function readDimension(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) return fallback;
  return value;
}

element('#new').addEventListener('click', () => {
  const width = readDimension(widthInput, map.width);
  const height = readDimension(heightInput, map.height);
  // A blank map is all Open: the runtime encloses the grid with the arena boundary, so
  // there is no need to paint a border for the map to be playable.
  map = createEmptyMap(nameInput.value.trim() || 'New Map', width, height);
  syncFields();
  draw();
  say(`New ${width} x ${height} map, all Open.`);
});

element('#resize').addEventListener('click', () => {
  const width = readDimension(widthInput, map.width);
  const height = readDimension(heightInput, map.height);
  if (width === map.width && height === map.height) return;
  // Keep every tile that still exists, with its finishes; anything outside the new bounds is gone.
  const resized = createEmptyMap(map.name, width, height);
  for (let y = 0; y < Math.min(height, map.height); y++) {
    for (let x = 0; x < Math.min(width, map.width); x++) {
      resized.terrain[y][x] = map.terrain[y][x];
      resized.floor[y][x] = map.floor[y][x];
      resized.wallpaper[y][x] = map.wallpaper[y][x];
    }
  }
  resized.boundaryWallpaper = map.boundaryWallpaper;
  resized.markers = map.markers.filter((marker) => marker.x < width && marker.y < height);
  resized.props = map.props;
  resized.wallProps = map.wallProps;
  const dropped = map.markers.length - resized.markers.length;
  map = resized;
  // A prop reaching past the new edge goes, and so does a wall prop that loses its wall to the
  // boundary moving.
  const droppedProps = pruneProps();
  syncFields();
  draw();
  say(`Resized to ${width} x ${height}${dropped > 0 ? `, dropping ${dropped} marker(s) outside the new bounds` : ''}.`
    + droppedMessage(droppedProps));
});

// Only the name box: the size boxes may hold a size New or Resize has yet to read.
nameInput.addEventListener('change', () => { map.name = nameInput.value.trim() || map.name; nameInput.value = map.name; });

element('#load').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    say(`${file.name} is not valid JSON: ${(error as Error).message}`);
    return;
  }
  const result = validateMap(parsed);
  if (!result.ok) {
    say(`${file.name} is not a valid map — ${result.errors.join(' | ')}`);
    return;
  }
  // An older file arrives upgraded, every finish Plain and no props; it exports as the current version.
  map = result.map;
  syncFields();
  draw();
  say(`Loaded ${file.name}: ${map.width} x ${map.height}, ${map.markers.length} marker(s), `
    + `${map.props.length + map.wallProps.length} prop(s).`);
});

element('#export').addEventListener('click', () => {
  // The editor never produces a file its own shared validator would reject.
  const result = validateMap(map);
  if (!result.ok) {
    say(`Cannot export — ${result.errors.join(' | ')}`);
    return;
  }
  const slug = map.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  const rows = (grid: number[][]) => grid.map((row) => `    [${row.join(',')}]`).join(',\n');
  const list = (entries: object[]) => (entries.length === 0 ? '[]' : `[\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]`);
  const markers = map.markers.map((marker) => `    {"type": ${marker.type}, "x": ${marker.x}, "y": ${marker.y}}`).join(',\n');
  const text = `{\n  "version": ${MAP_VERSION},\n  "name": ${JSON.stringify(map.name)},\n`
    + `  "width": ${map.width},\n  "height": ${map.height},\n`
    + `  "terrain": [\n${rows(map.terrain)}\n  ],\n  "floor": [\n${rows(map.floor)}\n  ],\n`
    + `  "wallpaper": [\n${rows(map.wallpaper)}\n  ],\n  "boundaryWallpaper": ${map.boundaryWallpaper},\n`
    + `  "markers": [\n${markers}\n  ],\n`
    + `  "props": ${list(map.props)},\n  "wallProps": ${list(map.wallProps)}\n}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}.json`;
  link.click();
  URL.revokeObjectURL(url);
  say(`Exported ${slug}.json (${map.width} x ${map.height}, ${map.markers.length} marker(s), `
    + `${map.props.length + map.wallProps.length} prop(s)).`);
});

showTools();
syncFields();
draw();
say(`Paint terrain and markers, then the floor and wallpaper layers (a tile is ${TILE_SIZE} world units), then place props, then Export. Maps are validated before they can be exported.`);
