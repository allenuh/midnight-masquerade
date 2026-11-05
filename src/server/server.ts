import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { flashlightStage } from '../shared/flashlight.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { RoomMessage, ServerMessage } from '../shared/protocol.js';
import {
  PLAYER_COUNT, STEP_SECONDS, abandonRound, createGame, expireInput,
  hunterProximity, reviveTicks, secondsToTicks, setInput, snapshotFor, startRound, stepGame, type Game,
} from './game.js';
import { loadMapCatalog, type MapCatalog, type MapEntry } from './maps.js';
import { defaultTuning, tuningDifferences, validateTuning, type Tuning } from '../shared/tuning.js';
import { isDebugRole, startDebugRound } from './debug-room.js'; // DEBUG-ROOM

type Client = { id: string; socket: WebSocket; lastInput: number; alive: boolean; room: Room | null };
// The host's only authority is starting rounds and choosing the map between them; the
// simulation never consults it. `map` is the catalogue entry the room's game plays on.
type Room = {
  code: string; host: Client; players: Client[]; game: Game; map: MapEntry; lastStart: number;
  debug?: true; // DEBUG-ROOM
};

// Room codes avoid characters that are easily confused when read aloud or typed.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
export const ROOM_CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// What a new room starts on: the defaults from gameplay-config.ts, with the match length
// taken from MATCH_SECONDS when the server was started with one. A server-side knob only;
// the host may still change it in the lobby like any other value.
export function roomTuning(): Tuning {
  const tuning = defaultTuning();
  const override = Number(process.env.MATCH_SECONDS);
  if (Number.isFinite(override) && override > 0) tuning.matchSeconds = override;
  return tuning;
}

// `log` is the console line per connection and room event; tests turn it off.
export function createGameServer(catalog: MapCatalog = loadMapCatalog(), { log = true } = {}) {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  // The game socket lives at /ws, relative to whatever origin served the page. Any other
  // upgrade is refused and closed, unless another listener shares this server (Vite's
  // HMR socket in development), in which case it is that listener's to answer.
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== '/ws') {
      if (server.listenerCount('upgrade') === 1) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
  });
  const rooms = new Map<string, Room>();
  const clients = new Set<Client>();
  let nextClientId = 1;
  let closing = false;

  // Connection and room events on the server console, so a remote session can be
  // followed from the host machine: connection ids and room codes only, nothing that
  // identifies a person, and nothing stored.
  function logRoom(room: Room, event: string): void {
    if (log) console.log(`[room] ${room.code} ${event} (${room.players.length}/${PLAYER_COUNT})`);
  }
  function logConnection(client: Client, event: string): void {
    if (log) console.log(`[conn] ${client.id} ${event}, ${clients.size} connected`);
  }

  function send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > 64 * 1024) {
      client.socket.terminate();
      return;
    }
    client.socket.send(JSON.stringify(message));
  }

  function broadcastRoom(room: Room, notice: RoomMessage['notice'] = null): void {
    for (const [seat, player] of room.players.entries()) {
      send(player, {
        type: 'room', code: room.code, players: room.players.length, host: room.host === player, seat, notice,
        maps: catalog.summaries, mapId: room.map.id, tuning: room.game.tuning,
      });
    }
  }

  // The full map, from which a client builds its scene. Sent to one client on join and to
  // everyone when the host switches; the client bundles no map of its own.
  function sendMap(client: Client, room: Room): void {
    send(client, { type: 'map', map: room.map.map });
  }

  function broadcastSnapshots(room: Room): void {
    if (room.game.roundState === 'lobby') return;
    // Each player's role is bound to its connection id, never supplied by a message.
    for (const player of room.players) send(player, snapshotFor(room.game, player.id));
  }

  // One line of playtest data per finished round, on the server console. Counters only:
  // no storage, no player identity, no telemetry service.
  function logRoundStats(room: Room): void {
    const { game } = room;
    const { stats } = game;
    const lightSeconds = Object.entries(stats.lightTicks)
      .map(([id, ticks]) => `${id} ${(ticks * STEP_SECONDS).toFixed(1)}s`).join(' ');
    console.log(
      `[round] room=${room.code} id=${game.roundId} result=${game.result}` +
      ` duration=${(game.tuning.matchSeconds - game.timeTicks * STEP_SECONDS).toFixed(1)}s` +
      ` creatureHp=${game.creatureState.hp.toFixed(1)} downs=${stats.incapacitations} revives=${stats.revives}` +
      ` batteries=${stats.pickupsCollected} exposure=${(stats.exposureTicks * STEP_SECONDS).toFixed(1)}s light=[${lightSeconds}]` +
      ` tuning=[${tuningDifferences(game.tuning)}]`,
    );
  }

  // DEBUG_SERVER=1 prints the whole balance picture once a second, including every
  // Hunter's proximity band. Deliberately server-side: no client is ever sent the four
  // bands together, because that would locate the Creature by triangulation.
  const debugServer = process.env.DEBUG_SERVER === '1';
  function logDebugState(room: Room): void {
    const { game, code } = room;
    const state = game.creatureState;
    // The one place the battery's spawn countdown appears: clients are told where the
    // battery is, never when the next one is due.
    const battery = game.pickup.at === null
      ? `none (next in ${(game.pickup.spawnTicks * STEP_SECONDS).toFixed(1)}s)`
      : `point ${game.pickup.at}`;
    const hunters = game.hunters.map((hunter) =>
      `${hunter.id} ${hunter.battery.toFixed(0)}/${flashlightStage(hunter.battery)}` +
      ` ${hunter.down ? `DOWN ${Math.floor(100 * hunter.reviveTicks / reviveTicks(game.tuning))}%` : 'ACTIVE'}` +
      ` ${hunterProximity(game, hunter)}`).join(' | ');
    console.log(
      `[debug] room=${code} t=${(game.timeTicks * STEP_SECONDS).toFixed(1)}s hp=${state.hp.toFixed(1)}` +
      ` sprintCd=${(state.sprintCooldownTicks * STEP_SECONDS).toFixed(1)}` +
      ` staggerCd=${(state.staggerCooldownTicks * STEP_SECONDS).toFixed(1)}` +
      ` burn=${(state.burnTicks * STEP_SECONDS).toFixed(1)}` +
      ` battery=${battery}` +
      ` active=${game.hunters.filter((hunter) => !hunter.down).length} :: ${hunters}`,
    );
  }

  function newCode(): string {
    let code: string;
    do {
      code = '';
      for (let index = 0; index < CODE_LENGTH; index++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    } while (rooms.has(code));
    return code;
  }

  function createRoom(client: Client, debug = false): void { // DEBUG-ROOM: the debug parameter
    const map = catalog.default;
    const room: Room = {
      code: newCode(), host: client, players: [client], game: createGame(map.world, roomTuning()), map, lastStart: -Infinity,
    };
    if (debug) room.debug = true; // DEBUG-ROOM
    rooms.set(room.code, room);
    client.room = room;
    logRoom(room, `${debug ? 'debug room ' : ''}created by ${client.id} on ${map.id}`); // DEBUG-ROOM: the debug label
    sendMap(client, room);
    broadcastRoom(room);
  }

  // Host only, and only between rounds: a finished round is dropped (roles forgotten, ids
  // kept) and the room's game is rebuilt on the new map. During the reveal or a running
  // round the request is ignored, so a mis-click never cuts a round short.
  function selectMap(room: Room, id: string): void {
    const entry = catalog.entries.find((candidate) => candidate.id === id);
    if (!entry || entry === room.map) return;
    if (room.game.roundState === 'reveal' || room.game.roundState === 'running') return;
    if (room.game.roundState === 'ended') abandonRound(room.game);
    room.map = entry;
    room.game.world = entry.world;
    for (const player of room.players) sendMap(player, room);
    broadcastRoom(room);
  }

  // Host only, and only between rounds, with the same finished-round handling as the map
  // picker. The whole table is replaced at once and only if every value validates, so the
  // room never holds a half-applied or out-of-bounds tuning. It takes effect at the next
  // start; a running or revealing round is never altered underneath the players.
  function tuneRoom(room: Room, raw: unknown): void {
    const tuning = validateTuning(raw);
    if (!tuning) return;
    if (room.game.roundState === 'reveal' || room.game.roundState === 'running') return;
    room.game.tuning = tuning;
    if (room.game.roundState === 'ended') abandonRound(room.game);
    logRoom(room, `tuning ${tuningDifferences(tuning)}`);
    broadcastRoom(room);
  }

  function joinRoom(client: Client, code: string): void {
    const room = rooms.get(code);
    if (!room) {
      send(client, { type: 'error', reason: 'not-found' });
      return;
    }
    // A room in a round always holds every player, so it is simply full.
    if (room.players.length >= PLAYER_COUNT) {
      send(client, { type: 'error', reason: 'full' });
      return;
    }
    room.players.push(client);
    client.room = room;
    logRoom(room, `${client.id} joined`);
    sendMap(client, room);
    broadcastRoom(room);
  }

  // Disconnect policy, also used when a player leaves with the room's Leave button (the
  // connection then stays open for the title screen). Host gone: the room closes and everyone else is told why (no
  // host migration). Anyone else gone: the round (running or finished) is dropped and
  // the rest wait in the lobby for a fifth player, with a notice if play was cut short.
  // No grace period, reconnect, or takeover.
  function leaveRoom(client: Client): void {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.players = room.players.filter((player) => player !== client);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      logRoom(room, `${client.id} left; room closed`);
      return;
    }
    if (room.host === client) {
      rooms.delete(room.code);
      logRoom(room, `host ${client.id} left; room closed`);
      for (const player of room.players) {
        player.room = null;
        send(player, { type: 'error', reason: 'host-left' });
        player.socket.close(1000, 'The host left the room');
      }
      return;
    }
    const inProgress = room.game.roundState === 'reveal' || room.game.roundState === 'running';
    if (room.game.roundState !== 'lobby') abandonRound(room.game);
    logRoom(room, `${client.id} left${inProgress ? '; round abandoned' : ''}`);
    broadcastRoom(room, inProgress ? 'disconnected' : null);
  }

  function handleMessage(client: Client, message: unknown, now: number): void {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const room = client.room;
    if (room && setInput(room.game, client.id, message)) {
      client.lastInput = now;
      return;
    }
    const fields = message as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (fields.type === 'create' && keys.length === 1 && !room) {
      createRoom(client);
    } else if (fields.type === 'join' && keys.length === 2 && typeof fields.code === 'string' && !room) {
      const code = fields.code.trim().toUpperCase();
      if (ROOM_CODE_PATTERN.test(code)) joinRoom(client, code);
      else send(client, { type: 'error', reason: 'not-found' });
    } else if (fields.type === 'selectMap' && keys.length === 2 && typeof fields.id === 'string' && room && room.host === client) {
      selectMap(room, fields.id);
    } else if (fields.type === 'tune' && keys.length === 2 && room && room.host === client) {
      tuneRoom(room, fields.tuning);
    } else if (
      fields.type === 'start' && keys.length === 1 && room && room.host === client &&
      room.players.length === PLAYER_COUNT && now - room.lastStart >= 500
    ) {
      // Starting again during or after a round is the testing reset: new spawns, new roles.
      room.lastStart = now;
      startRound(room.game, room.players.map((player) => player.id));
      broadcastSnapshots(room);
    } else if (fields.type === 'lobby' && keys.length === 1 && room && room.host === client && room.game.roundState === 'ended') {
      // The result screen's "Back to the lobby": the finished round is dropped (roles forgotten)
      // and everyone returns to the room screen. Only once a round has ended, so it never cuts
      // one short.
      abandonRound(room.game);
      logRoom(room, 'back to the lobby');
      broadcastRoom(room);
    } else if (fields.type === 'leave' && keys.length === 1 && room) {
      leaveRoom(client);
    // DEBUG-ROOM: create a debug room, and start one with any number of players.
    } else if (fields.type === 'debugCreate' && keys.length === 1 && !room) {
      createRoom(client, true);
    } else if (
      fields.type === 'debugStart' && keys.length === 2 && isDebugRole(fields.role) && room?.debug && room.host === client &&
      now - room.lastStart >= 500
    ) {
      room.lastStart = now;
      startDebugRound(room.game, room.players.map((player) => player.id), client.id, fields.role);
      broadcastSnapshots(room);
    // DEBUG-ROOM end
    // DEBUG-MENU: the host sets the running clock; at 0 the next step ends the round as expired.
    } else if (
      fields.type === 'setClock' && keys.length === 2 && typeof fields.seconds === 'number' && room && room.host === client &&
      room.game.roundState === 'running' && fields.seconds >= 0 && fields.seconds <= room.game.tuning.matchSeconds
    ) {
      room.game.timeTicks = secondsToTicks(fields.seconds);
    // The host brings the Creature's HP to zero; the next step starts the exorcism.
    } else if (fields.type === 'exorcise' && keys.length === 1 && room && room.host === client && room.game.roundState === 'running') {
      room.game.creatureState.hp = 0;
    // DEBUG-MENU end
    }
  }

  sockets.on('connection', (socket) => {
    socket.on('error', () => socket.terminate());
    const client: Client = { id: `p${nextClientId++}`, socket, lastInput: performance.now(), alive: true, room: null };
    clients.add(client);
    logConnection(client, 'connected');

    socket.on('pong', () => { client.alive = true; });
    socket.on('message', (data, isBinary) => {
      if (isBinary || closing) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleMessage(client, message, performance.now());
    });

    socket.on('close', () => {
      clients.delete(client);
      if (closing) return;
      logConnection(client, 'disconnected');
      leaveRoom(client);
    });
  });

  // Input volume cannot advance simulation time. A stalled loop slows the game
  // instead of applying a large catch-up step or accepting a client's delta time.
  let debugTicks = 0;
  function stepRooms(now: number): void {
    debugTicks += 1;
    for (const room of rooms.values()) {
      if (room.game.roundState === 'lobby') continue;
      for (const player of room.players) {
        if (now - player.lastInput > GAMEPLAY.inputTimeoutMs) expireInput(room.game, player.id);
      }
      const wasRunning = room.game.roundState === 'running';
      stepGame(room.game);
      broadcastSnapshots(room);
      if (wasRunning && room.game.roundState === 'ended') logRoundStats(room);
      if (debugServer && room.game.roundState === 'running' && debugTicks % GAMEPLAY.tickRate === 0) logDebugState(room);
    }
  }

  // Fixed steps, paced by the clock rather than by the timer's own cadence: a timer
  // asked for 34 ms fires every ~47 ms on Windows (15.6 ms granularity), which would run
  // every room at 70 % speed. The timer fires at half a step and each firing takes the
  // steps real time owes, at most MAX_CATCH_UP_STEPS, so a genuine stall still slows the
  // game instead of replaying a burst; the time beyond the cap is dropped, not owed.
  const STEP_MS = 1000 / GAMEPLAY.tickRate;
  const MAX_CATCH_UP_STEPS = 3;
  let nextStepAt = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    for (let steps = 0; nextStepAt <= now && steps < MAX_CATCH_UP_STEPS; steps++) {
      nextStepAt += STEP_MS;
      stepRooms(now);
    }
    if (nextStepAt < now) nextStepAt = now;
  }, Math.ceil(STEP_MS / 2));

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) client.socket.terminate();
      else {
        client.alive = false;
        client.socket.ping();
      }
    }
  }, 5000);

  async function close(): Promise<void> {
    closing = true;
    clearInterval(tick);
    clearInterval(heartbeat);
    rooms.clear();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { server, close };
}
