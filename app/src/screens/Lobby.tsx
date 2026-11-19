import { useEffect, useState } from 'react';
import { PRESETS, type PresetId, type PublicState, type Settings, type Team } from '../../../shared/protocol';
import { leaveParty, send, toast } from '../store';
import { GameMap } from '../map/GameMap';
import { AreaEditor } from '../map/AreaEditor';
import { getReady, useReady } from '../ready';
import { ft } from '../device/device';
import { sfx } from '../device/audio';
import { Icon, type IconName } from '../ui/icons';
import { Sheet, SliderRow, Switch, fmtDuration, fmtSecs } from '../ui/kit';

const TIMING: (keyof Settings)[] = ['matchMinutes', 'pingMinutes', 'revealSeconds', 'warnSeconds', 'freezeSeconds', 'campMinutes', 'outsideGraceSeconds', 'endgameMinutes', 'endgameRevealEveryMinutes'];

function ruleLines(s: Settings): [IconName, string][] {
  return [
    ['timer', `The match lasts ${fmtDuration(s.matchMinutes)}.`],
    ['eye', `Every ${fmtDuration(s.pingMinutes)}, everyone shows on the map for ${s.revealSeconds} seconds. A fake call warns you ${s.warnSeconds} seconds before.`],
    ['target', s.freezeSeconds ? `Hunters stay frozen for ${fmtSecs(s.freezeSeconds)} at the start, camera on, while everyone else runs.` : 'Hunters start chasing right away.'],
    ['flag', `Stay in one spot for ${s.campMinutes} minutes and your location gets exposed.`],
    ['map', `Leave the play area for ${fmtSecs(s.outsideGraceSeconds)} and you're out.`],
    ['radio', 'Each team gets a secret radio channel. Anyone who finds it can listen in.'],
    ['users', `When one team is left, a ${fmtDuration(s.endgameMinutes)} endgame starts with surprise reveals.`],
    ['vote', 'Ending early needs a yes from every player.'],
  ];
}

function RulesSheet({ s, host, onClose }: { s: Settings; host: boolean; onClose: () => void }) {
  const set = (k: keyof Settings, v: number | boolean | string) => send({ t: 'setSettings', settings: { [k]: v, ...(TIMING.includes(k) ? { preset: 'custom' } : {}) } });
  const row = (k: keyof Settings, label: string, min: number, max: number, step: number, fmt: (v: number) => string) =>
    <SliderRow key={k} label={label} value={s[k] as number} min={min} max={max} step={step} fmt={fmt} disabled={!host} onCommit={(v) => set(k, v)} />;
  return (
    <Sheet onClose={onClose} label="Game rules">
      <h2>Game rules</h2>
      {!host && <p className="hint">Only the host can change these.</p>}
      <div className="rules-group">
        <h3>Match</h3>
        {row('matchMinutes', 'Length', 15, 480, 15, fmtDuration)}
      </div>
      <div className="rules-group">
        <h3>Location pings</h3>
        <p>Everyone is revealed on a timer. The fake call comes first.</p>
        {row('pingMinutes', 'Ping every', 1, 60, 1, fmtDuration)}
        {row('revealSeconds', 'Everyone visible for', 5, 60, 1, (v) => `${v} s`)}
        {row('warnSeconds', 'Warning call', 5, 60, 1, (v) => `${v} s before`)}
      </div>
      <div className="rules-group">
        <h3>Hunter head start</h3>
        <p>Hunters can't move and must keep their camera uncovered. Breaking it loses the match.</p>
        {row('freezeSeconds', 'Freeze', 0, 900, 15, (v) => (v ? fmtSecs(v) : 'Off'))}
        {row('freezeMaxSteps', 'Steps allowed', 0, 20, 1, (v) => `${v}`)}
      </div>
      <div className="rules-group">
        <h3>Hiding</h3>
        {row('campMinutes', 'Exposed after staying put for', 2, 30, 1, (v) => `${v} min`)}
        {row('outsideGraceSeconds', 'Out of bounds allowed for', 15, 600, 15, fmtSecs)}
      </div>
      <div className="rules-group">
        <h3>Endgame</h3>
        <p>Starts when only one hiding team is left. Reveals come with no warning.</p>
        {row('endgameMinutes', 'Length', 5, 90, 5, fmtDuration)}
        {row('endgameRevealEveryMinutes', 'Reveal every', 1, 15, 1, (v) => `${v} min`)}
      </div>
      <div className="rules-group">
        <h3>Teams</h3>
        <div className="hint">If someone is left over after pairing</div>
        <div className="seg">
          {(['solo', 'hunters', 'trio'] as const).map((o) => (
            <button key={o} disabled={!host} className={s.oddRule === o ? 'on' : ''} onClick={() => set('oddRule', o)}>
              {o === 'solo' ? 'Plays solo' : o === 'hunters' ? 'Joins hunters' : 'Team of 3'}
            </button>
          ))}
        </div>
        {row('hunterTeams', 'Hunter teams', 1, 3, 1, (v) => `${v}`)}
        {row('soloThreshold', 'Free-for-all when hiding teams are', 0, 4, 1, (v) => (v ? `${v} or fewer` : 'Never'))}
        <p>In free-for-all everyone hides alone and can form alliances.</p>
        <Switch label="Caught players become hunters" on={s.caughtJoinHunters} disabled={!host} onChange={(v) => set('caughtJoinHunters', v)} />
      </div>
      <div className="rules-group">
        <h3>Tagging</h3>
        {row('combatRangeM', 'Hunter camera opens within', 10, 60, 1, ft)}
      </div>
      <button className="btn block" onClick={onClose}>Done</button>
    </Sheet>
  );
}

function Wheel({ s }: { s: PublicState }) {
  const spin = s.spin!;
  const [phase, setPhase] = useState<'spin' | 'reveal' | 'done'>(Date.now() - spin.at < 5000 ? 'spin' : 'done');
  const [rot, setRot] = useState(0);
  const names = spin.order.map((id) => s.players.find((p) => p.id === id)?.name ?? '?');
  const n = Math.max(names.length, 2);
  useEffect(() => {
    if (Date.now() - spin.at >= 5000) { setPhase('done'); return; }
    setPhase('spin');
    setRot(0);
    const a = requestAnimationFrame(() => setRot(360 * 6 + Math.random() * 360));
    const tick = setInterval(() => sfx.dial(), 110);
    const t1 = setTimeout(() => { clearInterval(tick); setPhase('reveal'); sfx.attention(); }, 3200);
    const t2 = setTimeout(() => setPhase('done'), 3200 + s.teams.length * 450 + 600);
    return () => { cancelAnimationFrame(a); clearInterval(tick); clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin.at]);
  if (phase !== 'spin') return <TeamCards s={s} animate={phase === 'reveal'} />;
  return (
    <div className="wheel-wrap">
      <div className="wheel-pointer" />
      <svg viewBox="-110 -110 220 220" className="wheel" style={{ transform: `rotate(${rot}deg)` }}>
        {names.map((name, i) => {
          const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, mid = (a0 + a1) / 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          return (
            <g key={i}>
              <path d={`M0 0 L${100 * Math.cos(a0)} ${100 * Math.sin(a0)} A100 100 0 ${large} 1 ${100 * Math.cos(a1)} ${100 * Math.sin(a1)} Z`} fill={i % 2 ? '#1b2520' : '#24302a'} stroke="#0c120e" strokeWidth="1.5" />
              <text x={62 * Math.cos(mid)} y={62 * Math.sin(mid)} transform={`rotate(${(mid * 180) / Math.PI} ${62 * Math.cos(mid)} ${62 * Math.sin(mid)})`} textAnchor="middle" dominantBaseline="middle" fill="#efe9dc" fontSize="11" fontWeight="700" fontFamily="Barlow Condensed">{name.slice(0, 10)}</text>
            </g>
          );
        })}
        <circle r="100" fill="none" stroke="#ff6b1a" strokeWidth="3" />
        <circle r="15" fill="#ff6b1a" />
      </svg>
    </div>
  );
}

function TeamCards({ s, animate }: { s: PublicState; animate: boolean }) {
  const mine = s.teams.find((t) => t.members.includes(s.you));
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(mine?.name ?? '');
  const ordered = [...s.teams.filter((t) => t.role === 'hider'), ...s.teams.filter((t) => t.role === 'hunter')];
  const nameOf = (id: string) => s.players.find((p) => p.id === id)?.name ?? '?';
  const save = () => { if (name.trim()) send({ t: 'teamName', name }); setEditing(false); };
  return (
    <div className="teams">
      {s.soloMode && <p className="hint">Not many hiders this round, so it's free-for-all. Team up with alliances during the match.</p>}
      {ordered.map((t: Team, i) => (
        <div key={t.id} className={`team-card ${animate ? 'pop' : ''}`} style={{ '--c': t.color, animationDelay: `${i * 0.45}s` } as React.CSSProperties}>
          {t.role === 'hunter' && <div className="stamp">HUNTERS</div>}
          <div className="team-name">
            {t.id === mine?.id && editing ? (
              <form className="row grow" onSubmit={(e) => { e.preventDefault(); save(); }}>
                <input className="input" autoFocus value={name} maxLength={24} onChange={(e) => setName(e.target.value)} onBlur={save} />
              </form>
            ) : (
              <>
                <b>{t.name}</b>
                {t.id === mine?.id && <button className="link" aria-label="Rename your team" onClick={() => { setName(t.name); setEditing(true); }}><Icon name="pencil" size={18} /></button>}
              </>
            )}
          </div>
          <div className="members">{t.members.map((id) => <span key={id} className={id === s.you ? 'me' : ''}>{nameOf(id)}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

export function Lobby({ s }: { s: PublicState }) {
  const host = s.you === s.hostId;
  const [editArea, setEditArea] = useState(false);
  const [rules, setRules] = useState(false);
  const ready = useReady();
  const me = s.players.find((p) => p.id === s.you);
  const myTeam = s.teams.find((t) => t.members.includes(s.you));
  const readyCount = s.players.filter((p) => p.ready).length;

  if (editArea && host) {
    return <AreaEditor initial={s.area} onCancel={() => setEditArea(false)} onSave={(area) => { send({ t: 'setArea', area }); setEditArea(false); }} />;
  }

  const share = async () => {
    const url = `${location.origin}${location.pathname}?code=${s.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Manhunt', text: `Join my Manhunt game. Code ${s.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    } catch { /* cancelled or blocked */ }
  };
  const pickPreset = (id: PresetId) => {
    sfx.tap();
    if (id === 'custom') { send({ t: 'setSettings', settings: { preset: 'custom' } }); setRules(true); return; }
    send({ t: 'setSettings', settings: { ...PRESETS[id].values, preset: id } });
  };
  const imReady = async () => {
    sfx.tap();
    await getReady(myTeam?.role === 'hunter');
    send({ t: 'ready', ready: true });
  };

  return (
    <div className="screen scroll">
      <div className="page">
        <div className="lobby-bar">
          <button className="icon-btn" aria-label="Leave party" onClick={leaveParty}><Icon name="back" /></button>
          <div className="code-chip">
            <div><small>Party code</small><br /><b>{s.code}</b></div>
            <button className="icon-btn" aria-label="Share invite" onClick={share}><Icon name="share" size={18} /></button>
          </div>
        </div>
        <h1 className="lobby-title">{s.phase === 'teams' ? 'Teams are set' : host ? 'Set up the hunt' : 'Waiting for the host'}</h1>

        {s.phase === 'teams' && s.spin && (
          <section className="card">
            <div className="card-head"><h2>Teams</h2>{myTeam && <span className="aside">You're {myTeam.role === 'hunter' ? 'hunting' : 'hiding'}</span>}</div>
            <Wheel s={s} />
          </section>
        )}

        <section className="card">
          <div className="card-head"><span className={`step-num ${s.area ? 'done' : ''}`}>{s.area ? <Icon name="check" size={16} /> : 1}</span><h2>Play area</h2></div>
          {s.area ? <div className="mini-map"><GameMap area={s.area} fitKey={s.area} /></div>
            : <p className="hint">{host ? 'Draw the zone you’re playing in. Search a place, drop a circle, then trace the streets.' : 'The host is picking the zone.'}</p>}
          {host && <button className={`btn ${s.area ? '' : 'primary'}`} onClick={() => setEditArea(true)}><Icon name="map" size={20} />{s.area ? 'Change area' : 'Draw the area'}</button>}
        </section>

        <section className="card">
          <div className="card-head"><span className="step-num done"><Icon name="check" size={16} /></span><h2>Game length</h2><button className="link" onClick={() => setRules(true)}>{host ? 'Edit rules' : 'All rules'}</button></div>
          {host && (
            <div className="preset-grid">
              {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((id) => (
                <button key={id} className={`preset ${s.settings.preset === id ? 'on' : ''}`} onClick={() => pickPreset(id)}>
                  <b>{PRESETS[id].name}</b><span>{PRESETS[id].blurb}</span>
                </button>
              ))}
              <button className={`preset ${s.settings.preset === 'custom' ? 'on' : ''}`} onClick={() => pickPreset('custom')}>
                <b>Custom</b><span>Set every timer yourself.</span>
              </button>
            </div>
          )}
          <ul className="rule-lines">
            {ruleLines(s.settings).map(([icon, text]) => <li key={text}><Icon name={icon} size={20} />{text}</li>)}
          </ul>
        </section>

        <section className="card">
          <div className="card-head"><span className={`step-num ${s.phase === 'teams' ? 'done' : ''}`}>{s.phase === 'teams' ? <Icon name="check" size={16} /> : 3}</span><h2>Players</h2><span className="aside">{s.players.length}{s.phase === 'teams' ? ` · ${readyCount} ready` : ''}</span></div>
          <ul className="players">
            {s.players.map((p) => (
              <li key={p.id}>
                <i className={p.connected ? 'dot on' : 'dot'} />
                <span className="name">{p.name}{p.id === s.you && ' (you)'}</span>
                {p.id === s.hostId && <span className="badge orange">Host</span>}
                {s.phase === 'teams' && <span className={`ready-tag ${p.ready ? 'yes' : ''}`}>{p.ready ? 'Ready' : 'Not ready'}</span>}
                {host && p.id !== s.hostId && <button className="link quiet" aria-label={`Remove ${p.name}`} onClick={() => send({ t: 'kick', playerId: p.id })}><Icon name="close" size={18} /></button>}
              </li>
            ))}
          </ul>
          {s.players.length < 2 && <p className="hint">Share the code so friends can join.</p>}
        </section>
      </div>

      <div className="sticky-cta">
        {s.phase === 'teams' && !me?.ready ? (
          <>
            <button className="btn primary big block" onClick={imReady}>I'm ready</button>
            <p className="hint">Turns on GPS, sound, motion{myTeam?.role === 'hunter' ? ' and the camera' : ''}. Keep the app open during the match.</p>
          </>
        ) : host ? (
          s.phase === 'lobby' ? (
            <>
              <button className="btn primary big block" disabled={s.players.length < 2 || !s.area} onClick={() => { sfx.tap(); send({ t: 'spin' }); }}><Icon name="shuffle" />Spin for teams</button>
              {(!s.area || s.players.length < 2) && <p className="hint">{!s.area ? 'Draw the play area first.' : 'Waiting for at least one more player.'}</p>}
            </>
          ) : (
            <>
              <button className="btn primary big block" onClick={() => send({ t: 'start' })}>Start the hunt</button>
              <p className="hint">{readyCount} of {s.players.length} ready{ready.done && ` · ${[ready.location ? null : 'no GPS', ready.audio ? null : 'no sound'].filter(Boolean).join(', ') || 'your phone is set'}`} · <button className="link" onClick={() => send({ t: 'spin' })}>Spin again</button></p>
            </>
          )
        ) : (
          <p className="hint">{s.phase === 'teams' ? 'You’re ready. The host starts the match.' : 'The host will spin for teams soon.'}</p>
        )}
      </div>

      {rules && <RulesSheet s={s.settings} host={host} onClose={() => setRules(false)} />}
    </div>
  );
}
