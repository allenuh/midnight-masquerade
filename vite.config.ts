import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./src/client'),
  server: {
    fs: {
      strict: true,
      // Server code and private spawn generation are outside the served roots.
      allow: [fromRoot('./src/client'), fromRoot('./src/shared')],
    },
  },
  build: { outDir: fromRoot('./dist/client'), emptyOutDir: true },
});
