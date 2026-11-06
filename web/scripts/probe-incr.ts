// Probe change-date (incremental) endpoint key formats. Keys redacted.
process.loadEnvFile('.env');
const K = process.env.DATA_GO_KR_SERVICE_KEY!;
const sb = (q: Record<string, string>) => `https://apis.data.go.kr/B553077/api/open/sdsc2/storeListByDate?${new URLSearchParams({ serviceKey: K, type: 'json', numOfRows: '1', pageNo: '1', ...q })}`;
for (const key of ['20261028', '20261027', '20261020', '20260930', '20260630', '202609', '202606']) {
  const t = await (await fetch(sb({ key }))).text();
  try {
    const j = JSON.parse(t);
    const it = j.body?.items?.[0];
    console.log(key, j.header?.resultMsg, j.body?.totalCount ?? '', it ? `${it.bizesNm} 변경=${it.chgGb ?? JSON.stringify(Object.entries(it).at(-1))}` : '');
  } catch {
    console.log(key, t.split(K).join('***').slice(0, 150));
  }
  await new Promise((r) => setTimeout(r, 1200));
}
