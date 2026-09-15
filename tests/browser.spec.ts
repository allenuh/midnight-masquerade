import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { GAMEPLAY } from '../src/shared/gameplay-config.js';
import type { ServerMessage } from '../src/shared/protocol.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type CreatureSnapshot = Extract<Snapshot, { role: 'creature' }>;

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
  };
}

test('two players can chase, receive private snapshots, tag, and restart', async ({ browser }, testInfo) => {
  // Separate browser contexts model two real players without sharing page state.
  const hunter = await browser.newPage();
  const creature = await browser.newPage();
  const hunterNetwork = observeGame(hunter);
  const creatureNetwork = observeGame(creature);
  const pageErrors: string[] = [];
  for (const page of [hunter, creature]) {
    page.on('pageerror', (error) => pageErrors.push(error.message));
  }

  function creatureSnapshot(): CreatureSnapshot {
    const snapshot = creatureNetwork.latest();
    if (snapshot?.role !== 'creature') throw new Error('Expected the Creature snapshot.');
    return snapshot;
  }

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
    const visiblePlayerColors = async (page: Page) => {
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
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let hunterPixels = 0;
        let creaturePixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const [red, green, blue] = [pixels[index], pixels[index + 1], pixels[index + 2]];
          // Basic lighting shades the primitives, so use color ranges rather than
          // exact material RGB values. The floor and walls are darker neutrals.
          if (red > 200 && green > 200 && blue > 200 && Math.abs(red - blue) < 20) hunterPixels++;
          if (red > 100 && red > green + 25 && green > blue + 10) creaturePixels++;
        }
        return { hunterPixels, creaturePixels };
      }, screenshot.toString('base64'));
    };
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
    for (const [axis, extent, negativeKey, positiveKey] of [
      ['z', GAMEPLAY.arena.depth, 'KeyW', 'KeyS'],
      ['x', GAMEPLAY.arena.width, 'KeyA', 'KeyD'],
    ] as const) {
      // Random spawns may be against a wall: move toward the center, then back.
      const firstSign = hunterNetwork.latest()!.hunter![axis] < extent / 2 ? 1 : -1;
      for (const sign of [firstSign, -firstSign]) {
        const key = sign === 1 ? positiveKey : negativeKey;
        const before = hunterNetwork.latest()!.hunter![axis];
        await hunter.keyboard.down(key);
        await expect.poll(() => (hunterNetwork.latest()!.hunter![axis] - before) * sign).toBeGreaterThan(12);
        await hunter.keyboard.up(key);
        await expect.poll(() => (creatureSnapshot().hunter![axis] - before) * sign).toBeGreaterThan(12);
      }
    }

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

    const creatureStart = { ...creatureSnapshot().creature };
    const held = new Set<string>();
    const deadline = Date.now() + 10_000;
    let savedWarning = false;
    while (creatureSnapshot().roundState === 'running' && Date.now() < deadline) {
      // Steering uses only the coordinates legitimately delivered to the Creature.
      const snapshot = creatureSnapshot();
      const dx = snapshot.hunter!.x - snapshot.creature.x;
      const dz = snapshot.hunter!.z - snapshot.creature.z;
      const desired = new Set<string>();
      if (Math.abs(dx) > 4) desired.add(dx > 0 ? 'KeyD' : 'KeyA');
      if (Math.abs(dz) > 4) desired.add(dz > 0 ? 'KeyS' : 'KeyW');
      for (const key of held) {
        if (!desired.has(key)) await creature.keyboard.up(key);
      }
      for (const key of desired) {
        if (!held.has(key)) await creature.keyboard.down(key);
      }
      held.clear();
      for (const key of desired) held.add(key);
      const hunterSnapshot = hunterNetwork.latest();
      if (!savedWarning && hunterSnapshot?.role === 'hunter' && hunterSnapshot.proximity === 'DANGER') {
        await hunter.screenshot({ path: testInfo.outputPath('hunter-warning.png') });
        savedWarning = true;
      }
      await creature.waitForTimeout(60);
    }
    for (const key of held) await creature.keyboard.up(key);
    expect(creatureSnapshot().creature).not.toEqual(creatureStart);
    await expect(hunter.locator('#status')).toContainText('Hunter caught. Round ended.');
    await expect(creature.locator('#status')).toContainText('Hunter caught. Round ended.');
    expect(hunterNetwork.latest()?.roundState).toBe('ended');
    expect(creatureSnapshot().roundState).toBe('ended');
    expect(hunterNetwork.latest()?.result).toBe('caught');
    expect(creatureSnapshot().result).toBe('caught');

    const warningStates = hunterNetwork.messages.flatMap((message) =>
      message.type === 'snapshot' && message.role === 'hunter' ? [message.proximity] : []);
    expect([...new Set(warningStates)]).toEqual(['SAFE', 'UNEASY', 'DANGER', 'IMMEDIATE']);

    const endedRoundId = creatureSnapshot().roundId;
    await hunter.getByRole('button', { name: 'Restart round' }).click();
    await expect.poll(() => hunterNetwork.latest()?.roundState).toBe('running');
    await expect.poll(() => creatureNetwork.latest()?.roundState).toBe('running');
    expect(creatureSnapshot().roundId).not.toBe(endedRoundId);
    expect(creatureSnapshot().result).toBeNull();
    await expect(hunter.locator('#proximity')).toHaveText('Proximity: SAFE');
    const restartedX = creatureSnapshot().creature.x;
    const restartedDirection = restartedX < GAMEPLAY.arena.width / 2 ? 1 : -1;
    const restartedKey = restartedDirection === 1 ? 'KeyD' : 'KeyA';
    await creature.keyboard.down(restartedKey);
    await expect.poll(() => (creatureSnapshot().creature.x - restartedX) * restartedDirection).toBeGreaterThan(12);
    await creature.keyboard.up(restartedKey);

    // Strict allowlists catch accidental additions, including nested transforms,
    // exact distances, spawn data, or revealing the Creature after a tag/reset.
    expect(hunterNetwork.messages.length).toBeGreaterThan(10);
    for (const message of hunterNetwork.messages) {
      expect(message.type).toBe('snapshot');
      if (message.type !== 'snapshot') throw new Error('Unexpected Hunter message.');
      expect(message.role).toBe('hunter');
      expect(Object.keys(message).sort()).toEqual(
        ['type', 'role', 'roundId', 'roundState', 'result', 'hunter', 'proximity'].sort(),
      );
      expect(Object.keys(message.hunter!).sort()).toEqual(['x', 'y', 'z']);
      expect(message.hunter!.y).toBe(GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
    }
    for (const message of creatureNetwork.messages) {
      if (message.type !== 'snapshot' || message.role !== 'creature') continue;
      expect(message.creature.y).toBe(GAMEPLAY.arena.floorY + GAMEPLAY.playerRadius);
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await hunter.close();
    await creature.close();
  }
});
