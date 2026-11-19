import { useSyncExternalStore } from 'react';
import type { ClientMsg, GameEvent, HistoryFrame, PublicState, ServerMsg, TagClaim } from '../../shared/protocol';
import { announce, sfx } from './device/audio';
import { vibrate } from './device/device';
import { closeMic, openMic, receiveFrame, rxState, startSending, stopSending } from './device/radio';

export type Tick = Extract<ServerMsg, { t: 'tick' }>;
export type RadioEntry = { id: string; kind: 'voice' | 'text'; from: string; text?: string; at: number; ch: number; dur?: number };
type Radio = { talking: boolean; rxFrom: string | null; log: RadioEntry[]; open: boolean };

type Store = {
  conn: 'idle' | 'connecting' | 'open' | 'retrying' | 'failed';
  failReason: string | null;
  code: string | null;
  s: PublicState | null;
  tick: Tick | null;
  events: GameEvent[];
  banner: GameEvent | null;
  warnPingAt: number | null;
  tagPrompt: TagClaim | null;
  votePrompt: TagClaim | null;
  allyPrompts: string[];
  history: { frames: HistoryFrame[]; events: GameEvent[] } | null;
  toast: string | null;
  clockOffset: number; // serverNow - Date.now()
  radio: Radio;
};

let state: Store = {
  conn: 'idle', failReason: null, code: null, s: null, tick: null, events: [], banner: null, warnPingAt: null,
  tagPrompt: null, votePrompt: null, allyPrompts: [], history: null, toast: null, clockOffset: 0,
  radio: { talking: false, rxFrom: null, log: [], open: false },
};
const subs = new Set<() => void>();
function set(p: Partial<Store>) { state = { ...state, ...p }; subs.forEach((f) => f()); }
export const getStore = () => state;
export function useStore<T>(sel: (s: Store) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}
export const serverNow = () => Date.now() + state.clockOffset;

// ---------- identity ----------
function rand(n: number) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const identity = {
  get id() { let v = localStorage.getItem('mh.id'); if (!v) { v = 'p' + rand(6); localStorage.setItem('mh.id', v); } return v; },
  get secret() { let v = localStorage.getItem('mh.secret'); if (!v) { v = rand(16); localStorage.setItem('mh.secret', v); } return v; },
  get name() { return localStorage.getItem('mh.name') ?? ''; },
  set name(v: string) { localStorage.setItem('mh.name', v); },
};

// ---------- connection ----------
// Where the game server lives. Empty = same origin (Cloudflare serving both).
// On Vercel, set VITE_API_URL to the Worker, e.g. https://manhunt.<you>.workers.dev
const API = String(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
let ws: WebSocket | null = null;
let retry = 0;
let wantOpen = false;

export async function createParty(): Promise<string> {
  const r = await fetch(`${API}/api/create`, { method: 'POST', body: JSON.stringify({ hostId: identity.id }) });
  if (!r.ok) throw new Error('Could not create a party');
  return ((await r.json()) as { code: string }).code;
}

export async function partyExists(code: string) {
  const r = await fetch(`${API}/api/party/${code}`);
  if (!r.ok) return false;
  return ((await r.json()) as { exists: boolean }).exists;
}

export function connect(code: string) {
  code = code.toUpperCase();
  wantOpen = true;
  localStorage.setItem('mh.party', code);
  set({ code, conn: retry ? 'retrying' : 'connecting', failReason: null });
  const q = new URLSearchParams({ pid: identity.id, secret: identity.secret, name: identity.name || 'Player' });
  const sock = new WebSocket(`${(API || location.origin).replace(/^http/, 'ws')}/api/party/${code}/ws?${q}`);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  let opened = false;
  sock.onopen = () => { opened = true; retry = 0; set({ conn: 'open' }); };
  sock.onmessage = (e) => {
    if (typeof e.data !== 'string') { void receiveFrame(e.data as ArrayBuffer); return; }
    handle(JSON.parse(e.data) as ServerMsg);
  };
  sock.onclose = async (e) => {
    if (ws !== sock) return;
    ws = null;
    if (!wantOpen) return;
    if (e.code === 4001) return fail('You were removed from the party');
    if (!opened) {
      // the server refused the upgrade; find out why before retrying forever
      const exists = await partyExists(code).catch(() => true);
      if (!exists) return fail('That party code does not exist');
      if (retry > 2 && !state.s) return fail('Could not join. The match may have already started.');
    }
    retry++;
    set({ conn: 'retrying' });
    setTimeout(() => wantOpen && connect(code), Math.min(8000, 500 * 2 ** Math.min(retry, 4)));
  };
}

function fail(reason: string) {
  wantOpen = false;
  localStorage.removeItem('mh.party');
  set({ conn: 'failed', failReason: reason, s: null, code: null });
}

export function leaveParty() {
  wantOpen = false;
  localStorage.removeItem('mh.party');
  ws?.close();
  ws = null;
  set({ conn: 'idle', s: null, code: null, tick: null, events: [], history: null, banner: null, radio: { talking: false, rxFrom: null, log: [], open: false } });
}

export function send(m: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ---------- walkie-talkie ----------
const setRadio = (p: Partial<Radio>) => set({ radio: { ...state.radio, ...p } });
const logRadio = (e: RadioEntry) => setRadio({ log: [...state.radio.log.slice(-120), e] });
let pressed = false;
let micIdle: ReturnType<typeof setTimeout> | undefined;
export async function pttDown() {
  if (pressed) return;
  pressed = true;
  clearTimeout(micIdle);
  const ok = await openMic();
  if (!ok) { pressed = false; sfx.denied(); toast('Microphone is blocked. Allow mic access to talk.'); return; }
  if (!pressed) return; // released while the mic was opening
  send({ t: 'ptt', on: true });
  sfx.keyUp();
  vibrate(20);
  setRadio({ talking: true });
  const id = Math.random().toString(36).slice(2);
  logRadio({ id, kind: 'voice', from: state.s?.you ?? '', at: serverNow(), ch: state.s?.radio.ch ?? 0 });
  startSending((f) => { if (ws?.readyState === WebSocket.OPEN) ws.send(f.buffer as ArrayBuffer); });
}
export function pttUp() {
  if (!pressed) return;
  pressed = false;
  if (!state.radio.talking) return;
  stopSending();
  send({ t: 'ptt', on: false });
  sfx.roger();
  micIdle = setTimeout(closeMic, 15000); // release the mic (and the iOS mic indicator) when idle
  const log = state.radio.log.map((e, i, a) => (i === a.length - 1 && e.kind === 'voice' && !e.dur ? { ...e, dur: serverNow() - e.at } : e));
  setRadio({ talking: false, log });
}
export const setRadioOpen = (open: boolean) => setRadio({ open });

const myName = () => state.s?.players.find((p) => p.id === state.s?.you)?.name ?? '\u0000';

function eventSound(e: GameEvent) {
  const mine = e.text.includes(myName());
  switch (e.kind) {
    case 'start': return announce('start');
    case 'freeze-over': return announce('released');
    case 'caught':
      if (e.text.includes(`caught ${myName()}`)) { sfx.tagged(); vibrate([400, 100, 400]); return announce('tagged', { chime: false }); }
      sfx.caught(); return announce('caught', { chime: false });
    case 'dq': sfx.caught(); return announce('dq', { chime: false });
    case 'endgame': sfx.endgame(); setTimeout(() => announce('endgame', { chime: false }), 1400); return;
    case 'camping': if (mine) announce('camping'); return;
    case 'outside': if (mine) announce('outside'); return;
    case 'alliance': if (mine && e.text.includes('formed')) announce('alliance'); return;
    case 'dispute': if (e.important) announce('dispute'); return;
    case 'vote':
      if (e.important) return announce('vote_started');
      return sfx.denied();
    case 'win':
      setTimeout(() => {
        const s = state.s;
        const w = s?.winner;
        const myTeam = s?.teams.find((t) => t.members.includes(s.you));
        if (!w) { sfx.lose(); return announce(/voted/.test(e.text) ? 'vote_passed' : 'match_over', { chime: false }); }
        if (myTeam && w.teamIds.includes(myTeam.id)) sfx.win(); else sfx.lose();
        announce(w.side === 'hunter' ? 'hunters_win' : 'hiders_win', { chime: false });
      }, 400);
      return;
    default:
      if (e.important) sfx.attention();
  }
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string) {
  set({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), 3000);
}

function handle(m: ServerMsg) {
  switch (m.t) {
    case 'state': {
      const prev = state.s;
      set({ s: m.s });
      if (prev && prev.phase !== m.s.phase && (m.s.phase === 'freeze' || m.s.phase === 'lobby')) set({ events: [], history: null });
      return;
    }
    case 'tick':
      return set({ tick: m, clockOffset: m.now - Date.now() });
    case 'event': {
      set({ events: [...state.events.slice(-150), m.e] });
      if (m.e.important) {
        set({ banner: m.e });
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => set({ banner: null }), 5000);
        vibrate([200, 100, 200]);
      }
      eventSound(m.e);
      return;
    }
    case 'warn': return set({ warnPingAt: m.pingAt });
    case 'tagPrompt': vibrate([300, 100, 300]); sfx.tagged(); return set({ tagPrompt: m.tag });
    case 'votePrompt': sfx.attention(); return set({ votePrompt: m.tag });
    case 'rx': {
      rxState(m.on);
      if (m.on) {
        logRadio({ id: Math.random().toString(36).slice(2), kind: 'voice', from: m.from, at: serverNow(), ch: m.ch });
        return setRadio({ rxFrom: m.from });
      }
      const log = state.radio.log.map((e) => (e.kind === 'voice' && e.from === m.from && !e.dur ? { ...e, dur: serverNow() - e.at } : e));
      return setRadio({ rxFrom: null, log });
    }
    case 'chat':
      if (m.from !== state.s?.you) sfx.dial();
      return logRadio({ id: Math.random().toString(36).slice(2), kind: 'text', from: m.from, text: m.text, at: m.at, ch: m.ch });
    case 'pttDenied':
      stopSending();
      pressed = false;
      sfx.denied();
      setRadio({ talking: false, log: state.radio.log.slice(0, -1) });
      return toast(`Channel busy. ${state.s?.players.find((p) => p.id === m.talker)?.name ?? 'Someone'} is talking.`);
    case 'allyPrompt': return set({ allyPrompts: [...new Set([...state.allyPrompts, m.fromId])] });
    case 'history': return set({ history: { frames: m.frames, events: m.events } });
    case 'error': return toast(m.msg);
  }
}

export const dismiss = {
  warn: () => set({ warnPingAt: null }),
  tag: () => set({ tagPrompt: null }),
  vote: () => set({ votePrompt: null }),
  ally: (id: string) => set({ allyPrompts: state.allyPrompts.filter((x) => x !== id) }),
  banner: () => set({ banner: null }),
};

// test hook: with ?test, expose send() so automated tests can tweak settings quickly
if (new URLSearchParams(location.search).has('test')) (window as unknown as { __send: typeof send }).__send = send;

// rejoin after a reload / relaunch
const saved = localStorage.getItem('mh.party');
if (saved && identity.name) connect(saved);
