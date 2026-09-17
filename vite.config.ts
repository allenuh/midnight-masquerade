import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./src/client'),
  server: {
    fs: {
      strict: true,
      // Server code, private spawn generation and the map files are outside the served
      // roots: the client bundles no map and receives the room's map from the server. The
      // map editor is NOT here, and is not reachable from this root at all.
      allow: [fromRoot('./src/client'), fromRoot('./src/shared')],
    },
  },
  // Relative asset URLs: the built page works from any origin or path prefix a proxy puts it under.
  base: './',
  build: { outDir: fromRoot('./dist/client'), emptyOutDir: true },
});
