import { useEffect, useMemo, useRef, useState } from 'react';
import * as ml from 'maplibre-gl';
import concave from '@turf/concave';
import convex from '@turf/convex';
import buffer from '@turf/buffer';
import simplify from '@turf/simplify';
import { featureCollection, point } from '@turf/helpers';
import type { Area, LatLng } from '../../../shared/protocol';
import { centroid, circlePolygon, distM } from '../../../shared/geo';
import { GameMap, flyTo } from './GameMap';
import { lastFix, startGeo } from '../device/geo';
import { ft } from '../device/device';
import { Icon } from '../ui/icons';

type Props = { initial: Area | null; onSave: (a: Area) => void; onCancel: () => void };
type SearchHit = { label: string; lat: number; lng: number };

/** Street/path nodes near a point, from OpenStreetMap's Overpass API. */
async function overpassPoints(c: LatLng, r: number): Promise<LatLng[]> {
  const kinds = 'residential|service|living_street|unclassified|tertiary|footway|path|pedestrian|track|cycleway|steps';
  const q = `[out:json][timeout:25];way["highway"~"^(${kinds})$"](around:${Math.round(r)},${c.lat},${c.lng});node(w);out skel qt;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error('Map data server is busy — try again in a minute');
  const j = (await res.json()) as { elements: { type: string; lat: number; lon: number }[] };
  return j.elements.filter((e) => e.type === 'node').map((e) => ({ lat: e.lat, lng: e.lon }));
}

let streetSource = overpassPoints;
/** Swap where street geometry comes from (the demo uses its bundled map). */
export function setStreetSource(fn: (c: LatLng, r: number) => Promise<LatLng[]>) { streetSource = fn; }

/** Pull the street network inside the circle and wrap it in a tight shape. */
export async function fitToStreets(c: LatLng, r: number): Promise<LatLng[]> {
  const pts = (await streetSource(c, r)).filter((p) => distM(p, c) <= r);
  if (pts.length < 6) throw new Error('Not enough streets or paths inside the circle');
  const fc = featureCollection(pts.map((p) => point([p.lng, p.lat])));
  const hull = concave(fc, { maxEdge: Math.max(0.08, (r / 1000) * 0.45), units: 'kilometers' }) ?? convex(fc);
  if (!hull) throw new Error('Could not build a shape here');
  const shape = buffer(hull, 22, { units: 'meters' })!;
  let coords: number[][] = [];
  for (let tol = 0.00002; tol < 0.01; tol *= 1.6) {
    const s = simplify(shape, { tolerance: tol, highQuality: true });
    const g = s.geometry;
    // take the biggest piece if it came back in parts
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((pl) => pl[0]);
    coords = rings.sort((a, b) => b.length - a.length)[0];
    if (coords.length <= 40) break;
  }
  return coords.slice(0, -1).map(([lng, lat]) => ({ lat, lng }));
}

function handleEl(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export function AreaEditor({ initial, onSave, onCancel }: Props) {
  const [map, setMap] = useState<ml.Map | null>(null);
  const [mode, setMode] = useState<'circle' | 'poly'>(initial ? 'poly' : 'circle');
  const [center, setCenter] = useState<LatLng | null>(initial?.center ?? null);
  const [radius, setRadius] = useState(initial?.radiusM || 250);
  const [poly, setPoly] = useState<LatLng[]>(initial?.polygon ?? []); // committed (drives handles)
  const [live, setLive] = useState<LatLng[] | null>(null); // while dragging
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [fitKey, setFitKey] = useState(initial ? 1 : 0);
  const cr = useRef({ center, radius });
  cr.current = { center, radius };

  const preview: Area | null = useMemo(() => {
    if (mode === 'circle') return center ? { polygon: circlePolygon(center, radius), center, radiusM: radius } : null;
    const pts = live ?? poly;
    if (pts.length < 3) return null;
    const c = centroid(pts);
    return { polygon: pts, center: c, radiusM: Math.max(...pts.map((p) => distM(c, p))) };
  }, [mode, center, radius, poly, live]);

  // start centred on the player if we have no area yet
  useEffect(() => {
    if (initial || !map) return;
    void startGeo().then((f) => f && flyTo(map, f, 16));
  }, [map, initial]);

  // circle handles: centre + radius knob
  useEffect(() => {
    if (!map || mode !== 'circle' || !center) return;
    const knobPos = (c: LatLng, r: number): [number, number] => [c.lng + r / (111_320 * Math.cos((c.lat * Math.PI) / 180)), c.lat];
    const cm = new ml.Marker({ element: handleEl('h-center'), draggable: true }).setLngLat([center.lng, center.lat]).addTo(map);
    const km = new ml.Marker({ element: handleEl('h-knob'), draggable: true }).setLngLat(knobPos(center, radius)).addTo(map);
    cm.on('drag', () => {
      const ll = cm.getLngLat();
      const c = { lat: ll.lat, lng: ll.lng };
      setCenter(c);
      km.setLngLat(knobPos(c, cr.current.radius));
    });
    km.on('drag', () => {
      const ll = km.getLngLat();
      const c = cr.current.center!;
      setRadius(Math.max(40, Math.min(2000, distM(c, { lat: ll.lat, lng: ll.lng }))));
    });
    km.on('dragend', () => km.setLngLat(knobPos(cr.current.center!, cr.current.radius)));
    return () => { cm.remove(); km.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, center === null]);

  // polygon handles: vertices + midpoints (drag a midpoint to add a point)
  useEffect(() => {
    if (!map || mode !== 'poly' || poly.length < 3) return;
    const made: ml.Marker[] = [];
    poly.forEach((p, i) => {
      const m = new ml.Marker({ element: handleEl('h-vertex' + (sel === i ? ' sel' : '')), draggable: true }).setLngLat([p.lng, p.lat]).addTo(map);
      m.getElement().addEventListener('click', (e) => { e.stopPropagation(); setSel(i); });
      m.on('drag', () => { const ll = m.getLngLat(); const n = [...poly]; n[i] = { lat: ll.lat, lng: ll.lng }; setLive(n); });
      m.on('dragend', () => { const ll = m.getLngLat(); const n = [...poly]; n[i] = { lat: ll.lat, lng: ll.lng }; setLive(null); setPoly(n); setSel(i); });
      made.push(m);
      const nx = poly[(i + 1) % poly.length];
      const mid = { lat: (p.lat + nx.lat) / 2, lng: (p.lng + nx.lng) / 2 };
      const mm = new ml.Marker({ element: handleEl('h-mid'), draggable: true }).setLngLat([mid.lng, mid.lat]).addTo(map);
      const ins = () => { const ll = mm.getLngLat(); const n = [...poly]; n.splice(i + 1, 0, { lat: ll.lat, lng: ll.lng }); return n; };
      mm.on('drag', () => setLive(ins()));
      mm.on('dragend', () => { const n = ins(); setLive(null); setPoly(n); setSel(i + 1); });
      made.push(mm);
    });
    return () => made.forEach((m) => m.remove());
  }, [map, mode, poly, sel]);

  // search (Photon / OpenStreetMap, no key)
  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    const t = setTimeout(async () => {
      const f = lastFix();
      const u = `https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}${f ? `&lat=${f.lat}&lon=${f.lng}` : ''}`;
      try {
        const j = (await (await fetch(u)).json()) as { features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] };
        setHits(j.features.map((x) => {
          const pr = x.properties;
          const label = [pr.name ?? [pr.housenumber, pr.street].filter(Boolean).join(' '), pr.city ?? pr.county, pr.state].filter(Boolean).join(', ');
          return { label, lng: x.geometry.coordinates[0], lat: x.geometry.coordinates[1] };
        }));
      } catch { setHits([]); }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const autoFit = async () => {
    const c = mode === 'circle' ? center : preview?.center;
    const r = mode === 'circle' ? radius : preview?.radiusM;
    if (!c || !r) return;
    setBusy('Tracing\u2026');
    setMsg('');
    try {
      const pts = await fitToStreets(c, r * 1.05);
      setPoly(pts);
      setMode('poly');
      setSel(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally { setBusy(''); }
  };

  const toPoly = () => {
    if (!center) return;
    setPoly(circlePolygon(center, radius, 16));
    setMode('poly');
    setSel(null);
  };

  return (
    <div className="screen editor">
      <GameMap
        area={preview}
        areaMode="edit"
        fitKey={fitKey}
        onReady={setMap}
        initialCenter={lastFix()}
        onClick={(p) => {
          if (mode === 'circle' && !center) { setCenter(p); return; }
          if (mode === 'circle') setCenter(p);
          setSel(null);
        }}
      >
        <div className="editor-top">
          <div className="search">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a place or address" />
            {hits.length > 0 && (
              <div className="hits">
                {hits.map((h, i) => (
                  <button key={i} onClick={() => { flyTo(map, h, 16); setHits([]); setQ(h.label); }}>{h.label}</button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" style={{ width: 52, height: 52 }} aria-label="My location" onClick={async () => { const f = await startGeo(); if (f) flyTo(map, f, 17); }}><Icon name="locate" /></button>
        </div>
      </GameMap>

      <div className="editor-sheet">
        {mode === 'circle' ? (
          <>
            <p className="hint">{center ? 'Drag the circle or the white knob to resize. Then trace the streets for a snug outline.' : 'Tap the map where you\u2019re playing.'}</p>
            {center && (
              <label className="slider">
                <span className="top"><span>Radius</span><b>{ft(radius)}</b></span>
                <input type="range" min={40} max={1500} step={5} value={radius} onChange={(e) => setRadius(+e.target.value)} />
              </label>
            )}
            <div className="row">
              <button className="btn" disabled={!center || !!busy} onClick={autoFit}>{busy || 'Trace the streets'}</button>
              <button className="btn ghost" disabled={!center} onClick={toPoly}>Edit shape</button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">Drag a point to move it. Drag a small dot to add a point. Tap a point to select it.</p>
            <div className="row">
              <button className="btn ghost" disabled={sel === null || poly.length <= 3} onClick={() => { setPoly(poly.filter((_, i) => i !== sel)); setSel(null); }}>Delete point</button>
              <button className="btn ghost" disabled={!!busy} onClick={autoFit}>{busy || 'Re-trace'}</button>
              <button className="btn ghost" onClick={() => { setMode('circle'); if (preview) { setCenter(preview.center); setRadius(Math.round(preview.radiusM)); } }}>Circle</button>
            </div>
          </>
        )}
        {msg && <p className="warn-text">{msg}</p>}
        <div className="row">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!preview} onClick={() => { if (preview) { onSave(preview); setFitKey((k) => k + 1); } }}>Use this area</button>
        </div>
      </div>
    </div>
  );
}
