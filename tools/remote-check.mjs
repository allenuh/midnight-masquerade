// Developer check for a remote playtest origin. Not part of the game or its tests.
//
//   node tools/remote-check.mjs https://<your-tunnel>.trycloudflare.com
//
// Opens five headless Chrome pages on that URL (the browser Playwright installed for
// `npm run test:browser`), and reports: the WebSocket each page opened (it must be
// wss:// on the same host, never localhost), a room created and joined by all five, one
// Creature and four Hunters after a start, the Creature revealed by a sprint and hidden
// again after the linger, and every page moved to round 2 by the host's restart.
import { chromium } from '@playwright/test';

const url = process.argv[2];
if (!url?.startsWith('http')) {
  console.error('usage: node tools/remote-check.mjs https://<host>');
  process.exit(2);
}
const secure = url.startsWith('https://');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const latest = (player) => player.messages.filter((message) => message.type === 'snapshot').at(-1);

const browser = await chromium.launch({ channel: 'chrome' });
const players = [];
const socketUrls = [];
for (let index = 0; index < 5; index++) {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  const messages = [];
  page.on('websocket', (socket) => {
    socketUrls.push(socket.url());
    socket.on('framereceived', (frame) => {
      try { messages.push(JSON.parse(frame.payload)); } catch { /* not JSON */ }
    });
  });
  page.on('console', (entry) => { if (entry.type() === 'error') console.log(`page ${index} console error: ${entry.text()}`); });
  await page.goto(url);
  players.push({ page, messages });
}

const host = players[0];
await host.page.locator('#create').click();
await host.page.locator('#room').waitFor({ state: 'visible', timeout: 15_000 });
const code = (await host.page.locator('#room').textContent()).replace('Room: ', '');
console.log(`room ${code} created through ${url}`);
for (const player of players.slice(1)) {
  await player.page.locator('#code').fill(code);
  await player.page.locator('#join').click();
}
await host.page.locator('#players').filter({ hasText: 'Players: 5 / 5' }).waitFor({ timeout: 15_000 });
console.log('five players in the room');

await host.page.locator('#start').click();
for (const player of players) await player.page.locator('#timer').waitFor({ state: 'visible', timeout: 15_000 });
await sleep(5_000);
const roles = players.map((player) => latest(player)?.role);
console.log(`roles: ${roles.join(', ')}`);
const creature = players[roles.indexOf('creature')];
const hunters = players.filter((player) => latest(player)?.role === 'hunter');

// A held sprint reveals the Creature to every Hunter; releasing it hides the Creature
// again once the linger passes.
await creature.page.locator('#arena').click();
await creature.page.keyboard.down('Space');
await sleep(1_500);
const seenWhileSprinting = hunters.every((hunter) => 'creature' in latest(hunter));
await creature.page.keyboard.up('Space');
await sleep(2_000);
const hiddenAfter = hunters.every((hunter) => !('creature' in latest(hunter)));
console.log(`revealed while sprinting: ${seenWhileSprinting}; hidden again after the linger: ${hiddenAfter}`);

const before = hunters[0].messages.length;
await sleep(3_000);
console.log(`snapshots per second seen by one Hunter: ${((hunters[0].messages.length - before) / 3).toFixed(1)}`);

await host.page.locator('#start').click();
await sleep(4_000);
const rounds = players.map((player) => latest(player)?.roundId);
console.log(`after the host's restart, round ids: ${rounds.join(', ')}`);
console.log(`sockets: ${[...new Set(socketUrls)].join(' ')}`);

const ok = socketUrls.length === 5
  && socketUrls.every((socket) => socket.startsWith(secure ? 'wss://' : 'ws://') && socket.startsWith(`${secure ? 'wss' : 'ws'}://${new URL(url).host}/ws`))
  && roles.filter((role) => role === 'creature').length === 1
  && seenWhileSprinting && hiddenAfter
  && rounds.every((id) => id === 2);
console.log(ok ? 'REMOTE CHECK PASSED' : 'REMOTE CHECK FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
