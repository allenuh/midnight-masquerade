import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:5180',
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 30_000,
    // A long match: these scripted rounds take minutes of driving, and the real 180 s
    // clock would expire mid-test. Timer expiry itself is covered in tests/resource.test.ts.
    // Its own port, so a game or any other Vite server left running on 5173 never blocks
    // the suite; the room default is the test arena, so no MAP override is needed.
    env: { HOST: '127.0.0.1', PORT: '5180', MATCH_SECONDS: '900' },
  },
});
