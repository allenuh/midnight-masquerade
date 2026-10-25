// Developer-only tile map editor. It shares the map schema and validator with the game
// (src/shared/map) and knows nothing else about it: no gameplay, no networking, no 3D.
// Everything here is local — files are read and written through the browser only.
import {
  FLOOR, FLOOR_IDS, FLOOR_LABELS, MAP_VERSION, MARKER, MARKER_LABELS, MAX_DIMENSION, MIN_CREATURE_SPAWNS, MIN_DIMENSION,
  MIN_HUNTER_SPAWNS, TERRAIN, TERRAIN_LABELS, TILE_SIZE, WALLPAPER, WALLPAPER_IDS, WALLPAPER_LABELS,
  countMarkers, createEmptyMap, type FloorId, type GameMap, type MarkerId, type TerrainId, type WallpaperId,
} from '../../src/shared/map/schema.js';
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

// The grid is edited one layer at a time: terrain and markers, the floor finish, or the
// wallpaper finish. Each layer has its own tools; finishes never change collision.
type Layer = 'terrain' | 'floor' | 'wallpaper';
type Tool =
  | { kind: 'terrain'; id: TerrainId } | { kind: 'marker'; id: MarkerId } | { kind: 'erase' }
  | { kind: 'floor'; id: FloorId } | { kind: 'wallpaper'; id: WallpaperId };
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
};
const LAYER_LABELS: Record<Layer, string> = { terrain: 'Terrain & markers', floor: 'Floor', wallpaper: 'Wallpaper' };
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
const selected: Record<Layer, Tool> = { terrain: TOOLS.terrain[1].tool, floor: TOOLS.floor[1].tool, wallpaper: TOOLS.wallpaper[1].tool };

// Marker tally with the playability minimums, so an author can see when Export will work.
function tally(): string {
  const creatures = countMarkers(map, MARKER.creatureSpawn);
  const hunters = countMarkers(map, MARKER.hunterSpawn);
  return `Battery ${countMarkers(map, MARKER.batterySpawn)} · Creature ${creatures}/${MIN_CREATURE_SPAWNS}`
    + ` · Hunter ${hunters}/${MIN_HUNTER_SPAWNS}${creatures >= MIN_CREATURE_SPAWNS && hunters >= MIN_HUNTER_SPAWNS ? '' : ' — not yet playable'}`;
}

function say(message: string): void {
  statusText.textContent = `${message}  [${tally()}]`;
}

const markerAt = (x: number, y: number) => map.markers.find((marker) => marker.x === x && marker.y === y);

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

function draw(): void {
  canvas.width = map.width * CELL;
  canvas.height = map.height * CELL;
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
  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;
  for (let x = 0; x <= map.width; x++) {
    context.beginPath();
    context.moveTo(x * CELL + 0.5, 0);
    context.lineTo(x * CELL + 0.5, canvas.height);
    context.stroke();
  }
  for (let y = 0; y <= map.height; y++) {
    context.beginPath();
    context.moveTo(0, y * CELL + 0.5);
    context.lineTo(canvas.width, y * CELL + 0.5);
    context.stroke();
  }
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
    return null;
  }
  if (tool.kind === 'terrain') {
    if (map.terrain[y][x] === tool.id) return null;
    map.terrain[y][x] = tool.id;
    // A marker may only sit on Open terrain, so walling a tile drops its marker rather
    // than leaving the map in a state its own validator would reject.
    if (tool.id === TERRAIN.wall && existing) {
      map.markers = map.markers.filter((marker) => marker !== existing);
      return `Removed the ${MARKER_LABELS[existing.type]} marker at (${x}, ${y}): markers cannot sit on Wall.`;
    }
    return null;
  }
  if (tool.kind !== 'marker') return null;
  if (map.terrain[y][x] !== TERRAIN.open) {
    return `(${x}, ${y}) is Wall. Markers can only be placed on Open terrain.`;
  }
  if (existing?.type === tool.id) return null;
  if (existing) map.markers = map.markers.filter((marker) => marker !== existing);
  map.markers.push({ type: tool.id, x, y });
  return null;
}

let painting = false;
let lastCell = '';

function cellFrom(event: MouseEvent): { x: number; y: number } | null {
  const bounds = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - bounds.left) / CELL);
  const y = Math.floor((event.clientY - bounds.top) / CELL);
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return { x, y };
}

function apply(event: MouseEvent, erasing: boolean): void {
  const cell = cellFrom(event);
  if (!cell) return;
  const key = `${cell.x},${cell.y}`;
  if (key === lastCell) return;
  lastCell = key;
  const message = paint(cell.x, cell.y, erasing);
  draw();
  say(message ?? `Painted (${cell.x}, ${cell.y}).`);
}

canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  event.preventDefault();
  if (event.shiftKey && layer !== 'terrain') {
    const cell = cellFrom(event);
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
  if (!painting) return;
  apply(event, (event.buttons & 2) !== 0);
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('mouseup', () => { painting = false; });

function showTools(): void {
  toolBar.replaceChildren();
  for (const entry of TOOLS[layer]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.label;
    button.addEventListener('click', () => {
      selected[layer] = entry.tool;
      for (const other of toolBar.children) other.classList.toggle('selected', other === button);
      say(`Tool: ${entry.label}`);
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
    for (const other of layerBar.children) other.classList.toggle('selected', other === button);
    showTools();
    draw();
    say(entry === 'terrain'
      ? 'Layer: terrain and markers.'
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
  const dropped = map.markers.length - resized.markers.length;
  map = resized;
  syncFields();
  draw();
  say(`Resized to ${width} x ${height}${dropped > 0 ? `, dropping ${dropped} marker(s) outside the new bounds` : ''}.`);
});

nameInput.addEventListener('change', () => { map.name = nameInput.value.trim() || map.name; syncFields(); });

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
  // A version 1 file arrives upgraded, every finish Plain; it exports as the current version.
  map = result.map;
  syncFields();
  draw();
  say(`Loaded ${file.name}: ${map.width} x ${map.height}, ${map.markers.length} marker(s).`);
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
  const markers = map.markers.map((marker) => `    {"type": ${marker.type}, "x": ${marker.x}, "y": ${marker.y}}`).join(',\n');
  const text = `{\n  "version": ${MAP_VERSION},\n  "name": ${JSON.stringify(map.name)},\n`
    + `  "width": ${map.width},\n  "height": ${map.height},\n`
    + `  "terrain": [\n${rows(map.terrain)}\n  ],\n  "floor": [\n${rows(map.floor)}\n  ],\n`
    + `  "wallpaper": [\n${rows(map.wallpaper)}\n  ],\n  "boundaryWallpaper": ${map.boundaryWallpaper},\n`
    + `  "markers": [\n${markers}\n  ]\n}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}.json`;
  link.click();
  URL.revokeObjectURL(url);
  say(`Exported ${slug}.json (${map.width} x ${map.height}, ${map.markers.length} marker(s)).`);
});

showTools();
syncFields();
draw();
say(`Paint terrain and markers, then the floor and wallpaper layers (a tile is ${TILE_SIZE} world units), then Export. Maps are validated before they can be exported.`);
