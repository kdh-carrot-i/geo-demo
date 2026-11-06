// 입지 심사 화면: 위치 확인 → 조건 → 분석 → 결과. Results live at #/a/<assessment_id>.
import { useCallback, useEffect, useRef, useState } from 'react';
import { agent } from './client';
import { ConditionsStep, emptyConditions, type Conditions } from './ConditionsStep';
import { LocationStep } from './LocationStep';
import { AreaReportLoader, AreaSearch } from './AreaView';
import { Opportunities } from './Opportunities';
import { WatchView } from './WatchView';
import { ResultView } from './ResultView';
import type { Assessment, HistoryItem, Place } from './types';
import './assess.css';

type View = { kind: 'new' } | { kind: 'result'; id: string } | { kind: 'history' } | { kind: 'areas' } | { kind: 'area'; id: string } | { kind: 'watch' };

function viewFromHash(): View {
  const m = /^#\/a\/(asm_\w+)/.exec(location.hash);
  if (m) return { kind: 'result', id: m[1] };
  if (location.hash.startsWith('#/history')) return { kind: 'history' };
  const a = /^#\/areas\/(.+)$/.exec(location.hash);
  if (a) return { kind: 'area', id: decodeURIComponent(a[1]) };
  if (location.hash.startsWith('#/areas')) return { kind: 'areas' };
  if (location.hash.startsWith('#/watch')) return { kind: 'watch' };
  return { kind: 'new' };
}

const STAGES = ['위치·업종 확인', '주변 지표 집계', '생존·매출 모델', '로드뷰 판독·요약', '점수 계산'];

export default function AssessApp() {
  const [view, setView] = useState<View>(viewFromHash);
  const [kakaoJsKey, setKakaoJsKey] = useState<string | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [shots, setShots] = useState<Blob[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const [cond, setCond] = useState<Conditions>(emptyConditions);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agent.config().then((c) => setKakaoJsKey(c.kakaoJsKey)).catch(() => {});
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (hash: string) => {
    location.hash = hash;
  };

  function reset() {
    setPlace(null);
    setShots([]);
    setCond(emptyConditions);
    setStep(1);
    setError(null);
    go('#/');
  }

  async function submit() {
    if (!place) return;
    setSubmitting(true);
    setError(null);
    try {
      const { assessment_id } = await withKey(() =>
        agent.create({
          lat: place.lat,
          lng: place.lng,
          industry: cond.industry?.code,
          floor_area_m2: cond.floor_area_m2 ? Number(cond.floor_area_m2) : undefined,
          floor: cond.floor ? Number(cond.floor) : undefined,
          store_name: cond.store_name.trim() || undefined,
          biz_no: cond.biz_no || undefined,
          radius_m: cond.radius_m,
          client_ref: cond.client_ref.trim() || undefined,
          images: shots,
        }),
      );
      go(`#/a/${assessment_id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="assess">
      <header className="topbar">
        <a className="brand" href="#/" onClick={reset}>
          상권 입지 심사
        </a>
        <span className="tag">내부 심사용 · 참고 자료</span>
        <nav>
          <a href="#/" onClick={reset} className={view.kind === 'new' ? 'on' : ''}>
            새 평가
          </a>
          <a href="#/history" className={view.kind === 'history' ? 'on' : ''}>
            지난 평가
          </a>
          <a href="#/areas" className={view.kind === 'areas' || view.kind === 'area' ? 'on' : ''}>
            상권분석
          </a>
          <a href="#/watch" className={view.kind === 'watch' ? 'on' : ''}>
            모니터링
          </a>
          <a href="/api/docs" target="_blank" rel="noreferrer">
            API 문서
          </a>
          <a href="#/map">지도 도구</a>
        </nav>
      </header>

      <main className="assess-main">
        {view.kind === 'new' && (
          <>
            <ol className="stepper">
              <li className={step === 1 ? 'on' : 'done'}>1 위치 확인</li>
              <li className={step === 2 ? 'on' : ''}>2 업종·조건</li>
              <li>3 결과</li>
            </ol>
            {error && <p className="warn">{error}</p>}
            {step === 1 && (
              <LocationStep kakaoJsKey={kakaoJsKey} place={place} shots={shots} onPlace={setPlace} onShots={setShots} onConfirm={() => setStep(2)} />
            )}
            {step === 2 && place && (
              <ConditionsStep place={place} shots={shots.length} value={cond} onChange={setCond} onBack={() => setStep(1)} onSubmit={submit} busy={submitting} />
            )}
          </>
        )}
        {view.kind === 'result' && <ResultLoader id={view.id} onNew={reset} />}
        {view.kind === 'history' && <History />}
        {view.kind === 'areas' && (
          <>
            <AreaSearch />
            <Opportunities />
          </>
        )}
        {view.kind === 'area' && <AreaReportLoader id={view.id} />}
        {view.kind === 'watch' && <WatchView />}
      </main>
    </div>
  );
}

/** The API client (client.ts) already asks for the key on 401 and retries; kept so call sites read the same. */
async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

function ResultLoader({ id, onNew }: { id: string; onNew: () => void }) {
  const [a, setA] = useState<Assessment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(Date.now());

  const poll = useCallback(async () => {
    for (;;) {
      const r = await withKey(() => agent.get(id, 25));
      setA(r);
      if (r.status !== 'queued' && r.status !== 'running') return;
    }
  }, [id]);

  useEffect(() => {
    setA(null);
    setErr(null);
    started.current = Date.now();
    poll().catch((e: Error) => setErr(e.message));
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [poll]);

  if (err) return <p className="warn">{err}</p>;
  if (!a || a.status === 'queued' || a.status === 'running') {
    const stage = Math.min(STAGES.length - 1, Math.floor(elapsed / 4));
    return (
      <section className="card progress">
        <h2>분석 중…</h2>
        <ol>
          {STAGES.map((s, i) => (
            <li key={s} className={i < stage ? 'done' : i === stage ? 'on' : ''}>
              {s}
            </li>
          ))}
        </ol>
        <p className="muted">{elapsed}초 · 보통 수 초, 로드뷰 판독이 있으면 30~60초 걸립니다.</p>
      </section>
    );
  }
  if (a.status === 'failed') {
    return (
      <section className="card">
        <h2>평가를 끝내지 못했습니다</h2>
        <p className="warn">
          {a.error?.title} — {a.error?.detail}
        </p>
        <button className="primary" onClick={onNew}>
          새 평가
        </button>
      </section>
    );
  }
  return <ResultView a={a} onNew={onNew} />;
}

function History() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    withKey(() => agent.history())
      .then(setItems)
      .catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <p className="warn">{err}</p>;
  if (!items) return <p className="muted">불러오는 중…</p>;
  return (
    <section className="card">
      <h2>지난 평가</h2>
      <table className="table">
        <thead>
          <tr>
            <th>일시</th>
            <th>주소</th>
            <th>업종</th>
            <th className="num">점수</th>
            <th>등급</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {items.map((h) => (
            <tr key={h.assessment_id} onClick={() => (location.hash = `#/a/${h.assessment_id}`)}>
              <td>{new Date(h.created_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</td>
              <td>{h.address ?? '—'}</td>
              <td>{h.industry ?? '—'}</td>
              <td className="num">{h.score?.toFixed(0) ?? '—'}</td>
              <td>{h.grade ?? '—'}</td>
              <td>{h.status === 'failed' ? `실패 (${h.error})` : h.status === 'partial' ? '완료 (일부 생략)' : h.status === 'done' ? '완료' : '분석 중'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
