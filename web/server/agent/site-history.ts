// 자리의 과거: 같은 건물(인허가 좌표 10m 안)에서 지금까지 열고 닫은 음식점·카페·편의점 이력.
// 인허가 좌표는 지번(건물) 단위라 층·호는 구분하지 못한다.
import { all } from './db.ts';
import { bbox, distanceM } from './geo.ts';

const SAME_SITE_M = 10;
const SVC: Record<string, string> = { '07_24_04_P': '일반음식점', rest_cafes: '휴게음식점', tobacco_retailers: '담배소매업(편의점 등)' };

export interface SiteHistory {
  radius_m: number;
  total: number;
  active: number;
  closed: number;
  /** 문 닫은 곳 중 3년 안에 닫은 곳 */
  closed_within_3y: number;
  /** 문 닫은 곳의 영업 기간 중앙값 (년) */
  median_years_closed: number | null;
  /** 최근 5년 안에 문 닫은 곳 */
  closed_last_5y: number;
  by_kind: { kind: string; total: number; closed: number }[];
  items: { name: string; kind: string; uptae: string | null; opened: string | null; closed: string | null; years: number | null; state: string }[];
  /** 폐업 전후 120일 안에 같은 건물에서 새 허가가 난 폐업 — 간판 교체·양도일 수도, 다른 호실의 새 가게일 수도 있다 (참고값) */
  switches: number;
  coverage: string;
}

const yearsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 864e5);

export function siteHistory(lat: number, lng: number): SiteHistory | null {
  const b = bbox(lat, lng, SAME_SITE_M * 3);
  const rows = all<{ opn_svc_id: string; bplc_nm: string | null; uptae_nm: string | null; apv_perm_ymd: string | null; dcb_ymd: string | null; trd_state_nm: string; lat: number; lon: number }>(
    `select opn_svc_id, bplc_nm, uptae_nm, apv_perm_ymd, dcb_ymd, trd_state_nm, lat, lon from license_event
     where opn_svc_id in ('07_24_04_P', 'rest_cafes', 'tobacco_retailers') and lat between ? and ? and lon between ? and ?`,
    b.minLat, b.maxLat, b.minLng, b.maxLng,
  ).filter((r) => distanceM(lat, lng, r.lat, r.lon) <= SAME_SITE_M);
  if (!rows.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const five = new Date(Date.now() - 5 * 365.25 * 864e5).toISOString().slice(0, 10);
  const items = rows
    .map((r) => {
      const closed = r.trd_state_nm === '폐업' ? r.dcb_ymd : null;
      const years = r.apv_perm_ymd ? Math.round(yearsBetween(r.apv_perm_ymd, closed ?? today) * 10) / 10 : null;
      return { name: r.bplc_nm ?? '(상호 없음)', kind: SVC[r.opn_svc_id] ?? r.opn_svc_id, uptae: r.uptae_nm, opened: r.apv_perm_ymd, closed, years, state: r.trd_state_nm };
    })
    .sort((x, y) => (y.opened ?? '').localeCompare(x.opened ?? ''));
  const closed = items.filter((x) => x.closed);
  // a closure followed (within 120 days) by a new license at the same site is a 간판 교체·양도, not a failure
  const opens = items.map((x) => x.opened).filter(Boolean) as string[];
  const switches = closed.filter((c) => opens.some((o) => Math.abs(yearsBetween(c.closed!, o)) * 365.25 <= 120 && o !== c.opened)).length;
  const yrs = closed.map((x) => x.years).filter((v): v is number => v != null).sort((a, c) => a - c);
  const kinds = new Map<string, { total: number; closed: number }>();
  for (const x of items) {
    const k = kinds.get(x.kind) ?? { total: 0, closed: 0 };
    k.total++;
    if (x.closed) k.closed++;
    kinds.set(x.kind, k);
  }
  return {
    radius_m: SAME_SITE_M,
    total: items.length,
    active: items.length - closed.length,
    closed: closed.length,
    closed_within_3y: closed.filter((x) => x.years != null && x.years < 3).length,
    median_years_closed: yrs.length ? yrs[Math.floor(yrs.length / 2)] : null,
    closed_last_5y: closed.filter((x) => (x.closed ?? '') >= five).length,
    by_kind: [...kinds].map(([kind, v]) => ({ kind, ...v })),
    items: items.slice(0, 30),
    switches,
    coverage: '일반음식점은 전체 이력, 휴게음식점·담배소매업은 2016년 이후 인허가 전부와 그 이전 영업 중인 곳 (수집 범위)',
  };
}
