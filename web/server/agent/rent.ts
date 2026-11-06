// 임대료·공실률 (한국부동산원 R-ONE 임대동향). R-ONE reports by named 상권; rone_area (etl/rone-area.ts)
// gives each name a representative point, so a site takes the nearest 상권 within NEAR_M, else its 시도 average.
// R-ONE은 건물 유형 3가지(중대형·소규모·집합)마다 층별 임대료를 낸다. 적용 단가는 건축물대장으로 유형을, 입력 층으로 층을 고른다.
import type { Buildings } from './building.ts';
import { all, one } from './db.ts';
import { distanceM } from './geo.ts';
import type { Location } from './location.ts';

const NEAR_M = 1000;

/** R-ONE 건물 유형. 중대형 = 일반건물 3층 이상 또는 연면적 330㎡ 초과, 소규모 = 일반건물 2층 이하·330㎡ 이하, 집합 = 구분소유 상가 */
export type RentType = '중대형 상가' | '소규모 상가' | '집합 상가';
const TYPES: RentType[] = ['중대형 상가', '소규모 상가', '집합 상가'];

export interface RentApplied {
  building_type: RentType;
  /** 유형을 고른 근거 (건축물대장 또는 기본값) */
  type_reason: string;
  /** R-ONE 층 구분 (지하1층 · 1층 … 5층 · 6층이상) */
  floor: string;
  floor_input: number | null;
  won_per_m2: number;
  area_m2: number | null;
  /** 면적 × 단가 (면적을 입력했을 때) */
  monthly_rent: number | null;
  /** 고른 유형·층에 값이 없어 다른 값을 쓴 경우 그 설명 */
  fallback: string | null;
}

export interface Rent {
  area: string;
  match: '상권' | '시도 평균';
  distance_m: number | null;
  quarter: string;
  building_type: string;
  rent_by_floor: { floor: string; won_per_m2: number }[];
  small_shop_1f_won_per_m2: number | null;
  vacancy_rate: { mid_large: number | null; small: number | null; quarter: string | null };
  est_monthly_rent_1f: number | null;
  /** 건물 유형별 층별 ㎡당 월 임대료와 공실률 (R-ONE이 그 상권에서 조사한 것만) */
  by_type: { type: RentType; quarter: string; floors: { floor: string; won_per_m2: number }[]; vacancy_rate: number | null }[];
  /** 이 점포에 적용한 단가 (건물 유형 × 층) */
  applied: RentApplied | null;
  note: string;
}

/** 입력 층(지하는 음수) → R-ONE 층 구분 */
export function roneFloor(n: number): string {
  if (n < 0) return '지하1층';
  if (n >= 6) return '6층이상';
  return `${Math.max(1, Math.round(n))}층`;
}

/** 건축물대장 주건축물로 R-ONE 건물 유형을 고른다 */
export function rentTypeOf(b: Buildings | null | undefined): { type: RentType; reason: string } {
  const m = b?.buildings[0];
  if (!m) return { type: '중대형 상가', reason: '건축물대장을 찾지 못해 중대형 상가(조사 범위가 가장 넓음)로 계산' };
  const desc = `지상 ${m.floors_above ?? '?'}층 · 연면적 ${m.total_area_m2 != null ? Math.round(m.total_area_m2).toLocaleString() : '?'}㎡`;
  // 대장 종류: 일반건물은 "일반건축물", 집합건물(구분소유)은 "표제부"(동별)·"총괄표제부"
  if (/표제부|집합/.test(m.kind)) return { type: '집합 상가', reason: `건축물대장 집합건물(구분소유) · ${desc}` };
  if (m.floors_above != null && m.total_area_m2 != null && m.floors_above <= 2 && m.total_area_m2 <= 330)
    return { type: '소규모 상가', reason: `건축물대장 일반건물 · ${desc} (2층 이하·330㎡ 이하)` };
  return { type: '중대형 상가', reason: `건축물대장 일반건물 · ${desc} (3층 이상 또는 330㎡ 초과)` };
}

interface Area {
  fullnm: string;
  lat: number;
  lon: number;
}
let areas: Area[] | undefined;

const quarter = (w: string) => `${w.slice(0, 4)}년 ${Number(w.slice(4))}분기`;

/** Latest 층별 임대료 rows for one R-ONE area and building type (some table ids carry bad years like 262602). */
function latestRent(fullnm: string, type: RentType) {
  const rows = all<{ floor: string; v: number; w: string }>(
    `SELECT cls_nm floor, dta_val v, wrttime_idtfr_id w FROM rone_stat
     WHERE grp_fullnm = ? AND itm_nm = '임대료' AND statbl_nm LIKE ? AND wrttime_idtfr_id LIKE '20%'`,
    fullnm,
    `임대동향 층별임대료%_${type}`,
  );
  if (!rows.length) return null;
  const w = rows.reduce((m, r) => (r.w > m ? r.w : m), '');
  return { w, rows: rows.filter((r) => r.w === w) };
}

function latestVacancy(fullnm: string, type: RentType) {
  return one<{ v: number; w: string }>(
    `SELECT dta_val v, wrttime_idtfr_id w FROM rone_stat
     WHERE cls_fullnm = ? AND itm_nm = '공실률' AND statbl_nm LIKE ? AND wrttime_idtfr_id LIKE '20%'
     ORDER BY wrttime_idtfr_id DESC LIMIT 1`,
    fullnm,
    `임대동향 지역별 공실률%_${type}`,
  );
}

/** 1층 임대료·공실률의 1년 변화 (같은 분기끼리 비교). `area` is Rent.area ("서울 › 강남 › 강남대로"). */
export function rentTrend(area: string): { quarter: string; prev_quarter: string; rent_1f_change: number | null; vacancy_now: number | null; vacancy_prev: number | null } | null {
  const fullnm = area.replace(/ › /g, '>');
  const series = all<{ v: number; w: string }>(
    `SELECT dta_val v, wrttime_idtfr_id w FROM rone_stat
     WHERE grp_fullnm = ? AND itm_nm = '임대료' AND cls_nm = '1층' AND statbl_nm LIKE '임대동향 층별임대료%_중대형 상가' AND wrttime_idtfr_id LIKE '20%'
     ORDER BY wrttime_idtfr_id DESC`,
    fullnm,
  ).filter((r) => r.v > 0);
  if (!series.length) return null;
  const now = series[0];
  const prevW = `${Number(now.w.slice(0, 4)) - 1}${now.w.slice(4)}`;
  const prev = series.find((r) => r.w === prevW);
  const vac = all<{ v: number; w: string }>(
    `SELECT dta_val v, wrttime_idtfr_id w FROM rone_stat
     WHERE cls_fullnm = ? AND itm_nm = '공실률' AND statbl_nm LIKE '임대동향 지역별 공실률%_중대형 상가' AND wrttime_idtfr_id LIKE '20%'
     ORDER BY wrttime_idtfr_id DESC`,
    fullnm,
  );
  const vNow = vac[0];
  const vPrev = vNow ? vac.find((r) => r.w === `${Number(vNow.w.slice(0, 4)) - 1}${vNow.w.slice(4)}`) : undefined;
  return {
    quarter: quarter(now.w),
    prev_quarter: quarter(prevW),
    rent_1f_change: prev ? Math.round((now.v / prev.v - 1) * 1000) / 1000 : null,
    vacancy_now: vNow ? Math.round(vNow.v * 10) / 10 : null,
    vacancy_prev: vPrev ? Math.round(vPrev.v * 10) / 10 : null,
  };
}

/** "부산광역시" → "부산", "충청북도" → "충북", "전남광주통합특별시" → "전남광주" … as R-ONE names its regions. */
function roneRegion(sido: string | null): string | null {
  if (!sido) return null;
  const fixed: Record<string, string> = { 충청북도: '충북', 충청남도: '충남', 경상북도: '경북', 경상남도: '경남', 전라북도: '전북', 전라남도: '전남' };
  const cand = [fixed[sido], sido.replace(/(특별자치시|특별자치도|통합특별시|특별시|광역시|도)$/, ''), sido.slice(0, 2)].filter(Boolean) as string[];
  for (const c of cand) {
    if (one('SELECT 1 FROM rone_stat WHERE grp_fullnm = ? AND itm_nm = ? LIMIT 1', c, '임대료')) return c;
  }
  return null;
}

const FLOOR_ORDER = ['지하1층', '1층', '2층', '3층', '4층', '5층', '6층이상'];

/** 상권 이름 비교용: 마지막 단계에서 기호·공백 제거 ("홍대/합정" = "홍대합정") */
const normName = (fullnm: string) => (fullnm.split('>').pop() ?? '').replace(/[^0-9A-Za-z가-힣]/g, '');

let stale: string | undefined;
/** 이 분기보다 오래된 자료는 조사가 끝난 상권으로 본다: 최신 분기에서 2년 전 */
function staleBefore(): string {
  if (stale) return stale;
  const w = one<{ w: string }>("SELECT max(wrttime_idtfr_id) w FROM rone_stat WHERE itm_nm = '임대료' AND statbl_nm LIKE '임대동향 층별임대료%' AND wrttime_idtfr_id LIKE '20%'")?.w ?? '000000';
  stale = `${Number(w.slice(0, 4)) - 2}${w.slice(4)}`;
  return stale;
}

function floorsOf(rows: { floor: string; v: number }[]) {
  return FLOOR_ORDER.flatMap((f) => {
    const r = rows.find((x) => x.floor === f);
    // 0 means the floor was not surveyed in that 상권
    return r && r.v > 0 ? [{ floor: f, won_per_m2: Math.round(r.v * 1000) }] : [];
  });
}

export function lookupRent(loc: Location, opts: { floorArea?: number; floor?: number; buildings?: Buildings | null } = {}): Rent | null {
  const floorArea = opts.floorArea;
  areas ??= all<Area>('SELECT fullnm, lat, lon FROM rone_area WHERE lat IS NOT NULL');
  const { type: wantType, reason } = rentTypeOf(opts.buildings);
  // 반경 안 조사 상권 중: 이 건물 유형을 조사한 곳 → 최근 자료 → 가까운 곳 (여의도처럼 집합 상가만 조사하는 상권도 있다)
  const near = areas
    .map((a) => ({ a, d: distanceM(loc.lat, loc.lng, a.lat, a.lon) }))
    .filter((x) => x.d <= NEAR_M)
    .map((x) => {
      const got = TYPES.map((t) => latestRent(x.a.fullnm, t));
      const w = got.reduce((m, g) => (g && g.w > m ? g.w : m), '');
      return { ...x, has: Boolean(got[TYPES.indexOf(wantType)]), w };
    })
    .filter((x) => x.w)
    .sort((p, q) => Number(q.has) - Number(p.has) || q.w.localeCompare(p.w) || p.d - q.d);

  let fullnm: string;
  let match: Rent['match'];
  let distance: number | null = null;
  let renamed = '';
  if (near[0]) {
    let pick = near[0];
    // R-ONE이 상권 이름을 바꾸면(홍대합정 → 홍대/합정) 옛 이름은 조사가 끊긴 채 남는다: 같은 이름의 최신 상권으로 넘어간다
    if (pick.w < staleBefore()) {
      const key = normName(pick.a.fullnm);
      const succ = areas
        .filter((a) => a.fullnm !== pick.a.fullnm && normName(a.fullnm) === key)
        .map((a) => ({ a, d: distanceM(loc.lat, loc.lng, a.lat, a.lon), w: TYPES.reduce((m, t) => Math.max(m, Number(latestRent(a.fullnm, t)?.w ?? 0)), 0).toString(), has: Boolean(latestRent(a.fullnm, wantType)) }))
        .filter((x) => x.w > pick.w)
        .sort((p, q) => Number(q.has) - Number(p.has) || q.w.localeCompare(p.w) || p.d - q.d)[0];
      if (succ) {
        renamed = ` 가까운 "${pick.a.fullnm}"은 ${quarter(pick.w)}로 조사가 끝나 같은 상권의 현재 이름 "${succ.a.fullnm}" 자료를 사용.`;
        pick = succ;
      }
    }
    fullnm = pick.a.fullnm;
    match = '상권';
    distance = Math.round(pick.d);
  } else {
    const region = roneRegion(loc.sido_nm);
    if (!region) return null;
    fullnm = region;
    match = '시도 평균';
  }
  const rent = latestRent(fullnm, '중대형 상가');

  const byFloor = rent ? floorsOf(rent.rows) : [];
  const small = latestRent(fullnm, '소규모 상가');
  const small1f = small?.rows.find((r) => r.floor === '1층');
  const vm = latestVacancy(fullnm, '중대형 상가');
  const vs = latestVacancy(fullnm, '소규모 상가');
  const f1 = byFloor.find((x) => x.floor === '1층');

  const byType = TYPES.flatMap((type) => {
    const t = type === '중대형 상가' ? rent : type === '소규모 상가' ? small : latestRent(fullnm, type);
    const floors = t ? floorsOf(t.rows) : [];
    if (!t || !floors.length) return [];
    const v = type === '중대형 상가' ? vm : type === '소규모 상가' ? vs : latestVacancy(fullnm, type);
    return [{ type, quarter: quarter(t.w), floors, vacancy_rate: v ? Math.round(v.v * 10) / 10 : null }];
  });
  if (!byType.length) return null;

  // 적용 단가: 건축물대장 유형 → 입력 층. 그 유형·층 값이 없으면 같은 층의 다른 유형, 그래도 없으면 1층
  const wantFloor = opts.floor != null ? roneFloor(opts.floor) : '1층';
  let applied: RentApplied | null = null;
  const order = [wantType, ...TYPES.filter((t) => t !== wantType)];
  for (const floor of [wantFloor, '1층']) {
    for (const type of order) {
      const hit = byType.find((x) => x.type === type)?.floors.find((x) => x.floor === floor);
      if (!hit) continue;
      const missing = [type !== wantType ? `${fullnm.replace(/>/g, ' › ')}에 ${wantType} 조사가 없어 ${type}` : '', floor !== wantFloor ? `${wantFloor} 값이 없어 ${floor}` : '']
        .filter(Boolean)
        .join(', ');
      applied = {
        building_type: type,
        type_reason: reason,
        floor,
        floor_input: opts.floor ?? null,
        won_per_m2: hit.won_per_m2,
        area_m2: floorArea ?? null,
        monthly_rent: floorArea ? Math.round((hit.won_per_m2 * floorArea) / 1e4) * 1e4 : null,
        fallback: missing ? `${missing} 값을 사용` : null,
      };
      break;
    }
    if (applied) break;
  }
  const floorNote = opts.floor == null ? ' 층을 입력하지 않아 1층으로 계산.' : '';
  return {
    area: fullnm.replace(/>/g, ' › '),
    match,
    distance_m: distance,
    quarter: (byType.find((t) => t.type === applied?.building_type) ?? byType[0]).quarter,
    building_type: applied?.building_type ?? byType[0].type,
    rent_by_floor: byFloor,
    small_shop_1f_won_per_m2: small1f ? Math.round(small1f.v * 1000) : null,
    vacancy_rate: {
      mid_large: vm ? Math.round(vm.v * 10) / 10 : null,
      small: vs ? Math.round(vs.v * 10) / 10 : null,
      quarter: vm ? quarter(vm.w) : vs ? quarter(vs.w) : null,
    },
    est_monthly_rent_1f: f1 && floorArea ? Math.round((f1.won_per_m2 * floorArea) / 1e4) * 1e4 : null,
    by_type: byType,
    applied,
    note:
      (match === '상권'
        ? `R-ONE 조사 상권 "${fullnm}"의 대표 지점이 ${distance}m 거리. 상권·건물 유형·층별 평균이며 개별 점포의 실제 임대료와 다를 수 있음.`
        : `반경 ${NEAR_M}m 안에 R-ONE 조사 상권이 없어 ${fullnm} 평균을 사용.`) +
      renamed +
      floorNote,
  };
}
