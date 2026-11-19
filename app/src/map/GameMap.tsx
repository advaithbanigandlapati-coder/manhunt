import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as ml from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Area, LatLng, Marker as Pin } from '../../../shared/protocol';

// MapLibre's tile worker must be served as its own file once bundled
ml.setWorkerUrl(workerUrl);

// OpenFreeMap: free vector tiles, no key, no account.
export const STYLE_DAY = 'https://tiles.openfreemap.org/styles/liberty';
export const STYLE_NIGHT = 'https://tiles.openfreemap.org/styles/dark';
type BaseStyle = string | ml.StyleSpecification;
const styles: { day: BaseStyle; night: BaseStyle } = { day: STYLE_DAY, night: STYLE_NIGHT };
/** Swap the basemap (the demo uses a bundled offline map). */
export function setBaseStyles(day: BaseStyle, night: BaseStyle) { styles.day = day; styles.night = night; }
const BLANK_STYLE: ml.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0d131b' } }],
};

export type MapPlayer = {
  id: string;
  lat: number;
  lng: number;
  color: string;
  label: string;
  kind: 'team' | 'ally' | 'ping' | 'camping' | 'outside' | 'dark' | 'replay';
  title?: string;
};

type Props = {
  area?: Area | null;
  areaMode?: 'game' | 'edit';
  players?: MapPlayer[];
  me?: { lat: number; lng: number; acc: number; color: string } | null;
  pins?: Pin[];
  night?: boolean;
  fitKey?: unknown; // change to re-fit the view to the area
  initialCenter?: LatLng | null;
  onClick?: (p: LatLng) => void;
  onLongPress?: (p: LatLng) => void;
  onPinTap?: (pin: Pin) => void;
  onReady?: (map: ml.Map) => void;
  children?: ReactNode;
};

const WORLD: [number, number][] = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];

function ring(poly: LatLng[]): [number, number][] {
  const r = poly.map((p) => [p.lng, p.lat] as [number, number]);
  return r.length ? [...r, r[0]] : r;
}

function addAreaLayers(map: ml.Map) {
  if (map.getSource('area')) return;
  const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('area', { type: 'geojson', data: empty });
  map.addSource('accuracy', { type: 'geojson', data: empty });
  map.addLayer({ id: 'mask-fill', type: 'fill', source: 'mask', paint: { 'fill-color': '#05070a', 'fill-opacity': 0.55 } });
  map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#3b82f6', 'line-width': 3 } });
  map.addLayer({ id: 'acc-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#a3e635', 'fill-opacity': 0.12 } });
}

function setAreaData(map: ml.Map, area: Area | null | undefined, mode: 'game' | 'edit') {
  const a = map.getSource('area') as ml.GeoJSONSource | undefined;
  const m = map.getSource('mask') as ml.GeoJSONSource | undefined;
  if (!a || !m) return;
  const r = area?.polygon.length ? ring(area.polygon) : null;
  a.setData({ type: 'FeatureCollection', features: r ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [r] } }] : [] });
  m.setData({ type: 'FeatureCollection', features: r && mode === 'game' ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [WORLD, r] } }] : [] });
  map.setPaintProperty('area-line', 'line-dasharray', mode === 'edit' ? [2, 1] : [1, 0]);
}

function circleRing(c: LatLng, r: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    out.push([c.lng + (r * Math.cos(a)) / (111_320 * Math.cos((c.lat * Math.PI) / 180)), c.lat + (r * Math.sin(a)) / 110_574]);
  }
  return out;
}

export function GameMap(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<ml.Map | null>(null);
  const markers = useRef(new Map<string, ml.Marker>());
  const pinMarkers = useRef(new Map<string, ml.Marker>());
  const meMarker = useRef<ml.Marker | null>(null);
  const [ready, setReady] = useState(0);
  const cb = useRef(p);
  cb.current = p;

  // create the map once
  useEffect(() => {
    const c = p.area?.center ?? p.initialCenter ?? (p.me ? { lat: p.me.lat, lng: p.me.lng } : { lat: 39.5, lng: -98.35 });
    const map = new ml.Map({
      container: el.current!,
      style: p.night ? styles.night : styles.day,
      center: [c.lng, c.lat],
      zoom: p.area || p.initialCenter || p.me ? 16 : 3,
      attributionControl: { compact: true },
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.on('style.load', () => { addAreaLayers(map); setReady((n) => n + 1); });
    // If the tile server can't be reached (bad signal, outage) fall back to a blank style so the
    // play area, players and markers still draw. The game never depends on the basemap.
    let styled = false;
    map.on('style.load', () => { styled = true; });
    const fallback = setTimeout(() => { if (!styled) map.setStyle(BLANK_STYLE); }, 8000);
    map.on('remove', () => clearTimeout(fallback));
    map.on('error', (e) => {
      const msg = String((e as unknown as { error?: { message?: string } }).error?.message ?? '');
      if (msg.includes('styles/dark')) map.setStyle(styles.day);
      else if (!styled && msg.includes('styles/')) map.setStyle(BLANK_STYLE);
    });
    map.on('click', (e) => cb.current.onClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    map.on('contextmenu', (e) => cb.current.onLongPress?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    // long-press on touch screens
    let t: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => clearTimeout(t);
    map.on('touchstart', (e) => {
      cancel();
      if (e.points.length !== 1) return;
      const ll = e.lngLat;
      t = setTimeout(() => cb.current.onLongPress?.({ lat: ll.lat, lng: ll.lng }), 600);
    });
    map.on('touchend', cancel);
    map.on('touchcancel', cancel);
    map.on('dragstart', cancel);
    map.on('zoomstart', cancel);
    cb.current.onReady?.(map);
    return () => { map.remove(); mapRef.current = null; markers.current.clear(); pinMarkers.current.clear(); meMarker.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // day/night
  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) map.setStyle(p.night ? styles.night : styles.day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.night]);

  // area polygon
  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) setAreaData(map, p.area, p.areaMode ?? 'game');
  }, [p.area, p.areaMode, ready]);

  // fit to area
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.area?.polygon.length) return;
    const b = new ml.LngLatBounds();
    p.area.polygon.forEach((q) => b.extend([q.lng, q.lat]));
    map.fitBounds(b, { padding: 50, duration: 600, maxZoom: 18 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitKey]);

  // me + accuracy circle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!p.me) { meMarker.current?.remove(); meMarker.current = null; return; }
    if (!meMarker.current) {
      const d = document.createElement('div');
      d.className = 'me-dot';
      meMarker.current = new ml.Marker({ element: d }).setLngLat([p.me.lng, p.me.lat]).addTo(map);
    }
    meMarker.current.setLngLat([p.me.lng, p.me.lat]);
    (meMarker.current.getElement() as HTMLElement).style.setProperty('--c', p.me.color);
    const acc = map.getSource('accuracy') as ml.GeoJSONSource | undefined;
    acc?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(p.me, Math.min(p.me.acc, 80))] } }] });
  }, [p.me?.lat, p.me?.lng, p.me?.acc, p.me?.color, ready]);

  // other players
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const pl of p.players ?? []) {
      seen.add(pl.id);
      let mk = markers.current.get(pl.id);
      if (!mk) {
        const d = document.createElement('div');
        d.innerHTML = '<div class="pin-body"><span></span></div>';
        mk = new ml.Marker({ element: d }).setLngLat([pl.lng, pl.lat]).addTo(map);
        markers.current.set(pl.id, mk);
      }
      mk.setLngLat([pl.lng, pl.lat]);
      const d = mk.getElement() as HTMLElement;
      d.className = `pin pin-${pl.kind}`;
      d.style.setProperty('--c', pl.color);
      d.title = pl.title ?? pl.label;
      d.querySelector('span')!.textContent = pl.label;
    }
    for (const [id, mk] of markers.current) if (!seen.has(id)) { mk.remove(); markers.current.delete(id); }
  }, [p.players]);

  // strategy pins
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const pin of p.pins ?? []) {
      seen.add(pin.id);
      if (pinMarkers.current.has(pin.id)) continue;
      const d = document.createElement('div');
      d.className = 'flag';
      d.innerHTML = `<div class="flag-label"></div><div class="flag-stem"></div>`;
      d.querySelector('.flag-label')!.textContent = pin.label;
      d.addEventListener('click', (e) => { e.stopPropagation(); cb.current.onPinTap?.(pin); });
      pinMarkers.current.set(pin.id, new ml.Marker({ element: d, anchor: 'bottom' }).setLngLat([pin.lng, pin.lat]).addTo(map));
    }
    for (const [id, mk] of pinMarkers.current) if (!seen.has(id)) { mk.remove(); pinMarkers.current.delete(id); }
  }, [p.pins]);

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      {p.children}
    </div>
  );
}

export function flyTo(map: ml.Map | null, p: LatLng, zoom?: number) {
  map?.flyTo({ center: [p.lng, p.lat], zoom: zoom ?? Math.max(map.getZoom(), 16), duration: 700 });
}
