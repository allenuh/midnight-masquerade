import { flashlightStage } from '../shared/flashlight.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import { validateMap } from '../shared/map/validate.js';
import { buildWorld } from '../shared/map/world.js';
import type { ClientMessage, InputState, RoomMessage, ServerMessage } from '../shared/protocol.js';
import { DEFAULT_TUNING, TUNABLES, defaultTuning, type Tunable, type Tuning } from '../shared/tuning.js';
import { createScene } from './scene.js';
import './style.css';

const element = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const canvas = element<HTMLCanvasElement>('#arena');
const container = element('#arena-container');
const arenaView = element('#arena-view');
const warning = element('#proximity-warning');
const lobby = element('#lobby');
const menu = element('#menu');
const createButton = element<HTMLButtonElement>('#create');
const joinForm = element<HTMLFormElement>('#join-form');
const codeInput = element<HTMLInputElement>('#code');
const joinButton = element<HTMLButtonElement>('#join');
const roomText = element('#room');
const timerText = element('#timer');
const playersText = element('#players');
const waitingText = element('#waiting');
const roleText = element('#role');
const batteryText = element('#battery');
const proximityText = element('#proximity');
const creatureHpText = element('#creature-hp');
const creatureStateText = element('#creature-state');
const teamText = element('#team');
const statusText = element('#status');
const startButton = element<HTMLButtonElement>('#start');
const overlay = element('#overlay');
const overlayTitle = element('#overlay-title');
const overlayDetail = element('#overlay-detail');
const debugPanel = element('#debug');
const mapSelect = element<HTMLSelectElement>('#map');
const mapText = element('#map-name');
const tuningPanel = element<HTMLDetailsElement>('#tuning');
const tuningSummary = element('#tuning-summary');
const tuningNote = element('#tuning-note');
const tuningBody = element<HTMLTableSectionElement>('#tuning-table tbody');
const tuningReset = element<HTMLButtonElement>('#tuning-reset');

const PLAYER_COUNT = GAMEPLAY.players.hunters + 1;
// Playtest overlay, off unless the page is opened with ?debug=1. It shows only what this
// client already received: a Hunter page has no Creature position to put in it.
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

function start(): void {
  // The client bundles no map. The scene exists only once the server has sent the room's
  // map, and is rebuilt (reusing the WebGL renderer) whenever the host switches map.
  let scene: ReturnType<typeof createScene> | null = null;

  function loadMap(value: unknown): void {
    const result = validateMap(value);
    if (!result.ok) {
      statusText.textContent = `The server sent an invalid map: ${result.errors.join(' | ')}`;
      return;
    }
    const renderer = scene?.renderer;
    scene?.dispose(true);
    try {
      scene = createScene(canvas, buildWorld(result.map), renderer);
    } catch {
      scene = null;
      statusText.textContent = 'This prototype requires WebGL 2. Enable browser hardware acceleration or try another desktop browser, then reload.';
      return;
    }
    resizeArena();
  }

  type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
  // The last room message (membership, host flag) and the last round snapshot, if a
  // round exists. A room message replaces the snapshot: it means there is no round.
  let room: RoomMessage | null = null;
  let snapshot: Snapshot | null = null;
  let menuNotice: string | null = null;
  let closedReason: string | null = null;
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

  function joinRoom(code: string): void {
    const normalized = code.trim().toUpperCase();
    if (normalized) send({ type: 'join', code: normalized });
  }

  // The between-round tuning table, one row per tunable from the shared table: the
  // host edits a number input, everyone else reads the same number as text. The room
  // message is the source of truth; an edit sends the whole table and the values shown
  // are whatever the server echoed back. Nothing here changes gameplay locally.
  type TuningRow = { tunable: Tunable; input: HTMLInputElement; text: HTMLElement; row: HTMLTableRowElement; defaultText: HTMLElement };
  const tuningRows: TuningRow[] = [];
  const formatValue = (tunable: Tunable, value: number): string =>
    tunable.step < 1 ? value.toFixed(2).replace(/\.?0+$/, '') : String(value);
  let lastGroup = '';
  for (const tunable of TUNABLES) {
    if (tunable.group !== lastGroup) {
      lastGroup = tunable.group;
      const heading = document.createElement('tr');
      const cell = document.createElement('th');
      cell.colSpan = 3;
      cell.textContent = tunable.group;
      heading.append(cell);
      tuningBody.append(heading);
    }
    const row = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = tunable.label;
    const value = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(tunable.min);
    input.max = String(tunable.max);
    input.step = String(tunable.step);
    input.setAttribute('aria-label', tunable.label);
    const text = document.createElement('span');
    value.append(input, text);
    const defaultText = document.createElement('td');
    defaultText.className = 'default';
    row.append(label, value, defaultText);
    tuningBody.append(row);
    tuningRows.push({ tunable, input, text, row, defaultText });
  }

  // The host's edit: every input clamped to its bounds, sent as one table. A typo that
  // leaves the bounds is corrected in place rather than silently dropped by the server.
  function sendTuning(): void {
    const tuning = defaultTuning();
    for (const { tunable, input } of tuningRows) {
      const raw = input.value.trim() === '' ? NaN : Number(input.value);
      const value = Number.isFinite(raw) ? Math.min(tunable.max, Math.max(tunable.min, raw)) : tunable.default;
      input.value = formatValue(tunable, value);
      tuning[tunable.key] = value;
    }
    send({ type: 'tune', tuning });
  }

  function renderTuning(tuning: Tuning, editable: boolean): void {
    let changed = 0;
    for (const { tunable, input, text, row, defaultText } of tuningRows) {
      const value = tuning[tunable.key];
      const isChanged = value !== tunable.default;
      if (isChanged) changed += 1;
      row.toggleAttribute('data-changed', isChanged);
      input.hidden = !editable;
      text.hidden = editable;
      // Never overwrite the number the host is in the middle of typing.
      if (document.activeElement !== input) input.value = formatValue(tunable, value);
      text.textContent = formatValue(tunable, value);
      defaultText.textContent = isChanged ? `default ${formatValue(tunable, tunable.default)}` : '';
    }
    tuningSummary.textContent = changed === 0 ? '(defaults)' : `(${changed} changed)`;
    tuningNote.textContent = editable
      ? 'Values apply to the next round. Everyone in the room sees them; the server checks and bounds every change.'
      : 'Set by the host between rounds. Changed values are marked *.';
    tuningReset.hidden = !editable;
  }

  function showOverlay(title: string, detail = ''): void {
    overlay.hidden = false;
    overlayTitle.textContent = title;
    overlayDetail.textContent = detail;
  }

  function resultText(result: Snapshot['result']): string {
    if (result === 'defeated') return 'Creature defeated. Hunters win.';
    if (result === 'expired') return 'Time expired. Creature wins.';
    return 'Every Hunter is down. Creature wins.';
  }

  // Whole seconds, rounded up so the clock only reads 0 when the round is actually over.
  const clockText = (seconds: number): string => {
    const total = Math.ceil(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  // One compact line per player, built from that client's own snapshot.
  function debugText(snapshot: Snapshot): string {
    const lines = [
      `time     ${snapshot.timeRemaining.toFixed(1)} s`,
      // The spawn countdown is deliberately not on the wire: knowing when the next battery
      // is due would let Hunters camp a point, so only the server log has it.
      `battery  ${snapshot.pickups.length === 0 ? 'none on the map' : `at point ${snapshot.pickups[0]}`}`,
      `hunters  ${snapshot.hunters.filter((hunter) => !hunter.down).length} active,` +
      ` ${snapshot.hunters.filter((hunter) => hunter.down).length} down`,
    ];
    for (const hunter of snapshot.hunters) {
      lines.push(
        `  ${hunter.id}     battery ${hunter.battery.toFixed(1)} ${flashlightStage(hunter.battery, room?.tuning ?? DEFAULT_TUNING)}` +
        `${hunter.light ? ' LIT' : ''} ${hunter.down ? `DOWN ${Math.floor(hunter.revive * 100)}%` : 'ACTIVE'}`,
      );
    }
    if (snapshot.role === 'hunter') {
      lines.push(`creature hp ${snapshot.creatureHp.toFixed(1)}, ${snapshot.creature ? 'revealed' : 'hidden'}`);
      lines.push(`proximity ${snapshot.proximity} (own band only)`);
    } else {
      lines.push(`creature hp ${snapshot.hp.toFixed(1)} ${snapshot.staggered ? 'STAGGERED' : ''} ${snapshot.burning ? 'BURNING' : ''}`);
      lines.push(
        `cooldowns sprint ${snapshot.sprintCooldown.toFixed(1)}` +
        ` stagger ${snapshot.staggerCooldown.toFixed(1)} attack ${snapshot.attackCooldown.toFixed(1)}` +
        ` burn ${snapshot.burnRemaining.toFixed(1)}`,
      );
    }
    return lines.join('\n');
  }

  // The whole page is derived from the connection, the room, and the latest snapshot.
  function updateUi(): void {
    const connected = socket.readyState === WebSocket.OPEN;
    const inRound = snapshot !== null;
    lobby.hidden = inRound;
    container.hidden = !inRound;
    menu.hidden = !connected || room !== null || closedReason !== null;
    createButton.disabled = joinButton.disabled = !connected;
    roomText.hidden = room === null;
    if (room) roomText.textContent = `Room: ${room.code}`;
    playersText.hidden = waitingText.hidden = room === null || inRound;
    if (room && !inRound) {
      playersText.textContent = `Players: ${room.players} / ${PLAYER_COUNT}`;
      waitingText.textContent = room.players < PLAYER_COUNT
        ? 'Waiting for players…'
        : room.host ? 'Everyone is here. Start the match.' : 'Everyone is here. Waiting for the host to start.';
    }
    startButton.hidden = !room?.host;
    startButton.disabled = !connected || !room || room.players < PLAYER_COUNT;
    startButton.textContent = snapshot && snapshot.roundState !== 'ended' ? 'Restart match' : 'Start match';

    // Map choice: a picker for the host between rounds, a label for everyone else. The
    // list and the current choice come from the room message; the map itself arrives
    // separately and is what the scene is built from.
    const betweenRounds = !snapshot || snapshot.roundState === 'ended';
    mapSelect.hidden = !room?.host || !betweenRounds;
    mapText.hidden = room === null || (room.host && betweenRounds);
    if (room) {
      if (mapSelect.options.length !== room.maps.length || [...mapSelect.options].some((option, index) => option.value !== room!.maps[index].id)) {
        mapSelect.replaceChildren(...room.maps.map((map) => new Option(map.name, map.id)));
      }
      mapSelect.value = room.mapId;
      mapText.textContent = `Map: ${room.maps.find((map) => map.id === room!.mapId)?.name ?? room.mapId}`;
    }
    // The tuning table follows the map picker's rule: between rounds only (the lobby and
    // the result screen), editable by the host, readable by everyone.
    tuningPanel.hidden = room === null || !betweenRounds;
    if (room) renderTuning(room.tuning, room.host);

    roleText.hidden = creatureHpText.hidden = creatureStateText.hidden = teamText.hidden = !inRound;
    timerText.hidden = !inRound;
    proximityText.hidden = batteryText.hidden = snapshot?.role !== 'hunter';
    debugPanel.hidden = !DEBUG || !inRound;
    overlay.hidden = true;
    warning.dataset.state = 'SAFE';

    if (closedReason) {
      statusText.textContent = closedReason;
    } else if (!snapshot) {
      statusText.textContent = !connected
        ? 'Connecting…'
        : !room
          ? (menuNotice ?? 'Create a room, or enter a room code to join one.')
          : room.notice === 'disconnected'
            ? 'A player disconnected, so the round was ended. Waiting for players…'
            : 'Share the room code. The host can start once five players are connected.';
    }
    if (!snapshot) return;

    // Compact team state, shared by both roles; the Hunter's own slot is marked.
    const self = snapshot.role === 'hunter' ? snapshot.self : null;
    teamText.textContent = snapshot.hunters
      .map((hunter) => `${hunter.id}${hunter.id === self ? '*' : ''} ${hunter.down ? `DOWN ${Math.floor(hunter.revive * 100)}%` : 'ACTIVE'}`)
      .join(' · ');

    // The authoritative clock, shown to both roles. The final stretch only changes colour.
    timerText.textContent = `Time: ${clockText(snapshot.timeRemaining)}`;
    timerText.dataset.state = snapshot.roundState === 'running' && snapshot.timeRemaining <= GAMEPLAY.round.finalWarningSeconds
      ? 'final' : 'normal';
    if (DEBUG) debugPanel.textContent = debugText(snapshot);

    if (snapshot.role === 'hunter') {
      roleText.textContent = `Role: Hunter ${snapshot.self} (white sphere)`;
      // `self` rather than `snapshot.self`: the snapshot is reassigned on every message,
      // so it does not stay narrowed inside a callback.
      const battery = snapshot.hunters.find((hunter) => hunter.id === self)?.battery ?? 0;
      const stage = flashlightStage(battery, room?.tuning ?? DEFAULT_TUNING);
      batteryText.textContent = `Battery: ${Math.ceil(battery)} ${stage}`;
      batteryText.dataset.state = stage;
      proximityText.textContent = `Proximity: ${snapshot.proximity}`;
      creatureHpText.textContent = `Creature HP: ${Math.ceil(snapshot.creatureHp)}`;
      const seen = snapshot.creature;
      const state = !seen ? 'HIDDEN'
        : seen.staggered ? 'STAGGERED'
          : seen.burning ? 'BURNING'
            : seen.sprinting ? 'SPRINTING' : 'REVEALED';
      creatureStateText.dataset.state = state;
      creatureStateText.textContent = `Creature: ${state === 'HIDDEN' ? 'hidden' : state}`;
      if (snapshot.roundState === 'running') warning.dataset.state = snapshot.proximity;
    } else {
      roleText.textContent = 'Role: Creature (orange octahedron)';
      creatureHpText.textContent = `HP: ${Math.ceil(snapshot.hp)}`;
      const state = snapshot.staggered ? 'STAGGERED'
        : snapshot.lit ? 'LIT'
          : snapshot.burning ? 'BURNING'
            : snapshot.sprinting ? 'SPRINTING'
              : snapshot.revealed ? 'REVEALED' : 'HIDDEN';
      creatureStateText.dataset.state = state;
      const cooldowns = [
        snapshot.burnRemaining > 0 ? ` · burning ${snapshot.burnRemaining.toFixed(1)} s` : '',
        snapshot.staggerCooldown > 0 ? ` · stagger cooldown ${snapshot.staggerCooldown.toFixed(1)} s` : '',
        snapshot.sprintCooldown > 0 ? ` · sprint cooldown ${snapshot.sprintCooldown.toFixed(1)} s` : '',
        snapshot.attackCooldown > 0 ? ` · attack cooldown ${snapshot.attackCooldown.toFixed(1)} s` : '',
      ].join('');
      creatureStateText.textContent = `State: ${state === 'HIDDEN' ? 'hidden' : state}${cooldowns}`;
    }

    const own = self === null ? undefined : snapshot.hunters.find((hunter) => hunter.id === self);
    switch (snapshot.roundState) {
      case 'reveal':
        if (snapshot.role === 'creature') showOverlay('YOU ARE THE CREATURE');
        else showOverlay('YOU ARE A HUNTER', snapshot.self);
        statusText.textContent = 'Roles are assigned. The round starts in a moment.';
        break;
      case 'running':
        if (own?.down) {
          showOverlay('INCAPACITATED', `REVIVE ${Math.floor(own.revive * 100)}%`);
          statusText.textContent = 'You are down. A teammate revives you by holding a flashlight on you.';
        } else if (snapshot.role === 'hunter') {
          // An empty flashlight is the one thing a Hunter has to be told in words: the
          // cone simply stops appearing, and only a pickup brings it back.
          statusText.textContent = (own?.battery ?? 0) > 0
            ? 'Find the Creature. Hold Space or the left mouse button for the flashlight: it drains battery, reveals and damages the Creature, and revives a downed teammate.'
            : 'Battery empty. Your flashlight does nothing until you walk over a green battery block.';
        } else {
          statusText.textContent = 'Touch Hunters to incapacitate them; down all four to win, or outlast the timer. Hold Space or the left mouse button to sprint: faster, but visible. Being lit staggers you, drains HP, and leaves you burning: you cannot incapacitate anyone while burning.';
        }
        break;
      case 'ended':
        statusText.textContent = `${resultText(snapshot.result)} ${room?.host ? 'Start the match to play again.' : 'Waiting for the host to start the next round.'}`;
        break;
    }
  }

  socket.addEventListener('open', () => {
    // A code in the URL is just a typed code: prefill it and join.
    const code = new URLSearchParams(location.search).get('room');
    if (code) {
      codeInput.value = code.trim().toUpperCase();
      joinRoom(code);
    }
    updateUi();
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === 'error') {
      if (message.reason === 'host-left') {
        closedReason = 'The host disconnected, so the room was closed. Reload this page to create or join a room.';
        room = null;
        snapshot = null;
        clearInput();
      } else {
        menuNotice = message.reason === 'full' ? 'That room is full.' : 'No room has that code.';
      }
      updateUi();
      return;
    }
    if (message.type === 'map') {
      loadMap(message.map);
      updateUi();
      return;
    }
    if (message.type === 'room') {
      room = message;
      snapshot = null;
      menuNotice = null;
      clearInput();
      updateUi();
      return;
    }
    const roundChanged = snapshot?.roundId !== message.roundId;
    snapshot = message;
    if (roundChanged || snapshot.roundState !== 'running') clearInput();
    updateUi();
  });

  socket.addEventListener('close', () => {
    clearInput();
    snapshot = null;
    closedReason ??= 'Disconnected. Reload this page to reconnect.';
    updateUi();
  });

  socket.addEventListener('error', () => {
    clearInput();
    snapshot = null;
    closedReason ??= 'Connection failed. Check that the server is running, then reload.';
    updateUi();
  });

  function handleKey(event: KeyboardEvent, pressed: boolean): void {
    // Typing a room code must never be read as movement.
    if (event.target instanceof HTMLInputElement) return;
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

  createButton.addEventListener('click', () => send({ type: 'create' }));
  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    joinRoom(codeInput.value);
  });
  tuningBody.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && room?.host) sendTuning();
  });
  tuningReset.addEventListener('click', () => {
    tuningReset.blur();
    if (room?.host) send({ type: 'tune', tuning: defaultTuning() });
  });
  mapSelect.addEventListener('change', () => {
    mapSelect.blur();
    send({ type: 'selectMap', id: mapSelect.value });
  });

  startButton.addEventListener('click', () => {
    if (startButton.disabled) return;
    // Drop focus so a later Space press works the action button instead of this button.
    startButton.blur();
    releaseInput();
    send({ type: 'start' });
  });

  // Held flags are refreshed so the server can stop a stalled client's input.
  const inputTimer = window.setInterval(sendInput, 100);

  function resizeArena(): void {
    if (!scene) return;
    const width = Math.max(1, Math.min(container.clientWidth, container.clientHeight * scene.aspect));
    const height = width / scene.aspect;
    arenaView.style.width = `${width}px`;
    arenaView.style.height = `${height}px`;
    scene.resize(width, height);
  }

  // Render the latest authoritative state; the client does not simulate movement or hits.
  let animationFrame = 0;
  function draw(): void {
    scene?.render(snapshot, room?.tuning ?? DEFAULT_TUNING);
    animationFrame = window.requestAnimationFrame(draw);
  }

  const resizeObserver = new ResizeObserver(resizeArena);
  resizeObserver.observe(container);
  resizeArena();
  draw();
  updateUi();

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    window.clearInterval(inputTimer);
    window.cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    scene?.dispose();
    socket.close();
  });
}

start();
