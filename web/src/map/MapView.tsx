import { useEffect, useRef } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import { fromLonLat, toLonLat } from 'ol/proj';
import { ScaleLine, defaults as defaultControls } from 'ol/control';
import { Fill, Stroke, Style, Circle as CircleStyle } from 'ol/style';
import './projections';

export type BaseMapId = 'osm' | 'vworld-base' | 'vworld-satellite' | 'vworld-gray';

export interface MapHandle {
  map: Map;
  /** features drawn for search hits / selected parcels */
  highlight: VectorSource;
}

const vworld = (layer: string) => new XYZ({ url: `/api/tiles/vworld/${layer}/{z}/{y}/{x}`, maxZoom: 19, attributions: '© VWorld' });

function makeBase(id: BaseMapId) {
  switch (id) {
    case 'vworld-base':
      return vworld('Base');
    case 'vworld-satellite':
      return vworld('Satellite');
    case 'vworld-gray':
      return vworld('gray');
    default:
      return new OSM();
  }
}

interface Props {
  baseMap: BaseMapId;
  onReady: (h: MapHandle) => void;
  onClick: (lon: number, lat: number) => void;
}

export function MapView({ baseMap, onReady, onClick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const baseLayer = useRef<TileLayer | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    const highlight = new VectorSource();
    const base = new TileLayer({ source: makeBase(baseMap) });
    baseLayer.current = base;
    const map = new Map({
      target: el.current!,
      layers: [
        base,
        new VectorLayer({
          source: highlight,
          style: new Style({
            fill: new Fill({ color: 'rgba(255, 99, 71, 0.2)' }),
            stroke: new Stroke({ color: '#ff6347', width: 2 }),
            image: new CircleStyle({ radius: 7, fill: new Fill({ color: '#ff6347' }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
          }),
        }),
      ],
      controls: defaultControls().extend([new ScaleLine()]),
      // original default view (bizgismap_cs.as): 126.98307, 37.56965 @ z15, zoom range 2..19
      view: new View({ center: fromLonLat([126.98307, 37.56965]), zoom: 15, minZoom: 2, maxZoom: 19, constrainResolution: true }),
    });
    map.on('singleclick', (e) => {
      const [lon, lat] = toLonLat(e.coordinate);
      clickRef.current(lon, lat);
    });
    onReady({ map, highlight });
    return () => map.setTarget(undefined);
    // map is created once; base map changes are applied below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    baseLayer.current?.setSource(makeBase(baseMap));
  }, [baseMap]);

  return <div ref={el} className="map" />;
}
