import type { LatLng } from './protocol';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Project to local metres around an origin (accurate at neighbourhood scale). */
function toXY(p: LatLng, o: LatLng): [number, number] {
  return [rad(p.lng - o.lng) * R * Math.cos(rad(o.lat)), rad(p.lat - o.lat) * R];
}

export function pointInPolygon(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

/** Distance in metres from p to the nearest polygon edge. */
export function distToEdgeM(p: LatLng, poly: LatLng[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = toXY(poly[j], p);
    const [bx, by] = toXY(poly[i], p);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Circle as a polygon ring. */
export function circlePolygon(c: LatLng, radiusM: number, steps = 48): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push({
      lat: c.lat + (radiusM * Math.sin(a)) / R * (180 / Math.PI),
      lng: c.lng + ((radiusM * Math.cos(a)) / (R * Math.cos(rad(c.lat)))) * (180 / Math.PI),
    });
  }
  return out;
}

export function centroid(poly: LatLng[]): LatLng {
  const s = poly.reduce((a, p) => ({ lat: a.lat + p.lat, lng: a.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / poly.length, lng: s.lng / poly.length };
}
