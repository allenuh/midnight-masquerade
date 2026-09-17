// Developer-only tile map editor. It shares the map schema and validator with the game
// (src/shared/map) and knows nothing else about it: no gameplay, no networking, no 3D.
// Everything here is local — files are read and written through the browser only.
import {
  MARKER, MARKER_LABELS, MAX_DIMENSION, MIN_CREATURE_SPAWNS, MIN_DIMENSION, MIN_HUNTER_SPAWNS, TERRAIN, TERRAIN_LABELS,
  countMarkers, createEmptyMap, type GameMap, type MarkerId, type TerrainId,
} from '../../src/shared/map/schema.js';
import { validateMap } from '../../src/shared/map/validate.js';
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

// A tool paints one terrain id, places one marker, or erases.
type Tool = { kind: 'terrain'; id: TerrainId } | { kind: 'marker'; id: MarkerId } | { kind: 'erase' };
const TOOLS: { label: string; tool: Tool }[] = [
  { label: TERRAIN_LABELS[TERRAIN.open], tool: { kind: 'terrain', id: TERRAIN.open } },
  { label: TERRAIN_LABELS[TERRAIN.wall], tool: { kind: 'terrain', id: TERRAIN.wall } },
  { label: MARKER_LABELS[MARKER.batterySpawn], tool: { kind: 'marker', id: MARKER.batterySpawn } },
  { label: MARKER_LABELS[MARKER.creatureSpawn], tool: { kind: 'marker', id: MARKER.creatureSpawn } },
  { label: MARKER_LABELS[MARKER.hunterSpawn], tool: { kind: 'marker', id: MARKER.hunterSpawn } },
  { label: 'Erase', tool: { kind: 'erase' } },
];
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
const toolBar = element('#tools');
const statusText = element('#status');

let map: GameMap = createEmptyMap('New Map', 48, 30);
let tool: Tool = TOOLS[1].tool;

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

function draw(): void {
  canvas.width = map.width * CELL;
  canvas.height = map.height * CELL;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      context.fillStyle = map.terrain[y][x] === TERRAIN.wall ? COLORS.wall : COLORS.open;
      context.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
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
}

// One painting action on one tile. Returns a message when something notable happened.
function paint(x: number, y: number, erasing: boolean): string | null {
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

for (const entry of TOOLS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = entry.label;
  button.addEventListener('click', () => {
    tool = entry.tool;
    for (const other of toolBar.children) other.classList.toggle('selected', other === button);
    say(`Tool: ${entry.label}`);
  });
  if (entry.tool === tool) button.classList.add('selected');
  toolBar.append(button);
}

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
  // Keep every tile that still exists; anything outside the new bounds is gone.
  const resized = createEmptyMap(map.name, width, height);
  for (let y = 0; y < Math.min(height, map.height); y++) {
    for (let x = 0; x < Math.min(width, map.width); x++) resized.terrain[y][x] = map.terrain[y][x];
  }
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
  const rows = map.terrain.map((row) => `    [${row.join(',')}]`).join(',\n');
  const markers = map.markers.map((marker) => `    {"type": ${marker.type}, "x": ${marker.x}, "y": ${marker.y}}`).join(',\n');
  const text = `{\n  "version": ${map.version},\n  "name": ${JSON.stringify(map.name)},\n`
    + `  "width": ${map.width},\n  "height": ${map.height},\n`
    + `  "terrain": [\n${rows}\n  ],\n  "markers": [\n${markers}\n  ]\n}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}.json`;
  link.click();
  URL.revokeObjectURL(url);
  say(`Exported ${slug}.json (${map.width} x ${map.height}, ${map.markers.length} marker(s)).`);
});

syncFields();
draw();
say('Paint terrain and markers, then Export. Maps are validated before they can be exported.');
