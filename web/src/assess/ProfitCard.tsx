// 손익분기 시뮬레이션 카드: 서버가 정한 가정값으로 시작하고, 심사역이 값을 바꾸면 같은 식(src/shared/profit.ts)으로 바로 다시 계산한다.
import { useMemo, useState } from 'react';
import { simulate, type ProfitInputs } from '../shared/profit';
import { won } from './charts';
import { Tile } from './ResultView';
import type { Assessment } from './types';

type P = NonNullable<Assessment['profitability']>;

function MoneyInput({ label, value, onChange, hint, step = 100_000 }: { label: string; value: number | null; onChange: (v: number | null) => void; hint?: string; step?: number }) {
  return (
    <label className="pf-field">
      <span>{label}</span>
      <input type="number" step={step} value={value ?? ''} placeholder="입력" onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
      <small className="muted">{value != null ? won(value) : '—'}{hint ? ` · ${hint}` : ''}</small>
    </label>
  );
}

export function ProfitCard({ p, refs }: { p: P; refs: React.ReactNode }) {
  const [x, setX] = useState<ProfitInputs>(p.inputs);
  const out = useMemo(() => simulate(x), [x]);
  const changed = JSON.stringify(x) !== JSON.stringify(p.inputs);
  const set = (k: keyof ProfitInputs['assumptions'], v: number | null) => setX({ ...x, assumptions: { ...x.assumptions, [k]: v ?? 0 } });
  const profitTone = out.operating_profit == null ? '' : out.operating_profit >= 0 ? 'good-text' : 'bad-text';
  return (
    <section className="card">
      <h3>
        손익분기 시뮬레이션 · {p.kind_label} {refs}
      </h3>
      <p className="muted small">영업 단계 월 손익 (세금·감가상각·이자·점주 본인 인건비 제외). 아래 값을 바꾸면 바로 다시 계산합니다.</p>
      <div className="tiles">
        <Tile label="월 영업이익" value={out.operating_profit != null ? won(out.operating_profit) : '—'} hint={out.operating_profit == null ? '예상 매출 필요' : `매출 ${won(x.monthly_sales)} − 변동비 − 고정비 ${won(out.fixed_cost)}`} />
        <Tile label="손익분기 월 매출" value={won(out.break_even_sales)} hint="이만큼 팔아야 본전" />
        <Tile label="투자 회수 기간" value={out.payback_months != null ? `${out.payback_months}개월` : '—'} hint={`초기 투자 ${won(x.assumptions.initial_investment)}`} />
        <Tile label="매출 대비 임대료" value={out.rent_to_sales != null ? `${(out.rent_to_sales * 100).toFixed(1)}%` : '—'} hint="10~15% 넘으면 부담이 큰 편" />
      </div>
      {out.operating_profit != null && (
        <p className={`small ${profitTone}`}>
          매출이 달라지면 월 영업이익:{' '}
          {out.sensitivity.map((s) => `${s.change > 0 ? '+' : ''}${Math.round(s.change * 100)}% ${won(s.operating_profit)}`).join(' · ')}
        </p>
      )}
      <details className="pf-edit" open={!p.inputs.monthly_sales}>
        <summary className="small">가정값 보기·바꾸기{changed ? ' (바뀜)' : ''}</summary>
        <div className="pf-grid">
          <MoneyInput label="예상 월 매출" value={x.monthly_sales} onChange={(v) => setX({ ...x, monthly_sales: v })} hint={p.sales_basis ?? '근거 매출 없음 — 직접 입력'} step={1_000_000} />
          <MoneyInput label="월 임대료" value={x.monthly_rent} onChange={(v) => setX({ ...x, monthly_rent: v })} hint={p.rent_basis ?? '임대료 정보 없음'} />
          <label className="pf-field">
            <span>변동비율 (원재료·수수료 등)</span>
            <input type="number" step={0.01} min={0} max={0.99} value={x.assumptions.variable_rate} onChange={(e) => set('variable_rate', Number(e.target.value))} />
            <small className="muted">{(x.assumptions.variable_rate * 100).toFixed(0)}% · 가정</small>
          </label>
          <MoneyInput label="월 인건비" value={x.assumptions.labor} onChange={(v) => set('labor', v)} hint="가정" />
          <MoneyInput label="월 기타 고정비" value={x.assumptions.other_fixed} onChange={(v) => set('other_fixed', v)} hint="관리비·공과금 등, 가정" />
          <MoneyInput label="초기 투자" value={x.assumptions.initial_investment} onChange={(v) => set('initial_investment', v)} hint="보증금 제외" step={1_000_000} />
        </div>
        {changed && (
          <button type="button" className="linklike" onClick={() => setX(p.inputs)}>
            처음 값으로 되돌리기
          </button>
        )}
        <ul className="muted small">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
