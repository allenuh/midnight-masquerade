import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMapCatalog } from './maps.js';
import { createGameServer } from './server.js';
import { createStaticHandler } from './static.js';

// Everything here is deployment configuration, read from the environment (or the
// optional .env file the playtest script loads): where to listen, never how to play.
const production = process.argv.includes('--production');
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');

const catalog = loadMapCatalog();
const gameServer = createGameServer(catalog);
let closeVite: (() => Promise<void>) | undefined;

if (!production) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true, ws: { server: gameServer.server } },
  });
  gameServer.server.on('request', vite.middlewares);
  closeVite = () => vite.close();
} else {
  const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));
  if (!existsSync(resolve(clientRoot, 'index.html'))) throw new Error('Build the client first with npm run build');
  gameServer.server.on('request', createStaticHandler(clientRoot));
}

gameServer.server.listen(port, host, () => {
  // Bound to every interface, the loopback address is still the one to open locally.
  const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`Prototype 4 — Resource Game (${production ? 'playtest build' : 'development'}): http://${localHost}:${port}`);
  console.log(`Listening on ${host}:${port}. Maps: ${catalog.entries.map((entry) => `${entry.id}${entry === catalog.default ? ' (default)' : ''}`).join(', ')}`);
  console.log('Open five browser clients. Create a room in one, join its code from the other four, then start.');
  // The tunnel is not part of the game: it only forwards a public HTTPS origin to this port.
  if (production) console.log(`To play over the internet, in another terminal: cloudflared tunnel --url http://localhost:${port}`);
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await closeVite?.();
  await gameServer.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
