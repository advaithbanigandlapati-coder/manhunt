// Hand-drawn 24px line icons, so the app doesn't lean on emoji.
import type { SVGProps } from 'react';

const P: Record<string, string> = {
  locate: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  radio: 'M9 2l1.5 4M7 6h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z M9 10h6v4H9z M9 17h1M12 17h1M15 17h0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7 M16 3.5a4 4 0 0 1 0 7.5 M18.5 14.5A7 7 0 0 1 22 21',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  down: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0M12 18v3',
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12Z',
  scan: 'M12 12m-1 0a1 1 0 1 0 2 0 1 1 0 1 0-2 0 M8.5 15.5a5 5 0 0 1 0-7 M15.5 8.5a5 5 0 0 1 0 7 M5.6 18.4a9 9 0 0 1 0-12.8 M18.4 5.6a9 9 0 0 1 0 12.8',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  speaker: 'M4 9h4l5-4v14l-5-4H4z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  voice: 'M4 12h2M8 8v8M12 5v14M16 8v8M20 11v2',
  pocket: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M14.5 9.5a2.5 2.5 0 1 1-3-3 2 2 0 0 0 3 3Z',
  vote: 'M9 11l3 3 7-7 M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  check: 'M5 12.5l4.5 4.5L19 7',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 1v4M12 19v4M1 12h4M19 12h4',
  shuffle: 'M16 4h4v4M4 20 20 4M20 16v4h-4M14.5 14.5 20 20M4 4l5 5',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z M9 4v14M15 6v14',
  exit: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4Z M13.5 6.5l4 4',
  timer: 'M12 8v5l3 2M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M9 2h6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  play: 'M7 4v16l13-8L7 4Z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 22, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name]} />
    </svg>
  );
}

/** The Manhunt mark: a reticle with one quadrant filled in blaze orange. */
export function Logo({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--bone)" strokeWidth="3.5" />
      <path d="M32 5a27 27 0 0 1 27 27H32Z" fill="var(--orange)" />
      <circle cx="32" cy="32" r="11" fill="none" stroke="var(--bone)" strokeWidth="3.5" />
      <path d="M32 0v14M32 50v14M0 32h14M50 32h14" stroke="var(--bone)" strokeWidth="3.5" />
    </svg>
  );
}

/** Topographic contour lines, used as a texture behind headers. */
export function Topo({ className }: { className?: string }) {
  const rings = [];
  for (let i = 0; i < 9; i++) {
    const r = 40 + i * 34;
    rings.push(<path key={`a${i}`} d={`M ${300 - r} 120 C ${300 - r} ${20 - i * 18}, ${300 + r * 1.2} ${10 - i * 20}, ${300 + r} 130 S ${310 - r * 0.6} ${250 + i * 26}, ${300 - r} 120 Z`} />);
    rings.push(<path key={`b${i}`} d={`M ${40 - i * 6} ${420 + i * 4} C ${120 + i * 20} ${330 - i * 30}, ${260 + i * 10} ${470 + i * 18}, ${420 + i * 30} ${400 - i * 22}`} />);
  }
  return (
    <svg className={className} viewBox="0 0 600 520" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      {rings}
    </svg>
  );
}
