// Check whether pending data.go.kr APIs are already usable with our key.
// NOT_REGISTERED = endpoint exists but the key is not subscribed; NO_OPENAPI = wrong path.
try {
  process.loadEnvFile('.env');
} catch {
  // real env
}
const K = process.env.DATA_GO_KR_SERVICE_KEY!;
const redact = (s: string) => s.split(K).join('***');

const targets: Array<[string, string]> = [
  ['아파트 매매 실거래가', `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade?serviceKey=${K}&LAWD_CD=11110&DEAL_YMD=202601&numOfRows=1&pageNo=1`],
  ['공정위 브랜드별 가맹점 현황 (추정 경로)', `https://apis.data.go.kr/1130000/FftcBrandFrcsStatsService/getBrandFrcsStats?serviceKey=${K}&pageNo=1&numOfRows=1&resultType=json&yr=2024`],
  ['공정위 브랜드별 창업금액 (추정 경로)', `https://apis.data.go.kr/1130000/FftcBrandFntnStatsService/getBrandFntnStats?serviceKey=${K}&pageNo=1&numOfRows=1&resultType=json&yr=2024`],
  ['행안부 일반음식점 인허가 (추정 경로)', `https://apis.data.go.kr/1741000/GeneralRestaurants/info?serviceKey=${K}&pageNo=1&numOfRows=1&returnType=json`],
];

for (const [name, url] of targets) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    const m = t.match(/(SERVICE_KEY_IS_NOT_REGISTERED_ERROR|NO_OPENAPI_SERVICE_ERROR|SERVICE ACCESS DENIED ERROR|resultCode["<>:\s]*"?\d+)/);
    console.log(`${name} → HTTP ${r.status} ${m?.[0] ?? redact(t.slice(0, 160)).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${name} → ERROR ${redact(String(e))}`);
  }
}
