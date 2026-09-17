import {
  MARKER, MARKER_LABELS, MAX_DIMENSION, MIN_CREATURE_SPAWNS, MIN_DIMENSION, MIN_HUNTER_SPAWNS,
  SUPPORTED_MAP_VERSIONS, TERRAIN,
  isMarkerId, isTerrainId, type GameMap, type MapMarker, type MarkerId, type TerrainId,
} from './schema.js';

// Shared validation: the editor refuses to export anything this rejects, and the
// runtime refuses to load it. Errors are developer-readable sentences, and a
// malformed map is never silently repaired.

export type MapValidation = { ok: true; map: GameMap } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;

export function validateMap(value: unknown): MapValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['map must be a JSON object'] };

  if (value.version === undefined) errors.push('map is missing "version"');
  else if (typeof value.version !== 'number' || !SUPPORTED_MAP_VERSIONS.includes(value.version)) {
    errors.push(`unsupported map version ${JSON.stringify(value.version)}; this build reads ${SUPPORTED_MAP_VERSIONS.join(', ')}`);
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') errors.push('"name" must be a non-empty string');
  if (!isDimension(value.width)) {
    errors.push(`"width" must be a whole number from ${MIN_DIMENSION} to ${MAX_DIMENSION}, got ${JSON.stringify(value.width)}`);
  }
  if (!isDimension(value.height)) {
    errors.push(`"height" must be a whole number from ${MIN_DIMENSION} to ${MAX_DIMENSION}, got ${JSON.stringify(value.height)}`);
  }
  // Dimensions gate every later check, so stop here rather than report noise from them.
  if (errors.length > 0) return { ok: false, errors };
  const width = value.width as number;
  const height = value.height as number;

  if (!Array.isArray(value.terrain)) {
    errors.push('"terrain" must be an array of rows');
    return { ok: false, errors };
  }
  if (value.terrain.length !== height) {
    errors.push(`"terrain" has ${value.terrain.length} rows but "height" is ${height}`);
  }
  value.terrain.forEach((row, y) => {
    if (!Array.isArray(row)) {
      errors.push(`terrain row ${y} must be an array`);
      return;
    }
    if (row.length !== width) errors.push(`terrain row ${y} has ${row.length} tiles but "width" is ${width}`);
    row.forEach((tile, x) => {
      if (!isTerrainId(tile)) errors.push(`terrain (${x}, ${y}) has unknown id ${JSON.stringify(tile)}`);
    });
  });

  if (!Array.isArray(value.markers)) {
    errors.push('"markers" must be an array');
    return { ok: false, errors };
  }
  value.markers.forEach((marker, index) => {
    if (!isRecord(marker)) {
      errors.push(`marker ${index} must be an object`);
      return;
    }
    if (!isMarkerId(marker.type)) {
      errors.push(`marker ${index} has unknown type ${JSON.stringify(marker.type)}`);
    }
    const inBounds = (coordinate: unknown, limit: number): boolean =>
      typeof coordinate === 'number' && Number.isInteger(coordinate) && coordinate >= 0 && coordinate < limit;
    if (!inBounds(marker.x, width) || !inBounds(marker.y, height)) {
      errors.push(`marker ${index} at (${JSON.stringify(marker.x)}, ${JSON.stringify(marker.y)}) is outside the ${width} x ${height} grid`);
      return;
    }
    // A marker is always "Open terrain plus a marker": it never replaces terrain.
    const row = value.terrain as unknown[];
    const tile = (row[marker.y as number] as unknown[] | undefined)?.[marker.x as number];
    if (tile !== TERRAIN.open) {
      const label = isMarkerId(marker.type) ? MARKER_LABELS[marker.type as MarkerId] : 'marker';
      errors.push(`marker ${index} (${label}) at (${marker.x}, ${marker.y}) is not on Open terrain`);
    }
  });

  // Playability: the round needs somewhere to put one Creature and a full team of
  // Hunters, each on a marker of its own. More markers than that are fine and give the
  // spawn roll something to vary; fewer leave the server nothing to choose from.
  const count = (type: MarkerId): number =>
    (value.markers as unknown[]).filter((marker) => isRecord(marker) && marker.type === type).length;
  const creatureSpawns = count(MARKER.creatureSpawn);
  const hunterSpawns = count(MARKER.hunterSpawn);
  if (creatureSpawns < MIN_CREATURE_SPAWNS) {
    errors.push(`map needs at least ${MIN_CREATURE_SPAWNS} ${MARKER_LABELS[MARKER.creatureSpawn]} marker(s), has ${creatureSpawns}`);
  }
  if (hunterSpawns < MIN_HUNTER_SPAWNS) {
    errors.push(`map needs at least ${MIN_HUNTER_SPAWNS} ${MARKER_LABELS[MARKER.hunterSpawn]} markers, has ${hunterSpawns}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    map: {
      version: value.version as number,
      name: value.name as string,
      width,
      height,
      terrain: value.terrain as TerrainId[][],
      markers: value.markers as MapMarker[],
    },
  };
}

// Convenience for the two runtime entry points: parse + validate or throw with every error.
export function parseMap(text: string, source: string): GameMap {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const result = validateMap(value);
  if (!result.ok) throw new Error(`${source} is not a valid map:\n- ${result.errors.join('\n- ')}`);
  return result.map;
}
