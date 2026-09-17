import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMap } from '../shared/map/validate.js';
import { buildWorld, type World } from '../shared/map/world.js';
import type { GameMap } from '../shared/map/schema.js';
import type { MapSummary } from '../shared/protocol.js';

// The server's map catalogue: every playable `maps/*.json`, loaded and validated once at
// startup. A room is created on the default entry and its host may switch to any other.
// A world is built once per entry and shared read-only by every room that plays it.
export type MapEntry = { id: string; name: string; map: GameMap; world: World };
export type MapCatalog = { default: MapEntry; entries: readonly MapEntry[]; summaries: MapSummary[] };

export const MAPS_DIR = fileURLToPath(new URL('../../maps/', import.meta.url));
// The map a room starts on. MAP=<id> (the filename without .json) overrides it for a
// playtest without editing anything; tests rely on the plain default.
export const DEFAULT_MAP_ID = 'test-arena';

export function loadMapCatalog(directory: string = MAPS_DIR, defaultId: string = process.env.MAP || DEFAULT_MAP_ID): MapCatalog {
  const entries: MapEntry[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    const id = basename(file, '.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    } catch (error) {
      console.warn(`[maps] skipping ${file}: not valid JSON (${(error as Error).message})`);
      continue;
    }
    const result = validateMap(parsed);
    if (!result.ok) {
      // A half-finished export must not take the server down; it just stays out of the picker.
      console.warn(`[maps] skipping ${file}:\n- ${result.errors.join('\n- ')}`);
      continue;
    }
    entries.push({ id, name: result.map.name, map: result.map, world: buildWorld(result.map) });
  }
  const fallback = entries.find((entry) => entry.id === defaultId);
  if (!fallback) {
    throw new Error(
      `Default map "${defaultId}" is missing from ${directory} or failed validation; ` +
      `playable maps: ${entries.map((entry) => entry.id).join(', ') || 'none'}`,
    );
  }
  return { default: fallback, entries, summaries: entries.map(({ id, name }) => ({ id, name })) };
}
