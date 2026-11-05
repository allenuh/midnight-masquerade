// DEBUG-MENU: the menu over the page, toggled with the ` key (closed with Esc), in the lobby or a
// round. It holds the round's numbers as plain text, the VFX toggles and the host's tuning table
// (all in index.html), and during a round the host's start (main.ts moves it here). It also has the
// host's clock buttons, the fear preview, a frame-rate readout and live tuning of the look: every
// control in look-controls.ts edits a plain value object that its module pushes to the picture
// each frame. Edits last until the page is reloaded; "Copy changes" lists them for the source.
// Deleting this file, look-controls.ts, the menu's markup and CSS, and the lines marked DEBUG-MENU
// removes the menu; the look objects it edits are ordinary module values and can stay.
import type { WebGLRenderer } from 'three';
import type { ClientMessage } from '../shared/protocol.js';
import { LOOK_CONTROLS, type LookControl } from './look-controls.js';

const element = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
// Seconds the clock is set to by "Clock to 0:31": one second before the final warning turns it red.
const FINAL_WARNING_TEST_SECONDS = 31;
// How often the frame-rate readout refreshes, in milliseconds.
const PERF_INTERVAL = 500;

function button(label: string, onClick: () => void): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = label;
  control.addEventListener('click', () => {
    // Drop focus so Space goes back to working the action button.
    control.blur();
    onClick();
  });
  return control;
}

// A slider or colour picker never keeps focus: while it has it, WASD and Space would not reach
// the game.
function releaseFocus(control: HTMLElement): void {
  control.addEventListener('change', () => control.blur());
  control.addEventListener('pointerup', () => control.blur());
}

const formatNumber = (value: number): string => String(Number(value.toFixed(4)));

export function mountDebugMenu(send: (message: ClientMessage) => void, initialFearPreview: number | null) {
  const menu = element('#debug-menu');
  const perfText = element('#perf');
  const roundActions = element('#round-actions');
  const lookSections = element('#look-sections');
  const lookActions = element('#look-actions');

  // Open state per tab, so a reload mid-tuning keeps it open.
  function setOpen(open: boolean): void {
    menu.hidden = !open;
    try {
      sessionStorage.setItem('debug-menu', open ? 'open' : 'closed');
    } catch {
      // Storage unavailable: the menu still opens and closes.
    }
  }
  try {
    menu.hidden = sessionStorage.getItem('debug-menu') !== 'open';
  } catch {
    menu.hidden = true;
  }
  window.addEventListener('keydown', (event) => {
    // The room code box takes any character.
    if (event.target instanceof HTMLInputElement && event.target.type === 'text') return;
    if (event.code === 'Backquote') {
      event.preventDefault();
      setOpen(menu.hidden !== false);
    } else if (event.code === 'Escape' && !menu.hidden) {
      setOpen(false);
    }
  });

  // Host clock buttons, enabled only while the host's round runs.
  const endRound = button('End round (expire clock)', () => send({ type: 'setClock', seconds: 0 }));
  const finalWarning = button('Clock to 0:31', () => send({ type: 'setClock', seconds: FINAL_WARNING_TEST_SECONDS }));
  roundActions.append(endRound, finalWarning);

  // Fear preview: a Hunter's fear effects at x (0 SAFE to 3 innermost IMMEDIATE; see fear.ts),
  // replacing the server's band, so the bands can be tuned without a Creature nearby.
  let fearPreview = initialFearPreview;
  const fearRow = document.createElement('label');
  fearRow.className = 'look-row';
  const fearOn = document.createElement('input');
  fearOn.type = 'checkbox';
  fearOn.checked = fearPreview !== null;
  const fearSlider = document.createElement('input');
  fearSlider.type = 'range';
  fearSlider.min = '0';
  fearSlider.max = '3';
  fearSlider.step = '0.05';
  fearSlider.value = String(fearPreview ?? 1.5);
  const fearValue = document.createElement('output');
  const syncFear = () => {
    fearPreview = fearOn.checked ? Number(fearSlider.value) : null;
    const value = Number(fearSlider.value);
    const band = value === 0 ? 'SAFE' : ['UNEASY', 'DANGER', 'IMMEDIATE'][Math.ceil(value) - 1];
    fearValue.textContent = fearOn.checked ? `${value.toFixed(2)} ${band}` : 'off';
  };
  for (const control of [fearOn, fearSlider]) {
    control.addEventListener('input', syncFear);
    releaseFocus(control);
  }
  fearSlider.addEventListener('input', () => {
    fearOn.checked = true;
    syncFear();
  });
  syncFear();
  const fearLabel = document.createElement('span');
  fearLabel.append(fearOn, ' fear preview');
  fearLabel.title = 'A Hunter\'s fear effects at this level, in place of the server\'s band (0 SAFE … 3 IMMEDIATE)';
  fearRow.append(fearLabel, fearSlider, fearValue);
  roundActions.after(fearRow);

  // Effect previews, on this screen only: replay a battery's entrance and sparkle, or a pickup's
  // sparkle, at the battery on the map, and set a Creature this client can already see burning.
  let sparklePreview: 'spawn' | 'pickup' | null = null;
  const effectRow = document.createElement('div');
  effectRow.className = 'look-row';
  const fireOn = document.createElement('input');
  fireOn.type = 'checkbox';
  releaseFocus(fireOn);
  const fireLabel = document.createElement('label');
  fireLabel.append(fireOn, ' fire preview');
  fireLabel.title = 'Sets a Creature this client can already see burning, on this screen only';
  effectRow.append(
    button('Battery spawn', () => { sparklePreview = 'spawn'; }),
    button('Pickup sparkle', () => { sparklePreview = 'pickup'; }),
    fireLabel,
  );
  fearRow.after(effectRow);

  // Live look controls, one collapsible section each, in the order look-controls.ts lists them.
  type Row = { control: LookControl; initial: number | string | boolean; row: HTMLElement; set: (value: number | string | boolean) => void };
  const rows: Row[] = [];
  const changedText = document.createElement('span');
  const sections = new Map<string, { body: HTMLElement; rows: Row[] }>();
  const isChanged = ({ control, initial }: Row) => control.object[control.key] !== initial;
  function refreshChanged(): void {
    let total = 0;
    for (const row of rows) {
      const changed = isChanged(row);
      row.row.toggleAttribute('data-changed', changed);
      if (changed) total += 1;
    }
    changedText.textContent = total === 0 ? 'no changes' : `${total} changed`;
  }

  for (const control of LOOK_CONTROLS) {
    let section = sections.get(control.section);
    if (!section) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = control.section;
      const body = document.createElement('div');
      details.append(summary, body);
      lookSections.append(details);
      section = { body, rows: [] };
      sections.set(control.section, section);
      const sectionRows = section.rows;
      const reset = button('reset section', () => {
        for (const row of sectionRows) row.set(row.initial);
        refreshChanged();
      });
      reset.className = 'look-reset';
      body.append(reset);
    }
    const row = document.createElement('label');
    row.className = 'look-row';
    row.title = control.path;
    const label = document.createElement('span');
    label.textContent = control.label;
    row.append(label);
    let set: Row['set'];
    if (control.kind === 'number') {
      const slider = document.createElement('input');
      slider.type = 'range';
      const box = document.createElement('input');
      box.type = 'number';
      for (const input of [slider, box]) {
        input.min = String(control.min);
        input.max = String(control.max);
        input.step = String(control.step);
        releaseFocus(input);
      }
      set = (value) => {
        control.object[control.key] = value;
        slider.value = String(value);
        box.value = formatNumber(value as number);
      };
      slider.addEventListener('input', () => {
        set(Number(slider.value));
        refreshChanged();
      });
      // The box takes any number, even past the slider's range; a bad entry is put back.
      box.addEventListener('change', () => {
        const value = Number(box.value);
        set(box.value.trim() !== '' && Number.isFinite(value) ? value : control.object[control.key] as number);
        refreshChanged();
      });
      row.append(slider, box);
    } else if (control.kind === 'color') {
      const picker = document.createElement('input');
      picker.type = 'color';
      releaseFocus(picker);
      set = (value) => {
        control.object[control.key] = value;
        picker.value = value as string;
      };
      picker.addEventListener('input', () => {
        set(picker.value);
        refreshChanged();
      });
      row.append(picker);
    } else {
      const box = document.createElement('input');
      box.type = 'checkbox';
      releaseFocus(box);
      set = (value) => {
        control.object[control.key] = value;
        box.checked = value as boolean;
      };
      box.addEventListener('change', () => {
        set(box.checked);
        refreshChanged();
      });
      row.append(box);
    }
    const initial = control.object[control.key] as Row['initial'];
    set(initial);
    const entry = { control, initial, row, set };
    rows.push(entry);
    section.rows.push(entry);
    section.body.append(row);
  }

  // Every edited value as "file  path  default → now", for pasting into the source. The clipboard
  // needs a secure page (localhost or https); the text is also shown so it can be copied by hand.
  const copyText = document.createElement('textarea');
  copyText.readOnly = true;
  copyText.hidden = true;
  copyText.rows = 6;
  const copyChanges = button('Copy changes', () => {
    const lines = rows.filter(isChanged).map(({ control, initial }) => {
      const now = control.object[control.key];
      const show = (value: unknown) => (typeof value === 'number' ? formatNumber(value) : String(value));
      return `${control.file}  ${control.path}  ${show(initial)} → ${show(now)}`;
    });
    copyText.value = lines.length === 0 ? 'No changes.' : lines.join('\n');
    copyText.hidden = false;
    navigator.clipboard?.writeText(copyText.value).catch(() => {
      // Not a secure page: the text box above has it.
    });
  });
  const resetAll = button('Reset all', () => {
    for (const row of rows) row.set(row.initial);
    copyText.hidden = true;
    refreshChanged();
  });
  lookActions.append(copyChanges, resetAll, changedText);
  lookActions.after(copyText);
  refreshChanged();

  // Frame rate and the renderer's work per frame. The composer renders several passes a frame, so
  // the counters are reset here once a frame rather than by every render call.
  let frames = 0;
  let perfFrom = performance.now();
  let infoRenderer: WebGLRenderer | null = null;

  return {
    // The fear preview level, or null to follow the server's band.
    get fearPreview(): number | null {
      return fearPreview;
    },
    // Whether the fire preview is on.
    get firePreview(): boolean {
      return fireOn.checked;
    },
    // The sparkle a button just asked for, once.
    takeSparklePreview(): 'spawn' | 'pickup' | null {
      const kind = sparklePreview;
      sparklePreview = null;
      return kind;
    },
    // From main.ts's updateUi: the clock buttons work only for the host of a running round.
    update(state: { host: boolean; running: boolean }): void {
      endRound.disabled = finalWarning.disabled = !state.host || !state.running;
    },
    // Once a frame, after the scene has rendered.
    frame(renderer: WebGLRenderer): void {
      if (infoRenderer !== renderer) {
        infoRenderer = renderer;
        renderer.info.autoReset = false;
      }
      frames += 1;
      const now = performance.now();
      if (now - perfFrom >= PERF_INTERVAL) {
        const { calls, triangles } = renderer.info.render;
        perfText.textContent = `${Math.round((frames * 1000) / (now - perfFrom))} fps · ${calls} draw calls · ${triangles} triangles`;
        frames = 0;
        perfFrom = now;
      }
      renderer.info.reset();
    },
  };
}
