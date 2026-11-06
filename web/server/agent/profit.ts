// 손익분기 시뮬레이션: 예상 매출(서울 예측 또는 브랜드 평균) − 변동비 − 고정비(임대료·인건비·기타) → 월 영업이익,
// 손익분기 매출, 투자 회수 기간. 비용 비율·인건비·초기 투자는 업종별 일반값(가정)이며 화면에서 바꿔 다시 계산한다.
// 계산식(simulate)은 src/shared/profit.ts — 화면 ProfitCard와 공용.
import { simulate, type ProfitAssumptions, type ProfitInputs, type ProfitOutputs } from '../../src/shared/profit.ts';
export { simulate, type ProfitAssumptions };

export type ProfitKind = 'food' | 'cafe' | 'cvs' | 'other';

/** 업종별 일반값 — 업계에서 흔히 쓰는 비율을 둥글게 잡은 가정값이다 (출처 데이터 아님). */
export const DEFAULTS: Record<ProfitKind, ProfitAssumptions & { label: string }> = {
  food: { label: '음식점', variable_rate: 0.45, labor: 6_000_000, other_fixed: 1_200_000, initial_investment: 120_000_000, default_area_m2: 66 },
  cafe: { label: '카페', variable_rate: 0.4, labor: 4_000_000, other_fixed: 900_000, initial_investment: 100_000_000, default_area_m2: 50 },
  cvs: { label: '편의점', variable_rate: 0.78, labor: 5_000_000, other_fixed: 1_000_000, initial_investment: 50_000_000, default_area_m2: 66 },
  other: { label: '기타 업종', variable_rate: 0.5, labor: 4_000_000, other_fixed: 1_000_000, initial_investment: 80_000_000, default_area_m2: 50 },
};

export interface Profitability {
  kind: ProfitKind;
  kind_label: string;
  sales_basis: string | null;
  rent_basis: string | null;
  area_m2: number;
  area_assumed: boolean;
  inputs: ProfitInputs;
  outputs: ProfitOutputs;
  notes: string[];
}

export function profitKind(code: string | null): ProfitKind {
  if (!code) return 'other';
  if (code === 'G20405') return 'cvs';
  if (code === 'I21201' || code.startsWith('I212')) return 'cafe';
  if (code.startsWith('I2')) return 'food';
  return 'other';
}

export function profitability(a: {
  industryCode: string | null;
  floorArea?: number;
  seoulSalesP50: number | null;
  benchmarkPerStore: number | null;
  brandAvgAnnual: number | null;
  brandName: string | null;
  brandCostTotal: number | null;
  /** 이 점포에 적용한 R-ONE ㎡당 월 임대료 (건물 유형 × 층) */
  rentPerM2: number | null;
  rentArea: string | null;
}): Profitability {
  const kind = profitKind(a.industryCode);
  const d = DEFAULTS[kind];
  const area = a.floorArea ?? d.default_area_m2;
  // 매출: 서울 매출 모델 중앙값 → 상권 실제 평균 → 브랜드 전국 평균 순
  let sales: number | null = null;
  let salesBasis: string | null = null;
  if (a.seoulSalesP50) [sales, salesBasis] = [a.seoulSalesP50, '서울 매출 모델 예측 중앙값 (점포당 월)'];
  else if (a.benchmarkPerStore) [sales, salesBasis] = [a.benchmarkPerStore, '같은 상권·업종 실제 평균 (서울시 추정매출)'];
  else if (a.brandAvgAnnual) [sales, salesBasis] = [Math.round(a.brandAvgAnnual / 12), `${a.brandName} 가맹점 전국 평균 매출 ÷ 12 (공정위)`];
  const rent = a.rentPerM2 != null ? Math.round(a.rentPerM2 * area) : null;
  const assumptions: ProfitAssumptions = { ...d, initial_investment: a.brandCostTotal ?? d.initial_investment };
  const inputs: ProfitInputs = { monthly_sales: sales, monthly_rent: rent, assumptions: { variable_rate: assumptions.variable_rate, labor: assumptions.labor, other_fixed: assumptions.other_fixed, initial_investment: assumptions.initial_investment, default_area_m2: d.default_area_m2 } };
  const notes = [
    `변동비율·인건비·기타 고정비는 ${d.label} 일반값(가정)이다. 실제 조건으로 바꿔 넣으면 다시 계산된다.`,
    a.brandCostTotal ? `초기 투자는 ${a.brandName} 공정위 공개 창업 비용 합계 (임대 보증금 제외).` : `초기 투자는 ${d.label} 일반값(가정, 임대 보증금 제외).`,
    '세금·감가상각·대출 이자·점주 본인 인건비는 빼고 계산한 영업 단계 손익이다.',
  ];
  if (!sales) notes.unshift('예상 매출이 없어 손익분기 매출(이만큼 팔아야 본전)만 계산했다. 서울 밖·비프랜차이즈는 매출 데이터 확보 후 제공.');
  if (!a.floorArea) notes.push(`면적을 입력하지 않아 ${d.label} 기본 ${d.default_area_m2}㎡로 임대료를 계산했다.`);
  return {
    kind,
    kind_label: d.label,
    sales_basis: salesBasis,
    rent_basis: rent != null ? `R-ONE ${a.rentArea ?? ''} ㎡당 월 임대료 × ${area}㎡` : null,
    area_m2: area,
    area_assumed: !a.floorArea,
    inputs,
    outputs: simulate(inputs),
    notes,
  };
}
