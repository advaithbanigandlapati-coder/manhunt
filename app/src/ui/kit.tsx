import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sfx } from '../device/audio';

export function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="grabber" />
        {children}
      </div>
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`}
        onClick={() => { sfx.toggle(); onChange(!on); }} />
    </label>
  );
}

/** Slider that only reports its value after the finger settles. */
export function SliderRow({ label, value, min, max, step, fmt, onCommit, disabled }: {
  label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onCommit: (v: number) => void; disabled?: boolean;
}) {
  const [v, setV] = useState(value);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setV(value), [value]);
  return (
    <label className="slider">
      <span className="top"><span>{label}</span><b>{fmt(v)}</b></span>
      <input type="range" min={min} max={max} step={step} value={v} disabled={disabled} aria-label={label}
        onChange={(e) => {
          const n = +e.target.value;
          setV(n);
          clearTimeout(t.current);
          t.current = setTimeout(() => onCommit(n), 250);
        }} />
    </label>
  );
}

export function fmtDuration(min: number) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
export function fmtSecs(s: number) {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}
