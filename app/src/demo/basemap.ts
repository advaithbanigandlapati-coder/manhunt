// A small made-up neighbourhood drawn as GeoJSON, so the demo needs no tile server.
// Coordinates are written in metres around the origin, then converted to lat/lng.
import type { StyleSpecification } from 'maplibre-gl';
import type { LatLng } from '../../../shared/protocol';

export const O: LatLng = { lat: 40.3801, lng: -74.5302 };
const K = 111_111;
const COS = Math.cos((O.lat * Math.PI) / 180);
export const toLL = (x: number, y: number): LatLng => ({ lat: O.lat + y / K, lng: O.lng + x / (K * COS) });
export const toXY = (p: LatLng): [number, number] => [(p.lng - O.lng) * K * COS, (p.lat - O.lat) * K];
const c = (x: number, y: number) => { const p = toLL(x, y); return [p.lng, p.lat]; };

type Pt = [number, number];
const loop: Pt[] = [];
for (let i = 0; i <= 40; i++) {
  const a = (i / 40) * Math.PI * 2;
  loop.push([235 * Math.cos(a) + 12 * Math.sin(3 * a), 145 * Math.sin(a) + 10 * Math.cos(2 * a)]);
}
const residential: Pt[][] = [
  loop,
  [[25, 150], [30, 220], [35, 292]],
  [[228, 20], [300, 90], [360, 262]],
  [[-110, 128], [-60, 50], [-95, -15]],
  [[70, 140], [95, 70], [45, 25]],
  [[-238, 5], [-160, -25], [-150, -85]],
  [[135, -128], [95, -60], [150, -35], [185, -88]],
  [[-35, -150], [-15, -70], [35, -85]],
  [[-170, 98], [-215, 55]],
  [[160, 105], [175, 45]],
];
const cul: Pt[] = [[-95, -15], [45, 25], [-150, -85], [185, -88], [35, -85], [-215, 55], [175, 45]];
const primary: Pt[] = [[-520, 360], [-150, 320], [150, 290], [520, 230]];
const rail: Pt[] = [[-470, -420], [-330, 0], [-230, 420]];
const parks: Pt[][] = [
  [[-520, -460], [-60, -460], [-30, -230], [-260, -200], [-520, -230]],
  [[300, -420], [520, -420], [520, -150], [360, -170]],
];

function segDist(px: number, py: number, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
const allRoads = [...residential, primary];
const nearRoad = (x: number, y: number, d: number) => allRoads.some((r) => r.some((p, i) => i > 0 && segDist(x, y, r[i - 1], p) < d));

// houses along both sides of each residential street
const houses: number[][][][] = [];
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (const road of residential) {
  for (let i = 1; i < road.length; i++) {
    const [ax, ay] = road[i - 1], [bx, by] = road[i];
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    for (let d = 10; d < len; d += 24) {
      for (const side of [-1, 1]) {
        const off = 24 + rnd() * 4;
        const cx = ax + ux * d - uy * off * side, cy = ay + uy * d + ux * off * side;
        if (nearRoad(cx, cy, 15) || houses.length > 420) continue;
        const w = 7 + rnd() * 2, h = 5.5 + rnd() * 1.5;
        const ring = [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]].map(([x, y]) => c(cx + x * ux - y * uy, cy + x * uy + y * ux));
        houses.push([ring]);
      }
    }
  }
}
houses.push([[c(170, 330), c(250, 320), c(255, 355), c(175, 365), c(170, 330)].map((p) => p as number[])]);
houses.push([[c(410, 40), c(460, 40), c(460, 80), c(410, 80), c(410, 40)].map((p) => p as number[])]);

const circle = (x: number, y: number, r: number) => {
  const out: number[][] = [];
  for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; out.push(c(x + r * Math.cos(a), y + r * Math.sin(a))); }
  return [out];
};

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
const line = (pts: Pt[], kind: string): GeoJSON.Feature => ({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: pts.map(([x, y]) => c(x, y)) } });
const poly = (coords: number[][][]): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } });

const data = {
  roads: fc([...residential.map((r) => line(r, 'res')), line(primary, 'primary')]),
  culs: fc(cul.map(([x, y]) => poly(circle(x, y, 13)))),
  rail: fc([line(rail, 'rail')]),
  parks: fc(parks.map((pk) => poly([[...pk, pk[0]].map(([x, y]) => c(x, y))]))),
  houses: fc(houses.map((h) => poly(h))),
};

/** Every 8 m along the residential streets, for "Fit to streets". */
export function streetPoints(): LatLng[] {
  const out: LatLng[] = [];
  for (const r of residential) for (let i = 1; i < r.length; i++) {
    const [ax, ay] = r[i - 1], [bx, by] = r[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 8));
    for (let k = 0; k <= n; k++) out.push(toLL(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n));
  }
  return out;
}

const wk = (p: number, r: number) => ['interpolate', ['exponential', 2], ['zoom'],
  13, ['match', ['get', 'kind'], 'primary', p / 12, r / 12],
  17, ['match', ['get', 'kind'], 'primary', p * 1.35, r * 1.35],
  20, ['match', ['get', 'kind'], 'primary', p * 11, r * 11]] as unknown as number;
const w = (m: number) => ['interpolate', ['exponential', 2], ['zoom'], 13, m / 12, 17, m * 1.35, 20, m * 11] as unknown as number;

function style(night: boolean): StyleSpecification {
  const C = night
    ? { bg: '#0f151d', park: '#13261c', house: '#1c2532', houseLine: '#253042', casing: '#090d13', road: '#2c394b', primary: '#5a4a24', rail: '#3c4655' }
    : { bg: '#edefe9', park: '#cfe6c4', house: '#dcd5cc', houseLine: '#c8bfb3', casing: '#c3c9d0', road: '#ffffff', primary: '#fde3a0', rail: '#98a1ab' };
  return {
    version: 8,
    sources: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { type: 'geojson', data: v }])) as StyleSpecification['sources'],
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },
      { id: 'parks', type: 'fill', source: 'parks', paint: { 'fill-color': C.park } },
      { id: 'rail', type: 'line', source: 'rail', paint: { 'line-color': C.rail, 'line-width': w(3), 'line-dasharray': [3, 2] } },
      { id: 'casing', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.casing, 'line-width': wk(17, 11) } },
      { id: 'culs', type: 'fill', source: 'culs', paint: { 'fill-color': C.road, 'fill-outline-color': C.casing } },
      { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'kind'], 'primary', C.primary, C.road] as unknown as string, 'line-width': wk(14, 8) } },
      { id: 'houses', type: 'fill', source: 'houses', paint: { 'fill-color': C.house, 'fill-outline-color': C.houseLine } },
    ],
  };
}
export const DAY = style(false);
export const NIGHT = style(true);
