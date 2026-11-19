import { useRef, useState } from 'react';
import { connect, createParty, identity, partyExists, useStore } from '../store';
import { isIOS, isStandalone } from '../device/device';
import { sfx, unlockAudio } from '../device/audio';
import { Icon, Logo, Topo } from '../ui/icons';

export function Home() {
  const fail = useStore((s) => s.failReason);
  const [name, setName] = useState(identity.name);
  const [joining, setJoining] = useState(!!new URLSearchParams(location.search).get('code'));
  const [code, setCode] = useState(new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);

  const go = async (create: boolean) => {
    if (!name.trim()) { setErr('Add your name first.'); return; }
    identity.name = name.trim().slice(0, 20);
    unlockAudio();
    sfx.tap();
    setBusy(true);
    setErr('');
    try {
      if (create) connect(await createParty());
      else {
        const c = code.trim().toUpperCase();
        if (!/^[A-Z2-9]{5}$/.test(c)) throw new Error('Party codes are 5 characters.');
        if (!(await partyExists(c))) throw new Error('No game with that code.');
        connect(c);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="screen home">
      <Topo className="home-topo" />
      <div className="home-inner">
        <div className="brand">
          <Logo size={58} />
          <h1 className="wordmark">MAN<em>HUNT</em></h1>
          <p className="tagline">Hide-and-seek across your whole neighborhood, with a radio in your pocket.</p>
        </div>

        <div className="home-actions">
          <label className="field">
            <span>Your name</span>
            <input className="input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="What your crew calls you" autoComplete="nickname" />
          </label>

          {!joining ? (
            <>
              <button className="btn primary big block" disabled={busy} onClick={() => go(true)}>Host a game</button>
              <button className="btn big block" onClick={() => { sfx.tap(); setJoining(true); setTimeout(() => codeRef.current?.focus(), 50); }}>Join with a code</button>
            </>
          ) : (
            <>
              <div className="code-boxes" onClick={() => codeRef.current?.focus()}>
                {[0, 1, 2, 3, 4].map((i) => <span key={i} className={i === Math.min(code.length, 4) ? 'cur' : ''}>{code[i] ?? ''}</span>)}
                <input ref={codeRef} value={code} maxLength={5} aria-label="Party code" autoCapitalize="characters" autoComplete="off"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && code.length === 5 && go(false)} />
              </div>
              <button className="btn primary big block" disabled={busy || code.length !== 5} onClick={() => go(false)}>Join game</button>
              <button className="link quiet" onClick={() => setJoining(false)}>Host one instead</button>
            </>
          )}
          {(err || fail) && <p className="warn-text">{err || fail}</p>}

          {!isStandalone && (
            <div className="install-row">
              <Icon name="share" size={20} />
              <span>{isIOS ? 'Tap Share, then Add to Home Screen, for full screen.' : 'Use your browser menu: Install app, for full screen.'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
