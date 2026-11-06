// Feasibility probes for DB / visualization directions. Prints shape of responses, never keys.
try {
  process.loadEnvFile('.env');
} catch {
  // real env
}
const E = process.env;
const P = { lon: 126.9784, lat: 37.5666 }; // 서울시청 인근
const keys = [E.VWORLD_KEY, E.DATA_GO_KR_SERVICE_KEY, E.R_ONE_KEY].filter(Boolean) as string[];
const redact = (s: string) => keys.reduce((a, k) => a.split(k).join('***'), s);

async function j(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _status: r.status, _text: redact(t.slice(0, 300)) };
  }
}
const show = (title: string, v: unknown) => console.log(`\n### ${title}\n${redact(JSON.stringify(v, null, 1)).slice(0, 1800)}`);

function vw(data: string, extra: Record<string, string> = {}) {
  return `https://api.vworld.kr/req/data?${new URLSearchParams({
    service: 'data', request: 'GetFeature', data, key: E.VWORLD_KEY!, domain: E.VWORLD_DOMAIN || 'localhost',
    format: 'json', crs: 'EPSG:4326', geometry: 'true', attribute: 'true', size: '3', ...extra,
  })}`;
}
const summarizeVw = (b: any) => {
  const r = b?.response;
  if (r?.status !== 'OK') return { status: r?.status, error: r?.error, raw: b?._text };
  const fs = r.result.featureCollection.features;
  return { status: 'OK', total: r.record?.total, count: fs.length, geomType: fs[0]?.geometry?.type, firstVertexCount: JSON.stringify(fs[0]?.geometry?.coordinates ?? []).split('],[').length, properties: fs[0]?.properties };
};

const buffer = (d: number) => `BOX(${P.lon - d},${P.lat - d},${P.lon + d},${P.lat + d})`;

// 1-1 building polygons
for (const layer of ['LT_C_SPBD', 'LT_C_BLDGINFO']) {
  show(`VWorld ${layer} @point`, summarizeVw(await j(vw(layer, { geomFilter: `POINT(${P.lon} ${P.lat})` }))));
}
show('VWorld LT_C_SPBD @BOX(~200m) count', summarizeVw(await j(vw('LT_C_SPBD', { geomFilter: buffer(0.002), size: '1000', geometry: 'false' }))));

// 1-2 상권
const sb = (op: string, q: Record<string, string>) =>
  `https://apis.data.go.kr/B553077/api/open/sdsc2/${op}?${new URLSearchParams({ serviceKey: E.DATA_GO_KR_SERVICE_KEY!, type: 'json', ...q })}`;
const store = await j(sb('storeListInRadius', { radius: '300', cx: String(P.lon), cy: String(P.lat), numOfRows: '1', pageNo: '1' }));
show('상가정보 반경300m', { totalCount: store?.body?.totalCount, item: store?.body?.items?.[0] ?? store });
const zone = await j(sb('storeZoneInRadius', { radius: '500', cx: String(P.lon), cy: String(P.lat) }));
show('상권영역 반경500m', { totalCount: zone?.body?.totalCount, item: zone?.body?.items?.[0] ? { ...zone.body.items[0], coords: String(zone.body.items[0].coords).slice(0, 120) } : zone });

// R-ONE 상권 관련 통계표 검색
const rone = await j(`https://www.reb.or.kr/r-one/openapi/SttsApiTbl.do?KEY=${E.R_ONE_KEY}&Type=json&pIndex=1&pSize=1000`);
const rows: any[] = rone?.SttsApiTbl?.[1]?.row ?? [];
show('R-ONE 통계표 (상권/상가/임대/공실 포함)', { totalTables: rows.length, matches: rows.filter((r) => /상권|상가|임대|공실|오피스/.test(r.STATBL_NM)).slice(0, 25).map((r) => `${r.STATBL_ID} ${r.STATBL_NM}`) });
