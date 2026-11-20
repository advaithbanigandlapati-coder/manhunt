import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_SETTINGS, HUNTER_COLOR, TEAM_COLORS, proxLevel,
  type Area, type ClientMsg, type GameEvent, type HistoryFrame, type LatLng, type Marker, type Phase,
  type PlayerStatus, type PublicState, type EndVote, RADIO_CHANNELS,
  ABILITIES, ABILITY_MINUTES, ORB_TIERS, MAX_REROLLS, ORB_PICKUP_M, SAFE_ZONE_M, SAFE_ZONE_CHARGE_MS,
  BOUNTY_MS, BOUNTY_EVERY_MS, BOUNTY_FLASH_MS, BOUNTY_MIN_POINTS,
  type AbilityId, type ModState, type Orb, type Roll, type ServerMsg, type Settings, type TagClaim, type Team,
  type VisReason, type VisiblePlayer, type Winner,
} from '../../shared/protocol';
import { distM, distToEdgeM, pointInPolygon } from '../../shared/geo';

type Pos = { lat: number; lng: number; acc: number; at: number };

type PlayerRec = {
  id: string;
  name: string;
  secretHash: string;
  teamId: string | null;
  status: PlayerStatus;
  allianceId: string | null;
  pos: Pos | null;
  lastLocAt: number;
  camp: { lat: number; lng: number; since: number } | null;
  outCount: number;
  outSince: number | null;
  freezeAnchor: LatLng | null;
  freezeOutCount: number;
  camBadSince: number | null;
  stillWarned: boolean;
  announced: Partial<Record<VisReason, boolean>>;
  ready: boolean;
  channel: number;
  lastSeen: number;
  mod: ModRec;
};

/** A player's mod state: points, rerolls, active effects, safe zones. */
type ModRec = Omit<ModState, 'decoy'> & { decoy: LatLng | null; bountyAt: number };

type Game = {
  code: string;
  hostId: string;
  phase: Phase;
  players: PlayerRec[];
  teams: Team[];
  settings: Settings;
  area: Area | null;
  soloMode: boolean;
  spin: { at: number; order: string[] } | null;
  startedAt: number | null;
  freezeEndsAt: number | null;
  endsAt: number | null;
  nextPingAt: number | null;
  warnedFor: number | null;
  revealUntil: number | null;
  endgame: boolean;
  nextEndgameRevealAt: number | null;
  initialHiderTeams: number;
  winner: Winner | null;
  markers: Marker[];
  events: GameEvent[];
  tags: (TagClaim & { stage: 'confirm' | 'vote'; deadline: number })[];
  allyReqs: { from: string; to: string; at: number }[];
  lastHistAt: number;
  lastSaveAt: number;
  endVote: EndVote | null;
  talkers: Record<number, { talker: string; since: number }>;
  homes: Record<string, number>; // teamId -> home channel
  orbs: Orb[];
  lastOrbAt: number;
};

type Att = { pid: string };

const MAX_PLAYERS = 30;
const TAG_TIMEOUT_MS = 20_000;
const rid = () => crypto.randomUUID().slice(0, 8);
const clampStr = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const SETTING_RANGES: { [K in keyof Settings]?: [number, number] } = {
  matchMinutes: [1, 480], pingMinutes: [0.25, 60], warnSeconds: [3, 60], revealSeconds: [3, 60],
  freezeSeconds: [0, 900], freezeMaxSteps: [0, 50], freezeRadiusM: [5, 60], campMinutes: [0.25, 30],
  modStartPoints: [0, 10], orbCount: [0, 30], campRadiusM: [10, 60], outsideGraceSeconds: [5, 600], darkSeconds: [10, 600], soloThreshold: [0, 10],
  hunterTeams: [1, 5], endgameMinutes: [0.5, 90], endgameRevealEveryMinutes: [0.1, 15],
  endgameRevealSeconds: [1, 30], combatRangeM: [10, 80],
};

async function sha(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function shuffle<T>(a: T[]): T[] {
  const r = new Uint32Array(a.length);
  crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Room extends DurableObject {
  g: Game | null = null;
  hist: HistoryFrame[] = [];

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => {
      this.g = (await ctx.storage.get<Game>('g')) ?? null;
      if (this.g) {
        this.g.talkers ??= {}; this.g.homes ??= {}; this.g.endVote ??= null; this.g.orbs ??= []; this.g.lastOrbAt ??= 0;
        this.g.settings = { ...DEFAULT_SETTINGS, ...this.g.settings };
        for (const p of this.g.players) p.mod ??= this.freshMod(0);
      }
      this.hist = (await ctx.storage.get<HistoryFrame[]>('hist')) ?? [];
    });
  }

  // ---------- HTTP entry ----------
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/init')) {
      if (this.g) return new Response('exists', { status: 409 });
      const { code, hostId } = (await req.json()) as { code: string; hostId: string };
      this.g = this.newGame(code, hostId);
      await this.save();
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/exists')) return Response.json({ exists: !!this.g, phase: this.g?.phase });

    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const g = this.g;
    if (!g) return new Response('no such party', { status: 404 });
    const pid = clampStr(url.searchParams.get('pid'), 64);
    const secret = url.searchParams.get('secret') ?? '';
    const name = clampStr(url.searchParams.get('name'), 20) || 'Player';
    if (!pid || secret.length < 16) return new Response('bad identity', { status: 400 });

    const hash = await sha(secret);
    let p = g.players.find((x) => x.id === pid);
    if (p) {
      if (p.secretHash !== hash) return new Response('identity mismatch', { status: 403 });
    } else {
      if (g.phase !== 'lobby' && g.phase !== 'teams') return new Response('match already started', { status: 409 });
      if (g.players.length >= MAX_PLAYERS) return new Response('party full', { status: 409 });
      p = this.newPlayer(pid, name, hash);
      g.players.push(p);
      this.event('join', `${p.name} joined`);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid } satisfies Att);
    await this.save();
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- WebSocket handlers ----------
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const g = this.g;
    if (!g) return;
    const { pid } = ws.deserializeAttachment() as Att;
    const p = g.players.find((x) => x.id === pid);
    if (!p) return ws.close(4000, 'removed');
    p.lastSeen = Date.now();
    if (typeof raw !== 'string') return this.onAudio(p, raw);
    if (raw.length > 20_000) return;
    let m: ClientMsg;
    try { m = JSON.parse(raw); } catch { return; }
    const isHost = pid === g.hostId;
    const err = (msg: string) => this.send(ws, { t: 'error', msg });
    const now = Date.now();

    switch (m.t) {
      case 'loc': return this.onLoc(p, m, now);
      case 'freeze': return this.onFreezeReport(p, m, now);
      case 'rename':
        if (g.phase !== 'lobby' && g.phase !== 'teams') return;
        p.name = clampStr(m.name, 20) || p.name;
        break;
      case 'setArea':
        if (!isHost) return err('Only the host can set the area');
        if (g.phase !== 'lobby' && g.phase !== 'teams') return;
        if (!Array.isArray(m.area?.polygon) || m.area.polygon.length < 3 || m.area.polygon.length > 400) return err('Bad area');
        g.area = {
          polygon: m.area.polygon.map((q) => ({ lat: +q.lat, lng: +q.lng })).filter((q) => isFinite(q.lat) && isFinite(q.lng)),
          center: { lat: +m.area.center.lat, lng: +m.area.center.lng },
          radiusM: +m.area.radiusM || 0,
        };
        break;
      case 'setSettings':
        if (!isHost) return err('Only the host can change settings');
        if (g.phase !== 'lobby' && g.phase !== 'teams') return;
        this.applySettings(m.settings);
        break;
      case 'spin':
        if (!isHost) return err('Only the host can spin');
        if (g.phase !== 'lobby' && g.phase !== 'teams') return;
        if (g.players.length < 2) return err('Need at least 2 players');
        this.spinTeams(now);
        break;
      case 'teamName': {
        const t = g.teams.find((x) => x.id === p.teamId);
        if (!t || g.phase === 'ended') return;
        t.name = clampStr(m.name, 24) || t.name;
        break;
      }
      case 'start':
        if (!isHost) return err('Only the host can start');
        if (g.phase !== 'teams') return err('Spin teams first');
        if (!g.area) return err('Set the play area first');
        if (!g.teams.some((t) => t.role === 'hunter') || !g.teams.some((t) => t.role === 'hider')) return err('Need hunters and hiders');
        this.startMatch(now);
        break;
      case 'hit': return this.onHit(p, m.targetId, now, err);
      case 'tagReply': return this.onTagReply(p, m.tagId, m.accept, now);
      case 'vote': {
        const tag = g.tags.find((x) => x.id === m.tagId && x.stage === 'vote');
        if (!tag || pid === tag.hunterId || pid === tag.targetId) return;
        tag.votes = { ...tag.votes, [pid]: !!m.hit };
        return;
      }
      case 'allyReq': {
        const t = g.players.find((x) => x.id === m.targetId);
        if (!g.soloMode || !t || t.id === p.id || this.roleOf(p) !== 'hider' || this.roleOf(t) !== 'hider') return;
        if (g.phase !== 'freeze' && g.phase !== 'live' && g.phase !== 'teams') return;
        g.allyReqs = g.allyReqs.filter((r) => !(r.from === p.id && r.to === t.id));
        g.allyReqs.push({ from: p.id, to: t.id, at: now });
        this.sendTo(t.id, { t: 'allyPrompt', fromId: p.id });
        return;
      }
      case 'allyReply': {
        const req = g.allyReqs.find((r) => r.from === m.fromId && r.to === p.id);
        g.allyReqs = g.allyReqs.filter((r) => r !== req);
        const from = g.players.find((x) => x.id === m.fromId);
        if (!req || !from || !m.accept) return;
        const aid = from.allianceId ?? p.allianceId ?? rid();
        for (const x of g.players) if (x.allianceId && (x.allianceId === from.allianceId || x.allianceId === p.allianceId)) x.allianceId = aid;
        from.allianceId = aid;
        p.allianceId = aid;
        this.event('alliance', `${from.name} and ${p.name} formed an alliance`);
        break;
      }
      case 'allyLeave': {
        const aid = p.allianceId;
        if (!aid) return;
        p.allianceId = null;
        const rest = g.players.filter((x) => x.allianceId === aid);
        if (rest.length < 2) rest.forEach((x) => (x.allianceId = null));
        this.event('alliance', `${p.name} broke their alliance`);
        break;
      }
      case 'marker':
        if (!p.teamId) return;
        if (m.op === 'add') {
          if (g.markers.filter((x) => x.teamId === p.teamId).length >= 30) return err('Marker limit reached');
          g.markers.push({ id: rid(), teamId: p.teamId, lat: +m.lat, lng: +m.lng, label: clampStr(m.label, 30) || 'Spot', by: p.id });
        } else {
          g.markers = g.markers.filter((x) => !(x.id === m.id && x.teamId === p.teamId));
        }
        break;
      case 'kick': {
        if (!isHost || m.playerId === g.hostId) return;
        if (g.phase !== 'lobby' && g.phase !== 'teams' && g.phase !== 'ended') return err('Players can only be removed between matches');
        const k = g.players.find((x) => x.id === m.playerId);
        if (!k) return;
        g.players = g.players.filter((x) => x !== k);
        g.teams.forEach((t) => (t.members = t.members.filter((id) => id !== k.id)));
        for (const s of this.ctx.getWebSockets()) if ((s.deserializeAttachment() as Att).pid === k.id) s.close(4001, 'kicked');
        this.event('leave', `${k.name} was removed`);
        this.checkOutcome(now);
        break;
      }
      case 'reset':
        if (!isHost) return;
        this.resetToLobby();
        break;
      case 'ready':
        if (g.phase !== 'lobby' && g.phase !== 'teams') return;
        p.ready = !!m.ready;
        break;
      case 'voteEnd':
        this.onVoteEnd(p, !!m.yes, now);
        break;
      case 'tune': return this.onTune(p, Math.round(+m.ch));
      case 'ptt': return this.onPtt(p, !!m.on, now);
      case 'say': {
        const text = clampStr(m.text, 140);
        if (!text) return;
        this.toChannel(p.channel, { t: 'chat', ch: p.channel, from: p.id, text, at: now });
        return;
      }
      case 'use':
        if (!this.onUse(p, m, now, err)) return;
        break;
      case 'roll': return this.onRoll(p, !!m.reroll, now);
      case 'history':
        return this.send(ws, { t: 'history', frames: this.hist, events: g.events });
      default:
        return;
    }
    await this.save();
    this.broadcastState();
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* already closed */ }
    const pid = (ws.deserializeAttachment() as Att | null)?.pid;
    const p = pid ? this.g?.players.find((x) => x.id === pid) : null;
    if (p && !this.isConnected(p.id)) this.onPtt(p, false, Date.now());
    this.broadcastState();
  }

  // ---------- walkie-talkie ----------
  /** Everyone tuned to a channel (except, optionally, one player). */
  listeners(ch: number, except?: string) {
    return this.ctx.getWebSockets().filter((ws) => {
      const pid = (ws.deserializeAttachment() as Att).pid;
      return pid !== except && this.g!.players.find((x) => x.id === pid)?.channel === ch;
    });
  }
  toChannel(ch: number, m: ServerMsg, except?: string) {
    const s = JSON.stringify(m);
    for (const ws of this.listeners(ch, except)) try { ws.send(s); } catch { /* closed */ }
  }
  onTune(p: PlayerRec, ch: number) {
    if (!(ch >= 1 && ch <= RADIO_CHANNELS) || ch === p.channel) return;
    this.onPtt(p, false, Date.now());
    p.channel = ch;
    const cur = this.g!.talkers[ch];
    if (cur && this.isConnected(cur.talker)) this.sendTo(p.id, { t: 'rx', ch, from: cur.talker, on: true });
    this.sendTo(p.id, { t: 'state', s: this.publicState(p.id) });
  }
  onPtt(p: PlayerRec, on: boolean, now: number) {
    const g = this.g!;
    const ch = p.channel;
    const cur = g.talkers[ch];
    if (on) {
      if (cur && cur.talker !== p.id && this.isConnected(cur.talker) && now - cur.since < 45_000) {
        return this.sendTo(p.id, { t: 'pttDenied', talker: cur.talker });
      }
      g.talkers[ch] = { talker: p.id, since: now };
      this.toChannel(ch, { t: 'rx', ch, from: p.id, on: true }, p.id);
    } else if (cur?.talker === p.id) {
      delete g.talkers[ch];
      this.toChannel(ch, { t: 'rx', ch, from: p.id, on: false }, p.id);
    }
  }
  /** Binary frames are mu-law voice; relay them to everyone else on the talker's channel. */
  onAudio(p: PlayerRec, buf: ArrayBuffer) {
    const g = this.g!;
    if (buf.byteLength > 4096 || g.talkers[p.channel]?.talker !== p.id) return;
    for (const ws of this.listeners(p.channel, p.id)) try { ws.send(buf); } catch { /* closed */ }
  }

  // ---------- ending early ----------
  votersNeeded(now: number) {
    return this.g!.players.filter((p) => this.isConnected(p.id) || now - p.lastSeen < 180_000).map((p) => p.id);
  }
  onVoteEnd(p: PlayerRec, yes: boolean, now: number) {
    const g = this.g!;
    if (g.phase !== 'freeze' && g.phase !== 'live') return;
    if (!g.endVote) {
      if (!yes) return;
      g.endVote = { by: p.id, startedAt: now, expiresAt: now + 180_000, yes: [p.id], needed: this.votersNeeded(now) };
      this.event('vote', `${p.name} wants to end the match. Everyone has to vote yes.`, true);
    } else if (yes) {
      if (!g.endVote.yes.includes(p.id)) g.endVote.yes.push(p.id);
    } else {
      g.endVote = null;
      this.event('vote', `Vote failed: ${p.name} wants to keep playing`);
    }
    this.checkEndVote(now);
  }
  checkEndVote(now: number) {
    const g = this.g!;
    const v = g.endVote;
    if (!v) return;
    v.needed = this.votersNeeded(now);
    if (v.needed.every((id) => v.yes.includes(id))) {
      g.endVote = null;
      this.finish(now, null, 'Everyone voted to end the match');
    } else if (now > v.expiresAt) {
      g.endVote = null;
      this.event('vote', 'The vote to end the match expired');
      this.broadcastState();
    }
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws); }

  // ---------- game clock ----------
  async alarm() {
    const g = this.g;
    if (!g || (g.phase !== 'freeze' && g.phase !== 'live')) return;
    this.tick(Date.now());
    if (g.phase === 'freeze' || g.phase === 'live') await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  tick(now: number) {
    const g = this.g!;
    const s = g.settings;
    let stateDirty = false;

    // freeze end
    if (g.phase === 'freeze' && g.freezeEndsAt && now >= g.freezeEndsAt) {
      g.phase = 'live';
      for (const p of this.hunters()) p.camp = null;
      this.event('freeze-over', 'Hunters released.', true);
      stateDirty = true;
    }
    if (g.phase === 'freeze') {
      for (const p of this.hunters()) {
        if (p.camBadSince && now - p.camBadSince > 8000) return this.hunterViolation(p, 'covered their camera during the freeze', now);
      }
    }

    // regular pings
    if (!g.endgame && g.nextPingAt) {
      if (now >= g.nextPingAt - s.warnSeconds * 1000 && g.warnedFor !== g.nextPingAt) {
        g.warnedFor = g.nextPingAt;
        this.broadcast({ t: 'warn', pingAt: g.nextPingAt });
      }
      if (now >= g.nextPingAt) {
        g.revealUntil = now + s.revealSeconds * 1000;
        g.nextPingAt += s.pingMinutes * 60_000;
        this.event('info', 'Location ping. Everyone is visible.');
        if (s.mods) this.assignBounty(now);
        stateDirty = true;
      }
    }
    // endgame reveals (no warning)
    if (g.endgame && g.nextEndgameRevealAt && now >= g.nextEndgameRevealAt) {
      g.revealUntil = now + s.endgameRevealSeconds * 1000;
      g.nextEndgameRevealAt += s.endgameRevealEveryMinutes * 60_000;
    }

    // per-player exposure checks
    for (const p of g.players) {
      if (p.status !== 'active') continue;
      if (p.outSince && now - p.outSince > s.outsideGraceSeconds * 1000) {
        p.status = 'dq';
        this.event('dq', `${p.name} was disqualified for leaving the area`, true);
        stateDirty = true;
        continue;
      }
      const why = this.exposure(p, now);
      if (why && !p.announced[why]) {
        p.announced[why] = true;
        const txt = why === 'camping' ? `${p.name} stayed put too long. Location exposed.`
          : why === 'outside' ? `${p.name} left the play area. Location exposed.`
          : `${p.name} went dark. Showing their last known spot.`;
        this.event(why === 'camping' ? 'camping' : why === 'outside' ? 'outside' : 'dark', txt);
      }
      if (!why) p.announced = {};
    }

    // mods: orbs, safe zone charge, bounty expiry, unclaimed rolls
    if (s.mods && this.modTick(now)) stateDirty = true;

    // end vote + stuck transmitters
    if (g.endVote) { this.checkEndVote(now); if (g.phase === 'ended') return; }
    for (const [ch, t] of Object.entries(g.talkers)) {
      if (now - t.since > 45_000 || !this.isConnected(t.talker)) {
        delete g.talkers[+ch];
        this.toChannel(+ch, { t: 'rx', ch: +ch, from: t.talker, on: false });
      }
    }

    // pending tags
    for (const tag of [...g.tags]) {
      if (now < tag.deadline) continue;
      g.tags = g.tags.filter((x) => x !== tag);
      if (tag.stage === 'confirm') this.catchPlayer(tag.targetId, tag.hunterId, now, ' (auto-confirmed)');
      else {
        const v = Object.values(tag.votes ?? {});
        const yes = v.filter(Boolean).length;
        if (yes > v.length - yes) this.catchPlayer(tag.targetId, tag.hunterId, now, ' (vote)');
        else this.event('dispute', `Dispute: the vote says ${this.name(tag.targetId)} was NOT hit`);
      }
      stateDirty = true;
    }

    // history every 5s
    if (now - g.lastHistAt >= 5000) {
      g.lastHistAt = now;
      const fr: HistoryFrame = { t: now, p: {} };
      for (const p of g.players) if (p.pos && p.status === 'active') fr.p[p.id] = [+p.pos.lat.toFixed(6), +p.pos.lng.toFixed(6)];
      this.hist.push(fr);
      if (this.hist.length > 2500) this.hist = this.hist.filter((_, i) => i % 2 === 0); // stay under storage value limits
    }

    // time up
    if (g.endsAt && now >= g.endsAt && g.phase === 'live') {
      const alive = this.activeHiderTeams();
      if (alive.length) return this.finish(now, { side: 'hider', teamIds: alive }, 'Hiders survived until time ran out');
      return this.finish(now, { side: 'hunter', teamIds: this.hunterTeamIds() }, 'All hiders caught');
    }

    if (g.phase !== 'freeze' && g.phase !== 'live') return;
    this.sendTicks(now);
    if (stateDirty) this.broadcastState();
    if (now - g.lastSaveAt > 5000) void this.save();
  }

  // ---------- message handlers ----------
  onLoc(p: PlayerRec, m: { lat: number; lng: number; acc: number }, now: number) {
    const g = this.g!;
    const lat = +m.lat, lng = +m.lng;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    if (now - p.lastLocAt < 900) return;
    const acc = Math.max(3, Math.min(+m.acc || 50, 200));
    p.pos = { lat, lng, acc, at: now };
    p.lastLocAt = now;
    if (p.status !== 'active' || (g.phase !== 'freeze' && g.phase !== 'live')) return;
    const s = g.settings;
    const here = { lat, lng };
    const slack = Math.min(acc, 30);

    // boundary: 3 confident readings in a row outside
    if (g.area) {
      const inside = pointInPolygon(here, g.area.polygon);
      if (inside) { p.outCount = 0; p.outSince = null; }
      else if (distToEdgeM(here, g.area.polygon) > Math.max(8, Math.min(acc, 40))) {
        p.outCount++;
        if (p.outCount >= 3 && !p.outSince) p.outSince = now;
      }
    }

    // camping anchor (hunters exempt while frozen)
    const frozenHunter = g.phase === 'freeze' && this.roleOf(p) === 'hunter';
    if (s.mods && !frozenHunter) this.pickUpOrbs(p, here, acc, now);
    if (!frozenHunter && (!p.camp || distM(p.camp, here) > s.campRadiusM + slack)) p.camp = { lat, lng, since: now };

    // hunter freeze GPS backstop
    if (frozenHunter) {
      if (!p.freezeAnchor) p.freezeAnchor = here;
      else {
        const d = distM(p.freezeAnchor, here) - slack;
        p.freezeOutCount = d > s.freezeRadiusM ? p.freezeOutCount + 1 : 0;
        if (p.freezeOutCount >= 3) this.hunterViolation(p, 'left the freeze zone', now);
      }
    }
  }

  onFreezeReport(p: PlayerRec, m: { steps: number; still: boolean; camOk: boolean }, now: number) {
    const g = this.g!;
    if (g.phase !== 'freeze' || this.roleOf(p) !== 'hunter' || p.status !== 'active') return;
    if (+m.steps > g.settings.freezeMaxSteps) return this.hunterViolation(p, `walked ${+m.steps} steps during the freeze`, now);
    p.camBadSince = m.camOk ? null : (p.camBadSince ?? now);
    if (m.still && !p.stillWarned) {
      p.stillWarned = true;
      this.event('warning', `${p.name}'s phone hasn't moved at all. Is it set down?`);
      this.broadcastState();
    }
  }

  onHit(p: PlayerRec, targetId: string, now: number, err: (s: string) => void) {
    const g = this.g!;
    if (g.phase !== 'live') return err(g.phase === 'freeze' ? 'Still frozen' : 'Match not live');
    if (this.roleOf(p) !== 'hunter' || p.status !== 'active') return;
    const t = g.players.find((x) => x.id === targetId);
    if (!t || t.status !== 'active' || this.roleOf(t) !== 'hider') return err('Not a valid target');
    if (g.tags.some((x) => x.targetId === t.id)) return err('Already waiting on that tag');
    if (!p.pos || !t.pos || distM(p.pos, t.pos) > g.settings.combatRangeM * 1.6 + Math.min(p.pos.acc + t.pos.acc, 40)) {
      return err('Too far away to count');
    }
    const safe = g.settings.mods ? this.protection(t, now) : null;
    if (safe) {
      this.sendTo(t.id, { t: 'event', e: { id: rid(), at: now, kind: 'mod', text: `${p.name} tried to tag you. ${safe === 'shield' ? 'Your shield blocked it.' : 'Your safe zone saved you.'}`, important: true } });
      return err(safe === 'shield' ? `${t.name} has an immunity shield up` : `${t.name} is in a safe zone`);
    }
    const tag = { id: rid(), hunterId: p.id, targetId: t.id, at: now, stage: 'confirm' as const, deadline: now + TAG_TIMEOUT_MS };
    g.tags.push(tag);
    this.sendTo(t.id, { t: 'tagPrompt', tag });
    this.sendTo(p.id, { t: 'event', e: { id: rid(), at: now, kind: 'info', text: `Hit sent. Waiting for ${t.name}.` } });
  }

  async onTagReply(p: PlayerRec, tagId: string, accept: boolean, now: number) {
    const g = this.g!;
    const tag = g.tags.find((x) => x.id === tagId && x.stage === 'confirm' && x.targetId === p.id);
    if (!tag) return;
    if (accept) {
      g.tags = g.tags.filter((x) => x !== tag);
      this.catchPlayer(tag.targetId, tag.hunterId, now, '');
    } else {
      const voters = g.players.filter((x) => x.id !== tag.hunterId && x.id !== tag.targetId && this.isConnected(x.id));
      if (!voters.length) {
        g.tags = g.tags.filter((x) => x !== tag);
        this.event('dispute', `${p.name} disputed the hit. Nobody else could vote, so it doesn't count.`);
      } else {
        Object.assign(tag, { stage: 'vote', deadline: now + TAG_TIMEOUT_MS, votes: {} });
        this.event('dispute', `${p.name} disputed a hit by ${this.name(tag.hunterId)}. Vote now.`, true);
        for (const v of voters) this.sendTo(v.id, { t: 'votePrompt', tag });
      }
    }
    await this.save();
    this.broadcastState();
  }

  // ---------- game logic ----------
  spinTeams(now: number) {
    const g = this.g!;
    const s = g.settings;
    const ids = shuffle(g.players.map((p) => p.id));
    const groups: string[][] = [];
    for (let i = 0; i + 1 < ids.length; i += 2) groups.push([ids[i], ids[i + 1]]);
    const odd = ids.length % 2 ? ids[ids.length - 1] : null;
    if (odd && s.oddRule === 'solo') groups.push([odd]);
    if (odd && s.oddRule === 'trio') (groups[groups.length - 1] ?? groups[groups.push([]) - 1]).push(odd);

    const hunterCount = Math.max(1, Math.min(s.hunterTeams, groups.length - 1 || 1));
    // hunters come from full pairs when possible, never the odd solo player
    const order = shuffle(groups.map((_, i) => i)).sort((a, b) => Math.min(groups[b].length, 2) - Math.min(groups[a].length, 2));
    const hunterIdx = new Set(order.slice(0, hunterCount));
    let hunters = groups.filter((_, i) => hunterIdx.has(i));
    let hiders = groups.filter((_, i) => !hunterIdx.has(i));
    if (odd && s.oddRule === 'hunters') hunters[0].push(odd);
    if (!hiders.length && hunters[0].length > 1) hiders = [[hunters[0].pop()!]]; // 2-3 player edge case

    g.soloMode = hiders.length <= s.soloThreshold && hiders.flat().length >= 2;
    if (g.soloMode) hiders = hiders.flat().map((id) => [id]);

    g.teams = [];
    hunters.forEach((m, i) => g.teams.push({ id: rid(), name: hunters.length > 1 ? `Hunters ${i + 1}` : 'Hunters', role: 'hunter', members: m, color: HUNTER_COLOR }));
    hiders.forEach((m, i) => g.teams.push({
      id: rid(), name: g.soloMode ? this.name(m[0]) : `Team ${i + 1}`, role: 'hider', members: m, color: TEAM_COLORS[i % TEAM_COLORS.length],
    }));
    for (const p of g.players) {
      p.teamId = g.teams.find((t) => t.members.includes(p.id))?.id ?? null;
      p.allianceId = null;
    }
    g.markers = [];
    g.phase = 'teams';
    g.spin = { at: now, order: g.teams.flatMap((t) => t.members) };
    this.assignChannels();
  }

  /** Every team gets its own random home channel; everyone starts tuned to theirs. */
  assignChannels() {
    const g = this.g!;
    const free = shuffle(Array.from({ length: RADIO_CHANNELS - 1 }, (_, i) => i + 2)); // channel 1 is the lobby
    const home = new Map(g.teams.map((t, i) => [t.id, free[i]]));
    for (const p of g.players) { p.channel = (p.teamId && home.get(p.teamId)) || 1; p.ready = false; }
    g.homes = Object.fromEntries(home);
    g.talkers = {};
  }

  startMatch(now: number) {
    const g = this.g!;
    const s = g.settings;
    Object.assign(g, {
      phase: s.freezeSeconds > 0 ? 'freeze' : 'live',
      startedAt: now,
      freezeEndsAt: now + s.freezeSeconds * 1000,
      endsAt: now + s.matchMinutes * 60_000,
      nextPingAt: now + s.pingMinutes * 60_000,
      warnedFor: null, revealUntil: null, endgame: false, nextEndgameRevealAt: null,
      winner: null, tags: [], allyReqs: [], events: [], lastHistAt: 0, endVote: null,
      initialHiderTeams: g.teams.filter((t) => t.role === 'hider').length,
    } satisfies Partial<Game>);
    for (const p of g.players) Object.assign(p, this.freshLive(), { status: 'active' as const, mod: this.freshMod(s.modStartPoints) });
    g.orbs = [];
    g.lastOrbAt = 0;
    if (s.mods) for (let i = 0; i < Math.min(3, s.orbCount); i++) { const o = this.spawnOrb(); if (o) g.orbs.push(o); }
    this.hist = [];
    this.event('start', s.freezeSeconds > 0 ? `Match on. Hunters are frozen for ${s.freezeSeconds >= 60 ? `${+(s.freezeSeconds / 60).toFixed(1)} min` : `${s.freezeSeconds}s`}. Run.` : 'Match on.', true);
    void this.ctx.storage.setAlarm(now + 1000);
  }

  catchPlayer(targetId: string, hunterId: string, now: number, suffix: string) {
    const g = this.g!;
    const t = g.players.find((x) => x.id === targetId);
    if (!t || t.status !== 'active') return;
    this.event('caught', `${this.name(hunterId)} caught ${t.name}${suffix}`, true);
    if (g.settings.mods) {
      const h = g.players.find((x) => x.id === hunterId);
      const bounty = (t.mod.until.bounty ?? 0) > now;
      if (h) h.mod.points += bounty ? 3 : 1;
      delete t.mod.until.bounty;
      if (h) this.sendTo(h.id, { t: 'event', e: { id: rid(), at: now, kind: 'mod', text: bounty ? 'Bounty collected: +3 points' : '+1 point for the catch' } });
    }
    if (g.settings.caughtJoinHunters) {
      const old = g.teams.find((x) => x.id === t.teamId);
      const hunt = g.teams.find((x) => x.role === 'hunter' && x.members.includes(hunterId)) ?? g.teams.find((x) => x.role === 'hunter');
      if (old && hunt) {
        old.members = old.members.filter((id) => id !== t.id);
        hunt.members.push(t.id);
        t.teamId = hunt.id;
        t.allianceId = null;
        t.camp = null;
      }
    } else t.status = 'caught';
    this.checkOutcome(now);
  }

  hunterViolation(p: PlayerRec, what: string, now: number) {
    if (this.g!.phase !== 'freeze') return;
    p.status = 'dq';
    this.finish(now, { side: 'hider', teamIds: this.activeHiderTeams() }, `${p.name} ${what}. Hunters lose.`);
  }

  checkOutcome(now: number) {
    const g = this.g!;
    if (g.phase !== 'freeze' && g.phase !== 'live') return;
    const alive = this.activeHiderTeams();
    if (!alive.length) return this.finish(now, { side: 'hunter', teamIds: this.hunterTeamIds() }, 'All hiders caught');
    if (!this.hunters().some((p) => p.status === 'active')) return this.finish(now, { side: 'hider', teamIds: alive }, 'No hunters left');
    if (!g.endgame && alive.length === 1 && g.initialHiderTeams >= 2) {
      g.endgame = true;
      g.endsAt = Math.min(g.endsAt ?? Infinity, now + g.settings.endgameMinutes * 60_000);
      g.nextPingAt = null;
      g.nextEndgameRevealAt = now + g.settings.endgameRevealEveryMinutes * 60_000;
      this.event('endgame', `Endgame. ${this.teamName(alive[0])} is the last team left. Reveals are random now.`, true);
    }
  }

  finish(now: number, w: Omit<Winner, 'elapsedMs' | 'reason'> | null, reason: string) {
    const g = this.g!;
    g.phase = 'ended';
    g.revealUntil = null;
    g.endVote = null;
    g.winner = w ? { ...w, reason, elapsedMs: now - (g.startedAt ?? now) } : null;
    const el = Math.floor((now - (g.startedAt ?? now)) / 1000);
    const h = Math.floor(el / 3600), mi = Math.floor((el % 3600) / 60), se = el % 60;
    const took = h ? `${h}h ${mi}m` : mi ? `${mi}m ${se}s` : `${se}s`;
    const who = w ? w.teamIds.map((id) => this.teamName(id)).join(' + ') : 'Nobody';
    this.event('win', w ? `${who} won in ${took}. ${reason}.` : reason, true);
    void this.ctx.storage.deleteAlarm();
    void this.save();
    this.broadcastState();
  }

  resetToLobby() {
    const g = this.g!;
    Object.assign(g, {
      phase: 'lobby', teams: [], soloMode: false, spin: null, startedAt: null, freezeEndsAt: null, endsAt: null,
      nextPingAt: null, warnedFor: null, revealUntil: null, endgame: false, nextEndgameRevealAt: null,
      winner: null, markers: [], tags: [], allyReqs: [], endVote: null, talkers: {}, orbs: [],
    } satisfies Partial<Game>);
    for (const p of g.players) Object.assign(p, this.freshLive(), { teamId: null, status: 'active' as const, allianceId: null, ready: false, channel: 1 });
    void this.ctx.storage.deleteAlarm();
  }

  applySettings(patch: Partial<Settings>) {
    const s = this.g!.settings;
    for (const [k, v] of Object.entries(patch ?? {})) {
      const key = k as keyof Settings;
      if (!(key in DEFAULT_SETTINGS)) continue;
      const range = SETTING_RANGES[key];
      if (range && typeof v === 'number' && isFinite(v)) (s as Record<string, unknown>)[key] = Math.round(Math.max(range[0], Math.min(range[1], v)) * 10) / 10;
      else if (typeof DEFAULT_SETTINGS[key] === 'boolean') (s as Record<string, unknown>)[key] = !!v;
      else if (key === 'oddRule' && ['solo', 'hunters', 'trio'].includes(v as string)) s.oddRule = v as Settings['oddRule'];
      else if (key === 'preset' && ['quick', 'classic', 'long', 'custom'].includes(v as string)) s.preset = v as Settings['preset'];
      else if (key === 'disabledAbilities' && Array.isArray(v)) s.disabledAbilities = [...new Set(v.filter((x) => typeof x === 'string' && x in ABILITIES))] as AbilityId[];
    }
  }

  // ---------- visibility ----------
  exposure(p: PlayerRec, now: number): VisReason | null {
    const g = this.g!;
    if (p.status !== 'active' || !p.pos || (g.phase !== 'freeze' && g.phase !== 'live')) return null;
    if (now - p.lastLocAt > g.settings.darkSeconds * 1000) return 'dark';
    if (p.outSince) return 'outside';
    if (p.camp && now - p.camp.since > g.settings.campMinutes * 60_000) return 'camping';
    return null;
  }

  sendTicks(now: number) {
    const g = this.g!;
    const revealing = !!g.revealUntil && now < g.revealUntil;
    const exposures = new Map(g.players.map((p) => [p.id, this.exposure(p, now)]));
    const active = g.players.filter((p) => p.status === 'active' && p.pos);
    const range = g.settings.combatRangeM;
    const mods = g.settings.mods;

    for (const ws of this.ctx.getWebSockets()) {
      const { pid } = ws.deserializeAttachment() as Att;
      const me = g.players.find((x) => x.id === pid);
      if (!me) continue;
      const myRole = this.roleOf(me);
      const vis: VisiblePlayer[] = [];
      let nearest = Infinity;
      const targets: string[] = [];
      for (const o of active) {
        if (o.id === me.id) continue;
        let pos: { lat: number; lng: number; acc: number; at: number } = o.pos!;
        let reason: VisReason | null =
          o.teamId && o.teamId === me.teamId ? 'team'
          : o.allianceId && o.allianceId === me.allianceId ? 'ally'
          : null;
        if (!reason) {
          reason = revealing ? 'ping' : exposures.get(o.id) ?? null;
          if (mods) {
            const u = o.mod.until;
            if ((u.vanish ?? 0) > now) reason = (me.mod.until.trace ?? 0) > now ? 'trace' : null;
            else if (!reason && myRole === 'hunter' && (u.bounty ?? 0) > now && (now - o.mod.bountyAt) % BOUNTY_EVERY_MS < BOUNTY_FLASH_MS) reason = 'bounty';
            if (reason && reason !== 'trace' && (u.fake ?? 0) > now && o.mod.decoy) pos = { ...pos, ...o.mod.decoy };
          }
        }
        if (reason) vis.push({ id: o.id, lat: pos.lat, lng: pos.lng, acc: pos.acc, reason, at: pos.at });
        pos = o.pos!;
        if (me.status === 'active' && me.pos && myRole && this.roleOf(o) && this.roleOf(o) !== myRole && now - pos.at < 30_000) {
          const d = distM(me.pos, pos);
          nearest = Math.min(nearest, d);
          if (myRole === 'hunter' && d <= range + Math.min(me.pos.acc, 20)) targets.push(o.id);
        }
      }
      this.send(ws, {
        t: 'tick', now, vis, prox: proxLevel(nearest), targets: g.phase === 'live' ? targets : [],
        revealUntil: revealing ? g.revealUntil : null, exposed: exposures.get(me.id) ?? null, outsideSince: me.outSince,
      });
    }
  }

  // ---------- helpers ----------
  newGame(code: string, hostId: string): Game {
    return {
      code, hostId, phase: 'lobby', players: [], teams: [], settings: { ...DEFAULT_SETTINGS }, area: null,
      soloMode: false, spin: null, startedAt: null, freezeEndsAt: null, endsAt: null, nextPingAt: null,
      warnedFor: null, revealUntil: null, endgame: false, nextEndgameRevealAt: null, initialHiderTeams: 0,
      winner: null, markers: [], events: [], tags: [], allyReqs: [], lastHistAt: 0, lastSaveAt: 0, endVote: null, talkers: {}, homes: {},
      orbs: [], lastOrbAt: 0,
    };
  }
  newPlayer(id: string, name: string, secretHash: string): PlayerRec {
    return { id, name, secretHash, teamId: null, status: 'active', allianceId: null, ready: false, channel: 1, lastSeen: Date.now(), mod: this.freshMod(0), ...this.freshLive() };
  }
  freshMod(points: number): ModRec {
    return { points, rerolls: MAX_REROLLS, freeZone: true, zones: [], decoy: null, pendingRoll: null, until: {}, bountyAt: 0 };
  }

  // ---------- mods ----------
  rollOrb(now: number): Roll {
    let r = Math.random();
    for (const t of ORB_TIERS) { if ((r -= t.chance) <= 0) return { tier: t.tier, points: t.points, at: now }; }
    return { tier: 'D', points: 1, at: now };
  }

  /** A random spot inside the play area, away from the edge and other orbs. */
  spawnOrb(): Orb | null {
    const g = this.g!;
    const poly = g.area?.polygon;
    if (!poly?.length) return null;
    const lats = poly.map((q) => q.lat), lngs = poly.map((q) => q.lng);
    const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
    for (let i = 0; i < 60; i++) {
      const q = { lat: a + Math.random() * (b - a), lng: c + Math.random() * (d - c) };
      if (!pointInPolygon(q, poly) || distToEdgeM(q, poly) < 12) continue;
      if (g.orbs.some((o) => distM(o, q) < 40)) continue;
      return { id: rid(), ...q };
    }
    return null;
  }

  pickUpOrbs(p: PlayerRec, here: LatLng, acc: number, now: number) {
    const g = this.g!;
    const reach = ORB_PICKUP_M + Math.min(acc, 15);
    const orb = g.orbs.find((o) => distM(o, here) <= reach);
    if (!orb) return;
    g.orbs = g.orbs.filter((o) => o !== orb);
    if (p.mod.pendingRoll) this.keepRoll(p, now);
    const roll = this.rollOrb(now);
    p.mod.pendingRoll = roll;
    this.sendTo(p.id, { t: 'orb', roll, rerollsLeft: p.mod.rerolls, rerolled: false });
    this.broadcastState();
  }

  onRoll(p: PlayerRec, reroll: boolean, now: number) {
    const cur = p.mod.pendingRoll;
    if (!cur) return;
    if (reroll && p.mod.rerolls > 0) {
      p.mod.rerolls--;
      const roll = this.rollOrb(now);
      p.mod.pendingRoll = roll;
      return this.sendTo(p.id, { t: 'orb', roll, rerollsLeft: p.mod.rerolls, rerolled: true });
    }
    this.keepRoll(p, now);
  }

  keepRoll(p: PlayerRec, now: number) {
    const r = p.mod.pendingRoll;
    if (!r) return;
    p.mod.points += r.points;
    p.mod.pendingRoll = null;
    if (r.tier === 'S') this.event('mod', `${p.name} pulled an S-tier orb`);
    this.sendTo(p.id, { t: 'event', e: { id: rid(), at: now, kind: 'mod', text: `${r.tier}-tier orb: +${r.points} point${r.points === 1 ? '' : 's'}` } });
    this.sendTo(p.id, { t: 'state', s: this.publicState(p.id) });
  }

  /** Why a hit on this player wouldn't count right now, if any. */
  protection(t: PlayerRec, now: number): 'shield' | 'zone' | null {
    const m = t.mod;
    if ((m.until.shield ?? 0) > now) return 'shield';
    if ((m.until.disabled ?? 0) <= now && t.pos && m.zones.some((z) => z.charge > 0 && distM(z, t.pos!) <= SAFE_ZONE_M)) return 'zone';
    return null;
  }

  /** At each ping, the richest hider (2+ points) gets a bounty. */
  assignBounty(now: number) {
    const g = this.g!;
    const pool = g.players.filter((p) => p.status === 'active' && this.roleOf(p) === 'hider' && p.mod.points >= BOUNTY_MIN_POINTS && !((p.mod.until.bounty ?? 0) > now));
    if (!pool.length) return;
    const top = Math.max(...pool.map((p) => p.mod.points));
    const pick = shuffle(pool.filter((p) => p.mod.points === top))[0];
    pick.mod.until.bounty = now + BOUNTY_MS;
    pick.mod.bountyAt = now;
    this.event('bounty', `Bounty on ${pick.name}. Hunters see them every 30 seconds for 5 minutes.`, true);
  }

  modTick(now: number): boolean {
    const g = this.g!;
    let dirty = false;
    if (g.area && g.orbs.length < g.settings.orbCount && now - g.lastOrbAt > 15_000) {
      const o = this.spawnOrb();
      if (o) { g.orbs.push(o); dirty = true; }
      g.lastOrbAt = now;
    }
    const pulse = Math.floor(now / 1000) % 5 === 0;
    for (const p of g.players) {
      const m = p.mod;
      if (m.pendingRoll && now - m.pendingRoll.at > 20_000) this.keepRoll(p, now);
      if (m.until.bounty && now > m.until.bounty) { delete m.until.bounty; dirty = true; }
      if (p.status !== 'active' || !p.pos || !m.zones.length) continue;
      const off = (m.until.disabled ?? 0) > now;
      let inside = false;
      for (const z of m.zones) if (!off && distM(z, p.pos) <= SAFE_ZONE_M) { z.charge -= 1000; inside = true; }
      const before = m.zones.length;
      m.zones = m.zones.filter((z) => z.charge > 0);
      if (m.zones.length !== before) this.sendTo(p.id, { t: 'event', e: { id: rid(), at: now, kind: 'mod', text: 'One of your safe zones ran out', important: true } });
      if (inside && (pulse || m.zones.length !== before)) this.sendTo(p.id, { t: 'state', s: this.publicState(p.id) });
    }
    return dirty;
  }

  onUse(p: PlayerRec, m: { ability: AbilityId; targetId?: string; lat?: number; lng?: number }, now: number, err: (s: string) => void): boolean {
    const g = this.g!;
    const s = g.settings;
    const a = ABILITIES[m.ability];
    const fail = (msg: string) => { err(msg); return false; };
    if (!s.mods || !a) return fail('Mods are off for this game');
    if (s.disabledAbilities.includes(m.ability)) return fail(`${a.name} is turned off for this game`);
    if (g.phase !== 'live' && g.phase !== 'freeze') return fail('The match hasn\u2019t started');
    const role = this.roleOf(p);
    if (a.who === 'caught') { if (p.status !== 'caught') return fail('Revive is for caught players'); }
    else {
      if (p.status !== 'active') return fail('You\u2019re out of the game');
      if (a.who === 'hider' && role !== 'hider') return fail(`${a.name} is for hiders`);
    }
    const mod = p.mod;
    const cost = m.ability === 'zone' && mod.freeZone ? 0 : a.cost;
    if (mod.points < cost) return fail(`You need ${cost} point${cost === 1 ? '' : 's'}`);
    const until = now + ABILITY_MINUTES * 60_000;
    const active = (k: keyof ModRec['until']) => (mod.until[k] ?? 0) > now;
    const target = m.targetId ? g.players.find((x) => x.id === m.targetId) : undefined;
    const tell = (id: string, text: string, important = false) => this.sendTo(id, { t: 'event', e: { id: rid(), at: now, kind: 'mod', text, important } });

    switch (m.ability) {
      case 'revive':
        p.status = 'active';
        Object.assign(p, { camp: null, outCount: 0, outSince: null, announced: {} });
        mod.until.shield = now + 30_000;
        this.event('mod', `${p.name} used Revive and is back in the game`, true);
        break;
      case 'reboot':
        if (!target || target.status !== 'caught' || this.roleOf(target) !== 'hider') return fail('Pick a caught hider');
        target.status = 'active';
        Object.assign(target, { camp: null, outCount: 0, outSince: null, announced: {} });
        target.mod.until.shield = now + 30_000;
        this.event('mod', `${p.name} used a Reboot Card. ${target.name} is back in the game.`, true);
        break;
      case 'vanish':
        if (active('vanish')) return fail('Vanish is already on');
        mod.until.vanish = until;
        break;
      case 'fake': {
        const lat = +(m.lat ?? NaN), lng = +(m.lng ?? NaN);
        if (!isFinite(lat) || !isFinite(lng)) return fail('Pick a spot for the decoy');
        if (g.area && !pointInPolygon({ lat, lng }, g.area.polygon)) return fail('The decoy has to be inside the play area');
        mod.decoy = { lat, lng };
        mod.until.fake = until;
        break;
      }
      case 'shield':
        if (active('shield')) return fail('Your shield is already up');
        mod.until.shield = until;
        break;
      case 'trace':
        if (active('trace')) return fail('Trace is already on');
        mod.until.trace = until;
        break;
      case 'disable':
        if (!target || target.id === p.id || target.status !== 'active') return fail('Pick an active player');
        target.mod.until.disabled = until;
        tell(target.id, 'Someone disabled your safe zones for 10 minutes', true);
        break;
      case 'steal':
        if (!target || target.id === p.id || target.status !== 'active') return fail('Pick an active player');
        if (target.mod.points < 1) return fail(`${target.name} has no points`);
        target.mod.points -= 1;
        mod.points += 1;
        tell(target.id, 'Someone stole 1 of your points', true);
        break;
      case 'zone':
        if (!p.pos) return fail('Waiting for your GPS');
        if (mod.zones.length >= 3) return fail('You can have 3 safe zones at once');
        if (mod.zones.some((z) => distM(z, p.pos!) < SAFE_ZONE_M * 1.5)) return fail('Too close to one of your other safe zones');
        mod.zones.push({ id: rid(), lat: p.pos.lat, lng: p.pos.lng, charge: SAFE_ZONE_CHARGE_MS });
        mod.freeZone = false;
        break;
      case 'clear':
        if (!active('bounty')) return fail('There\u2019s no bounty on you');
        delete mod.until.bounty;
        this.event('bounty', `${p.name} cleared their bounty`);
        break;
    }
    mod.points -= cost;
    tell(p.id, `${a.name} used${a.minutes ? ` for ${a.minutes} minutes` : ''}`);
    return true;
  }
  modState(p: PlayerRec): ModState {
    const now = Date.now();
    const m = p.mod;
    const until = Object.fromEntries(Object.entries(m.until).filter(([, v]) => (v ?? 0) > now));
    return { points: m.points, rerolls: m.rerolls, freeZone: m.freeZone, zones: m.zones, decoy: (m.until.fake ?? 0) > now ? m.decoy : null, pendingRoll: m.pendingRoll, until };
  }
  freshLive() {
    return { pos: null, lastLocAt: 0, camp: null, outCount: 0, outSince: null, freezeAnchor: null, freezeOutCount: 0, camBadSince: null, stillWarned: false, announced: {} };
  }
  roleOf(p: PlayerRec): 'hunter' | 'hider' | null {
    return this.g!.teams.find((t) => t.id === p.teamId)?.role ?? null;
  }
  hunters() { return this.g!.players.filter((p) => this.roleOf(p) === 'hunter'); }
  hunterTeamIds() { return this.g!.teams.filter((t) => t.role === 'hunter').map((t) => t.id); }
  activeHiderTeams(): string[] {
    const g = this.g!;
    return g.teams.filter((t) => t.role === 'hider' && t.members.some((id) => g.players.find((p) => p.id === id)?.status === 'active')).map((t) => t.id);
  }
  name(id: string) { return this.g!.players.find((p) => p.id === id)?.name ?? 'Someone'; }
  teamName(id: string) { return this.g!.teams.find((t) => t.id === id)?.name ?? 'A team'; }
  isConnected(pid: string) { return this.ctx.getWebSockets().some((s) => (s.deserializeAttachment() as Att).pid === pid); }

  event(kind: GameEvent['kind'], text: string, important = false) {
    const e: GameEvent = { id: rid(), at: Date.now(), kind, text, important };
    this.g!.events.push(e);
    if (this.g!.events.length > 300) this.g!.events.shift();
    this.broadcast({ t: 'event', e });
  }

  publicState(pid: string): PublicState {
    const g = this.g!;
    const me = g.players.find((p) => p.id === pid);
    return {
      code: g.code, phase: g.phase, hostId: g.hostId,
      players: g.players.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId, status: p.status, connected: this.isConnected(p.id), ready: p.ready, bounty: g.settings.mods && (p.mod.until.bounty ?? 0) > Date.now() })),
      teams: g.teams, settings: g.settings, area: g.area, soloMode: g.soloMode, spin: g.spin,
      startedAt: g.startedAt, freezeEndsAt: g.freezeEndsAt, endsAt: g.endsAt,
      nextPingAt: g.endgame ? null : g.nextPingAt, endgame: g.endgame, winner: g.winner,
      you: pid,
      alliance: me?.allianceId ? g.players.filter((p) => p.allianceId === me.allianceId && p.id !== pid).map((p) => p.id) : [],
      markers: me?.teamId ? g.markers.filter((m) => m.teamId === me.teamId) : [],
      endVote: g.endVote,
      orbs: g.settings.mods ? g.orbs : [],
      mods: g.settings.mods && me ? this.modState(me) : null,
      radio: {
        ch: me?.channel ?? 1,
        home: me?.teamId ? g.homes[me.teamId] ?? null : null,
        talker: me ? g.talkers[me.channel]?.talker ?? null : null,
      },
    };
  }

  send(ws: WebSocket, m: ServerMsg) { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } }
  sendTo(pid: string, m: ServerMsg) {
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as Att).pid === pid) this.send(ws, m);
  }
  broadcast(m: ServerMsg) { const s = JSON.stringify(m); for (const ws of this.ctx.getWebSockets()) try { ws.send(s); } catch { /* closed */ } }
  broadcastState() {
    if (!this.g) return;
    for (const ws of this.ctx.getWebSockets()) this.send(ws, { t: 'state', s: this.publicState((ws.deserializeAttachment() as Att).pid) });
  }

  async save() {
    if (!this.g) return;
    this.g.lastSaveAt = Date.now();
    await this.ctx.storage.put('g', this.g);
    if (this.g.phase !== 'lobby' && this.g.phase !== 'teams') await this.ctx.storage.put('hist', this.hist);
  }
}
