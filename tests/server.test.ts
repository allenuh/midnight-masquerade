import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createGameServer } from '../src/server/server.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position } from '../src/shared/protocol.js';
import { wallDistance } from '../src/shared/raycast.js';
import { keysToward } from './helpers/navigate.js';

type Message = {
  type: string;
  role?: 'hunter' | 'creature';
  roundId?: number;
  roundState?: string;
  result?: string | null;
  hunter?: Position | null;
  creature?: Position | { position: Position; staggered: boolean; sprinting: boolean };
  proximity?: string;
  facing?: number;
  light?: boolean;
  creatureHp?: number;
  hp?: number;
  hunterFacing?: number | null;
  hunterLight?: boolean;
};

const idle = { up: false, down: false, left: false, right: false, light: false };

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
  // `creature` may appear only while revealed; this file never turns the light on.
  assert.equal('creature' in message, false, 'hidden Creature never appears on the wire');
  assert.deepEqual(Object.keys(message).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'hunter', 'facing', 'light', 'proximity', 'creatureHp',
  ].sort());
  assert.equal(typeof message.facing, 'number');
  assert.equal(message.light, false);
  assert.equal(message.creatureHp, GAMEPLAY.creature.maxHp);
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
  assert.ok(message.result === null || message.result === 'caught' || message.result === 'defeated');
}

test('real sockets enforce roles, hidden payloads, tagging, restart, and vacant-slot reuse', { timeout: 40_000 }, async (t) => {
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
  assert.equal((initial.creature as Position).y, GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
  assert.equal(initial.hp, GAMEPLAY.creature.maxHp);
  assert.equal(initial.hunterLight, false);
  assert.equal(typeof initial.hunterFacing, 'number');
  assert.deepEqual(Object.keys(initial).sort(), [
    'type', 'role', 'roundId', 'roundState', 'result', 'creature', 'hunter', 'hunterFacing', 'hunterLight',
    'hp', 'lit', 'revealed', 'staggered', 'staggerCooldown', 'sprinting', 'sprintCooldown',
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
    ...idle, right: true,
    role: 'creature', x: 1, y: 1, z: 1, speed: 99_999,
  });
  const afterSpoof = await hunter.waitFor(() => hunter.messages.length >= spoofStart + 3, spoofStart);
  assert.deepEqual(afterSpoof.hunter, stationaryPosition);

  // This test controls only the Creature using coordinates that role may receive,
  // steering around the interior walls with the shared blockout geometry.
  const chase = (message: Message) => {
    if (message.role !== 'creature' || message.roundState !== 'running' || !message.hunter || !message.creature) return;
    const own = message.creature as Position;
    assert.equal(own.y, GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
    creature.send({ type: 'input', roundId: message.roundId, ...keysToward(own, message.hunter), light: false });
  };
  creature.listeners.add(chase);
  chase(initial);
  const caught = await creature.waitFor((message) => message.roundState === 'ended', 0, 20_000);
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
  // Random spawns may face a wall: move along X toward the side with more open floor.
  const clearance = (sign: number) => wallDistance(initial.hunter!, { x: sign, y: 0, z: 0 }, Infinity);
  const goRight = clearance(1) >= clearance(-1);
  hunter.send({ type: 'input', roundId: initial.roundId, ...idle, left: !goRight, right: goRight });
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
