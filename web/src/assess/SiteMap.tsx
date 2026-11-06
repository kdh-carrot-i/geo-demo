// Small OpenLayers map: the site, the analysis radius and nearby same-industry stores.
import { useEffect, useRef } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import Overlay from 'ol/Overlay';
import Point from 'ol/geom/Point';
import Circle from 'ol/geom/Circle';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import { fromLonLat, toLonLat } from 'ol/proj';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';

export interface Poi {
  name: string;
  detail: string;
  lat: number;
  lng: number;
}

interface Props {
  lat: number;
  lng: number;
  radiusM?: number;
  pois?: Poi[];
  /** When set, clicking the map moves the site. */
  onPick?: (lat: number, lng: number) => void;
  height?: number;
}

/** Light gray base map, or VWorld's dark one when the page is in dark mode. */
function baseLayer() {
  const t = document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'midnight' : 'white';
}

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function SiteMap({ lat, lng, radiusM, pois = [], onPick, height = 320 }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const layer = useRef<VectorSource>(new VectorSource());
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const overlay = new Overlay({ element: tip.current!, offset: [10, -10], positioning: 'bottom-left' });
    const m = new Map({
      target: el.current!,
      layers: [
        new TileLayer({ source: new XYZ({ url: `/api/tiles/vworld/${baseLayer()}/{z}/{y}/{x}`, maxZoom: 19, attributions: '© VWorld' }) }),
        new VectorLayer({ source: layer.current }),
      ],
      overlays: [overlay],
      controls: defaultControls({ rotate: false }).extend([new ScaleLine()]),
      view: new View({ center: fromLonLat([lng, lat]), zoom: 16, maxZoom: 19 }),
    });
    m.on('singleclick', (e) => {
      if (!pick.current) return;
      const [x, y] = toLonLat(e.coordinate);
      pick.current(y, x);
    });
    m.on('pointermove', (e) => {
      const f = m.forEachFeatureAtPixel(e.pixel, (f) => (f.get('poi') ? f : undefined), { hitTolerance: 6 });
      const p = f?.get('poi') as Poi | undefined;
      if (p) {
        tip.current!.innerHTML = `<strong>${p.name.replace(/</g, '&lt;')}</strong><br>${p.detail.replace(/</g, '&lt;')}`;
        overlay.setPosition(e.coordinate);
      } else overlay.setPosition(undefined);
    });
    map.current = m;
    return () => m.setTarget(undefined);
    // created once; content updates below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const src = layer.current;
    src.clear();
    const site = fromLonLat([lng, lat]);
    const accent = css('--site') || '#eb6834';
    const series = css('--series-1') || '#2a78d6';
    const surface = css('--surface-1') || '#fcfcfb';
    if (radiusM) {
      // EPSG:3857 metres stretch by 1/cos(lat)
      const ring = new Feature(new Circle(site, radiusM / Math.cos((lat * Math.PI) / 180)));
      ring.setStyle(new Style({ stroke: new Stroke({ color: accent, width: 2, lineDash: [6, 4] }), fill: new Fill({ color: 'rgba(235,104,52,0.06)' }) }));
      src.addFeature(ring);
    }
    for (const p of pois) {
      const f = new Feature(new Point(fromLonLat([p.lng, p.lat])));
      f.set('poi', p);
      f.setStyle(new Style({ image: new CircleStyle({ radius: 5, fill: new Fill({ color: series }), stroke: new Stroke({ color: surface, width: 2 }) }) }));
      src.addFeature(f);
    }
    const marker = new Feature(new Point(site));
    marker.setStyle(new Style({ image: new CircleStyle({ radius: 8, fill: new Fill({ color: accent }), stroke: new Stroke({ color: surface, width: 2 }) }) }));
    src.addFeature(marker);
    const view = map.current?.getView();
    if (view) {
      view.setCenter(site);
      if (radiusM) view.fit(src.getExtent(), { padding: [24, 24, 24, 24], maxZoom: 18 });
    }
  }, [lat, lng, radiusM, pois]);

  return (
    <div className="sitemap" style={{ height }}>
      <div ref={el} className="sitemap-canvas" />
      <div ref={tip} className="tooltip" />
    </div>
  );
}
