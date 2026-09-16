import type { ClientMessage, InputState, ServerMessage } from '../shared/protocol.js';
import { CAMERA } from './camera-config.js';
import { createScene } from './scene.js';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#arena')!;
const container = document.querySelector<HTMLElement>('#arena-container')!;
const arenaView = document.querySelector<HTMLElement>('#arena-view')!;
const warning = document.querySelector<HTMLElement>('#proximity-warning')!;
const roleText = document.querySelector<HTMLElement>('#role')!;
const proximityText = document.querySelector<HTMLElement>('#proximity')!;
const creatureHpText = document.querySelector<HTMLElement>('#creature-hp')!;
const creatureStateText = document.querySelector<HTMLElement>('#creature-state')!;
const statusText = document.querySelector<HTMLElement>('#status')!;
const restartButton = document.querySelector<HTMLButtonElement>('#restart')!;

function start(): void {
  let scene: ReturnType<typeof createScene>;
  try {
    scene = createScene(canvas);
  } catch {
    statusText.textContent = 'This prototype requires WebGL 2. Enable browser hardware acceleration or try another desktop browser, then reload.';
    return;
  }

  type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
  let snapshot: Snapshot | null = null;
  let serverFull = false;
  const input: InputState = { up: false, down: false, left: false, right: false, light: false };
  // Movement keys also steer the Hunter's facing. Space (or the left mouse button
  // on the arena) is the held action button: the Hunter's flashlight, the Creature's sprint.
  const keyBindings: Record<string, keyof InputState> = {
    KeyW: 'up',
    KeyS: 'down',
    KeyA: 'left',
    KeyD: 'right',
    Space: 'light',
  };

  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);

  function send(message: ClientMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function sendInput(): void {
    if (snapshot?.roundState === 'running') {
      send({ type: 'input', roundId: snapshot.roundId, ...input });
    }
  }

  function clearInput(): void {
    input.up = false;
    input.down = false;
    input.left = false;
    input.right = false;
    input.light = false;
  }

  function releaseInput(): void {
    clearInput();
    sendInput();
  }

  function setHeld(key: keyof InputState, pressed: boolean): void {
    if (snapshot?.roundState !== 'running' || socket.readyState !== WebSocket.OPEN) return;
    if (input[key] === pressed) return;
    input[key] = pressed;
    sendInput();
  }

  function updateHud(): void {
    if (!snapshot) return;
    roleText.textContent = `Role: ${snapshot.role === 'hunter' ? 'Hunter (white sphere)' : 'Creature (orange octahedron)'}`;
    proximityText.hidden = snapshot.role !== 'hunter';
    creatureHpText.hidden = false;
    creatureStateText.hidden = false;
    if (snapshot.role === 'hunter') {
      proximityText.textContent = `Proximity: ${snapshot.proximity}`;
      creatureHpText.textContent = `Creature HP: ${Math.ceil(snapshot.creatureHp)}`;
      const seen = snapshot.creature;
      const state = !seen ? 'HIDDEN' : seen.staggered ? 'STAGGERED' : seen.sprinting ? 'SPRINTING' : 'REVEALED';
      creatureStateText.dataset.state = state;
      creatureStateText.textContent = `Creature: ${state === 'HIDDEN' ? 'hidden' : state}`;
    } else {
      creatureHpText.textContent = `HP: ${Math.ceil(snapshot.hp)}`;
      const state = snapshot.staggered ? 'STAGGERED'
        : snapshot.lit ? 'LIT'
          : snapshot.sprinting ? 'SPRINTING'
            : snapshot.revealed ? 'REVEALED' : 'HIDDEN';
      creatureStateText.dataset.state = state;
      const cooldowns = [
        snapshot.staggerCooldown > 0 ? ` · stagger cooldown ${snapshot.staggerCooldown.toFixed(1)} s` : '',
        snapshot.sprintCooldown > 0 ? ` · sprint cooldown ${snapshot.sprintCooldown.toFixed(1)} s` : '',
      ].join('');
      creatureStateText.textContent = `State: ${state === 'HIDDEN' ? 'hidden' : state}${cooldowns}`;
    }
    warning.dataset.state = snapshot.role === 'hunter' && snapshot.roundState === 'running'
      ? snapshot.proximity
      : 'SAFE';
    switch (snapshot.roundState) {
      case 'waiting':
        statusText.textContent = `Waiting for the ${snapshot.role === 'hunter' ? 'Creature' : 'Hunter'}. Open a second browser client.`;
        break;
      case 'running':
        statusText.textContent = snapshot.role === 'hunter'
          ? 'Find the Creature. Hold Space or the left mouse button to shine the flashlight; it staggers and damages a lit Creature.'
          : 'Touch the Hunter to win. Hold Space or the left mouse button to sprint: faster, but visible. Stay out of the flashlight: being lit staggers you and drains HP.';
        break;
      case 'ended':
        statusText.textContent = snapshot.result === 'defeated'
          ? 'Creature defeated. Hunter wins. Restart to play again.'
          : 'Hunter caught. Creature wins. Restart to play again.';
        break;
    }
    restartButton.disabled = socket.readyState !== WebSocket.OPEN || snapshot.roundState === 'waiting';
  }

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === 'full') {
      serverFull = true;
      clearInput();
      restartButton.disabled = true;
      statusText.textContent = 'Both player slots are occupied. Close a player client, then reload this page.';
      return;
    }

    const roundChanged = snapshot?.roundId !== message.roundId;
    snapshot = message;
    if (roundChanged || snapshot.roundState !== 'running') clearInput();
    updateHud();
  });

  socket.addEventListener('close', () => {
    clearInput();
    warning.dataset.state = 'SAFE';
    restartButton.disabled = true;
    if (!serverFull) statusText.textContent = 'Disconnected. Reload this page to reconnect.';
  });

  socket.addEventListener('error', () => {
    clearInput();
    warning.dataset.state = 'SAFE';
    restartButton.disabled = true;
    if (!serverFull) statusText.textContent = 'Connection failed. Check that the server is running, then reload.';
  });

  function handleKey(event: KeyboardEvent, pressed: boolean): void {
    const key = keyBindings[event.code];
    if (!key) return;
    event.preventDefault();
    setHeld(key, pressed);
  }

  window.addEventListener('keydown', (event) => handleKey(event, true));
  window.addEventListener('keyup', (event) => handleKey(event, false));
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setHeld('light', true);
  });
  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) setHeld('light', false);
  });
  window.addEventListener('pointercancel', () => setHeld('light', false));
  window.addEventListener('blur', releaseInput);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseInput();
  });

  restartButton.addEventListener('click', () => {
    if (restartButton.disabled) return;
    // Drop focus so a later Space press works the flashlight instead of this button.
    restartButton.blur();
    releaseInput();
    send({ type: 'restart' });
  });

  // Held flags are refreshed so the server can stop a stalled client's input.
  const inputTimer = window.setInterval(sendInput, 100);

  function resizeArena(): void {
    const width = Math.max(1, Math.min(container.clientWidth, container.clientHeight * CAMERA.aspect));
    const height = width / CAMERA.aspect;
    arenaView.style.width = `${width}px`;
    arenaView.style.height = `${height}px`;
    scene.resize(width, height);
  }

  // Render the latest authoritative state; the client does not simulate movement or hits.
  let animationFrame = 0;
  function draw(): void {
    scene.render(snapshot);
    animationFrame = window.requestAnimationFrame(draw);
  }

  const resizeObserver = new ResizeObserver(resizeArena);
  resizeObserver.observe(container);
  resizeArena();
  draw();

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    window.clearInterval(inputTimer);
    window.cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    scene.dispose();
    socket.close();
  });
}

start();
