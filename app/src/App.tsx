import { useStore } from './store';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { Match } from './screens/Match';
import { Results } from './screens/Results';
import { Banner, Prompts } from './screens/overlays';
import { Logo } from './ui/icons';

export function App() {
  const s = useStore((x) => x.s);
  const conn = useStore((x) => x.conn);
  const code = useStore((x) => x.code);

  if (!s) {
    if (code && (conn === 'connecting' || conn === 'retrying')) {
      return <div className="screen center-screen"><Logo size={64} /><p>Joining {code}\u2026</p></div>;
    }
    return <><Home /><Banner /></>;
  }

  return (
    <>
      {s.phase === 'lobby' || s.phase === 'teams' ? <Lobby s={s} /> : s.phase === 'ended' ? <Results s={s} /> : <Match s={s} />}
      {conn === 'retrying' && <div className="reconnect">Reconnecting…</div>}
      <Prompts s={s} />
      <Banner />
    </>
  );
}
