// End-to-end smoke test for the Agent API (server must be running: npm run dev:api).
// Usage: npx tsx scripts/smoke-agent.ts [base-url]
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/api/v1';
const headers: Record<string, string> = process.env.AGENT_API_KEY ? { 'x-api-key': process.env.AGENT_API_KEY } : {};

// 1×1 PNG, enough to exercise the multipart path
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function json(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

async function assess(name: string, body: Record<string, unknown> | FormData) {
  const init: RequestInit =
    body instanceof FormData ? { method: 'POST', body } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const created = await json('/assessments', init);
  if (created.status !== 202) {
    console.log(`✗ ${name}: ${created.status}`, created.body);
    return;
  }
  const { assessment_id } = created.body as { assessment_id: string };
  const { body: a } = await json(`/assessments/${assessment_id}?wait=60`);
  const r = a as Record<string, any>;
  console.log(`\n■ ${name} → ${r.status} (${r.usage?.elapsed_ms ?? '-'}ms) ${assessment_id}`);
  if (r.error) return console.log('  error:', r.error);
  console.log(`  위치: ${r.location.address_road ?? r.location.address_jibun} · ${r.location.adm_nm} · 상권 ${r.location.trade_area?.name ?? '-'}`);
  console.log(`  업종: ${r.industry.name ?? '-'} (${r.industry.code ?? '-'}, ${r.industry.method}, ${r.industry.confidence}) 업태 ${r.industry.license_uptae ?? '-'} 브랜드 ${r.industry.franchise_brand ?? '-'}`);
  console.log(`  점수: ${r.score.total} (${r.score.grade}) 생존 ${r.score.survival_3y_prob ?? '-'}`);
  for (const c of r.score.components) console.log(`    - ${c.label} ${c.value ?? '—'} [${c.confidence}] ${c.basis}`);
  const s = r.sales_forecast;
  console.log(`  매출: ${s.p50 == null ? s.note : `${Math.round(s.p10 / 1e4)}~${Math.round(s.p90 / 1e4)}만 (중앙 ${Math.round(s.p50 / 1e4)}만, 상권 평균 ${Math.round((s.benchmark?.value ?? 0) / 1e4)}만)`}`);
  const c = r.indicators.competitors;
  console.log(`  경쟁: 동일 ${c.same_industry} / 전체 ${c.all_stores}, LQ ${c.location_quotient?.toFixed(2) ?? '-'}, 가까운 곳 ${c.nearest.slice(0, 3).map((n: any) => `${n.name}(${n.distance_m}m)`).join(', ')}`);
  console.log(`  음식점 인허가: ${JSON.stringify(r.indicators.food_license_churn)}`);
  console.log(`  사업자 상태: ${r.business_check ? `${r.business_check.status} / ${r.business_check.tax_type ?? '-'}` : '-'}`);
  console.log(`  경고: ${r.warnings.join(' / ')}`);
  return assessment_id;
}

const ind = await json('/industries?q=' + encodeURIComponent('카페'));
console.log('industries 카페 →', (ind.body as any).items?.map((i: any) => `${i.code} ${i.name}`).join(', '));
const cov = await json('/coverage?lat=35.1587&lng=129.1604');
console.log('coverage 부산 →', (cov.body as any).coverage, (cov.body as any).adm_nm);

const id = await assess('서울 시청 · 한식 · 면적 66㎡ · 사업자번호', { lat: 37.5663, lng: 126.9779, industry: '한식', floor_area_m2: 66, store_name: '테스트식당', biz_no: '1248100998' });
await assess('서울 연남동 · 카페 · 주소만', { address: '서울 마포구 동교로 240', industry: '카페' });
await assess('부산 해운대 · 카페 · 주소만', { address: '부산 해운대구 달맞이길117번길 11', industry: '카페' });
await assess('서울 강남 · 미용실 (음식점 외)', { lat: 37.4979, lng: 127.0276, industry: '미용실' });
await assess('서울 · 상호로만 업종 추정', { lat: 37.5009, lng: 127.0365, store_name: '스타벅스' });

const fd = new FormData();
fd.set('lat', '37.5636');
fd.set('lng', '126.9828');
fd.set('industry', 'I21007');
fd.append('roadview_images', new Blob([PNG], { type: 'image/png' }), 'roadview.png');
await assess('multipart + 이미지 1장', fd);

console.log('\n검증 오류 →', (await json('/assessments', { method: 'POST', body: '{"lat":37.5}', headers: { 'content-type': 'application/json' } })).status);
console.log('없는 평가 →', (await json('/assessments/asm_xxxxxxxxxxxxxxxxxxxx')).status);
if (id) {
  const rep = await json(`/assessments/${id}/report?format=json`);
  console.log('report json →', rep.status, (rep.body as any).sections?.map((s: any) => s.heading).join(' | '));
  const html = await fetch(`${BASE}/assessments/${id}/report`, { headers });
  console.log('report html →', html.status, (await html.text()).length, 'bytes');
  const msg = await json(`/assessments/${id}/messages`, { method: 'POST', body: JSON.stringify({ message: '근처 경쟁점이 많은 편인가요?' }), headers: { 'content-type': 'application/json' } });
  console.log('messages →', msg.status, typeof msg.body === 'string' ? msg.body.slice(0, 200) : JSON.stringify(msg.body).slice(0, 300));
}
