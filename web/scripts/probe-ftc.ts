// Inspect response shape of FTC franchise APIs (keys redacted).
try {
  process.loadEnvFile('.env');
} catch {
  // real env
}
const K = process.env.DATA_GO_KR_SERVICE_KEY!;
const base = 'https://apis.data.go.kr/1130000';
for (const [name, path] of [
  ['브랜드별 가맹점 현황', 'FftcBrandFrcsStatsService/getBrandFrcsStats'],
  ['브랜드별 창업금액', 'FftcBrandFntnStatsService/getBrandFntnStats'],
]) {
  const r = await fetch(`${base}/${path}?serviceKey=${K}&pageNo=1&numOfRows=2&resultType=json&yr=2024`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  console.log(`\n### ${name}\n${JSON.stringify({ totalCount: j.totalCount, items: j.items?.slice?.(0, 2) ?? j.items }, null, 1).slice(0, 1500)}`);
}
