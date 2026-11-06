// Response shapes of the Agent API (server/openapi.yaml). Only the fields the 심사 화면 reads.
export type Confidence = 'A' | 'B' | 'C';
export type Status = 'queued' | 'running' | 'done' | 'partial' | 'failed';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface Component {
  key: 'survival' | 'demand' | 'competition' | 'sales_power' | 'vision';
  label: string;
  value: number | null;
  weight: number;
  basis: string;
  confidence: Confidence;
  reason: string;
  method: string;
  inputs: { label: string; value: string; source?: string }[];
  sources: string[];
}

export interface Explanation {
  formula: string;
  grade_reason: string;
  lifts: string[];
  drags: string[];
  missing: string[];
  rules: string[];
}

export interface Source {
  key: string;
  provider: string;
  dataset: string;
  api: string;
  fields: string;
  scope: string;
  as_of: string;
  used_for: string[];
  /** 이용 범위 제한 (예: 내부 심사 한정) */
  license?: string;
}

type Sourced = { sources: string[] };

export interface BuildingInfo {
  name: string;
  kind: string;
  main_use: string;
  detail_use: string;
  structure: string;
  floors_above: number | null;
  floors_below: number | null;
  height_m: number | null;
  total_area_m2: number | null;
  building_area_m2: number | null;
  site_area_m2: number | null;
  coverage_ratio: number | null;
  floor_area_ratio: number | null;
  approval_date: string | null;
  age_years: number | null;
  households: number | null;
  elevators: number | null;
  parking: number | null;
  seismic_design: boolean | null;
}

export interface FloorInfo {
  building: string;
  floor: string;
  use: string;
  detail_use: string;
  area_m2: number | null;
}

export type RentType = '중대형 상가' | '소규모 상가' | '집합 상가';
export interface RentByType {
  type: RentType;
  quarter: string;
  floors: { floor: string; won_per_m2: number }[];
  vacancy_rate: number | null;
}
export interface RentApplied {
  building_type: RentType;
  type_reason: string;
  floor: string;
  floor_input: number | null;
  won_per_m2: number;
  area_m2: number | null;
  monthly_rent: number | null;
  fallback: string | null;
}

export interface Assessment {
  assessment_id: string;
  status: Status;
  created_at: string;
  completed_at: string | null;
  client_ref: string | null;
  error?: { title: string; status: number; detail?: string };
  location?: {
    lat: number;
    lng: number;
    address_road: string | null;
    address_jibun: string | null;
    adm_nm: string | null;
    sgg_nm: string | null;
    sido_nm: string | null;
    trade_area: { code: string; name: string; type: string; distance_m: number } | null;
    sbiz_zone?: { no: string; name: string; sgg_nm: string; area_m2: number } | null;
    coverage: 'seoul' | 'national';
  };
  industry?: { code: string | null; name: string | null; mcls_name: string | null; method: string; franchise_brand: string | null; confidence: Confidence };
  business_check?: { status: 'active' | 'suspended' | 'closed' | 'unknown'; tax_type: string | null } | null;
  score?: { total: number | null; grade: Grade | null; survival_3y_prob: number | null; components: Component[]; evidence_weight: number; explanation: Explanation };
  sales_forecast?: {
    p10: number | null;
    p50: number | null;
    p90: number | null;
    benchmark: { value: number | null; scope: string } | null;
    confidence: Confidence;
    note?: string;
    sources?: string[];
    method?: { range: string; benchmark: string; origin: string; accuracy: string; closure?: string } | null;
    /** v2부터 */
    model_version?: string;
    basis?: 'total_est' | 'card';
    variants?: Record<'franchise' | 'independent', { card: { p10: number; p50: number; p90: number }; total_est: { p10: number; p50: number; p90: number } | null; brand: string | null; calib_ratio?: number; calib_basis?: string; closure?: { prob_12m: number; peer_rate: number | null } | null }>;
    calib_ratio?: number | null;
    first_month_note?: string | null;
    conditions?: { industry_card: string; floor: string; site_area_m2: number | null; brand: string | null; store_name: string | null };
  };
  indicators?: {
    floating_pop: ({ quarter_total: number; by_time: Record<string, number>; share_2030: number; weekend_share: number; scope: string } & Sourced) | null;
    living_pop: ({ hourly_avg: number; by_time: Record<string, number>; scope: string } & Sourced) | null;
    flowpop_dong?: ({
      kind: 'measured' | 'estimated';
      hourly_avg: number;
      range: [number, number] | null;
      by_time: Record<string, number>;
      out_of_range: number;
      scope: string;
      license: string;
    } & Sourced) | null;
    residents: ({ population: number | null; households: number | null; scope: string } & Sourced) | null;
    /** 국민연금 가입 사업장, 법정동 (예전 평가에는 없음) */
    nps_workers?: ({
      workplaces: number;
      members_small: number;
      members_all: number;
      monthly_income_est: number | null;
      top_employers: { name: string; members: number; industry: string }[];
      as_of: string;
      scope: string;
    } & Sourced) | null;
    /** 주민등록 법정동 월별 (없던 예전 평가에는 없음) */
    resident_registry?: ({
      population: number;
      households: number;
      persons_per_household: number | null;
      population_change_pct: number | null;
      households_change_pct: number | null;
      share_20_39: number | null;
      share_60_plus: number | null;
      as_of: string;
      scope: string;
    } & Sourced) | null;
    workers: ({ workers: number | null; businesses: number | null; scope: string } & Sourced) | null;
    competitors: {
      radius_m: number;
      same_industry: number | null;
      all_stores: number;
      branch_share: number | null;
      /** 예전 평가에는 없음 */
      franchise_share?: number | null;
      location_quotient: number | null;
      nearest: { name: string; brand?: string | null; industry: string; distance_m: number; floor: string | null; lat: number; lng: number }[];
      scope: string;
    } & Sourced;
    store_change?: ({
      radius_m: number;
      from: string;
      to: string;
      same_industry: { closed: number; opened: number; before: number } | null;
      all: { closed: number; opened: number; before: number };
    } & Sourced) | null;
    food_license_churn: ({ radius_m: number; active: number; opened_12m: number; closed_12m: number } & Sourced) | null;
    /** 예전 평가에는 없음 */
    supply_pipeline?: ({
      under_construction_m2: { retail: number; office: number; lodging: number; other: number; buildings: number };
      permitted_m2: number;
      upcoming_households_3y: number;
      projects: { kind: 'commercial' | 'housing'; name: string | null; purpose: string; size: string; schedule: string }[];
      scope: string;
    } & Sourced) | null;
    site_history?: ({
      radius_m: number;
      total: number;
      active: number;
      closed: number;
      closed_within_3y: number;
      median_years_closed: number | null;
      closed_last_5y: number;
      by_kind: { kind: string; total: number; closed: number }[];
      items: { name: string; kind: string; uptae: string | null; opened: string | null; closed: string | null; years: number | null; state: string }[];
      switches: number;
      coverage: string;
    } & Sourced) | null;
    land_price: ({ official_price_per_m2: number; year_month: string | null } & Sourced) | null;
    rent?: ({
      area: string;
      match: '상권' | '시도 평균';
      distance_m: number | null;
      quarter: string;
      building_type: string;
      rent_by_floor: { floor: string; won_per_m2: number }[];
      small_shop_1f_won_per_m2: number | null;
      vacancy_rate: { mid_large: number | null; small: number | null; quarter: string | null };
      est_monthly_rent_1f: number | null;
      /** 건물 유형별 층별 단가 (이 변경 전 평가에는 없음) */
      by_type?: RentByType[];
      applied?: RentApplied | null;
      note: string;
    } & Sourced) | null;
    buildings?: ({ address: string | null; buildings: BuildingInfo[]; floors: FloorInfo[]; floors_truncated: boolean } & Sourced) | null;
  };
  vision?: {
    area_type: string;
    scores: Record<string, number>;
    observations: { road: string; sidewalk: string; vacancy_signs: string[] };
    cannot_tell: string[];
  } | null;
  summary?: { headline: string; opportunities: string[]; risks: string[]; unknowns: string[] } | null;
  brand?: {
    info: {
      brand: string;
      corp: string;
      industry: string;
      year: string;
      stores: number;
      opened: number;
      closed: number;
      renamed: number;
      closure_rate: number | null;
      avg_sales_annual: number | null;
      avg_sales_per_3_3m2: number | null;
      cost: { join: number | null; edu: number | null; deposit: number | null; etc: number | null; total: number | null } | null;
      trend: { year: string; stores: number; avg_sales_annual: number | null; closed: number }[];
    } | null;
    same_brand: { radius_m: number; within_500: number; within_1000: number; at_site: boolean; nearest: { name: string; distance_m: number; floor: string | null; lat: number; lng: number }[] } | null;
    sources: string[];
  } | null;
  profitability?: {
    kind: 'food' | 'cafe' | 'cvs' | 'other';
    kind_label: string;
    sales_basis: string | null;
    rent_basis: string | null;
    area_m2: number;
    area_assumed: boolean;
    inputs: import('../shared/profit').ProfitInputs;
    outputs: import('../shared/profit').ProfitOutputs;
    notes: string[];
    sources: string[];
  } | null;
  provenance?: Source[];
  warnings?: string[];
  disclaimer?: string;
}

export interface HistoryItem {
  assessment_id: string;
  created_at: string;
  status: Status;
  address: string | null;
  industry: string | null;
  score: number | null;
  grade: Grade | null;
  error: string | null;
}

export interface Industry {
  code: string;
  name: string;
  mcls_name: string;
  lcls_name: string;
  survival_model: boolean;
}

export interface Place {
  lat: number;
  lng: number;
  label: string;
  road?: string;
  jibun?: string;
}

// ── 상권 분석 (GET /areas, /areas/report) ──────────────────

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

type Share = { name: string; count: number; share: number };

export interface AreaReport {
  area: {
    id: string;
    name: string;
    kind: AreaCandidate['kind'];
    basis: string;
    lat: number;
    lng: number;
    radius_m: number | null;
    area_m2: number;
    polygons: number[][][][] | null;
    sido_nm: string | null;
    sgg_nm: string | null;
  };
  industry: {
    total: number;
    baseline_area: string;
    lcls: (Share & { lq: number | null; mcls: Share[] })[];
    food: Share[];
    top_scls: Share[];
    floors: Share[];
    branch_share: number;
  } & Sourced;
  points: [number, number, string, string, string, string][];
  store_change: ({ from: string; to: string; all: { before: number; closed: number; opened: number }; by_lcls: { name: string; before: number; closed: number; opened: number }[] } & Sourced) | null;
  food_trend: ({ active: number; recent3?: { opened: number; closed: number }; prev3?: { opened: number; closed: number }; by_year: { year: string; opened: number; closed: number }[]; as_of: string } & Sourced) | null;
  lifecycle?: { stage: '성장' | '성숙' | '쇠퇴' | '재생' | '판단 보류'; reason: string; evidence: string[]; metrics: { net_recent3: number; net_prev3: number; open_momentum: number | null; rent_1f_change: number | null } | null } & Sourced;
  population: {
    seoul:
      | ({
          quarter: string;
          trade_areas: string[];
          floating: { quarter_total: number; daily_avg: number; by_time: Record<string, number>; by_age: Record<string, number>; weekend_share: number; male_share: number } | null;
          residents: { population: number; households: number; apt_households: number } | null;
          workers: { workers: number } | null;
        } & Sourced)
      | null;
    dongs: {
      adm_cd: string;
      adm_nm: string;
      store_share: number;
      population: number | null;
      households: number | null;
      workers: number | null;
      businesses: number | null;
      sgis_year: string | null;
      living_pop_hourly: number | null;
      flowpop_hourly: { kind: 'measured' | 'estimated'; value: number; range: [number, number] | null; license: string } | null;
    }[];
    dong_sources: string[];
    /** 예전 리포트에는 없음 */
    demand?: ({
      bjd_count: number;
      workers: { members: number; income: number | null; workplaces: number } | null;
      residents: { population: number; households: number; change_pct: number | null; as_of: string } | null;
      scope: string;
    } & Sourced) | null;
  };
  supply_pipeline?: ({
    under_construction_m2: { retail: number; office: number; lodging: number; other: number; buildings: number };
    permitted_m2: number;
    upcoming_households_3y: number;
    projects: { kind: 'commercial' | 'housing'; name: string | null; purpose: string; size: string; schedule: string }[];
    scope: string;
  } & Sourced) | null;
  transport: {
    radius_m: number;
    stations: { name: string; lines: string[]; distance_m: number; lat: number; lng: number; ridership: { daily_avg: number; lines: string[]; peak_hour: string | null } | null }[];
    parking_lots: number;
    bus_stops: { count: number; names: number; nearest: string[]; points: [number, number, string][] };
    facilities: { code: string; label: string; count: number; nearest: string[] }[];
  } & Sourced;
  rent: (NonNullable<NonNullable<Assessment['indicators']>['rent']>) | null;
  sales: ({
    quarter: string;
    monthly_total: number;
    weekend_share: number;
    by_time: Record<string, number>;
    top: { industry: string; monthly: number; stores: number | null; per_store: number | null }[];
    note: string;
  } & Sourced) | null;
  gaps: string[];
  warnings: string[];
  provenance: Source[];
  generated_at: string;
  elapsed_ms: number;
}

export interface OpportunityResult {
  industry: { code: string; name: string };
  sido: string | null;
  sgg?: string | null;
  count: number;
  count_filtered?: number;
  sgg_options?: { name: string; zones: number }[];
  items: {
    id: string;
    rank?: number;
    name: string;
    sido: string;
    sgg: string;
    area_m2: number;
    stores_total: number;
    same_industry: number;
    lq: number;
    activity: number;
    room: number;
    /** 예전 서버 응답에는 없음 */
    upcoming_hh?: number;
    growth?: number;
    upcoming?: { name: string | null; hh: number; move_in: string; distance_m: number }[];
    score: number;
    note: string | null;
  }[];
  method: string;
  as_of?: string;
}

export interface WatchSignal {
  /** change = 등록 이후 달라진 것, state = 지금 주변 상태·동향 */
  group: 'change' | 'state';
  level: 'warn' | 'watch' | 'info';
  text: string;
}
export interface WatchItem {
  id: string;
  name: string;
  address: string | null;
  industry: string | null;
  brand: string | null;
  created_at: string;
  level: 'warn' | 'watch' | 'ok';
  signals: WatchSignal[];
}
type WatchSnap = {
  at: string;
  all_stores: number;
  same_industry: number;
  same_brand: number;
  license: { svc: string; active: number; opened_12m: number; closed_12m: number; closed_prev_12m: number; as_of: string } | null;
  rent_1f: { won_per_m2: number; quarter: string; area: string } | null;
};
export interface WatchDetail extends WatchItem {
  lat: number;
  lng: number;
  radius_m: number;
  memo: string | null;
  new_competitors: { id: string; name: string; d: number }[];
  gone_competitors: { id: string; name: string; d: number }[];
  new_same_brand: { id: string; name: string; d: number }[];
  store_compare: string;
  rules: string;
  baseline: WatchSnap;
  current: WatchSnap;
}
