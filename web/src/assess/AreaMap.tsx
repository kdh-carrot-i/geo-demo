// 상권 지도: 범위(경계 다각형 또는 원), 점포 점(대분류 색), 지하철역. 범례에서 대분류를 켜고 끌 수 있다.
import { useEffect, useMemo, useRef, useState } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import Overlay from 'ol/Overlay';
import Point from 'ol/geom/Point';
import Circle from 'ol/geom/Circle';
import Polygon from 'ol/geom/Polygon';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import { fromLonLat } from 'ol/proj';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style } from 'ol/style';
import type { AreaReport } from './types';

/** 대분류 → 범주색 슬롯 (고정 순서, 개수가 바뀌어도 색은 그대로). 나머지는 '기타' 회색. */
export const LCLS_SLOT: Record<string, number> = { 음식: 1, 소매: 2, '수리·개인': 3, 교육: 4, 보건의료: 5, 숙박: 6, '예술·스포츠': 7 };
export const lclsColorVar = (name: string) => (LCLS_SLOT[name] ? `var(--cat-${LCLS_SLOT[name]})` : 'var(--cat-other)');
const legendName = (name: string) => (LCLS_SLOT[name] ? name : '기타');

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function baseLayer() {
  const t = document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'midnight' : 'white';
}

export function AreaMap({ r, height = 460 }: { r: AreaReport; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const src = useRef(new VectorSource());
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const legend = useMemo(() => {
    const m = new globalThis.Map<string, number>();
    for (const p of r.points) m.set(legendName(p[2]), (m.get(legendName(p[2])) ?? 0) + 1);
    const order = [...Object.keys(LCLS_SLOT), '기타'];
    return order.filter((k) => m.has(k)).map((k) => ({ name: k, count: m.get(k)! }));
  }, [r.points]);

  useEffect(() => {
    const overlay = new Overlay({ element: tip.current!, offset: [10, -10], positioning: 'bottom-left' });
    const m = new Map({
      target: el.current!,
      layers: [
        new TileLayer({ source: new XYZ({ url: `/api/tiles/vworld/${baseLayer()}/{z}/{y}/{x}`, maxZoom: 19, attributions: '© VWorld' }) }),
        new VectorLayer({ source: src.current }),
      ],
      overlays: [overlay],
      controls: defaultControls({ rotate: false }).extend([new ScaleLine()]),
      view: new View({ center: fromLonLat([r.area.lng, r.area.lat]), zoom: 16, maxZoom: 19 }),
    });
    m.on('pointermove', (e) => {
      const f = m.forEachFeatureAtPixel(e.pixel, (f) => (f.get('tip') ? f : undefined), { hitTolerance: 4 });
      const t = f?.get('tip') as string | undefined;
      if (t) {
        tip.current!.innerHTML = t;
        overlay.setPosition(e.coordinate);
      } else overlay.setPosition(undefined);
    });
    map.current = m;
    return () => m.setTarget(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const s = src.current;
    s.clear();
    const accent = css('--site') || '#eb6834';
    const surface = css('--surface-1') || '#fcfcfb';
    const ink = css('--text-primary') || '#0b0b0b';
    const edge = new Style({ stroke: new Stroke({ color: accent, width: 2, lineDash: [6, 4] }), fill: new Fill({ color: 'rgba(235,104,52,0.05)' }) });
    if (r.area.polygons) {
      for (const rings of r.area.polygons) {
        const f = new Feature(new Polygon(rings.map((ring) => ring.map(([x, y]) => fromLonLat([x, y])))));
        f.setStyle(edge);
        s.addFeature(f);
      }
    } else if (r.area.radius_m) {
      const f = new Feature(new Circle(fromLonLat([r.area.lng, r.area.lat]), r.area.radius_m / Math.cos((r.area.lat * Math.PI) / 180)));
      f.setStyle(edge);
      s.addFeature(f);
    }
    const styles = new globalThis.Map<string, Style>();
    const styleFor = (name: string) => {
      const k = legendName(name);
      let st = styles.get(k);
      if (!st) {
        const color = css(LCLS_SLOT[k] ? `--cat-${LCLS_SLOT[k]}` : '--cat-other') || '#898781';
        st = new Style({ image: new CircleStyle({ radius: 3.5, fill: new Fill({ color }), stroke: new Stroke({ color: surface, width: 1 }) }) });
        styles.set(k, st);
      }
      return st;
    };
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    for (const [lng, lat, lcls, name, scls, flr] of r.points) {
      if (hidden.has(legendName(lcls))) continue;
      const f = new Feature(new Point(fromLonLat([lng, lat])));
      f.set('tip', `<strong>${esc(name)}</strong><br>${esc(lcls)} · ${esc(scls)}${flr ? ` · ${esc(flr)}층` : ''}`);
      f.setStyle(styleFor(lcls));
      s.addFeature(f);
    }
    const stn = new Style({ image: new RegularShape({ points: 4, radius: 8, angle: Math.PI / 4, fill: new Fill({ color: ink }), stroke: new Stroke({ color: surface, width: 2 }) }) });
    for (const st of r.transport.stations) {
      const f = new Feature(new Point(fromLonLat([st.lng, st.lat])));
      f.set('tip', `<strong>${esc(st.name)}</strong><br>${esc(st.lines.join(', '))}${st.ridership ? `<br>하루 승하차 ${st.ridership.daily_avg.toLocaleString()}명` : ''}`);
      f.setStyle(stn);
      s.addFeature(f);
    }
    const bus = new Style({ image: new RegularShape({ points: 3, radius: 5, fill: new Fill({ color: ink }), stroke: new Stroke({ color: surface, width: 1 }) }) });
    for (const [lng, lat, name] of r.transport.bus_stops.points) {
      const f = new Feature(new Point(fromLonLat([lng, lat])));
      f.set('tip', `<strong>${esc(name)}</strong><br>버스정류장`);
      f.setStyle(bus);
      s.addFeature(f);
    }
    const view = map.current?.getView();
    const ext = s.getExtent();
    if (view && ext.every(Number.isFinite)) view.fit(ext, { padding: [24, 24, 24, 24], maxZoom: 17 });
  }, [r, hidden]);

  const toggle = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div>
      <div className="sitemap" style={{ height }}>
        <div ref={el} className="sitemap-canvas" />
        <div ref={tip} className="tooltip" />
      </div>
      <ul className="legend" aria-label="업종 대분류 (눌러서 켜고 끄기)">
        {legend.map((l) => (
          <li key={l.name}>
            <button type="button" className={hidden.has(l.name) ? 'off' : ''} onClick={() => toggle(l.name)} aria-pressed={!hidden.has(l.name)}>
              <span className="swatch" style={{ background: l.name === '기타' ? 'var(--cat-other)' : lclsColorVar(l.name) }} />
              {l.name} <span className="muted">{l.count.toLocaleString()}</span>
            </button>
          </li>
        ))}
        <li className="muted small">
          <span className="swatch diamond" /> 지하철역 · ▲ 버스정류장 · 점선 = 분석 범위{r.points.length < r.industry.total ? ` · 점포 ${r.industry.total.toLocaleString()}곳 중 ${r.points.length.toLocaleString()}곳 표시` : ''}
        </li>
      </ul>
    </div>
  );
}
