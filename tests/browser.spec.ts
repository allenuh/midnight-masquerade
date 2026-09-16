import { expect, test, type Browser, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { Position, ServerMessage } from '../src/shared/protocol.js';
import { wallDistance } from '../src/shared/raycast.js';
import { findLane, keysToward, type Keys } from './helpers/navigate.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type HunterSnapshot = Extract<Snapshot, { role: 'hunter' }>;
type CreatureSnapshot = Extract<Snapshot, { role: 'creature' }>;

const HUNTER_KEYS = ['type', 'role', 'roundId', 'roundState', 'result', 'hunter', 'facing', 'light', 'proximity', 'creatureHp'].sort();
const groundedY = GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius;

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
    latest(): Snapshot | undefined {
      return messages.filter((message): message is Snapshot => message.type === 'snapshot').at(-1);
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
  };
}

// Basic lighting shades the primitives, so count color ranges rather than exact
// material RGB values. The floor, walls, and translucent light fan are neutrals or
// pale yellows that match neither the white Hunter nor the orange Creature.
async function visiblePlayerColors(page: Page) {
  const screenshot = await page.locator('#arena').screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    // Skip the outer margin: the amber proximity-warning border overlays the canvas edges.
    const margin = 24;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hunterPixels = 0;
    let creaturePixels = 0;
    for (let y = margin; y < canvas.height - margin; y++) {
      for (let x = margin; x < canvas.width - margin; x++) {
        const index = (y * canvas.width + x) * 4;
        const [red, green, blue] = [pixels[index], pixels[index + 1], pixels[index + 2]];
        if (red > 200 && green > 200 && blue > 200 && Math.abs(red - blue) < 20) hunterPixels++;
        if (red > 100 && red > green + 25 && green > blue + 10) creaturePixels++;
      }
    }
    return { hunterPixels, creaturePixels };
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
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
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

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

async function openPair(browser: Browser) {
  const hunter = await browser.newPage();
  const creature = await browser.newPage();
  const hunterNetwork = observeGame(hunter);
  const creatureNetwork = observeGame(creature);
  const pageErrors: string[] = [];
  for (const page of [hunter, creature]) {
    page.on('pageerror', (error) => pageErrors.push(error.message));
  }
  return { hunter, creature, hunterNetwork, creatureNetwork, pageErrors };
}

test('two players can chase through the blockout, receive private snapshots, tag, and restart', async ({ browser }, testInfo) => {
  // Separate pages model two real players without sharing page state.
  const { hunter, creature, hunterNetwork, creatureNetwork, pageErrors } = await openPair(browser);
  try {
    const privateModulePath = fileURLToPath(new URL('../src/server/game.ts', import.meta.url)).replaceAll('\\', '/');
    const privateModule = await hunter.request.get(`/@fs/${encodeURI(privateModulePath)}`);
    expect(privateModule.status()).toBe(403);
    await hunter.goto('/');
    await expect(hunter.locator('#role')).toContainText('Hunter');
    await expect(hunter.locator('#status')).toContainText('Waiting');
    await creature.goto('/');
    await expect(creature.locator('#role')).toContainText('Creature');
    await expect(creature.locator('#proximity')).toBeHidden();
    await expect.poll(() => hunterNetwork.latest()?.roundState).toBe('running');
    await expect.poll(() => creatureNetwork.latest()?.roundState).toBe('running');
    await expect(hunter.locator('#proximity')).toHaveText('Proximity: SAFE');
    await expect(hunter.locator('#creature-hp')).toHaveText(`Creature HP: ${GAMEPLAY.creature.maxHp}`);
    await expect(hunter.locator('#creature-state')).toHaveText('Creature: hidden');
    await expect(creature.locator('#creature-state')).toHaveText('State: hidden');

    // Require a real WebGL scene using a perspective projection in its shader.
    // Inspect screenshots rather than the drawing buffer, which WebGL may clear
    // after presentation. Neither check needs a game-state or renderer debug hook.
    for (const page of [hunter, creature]) {
      expect(await page.locator('#arena').evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext('webgl2');
        if (!(context instanceof WebGL2RenderingContext) || context.isContextLost()) return false;
        const program = context.getParameter(context.CURRENT_PROGRAM) as WebGLProgram | null;
        if (!program) return false;
        const location = context.getUniformLocation(program, 'projectionMatrix');
        if (!location) return false;
        const projection = context.getUniform(program, location) as Float32Array;
        return projection[11] === -1 && projection[15] === 0;
      })).toBe(true);
    }
    await creature.screenshot({ path: testInfo.outputPath('creature-view.png') });
    await expect.poll(async () => (await visiblePlayerColors(creature)).hunterPixels).toBeGreaterThan(20);
    await expect.poll(async () => (await visiblePlayerColors(creature)).creaturePixels).toBeGreaterThan(20);
    expect((await visiblePlayerColors(hunter)).creaturePixels).toBe(0);

    // A smaller desktop viewport must retain both players and the full arena.
    // Save both sizes so the fixed oblique camera framing can be inspected.
    await creature.setViewportSize({ width: 900, height: 700 });
    await expect.poll(async () => (await visiblePlayerColors(creature)).hunterPixels).toBeGreaterThan(10);
    await expect.poll(async () => (await visiblePlayerColors(creature)).creaturePixels).toBeGreaterThan(10);
    await creature.screenshot({ path: testInfo.outputPath('creature-view-small.png') });
    await creature.setViewportSize({ width: 1280, height: 800 });

    // Verify each WASD direction through server snapshots, including replication
    // to the Creature. No test sends positions or calls the simulation directly.
    for (const [axis, negativeKey, positiveKey] of [
      ['z', 'KeyW', 'KeyS'],
      ['x', 'KeyA', 'KeyD'],
    ] as const) {
      // Random spawns may be beside a wall: first move toward the side with more open floor.
      const origin = hunterNetwork.hunter().hunter;
      const clearance = (sign: number) => wallDistance(origin, { x: axis === 'x' ? sign : 0, y: 0, z: axis === 'z' ? sign : 0 }, Infinity);
      const firstSign = clearance(1) >= clearance(-1) ? 1 : -1;
      for (const sign of [firstSign, -firstSign]) {
        const key = sign === 1 ? positiveKey : negativeKey;
        const before = hunterNetwork.hunter().hunter[axis];
        await hunter.keyboard.down(key);
        await expect.poll(() => (hunterNetwork.hunter().hunter[axis] - before) * sign).toBeGreaterThan(12);
        await hunter.keyboard.up(key);
        await expect.poll(() => (creatureNetwork.creature().hunter![axis] - before) * sign).toBeGreaterThan(12);
      }
    }
    // Movement turned the facing gradually; the Creature is told where the light points.
    expect(hunterNetwork.messages.filter((m) => m.type === 'snapshot' && m.role === 'hunter').map((m) => (m as HunterSnapshot).facing)
      .some((facing, index, all) => index > 0 && facing !== all[index - 1])).toBe(true);
    expect(creatureNetwork.creature().hunterFacing).toBeCloseTo(hunterNetwork.hunter().facing, 5);

    const thirdPlayer = await browser.newPage();
    const thirdNetwork = observeGame(thirdPlayer);
    try {
      await thirdPlayer.goto('/');
      await expect(thirdPlayer.locator('#status')).toContainText('Both player slots are occupied');
      expect(thirdNetwork.messages).toEqual([{ type: 'full' }]);
      // The empty blockout also checks that the color detector cannot mistake
      // lit floor or walls for either player.
      expect(await visiblePlayerColors(thirdPlayer)).toEqual({ hunterPixels: 0, creaturePixels: 0 });
    } finally {
      await thirdPlayer.close();
    }

    // Chase: steering uses only the coordinates legitimately delivered to the Creature,
    // routed around the interior walls with the shared blockout geometry.
    const creatureStart = { ...creatureNetwork.creature().creature };
    let savedWarning = false;
    const held = new Set<string>();
    const deadline = Date.now() + 15_000;
    while (creatureNetwork.creature().roundState === 'running' && Date.now() < deadline) {
      const snapshot = creatureNetwork.creature();
      await applyKeys(creature, held, keysToward(snapshot.creature, snapshot.hunter!));
      const hunterSnapshot = hunterNetwork.latest();
      if (!savedWarning && hunterSnapshot?.role === 'hunter' && hunterSnapshot.proximity === 'DANGER') {
        await hunter.screenshot({ path: testInfo.outputPath('hunter-warning.png') });
        savedWarning = true;
      }
      await creature.waitForTimeout(50);
    }
    for (const key of held) await creature.keyboard.up(key);
    expect(creatureNetwork.creature().creature).not.toEqual(creatureStart);
    await expect(hunter.locator('#status')).toContainText('Hunter caught. Creature wins.');
    await expect(creature.locator('#status')).toContainText('Hunter caught. Creature wins.');
    expect(hunterNetwork.latest()?.roundState).toBe('ended');
    expect(creatureNetwork.creature().roundState).toBe('ended');
    expect(hunterNetwork.latest()?.result).toBe('caught');
    expect(creatureNetwork.creature().result).toBe('caught');

    const warningStates = hunterNetwork.messages.flatMap((message) =>
      message.type === 'snapshot' && message.role === 'hunter' ? [message.proximity] : []);
    expect([...new Set(warningStates)]).toEqual(['SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE']);

    const endedRoundId = creatureNetwork.creature().roundId;
    await hunter.getByRole('button', { name: 'Restart round' }).click();
    await expect.poll(() => hunterNetwork.latest()?.roundState).toBe('running');
    await expect.poll(() => creatureNetwork.latest()?.roundState).toBe('running');
    expect(creatureNetwork.creature().roundId).not.toBe(endedRoundId);
    expect(creatureNetwork.creature().result).toBeNull();
    await expect(hunter.locator('#proximity')).toHaveText('Proximity: SAFE');
    const restarted = creatureNetwork.creature().creature;
    const restartedDirection = wallDistance(restarted, { x: 1, y: 0, z: 0 }, Infinity) >= wallDistance(restarted, { x: -1, y: 0, z: 0 }, Infinity) ? 1 : -1;
    await creature.keyboard.down(restartedDirection === 1 ? 'KeyD' : 'KeyA');
    await expect.poll(() => (creatureNetwork.creature().creature.x - restarted.x) * restartedDirection).toBeGreaterThan(12);
    await creature.keyboard.up(restartedDirection === 1 ? 'KeyD' : 'KeyA');

    // Strict allowlists catch accidental additions, including nested transforms,
    // exact distances, spawn data, or revealing the Creature after a tag/reset.
    // The light was never used here, so no Hunter message may carry a Creature.
    expect(hunterNetwork.messages.length).toBeGreaterThan(10);
    for (const message of hunterNetwork.messages) {
      expect(message.type).toBe('snapshot');
      if (message.type !== 'snapshot') throw new Error('Unexpected Hunter message.');
      expect(message.role).toBe('hunter');
      if (message.role !== 'hunter') throw new Error('Unexpected Hunter message.');
      expect(Object.keys(message).sort()).toEqual(HUNTER_KEYS);
      expect(Object.keys(message.hunter).sort()).toEqual(['x', 'y', 'z']);
      expect(message.hunter.y).toBe(groundedY);
      expect(message.light).toBe(false);
    }
    for (const message of creatureNetwork.messages) {
      if (message.type !== 'snapshot' || message.role !== 'creature') continue;
      expect(message.creature.y).toBe(groundedY);
      expect(message.revealed).toBe(false);
      expect(message.hp).toBe(GAMEPLAY.creature.maxHp);
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await hunter.close();
    await creature.close();
  }
});

test('the Hunter reveals, staggers, damages, and defeats the Creature with the flashlight', async ({ browser }, testInfo) => {
  const { hunter, creature, hunterNetwork, creatureNetwork, pageErrors } = await openPair(browser);
  const isHunterMessage = (message: ServerMessage): message is HunterSnapshot => message.type === 'snapshot' && message.role === 'hunter';
  const isCreatureMessage = (message: ServerMessage): message is CreatureSnapshot => message.type === 'snapshot' && message.role === 'creature';
  try {
    await hunter.goto('/');
    await creature.goto('/');
    await expect.poll(() => hunterNetwork.latest()?.roundState).toBe('running');
    await expect.poll(() => creatureNetwork.latest()?.roundState).toBe('running');
    const running = () => hunterNetwork.latest()?.roundState === 'running';

    // Stage the encounter with each role's own legitimate information plus the
    // shared blockout: the Hunter walks to an open lane and turns east; the Creature,
    // which sees the Hunter and its facing, parks 100 units in front of it.
    const creatureStart = { ...creatureNetwork.creature().creature };
    const lane = findLane(360, [creatureStart]);
    expect(await drive(hunter, () => hunterNetwork.hunter().hunter, lane.start, { avoid: [creatureStart], arrive: 10, running })).toBe(true);
    await hunter.keyboard.down('KeyD');
    await expect.poll(() => Math.abs(wrapAngle(hunterNetwork.hunter().facing))).toBeLessThan(0.05);
    await hunter.keyboard.up('KeyD');
    let hunterPosition = { ...hunterNetwork.hunter().hunter };
    await expect.poll(() => {
      const now = hunterNetwork.hunter().hunter;
      const moved = now.x !== hunterPosition.x || now.z !== hunterPosition.z;
      hunterPosition = { ...now };
      return moved;
    }).toBe(false);
    const front = { ...hunterPosition, x: hunterPosition.x + 100 };
    expect(await drive(creature, () => creatureNetwork.creature().creature, front, { avoid: [hunterPosition], arrive: 10, running })).toBe(true);
    expect('creature' in hunterNetwork.hunter()).toBe(false);
    expect((await visiblePlayerColors(hunter)).creaturePixels).toBe(0);
    await expect(creature.locator('#creature-state')).toHaveText('State: hidden');

    // Sprint: the Creature's own action button reveals it with no light involved,
    // costs no HP, and the reveal ends after the linger once the button is released.
    await creature.keyboard.down('Space');
    await expect.poll(() => hunterNetwork.hunter().creature?.sprinting).toBe(true);
    expect(hunterNetwork.hunter().light).toBe(false);
    expect(hunterNetwork.hunter().creature!.staggered).toBe(false);
    await expect(hunter.locator('#creature-state')).toHaveText('Creature: SPRINTING');
    await expect(creature.locator('#creature-state')).toHaveText('State: SPRINTING');
    await expect.poll(async () => (await visiblePlayerColors(hunter)).creaturePixels).toBeGreaterThan(20);
    await hunter.screenshot({ path: testInfo.outputPath('hunter-sprint.png') });
    await creature.keyboard.up('Space');
    await expect.poll(() => creatureNetwork.creature().sprinting).toBe(false);
    await expect.poll(() => 'creature' in hunterNetwork.hunter()).toBe(false);
    await expect.poll(async () => (await visiblePlayerColors(hunter)).creaturePixels).toBe(0);
    await expect(hunter.locator('#creature-state')).toHaveText('Creature: hidden');
    expect(hunterNetwork.hunter().creatureHp).toBe(GAMEPLAY.creature.maxHp);
    expect(creatureNetwork.creature().hp).toBe(GAMEPLAY.creature.maxHp);

    // Light on: the Creature is revealed and staggered, and its HP drains.
    await hunter.keyboard.down('Space');
    await expect.poll(() => hunterNetwork.hunter().light).toBe(true);
    await expect.poll(() => hunterNetwork.hunter().creature?.staggered).toBe(true);
    expect(hunterNetwork.hunter().creature!.position).toEqual(creatureNetwork.creature().creature);
    await expect(hunter.locator('#creature-state')).toHaveText('Creature: STAGGERED');
    await expect(creature.locator('#creature-state')).toContainText('State: STAGGERED');
    await expect(creature.locator('#creature-state')).toContainText('stagger cooldown');
    await expect.poll(async () => (await visiblePlayerColors(hunter)).creaturePixels).toBeGreaterThan(20);
    await hunter.screenshot({ path: testInfo.outputPath('hunter-reveal.png') });
    await creature.screenshot({ path: testInfo.outputPath('creature-staggered.png') });
    const hpAtReveal = hunterNetwork.hunter().creatureHp;
    await expect.poll(() => hunterNetwork.hunter().creatureHp).toBeLessThan(hpAtReveal - 1);
    expect(creatureNetwork.creature().hp).toBeLessThan(GAMEPLAY.creature.maxHp);

    // Release: the Creature lingers for the configured window, then leaves both the
    // wire and the screen, and stays gone while the light is off.
    await hunter.keyboard.up('Space');
    const releaseIndex = hunterNetwork.messages.length;
    await expect.poll(() => hunterNetwork.hunter().light).toBe(false);
    await expect.poll(() => 'creature' in hunterNetwork.hunter()).toBe(false);
    await expect.poll(async () => (await visiblePlayerColors(hunter)).creaturePixels).toBe(0);
    await expect(hunter.locator('#creature-state')).toHaveText('Creature: hidden');
    await hunter.waitForTimeout(500);
    const afterRelease = hunterNetwork.messages.slice(releaseIndex).filter(isHunterMessage);
    const lingering = afterRelease.filter((message) => !message.light && 'creature' in message).length;
    expect(lingering).toBeGreaterThan(0);
    expect(lingering).toBeLessThanOrEqual(Math.round(GAMEPLAY.creature.visibilityLingerSeconds * GAMEPLAY.tickRate) + 3);
    const firstHidden = afterRelease.findIndex((message) => !message.light && !('creature' in message));
    expect(afterRelease.slice(firstHidden).every((message) => !('creature' in message))).toBe(true);

    // Hold the light until the Creature is defeated. Along the way the stagger
    // expires while the Creature is still lit, then the cooldown lets it stagger again.
    await hunter.keyboard.down('Space');
    await expect.poll(() => hunterNetwork.latest()?.result, { timeout: 45_000 }).toBe('defeated');
    await hunter.keyboard.up('Space');
    await expect(hunter.locator('#status')).toContainText('Creature defeated. Hunter wins.');
    await expect(creature.locator('#status')).toContainText('Creature defeated. Hunter wins.');
    await expect(hunter.locator('#creature-hp')).toHaveText('Creature HP: 0');
    expect(creatureNetwork.creature().result).toBe('defeated');
    expect(creatureNetwork.creature().hp).toBe(0);
    const creatureMessages = creatureNetwork.messages.filter(isCreatureMessage);
    const staggerStarts = creatureMessages.filter((message, index) => message.staggered && !creatureMessages[index - 1]?.staggered).length;
    expect(staggerStarts).toBeGreaterThanOrEqual(2);
    expect(creatureMessages.some((message) => message.lit && !message.staggered)).toBe(true);
    await hunter.screenshot({ path: testInfo.outputPath('hunter-victory.png') });

    // Restart resets HP, hides the Creature, and starts a new round.
    await creature.getByRole('button', { name: 'Restart round' }).click();
    await expect.poll(() => hunterNetwork.latest()?.roundState).toBe('running');
    await expect.poll(() => creatureNetwork.latest()?.roundState).toBe('running');
    expect(hunterNetwork.hunter().creatureHp).toBe(GAMEPLAY.creature.maxHp);
    expect('creature' in hunterNetwork.hunter()).toBe(false);
    await expect(hunter.locator('#creature-state')).toHaveText('Creature: hidden');

    // Wire allowlist: every Hunter message has exactly the base keys, plus
    // `creature` only in its { position, staggered, sprinting } shape while revealed.
    for (const message of hunterNetwork.messages) {
      if (!isHunterMessage(message)) throw new Error('Unexpected Hunter message.');
      expect(Object.keys(message).filter((key) => key !== 'creature').sort()).toEqual(HUNTER_KEYS);
      if (message.creature) {
        expect(Object.keys(message.creature).sort()).toEqual(['position', 'sprinting', 'staggered']);
        expect(Object.keys(message.creature.position).sort()).toEqual(['x', 'y', 'z']);
        expect(message.creature.position.y).toBe(groundedY);
      }
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await hunter.close();
    await creature.close();
  }
});
