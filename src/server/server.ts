import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { flashlightStage } from '../shared/flashlight.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { RoomMessage, ServerMessage } from '../shared/protocol.js';
import {
  MATCH_SECONDS, PLAYER_COUNT, REVIVE_TICKS, STEP_SECONDS, abandonRound, createGame, expireInput,
  hunterProximity, setInput, snapshotFor, startRound, stepGame, type Game,
} from './game.js';

type Client = { id: string; socket: WebSocket; lastInput: number; alive: boolean; room: Room | null };
// The host's only authority is starting rounds; the simulation never consults it.
type Room = { code: string; host: Client; players: Client[]; game: Game; lastStart: number };

// Room codes avoid characters that are easily confused when read aloud or typed.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
export const ROOM_CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function createGameServer() {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== '/ws') return;
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
  });
  const rooms = new Map<string, Room>();
  const clients = new Set<Client>();
  let nextClientId = 1;
  let closing = false;

  function send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > 64 * 1024) {
      client.socket.terminate();
      return;
    }
    client.socket.send(JSON.stringify(message));
  }

  function broadcastRoom(room: Room, notice: RoomMessage['notice'] = null): void {
    for (const player of room.players) {
      send(player, { type: 'room', code: room.code, players: room.players.length, host: room.host === player, notice });
    }
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
      ` duration=${(MATCH_SECONDS - game.timeTicks * STEP_SECONDS).toFixed(1)}s` +
      ` creatureHp=${game.creatureState.hp.toFixed(1)} downs=${stats.incapacitations} revives=${stats.revives}` +
      ` batteries=${stats.pickupsCollected} light=[${lightSeconds}]`,
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
      ` ${hunter.down ? `DOWN ${Math.floor(100 * hunter.reviveTicks / REVIVE_TICKS)}%` : 'ACTIVE'}` +
      ` ${hunterProximity(game, hunter)}`).join(' | ');
    console.log(
      `[debug] room=${code} t=${(game.timeTicks * STEP_SECONDS).toFixed(1)}s hp=${state.hp.toFixed(1)}` +
      ` sprintCd=${(state.sprintCooldownTicks * STEP_SECONDS).toFixed(1)}` +
      ` staggerCd=${(state.staggerCooldownTicks * STEP_SECONDS).toFixed(1)}` +
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

  function createRoom(client: Client): void {
    const room: Room = { code: newCode(), host: client, players: [client], game: createGame(), lastStart: -Infinity };
    rooms.set(room.code, room);
    client.room = room;
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
    broadcastRoom(room);
  }

  // Disconnect policy. Host gone: the room closes and everyone else is told why (no
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
      return;
    }
    if (room.host === client) {
      rooms.delete(room.code);
      for (const player of room.players) {
        player.room = null;
        send(player, { type: 'error', reason: 'host-left' });
        player.socket.close(1000, 'The host left the room');
      }
      return;
    }
    const inProgress = room.game.roundState === 'reveal' || room.game.roundState === 'running';
    if (room.game.roundState !== 'lobby') abandonRound(room.game);
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
    } else if (
      fields.type === 'start' && keys.length === 1 && room && room.host === client &&
      room.players.length === PLAYER_COUNT && now - room.lastStart >= 500
    ) {
      // Starting again during or after a round is the testing reset: new spawns, new roles.
      room.lastStart = now;
      startRound(room.game, room.players.map((player) => player.id));
      broadcastSnapshots(room);
    }
  }

  sockets.on('connection', (socket) => {
    socket.on('error', () => socket.terminate());
    const client: Client = { id: `p${nextClientId++}`, socket, lastInput: performance.now(), alive: true, room: null };
    clients.add(client);

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
      leaveRoom(client);
    });
  });

  // Input volume cannot advance simulation time. A stalled loop slows the game
  // instead of applying a large catch-up step or accepting a client's delta time.
  let debugTicks = 0;
  const tick = setInterval(() => {
    const now = performance.now();
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
  }, Math.ceil(1000 / GAMEPLAY.tickRate));

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
