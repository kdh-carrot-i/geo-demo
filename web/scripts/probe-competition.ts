// Probe APIs needed for competitive-analysis features. Prints status + response shape only; keys are redacted.
try {
  process.loadEnvFile('.env');
} catch {
  // real env
}
const E = process.env;
const keys = [E.SEOUL_OPEN_API_KEY, E.DATA_GO_KR_SERVICE_KEY, E.KAKAO_REST_KEY].filter(Boolean) as string[];
const redact = (s: string) => keys.reduce((a, k) => a.split(k).join('***'), s);
const P = { lon: 126.9784, lat: 37.5666 };

async function probe(name: string, url: string, pick: (j: any) => unknown, headers?: Record<string, string>) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    let out: unknown;
    try {
      out = pick(JSON.parse(t));
    } catch {
      out = t.slice(0, 200);
    }
    console.log(`\n### ${name} → HTTP ${r.status}\n${redact(JSON.stringify(out, null, 1)).slice(0, 900)}`);
  } catch (e) {
    console.log(`\n### ${name} → ERROR ${redact(String(e))}`);
  }
}

const seoul = (svc: string, extra = '') => `http://openapi.seoul.go.kr:8088/${E.SEOUL_OPEN_API_KEY}/json/${svc}/1/2/${extra}`;
const seoulPick = (j: any) => {
  const v: any = Object.values(j)[0];
  return { result: v?.RESULT ?? v, total: v?.list_total_count, row0: v?.row?.[0] };
};

await probe('서울 상권분석 추정매출-상권 (VwsmTrdarSelngQq)', seoul('VwsmTrdarSelngQq'), seoulPick);
await probe('서울 상권분석 점포-상권 (VwsmTrdarStorQq)', seoul('VwsmTrdarStorQq'), seoulPick);
await probe('서울 상권분석 상권영역 (TbgisTrdarRelm)', seoul('TbgisTrdarRelm'), seoulPick);
await probe('서울 상권분석 상주인구-상권 (VwsmTrdarRepopQq)', seoul('VwsmTrdarRepopQq'), seoulPick);
await probe('서울 상권분석 직장인구-상권 (VwsmTrdarWrcPopltnQq)', seoul('VwsmTrdarWrcPopltnQq'), seoulPick);
await probe('서울 지하철 역별 승하차 (CardSubwayStatsNew)', seoul('CardSubwayStatsNew', '20261001'), seoulPick);
await probe('서울 지하철 시간대별 승하차 (CardSubwayTime)', seoul('CardSubwayTime', '202609'), seoulPick);

const sb = (op: string, q: Record<string, string>) =>
  `https://apis.data.go.kr/B553077/api/open/sdsc2/${op}?${new URLSearchParams({ serviceKey: E.DATA_GO_KR_SERVICE_KEY!, type: 'json', numOfRows: '1', pageNo: '1', ...q })}`;
const sbPick = (j: any) => ({ header: j?.header, total: j?.body?.totalCount, item0: j?.body?.items?.[0] });
await probe('소상공인 건물단위 (storeListInBuilding)', sb('storeListInBuilding', { key: '1114010300100310000019225' }), sbPick);
await probe(
  '소상공인 다각형 (storeListInPolygon)',
  sb('storeListInPolygon', { key: `POLYGON((${P.lon - 0.002} ${P.lat - 0.002}, ${P.lon + 0.002} ${P.lat - 0.002}, ${P.lon + 0.002} ${P.lat + 0.002}, ${P.lon - 0.002} ${P.lat + 0.002}, ${P.lon - 0.002} ${P.lat - 0.002}))` }),
  sbPick,
);
await probe('소상공인 업종 반경 (storeListInRadius + 소분류)', sb('storeListInRadius', { radius: '500', cx: String(P.lon), cy: String(P.lat), indsMclsCd: 'I212' }), sbPick);

await probe(
  '카카오 카테고리 검색 카페(CE7) 반경 300m',
  `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=CE7&x=${P.lon}&y=${P.lat}&radius=300&size=1`,
  (j: any) => ({ meta: j?.meta, doc0: j?.documents?.[0] }),
  { Authorization: `KakaoAK ${E.KAKAO_REST_KEY}`, KA: `sdk/1.0 os/javascript lang/ko-KR origin/${E.KAKAO_ORIGIN ?? 'http://localhost:8000'}` },
);
