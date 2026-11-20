import { useEffect, useState } from 'react';
import { ABILITIES, ORB_TIERS, SAFE_ZONE_CHARGE_MS, type AbilityId, type PublicState, type Tier } from '../../../shared/protocol';
import { dismiss, send, serverNow, useStore } from '../store';
import { announce, sfx } from '../device/audio';
import { fmtClock } from '../device/device';
import { Icon, type IconName } from '../ui/icons';
import { Sheet } from '../ui/kit';

export const TIER_COLOR: Record<Tier, string> = { S: '#ffcf33', A: '#ff6b1a', B: '#a78bfa', C: '#4ea8de', D: '#9aa69d' };
const ICON: Record<AbilityId, IconName> = {
  revive: 'heart', reboot: 'heart', vanish: 'ghost', fake: 'pin', shield: 'shield', trace: 'eye', disable: 'off', steal: 'swap', zone: 'ring', clear: 'close',
};
const ORDER: AbilityId[] = ['revive', 'reboot', 'vanish', 'fake', 'shield', 'trace', 'disable', 'steal', 'zone', 'clear'];

function useTick(ms = 1000) {
  const [, f] = useState(0);
  useEffect(() => { const id = setInterval(() => f((x) => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return serverNow();
}

/** Small timers for whatever is active on you right now. */
export function EffectsBar({ s }: { s: PublicState }) {
  const now = useTick();
  const m = s.mods;
  if (!m) return null;
  const items: [string, number, boolean][] = [];
  const u = m.until;
  if (u.bounty && u.bounty > now) items.push(['Bounty on you', u.bounty, true]);
  if (u.disabled && u.disabled > now) items.push(['Safe zones off', u.disabled, true]);
  if (u.vanish && u.vanish > now) items.push(['Vanished', u.vanish, false]);
  if (u.fake && u.fake > now) items.push(['Decoy', u.fake, false]);
  if (u.shield && u.shield > now) items.push(['Shield', u.shield, false]);
  if (u.trace && u.trace > now) items.push(['Trace', u.trace, false]);
  if (!items.length) return null;
  return (
    <div className="effects">
      {items.map(([label, until, bad]) => <span key={label} className={bad ? 'bad' : ''}>{label} <b>{fmtClock(until - now)}</b></span>)}
    </div>
  );
}

function reasonBlocked(s: PublicState, id: AbilityId): string | null {
  const a = ABILITIES[id];
  const m = s.mods!;
  const me = s.players.find((p) => p.id === s.you);
  const role = s.teams.find((t) => t.members.includes(s.you))?.role;
  const now = serverNow();
  if (s.phase !== 'live' && s.phase !== 'freeze') return 'Match not started';
  if (a.who === 'caught' && me?.status !== 'caught') return 'Only when you’re caught';
  if (a.who !== 'caught' && me?.status !== 'active') return 'You’re out';
  if (a.who === 'hider' && role !== 'hider') return 'Hiders only';
  const key = ({ vanish: 'vanish', fake: 'fake', shield: 'shield', trace: 'trace' } as Record<string, keyof typeof m.until>)[id];
  if (key && (m.until[key] ?? 0) > now) return 'Active';
  if (id === 'clear' && !((m.until.bounty ?? 0) > now)) return 'No bounty on you';
  if (id === 'zone' && m.zones.length >= 3) return '3 zones max';
  if (id === 'reboot' && !s.players.some((p) => p.status === 'caught' && s.teams.find((t) => t.members.includes(p.id))?.role === 'hider')) return 'Nobody to bring back';
  const cost = id === 'zone' && m.freeZone ? 0 : a.cost;
  if (m.points < cost) return `Need ${cost}`;
  return null;
}

export function PowersSheet({ s, onClose, onPickPoint }: { s: PublicState; onClose: () => void; onPickPoint: (id: AbilityId) => void }) {
  const now = useTick();
  const [picking, setPicking] = useState<AbilityId | null>(null);
  const m = s.mods!;
  const off = new Set(s.settings.disabledAbilities);
  const list = ORDER.filter((id) => !off.has(id));
  const name = (id: string) => s.players.find((p) => p.id === id)?.name ?? '?';
  const roleOf = (id: string) => s.teams.find((t) => t.members.includes(id))?.role;

  const use = (id: AbilityId) => {
    sfx.tap();
    const a = ABILITIES[id];
    if (a.target === 'point') { onPickPoint(id); return; }
    if (a.target) { setPicking(id); return; }
    send({ t: 'use', ability: id });
    onClose();
  };

  if (picking) {
    const a = ABILITIES[picking];
    const myTeam = s.teams.find((t) => t.members.includes(s.you));
    const friend = (id: string) => !!myTeam?.members.includes(id) || s.alliance.includes(id);
    const targets = s.players.filter((p) => p.id !== s.you && (a.target === 'caught' ? p.status === 'caught' && roleOf(p.id) === 'hider' : p.status === 'active' && !friend(p.id)));
    return (
      <Sheet label={a.name} onClose={onClose}>
        <div className="row"><button className="icon-btn" aria-label="Back" onClick={() => setPicking(null)}><Icon name="back" /></button><h2 className="grow">{a.name}</h2></div>
        <p className="hint">{a.desc}</p>
        <div className="menu-list">
          {!targets.length && <p className="hint">Nobody to pick right now.</p>}
          {targets.map((p) => (
            <button key={p.id} className="menu-item" onClick={() => { send({ t: 'use', ability: picking, targetId: p.id }); setPicking(null); onClose(); }}>
              <i className={p.connected ? 'dot on' : 'dot'} /><span>{p.name}</span><small>{roleOf(p.id) === 'hunter' ? 'Hunter' : 'Hider'}{p.bounty ? ' · bounty' : ''}</small>
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet label="Powers" onClose={onClose}>
      <div className="powers-head">
        <div><h2>Powers</h2><p className="hint">Walk over orbs on the map to earn points.</p></div>
        <div className="points"><Icon name="coin" size={22} /><b>{m.points}</b><small>{m.rerolls} reroll{m.rerolls === 1 ? '' : 's'} left</small></div>
      </div>
      {(m.until.bounty ?? 0) > now && (
        <div className="bounty-card">
          <b>Bounty on you</b>
          <span>Hunters see you for 5 seconds every 30 seconds. Ends in {fmtClock((m.until.bounty ?? 0) - now)}.</span>
        </div>
      )}
      {m.zones.length > 0 && (
        <p className="hint">Your safe zones: {m.zones.map((z) => fmtClock(z.charge)).join(', ')} of protection left{(m.until.disabled ?? 0) > now ? ' (switched off right now)' : ''}. Stand inside one and hits don’t count.</p>
      )}
      <div className="abilities">
        {list.map((id) => {
          const a = ABILITIES[id];
          const why = reasonBlocked(s, id);
          const cost = id === 'zone' && m.freeZone ? 0 : a.cost;
          return (
            <div key={id} className={`ability ${why ? 'dim' : ''}`} style={{ '--t': TIER_COLOR[a.tier] } as React.CSSProperties}>
              <span className="tier">{a.tier}</span>
              <div className="ability-main">
                <div className="ability-top"><Icon name={ICON[id]} size={18} /><b>{id === 'zone' && m.freeZone ? 'Safe Zone' : a.name}</b></div>
                <p>{id === 'zone' && m.freeZone ? `Drop a safe zone where you stand. Inside it, hits don’t count for ${SAFE_ZONE_CHARGE_MS / 60000} minutes total. Your first one is free.` : a.desc}</p>
              </div>
              <button className="btn use" disabled={!!why} onClick={() => use(id)}>
                {why && why !== `Need ${cost}` ? <small>{why}</small> : <>{cost === 0 ? 'Free' : <><Icon name="coin" size={16} />{cost}</>}</>}
              </button>
            </div>
          );
        })}
      </div>
      <details className="odds">
        <summary>Orb odds</summary>
        <div className="odds-row">{ORB_TIERS.map((t) => <span key={t.tier} style={{ color: TIER_COLOR[t.tier] }}><b>{t.tier}</b> +{t.points} · {Math.round(t.chance * 100)}%</span>)}</div>
        <p className="hint">You get 3 rerolls per match. A reroll can land lower.</p>
      </details>
    </Sheet>
  );
}

/** Slot-machine reveal when you pick up an orb. */
export function RollOverlay() {
  const r = useStore((x) => x.roll);
  const now = useTick(500);
  const [spinning, setSpinning] = useState(true);
  const [face, setFace] = useState<Tier>('D');
  useEffect(() => {
    if (!r) return;
    setSpinning(true);
    const faces: Tier[] = ['D', 'C', 'B', 'A', 'S'];
    let i = 0;
    const id = setInterval(() => { setFace(faces[i++ % 5]); sfx.reel(); }, 70);
    const t = setTimeout(() => {
      clearInterval(id);
      setFace(r.roll.tier);
      setSpinning(false);
      sfx.tier(r.roll.tier);
      if (r.roll.tier === 'S') announce('jackpot', { chime: false });
    }, 1300);
    return () => { clearInterval(id); clearTimeout(t); };
  }, [r?.roll.at, r?.roll.tier, r?.rerollsLeft]);
  if (!r) return null;
  const left = Math.max(0, Math.ceil((r.roll.at + 20000 - now) / 1000));
  if (left === 0 && !spinning) setTimeout(dismiss.roll, 0);
  return (
    <div className="sheet-back roll-back">
      <div className="roll-card" style={{ '--t': TIER_COLOR[face] } as React.CSSProperties}>
        <small>{r.rerolled ? 'Reroll' : 'Orb collected'}</small>
        <div className={`roll-tier ${spinning ? 'spin' : 'land'}`}>{face}</div>
        <div className="roll-points">{spinning ? ' ' : `+${r.roll.points} point${r.roll.points === 1 ? '' : 's'}`}</div>
        <div className="row">
          <button className="btn grow" disabled={spinning || r.rerollsLeft < 1} onClick={() => { sfx.tap(); send({ t: 'roll', reroll: true }); }}>Reroll ({r.rerollsLeft} left)</button>
          <button className="btn primary grow" disabled={spinning} onClick={() => { sfx.toggle(); send({ t: 'roll', reroll: false }); dismiss.roll(); }}>Keep</button>
        </div>
        <p className="hint">{spinning ? 'Rolling…' : `Keeps automatically in ${left}s.`}</p>
      </div>
    </div>
  );
}
