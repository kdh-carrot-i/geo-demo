// 출자 매장 모니터링 (#/watch): 등록한 매장마다 등록 때(기준선)와 지금을 비교한 변화 신호.
import { useEffect, useState } from 'react';
import { agent } from './client';
import type { WatchDetail, WatchItem } from './types';

const LEVEL: Record<string, { tone: string; text: string }> = { warn: { tone: 'critical', text: '주의' }, watch: { tone: 'warning', text: '관찰' }, ok: { tone: 'good', text: '이상 없음' } };
const SIG: Record<string, string> = { warn: '⚠', watch: '●', info: '·' };
const GROUP: Record<string, string> = { change: '등록 이후', state: '현재 상태' };

export function WatchView() {
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => agent.watchList().then(setItems).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="card">
      <h3>출자 매장 모니터링</h3>
      <p className="muted small">
        평가 결과 화면의 "모니터링에 추가"로 등록합니다. 등록 때의 주변 상황(기준선)과 지금을 비교해 경쟁점 신규 진입, 같은 브랜드 근접 출점, 주변 개·폐업 추세, 임대료·공실 변화를 알려 줍니다. 점포 목록은 상가정보가 분기마다 갱신될 때 바뀝니다.
      </p>
      {error && <p className="warn">{error}</p>}
      {items && !items.length && <p className="muted">등록한 매장이 없습니다.</p>}
      <ul className="watch-list">
        {items?.map((w) => (
          <li key={w.id}>
            <button type="button" className="watch-head" onClick={() => setOpen(open === w.id ? null : w.id)} aria-expanded={open === w.id}>
              <span className={`badge ${LEVEL[w.level].tone}`}>{LEVEL[w.level].text}</span>
              <b>{w.name}</b>
              <span className="muted small">
                {w.industry ?? ''}
                {w.brand ? ` · ${w.brand}` : ''} · {w.address} · 등록 {w.created_at.slice(0, 10)}
              </span>
            </button>
            <ul className="small signals">
              {w.signals.map((s, i) => (
                <li key={i} className={`sig-${s.level}`}>
                  {SIG[s.level]} <span className="sig-group">{GROUP[s.group]}</span> {s.text}
                </li>
              ))}
            </ul>
            {open === w.id && (
              <WatchDetailView
                id={w.id}
                onDeleted={() => {
                  setOpen(null);
                  load();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WatchDetailView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [d, setD] = useState<WatchDetail | null>(null);
  useEffect(() => {
    agent.watchGet(id).then(setD).catch(() => {});
  }, [id]);
  if (!d) return <p className="muted small">불러오는 중…</p>;
  const row = (label: string, a: string | number | null | undefined, b: string | number | null | undefined) => (
    <tr>
      <td>{label}</td>
      <td className="num">{a ?? '—'}</td>
      <td className="num">{b ?? '—'}</td>
    </tr>
  );
  const group = (g: 'change' | 'state', title: string) => (
    <div>
      <h4>{title}</h4>
      <ul className="small signals">
        {d.signals
          .filter((x) => x.group === g)
          .map((x, i) => (
            <li key={i} className={`sig-${x.level}`}>
              {SIG[x.level]} {x.text}
            </li>
          ))}
      </ul>
    </div>
  );
  return (
    <div className="watch-detail">
      <div className="grid-2">
        {group('change', `등록 이후 변화 (${d.baseline.at.slice(0, 10)} 기준선 대비)`)}
        {group('state', '지금 주변 상태·동향')}
      </div>
      <p className="muted small">{d.rules}</p>
      <table className="mini">
        <thead>
          <tr>
            <th>반경 {d.radius_m}m</th>
            <th className="num">등록 때 ({d.baseline.at.slice(0, 10)})</th>
            <th className="num">지금</th>
          </tr>
        </thead>
        <tbody>
          {row('전체 점포', d.baseline.all_stores, d.current.all_stores)}
          {row(`같은 업종 (${d.industry ?? '—'})`, d.baseline.same_industry, d.current.same_industry)}
          {d.brand && row(`같은 브랜드 (${d.brand})`, d.baseline.same_brand, d.current.same_brand)}
          {d.current.license && row('인허가 영업 중', d.baseline.license?.active, d.current.license.active)}
          {d.current.license &&
            row('최근 1년 개업 / 폐업', d.baseline.license ? `${d.baseline.license.opened_12m} / ${d.baseline.license.closed_12m}` : null, `${d.current.license.opened_12m} / ${d.current.license.closed_12m}`)}
          {row(
            '1층 임대료 (㎡당 월)',
            d.baseline.rent_1f ? `${d.baseline.rent_1f.won_per_m2.toLocaleString()}원 (${d.baseline.rent_1f.quarter})` : null,
            d.current.rent_1f ? `${d.current.rent_1f.won_per_m2.toLocaleString()}원 (${d.current.rent_1f.quarter})` : null,
          )}
        </tbody>
      </table>
      <p className="muted small">{d.store_compare}</p>
      {d.new_competitors.length > 0 && <p className="small">신규 진입: {d.new_competitors.slice(0, 8).map((c) => `${c.name} ${c.d}m`).join(', ')}</p>}
      {d.memo && <p className="small">메모: {d.memo}</p>}
      <p className="small">
        <a href={`#/areas/${encodeURIComponent(`circle:${d.lat.toFixed(6)},${d.lng.toFixed(6)},${d.radius_m}`)}`}>이 매장 주변 상권 리포트</a> ·{' '}
        <button
          type="button"
          className="linklike"
          onClick={() => {
            if (window.confirm(`${d.name}을(를) 모니터링에서 뺄까요?`)) agent.watchDelete(id).then(onDeleted);
          }}
        >
          모니터링에서 빼기
        </button>
      </p>
    </div>
  );
}
