// Small device helpers: vibration, wake lock, platform detection.

export const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator && !/iPhone|iPad|iPod/.test(navigator.userAgent);
export function vibrate(pattern: number | number[]) {
  if (canVibrate) try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

let lock: WakeLockSentinel | null = null;
let wanted = false;
export async function keepAwake(on: boolean) {
  wanted = on;
  if (!('wakeLock' in navigator)) return;
  if (on && !lock) {
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch { /* needs a visible page + user gesture on some browsers */ }
  } else if (!on && lock) {
    await lock.release().catch(() => {});
    lock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted) void keepAwake(true);
});

export function fmtClock(ms: number) {
  if (!isFinite(ms)) return '--:--';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export const ft = (m: number) => `${Math.round(m * 3.281)} ft`;
