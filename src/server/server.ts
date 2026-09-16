import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { RoomMessage, ServerMessage } from '../shared/protocol.js';
import {
  PLAYER_COUNT, abandonRound, createGame, expireInput, setInput, snapshotFor, startRound, stepGame, type Game,
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
  const tick = setInterval(() => {
    const now = performance.now();
    for (const room of rooms.values()) {
      if (room.game.roundState === 'lobby') continue;
      for (const player of room.players) {
        if (now - player.lastInput > GAMEPLAY.inputTimeoutMs) expireInput(room.game, player.id);
      }
      stepGame(room.game);
      broadcastSnapshots(room);
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
