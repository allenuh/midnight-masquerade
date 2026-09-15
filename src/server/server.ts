import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { Role } from '../shared/protocol.js';
import { createGame, emptyInput, joinGame, leaveGame, restartGame, setInput, snapshotFor, stepGame } from './game.js';

export function createGameServer() {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== '/ws') return;
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
  });
  const game = createGame();
  const clients = new Map<Role, { socket: WebSocket; lastInput: number; alive: boolean }>();
  let closing = false;
  let lastRestart = -Infinity;

  function broadcast(): void {
    for (const [role, client] of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.socket.bufferedAmount > 64 * 1024) {
        client.socket.terminate();
        continue;
      }
      // The role is bound to the connection, never supplied by an input message.
      client.socket.send(JSON.stringify(snapshotFor(game, role)));
    }
  }

  sockets.on('connection', (socket) => {
    socket.on('error', () => socket.terminate());
    const role: Role | null = !clients.has('hunter') ? 'hunter' : !clients.has('creature') ? 'creature' : null;
    if (!role) {
      socket.send(JSON.stringify({ type: 'full' }));
      socket.close(1008, 'Two players are already connected');
      return;
    }

    const client = { socket, lastInput: performance.now(), alive: true };
    clients.set(role, client);
    joinGame(game, role);
    broadcast();

    socket.on('pong', () => { client.alive = true; });
    socket.on('message', (data, isBinary) => {
      if (isBinary || closing) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const now = performance.now();
      if (setInput(game, role, message)) {
        client.lastInput = now;
      } else if (
        typeof message === 'object' && message !== null &&
        Object.keys(message).length === 1 && 'type' in message && message.type === 'restart' &&
        clients.size === 2 && now - lastRestart >= 500
      ) {
        lastRestart = now;
        restartGame(game);
        broadcast();
      }
    });

    socket.on('close', () => {
      clients.delete(role);
      if (closing) return;
      leaveGame(game, role);
      broadcast();
    });
  });

  // Input volume cannot advance simulation time. A stalled loop slows the game
  // instead of applying a large catch-up step or accepting a client's delta time.
  const tick = setInterval(() => {
    const now = performance.now();
    for (const [role, client] of clients) {
      if (now - client.lastInput > GAMEPLAY.inputTimeoutMs) game.inputs[role] = emptyInput();
    }
    stepGame(game);
    broadcast();
  }, Math.ceil(1000 / GAMEPLAY.tickRate));

  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
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
