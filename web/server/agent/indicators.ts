// Step 3: facts about the surroundings, straight from commerce.sqlite (+ VWorld for 공시지가).
import { cadastral } from '../vworld.ts';
import { lookupBuildings, type Buildings } from './building.ts';
import { lookupRent, type Rent } from './rent.ts';
import { resolveBrand } from './brand.ts';
import { siteHistory, type SiteHistory } from './site-history.ts';
import { all, LATEST_Q, one } from './db.ts';
import { bbox, distanceM } from './geo.ts';
import type { Industry } from './industry.ts';
import type { Location } from './location.ts';
import { internalDataAllowed, INTERNAL_ONLY_LICENSE, type SourceTracker } from './sources.ts';

/** Every indicator block names the source keys (see sources.ts) its numbers come from. */
type Sourced = { sources: string[] };

const STORE_PERIOD = one<{ p: string }>("select std_period p from meta_source where table_name = 'store'")?.p ?? '';
/** An indicator block before its sources are attached. */
type Raw<K extends keyof Indicators> = Omit<NonNullable<Indicators[K]>, 'sources'>;

export interface Indicators {
  floating_pop: ({
    quarter_total: number;
    by_time: Record<string, number>;
    share_2030: number;
    weekend_share: number;
    as_of: string;
    scope: string;
  } & Sourced) | null;
  living_pop: ({ hourly_avg: number; by_time: Record<string, number>; as_of: string; scope: string } & Sourced) | null;
  /** 서울 밖 행정동 유동인구: 경기는 실측, 그 밖은 경기 실측으로 학습한 추정. 내부 심사 한정 (DATA_SCOPE=external이면 null) */
  flowpop_dong: ({
    kind: 'measured' | 'estimated';
    hourly_avg: number;
    /** 추정일 때 80% 범위 (시 단위 검증 잔차 기준, 학습 범위 밖일수록 넓다) */
    range: [number, number] | null;
    by_time: Record<string, number>;
    /** 학습 범위(경기) 밖 피처 비율 0~1 — 클수록 추정을 덜 믿는다 */
    out_of_range: number;
    as_of: string;
    scope: string;
    license: string;
  } & Sourced) | null;
  residents: ({ population: number | null; households: number | null; apt_households: number | null; scope: string } & Sourced) | null;
  /** 주민등록 인구·세대 (법정동, 월별). residents(SGIS 행정동 연 1회)보다 최신이고 1년 증감을 함께 준다 */
  resident_registry: ({
    population: number;
    households: number;
    persons_per_household: number | null;
    /** 12개월 전 대비 증감률 (%), 그 달 자료가 없으면 null */
    population_change_pct: number | null;
    households_change_pct: number | null;
    /** 20~39세 비율, 60세 이상 비율 (연령 자료가 있을 때) */
    share_20_39: number | null;
    share_60_plus: number | null;
    as_of: string;
    scope: string;
  } & Sourced) | null;
  workers: ({ workers: number | null; businesses: number | null; scope: string } & Sourced) | null;
  /**
   * 국민연금 가입 사업장 (법정동, 월별). 직원은 본사 주소로 등록돼 대기업·프랜차이즈·용역 회사는 실제 근무지와 다르다:
   * 300인 이하 사업장만 "그 동에서 일하는 사람"으로 보고, 전체는 참고로 준다.
   */
  nps_workers: ({
    workplaces: number;
    members_small: number;
    members_all: number;
    /** 300인 이하 사업장의 1인 월 소득 추정 (고지금액 ÷ 가입자 ÷ 보험료율 9.5%, 기준소득 상한 때문에 고소득은 낮게 잡힘) */
    monthly_income_est: number | null;
    top_employers: { name: string; members: number; industry: string }[];
    as_of: string;
    scope: string;
  } & Sourced) | null;
  competitors: {
    radius_m: number;
    same_industry: number | null;
    same_mcls: number | null;
    all_stores: number;
    branch_share: number | null;
    /** 같은 업종 중 공정위 가맹 브랜드로 잡힌 비율 (brand_alias 규칙) */
    franchise_share: number | null;
    location_quotient: number | null;
    nearest: { name: string; brand: string | null; industry: string; distance_m: number; floor: string | null; lat: number; lng: number }[];
    /** 입지계수 기준이 된 시도 */
    baseline_area: string | null;
    scope: string;
  } & Sourced;
  /** stores that appeared / disappeared between the two latest 상가정보 snapshots (where both exist) */
  store_change: ({
    radius_m: number;
    from: string;
    to: string;
    same_industry: { closed: number; opened: number; before: number } | null;
    all: { closed: number; opened: number; before: number };
  } & Sourced) | null;
  food_license_churn: ({ radius_m: number; active: number; opened_12m: number; closed_12m: number; as_of: string } & Sourced) | null;
  /**
   * 앞으로 생길 공급·수요 (건축HUB 인허가). 비주거는 좌표가 없어 반경 안 점포의 법정동 범위로 근사하고,
   * 건물(PNU)마다 최신 기록 하나만 쓴다. 주택은 좌표를 찾은 3년 내 입주 예정 100세대+ 단지만 1km 반경.
   */
  supply_pipeline: ({
    /** 착공했고 아직 사용승인 전인 비주거 연면적 (㎡) — 곧 생길 상가·사무 공간 */
    under_construction_m2: { retail: number; office: number; lodging: number; other: number; buildings: number };
    /** 2024년 이후 허가만 났고 아직 착공 전 */
    permitted_m2: number;
    upcoming_households_3y: number;
    projects: { kind: 'commercial' | 'housing'; name: string | null; purpose: string; size: string; schedule: string }[];
    scope: string;
  } & Sourced) | null;
  rent: (Rent & Sourced) | null;
  /** 자리의 과거: 같은 건물(10m)에서 열고 닫은 음식점·카페·편의점 */
  site_history: (SiteHistory & Sourced) | null;
  buildings: (Buildings & Sourced) | null;
  land_price: ({ official_price_per_m2: number; year_month: string | null } & Sourced) | null;
}

interface StoreRow {
  bizes_nm: string;
  brch_nm: string | null;
  inds_scls_cd: string;
  inds_scls_nm: string;
  inds_mcls_cd: string;
  ctprvn_cd: string;
  flr_no: string | null;
  lat: number;
  lon: number;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

const ymdDot = (d: string | null) => (d ? `${d.slice(0, 4)}.${d.slice(4, 6)}` : '?');
type PermitRow = { pnu: string; bld_nm: string | null; purps: string; tot_area: number; pms_day: string | null; real_stcns_day: string | null; use_apr_day: string | null };

export function supplyPipeline(loc: Location, radius: number): Raw<'supply_pipeline'> | null {
  // 반경 안 점포의 법정동 (인허가 기록에 좌표가 없어서)
  const b = bbox(loc.lat, loc.lng, radius);
  const bjds = all<{ d: string }>('select distinct ldong_cd d from store where lat between ? and ? and lon between ? and ? and ldong_cd is not null', b.minLat, b.maxLat, b.minLng, b.maxLng).map((r) => r.d);
  if (loc.pnu && !bjds.includes(loc.pnu.slice(0, 10))) bjds.push(loc.pnu.slice(0, 10));
  let rows: PermitRow[] = [];
  try {
    rows = bjds.length
      ? all<PermitRow>(
          `select pnu, bld_nm, purps, tot_area, pms_day, real_stcns_day, use_apr_day from arch_permit
           where bjd_cd in (${bjds.map(() => '?').join(',')}) and arch_gb in ('신축', '증축', '용도변경')`,
          ...bjds,
        )
      : [];
  } catch {
    return null; // 아직 수집 전 (etl/arch-permit.ts)
  }
  // 건물마다 최신 기록 하나 (같은 건물이 허가·변경·용도변경으로 여러 번 기록된다)
  const latest = new Map<string, PermitRow>();
  for (const r of rows) {
    const k = r.pnu;
    const prev = latest.get(k);
    if (!prev || (r.pms_day ?? '') > (prev.pms_day ?? '')) latest.set(k, r);
  }
  const uc = { retail: 0, office: 0, lodging: 0, other: 0, buildings: 0 };
  let permitted = 0;
  const projects: Raw<'supply_pipeline'>['projects'] = [];
  for (const r of latest.values()) {
    if (r.use_apr_day) continue;
    if (r.real_stcns_day && r.real_stcns_day >= '20220101') {
      const cls = /근린생활|판매/.test(r.purps) ? 'retail' : /업무/.test(r.purps) ? 'office' : /숙박/.test(r.purps) ? 'lodging' : 'other';
      uc[cls] += r.tot_area;
      uc.buildings++;
      projects.push({ kind: 'commercial', name: r.bld_nm, purpose: r.purps, size: `${Math.round(r.tot_area).toLocaleString()}㎡`, schedule: `${ymdDot(r.real_stcns_day)} 착공` });
    } else if (!r.real_stcns_day && (r.pms_day ?? '') >= '20240101') permitted += r.tot_area;
  }
  // 주택: 좌표가 있는 3년 내 입주 예정 단지 (etl/zone-housing.ts가 좌표를 채움)
  let hh = 0;
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const hb = bbox(loc.lat, loc.lng, 1000);
    for (const h of all<{ bld_nm: string | null; hhld: number; use_inspt_sched_day: string; lat: number; lon: number }>(
      `select bld_nm, hhld, use_inspt_sched_day, lat, lon from housing_permit
       where lat between ? and ? and lon between ? and ? and use_inspt_day is null and use_inspt_sched_day >= ?`,
      hb.minLat, hb.maxLat, hb.minLng, hb.maxLng, today,
    )) {
      if (distanceM(loc.lat, loc.lng, h.lat, h.lon) > 1000) continue;
      hh += h.hhld;
      projects.push({ kind: 'housing', name: h.bld_nm, purpose: '공동주택', size: `${h.hhld.toLocaleString()}세대`, schedule: `${ymdDot(h.use_inspt_sched_day)} 입주 예정` });
    }
  } catch {
    // 좌표 없음
  }
  if (!uc.buildings && !permitted && !hh) return null;
  projects.sort((a, b2) => parseInt(b2.size.replace(/\D/g, ''), 10) - parseInt(a.size.replace(/\D/g, ''), 10));
  const r0 = (v: number) => Math.round(v);
  return {
    under_construction_m2: { retail: r0(uc.retail), office: r0(uc.office), lodging: r0(uc.lodging), other: r0(uc.other), buildings: uc.buildings },
    permitted_m2: r0(permitted),
    upcoming_households_3y: hh,
    projects: projects.slice(0, 8),
    scope: `반경 ${radius}m 안 점포의 법정동 ${bjds.length}곳 (비주거, 건물별 최신 인허가) · 주택은 1km 안 입주 예정 100세대+ 단지`,
  };
}

// 업종 share of all stores, per 시도 — the LQ baseline. A 시도 baseline keeps rural areas from being
// judged against Seoul's mix.
let sclsShare: Map<string, number> | undefined;
let sidoName: Map<string, string> | undefined;
function industryShare(code: string, sido: string): number | null {
  if (!sclsShare) {
    // etl/zone-stats.ts가 미리 센 시도 × 소분류 비중 (점포 275만 곳을 그 자리에서 묶으면 서버가 뜬 뒤 첫 평가가 10초 넘게 걸린다)
    sclsShare = new Map(all<{ s: string; c: string; share: number }>('select ctprvn_cd s, scls_cd c, share from sido_scls_share').map((r) => [`${r.s}:${r.c}`, r.share]));
    sidoName = new Map(all<{ s: string; nm: string }>("select sido_cd s, locatadd_nm nm from region_legal where sgg_cd = '000' and umd_cd = '000'").map((r) => [r.s, r.nm]));
    // 세종(36)은 법정동 코드표에 시도 행이 없다
    if (!sidoName.has('36')) sidoName.set('36', '세종특별자치시');
  }
  return sclsShare.get(`${sido}:${code}`) ?? null;
}

function competitors(loc: Location, ind: Industry, radius: number): Raw<'competitors'> {
  const b = bbox(loc.lat, loc.lng, radius);
  const rows = all<StoreRow>(
    `select bizes_nm, brch_nm, inds_scls_cd, inds_scls_nm, inds_mcls_cd, ctprvn_cd, flr_no, lat, lon from store
     where lat between ? and ? and lon between ? and ?`,
    b.minLat, b.maxLat, b.minLng, b.maxLng,
  )
    .map((r) => ({ ...r, d: distanceM(loc.lat, loc.lng, r.lat, r.lon) }))
    .filter((r) => r.d <= radius);
  const same = ind.code ? rows.filter((r) => r.inds_scls_cd === ind.code) : [];
  const brands = new Map<StoreRow, string | null>();
  const brandOf = (r: StoreRow) => {
    if (!brands.has(r)) brands.set(r, resolveBrand(r.bizes_nm, r.brch_nm));
    return brands.get(r)!;
  };
  const mcls = ind.code ? rows.filter((r) => r.inds_mcls_cd === ind.code!.slice(0, 4)).length : null;
  // the 시도 most stores in the circle belong to (a circle can cross a border)
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(r.ctprvn_cd, (tally.get(r.ctprvn_cd) ?? 0) + 1);
  const sido = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const share = ind.code && sido ? industryShare(ind.code, sido) : null;
  return {
    radius_m: radius,
    same_industry: ind.code ? same.length : null,
    same_mcls: mcls,
    all_stores: rows.length,
    // 상가정보 지점명(brch_nm)이 있으면 체인 지점으로 본다 (프랜차이즈 근사)
    branch_share: same.length ? round3(same.filter((r) => r.brch_nm).length / same.length) : null,
    // 상호 → 공정위 브랜드 별칭 규칙으로 잡힌 비율 (지점명 근사보다 정확, 직영 브랜드는 공정위에 없어 빠짐)
    franchise_share: same.length ? round3(same.filter((r) => brandOf(r)).length / same.length) : null,
    location_quotient: share && rows.length ? round3(same.length / rows.length / share) : null,
    nearest: same
      .sort((a, b2) => a.d - b2.d)
      .slice(0, 10)
      .map((r) => ({ name: r.brch_nm ? `${r.bizes_nm} ${r.brch_nm}` : r.bizes_nm, brand: brandOf(r), industry: r.inds_scls_nm, distance_m: Math.round(r.d), floor: r.flr_no || null, lat: r.lat, lng: r.lon })),
    baseline_area: sido ? (sidoName?.get(sido) ?? sido) : null,
    scope: `소상공인 상가정보 ${STORE_PERIOD}`,
  };
}

/**
 * Compare the two latest snapshots inside the circle. A bizes_id present before and gone now counts as
 * closed (it may also be a re-registration), new ids as opened. Only where the older snapshot covers the
 * area (today: Seoul 2026-06 → nationwide 2026-09).
 */
function storeChange(loc: Location, ind: Industry, radius: number): Omit<NonNullable<Indicators['store_change']>, 'sources'> | null {
  const yms = all<{ ym: string }>('select distinct std_ym ym from store_snapshot order by 1 desc limit 2').map((r) => r.ym);
  if (yms.length < 2) return null;
  const [to, from] = yms;
  const b = bbox(loc.lat, loc.lng, radius);
  const pick = (ym: string) =>
    all<{ bizes_id: string; inds_scls_cd: string; lat: number; lon: number }>(
      'select bizes_id, inds_scls_cd, lat, lon from store_snapshot where std_ym = ? and lat between ? and ? and lon between ? and ?',
      ym, b.minLat, b.maxLat, b.minLng, b.maxLng,
    ).filter((r) => distanceM(loc.lat, loc.lng, r.lat, r.lon) <= radius);
  const before = pick(from);
  if (!before.length) return null; // the older snapshot does not cover this area
  const after = pick(to);
  const beforeIds = new Set(before.map((r) => r.bizes_id));
  const afterIds = new Set(after.map((r) => r.bizes_id));
  const count = (pred: (r: { inds_scls_cd: string }) => boolean) => ({
    closed: before.filter((r) => pred(r) && !afterIds.has(r.bizes_id)).length,
    opened: after.filter((r) => pred(r) && !beforeIds.has(r.bizes_id)).length,
    before: before.filter(pred).length,
  });
  const fmt = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4)}`;
  return {
    radius_m: radius,
    from: fmt(from),
    to: fmt(to),
    same_industry: ind.code ? count((r) => r.inds_scls_cd === ind.code) : null,
    all: count(() => true),
  };
}

function foodChurn(loc: Location, radius: number): Raw<'food_license_churn'> | null {
  const b = bbox(loc.lat, loc.lng, radius);
  const rows = all<{ apv_perm_ymd: string; dcb_ymd: string | null; trd_state_nm: string; lat: number; lon: number }>(
    `select apv_perm_ymd, dcb_ymd, trd_state_nm, lat, lon from license_event
     where opn_svc_id = '07_24_04_P' and lat between ? and ? and lon between ? and ?`,
    b.minLat, b.maxLat, b.minLng, b.maxLng,
  ).filter((r) => distanceM(loc.lat, loc.lng, r.lat, r.lon) <= radius);
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return {
    radius_m: radius,
    active: rows.filter((r) => r.trd_state_nm !== '폐업').length,
    opened_12m: rows.filter((r) => r.apv_perm_ymd >= since).length,
    closed_12m: rows.filter((r) => r.trd_state_nm === '폐업' && (r.dcb_ymd ?? '') >= since).length,
    as_of: one<{ d: string }>("select max(apv_perm_ymd) d from license_event where opn_svc_id = '07_24_04_P'")?.d ?? '',
  };
}

function seoulArea(loc: Location): { floating_pop: Raw<'floating_pop'> | null; residents: Raw<'residents'> | null; workers: Raw<'workers'> | null } | null {
  const ta = loc.trade_area;
  if (!ta) return null;
  const f = one<Record<string, number>>('select * from ta_flpop_q where stdr_yyqu_cd = ? and trdar_cd = ?', LATEST_Q, ta.code);
  const r = one<Record<string, number>>('select * from ta_repop_q where stdr_yyqu_cd = ? and trdar_cd = ?', LATEST_Q, ta.code);
  const w = one<Record<string, number>>('select * from ta_wrcpop_q where stdr_yyqu_cd = ? and trdar_cd = ?', LATEST_Q, ta.code);
  const scope = `상권 ${ta.name} · ${LATEST_Q.slice(0, 4)}년 ${LATEST_Q[4]}분기`;
  const tot = f?.tot_flpop_co || 0;
  return {
    floating_pop: f && tot
      ? {
          quarter_total: tot,
          by_time: Object.fromEntries(
            ['00_06', '06_11', '11_14', '14_17', '17_21', '21_24'].map((k) => [k.replace('_', '-'), +(f[`tmzon_${k}_flpop_co`] / tot).toFixed(3)]),
          ),
          share_2030: +((f.agrde_20_flpop_co + f.agrde_30_flpop_co) / tot).toFixed(3),
          weekend_share: +((f.sat_flpop_co + f.sun_flpop_co) / tot).toFixed(3),
          as_of: LATEST_Q,
          scope,
        }
      : null,
    residents: r ? { population: r.tot_repop_co, households: r.tot_hshld_co, apt_households: r.apt_hshld_co, scope } : null,
    workers: w ? { workers: w.tot_wrc_popltn_co, businesses: null, scope } : null,
  };
}

type SgisRow = { adm_nm: string; tot_ppltn: number; household_cnt: number; tot_worker: number; corp_cnt: number; year: string };
const SGIS_COLS = 's.adm_nm, s.tot_ppltn, s.household_cnt, s.tot_worker, s.corp_cnt, s.year';

export function sgisAdm(loc: Location): SgisRow | undefined {
  if (!loc.adm_cd) return undefined;
  const direct = one<SgisRow>(
    `select ${SGIS_COLS} from region_code_map m join sgis_adm_stats s on s.sgis_adm_cd = m.sgis_cd
     where m.level = 'dong' and m.adm_cd = ? limit 1`,
    loc.adm_cd,
  );
  if (direct || !loc.adm_nm) return direct;
  // 동 단위 대응표는 아직 서울만 있다 (전국은 점포 적재 후 재생성). 그 밖은 시군구 대응 + 동 이름으로 찾는다.
  return one<SgisRow>(
    `select ${SGIS_COLS} from region_code_map m join sgis_adm_stats s on substr(s.sgis_adm_cd, 1, 5) = m.sgis_cd
     where m.level = 'sgg' and m.sgg_cd = ? and s.adm_nm = ? limit 1`,
    loc.adm_cd.slice(0, 5), loc.adm_nm,
  );
}

const NPS_SMALL = 300;
const NPS_RATE = 0.095; // 2026년 국민연금 보험료율 (근로자+사용자)

/** 국민연금 가입 사업장: 필지의 법정동 (PNU 앞 10자리) */
export function npsWorkers(bjdCd: string | null | undefined): Raw<'nps_workers'> | null {
  if (!bjdCd || !/^\d{10}$/.test(bjdCd)) return null;
  let s: { n: number; all: number; small: number; bill: number; ym: string } | undefined;
  try {
    s = one(
      `select count(*) n, sum(members) "all", sum(case when members <= ${NPS_SMALL} then members else 0 end) small,
              sum(case when members <= ${NPS_SMALL} then bill else 0 end) bill, max(ym) ym
       from nps_workplace where bjd_cd = ?`,
      bjdCd,
    );
  } catch {
    return null; // 적재 전 (etl/nps-workplace.ts)
  }
  if (!s?.n) return null;
  const top = all<{ name: string; members: number; industry: string }>(
    `select name, members, ind_nm industry from nps_workplace where bjd_cd = ? and corp = 1 and members <= ${NPS_SMALL} order by members desc limit 5`,
    bjdCd,
  );
  const nm = one<{ n: string }>('select locatadd_nm n from region_legal where bjd_cd = ?', bjdCd)?.n ?? bjdCd;
  return {
    workplaces: s.n,
    members_small: s.small,
    members_all: s.all,
    monthly_income_est: s.small ? Math.round(s.bill / s.small / NPS_RATE / 10000) * 10000 : null,
    top_employers: top,
    as_of: s.ym,
    scope: `법정동 ${nm} · 국민연금 가입 사업장 ${s.ym} (법인 3인·개인 10인 이상)`,
  };
}

type RegRow ={ stats_ym: string; name: string; tot: number; hh_cnt: number; hh_nmpr: number | null };

/** 주민등록 인구·세대: 법정동(PNU 앞 10자리)의 최근 월과 12개월 전 */
export function residentRegistry(bjdCd: string | null | undefined): Raw<'resident_registry'> | null {
  if (!bjdCd || !/^\d{10}$/.test(bjdCd)) return null;
  let rows: RegRow[];
  try {
    rows = all<RegRow>('select stats_ym, name, tot, hh_cnt, hh_nmpr from resident_pop_bjd where stdg_cd = ? order by stats_ym desc', bjdCd);
  } catch {
    return null; // 아직 적재 전 (etl/resident-pop.ts)
  }
  const cur = rows[0];
  if (!cur?.tot) return null;
  const ago = `${Number(cur.stats_ym.slice(0, 4)) - 1}${cur.stats_ym.slice(4)}`;
  const prev = rows.find((r) => r.stats_ym === ago);
  const pct = (a: number, b: number | undefined) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
  // 연령: API 열 이름에서 나이 구간을 읽는다 (예: …20AGE…, 남녀 합산)
  let share2039: number | null = null;
  let share60: number | null = null;
  try {
    const a = one<Record<string, number | string>>('select * from resident_age_bjd where stdg_cd = ?', bjdCd);
    if (a) {
      const ages = Object.entries(a).filter(([k, v]) => k.startsWith('a_') && typeof v === 'number' && /\d/.test(k) && !/tot/i.test(k));
      const lo = (k: string) => Number(/(\d+)/.exec(k.slice(2))?.[1] ?? -1);
      const sum = (f: (n: number) => boolean) => ages.filter(([k]) => f(lo(k))).reduce((s, [, v]) => s + (v as number), 0);
      const total = sum((n) => n >= 0);
      if (total) {
        share2039 = Math.round((sum((n) => n >= 20 && n < 40) / total) * 1000) / 1000;
        share60 = Math.round((sum((n) => n >= 60) / total) * 1000) / 1000;
      }
    }
  } catch {
    // 연령 표 없음
  }
  const ym = `${cur.stats_ym.slice(0, 4)}-${cur.stats_ym.slice(4)}`;
  return {
    population: cur.tot,
    households: cur.hh_cnt,
    persons_per_household: cur.hh_nmpr,
    population_change_pct: pct(cur.tot, prev?.tot),
    households_change_pct: pct(cur.hh_cnt, prev?.hh_cnt),
    share_20_39: share2039,
    share_60_plus: share60,
    as_of: ym,
    scope: `법정동 ${cur.name} · 주민등록 ${ym}`,
  };
}

/** 부산 행정동 생활인구: 최근 월의 하루 평균 (주거+직장+방문 = 서울 생활인구와 같은 정의) */
function busanLivingPop(admCd: string): Raw<'living_pop'> | null {
  const rows = all<{ h: number; v: number; ym: string; nm: string }>(
    `select hour h, home + work + visit v, std_ym ym, adm_nm nm from busan_livepop_dong_h
     where adm_cd = ? and std_ym = (select max(std_ym) from busan_livepop_dong_h where adm_cd = ?)`,
    admCd, admCd,
  );
  if (!rows.length) return null;
  const tot = rows.reduce((s, r) => s + r.v, 0);
  const bucket = (from: number, to: number) => +(rows.filter((r) => r.h >= from && r.h < to).reduce((s, r) => s + r.v, 0) / tot).toFixed(3);
  const ym = rows[0].ym;
  return {
    hourly_avg: Math.round(tot / rows.length),
    by_time: { '00-06': bucket(0, 6), '06-11': bucket(6, 11), '11-14': bucket(11, 14), '14-17': bucket(14, 17), '17-21': bucket(17, 21), '21-24': bucket(21, 24) },
    as_of: `${ym.slice(0, 4)}-${ym.slice(4)}`,
    scope: `행정동 ${rows[0].nm} · 부산 생활인구 ${ym.slice(0, 4)}-${ym.slice(4)} 하루 평균`,
  };
}

function livingPop(loc: Location): Raw<'living_pop'> | null {
  if (loc.adm_cd?.startsWith('26')) return busanLivingPop(loc.adm_cd);
  if (!loc.adm_cd || loc.coverage !== 'seoul') return null;
  const rows = all<{ h: string; v: number; d: string }>(
    `select tmzon_pd_se h, avg(tot_lvpop_co) v, max(stdr_de_id) d from living_pop_dong_h where adstrd_code_se = ? group by 1`,
    loc.adm_cd,
  );
  if (!rows.length) return null;
  const avg = rows.reduce((s, r) => s + r.v, 0) / rows.length;
  const bucket = (from: number, to: number) => rows.filter((r) => +r.h >= from && +r.h < to).reduce((s, r) => s + r.v, 0) / rows.reduce((s, r) => s + r.v, 0);
  return {
    hourly_avg: Math.round(avg),
    by_time: { '00-06': +bucket(0, 6).toFixed(3), '06-11': +bucket(6, 11).toFixed(3), '11-14': +bucket(11, 14).toFixed(3), '14-17': +bucket(14, 17).toFixed(3), '17-21': +bucket(17, 21).toFixed(3), '21-24': +bucket(21, 24).toFixed(3) },
    as_of: rows[0].d,
    scope: `행정동 ${loc.adm_nm} · 서울 생활인구 최근 1주`,
  };
}

type FlowRow = { kind: 'measured' | 'estimated'; adm_nm: string; hourly_avg: number; p10: number; p90: number; out_of_range: number } & Record<string, number>;
const BANDS = ['00_06', '06_11', '11_14', '14_17', '17_21', '21_24'];

function flowpopDong(loc: Location): Raw<'flowpop_dong'> | null {
  if (!loc.adm_cd || loc.coverage === 'seoul' || !internalDataAllowed()) return null;
  const r = one<FlowRow>('select * from flowpop_est_dong where adm_cd = ?', loc.adm_cd);
  if (!r) return null;
  const measured = r.kind === 'measured';
  return {
    kind: r.kind,
    hourly_avg: r.hourly_avg,
    range: measured ? null : [r.p10, r.p90],
    by_time: Object.fromEntries(BANDS.map((b) => [b.replace('_', '-'), r[`sh_${b}`]])),
    out_of_range: r.out_of_range,
    as_of: '2026-08',
    scope: measured
      ? `행정동 ${r.adm_nm} · 경기 유동인구 실측 (2026-08 한 달, 내국인 시간당 평균)`
      : `행정동 ${r.adm_nm} · 경기 실측으로 학습한 추정값 (내국인 시간당 평균)`,
    license: INTERNAL_ONLY_LICENSE,
  };
}

async function landPrice(loc: Location): Promise<Raw<'land_price'> | null> {
  try {
    const p = (await cadastral({ point: [loc.lng, loc.lat] }))[0];
    return p?.officialPrice ? { official_price_per_m2: p.officialPrice, year_month: p.priceYearMonth ?? null } : null;
  } catch {
    return null;
  }
}

export async function collectIndicators(
  loc: Location,
  ind: Industry,
  radius: number,
  src: SourceTracker,
  floorArea?: number,
  floor?: number,
): Promise<{ indicators: Indicators; sgis: ReturnType<typeof sgisAdm> }> {
  const seoul = seoulArea(loc);
  const sg = sgisAdm(loc);
  const sgScope = sg ? `행정동 ${sg.adm_nm} · SGIS ${sg.year}` : '';
  const tag = <T extends object>(v: T | null | undefined, keys: string[], purpose: string): (T & Sourced) | null =>
    v ? { ...v, sources: keys.map((k) => src.use(k, purpose)) } : null;

  const living = livingPop(loc);
  const flow = flowpopDong(loc);
  const [land, bld] = await Promise.all([landPrice(loc), lookupBuildings(loc.pnu).catch(() => null)]);
  return {
    sgis: sg,
    indicators: {
      floating_pop: tag(seoul?.floating_pop, ['seoul_flpop'], '유동인구'),
      living_pop: tag(living, [loc.adm_cd?.startsWith('26') ? 'busan_livingpop' : 'seoul_livingpop'], '생활인구'),
      flowpop_dong: flow
        ? {
            ...flow,
            sources:
              flow.kind === 'measured'
                ? [src.use('gg_flowpop', '행정동 유동인구(실측)')]
                : [src.use('model_flowpop', '행정동 유동인구(추정)'), src.use('gg_flowpop', '유동인구 추정 모델 학습')],
          }
        : null,
      residents: seoul?.residents
        ? tag(seoul.residents, ['seoul_repop'], '상주인구·가구')
        : tag(sg ? { population: sg.tot_ppltn, households: sg.household_cnt, apt_households: null, scope: sgScope } : null, ['sgis_population', 'sgis_household'], '상주인구·가구'),
      resident_registry: tag(residentRegistry(loc.pnu?.slice(0, 10)), ['resident_registry'], '주민등록 인구·세대 (법정동, 1년 증감)'),
      nps_workers: tag(npsWorkers(loc.pnu?.slice(0, 10)), ['nps_workplace'], '직장인 수·소득 추정 (국민연금 사업장, 법정동)'),
      workers: seoul?.workers
        ? tag({ ...seoul.workers, businesses: sg?.corp_cnt ?? null }, sg ? ['seoul_wrcpop', 'sgis_company'] : ['seoul_wrcpop'], '직장인구·사업체')
        : tag(sg ? { workers: sg.tot_worker, businesses: sg.corp_cnt, scope: sgScope } : null, ['sgis_company'], '직장인구·사업체'),
      competitors: { ...competitors(loc, ind, radius), sources: [src.use('sbiz_store', '경쟁점·밀집도')] },
      store_change: tag(storeChange(loc, ind, radius), ['sbiz_store'], '점포 증감(분기 비교)'),
      food_license_churn: tag(ind.license_uptae ? foodChurn(loc, radius) : null, ['license_food'], '음식점 개업·폐업'),
      rent: tag(lookupRent(loc, { floorArea, floor, buildings: bld }), bld ? ['rone_rent', 'molit_building'] : ['rone_rent'], '임대료·공실률 (건물 유형은 건축물대장)'),
      site_history: tag(siteHistory(loc.lat, loc.lng), ['license_food', 'license_tobacco'], '자리의 과거 (같은 건물 개·폐업 이력)'),
      supply_pipeline: tag(supplyPipeline(loc, radius), ['arch_permit', 'housing_permit'], '앞으로 생길 상가·사무 공급과 입주 예정 세대'),
      buildings: tag(bld, ['molit_building'], '건축물대장'),
      land_price: tag(land, ['vworld_cadastral'], '공시지가'),
    },
  };
}
