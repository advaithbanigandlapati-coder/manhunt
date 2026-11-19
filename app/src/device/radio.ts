// Walkie-talkie audio. The mic is downsampled to 8 kHz and mu-law encoded (64 kbit/s,
// real radio quality) in 60 ms frames that go through the game server to everyone
// tuned to the same channel. Playback uses a small jitter buffer plus a radio filter.
import { RADIO_FRAME, RADIO_RATE } from '../../../shared/protocol';
import { getAudio, getMaster, radioHiss, sfx, unlockAudio } from './audio';

// ---------- G.711 mu-law ----------
const BIAS = 0x84, CLIP = 32635;
function encodeSample(s: number) {
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const man = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | man) & 0xff;
}
const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exp = (u >> 4) & 7, man = u & 0x0f;
  let s = (((man << 3) + BIAS) << exp) - BIAS;
  if (u & 0x80) s = -s;
  DECODE[i] = s / 32768;
}
export function encodeFrame(pcm: Int16Array) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i]);
  return out;
}

// ---------- worklets (inline, loaded from a blob URL) ----------
const WORKLETS = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${RADIO_RATE}; this.pos = 0; this.lp = 0; this.lp2 = 0; this.buf = new Int16Array(${RADIO_FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.lp += (ch[i] - this.lp) * 0.3; this.lp2 += (this.lp - this.lp2) * 0.3;
      if (++this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.lp2 * 2.2));
        this.buf[this.n++] = v * 32767;
        if (this.n === ${RADIO_FRAME}) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('mh-cap', Cap);
class Play extends AudioWorkletProcessor {
  constructor() {
    super(); this.q = []; this.cur = null; this.i = 0; this.started = false; this.buffered = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.q = []; this.cur = null; this.started = false; this.buffered = 0; return; }
      this.q.push(e.data); this.buffered += e.data.length;
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    if (!this.started && this.buffered < sampleRate * 0.12) { out.fill(0); return true; }
    this.started = true;
    for (let k = 0; k < out.length; k++) {
      if (!this.cur || this.i >= this.cur.length) {
        this.cur = this.q.shift(); this.i = 0;
        if (!this.cur) { out.fill(0, k); this.started = false; this.buffered = 0; return true; }
        this.buffered -= this.cur.length;
      }
      out[k] = this.cur[this.i++];
    }
    return true;
  }
}
registerProcessor('mh-play', Play);
`;

let loaded: Promise<void> | null = null;
function ensureWorklets() {
  const ctx = getAudio()!;
  loaded ??= ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLETS], { type: 'text/javascript' })));
  return loaded;
}

// ---------- playback ----------
let player: AudioWorkletNode | null = null;
let stopHiss: (() => void) | null = null;

async function ensurePlayer() {
  const ctx = getAudio();
  if (!ctx) return null;
  if (player) return player;
  await ensureWorklets();
  player = new AudioWorkletNode(ctx, 'mh-play', { outputChannelCount: [1] });
  // radio voice: band-limited, a little crunchy
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3300;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1700; mid.gain.value = 5;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
  shaper.curve = curve;
  const g = ctx.createGain(); g.gain.value = 1.4;
  player.connect(hp).connect(mid).connect(lp).connect(shaper).connect(g).connect(getMaster()!);
  return player;
}

/** Incoming mu-law frame from the server. */
export async function receiveFrame(buf: ArrayBuffer) {
  const p = await ensurePlayer();
  const ctx = getAudio();
  if (!p || !ctx) return;
  const u = new Uint8Array(buf);
  const ratio = ctx.sampleRate / RADIO_RATE;
  const out = new Float32Array(Math.floor(u.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i / ratio, j = Math.floor(x), f = x - j;
    const a = DECODE[u[j]], b = DECODE[u[Math.min(j + 1, u.length - 1)]];
    out[i] = a + (b - a) * f;
  }
  p.port.postMessage(out, [out.buffer]);
}

/** Someone keyed up / released on our channel. */
export function rxState(on: boolean) {
  if (on) {
    sfx.keyUp();
    stopHiss?.();
    stopHiss = radioHiss();
  } else {
    stopHiss?.();
    stopHiss = null;
    sfx.roger();
    setTimeout(() => sfx.squelch(), 120);
    player?.port.postMessage('flush');
  }
}

// ---------- capture ----------
let mic: MediaStream | null = null;
let cap: AudioWorkletNode | null = null;
let sending: ((frame: Uint8Array) => void) | null = null;

export async function openMic(): Promise<boolean> {
  unlockAudio();
  const ctx = getAudio()!;
  if (mic && cap) return true;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch {
    return false;
  }
  await ensureWorklets();
  cap = new AudioWorkletNode(ctx, 'mh-cap');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  ctx.createMediaStreamSource(mic).connect(cap).connect(mute).connect(ctx.destination);
  cap.port.onmessage = (e) => sending?.(encodeFrame(e.data as Int16Array));
  return true;
}

export function closeMic() {
  sending = null;
  cap?.disconnect();
  cap = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
}

export function startSending(send: (frame: Uint8Array) => void) { sending = send; }
export function stopSending() { sending = null; }
export const micOpen = () => !!mic;
