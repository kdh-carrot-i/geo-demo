// 프랜차이즈 브랜드: 공정위 가맹사업 정보공개(평균 매출·가맹점 수·개폐점·창업 비용)와 같은 브랜드 근접 매장(점주권 중복).
// 상호 ↔ 공정위 등록명은 별칭 표(brand_alias, etl/brand-alias.ts)와 brand-name.ts 규칙으로 잇는다.
import { matchPrefix, type AliasKind } from './brand-name.ts';
import { all, one } from './db.ts';
import { bbox, distanceM } from './geo.ts';

// ── 상호 → 브랜드 ──────────────────────────────────────────

type AliasRow = { group_nm: string; kind: AliasKind };
let aliasMap: Map<string, AliasRow> | null | undefined;
/** 별칭 표 (없으면 null: etl/brand-alias.ts를 아직 안 돌린 DB) */
function aliases(): Map<string, AliasRow> | null {
  if (aliasMap === undefined) {
    try {
      aliasMap = new Map(all<AliasRow & { alias: string }>('select alias, group_nm, kind from brand_alias').map((r) => [r.alias, r]));
      if (!aliasMap.size) aliasMap = null;
    } catch {
      aliasMap = null;
    }
  }
  return aliasMap;
}

/**
 * 상호(+ 지점명) → 대표 브랜드 (최신 연도 공정위 등록명). "메가커피 강남역점" → "메가엠지씨커피(MEGA MGC COFFEE)".
 * 별칭 표가 없으면 예전 규칙(등록명이 상호의 접두어)으로 찾는다.
 */
export function resolveBrand(storeName?: string | null, branch?: string | null): string | null {
  if (!storeName?.trim()) return null;
  const m = aliases();
  if (m) return matchPrefix(storeName, (a) => m.get(a), branch)?.value.group_nm ?? null;
  return (
    one<{ brand_nm: string }>(
      `select brand_nm from franchise_brand_y
       where length(replace(brand_nm, ' ', '')) >= 2 and instr(?, replace(brand_nm, ' ', '')) = 1
       order by length(brand_nm) desc, frcs_cnt desc limit 1`,
      storeName.replace(/\s+/g, ''),
    )?.brand_nm ?? null
  );
}

/** 상가정보 점포가 이 브랜드 매장인가 — 같은 브랜드 근접 매장·관심 매장 감시에 쓴다 */
export function brandMatcher(brand: string): (bizesNm: string, brchNm?: string | null) => boolean {
  const m = aliases();
  if (!m) {
    const key = brand.replace(/\s+/g, '');
    return (n) => n.replace(/\s+/g, '').startsWith(key);
  }
  // 대표 브랜드가 아닌 이름(예전 연도 등록명·상호)이 오면 먼저 대표 브랜드로
  const group = groupOf(brand) ?? resolveBrand(brand) ?? brand;
  return (n, b) => resolveBrand(n, b) === group;
}

/** 등록명(어느 연도든)·대표 이름 → 대표 브랜드 */
function groupOf(brand: string): string | null {
  try {
    return one<{ g: string }>('select group_nm g from brand_member where group_nm = ? or brand_nm = ? order by yr desc limit 1', brand, brand)?.g ?? null;
  } catch {
    return null;
  }
}

export interface BrandInfo {
  brand: string;
  corp: string;
  industry: string;
  year: string;
  stores: number;
  opened: number;
  /** 계약 종료 + 계약 해지 */
  closed: number;
  renamed: number;
  /** (계약 종료 + 해지) ÷ 가맹점 수 — 공정위 공개값으로 만든 근사 폐점률 */
  closure_rate: number | null;
  /** 가맹점 연평균 매출 (원) */
  avg_sales_annual: number | null;
  /** 3.3㎡당 연평균 매출 (원) */
  avg_sales_per_3_3m2: number | null;
  /** 창업 비용 (원): 가맹비·교육비·보증금·기타(인테리어 등)·합계 */
  cost: { join: number | null; edu: number | null; deposit: number | null; etc: number | null; total: number | null } | null;
  trend: { year: string; stores: number; avg_sales_annual: number | null; closed: number }[];
}

const won = (thousand: number | null | undefined) => (thousand ? thousand * 1000 : null);

/** 공정위 정보. brand는 대표 브랜드·등록명·상호 어느 것이든 된다 (연도마다 등록명이 달라도 대표 브랜드로 묶어 추이를 낸다) */
export function brandInfo(brand: string | null): BrandInfo | null {
  if (!brand) return null;
  const group = aliases() ? (groupOf(brand) ?? resolveBrand(brand)) : null;
  type Y = { yr: string; corp_nm: string; brand_nm: string; induty_mlsfc_nm: string; frcs_cnt: number; new_frcs_rgs_cnt: number; ctrt_end_cnt: number; ctrt_cncltn_cnt: number; nm_chg_cnt: number; avrg_sls_amt: number; ar_unit_avrg_sls_amt: number };
  const cols = 'f.yr, f.corp_nm, f.brand_nm, f.induty_mlsfc_nm, f.frcs_cnt, f.new_frcs_rgs_cnt, f.ctrt_end_cnt, f.ctrt_cncltn_cnt, f.nm_chg_cnt, f.avrg_sls_amt, f.ar_unit_avrg_sls_amt';
  // 한 해에 같은 브랜드 등록이 여럿이면(지역 본부 등) 가맹점 수가 가장 많은 것
  const rows = (
    group
      ? all<Y>(`select ${cols} from franchise_brand_y f join brand_member m using (yr, corp_nm, brand_nm) where m.group_nm = ? order by f.yr desc, f.frcs_cnt desc`, group)
      : all<Y>(`select ${cols} from franchise_brand_y f where f.brand_nm = ? order by f.yr desc, f.frcs_cnt desc`, brand)
  ).filter((x, i, a) => i === 0 || a[i - 1].yr !== x.yr);
  if (!rows.length) return null;
  const r = rows[0];
  const c = one<{ jng_bzmn_jng_amt: number; jng_bzmn_edu_amt: number; jng_bzmn_assrnc_amt: number; jng_bzmn_etc_amt: number; smtn_amt: number }>(
    'select jng_bzmn_jng_amt, jng_bzmn_edu_amt, jng_bzmn_assrnc_amt, jng_bzmn_etc_amt, smtn_amt from franchise_cost_y where brand_nm = ? and corp_nm = ? order by yr desc limit 1',
    r.brand_nm, r.corp_nm,
  );
  const closed = (r.ctrt_end_cnt ?? 0) + (r.ctrt_cncltn_cnt ?? 0);
  return {
    brand: group ?? brand,
    corp: r.corp_nm,
    industry: r.induty_mlsfc_nm,
    year: r.yr,
    stores: r.frcs_cnt ?? 0,
    opened: r.new_frcs_rgs_cnt ?? 0,
    closed,
    renamed: r.nm_chg_cnt ?? 0,
    closure_rate: r.frcs_cnt ? Math.round((closed / r.frcs_cnt) * 1000) / 1000 : null,
    avg_sales_annual: won(r.avrg_sls_amt),
    avg_sales_per_3_3m2: won(r.ar_unit_avrg_sls_amt),
    cost: c ? { join: won(c.jng_bzmn_jng_amt), edu: won(c.jng_bzmn_edu_amt), deposit: won(c.jng_bzmn_assrnc_amt), etc: won(c.jng_bzmn_etc_amt), total: won(c.smtn_amt) } : null,
    trend: rows
      .slice(0, 3)
      .reverse()
      .map((x) => ({ year: x.yr, stores: x.frcs_cnt ?? 0, avg_sales_annual: won(x.avrg_sls_amt), closed: (x.ctrt_end_cnt ?? 0) + (x.ctrt_cncltn_cnt ?? 0) })),
  };
}

export interface SameBrand {
  radius_m: number;
  within_500: number;
  within_1000: number;
  /** 15m 안 매장: 평가 위치 자체가 기존 매장일 수 있음 */
  at_site: boolean;
  nearest: { name: string; distance_m: number; floor: string | null; lat: number; lng: number }[];
}

const RADIUS = 1000;

/** 상가정보에서 상호가 이 브랜드(별칭 포함: "메가커피"·"메가엠지씨커피"…)로 잡히는 매장 (지점명은 brch_nm) */
export function sameBrandNearby(brand: string | null, lat: number, lng: number): SameBrand | null {
  if (!brand) return null;
  const isBrand = brandMatcher(brand);
  const b = bbox(lat, lng, RADIUS);
  const rows = all<{ bizes_nm: string; brch_nm: string | null; flr_no: string | null; lat: number; lon: number }>(
    'select bizes_nm, brch_nm, flr_no, lat, lon from store where lat between ? and ? and lon between ? and ?',
    b.minLat, b.maxLat, b.minLng, b.maxLng,
  )
    .filter((s) => s.bizes_nm && isBrand(s.bizes_nm, s.brch_nm))
    .map((s) => ({ ...s, d: Math.round(distanceM(lat, lng, s.lat, s.lon)) }))
    .filter((s) => s.d <= RADIUS)
    .sort((x, y) => x.d - y.d);
  return {
    radius_m: RADIUS,
    within_500: rows.filter((s) => s.d <= 500).length,
    within_1000: rows.length,
    at_site: rows.some((s) => s.d <= 15),
    nearest: rows.slice(0, 8).map((s) => ({ name: [s.bizes_nm, s.brch_nm].filter(Boolean).join(' '), distance_m: s.d, floor: s.flr_no, lat: s.lat, lng: s.lon })),
  };
}
