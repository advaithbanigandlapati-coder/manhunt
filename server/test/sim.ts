// End-to-end simulation against `wrangler dev`: 5 fake phones play a full match.
// Usage: npx tsx test/sim.ts [baseUrl]
import WebSocket from 'ws';
import type { ServerMsg, PublicState, ClientMsg } from '../../shared/protocol';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const O = { lat: 40.3801, lng: -74.5302 }; // middle of the play area
const off = (dx: number, dy: number) => ({ lat: O.lat + dy / 111_111, lng: O.lng + dx / (111_111 * Math.cos((O.lat * Math.PI) / 180)) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

class Phone {
  ws!: WebSocket;
  state!: PublicState;
  ticks: Extract<ServerMsg, { t: 'tick' }>[] = [];
  events: string[] = [];
  prompts: ServerMsg[] = [];
  warned = false;
  errors: string[] = [];
  audio = 0;
  chats: string[] = [];
  constructor(public name: string, public id = 'p-' + Math.random().toString(36).slice(2, 10), public secret = 's'.repeat(8) + Math.random().toString(36).slice(2)) {}
  connect(code: string) {
    return new Promise<void>((res, rej) => {
      const u = `${BASE.replace('http', 'ws')}/api/party/${code}/ws?pid=${this.id}&secret=${this.secret}&name=${this.name}`;
      this.ws = new WebSocket(u);
      this.ws.on('message', (d, isBinary) => {
        if (isBinary) { this.audio++; return; }
        const m = JSON.parse(String(d)) as ServerMsg;
        if (m.t === 'state') { this.state = m.s; res(); }
        else if (m.t === 'tick') this.ticks.push(m);
        else if (m.t === 'event') this.events.push(m.e.text);
        else if (m.t === 'warn') this.warned = true;
        else if (m.t === 'error') this.errors.push(m.msg);
        else if (m.t === 'chat') this.chats.push(m.text);
        else this.prompts.push(m);
      });
      this.ws.on('error', rej);
    });
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  loc(dx: number, dy: number, acc = 5) { this.send({ t: 'loc', ...off(dx, dy), acc, at: Date.now() }); }
  get lastTick() { return this.ticks[this.ticks.length - 1]; }
  get role() { return this.state.teams.find((t) => t.members.includes(this.id))?.role; }
}

async function main() {
  const names = ['Ava', 'Ben', 'Cal', 'Dee', 'Eli'];
  const phones = names.map((n) => new Phone(n));
  const host = phones[0];
  const { code } = await (await fetch(`${BASE}/api/create`, { method: 'POST', body: JSON.stringify({ hostId: host.id }) })).json() as { code: string };
  check(/^[A-Z2-9]{5}$/.test(code), `party created with code ${code}`);
  for (const p of phones) await p.connect(code);
  await sleep(300);
  check(host.state.players.length === 5, '5 players in lobby');

  // impersonation is blocked
  const bad = await new Promise<number>((r) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/party/${code}/ws?pid=${phones[1].id}&secret=${'x'.repeat(20)}&name=Hacker`);
    ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0));
    ws.on('open', () => r(101));
  });
  check(bad === 403, 'cannot connect as another player with the wrong secret');

  phones[1].send({ t: 'spin' });
  await sleep(200);
  check(phones[1].errors.some((e) => /host/i.test(e)), 'non-host cannot spin');

  const square = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];
  host.send({ t: 'setArea', area: { polygon: square, center: O, radiusM: 300 } });
  host.send({ t: 'setSettings', settings: { freezeSeconds: 4, pingMinutes: 0.25, warnSeconds: 5, revealSeconds: 3, outsideGraceSeconds: 5, oddRule: 'solo', endgameRevealEveryMinutes: 0.1, endgameRevealSeconds: 3 } });
  host.send({ t: 'spin' });
  await sleep(400);
  const s = host.state;
  check(s.phase === 'teams', 'spin moves to teams phase');
  const hunterTeam = s.teams.find((t) => t.role === 'hunter')!;
  check(s.teams.filter((t) => t.role === 'hunter').length === 1 && hunterTeam.members.length === 2, 'one hunter team of 2');
  check(s.soloMode && s.teams.filter((t) => t.role === 'hider').length === 3, '3 hiders left -> solo mode with 3 individuals');
  check(s.spin?.order.length === 5, 'spin order covers everyone');

  const hunters = phones.filter((p) => p.role === 'hunter');
  const hiders = phones.filter((p) => p.role === 'hider');
  hunters[0].send({ t: 'teamName', name: 'The Wolves' });
  await sleep(200);
  check(host.state.teams.some((t) => t.name === 'The Wolves'), 'team can name itself');

  // walkie-talkie: teammates share a home channel, others can tune in and intercept
  const homeH = hunters[0].state.radio.home!;
  check(homeH >= 2 && hunters[1].state.radio.ch === homeH && hiders.every((h) => h.state.radio.ch !== homeH), `hunters share secret home channel ${homeH}`);
  hiders[0].send({ t: 'tune', ch: homeH }); // eavesdropper
  await sleep(200);
  hunters[0].send({ t: 'ptt', on: true });
  await sleep(150);
  hunters[0].ws.send(Buffer.alloc(480, 0x7f));
  hunters[0].ws.send(Buffer.alloc(480, 0x7f));
  await sleep(250);
  check(hunters[1].prompts.some((m) => m.t === 'rx' && m.on) && hunters[1].audio === 2, 'teammate receives key-up + voice frames');
  check(hiders[0].audio === 2, 'a player tuned to the channel intercepts the voice');
  check(hiders[1].audio === 0, 'players on other channels hear nothing');
  hunters[1].send({ t: 'ptt', on: true });
  await sleep(200);
  check(hunters[1].prompts.some((m) => m.t === 'pttDenied'), 'channel is busy while someone is talking');
  hunters[0].send({ t: 'ptt', on: false });
  hunters[0].send({ t: 'say', text: 'west side, by the park' });
  await sleep(250);
  check(hiders[0].chats.includes('west side, by the park'), 'channel text chat is interceptable too');
  hiders[0].send({ t: 'tune', ch: hiders[0].state.radio.home! });

  for (const p of phones) p.send({ t: 'ready', ready: true });
  await sleep(200);
  check(host.state.players.every((p) => p.ready), 'ready check shows everyone ready');

  host.send({ t: 'start' });
  await sleep(300);
  check(host.state.phase === 'freeze', 'match starts in freeze phase');

  // everyone reports positions; hunters stand at the origin, hiders spread out
  const posOf = new Map<Phone, [number, number]>();
  hunters.forEach((h, i) => posOf.set(h, [i * 2, 0]));
  hiders.forEach((h, i) => posOf.set(h, [150 + i * 60, 100]));
  const pump = setInterval(() => {
    for (const [p, [x, y]] of posOf) p.loc(x, y);
    for (const h of hunters) if (host.state.phase === 'freeze') h.send({ t: 'freeze', steps: 2, still: false, camOk: true });
  }, 1000);

  await sleep(2500);
  const ht = hiders[0].lastTick;
  check(!!ht && !ht.vis.some((v) => hunters.some((h) => h.id === v.id)), 'hiders cannot see hunters outside a ping');
  check(hunters[0].lastTick?.vis.some((v) => v.id === hunters[1].id && v.reason === 'team') ?? false, 'hunters see their teammate');

  await sleep(3000);
  check(host.state.phase === 'live', 'freeze ends and match goes live');

  // alliance between two solo hiders
  hiders[0].send({ t: 'allyReq', targetId: hiders[1].id });
  await sleep(300);
  const ap = hiders[1].prompts.find((m) => m.t === 'allyPrompt');
  check(!!ap, 'alliance request arrives');
  hiders[1].send({ t: 'allyReply', fromId: hiders[0].id, accept: true });
  await sleep(1500);
  check(hiders[0].lastTick.vis.some((v) => v.id === hiders[1].id && v.reason === 'ally'), 'allies see each other');

  // wait for the ping (15s interval, 5s warning)
  for (let i = 0; i < 20 && !hiders[2].warned; i++) await sleep(500);
  check(hiders[2].warned, 'fake-call warning arrives before the ping');
  for (let i = 0; i < 14 && !hiders[2].lastTick?.revealUntil; i++) await sleep(500);
  check(hiders[2].lastTick?.vis.some((v) => v.reason === 'ping' && hunters.some((h) => h.id === v.id)) ?? false, 'during a ping hiders can see hunters');

  // a hider walks out of bounds -> exposed, then DQ after grace
  posOf.set(hiders[2], [400, 400]);
  await sleep(4500);
  check(hiders[2].lastTick?.exposed === 'outside', 'leaving the area exposes you');
  check(hunters[0].lastTick.vis.some((v) => v.id === hiders[2].id && v.reason === 'outside'), 'others see the out-of-bounds player');
  await sleep(6000);
  check(host.state.players.find((p) => p.id === hiders[2].id)?.status === 'dq', 'staying outside gets you DQ\'d');

  // heartbeat + combat range: hunter walks up to hider 0
  const [hx, hy] = posOf.get(hiders[0])!;
  posOf.set(hunters[0], [hx - 50, hy]);
  await sleep(2500);
  check(hiders[0].lastTick.prox >= 2 && hiders[0].lastTick.prox <= 3, `heartbeat at 50 m (level ${hiders[0].lastTick.prox})`);
  posOf.set(hunters[0], [hx - 10, hy]);
  await sleep(2500);
  check(hiders[0].lastTick.prox === 5, 'heartbeat maxes out at 10 m');
  check(hunters[0].lastTick.targets.includes(hiders[0].id), 'hider is inside combat range (camera on)');

  // hit -> dispute -> vote
  hunters[0].send({ t: 'hit', targetId: hiders[0].id });
  await sleep(400);
  const tp = hiders[0].prompts.find((m) => m.t === 'tagPrompt') as Extract<ServerMsg, { t: 'tagPrompt' }>;
  check(!!tp, 'target gets a "were you hit?" prompt');
  hiders[0].send({ t: 'tagReply', tagId: tp.tag.id, accept: false });
  await sleep(400);
  const voters = phones.filter((p) => p.prompts.some((m) => m.t === 'votePrompt'));
  check(voters.length === 3, 'dispute sends a vote to the 3 uninvolved players');
  for (const v of voters) v.send({ t: 'vote', tagId: tp.tag.id, hit: true });
  for (let i = 0; i < 50 && host.state.players.find((p) => p.id === hiders[0].id)?.status !== 'caught'; i++) await sleep(500);
  check(host.state.players.find((p) => p.id === hiders[0].id)?.status === 'caught', 'majority vote counts the hit');
  check(host.state.endgame, 'one hider left -> ENDGAME');
  check(host.state.nextPingAt === null, 'endgame hides the next-ping timer (no warning)');

  // last hider tagged and accepts
  const [lx, ly] = posOf.get(hiders[1])!;
  posOf.set(hunters[1], [lx + 5, ly]);
  await sleep(2500);
  hunters[1].send({ t: 'hit', targetId: hiders[1].id });
  await sleep(400);
  const tp2 = hiders[1].prompts.find((m) => m.t === 'tagPrompt') as Extract<ServerMsg, { t: 'tagPrompt' }>;
  hiders[1].send({ t: 'tagReply', tagId: tp2.tag.id, accept: true });
  await sleep(600);
  check(host.state.phase === 'ended' && host.state.winner?.side === 'hunter', 'hunters win when everyone is caught');
  check(phones.every((p) => p.events.some((e) => /won in/.test(e))), 'everyone gets the win notification with the time');

  host.send({ t: 'history' });
  await sleep(400);
  const hist = host.prompts.find((m) => m.t === 'history') as Extract<ServerMsg, { t: 'history' }>;
  check(!!hist && hist.frames.length > 3, `replay history recorded (${hist?.frames.length} frames)`);

  // second match: hunter walks during the freeze -> automatic loss
  host.send({ t: 'reset' });
  host.send({ t: 'spin' });
  await sleep(300);
  host.send({ t: 'setSettings', settings: { freezeSeconds: 20 } });
  host.send({ t: 'start' });
  await sleep(500);
  const h2 = phones.find((p) => p.role === 'hunter')!;
  h2.send({ t: 'freeze', steps: 12, still: false, camOk: true });
  await sleep(500);
  check(host.state.phase === 'ended' && host.state.winner?.side === 'hider', 'hunter walking during the freeze = hiders win');

  // third match: ending early needs every player to vote yes
  host.send({ t: 'reset' });
  host.send({ t: 'spin' });
  await sleep(300);
  host.send({ t: 'start' });
  await sleep(400);
  phones[1].send({ t: 'voteEnd', yes: true });
  await sleep(300);
  check(!!host.state.endVote && host.state.endVote.needed.length === 5, 'a vote to end starts and needs all 5 players');
  for (const p of phones.slice(2)) p.send({ t: 'voteEnd', yes: true });
  await sleep(300);
  check(host.state.phase !== 'ended', 'match keeps going while one player has not voted');
  host.send({ t: 'voteEnd', yes: false });
  await sleep(300);
  check(!host.state.endVote && host.state.phase !== 'ended', 'one "no" cancels the vote');
  for (const p of phones) p.send({ t: 'voteEnd', yes: true });
  await sleep(500);
  check(host.state.phase === 'ended' && /voted/.test(host.events.join(' ')), 'unanimous vote ends the match');

  clearInterval(pump);
  phones.forEach((p) => p.ws.close());
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
