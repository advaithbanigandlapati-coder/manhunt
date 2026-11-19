// Camera helpers: open the back camera and detect a covered lens.

let stream: MediaStream | null = null;
let users = 0;

export async function acquireCamera(): Promise<MediaStream> {
  users++;
  if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  return stream;
}

export function releaseCamera() {
  users = Math.max(0, users - 1);
  if (!users && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

/**
 * Samples the video every 500ms. A lens covered by a finger, hand or pocket gives a frame
 * that is nearly black or almost perfectly uniform. Night scenes still have sensor noise
 * and light sources, so the thresholds are deliberately strict.
 */
export function watchObstruction(video: HTMLVideoElement, onChange: (ok: boolean) => void) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  let last: boolean | null = null;
  const id = setInterval(() => {
    let ok = false;
    const live = !!(video.srcObject as MediaStream | null)?.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);
    if (live && video.readyState >= 2) {
      g.drawImage(video, 0, 0, 32, 24);
      const d = g.getImageData(0, 0, 32, 24).data;
      let sum = 0, sum2 = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += l;
        sum2 += l * l;
      }
      const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      ok = !((mean < 10 && std < 4) || std < 2.5);
    }
    if (document.visibilityState !== 'visible') ok = false;
    if (ok !== last) { last = ok; onChange(ok); }
  }, 500);
  return () => clearInterval(id);
}
