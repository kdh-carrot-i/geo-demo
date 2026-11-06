// Step 5: combine model output and indicators into score-v0.1 (docs/08_API_명세.md 4장).
// Every component carries how it was computed (method), the numbers it used (inputs) and a
// one-line reason for its value, and the score carries the arithmetic and the grade decision.
import { all, LATEST_Q, one } from './db.ts';
import type { Confidence } from './industry.ts';
import type { Indicators } from './indicators.ts';
import type { Location } from './location.ts';
import type { SalesResult, SurvivalResult } from './models.ts';
import type { Vision } from './llm.ts';
import type { SourceTracker } from './sources.ts';

export const SCORE_VERSION = 'score-v0.1';
const WEIGHTS = { survival: 0.5, demand: 0.15, competition: 0.15, sales_power: 0.1, vision: 0.1 } as const;
type Key = keyof typeof WEIGHTS;
const GRADE_TEXT = { A: '우수', B: '양호', C: '보통', D: '주의', E: '위험' } as const;

export interface Input {
  label: string;
  value: string;
  /** source key (sources.ts) */
  source?: string;
}

export interface Component {
  key: Key;
  label: string;
  value: number | null;
  weight: number;
  basis: string;
  confidence: Confidence;
  /** why the value came out this way, in one sentence */
  reason: string;
  /** how the value is computed */
  method: string;
  inputs: Input[];
  sources: string[];
}

export interface Explanation {
  /** the weighted-average arithmetic, e.g. "(25.3×50% + …) ÷ 90% = 39.0" */
  formula: string;
  grade_reason: string;
  /** components that pulled the score up / down the most */
  lifts: string[];
  drags: string[];
  missing: string[];
  rules: string[];
}

export interface Score {
  total: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | null;
  survival_3y_prob: number | null;
  components: Component[];
  /** Sum of weights that had data (1 = every component). Grade A requires >= 0.75 and the survival model; below 0.3 no grade. */
  evidence_weight: number;
  explanation: Explanation;
  model_version: string;
}

/** "상위 N%" wording; never 0%. */
const top = (p: number) => `상위 ${Math.max(1, Math.round(100 - p))}%`;
const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());
const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const man = (v: number) => `${Math.round(v / 1e4).toLocaleString()}만 원`;

function percentile(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return (100 * lo) / Math.max(1, sorted.length);
}

const sortedCol = (sql: string) => all<{ v: number }>(sql).map((r) => r.v).filter((v) => v != null).sort((a, b) => a - b);
let ref: Record<string, number[]> | undefined;
function refs() {
  ref ??= {
    flpop: sortedCol(`select tot_flpop_co v from ta_flpop_q where stdr_yyqu_cd = '${LATEST_Q}'`),
    wrcpop: sortedCol(`select tot_wrc_popltn_co v from ta_wrcpop_q where stdr_yyqu_cd = '${LATEST_Q}'`),
    repop: sortedCol(`select tot_repop_co v from ta_repop_q where stdr_yyqu_cd = '${LATEST_Q}'`),
    sg_pop: sortedCol('select tot_ppltn v from sgis_adm_stats'),
    sg_worker: sortedCol('select tot_worker v from sgis_adm_stats'),
    // 서울 밖 행정동 유동인구 (경기 실측 + 추정)
    flow_dong: sortedCol("select hourly_avg v from flowpop_est_dong where adm_cd not like '11%'"),
  };
  return ref;
}

function base(key: Key, label: string, confidence: Confidence): Component {
  return { key, label, value: null, weight: WEIGHTS[key], basis: '', confidence, reason: '', method: '', inputs: [], sources: [] };
}

function survival(s: SurvivalResult | null, industryKnown: boolean, floorArea: number | undefined, src: SourceTracker): Component {
  const c = base('survival', '3년 생존', s?.variant === 'full' ? 'B' : 'C');
  c.method =
    '전국 일반음식점 31.8만 곳(2018~2022 개업)의 실제 영업·폐업 기록으로 배운 자체 모델이 "지금 이 자리에 개업하면 3년 안에 폐업할 확률"을 계산합니다. ' +
    '이 확률을 같은 업태의 실제 신규 개업 가게(2021 하반기~2022)들과 비교해, 이 자리보다 폐업 위험이 높은 곳의 비율을 0~100점으로 보여 줍니다. ' +
    '면적을 넣으면 위험한 자리를 더 잘 가려냅니다 (가려내는 힘은 0.5(무작위)~1(완벽) 척도로 면적이 있으면 0.67, 없으면 0.60).';
  if (!s) {
    c.basis = industryKnown ? '음식점·카페·편의점 외 업종은 준비 중 — 업종별 인허가 API 활용신청 후 같은 방식으로 제공' : '업종 미확정 — industry를 보내면 계산';
    c.reason = c.basis;
    return c;
  }
  if (s.model === 'cvs') return survivalCvs(c, s, src);
  if (s.model === 'cafe') return survivalCafe(c, s, src);
  c.value = s.score;
  c.sources = [src.use('model_survival', '3년 생존 확률'), src.use('license_food', '생존 모델 입력(주변 음식점 이력)')];
  const f = s.features;
  c.basis = `3년 내 폐업 확률 ${pct(s.close_3y_prob)} (같은 업태 신규 개업 ${s.reference_n.toLocaleString()}곳과 비교)${s.variant === 'location' ? ' · 면적 미입력' : ''}`;
  c.reason = `3년 내 폐업 확률이 ${pct(s.close_3y_prob)}로, 같은 업태(${s.uptae_used}) 신규 개업 ${s.reference_n.toLocaleString()}곳 중 이 자리보다 폐업 위험이 높은 곳이 ${Math.round(s.score)}%라서 ${Math.round(s.score)}점이다.`;
  c.inputs = [
    { label: '3년 내 폐업 확률', value: pct(s.close_3y_prob, 1), source: 'model_survival' },
    { label: '비교 대상', value: `같은 업태 '${s.uptae_used}' 신규 개업 ${s.reference_n.toLocaleString()}곳`, source: 'model_survival' },
    { label: '사용 모델', value: s.variant === 'full' ? `면적 포함 (입력 ${floorArea}㎡)` : '위치 전용 (면적 미입력)', source: 'model_survival' },
    { label: '반경 300m 영업 중 음식점', value: `${n0(f.active_300)}곳 (100m 안 ${n0(f.active_100)}곳)`, source: 'license_food' },
    { label: '반경 300m 같은 업태', value: `${n0(f.same_uptae_300)}곳`, source: 'license_food' },
    { label: '최근 1년 주변 개업 / 폐업', value: `${n0(f.opened_12m_300)} / ${n0(f.closed_12m_300)}곳`, source: 'license_food' },
    { label: '주변 회전율', value: f.churn_12m == null ? '—' : `${pct(f.churn_12m)} (최근 1년 개업+폐업 ÷ 영업 중)`, source: 'license_food' },
    {
      label: '주변 선배 점포 3년 폐업률',
      value: f.hist_close3y_rt_300 == null ? '이력 없음' : `${pct(f.hist_close3y_rt_300)} (3~6년 전 개업 ${n0(f.hist_n_300)}곳 기준)`,
      source: 'license_food',
    },
  ];
  return c;
}

/** 편의점: 담배소매업 인허가로 학습한 survival-cvs-v0 */
function survivalCvs(c: Component, s: SurvivalResult, src: SourceTracker): Component {
  const f = s.features;
  c.confidence = 'C';
  c.method =
    '전국 편의점(GS25·CU·세븐일레븐·이마트24·미니스톱) 2019~2020 개업 가게의 실제 영업·폐업 기록으로 배운 자체 모델이 ' +
    '"지금 이 자리에 열면 3년 안에 실제로 폐업할 확률"을 계산합니다. 폐업 직후 20m 안에서 다시 허가가 난 경우(간판 교체·양도)는 폐업으로 세지 않습니다 ' +
    '(서류상 폐업의 68%가 이 경우입니다). 같은 브랜드의 실제 신규 개점 가게(2021 하반기~2022)들과 비교해 점수를 냅니다. 가려내는 힘은 0.5(무작위)~1(완벽) 척도로 0.61이고, 위험이 높다고 본 상위 10%의 실제 폐업률은 하위 10%의 3.3배였습니다.';
  c.value = s.score;
  c.sources = [src.use('model_survival_cvs', '3년 생존 확률 (편의점)'), src.use('license_tobacco', '생존 모델 입력(주변 편의점 이력)'), src.use('license_food', '생존 모델 입력(주변 음식점 수)')];
  c.basis = `3년 내 폐업 확률 ${pct(s.close_3y_prob, 1)} (${s.uptae_used} 신규 개점 ${s.reference_n.toLocaleString()}곳과 비교)`;
  c.reason = `3년 내 실제 폐업 확률이 ${pct(s.close_3y_prob, 1)}로, ${s.uptae_used} 신규 개점 ${s.reference_n.toLocaleString()}곳 중 이 자리보다 폐업 위험이 높은 곳이 ${Math.round(s.score)}%라서 ${Math.round(s.score)}점이다. 편의점은 전체 폐업률이 낮아(약 6%) 확률 차이가 작아도 순위 차이는 크다.`;
  c.inputs = [
    { label: '3년 내 폐업 확률', value: pct(s.close_3y_prob, 1), source: 'model_survival_cvs' },
    { label: '비교 대상', value: `${s.uptae_used} 신규 개점 ${s.reference_n.toLocaleString()}곳`, source: 'model_survival_cvs' },
    { label: '가장 가까운 편의점', value: f.nearest_cvs_m == null || f.nearest_cvs_m >= 450 ? '300m 안 없음' : `${n0(f.nearest_cvs_m)}m`, source: 'license_tobacco' },
    { label: '반경 300m 영업 중 편의점', value: `${n0(f.active_cvs_300)}곳 (100m 안 ${n0(f.active_cvs_100)}곳, 같은 브랜드 ${n0(f.same_brand_300)}곳)`, source: 'license_tobacco' },
    { label: '반경 300m 담배 판매점 전체', value: `${n0(f.active_all_300)}곳 (슈퍼·마트 포함)`, source: 'license_tobacco' },
    { label: '최근 1년 주변 편의점 개점 / 실제 폐업', value: `${n0(f.opened_cvs_12m_300)} / ${n0(f.closed_cvs_12m_300)}곳`, source: 'license_tobacco' },
    { label: '반경 300m 영업 중 음식점 (수요 대리 지표)', value: `${n0(f.food_active_300)}곳`, source: 'license_food' },
    {
      label: '주변 선배 편의점 3년 폐업률',
      value: f.hist_close3y_rt_300 == null ? '이력 없음' : `${pct(f.hist_close3y_rt_300)} (3~6년 전 개점 ${n0(f.hist_n_300)}곳 기준)`,
      source: 'license_tobacco',
    },
  ];
  return c;
}

/** 카페: 휴게음식점 커피숍 인허가로 학습한 survival-cafe-v0 */
function survivalCafe(c: Component, s: SurvivalResult, src: SourceTracker): Component {
  const f = s.features;
  c.confidence = 'C';
  c.method =
    '전국 카페 2019~2020 개업 가게의 실제 영업·폐업 기록으로 배운 자체 모델이 "지금 이 자리에 열면 3년 안에 실제로 폐업할 확률"을 계산합니다. ' +
    '폐업 직후 20m 안에서 다시 카페 허가가 난 경우(간판 교체·양도)는 폐업으로 세지 않습니다 (카페 폐업의 18%). ' +
    '같은 브랜드(브랜드를 모르면 개인·기타 카페)의 실제 신규 개점 가게(2021 하반기~2022)들과 비교해 점수를 냅니다. ' +
    '가려내는 힘은 0.5(무작위)~1(완벽) 척도로 0.65지만 대부분 브랜드 차이(대형 프랜차이즈 3년 폐업 약 4%, 개인 카페 35%)에서 나옵니다. 개인 카페끼리는 0.57(위험 상위 10%의 실제 폐업 42%, 하위 10%는 21%)이라, 자리만으로 가려내는 힘은 약합니다.';
  c.value = s.score;
  c.sources = [src.use('model_survival_cafe', '3년 생존 확률 (카페)'), src.use('license_rest_cafe', '생존 모델 입력(주변 카페 이력)'), src.use('license_food', '생존 모델 입력(주변 음식점 수)')];
  c.basis = `3년 내 폐업 확률 ${pct(s.close_3y_prob, 1)} (${s.uptae_used} 신규 개점 ${s.reference_n.toLocaleString()}곳과 비교)`;
  c.reason = `3년 내 실제 폐업 확률이 ${pct(s.close_3y_prob, 1)}로, ${s.uptae_used} 신규 개점 ${s.reference_n.toLocaleString()}곳 중 이 자리보다 폐업 위험이 높은 곳이 ${Math.round(s.score)}%라서 ${Math.round(s.score)}점이다.`;
  c.inputs = [
    { label: '3년 내 폐업 확률', value: pct(s.close_3y_prob, 1), source: 'model_survival_cafe' },
    { label: '비교 대상', value: `${s.uptae_used} 신규 개점 ${s.reference_n.toLocaleString()}곳`, source: 'model_survival_cafe' },
    { label: '가장 가까운 카페', value: f.nearest_cafe_m == null || f.nearest_cafe_m >= 450 ? '300m 안 없음' : `${n0(f.nearest_cafe_m)}m`, source: 'license_rest_cafe' },
    { label: '반경 300m 영업 중 카페', value: `${n0(f.active_cafe_300)}곳 (100m 안 ${n0(f.active_cafe_100)}곳, 프랜차이즈 ${n0(f.active_brand_cafe_300)}곳, 같은 브랜드 ${n0(f.same_brand_300)}곳)`, source: 'license_rest_cafe' },
    { label: '반경 300m 휴게음식점 전체', value: `${n0(f.active_all_300)}곳 (제과·분식·편의점 등 포함)`, source: 'license_rest_cafe' },
    { label: '최근 1년 주변 카페 개업 / 실제 폐업', value: `${n0(f.opened_cafe_12m_300)} / ${n0(f.closed_cafe_12m_300)}곳`, source: 'license_rest_cafe' },
    { label: '반경 300m 영업 중 음식점 (수요 대리 지표)', value: `${n0(f.food_active_300)}곳`, source: 'license_food' },
    {
      label: '주변 선배 카페 3년 폐업률',
      value: f.hist_close3y_rt_300 == null ? '이력 없음' : `${pct(f.hist_close3y_rt_300)} (3~6년 전 개업 ${n0(f.hist_n_300)}곳 기준)`,
      source: 'license_rest_cafe',
    },
  ];
  return c;
}

function demand(loc: Location, ind: Indicators): Component {
  const r = refs();
  const c = base('demand', '수요', 'A');
  if (loc.trade_area && ind.floating_pop && ind.workers?.workers != null && ind.residents?.population != null) {
    const p = [percentile(r.flpop, ind.floating_pop.quarter_total), percentile(r.wrcpop, ind.workers.workers), percentile(r.repop, ind.residents.population)];
    c.value = 0.5 * p[0] + 0.25 * p[1] + 0.25 * p[2];
    c.method = `서울 ${r.flpop.length.toLocaleString()}개 상권 안에서 유동·직장·상주인구가 각각 몇 번째인지(백분위)를 구해 유동 50% + 직장 25% + 상주 25%로 평균한다.`;
    c.basis = `서울 상권 중 유동 ${top(p[0])}, 직장 ${top(p[1])}, 상주 ${top(p[2])}`;
    const names = ['유동', '직장', '상주'];
    const best = names[p.indexOf(Math.max(...p))];
    const worst = names[p.indexOf(Math.min(...p))];
    c.reason = `${best}인구는 서울 상권 중 ${top(Math.max(...p))}로 많지만 ${worst}인구가 ${top(Math.min(...p))}로 적어, 가중평균 ${c.value.toFixed(1)}점이다.`;
    c.inputs = [
      { label: '유동인구 (분기 합계)', value: `${n0(ind.floating_pop.quarter_total)}명 · 백분위 ${p[0].toFixed(0)} (${top(p[0])})`, source: 'seoul_flpop' },
      { label: '직장인구', value: `${n0(ind.workers.workers)}명 · 백분위 ${p[1].toFixed(0)} (${top(p[1])})`, source: 'seoul_wrcpop' },
      { label: '상주인구', value: `${n0(ind.residents.population)}명 · 백분위 ${p[2].toFixed(0)} (${top(p[2])})`, source: 'seoul_repop' },
      { label: '계산', value: `${p[0].toFixed(1)}×0.5 + ${p[1].toFixed(1)}×0.25 + ${p[2].toFixed(1)}×0.25 = ${c.value.toFixed(1)}` },
    ];
    c.sources = [...ind.floating_pop.sources, ...ind.workers.sources.filter((k) => k !== 'sgis_company'), ...ind.residents.sources];
  } else if (ind.flowpop_dong && ind.residents?.population != null && ind.workers?.workers != null) {
    const fd = ind.flowpop_dong;
    const measured = fd.kind === 'measured';
    const p = [percentile(r.flow_dong, fd.hourly_avg), percentile(r.sg_worker, ind.workers.workers), percentile(r.sg_pop, ind.residents.population)];
    c.value = 0.5 * p[0] + 0.25 * p[1] + 0.25 * p[2];
    c.confidence = measured ? 'B' : 'C';
    c.method =
      `서울 밖 ${r.flow_dong.length.toLocaleString()}개 행정동 안에서 유동인구(시간당 평균)의 백분위, 전국 행정동 안에서 종사자·인구의 백분위를 구해 ` +
      '유동 50% + 종사자 25% + 상주 25%로 평균한다 (서울 상권과 같은 비율). ' +
      (measured ? '유동인구는 경기도 실측값이다.' : '유동인구는 경기 실측 408개 행정동으로 학습한 추정값이다 (시 단위로 맞춰 보면 오차 중앙값 14%).') +
      ' 내부 심사 한정 데이터다.';
    c.basis = `행정동 중 유동 ${top(p[0])}${measured ? '' : '(추정)'}, 종사자 ${top(p[1])}, 상주 ${top(p[2])}`;
    const names = ['유동', '종사자', '상주'];
    c.reason = `${names[p.indexOf(Math.max(...p))]}인구가 ${top(Math.max(...p))}로 가장 높고 ${names[p.indexOf(Math.min(...p))]}인구가 ${top(Math.min(...p))}로 가장 낮아, 가중평균 ${c.value.toFixed(1)}점이다.${measured ? '' : ' 유동인구는 추정값이라 신뢰 C.'}`;
    c.inputs = [
      {
        label: measured ? '유동인구 (시간당 평균, 실측)' : '유동인구 (시간당 평균, 추정)',
        value: `${n0(fd.hourly_avg)}명${fd.range ? ` (80% 범위 ${n0(fd.range[0])}~${n0(fd.range[1])})` : ''} · 백분위 ${p[0].toFixed(0)}`,
        source: fd.sources[0],
      },
      { label: '행정동 종사자', value: `${n0(ind.workers.workers)}명 · 백분위 ${p[1].toFixed(0)}`, source: 'sgis_company' },
      { label: '행정동 인구', value: `${n0(ind.residents.population)}명 · 백분위 ${p[2].toFixed(0)}`, source: 'sgis_population' },
      ...(!measured && fd.out_of_range > 0.3 ? [{ label: '추정 주의', value: `이 동의 특성 중 ${Math.round(fd.out_of_range * 100)}%가 학습 범위(경기) 밖이라 범위를 넓혀 표시` }] : []),
      { label: '계산', value: `${p[0].toFixed(1)}×0.5 + ${p[1].toFixed(1)}×0.25 + ${p[2].toFixed(1)}×0.25 = ${c.value.toFixed(1)}` },
    ];
    c.sources = [...fd.sources, ...ind.residents.sources, ...ind.workers.sources];
  } else if (ind.residents?.population != null && ind.workers?.workers != null) {
    const p = [percentile(r.sg_pop, ind.residents.population), percentile(r.sg_worker, ind.workers.workers)];
    c.value = 0.5 * p[0] + 0.5 * p[1];
    c.confidence = 'B';
    c.method = `서울 상권 밖이라 유동인구가 없어, 전국 ${r.sg_pop.length.toLocaleString()}개 행정동 안에서 인구·종사자 수의 백분위를 구해 50%씩 평균한다.`;
    c.basis = `전국 행정동 중 인구 ${top(p[0])}, 종사자 ${top(p[1])} (전국 유동인구 대신 주거·직장인구 사용)`;
    c.reason = `행정동 인구가 전국 ${top(p[0])}, 종사자가 ${top(p[1])}라서 ${c.value.toFixed(1)}점이다. 유동인구는 반영되지 않았다.`;
    c.inputs = [
      { label: '행정동 인구', value: `${n0(ind.residents.population)}명 · 백분위 ${p[0].toFixed(0)}`, source: 'sgis_population' },
      { label: '행정동 종사자', value: `${n0(ind.workers.workers)}명 · 백분위 ${p[1].toFixed(0)}`, source: 'sgis_company' },
      { label: '계산', value: `${p[0].toFixed(1)}×0.5 + ${p[1].toFixed(1)}×0.5 = ${c.value.toFixed(1)}` },
    ];
    c.sources = [...ind.residents.sources, ...ind.workers.sources];
  } else {
    c.basis = '인구 데이터 없음';
    c.reason = '이 위치의 인구 통계를 찾지 못해 계산하지 않았다.';
  }
  return c;
}

function competition(ind: Indicators): Component {
  const comp = ind.competitors;
  const c = base('competition', '경쟁 강도', 'B');
  c.method =
    '반경 안 점포 중 같은 업종의 비중을, 같은 시도 전체 점포 중 그 업종의 비중으로 나눈 입지계수(LQ)를 구한다. LQ 1 = 시도 평균만큼 밀집, 2 이상 = 과밀. 점수 = 100 − 50 × LQ (0~100으로 자름), 즉 덜 밀집할수록 높다.';
  c.sources = comp.sources;
  if (comp.location_quotient == null || comp.all_stores < 20) {
    c.basis = comp.all_stores < 20 ? `반경 ${comp.radius_m}m 점포 ${comp.all_stores}곳 — 비교하기에 적음` : '업종 미확정';
    c.reason = comp.all_stores < 20 ? `반경 안 점포가 ${comp.all_stores}곳뿐이라 밀집도를 믿기 어려워 계산하지 않았다 (20곳 이상 필요).` : '업종이 정해지지 않아 계산하지 않았다.';
    return c;
  }
  const lq = comp.location_quotient;
  const area = comp.baseline_area ?? '시도';
  c.value = Math.max(0, Math.min(100, 100 - 50 * lq));
  c.basis = `반경 ${comp.radius_m}m 동일 업종 ${comp.same_industry}곳 / 전체 ${comp.all_stores}곳, 입지계수 ${lq.toFixed(2)}`;
  c.reason =
    lq >= 2
      ? `같은 업종이 ${area} 평균의 ${lq.toFixed(1)}배로 몰려 있어 0점이다.`
      : lq > 1
        ? `같은 업종이 ${area} 평균보다 ${((lq - 1) * 100).toFixed(0)}% 더 몰려 있어 ${c.value.toFixed(1)}점이다.`
        : `같은 업종이 ${area} 평균보다 ${((1 - lq) * 100).toFixed(0)}% 덜 몰려 있어 ${c.value.toFixed(1)}점이다.`;
  const localShare = (comp.same_industry ?? 0) / comp.all_stores;
  c.inputs = [
    { label: `반경 ${comp.radius_m}m 같은 업종`, value: `${comp.same_industry}곳`, source: 'sbiz_store' },
    { label: `반경 ${comp.radius_m}m 전체 점포`, value: `${comp.all_stores.toLocaleString()}곳`, source: 'sbiz_store' },
    { label: '반경 안 같은 업종 비중', value: pct(localShare, 1), source: 'sbiz_store' },
    { label: `${area} 전체 같은 업종 비중`, value: pct(localShare / lq, 2), source: 'sbiz_store' },
    { label: '계산', value: `LQ = ${pct(localShare, 1)} ÷ ${pct(localShare / lq, 2)} = ${lq.toFixed(2)} → 100 − 50×${lq.toFixed(2)} = ${c.value.toFixed(1)}` },
  ];
  return c;
}

function salesPower(sales: SalesResult | null, cs: string | null, src: SourceTracker): Component {
  const c = base('sales_power', '매출력', 'A');
  c.method = '이 상권에서 같은 업종의 점포당 월 매출(서울시 추정매출 ÷ 점포 수)이 서울 모든 상권의 같은 업종 중 몇 번째인지 백분위로 쓴다.';
  c.basis = '서울 상권 밖이거나 업종 미확정';
  c.reason = '서울 상권분석 데이터가 있는 위치·업종에서만 계산한다.';
  if (!sales?.available || sales.benchmark_per_store == null || !cs) return c;
  const n = one<{ lower: number; total: number }>(
    `select sum(s.thsmon_selng_amt * 1.0 / t.similr_induty_stor_co < ?) lower, count(*) total
     from ta_sales_q s join ta_store_q t using (stdr_yyqu_cd, trdar_cd, svc_induty_cd)
     where s.stdr_yyqu_cd = ? and s.svc_induty_cd = ? and t.similr_induty_stor_co > 0`,
    sales.benchmark_per_store, LATEST_Q, cs,
  );
  if (!n?.total) return c;
  c.value = (100 * n.lower) / n.total;
  c.sources = [src.use('seoul_sales', '매출력·매출 벤치마크'), src.use('seoul_store', '매출력(점포 수)')];
  c.basis = `이 상권 같은 업종 점포당 매출이 서울 ${n.total}개 상권 중 ${top(c.value)}`;
  c.reason = `이 상권의 같은 업종 점포당 월 매출 ${man(sales.benchmark_per_store)}은 서울 ${n.total}개 상권 중 ${n.lower}곳보다 높아 ${c.value.toFixed(1)}점이다.`;
  c.inputs = [
    { label: '이 상권 같은 업종 점포당 월 매출', value: `${man(sales.benchmark_per_store)} (점포 ${sales.benchmark_stores}곳 평균)`, source: 'seoul_sales' },
    { label: '비교 대상', value: `같은 업종이 있는 서울 상권 ${n.total}곳 (${LATEST_Q.slice(0, 4)}년 ${LATEST_Q[4]}분기)`, source: 'seoul_sales' },
    { label: '이보다 매출이 낮은 상권', value: `${n.lower}곳 → 백분위 ${c.value.toFixed(1)}` },
  ];
  return c;
}

function vision(v: Vision | null, src: SourceTracker): Component {
  const c = base('vision', '로드뷰', 'C');
  c.method = 'Claude가 담은 로드뷰 화면을 보고 보행 유동·접근성·가시성·상업 밀집·시설 상태를 각각 0~100으로 매기고, 다섯 값을 평균한다. 같은 사진도 판독이 달라질 수 있어 가중치를 10%로 제한한다.';
  if (!v) {
    c.basis = '로드뷰 이미지 없음';
    c.reason = '로드뷰를 담지 않아 이 항목은 빼고 나머지로 계산했다.';
    return c;
  }
  const s = v.scores;
  c.value = (s.pedestrian + s.accessibility + s.visibility + s.commercial_density + s.facility_condition) / 5;
  c.sources = [src.use('claude_vision', '로드뷰 판독')];
  c.basis = `로드뷰 ${v.images_used}장 판독 (접근성·가시성·밀집도·시설 등 평균)`;
  c.reason = `로드뷰 ${v.images_used}장에서 ${v.area_type}으로 판독했고, 다섯 항목 평균이 ${c.value.toFixed(1)}점이다.`;
  c.inputs = [
    { label: '보행 유동', value: String(s.pedestrian), source: 'claude_vision' },
    { label: '접근성', value: String(s.accessibility), source: 'claude_vision' },
    { label: '가시성', value: String(s.visibility), source: 'claude_vision' },
    { label: '상업 밀집', value: String(s.commercial_density), source: 'claude_vision' },
    { label: '시설 상태', value: String(s.facility_condition), source: 'claude_vision' },
  ];
  return c;
}

export function computeScore(a: {
  loc: Location;
  indicators: Indicators;
  survival: SurvivalResult | null;
  sales: SalesResult | null;
  seoulCs: string | null;
  industryKnown: boolean;
  floorArea?: number;
  vision: Vision | null;
  sources: SourceTracker;
}): Score {
  const s = a.survival;
  const components = [
    survival(s, a.industryKnown, a.floorArea, a.sources),
    demand(a.loc, a.indicators),
    competition(a.indicators),
    salesPower(a.sales, a.seoulCs, a.sources),
    vision(a.vision, a.sources),
  ];
  const used = components.filter((c) => c.value != null);
  const wsum = used.reduce((x, c) => x + c.weight, 0);
  const total = wsum ? used.reduce((x, c) => x + c.value! * c.weight, 0) / wsum : null;
  const raw: Score['grade'] = total == null ? null : total >= 80 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : total >= 20 ? 'D' : 'E';
  let grade = raw;
  // A needs both the survival model and most of the other evidence; otherwise cap at B.
  const thin = !s || wsum < 0.75;
  if (thin && grade === 'A') grade = 'B';
  // Too little evidence to grade at all (e.g. 업종 unknown → only 수요 left).
  if (wsum < 0.3) grade = null;

  const explanation = explain(components, used, wsum, total, raw, grade, Boolean(s));
  for (const c of components) c.value = c.value == null ? null : Math.round(c.value * 10) / 10;
  return {
    total: total == null ? null : Math.round(total * 10) / 10,
    grade,
    survival_3y_prob: s?.survival_3y_prob ?? null,
    components,
    evidence_weight: Math.round(wsum * 100) / 100,
    explanation,
    model_version: SCORE_VERSION,
  };
}

function explain(
  comps: Component[],
  used: Component[],
  wsum: number,
  total: number | null,
  raw: Score['grade'],
  grade: Score['grade'],
  hasSurvival: boolean,
): Explanation {
  const w = (c: Component) => `${Math.round(c.weight * 100)}%`;
  const formula =
    total == null
      ? '점수를 낼 항목이 없다.'
      : wsum < 0.999
        ? `(${used.map((c) => `${c.value!.toFixed(1)}×${w(c)}`).join(' + ')}) ÷ ${Math.round(wsum * 100)}% = ${total.toFixed(1)}점`
        : `${used.map((c) => `${c.value!.toFixed(1)}×${w(c)}`).join(' + ')} = ${total.toFixed(1)}점`;

  let grade_reason: string;
  if (total == null) grade_reason = '근거가 되는 항목이 하나도 없어 점수와 등급을 내지 않았다.';
  else if (grade == null) grade_reason = `${total.toFixed(1)}점이지만 근거가 있는 항목이 ${Math.round(wsum * 100)}%뿐이라(30% 미만) 등급을 보류했다.`;
  else {
    const band = { A: '80점 이상', B: '60~80점', C: '40~60점', D: '20~40점', E: '20점 미만' }[raw!];
    grade_reason = `${total.toFixed(1)}점은 ${band} 구간이라 ${raw}(${GRADE_TEXT[raw!]})다.`;
    if (grade !== raw) {
      grade_reason += hasSurvival
        ? ` 다만 근거가 있는 항목이 ${Math.round(wsum * 100)}%라(75% 미만) 최고 B로 제한했다.`
        : ' 다만 3년 생존 모델이 없는 업종이라 최고 B로 제한했다.';
    }
  }

  // Contribution of each component relative to a neutral 50, scaled by its effective weight.
  const impact = used.map((c) => ({ c, d: ((c.value! - 50) * c.weight) / (wsum || 1) })).sort((a, b) => b.d - a.d);
  const say = (x: { c: Component; d: number }) =>
    `${x.c.label} ${x.c.value!.toFixed(0)}점 (가중치 ${w(x.c)}, 종합 점수를 ${x.d >= 0 ? '+' : ''}${x.d.toFixed(1)}점 움직임) — ${x.c.reason}`;
  return {
    formula,
    grade_reason,
    lifts: impact.filter((x) => x.d >= 2).slice(0, 2).map(say),
    drags: impact.filter((x) => x.d <= -2).reverse().slice(0, 2).map(say),
    missing: comps.filter((c) => c.value == null).map((c) => `${c.label} (가중치 ${w(c)}) — ${c.reason} 이 가중치는 나머지 항목에 나눠 반영했다.`),
    rules: [
      '종합 점수 = 데이터가 있는 항목들의 가중평균. 가중치: 3년 생존 50%, 수요 15%, 경쟁 강도 15%, 매출력 10%, 로드뷰 10%.',
      '빠진 항목의 가중치는 버리지 않고 남은 항목에 비율대로 나눠 준다 (가중치 합계로 나눔).',
      '등급: A 80점 이상 · B 60~80 · C 40~60 · D 20~40 · E 20 미만.',
      '생존 모델이 없거나 근거 항목이 75% 미만이면 최고 B, 30% 미만이면 등급 보류.',
      '각 항목은 50점이 "비교 대상의 중간"이다. 50보다 높으면 종합 점수를 올리고, 낮으면 내린다.',
    ],
  };
}
