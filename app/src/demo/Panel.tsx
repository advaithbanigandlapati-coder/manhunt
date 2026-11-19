import { useState } from 'react';
import { useStore } from '../store';
import { demo } from './hub';

export function Panel() {
  const s = useStore((x) => x.s);
  const [prefer, setPrefer] = useState(demo.prefer ?? 'hider');
  const role = s?.teams.find((t) => t.members.includes(s.you))?.role;
  const phase = s?.phase ?? 'home';
  const live = phase === 'freeze' || phase === 'live';

  const steps: Record<string, string> = {
    home: 'Type a name and tap Host a game. Six bot players will join.',
    lobby: 'Pick a game length, check the area, then tap Spin for teams.',
    teams: 'Rename your team with the pencil, tap I\u2019m ready, then Start the hunt.',
    freeze: role === 'hunter' ? 'You’re frozen. The camera has to stay on and uncovered (here it shows a fake camera feed).' : 'Run! The hunters are frozen. Tap the map to move.',
    live: role === 'hunter' ? 'Hunt. Walk up to a hider to open the combat cam. Tap the orange radio button to open the walkie, or hold it to talk.' : 'Hide. Tap the orange radio button to open the walkie (hold it to talk). Try Scan to find other teams\u2019 channels.',
    ended: 'Scrub the replay, or tap Play again.',
  };

  return (
    <aside className="demo-panel">
      <h1>MAN<em>HUNT</em></h1>
      <p className="lead">The real app and game rules, running in this page against six bots. The street map is made up, GPS is simulated (tap the map to move), and your mic is silent here.</p>

      <div className="now">
        <span>What to do now</span>
        <p>{steps[phase]}</p>
      </div>

      <label className="ctl">Play as
        <div className="seg">
          {(['hider', 'hunter'] as const).map((r) => (
            <button key={r} className={prefer === r ? 'on' : ''} onClick={() => { demo.setPrefer(r); setPrefer(r); }}>{r === 'hider' ? 'Hider' : 'Hunter'}</button>
          ))}
        </div>
        <small>Applies the next time teams are spun.</small>
      </label>

      <div className="ctl">Shortcuts
        <div className="btns">
          <button disabled={phase !== 'freeze'} onClick={demo.skipFreeze}>Skip the freeze</button>
          <button disabled={!live} onClick={demo.pingNow}>Ping now (fake call → radar)</button>
          {role === 'hunter'
            ? <button disabled={phase !== 'live'} onClick={demo.walkToHider}>Walk me to the nearest hider</button>
            : <button disabled={phase !== 'live'} onClick={demo.chaseMe}>Send a hunter after me</button>}
          <button disabled={!live} onClick={demo.teammateTalk}>Have a teammate radio in</button>
          <button disabled={!live} onClick={demo.walkOut}>Walk me out of bounds</button>
          <button disabled={!live} onClick={demo.walkHome}>Walk me back to the middle</button>
          <button onClick={() => location.reload()}>Restart demo</button>
        </div>
      </div>
      <p className="fine">Demo timers are short: 20 s freeze, a ping every 90 s, a 15-minute match. Turn your sound on. Vibration only works on Android.</p>
    </aside>
  );
}
