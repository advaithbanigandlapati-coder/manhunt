// Cameras are blocked in the preview frame, so feed the app an animated "back yard at dusk" instead.
let canvas: HTMLCanvasElement | null = null;
function fakeStream(): MediaStream {
  if (canvas) return canvas.captureStream(15);
  const cv = (canvas = document.createElement('canvas'));
  cv.width = 480;
  cv.height = 640;
  const g = cv.getContext('2d')!;
  let t = 0;
  const draw = () => {
    t += 1;
    const sky = g.createLinearGradient(0, 0, 0, 640);
    sky.addColorStop(0, '#2b3a55');
    sky.addColorStop(0.45, '#6b6f86');
    sky.addColorStop(0.46, '#2f3b2c');
    sky.addColorStop(1, '#141a12');
    g.fillStyle = sky;
    g.fillRect(0, 0, 480, 640);
    // houses on the horizon
    g.fillStyle = '#1d2433';
    for (let i = 0; i < 6; i++) { const x = i * 90 - 20; g.fillRect(x, 230, 70, 60); g.beginPath(); g.moveTo(x - 6, 232); g.lineTo(x + 35, 200); g.lineTo(x + 76, 232); g.fill(); }
    g.fillStyle = '#f4d58d';
    for (let i = 0; i < 6; i++) if ((i * 7) % 3) g.fillRect(i * 90 + 8, 250, 12, 12);
    // bushes
    g.fillStyle = '#1f2b1b';
    for (let i = 0; i < 5; i++) { g.beginPath(); g.ellipse(60 + i * 100, 330 + (i % 2) * 20, 70, 36, 0, 0, Math.PI * 2); g.fill(); }
    // someone sneaking between bushes
    const px = 240 + Math.sin(t / 40) * 150;
    g.fillStyle = '#0b0d10';
    g.beginPath(); g.arc(px, 300, 12, 0, Math.PI * 2); g.fill();
    g.fillRect(px - 10, 312, 20, 40);
    // sensor noise
    const img = g.getImageData(0, 0, 480, 640);
    for (let i = 0; i < img.data.length; i += 16) { const n = (Math.random() - 0.5) * 22; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    g.putImageData(img, 0, 0);
  };
  draw();
  setInterval(draw, 66);
  return cv.captureStream(15);
}

let silent: MediaStream | null = null;
function silentMic(): MediaStream {
  // a real (silent) audio track so the radio code runs end to end in the preview
  if (!silent) { const ac = new AudioContext(); silent = ac.createMediaStreamDestination().stream; }
  return silent;
}
const md = (navigator.mediaDevices ?? {}) as MediaDevices;
md.getUserMedia = async (c?: MediaStreamConstraints) => (c?.audio && !c.video ? silentMic() : fakeStream());
if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true });
