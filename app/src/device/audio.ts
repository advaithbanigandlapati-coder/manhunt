// Sound engine. Everything except the announcer is synthesised with Web Audio:
// a master bus with a compressor and a small generated reverb gives the sounds weight.
// iOS only allows audio after a tap, so unlockAudio() must run inside a click handler.

let ctx: AudioContext | null = null;
let master: GainNode;
let verb: ConvolverNode;
let verbIn: GainNode;
const clips = new Map<string, AudioBuffer>();

export const VOICE_LINES = [
  'start', 'released', 'ping_incoming', 'ping', 'endgame', 'tagged', 'caught', 'dq', 'camping', 'outside', 'inside',
  'target', 'freeze_broken', 'hunters_win', 'hiders_win', 'match_over', 'vote_started', 'vote_passed', 'alliance',
  'dispute', 'min30', 'min10', 'min5', 'min1', 'ready',
] as const;
export type VoiceLine = (typeof VOICE_LINES)[number];

// ---------- prefs ----------
type Prefs = { sfx: boolean; voice: boolean };
let prefs: Prefs = { sfx: true, voice: true };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('mh.sound') ?? '{}') }; } catch { /* default */ }
export const soundPrefs = () => prefs;
export function setSoundPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p };
  try { localStorage.setItem('mh.sound', JSON.stringify(prefs)); } catch { /* ignore */ }
}

// ---------- setup ----------
function impulse(c: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(c.sampleRate * seconds);
  const b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return b;
}

export function getAudio(): AudioContext | null { return ctx; }
export function getMaster(): AudioNode | null { return ctx ? master : null; }

export function unlockAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(ctx.destination);
    verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 1.6, 3);
    verbIn = ctx.createGain();
    verbIn.gain.value = 0.35;
    verbIn.connect(verb).connect(master);
    void loadVoice();
  }
  if (ctx.state !== 'running') void ctx.resume();
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, 22050);
  s.connect(ctx.destination);
  s.start();
}
export const audioReady = () => ctx?.state === 'running';

async function loadVoice() {
  const base = import.meta.env.BASE_URL ?? '/';
  await Promise.all(VOICE_LINES.map(async (k) => {
    try {
      const buf = await (await fetch(`${base}voice/${k}.mp3`)).arrayBuffer();
      clips.set(k, await ctx!.decodeAudioData(buf));
    } catch { /* missing clip: stay silent */ }
  }));
}

// ---------- building blocks ----------
type ToneOpts = { to?: number; attack?: number; wet?: number; dest?: AudioNode; detune?: number };
function tone(type: OscillatorType, f: number, t: number, dur: number, gain: number, o: ToneOpts = {}) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  if (o.detune) osc.detune.value = o.detune;
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + (o.attack ?? 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(o.dest ?? master);
  if (o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w).connect(verbIn); }
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

let noiseBuf: AudioBuffer | null = null;
function noise(t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 1, o: { to?: number; wet?: number; dest?: AudioNode } = {}) {
  if (!ctx) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(o.dest ?? master);
  if (o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w).connect(verbIn); }
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

/** FM bell: a sine carrier modulated by a decaying sine. */
function bell(f: number, t: number, dur: number, gain: number, ratio = 3.5, index = 3, wet = 0.5) {
  if (!ctx) return;
  const car = ctx.createOscillator();
  const mod = ctx.createOscillator();
  const mg = ctx.createGain();
  const g = ctx.createGain();
  car.frequency.value = f;
  mod.frequency.value = f * ratio;
  mg.gain.setValueAtTime(f * index, t);
  mg.gain.exponentialRampToValueAtTime(1, t + dur * 0.6);
  mod.connect(mg).connect(car.frequency);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  car.connect(g).connect(master);
  const w = ctx.createGain();
  w.gain.value = wet;
  g.connect(w).connect(verbIn);
  car.start(t); mod.start(t);
  car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
}

const now = () => ctx!.currentTime + 0.01;
const on = () => !!ctx && prefs.sfx;

// ---------- sound effects ----------
export const sfx = {
  tap() { if (!on()) return; const t = now(); noise(t, 0.025, 0.12, 'bandpass', 3200, 2); tone('sine', 1900, t, 0.04, 0.04); },
  toggle() { if (!on()) return; const t = now(); tone('triangle', 660, t, 0.06, 0.08); tone('triangle', 990, t + 0.05, 0.08, 0.07); },

  /** Original two-bar ring for the fake incoming call. Returns stop(). */
  ring(): () => void {
    if (!on()) return () => {};
    let stopped = false;
    const motif = [659.3, 987.8, 830.6, 987.8, 659.3, 1318.5];
    const play = () => {
      if (stopped || !ctx) return;
      const t = now();
      motif.forEach((f, i) => bell(f, t + i * 0.16, 0.7, 0.16, 2, 2.2, 0.35));
    };
    play();
    const id = setInterval(play, 1900);
    return () => { stopped = true; clearInterval(id); };
  },

  /** Sonar ping + sweep when locations are revealed. */
  sonar() {
    if (!on()) return;
    const t = now();
    tone('sine', 1180, t, 1.6, 0.32, { to: 1050, wet: 1.2 });
    tone('sine', 59, t, 0.4, 0.4, { to: 38 });
    noise(t + 0.05, 1.1, 0.06, 'bandpass', 400, 3, { to: 3800, wet: 0.6 });
  },

  /** Lub-dub with a real low-end thump. */
  heartbeat(strength = 1) {
    if (!on()) return;
    const t = now();
    const s = Math.min(1.4, strength);
    tone('sine', 62, t, 0.16, 0.7 * s, { to: 38, attack: 0.004 });
    noise(t, 0.05, 0.12 * s, 'lowpass', 180, 0.7);
    tone('sine', 54, t + 0.21, 0.2, 0.5 * s, { to: 34, attack: 0.004 });
    noise(t + 0.21, 0.05, 0.08 * s, 'lowpass', 160, 0.7);
  },

  /** Short countdown tick (last seconds before a ping). */
  tick() { if (!on()) return; const t = now(); tone('sine', 1760, t, 0.05, 0.1); noise(t, 0.02, 0.06, 'highpass', 4000); },

  /** Generic heads-up before the announcer speaks. */
  attention() { if (!on()) return; const t = now(); bell(880, t, 0.5, 0.12, 1.5, 1.2, 0.4); bell(1318.5, t + 0.12, 0.6, 0.1, 1.5, 1.2, 0.4); },

  caught() {
    if (!on()) return;
    const t = now();
    for (const [f, d] of [[110, -8], [164.8, 6], [220, 0]] as const) tone('sawtooth', f, t, 0.9, 0.09, { to: f * 0.7, detune: d, wet: 0.5 });
    noise(t, 0.35, 0.2, 'lowpass', 900, 0.8, { to: 120, wet: 0.4 });
  },
  tagged() {
    if (!on()) return;
    const t = now();
    tone('square', 880, t, 0.5, 0.08, { to: 220, wet: 0.4 });
    tone('sawtooth', 440, t + 0.05, 0.6, 0.07, { to: 110, wet: 0.4 });
    noise(t, 0.4, 0.18, 'bandpass', 1200, 1, { to: 200 });
  },
  endgame() {
    if (!on()) return;
    const t = now();
    tone('sawtooth', 55, t, 2.6, 0.18, { attack: 1.2, wet: 0.6 });
    tone('sawtooth', 55.6, t, 2.6, 0.14, { attack: 1.2, wet: 0.6 });
    for (let i = 0; i < 3; i++) tone('square', 740, t + 1.3 + i * 0.32, 0.18, 0.05, { wet: 0.5 });
  },
  win() {
    if (!on()) return;
    const t = now();
    [523.3, 659.3, 784, 1046.5].forEach((f, i) => bell(f, t + i * 0.13, 1.4, 0.14, 2, 1.5, 0.6));
  },
  lose() {
    if (!on()) return;
    const t = now();
    [392, 311.1, 261.6, 196].forEach((f, i) => tone('triangle', f, t + i * 0.2, 0.9, 0.12, { wet: 0.6 }));
  },
  denied() { if (!on()) return; const t = now(); tone('square', 180, t, 0.12, 0.08); tone('square', 150, t + 0.14, 0.18, 0.08); },
  combat() { if (!on()) return; const t = now(); for (let i = 0; i < 3; i++) tone('square', 1400, t + i * 0.11, 0.06, 0.06); },

  // ---------- walkie ----------
  keyUp() { if (!ctx) return; const t = now(); noise(t, 0.03, 0.25, 'bandpass', 2400, 1.5); tone('square', 120, t, 0.02, 0.05); },
  roger() { if (!ctx) return; const t = now(); tone('square', 1250, t, 0.07, 0.05); tone('square', 1650, t + 0.075, 0.09, 0.05); },
  squelch() { if (!ctx) return; const t = now(); noise(t, 0.22, 0.22, 'bandpass', 1800, 0.8, { to: 900 }); },
  dial() { if (!ctx) return; const t = now(); noise(t, 0.015, 0.15, 'bandpass', 5000, 4); },
};

/** Faint hiss that sits under incoming radio audio. Returns stop(). */
export function radioHiss(): () => void {
  if (!ctx) return () => {};
  const t = now();
  const src = ctx.createBufferSource();
  if (!noiseBuf) noise(t, 0.001, 0.0001, 'lowpass', 100); // makes noiseBuf
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 2200;
  f.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.035, t + 0.05);
  src.connect(f).connect(g).connect(master);
  src.start();
  return () => {
    const e = ctx!.currentTime;
    g.gain.setValueAtTime(g.gain.value, e);
    g.gain.exponentialRampToValueAtTime(0.0001, e + 0.08);
    src.stop(e + 0.1);
  };
}

// ---------- announcer ----------
let speaking: AudioBufferSourceNode | null = null;
/** Deep British announcer (pre-rendered clips). */
export function announce(line: VoiceLine, opts: { chime?: boolean } = {}) {
  if (!ctx || !prefs.voice) return;
  const buf = clips.get(line);
  if (!buf) return;
  try { speaking?.stop(); } catch { /* already done */ }
  if (opts.chime !== false && prefs.sfx) sfx.attention();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 1.15;
  src.connect(g).connect(master);
  const w = ctx.createGain();
  w.gain.value = 0.12;
  g.connect(w).connect(verbIn);
  src.start(ctx.currentTime + (opts.chime !== false && prefs.sfx ? 0.42 : 0.02));
  speaking = src;
}
