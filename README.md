# Manhunt

A real-world manhunt PWA. You and your friends join with a party code, spin for teams, and play inside a play area you draw on the map. Location pings, camping and out-of-bounds detection, a hunter freeze enforced by step counting and the camera, a proximity heartbeat, a combat cam for Nerf tags, endgame, and a replay at the end.

**Stack:** React + Vite PWA · Cloudflare Worker + one Durable Object per party (the authoritative game server) · MapLibre + OpenFreeMap tiles (no API keys) · OSM Overpass/Photon for street tracing and search.

The app and the game server deploy together as **one Worker on one origin**, on Cloudflare's free plan (Durable Objects with SQLite storage are included there). No database, no keys, no credit card.

## Quick start

```bash
npm run setup                 # installs app + server deps
npm run build                 # builds the PWA into app/dist
npm run dev:server            # wrangler dev on :8787 (serves the built app + game server)
# open http://localhost:8787  — or for hot reload:
npm run dev:app               # vite on :5173, proxies /api (incl. websockets) to :8787
```

Test on a phone over your LAN with the Vite URL. Geolocation, camera and motion sensors need **HTTPS** on real phones, so for phone testing either deploy, or tunnel (`cloudflared tunnel --url http://localhost:8787`).

**Desk testing:** add `?sim` to the URL. Your GPS is replaced by a fake position, and tapping the map moves you. Open several browser profiles to play against yourself.

## Deploy: app on Vercel, game server on Cloudflare

Vercel functions can't hold long-lived WebSockets or per-party state, so the game server stays a Cloudflare Worker (free plan). The PWA goes on Vercel.

1. **Game server:** `npx wrangler login` once, then `npm run deploy`. You get `https://manhunt.<you>.workers.dev`. That Worker also serves a copy of the app, which is handy as a backup.
2. **App on Vercel:** import the repo and set **Root Directory = `app`**. Keep "Include files outside the root directory" on, because the app imports `../shared`. Add the env var `VITE_API_URL = https://manhunt.<you>.workers.dev` and deploy. `app/vercel.json` already sets the build.

The Worker's JSON endpoints send CORS headers, and WebSockets connect cross-origin directly. Friends open the Vercel URL, then use Share → **Add to Home Screen** (iOS) or **Install app** (Android) for full screen.

## Interactive demo

`npx vite build -c vite.demo.config.ts` (inside `app/`) builds `dist-demo/`. It's the real app plus the real `room.ts` running in the page against six bots, with a bundled offline map, simulated GPS and a fake camera, so you can review everything with no backend.

## Tests

```bash
npm run dev:server            # in one terminal
npm run test:server           # 34 checks: 5 simulated phones, full match + freeze-violation match
npm run test:e2e              # 4 headless Chrome phones through the real UI, screenshots in /tmp/shots
```

`test:e2e` needs Playwright and Chrome (`PLAYWRIGHT_PATH`, `CHROME` env vars override the defaults). It uses fake GPS, a fake camera and `?test`, which exposes `window.__send` so the test can shorten timers.

## How the game works (server rules)

| Rule | Behaviour |
|---|---|
| Party | 5-char code, max 30 players. Each phone has an id plus a secret in localStorage, so nobody can join as someone else. |
| Teams | Host spins: random pairs, odd player per lobby setting (solo / joins hunters / team of 3). Hunters are drawn from full pairs. If hider teams ≤ the "solo threshold" (default 2), every hider plays solo and alliances unlock. Teams rename themselves. |
| Visibility | The server holds all positions. Each phone only receives teammates, allies, and players who are exposed: during a ping, camping, out of bounds, or gone dark. Inspecting the app doesn't reveal anyone. |
| Freeze | Hunters stay put for N seconds. They lose automatically if they take more than N steps (accelerometer), if GPS confidently shows them outside the freeze radius (3 readings in a row, accuracy-adjusted), or if the camera is covered for more than 8s. A phone that is perfectly still for 60s gets flagged ("set down?"). |
| Presets | Quick (45 min), Classic (2 h, default), Long haul (4 h), or Custom. Matches can run up to 8 h. |
| Pings | Every N minutes. A fake incoming call + voice warning comes N seconds before, then a radar sweep shows everyone live for N seconds. |
| Camping | Staying within ~20 m for 7 min (configurable) exposes you until you move. |
| Boundary | 3 confident readings outside = exposed + countdown. Still outside after the grace period = DQ. |
| Gone dark | No location report for 60s (app closed or phone locked) = everyone sees your last known spot. |
| Heartbeat | Server sends a 0–5 proximity level to the nearest enemy (≤15/35/60/100/150 m), never a direction. Sound + screen pulse on all phones, vibration on Android. |
| Tagging | Inside combat range (default 30 m) the hunter's camera opens automatically with a HIT button. The target confirms or disputes. A dispute goes to a 20s vote by everyone else. No answer = auto-accept. |
| Endgame | When one hider team is left, the clock drops to ≤15 min and reveals happen every 4 min for 3s with no warning. |
| Win | All hiders caught = hunters win. Survive to the end, or the hunters break the freeze = hiders win. Everyone gets the result and the time. |
| Replay | Positions are sampled every 5s. The results screen has a scrubber and a tappable timeline. |

## Walkie-talkie

- Every team gets a secret channel (2 to 99). Channel 1 is the lobby. Anyone can tune or **Scan** to find other teams' channels and listen in, voice and text.
- Tap the orange radio button on the map to open the radio. Hold it to talk without opening anything. In the radio screen, hold the big button or the space bar.
- One person talks at a time per channel (a busy light shows who). Voice is 8 kHz mu-law in 60 ms frames (64 kbit/s) relayed by the Durable Object, so it needs no extra service. Expect a quarter-second of delay, like a real radio.
- The mic is released 15 seconds after you stop talking.

## Ending early

Any player can start a vote from the menu. The match ends only when **every** player still around votes yes. Players offline for more than 3 minutes don't block it. A single "Keep playing" cancels the vote. Votes expire after 3 minutes. The host can no longer end a match alone, and players can only be removed between matches.

## Sound

- Effects are synthesized with Web Audio (FM bells, sonar ping, heartbeat thumps, radio key-up, roger beep and squelch) through a compressor and a small generated reverb.
- The announcer is a deep British neural voice (Kokoro `bm_lewis`, Apache-2.0), pre-rendered into 25 short clips in `app/public/voice` (450 KB, cached offline). To change the lines, see `tools/make_voice.py`.
- Players can turn sound effects and the announcer on or off in the match menu.

## Platform limits (web app)

- **Screen must stay on.** Browsers stop GPS when the app is backgrounded or locked. The app holds a wake lock, and silence counts as "gone dark".
- **iPhone can't vibrate from the web.** The heartbeat on iPhone is sound + the red screen pulse.
- **Camera obstruction** looks for near-black or perfectly uniform frames. The thresholds are conservative for night play, but test it in your real lighting.
- **Volume buttons** can't be read by web apps, so the walkie-talkie uses on-screen hold-to-talk.
- **Radio with the screen off:** installed iOS web apps lose the mic when locked, so talking needs the app open. That matches "turn the phone off to leave the talkie".

## Roadmap

1. **Hunter cams streamed** to hiders during the freeze.
2. **Radio extras for mods:** Bug Sweep (see who is listening) and Scramble.
3. **Mods.** Ability points, map orb pickups with D–S tier rolls (3 rerolls), and the 11 abilities (Revive, Reboot Card, Vanish, Fake Location, Trace, Immunity Shield, Clear Bounty, Extra/Disable Safe Zone, Steal Credits). `settings.mods` is already in the protocol, and the server is the right place for the logic.
4. **Replay export** to video (canvas → MediaRecorder → share sheet → Photos).
5. **Web push** for events when a phone isn't in the app.

## Code map

```
shared/protocol.ts   message + state types, default settings, proximity buckets
shared/geo.ts        distance, point-in-polygon, edge distance, circle polygons
server/src/room.ts   Durable Object: the whole game (lobby → teams → freeze → live → ended)
server/src/index.ts  Worker: /api/create, /api/party/:code, /api/party/:code/ws
server/test/sim.ts   protocol-level match simulation
app/src/store.ts     websocket client, reconnect, identity, event handling
app/src/device/      GPS (+sim), step counter, camera + obstruction, audio synth, wake lock
app/src/map/         MapLibre wrapper, area editor (search, circle, trace streets, edit points)
app/src/screens/     Home, Lobby (rules, wheel, ready check), Match, overlays, Results
app/test/e2e.mjs     4-phone Playwright run
```
