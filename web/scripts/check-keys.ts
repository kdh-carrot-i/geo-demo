// Smoke-test each API key in .env against a cheap real endpoint. Keys are redacted from output.
try {
  process.loadEnvFile('.env');
} catch {
  // fall back to the real environment
}

const env = (k: string) => process.env[k] ?? '';
const secrets = ['DATA_GO_KR_SERVICE_KEY', 'VWORLD_KEY', 'R_ONE_KEY', 'KAKAO_REST_KEY', 'SGIS_SERVICE_ID', 'SGIS_SECRET_KEY', 'SEOUL_OPEN_API_KEY']
  .map(env)
  .filter(Boolean);
const redact = (s: string) => secrets.reduce((acc, k) => acc.split(k).join('***').split(encodeURIComponent(k)).join('***'), s);

interface Probe {
  group: string;
  name: string;
  url: () => string;
  headers?: () => Record<string, string>;
  /** returns null when OK, otherwise a reason */
  judge: (status: number, body: string, contentType: string) => string | null;
}

const SEOUL = { lon: 126.978, lat: 37.5665 };
let samplePnu = '1114010300100310000';
let sgisToken = '';

/** Seoul Open API wraps results as { <SERVICE>: { RESULT: { CODE: 'INFO-000' } } } or a bare RESULT on error. */
function seoul(status: number, body: string): string | null {
  try {
    const j = JSON.parse(body);
    const svc = Object.values(j)[0] as { RESULT?: { CODE: string; MESSAGE: string }; CODE?: string; MESSAGE?: string };
    const r = svc?.RESULT ?? (svc as { CODE: string; MESSAGE: string });
    return r?.CODE === 'INFO-000' ? null : `${r?.CODE} ${r?.MESSAGE}`;
  } catch {
    return `HTTP ${status} ${body.slice(0, 120)}`;
  }
}

const xmlError = (body: string) => body.match(/<(returnAuthMsg|errMsg|resultMsg)>([^<]+)</)?.[2];

/** data.go.kr services answer in XML or JSON with resultCode "00"/"0"/"INFO-0" on success. */
function dataGoKr(status: number, body: string): string | null {
  if (status !== 200) return `HTTP ${status} ${xmlError(body) ?? body.slice(0, 120)}`;
  if (/SERVICE_KEY|SERVICE ERROR|NO_OPENAPI/.test(body)) return xmlError(body) ?? body.slice(0, 120);
  const code = body.match(/"?resultCode"?\s*[:>]\s*"?([\w-]+)/)?.[1];
  if (code && !/^(0+|INFO-0+)$/.test(code)) {
    const msg = body.match(/"?resultMsg"?\s*[:>]\s*"?([^"<,}]+)/)?.[1];
    return `resultCode ${code} ${msg ?? ''}`;
  }
  return null;
}

const probes: Probe[] = [
  {
    group: 'VWORLD_KEY',
    name: 'WMTS 배경지도 타일 (Base 7/49/109)',
    url: () => `https://api.vworld.kr/req/wmts/1.0.0/${env('VWORLD_KEY')}/Base/7/49/109.png`,
    judge: (s, _b, ct) => (s === 200 && ct.startsWith('image/') ? null : `HTTP ${s} ${ct}`),
  },
  {
    group: 'VWORLD_KEY',
    name: '데이터 API 연속지적도 (서울시청 좌표)',
    url: () =>
      `https://api.vworld.kr/req/data?${new URLSearchParams({
        service: 'data',
        request: 'GetFeature',
        data: 'LP_PA_CBND_BUBUN',
        key: env('VWORLD_KEY'),
        domain: env('VWORLD_DOMAIN') || 'localhost',
        format: 'json',
        crs: 'EPSG:4326',
        geometry: 'false',
        attribute: 'true',
        geomFilter: `POINT(${SEOUL.lon} ${SEOUL.lat})`,
      })}`,
    judge: (_s, b) => {
      try {
        const r = JSON.parse(b).response;
        if (r.status !== 'OK') return `${r.status} ${r.error?.text ?? ''}`;
        const p = r.result.featureCollection.features[0]?.properties;
        if (p?.pnu) samplePnu = p.pnu;
        return null;
      } catch {
        return 'non-JSON response';
      }
    },
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '행안부 법정동코드 (서울특별시 중구)',
    url: () =>
      `https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&type=json&pageNo=1&numOfRows=1&locatadd_nm=${encodeURIComponent('서울특별시 중구')}`,
    judge: dataGoKr,
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '소상공인 상가(상권)정보 반경조회 (서울시청 200m)',
    url: () =>
      `https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&radius=200&cx=${SEOUL.lon}&cy=${SEOUL.lat}&type=json&numOfRows=1&pageNo=1`,
    judge: dataGoKr,
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '국토부 상업업무용 매매 실거래가 (종로구 2024-01)',
    url: () =>
      `https://apis.data.go.kr/1613000/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&LAWD_CD=11110&DEAL_YMD=202401&numOfRows=1&pageNo=1`,
    judge: dataGoKr,
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '건축HUB 건축물대장 표제부 (sample PNU)',
    url: () => {
      const p = samplePnu;
      return `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&sigunguCd=${p.slice(0, 5)}&bjdongCd=${p.slice(5, 10)}&platGbCd=${p[10] === '2' ? '1' : '0'}&bun=${p.slice(11, 15)}&ji=${p.slice(15, 19)}&_type=json&numOfRows=1&pageNo=1`;
    },
    judge: dataGoKr,
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '국토부 아파트 매매 실거래가 (종로구 2026-01)',
    url: () =>
      `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&LAWD_CD=11110&DEAL_YMD=202601&numOfRows=1&pageNo=1`,
    judge: dataGoKr,
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '공정위 브랜드별 가맹점 현황 (2024)',
    url: () =>
      `https://apis.data.go.kr/1130000/FftcBrandFrcsStatsService/getBrandFrcsStats?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&pageNo=1&numOfRows=1&resultType=json&yr=2024`,
    judge: dataGoKr,
  },
  {
    group: 'DATA_GO_KR_SERVICE_KEY',
    name: '공정위 브랜드별 창업금액 (2024)',
    url: () =>
      `https://apis.data.go.kr/1130000/FftcBrandFntnStatsService/getBrandFntnStats?serviceKey=${env('DATA_GO_KR_SERVICE_KEY')}&pageNo=1&numOfRows=1&resultType=json&yr=2024`,
    judge: dataGoKr,
  },
  {
    group: 'R_ONE_KEY',
    name: 'R-ONE 통계표 목록',
    url: () => `https://www.reb.or.kr/r-one/openapi/SttsApiTbl.do?KEY=${env('R_ONE_KEY')}&Type=json&pIndex=1&pSize=3`,
    judge: (s, b) => {
      try {
        const j = JSON.parse(b);
        const head = j.SttsApiTbl?.[0]?.head;
        const result = head?.find?.((h: { RESULT?: { CODE: string; MESSAGE: string } }) => h.RESULT)?.RESULT ?? j.RESULT;
        if (result && result.CODE !== 'INFO-000') return `${result.CODE} ${result.MESSAGE}`;
        return s === 200 && j.SttsApiTbl ? null : `HTTP ${s} ${b.slice(0, 120)}`;
      } catch {
        return `HTTP ${s} non-JSON: ${b.slice(0, 120)}`;
      }
    },
  },
  {
    group: 'SGIS_SECRET_KEY',
    name: 'SGIS 인증 토큰 발급',
    url: () => `https://sgisapi.mods.go.kr/OpenAPI3/auth/authentication.json?consumer_key=${env('SGIS_SERVICE_ID')}&consumer_secret=${env('SGIS_SECRET_KEY')}`,
    judge: (s, b) => {
      try {
        const j = JSON.parse(b);
        if (j.errCd !== 0) return `errCd ${j.errCd} ${j.errMsg}`;
        sgisToken = j.result.accessToken;
        return null;
      } catch {
        return `HTTP ${s} ${b.slice(0, 120)}`;
      }
    },
  },
  {
    group: 'SGIS_SECRET_KEY',
    name: 'SGIS 총조사 주요지표 (서울 중구 소공동)',
    url: () => `https://sgisapi.mods.go.kr/OpenAPI3/stats/population.json?accessToken=${sgisToken}&year=2023&adm_cd=11020520`,
    judge: (s, b) => {
      try {
        const j = JSON.parse(b);
        return j.errCd === 0 ? null : `errCd ${j.errCd} ${j.errMsg}`;
      } catch {
        return `HTTP ${s} ${b.slice(0, 120)}`;
      }
    },
  },
  {
    group: 'SEOUL_OPEN_API_KEY',
    name: '서울 행정동 생활인구 (SPOP_LOCAL_RESD_DONG)',
    url: () => `http://openapi.seoul.go.kr:8088/${env('SEOUL_OPEN_API_KEY')}/json/SPOP_LOCAL_RESD_DONG/1/1/`,
    judge: seoul,
  },
  {
    group: 'SEOUL_OPEN_API_KEY',
    name: '서울 상권분석 길단위인구-상권 (VwsmTrdarFlpopQq)',
    url: () => `http://openapi.seoul.go.kr:8088/${env('SEOUL_OPEN_API_KEY')}/json/VwsmTrdarFlpopQq/1/1/`,
    judge: seoul,
  },
  {
    group: 'KAKAO_REST_KEY',
    name: '카카오 주소 검색',
    url: () => `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent('세종대로 110')}`,
    headers: () => ({
      Authorization: `KakaoAK ${env('KAKAO_REST_KEY')}`,
      KA: `sdk/1.0 os/javascript lang/ko-KR origin/${env('KAKAO_ORIGIN') || 'http://localhost:8000'}`,
    }),
    judge: (s, b) => (s === 200 ? null : `HTTP ${s} ${b.slice(0, 120)}`),
  },
];

let failed = 0;
for (const p of probes) {
  if (!env(p.group)) {
    console.log(`SKIP  [${p.group}] ${p.name} — not set`);
    continue;
  }
  try {
    const res = await fetch(p.url(), { headers: p.headers?.(), signal: AbortSignal.timeout(10000) });
    const ct = res.headers.get('content-type') ?? '';
    const body = ct.startsWith('image/') ? '' : await res.text();
    const why = p.judge(res.status, body, ct);
    if (why) failed++;
    console.log(`${why ? 'FAIL' : 'OK  '}  [${p.group}] ${p.name}${why ? ' — ' + redact(why) : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  [${p.group}] ${p.name} — ${redact(String(e))}`);
  }
}
console.log(`sample PNU used: ${samplePnu}`);
process.exitCode = failed ? 1 : 0;
