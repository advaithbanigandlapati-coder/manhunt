// Runs before any app module: force simulated GPS and make storage safe in sandboxed frames.
(globalThis as { __MH_SIM?: boolean }).__MH_SIM = true;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}
try {
  window.localStorage.setItem('mh.probe', '1');
  window.localStorage.removeItem('mh.probe');
} catch {
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
}
try { localStorage.removeItem('mh.party'); } catch { /* ignore */ }
