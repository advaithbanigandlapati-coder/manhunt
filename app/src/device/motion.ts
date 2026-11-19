// Step counter + "phone is perfectly still" detector from the accelerometer.
// Used to enforce the hunters' freeze far more precisely than GPS can.

type DME = typeof DeviceMotionEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

export async function requestMotion(): Promise<boolean> {
  const D = (window as unknown as { DeviceMotionEvent?: DME }).DeviceMotionEvent;
  if (!D) return false;
  if (typeof D.requestPermission === 'function') {
    try { return (await D.requestPermission()) === 'granted'; } catch { return false; }
  }
  return true;
}

export class StepCounter {
  steps = 0;
  stillSince = Date.now();
  private smooth = 9.81;
  private lastStep = 0;
  private above = false;
  private ref = 9.81;
  private gotData = false;
  private handler = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    this.gotData = true;
    const mag = Math.hypot(a.x, a.y, a.z);
    this.smooth = this.smooth * 0.8 + mag * 0.2; // low-pass
    this.ref = this.ref * 0.98 + mag * 0.02; // slow baseline (gravity)
    const d = this.smooth - this.ref;
    const now = Date.now();
    // a step is a bounce well above the baseline, at most ~3 per second
    if (!this.above && d > 1.6 && now - this.lastStep > 320) {
      this.above = true;
      this.lastStep = now;
      this.steps++;
    } else if (this.above && d < 0.4) this.above = false;
    if (Math.abs(mag - this.ref) > 0.06) this.stillSince = now;
  };
  start() {
    this.steps = 0;
    this.stillSince = Date.now();
    window.addEventListener('devicemotion', this.handler);
  }
  stop() { window.removeEventListener('devicemotion', this.handler); }
  /** True when the phone hasn't moved at all for 60s (probably set down). */
  get still() { return this.gotData && Date.now() - this.stillSince > 60_000; }
  get working() { return this.gotData; }
}
