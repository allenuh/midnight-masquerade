import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createGameServer } from '../src/server/server.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position } from '../src/shared/protocol.js';

type Message = {
  type: string;
  role?: 'hunter' | 'creature';
  roundId?: number;
  roundState?: string;
  result?: string | null;
  hunter?: Position | null;
  creature?: Position;
  proximity?: string;
};

class Peer {
  readonly messages: Message[] = [];
  readonly listeners = new Set<(message: Message) => void>();

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Message;
      this.messages.push(message);
      for (const listener of this.listeners) listener(message);
    });
  }

  static async connect(url: string) {
    const peer = new Peer(new WebSocket(url));
    await once(peer.socket, 'open');
    return peer;
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate: (message: Message) => boolean, after = 0, timeoutMs = 5_000): Promise<Message> {
    const existing = this.messages.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for a server message; last: ${JSON.stringify(this.messages.at(-1))}`));
      }, timeoutMs);
      const listener = (message: Message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      this.listeners.add(listener);
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close();
    const timer = setTimeout(() => this.socket.terminate(), 500);
    await closed;
    clearTimeout(timer);
  }
}

function assertHunterMessage(message: Message) {
  assert.deepEqual(Object.keys(message).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'hunter', 'proximity',
  ].sort());
  assert.equal(message.type, 'snapshot');
  assert.equal(message.role, 'hunter');
  assert.ok(message.hunter);
  assert.deepEqual(Object.keys(message.hunter).sort(), ['x', 'y', 'z']);
  assert.equal(typeof message.hunter.x, 'number');
  assert.equal(typeof message.hunter.y, 'number');
  assert.equal(typeof message.hunter.z, 'number');
  assert.equal(message.hunter.y, GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
  assert.equal(typeof message.roundId, 'number');
  assert.ok(['SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE'].includes(message.proximity!));
  assert.ok(['waiting', 'running', 'ended'].includes(message.roundState!));
  assert.ok(message.result === null || message.result === 'caught');
}

test('real sockets enforce roles, hidden payloads, tagging, restart, and vacant-slot reuse', { timeout: 20_000 }, async (t) => {
  const { server, close } = createGameServer();
  const peers: Peer[] = [];
  t.after(async () => {
    await Promise.all(peers.map((peer) => peer.close()));
    await close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const connect = async () => {
    const peer = await Peer.connect(url);
    peers.push(peer);
    return peer;
  };

  const hunter = await connect();
  const waiting = await hunter.waitFor((message) => message.roundState === 'waiting');
  assertHunterMessage(waiting);
  const creature = await connect();
  const initial = await creature.waitFor((message) => message.roundState === 'running');
  assert.equal(initial.role, 'creature');
  assert.ok(initial.creature && initial.hunter);
  assert.deepEqual(Object.keys(initial.creature).sort(), ['x', 'y', 'z']);
  assert.equal(initial.creature.y, GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
  assert.deepEqual(Object.keys(initial).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'creature', 'hunter',
  ].sort());
  const runningHunter = await hunter.waitFor((message) => message.roundState === 'running');
  assert.equal(runningHunter.proximity, 'SAFE');
  assert.deepEqual(runningHunter.hunter, initial.hunter);

  const third = await connect();
  assert.deepEqual(await third.waitFor((message) => message.type === 'full'), { type: 'full' });
  await third.close();

  const stationaryPosition = { ...runningHunter.hunter! };
  const spoofStart = hunter.messages.length;
  hunter.send({ type: 'position', x: 1, y: 1, z: 1 });
  hunter.send({
    type: 'input', roundId: runningHunter.roundId,
    up: false, down: false, left: false, right: true,
    role: 'creature', x: 1, y: 1, z: 1, speed: 99_999,
  });
  const afterSpoof = await hunter.waitFor(() => hunter.messages.length >= spoofStart + 3, spoofStart);
  assert.deepEqual(afterSpoof.hunter, stationaryPosition);

  // This test controls only the Creature using coordinates that role may receive.
  const chase = (message: Message) => {
    if (message.role !== 'creature' || message.roundState !== 'running' || !message.hunter || !message.creature) return;
    const dx = message.hunter.x - message.creature.x;
    assert.equal(message.creature.y, GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
    const dz = message.hunter.z - message.creature.z;
    creature.send({
      type: 'input', roundId: message.roundId,
      up: dz < -1, down: dz > 1, left: dx < -1, right: dx > 1,
    });
  };
  creature.listeners.add(chase);
  chase(initial);
  const caught = await creature.waitFor((message) => message.roundState === 'ended', 0, 8_000);
  creature.listeners.delete(chase);
  const hunterCaught = await hunter.waitFor((message) => message.roundState === 'ended');
  assert.equal(caught.result, 'caught');
  assert.equal(hunterCaught.result, 'caught');
  assert.equal(hunterCaught.roundId, caught.roundId);
  assert.deepEqual(new Set(hunter.messages.map((message) => message.proximity)), new Set([
    'SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE',
  ]));

  const restartStart = hunter.messages.length;
  hunter.send({ type: 'restart' });
  const restarted = await hunter.waitFor((message) => message.roundState === 'running' && message.roundId === caught.roundId! + 1, restartStart);
  assert.equal(restarted.result, null);
  assert.equal(restarted.proximity, 'SAFE');
  const creatureRestarted = await creature.waitFor((message) => message.roundId === restarted.roundId);
  assert.equal(creatureRestarted.roundState, 'running');

  const leaveStart = hunter.messages.length;
  await creature.close();
  const alone = await hunter.waitFor((message) => message.roundState === 'waiting', leaveStart);
  assert.equal(alone.proximity, 'SAFE');
  const replacement = await connect();
  const replacementRound = await replacement.waitFor((message) => message.roundState === 'running');
  assert.equal(replacementRound.role, 'creature');
  assert.equal(replacementRound.roundId, restarted.roundId! + 1);

  const hunterLeaveStart = replacement.messages.length;
  await hunter.close();
  const loneCreature = await replacement.waitFor((message) => message.roundState === 'waiting', hunterLeaveStart);
  assert.equal(loneCreature.role, 'creature');
  assert.equal(loneCreature.hunter, null);
  const replacementHunter = await connect();
  const replacementHunterRound = await replacementHunter.waitFor((message) => message.roundState === 'running');
  assert.equal(replacementHunterRound.role, 'hunter');
  assert.equal(replacementHunterRound.roundId, replacementRound.roundId! + 1);

  // Inspect the actual wire payload, including waiting, running, and ended rounds.
  hunter.messages.forEach(assertHunterMessage);
  replacementHunter.messages.forEach(assertHunterMessage);
});

test('server stops movement when input messages expire', { timeout: 10_000 }, async (t) => {
  const { server, close } = createGameServer();
  const peers: Peer[] = [];
  t.after(async () => {
    await Promise.all(peers.map((peer) => peer.close()));
    await close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const hunter = await Peer.connect(url);
  peers.push(hunter);
  const creature = await Peer.connect(url);
  peers.push(creature);
  const initial = await hunter.waitFor((message) => message.roundState === 'running');
  const start = hunter.messages.length;
  hunter.send({
    type: 'input', roundId: initial.roundId,
    up: false, down: false,
    left: initial.hunter!.x > GAMEPLAY.arena.width / 2,
    right: initial.hunter!.x <= GAMEPLAY.arena.width / 2,
  });
  const expired = await hunter.waitFor(() => hunter.messages.length >= start + 20, start);
  const distance = Math.hypot(
    expired.hunter!.x - initial.hunter!.x,
    expired.hunter!.y - initial.hunter!.y,
    expired.hunter!.z - initial.hunter!.z,
  );
  assert.ok(distance > 0, 'one valid input moves the player');
  assert.ok(distance <= GAMEPLAY.speed.hunter * (GAMEPLAY.inputTimeoutMs / 1000 + 1 / GAMEPLAY.tickRate) + 1e-8);
  const stoppedStart = hunter.messages.length;
  const stopped = await hunter.waitFor(() => hunter.messages.length >= stoppedStart + 10, stoppedStart);
  assert.deepEqual(stopped.hunter, expired.hunter, 'expired input stays stopped');
  assert.equal(stopped.roundState, 'running');
});
