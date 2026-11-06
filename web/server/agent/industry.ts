// Step 2: decide which 업종 we are scoring. Pivot = 상가정보 소분류 (docs/03_DB_설계.md 3-2).
import { resolveBrand } from './brand.ts';
import { all, one } from './db.ts';
import { bbox, distanceM } from './geo.ts';

export type Confidence = 'A' | 'B' | 'C';

export interface Industry {
  code: string | null;
  name: string | null;
  mcls_name: string | null;
  lcls_name: string | null;
  method: 'input' | 'store_name' | 'roadview' | 'unknown';
  franchise_brand: string | null;
  confidence: Confidence;
  /** 서울 상권분석 서비스업종 (CS…) — for the Seoul sales model and benchmarks */
  seoul_cs: string | null;
  /** 일반음식점 인허가 업태 — for the survival model; null = not a 일반음식점 업종 */
  license_uptae: string | null;
}

interface Scls {
  code: string;
  name: string;
  mcls_name: string;
  lcls_name: string;
}

let catalog: Scls[] | undefined;
export function industryCatalog(): Scls[] {
  // 업종 코드표(industry_store, 247개)에서 바로 읽는다. 점포 275만 곳을 묶으면 서버가 다시 뜬 뒤 첫 검색이 10초 걸린다
  catalog ??= all<Scls>(`
    select scls_cd code, scls_nm name, mcls_nm mcls_name, lcls_nm lcls_name from industry_store order by scls_cd`);
  if (!catalog.length)
    catalog = all<Scls>(`
      select inds_scls_cd code, max(inds_scls_nm) name, max(inds_mcls_nm) mcls_name, max(inds_lcls_nm) lcls_name
      from store group by inds_scls_cd order by inds_scls_cd`);
  return catalog;
}

const SYNONYMS: Record<string, string> = {
  커피: 'I21201', 커피전문점: 'I21201', 까페: 'I21201', 한식: 'I20101', 중식: 'I20201', 일식: 'I20301',
  양식: 'I20401', 분식: 'I21007', 베이커리: 'I21001', 제과: 'I21001', 호프: 'I21103', 술집: 'I21104',
};

/** 소분류 → 일반음식점 인허가 업태 (license_event.uptae_nm). Only 음식(I2) 업종 get one. */
function licenseUptae(code: string): string | null {
  if (!code.startsWith('I2')) return null;
  const fixed: Record<string, string> = {
    I20107: '식육(숯불구이)', I20108: '식육(숯불구이)', I20111: '횟집', I20702: '뷔페식',
    I21003: '패스트푸드', I21004: '패스트푸드', I21006: '통닭(치킨)', I21007: '분식',
    I21103: '호프/통닭', I21104: '정종/대포집/소주방', I21201: '까페',
  };
  if (fixed[code]) return fixed[code];
  const byGroup: Record<string, string> = {
    I201: '한식', I202: '중국식', I203: '일식', I204: '경양식', I205: '외국음식전문점(인도,태국등)', I206: '외국음식전문점(인도,태국등)',
  };
  return byGroup[code.slice(0, 4)] ?? '기타';
}

function seoulCs(code: string): string | null {
  return (
    one<{ code: string }>(
      `select code from industry_map where system = 'seoul_svc' and scls_cd = ?
       order by case match_type when 'exact' then 0 when 'group' then 1 else 2 end limit 1`,
      code,
    )?.code ?? null
  );
}

/** 상호 → 공정위 대표 브랜드 (별칭 표 brand_alias: "메가커피 강남역점" → "메가엠지씨커피(MEGA MGC COFFEE)") */
const franchiseBrand = (storeName?: string) => resolveBrand(storeName);

function finish(s: Scls | undefined, method: Industry['method'], confidence: Confidence, brand: string | null): Industry {
  if (!s) {
    return { code: null, name: null, mcls_name: null, lcls_name: null, method: 'unknown', franchise_brand: brand, confidence: 'C', seoul_cs: null, license_uptae: null };
  }
  return { ...s, method, franchise_brand: brand, confidence, seoul_cs: seoulCs(s.code), license_uptae: licenseUptae(s.code) };
}

export function searchIndustries(q: string): Scls[] {
  const cat = industryCatalog();
  const t = q.trim();
  if (!t) return cat;
  const syn = SYNONYMS[t];
  return cat.filter((s) => s.code === syn || s.code.startsWith(t.toUpperCase()) || s.name.includes(t) || s.mcls_name.includes(t));
}

export function resolveIndustry(input: { industry?: string; store_name?: string; lat: number; lng: number }): Industry {
  const cat = industryCatalog();
  const brand = franchiseBrand(input.store_name);

  if (input.industry) {
    const t = input.industry.trim();
    const byCode = cat.find((s) => s.code === t.toUpperCase());
    if (byCode) return finish(byCode, 'input', 'A', brand);
    const byName = cat.find((s) => s.name === t) ?? cat.find((s) => s.code === SYNONYMS[t]) ?? searchIndustries(t)[0];
    if (byName) return finish(byName, 'input', 'B', brand);
  }

  if (input.store_name) {
    // The store may already exist at this spot (상가정보), else take the most common 업종 for that name.
    const b = bbox(input.lat, input.lng, 50);
    const here = all<{ code: string; lat: number; lon: number }>(
      `select inds_scls_cd code, lat, lon from store
       where bizes_nm = ? and lat between ? and ? and lon between ? and ?`,
      input.store_name, b.minLat, b.maxLat, b.minLng, b.maxLng,
    ).find((r) => distanceM(input.lat, input.lng, r.lat, r.lon) <= 50);
    if (here) return finish(cat.find((s) => s.code === here.code), 'store_name', 'A', brand);
    const common = one<{ code: string }>(
      `select inds_scls_cd code from store where bizes_nm like ? group by 1 order by count(*) desc limit 1`,
      // 대표 브랜드는 괄호 표기·[가맹본부] 앞까지 ("메가엠지씨커피%"), 브랜드가 아니면 상호 첫 낱말
      `${(brand?.replace(/[([].*$/, '') ?? input.store_name.trim().split(/\s+/)[0]).trim()}%`,
    );
    if (common) return finish(cat.find((s) => s.code === common.code), 'store_name', 'B', brand);
  }
  return finish(undefined, 'unknown', 'C', brand);
}

/** Used after the roadview step when nothing else identified the 업종. */
export function industryFromName(name: string): Industry | null {
  const hit = searchIndustries(name)[0];
  return hit ? finish(hit, 'roadview', 'C', null) : null;
}
