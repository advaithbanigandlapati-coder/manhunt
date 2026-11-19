import { useSyncExternalStore } from 'react';
import { unlockAudio } from './device/audio';
import { startGeo } from './device/geo';
import { requestMotion } from './device/motion';
import { acquireCamera, releaseCamera } from './device/camera';
import { keepAwake } from './device/device';

// One tap grants everything the match needs. iOS only allows motion + audio permission
// inside a tap, so this must be called straight from a click handler.

export type Ready = { audio: boolean; location: boolean; motion: boolean; camera: boolean | null; done: boolean };
let r: Ready = { audio: false, location: false, motion: false, camera: null, done: false };
const subs = new Set<() => void>();
const set = (p: Partial<Ready>) => { r = { ...r, ...p }; subs.forEach((f) => f()); };
export const useReady = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => r);

export async function getReady(needCamera: boolean) {
  unlockAudio();
  const motionP = requestMotion(); // must start before any await
  set({ audio: true });
  const [motion, fix] = await Promise.all([motionP, startGeo()]);
  set({ motion, location: !!fix });
  if (needCamera) {
    try { await acquireCamera(); releaseCamera(); set({ camera: true }); } catch { set({ camera: false }); }
  }
  void keepAwake(true);
  set({ done: true });
}
