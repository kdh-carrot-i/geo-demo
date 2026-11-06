// Probe parameters needed by the Seoul SQLite ETL (keys redacted).
try {
  process.loadEnvFile('.env');
} catch {
  // real env
}
const E = process.env;
const keys = [E.SEOUL_OPEN_API_KEY, E.DATA_GO_KR_SERVICE_KEY, E.R_ONE_KEY, E.SGIS_SERVICE_ID, E.SGIS_SECRET_KEY].filter(Boolean) as string[];
const redact = (s: string) => keys.reduce((a, k) => a.split(k).join('***'), s);
async function show(name: string, url: string, pick: (j: any) => unknown = (j) => j) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    let o: unknown;
    try {
      o = pick(JSON.parse(t));
    } catch {
      o = t.slice(0, 300);
    }
    console.log(`\n### ${name} → ${r.status}\n${redact(JSON.stringify(o)).slice(0, 700)}`);
  } catch (e) {
    console.log(`\n### ${name} → ERR ${redact(String(e))}`);
  }
}
const S = (svc: string, s: number, e: number, extra = '') => `http://openapi.seoul.go.kr:8088/${E.SEOUL_OPEN_API_KEY}/json/${svc}/${s}/${e}/${extra}`;
const sp = (j: any) => {
  const v: any = Object.values(j)[0];
  return { r: v?.RESULT?.CODE ?? v?.CODE, total: v?.list_total_count, n: v?.row?.length, row0: v?.row?.[0] && Object.fromEntries(Object.entries(v.row[0]).slice(0, 6)) };
};

await show('Seoul sales quarter filter 20262', S('VwsmTrdarSelngQq', 1, 1, '20262'), sp);
await show('Seoul sales quarter filter 20261', S('VwsmTrdarSelngQq', 1, 1, '20261'), sp);
await show('Seoul store quarter 20262', S('VwsmTrdarStorQq', 1, 1, '20262'), sp);
await show('Seoul flpop 20262', S('VwsmTrdarFlpopQq', 1, 1, '20262'), sp);
await show('Seoul living pop date 20261020', S('SPOP_LOCAL_RESD_DONG', 1, 1, '20261020'), sp);
await show('Seoul living pop no filter', S('SPOP_LOCAL_RESD_DONG', 1, 1), sp);
await show('Seoul trade area 1000 page', S('TbgisTrdarRelm', 1, 1000), (j: any) => ({ total: j.TbgisTrdarRelm?.list_total_count, n: j.TbgisTrdarRelm?.row?.length }));

const sb = (op: string, q: Record<string, string>) =>
  `https://apis.data.go.kr/B553077/api/open/sdsc2/${op}?${new URLSearchParams({ serviceKey: E.DATA_GO_KR_SERVICE_KEY!, type: 'json', numOfRows: '1000', pageNo: '1', ...q })}`;
await show('store in dong (ctprvnCd 11)', sb('storeListInDong', { divId: 'ctprvnCd', key: '11' }), (j: any) => ({ h: j.header?.resultMsg, total: j.body?.totalCount, n: j.body?.items?.length }));
await show('store zone in admi (ctprvnCd 11)', sb('storeZoneInAdmi', { divId: 'ctprvnCd', key: '11' }), (j: any) => ({ h: j.header?.resultMsg, total: j.body?.totalCount, item0: j.body?.items?.[0] && { ...j.body.items[0], coords: String(j.body.items[0].coords).slice(0, 60) } }));

// SGIS
const tok = await (await fetch(`https://sgisapi.mods.go.kr/OpenAPI3/auth/authentication.json?consumer_key=${E.SGIS_SERVICE_ID}&consumer_secret=${E.SGIS_SECRET_KEY}`)).json();
const at = tok.result.accessToken;
await show('SGIS population Seoul low_search=2', `https://sgisapi.mods.go.kr/OpenAPI3/stats/population.json?accessToken=${at}&year=2023&adm_cd=11&low_search=2`, (j: any) => ({ err: j.errCd, n: j.result?.length, r0: j.result?.[0] }));
await show('SGIS household Seoul low_search=2', `https://sgisapi.mods.go.kr/OpenAPI3/stats/household.json?accessToken=${at}&year=2023&adm_cd=11&low_search=2`, (j: any) => ({ err: j.errCd, n: j.result?.length, r0: j.result?.[0] }));
await show('SGIS company Seoul low_search=2', `https://sgisapi.mods.go.kr/OpenAPI3/stats/company.json?accessToken=${at}&year=2022&adm_cd=11&low_search=2`, (j: any) => ({ err: j.errCd, n: j.result?.length, r0: j.result?.[0] }));

// R-ONE data
const R = (q: string) => `https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${E.R_ONE_KEY}&Type=json&pIndex=1&pSize=3&${q}`;
await show('R-ONE 중대형 임대가격지수 2024Q3~ (T249863134832916) QY', R('STATBL_ID=T249863134832916&DTACYCLE_CD=QY'));
await show('R-ONE 통계표 공실률 검색', `https://www.reb.or.kr/r-one/openapi/SttsApiTbl.do?KEY=${E.R_ONE_KEY}&Type=json&pIndex=1&pSize=1000`, (j: any) =>
  (j.SttsApiTbl?.[1]?.row ?? []).filter((r: any) => /공실률|임대료|권리금/.test(r.STATBL_NM)).map((r: any) => `${r.STATBL_ID} ${r.STATBL_NM}`).slice(0, 30),
);
