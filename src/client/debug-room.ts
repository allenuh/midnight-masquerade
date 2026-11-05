// DEBUG-ROOM: a temporary, developer-only room the host can start alone or with any number of
// players; the server fills the empty slots with dummies that stand still (src/server/debug-room.ts).
// Offered only under `npm run dev` or with ?debug=1. Its controls are made here and put next to
// the page's own, so index.html knows nothing of them. To remove: delete this file,
// src/server/debug-room.ts and tests/debug-room.test.ts, then every line marked DEBUG-ROOM.
import type { ClientMessage, DebugRole } from '../shared/protocol.js';

const AVAILABLE = import.meta.env.DEV || new URLSearchParams(location.search).get('debug') === '1';

const createButton = document.createElement('button');
createButton.type = 'button';
createButton.textContent = 'Debug room';
createButton.title = 'Developer only: start a round without a full party; empty slots are idle dummies.';

const roleSelect = document.createElement('select');
roleSelect.setAttribute('aria-label', 'Debug role');
roleSelect.append(new Option('as Hunter', 'hunter'), new Option('as Creature', 'creature'), new Option('as random', 'random'));

export const debugRoom = {
  // True once this client has created a debug room (it is then the host). Joiners never need it.
  active: false,

  // `send` reaches the server; `refresh` redraws the page after a choice.
  mount(send: (message: ClientMessage) => void, refresh: () => void): void {
    if (!AVAILABLE) return;
    document.querySelector('#create')!.after(createButton);
    document.querySelector('#start')!.after(roleSelect);
    createButton.addEventListener('click', () => {
      debugRoom.active = true;
      send({ type: 'debugCreate' });
      refresh();
    });
    // Drop focus so Space goes back to working the action button.
    roleSelect.addEventListener('change', () => roleSelect.blur());
  },

  // Called from the page's updateUi: the Debug room button follows Host a game, and the role
  // picker shows wherever the host's Start button does.
  update(createDisabled: boolean, startHidden: boolean): void {
    createButton.disabled = createDisabled;
    roleSelect.hidden = !debugRoom.active || startHidden;
  },

  startMessage(): ClientMessage {
    return { type: 'debugStart', role: roleSelect.value as DebugRole };
  },
};
