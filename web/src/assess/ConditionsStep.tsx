// Step 2: 업종 and the rest of the request (면적, 상호, 사업자번호, 반경, 관리번호).
import { useEffect, useState } from 'react';
import { agent } from './client';
import type { Industry, Place } from './types';

export interface Conditions {
  industry: Industry | null;
  floor_area_m2: string;
  /** '' = 모름(1층으로 계산), '-1' = 지하1층, '6' = 6층 이상 */
  floor: string;
  store_name: string;
  biz_no: string;
  radius_m: number;
  client_ref: string;
}

export const emptyConditions: Conditions = { industry: null, floor_area_m2: '', floor: '', store_name: '', biz_no: '', radius_m: 300, client_ref: '' };

// R-ONE 층별 임대료 구분과 같게
const FLOORS: [string, string][] = [
  ['', '모름 (1층으로 계산)'],
  ['-1', '지하층'],
  ['1', '1층'],
  ['2', '2층'],
  ['3', '3층'],
  ['4', '4층'],
  ['5', '5층'],
  ['6', '6층 이상'],
];

interface Props {
  place: Place;
  shots: number;
  value: Conditions;
  onChange: (c: Conditions) => void;
  onBack: () => void;
  onSubmit: () => void;
  busy: boolean;
}

export function ConditionsStep({ place, shots, value: c, onChange, onBack, onSubmit, busy }: Props) {
  const [q, setQ] = useState(c.industry?.name ?? '');
  const [options, setOptions] = useState<Industry[]>([]);
  const set = (patch: Partial<Conditions>) => onChange({ ...c, ...patch });

  useEffect(() => {
    if (!q.trim() || q === c.industry?.name) {
      setOptions([]);
      return;
    }
    const t = setTimeout(() => agent.industries(q.trim()).then((r) => setOptions(r.slice(0, 8))).catch(() => setOptions([])), 200);
    return () => clearTimeout(t);
  }, [q, c.industry]);

  const area = Number(c.floor_area_m2);
  const areaBad = c.floor_area_m2 !== '' && !(area >= 1 && area <= 100000);
  const bizBad = c.biz_no !== '' && !/^\d{10}$/.test(c.biz_no);

  return (
    <section className="card">
      <h2>무엇을 열 계획인가요?</h2>
      <p className="muted">
        {place.road ?? place.label} · 로드뷰 {shots ? `${shots}장 담음` : '담지 않음 (로드뷰 항목 10%는 빼고 계산)'}
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!areaBad && !bizBad) onSubmit();
        }}
      >
        <label className="field wide">
          <span>
            업종 <em>권장</em>
          </span>
          <div className="combo">
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (c.industry) set({ industry: null });
              }}
              placeholder="예: 카페, 한식, 치킨, 미용실"
            />
            {options.length > 0 && (
              <ul className="options">
                {options.map((o) => (
                  <li key={o.code}>
                    <button
                      type="button"
                      onClick={() => {
                        set({ industry: o });
                        setQ(o.name);
                        setOptions([]);
                      }}
                    >
                      <strong>{o.name}</strong>
                      <span>
                        {o.lcls_name} › {o.mcls_name} · {o.code}
                        {o.survival_model ? ' · 생존 확률 제공' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <small className="muted">
            {c.industry
              ? `${c.industry.name} (${c.industry.code})${c.industry.survival_model ? '' : ' — 음식점 외 업종은 3년 생존 확률이 아직 없어 등급이 최대 B입니다'}`
              : '목록에서 고르면 정확합니다. 비워 두면 상호나 간판으로 추정합니다.'}
          </small>
        </label>

        <label className="field">
          <span>
            매장 면적 (㎡) <em>권장</em>
          </span>
          <input inputMode="decimal" value={c.floor_area_m2} onChange={(e) => set({ floor_area_m2: e.target.value.replace(/[^\d.]/g, '') })} placeholder="예: 66" />
          <small className={areaBad ? 'warn' : 'muted'}>{areaBad ? '1~100000 사이로 넣어 주세요' : '3년 생존 예측에 가장 큰 영향을 주는 값입니다'}</small>
        </label>

        <label className="field">
          <span>
            층 <em>권장</em>
          </span>
          <select value={c.floor} onChange={(e) => set({ floor: e.target.value })}>
            {FLOORS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <small className="muted">임대료를 그 층 단가로 계산합니다 (건물 유형은 건축물대장으로 자동 판별)</small>
        </label>

        <label className="field">
          <span>집계 반경</span>
          <select value={c.radius_m} onChange={(e) => set({ radius_m: Number(e.target.value) })}>
            {[100, 300, 500, 1000].map((r) => (
              <option key={r} value={r}>
                {r}m
              </option>
            ))}
          </select>
          <small className="muted">경쟁점·밀집도를 셀 범위</small>
        </label>

        <label className="field">
          <span>상호</span>
          <input value={c.store_name} onChange={(e) => set({ store_name: e.target.value })} placeholder="예: OO식당" />
          <small className="muted">프랜차이즈 판별에 씁니다</small>
        </label>

        <label className="field">
          <span>사업자등록번호</span>
          <input inputMode="numeric" value={c.biz_no} onChange={(e) => set({ biz_no: e.target.value.replace(/\D/g, '').slice(0, 10) })} placeholder="숫자 10자리" />
          <small className={bizBad ? 'warn' : 'muted'}>{bizBad ? '숫자 10자리를 모두 넣어 주세요' : '영업 상태 확인에만 쓰고 저장하지 않습니다'}</small>
        </label>

        <label className="field">
          <span>관리 번호</span>
          <input value={c.client_ref} onChange={(e) => set({ client_ref: e.target.value.slice(0, 64) })} placeholder="예: 심사-2026-0412" />
          <small className="muted">지난 평가 목록에서 찾을 때 씁니다</small>
        </label>

        <div className="actions wide">
          <button type="button" className="secondary" onClick={onBack}>
            ← 위치 다시 보기
          </button>
          <button className="primary" disabled={busy || areaBad || bizBad}>
            {busy ? '요청 중…' : '평가하기'}
          </button>
        </div>
      </form>
    </section>
  );
}
