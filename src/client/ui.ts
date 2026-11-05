// The page's look: ransom-note lettering cut from magazine faces, the in-round HUD, the room's
// guest list, and the two result views (an overlay over the game and the fullscreen Gazette).
// Everything here only draws what main.ts hands it; no rule or state lives in this module.
import { flashlightStage } from '../shared/flashlight.js';
import { GAMEPLAY } from '../shared/gameplay-config.js';
import type { HunterId, RoomMessage, RoundResult, ServerMessage } from '../shared/protocol.js';
import type { Tuning } from '../shared/tuning.js';
import { TRANSITION } from './transition.js';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;

const element = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

// Calls `done` when every finite CSS animation now on `target` or inside it has ended, so the timings
// live only in style.css. With reduced motion there are none, and `done` runs at once. The cut-out
// letters' endless jitter does not count.
function afterAnimations(target: HTMLElement, done: () => void): void {
  const finite = target.getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
  void Promise.allSettled(finite.map((animation) => animation.finished)).then(done);
}

// Paper colours as [background, letter]. The palette is the masquerade's: cream card, ink,
// wine, mustard, teal, pink, powder blue and orange.
const SWATCH = {
  cream: ['#efe6d2', '#1b1720'],
  creamRed: ['#efe6d2', '#7a1828'],
  ink: ['#1d1822', '#efe6d2'],
  inkGold: ['#1d1822', '#e5b84a'],
  inkPink: ['#1d1822', '#e0568f'],
  wine: ['#8a1f2e', '#f4ead6'],
  gold: ['#e5b84a', '#2a1a10'],
  teal: ['#1f6f73', '#f4ead6'],
  pink: ['#e0568f', '#1b1720'],
  powder: ['#93b6d6', '#1b1720'],
  orange: ['#d9662e', '#1b1720'],
} as const;
type Swatch = keyof typeof SWATCH;
// Each face is a class in style.css (family, weight and style).
type Face = 'abril' | 'alfa' | 'bodoni' | 'playfair' | 'rye' | 'bungee' | 'fraktur';

// One cut-out letter: its text, paper, face, size in stage pixels, and tilt in degrees. `null`
// is the space between two words.
export type Tile = [text: string, swatch: Swatch, face: Face, size: number, turn: number] | null;

// Torn edges, taken in turn so neighbouring letters never share an outline.
const CLIPS = [
  'polygon(3% 0,100% 5%,96% 100%,0 94%)',
  'polygon(0 6%,97% 0,100% 95%,4% 100%)',
  'polygon(2% 3%,100% 0,98% 97%,0 100%)',
  'polygon(0 0,100% 4%,97% 96%,3% 100%)',
];

// For a title on light paper: the light cut-outs become dark and the dark ones light.
const ON_LIGHT: Partial<Record<Swatch, Swatch>> = { cream: 'ink', ink: 'cream', creamRed: 'wine', inkGold: 'gold' };

// Cut-out letters for one line. The word gaps hold a real space, so the line's text still reads
// as words (to screen readers, and to anything reading textContent). `first` numbers the line's
// first letter (--tile), which sets where each letter starts in the jitter (style.css).
export function tiles(line: Tile[], { scale = 1, light = false } = {}, first = 0): HTMLElement {
  const row = document.createElement('span');
  row.className = 'tiles';
  line.forEach((tile, index) => {
    const cut = document.createElement('span');
    if (tile === null) {
      cut.className = 'tile-gap';
      cut.textContent = ' ';
    } else {
      const [text, swatch, face, size, turn] = tile;
      const [paper, ink] = SWATCH[(light && ON_LIGHT[swatch]) || swatch];
      cut.className = `tile f-${face}`;
      cut.textContent = text;
      cut.style.cssText = `background:${paper};color:${ink};font-size:${Math.round(size * scale)}px;` +
        `transform:rotate(${turn}deg);clip-path:${CLIPS[index % CLIPS.length]};--tile:${first + index}`;
    }
    row.append(cut);
  });
  return row;
}

// A title of several lines, replacing whatever the element held. Letters are numbered across the
// lines, so a second line doesn't jitter in step with the first.
export function setTiles(target: HTMLElement, lines: Tile[][], options: { scale?: number; light?: boolean } = {}): void {
  let first = 0;
  target.replaceChildren(...lines.map((line) => {
    const row = tiles(line, options, first);
    first += line.length;
    return row;
  }));
}

// Any text as cut-outs, for messages with no hand-set title: papers, faces, sizes and tilts are
// taken in turn, so the same text always looks the same. No blackletter here: its capitals are
// hard to read in words nobody chose the letters for.
const ROTATION: [Swatch, Face][] = [
  ['cream', 'abril'], ['wine', 'bodoni'], ['gold', 'alfa'], ['teal', 'playfair'], ['ink', 'rye'],
  ['pink', 'alfa'], ['powder', 'bungee'], ['creamRed', 'playfair'], ['orange', 'abril'], ['inkGold', 'bodoni'],
];
const TURNS = [-4, 3, -2, 4, -3, 2, -1, 3];
const SIZES = [1, 0.86, 0.94, 1.08, 0.82, 0.98];
export function ransom(text: string, size: number): Tile[] {
  let letter = 0;
  return [...text].map((character): Tile => {
    if (character === ' ') return null;
    const [swatch, face] = ROTATION[letter % ROTATION.length];
    const tile: Tile = [character, swatch, face, size * SIZES[letter % SIZES.length], TURNS[letter % TURNS.length]];
    letter += 1;
    return tile;
  });
}

// The hand-set titles, as laid out on the design canvas.
export const TITLE: Tile[][] = [
  [['M', 'cream', 'abril', 104, -4], ['i', 'wine', 'playfair', 88, 3], ['D', 'gold', 'alfa', 84, -2], ['N', 'teal', 'bodoni', 92, 4],
    ['I', 'pink', 'rye', 80, -3], ['g', 'creamRed', 'fraktur', 100, 2], ['H', 'powder', 'bungee', 78, -1], ['T', 'orange', 'abril', 96, 3]],
  [['M', 'inkGold', 'fraktur', 76, 2], ['a', 'cream', 'alfa', 60, -3], ['S', 'wine', 'bodoni', 66, 2], ['q', 'gold', 'playfair', 70, -4],
    ['U', 'powder', 'rye', 58, 3], ['E', 'ink', 'abril', 68, -2], ['R', 'pink', 'bungee', 54, 4], ['A', 'creamRed', 'bodoni', 64, -2],
    ['d', 'teal', 'fraktur', 74, 3], ['E', 'orange', 'alfa', 62, -3]],
];
export const GUEST_LIST: Tile[] = [
  ['G', 'creamRed', 'fraktur', 38, -3], ['u', 'gold', 'alfa', 28, 3], ['e', 'teal', 'playfair', 32, -2], ['S', 'pink', 'bungee', 26, 2],
  ['T', 'ink', 'rye', 30, -4], null, ['L', 'powder', 'abril', 34, 3], ['i', 'wine', 'bodoni', 30, -1], ['s', 'orange', 'alfa', 28, 4],
  ['t', 'cream', 'playfair', 32, -2],
];
const THE_GUESTS: Tile[] = [
  ['T', 'creamRed', 'fraktur', 28, -4], ['h', 'gold', 'alfa', 20, 3], ['e', 'teal', 'playfair', 22, -2], null,
  ['G', 'pink', 'abril', 24, 2], ['U', 'cream', 'bungee', 18, -3], ['E', 'wine', 'bodoni', 22, 4], ['S', 'powder', 'rye', 20, -1],
  ['T', 'orange', 'abril', 24, 3], ['S', 'ink', 'alfa', 20, -4],
];
const THE_CREATURE: Tile[] = [
  ['T', 'ink', 'rye', 20, -3], ['h', 'cream', 'bodoni', 22, 2], ['e', 'pink', 'playfair', 22, -2], null,
  ['C', 'wine', 'fraktur', 28, 3], ['r', 'gold', 'alfa', 20, -4], ['E', 'powder', 'bungee', 18, 2], ['A', 'teal', 'abril', 24, -1],
  ['T', 'creamRed', 'rye', 20, 4], ['u', 'orange', 'playfair', 24, -3], ['R', 'inkGold', 'bodoni', 22, 2], ['E', 'pink', 'alfa', 20, -2],
];
const CREATURE_WINS: Tile[][] = [
  [['T', 'cream', 'rye', 58, -4], ['H', 'wine', 'bodoni', 54, 3], ['e', 'gold', 'playfair', 58, -2]],
  [['C', 'wine', 'fraktur', 104, -3], ['R', 'cream', 'abril', 88, 2], ['E', 'teal', 'bungee', 76, -1], ['A', 'pink', 'alfa', 86, 4],
    ['T', 'ink', 'rye', 80, -3], ['u', 'powder', 'playfair', 90, 2], ['R', 'gold', 'bodoni', 84, -2], ['e', 'creamRed', 'fraktur', 96, 3]],
  [['W', 'orange', 'abril', 72, 2], ['I', 'inkGold', 'alfa', 64, -3], ['N', 'cream', 'bodoni', 70, 1], ['s', 'wine', 'playfair', 72, -4]],
];
const HUNTERS_WIN: Tile[][] = [
  [['T', 'cream', 'rye', 58, -4], ['H', 'teal', 'bodoni', 54, 3], ['e', 'gold', 'playfair', 58, -2]],
  [['H', 'gold', 'abril', 100, -3], ['u', 'cream', 'playfair', 88, 2], ['N', 'powder', 'bungee', 76, -1], ['T', 'ink', 'rye', 82, 4],
    ['E', 'pink', 'alfa', 84, -3], ['r', 'teal', 'fraktur', 96, 2], ['S', 'cream', 'bodoni', 86, -2]],
  [['W', 'gold', 'abril', 72, 2], ['I', 'ink', 'alfa', 64, -3], ['N', 'powder', 'bodoni', 70, 1]],
];

// The room code on the invitation, one paper per character.
const CODE_TILES: [Swatch, Face, number, number][] = [
  ['ink', 'abril', 84, -4], ['pink', 'alfa', 78, 3], ['teal', 'bodoni', 86, -2], ['gold', 'rye', 76, 4],
];
export function setRoomCode(target: HTMLElement, code: string): void {
  if (target.textContent === code) return;
  setTiles(target, [[...code].map((character, index): Tile => {
    const [swatch, face, size, turn] = CODE_TILES[index % CODE_TILES.length];
    return [character, swatch, face, size, turn];
  })]);
}

// The guest list: the seats filled so far in join order (the host is always the first), this
// player's own seat in cream, and the empty seats still to fill.
export function renderGuests(list: HTMLElement, room: RoomMessage, seats: number): void {
  const rows: HTMLLIElement[] = [];
  for (let seat = 0; seat < seats; seat++) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'guest-name';
    const state = document.createElement('span');
    state.className = 'guest-state';
    if (seat < room.players) {
      const you = seat === room.seat;
      row.className = you ? 'guest you' : 'guest';
      name.textContent = `Guest ${seat + 1}`;
      state.textContent = [seat === 0 ? 'HOST' : '', you ? 'YOU' : ''].filter(Boolean).join(' · ') || 'ARRIVED';
      row.append(maskIcon('mask'), name, state);
    } else {
      row.className = 'guest empty';
      name.textContent = 'An empty slot…';
      state.textContent = 'WAITING';
      row.append(maskIcon('mask-outline'), name, state);
    }
    rows.push(row);
  }
  list.replaceChildren(...rows);
}

function maskIcon(symbol: 'mask' | 'mask-down' | 'mask-outline'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${symbol}`);
  svg.setAttribute('viewBox', '0 0 48 26');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

// Whole seconds as m:ss, rounded up so the clock only reads 0:00 when the time is really gone.
export const clockText = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// The clock's papers by position from the right (ones, tens, colon, minutes, tens of minutes),
// with the final stretch in wine and pink.
const CLOCK_TILES: Record<'normal' | 'final', [Swatch, Face, number, number][]> = {
  normal: [['powder', 'bodoni', 66, -2], ['gold', 'alfa', 60, 3], ['inkGold', 'rye', 48, 2], ['cream', 'abril', 64, -4], ['teal', 'bungee', 58, 3]],
  final: [['wine', 'bodoni', 66, -2], ['pink', 'alfa', 60, 3], ['inkPink', 'rye', 48, 2], ['wine', 'abril', 64, -4], ['pink', 'bungee', 58, 3]],
};

export function createHud() {
  const hud = element('#game-hud');
  const teamCards = element('#team-cards');
  const clock = element('#clock');
  const clockWatch = element('#clock-watch');
  const clockWarning = element('#clock-warning');
  const hpFill = element('#hp-fill');
  const hpBar = element('#hp-bar');
  const hpNumber = element('#hp-number');
  const creatureTag = element('#creature-tag');
  const creatureNote = element('#creature-note');
  const batterySection = element('#hud-battery');
  const batteryFill = element('#battery-fill');
  const batteryMarks = element('#battery-marks');
  const batteryIcon = element('#battery-icon');
  const batteryNumber = element('#battery-number');
  const batteryStage = element('#battery-stage');
  setTiles(element('#team-title'), [THE_GUESTS]);
  setTiles(element('#creature-title'), [THE_CREATURE]);

  // One card per Hunter, made once and restyled from each snapshot.
  const cards = new Map<HunterId, { card: HTMLElement; name: HTMLElement; state: HTMLElement; bar: HTMLElement; fill: HTMLElement; icon: SVGSVGElement }>();
  for (const id of ['H1', 'H2', 'H3', 'H4'] as const) {
    const card = document.createElement('div');
    card.className = 'team-card';
    const text = document.createElement('div');
    text.className = 'team-text';
    const name = document.createElement('span');
    name.className = 'team-name';
    const state = document.createElement('span');
    state.className = 'team-state';
    const bar = document.createElement('div');
    bar.className = 'revive-bar';
    bar.setAttribute('role', 'img');
    const fill = document.createElement('div');
    bar.append(fill);
    text.append(name, state, bar);
    const icon = maskIcon('mask');
    card.append(icon, text);
    teamCards.append(card);
    cards.set(id, { card, name, state, bar, fill, icon });
  }

  let clockShown = '';
  let hudEnded: boolean | null = null;
  return {
    update(snapshot: Snapshot, tuning: Tuning): void {
      // The result has its own view; the HUD fades aside as it comes in.
      const ended = snapshot.roundState === 'ended';
      if (ended !== hudEnded) {
        hudEnded = ended;
        hud.classList.toggle('leaving', ended);
        if (ended) {
          afterAnimations(hud, () => {
            if (hudEnded) hud.hidden = true;
          });
        } else {
          hud.hidden = false;
        }
      }
      const self = snapshot.role === 'hunter' ? snapshot.self : null;

      for (const hunter of snapshot.hunters) {
        const { card, name, state, bar, fill, icon } = cards.get(hunter.id)!;
        const percent = Math.floor(hunter.revive * 100);
        card.classList.toggle('you', hunter.id === self);
        card.classList.toggle('down', hunter.down);
        name.textContent = hunter.id === self ? `${hunter.id} · YOU` : hunter.id;
        state.textContent = hunter.down ? `DOWN · ${percent}%` : 'ACTIVE';
        bar.hidden = !hunter.down;
        bar.setAttribute('aria-label', `Revive progress ${percent} percent`);
        fill.style.width = `${percent}%`;
        icon.querySelector('use')!.setAttribute('href', hunter.down ? '#mask-down' : '#mask');
      }

      const final = snapshot.roundState === 'running' && snapshot.timeRemaining <= GAMEPLAY.round.finalWarningSeconds;
      const shown = `${clockText(snapshot.timeRemaining)}${final ? '!' : ''}`;
      if (shown !== clockShown) {
        clockShown = shown;
        const text = clockText(snapshot.timeRemaining);
        const styles = CLOCK_TILES[final ? 'final' : 'normal'];
        setTiles(clock, [[...text].map((character, index): Tile => {
          const [swatch, face, size, turn] = styles[Math.min(text.length - 1 - index, styles.length - 1)];
          return [character, swatch, face, size, turn];
        })]);
        clock.setAttribute('aria-label', `${text} left`);
        clockWatch.classList.toggle('final', final);
        clockWarning.hidden = !final;
      }

      // The Creature's health and condition: what the Hunters see of it, or its own.
      const hp = snapshot.role === 'hunter' ? snapshot.creatureHp : snapshot.hp;
      const hpPercent = Math.max(0, Math.min(100, (hp / tuning.creatureMaxHp) * 100));
      hpFill.style.width = `${hpPercent}%`;
      hpNumber.textContent = String(Math.ceil(hp));
      hpBar.setAttribute('aria-label', `Creature health ${Math.ceil(hp)} of ${tuning.creatureMaxHp}`);
      let tag: string;
      let tone: string;
      let note = '';
      if (snapshot.role === 'hunter') {
        const seen = snapshot.creature;
        [tag, tone] = !seen ? ['UNSEEN', 'quiet']
          : seen.staggered ? ['STAGGERED', 'gold']
            : seen.burning ? ['BURNING · CAN\'T CATCH YOU', 'orange']
              : seen.sprinting ? ['SPRINTING · SEEN', 'pink'] : ['REVEALED', 'powder'];
      } else {
        [tag, tone] = snapshot.staggered ? ['STAGGERED', 'gold']
          : snapshot.lit ? ['IN THE LIGHT', 'gold']
            : snapshot.burning ? ['BURNING · CAN\'T CATCH', 'orange']
              : snapshot.sprinting ? ['SPRINTING · SEEN', 'pink']
                : snapshot.revealed ? ['SEEN', 'powder'] : ['HIDDEN', 'quiet'];
        note = [
          snapshot.attackCooldown > 0 ? `CATCH IN ${snapshot.attackCooldown.toFixed(1)} S` : '',
          snapshot.sprintCooldown > 0 ? `SPRINT IN ${snapshot.sprintCooldown.toFixed(1)} S` : '',
        ].filter(Boolean).join(' · ');
      }
      creatureTag.textContent = tag;
      creatureTag.dataset.tone = tone;
      creatureNote.textContent = note;
      creatureNote.hidden = note === '';

      // The battery is the Hunter's alone.
      batterySection.hidden = snapshot.role !== 'hunter';
      if (snapshot.role === 'hunter') {
        const battery = snapshot.hunters.find((hunter) => hunter.id === self)?.battery ?? 0;
        const stage = flashlightStage(battery, tuning);
        const percent = Math.max(0, Math.min(100, (battery / tuning.batteryMax) * 100));
        batteryFill.style.width = `${percent}%`;
        batterySection.dataset.stage = stage;
        batteryNumber.textContent = String(Math.ceil(percent));
        batteryStage.textContent = stage;
        batteryIcon.setAttribute('aria-label', `Battery ${Math.ceil(percent)} percent, ${stage}`);
        // The dashes mark where the beam steps down: FULL to HALF, HALF to LOW.
        const marks = [tuning.fullBatteryFraction, tuning.halfBatteryFraction].map((fraction) => `${fraction * 100}%`).join();
        if (batteryMarks.dataset.marks !== marks) {
          batteryMarks.dataset.marks = marks;
          batteryMarks.replaceChildren(...[tuning.fullBatteryFraction, tuning.halfBatteryFraction].map((fraction) => {
            const mark = document.createElement('span');
            mark.style.left = `${fraction * 100}%`;
            return mark;
          }));
        }
      }
    },
  };
}

// The private role reveal: the letters are pasted on as the wipe that opened the round clears, and
// fall away when the round goes live. The fall never holds up play: the overlay takes no input.
export function createRoleReveal() {
  const overlay = element('#overlay');
  const title = element('#overlay-title');
  const detail = element('#overlay-detail');
  // The wipe clears left to right, reaching the title about now.
  overlay.style.setProperty('--enter-delay', `${TRANSITION.HOLD_SECONDS + TRANSITION.REVEAL_SECONDS * 0.6}s`);
  let round: Snapshot['roundId'] | null = null;

  return {
    update(snapshot: Snapshot | null): void {
      if (snapshot?.roundState === 'reveal') {
        if (snapshot.roundId === round) return;
        round = snapshot.roundId;
        setTiles(title, [ransom(snapshot.role === 'creature' ? 'YOU ARE THE CREATURE' : 'YOU ARE A HUNTER', 60)]);
        detail.textContent = snapshot.role === 'creature' ? '' : snapshot.self;
        // Taken off and put back with a style flush between, so a restart mid-reveal plays it again.
        overlay.classList.remove('entering', 'leaving');
        overlay.hidden = false;
        void overlay.offsetWidth;
        overlay.classList.add('entering');
        return;
      }
      if (round === null) return;
      const goingLive = snapshot?.roundId === round && snapshot.roundState === 'running';
      round = null;
      overlay.classList.remove('entering');
      if (!goingLive) {
        overlay.hidden = true;
        return;
      }
      overlay.classList.add('leaving');
      afterAnimations(overlay, () => {
        if (round !== null) return;
        overlay.hidden = true;
        overlay.classList.remove('leaving');
      });
    },
  };
}

// The words that go with each result, on the overlay and in the Gazette.
const REASON: Record<RoundResult, string> = {
  caught: 'Every Hunter is down.',
  expired: 'The clock struck midnight with the Creature still at large.',
  defeated: 'The Creature has been exorcised.',
};
const HEADLINE: Record<RoundResult, string> = {
  caught: 'Guests vanish from the masquerade',
  expired: 'Creature outlasts the evening',
  defeated: 'Creature unmasked at the midnight ball',
};

function statList(target: HTMLElement, entries: [string, string][]): void {
  target.replaceChildren(...entries.map(([label, value]) => {
    const entry = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    entry.append(term, detail);
    return entry;
  }));
}

// The result: first the overlay over the stilled game, then, on request, the fullscreen Gazette.
// The host gets Play again and Back to the lobby in both; everyone else is told to wait.
export function createResult() {
  const overlay = element('#result');
  const overlayTitle = element('#result-title');
  const overlayReason = element('#result-reason');
  const overlayStats = element('#result-stats');
  const gazette = element('#gazette');
  const gazetteTitle = element('#gazette-title');
  const gazetteReason = element('#gazette-reason');
  const gazetteHeadline = element('#gazette-headline');
  const gazetteStats = element('#gazette-stats');
  const gazetteFlashlight = element('#gazette-flashlight');
  let drawn = '';

  return {
    update(snapshot: Snapshot | null, room: RoomMessage | null, showGazette: boolean): void {
      const ended = snapshot?.roundState === 'ended' && snapshot.result !== null;
      overlay.hidden = !ended || showGazette;
      // A browser restarts an animation when its element is shown again, and coming back from the
      // Gazette is already a wipe: the entrance plays once per result.
      if (overlay.hidden) overlay.classList.remove('entering');
      gazette.hidden = !ended || !showGazette;
      for (const host of document.querySelectorAll<HTMLElement>('.result-host')) host.hidden = !room?.host;
      for (const wait of document.querySelectorAll<HTMLElement>('.result-wait')) wait.hidden = room?.host ?? false;
      if (!ended || !snapshot.result) return;
      // Drawn once per round's result: the numbers do not change after the end.
      const key = `${snapshot.roundId}:${snapshot.result}`;
      if (key === drawn) return;
      drawn = key;

      const result = snapshot.result;
      const creatureWon = result !== 'defeated';
      const hp = Math.ceil(snapshot.role === 'hunter' ? snapshot.creatureHp : snapshot.hp);
      const played = Math.max(0, (room?.tuning.matchSeconds ?? snapshot.timeRemaining) - snapshot.timeRemaining);
      const stats = snapshot.stats ?? { caught: 0, revived: 0, batteries: 0, lit: 0, flashlight: { H1: 0, H2: 0, H3: 0, H4: 0 } };

      setTiles(overlayTitle, creatureWon ? CREATURE_WINS : HUNTERS_WIN);
      overlayTitle.setAttribute('aria-label', creatureWon ? 'The Creature wins' : 'The Hunters win');
      overlayReason.textContent = REASON[result];
      overlayReason.style.setProperty('--chars', String(REASON[result].length));
      statList(overlayStats, [
        ['ROUND', clockText(played)], ['CREATURE HP', String(hp)], ['CAUGHT', String(stats.caught)],
        ['REVIVED', String(stats.revived)], ['BATTERIES', String(stats.batteries)],
      ]);

      gazette.dataset.winner = creatureWon ? 'creature' : 'hunters';
      setTiles(gazetteTitle, creatureWon ? CREATURE_WINS : HUNTERS_WIN, { scale: 1.12, light: !creatureWon });
      gazetteTitle.setAttribute('aria-label', creatureWon ? 'The Creature wins' : 'The Hunters win');
      gazetteReason.textContent = REASON[result];
      gazetteHeadline.textContent = HEADLINE[result];
      statList(gazetteStats, [
        ['ROUND', clockText(played)],
        creatureWon ? ['CREATURE HP LEFT', String(hp)] : ['TIME TO SPARE', clockText(snapshot.timeRemaining)],
        ['GUESTS CAUGHT', String(stats.caught)], ['REVIVED', String(stats.revived)],
        ['BATTERIES FOUND', String(stats.batteries)], ['LIGHT ON IT', `${stats.lit.toFixed(1)} s`],
      ]);
      gazetteFlashlight.textContent = `Flashlight time: ${(Object.entries(stats.flashlight) as [HunterId, number][])
        .map(([id, seconds]) => `${id} ${Math.round(seconds)} s`).join(' · ')}`;

      // Everything is drawn: play the overlay's entrance (style.css), once.
      if (overlay.hidden) return;
      overlay.classList.add('entering');
      afterAnimations(overlay, () => overlay.classList.remove('entering'));
    },
  };
}
