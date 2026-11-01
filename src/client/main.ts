import { flashlightStage } from '../shared/flashlight.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import { validateMap } from '../shared/map/validate.js';
import { buildWorld } from '../shared/map/world.js';
import type { ClientMessage, InputState, RoomMessage, ServerMessage } from '../shared/protocol.js';
import { DEFAULT_TUNING, TUNABLES, defaultTuning, type Tunable, type Tuning } from '../shared/tuning.js';
import {
  NIGHT, createScene, loadBatteryModel, loadCreatureModel, loadHunterModel, type BatteryModel, type CreatureModel, type HunterModel,
} from './scene.js';
import { VFX, type VfxKey } from './vfx.js';
import { loadPropModels, type PropModels } from './props.js';
import { loadSurfaceTextures, type SurfaceTextures } from './surface-meshes.js';
import {
  GUEST_LIST, TITLE, clockText, createHud, createResult, ransom, renderGuests, setRoomCode, setTiles,
} from './ui.js';
import { createTransition } from './transition.js';
import { debugRoom } from './debug-room.js'; // DEBUG-ROOM
import { mountDebugMenu } from './debug-menu.js'; // DEBUG-MENU
import './style.css';

const element = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const canvas = element<HTMLCanvasElement>('#arena');
const container = element('#arena-container');
const arenaView = element('#arena-view');
const lobby = element('#lobby');
const titleScreen = element('#title-screen');
const roomScreen = element('#room-screen');
const guestList = element('#guest-list');
const copyLinkButton = element<HTMLButtonElement>('#copy-link');
const leaveButton = element<HTMLButtonElement>('#leave-room');
const inviteLink = element<HTMLInputElement>('#invite-link');
const hudLayer = element('#hud-layer');
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
const startControls = element('#start-controls');
const menuRoom = element('#menu-room');
const mapSelect = element<HTMLSelectElement>('#map');
const vfxToggles = document.querySelectorAll<HTMLInputElement>('#vfx input');
const mapText = element('#map-name');
const tuningPanel = element<HTMLDetailsElement>('#tuning');
const tuningSummary = element('#tuning-summary');
const tuningNote = element('#tuning-note');
const tuningBody = element<HTMLTableSectionElement>('#tuning-table tbody');
const tuningReset = element<HTMLButtonElement>('#tuning-reset');

const PLAYER_COUNT = GAMEPLAY.players.hunters + 1;
// The designed sizes the screens and the HUD are laid out at (style.css), before scaling.
const STAGE = { width: 1440, height: 900 };
const HUD_WIDTH = 1440;
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
// ?debug=1&fear=x opens a page with the debug menu's fear preview on at x: a Hunter's fear effects
// without a Creature, x from 0 (SAFE) to 3 (as close as IMMEDIATE gets), e.g. 1.5 for halfway
// through DANGER (see fear.ts).
const fearParameter = new URLSearchParams(location.search).get('fear');
const FEAR_PREVIEW = DEBUG && fearParameter !== null && Number.isFinite(Number(fearParameter)) ? Number(fearParameter) : null;

// The screen wipe. The page opens covered and is revealed once the ransom faces have loaded (or
// after 1.5 s without them), so the title never shows in fallback fonts. Each wipe ends by
// redrawing the page (`settle`, set once the page is running), in case it changed screens again.
let settle = () => {};
const transition = createTransition(element<HTMLCanvasElement>('#transition'), () => settle());
Promise.race([document.fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 1500))]).then(() => transition.reveal());

function start(
  hunterModel: HunterModel, creatureModel: CreatureModel, batteryModel: BatteryModel, surfaceTextures: SurfaceTextures,
  propModels: PropModels,
): void {
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
      scene = createScene(
        canvas, buildWorld(result.map), hunterModel, creatureModel, batteryModel, surfaceTextures, propModels, renderer,
      );
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
  // Set by Leave until the next create or join: room messages the server sent before it saw the
  // leave are still on their way and must not put this page back in the room.
  let left = false;
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
    if (message.type === 'create' || message.type === 'join' || message.type === 'debugCreate') left = false;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  const debugMenu = mountDebugMenu(send, FEAR_PREVIEW); // DEBUG-MENU
  const hud = createHud();
  const result = createResult();
  // The result overlay comes first; the Gazette only once a player asks for it.
  let gazetteOpen = false;
  // The screen on show and the snapshot it is drawn from. When the state calls for another screen
  // these hold still while the wipe covers the window, and change behind it.
  let shownScreen: string | null = null;
  let shownSnapshot: Snapshot | null = null;
  setTiles(element('#game-title'), TITLE);
  setTiles(element('#guests-title'), [GUEST_LIST]);

  // In the lobby the host's start sits under the guest list; during a round the page shows only
  // the game, so it moves into the debug menu's Room section, keeping its id and listeners.
  const startHome = { parent: startControls.parentElement!, next: startControls.nextSibling };
  function placeRoomControls(inRound: boolean): void {
    const home = inRound ? menuRoom : startHome.parent;
    if (startControls.parentElement === home) return;
    if (inRound) home.append(startControls);
    else startHome.parent.insertBefore(startControls, startHome.next);
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

  // The title in cut-out letters, redrawn only when it changes. `dim` darkens the game behind it.
  function showOverlay(title: string, detail = '', dim = false): void {
    overlay.hidden = false;
    overlay.classList.toggle('reveal', dim);
    if (overlayTitle.dataset.text !== title) {
      overlayTitle.dataset.text = title;
      setTiles(overlayTitle, [ransom(title, 60)]);
    }
    overlayDetail.textContent = detail;
  }

  function resultText(result: Snapshot['result']): string {
    if (result === 'defeated') return 'Creature defeated. Hunters win.';
    if (result === 'expired') return 'Time expired. Creature wins.';
    return 'Every Hunter is down. Creature wins.';
  }

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
      lines.push(`proximity ${snapshot.proximity}, dread ${snapshot.dread}/${GAMEPLAY.proximity.dreadSteps} (own only)`);
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

  // Which screen the state calls for. A new round is a new screen, so Play again wipes too.
  function screenOf(): string {
    if (snapshot) return `${gazetteOpen ? 'gazette' : 'game'}:${snapshot.roundId}`;
    return room ? 'room' : 'title';
  }

  // The whole page is derived from the connection, the room, and the latest snapshot.
  function updateUi(): void {
    if (snapshot?.roundState !== 'ended') gazetteOpen = false;
    const screen = screenOf();
    shownScreen ??= screen;
    if (screen !== shownScreen) {
      transition.run(() => {
        shownScreen = screenOf();
        updateUi();
      });
      return;
    }
    shownSnapshot = snapshot;
    const connected = socket.readyState === WebSocket.OPEN;
    const inRound = snapshot !== null;
    // During a round (the reveal, the play and the result) the page is only the game, filling
    // the window; the host's start and the round's numbers are in the debug menu.
    document.body.classList.toggle('in-round', inRound);
    placeRoomControls(inRound);
    lobby.hidden = inRound;
    container.hidden = !inRound;
    // Outside a room: the title screen. In one: the invitation and the guest list.
    titleScreen.hidden = room !== null;
    roomScreen.hidden = room === null;
    menu.hidden = !connected || room !== null || closedReason !== null;
    createButton.disabled = joinButton.disabled = !connected;
    if (room) {
      setRoomCode(roomText, room.code);
      inviteLink.value = `${location.origin}${location.pathname}?room=${room.code}`;
      const guests = `${room.players}:${room.seat}`;
      if (guestList.dataset.guests !== guests) {
        guestList.dataset.guests = guests;
        renderGuests(guestList, room, PLAYER_COUNT);
      }
    }
    playersText.hidden = waitingText.hidden = room === null || inRound;
    if (room && !inRound) {
      playersText.textContent = `${room.players} / ${PLAYER_COUNT}`;
      waitingText.textContent = room.players < PLAYER_COUNT
        ? 'The evening begins when all five guests arrive.'
        : room.host ? 'Everyone has arrived. Begin the evening.' : 'Everyone has arrived. Waiting for the host to begin.';
      // DEBUG-ROOM
      if (debugRoom.active) waitingText.textContent = 'Debug room: start any time. Empty slots are dummies that stand still.';
    }
    startButton.hidden = !room?.host;
    startButton.disabled = !connected || !room || (room.players < PLAYER_COUNT && !debugRoom.active); // DEBUG-ROOM: the debugRoom check
    debugRoom.update(createButton.disabled, startButton.hidden); // DEBUG-ROOM
    startButton.textContent = !snapshot ? 'Begin the evening' : snapshot.roundState === 'ended' ? 'Play again' : 'Restart match';

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
      mapText.textContent = room.maps.find((map) => map.id === room!.mapId)?.name ?? room.mapId;
    }
    // The tuning table (in the debug menu) follows the map picker's rule: between rounds only
    // (the lobby and the result), editable by the host, readable by everyone.
    tuningPanel.hidden = room === null || !betweenRounds;
    if (room) renderTuning(room.tuning, room.host);

    roleText.hidden = creatureHpText.hidden = creatureStateText.hidden = teamText.hidden = !inRound;
    timerText.hidden = !inRound;
    proximityText.hidden = batteryText.hidden = snapshot?.role !== 'hunter';
    debugPanel.hidden = !inRound;
    debugMenu.update({ host: room?.host ?? false, running: snapshot?.roundState === 'running' }); // DEBUG-MENU
    overlay.hidden = true;
    result.update(snapshot, room, gazetteOpen);

    // The status line carries only what the screens do not already say.
    if (closedReason) {
      statusText.textContent = closedReason;
    } else if (!snapshot) {
      statusText.textContent = !connected
        ? 'Connecting…'
        : !room
          ? (menuNotice ?? '')
          : room.notice === 'disconnected'
            ? 'A player disconnected, so the round was ended. Waiting for players…'
            : '';
    }
    if (!snapshot) return;
    hud.update(snapshot, room?.tuning ?? DEFAULT_TUNING);

    // Compact team state, shared by both roles; the Hunter's own slot is marked.
    const self = snapshot.role === 'hunter' ? snapshot.self : null;
    teamText.textContent = snapshot.hunters
      .map((hunter) => `${hunter.id}${hunter.id === self ? '*' : ''} ${hunter.down ? `DOWN ${Math.floor(hunter.revive * 100)}%` : 'ACTIVE'}`)
      .join(' · ');

    // The authoritative clock, shown to both roles. The final stretch only changes colour.
    timerText.textContent = `Time: ${clockText(snapshot.timeRemaining)}`;
    timerText.dataset.state = snapshot.roundState === 'running' && snapshot.timeRemaining <= GAMEPLAY.round.finalWarningSeconds
      ? 'final' : 'normal';
    debugPanel.textContent = debugText(snapshot);

    if (snapshot.role === 'hunter') {
      roleText.textContent = `Role: Hunter ${snapshot.self} (white)`;
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
    } else {
      roleText.textContent = 'Role: Creature (hooded wraith)';
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
        if (snapshot.role === 'creature') showOverlay('YOU ARE THE CREATURE', '', true);
        else showOverlay('YOU ARE A HUNTER', snapshot.self, true);
        statusText.textContent = 'Roles are assigned. The round starts in a moment.';
        break;
      case 'running':
        // While a catch cutscene plays, the game itself is the message: no overlay.
        if (snapshot.catch) {
          statusText.textContent = '';
        } else if (own?.down) {
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
      case 'ended': {
        // The result view (ui.ts) is over the game; the status line keeps the same words.
        const next = room?.host ? 'Play again to start the next round.' : 'Waiting for the host to start the next round.';
        statusText.textContent = `${resultText(snapshot.result)} ${next}`;
        break;
      }
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
        closedReason = 'The host left, so the room was closed. Reload this page to create or join a room.';
        room = null;
        snapshot = null;
        clearInput();
      } else {
        menuNotice = message.reason === 'full' ? 'That room is full.' : 'No room has that code.';
      }
      updateUi();
      return;
    }
    if (left) return;
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
    // Typing a room code, or working a debug menu control, must never be read as movement.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
      || event.target instanceof HTMLTextAreaElement) return;
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
  // VFX toggles, remembered in this browser only. Each one is blurred after a click so
  // Space goes back to working the action button.
  try {
    const saved = JSON.parse(localStorage.getItem('vfx') ?? '{}') as Record<string, unknown>;
    for (const key of Object.keys(VFX) as VfxKey[]) {
      if (typeof saved[key] === 'boolean') VFX[key] = saved[key];
    }
  } catch {
    // No storage or a bad value: keep the defaults.
  }
  for (const toggle of vfxToggles) {
    const key = toggle.dataset.vfx as VfxKey;
    toggle.checked = VFX[key];
    toggle.addEventListener('change', () => {
      VFX[key] = toggle.checked;
      toggle.blur();
      try {
        localStorage.setItem('vfx', JSON.stringify(VFX));
      } catch {
        // Storage unavailable: the toggle still applies for this page.
      }
    });
  }
  mapSelect.addEventListener('change', () => {
    mapSelect.blur();
    send({ type: 'selectMap', id: mapSelect.value });
  });

  // The host's start: Begin the evening in the room, Play again on the result, and the debug
  // menu's restart. Each drops focus so a later Space press works the action button instead.
  function startRound(button: HTMLButtonElement): void {
    button.blur();
    if (startButton.disabled) return;
    releaseInput();
    send(debugRoom.active ? debugRoom.startMessage() : { type: 'start' }); // DEBUG-ROOM: was send({ type: 'start' })
  }
  startButton.addEventListener('click', () => startRound(startButton));
  for (const button of document.querySelectorAll<HTMLButtonElement>('.play-again')) {
    button.addEventListener('click', () => startRound(button));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.to-lobby')) {
    button.addEventListener('click', () => {
      button.blur();
      if (room?.host) send({ type: 'lobby' });
    });
  }
  for (const [selector, open] of [['#read-gazette', true], ['#close-gazette', false]] as const) {
    element<HTMLButtonElement>(selector).addEventListener('click', (event) => {
      (event.currentTarget as HTMLButtonElement).blur();
      gazetteOpen = open;
      updateUi();
    });
  }
  // The clipboard needs a secure page (https, or this machine's own address); elsewhere the link
  // is shown to copy by hand.
  copyLinkButton.addEventListener('click', () => {
    copyLinkButton.blur();
    const shown = () => {
      inviteLink.hidden = false;
      inviteLink.select();
    };
    if (!navigator.clipboard) return shown();
    navigator.clipboard.writeText(inviteLink.value).then(() => {
      copyLinkButton.textContent = 'Copied';
      window.setTimeout(() => { copyLinkButton.textContent = 'Copy invitation link'; }, 1500);
    }, shown);
  });
  // Leave: back to the title screen on the same connection. The room code comes off the URL so a
  // reload doesn't join again.
  leaveButton.addEventListener('click', () => {
    leaveButton.blur();
    if (!room) return;
    send({ type: 'leave' });
    left = true;
    room = null;
    snapshot = null;
    debugRoom.active = false; // DEBUG-ROOM
    inviteLink.hidden = true;
    clearInput();
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    updateUi();
  });
  debugRoom.mount(send, updateUi); // DEBUG-ROOM

  // Held flags are refreshed so the server can stop a stalled client's input.
  const inputTimer = window.setInterval(sendInput, 100);

  function resizeArena(): void {
    if (!scene) return;
    const width = Math.max(1, Math.min(container.clientWidth, container.clientHeight * scene.aspect));
    const height = width / scene.aspect;
    arenaView.style.width = `${width}px`;
    arenaView.style.height = `${height}px`;
    // The HUD is laid out 1440 wide, as tall as the arena's shape, and scaled onto it.
    hudLayer.style.setProperty('--hud-scale', String(width / HUD_WIDTH));
    hudLayer.style.setProperty('--hud-height', `${HUD_WIDTH / scene.aspect}px`);
    scene.resize(width, height);
  }

  // The full screens (title, room, Gazette) are a 1440 × 900 stage fitted to the window.
  function fitStage(): void {
    const scale = Math.min(window.innerWidth / STAGE.width, window.innerHeight / STAGE.height);
    document.documentElement.style.setProperty('--stage-scale', String(scale));
  }
  window.addEventListener('resize', fitStage);
  fitStage();

  // Render the latest authoritative state; the client does not simulate movement or hits.
  let animationFrame = 0;
  let letterbox = '';
  function draw(): void {
    scene?.render(shownSnapshot, room?.tuning ?? DEFAULT_TUNING, debugMenu.fearPreview); // DEBUG-MENU: was FEAR_PREVIEW
    if (scene) debugMenu.frame(scene.renderer); // DEBUG-MENU
    // The letterbox round the game matches the night beyond the map.
    if (letterbox !== NIGHT.BACKGROUND_COLOR) container.style.background = letterbox = NIGHT.BACKGROUND_COLOR;
    animationFrame = window.requestAnimationFrame(draw);
  }

  settle = updateUi;
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

// Every model and surface texture is needed by every scene, so they are loaded before
// anything connects.
Promise.all([loadHunterModel(), loadCreatureModel(), loadBatteryModel(), loadSurfaceTextures(), loadPropModels()]).then(
  ([hunterModel, creatureModel, batteryModel, surfaceTextures, propModels]) =>
    start(hunterModel, creatureModel, batteryModel, surfaceTextures, propModels), () => {
  statusText.textContent = 'Could not load the game models. Reload the page to try again.';
});
