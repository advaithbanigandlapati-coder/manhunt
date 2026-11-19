// GPS tracking with a simulation mode for testing at a desk: open the app with ?sim
// and tap the map to move yourself.

export type Fix = { lat: number; lng: number; acc: number; at: number };
type Listener = (f: Fix) => void;

export const SIM = new URLSearchParams(location.search).has('sim') || (globalThis as { __MH_SIM?: boolean }).__MH_SIM === true;

let watchId: number | null = null;
let last: Fix | null = null;
let error: string | null = null;
const listeners = new Set<Listener>();

function emit(f: Fix) {
  last = f;
  error = null;
  listeners.forEach((l) => l(f));
}

export function onFix(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const lastFix = () => last;
export const geoError = () => error;

export function startGeo(): Promise<Fix | null> {
  if (SIM) {
    if (!last) emit({ lat: 40.3801, lng: -74.5302, acc: 5, at: Date.now() });
    return Promise.resolve(last);
  }
  if (!('geolocation' in navigator)) { error = 'This browser has no GPS access'; return Promise.resolve(null); }
  return new Promise((resolve) => {
    let first = true;
    if (watchId != null) return resolve(last);
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        emit({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() });
        if (first) { first = false; resolve(last); }
      },
      (e) => {
        error = e.code === e.PERMISSION_DENIED ? 'Location permission denied — allow it in Settings' : 'Waiting for GPS…';
        if (first) { first = false; resolve(null); }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  });
}

export function simMoveTo(lat: number, lng: number) {
  if (SIM) emit({ lat, lng, acc: 5, at: Date.now() });
}

// keep re-sending the simulated position so the server doesn't think we went dark
if (SIM) setInterval(() => last && emit({ ...last, at: Date.now() }), 2000);
