import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRepo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// The map editor is a separate build target on purpose: it is a developer tool that must
// never reach a player. Its root is this directory, so `npm run build` (which uses the
// repository's vite.config.ts rooted at src/client) cannot pull any of it in, and the
// production server only ever serves dist/client.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    port: 5175,
    fs: {
      strict: true,
      // Only the editor itself and the shared map schema/validation it reuses.
      allow: [fileURLToPath(new URL('.', import.meta.url)), fromRepo('src/shared')],
    },
  },
  build: { outDir: fromRepo('dist/map-editor'), emptyOutDir: true },
});
