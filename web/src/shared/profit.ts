// 손익분기 계산식 — 서버(web/server/agent/profit.ts)와 화면(ProfitCard)이 같은 식을 쓰도록 여기 한 곳에 둔다.

export interface ProfitAssumptions {
  /** 매출에 비례하는 비용 비율 (원재료·카드 수수료·로열티 등) */
  variable_rate: number;
  /** 월 인건비 (점주 본인 인건비 제외) */
  labor: number;
  /** 월 기타 고정비 (관리비·공과금·통신·보험 등) */
  other_fixed: number;
  /** 초기 투자 (가맹비·인테리어·설비 등, 임대 보증금 제외) */
  initial_investment: number;
  /** 면적 미입력 때 쓰는 매장 면적 (㎡) */
  default_area_m2: number;
}

export interface ProfitInputs {
  monthly_sales: number | null;
  monthly_rent: number | null;
  assumptions: ProfitAssumptions;
}

export interface ProfitOutputs {
  fixed_cost: number | null;
  operating_profit: number | null;
  break_even_sales: number | null;
  payback_months: number | null;
  rent_to_sales: number | null;
  /** 매출이 ±20% 달라질 때의 월 영업이익 */
  sensitivity: { change: number; operating_profit: number | null }[];
}

/** 순수 계산식 (서버·화면 공용) */
export function simulate(x: ProfitInputs): ProfitOutputs {
  const a = x.assumptions;
  const fixed = x.monthly_rent != null ? x.monthly_rent + a.labor + a.other_fixed : null;
  const margin = 1 - a.variable_rate;
  const op = (s: number | null) => (s != null && fixed != null ? Math.round(s * margin - fixed) : null);
  const profit = op(x.monthly_sales);
  return {
    fixed_cost: fixed,
    operating_profit: profit,
    break_even_sales: fixed != null && margin > 0 ? Math.round(fixed / margin) : null,
    payback_months: profit != null && profit > 0 ? Math.round((a.initial_investment / profit) * 10) / 10 : null,
    rent_to_sales: x.monthly_rent != null && x.monthly_sales ? Math.round((x.monthly_rent / x.monthly_sales) * 1000) / 1000 : null,
    sensitivity: [-0.2, -0.1, 0, 0.1, 0.2].map((c) => ({ change: c, operating_profit: op(x.monthly_sales != null ? x.monthly_sales * (1 + c) : null) })),
  };
}

