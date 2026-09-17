import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMapCatalog } from './maps.js';
import { createGameServer } from './server.js';

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
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  gameServer.server.on('request', async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const path = resolve(clientRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      // Serve only built browser assets, never the adjacent compiled server/shared files.
      if (!path.startsWith(resolve(clientRoot) + sep)) {
        response.writeHead(404).end();
        return;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(path).on('error', () => response.destroy()).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
}

gameServer.server.listen(port, host, () => {
  console.log(`Prototype 4 — Resource Game: http://${host}:${port}`);
  console.log(`Maps: ${catalog.entries.map((entry) => `${entry.id}${entry === catalog.default ? ' (default)' : ''}`).join(', ')}`);
  console.log('Open five browser clients. Create a room in one, join its code from the other four, then start.');
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
