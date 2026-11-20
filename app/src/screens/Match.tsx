import { useEffect, useMemo, useRef, useState } from 'react';
import type { AbilityId, Marker, PublicState } from '../../../shared/protocol';
import { HUNTER_COLOR } from '../../../shared/protocol';
import { leaveParty, pttDown, pttUp, send, serverNow, toast, useStore } from '../store';
import { GameMap, flyTo, type MapPlayer } from '../map/GameMap';
import type * as ml from 'maplibre-gl';
import { onFix, startGeo, simMoveTo, SIM, type Fix, geoError, lastFix } from '../device/geo';
import { fmtClock, keepAwake, vibrate, ft } from '../device/device';
import { announce, setSoundPrefs, sfx, soundPrefs, type VoiceLine } from '../device/audio';
import { CallScreen, CombatCam, FreezeCam, Radar } from './overlays';
import { Walkie } from './Walkie';
import { EffectsBar, PowersSheet, RollOverlay } from './Powers';
import { Icon } from '../ui/icons';
import { Sheet, Switch } from '../ui/kit';

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const QUICK_LABELS = ['Hide spot', 'Meet here', 'Hunters seen', 'Danger', 'Escape route'];
const TIME_CALLS: [number, VoiceLine][] = [[30, 'min30'], [10, 'min10'], [5, 'min5'], [1, 'min1']];

function useClock() {
  const [, f] = useState(0);
  useEffect(() => { const id = setInterval(() => f((x) => x + 1), 500); return () => clearInterval(id); }, []);
  return serverNow();
}

export function Match({ s }: { s: PublicState }) {
  const tick = useStore((x) => x.tick);
  const warnAt = useStore((x) => x.warnPingAt);
  const events = useStore((x) => x.events);
  const radio = useStore((x) => x.radio);
  const now = useClock();
  const [me, setMe] = useState<Fix | null>(null);
  const [map, setMap] = useState<ml.Map | null>(null);
  const [sheet, setSheet] = useState<null | 'team' | 'menu' | 'feed' | 'powers'>(null);
  const [pickAbility, setPickAbility] = useState<AbilityId | null>(null);
  const [walkie, setWalkie] = useState(false);
  const [pocket, setPocket] = useState(false);
  const [markMode, setMarkMode] = useState(false);
  const [newPin, setNewPin] = useState<{ lat: number; lng: number } | null>(null);
  const [pinLabel, setPinLabel] = useState('');
  const [openPin, setOpenPin] = useState<Marker | null>(null);
  const [night, setNight] = useState(() => { const h = new Date().getHours(); return h >= 18 || h < 7; });
  const [prefs, setPrefs] = useState(soundPrefs());
  const [camDismissed, setCamDismissed] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [seenEvents, setSeenEvents] = useState(0);
  const followed = useRef(false);

  const myPlayer = s.players.find((p) => p.id === s.you);
  const myTeam = s.teams.find((t) => t.members.includes(s.you));
  const role = myTeam?.role ?? 'hider';
  const active = myPlayer?.status === 'active';
  const color = role === 'hunter' ? HUNTER_COLOR : myTeam?.color ?? '#ff6b1a';
  const nameOf = (id: string) => s.players.find((p) => p.id === id)?.name ?? '?';
  const teamOf = (id: string) => s.teams.find((t) => t.members.includes(id));

  // GPS -> server, plus a keep-alive while standing still
  useEffect(() => {
    void startGeo();
    void keepAwake(true);
    let lastSent = 0;
    let latest: Fix | null = lastFix();
    if (latest) setMe(latest);
    const push = () => { if (!latest) return; lastSent = Date.now(); send({ t: 'loc', lat: latest.lat, lng: latest.lng, acc: latest.acc, at: latest.at }); };
    const off = onFix((f) => { latest = f; setMe(f); if (Date.now() - lastSent > 1500) push(); });
    const id = setInterval(() => { if (Date.now() - lastSent > 2500) push(); }, 1000);
    return () => { off(); clearInterval(id); };
  }, []);
  useEffect(() => { if (me && map && !followed.current) { followed.current = true; flyTo(map, me, 17); } }, [me, map]);

  // heartbeat
  const prox = active && s.phase === 'live' ? tick?.prox ?? 0 : 0;
  useEffect(() => {
    if (!prox) return;
    const ms = [0, 1300, 1000, 760, 540, 380][prox];
    const beat = () => { sfx.heartbeat(0.45 + prox * 0.15); vibrate([45, 120, 60]); };
    beat();
    const id = setInterval(beat, ms);
    return () => clearInterval(id);
  }, [prox]);

  // time calls + countdown ticks before a ping + "back inside"
  const called = useRef(new Set<number>());
  const timerMs = (s.endsAt ?? now) - now;
  useEffect(() => {
    if (s.phase !== 'live' || !s.startedAt || !s.endsAt) return;
    const total = (s.endsAt - s.startedAt) / 60000;
    for (const [m, line] of TIME_CALLS) {
      if (timerMs <= m * 60000 && timerMs > (m * 60000 - 5000) && total > m * 1.5 && !called.current.has(m)) { called.current.add(m); announce(line); }
    }
  }, [Math.floor(timerMs / 1000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const pingMs = s.nextPingAt ? s.nextPingAt - now : null;
  const pingSec = pingMs === null ? -1 : Math.ceil(pingMs / 1000);
  useEffect(() => { if (pingSec > 0 && pingSec <= 5) sfx.tick(); }, [pingSec]);
  const wasOutside = useRef(false);
  useEffect(() => {
    const out = tick?.exposed === 'outside';
    if (wasOutside.current && !out && active) announce('inside');
    wasOutside.current = out;
  }, [tick?.exposed, active]);

  const players: MapPlayer[] = useMemo(() => (tick?.vis ?? []).map((v) => {
    const t = teamOf(v.id);
    return {
      id: v.id, lat: v.lat, lng: v.lng, kind: v.reason, label: initials(nameOf(v.id)),
      color: t?.role === 'hunter' ? HUNTER_COLOR : t?.color ?? '#9aa69d',
      title: `${nameOf(v.id)} (${v.reason})`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tick, s.teams, s.players]);

  const targets = role === 'hunter' && active ? tick?.targets ?? [] : [];
  const targetKey = targets.slice().sort().join(',');
  const showCombat = targets.length > 0 && camDismissed !== targetKey && s.phase === 'live' && !walkie;
  const frozenHunter = s.phase === 'freeze' && role === 'hunter' && active;
  const revealing = !!tick?.revealUntil && tick.revealUntil > now;
  const vote = s.endVote;
  const iVoted = !!vote?.yes.includes(s.you);
  const unread = events.length - seenEvents;

  // radio button on the map: tap opens the radio, hold talks
  const holdT = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holding = useRef(false);
  const radioHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      holding.current = false;
      holdT.current = setTimeout(() => { holding.current = true; void pttDown(); }, 260);
    },
    onPointerUp: () => {
      clearTimeout(holdT.current);
      if (holding.current) pttUp(); else { sfx.tap(); setWalkie(true); }
      holding.current = false;
    },
    onPointerCancel: () => { clearTimeout(holdT.current); if (holding.current) pttUp(); holding.current = false; },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };

  const onMapTap = (p: { lat: number; lng: number }) => {
    if (pickAbility) { send({ t: 'use', ability: pickAbility, lat: p.lat, lng: p.lng }); setPickAbility(null); return; }
    if (markMode) { setNewPin(p); setPinLabel(''); setMarkMode(false); return; }
    if (SIM) simMoveTo(p.lat, p.lng);
  };

  return (
    <div className={`screen match ${prox ? `prox-${prox}` : ''}`}>
      <GameMap
        area={s.area} fitKey={s.startedAt} players={players} pins={s.markers} night={night}
        orbs={s.orbs} decoy={s.mods?.decoy ?? null}
        zones={s.mods?.zones.map((z) => ({ ...z, off: (s.mods?.until.disabled ?? 0) > now }))}
        me={me ? { ...me, color: active ? color : '#66736a' } : null}
        onReady={setMap} onClick={onMapTap}
        onLongPress={(p) => { setNewPin(p); setPinLabel(''); }}
        onPinTap={setOpenPin}
      >
        {revealing && <Radar until={tick!.revealUntil!} endgame={s.endgame} />}
      </GameMap>

      <div className="topbar">
        <div className="role-pill" style={{ '--c': color } as React.CSSProperties}>
          <b>{!active ? (myPlayer?.status === 'dq' ? 'OUT' : 'CAUGHT') : role === 'hunter' ? 'HUNTER' : s.soloMode ? 'SOLO' : 'HIDER'}</b>
          <small>{myTeam?.name}</small>
        </div>
        <div className={`ping-clock ${pingMs !== null && pingMs < 60000 ? 'soon' : ''}`}>
          <small>{s.endgame ? 'Endgame' : s.phase === 'freeze' ? 'Hunters free in' : 'Next ping'}</small>
          <b>{s.phase === 'freeze' ? fmtClock((s.freezeEndsAt ?? now) - now) : pingMs === null ? '??' : fmtClock(pingMs)}</b>
        </div>
        <div className="match-clock"><small>Time left</small><b>{fmtClock(timerMs)}</b></div>
      </div>

      <div className="status-stack">
        {vote && (
          <div className="vote-bar">
            <p>{nameOf(vote.by)} wants to end the match. {vote.yes.length} of {vote.needed.length} said yes.</p>
            {iVoted ? <p className="hint" style={{ color: '#4b5a50' }}>You voted yes. Waiting on {vote.needed.filter((id) => !vote.yes.includes(id)).map(nameOf).join(', ')}.</p> : (
              <div className="row">
                <button className="btn ghost" onClick={() => send({ t: 'voteEnd', yes: false })}>Keep playing</button>
                <button className="btn primary" onClick={() => send({ t: 'voteEnd', yes: true })}>End it</button>
              </div>
            )}
          </div>
        )}
        {s.phase === 'freeze' && role === 'hider' && <div className="status run">Run. Hunters are frozen for {fmtClock((s.freezeEndsAt ?? now) - now)}.</div>}
        {!active && <div className="status out">{myPlayer?.status === 'dq' ? 'You’re out.' : 'You were caught.'} You can still watch and use the radio.</div>}
        {tick?.exposed === 'outside' && <div className="status danger">Outside the area. Get back in {fmtClock((tick.outsideSince ?? now) + s.settings.outsideGraceSeconds * 1000 - now)}.</div>}
        {tick?.exposed === 'camping' && <div className="status warn">You stayed put too long, so everyone can see you. Move {ft(s.settings.campRadiusM)} to hide again.</div>}
        {tick?.exposed === 'dark' && <div className="status warn">No signal from your phone. Others see your last spot.</div>}
        {!me && geoError() && <div className="status warn">{geoError()}</div>}
        {radio.rxFrom && !walkie && <div className="status radio"><i />{nameOf(radio.rxFrom)} on channel {s.radio.ch}</div>}
        {s.alliance.length > 0 && <div className="status ally">Allied with {s.alliance.map(nameOf).join(', ')}</div>}
        {markMode && <div className="status ally">Tap the map to drop a marker for your team.</div>}
        {pickAbility && <div className="status ally">Tap the map where your decoy should appear. <button className="link" onClick={() => setPickAbility(null)}>Cancel</button></div>}
        <EffectsBar s={s} />
        {SIM && <div className="status sim">Simulated GPS. Tap the map to move.</div>}
      </div>

      <nav className="dock" aria-label="Match controls">
        {s.mods ? (
          <button className="dock-btn" aria-label={`Powers, ${s.mods.points} points`} onClick={() => { sfx.tap(); setSheet('powers'); }}>
            <Icon name="bolt" /><span className="pts">{s.mods.points}</span>
          </button>
        ) : (
          <button className="dock-btn" aria-label="Center on me" onClick={() => { sfx.tap(); if (me) flyTo(map, me, 17); }}><Icon name="locate" /></button>
        )}
        <button className={`dock-btn ${markMode ? 'on' : ''}`} aria-label="Drop a marker" onClick={() => { sfx.tap(); setMarkMode(!markMode); }}><Icon name="flag" /></button>
        <button className={`radio-btn ${radio.talking ? 'talking' : ''} ${radio.rxFrom ? 'rx' : ''}`} aria-label="Radio. Tap to open, hold to talk" {...radioHandlers}>
          <Icon name="radio" size={26} /><small>CH {s.radio.ch}</small>
        </button>
        <button className="dock-btn" aria-label="Teams" onClick={() => { sfx.tap(); setSheet('team'); }}><Icon name="users" /></button>
        <button className="dock-btn" aria-label="Menu" onClick={() => { sfx.tap(); setSheet('menu'); }}>{unread > 0 && <i className="badge-dot" />}<Icon name="menu" /></button>
      </nav>

      {newPin && (
        <Sheet label="New marker" onClose={() => setNewPin(null)}>
          <h2>Drop a marker</h2>
          <p className="hint">Only your team sees it.</p>
          <div className="quick" style={{ padding: 0, flexWrap: 'wrap' }}>{QUICK_LABELS.map((l) => <button key={l} style={pinLabel === l ? { borderColor: 'var(--orange)', color: 'var(--orange)' } : {}} onClick={() => setPinLabel(l)}>{l}</button>)}</div>
          <input className="input" value={pinLabel} maxLength={30} onChange={(e) => setPinLabel(e.target.value)} placeholder="Or type a label" />
          <button className="btn primary block" onClick={() => { send({ t: 'marker', op: 'add', ...newPin, label: pinLabel || 'Spot' }); setNewPin(null); sfx.toggle(); }}>Drop it</button>
        </Sheet>
      )}
      {openPin && (
        <Sheet label="Marker" onClose={() => setOpenPin(null)}>
          <h2>{openPin.label}</h2>
          <p className="hint">Dropped by {nameOf(openPin.by)}. Only your team sees this.</p>
          <button className="btn danger block" onClick={() => { send({ t: 'marker', op: 'del', id: openPin.id }); setOpenPin(null); }}>Remove marker</button>
        </Sheet>
      )}

      {s.mods && <button className="map-fab" aria-label="Center on me" onClick={() => { sfx.tap(); if (me) flyTo(map, me, 17); }}><Icon name="locate" /></button>}
      {sheet === 'powers' && s.mods && <PowersSheet s={s} onClose={() => setSheet(null)} onPickPoint={(id) => { setSheet(null); setPickAbility(id); }} />}
      {sheet === 'team' && (
        <Sheet label="Teams" onClose={() => setSheet(null)}>
          <h2>Teams</h2>
          {s.teams.map((t) => (
            <div key={t.id} className="team-row" style={{ '--c': t.role === 'hunter' ? HUNTER_COLOR : t.color } as React.CSSProperties}>
              <b>{t.name}{t.role === 'hunter' ? ' · hunters' : ''}</b>
              {t.members.map((id) => {
                const p = s.players.find((x) => x.id === id);
                const canAlly = s.soloMode && role === 'hider' && active && t.role === 'hider' && id !== s.you && p?.status === 'active' && !s.alliance.includes(id);
                return (
                  <div key={id} className={`member ${p?.status}`}>
                    <i className={p?.connected ? 'dot on' : 'dot'} />
                    <span>{p?.name}{id === s.you && ' (you)'}</span>
                    <em>{p?.bounty ? 'Bounty ' : ''}{p?.status === 'active' ? '' : p?.status === 'dq' ? 'Out' : 'Caught'}</em>
                    {canAlly && <button className="link" onClick={() => { send({ t: 'allyReq', targetId: id }); toast('Alliance request sent'); }}>Ally</button>}
                  </div>
                );
              })}
            </div>
          ))}
          {s.alliance.length > 0 && <button className="btn block" onClick={() => send({ t: 'allyLeave' })}>Break alliance</button>}
        </Sheet>
      )}

      {sheet === 'menu' && (
        <Sheet label="Menu" onClose={() => setSheet(null)}>
          <div className="menu-list">
            <button className="menu-item" onClick={() => { setSheet('feed'); setSeenEvents(events.length); }}><Icon name="list" /><span>What happened</span><small>{unread > 0 ? `${unread} new` : ''}</small></button>
            <button className="menu-item" onClick={() => { setPocket(true); setSheet(null); }}><Icon name="pocket" /><span>Pocket mode</span><small>Black screen, saves battery</small></button>
            <button className="menu-item" onClick={() => setNight(!night)}><Icon name={night ? 'sun' : 'moon'} /><span>{night ? 'Day map' : 'Night map'}</span></button>
          </div>
          <div>
            <Switch label="Sound effects" on={prefs.sfx} onChange={(v) => { setSoundPrefs({ sfx: v }); setPrefs(soundPrefs()); }} />
            <Switch label="Announcer voice" on={prefs.voice} onChange={(v) => { setSoundPrefs({ voice: v }); setPrefs(soundPrefs()); }} />
          </div>
          <div className="menu-list">
            <button className="menu-item" disabled={!!vote} onClick={() => { send({ t: 'voteEnd', yes: true }); setSheet(null); }}><Icon name="vote" /><span>Vote to end the match</span><small>{vote ? 'Vote running' : 'Everyone must agree'}</small></button>
            <button className="menu-item danger" onClick={() => { if (confirmLeave) leaveParty(); setConfirmLeave(!confirmLeave); }}><Icon name="exit" /><span>{confirmLeave ? 'Tap again to leave' : 'Leave game'}</span></button>
          </div>
        </Sheet>
      )}

      {sheet === 'feed' && (
        <Sheet label="What happened" onClose={() => setSheet(null)}>
          <h2>What happened</h2>
          {!events.length && <p className="hint">Nothing yet.</p>}
          <ul className="feed">
            {[...events].reverse().map((e) => (
              <li key={e.id} className={`ev-${e.kind}`}><time>{new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{e.text}</li>
            ))}
          </ul>
        </Sheet>
      )}

      {frozenHunter && s.freezeEndsAt && <FreezeCam endsAt={s.freezeEndsAt} maxSteps={s.settings.freezeMaxSteps} />}
      {showCombat && <CombatCam s={s} targets={targets} onClose={() => setCamDismissed(targetKey)} />}
      {walkie && <Walkie s={s} onClose={() => setWalkie(false)} />}
      {warnAt && warnAt > now - 1000 && <CallScreen pingAt={warnAt} />}
      <RollOverlay />
      {pocket && (
        <div className="pocket" onDoubleClick={() => setPocket(false)} onClick={(e) => e.detail >= 2 && setPocket(false)}>
          <b>{pingMs === null ? '--:--' : fmtClock(pingMs)}</b>
          <span>Double-tap to wake</span>
        </div>
      )}
    </div>
  );
}
