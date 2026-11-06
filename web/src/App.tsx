// 지도 도구 (#/map): 주소 검색, 클릭 방식 네 가지 — 필지 선택(PNU) / 건물(동) 선택 / 원으로 상권 설정 / 다각형으로 상권 설정.
// 직접 그린 범위는 상권분석 리포트(#/areas/circle:… 또는 #/areas/poly:…)로 연다.
import { useEffect, useRef, useState } from 'react';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Circle from 'ol/geom/Circle';
import Polygon from 'ol/geom/Polygon';
import GeoJSON from 'ol/format/GeoJSON';
import Draw from 'ol/interaction/Draw';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';
import { MapView, type BaseMapId, type MapHandle } from './map/MapView';
import { api } from './api';
import type { GeocodeResult, ParcelResult, ReverseResult } from './shared/api-types';
import './App.css';

const geojson = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

type Mode = 'parcel' | 'building' | 'circle' | 'polygon';
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'parcel', label: '필지 선택', hint: '필지(PNU) 단위: 지번·공시지가와 그 필지의 건축물대장 전체·입점 점포를 보여 줍니다. 아파트 단지는 단지 전체가 하나로 잡힙니다.' },
  { id: 'building', label: '건물(동) 선택', hint: '건물 한 동 단위: 누른 동의 외곽선과 그 동의 건축물대장·세대수·추정 거주인구를 보여 줍니다. 점포는 동 정보가 없어 필지 단위로만 셉니다.' },
  { id: 'circle', label: '원으로 상권 설정', hint: '중심을 누르고 반경을 정한 뒤 리포트를 만듭니다.' },
  { id: 'polygon', label: '다각형으로 상권 설정', hint: '꼭짓점을 차례로 누르고, 첫 점을 다시 누르거나 마지막 점을 두 번 눌러 닫습니다.' },
];

interface ParcelDetail {
  pnu: string;
  buildings: {
    address: string | null;
    buildings_total?: number;
    buildings: {
      name: string;
      main_use: string;
      detail_use: string | null;
      structure: string;
      floors_above: number | null;
      floors_below: number | null;
      total_area_m2: number | null;
      approval_date: string | null;
      age_years: number | null;
      coverage_ratio: number | null;
      floor_area_ratio: number | null;
    }[];
    floors: { building: string | null; floor: string; use: string; detail_use: string | null; area_m2: number | null }[];
  } | null;
  stores: { total: number; by_lcls: { name: string; count: number }[]; items: { name: string; industry: string; floor: string | null; ho: string | null }[]; as_of: string };
}

interface FloorRow {
  building: string | null;
  floor: string;
  use: string;
  detail_use: string | null;
  area_m2: number | null;
}

interface BuildingDong {
  outline: { geometry: GeoJSON.Geometry; name: string; dong: string; floors_above: number | null; floors_below: number | null; source: string };
  pnu: string | null;
  address: string | null;
  register: {
    name: string;
    kind: string;
    main_use: string;
    detail_use: string | null;
    structure: string;
    floors_above: number | null;
    floors_below: number | null;
    total_area_m2: number | null;
    building_area_m2: number | null;
    approval_date: string | null;
    age_years: number | null;
    households: number | null;
    elevators: number | null;
    parking: number | null;
    floors: FloorRow[];
    floors_note: string | null;
  } | null;
  match: string;
  residents: { households: number; persons_per_household: number; persons: number; basis: string } | null;
  parcel: { buildings: number; households: number | null; stores: number; store_note: string };
  sources: string[];
}

const drawStyle = new Style({
  fill: new Fill({ color: 'rgba(235, 104, 52, 0.08)' }),
  stroke: new Stroke({ color: '#eb6834', width: 2, lineDash: [6, 4] }),
  image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#eb6834' }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
});

export default function App() {
  const mapRef = useRef<MapHandle | null>(null);
  const drawSrc = useRef(new VectorSource());
  const drawRef = useRef<Draw | null>(null);
  const [baseMap, setBaseMap] = useState<BaseMapId>('osm');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<GeocodeResult[]>([]);
  const [mode, setMode] = useState<Mode>('parcel');
  const [info, setInfo] = useState<{ addr?: ReverseResult; parcel?: ParcelResult } | null>(null);
  const [detail, setDetail] = useState<ParcelDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [dong, setDong] = useState<BuildingDong | null>(null);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState(300);
  const [polygon, setPolygon] = useState<number[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onReady(h: MapHandle) {
    mapRef.current = h;
    h.map.addLayer(new VectorLayer({ source: drawSrc.current, style: drawStyle }));
  }

  function goTo(h: GeocodeResult) {
    const m = mapRef.current;
    if (!m) return;
    m.highlight.clear();
    m.highlight.addFeature(new Feature(new Point(fromLonLat([h.lon, h.lat]))));
    m.map.getView().animate({ center: fromLonLat([h.lon, h.lat]), zoom: 17 });
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    const r = await run(() => api.geocode(query.trim()));
    if (r) {
      setHits(r);
      if (r[0]) goTo(r[0]);
    }
  }

  async function inspect(lon: number, lat: number) {
    setDetail(null);
    const r = await run(async () => {
      // parcel lookup may be unconfigured; still show the address
      const [addr, parcels] = await Promise.all([api.reverse(lon, lat), api.parcelAt(lon, lat).catch(() => [])]);
      return { addr, parcel: parcels[0] };
    });
    if (!r) return;
    setInfo(r);
    const m = mapRef.current;
    if (m) {
      m.highlight.clear();
      if (r.parcel) m.highlight.addFeatures(geojson.readFeatures({ type: 'Feature', geometry: r.parcel.geometry, properties: {} }));
      else m.highlight.addFeature(new Feature(new Point(fromLonLat([lon, lat]))));
    }
    if (r.parcel?.pnu) {
      setDetailBusy(true);
      api
        .parcelDetail(r.parcel.pnu)
        .then((d) => setDetail(d as ParcelDetail))
        .catch((e: Error) => setError(`건물 정보: ${e.message}`))
        .finally(() => setDetailBusy(false));
    }
  }

  async function inspectBuilding(lon: number, lat: number) {
    setDong(null);
    const r = (await run(() => api.buildingAt(lon, lat))) as BuildingDong | undefined;
    const m = mapRef.current;
    if (m) {
      m.highlight.clear();
      if (r) m.highlight.addFeatures(geojson.readFeatures({ type: 'Feature', geometry: r.outline.geometry, properties: {} }));
      else m.highlight.addFeature(new Feature(new Point(fromLonLat([lon, lat]))));
    }
    if (r) setDong(r);
  }

  function onMapClick(lon: number, lat: number) {
    if (mode === 'parcel') inspect(lon, lat);
    else if (mode === 'building') inspectBuilding(lon, lat);
    else if (mode === 'circle') setCenter({ lat, lng: lon });
    // polygon mode: the Draw interaction handles clicks
  }

  // redraw the circle whenever the centre or radius changes
  useEffect(() => {
    if (mode !== 'circle') return;
    const src = drawSrc.current;
    src.clear();
    if (!center) return;
    const c = fromLonLat([center.lng, center.lat]);
    src.addFeature(new Feature(new Circle(c, radius / Math.cos((center.lat * Math.PI) / 180))));
    src.addFeature(new Feature(new Point(c)));
  }, [mode, center, radius]);

  // polygon mode: an OpenLayers Draw interaction on the draw layer
  useEffect(() => {
    const m = mapRef.current?.map;
    if (!m) return;
    if (drawRef.current) {
      m.removeInteraction(drawRef.current);
      drawRef.current = null;
    }
    if (mode !== 'polygon') return;
    const d = new Draw({ source: drawSrc.current, type: 'Polygon', style: drawStyle });
    d.on('drawstart', () => {
      drawSrc.current.clear();
      setPolygon(null);
    });
    d.on('drawend', (e) => {
      const g = e.feature.getGeometry() as Polygon;
      setPolygon(g.getCoordinates()[0].map((c) => toLonLat(c)));
    });
    m.addInteraction(d);
    drawRef.current = d;
  }, [mode]);

  function switchMode(next: Mode) {
    drawSrc.current.clear();
    mapRef.current?.highlight.clear();
    setInfo(null);
    setDetail(null);
    setDong(null);
    setCenter(null);
    setPolygon(null);
    setMode(next);
  }

  function openReport() {
    let id: string | null = null;
    if (mode === 'circle' && center) id = `circle:${center.lat.toFixed(6)},${center.lng.toFixed(6)},${radius}`;
    if (mode === 'polygon' && polygon) id = `poly:${polygon.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(',')}`;
    if (id) location.hash = `#/areas/${encodeURIComponent(id)}`;
  }

  const current = MODES.find((x) => x.id === mode)!;

  return (
    <div className="maptool">
      <header className="mt-top">
        <a className="mt-brand" href="#/">
          상권 입지 심사
        </a>
        <nav>
          <a href="#/">새 평가</a>
          <a href="#/history">지난 평가</a>
          <a href="#/areas">상권분석</a>
          <a href="#/watch">모니터링</a>
          <a href="/api/docs" target="_blank" rel="noreferrer">
            API 문서
          </a>
          <a href="#/map" className="on">
            지도 도구
          </a>
        </nav>
      </header>
      <div className="app">
        <aside className="panel">
          <form onSubmit={search} className="search">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="주소 또는 장소 검색" />
            <button disabled={busy}>검색</button>
          </form>
          <label className="basemap">
            배경지도
            <select value={baseMap} onChange={(e) => setBaseMap(e.target.value as BaseMapId)}>
              <option value="osm">OpenStreetMap</option>
              <option value="vworld-base">브이월드 기본</option>
              <option value="vworld-gray">브이월드 회색</option>
              <option value="vworld-satellite">브이월드 영상</option>
            </select>
          </label>

          <div className="modes" role="radiogroup" aria-label="클릭 방식">
            {MODES.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={mode === x.id} className={mode === x.id ? 'on' : ''} onClick={() => switchMode(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          <p className="hint">{current.hint}</p>

          {error && <p className="error">{error}</p>}
          <ul className="hits">
            {hits.map((h, i) => (
              <li key={i} onClick={() => goTo(h)}>
                <strong>{h.label}</strong>
                <span>{h.road ?? h.jibun}</span>
              </li>
            ))}
          </ul>

          {mode === 'circle' && (
            <section className="info">
              <h2>원으로 상권 설정</h2>
              <p className="hint">{center ? `중심 ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}` : '지도에서 중심을 누르십시오.'}</p>
              <label className="radius">
                반경 <b>{radius}m</b>
                <input type="range" min={100} max={1500} step={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
              </label>
              <button type="button" className="primary" disabled={!center} onClick={openReport}>
                이 범위로 상권 리포트 만들기
              </button>
            </section>
          )}

          {mode === 'polygon' && (
            <section className="info">
              <h2>다각형으로 상권 설정</h2>
              <p className="hint">{polygon ? `꼭짓점 ${polygon.length - 1}개 — 다시 그리려면 지도를 누르십시오.` : '꼭짓점을 차례로 누르고, 첫 점을 다시 누르거나 마지막 점을 두 번 눌러 닫습니다. 넓이 7㎢까지.'}</p>
              <button type="button" className="primary" disabled={!polygon} onClick={openReport}>
                이 범위로 상권 리포트 만들기
              </button>
            </section>
          )}

          {mode === 'parcel' && info && (
            <section className="info">
              <h2>클릭 위치</h2>
              <dl>
                <dt>지번</dt>
                <dd>{info.addr?.jibun ?? '-'}</dd>
                <dt>도로명</dt>
                <dd>{info.addr?.road ?? '-'}</dd>
                <dt>행정동</dt>
                <dd>{info.addr?.hName ?? '-'}</dd>
                <dt>PNU</dt>
                <dd>{info.parcel?.pnu ?? '-'}</dd>
                <dt>공시지가</dt>
                <dd>{info.parcel?.officialPrice ? `${info.parcel.officialPrice.toLocaleString()}원/㎡ (${info.parcel.priceYearMonth ?? ''})` : '-'}</dd>
              </dl>
              {detailBusy && <p className="hint">건축물대장·입점 점포를 불러오는 중…</p>}
              {detail && <ParcelDetailView d={detail} />}
            </section>
          )}
          {mode === 'building' && busy && !dong && <p className="hint">건물 외곽선·건축물대장을 불러오는 중…</p>}
          {mode === 'building' && dong && <BuildingDongView d={dong} />}
        </aside>
        <MapView baseMap={baseMap} onReady={onReady} onClick={onMapClick} />
      </div>
    </div>
  );
}

const m2 = (v: number | null) => (v == null ? '-' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}㎡`);

function BuildingDongView({ d }: { d: BuildingDong }) {
  const g = d.register;
  const o = d.outline;
  return (
    <section className="info">
      <h2>
        {o.name || '이름 없는 건물'} {o.dong}
      </h2>
      <dl>
        <dt>주소</dt>
        <dd>{d.address ?? '-'}</dd>
        <dt>PNU</dt>
        <dd>{d.pnu ?? '-'}</dd>
        <dt>외곽선</dt>
        <dd>
          지상 {o.floors_above ?? '-'}층{o.floors_below ? ` · 지하 ${o.floors_below}층` : ''} ({o.source})
        </dd>
      </dl>
      <p className="hint">{d.match}</p>

      <h2>이 동의 건축물대장</h2>
      {g ? (
        <>
          <dl>
            <dt>주용도</dt>
            <dd>
              {g.main_use}
              {g.detail_use && g.detail_use !== g.main_use ? ` (${g.detail_use})` : ''}
            </dd>
            <dt>세대수</dt>
            <dd>{g.households != null ? `${g.households.toLocaleString()}세대` : '-'}</dd>
            <dt>층수</dt>
            <dd>
              지상 {g.floors_above ?? '-'} / 지하 {g.floors_below ?? 0}
            </dd>
            <dt>연면적</dt>
            <dd>{m2(g.total_area_m2)}</dd>
            <dt>건축면적</dt>
            <dd>{m2(g.building_area_m2)}</dd>
            <dt>구조</dt>
            <dd>{g.structure || '-'}</dd>
            <dt>사용승인</dt>
            <dd>
              {g.approval_date ?? '-'}
              {g.age_years != null ? ` (${g.age_years}년)` : ''}
            </dd>
            <dt>승강기·주차</dt>
            <dd>
              {g.elevators ?? '-'}대 · {g.parking ?? '-'}면
            </dd>
          </dl>
          {g.floors.length > 0 && (
            <details>
              <summary>층별 용도 ({g.floors.length})</summary>
              <ul className="floors">
                {g.floors.map((f, i) => (
                  <li key={i}>
                    <b>{f.floor}</b> {f.use}
                    {f.detail_use && f.detail_use !== f.use ? ` (${f.detail_use})` : ''} · {m2(f.area_m2)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {g.floors_note && <p className="hint">{g.floors_note}</p>}
        </>
      ) : (
        <p className="hint">이 동과 연결되는 건축물대장을 찾지 못했습니다.</p>
      )}

      <h2>거주인구 (추정)</h2>
      {d.residents ? (
        <>
          <p>
            <b>약 {d.residents.persons.toLocaleString()}명</b> · {d.residents.households.toLocaleString()}세대 × {d.residents.persons_per_household}명
          </p>
          <p className="hint">{d.residents.basis}</p>
        </>
      ) : (
        <p className="hint">주택이 아니거나 세대수가 없어 추정하지 않았습니다.</p>
      )}

      <h2>같은 필지(단지) 전체</h2>
      <dl>
        <dt>건물</dt>
        <dd>주건축물 {d.parcel.buildings}동</dd>
        <dt>세대수</dt>
        <dd>{d.parcel.households != null ? `${d.parcel.households.toLocaleString()}세대` : '-'}</dd>
        <dt>입점 점포</dt>
        <dd>{d.parcel.stores.toLocaleString()}곳</dd>
      </dl>
      <p className="hint">{d.parcel.store_note} 점포 목록은 "필지 선택"에서 볼 수 있습니다.</p>
      <p className="hint">출처: {d.sources.join(', ')}</p>
    </section>
  );
}

function ParcelDetailView({ d }: { d: ParcelDetail }) {
  const b = d.buildings?.buildings[0];
  return (
    <>
      <h2>건축물대장</h2>
      {b ? (
        <>
          <dl>
            <dt>건물</dt>
            <dd>
              {b.name || '-'}
              {(d.buildings!.buildings_total ?? d.buildings!.buildings.length) > 1 ? ` 외 표제부 ${(d.buildings!.buildings_total ?? d.buildings!.buildings.length) - 1}건` : ''}
              {d.buildings!.buildings_total && d.buildings!.buildings_total > d.buildings!.buildings.length ? ' (동별로 보려면 "건물(동) 선택")' : ''}
            </dd>
            <dt>주용도</dt>
            <dd>
              {b.main_use}
              {b.detail_use ? ` (${b.detail_use})` : ''}
            </dd>
            <dt>구조</dt>
            <dd>{b.structure || '-'}</dd>
            <dt>층수</dt>
            <dd>
              지상 {b.floors_above ?? '-'} / 지하 {b.floors_below ?? 0}
            </dd>
            <dt>연면적</dt>
            <dd>{m2(b.total_area_m2)}</dd>
            <dt>사용승인</dt>
            <dd>
              {b.approval_date ?? '-'}
              {b.age_years != null ? ` (${b.age_years}년)` : ''}
            </dd>
            <dt>건폐·용적</dt>
            <dd>
              {b.coverage_ratio != null ? `${b.coverage_ratio}%` : '미기재'} · {b.floor_area_ratio != null ? `${b.floor_area_ratio}%` : '미기재'}
            </dd>
          </dl>
          {d.buildings!.floors.length > 0 && (
            <details>
              <summary>층별 용도 ({d.buildings!.floors.length})</summary>
              <ul className="floors">
                {d.buildings!.floors.map((f, i) => (
                  <li key={i}>
                    <b>{f.building ? `${f.building} ` : ''}{f.floor}</b> {f.use}
                    {f.detail_use && f.detail_use !== f.use ? ` (${f.detail_use})` : ''} · {m2(f.area_m2)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <p className="hint">이 필지에서 건축물대장을 찾지 못했습니다 (도로·공터이거나 지번이 확정되지 않은 곳일 수 있습니다).</p>
      )}

      <h2>입점 점포 ({d.stores.total})</h2>
      {d.stores.total ? (
        <>
          <p className="hint">
            {d.stores.by_lcls.map((x) => `${x.name} ${x.count}`).join(' · ')} — 상가정보 {d.stores.as_of}
          </p>
          <ul className="floors">
            {d.stores.items.map((s, i) => (
              <li key={i}>
                <b>{s.floor ? `${s.floor}층` : '층 미상'}</b> {s.name} <span className="hint">{s.industry}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">상가정보에 등록된 점포가 없습니다.</p>
      )}
      <p className="hint">출처: 국토교통부 건축HUB 건축물대장, 소상공인시장진흥공단 상가(상권)정보</p>
    </>
  );
}
