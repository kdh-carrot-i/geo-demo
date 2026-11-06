// 상권분석 화면: 상권 이름 검색 → 후보 선택 → 상권 일대 리포트 (#/areas, #/areas/<id>).
import { useEffect, useState } from 'react';
import { AreaMap, lclsColorVar } from './AreaMap';
import { TimeBars, won } from './charts';
import { agent } from './client';
import { Refs, RentCard, Tile } from './ResultView';
import type { AreaCandidate, AreaReport } from './types';

const KIND: Record<AreaCandidate['kind'], string> = { sbiz_zone: '상권영역 경계', seoul_trdar: '서울 상권', rone_area: 'R-ONE 조사 상권', place: '장소', custom_circle: '직접 그린 원', custom_polygon: '직접 그린 다각형' };
const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());

export function AreaSearch({ initial }: { initial?: string }) {
  const [q, setQ] = useState(initial ?? '');
  const [items, setItems] = useState<AreaCandidate[] | null>(null);
  const [places, setPlaces] = useState<{ shown: number; total: number; filter: string } | null>(null);
  const [searched, setSearched] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e?: React.FormEvent, allPlaces = false) {
    e?.preventDefault();
    const term = allPlaces ? searched : q.trim();
    if (term.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const r = await agent.areas(term, allPlaces);
      setItems(r.items);
      setPlaces(r.places);
      setSearched(term);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>상권 검색</h3>
      <form className="row" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="상권·역·거리 이름 (예: 선릉역, 서면역, 강남대로, 광안리, 동대구)" aria-label="상권 이름" autoFocus />
        <button type="submit" className="primary" disabled={busy || q.trim().length < 2}>
          {busy ? '찾는 중…' : '찾기'}
        </button>
      </form>
      <p className="muted small">
        같은 이름으로 여러 후보가 나올 수 있습니다. 목록 아래 표에서 종류별 차이를 확인하십시오.
      </p>
      {error && <p className="warn">{error}</p>}
      {items && !items.length && <p className="muted">찾은 상권이 없습니다. 역 이름이나 동 이름으로 다시 찾아보십시오.</p>}
      {items && items.length > 0 && (
        <ul className="area-candidates">
          {items.map((c, i) => (
            <li key={c.id}>
              <a href={`#/areas/${encodeURIComponent(c.id)}`}>
                {i === 0 && <span className="tag rec">추천</span>} <span className="tag">{KIND[c.kind]}</span> <b>{c.name}</b>
                <span className="muted small"> {c.detail}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {places && places.total > 0 && (
        <p className="muted small places-note">
          장소 {places.shown}곳 표시 — 카카오 검색 결과 {places.total}곳 중 {places.filter}.{' '}
          {places.shown < places.total && (
            <button type="button" className="linklike" disabled={busy} onClick={() => search(undefined, true)}>
              장소 더 보기 ({places.total}곳 모두)
            </button>
          )}
        </p>
      )}
      {items && items.length > 0 && <KindGuide kinds={new Set(items.map((c) => c.kind))} />}
    </section>
  );
}

/** 이름이 같아도 범위를 만든 기관·방법이 달라 숫자가 다르게 나온다: 후보 종류별 차이 */
const KIND_GUIDE: { kind: AreaCandidate['kind']; who: string; shape: string; when: string }[] = [
  {
    kind: 'sbiz_zone',
    who: '소상공인시장진흥공단이 점포가 몰린 곳을 보고 그린 주요 상권 (전국 1,227곳)',
    shape: '실제 경계선 (다각형). 역 출구별로 나뉜 영역은 하나로 합침',
    when: '기본 선택. 경계가 있어 범위가 가장 정확함',
  },
  {
    kind: 'seoul_trdar',
    who: '서울시 상권분석서비스의 상권 (서울 1,650곳 — 골목·발달·전통시장·관광특구)',
    shape: '경계가 공개되지 않아 중심점 + 면적을 원으로 바꾼 반경',
    when: '서울시 유동인구·매출과 집계 단위가 정확히 같아야 할 때',
  },
  {
    kind: 'rone_area',
    who: '한국부동산원이 임대료·공실을 조사하는 상권 이름 (전국 약 500곳)',
    shape: '대표 지점(카카오로 찾은 장소) 중심 반경 500m 원',
    when: '경계 데이터가 없는 지방 상권 (예: 광안리, 동대구). 임대료가 이 상권 기준',
  },
  {
    kind: 'place',
    who: '카카오 장소 검색 결과 (역·건물·장소)',
    shape: '검색 지점 중심 반경 500m 원',
    when: '상권 데이터가 없거나, 특정 지점 주변만 보고 싶을 때',
  },
];

function KindGuide({ kinds }: { kinds: Set<AreaCandidate['kind']> }) {
  return (
    <details className="kind-guide" open>
      <summary className="small">후보 종류가 왜 여러 개인가요?</summary>
      <p className="muted small">
        같은 이름이라도 범위를 만든 기관과 방법이 달라 점포 수·인구 같은 숫자가 다르게 나옵니다. 위에서부터 범위가 정확한 순서이며, 보통은 <b>추천</b> 후보를 고르면 됩니다.
      </p>
      <table className="mini">
        <thead>
          <tr>
            <th>종류</th>
            <th>누가 정한 상권인가</th>
            <th>범위 모양</th>
            <th>이럴 때 고르세요</th>
          </tr>
        </thead>
        <tbody>
          {KIND_GUIDE.map((g) => (
            <tr key={g.kind} className={kinds.has(g.kind) ? '' : 'dim'}>
              <td>
                <span className="tag">{KIND[g.kind]}</span>
              </td>
              <td>{g.who}</td>
              <td>{g.shape}</td>
              <td>{g.when}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function AreaReportLoader({ id }: { id: string }) {
  const [r, setR] = useState<AreaReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setR(null);
    setError(null);
    agent.areaReport(id).then(setR).catch((e: Error) => setError(e.message));
  }, [id]);
  if (error)
    return (
      <section className="card">
        <p className="warn">{error}</p>
        <a href="#/areas">다른 상권 찾기</a>
      </section>
    );
  if (!r) return <section className="card muted">상권 데이터를 모으는 중입니다… (점포·인구·교통·시설, 보통 3~8초)</section>;
  return <AreaReportView r={r} />;
}

function ShareBars({ items, max, color, note }: { items: { name: string; count: number; share: number }[]; max?: number; color?: (name: string) => string; note?: (name: string) => string | null }) {
  const top = max ?? Math.max(...items.map((x) => x.share), 0.0001);
  return (
    <ul className="hbars" role="list">
      {items.map((x) => (
        <li key={x.name} title={`${x.name} ${x.count.toLocaleString()}곳 · ${pct(x.share, 1)}`}>
          <div className="hbar-head">
            <span className="hbar-label">{x.name}</span>
            <span className="hbar-value">
              {x.count.toLocaleString()} <small className="muted">{pct(x.share)}</small>
            </span>
          </div>
          <div className="hbar-track" aria-hidden>
            <div className="hbar-fill" style={{ width: `${Math.max(1.5, (x.share / top) * 100)}%`, background: color?.(x.name) }} />
          </div>
          {note?.(x.name) && <div className="hbar-note">{note(x.name)}</div>}
        </li>
      ))}
    </ul>
  );
}

function AreaReportView({ r }: { r: AreaReport }) {
  const sources = r.provenance;
  const refs = (keys: string[] | undefined) => <Refs keys={keys} sources={sources} />;
  const ind = r.industry;
  const sp = r.population.seoul;
  const lq = new Map(ind.lcls.map((l) => [l.name, l.lq]));
  const special = ind.lcls.filter((l) => l.lq != null && l.lq >= 1.2 && l.share >= 0.03);

  return (
    <div className="result">
      <header className="result-head">
        <div>
          <h2>{r.area.name} 상권 분석</h2>
          <p className="muted">
            {[r.area.sido_nm, r.area.sgg_nm].filter(Boolean).join(' ')} · {r.area.basis} · 면적 {(r.area.area_m2 / 10000).toFixed(1)}만㎡ · 점포 {ind.total.toLocaleString()}곳
          </p>
        </div>
        <div className="actions">
          {/* 브라우저 인쇄 → "PDF로 저장"하면 리포트 파일이 된다 (메뉴·버튼은 인쇄에서 빠짐) */}
          <button className="secondary" onClick={() => window.print()}>
            인쇄 · PDF 저장
          </button>
          {r.area.kind.startsWith('custom') && (
            <a className="button secondary" href="#/map">
              지도 도구로 돌아가기
            </a>
          )}
          <a className="button secondary" href="#/areas">
            다른 상권 찾기
          </a>
        </div>
      </header>

      {r.warnings.length > 0 && (
        <ul className="warn-list small">
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {r.lifecycle && (
        <section className="card">
          <h3>
            상권 생애주기 {refs(r.lifecycle.sources)}
          </h3>
          <div className="lifecycle">
            {(['성장', '성숙', '쇠퇴', '재생'] as const).map((st) => (
              <span key={st} className={`stage${r.lifecycle!.stage === st ? ' on' : ''} stage-${st}`}>
                {st}
              </span>
            ))}
            {r.lifecycle.stage === '판단 보류' && <span className="stage on">판단 보류</span>}
          </div>
          <p>{r.lifecycle.reason}</p>
          {r.lifecycle.evidence.length > 0 && (
            <ul className="small muted">
              {r.lifecycle.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <p className="muted small">판정 규칙: 최근 3년 음식점 순증 ≥ +5% → 성장 (그 전 3년이 순감이었으면 재생), ≤ −5% 또는 개업 속도 감소와 순감 → 쇠퇴, 그 밖 → 성숙. 검색 화제성(네이버 데이터랩)은 키 확보 후 추가 예정.</p>
        </section>
      )}

      <section className="card">
        <h3>업종 배치 {refs(ind.sources)}</h3>
        <AreaMap r={r} />
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>업종 분포 (대분류) {refs(ind.sources)}</h3>
          <p className="muted small">
            괄호 안은 {ind.baseline_area} 전체 대비 배수 (1.2배 이상 = 이 상권에 특히 많음). 눌러서 중분류를 펼칩니다.
          </p>
          {ind.lcls.map((l) => (
            <details key={l.name} className="lcls">
              <summary>
                <ShareBars
                  items={[l]}
                  max={ind.lcls[0].share}
                  color={lclsColorVar}
                  note={() => (l.lq != null ? `${ind.baseline_area} 대비 ${l.lq.toFixed(2)}배` : null)}
                />
              </summary>
              <ShareBars items={l.mcls} color={() => lclsColorVar(l.name)} />
            </details>
          ))}
        </section>

        <section className="card">
          <h3>음식점 구성 (중분류) {refs(ind.sources)}</h3>
          {ind.food.length ? <ShareBars items={ind.food} color={() => lclsColorVar('음식')} /> : <p className="muted">음식점이 없습니다.</p>}
          <h4>많은 업종 (소분류 상위 15)</h4>
          <ShareBars items={ind.top_scls} />
        </section>
      </div>

      <section className="card">
        <h3>상권 성격 {refs(ind.sources)}</h3>
        <div className="tiles">
          <Tile label="특화 업종" value={special.length ? special.map((l) => l.name).join(', ') : '없음'} hint={special.length ? special.map((l) => `${l.name} ${l.lq?.toFixed(1)}배`).join(' · ') : `${ind.baseline_area} 평균과 비슷한 구성`} />
          {ind.floors.map((f) => (
            <Tile key={f.name} label={`${f.name} 점포`} value={pct(f.share)} hint={`${f.count.toLocaleString()}곳`} />
          ))}
          <Tile label="지점명 있는 점포" value={pct(ind.branch_share)} hint="프랜차이즈·체인 근사" />
          {lq.get('숙박') != null && (lq.get('숙박') ?? 0) >= 2 && <Tile label="숙박 비중" value={`${lq.get('숙박')!.toFixed(1)}배`} hint="관광·유흥 상권 신호" />}
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>점포 증감 {refs(r.store_change?.sources)}</h3>
          {r.store_change ? (
            <>
              <div className="tiles">
                <Tile label={`${r.store_change.from} → ${r.store_change.to}`} value={`+${r.store_change.all.opened} / −${r.store_change.all.closed}`} hint={`기존 ${r.store_change.all.before.toLocaleString()}곳 중 ${pct(r.store_change.all.closed / r.store_change.all.before)} 사라짐`} />
              </div>
              <table className="mini">
                <thead>
                  <tr>
                    <th>대분류</th>
                    <th className="num">기존</th>
                    <th className="num">새로 생김</th>
                    <th className="num">사라짐</th>
                  </tr>
                </thead>
                <tbody>
                  {r.store_change.by_lcls.map((x) => (
                    <tr key={x.name}>
                      <td>{x.name}</td>
                      <td className="num">{x.before}</td>
                      <td className="num">+{x.opened}</td>
                      <td className="num">−{x.closed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted">없음 — 이전 분기 상가정보가 서울만 있습니다. 다음 분기 파일을 받으면 전국 비교가 됩니다.</p>
          )}
        </section>

        <section className="card">
          <h3>음식점 개업·폐업 (인허가) {refs(r.food_trend?.sources)}</h3>
          {r.food_trend ? (
            <>
              <p className="muted small">영업 중 {r.food_trend.active.toLocaleString()}곳 · 기준 {r.food_trend.as_of}</p>
              <table className="mini">
                <thead>
                  <tr>
                    <th>연도</th>
                    <th className="num">개업</th>
                    <th className="num">폐업</th>
                    <th className="num">순증</th>
                  </tr>
                </thead>
                <tbody>
                  {r.food_trend.by_year.map((y) => (
                    <tr key={y.year}>
                      <td>{y.year}</td>
                      <td className="num">{y.opened}</td>
                      <td className="num">{y.closed}</td>
                      <td className="num">{y.opened - y.closed > 0 ? '+' : ''}{y.opened - y.closed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="muted">범위 안에 일반음식점 인허가 기록이 없습니다.</p>
          )}
        </section>
      </div>

      <section className="card">
        <h3>인구</h3>
        {sp ? (
          <>
            <p className="muted small">
              서울 상권분석 {sp.trade_areas.length}개 상권 합산 ({sp.trade_areas.join(', ')}) · {sp.quarter.slice(0, 4)}년 {sp.quarter[4]}분기 {refs(sp.sources)}
            </p>
            <div className="tiles">
              {sp.floating && <Tile label="유동인구 (하루 평균)" value={num(sp.floating.daily_avg)} unit="명" hint={`분기 합계 ${num(sp.floating.quarter_total)} · 주말 ${pct(sp.floating.weekend_share)} · 남성 ${pct(sp.floating.male_share)}`} />}
              {sp.residents && <Tile label="상주인구" value={num(sp.residents.population)} unit="명" hint={`가구 ${num(sp.residents.households)} · 아파트 ${num(sp.residents.apt_households)}`} />}
              {sp.workers && <Tile label="직장인구" value={num(sp.workers.workers)} unit="명" />}
            </div>
            {sp.floating && (
              <div className="grid-2">
                <TimeBars title="유동인구 시간대 비중" data={sp.floating.by_time} />
                <TimeBars title="유동인구 연령대 비중" data={sp.floating.by_age} />
              </div>
            )}
          </>
        ) : (
          <p className="muted small">서울 상권분석 상권이 범위에 없어, 아래 행정동 통계를 씁니다.</p>
        )}
        {(r.population.demand || r.supply_pipeline) && (
          <div className="tiles">
            {r.population.demand?.workers && (
              <Tile
                label="직장인 (국민연금)"
                value={num(r.population.demand.workers.members)}
                unit="명"
                hint={`300인 이하 사업장 ${num(r.population.demand.workers.workplaces)}곳${r.population.demand.workers.income ? ` · 월 소득 추정 ${num(r.population.demand.workers.income / 10000)}만 원` : ''} · ${r.population.demand.scope}`}
                refs={refs(r.population.demand.sources)}
              />
            )}
            {r.population.demand?.residents && (
              <Tile
                label="주민등록 인구"
                value={num(r.population.demand.residents.population)}
                unit="명"
                hint={`${num(r.population.demand.residents.households)}세대${r.population.demand.residents.change_pct != null ? ` · 1년 ${r.population.demand.residents.change_pct > 0 ? '+' : ''}${r.population.demand.residents.change_pct}%` : ''} · ${r.population.demand.residents.as_of}`}
                refs={refs(r.population.demand.sources)}
              />
            )}
            {r.supply_pipeline && r.supply_pipeline.under_construction_m2.buildings > 0 && (
              <Tile
                label="곧 생길 상가·사무 (공사 중)"
                value={num(r.supply_pipeline.under_construction_m2.retail + r.supply_pipeline.under_construction_m2.office)}
                unit="㎡"
                hint={`${r.supply_pipeline.under_construction_m2.buildings}개 건물 · ${r.supply_pipeline.scope}`}
                refs={refs(r.supply_pipeline.sources)}
              />
            )}
            {r.supply_pipeline && r.supply_pipeline.upcoming_households_3y > 0 && (
              <Tile
                label="입주 예정 (1km, 3년)"
                value={num(r.supply_pipeline.upcoming_households_3y)}
                unit="세대"
                hint={r.supply_pipeline.projects.filter((p) => p.kind === 'housing').slice(0, 3).map((p) => `${p.name ?? '단지'} ${p.size} · ${p.schedule}`).join(' · ')}
                refs={refs(r.supply_pipeline.sources)}
              />
            )}
          </div>
        )}
        <h4>범위에 걸친 행정동 {refs(r.population.dong_sources)}</h4>
        <table className="mini">
          <thead>
            <tr>
              <th>행정동</th>
              <th className="num">점포 비중</th>
              <th className="num">인구</th>
              <th className="num">가구</th>
              <th className="num">종사자</th>
              <th className="num">생활인구 (시간당)</th>
              <th className="num">유동인구 (시간당)</th>
            </tr>
          </thead>
          <tbody>
            {r.population.dongs.map((d) => (
              <tr key={d.adm_cd}>
                <td>{d.adm_nm}</td>
                <td className="num">{pct(d.store_share)}</td>
                <td className="num">{num(d.population)}</td>
                <td className="num">{num(d.households)}</td>
                <td className="num">{num(d.workers)}</td>
                <td className="num">{d.living_pop_hourly != null ? num(d.living_pop_hourly) : '—'}</td>
                <td className="num">
                  {d.flowpop_hourly ? (
                    <>
                      {num(d.flowpop_hourly.value)}
                      <small className="muted"> {d.flowpop_hourly.kind === 'measured' ? '실측' : `추정 ${num(d.flowpop_hourly.range?.[0])}~${num(d.flowpop_hourly.range?.[1])}`}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          인구·가구·종사자는 SGIS {r.population.dongs[0]?.sgis_year ?? ''} 행정동 전체 값입니다. 생활인구는 서울(그 시간에 동 안에 있는 사람), 유동인구는 서울 밖(움직이는 사람)이라 정의가 다릅니다.
          {r.population.dongs.some((d) => d.flowpop_hourly) && <span className="internal-note"> 유동인구: {r.population.dongs.find((d) => d.flowpop_hourly)!.flowpop_hourly!.license}</span>}
        </p>
        {!sp?.floating && !r.population.dongs.some((d) => d.flowpop_hourly || d.living_pop_hourly != null) && (
          <p className="muted small">유동인구: 없음 — 이 지역은 공개 유동·생활인구가 없습니다. 필요한 것: 행정동·격자 단위 유동인구. 확보 방법: 통신사 유동인구 구매 (KT PLIP·SKT 지오비전).</p>
        )}
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>교통 {refs(r.transport.sources)}</h3>
          <p className="muted small">중심에서 반경 {r.transport.radius_m}m</p>
          {r.transport.stations.length ? (
            <table className="mini">
              <thead>
                <tr>
                  <th>지하철역</th>
                  <th>노선</th>
                  <th className="num">거리</th>
                  <th className="num">하루 승하차</th>
                  <th className="num">붐비는 시간</th>
                </tr>
              </thead>
              <tbody>
                {r.transport.stations.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.lines.join(', ')}</td>
                    <td className="num">{s.distance_m}m</td>
                    <td className="num">{s.ridership ? num(s.ridership.daily_avg) : '—'}</td>
                    <td className="num">{s.ridership?.peak_hour ? `${s.ridership.peak_hour}시` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">반경 안에 지하철역이 없습니다.</p>
          )}
          {r.transport.stations.some((s) => !s.ridership) && (
            <p className="muted small">승하차 '—': 없음 — 적재한 곳은 서울·부산·대구·인천·광주·대전 도시철도입니다. 광역철도(코레일)는 한국철도공사 역별 승하차 파일로 확보할 수 있습니다.</p>
          )}
          <div className="tiles">
            <Tile label="주차장" value={num(r.transport.parking_lots)} unit="곳" />
            <Tile
              label="버스정류장 (범위 안)"
              value={num(r.transport.bus_stops.count)}
              unit="곳"
              hint={`이름 기준 ${num(r.transport.bus_stops.names)}곳 (방향별 정류장을 하나로) · 가까운 곳: ${r.transport.bus_stops.nearest.slice(0, 3).join(', ') || '없음'}`}
            />
          </div>
        </section>

        <section className="card">
          <h3>주요 시설 {refs(r.transport.sources)}</h3>
          <p className="muted small">중심에서 반경 {r.transport.radius_m}m · 카카오 장소 기준</p>
          <div className="tiles">
            {r.transport.facilities.map((f) => (
              <Tile key={f.code} label={f.label} value={num(f.count)} unit="곳" hint={f.nearest.slice(0, 2).join(', ')} />
            ))}
          </div>
        </section>
      </div>

      {r.rent && <RentCard r={r.rent} refs={refs(r.rent.sources)} />}

      <section className="card">
        <h3>매출 {refs(r.sales?.sources)}</h3>
        {r.sales ? (
          <>
            <p className="muted small">
              {r.sales.quarter.slice(0, 4)}년 {r.sales.quarter[4]}분기 · {r.sales.note}
            </p>
            <div className="grid-2">
              <div>
                <div className="tiles">
                  <Tile label="월 매출 합계" value={won(r.sales.monthly_total)} hint={`주말 비중 ${pct(r.sales.weekend_share)}`} />
                </div>
                <TimeBars title="시간대별 매출 비중" data={r.sales.by_time} />
              </div>
              <table className="mini">
                <thead>
                  <tr>
                    <th>업종</th>
                    <th className="num">월 매출</th>
                    <th className="num">점포</th>
                    <th className="num">점포당</th>
                  </tr>
                </thead>
                <tbody>
                  {r.sales.top.map((t) => (
                    <tr key={t.industry}>
                      <td>{t.industry}</td>
                      <td className="num">{won(t.monthly)}</td>
                      <td className="num">{num(t.stores)}</td>
                      <td className="num">{won(t.per_store)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="muted">없음 — 공개 매출 데이터는 서울 상권분석서비스뿐입니다. 서울 밖은 점포 단위 카드매출(DW 백업분 사용 허가 또는 카드사 구매)이 필요합니다.</p>
        )}
      </section>

      <details className="card" id="sources">
        <summary>출처와 참고사항 ({sources.length})</summary>
        <div className="table-wrap">
          <table className="table src-table">
            <thead>
              <tr>
                <th>#</th>
                <th>제공 · 데이터</th>
                <th>API</th>
                <th>사용한 값</th>
                <th>단위·범위</th>
                <th>기준 시점</th>
                <th>쓴 곳</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((p, i) => (
                <tr key={p.key} id={`src-${p.key}`}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <b>{p.provider}</b>
                    <br />
                    {p.dataset}
                  </td>
                  <td>
                    <code>{p.api}</code>
                  </td>
                  <td>{p.fields}</td>
                  <td>{p.scope}</td>
                  <td>{p.as_of || '—'}</td>
                  <td>
                    {p.used_for.join(', ')}
                    {p.license && <div className="internal-note small">{p.license}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          생성 {new Date(r.generated_at).toLocaleString('ko-KR')} · {(r.elapsed_ms / 1000).toFixed(1)}초 · 참고 자료이며 현장 확인이 필요합니다.
        </p>
      </details>
    </div>
  );
}
