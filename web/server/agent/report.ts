// Report rendering (json sections + a printable HTML page) from a finished assessment.
import type { AssessmentResult } from './pipeline.ts';

type Done = AssessmentResult & { assessment_id: string; created_at: string };

const won = (v: unknown) => (typeof v === 'number' ? `${Math.round(v / 1e4).toLocaleString()}만 원` : '—');
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const list = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- 없음');

export function reportSections(a: Done) {
  const refNo = (keys: string[] | undefined) =>
    [...new Set(keys ?? [])]
      .map((k) => a.provenance.findIndex((p) => p.key === k) + 1)
      .filter((n) => n > 0)
      .sort((x, y) => x - y)
      .map((n) => `[${n}]`)
      .join('');
  const s = a.score;
  const f = a.sales_forecast as {
    p10?: number | null;
    p50?: number | null;
    p90?: number | null;
    benchmark?: { value: number | null; scope: string } | null;
    note?: string;
    method?: { range: string; benchmark: string; origin: string; accuracy: string } | null;
  };
  const c = a.indicators.competitors;
  return {
    title: `입지 평가 리포트 — ${a.location.address_road ?? a.location.address_jibun ?? `${a.location.lat}, ${a.location.lng}`}`,
    sections: [
      {
        heading: '결론',
        body_markdown: `**${a.summary?.headline ?? '요약 없음'}**\n\n종합 점수 **${s.total ?? '—'}** (등급 ${s.grade ?? '—'}) · 3년 생존 확률 ${pct(s.survival_3y_prob)} · 업종 ${a.industry.name ?? '미확정'}`,
      },
      {
        heading: '판단 근거',
        body_markdown: s.explanation
          ? [
              s.explanation.grade_reason,
              '',
              `계산: ${s.explanation.formula}`,
              '',
              ...(s.explanation.drags.length ? ['점수를 끌어내린 항목', ...s.explanation.drags.map((x) => `- ${x}`), ''] : []),
              ...(s.explanation.lifts.length ? ['점수를 끌어올린 항목', ...s.explanation.lifts.map((x) => `- ${x}`), ''] : []),
              ...(s.explanation.missing.length ? ['계산에서 빠진 항목', ...s.explanation.missing.map((x) => `- ${x}`), ''] : []),
              '점수 규칙',
              ...s.explanation.rules.map((x) => `- ${x}`),
            ].join('\n')
          : '—',
      },
      {
        heading: '점수 구성 — 항목별 계산',
        body_markdown: s.components
          .map((x) =>
            [
              `**${x.label} ${x.value ?? '—'}점** (가중치 ${Math.round(x.weight * 100)}%, 신뢰 ${x.confidence}) ${refNo(x.sources)}`,
              x.reason ?? x.basis,
              x.method ? `방법: ${x.method}` : '',
              ...(x.inputs ?? []).map((i) => `- ${i.label}: ${i.value} ${i.source ? refNo([i.source]) : ''}`),
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n'),
      },
      {
        heading: '매출 예측 (점포당 월)',
        body_markdown: f.p50 != null
          ? [
              `예상 범위 ${won(f.p10)} ~ ${won(f.p90)} (중앙 ${won(f.p50)}), 신뢰 C ${refNo(['model_sales'])}`,
              '',
              `같은 상권 실제 평균: ${won(f.benchmark?.value)} (${f.benchmark?.scope ?? ''}) ${refNo(['seoul_sales', 'seoul_store'])}`,
              '',
              ...(f.method
                ? ['**이 매출은 어디서 왔나요?**', '', `- 예상 범위: ${f.method.range}`, `- 상권 실제 평균: ${f.method.benchmark}`, `- 원천: ${f.method.origin}`, `- 정확도: ${f.method.accuracy}`]
                : [f.note ?? '']),
            ].join('\n')
          : (f.note ?? '제공하지 않음'),
      },
      {
        heading: `경쟁 (반경 ${c.radius_m}m)`,
        body_markdown: `동일 업종 ${c.same_industry ?? '—'}곳 / 전체 점포 ${c.all_stores}곳, 입지계수 ${c.location_quotient?.toFixed(2) ?? '—'}\n\n${c.nearest.map((n) => `- ${n.name} (${n.industry}, ${n.distance_m}m${n.floor ? `, ${n.floor}층` : ''})`).join('\n')}`,
      },
      { heading: '기회 요인', body_markdown: list(a.summary?.opportunities) },
      { heading: '리스크', body_markdown: list(a.summary?.risks) },
      {
        heading: '임대료 · 공실',
        body_markdown: (() => {
          const r = a.indicators.rent;
          if (!r) return '임대료 정보를 찾지 못했습니다.';
          const ap = r.applied;
          const floors = [...new Set(r.by_type.flatMap((t) => t.floors.map((f) => f.floor)))];
          const cell = (t: (typeof r.by_type)[number], f: string) => t.floors.find((x) => x.floor === f)?.won_per_m2.toLocaleString() ?? '—';
          return [
            `${r.match === '상권' ? `R-ONE 조사 상권 ${r.area} (대표 지점 ${r.distance_m}m)` : `${r.area} 평균`} · ${r.quarter} ${refNo(r.sources)}`,
            '',
            ...(ap
              ? [
                  `**적용 단가: ${ap.building_type} ${ap.floor} ㎡당 월 ${ap.won_per_m2.toLocaleString()}원**${ap.monthly_rent != null ? ` → 예상 월 임대료 ${won(ap.monthly_rent)} (${ap.area_m2}㎡)` : ''}`,
                  `- 건물 유형 근거: ${ap.type_reason}`,
                  ...(ap.fallback ? [`- ${ap.fallback}`] : []),
                  '',
                ]
              : []),
            `| 층 (㎡당 월, 원) | ${r.by_type.map((t) => t.type).join(' | ')} |`,
            `|---|${r.by_type.map(() => '---:').join('|')}|`,
            ...floors.map((f) => `| ${f} | ${r.by_type.map((t) => cell(t, f)).join(' | ')} |`),
            `| 공실률 | ${r.by_type.map((t) => (t.vacancy_rate != null ? `${t.vacancy_rate}%` : '—')).join(' | ')} |`,
            '',
            r.note,
          ].join('\n');
        })(),
      },
      {
        heading: '이 자리의 과거',
        body_markdown: (() => {
          const h = a.indicators.site_history;
          if (!h) return '이 건물에서 음식점·카페·편의점 인허가 기록을 찾지 못했습니다.';
          return [
            `같은 건물(인허가 좌표 ${h.radius_m}m 안)에서 ${h.total}곳이 거쳐 갔고 지금 ${h.active}곳이 영업 중입니다. 폐업 ${h.closed}곳 중 ${h.closed_within_3y}곳이 3년 안에 문을 닫았습니다 (폐업까지 중앙값 ${h.median_years_closed ?? '—'}년, 최근 5년 폐업 ${h.closed_last_5y}곳). ${refNo(h.sources)}`,
            '',
            ...h.items.slice(0, 10).map((x) => `- ${x.name} (${x.kind}${x.uptae ? `·${x.uptae}` : ''}) ${x.opened ?? '?'} ~ ${x.closed ?? '영업 중'}${x.years != null ? `, ${x.years}년` : ''}`),
            '',
            `층·호는 구분하지 못합니다. ${h.coverage}`,
          ].join('\n');
        })(),
      },
      {
        heading: '건축물대장',
        body_markdown: (() => {
          const bl = a.indicators.buildings;
          if (!bl?.buildings.length) return '이 위치의 지번에서 건축물대장을 찾지 못했습니다.';
          const m = bl.buildings[0];
          return [
            `${bl.address ?? ''} ${refNo(bl.sources)}`,
            '',
            `- 주용도: ${m.main_use}${m.detail_use ? ` (${m.detail_use})` : ''} · 구조: ${m.structure}`,
            `- 층수: 지상 ${m.floors_above ?? '—'} / 지하 ${m.floors_below ?? 0} · 연면적 ${m.total_area_m2 ?? '—'}㎡`,
            `- 사용승인: ${m.approval_date ?? '—'}${m.age_years != null ? ` (${m.age_years}년 경과)` : ''} · 건폐율 ${m.coverage_ratio != null ? `${m.coverage_ratio}%` : '미기재'} · 용적률 ${m.floor_area_ratio != null ? `${m.floor_area_ratio}%` : '미기재'}`,
            ...(bl.floors.length ? ['', '층별 용도', ...bl.floors.map((f) => `- ${f.building ? `${f.building} ` : ''}${f.floor}: ${f.use}${f.detail_use && f.detail_use !== f.use ? ` (${f.detail_use})` : ''}, ${f.area_m2 ?? '—'}㎡`)] : []),
          ].join('\n');
        })(),
      },
      { heading: '현장에서 확인할 것', body_markdown: list([...(a.summary?.unknowns ?? []), ...(a.vision?.cannot_tell ?? [])]) },
      {
        heading: '출처',
        body_markdown: a.provenance
          .map((p, i) => `- [${i + 1}] ${p.provider} · ${p.dataset} — API ${p.api} · 사용한 값: ${p.fields} · ${p.scope} · 기준 ${p.as_of || '—'} · 쓴 곳: ${p.used_for.join(', ')}`)
          .join('\n'),
      },
      { heading: '유의 사항', body_markdown: [...a.warnings.map((w) => `- ${w}`), '', a.disclaimer].join('\n') },
    ],
  };
}

function md(s: string) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .split('\n\n')
    .map((block) => (block.startsWith('- ') ? `<ul>${block.split('\n').map((l) => `<li>${l.replace(/^- /, '')}</li>`).join('')}</ul>` : `<p>${block.replace(/\n/g, '<br>')}</p>`))
    .join('');
}

export function reportHtml(a: Done): string {
  const r = reportSections(a);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<style>
  :root { --fg:#1b1f24; --muted:#5b6470; --line:#e3e6ea; --bg:#fff; --accent:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaed; --muted:#9aa3ad; --line:#2c3138; --bg:#15181c; } }
  body { background:var(--bg); color:var(--fg); font:15px/1.6 system-ui, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; max-width:760px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; border-top:1px solid var(--line); padding-top:16px; margin-top:24px; }
  .meta { color:var(--muted); font-size:13px; } strong { color:var(--accent); } ul { padding-left:20px; }
  @media print { body { max-width:none; } }
</style></head><body>
<h1>${esc(r.title)}</h1>
<div class="meta">${esc(a.assessment_id)} · ${esc(a.created_at)}</div>
${r.sections.map((s) => `<h2>${esc(s.heading)}</h2>${md(s.body_markdown)}`).join('\n')}
</body></html>`;
}
