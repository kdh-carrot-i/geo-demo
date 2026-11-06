// 출자 매장 모니터링: 매장을 등록할 때 주변 상황을 기준선으로 저장하고, 볼 때마다 지금과 비교해 변화 신호를 낸다.
// 상가정보(store)는 분기마다 새 파일을 적재할 때, 인허가(license_event)는 다시 수집할 때 바뀐다.
import { brandMatcher } from './brand.ts';
import { all, one, state } from './db.ts';
import { bbox, distanceM } from './geo.ts';
import { resolveLocation, type Location } from './location.ts';
import { ApiProblem } from './problem.ts';
import { lookupRent } from './rent.ts';
import { newId } from './pipeline.ts';

state.exec(`
  create table if not exists watch_store (
    id text primary key,
    created_at text not null,
    name text not null,
    lat real not null,
    lng real not null,
    industry_code text,
    industry_name text,
    brand text,
    radius_m integer not null,
    memo text,
    location_json text not null,
    baseline_json text not null
  );
`);

const LICENSE_SVC = (code: string | null) => (code === 'G20405' ? 'tobacco_retailers' : code?.startsWith('I212') ? 'rest_cafes' : code?.startsWith('I2') ? '07_24_04_P' : null);
const SVC_LABEL: Record<string, string> = { '07_24_04_P': '일반음식점', rest_cafes: '휴게음식점', tobacco_retailers: '담배소매업' };

interface Snapshot {
  at: string;
  store_period: string;
  all_stores: number;
  same_industry: { id: string; name: string; d: number }[];
  same_brand: { id: string; name: string; d: number }[];
  license: { svc: string; active: number; opened_12m: number; closed_12m: number; closed_prev_12m: number; as_of: string } | null;
  rent_1f: { won_per_m2: number; quarter: string; area: string } | null;
  vacancy: { rate: number | null; quarter: string | null } | null;
}

function snapshot(w: { lat: number; lng: number; radius_m: number; industry_code: string | null; brand: string | null }, loc: Location): Snapshot {
  const b = bbox(w.lat, w.lng, w.radius_m);
  const stores = all<{ bizes_id: string; bizes_nm: string; brch_nm: string | null; inds_scls_cd: string; lat: number; lon: number }>(
    'select bizes_id, bizes_nm, brch_nm, inds_scls_cd, lat, lon from store where lat between ? and ? and lon between ? and ?',
    b.minLat, b.maxLat, b.minLng, b.maxLng,
  )
    .map((s) => ({ ...s, d: Math.round(distanceM(w.lat, w.lng, s.lat, s.lon)) }))
    .filter((s) => s.d <= w.radius_m);
  const name = (s: { bizes_nm: string; brch_nm: string | null }) => [s.bizes_nm, s.brch_nm].filter(Boolean).join(' ');
  const isBrand = w.brand ? brandMatcher(w.brand) : null;
  const svc = LICENSE_SVC(w.industry_code);
  let license: Snapshot['license'] = null;
  if (svc) {
    const rows = all<{ apv_perm_ymd: string | null; dcb_ymd: string | null; trd_state_nm: string; lat: number; lon: number }>(
      'select apv_perm_ymd, dcb_ymd, trd_state_nm, lat, lon from license_event where opn_svc_id = ? and lat between ? and ? and lon between ? and ?',
      svc, b.minLat, b.maxLat, b.minLng, b.maxLng,
    ).filter((r) => distanceM(w.lat, w.lng, r.lat, r.lon) <= w.radius_m);
    const ago = (y: number) => new Date(Date.now() - y * 365.25 * 864e5).toISOString().slice(0, 10);
    const closedIn = (from: string, to: string) => rows.filter((r) => r.trd_state_nm === '폐업' && (r.dcb_ymd ?? '') >= from && (r.dcb_ymd ?? '') < to).length;
    license = {
      svc,
      active: rows.filter((r) => r.trd_state_nm !== '폐업').length,
      opened_12m: rows.filter((r) => (r.apv_perm_ymd ?? '') >= ago(1)).length,
      closed_12m: closedIn(ago(1), '9999'),
      closed_prev_12m: closedIn(ago(2), ago(1)),
      as_of: one<{ d: string }>('select max(apv_perm_ymd) d from license_event where opn_svc_id = ?', svc)?.d ?? '',
    };
  }
  const rent = lookupRent(loc);
  const f1 = rent?.rent_by_floor.find((x) => x.floor === '1층');
  return {
    at: new Date().toISOString(),
    store_period: one<{ p: string }>("select std_period p from meta_source where table_name = 'store'")?.p ?? '',
    all_stores: stores.length,
    same_industry: w.industry_code ? stores.filter((s) => s.inds_scls_cd === w.industry_code).map((s) => ({ id: s.bizes_id, name: name(s), d: s.d })) : [],
    same_brand: isBrand ? stores.filter((s) => s.bizes_nm && isBrand(s.bizes_nm, s.brch_nm)).map((s) => ({ id: s.bizes_id, name: name(s), d: s.d })) : [],
    license,
    rent_1f: f1 && rent ? { won_per_m2: f1.won_per_m2, quarter: rent.quarter, area: rent.area } : null,
    vacancy: rent ? { rate: rent.vacancy_rate.mid_large, quarter: rent.vacancy_rate.quarter } : null,
  };
}

export interface Signal {
  /** change = 등록(기준선) 이후 달라진 것, state = 지금 주변 상태·동향 (등록 때부터 있던 것 포함) */
  group: 'change' | 'state';
  level: 'warn' | 'watch' | 'info';
  text: string;
}

/** 동향 기준은 상권 규모에 맞춰 비율로 본다 (영업 중 대비). 큰 상권이 고정 건수 기준에 더 쉽게 걸리지 않게. */
const NET_DECLINE_WATCH = 0.03;
const NET_DECLINE_WARN = 0.08;
const CLOSURE_SURGE = 1.5;
const MIN_CLOSURES = 3;
/** 같은 업종 밀집: 반경 안 업종 비중이 같은 시도 비중의 2배 이상 */
const DENSE_LQ = 2;

function sidoShare(loc: Location, code: string | null): number | null {
  if (!code || !loc.sido_nm) return null;
  const cd = one<{ c: string }>('select ctprvn_cd c from store where ctprvn_nm = ? limit 1', loc.sido_nm)?.c;
  return cd ? one<{ s: number }>('select share s from sido_scls_share where ctprvn_cd = ? and scls_cd = ?', cd, code)?.s ?? null : null;
}

function compare(base: Snapshot, now: Snapshot, w: { radius_m: number; industry_code: string | null; industry_name: string | null; brand: string | null }, loc: Location) {
  const signals: Signal[] = [];
  const add = (group: Signal['group'], level: Signal['level'], text: string) => signals.push({ group, level, text });

  // ── 등록 이후 변화 ──
  const baseIds = new Set(base.same_industry.map((s) => s.id));
  const nowIds = new Set(now.same_industry.map((s) => s.id));
  const newComp = now.same_industry.filter((s) => !baseIds.has(s.id)).sort((a, b) => a.d - b.d);
  const goneComp = base.same_industry.filter((s) => !nowIds.has(s.id));
  const bBrand = new Set(base.same_brand.map((s) => s.id));
  const newBrand = now.same_brand.filter((s) => !bBrand.has(s.id) && s.d > 15).sort((a, b) => a.d - b.d);
  if (newBrand.length) add('change', 'warn', `같은 브랜드 매장 ${newBrand.length}곳이 반경 ${w.radius_m}m 안에 새로 생겼습니다 (가장 가까운 곳 ${newBrand[0].name} ${newBrand[0].d}m). 영업지역 침해 여부를 확인하십시오.`);
  if (newComp.length) add('change', newComp.some((s) => s.d <= 100) ? 'warn' : 'watch', `같은 업종(${w.industry_name}) 점포 ${newComp.length}곳 신규 진입 (가장 가까운 곳 ${newComp[0].name} ${newComp[0].d}m)`);
  if (goneComp.length) add('change', 'info', `같은 업종 점포 ${goneComp.length}곳이 목록에서 사라졌습니다 (폐업 또는 이전)`);
  if (base.rent_1f && now.rent_1f && base.rent_1f.quarter !== now.rent_1f.quarter) {
    const ch = now.rent_1f.won_per_m2 / base.rent_1f.won_per_m2 - 1;
    if (Math.abs(ch) >= 0.05) add('change', ch > 0 ? 'watch' : 'info', `1층 임대료가 등록 때보다 ${(ch * 100).toFixed(1)}% ${ch > 0 ? '올랐습니다' : '내렸습니다'} (${base.rent_1f.quarter} → ${now.rent_1f.quarter})`);
  }
  if (base.vacancy?.rate != null && now.vacancy?.rate != null && now.vacancy.rate - base.vacancy.rate >= 2) add('change', 'watch', `공실률이 등록 때 ${base.vacancy.rate}% → ${now.vacancy.rate}%로 올랐습니다`);
  if (!signals.some((x) => x.group === 'change')) add('change', 'info', '등록 이후 눈에 띄는 변화가 없습니다.');

  // ── 지금 주변 상태·동향 ──
  const nearBrand = now.same_brand.filter((s) => s.d > 15).sort((a, b) => a.d - b.d);
  if (nearBrand.length)
    add('state', nearBrand[0].d <= 200 ? 'warn' : 'watch', `같은 브랜드(${w.brand}) 매장 ${nearBrand.length}곳이 반경 ${w.radius_m}m 안에 있습니다 (가장 가까운 곳 ${nearBrand[0].name} ${nearBrand[0].d}m). 영업지역 보호 범위를 확인하십시오.`);
  const share = sidoShare(loc, w.industry_code);
  if (share && now.all_stores >= 30 && now.same_industry.length >= 5) {
    const lq = now.same_industry.length / now.all_stores / share;
    if (lq >= DENSE_LQ) add('state', 'watch', `같은 업종(${w.industry_name})이 반경 안에 ${now.same_industry.length}곳으로, 같은 시도 평균의 ${lq.toFixed(1)}배 밀집해 있습니다.`);
  }
  if (now.license && now.license.active >= 10) {
    const l = now.license;
    const label = SVC_LABEL[l.svc];
    const net = (l.opened_12m - l.closed_12m) / l.active;
    if (l.closed_prev_12m >= MIN_CLOSURES && l.closed_12m >= CLOSURE_SURGE * l.closed_prev_12m && l.closed_12m / l.active >= 0.05)
      add('state', 'warn', `반경 안 ${label} 폐업이 최근 1년 ${l.closed_12m}곳으로 그 전 1년(${l.closed_prev_12m}곳)의 ${(l.closed_12m / l.closed_prev_12m).toFixed(1)}배입니다 (상권 쇠퇴 신호).`);
    if (-net >= NET_DECLINE_WATCH && l.closed_12m >= MIN_CLOSURES)
      add('state', -net >= NET_DECLINE_WARN ? 'warn' : 'watch', `최근 1년 ${label} 개업 ${l.opened_12m}곳 < 폐업 ${l.closed_12m}곳 — 영업 중 ${l.active}곳 대비 ${(net * 100).toFixed(1)}% 순감소`);
    else add('state', 'info', `최근 1년 ${label} 개업 ${l.opened_12m}곳 · 폐업 ${l.closed_12m}곳 (영업 중 ${l.active}곳 대비 ${net >= 0 ? '+' : ''}${(net * 100).toFixed(1)}%)`);
  }

  const sameData = base.store_period === now.store_period;
  return {
    signals,
    new_competitors: newComp.slice(0, 20),
    gone_competitors: goneComp.slice(0, 20),
    new_same_brand: newBrand,
    store_compare: sameData ? `상가정보가 등록 때와 같은 기준(${now.store_period})이라 점포 변화는 다음 분기 파일 적재 후 나타납니다.` : `상가정보 ${base.store_period} → ${now.store_period} 비교`,
    rules: `동향: 최근 1년 (개업 − 폐업) ÷ 영업 중이 −${NET_DECLINE_WATCH * 100}% 이하면 관찰, −${NET_DECLINE_WARN * 100}% 이하면 주의. 폐업이 그 전 1년의 ${CLOSURE_SURGE}배 이상이고 영업 중의 5% 이상이면 주의. 같은 브랜드가 200m 안이면 주의, 반경 안이면 관찰. 같은 업종 비중이 시도 평균의 ${DENSE_LQ}배 이상이면 관찰.`,
  };
}

export async function addWatch(input: { name: string; lat: number; lng: number; industry_code?: string | null; industry_name?: string | null; brand?: string | null; radius_m?: number; memo?: string }) {
  if (!input.name?.trim()) throw new ApiProblem(400, '요청 형식 오류', 'name(매장 이름)이 필요합니다.');
  if (!(input.lat >= 33 && input.lat <= 39 && input.lng >= 124 && input.lng <= 132)) throw new ApiProblem(400, '위치 범위 오류', '국내 좌표가 필요합니다.');
  const radius = Math.min(1000, Math.max(100, Math.round(input.radius_m ?? 500)));
  const loc = await resolveLocation({ lat: input.lat, lng: input.lng });
  const w = { lat: input.lat, lng: input.lng, radius_m: radius, industry_code: input.industry_code ?? null, brand: input.brand ?? null };
  const base = snapshot(w, loc);
  const id = newId('wch_');
  state
    .prepare('insert into watch_store (id, created_at, name, lat, lng, industry_code, industry_name, brand, radius_m, memo, location_json, baseline_json) values (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, base.at, input.name.trim(), input.lat, input.lng, w.industry_code, input.industry_name ?? null, w.brand, radius, input.memo ?? null, JSON.stringify(loc), JSON.stringify(base));
  return getWatch(id);
}

type Row = { id: string; created_at: string; name: string; lat: number; lng: number; industry_code: string | null; industry_name: string | null; brand: string | null; radius_m: number; memo: string | null; location_json: string; baseline_json: string };

export function getWatch(id: string) {
  const r = state.prepare('select * from watch_store where id = ?').get(id) as Row | undefined;
  if (!r) throw new ApiProblem(404, '모니터링 매장 없음', `${id}을(를) 찾을 수 없습니다.`);
  const loc = JSON.parse(r.location_json) as Location;
  const base = JSON.parse(r.baseline_json) as Snapshot;
  const now = snapshot(r, loc);
  const diff = compare(base, now, r, loc);
  return {
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    lat: r.lat,
    lng: r.lng,
    address: loc.address_road ?? loc.address_jibun,
    industry: r.industry_name,
    brand: r.brand,
    radius_m: r.radius_m,
    memo: r.memo,
    level: diff.signals.some((s) => s.level === 'warn') ? 'warn' : diff.signals.some((s) => s.level === 'watch') ? 'watch' : 'ok',
    ...diff,
    baseline: { at: base.at, all_stores: base.all_stores, same_industry: base.same_industry.length, same_brand: base.same_brand.length, license: base.license, rent_1f: base.rent_1f },
    current: { at: now.at, all_stores: now.all_stores, same_industry: now.same_industry.length, same_brand: now.same_brand.length, license: now.license, rent_1f: now.rent_1f },
    sources: ['소상공인시장진흥공단 상가(상권)정보', '행정안전부 지방행정 인허가', '한국부동산원 R-ONE 임대동향'],
  };
}

export function listWatch() {
  const rows = state.prepare('select id from watch_store order by created_at desc').all() as { id: string }[];
  return rows.map((r) => {
    const w = getWatch(r.id);
    // 목록에는 경보 수준이 있는 신호를 먼저
    const order = { warn: 0, watch: 1, info: 2 } as const;
    return { id: w.id, name: w.name, address: w.address, industry: w.industry, brand: w.brand, created_at: w.created_at, level: w.level, signals: [...w.signals].sort((a, b) => order[a.level] - order[b.level]).slice(0, 3) };
  });
}

export function deleteWatch(id: string) {
  const r = state.prepare('delete from watch_store where id = ?').run(id);
  if (!r.changes) throw new ApiProblem(404, '모니터링 매장 없음', `${id}을(를) 찾을 수 없습니다.`);
}
