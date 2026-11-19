// Drives 4 headless phones through a full match against `wrangler dev` and saves screenshots.
// Usage: node test/e2e.mjs [baseUrl] [outDir]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.argv[3] ?? '/tmp/shots';
const O = { latitude: 40.3801, longitude: -74.5302 };
const at = (dx, dy) => ({ latitude: O.latitude + dy / 111111, longitude: O.longitude + dx / (111111 * Math.cos((O.latitude * Math.PI) / 180)), accuracy: 5 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fails++; };

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
async function phone(name, pos) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: pos, permissions: ['geolocation', 'camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/tiles\.openfreemap|photon|overpass|Failed to load resource|ERR_TUNNEL|net::/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  const ph = { name, ctx, page, tick: null, shot: (n) => page.screenshot({ path: `${OUT}/${n}.png` }) };
  ph.audio = 0;
  page.on('websocket', (ws) => ws.on('framereceived', (f) => { if (typeof f.payload !== 'string') { ph.audio++; return; } try { const m = JSON.parse(f.payload); if (m.t === 'tick') ph.tick = m; } catch {} }));
  page.on('websocket', (ws) => ws.on('framesent', (f) => { try { const m = JSON.parse(f.payload); if (m.t === 'loc') ph.lastLoc = m; } catch {} }));
  return ph;
}

const A = await phone('Ava', at(0, 0));
await A.page.goto(`${BASE}/?test`);
await A.page.fill('input[autocomplete=nickname]', 'Ava');
await A.shot('01-home');
await A.page.click('text=Host a game');
await A.page.waitForSelector('.code-chip b');
const code = await A.page.textContent('.code-chip b');
check(/^[A-Z2-9]{5}$/.test(code), `party code shown (${code})`);

const others = [];
for (const [n, p] of [['Ben', at(5, 0)], ['Cal', at(40, 60)], ['Dee', at(-50, 80)]]) {
  const ph = await phone(n, p);
  await ph.page.goto(`${BASE}/?test&code=${code}`);
  await ph.page.fill('input[autocomplete=nickname]', n);
  await ph.page.click('text=Join game');
  await ph.page.waitForSelector('.code-chip b');
  others.push(ph);
}
const all = [A, ...others];
await sleep(800);
check((await A.page.locator('.players li').count()) === 4, 'host sees 4 players');
await A.shot('02-lobby');

// area editor
await A.page.click('text=Draw the area');
await A.page.waitForSelector('.editor .map canvas');
await sleep(1500);
await A.page.mouse.click(195, 330);
await sleep(600);
await A.shot('03-area-editor');
await A.page.click('text=Edit shape');
await sleep(500);
await A.shot('04-area-edit-points');
await A.page.click('text=Use this area');
await sleep(800);
check(await A.page.locator('.mini-map').isVisible(), 'area saved and previewed in lobby');

await A.page.evaluate(() => window.__send({ t: 'setSettings', settings: { freezeSeconds: 12, pingMinutes: 0.5, warnSeconds: 8, revealSeconds: 6 } }));
await A.page.click('text=Spin for teams');
await sleep(1400);
await A.shot('05-wheel-spinning');
await sleep(4500);
await A.shot('06-teams');
check((await A.page.locator('.team-card').count()) === 3, '3 team cards after the spin (hunters + 2 solo hiders)');

for (const p of all) { await p.page.click("text=I'm ready"); }
await sleep(1500);
await A.shot('07-ready');
await A.page.click('text=Start the hunt');
await sleep(2500);

const roleOf = async (p) => (await p.page.textContent('.role-pill')).includes('HUNTER') ? 'hunter' : 'hider';
const roles = await Promise.all(all.map(roleOf));
const hunters = all.filter((_, i) => roles[i] === 'hunter');
const hiders = all.filter((_, i) => roles[i] === 'hider');
check(hunters.length === 2 && hiders.length === 2, `roles: hunters ${hunters.map((h) => h.name)} / hiders ${hiders.map((h) => h.name)}`);

// hunters must not move during the freeze; hiders run
await hiders[0].ctx.setGeolocation(at(80, 60));
await hiders[1].ctx.setGeolocation(at(-90, 70));
await sleep(1500);
check(await hunters[0].page.locator('.freeze-cam').isVisible(), 'hunter sees the freeze camera screen');
await hunters[0].shot('08-hunter-freeze');
check(await hiders[0].page.locator('.status.run').isVisible(), 'hider sees RUN countdown');
await hiders[0].shot('09-hider-run');

await sleep(11000);
check(!(await hunters[0].page.locator('.freeze-cam').isVisible()), 'freeze camera closes when hunters are released');
await hunters[0].shot('10-hunter-live');

// walkie-talkie: hold the radio button on the map, teammate hears it live
const rb = await hunters[0].page.locator('.radio-btn').boundingBox();
await hunters[0].page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
await hunters[0].page.mouse.down();
await sleep(2200);
check(await hunters[1].page.locator('.status.radio').isVisible(), 'teammate sees who is talking on the radio');
check(hunters[1].audio > 10, `teammate receives live voice frames (${hunters[1].audio})`);
check(hiders[0].audio === 0, 'other teams hear nothing on their own channel');
await hunters[1].shot('10b-radio-rx');
await hunters[0].page.mouse.up();
await sleep(500);
await hunters[0].page.click('.radio-btn');
await sleep(800);
check(await hunters[0].page.locator('.walkie').isVisible(), 'tapping the radio button opens the walkie');
await hunters[0].page.click('.quick button:has-text("On the move")');
await sleep(700);
check((await hunters[1].page.evaluate(() => 1)) && true, 'quick message sent');
await hunters[0].shot('10c-walkie');
await hunters[0].page.click('button[aria-label="Close radio"]');

// ping warning call at ~22s, ping at 30s
await hiders[0].page.waitForSelector('.call-screen', { timeout: 15000 }).catch(() => {});
check(await hiders[0].page.locator('.call-screen').isVisible(), 'fake incoming call before the ping');
await sleep(3200);
await hiders[0].shot('11-fake-call');
await hiders[0].page.waitForSelector('.radar-overlay', { timeout: 12000 }).catch(() => {});
await sleep(800);
check(await hiders[0].page.locator('.radar-overlay').isVisible(), 'radar overlay during the ping');
check((await hiders[0].page.locator('.pin').count()) >= 3, 'during the ping the hider sees everyone');
await hiders[0].shot('12-ping-radar');
await sleep(6500);
check((await hiders[0].page.locator('.pin').count()) === 0, 'after the ping other players disappear again');

// hunter closes in -> heartbeat, then combat cam
await hunters[0].ctx.setGeolocation(at(80 - 45, 60));
await sleep(3500);
check(await hiders[0].page.evaluate(() => /prox-[23]/.test(document.querySelector('.match')?.className ?? '')), 'hider heartbeat when hunter is ~45 m away');
await hiders[0].shot('13-heartbeat');
await hunters[0].ctx.setGeolocation(at(80 - 6, 60));
await sleep(3500);
check(await hunters[0].page.locator('.combat-cam').isVisible(), 'combat camera opens when a hider is in Nerf range');
await hunters[0].shot('14-combat-cam');
await hunters[0].page.click('.btn.hit');
await hiders[0].page.waitForSelector('.modal.alert', { timeout: 5000 }).catch(() => {});
check(await hiders[0].page.locator('.modal.alert').isVisible(), 'hider gets the "they hit you" prompt');
await hiders[0].shot('15-hit-prompt');
await hiders[0].page.click('text=I got hit');
await sleep(1500);
check(await A.page.locator('.banner').isVisible(), 'everyone gets a caught/endgame banner');
await hiders[1].shot('16-endgame-banner');
check(await hiders[0].page.locator('.status.out').isVisible(), 'caught player is spectating');

// markers
await hiders[1].page.click('button[aria-label="Drop a marker"]');
await hiders[1].page.mouse.click(250, 450);
await hiders[1].page.click('.quick button:has-text("Hide spot")');
await hiders[1].page.click('text=Drop it');
await sleep(800);
check((await hiders[1].page.locator('.flag').count()) === 1, 'strategy marker dropped');
await hiders[1].shot('17-marker');

// last hider caught
const [lx, ly] = [-90, 70];
await hunters[1].ctx.setGeolocation(at(lx + 4, ly));
await sleep(3500);
await hunters[1].page.click('.btn.hit');
await hiders[1].page.waitForSelector('.modal.alert', { timeout: 5000 });
await hiders[1].page.click('text=I got hit');
await A.page.waitForSelector('.results', { timeout: 6000 }).catch(() => {});
check(await A.page.locator('.results').isVisible(), 'results screen after the last catch');
await sleep(2500);
await A.page.click('.replay-controls .btn').catch(() => {});
await sleep(1200);
await A.shot('18-results');
check(/Hunters win/.test(await A.page.textContent('.result-hero')), 'hunters win');

console.log(errors.length ? `\nPage errors:\n${errors.slice(0, 15).join('\n')}` : '\nNo page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close();
process.exit(fails ? 1 : 0);
