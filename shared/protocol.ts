// Shared types for the Manhunt client and the game server.
// Everything that crosses the WebSocket is defined here.

export type LatLng = { lat: number; lng: number };

/** Play area: a closed polygon ring (first point not repeated). */
export type Area = { polygon: LatLng[]; center: LatLng; radiusM: number };

export type OddRule = 'solo' | 'hunters' | 'trio';

export type Settings = {
  matchMinutes: number;
  pingMinutes: number; // time between location pings
  warnSeconds: number; // fake call this long before a ping
  revealSeconds: number; // how long a ping shows everyone
  freezeSeconds: number; // hunters must stay put this long at the start
  freezeMaxSteps: number; // steps allowed during the freeze
  freezeRadiusM: number; // GPS backstop radius during the freeze
  campMinutes: number; // staying in one spot this long exposes you
  campRadiusM: number;
  outsideGraceSeconds: number; // outside the area this long = DQ
  darkSeconds: number; // no location for this long = "gone dark"
  oddRule: OddRule;
  soloThreshold: number; // hider teams <= this -> everyone plays solo with alliances
  hunterTeams: number;
  caughtJoinHunters: boolean;
  endgameMinutes: number;
  endgameRevealEveryMinutes: number;
  endgameRevealSeconds: number;
  combatRangeM: number; // hunter camera turns on inside this range
  mods: boolean; // abilities (phase 2)
  preset: PresetId;
};

export type PresetId = 'quick' | 'classic' | 'long' | 'custom';

/** The timing knobs a preset sets. Everything else keeps its own value. */
export type PresetValues = Pick<Settings, 'matchMinutes' | 'pingMinutes' | 'revealSeconds' | 'warnSeconds' | 'freezeSeconds' | 'campMinutes' | 'outsideGraceSeconds' | 'endgameMinutes' | 'endgameRevealEveryMinutes'>;

export const PRESETS: Record<Exclude<PresetId, 'custom'>, { name: string; blurb: string; values: PresetValues }> = {
  quick: {
    name: 'Quick', blurb: '45 minutes. Pings every 5 min.',
    values: { matchMinutes: 45, pingMinutes: 5, revealSeconds: 15, warnSeconds: 15, freezeSeconds: 120, campMinutes: 5, outsideGraceSeconds: 60, endgameMinutes: 10, endgameRevealEveryMinutes: 3 },
  },
  classic: {
    name: 'Classic', blurb: '2 hours. Pings every 10 min.',
    values: { matchMinutes: 120, pingMinutes: 10, revealSeconds: 20, warnSeconds: 15, freezeSeconds: 180, campMinutes: 7, outsideGraceSeconds: 90, endgameMinutes: 15, endgameRevealEveryMinutes: 4 },
  },
  long: {
    name: 'Long haul', blurb: '4 hours. Pings every 15 min.',
    values: { matchMinutes: 240, pingMinutes: 15, revealSeconds: 20, warnSeconds: 20, freezeSeconds: 300, campMinutes: 10, outsideGraceSeconds: 120, endgameMinutes: 20, endgameRevealEveryMinutes: 5 },
  },
};

export const DEFAULT_SETTINGS: Settings = {
  ...PRESETS.classic.values,
  freezeMaxSteps: 8,
  freezeRadiusM: 15,
  campRadiusM: 20,
  darkSeconds: 60,
  oddRule: 'solo',
  soloThreshold: 2,
  hunterTeams: 1,
  caughtJoinHunters: false,
  endgameRevealSeconds: 3,
  combatRangeM: 30,
  mods: false,
  preset: 'classic',
};

export type Role = 'hunter' | 'hider';
export type PlayerStatus = 'active' | 'caught' | 'dq';
export type Phase = 'lobby' | 'teams' | 'freeze' | 'live' | 'ended';

export type PublicPlayer = {
  id: string;
  name: string;
  teamId: string | null;
  status: PlayerStatus;
  connected: boolean;
  ready: boolean;
};

export type Team = { id: string; name: string; role: Role; members: string[]; color: string };

export type Marker = { id: string; teamId: string; lat: number; lng: number; label: string; by: string };

export type Winner = { side: Role; teamIds: string[]; reason: string; elapsedMs: number };

export type PublicState = {
  code: string;
  phase: Phase;
  hostId: string;
  players: PublicPlayer[];
  teams: Team[];
  settings: Settings;
  area: Area | null;
  soloMode: boolean;
  spin: { at: number; order: string[] } | null;
  startedAt: number | null;
  freezeEndsAt: number | null;
  endsAt: number | null;
  nextPingAt: number | null; // null during endgame (no warning)
  endgame: boolean;
  winner: Winner | null;
  endVote: EndVote | null;
  // personalised fields
  you: string;
  alliance: string[]; // player ids you are allied with (solo mode)
  markers: Marker[]; // your team's markers only
  radio: { ch: number; home: number | null; talker: string | null };
};

/** Ending early needs a yes from every player who is still around. */
export type EndVote = { by: string; startedAt: number; expiresAt: number; yes: string[]; needed: string[] };

export const RADIO_CHANNELS = 99;
/** Walkie audio: 8 kHz mono, mu-law, 60 ms per binary frame. */
export const RADIO_RATE = 8000;
export const RADIO_FRAME = 480;

export type VisReason = 'team' | 'ally' | 'ping' | 'camping' | 'outside' | 'dark';

export type VisiblePlayer = {
  id: string;
  lat: number;
  lng: number;
  acc: number;
  reason: VisReason;
  at: number; // when this position was recorded
};

export type GameEvent = {
  id: string;
  at: number;
  kind:
    | 'join' | 'leave' | 'start' | 'freeze-over' | 'caught' | 'dq' | 'camping' | 'outside'
    | 'dark' | 'endgame' | 'win' | 'alliance' | 'dispute' | 'warning' | 'info' | 'vote';
  text: string;
  important?: boolean; // show as a full banner + voice
};

export type TagClaim = { id: string; hunterId: string; targetId: string; at: number; votes?: Record<string, boolean> };

export type HistoryFrame = { t: number; p: Record<string, [number, number]> };

export type ClientMsg =
  | { t: 'loc'; lat: number; lng: number; acc: number; at: number }
  | { t: 'freeze'; steps: number; still: boolean; camOk: boolean }
  | { t: 'setArea'; area: Area }
  | { t: 'setSettings'; settings: Partial<Settings> }
  | { t: 'spin' }
  | { t: 'teamName'; name: string }
  | { t: 'rename'; name: string }
  | { t: 'start' }
  | { t: 'hit'; targetId: string }
  | { t: 'tagReply'; tagId: string; accept: boolean }
  | { t: 'vote'; tagId: string; hit: boolean }
  | { t: 'allyReq'; targetId: string }
  | { t: 'allyReply'; fromId: string; accept: boolean }
  | { t: 'allyLeave' }
  | { t: 'marker'; op: 'add'; lat: number; lng: number; label: string }
  | { t: 'marker'; op: 'del'; id: string }
  | { t: 'kick'; playerId: string }
  | { t: 'reset' }
  | { t: 'end' }
  | { t: 'history' }
  | { t: 'ready'; ready: boolean }
  | { t: 'voteEnd'; yes: boolean }
  | { t: 'tune'; ch: number }
  | { t: 'ptt'; on: boolean }
  | { t: 'say'; text: string };

export type ServerMsg =
  | { t: 'state'; s: PublicState }
  | {
      t: 'tick';
      now: number;
      vis: VisiblePlayer[];
      prox: number; // 0 (nobody near) .. 5 (on top of you)
      targets: string[]; // hunters: hiders inside combat range
      revealUntil: number | null;
      exposed: VisReason | null; // why YOU are currently exposed, if you are
      outsideSince: number | null;
    }
  | { t: 'event'; e: GameEvent }
  | { t: 'warn'; pingAt: number }
  | { t: 'tagPrompt'; tag: TagClaim }
  | { t: 'votePrompt'; tag: TagClaim }
  | { t: 'allyPrompt'; fromId: string }
  | { t: 'history'; frames: HistoryFrame[]; events: GameEvent[] }
  | { t: 'error'; msg: string }
  | { t: 'rx'; ch: number; from: string; on: boolean } // someone keyed up / released on your channel
  | { t: 'pttDenied'; talker: string }
  | { t: 'chat'; ch: number; from: string; text: string; at: number };

export const TEAM_COLORS = ['#2ec4b6', '#4ea8de', '#a78bfa', '#f4d35e', '#f78fb3', '#9ad65c', '#5eead4', '#c4b5fd', '#fca5a5', '#93c5fd'];
export const HUNTER_COLOR = '#ff6b1a';

/** Proximity buckets in metres, nearest first. Index+1 is the level. */
export const PROX_BUCKETS = [15, 35, 60, 100, 150];
export function proxLevel(d: number): number {
  for (let i = 0; i < PROX_BUCKETS.length; i++) if (d <= PROX_BUCKETS[i]) return 5 - i;
  return 0;
}
