import { useEffect, useRef, useState } from 'react';
import type { PublicState } from '../../../shared/protocol';
import { dismiss, send, serverNow, useStore } from '../store';
import { announce, sfx } from '../device/audio';
import { fmtClock, vibrate } from '../device/device';
import { acquireCamera, releaseCamera, watchObstruction } from '../device/camera';
import { StepCounter } from '../device/motion';
import { Icon, Logo } from '../ui/icons';

function useNow(ms = 250) {
  const [, f] = useState(0);
  useEffect(() => { const id = setInterval(() => f((x) => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return serverNow();
}

/** Fake incoming call before every ping. */
export function CallScreen({ pingAt }: { pingAt: number }) {
  const now = useNow();
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    const stop = sfx.ring();
    vibrate([600, 300, 600, 300, 600]);
    const t = setTimeout(() => { stop(); setAnswered(true); announce('ping_incoming', { chime: false }); }, 3000);
    return () => { stop(); clearTimeout(t); };
  }, [pingAt]);
  useEffect(() => { if (now > pingAt + 500) dismiss.warn(); }, [now, pingAt]);
  return (
    <div className="call-screen" onClick={() => answered && dismiss.warn()}>
      <div className="call-top">
        <div className="logo-ring"><Logo size={62} /></div>
        <div className="call-name">Manhunt Control</div>
        <div className="call-sub">{answered ? 'Location ping incoming' : 'Incoming call'}</div>
        <div className="call-count">{fmtClock(pingAt - now)}</div>
      </div>
      <div className="call-actions">
        <button className="call-btn decline" aria-label="Dismiss" onClick={() => dismiss.warn()}><Icon name="close" size={30} /></button>
        <button className="call-btn accept" aria-label="Answer" onClick={() => { setAnswered(true); announce('ping_incoming', { chime: false }); }}><Icon name="phone" size={30} /></button>
      </div>
    </div>
  );
}

/** Radar sweep while everyone is visible. */
export function Radar({ until, endgame }: { until: number; endgame: boolean }) {
  const now = useNow(200);
  useEffect(() => {
    sfx.sonar();
    vibrate([80, 60, 80]);
    if (!endgame) setTimeout(() => announce('ping', { chime: false }), 900);
  }, [until, endgame]);
  return (
    <div className="radar-overlay">
      <div className="radar-sweep" />
      <div className="radar-label">Everyone visible · {Math.max(0, Math.ceil((until - now) / 1000))}s</div>
    </div>
  );
}

/** Hunter's screen during the freeze: camera on and uncovered, steps counted. */
export function FreezeCam({ endsAt, maxSteps }: { endsAt: number; maxSteps: number }) {
  const now = useNow();
  const video = useRef<HTMLVideoElement>(null);
  const [camOk, setCamOk] = useState(false);
  const [camErr, setCamErr] = useState('');
  const [steps, setSteps] = useState(0);
  const okRef = useRef(false);
  okRef.current = camOk;
  useEffect(() => {
    let stopWatch = () => {};
    acquireCamera()
      .then((st) => {
        if (!video.current) return;
        video.current.srcObject = st;
        void video.current.play();
        stopWatch = watchObstruction(video.current, setCamOk);
      })
      .catch(() => setCamErr('Camera blocked. Allow camera access or you lose the freeze.'));
    const sc = new StepCounter();
    sc.start();
    const id = setInterval(() => {
      setSteps(sc.steps);
      send({ t: 'freeze', steps: sc.steps, still: sc.still, camOk: okRef.current });
    }, 1000);
    return () => { stopWatch(); releaseCamera(); sc.stop(); clearInterval(id); };
  }, []);
  return (
    <div className="freeze-cam">
      <video ref={video} playsInline muted autoPlay />
      <div className={`cam-status ${camOk ? 'ok' : 'bad'}`}>{camErr || (camOk ? 'Camera on' : 'Camera covered. Uncover it now.')}</div>
      <div className="freeze-info">
        <div className="freeze-title">You're frozen</div>
        <div className="freeze-clock">{fmtClock(endsAt - now)}</div>
        <div className={`freeze-steps ${steps > maxSteps * 0.6 ? 'hot' : ''}`}>{steps} of {maxSteps} steps used</div>
        <p>Stay put and keep the camera pointed out. Moving or covering it loses the match.</p>
      </div>
    </div>
  );
}

/** Opens automatically when a hider is in Nerf range. */
export function CombatCam({ s, targets, onClose }: { s: PublicState; targets: string[]; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let alive = true;
    vibrate([100, 50, 100, 50, 100]);
    sfx.combat();
    announce('target', { chime: false });
    acquireCamera().then((st) => { if (alive && video.current) { video.current.srcObject = st; void video.current.play(); } }).catch(() => {});
    return () => { alive = false; releaseCamera(); };
  }, []);
  const name = (id: string) => s.players.find((p) => p.id === id)?.name ?? '?';
  return (
    <div className="combat-cam">
      <video ref={video} playsInline muted autoPlay />
      <div className="crosshair" />
      <div className="combat-head">
        <span>Target in range</span>
        <button className="icon-btn" onClick={onClose} aria-label="Hide camera"><Icon name="down" /></button>
      </div>
      <div className="combat-actions">
        {targets.map((id) => <button key={id} className="btn hit" onClick={() => { sfx.tap(); send({ t: 'hit', targetId: id }); }}>Hit {name(id)}</button>)}
      </div>
    </div>
  );
}

export function Prompts({ s }: { s: PublicState }) {
  const tag = useStore((x) => x.tagPrompt);
  const vote = useStore((x) => x.votePrompt);
  const allies = useStore((x) => x.allyPrompts);
  const now = useNow(500);
  const name = (id: string) => s.players.find((p) => p.id === id)?.name ?? 'Someone';
  const modal = (body: React.ReactNode, alert = false) => <div className="sheet-back"><div className={`modal ${alert ? 'alert' : ''}`}>{body}</div></div>;
  if (tag) {
    return modal(<>
      <h2>{name(tag.hunterId)} says they hit you</h2>
      <p className="hint">Counts automatically in {Math.max(0, Math.ceil((tag.at + 20000 - now) / 1000))}s if you don't answer.</p>
      <div className="row">
        <button className="btn grow" onClick={() => { send({ t: 'tagReply', tagId: tag.id, accept: false }); dismiss.tag(); }}>They missed</button>
        <button className="btn primary grow" onClick={() => { send({ t: 'tagReply', tagId: tag.id, accept: true }); dismiss.tag(); }}>I got hit</button>
      </div>
    </>, true);
  }
  if (vote) {
    return modal(<>
      <h2>Was it a hit?</h2>
      <p className="hint">{name(vote.targetId)} says {name(vote.hunterId)} missed. Majority wins.</p>
      <div className="row">
        <button className="btn grow" onClick={() => { send({ t: 'vote', tagId: vote.id, hit: false }); dismiss.vote(); }}>Missed</button>
        <button className="btn primary grow" onClick={() => { send({ t: 'vote', tagId: vote.id, hit: true }); dismiss.vote(); }}>Hit</button>
      </div>
    </>);
  }
  if (allies.length) {
    const from = allies[0];
    return modal(<>
      <h2>{name(from)} wants to team up</h2>
      <p className="hint">Allies see each other on the map until one of you breaks it off.</p>
      <div className="row">
        <button className="btn grow" onClick={() => { send({ t: 'allyReply', fromId: from, accept: false }); dismiss.ally(from); }}>No thanks</button>
        <button className="btn primary grow" onClick={() => { send({ t: 'allyReply', fromId: from, accept: true }); dismiss.ally(from); }}>Team up</button>
      </div>
    </>);
  }
  return null;
}

export function Banner() {
  const b = useStore((s) => s.banner);
  const t = useStore((s) => s.toast);
  return (
    <>
      {b && <div className={`banner banner-${b.kind}`} role="status" onClick={dismiss.banner}><span className="mark" />{b.text}</div>}
      {t && <div className="toast" role="status">{t}</div>}
    </>
  );
}
