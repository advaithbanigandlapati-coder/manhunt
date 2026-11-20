// Mods simulation against `wrangler dev`: every ability, orbs, rerolls, safe zones, bounties.
// Usage: npx tsx test/mods.ts [baseUrl]
import WebSocket from 'ws';
import type { ServerMsg, PublicState, ClientMsg } from '../../shared/protocol';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const O = { lat: 40.3801, lng: -74.5302 };
const off = (dx: number, dy: number) => ({ lat: O.lat + dy / 111_111, lng: O.lng + dx / (111_111 * Math.cos((O.lat * Math.PI) / 180)) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

class Phone {
  ws!: WebSocket;
  state!: PublicState;
  tick: Extract<ServerMsg, { t: 'tick' }> | null = null;
  msgs: ServerMsg[] = [];
  errors: string[] = [];
  pos: [number, number] = [0, 0];
  constructor(public name: string, public id = 'p-' + Math.random().toString(36).slice(2, 10), public secret = 's'.repeat(8) + Math.random().toString(36).slice(2)) {}
  connect(code: string) {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/party/${code}/ws?pid=${this.id}&secret=${this.secret}&name=${this.name}`);
      this.ws.on('message', (d, bin) => {
        if (bin) return;
        const m = JSON.parse(String(d)) as ServerMsg;
        if (m.t === 'state') { this.state = m.s; res(); }
        else if (m.t === 'tick') this.tick = m;
        else if (m.t === 'error') this.errors.push(m.msg);
        else this.msgs.push(m);
      });
      this.ws.on('error', rej);
    });
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  get points() { return this.state.mods?.points ?? -1; }
  get role() { return this.state.teams.find((t) => t.members.includes(this.id))?.role; }
  sees(id: string) { return this.tick?.vis.find((v) => v.id === id); }
  lastErr() { return this.errors[this.errors.length - 1] ?? ''; }
  status(of: Phone) { return this.state.players.find((p) => p.id === of.id)?.status; }
}

async function main() {
  const phones = ['Ava', 'Ben', 'Cal', 'Dee', 'Eli'].map((n) => new Phone(n));
  const host = phones[0];
  const { code } = await (await fetch(`${BASE}/api/create`, { method: 'POST', body: JSON.stringify({ hostId: host.id }) })).json() as { code: string };
  for (const p of phones) await p.connect(code);
  const square = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];
  host.send({ t: 'setArea', area: { polygon: square, center: O, radiusM: 300 } });
  host.send({ t: 'setSettings', settings: { mods: true, modStartPoints: 6, orbCount: 4, freezeSeconds: 3, pingMinutes: 0.25, warnSeconds: 3, revealSeconds: 5 } });
  host.send({ t: 'spin' });
  await sleep(400);
  check(host.state.settings.mods && host.state.settings.modStartPoints === 6, 'host turns mods on');
  host.send({ t: 'start' });
  await sleep(600);
  const H = phones.filter((p) => p.role === 'hunter');
  const [A, B, C] = phones.filter((p) => p.role === 'hider');
  check(H.length === 2 && !!C, 'one hunter pair and three solo hiders');
  check(host.state.orbs.length >= 1 && host.state.orbs.length <= 3, `orbs appear on the map at the start (${host.state.orbs.length})`);
  check(A.points === 6 && H[0].points === 6, 'everyone starts with 6 points');

  H[0].pos = [0, 0]; H[1].pos = [3, 0]; A.pos = [8, 4]; B.pos = [-8, 4]; C.pos = [4, -8];
  const pump = setInterval(() => {
    for (const p of phones) p.send({ t: 'loc', ...off(...p.pos), acc: 5, at: Date.now() });
    for (const h of H) if (host.state.phase === 'freeze') h.send({ t: 'freeze', steps: 0, still: false, camOk: true });
  }, 1000);
  await sleep(4000);
  check(host.state.phase === 'live', 'match is live');

  // vanish + fake location before the ping
  A.send({ t: 'use', ability: 'vanish' });
  B.send({ t: 'use', ability: 'fake', ...off(120, 120) });
  await sleep(500);
  check(A.points === 5 && !!A.state.mods?.until.vanish, 'Vanish costs 1 and is active');
  check(B.points === 5 && !!B.state.mods?.decoy, 'Fake Location costs 1 and stores the decoy');
  B.send({ t: 'use', ability: 'zone' });
  await sleep(300);
  check(B.points === 5 && B.state.mods?.zones.length === 1 && !B.state.mods.freeZone, 'first safe zone is free');

  for (let i = 0; i < 30 && !H[0].tick?.revealUntil; i++) await sleep(500);
  await sleep(1200);
  check(!!H[0].tick?.revealUntil && !!H[0].sees(C.id), 'during the ping hunters see a normal hider');
  check(!H[0].sees(A.id), 'Vanish hides you from the ping');
  const bv = H[0].sees(B.id);
  const decoy = off(120, 120);
  check(!!bv && Math.abs(bv.lat - decoy.lat) < 1e-6 && Math.abs(bv.lng - decoy.lng) < 1e-6, 'Fake Location shows the decoy instead of you');
  check(!!host.state.players.find((p) => p.id === C.id)?.bounty, 'the richest hider (Cal, 6 points) gets a bounty at the ping');

  H[0].send({ t: 'use', ability: 'trace' });
  await sleep(1500);
  check(H[0].sees(A.id)?.reason === 'trace', 'Trace reveals the vanished hider');
  check(!H[1].sees(A.id), 'teammate without Trace still can’t see them');

  C.send({ t: 'use', ability: 'clear' });
  await sleep(300);
  check(!host.state.players.find((p) => p.id === C.id)?.bounty && C.points === 5, 'Clear Bounty removes it for 1 point');
  C.send({ t: 'use', ability: 'shield' });
  await sleep(300);
  H[0].send({ t: 'hit', targetId: C.id });
  await sleep(400);
  check(/shield/i.test(H[0].lastErr()) && !C.msgs.some((m) => m.t === 'tagPrompt'), 'Immunity Shield blocks a hit');

  H[1].send({ t: 'hit', targetId: B.id });
  await sleep(400);
  check(/safe zone/i.test(H[1].lastErr()), 'standing in your safe zone blocks a hit');
  H[1].send({ t: 'use', ability: 'disable', targetId: B.id });
  await sleep(300);
  H[1].send({ t: 'hit', targetId: B.id });
  await sleep(400);
  const tp = B.msgs.find((m) => m.t === 'tagPrompt') as Extract<ServerMsg, { t: 'tagPrompt' }> | undefined;
  check(!!tp, 'Disable Safe Zone lets the hit through');
  if (tp) B.send({ t: 'tagReply', tagId: tp.tag.id, accept: true });
  await sleep(500);
  check(host.status(B) === 'caught' && H[1].points === 6, 'catch gives the hunter +1 point (6 - 1 for Disable + 1)');

  B.send({ t: 'use', ability: 'revive' });
  await sleep(400);
  check(host.status(B) === 'active' && B.points === 2 && !!B.state.mods?.until.shield, 'Revive brings you back for 3 points with a short shield');

  H[0].send({ t: 'use', ability: 'steal', targetId: C.id });
  await sleep(300);
  check(C.points === 3 && H[0].points === 5, 'Steal Credits takes 1 point (Cal 4 -> 3)');

  H[0].send({ t: 'hit', targetId: A.id });
  await sleep(400);
  const tpA = A.msgs.find((m) => m.t === 'tagPrompt') as Extract<ServerMsg, { t: 'tagPrompt' }> | undefined;
  if (tpA) A.send({ t: 'tagReply', tagId: tpA.tag.id, accept: true });
  await sleep(500);
  check(host.status(A) === 'caught', 'vanished players can still be tagged in person');
  C.send({ t: 'use', ability: 'reboot', targetId: A.id });
  await sleep(400);
  check(host.status(A) === 'active' && C.points === 0, 'Reboot Card brings a caught hider back for 3 points');

  C.send({ t: 'use', ability: 'vanish' });
  await sleep(300);
  check(/need 1 point/i.test(C.lastErr()), 'can’t use abilities without enough points');
  H[0].send({ t: 'use', ability: 'vanish' });
  await sleep(300);
  check(/for hiders/i.test(H[0].lastErr()), 'hider-only abilities are blocked for hunters');

  // orbs: walk onto one, reroll, keep
  for (let i = 0; i < 10 && !host.state.orbs.length; i++) await sleep(1000);
  const orb = host.state.orbs[0];
  const dx = (orb.lng - O.lng) * 111_111 * Math.cos((O.lat * Math.PI) / 180), dy = (orb.lat - O.lat) * 111_111;
  const before = A.points;
  A.pos = [dx + 2, dy];
  await sleep(2500);
  const r1 = A.msgs.find((m) => m.t === 'orb') as Extract<ServerMsg, { t: 'orb' }> | undefined;
  check(!!r1 && r1.rerollsLeft === 3, `walking onto an orb rolls a reward (${r1?.roll.tier}-tier, ${r1?.roll.points} pts)`);
  check(!host.state.orbs.some((o) => o.id === orb.id), 'the orb disappears for everyone');
  A.send({ t: 'roll', reroll: true });
  await sleep(300);
  const r2 = [...A.msgs].reverse().find((m) => m.t === 'orb') as Extract<ServerMsg, { t: 'orb' }>;
  check(r2.rerolled && r2.rerollsLeft === 2, 'reroll uses one of 3 rerolls');
  A.send({ t: 'roll', reroll: false });
  await sleep(300);
  check(A.points === before + r2.roll.points, `keeping the roll adds its points (+${r2.roll.points})`);

  // per-ability toggles
  host.send({ t: 'reset' });
  host.send({ t: 'setSettings', settings: { disabledAbilities: ['vanish', 'nonsense' as never] } });
  host.send({ t: 'spin' });
  await sleep(300);
  check(JSON.stringify(host.state.settings.disabledAbilities) === '["vanish"]', 'host can switch single abilities off');
  host.send({ t: 'start' });
  await sleep(4500);
  const hider = phones.find((p) => p.role === 'hider')!;
  hider.send({ t: 'use', ability: 'vanish' });
  await sleep(300);
  check(/turned off/i.test(hider.lastErr()), 'a switched-off ability can’t be used');

  host.send({ t: 'reset' });
  host.send({ t: 'setSettings', settings: { mods: false } });
  host.send({ t: 'spin' });
  host.send({ t: 'start' });
  await sleep(600);
  check(host.state.mods === null && host.state.orbs.length === 0, 'with mods off there are no orbs or points');

  clearInterval(pump);
  phones.forEach((p) => p.ws.close());
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
