// Runs the real game server (server/src/room.ts) inside the page, plus six bot players,
// and routes the app's fetch/WebSocket calls to it. Nothing leaves the browser.
import { Room } from '../../../server/src/room';
import type { LatLng, PublicState, ServerMsg } from '../../../shared/protocol';
import { distM, pointInPolygon, centroid } from '../../../shared/geo';
import { O, toLL, toXY, streetPoints } from './basemap';
import { fitToStreets, setStreetSource } from '../map/AreaEditor';
import { lastFix, simMoveTo } from '../device/geo';
import { encodeFrame } from '../device/radio';
import { RADIO_FRAME, RADIO_RATE } from '../../../shared/protocol';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- fake Durable Object runtime ----------
class ServerSock {
  att: unknown;
  open = true;
  constructor(private deliver: (s: string) => void, private onClose: () => void) {}
  serializeAttachment(a: unknown) { this.att = a; }
  deserializeAttachment() { return this.att; }
  send(s: string | ArrayBuffer) { if (this.open) setTimeout(() => this.open && this.deliver(s as string), 0); }
  close() { if (!this.open) return; this.open = false; this.onClose(); }
}
const socks: ServerSock[] = [];
let alarm: ReturnType<typeof setTimeout> | undefined;
let ready: Promise<void> = Promise.resolve();
const ctx = {
  storage: {
    get: async () => undefined,
    put: async () => {},
    setAlarm: async (t: number) => { clearTimeout(alarm); alarm = setTimeout(() => void room.alarm(), Math.max(0, t - Date.now())); },
    deleteAlarm: async () => clearTimeout(alarm),
  },
  blockConcurrencyWhile: (fn: () => Promise<void>) => (ready = fn()),
  acceptWebSocket: (s: ServerSock) => socks.push(s),
  getWebSockets: () => socks.filter((s) => s.open),
};

/** Lets the visitor choose their role: the spin is still random for everyone else. */
class DemoRoom extends Room {
  prefer: 'hunter' | 'hider' | null = 'hider';
  userId = '';
  spinTeams(now: number) {
    super.spinTeams(now);
    const g = this.g!;
    const mine = g.teams.find((t) => t.members.includes(this.userId));
    if (!this.prefer || !mine || mine.role === this.prefer) return;
    const other = g.teams.find((t) => t.role === this.prefer && t.members.length)!;
    const swapWith = other.members[0];
    mine.members = mine.members.map((id) => (id === this.userId ? swapWith : id));
    other.members = other.members.map((id) => (id === swapWith ? this.userId : id));
    for (const p of g.players) p.teamId = g.teams.find((t) => t.members.includes(p.id))?.id ?? null;
    if (g.soloMode) for (const t of g.teams) if (t.role === 'hider') t.name = this.name(t.members[0]);
    g.spin = { at: now, order: g.teams.flatMap((t) => t.members) };
    this.assignChannels(); // keep everyone on their (new) team's channel
  }
}
const room = new DemoRoom(ctx as Any, {});
export const demoRoom = room;

async function join(pid: string, name: string, deliver: (s: string) => void) {
  await ready;
  const g = room.g;
  if (!g) throw new Error('no party');
  let p = g.players.find((x) => x.id === pid);
  if (!p) {
    if (g.phase !== 'lobby' && g.phase !== 'teams') throw new Error('started');
    p = room.newPlayer(pid, name, 'demo');
    g.players.push(p);
    room.event('join', `${p.name} joined`);
  }
  const s: ServerSock = new ServerSock(deliver, () => void room.webSocketClose(s as Any));
  ctx.acceptWebSocket(s);
  s.serializeAttachment({ pid });
  room.broadcastState();
  return s;
}
const toRoom = (s: ServerSock, m: object) => void room.webSocketMessage(s as Any, JSON.stringify(m));

// ---------- fetch + WebSocket routed to the in-page server ----------
const CODE = 'HUNT5';
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/api/create')) {
    await ready;
    const { hostId } = JSON.parse(String(init?.body ?? '{}'));
    room.userId = hostId;
    if (!room.g) createParty(hostId);
    return new Response(JSON.stringify({ code: CODE }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/party/')) return new Response(JSON.stringify({ exists: !!room.g, phase: room.g?.phase }));
  return realFetch(input, init);
};

class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private srv: ServerSock | null = null;
  constructor(url: string) {
    const u = new URL(url, location.href);
    join(u.searchParams.get('pid')!, u.searchParams.get('name') ?? 'You', (s) => this.onmessage?.({ data: s }))
      .then((srv) => { this.srv = srv; this.readyState = 1; this.onopen?.({}); })
      .catch(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); });
  }
  send(s: string) { if (this.srv) void room.webSocketMessage(this.srv as Any, s); }
  close() { this.readyState = 3; this.srv?.close(); this.onclose?.({ code: 1000 }); }
}
(window as Any).WebSocket = FakeWS;

// ---------- party setup ----------
setStreetSource(async () => streetPoints());
const BOT_NAMES = ['Maya', 'Jay', 'Theo', 'Rin', 'Omar', 'Priya'];

function createParty(hostId: string) {
  room.g = room.newGame(CODE, hostId);
  Object.assign(room.g.settings, {
    matchMinutes: 15, pingMinutes: 1.5, warnSeconds: 10, revealSeconds: 10, freezeSeconds: 20,
    campMinutes: 3, outsideGraceSeconds: 30, endgameMinutes: 4, endgameRevealEveryMinutes: 1,
    mods: true, modStartPoints: 3, orbCount: 8,
  });
  void fitToStreets(O, 270).then((polygon) => {
    if (!room.g || room.g.area) return;
    room.g.area = { polygon, center: centroid(polygon), radiusM: 270 };
    room.broadcastState();
  });
  BOT_NAMES.forEach((n, i) => setTimeout(() => void addBot(n, i), 600 + i * 450));
}

// ---------- bots ----------
type Bot = {
  id: string; name: string; sock: ServerSock; s: PublicState | null; tick: Extract<ServerMsg, { t: 'tick' }> | null;
  x: number; y: number; heading: number; lastHit: number; chaseUser: boolean;
};
const bots: Bot[] = [];

async function addBot(name: string, i: number) {
  const a = (i / BOT_NAMES.length) * Math.PI * 2;
  const bot: Bot = { id: 'bot' + i, name, sock: null as Any, s: null, tick: null, x: Math.cos(a) * 90, y: Math.sin(a) * 60, heading: a, lastHit: 0, chaseUser: false };
  bot.sock = await join(bot.id, name, (raw) => {
    if (typeof raw !== 'string') return; // radio audio: bots don't listen
    const m = JSON.parse(raw) as ServerMsg;
    if (m.t === 'state') {
      bot.s = m.s;
      const v = m.s.endVote;
      if (v && !v.yes.includes(bot.id)) setTimeout(() => toRoom(bot.sock, { t: 'voteEnd', yes: true }), 1500 + Math.random() * 4000);
    }
    else if (m.t === 'tick') bot.tick = m;
    else if (m.t === 'tagPrompt') setTimeout(() => toRoom(bot.sock, { t: 'tagReply', tagId: m.tag.id, accept: true }), 1800);
    else if (m.t === 'votePrompt') setTimeout(() => toRoom(bot.sock, { t: 'vote', tagId: m.tag.id, hit: true }), 1500);
    else if (m.t === 'orb') setTimeout(() => toRoom(bot.sock, { t: 'roll', reroll: m.roll.tier === 'D' && m.rerollsLeft > 0 }), 1500);
    else if (m.t === 'allyPrompt') setTimeout(() => toRoom(bot.sock, { t: 'allyReply', fromId: m.fromId, accept: true }), 1500);
    else if ((m.t === 'chat' || (m.t === 'rx' && !m.on)) && m.from === room.userId && isTeammate(bot.id, room.userId)) replyToUser(bot, m.t === 'chat' ? m.text : null);
  });
  bots.push(bot);
}

const posOf = (id: string): LatLng | null => {
  if (id === room.userId) return lastFix();
  return room.g?.players.find((p) => p.id === id)?.pos ?? null;
};
const roleOf = (id: string) => room.g?.teams.find((t) => t.members.includes(id))?.role;

setInterval(() => {
  const g = room.g;
  if (!g || (g.phase !== 'teams' && g.phase !== 'freeze' && g.phase !== 'live')) return;
  const area = g.area?.polygon;
  for (const b of bots) {
    const me = g.players.find((p) => p.id === b.id);
    if (!me) continue;
    const role = roleOf(b.id);
    if (me.status === 'active' && g.phase !== 'teams' && !(g.phase === 'freeze' && role === 'hunter')) {
      let speed = 1.3;
      if (role === 'hider') {
        speed = g.phase === 'freeze' ? 3.2 : 1.1;
        b.heading += (Math.random() - 0.5) * 0.8;
      } else {
        // hunters head for a hider (or the visitor, when asked)
        const prey = b.chaseUser && roleOf(room.userId) === 'hider' && g.players.find((p) => p.id === room.userId)?.status === 'active'
          ? room.userId
          : g.players.filter((p) => roleOf(p.id) === 'hider' && p.status === 'active' && p.id !== room.userId && p.pos)
              .sort((p, q) => distM(posOf(b.id) ?? O, p.pos!) - distM(posOf(b.id) ?? O, q.pos!))[0]?.id;
        const tp = prey ? posOf(prey) : null;
        if (tp) { const [tx, ty] = toXY(tp); b.heading = Math.atan2(ty - b.y, tx - b.x); speed = b.chaseUser ? 2.6 : 1.4; }
      }
      let nx = b.x + Math.cos(b.heading) * speed, ny = b.y + Math.sin(b.heading) * speed;
      if (area && !pointInPolygon(toLL(nx, ny), area)) { b.heading = Math.atan2(-b.y, -b.x) + (Math.random() - 0.5); nx = b.x; ny = b.y; }
      b.x = nx; b.y = ny;
    }
    toRoom(b.sock, { t: 'loc', ...toLL(b.x, b.y), acc: 6, at: Date.now() });
    if (g.phase === 'freeze' && role === 'hunter') toRoom(b.sock, { t: 'freeze', steps: 0, still: false, camOk: true });
    if (g.phase === 'live' && role === 'hunter' && b.tick?.targets.length && Date.now() - b.lastHit > 9000) {
      b.lastHit = Date.now();
      setTimeout(() => toRoom(b.sock, { t: 'hit', targetId: b.tick!.targets[0] }), 1200);
    }
  }
}, 1000);

// ---------- bot radio chatter ----------
const VOWELS: [number, number][] = [[730, 1090], [270, 2290], [530, 1840], [570, 840], [440, 1020], [300, 870], [660, 1720]];
/** Voice-like mumble: a pitched buzz through moving formants, chopped into syllables. */
function babble(seconds: number): Int16Array {
  const n = Math.floor(seconds * RADIO_RATE);
  const out = new Int16Array(n);
  const f0base = 95 + Math.random() * 45;
  let phase = 0, t = 0;
  const res = [{ y1: 0, y2: 0 }, { y1: 0, y2: 0 }];
  let syl = 0, sylLen = 0, gap = 0, v: [number, number] = VOWELS[0];
  for (let i = 0; i < n; i++, t++) {
    if (t >= sylLen + gap) { t = 0; syl++; sylLen = Math.floor(RADIO_RATE * (0.09 + Math.random() * 0.15)); gap = Math.random() < 0.25 ? Math.floor(RADIO_RATE * (0.08 + Math.random() * 0.2)) : Math.floor(RADIO_RATE * 0.02); v = VOWELS[Math.floor(Math.random() * VOWELS.length)]; }
    const inSyl = t < sylLen;
    const env = inSyl ? Math.sin((Math.PI * t) / sylLen) ** 0.6 : 0;
    const f0 = f0base * (1.15 - 0.25 * (t / Math.max(1, sylLen))) * (1 + 0.04 * Math.sin(syl));
    phase += f0 / RADIO_RATE;
    if (phase >= 1) phase -= 1;
    let x = (phase < 0.08 ? 1 : -0.08) + (t < 160 && inSyl ? (Math.random() - 0.5) * 0.8 : 0);
    let y = 0;
    v.forEach((f, k) => {
      const r = 0.94, w = (2 * Math.PI * f) / RADIO_RATE;
      const yk = x * (1 - r) + 2 * r * Math.cos(w) * res[k].y1 - r * r * res[k].y2;
      res[k].y2 = res[k].y1; res[k].y1 = yk;
      y += yk * (k ? 0.6 : 1);
    });
    out[i] = Math.max(-32767, Math.min(32767, y * env * 52000));
  }
  return out;
}

const busyBots = new Set<string>();
function transmit(b: Bot, seconds: number, text?: string) {
  if (busyBots.has(b.id) || room.g?.talkers[room.g.players.find((p) => p.id === b.id)?.channel ?? 0]) return;
  busyBots.add(b.id);
  const pcm = babble(seconds);
  toRoom(b.sock, { t: 'ptt', on: true });
  let k = 0;
  const id = setInterval(() => {
    if (k * RADIO_FRAME >= pcm.length) {
      clearInterval(id);
      toRoom(b.sock, { t: 'ptt', on: false });
      busyBots.delete(b.id);
      if (text) setTimeout(() => toRoom(b.sock, { t: 'say', text }), 500);
      return;
    }
    const frame = encodeFrame(pcm.subarray(k * RADIO_FRAME, (k + 1) * RADIO_FRAME));
    k++;
    void room.webSocketMessage(b.sock as Any, frame.buffer as ArrayBuffer);
  }, 60);
}

const isTeammate = (a: string, b: string) => !!room.g?.teams.find((t) => t.members.includes(a) && t.members.includes(b));
const LINES_HIDE = ['Moving to the north side', 'Behind the blue house', 'All quiet here', 'Hunter by the park, stay low', 'Heading your way', 'In the bushes by the corner'];
const LINES_HUNT = ['Sweeping the east loop', 'Lost them near the cul-de-sac', 'Check the backyards', 'I’ll cut through the middle', 'Ping is soon, get ready'];
const REPLIES: Record<string, string> = {
  'Where are you?': 'By the houses on the north loop',
  'Hunter near me': 'Run toward the park, I’ll cover',
  'On the move': 'Copy, moving too',
  'Hiding': 'Stay put till the ping',
  'Meet at the marker': 'On my way to the marker',
  'Copy that': 'Over and out',
};
function replyToUser(b: Bot, said: string | null) {
  const text = said ? REPLIES[said] ?? 'Copy that' : 'Copy that';
  setTimeout(() => transmit(b, 1.4 + Math.random(), text), 1800);
}
setInterval(() => {
  const g = room.g;
  if (!g || (g.phase !== 'live' && g.phase !== 'freeze') || Math.random() > 0.35) return;
  const b = bots[Math.floor(Math.random() * bots.length)];
  const me = g.players.find((p) => p.id === b?.id);
  if (!b || !me || me.status !== 'active') return;
  const lines = roleOf(b.id) === 'hunter' ? LINES_HUNT : LINES_HIDE;
  transmit(b, 1.5 + Math.random() * 1.8, Math.random() < 0.7 ? lines[Math.floor(Math.random() * lines.length)] : undefined);
}, 9000);

// bots occasionally use powers
setInterval(() => {
  const g = room.g;
  if (!g?.settings.mods || g.phase !== 'live') return;
  for (const b of bots) {
    const p = g.players.find((x) => x.id === b.id);
    if (!p || p.status !== 'active' || p.mod.points < 1 || Math.random() > 0.08) continue;
    const role = roleOf(b.id);
    const pick = role === 'hunter' ? 'trace' : (['vanish', 'shield', 'zone'] as const)[Math.floor(Math.random() * 3)];
    toRoom(b.sock, { t: 'use', ability: pick });
  }
}, 10_000);

// ---------- demo controls ----------
let walking: ReturnType<typeof setInterval> | undefined;
function walkMeTo(target: LatLng, seconds = 6) {
  const from = lastFix() ?? O;
  clearInterval(walking);
  let k = 0;
  const n = seconds * 4;
  walking = setInterval(() => {
    k++;
    simMoveTo(from.lat + ((target.lat - from.lat) * k) / n, from.lng + ((target.lng - from.lng) * k) / n);
    if (k >= n) clearInterval(walking);
  }, 250);
}

export const demo = {
  setPrefer(r: 'hunter' | 'hider') { room.prefer = r; },
  get prefer() { return room.prefer; },
  pingNow() {
    const g = room.g;
    if (!g || (g.phase !== 'live' && g.phase !== 'freeze')) return;
    if (g.endgame) g.nextEndgameRevealAt = Date.now();
    else { g.nextPingAt = Date.now() + g.settings.warnSeconds * 1000 + 300; g.warnedFor = null; room.broadcastState(); }
  },
  skipFreeze() { if (room.g?.phase === 'freeze') room.g.freezeEndsAt = Date.now(); },
  chaseMe() {
    const h = bots.filter((b) => roleOf(b.id) === 'hunter');
    h.forEach((b, i) => (b.chaseUser = i === 0));
    if (h[0]) { const me = lastFix() ?? O; const [x, y] = toXY(me); h[0].x = x + 90; h[0].y = y + 40; }
  },
  walkToHider() {
    const me = lastFix() ?? O;
    const t = room.g?.players.filter((p) => roleOf(p.id) === 'hider' && p.status === 'active' && p.pos && p.id !== room.userId)
      .sort((a, b) => distM(me, a.pos!) - distM(me, b.pos!))[0];
    if (t?.pos) walkMeTo({ lat: t.pos.lat + 0.00003, lng: t.pos.lng }, Math.min(8, Math.max(3, distM(me, t.pos) / 15)));
  },
  walkOut() {
    const a = room.g?.area;
    if (!a) return;
    const [cx, cy] = toXY(a.center);
    walkMeTo(toLL(cx + a.radiusM + 60, cy), 5);
  },
  walkHome() { walkMeTo(room.g?.area?.center ?? O, 5); },
  /** Drop an orb a few steps away from you. */
  orbNearMe() {
    const g = room.g;
    if (!g || !g.settings.mods) return;
    const me = lastFix() ?? O;
    const [x, y] = toXY(me);
    g.orbs.push({ id: 'demo' + Date.now(), ...toLL(x + 30, y + 10) });
    room.broadcastState();
  },
  givePoints() {
    const p = room.g?.players.find((x) => x.id === room.userId);
    if (!p) return;
    p.mod.points += 5;
    room.broadcastState();
  },
  /** Make a teammate key up right now. */
  teammateTalk() {
    const b = bots.find((x) => isTeammate(x.id, room.userId)) ?? bots[0];
    if (b) transmit(b, 2.2, 'Hunter spotted by the park, heading north');
  },
};
