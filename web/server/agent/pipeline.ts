// Runs one assessment end to end: location → industry → indicators → models → Claude → score.
import { brandInfo, sameBrandNearby, type BrandInfo, type SameBrand } from './brand.ts';
import { profitability, type Profitability } from './profit.ts';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { state } from './db.ts';
import { collectIndicators } from './indicators.ts';
import { industryFromName, resolveIndustry, type Industry } from './industry.ts';
import { analyze, llmAvailable, type Summary, type Usage, type Vision } from './llm.ts';
import { resolveLocation, type Location } from './location.ts';
import { predictSales, predictSalesV2, predictSurvival, predictSurvivalCafe, predictSurvivalCvs, type SalesResult, type SalesV2Result, type SurvivalResult } from './models.ts';
import { computeScore, type Score } from './score.ts';
import { SourceTracker, type Source } from './sources.ts';

export const DISCLAIMER = '본 결과는 공공·추정 데이터 기반 참고 자료이며 투자 또는 출자 판단을 대신하지 않습니다.';

// Messages are shown to API callers as-is, so they are written in Korean.
const num = (msg: string) =>
  z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number({ error: msg }).finite(msg).optional());
const LAT = '위도(lat)는 33~39 사이 숫자여야 합니다 (대한민국 범위)';
const LNG = '경도(lng)는 124~132 사이 숫자여야 합니다 (대한민국 범위)';
const AREA = '매장 면적(floor_area_m2)은 1~100000 사이 숫자(㎡)여야 합니다';
const FLOOR = '층(floor)은 0이 아닌 정수입니다 (1층 = 1, 지하1층 = -1)';
export const AssessmentRequest = z
  .object({
    lat: num(LAT).pipe(z.number().min(33, LAT).max(39, LAT).optional()),
    lng: num(LNG).pipe(z.number().min(124, LNG).max(132, LNG).optional()),
    address: z.string('주소(address)는 문자열이어야 합니다').trim().max(200, '주소(address)는 200자 이하입니다').optional(),
    store_name: z.string('상호(store_name)는 문자열이어야 합니다').trim().max(100, '상호(store_name)는 100자 이하입니다').optional(),
    biz_no: z.string('사업자번호(biz_no)는 문자열이어야 합니다').regex(/^\d{10}$/, '사업자번호(biz_no)는 하이픈 없이 숫자 10자리입니다 (예: 1248100998)').optional(),
    industry: z.string('업종(industry)은 문자열이어야 합니다').trim().max(50, '업종(industry)은 50자 이하입니다').optional(),
    floor_area_m2: num(AREA).pipe(z.number().min(1, AREA).max(100000, AREA).optional()),
    floor: num(FLOOR).pipe(z.number().int(FLOOR).min(-10, FLOOR).max(200, FLOOR).refine((v) => v !== 0, FLOOR).optional()),
    roadview_auto: z.preprocess((v) => v === true || v === 'true', z.boolean()).default(true),
    radius_m: z.preprocess(
      (v) => (v == null || v === '' ? 300 : Number(v)),
      z.union([z.literal(100), z.literal(300), z.literal(500), z.literal(1000)], { error: '반경(radius_m)은 100, 300, 500, 1000 중 하나입니다' }),
    ),
    client_ref: z.string().max(64, 'client_ref는 64자 이하입니다').optional(),
  })
  .refine((r) => (r.lat !== undefined && r.lng !== undefined) || r.address, { message: '위치가 필요합니다: lat+lng 또는 address 중 하나를 보내십시오' })
  .refine((r) => (r.lat === undefined) === (r.lng === undefined), { message: 'lat과 lng는 함께 보내야 합니다' });
export type AssessmentRequest = z.infer<typeof AssessmentRequest>;

export interface RoadviewImage {
  data: string;
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface AssessmentResult {
  location: Location;
  industry: Industry;
  business_check: { status: 'active' | 'suspended' | 'closed' | 'unknown'; tax_type: string | null; checked_at: string } | null;
  score: Score;
  sales_forecast: Record<string, unknown>;
  indicators: Awaited<ReturnType<typeof collectIndicators>>['indicators'];
  vision: Vision | null;
  summary: Summary | null;
  /** 상호에서 프랜차이즈 브랜드를 알아냈을 때: 공정위 정보공개 + 같은 브랜드 근접 매장 */
  brand: { info: BrandInfo | null; same_brand: SameBrand | null; sources: string[] } | null;
  /** 손익분기 시뮬레이션 (가정값 포함, 화면에서 바꿔 다시 계산) */
  profitability: (Profitability & { sources: string[] }) | null;
  provenance: Source[];
  warnings: string[];
  disclaimer: string;
  usage: Usage & { elapsed_ms: number };
}

/** 상가정보 소분류 편의점 → survival-cvs-v0 */
const CVS_CODE = 'G20405';
const CVS_BRANDS: [string, RegExp][] = [
  ['GS25', /GS\s?25|지에스\s?25/i],
  ['CU', /(^|[^A-Za-z])CU([^A-Za-z]|$)|씨유|훼미리마트/],
  ['세븐일레븐', /세븐일레븐|7-?eleven|코리아세븐/i],
  ['이마트24', /이마트\s?24|위드미/i],
  ['미니스톱', /미니스톱/],
];
function cvsBrand(...names: (string | null | undefined)[]): string | null {
  for (const n of names) for (const [b, rx] of CVS_BRANDS) if (n && rx.test(n)) return b;
  return null;
}
/** 상가정보 중분류 비알코올(I212, 소분류 카페 I21201) → survival-cafe-v0. 브랜드는 상호로 Python 쪽에서 판별 */
const isCafe = (code: string | null) => Boolean(code?.startsWith('I212'));

export function newId(prefix: string): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return prefix + Array.from(randomBytes(20), (b) => abc[b % abc.length]).join('');
}

/** 국세청 사업자 상태조회 (data.go.kr). The number is sent upstream only, never stored or logged. */
async function checkBusiness(bizNo: string): Promise<AssessmentResult['business_check']> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  const checked_at = new Date().toISOString();
  if (!key) return { status: 'unknown', tax_type: null, checked_at };
  try {
    const res = await fetch(`https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ b_no: [bizNo] }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { data?: { b_stt_cd?: string; tax_type?: string }[] };
    const d = body.data?.[0];
    const code = d?.b_stt_cd;
    return {
      status: code === '01' ? 'active' : code === '02' ? 'suspended' : code === '03' ? 'closed' : 'unknown',
      // 미등록 번호면 tax_type에 안내 문구가 오므로 상태가 확인된 경우만 싣는다
      tax_type: code ? (d?.tax_type ?? null) : null,
      checked_at,
    };
  } catch {
    return { status: 'unknown', tax_type: null, checked_at };
  }
}

/** 화면·API에 그대로 보여 주는 월 매출 산출 설명 */
const SALES_METHOD = {
  range:
    '서울 상권별·업종별 점포당 월 매출 2년치로 배운 자체 모델이 계산한 범위입니다. 가운데 값이 가장 그럴듯한 값이고, 10곳 중 8곳은 이 범위 안에 듭니다. ' +
    '상권의 유동·상주·직장인구, 점포 수, 개·폐업률, 업종을 봅니다.',
  benchmark: '서울시 상권분석서비스의 추정 매출을 같은 상권·업종의 점포 수로 나눈 값입니다. 최신 분기 기준입니다.',
  origin: '서울시가 카드 매출 등을 바탕으로 상권·업종별로 추정해 공개한 값입니다. 개별 점포의 실제 매출이 아니라 그 상권 업종의 평균입니다.',
  accuracy: '처음 보는 상권에서 오차 중앙값은 약 59%로, 업종 평균을 그대로 쓸 때보다 조금 나은 수준입니다. 그래서 신뢰 C로, 범위로만 참고하십시오.',
};

/** v2: 사내 카드매출 매장 단위로 학습, 전국 */
const SALES_V2_METHOD = {
  range:
    '전국 카드 가맹점 약 186만 곳의 실제 월 매출로 배운 자체 모델이 계산한 범위입니다. 근처 같은 업종 가게들의 매출을 기준으로, ' +
    '업종·브랜드·면적·층·같은 건물 가게들의 매출·유동인구·동네 소득 등에 따라 위아래로 조정했습니다. 가운데 값이 가장 그럴듯한 값이고, 10곳 중 8곳은 이 범위 안에 듭니다.',
  benchmark: '근처(약 750m) 같은 업종 가게들의 카드 월 매출 중앙값입니다. 가게가 5곳 이상일 때만 보여 줍니다.',
  origin: '사내 카드 가맹점 매출로 학습했습니다. 카드 결제분이라 실제 총매출보다 작아서, 서울 상권 통계와 비교한 비율(약 2배)을 곱해 총매출로 보여 줍니다.',
  accuracy:
    '학습에 쓰지 않은 지역의 실제 매출과 비교하면 프랜차이즈는 오차 중앙값 약 34%(3곳 중 2곳이 실제와 ±50% 안), 개인 매장은 약 56%입니다. ' +
    '총매출 환산 비율은 상권마다 차이가 있어(관광지는 실제보다 낮게, 전통시장은 높게 나올 수 있음) 범위로 참고하십시오.',
};

/** v3: 업종 묶음별 모델 + 건물·땅·주변 브랜드 구성. 시험 지역(학습에 안 쓴 시군구) 오차 중앙값 */
const SALES_V3_ACCURACY: Record<string, string> = {
  '카페·디저트': '카페·디저트는 오차 중앙값 약 46%(프랜차이즈 28%, 개인 54%)로, 주변 같은 업종 중앙값을 그대로 쓸 때(59%)보다 낫습니다',
  '음식점': '음식점은 오차 중앙값 약 53%(프랜차이즈 40%, 개인 55%)로, 주변 같은 업종 중앙값을 그대로 쓸 때(61%)보다 낫습니다',
  '편의점·슈퍼': '편의점·슈퍼는 오차 중앙값 약 28~32%(프랜차이즈 25%)로, 주변 편의점 중앙값을 그대로 쓸 때와 비슷합니다',
  '기타': '이 업종 묶음은 오차 중앙값 약 56%(프랜차이즈 44%)로, 개인 매장은 주변 같은 업종 중앙값을 그대로 쓸 때와 비슷합니다',
};

function salesV3Method(group: string) {
  return {
    range:
      '전국 카드 가맹점의 실제 월 매출로 업종 묶음(카페·디저트 / 음식점 / 편의점·슈퍼 / 기타)마다 따로 배운 자체 모델이 계산한 범위입니다. ' +
      '근처 같은 업종 가게들의 매출을 기준으로, 업종·브랜드·면적·층·같은 건물 가게들의 매출·건물 규모와 연식·앞 도로 폭·코너 여부·주변 가맹점 비율·유동인구·동네 소득 등에 따라 조정했습니다. ' +
      '개업 2년 차(자리 잡은 뒤) 기준이며, 가운데 값이 가장 그럴듯한 값이고 10곳 중 8곳은 이 범위 안에 듭니다.',
    benchmark: '근처(약 750m) 같은 업종 가게들의 카드 월 매출 중앙값입니다. 가게가 5곳 이상일 때만 보여 줍니다.',
    origin:
      '사내 카드 가맹점 매출로 학습했습니다. 카드 결제분이라 실제 총매출보다 작아서, 브랜드별 공정위 가맹점 평균 매출과 비교한 비율을 곱해 총매출로 보여 줍니다 ' +
      '(브랜드 비율이 없으면 같은 업종 브랜드들의 중앙값).',
    accuracy:
      `학습에 쓰지 않은 44개 시군구의 실제 카드매출 약 27만 곳과 비교하면 ${SALES_V3_ACCURACY[group] ?? SALES_V3_ACCURACY['기타']}. ` +
      '개업 2년 안 가게와 비교하면 치우침 없이 맞았고(예측이 실제의 97~98%, 오차 중앙값 약 48%), 5년 넘은 음식점보다는 약 20% 낮게 나옵니다. 값이 개업 2년 차 기준이기 때문입니다. ' +
      '이 오차는 카드매출 기준입니다. 총매출은 가게별 실제 값이 없어 검증하지 못한 추정입니다. ' +
      '매장 면적을 넣으면 음식점은 오차가 약 6%p, 카페는 약 3%p 줄어듭니다. 개업 첫 달은 이 값보다 10~15% 낮고 3개월쯤 되면 이 수준에 닿습니다.',
    closure:
      '개업 1년 안 폐업 가능성은 이 자리의 예상 매출이 주변 같은 업종보다 얼마나 높고 낮은지와 입지 조건으로 계산했습니다. 카드 매출과 인허가 폐업 신고를 이은 과거 기록으로 배웠습니다. ' +
      '학습에 쓰지 않은 지역·시기에서 시험하면, 개업 2년 안 가게 중 위험 상위 10%의 실제 폐업률은 평균의 약 2배였습니다. 어느 가게가 닫을지 맞히는 값이 아니라 위험 수준을 비교하는 값입니다.',
  };
}

function salesForecastV2(v2: Extract<SalesV2Result, { available: true }>, req: AssessmentRequest, src: SourceTracker): Record<string, unknown> {
  // 상호가 공정위 브랜드로 잡히면 프랜차이즈 값을, 아니면 개인 매장 값을 대표로
  const main = v2.brand_matched ? v2.variants.franchise : v2.variants.independent;
  const r = main.total_est ?? main.card;
  const v3 = v2.model === 'sales-v3';
  const ratio = main.calib_ratio ?? v2.calib_ratio;
  const basis = main.calib_basis === '브랜드' ? '브랜드 비율' : main.calib_basis === '업종' ? '같은 업종 브랜드 중앙값' : '전체 중앙값';
  return {
    unit: 'KRW/month',
    model_version: v2.model,
    confidence: v2.brand_matched ? 'B' : 'C',
    sources: [src.use('model_sales_v2', '월 매출 예상 범위 (전국)'), src.use('card_sales', '월 매출 학습 (사내 카드매출)')],
    method: v3 ? salesV3Method(v2.group ?? '기타') : SALES_V2_METHOD,
    p10: r.p10,
    p50: r.p50,
    p90: r.p90,
    basis: main.total_est ? 'total_est' : 'card',
    variants: v2.variants,
    calib_ratio: ratio,
    first_month_note: v2.first_month_note ?? null,
    conditions: { industry_card: v2.card_industry, group: v2.group ?? null, floor: v2.floor, site_area_m2: v2.site_area, brand: v2.brand_matched, store_name: req.store_name ?? null },
    benchmark: v2.context.neighbour_median_card
      ? { value: v2.context.neighbour_median_card, scope: `주변 약 750m 같은 업종 ${v2.context.neighbours_same_industry}곳의 카드 월 매출 중앙값`, confidence: 'B' }
      : null,
    note: v3
      ? `${v2.brand_matched ? `프랜차이즈(${v2.brand_matched})` : '개인 매장'} · 개업 2년 차 기준. 총매출은 카드 결제 규모 × ${ratio}(${basis}).${req.floor_area_m2 ? '' : ' 면적을 비우면 값이 낮게 나오는 경향이 있으니 매장 면적을 넣어 주세요 (오차도 음식점 약 6%p 줄어듭니다).'}`
      : `${v2.brand_matched ? `프랜차이즈(${v2.brand_matched})` : '개인 매장'} 기준. 총매출은 카드 결제 규모 × 환산 비율 ${v2.calib_ratio ?? '—'} (상권마다 차이가 커서 범위로만 해석).${req.floor_area_m2 ? '' : ' 매장 면적(floor_area_m2)을 넣으면 규모를 반영한다.'}`,
  };
}

function salesForecast(sales: SalesResult | null, loc: Location, ind: Industry, src: SourceTracker): Record<string, unknown> {
  const base = { unit: 'KRW/month', model_version: 'sales-v0', confidence: 'C' };
  if (!sales?.available) {
    return {
      ...base,
      p10: null,
      p50: null,
      p90: null,
      benchmark: null,
      sources: [],
      method: null,
      note:
        loc.coverage === 'seoul'
          ? '상권 또는 업종이 확인되지 않아 예측하지 않았습니다. 서울 상권분석서비스의 상권 안이고 업종이 정해지면 계산합니다.'
          : '서울 밖 월 매출은 없음 — 공개 매출 데이터가 서울(상권분석서비스 추정매출)뿐입니다. 필요한 것: 점포 단위 카드매출. 확보 방법: 기존 DW의 카드매출 백업분(~2024-06, 계약상 사용 범위 확인 중) 또는 카드사 데이터 구매.',
    };
  }
  return {
    ...base,
    sources: [src.use('model_sales', '월 매출 예상 범위'), src.use('seoul_sales', '월 매출 학습·상권 실제 평균'), src.use('seoul_store', '월 매출 점포 수')],
    method: SALES_METHOD,
    p10: sales.p10,
    p50: sales.p50,
    p90: sales.p90,
    benchmark: {
      value: sales.benchmark_per_store,
      scope: `상권 ${loc.trade_area?.name} · ${ind.name} · ${sales.quarter} · 점포 ${sales.benchmark_stores}곳 평균`,
      confidence: 'A',
    },
    note: '처음 보는 상권 기준 오차 중앙값 약 59% (docs/08 6장). 범위로 해석하십시오.',
  };
}

export async function runAssessment(req: AssessmentRequest, images: RoadviewImage[]): Promise<AssessmentResult> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const src = new SourceTracker();
  const loc = await resolveLocation(req);
  src.use('kakao_local', '위치·행정동 확인');
  if (loc.trade_area) src.use('seoul_trdar', '상권 판정');
  if (loc.sbiz_zone) src.use('sbiz_zone', '상권 판정 (전국)');
  let ind = resolveIndustry({ ...req, lat: loc.lat, lng: loc.lng });
  if (!ind.code) warnings.push('업종을 확정하지 못했습니다. industry 필드를 보내면 정확도가 올라갑니다.');
  if (!images.length && req.roadview_auto) warnings.push('로드뷰 자동 수집은 준비 중입니다. 로드뷰 캡처를 첨부하면 로드뷰 항목(10%)이 반영됩니다.');

  const salesV2P: Promise<SalesV2Result | null> = ind.code
    ? predictSalesV2({ lat: loc.lat, lng: loc.lng, pnu: loc.pnu ?? null, scls: ind.code, store_name: req.store_name, floor: req.floor, site_area: req.floor_area_m2 }).catch((e: Error) => {
        warnings.push(`매출 모델 v2 실패: ${e.message}`);
        return null;
      })
    : Promise.resolve(null);
  const [{ indicators }, survival, sales, business] = await Promise.all([
    collectIndicators(loc, ind, req.radius_m, src, req.floor_area_m2, req.floor),
    ind.code === CVS_CODE
      ? predictSurvivalCvs({ lat: loc.lat, lng: loc.lng, brand: cvsBrand(req.store_name, ind.franchise_brand), sido_nm: loc.sido_nm }).catch((e: Error) => {
          warnings.push(`편의점 생존 모델 실패: ${e.message}`);
          return null;
        })
      : isCafe(ind.code)
      ? predictSurvivalCafe({
          lat: loc.lat,
          lng: loc.lng,
          names: [req.store_name, ind.franchise_brand].filter((n): n is string => Boolean(n)),
          sido_nm: loc.sido_nm,
        }).catch((e: Error) => {
          warnings.push(`카페 생존 모델 실패: ${e.message}`);
          return null;
        })
      : ind.license_uptae
      ? predictSurvival({ lat: loc.lat, lng: loc.lng, uptae: ind.license_uptae, sido_nm: loc.sido_nm, site_area: req.floor_area_m2 }).catch((e: Error) => {
          warnings.push(`생존 모델 실패: ${e.message}`);
          return null;
        })
      : Promise.resolve(null as SurvivalResult | null),
    loc.trade_area && ind.seoul_cs
      ? predictSales({ trdar_cd: loc.trade_area.code, ind: ind.seoul_cs }).catch((e: Error) => {
          warnings.push(`매출 모델 실패: ${e.message}`);
          return null;
        })
      : Promise.resolve(null as SalesResult | null),
    req.biz_no ? checkBusiness(req.biz_no) : Promise.resolve(null),
  ]);
  if (ind.code && !ind.license_uptae && ind.code !== CVS_CODE) warnings.push('생존 확률은 지금 음식점·카페·편의점 업종만 나옵니다. 다른 업종은 업종별 인허가 데이터를 추가해 확장할 예정입니다.');
  if (ind.license_uptae && !isCafe(ind.code) && !req.floor_area_m2) warnings.push('매장 면적(floor_area_m2)이 없어 위치 전용 생존 모델을 사용했습니다.');
  if (loc.coverage === 'national') {
    const fd = indicators.flowpop_dong;
    warnings.push(
      fd
        ? `서울 밖 위치: 유동인구는 ${fd.kind === 'measured' ? '경기도 실측값' : '경기 실측으로 학습한 추정값'}을 썼습니다.`
        : '서울 밖 위치: 유동인구는 주거·직장인구로 대신했습니다.',
    );
    if (fd) warnings.push('내부 심사 한정 데이터 포함: 경기 유동인구(공공누리 2유형) 및 이를 학습한 추정값. 외부 제공 전 외부 자문이 필요합니다.');
  }

  const salesV2 = await salesV2P;
  // v2(전국, 매장 단위)가 있으면 그것을, 없으면 v0(서울 상권 평균)
  const sales_forecast = salesV2?.available ? salesForecastV2(salesV2, req, src) : salesForecast(sales, loc, ind, src);
  let vision: Vision | null = null;
  let summary: Summary | null = null;
  let usage: Usage = { llm_input_tokens: 0, llm_output_tokens: 0 };
  if (llmAvailable()) {
    const pre = computeScore({ loc, indicators, survival, sales, seoulCs: ind.seoul_cs, industryKnown: Boolean(ind.code), floorArea: req.floor_area_m2, vision: null, sources: src });
    try {
      const a = await analyze(images, { location: loc, industry: ind, score_without_roadview: pre, survival, sales_forecast, indicators, warnings });
      ({ vision, summary, usage } = a);
      if (!ind.code && vision?.observations.visible_stores.length) {
        const guess = industryFromName(vision.observations.visible_stores[0].industry);
        if (guess) {
          ind = guess;
          warnings.push(`업종을 로드뷰 간판에서 추정했습니다: ${guess.name}`);
        }
      }
    } catch (e) {
      warnings.push(`요약·로드뷰 판독 실패: ${(e as Error).message}`);
    }
  } else {
    warnings.push('ANTHROPIC_API_KEY가 설정되지 않아 로드뷰 판독과 요약을 건너뛰었습니다.');
  }

  const score = computeScore({ loc, indicators, survival, sales, seoulCs: ind.seoul_cs, industryKnown: Boolean(ind.code), floorArea: req.floor_area_m2, vision, sources: src });
  if (business) src.use('nts_status', '사업자 상태');
  if (summary) src.use('claude_vision', '요약 작성');
  const brandBlock = ind.franchise_brand
    ? {
        info: brandInfo(ind.franchise_brand),
        same_brand: sameBrandNearby(ind.franchise_brand, loc.lat, loc.lng),
        sources: [src.use('ftc_franchise', '브랜드 평균 매출·개폐점·창업 비용'), src.use('sbiz_store', '같은 브랜드 근접 매장')],
      }
    : null;
  const applied = indicators.rent?.applied ?? null;
  const pf = profitability({
    industryCode: ind.code,
    floorArea: req.floor_area_m2,
    seoulSalesP50: sales?.available ? sales.p50 : null,
    benchmarkPerStore: sales?.available ? sales.benchmark_per_store : null,
    brandAvgAnnual: brandBlock?.info?.avg_sales_annual ?? null,
    brandName: brandBlock?.info?.brand ?? null,
    brandCostTotal: brandBlock?.info?.cost?.total ?? null,
    rentPerM2: applied?.won_per_m2 ?? null,
    rentArea: indicators.rent ? `${indicators.rent.area} ${applied?.building_type ?? ''} ${applied?.floor ?? ''}`.trim() : null,
  });
  const profitBlock = ind.code
    ? {
        ...pf,
        sources: [
          ...(pf.sales_basis?.startsWith('서울') ? [src.use('model_sales', '손익 시뮬레이션 매출')] : []),
          ...(pf.sales_basis?.includes('공정위') || brandBlock?.info?.cost ? [src.use('ftc_franchise', '손익 시뮬레이션 매출·창업 비용')] : []),
          ...(pf.inputs.monthly_rent != null ? [src.use('rone_rent', '손익 시뮬레이션 임대료')] : []),
        ],
      }
    : null;
  const sh = indicators.site_history;
  // 건물 단위라 층·호를 못 나눠 간판 교체와 실제 폐업을 가를 수 없다: 숫자를 그대로 알리고 현장 확인을 권한다
  if (sh && sh.closed_within_3y >= 3 && sh.closed_last_5y >= 3)
    warnings.push(`이 건물에서 3년을 못 넘기고 문 닫은 음식점·카페·편의점이 ${sh.closed_within_3y}곳입니다 (전체 ${sh.total}곳 중 폐업 ${sh.closed}곳, 폐업까지 중앙값 ${sh.median_years_closed ?? '—'}년, 최근 5년 폐업 ${sh.closed_last_5y}곳). 같은 자리인지(층·호)와 폐업 이유를 현장에서 확인하십시오.`);
  const sb = brandBlock?.same_brand;
  if (sb && sb.within_500 - (sb.at_site ? 1 : 0) > 0)
    warnings.push(
      `같은 브랜드(${ind.franchise_brand}) 매장이 반경 500m 안에 ${sb.within_500 - (sb.at_site ? 1 : 0)}곳 있습니다 (가장 가까운 곳 ${sb.nearest.find((n) => n.distance_m > 15)?.distance_m ?? '—'}m). 가맹계약의 영업지역 보호 범위를 확인하십시오.`,
    );
  const provenance = src.list();
  return {
    location: loc,
    industry: ind,
    business_check: business,
    score,
    sales_forecast,
    indicators,
    vision,
    summary,
    brand: brandBlock,
    profitability: profitBlock,
    provenance,
    warnings,
    disclaimer: DISCLAIMER,
    usage: { ...usage, elapsed_ms: Date.now() - t0 },
  };
}

// --- persistence -----------------------------------------------------------

export type Status = 'queued' | 'running' | 'done' | 'partial' | 'failed';

export function saveNew(id: string, req: AssessmentRequest) {
  const { biz_no, ...safe } = req;
  state
    .prepare('insert into assessment (id, created_at, status, request_json) values (?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'queued', JSON.stringify({ ...safe, biz_no_provided: Boolean(biz_no) }));
}

export function setStatus(id: string, status: Status, result?: unknown) {
  state
    .prepare('update assessment set status = ?, result_json = coalesce(?, result_json), completed_at = case when ? in (\'done\', \'partial\', \'failed\') then ? else completed_at end where id = ?')
    .run(status, result === undefined ? null : JSON.stringify(result), status, new Date().toISOString(), id);
}

/** Recent assessments for the 심사 화면 history list (newest first). */
export function list(limit: number) {
  const rows = state
    .prepare('select id, created_at, status, request_json, result_json from assessment order by created_at desc limit ?')
    .all(limit) as { id: string; created_at: string; status: Status; request_json: string; result_json: string | null }[];
  return rows.map((r) => {
    const req = JSON.parse(r.request_json) as Record<string, unknown>;
    const res = r.result_json ? (JSON.parse(r.result_json) as Partial<AssessmentResult> & { error?: { title: string } }) : {};
    return {
      assessment_id: r.id,
      created_at: r.created_at,
      status: r.status,
      client_ref: (req.client_ref as string) ?? null,
      address: res.location?.address_road ?? res.location?.address_jibun ?? (req.address as string) ?? null,
      industry: res.industry?.name ?? (req.industry as string) ?? null,
      score: res.score?.total ?? null,
      grade: res.score?.grade ?? null,
      error: res.error?.title ?? null,
    };
  });
}

export function load(id: string) {
  const row = state.prepare('select * from assessment where id = ?').get(id) as
    | { id: string; created_at: string; completed_at: string | null; status: Status; request_json: string; result_json: string | null }
    | undefined;
  if (!row) return undefined;
  const request = JSON.parse(row.request_json) as Record<string, unknown>;
  return {
    assessment_id: row.id,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    client_ref: (request.client_ref as string) ?? null,
    ...(row.result_json ? (JSON.parse(row.result_json) as object) : {}),
  };
}
