# Creature Containment Crew (Title Pending)

This repository contains a multiplayer browser game based heavily on the [Luigi's Ghost Mansion](https://nintendo-land.fandom.com/wiki/Luigi%27s_Ghost_Mansion) attraction from [Nintendo Land](https://en.wikipedia.org/wiki/Nintendo_Land) for the Wii U.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the current prototype, its rules, and how to run and test it locally.

# Remote Playtesting

How to host a five-player match from your own computer for friends anywhere, through one
public HTTPS link. The game itself runs on your machine and stays authoritative; the
tunnel only forwards traffic from the public internet to it. Nothing in the game knows
about the tunnel, so the same build runs unchanged on a LAN or, later, on a real host.

```
friends' browsers  --https/wss-->  Cloudflare  --tunnel-->  your PC: npm run playtest (port 5173)
```

## 1. Prerequisites

- **Node.js 22.12 or newer** and npm (`node --version` to check).
- **cloudflared**, Cloudflare's tunnel client. No Cloudflare account is needed for a
  temporary "quick tunnel":
  - Windows: `winget install --id Cloudflare.cloudflared` (or `choco install cloudflared`)
  - macOS: `brew install cloudflared`
  - Linux: packages at <https://pkg.cloudflare.com/> or the GitHub release binary

  Open a **new** terminal after installing so it is on your `PATH`; `cloudflared --version`
  should print a version.
- Your friends need only a desktop browser with WebGL 2 (current Chrome, Edge, or
  Firefox). No installs, accounts, ports, or settings on their side.

## 2. Install and build

```sh
npm install
```

That is all; `npm run playtest` below builds the game every time it starts, so the
players always get the code currently on disk.

## 3. Start playtest mode

```sh
npm run playtest
```

This type-checks, builds the player client into `dist/client`, compiles the server,
and serves both from **one port**: the page and its WebSocket share
`http://127.0.0.1:5173`. It is the production serving path (no Vite dev server, no hot
reload, no developer tools), and the map editor is not part of the build at all.

The console prints the local URL, the maps it found, and the exact tunnel command.
`.env not found. Continuing without it.` is Node telling you the optional settings file
(step 5) is absent; it is not an error.

To restart after a code or map change: `Ctrl+C`, then `npm run playtest` again. Friends
reload the page; the served page is never cached, so they get the new build at once.
(`npm start` serves the last build without rebuilding.)

## 4. Local check

Open <http://127.0.0.1:5173> in your own browser. You should see **Create room** and the
server console should log `[conn] p1 connected`. Open a second tab, create a room in
one and join it from the other; both see `Players: 2 / 5`.

## 5. Optional: settings and a LAN check

Settings are read from a `.env` file next to `package.json` if one exists. Copy
[`.env.example`](.env.example) to `.env` and uncomment what you need:

```
HOST=127.0.0.1     # 0.0.0.0 to let other computers on your LAN connect
PORT=5173          # the one port the page and the WebSocket share
# MATCH_SECONDS=180
# MAP=test-arena
# DEBUG_SERVER=1
```

`.env` is git-ignored. Gameplay tuning is not in it: the balance numbers live in
`src/shared/gameplay-config.ts` and take effect on the next `npm run playtest`.

For a LAN test (two computers in the same house), set `HOST=0.0.0.0`, restart, allow the
Windows Firewall prompt for Node, and open `http://<your LAN IP>:5173` on the other
machine (`ipconfig` shows the IP). The tunnel does **not** need this: it connects to
`localhost` on the same machine, so `127.0.0.1` is enough for remote play.

## 6. Open the tunnel

Leave the game running and, in a **second terminal**:

```sh
cloudflared tunnel --url http://localhost:5173
```

(If you changed `PORT`, use that port here instead.) After a few seconds the output
contains a box with a line like:

```
https://random-words-here.trycloudflare.com
```

That is the public URL. It is random, works only while this command runs, and changes
every time you start the tunnel. The first request can take a moment while Cloudflare
warms up.

Optional self-check before inviting anyone: with the game and the tunnel running,
`node tools/remote-check.mjs https://…trycloudflare.com` opens five headless browsers on
the public URL, fills a room, starts a round, and prints `REMOTE CHECK PASSED` if the
sockets are `wss://` on that host and a restart works. It needs the browser installed by
`npm run test:browser` (Chrome) and is not part of the game.

## 7. Send the URL

Send friends exactly that `https://…trycloudflare.com` address. They open it in a
browser and see the same page you see locally. Nothing else is needed from them.

- One person clicks **Create room** and reads out the four-letter code from the header.
- The other four type the code and click **Join**, or open
  `https://…trycloudflare.com/?room=CODE` directly.
- At `Players: 5 / 5` the host's **Start match** button enables; the host can also pick
  the map from the dropdown beside it. Everyone privately sees their role for three
  seconds, then the round runs.
- After a result the host presses **Start match** again for a rematch with fresh roles;
  nobody needs a new link or a new room.

Controls and rules are in the page footer and in
[DOCUMENTATION.md](DOCUMENTATION.md#five-client-playtest-procedure).

The server console on your machine shows one `[conn]`/`[room]` line per connection and
room event and one `[round]` line per finished round with the winner, duration, Creature
HP left, downs, revives, batteries collected, and flashlight seconds per Hunter. Copy
those lines into your balance notes; nothing is stored anywhere.

## 8. Stop

`Ctrl+C` in the tunnel terminal (the public URL stops working immediately), then
`Ctrl+C` in the game terminal. Players still connected see "Disconnected".

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Friends get a Cloudflare error page (502 / 1033) | Nothing is listening on the port the tunnel points at. Check the game terminal is running and that the port in the `cloudflared` command matches the one it printed. |
| The page loads but stays on **Connecting…** | The WebSocket did not connect. In the browser press F12 → Network → WS: the request must be `wss://<the same host>/ws`. If it is `ws://` on an `https://` page, or names another host, the page was not served by this server (a proxy or extension rewrote it); the client always derives the socket from the page's own address. |
| Works for you at `127.0.0.1`, not through the tunnel | You started `npm run dev` instead of `npm run playtest`. The dev server rejects requests for unknown host names; the playtest build accepts any host. |
| Works through the tunnel, not on the LAN | `HOST` is `127.0.0.1` (only this machine) or the firewall blocks Node. Set `HOST=0.0.0.0` in `.env`, restart, and allow the prompt. The tunnel never needs this. |
| A friend's page shows old behaviour after you changed code | They must reload after you restart `npm run playtest`; the build happens on start, not on save. |
| Everyone is thrown back to the lobby mid-round | A player disconnected. By design the round ends and the room waits for a fifth player again; the host restarting the match starts a new round. If the host disconnects the room closes and everyone reloads. |
| Movement feels delayed | Real latency: inputs go to your machine and positions come back, so a player far from you sees their own movement one round trip late (typically 50–150 ms). The server is authoritative on purpose; there is no client prediction in this prototype. |
| `cloudflared` is not recognised | Open a new terminal after installing, or run it by full path (Windows: `"C:\Program Files (x86)\cloudflared\cloudflared.exe"`). |
| The tunnel URL changed | Quick tunnels get a new random name every run. Send the new one; rooms are not tied to it. |
| Something else | `DEBUG_SERVER=1` in `.env` prints the whole balance state once a second per room, on the server only. |

Quick tunnels are free, unauthenticated, and meant for exactly this kind of temporary
session: they have no uptime guarantee and anyone who has the URL can open the game
while it runs. Do not leave one running unattended.
