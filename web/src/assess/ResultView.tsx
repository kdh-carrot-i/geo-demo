// Step 4: the finished assessment.
import { useMemo } from 'react';
import { ProfitCard } from './ProfitCard';
import { agent } from './client';
import { ChatPanel } from './ChatPanel';
import { RangeBar, ScoreBars, TimeBars, won } from './charts';
import { SiteMap, type Poi } from './SiteMap';
import type { Assessment, BuildingInfo, Component, Explanation, FloorInfo, Grade, Source } from './types';

const GRADE: Record<Grade, { tone: string; text: string }> = {
  A: { tone: 'good', text: '우수' },
  B: { tone: 'good', text: '양호' },
  C: { tone: 'warning', text: '보통' },
  D: { tone: 'serious', text: '주의' },
  E: { tone: 'critical', text: '위험' },
};
const BIZ: Record<string, string> = { active: '계속사업자', suspended: '휴업', closed: '폐업', unknown: '확인 안 됨' };
const CONF: Record<string, string> = { A: '실측', B: '계산·모델', C: '추정' };

const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());

export function ResultView({ a, onNew }: { a: Assessment; onNew: () => void }) {
  const s = a.score!;
  const ind = a.indicators!;
  const loc = a.location!;
  const f = a.sales_forecast!;
  const storeModel = f.model_version === 'sales-v2' || f.model_version === 'sales-v3';
  const comp = ind.competitors;
  const pois = useMemo<Poi[]>(
    () => comp.nearest.map((n) => ({ name: n.name, detail: `${n.industry} · ${n.distance_m}m${n.floor ? ` · ${n.floor}층` : ''}`, lat: n.lat, lng: n.lng })),
    [comp.nearest],
  );
  const g = s.grade ? GRADE[s.grade] : null;
  const sources = a.provenance ?? [];
  // footnote numbers follow the order of the 출처 table at the bottom
  const refs = (keys: string[] | undefined) => <Refs keys={keys} sources={sources} />;

  return (
    <div className="result">
      <header className="result-head">
        <div>
          <h2>{loc.address_road ?? loc.address_jibun}</h2>
          <p className="muted">
            {a.industry?.name ?? '업종 미확정'}
            {a.industry?.franchise_brand ? ` · ${a.industry.franchise_brand}` : ''} · {loc.adm_nm}
            {loc.trade_area ? ` · ${loc.trade_area.name}(${loc.trade_area.type})` : loc.sbiz_zone ? ` · 상권 ${loc.sbiz_zone.name}` : ''} · 반경 {comp.radius_m}m
            {a.client_ref ? ` · ${a.client_ref}` : ''}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              agent
                .watchAdd({
                  name: `${a.industry?.franchise_brand ?? a.industry?.name ?? '매장'} · ${loc.address_road ?? loc.address_jibun ?? ''}`,
                  lat: loc.lat,
                  lng: loc.lng,
                  industry_code: a.industry?.code,
                  industry_name: a.industry?.name,
                  brand: a.industry?.franchise_brand,
                  radius_m: 500,
                  memo: a.client_ref ?? undefined,
                })
                .then(() => (location.hash = '#/watch'))
                .catch((e: Error) => alert(`모니터링 등록 실패: ${e.message}`))
            }
          >
            모니터링에 추가
          </button>
          <button type="button" className="secondary" onClick={() => agent.openReport(a.assessment_id)}>
            리포트 열기 (인쇄·PDF)
          </button>
          <button type="button" className="primary" onClick={onNew}>
            새 평가
          </button>
        </div>
      </header>

      <div className="grid-2">
        <section className="card hero">
          <div className="hero-num">
            <span className="big">{s.total == null ? '—' : s.total.toFixed(1)}</span>
            <span className="unit">/ 100</span>
          </div>
          {g ? (
            <span className={`badge ${g.tone}`}>
              <b>{s.grade}</b> {g.text}
            </span>
          ) : (
            <span className="badge neutral">등급 보류 · 근거 부족</span>
          )}
          <dl className="kv">
            <dt>3년 생존 확률</dt>
            <dd>{s.survival_3y_prob == null ? '— (음식점 업종만)' : pct(s.survival_3y_prob)}</dd>
            <dt>근거가 있는 항목</dt>
            <dd>{pct(s.evidence_weight)}</dd>
            {a.business_check && (
              <>
                <dt>사업자 상태</dt>
                <dd>
                  {BIZ[a.business_check.status]}
                  {a.business_check.tax_type ? ` · ${a.business_check.tax_type.replace('부가가치세 ', '')}` : ''}
                </dd>
              </>
            )}
          </dl>
          {a.summary?.headline && <p className="headline">{a.summary.headline}</p>}
          {s.explanation && <Judgment e={s.explanation} />}
          <p className="disclaimer">{a.disclaimer}</p>
        </section>

        <section className="card">
          <h3>점수 구성</h3>
          <p className="muted small">항목마다 50점이 비교 대상의 중간입니다(막대의 세로선). 펼치면 계산 방법과 사용한 숫자를 볼 수 있습니다.</p>
          <ul className="comps">
            {s.components.map((c) => (
              <ComponentRow key={c.key} c={c} refs={refs} />
            ))}
          </ul>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h3>
            {storeModel ? '월 매출 (이 자리 예상)' : '월 매출 (점포당)'} {refs(f.sources)}
          </h3>
          {storeModel && f.variants ? (
            <>
              {(['franchise', 'independent'] as const).map((k) => {
                const v = f.variants![k];
                const r = v.total_est ?? v.card;
                return (
                  <div key={k} className="sales-variant">
                    <p className="small">
                      <b>{k === 'franchise' ? `프랜차이즈${v.brand && v.brand !== '기타 브랜드' ? ` (${v.brand})` : ''}` : '개인 매장'}</b>
                      {f.conditions?.brand ? (k === 'franchise' ? ' · 입력 상호 기준' : '') : k === 'independent' ? ' · 입력 상호 기준' : ''}
                    </p>
                    <RangeBar p10={r.p10} p50={r.p50} p90={r.p90} bench={null} />
                    {v.calib_ratio && v.total_est && <p className="muted small">카드 결제 규모 × {v.calib_ratio} ({v.calib_basis === '브랜드' ? '브랜드 비율' : v.calib_basis === '업종' ? '같은 업종 브랜드 중앙값' : '전체 중앙값'})</p>}
                    {v.closure && <p className="small">개업 1년 안 폐업 가능성 약 {Math.round(v.closure.prob_12m * 100)}%{v.closure.peer_rate != null && ` (같은 업종 새 가게 평균 ${Math.round(v.closure.peer_rate * 100)}%)`}</p>}
                  </div>
                );
              })}
              <p className="muted small">
                {f.basis !== 'total_est' ? '카드 결제 규모' : f.model_version === 'sales-v3' ? '총매출 추정 · 개업 2년 차 기준' : `총매출 추정 = 카드 결제 규모 × ${f.calib_ratio}`}
                {f.conditions && ` · ${f.conditions.industry_card} · 층 ${f.conditions.floor}${f.conditions.site_area_m2 ? ` · ${f.conditions.site_area_m2}㎡` : ' · 면적 미입력'}`}
                {f.benchmark && ` · ${f.benchmark.scope} ${num(f.benchmark.value)}원`} · 신뢰 {f.confidence}({CONF[f.confidence]})
              </p>
              {f.method && (
                <details className="sales-why">
                  <summary className="small">이 매출은 어디서 왔나요?</summary>
                  <dl className="sales-method">
                    <dt>예상 범위 {refs(['model_sales_v2'])}</dt>
                    <dd>{f.method.range}</dd>
                    <dt>주변 비교값 {refs(['card_sales'])}</dt>
                    <dd>{f.method.benchmark}</dd>
                    <dt>원천</dt>
                    <dd>{f.method.origin}</dd>
                    <dt>정확도</dt>
                    <dd>{f.method.accuracy}</dd>
                    {f.method.closure && (
                      <>
                        <dt>폐업 가능성</dt>
                        <dd>{f.method.closure}</dd>
                      </>
                    )}
                  </dl>
                </details>
              )}
              {f.first_month_note && <p className="small">※ {f.first_month_note}</p>}
              {f.note && <p className="muted small">{f.note}</p>}
            </>
          ) : f.p10 != null && f.p50 != null && f.p90 != null ? (
            <>
              <RangeBar p10={f.p10} p50={f.p50} p90={f.p90} bench={f.benchmark?.value ?? null} />
              <p className="muted small">
                {f.benchmark?.scope} · 예측은 신뢰 {f.confidence}({CONF[f.confidence]}) — 상권 실제 평균을 함께 보세요.
              </p>
              {f.method && (
                <details className="sales-why">
                  <summary className="small">이 매출은 어디서 왔나요?</summary>
                  <dl className="sales-method">
                    <dt>예상 범위 {refs(['model_sales'])}</dt>
                    <dd>{f.method.range}</dd>
                    <dt>상권 실제 평균 {refs(['seoul_sales', 'seoul_store'])}</dt>
                    <dd>{f.method.benchmark}</dd>
                    <dt>원천</dt>
                    <dd>{f.method.origin} (서울 열린데이터광장 상권 추정매출·점포 자료)</dd>
                    <dt>정확도</dt>
                    <dd>{f.method.accuracy}</dd>
                  </dl>
                </details>
              )}
            </>
          ) : (
            <p className="muted">{f.note}</p>
          )}
        </section>

        <section className="card">
          <h3>경쟁</h3>
          <div className="tiles">
            <Tile label="같은 업종" value={num(comp.same_industry)} unit="곳" refs={refs(comp.sources)} />
            <Tile label="전체 점포" value={num(comp.all_stores)} unit="곳" refs={refs(comp.sources)} />
            {comp.franchise_share != null && (
              <Tile label="같은 업종 중 가맹점" value={pct(comp.franchise_share)} hint="상호로 찾은 공정위 가맹 브랜드 (직영 제외)" refs={refs(comp.sources)} />
            )}
            <Tile label="밀집도 (입지계수)" value={comp.location_quotient?.toFixed(2) ?? '—'} hint="1 = 서울 평균, 2 이상 과밀" refs={refs(comp.sources)} />
            {ind.store_change?.same_industry && (
              <Tile
                label={`같은 업종 증감 (${ind.store_change.from}→${ind.store_change.to})`}
                value={`+${ind.store_change.same_industry.opened} / −${ind.store_change.same_industry.closed}`}
                hint={`새로 생김 / 사라짐 · 기존 ${ind.store_change.same_industry.before}곳 중 ${pct(ind.store_change.same_industry.before ? ind.store_change.same_industry.closed / ind.store_change.same_industry.before : null)} 사라짐`}
                refs={refs(ind.store_change.sources)}
              />
            )}
            {ind.store_change && (
              <Tile
                label={`전체 점포 증감 (${ind.store_change.from}→${ind.store_change.to})`}
                value={`+${ind.store_change.all.opened} / −${ind.store_change.all.closed}`}
                hint={`기존 ${ind.store_change.all.before}곳 중 ${pct(ind.store_change.all.before ? ind.store_change.all.closed / ind.store_change.all.before : null)} 사라짐 (상가정보 비교)`}
                refs={refs(ind.store_change.sources)}
              />
            )}
            {ind.supply_pipeline && ind.supply_pipeline.under_construction_m2.buildings > 0 && (
              <Tile
                label="곧 생길 상가·사무 (공사 중)"
                value={num(ind.supply_pipeline.under_construction_m2.retail + ind.supply_pipeline.under_construction_m2.office)}
                unit="㎡"
                hint={`근생·판매 ${num(ind.supply_pipeline.under_construction_m2.retail)}㎡ · 업무 ${num(ind.supply_pipeline.under_construction_m2.office)}㎡ · ${ind.supply_pipeline.under_construction_m2.buildings}개 건물 · 허가만 난 곳 ${num(ind.supply_pipeline.permitted_m2)}㎡ · ${ind.supply_pipeline.scope}`}
                refs={refs(ind.supply_pipeline.sources)}
              />
            )}
            {ind.supply_pipeline && ind.supply_pipeline.upcoming_households_3y > 0 && (
              <Tile
                label="입주 예정 (1km, 3년)"
                value={num(ind.supply_pipeline.upcoming_households_3y)}
                unit="세대"
                hint={ind.supply_pipeline.projects.filter((p) => p.kind === 'housing').slice(0, 3).map((p) => `${p.name ?? '단지'} ${p.size} · ${p.schedule}`).join(' · ')}
                refs={refs(ind.supply_pipeline.sources)}
              />
            )}
            {ind.food_license_churn && (
              <Tile
                label="음식점 최근 1년"
                value={`+${ind.food_license_churn.opened_12m} / −${ind.food_license_churn.closed_12m}`}
                hint="개업 / 폐업 (일반음식점 인허가)"
                refs={refs(ind.food_license_churn.sources)}
              />
            )}
          </div>
          <p className="muted small">{comp.scope}</p>
        </section>
      </div>

      {a.profitability && <ProfitCard p={a.profitability} refs={refs(a.profitability.sources)} />}
      {a.brand && <BrandCard b={a.brand} refs={refs(a.brand.sources)} />}
      {ind.rent && <RentCard r={ind.rent} refs={refs(ind.rent.sources)} />}

      <section className="card">
        <h3>주변 지도</h3>
        <div className="map-row">
          <SiteMap lat={loc.lat} lng={loc.lng} radiusM={comp.radius_m} pois={pois} height={360} />
          <div>
            <p className="legend-line">
              <i className="dot site" /> 검토 위치 <i className="dot poi" /> 같은 업종 (가까운 10곳) <i className="ring" /> 반경 {comp.radius_m}m
            </p>
            <ol className="near">
              {comp.nearest.map((n, i) => (
                <li key={i}>
                  <span>
                    {n.name}
                    {n.brand && <span className="sig-group"> {n.brand}</span>}
                  </span>
                  <span className="muted">
                    {n.distance_m}m{n.floor ? ` · ${n.floor}층` : ''}
                  </span>
                </li>
              ))}
              {comp.nearest.length === 0 && <li className="muted">반경 안에 같은 업종 점포가 없습니다.</li>}
            </ol>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>수요</h3>
        <div className="tiles">
          {ind.floating_pop && (
            <Tile label="유동인구 (분기 합계)" value={num(ind.floating_pop.quarter_total)} unit="명" hint={ind.floating_pop.scope} refs={refs(ind.floating_pop.sources)} />
          )}
          {ind.floating_pop && (
            <Tile label="유동인구 2030 비중" value={pct(ind.floating_pop.share_2030)} hint={`주말 비중 ${pct(ind.floating_pop.weekend_share)}`} refs={refs(ind.floating_pop.sources)} />
          )}
          <Tile label="상주인구" value={num(ind.residents?.population)} unit="명" hint={ind.residents?.scope} refs={refs(ind.residents?.sources)} />
          <Tile label="가구" value={num(ind.residents?.households)} unit="가구" hint={ind.residents?.scope} refs={refs(ind.residents?.sources)} />
          {ind.resident_registry && (
            <Tile
              label="주민등록 인구 (법정동)"
              value={num(ind.resident_registry.population)}
              unit="명"
              hint={[
                `${num(ind.resident_registry.households)}세대`,
                ind.resident_registry.population_change_pct != null && `1년 ${ind.resident_registry.population_change_pct > 0 ? '+' : ''}${ind.resident_registry.population_change_pct}%`,
                ind.resident_registry.share_20_39 != null && `20~39세 ${pct(ind.resident_registry.share_20_39)}`,
                ind.resident_registry.scope,
              ].filter(Boolean).join(' · ')}
              refs={refs(ind.resident_registry.sources)}
            />
          )}
          {ind.nps_workers && (
            <Tile
              label="직장인 (국민연금, 법정동)"
              value={num(ind.nps_workers.members_small)}
              unit="명"
              hint={[
                `300인 이하 사업장 기준 · 전체 ${num(ind.nps_workers.members_all)}명(본사 등록 포함)`,
                ind.nps_workers.monthly_income_est != null && `월 소득 추정 ${num(Math.round(ind.nps_workers.monthly_income_est / 10000))}만 원`,
                ind.nps_workers.top_employers.length > 0 && `주요 사업장: ${ind.nps_workers.top_employers.slice(0, 3).map((e) => `${e.name} ${num(e.members)}명`).join(', ')}`,
                ind.nps_workers.scope,
              ].filter(Boolean).join(' · ')}
              refs={refs(ind.nps_workers.sources)}
            />
          )}
          <Tile label="직장인구" value={num(ind.workers?.workers)} unit="명" hint={ind.workers?.scope} refs={refs(workerKeys(ind.workers?.sources))} />
          {ind.workers?.businesses != null && <Tile label="사업체 (행정동)" value={num(ind.workers.businesses)} unit="곳" refs={refs(['sgis_company'])} />}
          {ind.flowpop_dong && (
            <Tile
              label={`유동인구 (시간당 평균${ind.flowpop_dong.kind === 'measured' ? ', 실측' : ', 추정'})`}
              value={num(ind.flowpop_dong.hourly_avg)}
              unit="명"
              hint={`${ind.flowpop_dong.range ? `80% 범위 ${num(ind.flowpop_dong.range[0])}~${num(ind.flowpop_dong.range[1])}명 · ` : ''}${ind.flowpop_dong.scope}`}
              refs={refs(ind.flowpop_dong.sources)}
            />
          )}
          {ind.living_pop && (
            <Tile label="생활인구 (시간당 평균)" value={num(ind.living_pop.hourly_avg)} unit="명" hint={ind.living_pop.scope} refs={refs(ind.living_pop.sources)} />
          )}
          {ind.land_price && (
            <Tile label="공시지가" value={won(ind.land_price.official_price_per_m2)} unit="/㎡" hint={ind.land_price.year_month ?? ''} refs={refs(ind.land_price.sources)} />
          )}
        </div>
        <div className="grid-2">
          {ind.floating_pop && <TimeBars title={`유동인구 시간대 비중 · ${ind.floating_pop.scope}`} data={ind.floating_pop.by_time} refs={refs(ind.floating_pop.sources)} />}
          {ind.flowpop_dong && (
            <TimeBars title={`유동인구 시간대 비중 · ${ind.flowpop_dong.kind === 'measured' ? '경기 실측' : '추정 (비슷한 경기 행정동 10곳 평균)'}`} data={ind.flowpop_dong.by_time} refs={refs(ind.flowpop_dong.sources)} />
          )}
          {ind.living_pop && <TimeBars title={`생활인구 시간대 비중 · ${ind.living_pop.scope}`} data={ind.living_pop.by_time} refs={refs(ind.living_pop.sources)} />}
        </div>
        {ind.flowpop_dong && <p className="internal-note small">{ind.flowpop_dong.license}</p>}
        {!ind.floating_pop && !ind.flowpop_dong && <p className="muted small">유동인구는 서울 상권과 경기·추정 대상 행정동에서 제공됩니다. 이 위치는 주거·직장인구로 수요를 계산했습니다.</p>}
      </section>

      {(a.summary || a.vision) && (
        <div className="grid-2">
          {a.summary && (
            <section className="card">
              <h3>요약</h3>
              <List title="기회 요인" items={a.summary.opportunities} />
              <List title="리스크" items={a.summary.risks} />
              <List title="현장에서 확인할 것" items={[...a.summary.unknowns, ...(a.vision?.cannot_tell ?? [])]} />
            </section>
          )}
          {a.vision && (
            <section className="card">
              <h3>로드뷰 판독</h3>
              <p>
                <b>{a.vision.area_type}</b> · {a.vision.observations.road} · {a.vision.observations.sidewalk}
              </p>
              <ScoreBars
                bars={Object.entries(a.vision.scores).map(([k, v]) => ({ label: VISION[k] ?? k, value: v, tip: `${VISION[k] ?? k} ${v}점 (AI 판독, 신뢰 C)` }))}
              />
              {a.vision.observations.vacancy_signs.length > 0 && <List title="공실·쇠퇴 징후" items={a.vision.observations.vacancy_signs} />}
            </section>
          )}
        </div>
      )}

      <ChatPanel id={a.assessment_id} />

      <SiteHistoryCard h={ind.site_history ?? null} refs={refs(ind.site_history?.sources)} />

      {ind.buildings ? (
        <BuildingCard b={ind.buildings} refs={refs(ind.buildings.sources)} />
      ) : (
        <section className="card">
          <h3>건축물대장</h3>
          <p className="muted small">이 위치의 지번에서 건축물대장을 찾지 못했습니다 (도로·공터이거나 지번이 확정되지 않은 위치일 수 있습니다).</p>
        </section>
      )}

      <details className="card" id="sources">
        <summary>
          출처와 참고 사항 <span className="muted small">— 출처 {sources.length}곳{(a.warnings ?? []).length ? ` · 참고 사항 ${a.warnings!.length}건` : ''}</span>
        </summary>
        {(a.warnings ?? []).length > 0 && <List title="참고 사항" items={a.warnings!} />}
        <h4>데이터 출처</h4>
        <p className="muted small">화면의 [번호]는 아래 표의 번호입니다. 이 평가에 실제로 쓰인 출처만 표시합니다.</p>
        <div className="table-wrap">
          <table className="table src-table">
            <thead>
              <tr>
                <th>#</th>
                <th>제공 기관 · 데이터</th>
                <th>API (서비스명)</th>
                <th>사용한 값</th>
                <th>단위·범위</th>
                <th>기준 시점</th>
                <th>이 평가에서 쓴 곳</th>
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
      </details>
    </div>
  );
}

const VISION: Record<string, string> = { pedestrian: '보행 유동', accessibility: '접근성', visibility: '가시성', commercial_density: '상업 밀집', facility_condition: '시설 상태' };

export function Tile({ label, value, unit, hint, refs }: { label: string; value: string; unit?: string; hint?: string; refs?: React.ReactNode }) {
  return (
    <div className="tile">
      <span className="tile-label">
        {label} {refs}
      </span>
      <span className="tile-value">
        {value}
        {unit && value !== '—' && <small> {unit}</small>}
      </span>
      {hint && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="bullets">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </>
  );
}

/** 직장인구 itself comes from the 상권 직장인구 table; SGIS 사업체 only supplies the 사업체 count (unless it is the only source). */
function workerKeys(keys: string[] | undefined) {
  if (!keys) return keys;
  return keys.length > 1 ? keys.filter((k) => k !== 'sgis_company') : keys;
}

export function Refs({ keys, sources }: { keys: string[] | undefined; sources: Source[] }) {
  const nums = [...new Set(keys ?? [])]
    .map((k) => ({ k, n: sources.findIndex((s) => s.key === k) + 1 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.n - b.n);
  if (!nums.length) return null;
  return (
    <sup className="refs">
      {nums.map(({ k, n }) => (
        <a
          key={k}
          href={`#src-${k}`}
          title={`${sources[n - 1].provider} · ${sources[n - 1].dataset}`}
          onClick={(e) => {
            e.preventDefault();
            // the 출처 block is collapsed by default
            const box = document.getElementById('sources') as HTMLDetailsElement | null;
            if (box) box.open = true;
            requestAnimationFrame(() => document.getElementById(`src-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          }}
        >
          [{n}]
        </a>
      ))}
    </sup>
  );
}

function Judgment({ e }: { e: Explanation }) {
  return (
    <div className="judge">
      <h4>판단 근거</h4>
      <p>{e.grade_reason}</p>
      <p className="formula">{e.formula}</p>
      {e.drags.length > 0 && <List title="점수를 끌어내린 항목" items={e.drags} />}
      {e.lifts.length > 0 && <List title="점수를 끌어올린 항목" items={e.lifts} />}
      {e.missing.length > 0 && <List title="계산에서 빠진 항목" items={e.missing} />}
      <details>
        <summary className="small">점수 규칙 보기</summary>
        <ul className="bullets small">
          {e.rules.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function ComponentRow({ c, refs }: { c: Component; refs: (keys: string[]) => React.ReactNode }) {
  return (
    <li className="comp">
      <div className="hbar-head">
        <span className="hbar-label">
          {c.label} · 가중치 {Math.round(c.weight * 100)}% {refs(c.sources ?? [])}
        </span>
        <span className="hbar-value">{c.value == null ? '—' : c.value.toFixed(0)}</span>
      </div>
      <div className={`hbar-track${c.value == null ? ' empty' : ''}`} aria-hidden>
        {c.value != null && <div className="hbar-fill" style={{ width: `${Math.max(c.value, 1.5)}%` }} />}
        <div className="hbar-mid" />
      </div>
      <p className="comp-reason">{c.reason ?? c.basis}</p>
      <details>
        <summary className="small">
          왜 이 점수인가요? · 신뢰 {c.confidence}({CONF[c.confidence]})
        </summary>
        <p className="small">{c.method}</p>
        {(c.inputs ?? []).length > 0 && (
          <table className="table inputs">
            <tbody>
              {c.inputs.map((i, k) => (
                <tr key={k}>
                  <th>{i.label}</th>
                  <td>
                    {i.value} {i.source && refs([i.source])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </li>
  );
}

const m2 = (v: number | null) => (v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}㎡`);
const pctv = (v: number | null) => (v == null ? '미기재' : `${v.toFixed(1)}%`);

function BuildingCard({
  b,
  refs,
}: {
  b: { address: string | null; buildings: BuildingInfo[]; floors: FloorInfo[]; floors_truncated: boolean };
  refs: React.ReactNode;
}) {
  const main = b.buildings[0];
  const rest = b.buildings.slice(1);
  return (
    <section className="card">
      <h3>
        건축물대장 {refs}
      </h3>
      <p className="muted small">
        {b.address} · 이 필지의 건물 {b.buildings.length}동
      </p>
      <div className="tiles">
        <Tile label="주용도" value={main.main_use || '—'} hint={main.detail_use} />
        <Tile label="층수" value={`지상 ${main.floors_above ?? '—'} · 지하 ${main.floors_below ?? 0}`} hint={main.height_m ? `높이 ${main.height_m}m` : undefined} />
        <Tile label="연면적" value={m2(main.total_area_m2)} hint={`건축면적 ${m2(main.building_area_m2)} · 대지 ${m2(main.site_area_m2)}`} />
        <Tile label="사용승인" value={main.approval_date ?? '—'} hint={main.age_years != null ? `${main.age_years}년 경과` : undefined} />
        <Tile label="건폐율 · 용적률" value={`${pctv(main.coverage_ratio)} · ${pctv(main.floor_area_ratio)}`} />
        <Tile label="구조" value={main.structure || '—'} hint={main.seismic_design == null ? undefined : main.seismic_design ? '내진설계 적용' : '내진설계 미적용'} />
        <Tile label="승강기 · 주차" value={`${main.elevators ?? 0}대 · ${main.parking ?? 0}대`} />
        {main.households != null && <Tile label="세대·가구" value={String(main.households)} />}
      </div>
      <p className="small muted">
        {main.name ? <b>{main.name} · </b> : null}
        {main.kind} · 비어 있는 칸은 대장에 기재되지 않은 항목입니다
      </p>
      {b.floors.length > 0 && (
        <details open={b.floors.length <= 12}>
          <summary className="small link">층별 용도 ({b.floors.length}개 층{b.floors_truncated ? ', 일부만 표시' : ''})</summary>
          <div className="table-wrap">
            <table className="table floors">
              <thead>
                <tr>
                  {rest.length > 0 && <th>동</th>}
                  <th>층</th>
                  <th>용도</th>
                  <th>세부 용도</th>
                  <th className="num">면적</th>
                </tr>
              </thead>
              <tbody>
                {b.floors.map((f, i) => (
                  <tr key={i}>
                    {rest.length > 0 && <td>{f.building || '—'}</td>}
                    <td>{f.floor}</td>
                    <td>{f.use}</td>
                    <td className="muted">{f.detail_use}</td>
                    <td className="num">{m2(f.area_m2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {rest.length > 0 && (
        <details>
          <summary className="small link">같은 필지의 다른 건물 {rest.length}동</summary>
          <ul className="bullets small">
            {rest.map((x, i) => (
              <li key={i}>
                {x.name || '이름 없음'} — {x.main_use}, 지상 {x.floors_above ?? '—'}층, 연면적 {m2(x.total_area_m2)}, 사용승인 {x.approval_date ?? '—'} ({x.kind})
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function RentCard({ r, refs }: { r: NonNullable<NonNullable<Assessment['indicators']>['rent']>; refs: React.ReactNode }) {
  // 이 변경 전에 저장된 평가에는 by_type이 없다: 중대형 층별만으로 표를 만든다
  const types = r.by_type ?? [{ type: '중대형 상가' as const, quarter: r.quarter, floors: r.rent_by_floor, vacancy_rate: r.vacancy_rate.mid_large }];
  const floors = [...new Set(types.flatMap((t) => t.floors.map((f) => f.floor)))];
  const ap = r.applied ?? null;
  const f1 = r.rent_by_floor.find((x) => x.floor === '1층');
  const wonM2 = (v: number) => `${v.toLocaleString()}원/㎡`;
  const vac = types.find((t) => t.type === (ap?.building_type ?? '중대형 상가'))?.vacancy_rate ?? null;
  return (
    <section className="card">
      <h3>
        임대료 · 공실 {refs}
      </h3>
      <p className="muted small">
        {r.match === '상권' ? `R-ONE 조사 상권 ${r.area} (대표 지점 ${r.distance_m}m)` : `${r.area} 평균 (반경 1km 안 조사 상권 없음)`} · {r.quarter} · ㎡당 월 임대료
      </p>
      <div className="grid-2">
        <div className="tiles">
          {ap ? (
            <>
              <Tile label={`적용 단가 · ${ap.building_type} ${ap.floor}`} value={wonM2(ap.won_per_m2)} hint={ap.type_reason} />
              {ap.monthly_rent != null && <Tile label="예상 월 임대료" value={won(ap.monthly_rent)} hint={`${ap.area_m2}㎡ × 적용 단가`} />}
            </>
          ) : (
            <>
              <Tile label="1층 임대료" value={f1 ? wonM2(f1.won_per_m2) : '—'} hint="중대형 상가, 월" />
              {r.est_monthly_rent_1f != null && <Tile label="예상 월 임대료 (1층)" value={won(r.est_monthly_rent_1f)} hint="입력 면적 × 1층 ㎡당 임대료" />}
            </>
          )}
          <Tile label="공실률" value={vac != null ? `${vac}%` : '—'} hint={`${ap?.building_type ?? '중대형 상가'}${r.vacancy_rate.quarter ? ` · ${r.vacancy_rate.quarter}` : ''}`} />
        </div>
        <div>
          <p className="small muted">건물 유형 × 층별 ㎡당 월 임대료 (원){ap ? ' · 굵은 칸이 적용 단가' : ''}</p>
          <table className="mini rent-table">
            <thead>
              <tr>
                <th>층</th>
                {types.map((t) => (
                  <th key={t.type} className="num">
                    {t.type.replace(' 상가', '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {floors.map((f) => (
                <tr key={f}>
                  <td>{f}</td>
                  {types.map((t) => {
                    const v = t.floors.find((x) => x.floor === f)?.won_per_m2;
                    const hit = ap && ap.building_type === t.type && ap.floor === f;
                    return (
                      <td key={t.type} className={`num${hit ? ' hit' : ''}`}>
                        {v != null ? v.toLocaleString() : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td>공실률</td>
                {types.map((t) => (
                  <td key={t.type} className="num">
                    {t.vacancy_rate != null ? `${t.vacancy_rate}%` : '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {ap?.fallback && <p className="warn small">{ap.fallback}</p>}
      <p className="muted small">{r.note}</p>
    </section>
  );
}

/** 프랜차이즈 브랜드: 공정위 정보공개 + 같은 브랜드 근접 매장 (점주권 중복) */
function BrandCard({ b, refs }: { b: NonNullable<Assessment['brand']>; refs: React.ReactNode }) {
  const i = b.info;
  const sb = b.same_brand;
  const others = sb ? sb.nearest.filter((n) => n.distance_m > 15) : [];
  const near500 = sb ? sb.within_500 - (sb.at_site ? 1 : 0) : 0;
  return (
    <section className="card">
      <h3>
        브랜드 · {i?.brand ?? '—'} {refs}
      </h3>
      {i ? (
        <>
          <p className="muted small">
            {i.corp} · {i.industry} · 공정위 가맹사업 정보 {i.year}년 공개분 (브랜드 전국 평균, 지역 구분 없음)
          </p>
          <div className="tiles">
            <Tile label="가맹점 평균 매출 (연)" value={won(i.avg_sales_annual)} hint={i.avg_sales_per_3_3m2 ? `3.3㎡당 ${won(i.avg_sales_per_3_3m2)} · 월 환산 ${won(i.avg_sales_annual ? i.avg_sales_annual / 12 : null)}` : undefined} />
            <Tile label="가맹점 수" value={num(i.stores)} unit="곳" hint={`신규 ${num(i.opened)} · 종료·해지 ${num(i.closed)} · 명의변경 ${num(i.renamed)}`} />
            <Tile label="폐점률 (근사)" value={pct(i.closure_rate, 1)} hint="(계약 종료 + 해지) ÷ 가맹점 수" />
            {i.cost?.total != null && (
              <Tile label="창업 비용 합계" value={won(i.cost.total)} hint={`가맹비 ${won(i.cost.join)} · 교육 ${won(i.cost.edu)} · 보증금 ${won(i.cost.deposit)} · 기타 ${won(i.cost.etc)}`} />
            )}
          </div>
          {i.trend.length > 1 && (
            <p className="muted small">
              추이: {i.trend.map((t) => `${t.year} 가맹점 ${t.stores.toLocaleString()}곳·평균 매출 ${won(t.avg_sales_annual)}`).join(' → ')}
            </p>
          )}
        </>
      ) : (
        <p className="muted small">공정위 가맹사업 정보에서 이 브랜드의 공개 자료를 찾지 못했습니다.</p>
      )}
      {sb && (
        <>
          <h4>같은 브랜드 근접 매장 (반경 {sb.radius_m.toLocaleString()}m)</h4>
          <p className={near500 > 0 ? 'warn small' : 'muted small'}>
            500m 안 {near500}곳 · 1km 안 {sb.within_1000 - (sb.at_site ? 1 : 0)}곳
            {sb.at_site ? ' · 이 위치에 이미 같은 브랜드 매장이 있습니다 (기존 매장 평가일 수 있음)' : ''}
            {near500 > 0 ? ' — 가맹계약의 영업지역 보호 범위를 확인하십시오.' : ''}
          </p>
          {others.length > 0 && (
            <ul className="small">
              {others.slice(0, 5).map((n) => (
                <li key={`${n.name}${n.distance_m}`}>
                  {n.name} · {n.distance_m}m{n.floor ? ` · ${n.floor}층` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 자리의 과거: 같은 건물에서 열고 닫은 음식점·카페·편의점 */
function SiteHistoryCard({ h, refs }: { h: NonNullable<NonNullable<Assessment['indicators']>['site_history']> | null; refs: React.ReactNode }) {
  if (!h)
    return (
      <section className="card">
        <h3>이 자리의 과거</h3>
        <p className="muted small">이 건물에서 음식점·카페·편의점 인허가 기록을 찾지 못했습니다 (도로·지하철역 위이거나 해당 업종이 들어선 적 없는 건물일 수 있습니다).</p>
      </section>
    );
  const risky = h.closed_within_3y >= 3 && h.closed_last_5y >= 3;
  return (
    <section className="card">
      <h3>
        이 자리의 과거 {refs}
      </h3>
      <p className="muted small">같은 건물(인허가 좌표 {h.radius_m}m 안)에서 열고 닫은 음식점·카페·편의점 · 층·호는 구분하지 못합니다 · {h.coverage}</p>
      <div className="tiles">
        <Tile label="거쳐 간 가게" value={num(h.total)} unit="곳" hint={h.by_kind.map((k) => `${k.kind} ${k.total}`).join(' · ')} />
        <Tile label="지금 영업 중" value={num(h.active)} unit="곳" />
        <Tile label="3년 안에 문 닫음" value={num(h.closed_within_3y)} unit="곳" hint={`폐업 ${h.closed}곳 중 · 최근 5년 폐업 ${h.closed_last_5y}곳`} />
        <Tile label="폐업까지 걸린 기간" value={h.median_years_closed != null ? `${h.median_years_closed}년` : '—'} hint="문 닫은 가게의 중앙값" />
      </div>
      {risky && <p className="warn small">3년을 못 넘긴 가게가 많은 건물입니다. 같은 층·호인지와 폐업 이유를 현장에서 확인하십시오.</p>}
      <details>
        <summary className="small">가게별 이력 ({h.items.length}{h.total > h.items.length ? ` / ${h.total}` : ''})</summary>
        <table className="table src-table">
          <thead>
            <tr>
              <th>상호</th>
              <th>업종</th>
              <th>개업</th>
              <th>폐업</th>
              <th className="num">영업 기간</th>
            </tr>
          </thead>
          <tbody>
            {h.items.map((x, i) => (
              <tr key={i}>
                <td>{x.name}</td>
                <td>
                  {x.kind}
                  {x.uptae ? ` · ${x.uptae}` : ''}
                </td>
                <td>{x.opened ?? '—'}</td>
                <td>{x.closed ?? (x.state === '폐업' ? '날짜 미상' : '영업 중')}</td>
                <td className="num">{x.years != null ? `${x.years}년` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
