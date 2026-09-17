import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { loadMapCatalog, type MapCatalog } from '../src/server/maps.js';
import { ROOM_CODE_PATTERN, createGameServer } from '../src/server/server.js';
import { MARKER, createEmptyMap } from '../src/shared/map/schema.js';
import { buildWorld } from '../src/shared/map/world.js';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { HunterView, Position } from '../src/shared/protocol.js';
import { wallDistance } from '../src/shared/raycast.js';
import { HUNTER_PAYLOAD_KEYS, HUNTER_VIEW_KEYS, TEST_MAP, TEST_MAP_PATH, TEST_WORLD } from './helpers/game.js';
import { keysToward } from './helpers/navigate.js';

type Message = {
  type: string;
  reason?: string;
  code?: string;
  players?: number;
  host?: boolean;
  notice?: string | null;
  maps?: { id: string; name: string }[];
  mapId?: string;
  map?: unknown;
  role?: 'hunter' | 'creature';
  roundId?: number;
  roundState?: string;
  result?: string | null;
  hunters?: HunterView[];
  self?: string;
  proximity?: string;
  creatureHp?: number;
  creature?: Position | { position: Position; staggered: boolean; sprinting: boolean; burning: boolean };
  hp?: number;
  attackCooldown?: number;
};

const idle = { up: false, down: false, left: false, right: false, light: false };
const PLAYER_COUNT = GAMEPLAY.players.hunters + 1;
const groundedY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;

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

  latest(): Message | undefined {
    return this.messages.at(-1);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertHunterMessage(message: Message) {
  // `creature` may appear only while revealed; these tests never use the light or the sprint.
  assert.equal('creature' in message, false, 'hidden Creature never appears on the wire');
  assert.deepEqual(Object.keys(message).sort(), HUNTER_PAYLOAD_KEYS);
  assert.equal(message.type, 'snapshot');
  assert.equal(message.role, 'hunter');
  assert.equal(typeof message.roundId, 'number');
  assert.ok(['reveal', 'running', 'ended'].includes(message.roundState!));
  assert.ok(message.result === null || ['caught', 'defeated', 'expired'].includes(message.result!));
  assert.ok(['H1', 'H2', 'H3', 'H4'].includes(message.self!));
  assert.ok(['SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE'].includes(message.proximity!));
  assert.equal(message.creatureHp, GAMEPLAY.creature.maxHp);
  assert.equal(message.hunters!.length, GAMEPLAY.players.hunters);
  for (const hunter of message.hunters!) {
    assert.deepEqual(Object.keys(hunter).sort(), HUNTER_VIEW_KEYS);
    assert.deepEqual(Object.keys(hunter.position).sort(), ['x', 'y', 'z']);
    assert.equal(hunter.position.y, groundedY);
    assert.equal(typeof hunter.facing, 'number');
    assert.equal(hunter.light, false);
  }
}

const own = (message: Message): HunterView => message.hunters!.find((hunter) => hunter.id === message.self)!;

async function startServer(t: test.TestContext, catalog?: MapCatalog) {
  const { server, close } = createGameServer(catalog);
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
  return { connect };
}

// Creates a room with the first peer and joins the rest; returns the full room.
async function fillRoom(connect: () => Promise<Peer>) {
  const host = await connect();
  host.send({ type: 'create' });
  const created = await host.waitFor((message) => message.type === 'room');
  const code = created.code!;
  const guests: Peer[] = [];
  for (let index = 1; index < PLAYER_COUNT; index++) {
    const guest = await connect();
    guest.send({ type: 'join', code });
    await guest.waitFor((message) => message.type === 'room' && message.players === index + 1);
    guests.push(guest);
  }
  await host.waitFor((message) => message.type === 'room' && message.players === PLAYER_COUNT);
  return { host, guests, code, players: [host, ...guests] };
}

test('real sockets run the room flow: codes, joins, private roles, hidden payloads, downing, and disconnects', { timeout: 60_000 }, async (t) => {
  const { connect } = await startServer(t);

  const host = await connect();
  host.send({ type: 'create' });
  const created = await host.waitFor((message) => message.type === 'room');
  assert.match(created.code!, ROOM_CODE_PATTERN);
  // The room message also carries the map catalogue and the room's choice. The catalogue
  // lists whatever the developer has in maps/, so only the test arena's presence is fixed.
  const roomOf = (message: Message) => {
    assert.ok(Array.isArray(message.maps) && message.maps.some((map) => map.id === 'test-arena' && map.name === 'Test Arena'));
    const { maps: _maps, ...rest } = message;
    return rest;
  };
  assert.deepEqual(roomOf(created), { type: 'room', code: created.code, players: 1, host: true, notice: null, mapId: 'test-arena' });
  // The full map arrived before the room message: the client builds its scene from it.
  const mapMessage = host.messages.find((message) => message.type === 'map');
  assert.ok(mapMessage && typeof mapMessage.map === 'object', 'the room map is sent on create');
  assert.ok(host.messages.indexOf(mapMessage) < host.messages.indexOf(created));
  const code = created.code!;

  // A code that cannot exist is rejected without side effects; the real code joins even
  // in lower case, and every member learns the new count.
  const second = await connect();
  second.send({ type: 'join', code: '0000' });
  assert.deepEqual(await second.waitFor((message) => message.type === 'error'), { type: 'error', reason: 'not-found' });
  second.send({ type: 'join', code: code.toLowerCase() });
  assert.deepEqual(roomOf(await second.waitFor((message) => message.type === 'room')), { type: 'room', code, players: 2, host: false, notice: null, mapId: 'test-arena' });
  assert.deepEqual(roomOf(await host.waitFor((message) => message.type === 'room' && message.players === 2)), { type: 'room', code, players: 2, host: true, notice: null, mapId: 'test-arena' });

  // Starting needs a full room: nothing happens with two players.
  const earlyStart = host.messages.length;
  host.send({ type: 'start' });
  await sleep(300);
  assert.equal(host.messages.length, earlyStart);

  const guests = [second];
  for (let count = 3; count <= PLAYER_COUNT; count++) {
    const guest = await connect();
    guest.send({ type: 'join', code });
    await guest.waitFor((message) => message.type === 'room' && message.players === count);
    guests.push(guest);
  }
  await host.waitFor((message) => message.type === 'room' && message.players === PLAYER_COUNT);
  const players = [host, ...guests];

  const sixth = await connect();
  sixth.send({ type: 'join', code });
  assert.deepEqual(await sixth.waitFor((message) => message.type === 'error'), { type: 'error', reason: 'full' });
  await sixth.close();

  // Only the host can start.
  const before = players.map((peer) => peer.messages.length);
  second.send({ type: 'start' });
  await sleep(300);
  assert.deepEqual(players.map((peer) => peer.messages.length), before);

  host.send({ type: 'start' });
  const reveals = await Promise.all(players.map((peer) => peer.waitFor((message) => message.type === 'snapshot')));
  assert.equal(reveals.filter((message) => message.role === 'creature').length, 1);
  assert.deepEqual(reveals.filter((message) => message.role === 'hunter').map((message) => message.self).sort(), ['H1', 'H2', 'H3', 'H4']);
  for (const message of reveals) assert.equal(message.roundState, 'reveal');
  const creature = players[reveals.findIndex((message) => message.role === 'creature')];
  const hunters = players.filter((peer) => peer !== creature);
  const roundId = reveals[0].roundId!;
  const initial = reveals.find((message) => message.role === 'creature')!;
  assert.ok(initial.creature && initial.hunters);
  assert.deepEqual(Object.keys(initial.creature).sort(), ['x', 'y', 'z']);
  assert.equal((initial.creature as Position).y, groundedY);
  assert.equal(initial.hp, GAMEPLAY.creature.maxHp);
  assert.equal(initial.hunters.length, GAMEPLAY.players.hunters);

  // Nobody moves during the reveal, then the round runs for everyone.
  const revealHunter = reveals.find((message) => message.role === 'hunter')!;
  await Promise.all(players.map((peer) => peer.waitFor((message) => message.roundState === 'running')));
  const runningHunter = hunters[0].latest()!;
  assert.equal(runningHunter.proximity, 'SAFE');
  assert.deepEqual(runningHunter.hunters!.map((hunter) => hunter.position), revealHunter.hunters!.map((hunter) => hunter.position));

  // Spoofed positions, foreign fields, and a non-host start are ignored outright.
  const spoofed = hunters.find((peer) => peer !== host)!;
  const stationaryPosition = { ...own(spoofed.latest()!).position };
  const spoofStart = spoofed.messages.length;
  spoofed.send({ type: 'position', x: 1, y: 1, z: 1 });
  spoofed.send({
    type: 'input', roundId,
    ...idle, right: true,
    role: 'creature', self: 'H1', x: 1, y: 1, z: 1, speed: 99_999,
  });
  spoofed.send({ type: 'start' });
  const afterSpoof = await spoofed.waitFor(() => spoofed.messages.length >= spoofStart + 3, spoofStart);
  assert.deepEqual(own(afterSpoof).position, stationaryPosition);

  // This test controls only the Creature using coordinates that role may receive,
  // steering around the interior walls toward the nearest active Hunter.
  const chase = (message: Message) => {
    if (message.role !== 'creature' || message.roundState !== 'running' || !message.hunters || !message.creature) return;
    const position = message.creature as Position;
    assert.equal(position.y, groundedY);
    const targets = message.hunters.filter((hunter) => !hunter.down);
    const nearest = targets.reduce((best, hunter) =>
      Math.hypot(hunter.position.x - position.x, hunter.position.z - position.z) <
      Math.hypot(best.position.x - position.x, best.position.z - position.z) ? hunter : best);
    creature.send({ type: 'input', roundId: message.roundId, ...keysToward(position, nearest.position), light: false });
  };
  creature.listeners.add(chase);
  chase(creature.latest()!);
  const tagged = await creature.waitFor((message) => !!message.hunters?.some((hunter) => hunter.down), 0, 25_000);
  creature.listeners.delete(chase);
  creature.send({ type: 'input', roundId, ...idle });
  assert.equal(tagged.roundState, 'running', 'one Hunter down does not end the round');
  assert.equal(tagged.result, null);
  assert.equal(tagged.hunters!.filter((hunter) => hunter.down).length, 1);
  assert.ok(tagged.attackCooldown! > 0);
  const downedId = tagged.hunters!.find((hunter) => hunter.down)!.id;
  const downed = hunters.find((peer) => peer.latest()!.self === downedId)!;
  const downedView = await downed.waitFor((message) => !!message.hunters && own(message).down);
  assert.equal(downedView.roundState, 'running');
  assert.equal(own(downedView).revive, 0);
  // Its own warning climbed as the Creature closed in; the others still know nothing.
  assert.ok(downed.messages.some((message) => message.proximity === 'IMMEDIATE' || message.proximity === 'DANGER'));
  // Its input is now refused: the body stays where it fell.
  const fell = { ...own(downedView).position };
  const downedStart = downed.messages.length;
  downed.send({ type: 'input', roundId, ...idle, up: true, light: true });
  const later = await downed.waitFor(() => downed.messages.length >= downedStart + 5, downedStart);
  assert.deepEqual(own(later).position, fell);
  assert.equal(own(later).light, false);
  // Every teammate and the Creature see the same downed slot.
  for (const peer of players) assert.equal(peer.latest()!.hunters!.find((hunter) => hunter.id === downedId)!.down, true);

  // Disconnect policy: a guest leaving mid-round abandons the round and returns the rest
  // to the room with a notice; snapshots stop.
  const leaver = guests.find((peer) => peer !== downed && peer !== creature) ?? guests[0];
  const remaining = players.filter((peer) => peer !== leaver);
  const leaveStart = remaining.map((peer) => peer.messages.length);
  await leaver.close();
  await Promise.all(remaining.map((peer, index) => peer.waitFor((message) => message.type === 'room', leaveStart[index])));
  for (const peer of remaining) {
    const notice = peer.latest()!;
    assert.deepEqual(roomOf(notice), { type: 'room', code, players: PLAYER_COUNT - 1, host: peer === host, notice: 'disconnected', mapId: 'test-arena' });
  }
  await sleep(200);
  for (const peer of remaining) assert.equal(peer.latest()!.type, 'room', 'no snapshots without a round');

  // A replacement fills the room and the host starts a fresh round with new roles.
  const replacement = await connect();
  replacement.send({ type: 'join', code });
  await Promise.all([...remaining, replacement].map((peer) =>
    peer.waitFor((message) => message.type === 'room' && message.players === PLAYER_COUNT && message.notice === null)));
  const restartStart = [...remaining, replacement].map((peer) => peer.messages.length);
  host.send({ type: 'start' });
  const restarted = await Promise.all([...remaining, replacement].map((peer, index) =>
    peer.waitFor((message) => message.type === 'snapshot', restartStart[index])));
  for (const message of restarted) {
    assert.equal(message.roundId, roundId + 1);
    assert.equal(message.roundState, 'reveal');
    assert.equal(message.result, null);
  }
  assert.equal(restarted.filter((message) => message.role === 'creature').length, 1);
  assert.equal(restarted.every((message) => message.hunters!.every((hunter) => !hunter.down)), true);

  // Every Hunter payload seen so far, in every round state, matched the allowlist.
  for (const peer of [...hunters, replacement]) {
    for (const message of peer.messages) if (message.type === 'snapshot' && message.role === 'hunter') assertHunterMessage(message);
  }

  // Host disconnect: the room closes and everyone else is told, then dropped.
  const others = [...remaining, replacement].filter((peer) => peer !== host);
  const hostLeaveStart = others.map((peer) => peer.messages.length);
  await host.close();
  await Promise.all(others.map((peer, index) => peer.waitFor((message) => message.type === 'error', hostLeaveStart[index])));
  for (const peer of others) {
    assert.deepEqual(peer.latest(), { type: 'error', reason: 'host-left' });
    if (peer.socket.readyState !== WebSocket.CLOSED) await once(peer.socket, 'close');
  }
  const late = await connect();
  late.send({ type: 'join', code });
  assert.deepEqual(await late.waitFor((message) => message.type === 'error'), { type: 'error', reason: 'not-found' });
});

test('server stops movement when input messages expire', { timeout: 20_000 }, async (t) => {
  const { connect } = await startServer(t);
  const { host, players } = await fillRoom(connect);
  host.send({ type: 'start' });
  const running = await Promise.all(players.map((peer) => peer.waitFor((message) => message.roundState === 'running', 0, 10_000)));
  const hunter = players[running.findIndex((message) => message.role === 'hunter')];
  const initial = hunter.latest()!;
  const start = hunter.messages.length;
  // Random spawns may face a wall: move along X toward the side with more open floor.
  const origin = own(initial).position;
  const clearance = (sign: number) => wallDistance(origin, { x: sign, y: 0, z: 0 }, Infinity, TEST_WORLD.wallBoxes);
  const goRight = clearance(1) >= clearance(-1);
  hunter.send({ type: 'input', roundId: initial.roundId, ...idle, left: !goRight, right: goRight });
  const expired = await hunter.waitFor(() => hunter.messages.length >= start + 20, start);
  const moved = own(expired).position;
  const distance = Math.hypot(moved.x - origin.x, moved.y - origin.y, moved.z - origin.z);
  assert.ok(distance > 0, 'one valid input moves the player');
  assert.ok(distance <= GAMEPLAY.speed.hunter * (GAMEPLAY.inputTimeoutMs / 1000 + 1 / GAMEPLAY.tickRate) + 1e-8);
  const stoppedStart = hunter.messages.length;
  const stopped = await hunter.waitFor(() => hunter.messages.length >= stoppedStart + 10, stoppedStart);
  assert.deepEqual(own(stopped).position, moved, 'expired input stays stopped');
  assert.equal(stopped.roundState, 'running');
  // Teammates and the Creature saw the same movement.
  for (const peer of players) {
    if (peer === hunter) continue;
    assert.deepEqual(peer.latest()!.hunters!.find((view) => view.id === initial.self)!.position, moved);
  }
});

test('the host picks the room map between rounds, and every client is sent the map it will play', { timeout: 30_000 }, async (t) => {
  // A private catalogue with two playable maps, so the test does not depend on what the
  // developer keeps in maps/. `spare` is a tiny all-Open map with its own spawn markers.
  const spare = createEmptyMap('Spare', 8, 6);
  spare.markers = [
    { type: MARKER.creatureSpawn, x: 7, y: 5 },
    { type: MARKER.hunterSpawn, x: 0, y: 0 }, { type: MARKER.hunterSpawn, x: 2, y: 0 },
    { type: MARKER.hunterSpawn, x: 0, y: 2 }, { type: MARKER.hunterSpawn, x: 2, y: 2 },
  ];
  const directory = mkdtempSync(join(tmpdir(), 'ccc-select-'));
  writeFileSync(join(directory, 'test-arena.json'), readFileSync(TEST_MAP_PATH));
  writeFileSync(join(directory, 'spare.json'), JSON.stringify(spare));
  const { connect } = await startServer(t, loadMapCatalog(directory, 'test-arena'));
  const { host, players, code } = await fillRoom(connect);
  const guest = players.find((peer) => peer !== host)!;

  // Everyone was sent the default map on join, before the room message.
  for (const peer of players) {
    const mapMessage = peer.messages.find((message) => message.type === 'map');
    assert.ok(mapMessage, 'the map arrives on join');
    assert.equal((mapMessage.map as { name: string }).name, 'Test Arena');
    assert.equal(peer.latest()!.mapId, 'test-arena');
    assert.deepEqual(peer.latest()!.maps, [{ id: 'spare', name: 'Spare' }, { id: 'test-arena', name: 'Test Arena' }]);
  }

  // A guest cannot choose; an unknown id is ignored; the host can. Every peer has seen
  // the full room first, so the counts below are stable.
  await Promise.all(players.map((peer) => peer.waitFor((message) => message.type === 'room' && message.players === PLAYER_COUNT)));
  const before = players.map((peer) => peer.messages.length);
  guest.send({ type: 'selectMap', id: 'spare' });
  host.send({ type: 'selectMap', id: 'missing' });
  await sleep(300);
  players.forEach((peer, index) => assert.equal(peer.messages.length, before[index], 'nothing was sent'));

  host.send({ type: 'selectMap', id: 'spare' });
  for (const peer of players) {
    const switched = await peer.waitFor((message) => message.type === 'room' && message.mapId === 'spare');
    assert.equal(switched.players, PLAYER_COUNT);
    const mapMessage = peer.messages.slice(before[players.indexOf(peer)]).find((message) => message.type === 'map');
    assert.ok(mapMessage && (mapMessage.map as { name: string }).name === 'Spare', 'the new map is sent to everyone');
  }

  // The round then plays on the chosen map: spawns come from its markers, and the arena
  // is its size, so every position sits inside the 8 x 6 tile floor.
  host.send({ type: 'start' });
  const reveals = await Promise.all(players.map((peer) => peer.waitFor((message) => message.type === 'snapshot')));
  const spareWorld = buildWorld(spare);
  const creature = reveals.find((message) => message.role === 'creature')!;
  assert.ok(spareWorld.creatureSpawns.some((spawn) => spawn.x === (creature.creature as Position).x && spawn.z === (creature.creature as Position).z));
  for (const view of creature.hunters!) {
    assert.ok(spareWorld.hunterSpawns.some((spawn) => spawn.x === view.position.x && spawn.z === view.position.z), `${view.id} on a Spare marker`);
    assert.ok(view.position.x < spareWorld.width && view.position.z < spareWorld.depth);
  }
  const roundId = creature.roundId!;

  // Mid-round the choice is refused, so a round is never cut short by a map change.
  const during = host.messages.length;
  host.send({ type: 'selectMap', id: 'test-arena' });
  await sleep(300);
  assert.ok(!host.messages.slice(during).some((message) => message.type === 'room' || message.type === 'map'));
  assert.equal(host.latest()!.type, 'snapshot');

  // Between rounds the host may switch back. A guest leaving abandons the round (the
  // quickest way to a lobby here; the result screen takes the same branch), then the
  // room switches, a replacement joins and is sent the arena, and the next start is a
  // new round id with spawns from the arena's markers.
  await Promise.all(players.map((peer) => peer.waitFor((message) => message.roundState === 'running')));
  await guest.close();
  await host.waitFor((message) => message.type === 'room' && message.notice === 'disconnected');
  host.send({ type: 'selectMap', id: 'test-arena' });
  await host.waitFor((message) => message.type === 'room' && message.mapId === 'test-arena');
  const replacement = await connect();
  replacement.send({ type: 'join', code });
  const joined = await replacement.waitFor((message) => message.type === 'room');
  assert.equal(joined.mapId, 'test-arena');
  assert.equal((replacement.messages.find((message) => message.type === 'map')!.map as { name: string }).name, 'Test Arena');
  await host.waitFor((message) => message.type === 'room' && message.players === PLAYER_COUNT);
  host.send({ type: 'start' });
  const next = await host.waitFor((message) => message.type === 'snapshot' && message.roundId !== roundId);
  assert.equal(next.roundId, roundId + 1);
  const arena = buildWorld(TEST_MAP);
  for (const view of next.hunters!) {
    assert.ok(arena.hunterSpawns.some((spawn) => spawn.x === view.position.x && spawn.z === view.position.z), `${view.id} back on the arena`);
  }
});
