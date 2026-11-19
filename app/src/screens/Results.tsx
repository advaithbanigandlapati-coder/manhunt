import { useEffect, useMemo, useState } from 'react';
import type { PublicState } from '../../../shared/protocol';
import { HUNTER_COLOR } from '../../../shared/protocol';
import { leaveParty, send, useStore } from '../store';
import { GameMap, type MapPlayer } from '../map/GameMap';
import { fmtClock } from '../device/device';
import { Icon, Topo } from '../ui/icons';

export function Results({ s }: { s: PublicState }) {
  const hist = useStore((x) => x.history);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const w = s.winner;
  const myTeam = s.teams.find((t) => t.members.includes(s.you));
  const won = !!w && !!myTeam && w.teamIds.includes(myTeam.id);

  useEffect(() => { send({ t: 'history' }); }, []);
  const frames = hist?.frames ?? [];
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setI((x) => { if (x >= frames.length - 1) { setPlaying(false); return x; } return x + 1; }), 110);
    return () => clearInterval(id);
  }, [playing, frames.length]);

  const fr = frames[Math.min(i, frames.length - 1)];
  const players: MapPlayer[] = useMemo(() => {
    if (!fr) return [];
    return Object.entries(fr.p).map(([id, [lat, lng]]) => {
      const t = s.teams.find((x) => x.members.includes(id));
      const n = s.players.find((p) => p.id === id)?.name ?? '?';
      return { id, lat, lng, label: n.slice(0, 2).toUpperCase(), title: n, kind: 'replay', color: t?.role === 'hunter' ? HUNTER_COLOR : t?.color ?? '#9aa69d' };
    });
  }, [fr, s.teams, s.players]);
  const t0 = s.startedAt ?? frames[0]?.t ?? 0;

  return (
    <div className="screen scroll results">
      <div className="page">
        <div className={`result-hero ${won ? 'won' : ''}`}>
          <Topo className="topo" />
          <small>{w ? (won ? 'You won' : 'You lost') : 'Match over'}</small>
          <h1>{w ? `${w.side === 'hunter' ? 'Hunters' : 'Hiders'} win` : 'No winner'}</h1>
          <p>{w ? `${w.teamIds.map((id) => s.teams.find((t) => t.id === id)?.name).join(' and ')}. ${w.reason}. ${fmtClock(w.elapsedMs)}` : 'The match was ended early.'}</p>
        </div>

        <section className="card">
          <div className="card-head"><h2>Replay</h2><span className="aside">{frames.length > 1 ? fmtClock((fr?.t ?? t0) - t0) : ''}</span></div>
          <div className="replay-map"><GameMap area={s.area} fitKey={s.area} players={players} /></div>
          {frames.length > 1 ? (
            <div className="replay-controls">
              <button className="btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (i >= frames.length - 1) setI(0); setPlaying(!playing); }}><Icon name={playing ? 'pause' : 'play'} size={20} /></button>
              <input type="range" aria-label="Replay position" min={0} max={frames.length - 1} value={i} onChange={(e) => { setPlaying(false); setI(+e.target.value); }} />
            </div>
          ) : <p className="hint">{hist ? 'Not enough movement recorded for a replay.' : 'Loading the replay…'}</p>}
        </section>

        <section className="card">
          <div className="card-head"><h2>Timeline</h2><span className="aside">Tap to jump</span></div>
          <ul className="feed">
            {(hist?.events ?? []).map((e) => (
              <li key={e.id} className={`ev-${e.kind}`} onClick={() => { const k = frames.findIndex((f) => f.t >= e.at); if (k >= 0) { setPlaying(false); setI(k); } }}>
                <time>{fmtClock(e.at - t0)}</time>{e.text}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="sticky-cta">
        {s.you === s.hostId ? <button className="btn primary big block" onClick={() => send({ t: 'reset' })}>Play again</button> : <p className="hint">The host can start another round.</p>}
        <button className="btn ghost block" onClick={leaveParty}>Leave game</button>
      </div>
    </div>
  );
}
