import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

// The built player client, and only that. Every request is resolved inside `root` or
// answered 404: the compiled server and shared modules sit next to dist/client, the map
// files and the map editor's build sit elsewhere, and none of them is ever served.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function createStaticHandler(root: string): (request: IncomingMessage, response: ServerResponse) => void {
  const base = resolve(root);
  return (request, response) => {
    void serve(base, request, response);
  };
}

async function serve(base: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    // The base URL is only there to parse a request path; no absolute URL is ever built from it.
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://unused').pathname);
    const path = resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(base + sep)) {
      response.writeHead(404).end();
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    // Vite names everything under assets/ by content hash, so those may be cached for
    // good; index.html is what points at the current hashes and must always be refetched,
    // or a rebuilt game would keep serving the old bundle through any caching proxy.
    const hashed = pathname.startsWith('/assets/');
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).on('error', () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}
