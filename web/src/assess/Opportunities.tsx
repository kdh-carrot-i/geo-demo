// 유망 입지 찾기: 업종을 고르면 상권영역별 "상권은 활발한데 그 업종은 덜 밀집한 곳" 순위 (GET /opportunities).
import { useEffect, useState } from 'react';
import { agent } from './client';
import type { Industry, OpportunityResult } from './types';

const SIDO = ['', '서울특별시', '부산광역시', '대구광역시', '인천광역시', '전남광주통합특별시', '대전광역시', '울산광역시', '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도', '경상북도', '경상남도', '제주특별자치도'];

export function Opportunities() {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<Industry[]>([]);
  const [ind, setInd] = useState<Industry | null>(null);
  const [sido, setSido] = useState('');
  const [sgg, setSgg] = useState('');
  const [sggOptions, setSggOptions] = useState<{ name: string; zones: number }[]>([]);
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [r, setR] = useState<OpportunityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ind && q === ind.name) return;
    if (q.trim().length < 1) return setOptions([]);
    const t = setTimeout(() => agent.industries(q.trim()).then((x) => setOptions(x.slice(0, 8))).catch(() => setOptions([])), 200);
    return () => clearTimeout(t);
  }, [q, ind]);

  useEffect(() => {
    if (!ind) return;
    setBusy(true);
    setError(null);
    agent
      .opportunities(ind.code, sido, sgg, upcomingOnly)
      .then((x) => {
        setR(x);
        // 시군구 목록은 시도를 바꿨을 때(시군구 미선택)의 응답에서만 갱신
        if (!sgg) setSggOptions(x.sgg_options ?? []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [ind, sido, sgg, upcomingOnly]);

  return (
    <section className="card">
      <h3>유망 입지 찾기</h3>
      <p className="muted small">업종을 고르면 전국 상권영역 중 "상권은 활발한데 이 업종은 시도 평균보다 덜 밀집하고, 곧 입주가 몰리는 곳"을 보여 줍니다.</p>
      <div className="row">
        <div className="opp-pick">
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setInd(null);
            }}
            placeholder="업종 (예: 카페, 치킨, 미용실)"
            aria-label="업종"
          />
          {!ind && options.length > 0 && (
            <ul className="opp-options">
              {options.map((o) => (
                <li key={o.code}>
                  <button
                    type="button"
                    onClick={() => {
                      setInd(o);
                      setQ(o.name);
                      setOptions([]);
                    }}
                  >
                    {o.name} <span className="muted small">{o.lcls_name} › {o.mcls_name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <select
          value={sido}
          onChange={(e) => {
            setSido(e.target.value);
            setSgg('');
            setSggOptions([]);
          }}
          aria-label="시도"
        >
          {SIDO.map((s) => (
            <option key={s} value={s}>
              {s || '전국'}
            </option>
          ))}
        </select>
        <select value={sgg} onChange={(e) => setSgg(e.target.value)} aria-label="시군구" disabled={!sido || !sggOptions.length}>
          <option value="">{sido ? '시군구 전체' : '시도를 먼저'}</option>
          {sggOptions.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name} ({o.zones})
            </option>
          ))}
        </select>
        <label className="small">
          <input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} /> 입주 예정 단지 근처만
        </label>
      </div>
      {error && <p className="warn">{error}</p>}
      {busy && <p className="muted small">상권별로 계산하는 중…</p>}
      {r && !busy && (
        <>
          <p className="muted small">
            {r.sgg
              ? `${r.sido} ${r.sgg} 상권영역 ${r.count_filtered ?? r.items.length}곳 (점수·순위는 ${r.sido} ${r.count.toLocaleString()}곳 기준)`
              : `${r.sido ?? '전국'} 상권영역 ${r.count.toLocaleString()}곳 중 상위 ${r.items.length}곳`}{' '}
            · {r.industry.name} · 상가정보 {r.as_of}
          </p>
          <div className="table-wrap">
            <table className="mini">
              <thead>
                <tr>
                  <th>{r.sgg ? `${r.sido?.slice(0, 2)} 순위` : '#'}</th>
                  <th>상권</th>
                  <th className="num">점수</th>
                  <th className="num">전체 점포</th>
                  <th className="num">{r.industry.name}</th>
                  <th className="num">시도 대비</th>
                  <th className="num">활성도</th>
                  <th className="num">여유도</th>
                  <th className="num">입주 예정 (3년)</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((o, i) => (
                  <tr key={o.id}>
                    <td>{o.rank ?? i + 1}</td>
                    <td>
                      <a href={`#/areas/${encodeURIComponent(o.id)}`}>{o.name}</a> <span className="muted small">{o.sido.replace(/(특별|광역|통합특별|특별자치)?(시|도)$/, '')} {o.sgg}</span>
                      {o.note && <div className="muted small">{o.note}</div>}
                    </td>
                    <td className="num">
                      <b>{o.score.toFixed(0)}</b>
                    </td>
                    <td className="num">{o.stores_total.toLocaleString()}</td>
                    <td className="num">{o.same_industry.toLocaleString()}</td>
                    <td className="num">{o.lq.toFixed(2)}배</td>
                    <td className="num">{o.activity.toFixed(0)}</td>
                    <td className="num">{o.room.toFixed(0)}</td>
                    <td className="num" title={(o.upcoming ?? []).map((u) => `${u.name ?? '단지'} ${u.hh.toLocaleString()}세대 · ${u.move_in.slice(0, 4)}.${u.move_in.slice(4, 6)} 입주 · ${u.distance_m}m`).join('\n')}>
                      {o.upcoming_hh ? (
                        <>
                          {o.upcoming_hh.toLocaleString()}세대
                          {o.upcoming?.[0] && <div className="muted small">{o.upcoming[0].name ?? '단지'} 외 · {o.upcoming[0].move_in.slice(0, 4)}년</div>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="kind-guide">
            <summary className="small">점수는 어떻게 계산하나요?</summary>
            <p className="muted small">{r.method}</p>
          </details>
        </>
      )}
    </section>
  );
}
