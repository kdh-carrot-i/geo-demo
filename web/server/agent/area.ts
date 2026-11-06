// 상권 분석: 상권 이름 → 범위(경계 다각형, 없으면 중심 + 반경) → 업종 분포·인구·교통·시설·임대료·매출 집계.
// 범위 규칙 (2026-11-02 결정): 소상공인 상권영역(경계) → 서울 상권분석 상권(중심 + 면적 환산 반경)
// → R-ONE 조사 상권(대표 지점 + 500m) → 카카오 장소(중심 + 500m).
import { categorySearch, geocode, keywordPlaces, type KeywordPlace } from '../kakao.ts';
import { normName } from './brand-name.ts';
import { all, LATEST_Q, one } from './db.ts';
import { bbox, distanceM } from './geo.ts';
import { inside, resolveLocation, rings } from './location.ts';
import { ApiProblem } from './problem.ts';
import { supplyPipeline } from './indicators.ts';
import { lookupRent, rentTrend } from './rent.ts';
import { internalDataAllowed, INTERNAL_ONLY_LICENSE, SourceTracker, type Source } from './sources.ts';

const PLACE_RADIUS_M = 500;
/** 지도에서 직접 그린 범위의 상한 (집계 시간을 몇 초로 묶어 두려고) */
const MAX_CUSTOM_RADIUS_M = 1500;
const MAX_CUSTOM_AREA_M2 = 7_000_000;
const MAX_POINTS = 5000;

export interface AreaCandidate {
  id: string;
  name: string;
  kind: 'sbiz_zone' | 'seoul_trdar' | 'rone_area' | 'place' | 'custom_circle' | 'custom_polygon';
  detail: string;
  lat: number;
  lng: number;
  boundary: 'polygon' | 'circle';
  radius_m: number | null;
}

// ── 범위 ─────────────────────────────────────────────────

interface Zone {
  no: string;
  name: string;
  sido: string;
  sgg: string;
  area: number;
  rings: number[][][];
  box: [number, number, number, number];
}
let zones: Zone[] | undefined;
function loadZones(): Zone[] {
  zones ??= all<{ trar_no: string; main_trar_nm: string; ctprvn_nm: string; signgu_nm: string; trar_area: number; wkt: string }>(
    'select trar_no, main_trar_nm, ctprvn_nm, signgu_nm, trar_area, wkt from trade_zone_sbiz where wkt is not null',
  ).map((z) => {
    const rs = rings(z.wkt);
    const xs = rs.flat().map((p) => p[0]);
    const ys = rs.flat().map((p) => p[1]);
    return { no: String(z.trar_no), name: z.main_trar_nm, sido: z.ctprvn_nm, sgg: z.signgu_nm, area: Number(z.trar_area), rings: rs, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  return zones;
}

interface SeoulTa {
  trdar_cd: string;
  trdar_cd_nm: string;
  trdar_se_cd_nm: string;
  signgu_cd_nm: string;
  lat: number;
  lon: number;
  relm_ar: number;
}
let seoulTas: SeoulTa[] | undefined;
const loadSeoul = () => (seoulTas ??= all<SeoulTa>('select trdar_cd, trdar_cd_nm, trdar_se_cd_nm, signgu_cd_nm, lat, lon, relm_ar from trade_area_seoul'));
const taRadius = (t: SeoulTa) => Math.round(Math.min(1000, Math.max(150, Math.sqrt(t.relm_ar / Math.PI))));

interface RoneArea {
  fullnm: string;
  leaf: string;
  lat: number;
  lon: number;
  matched_name: string;
}
let roneAreas: RoneArea[] | undefined;
const loadRone = () => (roneAreas ??= all<RoneArea>('select fullnm, leaf, lat, lon, matched_name from rone_area where lat is not null'));

/** "선릉역1번 출구" and "선릉역7번 출구" are one 상권 to a reviewer */
const zoneGroup = (name: string) => name.replace(/\s*\d+번\s*출구$/, '').trim();

/** 상권 중심이 될 만한 장소: 지하철역·관광명소 분류, 또는 역·터미널·시장·해수욕장·거리 같은 이름의 분류 */
const CENTRAL_GROUPS = new Set(['SW8', 'AT4']);
const CENTRAL_CATEGORY = /지하철|기차역|전철역|터미널|시장|해수욕장|해변|관광|거리|광장|테마거리|테마파크|공원|번화가|먹자골목/; // "테마카페" 같은 가게 분류는 빼려고 테마거리·테마파크만
const isCentral = (p: KeywordPlace) => CENTRAL_GROUPS.has(p.group) || CENTRAL_CATEGORY.test(p.category);
const DEFAULT_PLACES = 5;

/** 상권영역 묶음 → 후보 (note는 별칭으로 찾았을 때 앞에 붙는 설명) */
function zoneCandidate(zs: Zone[], note = ''): AreaCandidate {
  const pts = zs.flatMap((z) => z.rings.flat());
  return {
    id: `zone:${zs.map((z) => z.no).join('.')}`,
    name: zoneGroup(zs[0].name),
    kind: 'sbiz_zone',
    detail: `${note}${zs[0].sido} ${zs[0].sgg} · 소상공인 상권영역${zs.length > 1 ? ` ${zs.length}곳 합침 (${zs.map((z) => z.name).join(', ')})` : ''} · ${Math.round(zs.reduce((s, z) => s + z.area, 0) / 1000).toLocaleString()}천㎡`,
    lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    lng: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    boundary: 'polygon',
    radius_m: null,
  };
}

// ── 별칭 (area_alias: 카카오 테마거리 + 수동 별칭, etl/area-alias.ts) ──
interface AreaAlias {
  alias: string;
  name: string;
  target: string;
  kind: 'kakao_theme' | 'manual';
  category: string;
  sido: string;
  sgg: string;
  address: string;
  lat: number;
  lon: number;
}
let areaAliases: AreaAlias[] | undefined;
function loadAliases(): AreaAlias[] {
  if (!areaAliases) {
    try {
      areaAliases = all<AreaAlias>('select alias, name, target, kind, category, sido, sgg, address, lat, lon from area_alias');
    } catch {
      areaAliases = []; // 아직 적재 전
    }
  }
  return areaAliases;
}
/** 별칭 찾기: 정규화한 이름이 같은 것, 없으면 서로 포함하는 것 (짧은 이름 먼저, 5곳까지) */
function aliasHits(query: string): AreaAlias[] {
  const k = normName(query);
  if (k.length < 2) return [];
  const list = loadAliases();
  const exact = list.filter((a) => a.alias === k);
  if (exact.length) return exact;
  return list
    .filter((a) => a.alias.includes(k) || (a.alias.length >= 3 && k.includes(a.alias)))
    .sort((a, b) => a.alias.length - b.alias.length)
    .slice(0, 5);
}

// ── 검색 순위 ──
// 출처(상권영역·서울 상권·R-ONE·카카오)를 찾은 순서대로 붙이면 "서울역" 검색에 "서울수유초등학교"가 먼저 온다:
// 상권영역 이름은 우체국·학교 같은 기준 시설 이름이라 '역'을 뗀 "서울"이 수십 곳에 걸리기 때문이다.
// 그래서 이름 일치 정도 + 카카오가 찾은 기준 지점과의 거리로 점수를 매겨 정렬하고, 관련 낮은 후보는 덜어 낸다.
const key = (s: string) => zoneGroup(s).replace(/\s+/g, '').toLowerCase();
/** 상권영역 이름이 기준 시설에서 온 경우 (검색어가 그 일부일 뿐이면 뒤로) */
const FACILITY_NAME = /(우체국|우편취급국|초등학교|중학교|고등학교|학교|정류장|병원|주민센터|아파트)$/;
const KIND_ORDER: Record<AreaCandidate['kind'], number> = { sbiz_zone: 4, seoul_trdar: 3, rone_area: 2, place: 1, custom_circle: 0, custom_polygon: 0 };
const MAX_ITEMS = 20;

function nameScore(name: string, q: string): number {
  const n = key(name);
  const qs = [q, q.endsWith('역') ? q.slice(0, -1) : `${q}역`];
  if (qs.includes(n)) return 100; // "서울역" = "서울역", "서면" = "서면역"
  if (n.startsWith(q)) return 80; // "서울역 15번", "강남역 2호선"
  if (n.includes(q)) return 60; // "시청/서울역"
  return q.endsWith('역') && n.includes(q.slice(0, -1)) ? 20 : 10; // '역'만 뗀 이름에 걸린 것 ("서울수유초등학교")
}

/**
 * 후보 정렬: 이름 일치 점수 + 기준 지점 가까움 + 경계 품질(상권영역 > 서울 상권 > R-ONE > 장소).
 * 기준 지점 = 카카오 장소 중 검색어로 시작하는 역·관광지 등 (없으면 검색어로 시작하는 첫 장소, 없으면 별칭 지점).
 */
function rankCandidates(cands: AreaCandidate[], query: string, fromAlias: Set<AreaCandidate>, kp: KeywordPlace[], addrIds: Set<string>): AreaCandidate[] {
  const q = key(query);
  const starts = (p: KeywordPlace) => key(p.name).startsWith(q) || key(p.name).startsWith(q.replace(/역$/, '') + '역');
  // 기준 지점: 역·관광지 같은 상권 중심 장소 > 별칭 지점 > 그 밖 장소. 가게("객리단길무인카페")가 기준이 되면 안 된다
  const a = kp.find((p) => isCentral(p) && starts(p));
  const aliasPt = cands.find((c) => fromAlias.has(c));
  const b = a ?? aliasPt ?? kp.find(starts);
  const anchor = b ? { lat: b.lat, lng: b.lng } : null;
  const dist = (c: AreaCandidate) => (anchor ? distanceM(anchor.lat, anchor.lng, c.lat, c.lng) : Infinity);
  // 상권 중심 분류가 아닌 카카오 장소(가게·건물)와 주소 한 점은 이름이 검색어로 시작해도 상권 후보로는 약하다
  const shopIds = new Set([...addrIds, ...kp.filter((p) => !isCentral(p)).map((p) => `place:${p.lat.toFixed(6)},${p.lng.toFixed(6)}:${encodeURIComponent(p.name)}`)]);
  const scored = cands.map((c) => {
    let s = nameScore(c.name, q);
    // 별칭으로 찾은 후보: 테마거리 지점(이름이 별칭 대상)과 그 지점을 품은 상권영역 — 이름이 달라도 검색 의도와 맞다
    if (fromAlias.has(c)) s = Math.max(s, c.kind === 'place' ? 75 : 78);
    else if (c.kind === 'sbiz_zone' && s < 100 && FACILITY_NAME.test(c.name)) s -= 55; // "서울역삼1동우체국"은 "서울역"을 글자로만 포함 (접두어 80점도 25점으로)
    else if (shopIds.has(c.id)) s = Math.min(s, 50);
    const d = dist(c);
    if (d <= 1500) s += 20;
    else if (anchor && d > 30000) s -= 15; // 같은 이름의 다른 도시 (명동 → 천안 명동패션거리)
    return { c, s, d };
  });
  scored.sort((x, y) => y.s - x.s || KIND_ORDER[y.c.kind] - KIND_ORDER[x.c.kind] || x.d - y.d);
  // 관련 있는 후보(30점 이상)가 3개 이상이면 나머지는 덜어 낸다. 결과가 적은 검색은 그대로 보여 준다
  const good = scored.filter((x) => x.s >= 30);
  return (good.length >= 3 ? good : scored).slice(0, MAX_ITEMS).map((x) => x.c);
}

export interface AreaSearch {
  items: AreaCandidate[];
  /** 장소 후보: 보여 준 개수 / 카카오가 돌려준 전체 개수 (최대 45). all=true면 전부 보여 준다 */
  places: { shown: number; total: number; filter: string };
}

export async function searchAreas(q: string, allPlaces = false): Promise<AreaSearch> {
  const query = q.trim();
  if (query.length < 2) throw new ApiProblem(400, '검색어가 짧음', '상권 이름을 2글자 이상 입력하십시오. 예: 선릉역, 서면역, 광안리');
  const base = query.replace(/역$/, '');
  const out: AreaCandidate[] = [];

  // 별칭·테마거리 ("객리단길" → 객사길): 그 지점을 품은 상권영역, 없으면 테마거리 지점 자체를 맨 앞에
  const aliasOut: AreaCandidate[] = [];
  for (const a of aliasHits(query)) {
    const via = `${a.name}${a.target !== a.name ? ` → ${a.target}` : ''} (${a.kind === 'manual' ? '별칭' : `카카오 ${a.category}`}) · `;
    const zs = loadZones().filter((z) => a.lon >= z.box[0] && a.lon <= z.box[2] && a.lat >= z.box[1] && a.lat <= z.box[3] && inside(a.lon, a.lat, z.rings));
    if (zs.length) aliasOut.push(zoneCandidate(zs.slice(0, 1), via));
    aliasOut.push({
      id: `place:${a.lat.toFixed(6)},${a.lon.toFixed(6)}:${encodeURIComponent(a.target)}`,
      name: a.target,
      kind: 'place',
      detail: `${via}${a.address} · 경계 데이터 없음, 반경 ${PLACE_RADIUS_M}m`,
      lat: a.lat,
      lng: a.lon,
      boundary: 'circle',
      radius_m: PLACE_RADIUS_M,
    });
  }

  const groups = new Map<string, Zone[]>();
  for (const z of loadZones().filter((z) => z.name.includes(base))) {
    const k = `${z.sido}|${z.sgg}|${zoneGroup(z.name)}`;
    groups.set(k, [...(groups.get(k) ?? []), z]);
  }
  for (const zs of groups.values()) out.push(zoneCandidate(zs));
  for (const t of loadSeoul().filter((t) => t.trdar_cd_nm.includes(base)).slice(0, 8)) {
    out.push({
      id: `seoul:${t.trdar_cd}`,
      name: t.trdar_cd_nm,
      kind: 'seoul_trdar',
      detail: `서울 ${t.signgu_cd_nm} · 서울시 상권분석 ${t.trdar_se_cd_nm} · 중심에서 반경 ${taRadius(t)}m (면적 환산)`,
      lat: t.lat,
      lng: t.lon,
      boundary: 'circle',
      radius_m: taRadius(t),
    });
  }
  // R-ONE 임대동향 조사 상권 (이름만 공개 → 카카오로 찾은 대표 지점). 같은 지점을 쓰는 이름은 하나만
  const ronePts = new Set<string>();
  for (const a of loadRone().filter((a) => a.leaf.replace(/\//g, '').includes(base.replace(/\//g, '')))) {
    const k = `${a.lat.toFixed(4)},${a.lon.toFixed(4)}`;
    if (ronePts.has(k)) continue;
    ronePts.add(k);
    out.push({
      id: `rone:${a.fullnm}`,
      name: a.leaf,
      kind: 'rone_area',
      detail: `${a.fullnm.replace(/>/g, ' › ')} · 한국부동산원 임대동향 조사 상권 · 대표 지점(${a.matched_name}) 반경 ${PLACE_RADIUS_M}m`,
      lat: a.lat,
      lng: a.lon,
      boundary: 'circle',
      radius_m: PLACE_RADIUS_M,
    });
  }
  // 주소로 입력한 경우 (지번·도로명 한 점). 도로·지역 이름 주소("강남대로")는 끝점 하나라 상권 중심이 아니다: 다른 후보가 있으면 뺀다
  const addr = (await geocode(query).catch(() => [])).filter((h) => h.source === 'address');
  const addrHits = out.length || aliasOut.length ? addr.filter((h) => h.precision !== 'region') : addr;
  const place = (name: string, lat: number, lng: number, detail: string): AreaCandidate => ({
    id: `place:${lat.toFixed(6)},${lng.toFixed(6)}:${encodeURIComponent(name)}`,
    name,
    kind: 'place',
    detail: `${detail} · 경계 데이터 없음, 반경 ${PLACE_RADIUS_M}m`,
    lat,
    lng,
    boundary: 'circle',
    radius_m: PLACE_RADIUS_M,
  });
  const addrOut = addrHits.slice(0, 3).map((h) => place(h.label, h.lat, h.lon, '주소'));
  out.push(...addrOut);

  // 카카오 장소 (최대 45). 기본은 상권 중심이 될 만한 곳만 5개, all이면 전부
  const kp = await keywordPlaces(query).catch(() => [] as KeywordPlace[]);
  const central = kp.filter(isCentral);
  const picked = allPlaces ? kp : (central.length ? central : kp).slice(0, DEFAULT_PLACES);
  for (const p of picked) out.push(place(p.name, p.lat, p.lng, `${p.road ?? p.address} · ${p.category.split(' > ').slice(-2).join(' › ')}`));
  // 같은 상권영역·같은 지점(50m 안 같은 이름)은 한 번만
  const uniq: AreaCandidate[] = [];
  for (const c of [...aliasOut, ...out])
    if (!uniq.some((x) => x.id === c.id || (x.kind === 'place' && c.kind === 'place' && x.name === c.name && distanceM(x.lat, x.lng, c.lat, c.lng) < 50))) uniq.push(c);
  const items = rankCandidates(uniq, query, new Set(aliasOut), kp, new Set(addrOut.map((c) => c.id)));
  return {
    items,
    places: {
      shown: picked.length,
      total: kp.length,
      filter: allPlaces ? '전체' : central.length ? '역·관광지·시장 등 상권 중심이 될 만한 장소만' : '상권 중심 분류가 없어 검색 상위',
    },
  };
}

interface Geo {
  id: string;
  name: string;
  kind: AreaCandidate['kind'];
  basis: string;
  lat: number;
  lng: number;
  radius_m: number | null;
  /** one entry per 상권영역; each is that zone's rings */
  polygons: number[][][][] | null;
  area_m2: number;
  /** radius used for Kakao circle queries (교통·시설) */
  reach_m: number;
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  contains: (lon: number, lat: number) => boolean;
}

function circleGeo(id: string, name: string, kind: Geo['kind'], basis: string, lat: number, lng: number, r: number): Geo {
  return {
    id, name, kind, basis, lat, lng, radius_m: r, polygons: null, area_m2: Math.round(Math.PI * r * r), reach_m: r,
    box: bbox(lat, lng, r),
    contains: (lon, la) => distanceM(lat, lng, la, lon) <= r,
  };
}

function resolveGeo(id: string): Geo {
  const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'zone') {
    const nos = new Set(rest.split('.'));
    const zs = loadZones().filter((z) => nos.has(z.no));
    if (!zs.length) throw new ApiProblem(404, '상권 없음', `상권영역 ${rest}을(를) 찾을 수 없습니다.`);
    const pts = zs.flatMap((z) => z.rings.flat());
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const reach = Math.min(1000, Math.max(300, Math.max(...pts.map((p) => distanceM(lat, lng, p[1], p[0])))));
    return {
      id, name: zoneGroup(zs[0].name), kind: 'sbiz_zone',
      basis: `소상공인 상권영역 경계${zs.length > 1 ? ` ${zs.length}곳 합침` : ''} (${zs.map((z) => z.name).join(', ')})`,
      lat, lng, radius_m: null, polygons: zs.map((z) => z.rings), area_m2: Math.round(zs.reduce((s, z) => s + z.area, 0)), reach_m: Math.round(reach),
      box: { minLng: Math.min(...zs.map((z) => z.box[0])), minLat: Math.min(...zs.map((z) => z.box[1])), maxLng: Math.max(...zs.map((z) => z.box[2])), maxLat: Math.max(...zs.map((z) => z.box[3])) },
      contains: (lon, la) => zs.some((z) => lon >= z.box[0] && lon <= z.box[2] && la >= z.box[1] && la <= z.box[3] && inside(lon, la, z.rings)),
    };
  }
  if (kind === 'seoul') {
    const t = loadSeoul().find((x) => x.trdar_cd === rest);
    if (!t) throw new ApiProblem(404, '상권 없음', `서울 상권 ${rest}을(를) 찾을 수 없습니다.`);
    return circleGeo(id, t.trdar_cd_nm, 'seoul_trdar', `서울시 상권분석 ${t.trdar_se_cd_nm} — 경계가 없어 중심에서 면적 환산 반경`, t.lat, t.lon, taRadius(t));
  }
  if (kind === 'rone') {
    const a = loadRone().find((x) => x.fullnm === rest);
    if (!a) throw new ApiProblem(404, '상권 없음', `R-ONE 상권 ${rest}을(를) 찾을 수 없습니다.`);
    return circleGeo(id, a.leaf, 'rone_area', `한국부동산원 임대동향 조사 상권 — 경계가 없어 대표 지점(${a.matched_name}) 중심 반경 ${PLACE_RADIUS_M}m`, a.lat, a.lon, PLACE_RADIUS_M);
  }
  if (kind === 'place') {
    const m = /^(-?[\d.]+),(-?[\d.]+):(.*)$/.exec(rest);
    if (!m) throw new ApiProblem(400, '상권 ID 형식 오류', 'place:<위도>,<경도>:<이름> 형식이어야 합니다.');
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) throw new ApiProblem(400, '위치 범위 오류', '국내 좌표가 아닙니다.');
    return circleGeo(id, decodeURIComponent(m[3]) || '선택 지점', 'place', `경계 데이터가 없어 카카오 검색 지점 중심 반경 ${PLACE_RADIUS_M}m`, lat, lng, PLACE_RADIUS_M);
  }
  if (kind === 'circle') {
    // circle:<위도>,<경도>,<반경m> — 지도 도구에서 직접 그린 원
    const [lat, lng, r] = rest.split(',').map(Number);
    if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) throw new ApiProblem(400, '위치 범위 오류', '국내 좌표가 아닙니다.');
    if (!(r >= 50 && r <= MAX_CUSTOM_RADIUS_M)) throw new ApiProblem(400, '반경 범위 오류', `반경은 50~${MAX_CUSTOM_RADIUS_M}m여야 합니다.`);
    return circleGeo(id, `직접 설정한 원 (반경 ${Math.round(r)}m)`, 'custom_circle', `지도에서 직접 그린 원 — 중심 반경 ${Math.round(r)}m`, lat, lng, Math.round(r));
  }
  if (kind === 'poly') {
    // poly:<경도> <위도>,<경도> <위도>,… — 지도 도구에서 직접 그린 다각형 (닫지 않아도 됨)
    const ring = rest.split(',').map((p) => p.trim().split(/\s+/).map(Number));
    if (ring.length < 3 || ring.length > 200 || ring.some((p) => p.length !== 2 || !(p[1] >= 33 && p[1] <= 39 && p[0] >= 124 && p[0] <= 132)))
      throw new ApiProblem(400, '다각형 형식 오류', '꼭짓점 3~200개의 국내 좌표 "경도 위도"를 쉼표로 이어 주십시오.');
    if (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]) ring.push(ring[0]);
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const lng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    // 넓이: 위도 중심에서 미터로 펴서 신발끈 공식
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 110574;
    let a2 = 0;
    for (let i = 0; i < ring.length - 1; i++) a2 += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
    const area = Math.abs(a2) / 2;
    if (area > MAX_CUSTOM_AREA_M2) throw new ApiProblem(400, '범위가 너무 큼', `다각형 넓이는 ${MAX_CUSTOM_AREA_M2 / 1e6}㎢ 이하여야 합니다 (지금 ${(area / 1e6).toFixed(1)}㎢).`);
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const reach = Math.min(1500, Math.max(200, Math.max(...ring.map((p) => distanceM(lat, lng, p[1], p[0])))));
    return {
      id, name: '직접 설정한 다각형', kind: 'custom_polygon', basis: `지도에서 직접 그린 다각형 (꼭짓점 ${ring.length - 1}개)`,
      lat, lng, radius_m: null, polygons: [[ring]], area_m2: Math.round(area), reach_m: Math.round(reach),
      box: { minLng: Math.min(...xs), minLat: Math.min(...ys), maxLng: Math.max(...xs), maxLat: Math.max(...ys) },
      contains: (lon, la) => inside(lon, la, [ring]),
    };
  }
  throw new ApiProblem(400, '상권 ID 형식 오류', 'zone:, seoul:, rone:, place:, circle:, poly: 중 하나로 시작해야 합니다. GET /areas?q= 결과의 id를 쓰십시오.');
}

// ── 집계 ─────────────────────────────────────────────────

interface StoreRow {
  bizes_nm: string;
  brch_nm: string | null;
  inds_lcls_cd: string;
  inds_lcls_nm: string;
  inds_mcls_nm: string;
  inds_scls_nm: string;
  flr_no: string | null;
  lon: number;
  lat: number;
  adong_cd: string | null;
  adong_nm: string | null;
  ldong_cd: string | null;
  ctprvn_cd: string;
}

const sidoShare = new Map<string, Map<string, number>>();
function sidoLclsShare(sido: string): Map<string, number> {
  let m = sidoShare.get(sido);
  if (!m) {
    const rows = all<{ k: string; n: number }>('select inds_lcls_nm k, count(*) n from store where ctprvn_cd = ? group by 1', sido);
    const tot = rows.reduce((s, r) => s + r.n, 0);
    m = new Map(rows.map((r) => [r.k, r.n / tot]));
    sidoShare.set(sido, m);
  }
  return m;
}

const share = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : 0);
function countBy<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}
function floorClass(f: string | null): string {
  const s = (f ?? '').trim();
  if (!s) return '미상';
  if (/^(B|b|지하|-)/.test(s)) return '지하';
  const n = Number(s);
  if (n === 1) return '1층';
  if (n >= 2) return '2층 이상';
  return '미상';
}

function industryMix(stores: StoreRow[]) {
  const total = stores.length;
  const sido = countBy(stores, (s) => s.ctprvn_cd)[0]?.[0];
  const base = sido ? sidoLclsShare(sido) : new Map<string, number>();
  const sidoNm = sido ? one<{ n: string }>('select ctprvn_nm n from store where ctprvn_cd = ? limit 1', sido)?.n ?? sido : '';
  const lcls = countBy(stores, (s) => s.inds_lcls_nm).map(([name, n]) => {
    const sh = share(n, total);
    const b = base.get(name);
    const sub = stores.filter((s) => s.inds_lcls_nm === name);
    return {
      name,
      count: n,
      share: sh,
      /** 이 상권 비중 ÷ 같은 시도 비중. 1.2 이상 = 이 상권에 특히 많음 */
      lq: b ? Math.round((sh / b) * 100) / 100 : null,
      mcls: countBy(sub, (s) => s.inds_mcls_nm).slice(0, 8).map(([m, c]) => ({ name: m, count: c, share: share(c, n) })),
    };
  });
  const food = stores.filter((s) => s.inds_lcls_cd === 'I2');
  return {
    total,
    baseline_area: sidoNm,
    lcls,
    food: countBy(food, (s) => s.inds_mcls_nm).map(([name, c]) => ({ name, count: c, share: share(c, food.length) })),
    top_scls: countBy(stores, (s) => s.inds_scls_nm).slice(0, 15).map(([name, c]) => ({ name, count: c, share: share(c, total) })),
    floors: countBy(stores, (s) => floorClass(s.flr_no)).map(([name, c]) => ({ name, count: c, share: share(c, total) })),
    branch_share: share(stores.filter((s) => s.brch_nm && s.brch_nm.trim()).length, total),
  };
}

function storeChange(g: Geo) {
  const yms = all<{ ym: string }>('select distinct std_ym ym from store_snapshot order by 1 desc limit 2').map((r) => r.ym);
  if (yms.length < 2) return null;
  const [to, from] = yms;
  const pick = (ym: string) =>
    all<{ bizes_id: string; inds_scls_cd: string; lat: number; lon: number }>(
      'select bizes_id, inds_scls_cd, lat, lon from store_snapshot where std_ym = ? and lat between ? and ? and lon between ? and ?',
      ym, g.box.minLat, g.box.maxLat, g.box.minLng, g.box.maxLng,
    ).filter((r) => g.contains(r.lon, r.lat));
  const before = pick(from);
  if (!before.length) return null;
  const after = pick(to);
  const bIds = new Set(before.map((r) => r.bizes_id));
  const aIds = new Set(after.map((r) => r.bizes_id));
  const names = new Map(all<{ c: string; n: string }>('select distinct inds_lcls_cd c, inds_lcls_nm n from store').map((r) => [r.c, r.n]));
  const by = new Map<string, { closed: number; opened: number; before: number }>();
  const bump = (cd: string, k: 'closed' | 'opened' | 'before') => {
    const name = names.get(cd.slice(0, 2)) ?? cd.slice(0, 2);
    const v = by.get(name) ?? { closed: 0, opened: 0, before: 0 };
    v[k]++;
    by.set(name, v);
  };
  for (const r of before) {
    bump(r.inds_scls_cd, 'before');
    if (!aIds.has(r.bizes_id)) bump(r.inds_scls_cd, 'closed');
  }
  for (const r of after) if (!bIds.has(r.bizes_id)) bump(r.inds_scls_cd, 'opened');
  const fmt = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4)}`;
  return {
    from: fmt(from),
    to: fmt(to),
    all: { before: before.length, closed: before.filter((r) => !aIds.has(r.bizes_id)).length, opened: after.filter((r) => !bIds.has(r.bizes_id)).length },
    by_lcls: [...by].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.before - a.before),
  };
}

function foodTrend(g: Geo) {
  const rows = all<{ apv_perm_ymd: string | null; dcb_ymd: string | null; trd_state_nm: string; lat: number; lon: number }>(
    `select apv_perm_ymd, dcb_ymd, trd_state_nm, lat, lon from license_event
     where opn_svc_id = '07_24_04_P' and lat between ? and ? and lon between ? and ?`,
    g.box.minLat, g.box.maxLat, g.box.minLng, g.box.maxLng,
  ).filter((r) => g.contains(r.lon, r.lat));
  if (!rows.length) return null;
  const y0 = new Date().getFullYear() - 5;
  const years = Array.from({ length: 6 }, (_, i) => String(y0 + i));
  const ago = (y: number) => new Date(Date.now() - y * 365.25 * 864e5).toISOString().slice(0, 10);
  const win = (from: string, to: string) => ({
    opened: rows.filter((r) => (r.apv_perm_ymd ?? '') >= from && (r.apv_perm_ymd ?? '') < to).length,
    closed: rows.filter((r) => r.trd_state_nm === '폐업' && (r.dcb_ymd ?? '') >= from && (r.dcb_ymd ?? '') < to).length,
  });
  return {
    /** 최근 3년 / 그 전 3년 (오늘 기준 이동 구간) */
    recent3: win(ago(3), '9999'),
    prev3: win(ago(6), ago(3)),
    active: rows.filter((r) => r.trd_state_nm !== '폐업').length,
    by_year: years.map((y) => ({
      year: y,
      opened: rows.filter((r) => (r.apv_perm_ymd ?? '').startsWith(y)).length,
      closed: rows.filter((r) => r.trd_state_nm === '폐업' && (r.dcb_ymd ?? '').startsWith(y)).length,
    })),
    as_of: one<{ d: string }>("select max(apv_perm_ymd) d from license_event where opn_svc_id = '07_24_04_P'")?.d ?? '',
  };
}

/**
 * 범위에 드는 서울 상권: 중심점이 범위 안이거나, 이름이 같은 상권 (경계선 바로 밖에 중심점이 있는 "선릉역" 같은 경우).
 */
function seoulTasIn(g: Geo): SeoulTa[] {
  if (g.kind === 'seoul_trdar') return loadSeoul().filter((t) => g.id === `seoul:${t.trdar_cd}`);
  const base = g.name.replace(/역$/, '');
  return loadSeoul().filter((t) => g.contains(t.lon, t.lat) || (t.trdar_cd_nm.replace(/역$/, '') === base && distanceM(g.lat, g.lng, t.lat, t.lon) <= 1000));
}

const BANDS: [string, string][] = [['00-06', '00_06'], ['06-11', '06_11'], ['11-14', '11_14'], ['14-17', '14_17'], ['17-21', '17_21'], ['21-24', '21_24']];
const AGES: [string, string][] = [['10대', '10'], ['20대', '20'], ['30대', '30'], ['40대', '40'], ['50대', '50'], ['60대 이상', '60_above']];

/** 서울 상권분석 상권 (중심점이 범위 안에 있는 것) 합산 */
function seoulPopulation(g: Geo) {
  const tas = seoulTasIn(g);
  if (!tas.length) return null;
  const codes = tas.map((t) => t.trdar_cd);
  const ph = codes.map(() => '?').join(',');
  const sum = (table: string, cols: string[]) =>
    one<Record<string, number>>(`select ${cols.map((c) => `sum(${c}) ${c}`).join(', ')} from ${table} where stdr_yyqu_cd = ? and trdar_cd in (${ph})`, LATEST_Q, ...codes) ?? {};
  const f = sum('ta_flpop_q', [
    'tot_flpop_co', 'ml_flpop_co', 'sat_flpop_co', 'sun_flpop_co',
    ...BANDS.map(([, b]) => `tmzon_${b}_flpop_co`), ...AGES.map(([, a]) => `agrde_${a}_flpop_co`),
  ]);
  const r = sum('ta_repop_q', ['tot_repop_co', 'tot_hshld_co', 'apt_hshld_co']);
  const w = sum('ta_wrcpop_q', ['tot_wrc_popltn_co']);
  const tot = f.tot_flpop_co || 0;
  return {
    quarter: LATEST_Q,
    trade_areas: tas.map((t) => `${t.trdar_cd_nm}(${t.trdar_se_cd_nm})`),
    floating: tot
      ? {
          quarter_total: tot,
          daily_avg: Math.round(tot / 91),
          by_time: Object.fromEntries(BANDS.map(([k, b]) => [k, share(f[`tmzon_${b}_flpop_co`] ?? 0, tot)])),
          by_age: Object.fromEntries(AGES.map(([k, a]) => [k, share(f[`agrde_${a}_flpop_co`] ?? 0, tot)])),
          weekend_share: share((f.sat_flpop_co ?? 0) + (f.sun_flpop_co ?? 0), tot),
          male_share: share(f.ml_flpop_co ?? 0, tot),
        }
      : null,
    residents: r.tot_repop_co != null ? { population: r.tot_repop_co, households: r.tot_hshld_co, apt_households: r.apt_hshld_co } : null,
    workers: w.tot_wrc_popltn_co != null ? { workers: w.tot_wrc_popltn_co } : null,
  };
}

/** 범위에 걸친 행정동 (점포 10% 이상, 최대 5곳)의 SGIS 인구·종사자, 유동·생활인구 */
function dongPopulation(stores: StoreRow[]) {
  const total = stores.length;
  const dongs = countBy(stores.filter((s) => s.adong_cd), (s) => `${s.adong_cd}|${s.adong_nm}`)
    .filter(([, n], i) => i === 0 || n / total >= 0.1)
    .slice(0, 5);
  return dongs.map(([k, n]) => {
    const [adm_cd, adm_nm] = k.split('|');
    const sg = one<{ tot_ppltn: number; household_cnt: number; tot_worker: number; corp_cnt: number; year: string }>(
      `select s.tot_ppltn, s.household_cnt, s.tot_worker, s.corp_cnt, s.year from region_code_map m join sgis_adm_stats s on s.sgis_adm_cd = m.sgis_cd
       where m.level = 'dong' and m.adm_cd = ? limit 1`,
      adm_cd,
    );
    const seoul = adm_cd.startsWith('11');
    const living = seoul ? one<{ v: number }>('select avg(tot_lvpop_co) v from living_pop_dong_h where adstrd_code_se = ?', adm_cd)?.v ?? null : null;
    const flow =
      !seoul && internalDataAllowed()
        ? one<{ kind: string; hourly_avg: number; p10: number; p90: number }>('select kind, hourly_avg, p10, p90 from flowpop_est_dong where adm_cd = ?', adm_cd) ?? null
        : null;
    return {
      adm_cd,
      adm_nm,
      store_share: share(n, total),
      population: sg?.tot_ppltn ?? null,
      households: sg?.household_cnt ?? null,
      workers: sg?.tot_worker ?? null,
      businesses: sg?.corp_cnt ?? null,
      sgis_year: sg?.year ?? null,
      living_pop_hourly: living != null ? Math.round(living) : null,
      flowpop_hourly: flow ? { kind: flow.kind, value: flow.hourly_avg, range: flow.kind === 'estimated' ? [flow.p10, flow.p90] : null, license: INTERNAL_ONLY_LICENSE } : null,
    };
  });
}

/**
 * 범위 안 점포의 법정동 합계: 국민연금 직장인(300인 이하 사업장)·소득 추정, 주민등록 인구·세대와 1년 증감.
 * 점포가 1% 미만인 법정동은 뺀다 (경계에 살짝 걸친 동이 합계를 부풀리지 않게).
 */
function areaDemand(stores: StoreRow[]) {
  const counts = countBy(stores.filter((s) => s.ldong_cd), (s) => s.ldong_cd!);
  const bjds = counts.filter(([, n]) => n / stores.length >= 0.01).map(([k]) => k);
  if (!bjds.length) return null;
  const ph = bjds.map(() => '?').join(',');
  let workers: { members: number; income: number | null; workplaces: number } | null = null;
  try {
    const w = one<{ m: number; b: number; n: number }>(
      `select sum(case when members <= 300 then members else 0 end) m, sum(case when members <= 300 then bill else 0 end) b, count(*) n
       from nps_workplace where bjd_cd in (${ph})`,
      ...bjds,
    );
    if (w?.n) workers = { members: w.m, income: w.m ? Math.round(w.b / w.m / 0.095 / 10000) * 10000 : null, workplaces: w.n };
  } catch {
    // 적재 전
  }
  let residents: { population: number; households: number; change_pct: number | null; as_of: string } | null = null;
  try {
    const last = one<{ ym: string }>(`select max(stats_ym) ym from resident_pop_bjd where stdg_cd in (${ph})`, ...bjds)?.ym;
    if (last) {
      const ago = `${Number(last.slice(0, 4)) - 1}${last.slice(4)}`;
      const cur = one<{ p: number; h: number }>(`select sum(tot) p, sum(hh_cnt) h from resident_pop_bjd where stats_ym = ? and stdg_cd in (${ph})`, last, ...bjds);
      const prev = one<{ p: number }>(`select sum(tot) p from resident_pop_bjd where stats_ym = ? and stdg_cd in (${ph})`, ago, ...bjds);
      if (cur?.p) residents = { population: cur.p, households: cur.h, change_pct: prev?.p ? Math.round(((cur.p - prev.p) / prev.p) * 1000) / 10 : null, as_of: `${last.slice(0, 4)}-${last.slice(4)}` };
    }
  } catch {
    // 적재 전
  }
  if (!workers && !residents) return null;
  return { bjd_count: bjds.length, workers, residents, scope: `범위 안 점포의 법정동 ${bjds.length}곳 합계 (점포 1% 이상인 동)` };
}

let subwayDaily: Map<string, { daily: number; lines: Set<string> }> | undefined;
let subwayPeak: Map<string, { hr: string; riders: number }> | undefined;
const stationKey = (s: string) => s.replace(/\(.*\)/, '').replace(/역$/, '').trim();
/** 서울 밖 역: 노선 이름으로 지역을 정한다 ("부산1호선", "대구2호선", "인천1호선", "광주1호선", "대전1호선") */
const REGION_OF_LINE = /(부산|대구|인천|광주|대전)/;
function regionalSubway(name: string, lines: string[]) {
  const region = lines.map((l) => REGION_OF_LINE.exec(l)?.[1]).find(Boolean);
  if (!region) return null;
  const r = one<{ daily_avg: number; peak_hour: number | null; lines: string | null; provider: string; date_from: string; date_to: string }>(
    'select daily_avg, peak_hour, lines, provider, date_from, date_to from subway_station_stats where region = ? and station = ?',
    region,
    stationKey(name),
  );
  return r ? { daily_avg: r.daily_avg, lines: r.lines ? r.lines.split(',') : [], peak_hour: r.peak_hour != null ? String(r.peak_hour).padStart(2, '0') : null, source: 'regional' as const } : null;
}

function subwayStats(name: string, lines: string[] = []) {
  const regional = regionalSubway(name, lines);
  if (regional) return regional;
  if (lines.length && lines.every((l) => REGION_OF_LINE.test(l))) return null;
  if (!subwayDaily) {
    subwayDaily = new Map();
    const days = one<{ d: number }>('select count(distinct use_ymd) d from subway_daily')?.d || 1;
    for (const r of all<{ l: string; s: string; v: number }>('select sbwy_rout_ln_nm l, sbwy_stns_nm s, sum(gton_tnope + gtoff_tnope) v from subway_daily group by 1, 2')) {
      const k = stationKey(r.s);
      const cur = subwayDaily.get(k) ?? { daily: 0, lines: new Set<string>() };
      cur.daily += r.v / days;
      cur.lines.add(r.l);
      subwayDaily.set(k, cur);
    }
    subwayPeak = new Map();
    const mm = one<{ m: string }>('select max(use_mm) m from subway_hourly_m')?.m;
    const hourly = new Map<string, Map<string, number>>();
    for (const r of all<{ s: string; hr: string; v: number }>('select station_nm s, hr, sum(ride + alight) v from subway_hourly_m where use_mm = ? group by 1, 2', mm ?? '')) {
      const k = stationKey(r.s);
      const m = hourly.get(k) ?? new Map<string, number>();
      m.set(r.hr, (m.get(r.hr) ?? 0) + r.v);
      hourly.set(k, m);
    }
    for (const [k, m] of hourly) {
      const [hr, v] = [...m].sort((a, b) => b[1] - a[1])[0];
      subwayPeak.set(k, { hr, riders: v });
    }
  }
  const k = stationKey(name);
  const d = subwayDaily.get(k);
  return d ? { daily_avg: Math.round(d.daily), lines: [...d.lines], peak_hour: subwayPeak!.get(k)?.hr ?? null, source: 'seoul' as const } : null;
}

const FACILITIES: [string, string][] = [
  ['MT1', '대형마트'], ['SC4', '학교'], ['AC5', '학원'], ['HP8', '병원'], ['PM9', '약국'], ['BK9', '은행'],
  ['PO3', '공공기관'], ['CT1', '문화시설'], ['AT4', '관광명소'], ['AD5', '숙박'],
];

/** 버스정류장: 범위(경계 다각형 또는 원) 안에서 직접 센다 */
function busStops(g: Geo) {
  const rows = all<{ stop_nm: string; lat: number; lon: number }>(
    'select stop_nm, lat, lon from bus_stop where lat between ? and ? and lon between ? and ?',
    g.box.minLat, g.box.maxLat, g.box.minLng, g.box.maxLng,
  ).filter((s) => g.contains(s.lon, s.lat));
  const names = new Set(rows.map((s) => s.stop_nm));
  const nearest = rows
    .map((s) => ({ name: s.stop_nm, d: Math.round(distanceM(g.lat, g.lng, s.lat, s.lon)) }))
    .sort((a, b) => a.d - b.d)
    .filter((s, i, xs) => xs.findIndex((x) => x.name === s.name) === i)
    .slice(0, 5);
  return { count: rows.length, names: names.size, nearest: nearest.map((s) => `${s.name} (${s.d}m)`), points: rows.map((s) => [s.lon, s.lat, s.stop_nm] as [number, number, string]) };
}

async function transportAndFacilities(g: Geo) {
  const [stations, parking, ...fac] = await Promise.all([
    categorySearch('SW8', g.lng, g.lat, g.reach_m),
    categorySearch('PK6', g.lng, g.lat, g.reach_m),
    ...FACILITIES.map(([c]) => categorySearch(c, g.lng, g.lat, g.reach_m)),
  ]);
  // Kakao lists one place per 역 × 노선 ("선릉역 2호선", "선릉역 수인분당선")
  const seen = new Map<string, { name: string; lines: string[]; distance_m: number; lat: number; lng: number }>();
  for (const s of stations.items) {
    const [stn, ...line] = s.name.split(' ');
    const cur = seen.get(stn) ?? { name: stn, lines: [], distance_m: s.distance_m, lat: s.lat, lng: s.lng };
    if (line.length) cur.lines.push(line.join(' '));
    cur.distance_m = Math.min(cur.distance_m, s.distance_m);
    seen.set(stn, cur);
  }
  return {
    radius_m: g.reach_m,
    stations: [...seen.values()].map((s) => ({ ...s, ridership: subwayStats(s.name, s.lines) })),
    parking_lots: parking.total,
    /** 범위 안 정류장 (방향별로 따로 셈) · 이름 기준 개수 · 중심에서 가까운 순 */
    bus_stops: busStops(g),
    facilities: FACILITIES.map(([code, label], i) => ({ code, label, count: fac[i].total, nearest: fac[i].items.slice(0, 3).map((p) => `${p.name} (${p.distance_m}m)`) })),
  };
}

function seoulSales(g: Geo) {
  const tas = seoulTasIn(g);
  if (!tas.length) return null;
  const codes = tas.map((t) => t.trdar_cd);
  const ph = codes.map(() => '?').join(',');
  const rows = all<{ nm: string; amt: number; stores: number }>(
    `select s.svc_induty_cd_nm nm, sum(s.thsmon_selng_amt) amt,
            (select sum(similr_induty_stor_co) from ta_store_q t where t.stdr_yyqu_cd = s.stdr_yyqu_cd and t.svc_induty_cd = s.svc_induty_cd and t.trdar_cd in (${ph})) stores
     from ta_sales_q s where s.stdr_yyqu_cd = ? and s.trdar_cd in (${ph}) group by s.svc_induty_cd, s.svc_induty_cd_nm order by amt desc`,
    ...codes, LATEST_Q, ...codes,
  );
  if (!rows.length) return null;
  const t = one<Record<string, number>>(
    `select sum(thsmon_selng_amt) tot, sum(mdwk_selng_amt) wd, sum(wkend_selng_amt) we, ${BANDS.map(([, b]) => `sum(tmzon_${b}_selng_amt) t${b}`).join(', ')}
     from ta_sales_q where stdr_yyqu_cd = ? and trdar_cd in (${ph})`,
    LATEST_Q, ...codes,
  )!;
  return {
    quarter: LATEST_Q,
    monthly_total: t.tot,
    weekend_share: share(t.we, t.tot),
    by_time: Object.fromEntries(BANDS.map(([k, b]) => [k, share(t[`t${b}`], t.tot)])),
    top: rows.slice(0, 12).map((r) => ({ industry: r.nm, monthly: r.amt, stores: r.stores ?? null, per_store: r.stores ? Math.round(r.amt / r.stores) : null })),
    note: '서울시 상권분석서비스 추정매출(카드사 매출 등 기반 추정)의 당월 매출 금액 합. 상권 중심점이 범위 안에 있는 서울 상권만 합산',
  };
}

// ── 상권 생애주기 ─────────────────────────────────────────

type Stage = '성장' | '성숙' | '쇠퇴' | '재생' | '판단 보류';
function lifecycle(food: ReturnType<typeof foodTrend>, change: ReturnType<typeof storeChange>, rt: ReturnType<typeof rentTrend>) {
  const evidence: string[] = [];
  if (!food || food.active < 20) return { stage: '판단 보류' as Stage, reason: '범위 안 음식점이 20곳 미만이라 추세를 판단하기 어렵다.', evidence, metrics: null };
  const { recent3: r, prev3: p, active } = food;
  const netNow = (r.opened - r.closed) / active;
  const netPrev = (p.opened - p.closed) / active;
  const momentum = p.opened ? r.opened / p.opened : null;
  evidence.push(`음식점 최근 3년 개업 ${r.opened} · 폐업 ${r.closed} (순증 ${netNow >= 0 ? '+' : ''}${(netNow * 100).toFixed(1)}% of 영업 중 ${active})`);
  evidence.push(`그 전 3년 개업 ${p.opened} · 폐업 ${p.closed} (순증 ${netPrev >= 0 ? '+' : ''}${(netPrev * 100).toFixed(1)}%)`);
  if (momentum != null) evidence.push(`개업 속도: 그 전 3년 대비 ${(momentum * 100).toFixed(0)}%`);
  let rentUp: boolean | null = null;
  if (rt?.rent_1f_change != null) {
    rentUp = rt.rent_1f_change >= 0.02;
    evidence.push(`1층 임대료 1년 변화 ${rt.rent_1f_change >= 0 ? '+' : ''}${(rt.rent_1f_change * 100).toFixed(1)}% (${rt.prev_quarter} → ${rt.quarter})`);
  }
  if (rt?.vacancy_now != null && rt.vacancy_prev != null) evidence.push(`공실률 ${rt.vacancy_prev}% → ${rt.vacancy_now}%`);
  if (change) evidence.push(`분기 점포 증감 ${change.from} → ${change.to}: +${change.all.opened} / −${change.all.closed}`);

  let stage: Stage;
  let reason: string;
  if (netNow >= 0.05 && netPrev < 0) {
    stage = '재생';
    reason = '그 전 3년엔 점포가 줄었는데 최근 3년엔 다시 늘고 있다.';
  } else if (netNow >= 0.05 && (momentum ?? 1) >= 0.9) {
    stage = '성장';
    reason = `최근 3년 음식점이 순증(+${(netNow * 100).toFixed(0)}%)했고 개업 속도도 유지되고 있다${rentUp ? ', 임대료도 오르는 중이다' : ''}.`;
  } else if (netNow <= -0.05 || (netNow < 0 && (momentum ?? 1) < 0.8)) {
    stage = '쇠퇴';
    reason = `최근 3년 폐업이 개업보다 많고(순증 ${(netNow * 100).toFixed(0)}%)${momentum != null && momentum < 0.9 ? ' 개업 속도도 줄었다' : ''}${rentUp === false ? ', 임대료도 정체·하락이다' : ''}.`;
  } else {
    stage = '성숙';
    reason = '최근 3년 개업과 폐업이 비슷해 점포 수가 안정적이다. 들어오는 만큼 나가는 경쟁 상권이다.';
  }
  return { stage, reason, evidence, metrics: { net_recent3: Math.round(netNow * 1000) / 1000, net_prev3: Math.round(netPrev * 1000) / 1000, open_momentum: momentum != null ? Math.round(momentum * 100) / 100 : null, rent_1f_change: rt?.rent_1f_change ?? null } };
}

// ── 리포트 ───────────────────────────────────────────────

export interface AreaReport {
  area: { id: string; name: string; kind: Geo['kind']; basis: string; lat: number; lng: number; radius_m: number | null; area_m2: number; polygons: number[][][][] | null; sido_nm: string | null; sgg_nm: string | null };
  industry: ReturnType<typeof industryMix> & { sources: string[] };
  /** [lng, lat, 대분류, 상호, 소분류, 층] — 지도 표시용 (최대 5,000개, 넘으면 고르게 추림) */
  points: [number, number, string, string, string, string][];
  store_change: (NonNullable<ReturnType<typeof storeChange>> & { sources: string[] }) | null;
  food_trend: (NonNullable<ReturnType<typeof foodTrend>> & { sources: string[] }) | null;
  population: {
    seoul: (NonNullable<ReturnType<typeof seoulPopulation>> & { sources: string[] }) | null;
    dongs: ReturnType<typeof dongPopulation>;
    dong_sources: string[];
    /** 법정동 합계: 국민연금 직장인·소득, 주민등록 인구·1년 증감 */
    demand: (NonNullable<ReturnType<typeof areaDemand>> & { sources: string[] }) | null;
  };
  /** 앞으로 생길 공급·수요 (건축HUB 인허가, 심사 결과와 같은 계산) */
  supply_pipeline: (NonNullable<ReturnType<typeof supplyPipeline>> & { sources: string[] }) | null;
  transport: Awaited<ReturnType<typeof transportAndFacilities>> & { sources: string[] };
  rent: (NonNullable<ReturnType<typeof lookupRent>> & { sources: string[] }) | null;
  sales: (NonNullable<ReturnType<typeof seoulSales>> & { sources: string[] }) | null;
  /** 상권 생애주기: 성장·성숙·쇠퇴·재생 (음식점 개폐업 3년 구간 비교 + 임대료·공실 1년 변화) */
  lifecycle: ReturnType<typeof lifecycle> & { sources: string[] };
  gaps: string[];
  warnings: string[];
  provenance: Source[];
  generated_at: string;
  elapsed_ms: number;
}

const cache = new Map<string, { at: number; r: AreaReport }>();
const TTL_MS = 30 * 60 * 1000;

export async function areaReport(id: string): Promise<AreaReport> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.r;
  const t0 = Date.now();
  const g = resolveGeo(id);
  const src = new SourceTracker();
  src.use('kakao_local', '상권 검색·위치');
  if (g.kind === 'sbiz_zone') src.use('sbiz_zone', '상권 경계');
  if (g.kind === 'seoul_trdar') src.use('seoul_trdar', '상권 중심·면적');
  if (g.kind === 'rone_area') src.use('rone_rent', '상권 이름·대표 지점');

  const stores = all<StoreRow>(
    `select bizes_nm, brch_nm, inds_lcls_cd, inds_lcls_nm, inds_mcls_nm, inds_scls_nm, flr_no, lon, lat, adong_cd, adong_nm, ldong_cd, ctprvn_cd
     from store where lat between ? and ? and lon between ? and ?`,
    g.box.minLat, g.box.maxLat, g.box.minLng, g.box.maxLng,
  ).filter((s) => g.contains(s.lon, s.lat));
  if (!stores.length) throw new ApiProblem(422, '점포 없음', `${g.name} 범위 안에 상가정보 점포가 없습니다. 다른 후보를 고르십시오.`);

  const step = Math.max(1, Math.ceil(stores.length / MAX_POINTS));
  const points = stores.filter((_, i) => i % step === 0).map((s) => [s.lon, s.lat, s.inds_lcls_nm, s.bizes_nm + (s.brch_nm ? ` ${s.brch_nm}` : ''), s.inds_scls_nm, s.flr_no ?? ''] as AreaReport['points'][number]);

  const [loc, tf] = await Promise.all([resolveLocation({ lat: g.lat, lng: g.lng }), transportAndFacilities(g)]);
  const seoulPop = seoulPopulation(g);
  const dongs = dongPopulation(stores);
  const demand = areaDemand(stores);
  const supply = supplyPipeline(loc, Math.min(1000, Math.round(g.reach_m)));
  const rent = lookupRent(loc);
  const sales = seoulSales(g);
  const change = storeChange(g);
  const food = foodTrend(g);

  const dongSources = [
    src.use('sgis_population', '행정동 인구·가구'),
    src.use('sgis_household', '행정동 가구'),
    src.use('sgis_company', '행정동 종사자·사업체'),
    ...(dongs.some((d) => d.living_pop_hourly != null) ? [src.use('seoul_livingpop', '행정동 생활인구')] : []),
    ...(dongs.some((d) => d.flowpop_hourly?.kind === 'measured') ? [src.use('gg_flowpop', '행정동 유동인구(실측)')] : []),
    ...(dongs.some((d) => d.flowpop_hourly?.kind === 'estimated') ? [src.use('model_flowpop', '행정동 유동인구(추정)'), src.use('gg_flowpop', '유동인구 추정 모델 학습')] : []),
  ];

  const gaps: string[] = [];
  if (!sales) gaps.push('매출: 없음 — 공개 매출은 서울 상권분석서비스뿐. 필요한 것: 점포 단위 카드매출. 확보 방법: DW 카드매출 백업분(사용 범위 확인 중) 또는 카드사 데이터 구매');
  if (!seoulPop?.floating && !dongs.some((d) => d.flowpop_hourly))
    gaps.push('유동인구: 없음 — 서울 상권 밖이고 추정 대상 행정동도 아님. 확보 방법: 통신사 유동인구 구매 (KT·SKT)');
  if (!change) gaps.push('점포 증감: 없음 — 이전 분기 상가정보 스냅샷이 서울만 있음. 다음 분기 파일을 받으면 전국 비교 가능');
  if (tf.stations.length && !tf.stations.some((s) => s.ridership))
    gaps.push('지하철 승하차: 없음 — 적재한 곳은 서울·부산·대구·인천·광주·대전 도시철도. 광역철도(코레일)는 한국철도공사 역별 승하차 파일로 확보 가능');

  const warnings: string[] = [];
  if (g.kind === 'custom_circle' || g.kind === 'custom_polygon') warnings.push('지도에서 직접 그린 범위입니다. 서울 상권 인구·매출은 중심점이 범위 안에 있는 서울 상권만 합산합니다.');
  if (g.kind === 'place' || g.kind === 'rone_area') warnings.push(`${g.name}은(는) 상권 경계 데이터가 없어 ${g.kind === 'rone_area' ? '대표 지점' : '검색 지점'} 중심 반경 ${PLACE_RADIUS_M}m로 집계했습니다. 실제 상권 범위와 다를 수 있습니다.`);
  if (g.kind === 'seoul_trdar') warnings.push('서울 상권분석 상권은 경계 대신 중심점과 면적만 공개돼, 면적을 원으로 바꾼 반경으로 집계했습니다.');
  if (dongs.some((d) => d.flowpop_hourly)) warnings.push('내부 심사 한정 데이터 포함: 경기 유동인구(공공누리 2유형) 및 이를 학습한 추정값. 외부 제공 전 외부 자문이 필요합니다.');
  warnings.push('지하철역·주차장·주요 시설 개수는 카카오 장소 검색 기준이라 범위가 다각형이어도 중심에서 원 반경으로 셉니다 (버스정류장은 범위 안에서 직접 셈).');

  const r: AreaReport = {
    area: {
      id: g.id, name: g.name, kind: g.kind, basis: g.basis, lat: g.lat, lng: g.lng, radius_m: g.radius_m, area_m2: g.area_m2, polygons: g.polygons,
      sido_nm: loc.sido_nm, sgg_nm: loc.sgg_nm,
    },
    industry: { ...industryMix(stores), sources: [src.use('sbiz_store', '업종 분포·배치')] },
    points,
    store_change: change ? { ...change, sources: [src.use('sbiz_store', '점포 증감(분기 비교)')] } : null,
    food_trend: food ? { ...food, sources: [src.use('license_food', '음식점 개업·폐업 추이')] } : null,
    population: {
      seoul: seoulPop ? { ...seoulPop, sources: [src.use('seoul_flpop', '상권 유동인구'), src.use('seoul_repop', '상권 상주인구'), src.use('seoul_wrcpop', '상권 직장인구')] } : null,
      dongs,
      dong_sources: dongSources,
      demand: demand
        ? {
            ...demand,
            sources: [
              ...(demand.workers ? [src.use('nps_workplace', '범위 직장인·소득 추정')] : []),
              ...(demand.residents ? [src.use('resident_registry', '범위 주민등록 인구·1년 증감')] : []),
            ],
          }
        : null,
    },
    supply_pipeline: supply ? { ...supply, sources: [src.use('arch_permit', '곧 생길 상가·사무 공간'), src.use('housing_permit', '입주 예정 세대')] } : null,
    transport: {
      ...tf,
      sources: [
        src.use('kakao_category', '지하철역·주차장·주요 시설'),
        ...(tf.stations.some((s) => s.ridership?.source === 'seoul') ? [src.use('seoul_subway', '지하철 승하차')] : []),
        ...(tf.stations.some((s) => s.ridership?.source === 'regional') ? [src.use('regional_subway', '지하철 승하차 (서울 밖)')] : []),
        src.use('bus_stop', '버스정류장'),
      ],
    },
    rent: rent ? { ...rent, sources: [src.use('rone_rent', '임대료·공실률')] } : null,
    sales: sales ? { ...sales, sources: [src.use('seoul_sales', '상권 매출'), src.use('seoul_store', '점포당 매출 계산')] } : null,
    lifecycle: (() => {
      const lc = lifecycle(food, change, rent ? rentTrend(rent.area) : null);
      return { ...lc, sources: lc.metrics ? [src.use('license_food', '상권 생애주기 (개폐업 추세)'), ...(rent ? [src.use('rone_rent', '상권 생애주기 (임대료·공실 변화)')] : [])] : [] };
    })(),
    gaps,
    warnings,
    provenance: [],
    generated_at: new Date().toISOString(),
    elapsed_ms: 0,
  };
  r.provenance = src.list();
  r.elapsed_ms = Date.now() - t0;
  cache.set(id, { at: Date.now(), r });
  return r;
}
