import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../src/server/server.js';
import { createStaticHandler } from '../src/server/static.js';
import { loadMapCatalog } from '../src/server/maps.js';

// How the game reaches players who are not on this machine: one origin serves the page
// and its WebSocket, the client derives that origin from the page, and the static server
// hands out the built client and nothing else. None of this knows about any tunnel.

const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

type Reply = { status: number; headers: IncomingMessage['headers']; body: string };

function fetchRaw(port: number, path: string, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A stand-in for dist/: the built client next to the compiled server and shared code
// that must never be served, and a map-editor build that must never be reachable.
function fakeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'ccc-dist-'));
  mkdirSync(join(dist, 'client', 'assets'), { recursive: true });
  mkdirSync(join(dist, 'server'));
  mkdirSync(join(dist, 'map-editor'));
  writeFileSync(join(dist, 'client', 'index.html'), '<!doctype html><script type="module" src="./assets/index-abc123.js"></script>');
  writeFileSync(join(dist, 'client', 'assets', 'index-abc123.js'), 'console.log("game")');
  writeFileSync(join(dist, 'client', 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(join(dist, 'server', 'index.js'), 'secret server code');
  writeFileSync(join(dist, 'map-editor', 'index.html'), 'the editor');
  return dist;
}

test('the static server hands out the built client and nothing beside it', { timeout: 15_000 }, async (t) => {
  const dist = fakeDist();
  const server = createServer(createStaticHandler(join(dist, 'client')));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const page = await fetchRaw(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type']!, /^text\/html/);
  // The page is what names the current bundle: never cached, so a rebuild reaches
  // every player on reload even through a caching proxy.
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.body, /index-abc123\.js/);
  assert.equal((await fetchRaw(port, '/index.html')).status, 200);
  assert.equal((await fetchRaw(port, '/?room=ABCD')).status, 200, 'the join link is the page plus a query');

  const script = await fetchRaw(port, '/assets/index-abc123.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type']!, /^text\/javascript/);
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable', 'hashed assets may be cached for good');
  assert.equal(script.body, 'console.log("game")');
  assert.match((await fetchRaw(port, '/assets/index-abc123.css')).headers['content-type']!, /^text\/css/);

  const head = await fetchRaw(port, '/assets/index-abc123.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String('console.log("game")'.length));

  // Nothing beside the client: not the compiled server, not the editor, not the maps,
  // however the path is spelled.
  for (const path of [
    '/../server/index.js', '/..%2Fserver/index.js', '/%2e%2e/server/index.js', '/assets/../../server/index.js',
    '/../map-editor/index.html', '/../map-editor/', '/../../maps/test-arena.json', '/server/index.js', '/map-editor/index.html',
  ]) {
    assert.equal((await fetchRaw(port, path)).status, 404, path);
  }
  assert.equal((await fetchRaw(port, '/assets/')).status, 404, 'directories are not listed');
  assert.equal((await fetchRaw(port, '/assets')).status, 404);
  assert.equal((await fetchRaw(port, '/missing.js')).status, 404);
  assert.equal((await fetchRaw(port, '/', 'POST')).status, 405);
  assert.equal((await fetchRaw(port, '/', 'PUT')).status, 405);
});

test('a WebSocket upgrade anywhere but /ws is refused and closed', { timeout: 15_000 }, async (t) => {
  const catalog = loadMapCatalog();
  const { server, close } = createGameServer(catalog, { log: false });
  t.after(() => close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  // Without the refusal the server would hold this socket open forever and the test would time out here.
  await once(socket, 'close');
  assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 404/);
});

test('the client reaches the server through the origin that served it, never a fixed host', () => {
  // Remote players load the page from a tunnel or a host; the socket must follow that
  // origin (wss: under https:), so no client source may name a host, port, or scheme.
  const clientSources = ['src/client/main.ts', 'src/client/scene.ts', 'src/client/camera-config.ts', 'src/client/index.html'];
  for (const file of clientSources) {
    const source = readFileSync(repoFile(file), 'utf8');
    assert.doesNotMatch(source, /localhost|127\.0\.0\.1|wss?:\/\//, `${file} names a fixed host`);
    assert.doesNotMatch(source, /:5173|:5180|:5175/, `${file} names a port`);
  }
  const main = readFileSync(repoFile('src/client/main.ts'), 'utf8');
  assert.match(main, /new WebSocket\(`\$\{location\.protocol === 'https:' \? 'wss:' : 'ws:'\}\/\/\$\{location\.host\}\/ws`\)/,
    'the socket URL is derived from the page origin');
  // The shared and server modules carry no client endpoint either; the only hosts the
  // server knows are the interface it binds, from the environment.
  const entry = readFileSync(repoFile('src/server/index.ts'), 'utf8');
  assert.match(entry, /process\.env\.HOST \?\? '127\.0\.0\.1'/);
  assert.match(entry, /process\.env\.PORT \?\? 5173/);
  assert.doesNotMatch(entry, /trycloudflare|cloudflared tunnel run|\.cfargotunnel/, 'no tunnel hostname is built in');

  // A relative asset base, so the built page is not tied to being served at a domain root.
  assert.match(readFileSync(repoFile('vite.config.ts'), 'utf8'), /base: '\.\/'/);
});

test('the playtest command is a production serve of the player build with optional .env settings', () => {
  const pkg = JSON.parse(readFileSync(repoFile('package.json'), 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string> };
  assert.match(pkg.scripts.playtest, /^npm run build && npm run playtest:serve$/);
  assert.match(pkg.scripts['playtest:serve'], /--env-file-if-exists=\.env dist\/server\/index\.js --production/);
  assert.equal('cloudflared' in pkg.dependencies, false, 'the tunnel is not a dependency of the game');
  assert.equal(existsSync(repoFile('.env.example')), true);
  const example = readFileSync(repoFile('.env.example'), 'utf8');
  assert.match(example, /^HOST=/m);
  assert.match(example, /^PORT=/m);
  assert.match(readFileSync(repoFile('.gitignore'), 'utf8'), /^\.env$/m, 'a real .env is never committed');
});
