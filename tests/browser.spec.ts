import { expect, test, type Browser, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { HunterView, Position, RoomMessage, ServerMessage } from '../src/shared/protocol.js';
import { wallDistance } from '../src/shared/raycast.js';
import { TEST_WORLD } from './helpers/game.js';
import { findLane, keysToward, type Keys } from './helpers/navigate.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type HunterSnapshot = Extract<Snapshot, { role: 'hunter' }>;
type CreatureSnapshot = Extract<Snapshot, { role: 'creature' }>;

const HUNTER_KEYS = [
  'type', 'role', 'roundId', 'roundState', 'result', 'hunters', 'timeRemaining', 'pickups',
  'self', 'proximity', 'dread', 'creatureHp',
].sort();
const HUNTER_VIEW_KEYS = ['id', 'position', 'facing', 'light', 'battery', 'down', 'revive'].sort();
const PLAYER_COUNT = GAMEPLAY.players.hunters + 1;
const groundedY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;
const MAX_BATTERY = GAMEPLAY.battery.max;
// Battery points come from the loaded map's markers, in the same order the server uses.
const PICKUP_COUNT = TEST_WORLD.batterySpawns.length;
const pickupPoint = (index: number): Position => ({ ...TEST_WORLD.batterySpawns[index] });

function observeGame(page: Page) {
  const messages: ServerMessage[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/ws')) return;
    socket.on('framereceived', ({ payload }) => {
      messages.push(JSON.parse(payload.toString()) as ServerMessage);
    });
  });
  return {
    messages,
    last(): ServerMessage | undefined {
      return messages.at(-1);
    },
    latest(): Snapshot | undefined {
      return messages.filter((message): message is Snapshot => message.type === 'snapshot').at(-1);
    },
    room(): RoomMessage | undefined {
      return messages.filter((message): message is RoomMessage => message.type === 'room').at(-1);
    },
    hunter(): HunterSnapshot {
      const snapshot = this.latest();
      if (snapshot?.role !== 'hunter') throw new Error('Expected the Hunter snapshot.');
      return snapshot;
    },
    creature(): CreatureSnapshot {
      const snapshot = this.latest();
      if (snapshot?.role !== 'creature') throw new Error('Expected the Creature snapshot.');
      return snapshot;
    },
    // This Hunter's own entry in its team list.
    own(): HunterView {
      const snapshot = this.hunter();
      return snapshot.hunters.find((hunter) => hunter.id === snapshot.self)!;
    },
    // A snapshot's view of the named Hunter, from either role.
    teammate(id: string): HunterView {
      return this.latest()!.hunters.find((hunter) => hunter.id === id)!;
    },
  };
}
type Network = ReturnType<typeof observeGame>;
type Player = { page: Page; network: Network };

// Basic lighting shades the primitives, so count colour ranges rather than exact
// material RGB values. The floor, walls, and translucent light fan are grey-greens or pale
// yellows that match none of: the viewer's own white Hunter, the blue-grey teammates, or
// the Creature — its charcoal robe (an exactly neutral grey; the Hunters' flashlights share
// that grey but are only a few pixels across, so a charcoal pixel counts only inside a solid
// 5x5 patch of it), or the ember orange-red it glows while burning. Only meaningful while no
// text overlay covers the arena. The HUD's paper colours would count too, so it is hidden for the
// screenshot.
async function visiblePlayerColors(page: Page) {
  await page.locator('#hud-layer').evaluate((layer) => { (layer as HTMLElement).style.visibility = 'hidden'; });
  const screenshot = await page.locator('#arena').screenshot();
  await page.locator('#hud-layer').evaluate((layer) => { (layer as HTMLElement).style.visibility = ''; });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    // Skip the outer margin, where the vignette and the fear effects are darkest.
    const margin = 24;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const charcoal = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < charcoal.length; index++) {
      const [red, green, blue] = [pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      charcoal[index] = max - min <= 2 && min >= 16 && max <= 110 ? 1 : 0;
    }
    const charcoalPatch = (x: number, y: number) => {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) if (!charcoal[(y + dy) * canvas.width + x + dx]) return false;
      }
      return true;
    };
    let selfPixels = 0;
    let teammatePixels = 0;
    let creaturePixels = 0;
    for (let y = margin; y < canvas.height - margin; y++) {
      for (let x = margin; x < canvas.width - margin; x++) {
        const index = (y * canvas.width + x) * 4;
        const [red, green, blue] = [pixels[index], pixels[index + 1], pixels[index + 2]];
        if (red > 200 && green > 200 && blue > 200 && Math.abs(red - blue) < 20) selfPixels++;
        if (blue > 140 && blue > red + 30 && green > red) teammatePixels++;
        const burning = red > 100 && red > green + 25 && green > blue + 10;
        if (burning || charcoalPatch(x, y)) creaturePixels++;
      }
    }
    return { selfPixels, teammatePixels, creaturePixels };
  }, screenshot.toString('base64'));
}

// Hold exactly the WASD keys the steering asks for, releasing the rest.
async function applyKeys(page: Page, held: Set<string>, keys: Keys): Promise<void> {
  const desired = new Set<string>();
  if (keys.up) desired.add('KeyW');
  if (keys.down) desired.add('KeyS');
  if (keys.left) desired.add('KeyA');
  if (keys.right) desired.add('KeyD');
  for (const key of held) {
    if (!desired.has(key)) await page.keyboard.up(key);
  }
  for (const key of desired) {
    if (!held.has(key)) await page.keyboard.down(key);
  }
  held.clear();
  for (const key of desired) held.add(key);
}

// Steer a page's player to a point using only coordinates that role legitimately
// receives, then release every key. Returns false if the round ends first.
async function drive(
  page: Page, position: () => Position, target: Position,
  options: { avoid?: Position[]; arrive: number; running: () => boolean; timeoutMs?: number },
): Promise<boolean> {
  const held = new Set<string>();
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  try {
    while (Date.now() < deadline) {
      if (!options.running()) return false;
      const keys = keysToward(position(), target, options);
      if (!keys.up && !keys.down && !keys.left && !keys.right) return true;
      await applyKeys(page, held, keys);
      await page.waitForTimeout(50);
    }
    throw new Error(`Timed out driving to ${JSON.stringify(target)} from ${JSON.stringify(position())}`);
  } finally {
    for (const key of held) await page.keyboard.up(key);
  }
}

// Turn a Hunter to face east or west with the movement keys (the facing chases the held direction).
async function face(hunter: Player, direction: 'east' | 'west'): Promise<void> {
  const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
  const key = direction === 'east' ? 'KeyD' : 'KeyA';
  const target = direction === 'east' ? 0 : Math.PI;
  await hunter.page.keyboard.down(key);
  await expect.poll(() => Math.abs(wrapAngle(hunter.network.own().facing - target))).toBeLessThan(0.05);
  await hunter.page.keyboard.up(key);
  let last = { ...hunter.network.own().position };
  await expect.poll(() => {
    const now = hunter.network.own().position;
    const moved = now.x !== last.x || now.z !== last.z;
    last = { ...now };
    return moved;
  }).toBe(false);
}

const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.z - b.z);

// The arena corner farthest from every listed position: a safe place to send a player.
function farCorner(others: Position[]): Position {
  const inset = 60;
  const corners = [
    { x: inset, y: groundedY, z: inset },
    { x: TEST_WORLD.width - inset, y: groundedY, z: inset },
    { x: inset, y: groundedY, z: TEST_WORLD.depth - inset },
    { x: TEST_WORLD.width - inset, y: groundedY, z: TEST_WORLD.depth - inset },
  ];
  return corners.reduce((best, corner) =>
    Math.min(...others.map((other) => distance(corner, other))) > Math.min(...others.map((other) => distance(best, other))) ? corner : best);
}

async function openPlayers(browser: Browser) {
  const players: Player[] = [];
  const pageErrors: string[] = [];
  for (let index = 0; index < PLAYER_COUNT; index++) {
    // Separate pages model real players without sharing page state.
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    players.push({ page, network: observeGame(page) });
  }
  return { players, pageErrors, close: () => Promise.all(players.map((player) => player.page.close())) };
}

async function createRoom(host: Player): Promise<string> {
  await host.page.goto('/');
  await host.page.getByRole('button', { name: 'Host a game' }).click();
  await expect(host.page.locator('#room')).toHaveText(/^[A-Z0-9]{4}$/);
  const code = (await host.page.locator('#room').textContent())!.trim();
  return code;
}

// Everyone else joins by URL, which is the same as typing the code.
async function fillRoom(players: Player[]): Promise<string> {
  const code = await createRoom(players[0]);
  for (const guest of players.slice(1)) {
    await guest.page.goto(`/?room=${code}`);
    await expect(guest.page.locator('#room')).toHaveText(code);
  }
  for (const player of players) await expect(player.page.locator('#players')).toHaveText(`${PLAYER_COUNT} / ${PLAYER_COUNT}`);
  return code;
}

// During a round the page is only the game; the VFX toggles and the host's room controls are in
// the debug menu (toggled with `), each in a collapsible section. The menu is left closed
// otherwise, so it never covers the arena the colour checks read.
async function openMenu(page: Page, section: string) {
  if (await page.locator('#debug-menu').isHidden()) await page.keyboard.press('Backquote');
  await page.locator(section).evaluate((details) => {
    (details as HTMLDetailsElement).open = true;
  });
}
async function closeMenu(page: Page) {
  if (await page.locator('#debug-menu').isVisible()) await page.keyboard.press('Backquote');
}

// The host starts; every page reaches the reveal and then the running round. On the result the
// host uses Play again; during a round, Restart match is in the debug menu's Room section.
async function startMatch(host: Player, players: Player[], previousRoundId?: number) {
  const inRound = await host.page.locator('body.in-round').count() > 0;
  if (await host.page.locator('#play-again').isVisible()) {
    await host.page.locator('#play-again').click();
  } else {
    if (inRound) await openMenu(host.page, '#menu-room-section');
    await host.page.locator('#start').click();
    if (inRound) await closeMenu(host.page);
  }
  for (const player of players) {
    await expect.poll(() => {
      const snapshot = player.network.latest();
      return snapshot !== undefined && snapshot.roundId !== previousRoundId;
    }, { timeout: 10_000 }).toBe(true);
  }
  const reveals = players.map((player) => player.network.latest()!);
  expect(new Set(reveals.map((snapshot) => snapshot.roundId)).size).toBe(1);
  expect(reveals.every((snapshot) => snapshot.roundState === 'reveal' || snapshot.roundState === 'running')).toBe(true);
  const creature = players.filter((player) => player.network.latest()!.role === 'creature');
  expect(creature).toHaveLength(1);
  const hunters = players.filter((player) => player.network.latest()!.role === 'hunter');
  expect(hunters.map((hunter) => hunter.network.hunter().self).sort()).toEqual(['H1', 'H2', 'H3', 'H4']);
  for (const player of players) await expect.poll(() => player.network.latest()?.roundState, { timeout: 10_000 }).toBe('running');
  return { creature: creature[0], hunters, roundId: reveals[0].roundId };
}

// Checks every Hunter payload in plain JavaScript and asserts once: each expect() is a
// traced step, and four Hunters produce thousands of snapshots per test.
function assertHunterWire(network: Network) {
  const snapshots = network.messages.filter((message): message is HunterSnapshot => message.type === 'snapshot' && message.role === 'hunter');
  expect(snapshots.length).toBeGreaterThan(10);
  const problems: string[] = [];
  const sameKeys = (value: object, expected: string[]) => Object.keys(value).sort().join() === expected.join();
  for (const message of snapshots) {
    if (Object.keys(message).filter((key) => key !== 'creature' && key !== 'catch' && key !== 'stats').sort().join() !== HUNTER_KEYS.join()) problems.push(`keys: ${Object.keys(message).join()}`);
    if (('stats' in message) !== (message.roundState === 'ended')) problems.push(`stats in ${message.roundState}`);
    if (message.catch && (!sameKeys(message.catch, ['elapsed', 'hunter']) || typeof message.catch.elapsed !== 'number')) {
      problems.push(`catch ${JSON.stringify(message.catch)}`);
    }
    if (message.hunters.length !== GAMEPLAY.players.hunters) problems.push(`hunter count ${message.hunters.length}`);
    for (const hunter of message.hunters) {
      if (!sameKeys(hunter, HUNTER_VIEW_KEYS)) problems.push(`hunter view keys: ${Object.keys(hunter).join()}`);
      if (!sameKeys(hunter.position, ['x', 'y', 'z']) || hunter.position.y !== groundedY) problems.push(`hunter position ${JSON.stringify(hunter.position)}`);
    }
    // The clock is a number of seconds and the pickup list is spawn-point indices: neither
    // may ever become an object that could carry a position.
    if (typeof message.timeRemaining !== 'number' || message.timeRemaining < 0) problems.push(`time ${message.timeRemaining}`);
    if (message.pickups.length > 1) problems.push(`more than one battery: ${JSON.stringify(message.pickups)}`);
    if (message.pickups.some((index) => !Number.isInteger(index) || index < 0 || index >= PICKUP_COUNT)) {
      problems.push(`pickups ${JSON.stringify(message.pickups)}`);
    }
    if (message.creature) {
      if (!sameKeys(message.creature, ['burning', 'facing', 'position', 'revealRemaining', 'sprinting', 'staggered'])) problems.push(`creature keys: ${Object.keys(message.creature).join()}`);
      if (!sameKeys(message.creature.position, ['x', 'y', 'z']) || message.creature.position.y !== groundedY) problems.push(`creature position ${JSON.stringify(message.creature.position)}`);
    }
  }
  expect(problems.slice(0, 5)).toEqual([]);
}

test('the title screen is styled from its first frame, and ready before the wipe uncovers it', async ({ page }) => {
  // Every frame the browser renders from the very start, until the opening wipe has finished.
  await page.addInitScript(() => {
    const seen = { unstyled: 0, frames: 0, atReveal: null as null | { tiles: number; scale: string } };
    (window as unknown as { seen: typeof seen }).seen = seen;
    const frame = () => {
      const cover = document.querySelector<HTMLCanvasElement>('#transition');
      if (document.body) {
        seen.frames += 1;
        if (getComputedStyle(document.body).overflow !== 'hidden'
          || document.documentElement.scrollHeight > window.innerHeight) seen.unstyled += 1;
      }
      if (cover && !cover.style.background && !seen.atReveal) {
        seen.atReveal = {
          tiles: document.querySelectorAll('#game-title .tile').length,
          scale: document.documentElement.style.getPropertyValue('--stage-scale'),
        };
      }
      if (!cover?.hidden) requestAnimationFrame(frame);
    };
    frame();
  });
  await page.goto('/');
  await expect(page.locator('#transition')).toBeHidden();
  const seen = await page.evaluate(() => (window as unknown as { seen: unknown }).seen) as {
    unstyled: number; frames: number; atReveal: { tiles: number; scale: string };
  };
  expect(seen.frames).toBeGreaterThan(0);
  expect(seen.unstyled).toBe(0);
  expect(seen.atReveal.tiles).toBeGreaterThan(0);
  expect(seen.atReveal.scale).not.toBe('');
});

test('five players fill a room, receive private roles, move, see only permitted state, and survive a disconnect', async ({ browser }, testInfo) => {
  const { players, pageErrors, close } = await openPlayers(browser);
  const [host, second] = players;
  try {
    const privateModulePath = fileURLToPath(new URL('../src/server/game.ts', import.meta.url)).replaceAll('\\', '/');
    const privateModule = await host.page.request.get(`/@fs/${encodeURI(privateModulePath)}`);
    expect(privateModule.status()).toBe(403);

    // Room screen: a code, a count, the guest list, and a start button only the host has.
    const code = await createRoom(host);
    await expect(host.page.locator('#players')).toHaveText(`1 / ${PLAYER_COUNT}`);
    await expect(host.page.locator('#waiting')).toHaveText('The evening begins when all five guests arrive.');
    await expect(host.page.locator('#guest-list li')).toHaveText(['Guest 1HOST · YOU', 'An empty slot…WAITING', 'An empty slot…WAITING', 'An empty slot…WAITING', 'An empty slot…WAITING']);
    await expect(host.page.locator('#start')).toBeVisible();
    await expect(host.page.locator('#start')).toBeDisabled();
    await expect(host.page.locator('#arena-container')).toBeHidden();

    // A wrong code is refused; the form then joins with the real one, typed in lower case.
    await second.page.goto('/');
    await second.page.locator('#code').fill('0000');
    await second.page.getByRole('button', { name: 'Join' }).click();
    await expect(second.page.locator('#status')).toHaveText('No room has that code.');
    await second.page.locator('#code').fill(code.toLowerCase());
    await second.page.getByRole('button', { name: 'Join' }).click();
    await expect(second.page.locator('#room')).toHaveText(code);
    await expect(second.page.locator('#players')).toHaveText(`2 / ${PLAYER_COUNT}`);
    await expect(second.page.locator('#guest-list li').nth(1)).toHaveText('Guest 2YOU');
    await expect(second.page.locator('#start')).toBeHidden();
    await expect(host.page.locator('#players')).toHaveText(`2 / ${PLAYER_COUNT}`);
    await expect(host.page.locator('#guest-list li').nth(1)).toHaveText('Guest 2ARRIVED');

    for (const guest of players.slice(2)) {
      await guest.page.goto(`/?room=${code}`);
      await expect(guest.page.locator('#room')).toHaveText(code);
    }
    for (const player of players) await expect(player.page.locator('#players')).toHaveText(`${PLAYER_COUNT} / ${PLAYER_COUNT}`);
    await expect(host.page.locator('#waiting')).toHaveText('Everyone has arrived. Begin the evening.');
    await expect(second.page.locator('#waiting')).toHaveText('Everyone has arrived. Waiting for the host to begin.');
    await expect(host.page.locator('#start')).toBeEnabled();

    // Map choice: the host has a picker listing the server's catalogue with the test arena
    // selected; guests see the name. Switching (when another map exists) updates every
    // page's label and rebuilds the scene, and the arena is what the tests then play on.
    await expect(host.page.locator('#map')).toBeVisible();
    await expect(host.page.locator('#map')).toHaveValue('test-arena');
    await expect(second.page.locator('#map')).toBeHidden();
    await expect(second.page.locator('#map-name')).toHaveText('Test Arena');
    const otherMap = host.network.room()!.maps.find((map) => map.id !== 'test-arena');
    if (otherMap) {
      await host.page.locator('#map').selectOption(otherMap.id);
      for (const player of players) await expect(player.page.locator(player === host ? '#map' : '#map-name')).toHaveText(new RegExp(otherMap.name));
      await expect.poll(() => second.network.room()?.mapId).toBe(otherMap.id);
      await host.page.locator('#map').selectOption('test-arena');
      for (const player of players) await expect.poll(() => player.network.room()?.mapId).toBe('test-arena');
    }
    for (const player of players) {
      const maps = player.network.messages.filter((message) => message.type === 'map');
      expect(maps.length).toBeGreaterThan(0);
      expect((maps.at(-1) as { map: { name: string } }).map.name).toBe('Test Arena');
    }

    // A sixth client is refused.
    const sixth = await browser.newPage();
    try {
      await sixth.goto(`/?room=${code}`);
      await expect(sixth.locator('#status')).toHaveText('That room is full.');
      await expect(sixth.locator('#room')).toBeHidden();
    } finally {
      await sixth.close();
    }

    // Start: every page privately shows its own role, then the round runs.
    await host.page.getByRole('button', { name: 'Begin the evening' }).click();
    for (const player of players) await expect.poll(() => player.network.latest()?.roundState, { timeout: 10_000 }).toBe('reveal');
    const creaturePages = players.filter((player) => player.network.latest()!.role === 'creature');
    expect(creaturePages).toHaveLength(1);
    const creature = creaturePages[0];
    const hunters = players.filter((player) => player !== creature);
    await expect(creature.page.locator('#overlay-title')).toHaveText('YOU ARE THE CREATURE');
    await expect(creature.page.locator('#role')).toContainText('Creature');
    await expect(creature.page.locator('#proximity')).toBeHidden();
    for (const hunter of hunters) {
      await expect(hunter.page.locator('#overlay-title')).toHaveText('YOU ARE A HUNTER');
      await expect(hunter.page.locator('#overlay-detail')).toHaveText(hunter.network.hunter().self);
      await expect(hunter.page.locator('#role')).toContainText(`Hunter ${hunter.network.hunter().self}`);
    }
    await creature.page.screenshot({ path: testInfo.outputPath('creature-reveal.png') });
    for (const player of players) await expect.poll(() => player.network.latest()?.roundState, { timeout: 10_000 }).toBe('running');
    for (const player of players) {
      await expect(player.page.locator('#overlay')).toBeHidden();
      await expect(player.page.locator('#team')).toHaveText(teamLine(player, () => 'ACTIVE'));
      await expect(player.page.locator('#arena-container')).toBeVisible();
      await expect(player.page.locator('#lobby')).toBeHidden();
    }
    for (const hunter of hunters) {
      await expect(hunter.page.locator('#team-cards')).toContainText(`${hunter.network.hunter().self} · YOU`);
      await expect(hunter.page.locator('#battery-number')).toHaveText('100');
      await expect(hunter.page.locator('#battery-stage')).toHaveText('FULL');
      await expect(hunter.page.locator('#creature-tag')).toHaveText('UNSEEN');
      await expect(hunter.page.locator('#hp-number')).toHaveText(String(GAMEPLAY.creature.maxHp));
      await expect(hunter.page.locator('#team')).toContainText(`${hunter.network.hunter().self}* ACTIVE`);
      await expect(hunter.page.locator('#proximity')).toHaveText('Proximity: SAFE');
      await expect(hunter.page.locator('#creature-hp')).toHaveText(`Creature HP: ${GAMEPLAY.creature.maxHp}`);
      await expect(hunter.page.locator('#creature-state')).toHaveText('Creature: hidden');
      // Prototype 4 HUD: a full battery at the FULL stage, and an empty map — nothing
      // spawns until the first-spawn delay has run, because everyone starts fully charged.
      await expect(hunter.page.locator('#battery')).toHaveText(`Battery: ${MAX_BATTERY} FULL`);
      expect(hunter.network.hunter().pickups).toHaveLength(0);
    }
    await expect(creature.page.locator('#creature-state')).toHaveText('State: hidden');
    await expect(creature.page.locator('#hud-battery')).toBeHidden();
    await expect(creature.page.locator('#creature-tag')).toHaveText('HIDDEN');
    await expect(creature.page.locator('#clock')).toHaveText(/^\d+:\d{2}$/);
    // The clock is authoritative and identical for both roles; the Creature has no battery.
    for (const player of players) await expect(player.page.locator('#timer')).toHaveText(/^Time: \d+:\d{2}$/);
    await expect(creature.page.locator('#battery')).toBeHidden();
    expect(creature.network.creature().pickups).toEqual(hunters[0].network.hunter().pickups);
    const clockAt = creature.network.creature().timeRemaining;
    await expect.poll(() => creature.network.creature().timeRemaining).toBeLessThan(clockAt);
    await expect.poll(() => hunters[0].network.hunter().timeRemaining).toBeLessThan(clockAt);

    // Require a real WebGL scene using a perspective projection in its shader. Bloom and the
    // night grade end each frame with a flat full-screen pass, so they are switched off while
    // the last program drawn is read, which is then the scene's own.
    for (const player of [hunters[0], creature]) {
      const postEffects = [player.page.locator('[data-vfx="bloom"]'), player.page.locator('[data-vfx="grade"]')];
      await openMenu(player.page, '#vfx-section');
      for (const toggle of postEffects) await toggle.uncheck();
      await player.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await player.page.locator('#arena').evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext('webgl2');
        if (!(context instanceof WebGL2RenderingContext) || context.isContextLost()) return false;
        const program = context.getParameter(context.CURRENT_PROGRAM) as WebGLProgram | null;
        if (!program) return false;
        const location = context.getUniformLocation(program, 'projectionMatrix');
        if (!location) return false;
        const projection = context.getUniform(program, location) as Float32Array;
        return projection[11] === -1 && projection[15] === 0;
      })).toBe(true);
      for (const toggle of postEffects) await toggle.check();
      await closeMenu(player.page);
    }
    // The Creature sees four Hunters and itself; a Hunter sees itself, three teammates, no Creature.
    await creature.page.screenshot({ path: testInfo.outputPath('creature-view.png') });
    await expect.poll(async () => (await visiblePlayerColors(creature.page)).teammatePixels).toBeGreaterThan(60);
    await expect.poll(async () => (await visiblePlayerColors(creature.page)).creaturePixels).toBeGreaterThan(20);
    const hunterColors = await visiblePlayerColors(hunters[0].page);
    expect(hunterColors.selfPixels).toBeGreaterThan(20);
    expect(hunterColors.teammatePixels).toBeGreaterThan(40);
    expect(hunterColors.creaturePixels).toBe(0);
    await hunters[0].page.screenshot({ path: testInfo.outputPath('hunter-view.png') });

    // Movement by one Hunter is replicated to its teammates and to the Creature; the
    // Creature's own movement reaches only the Creature.
    const mover = hunters[1];
    const moverId = mover.network.hunter().self;
    for (const [axis, negativeKey, positiveKey] of [['z', 'KeyW', 'KeyS'], ['x', 'KeyA', 'KeyD']] as const) {
      // Random spawns may be beside a wall: first move toward the side with more open floor.
      const origin = mover.network.own().position;
      const clearance = (sign: number) => wallDistance(origin, { x: axis === 'x' ? sign : 0, y: 0, z: axis === 'z' ? sign : 0 }, Infinity, TEST_WORLD.wallBoxes);
      const firstSign = clearance(1) >= clearance(-1) ? 1 : -1;
      for (const sign of [firstSign, -firstSign]) {
        const key = sign === 1 ? positiveKey : negativeKey;
        const before = mover.network.own().position[axis];
        await mover.page.keyboard.down(key);
        await expect.poll(() => (mover.network.own().position[axis] - before) * sign).toBeGreaterThan(12);
        await mover.page.keyboard.up(key);
        await expect.poll(() => (creature.network.teammate(moverId).position[axis] - before) * sign).toBeGreaterThan(12);
        await expect.poll(() => (hunters[0].network.teammate(moverId).position[axis] - before) * sign).toBeGreaterThan(12);
      }
    }
    expect(creature.network.teammate(moverId).facing).toBeCloseTo(mover.network.own().facing, 5);
    const creatureStart = { ...creature.network.creature().creature };
    const creatureSign = wallDistance(creatureStart, { x: 1, y: 0, z: 0 }, Infinity, TEST_WORLD.wallBoxes) >= wallDistance(creatureStart, { x: -1, y: 0, z: 0 }, Infinity, TEST_WORLD.wallBoxes) ? 1 : -1;
    await creature.page.keyboard.down(creatureSign === 1 ? 'KeyD' : 'KeyA');
    await expect.poll(() => (creature.network.creature().creature.x - creatureStart.x) * creatureSign).toBeGreaterThan(12);
    await creature.page.keyboard.up(creatureSign === 1 ? 'KeyD' : 'KeyA');
    for (const hunter of hunters) expect('creature' in hunter.network.hunter()).toBe(false);

    // Holding the flashlight drains the battery on the server and on every client that
    // draws this Hunter's cone; releasing it stops the drain with no recharge.
    const lighter = hunters[0];
    await lighter.page.keyboard.down('Space');
    await expect.poll(() => lighter.network.own().battery).toBeLessThan(MAX_BATTERY);
    await expect.poll(() => creature.network.teammate(lighter.network.hunter().self).battery).toBeLessThan(MAX_BATTERY);
    await lighter.page.keyboard.up('Space');
    await expect.poll(() => lighter.network.own().light).toBe(false);
    const drained = lighter.network.own().battery;
    await expect(lighter.page.locator('#battery')).toHaveText(`Battery: ${Math.ceil(drained)} FULL`);
    await lighter.page.waitForTimeout(500);
    expect(lighter.network.own().battery).toBe(drained);

    // Sprint: every Hunter page receives the Creature while it sprints, then loses it again.
    await creature.page.keyboard.down('Space');
    for (const hunter of hunters) await expect.poll(() => hunter.network.hunter().creature?.sprinting).toBe(true);
    for (const hunter of hunters) await expect(hunter.page.locator('#creature-state')).toHaveText('Creature: SPRINTING');
    await expect(creature.page.locator('#creature-state')).toHaveText('State: SPRINTING');
    await expect.poll(async () => (await visiblePlayerColors(hunters[0].page)).creaturePixels).toBeGreaterThan(20);
    await hunters[0].page.screenshot({ path: testInfo.outputPath('hunter-sprint.png') });
    await creature.page.keyboard.up('Space');
    for (const hunter of hunters) await expect.poll(() => 'creature' in hunter.network.hunter()).toBe(false);
    await expect.poll(async () => (await visiblePlayerColors(hunters[0].page)).creaturePixels).toBe(0);
    for (const hunter of hunters) await expect(hunter.page.locator('#creature-state')).toHaveText('Creature: hidden');
    expect(hunters[0].network.hunter().creatureHp).toBe(GAMEPLAY.creature.maxHp);

    // Wire allowlists for every Hunter page: no hidden transform ever, and the Creature
    // only in its revealed shape while it sprinted.
    for (const hunter of hunters) {
      assertHunterWire(hunter.network);
      const withCreature = hunter.network.messages.filter((message) => message.type === 'snapshot' && message.role === 'hunter' && 'creature' in message);
      expect(withCreature.length).toBeGreaterThan(0);
    }

    // Disconnect policy: a guest closing mid-round sends everyone else back to the room.
    const leaver = hunters.find((hunter) => hunter !== host) ?? creature;
    const remaining = players.filter((player) => player !== leaver);
    const roundId = creature.network.latest()!.roundId;
    await leaver.page.close();
    for (const player of remaining) {
      await expect(player.page.locator('#status')).toHaveText('A player disconnected, so the round was ended. Waiting for players…');
      await expect(player.page.locator('#players')).toHaveText(`${PLAYER_COUNT - 1} / ${PLAYER_COUNT}`);
      await expect(player.page.locator('#arena-container')).toBeHidden();
      expect(player.network.room()?.notice).toBe('disconnected');
    }
    await expect(host.page.locator('#start')).toBeDisabled();

    // A replacement joins and the host starts a fresh round with new roles.
    const replacement = await browser.newPage();
    const replacementNetwork = observeGame(replacement);
    try {
      await replacement.goto(`/?room=${code}`);
      const everyone = [...remaining, { page: replacement, network: replacementNetwork }];
      for (const player of everyone) await expect(player.page.locator('#players')).toHaveText(`${PLAYER_COUNT} / ${PLAYER_COUNT}`);
      const again = await startMatch(host, everyone, roundId);
      expect(again.roundId).toBe(roundId + 1);
      for (const player of everyone) {
        expect(player.network.latest()!.result).toBeNull();
        expect(player.network.latest()!.hunters.every((hunter) => !hunter.down)).toBe(true);
      }
    } finally {
      await replacement.close();
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await close();
  }
});

// The compact team line as a page should show it: the viewer's own slot carries an asterisk.
function teamLine(player: Player, state: (id: string) => string): string {
  const snapshot = player.network.latest();
  const self = snapshot?.role === 'hunter' ? snapshot.self : null;
  return ['H1', 'H2', 'H3', 'H4'].map((id) => `${id}${id === self ? '*' : ''} ${state(id)}`).join(' · ');
}

test('Hunters reveal and damage the Creature, a downed Hunter is revived by a teammate, the Creature is defeated, and the room plays again', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const { players, pageErrors, close } = await openPlayers(browser);
  const host = players[0];
  try {
    await fillRoom(players);
    const { creature, hunters, roundId } = await startMatch(host, players);
    const running = () => creature.network.latest()?.roundState === 'running';
    const creaturePosition = () => creature.network.creature().creature;
    const positionOf = (hunter: Player) => hunter.network.own().position;
    const othersFor = (player: Player) => players.filter((other) => other !== player).map((other) =>
      other === creature ? creaturePosition() : creature.network.teammate(other.network.hunter().self).position);

    // Stage the encounter with each role's own legitimate information plus the shared
    // blockout: Hunter A walks to an open lane and turns east; the Creature, which sees
    // every Hunter and its facing, parks 60 units in front of A: inside the 90-unit beam.
    const [a, b] = hunters;
    const lane = findLane(300, othersFor(a));
    expect(await drive(a.page, () => positionOf(a), lane.start, { avoid: othersFor(a), arrive: 10, running })).toBe(true);
    await face(a, 'east');
    const front = { ...positionOf(a), x: positionOf(a).x + 60 };
    expect(await drive(creature.page, creaturePosition, front, { avoid: othersFor(creature), arrive: 10, running })).toBe(true);
    for (const hunter of hunters) expect('creature' in hunter.network.hunter()).toBe(false);

    // A's light reveals and staggers the Creature for every Hunter and drains HP.
    await a.page.keyboard.down('Space');
    await expect.poll(() => a.network.own().light).toBe(true);
    for (const hunter of hunters) await expect.poll(() => hunter.network.hunter().creature?.staggered).toBe(true);
    expect(a.network.hunter().creature!.position).toEqual(creaturePosition());
    for (const hunter of hunters) await expect(hunter.page.locator('#creature-state')).toHaveText('Creature: STAGGERED');
    await expect(creature.page.locator('#creature-state')).toContainText('State: STAGGERED');
    await expect.poll(async () => (await visiblePlayerColors(b.page)).creaturePixels).toBeGreaterThan(20);
    await b.page.screenshot({ path: testInfo.outputPath('teammate-sees-reveal.png') });
    const hpAtReveal = a.network.hunter().creatureHp;
    await expect.poll(() => a.network.hunter().creatureHp).toBeLessThan(hpAtReveal - 1);
    await a.page.keyboard.up('Space');
    for (const hunter of hunters) await expect.poll(() => 'creature' in hunter.network.hunter()).toBe(false);

    // Once free of the stagger and the burn, the Creature attacks A: A is down, the round
    // goes on, and everyone sees it.
    await expect.poll(() => creature.network.creature().staggered, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => creature.network.creature().burning, { timeout: 10_000 }).toBe(false);
    const aId = a.network.hunter().self;
    await drive(creature.page, creaturePosition, positionOf(a), { arrive: 0, running: () => running() && !creature.network.teammate(aId).down });
    for (const player of players) await expect.poll(() => player.network.teammate(aId).down).toBe(true);
    expect(creature.network.creature().roundState).toBe('running');
    expect(creature.network.creature().attackCooldown).toBeGreaterThan(0);
    // Nothing covers the game for a downed Hunter: its own card says so, and it watches on.
    await expect(a.page.locator('#team-cards')).toContainText('DOWN · 0%');
    await expect(a.page.locator('#overlay')).toBeHidden();
    for (const player of players) await expect(player.page.locator('#team')).toContainText(`${aId}${player === a ? '*' : ''} DOWN 0%`);
    await a.page.screenshot({ path: testInfo.outputPath('hunter-down.png') });
    // A's keys do nothing now.
    const fell = { ...positionOf(a) };
    await a.page.keyboard.down('KeyD');
    await a.page.waitForTimeout(400);
    await a.page.keyboard.up('KeyD');
    expect(positionOf(a)).toEqual(fell);

    // The Creature retreats, then a teammate walks up beside the body, faces it, and shines.
    const away = farCorner([fell, ...hunters.filter((hunter) => hunter !== a).map(positionOf)]);
    expect(await drive(creature.page, creaturePosition, away, { avoid: hunters.map(positionOf), arrive: 30, running })).toBe(true);
    // The Creature can catch a bystander on its way out, so the rescue is carried out by
    // whichever teammate is still standing rather than by a fixed slot.
    const standing = () => hunters.filter((hunter) => hunter !== a && !hunter.network.own().down);
    const rescuer = standing()[0];
    expect(rescuer, 'at least one teammate is still up to revive A').toBeDefined();
    // Approach from the west unless the body lies against the west wall.
    const fromWest = fell.x - 60 >= 60;
    const approach = { ...fell, x: fromWest ? fell.x - 60 : fell.x + 60 };
    expect(await drive(rescuer.page, () => positionOf(rescuer), approach, { avoid: othersFor(rescuer), arrive: 10, running })).toBe(true);
    await face(rescuer, fromWest ? 'east' : 'west');
    await rescuer.page.keyboard.down('Space');
    await expect.poll(() => rescuer.network.teammate(aId).revive).toBeGreaterThan(0);
    await expect(a.page.locator('#team-cards')).toContainText(/DOWN · [1-9]\d?%/);
    await expect(a.page.locator('#overlay')).toBeHidden();
    await expect(rescuer.page.locator('#team')).toContainText(new RegExp(`${aId} DOWN [1-9]\\d?%`));
    await rescuer.page.screenshot({ path: testInfo.outputPath('hunter-reviving.png') });
    await expect.poll(() => rescuer.network.teammate(aId).down, { timeout: GAMEPLAY.revive.seconds * 1000 + 15_000 }).toBe(false);
    await rescuer.page.keyboard.up('Space');
    for (const player of players) await expect(player.page.locator('#team')).toContainText(`${aId}${player === a ? '*' : ''} ACTIVE`);
    // Revived: A can move again (toward whichever side has more open floor).
    const revivedAt = { ...positionOf(a) };
    const zClearance = (sign: number) => wallDistance(revivedAt, { x: 0, y: 0, z: sign }, Infinity, TEST_WORLD.wallBoxes);
    const zSign = zClearance(1) >= zClearance(-1) ? 1 : -1;
    await a.page.keyboard.down(zSign === 1 ? 'KeyS' : 'KeyW');
    await expect.poll(() => (positionOf(a).z - revivedAt.z) * zSign).toBeGreaterThan(12);
    await a.page.keyboard.up(zSign === 1 ? 'KeyS' : 'KeyW');

    // The rescue cost the reviver most of a battery, and a pickup is the only way to get
    // it back. The map holds at most one battery and none at all early on, so wait for one
    // to appear, then walk to it: it refills the Hunter, disappears for every client, and
    // starts the respawn countdown on the server. Nobody else is moving at this point, so
    // the battery cannot be taken on the way.
    const spent = rescuer.network.own().battery;
    expect(spent).toBeLessThan(MAX_BATTERY);
    await expect.poll(() => rescuer.network.hunter().pickups.length, { timeout: 90_000 }).toBe(1);
    const target = rescuer.network.hunter().pickups[0];
    expect(await drive(rescuer.page, () => positionOf(rescuer), pickupPoint(target), {
      avoid: [creaturePosition()], arrive: 10, running, timeoutMs: 40_000,
    })).toBe(true);
    await expect.poll(() => rescuer.network.own().battery).toBe(MAX_BATTERY);
    expect(rescuer.network.hunter().pickups).not.toContain(target);
    expect(creature.network.creature().pickups).not.toContain(target);
    await expect(rescuer.page.locator('#battery')).toHaveText(`Battery: ${MAX_BATTERY} FULL`);
    await rescuer.page.screenshot({ path: testInfo.outputPath('hunter-battery-pickup.png') });

    // Defeat: A leaves the lane, the Creature is parked close in front of C — the Hunter
    // that has not spent any battery yet — and C holds the light until the Creature's HP
    // reaches zero. Along the way the stagger expires while the Creature is still lit, then
    // the cooldown lets it stagger again. The distance is short enough that the beam still
    // reaches after the battery has dropped through its stages.
    expect(await drive(a.page, () => positionOf(a), farCorner(othersFor(a)), { avoid: othersFor(a), arrive: 30, running })).toBe(true);
    const killer = standing().find((hunter) => hunter !== rescuer && hunter.network.own().battery === MAX_BATTERY) ?? rescuer;
    expect(killer.network.own().battery).toBe(MAX_BATTERY);
    const killLane = findLane(200, othersFor(killer));
    expect(await drive(killer.page, () => positionOf(killer), killLane.start, { avoid: othersFor(killer), arrive: 10, running })).toBe(true);
    await face(killer, 'east');
    const frontOfKiller = { ...positionOf(killer), x: positionOf(killer).x + 45 };
    expect(await drive(creature.page, creaturePosition, frontOfKiller, { avoid: othersFor(creature), arrive: 6, running })).toBe(true);
    await killer.page.keyboard.down('Space');
    await expect.poll(() => killer.network.hunter().creature?.staggered).toBe(true);
    await expect.poll(() => creature.network.latest()?.result, { timeout: 60_000 }).toBe('defeated');
    await killer.page.keyboard.up('Space');
    // Killing the Creature outright costs most of one battery.
    expect(killer.network.own().battery).toBeLessThan(0.6 * MAX_BATTERY);
    for (const player of players) {
      await expect(player.page.locator('#status')).toContainText('Creature defeated. Hunters win.');
      await expect(player.page.locator('#result')).toBeVisible();
      await expect(player.page.locator('#result-title')).toHaveAccessibleName('The Hunters win');
      await expect(player.page.locator('#result-reason')).toHaveText('The Creature has been exorcised.');
      await expect(player.page.locator('#game-hud')).toBeHidden();
    }
    await expect(host.page.locator('#status')).toContainText('Play again to start the next round.');
    await expect(host.page.locator('#start')).toHaveText('Play again');
    await expect(host.page.locator('#start')).toBeEnabled();
    await expect(host.page.locator('#play-again')).toBeVisible();
    for (const player of players.filter((player) => player !== host)) {
      await expect(player.page.locator('#status')).toContainText('Waiting for the host to start the next round.');
      await expect(player.page.locator('#start')).toBeHidden();
      await expect(player.page.locator('#play-again')).toBeHidden();
      await expect(player.page.locator('#result .result-wait')).toBeVisible();
    }
    // The tallies came with the result: A's catch, its revival, the battery, and the light on the
    // Creature at least as long as the kill took.
    const stats = creature.network.creature().stats!;
    expect(stats.caught).toBeGreaterThanOrEqual(1);
    expect(stats.revived).toBeGreaterThanOrEqual(1);
    expect(stats.batteries).toBeGreaterThanOrEqual(1);
    expect(stats.lit).toBeGreaterThan(0);
    await expect(host.page.locator('#result-stats')).toContainText(`CAUGHT${stats.caught}`);
    // The Gazette opens over everything and closes back to the overlay.
    await b.page.locator('#read-gazette').click();
    await expect(b.page.locator('#gazette')).toBeVisible();
    await expect(b.page.locator('#gazette-headline')).toHaveText('Creature unmasked at the midnight ball');
    await expect(b.page.locator('#gazette-stats')).toContainText(`LIGHT ON IT${stats.lit.toFixed(1)} s`);
    await b.page.screenshot({ path: testInfo.outputPath('gazette.png') });
    await b.page.locator('#close-gazette').click();
    await expect(b.page.locator('#gazette')).toBeHidden();
    await expect(b.page.locator('#result')).toBeVisible();
    // Coming back is the wipe's job: the entrance does not play twice.
    await expect(b.page.locator('#result')).not.toHaveClass(/entering/);
    for (const hunter of hunters) await expect(hunter.page.locator('#creature-hp')).toHaveText('Creature HP: 0');
    expect(creature.network.creature().hp).toBe(0);
    const creatureMessages = creature.network.messages.filter((message): message is CreatureSnapshot => message.type === 'snapshot' && message.role === 'creature');
    const staggerStarts = creatureMessages.filter((message, index) => message.staggered && !creatureMessages[index - 1]?.staggered).length;
    expect(staggerStarts).toBeGreaterThanOrEqual(2);
    expect(creatureMessages.some((message) => message.lit && !message.staggered)).toBe(true);
    await killer.page.screenshot({ path: testInfo.outputPath('hunter-victory.png') });

    for (const hunter of hunters) assertHunterWire(hunter.network);

    // Rematch without recreating the room: fresh roles, full HP, nobody down, nothing revealed.
    const clockAtEnd = creature.network.creature().timeRemaining;
    const again = await startMatch(host, players, roundId);
    expect(again.roundId).toBe(roundId + 1);
    for (const hunter of again.hunters) {
      expect(hunter.network.hunter().creatureHp).toBe(GAMEPLAY.creature.maxHp);
      expect('creature' in hunter.network.hunter()).toBe(false);
      await expect(hunter.page.locator('#creature-state')).toHaveText('Creature: hidden');
      // Prototype 4 resources reset with the round: full batteries, an empty map with the
      // first-spawn delay running again, and a fresh clock — nothing carried over.
      await expect(hunter.page.locator('#battery')).toHaveText(`Battery: ${MAX_BATTERY} FULL`);
      expect(hunter.network.hunter().pickups).toHaveLength(0);
      expect(hunter.network.hunter().timeRemaining).toBeGreaterThan(clockAtEnd);
    }
    expect(again.creature.network.creature().hunters.every((hunter) => !hunter.down)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await close();
  }
});

test('the Creature wins by downing all four Hunters, and the room can start again', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const { players, pageErrors, close } = await openPlayers(browser);
  const host = players[0];
  try {
    await fillRoom(players);
    const { creature, hunters, roundId } = await startMatch(host, players);
    const creaturePosition = () => creature.network.creature().creature;

    // Chase the nearest active Hunter, one after another, until every Hunter is down.
    const held = new Set<string>();
    const deadline = Date.now() + 120_000;
    let downs = 0;
    while (creature.network.creature().roundState === 'running' && Date.now() < deadline) {
      const snapshot = creature.network.creature();
      const targets = snapshot.hunters.filter((hunter) => !hunter.down);
      // The last catch's cutscene: every Hunter is down and the round ends when it does.
      if (targets.length === 0) {
        await creature.page.waitForTimeout(50);
        continue;
      }
      const position = creaturePosition();
      const nearest = targets.reduce((best, hunter) => (distance(hunter.position, position) < distance(best.position, position) ? hunter : best));
      await applyKeys(creature.page, held, keysToward(position, nearest.position));
      const downNow = snapshot.hunters.filter((hunter) => hunter.down).length;
      if (downNow > downs) {
        downs = downNow;
        expect(snapshot.result).toBeNull();
        if (downNow === 1) await creature.page.screenshot({ path: testInfo.outputPath('creature-first-down.png') });
      }
      await creature.page.waitForTimeout(50);
    }
    for (const key of held) await creature.page.keyboard.up(key);
    expect(creature.network.creature().roundState).toBe('ended');
    expect(creature.network.creature().result).toBe('caught');
    for (const player of players) {
      await expect(player.page.locator('#status')).toContainText('Every Hunter is down. Creature wins.');
      await expect(player.page.locator('#team')).toHaveText(/H1\*? DOWN \d+% · H2\*? DOWN \d+% · H3\*? DOWN \d+% · H4\*? DOWN \d+%/);
    }
    // A hidden Creature stays hidden: a Hunter page received it only for each catch, during the
    // cutscene every player watches and the reveal linger after it (a few spare snapshots for
    // timing), never while it hunted unseen.
    const lingerSnapshots = Math.ceil(GAMEPLAY.creature.visibilityLingerSeconds * GAMEPLAY.tickRate) + 3;
    for (const hunter of hunters) {
      expect(hunter.network.hunter().result).toBe('caught');
      let sinceCatch = Infinity;
      for (const message of hunter.network.messages) {
        if (message.type !== 'snapshot') continue;
        sinceCatch = 'catch' in message ? 0 : sinceCatch + 1;
        if ('creature' in message) expect(sinceCatch, 'the Creature appears only around a catch').toBeLessThanOrEqual(lingerSnapshots);
      }
      expect(hunter.network.messages.some((message) => message.type === 'snapshot' && 'catch' in message), 'every Hunter watched the catches').toBe(true);
      assertHunterWire(hunter.network);
    }
    await hunters[0].page.screenshot({ path: testInfo.outputPath('creature-victory.png') });
    for (const player of players) await expect(player.page.locator('#result-title')).toHaveAccessibleName('The Creature wins');

    // Back to the lobby: everyone returns to the room screen, then the host begins again from it.
    // The diamond wipe covers the change of screen and is gone once the room shows.
    await host.page.locator('#to-lobby').click();
    await expect(host.page.locator('#transition')).toBeVisible();
    for (const player of players) {
      await expect(player.page.locator('#room-screen')).toBeVisible();
      await expect(player.page.locator('#transition')).toBeHidden();
      await expect(player.page.locator('#arena-container')).toBeHidden();
      await expect(player.page.locator('#players')).toHaveText(`${PLAYER_COUNT} / ${PLAYER_COUNT}`);
    }
    await expect(host.page.locator('#start')).toHaveText('Begin the evening');
    const again = await startMatch(host, players, roundId);
    expect(again.roundId).toBe(roundId + 1);
    for (const player of players) expect(player.network.latest()!.hunters.every((hunter) => !hunter.down)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await close();
  }
});
