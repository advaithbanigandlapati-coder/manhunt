import { useEffect, useMemo, useRef, useState } from 'react';
import { HUNTER_COLOR, RADIO_CHANNELS, type PublicState } from '../../../shared/protocol';
import { pttDown, pttUp, send, serverNow, setRadioOpen, useStore } from '../store';
import { sfx } from '../device/audio';
import { Icon } from '../ui/icons';
import { GameMap, type MapPlayer } from '../map/GameMap';
import { lastFix } from '../device/geo';

const QUICK = ['Where are you?', 'Hunter near me', 'On the move', 'Hiding', 'Meet at the marker', 'Copy that'];

/** Hold-to-talk that works with touch, mouse and the space bar. */
export function usePtt() {
  const down = () => { void pttDown(); };
  const up = () => pttUp();
  return {
    onPointerDown: (e: React.PointerEvent) => { (e.target as Element).setPointerCapture?.(e.pointerId); down(); },
    onPointerUp: up,
    onPointerCancel: up,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

export function Walkie({ s, onClose }: { s: PublicState; onClose: () => void }) {
  const radio = useStore((x) => x.radio);
  const tick = useStore((x) => x.tick);
  const [tab, setTab] = useState<'log' | 'map'>('log');
  const [text, setText] = useState('');
  const [scanning, setScanning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const ptt = usePtt();
  const ch = s.radio.ch;
  const home = s.radio.home;
  const name = (id: string) => s.players.find((p) => p.id === id)?.name ?? 'Unknown';
  const team = s.teams.find((t) => t.members.includes(s.you));

  useEffect(() => { setRadioOpen(true); return () => { setRadioOpen(false); pttUp(); }; }, []);
  const entries = radio.log.filter((e) => e.ch === ch);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e6, behavior: 'smooth' }); }, [entries.length]);

  // space bar = push to talk on a computer
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); void pttDown(); } };
    const upk = (e: KeyboardEvent) => { if (e.code === 'Space') pttUp(); };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', upk);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', upk); };
  }, []);

  // scanner: step through channels, stop on any traffic
  const traffic = radio.rxFrom || entries.some((e) => serverNow() - e.at < 2500);
  useEffect(() => {
    if (!scanning) return;
    if (traffic) { setScanning(false); sfx.toggle(); return; }
    const id = setTimeout(() => { sfx.dial(); send({ t: 'tune', ch: (ch % RADIO_CHANNELS) + 1 }); }, 1500);
    return () => clearTimeout(id);
  }, [scanning, ch, traffic]);

  const tune = (n: number) => { setScanning(false); sfx.dial(); send({ t: 'tune', ch: ((n - 1 + RADIO_CHANNELS) % RADIO_CHANNELS) + 1 }); };
  const say = (t: string) => { if (!t.trim()) return; send({ t: 'say', text: t.trim() }); setText(''); };

  const busy = !!radio.rxFrom && !radio.talking;
  const status = radio.talking ? 'Transmitting' : radio.rxFrom ? `${name(radio.rxFrom)} talking` : scanning ? 'Scanning…' : ch === home ? 'Team channel' : home ? 'Not your channel' : 'Lobby channel';
  const sub = ch === home ? 'Anyone who finds this channel can listen.' : home ? `Your team is on ${home}.` : 'Everyone starts here.';

  const players: MapPlayer[] = useMemo(() => (tick?.vis ?? []).filter((v) => v.reason === 'team' || v.reason === 'ally').map((v) => ({
    id: v.id, lat: v.lat, lng: v.lng, label: name(v.id).slice(0, 2).toUpperCase(), kind: v.reason, color: team?.role === 'hunter' ? HUNTER_COLOR : team?.color ?? '#999',
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [tick]);
  const me = lastFix();

  return (
    <div className="walkie" role="dialog" aria-label="Radio">
      <div className="walkie-head">
        <button className="icon-btn" aria-label="Close radio" onClick={onClose}><Icon name="down" /></button>
        <h2>Radio</h2>
        {home && ch !== home && <button className="btn" style={{ minHeight: 44 }} onClick={() => tune(home)}>Back to team</button>}
      </div>

      <div className="lcd" aria-live="polite">
        <div className="lcd-ch"><small>CH</small>{String(ch).padStart(2, '0')}</div>
        <div className="lcd-status">{status}</div>
        <div className="lcd-sub">{sub}</div>
        <div className="lcd-lamps">
          <span className={`lamp rx ${radio.rxFrom ? 'on' : ''}`}><i />RX</span>
          <span className={`lamp tx ${radio.talking ? 'on' : ''}`}><i />TX</span>
          <span className={`lamp ${scanning ? 'on' : ''}`}><i />SCAN</span>
          <span className={`lamp ${ch === home ? 'on' : ''}`}><i />HOME</span>
        </div>
      </div>

      <div className="tuner">
        <button className="btn" aria-label="Channel down" onClick={() => tune(ch - 1)}><Icon name="minus" /></button>
        <button className={`btn ${scanning ? 'on' : ''}`} onClick={() => { sfx.toggle(); setScanning(!scanning); }}><Icon name="scan" size={20} />{scanning ? 'Stop' : 'Scan'}</button>
        <button className="btn" onClick={() => setTab(tab === 'log' ? 'map' : 'log')}><Icon name={tab === 'log' ? 'map' : 'list'} size={20} />{tab === 'log' ? 'Map' : 'Log'}</button>
        <button className="btn" aria-label="Channel up" onClick={() => tune(ch + 1)}><Icon name="plus" /></button>
      </div>

      {tab === 'log' ? (
        <div className="radio-log" ref={logRef}>
          {!entries.length && <p className="log-empty">Nothing on channel {ch} yet. Hold the button to talk, or send a quick message.</p>}
          {entries.map((e) => {
            const mine = e.from === s.you;
            const live = e.kind === 'voice' && !e.dur;
            return e.kind === 'voice' ? (
              <div key={e.id} className={`msg voice ${mine ? 'me' : ''} ${live ? 'live' : ''}`}>
                <Icon name="voice" size={18} />
                <div><span className="who">{mine ? 'You' : name(e.from)}</span>{live ? (mine ? 'Talking…' : 'Live') : `Voice · ${Math.max(1, Math.round((e.dur ?? 0) / 1000))}s`}</div>
                <span className="wave">{[8, 14, 10, 16, 7, 12].map((h, i) => <i key={i} style={{ height: h, animationDelay: `${i * 0.08}s` }} />)}</span>
              </div>
            ) : (
              <div key={e.id} className={`msg ${mine ? 'me' : ''}`}><span className="who">{mine ? 'You' : name(e.from)}</span>{e.text}</div>
            );
          })}
        </div>
      ) : (
        <div className="walkie-map">
          <GameMap area={s.area} fitKey={s.area} players={players} pins={s.markers} me={me ? { ...me, color: team?.color ?? '#ff6b1a' } : null} />
        </div>
      )}

      <div className="quick">{QUICK.map((q) => <button key={q} onClick={() => say(q)}>{q}</button>)}</div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); say(text); }}>
        <input className="input" value={text} maxLength={140} onChange={(e) => setText(e.target.value)} placeholder={`Message channel ${ch}`} />
        <button className="icon-btn" aria-label="Send" disabled={!text.trim()}><Icon name="send" size={20} /></button>
      </form>
      <div className="ptt-wrap">
        <button className={`ptt ${radio.talking ? 'talking' : ''} ${busy ? 'busy' : ''}`} {...ptt} aria-label="Hold to talk">
          <Icon name="mic" size={30} />
          <span>{radio.talking ? 'Talking' : busy ? `${name(radio.rxFrom!)} is talking` : 'Hold to talk'}<small>{radio.talking ? 'Let go to finish' : 'or hold the radio button on the map'}</small></span>
        </button>
      </div>
    </div>
  );
}
