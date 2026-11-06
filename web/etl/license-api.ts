// 행정안전부 인허가 API (공공데이터포털, 2026-01 통합 개방) → license_event.
// Survival-model training data for 업종 beyond 일반음식점. Crawled per 인허가일 window (see url()).
// Resumable: finished window pages are recorded in etl_progress, so re-running continues where it stopped
// (raw pages also land in data/lake/raw).
//
//   npx tsx etl/license-api.ts tobacco_retailers   # 담배소매업 (편의점 대부분)  2016~ 전부 + 이전 영업 중 ≈ 21만 행, 2.1k calls
//   npx tsx etl/license-api.ts rest_cafes          # 휴게음식점 (카페·편의점 일부) 같은 범위
//   npx tsx etl/license-api.ts all
//
// Dev-account limit is 10,000 calls/day per API; set BUDGET_DATA_GO_KR to cap one run (default here 7000).
import { resolve } from 'node:path';
import { DATA_DIR, E, getJson, log, openDb, sleep, toWgs, type Row } from './lib.ts';

E.BUDGET_DATA_GO_KR ??= '7000';

const SERVICES = {
  tobacco_retailers: { label: '담배소매업', uptae: (_: Row) => '담배소매' },
  rest_cafes: { label: '휴게음식점', uptae: (r: Row) => String(r.BZSTAT_SE_NM || '기타 휴게음식점') },
} as const;
type Svc = keyof typeof SERVICES;

const PAGE = 100; // API maximum
const CONCURRENCY = 2; // starts are still spaced by the per-host throttle in lib.ts; the API returns HTTP_ERROR when pushed
const ATTEMPTS = 6; // the provider answers the same query in ~8s or >20s (portal timeout → HTTP_ERROR 04) at random

const { db, upsert } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS etl_progress (job TEXT, page INTEGER, rows INTEGER, done_at TEXT, PRIMARY KEY (job, page))`);
db.exec(`CREATE INDEX IF NOT EXISTS license_event_svc ON license_event(opn_svc_id)`);

// The provider pages with OFFSET: past roughly page 1,000 of the unfiltered list it takes >20s and the
// portal answers HTTP_ERROR (code 04). So we crawl by 인허가일 window (cond[LCPMT_YMD]); inside a window
// even page 150 answers in ~6s. Every row has LCPMT_YMD, so the windows cover the whole list.
/** stts: 영업상태코드 filter (01 = 영업/정상) */
type Win = { from: string; to: string; stts?: string };
const url = (svc: Svc, w: Win, page: number) =>
  `https://apis.data.go.kr/1741000/${svc}/info?${new URLSearchParams({
    serviceKey: E.DATA_GO_KR_SERVICE_KEY!,
    pageNo: String(page),
    numOfRows: String(PAGE),
    returnType: 'json',
    'cond[LCPMT_YMD::GTE]': w.from,
    'cond[LCPMT_YMD::LT]': w.to,
    ...(w.stts ? { 'cond[SALS_STTS_CD::EQ]': w.stts } : {}),
  })}`;
/**
 * Scope (2026-11-02 결정): 인허가 2016년 이후는 전부 (생존 모델의 개업 → 3년 폐업 레이블),
 * 그 이전은 지금 영업 중인 곳만 (주변 경쟁점 수). 2016년 이전 폐업 37.5만 건은 받지 않는다.
 */
const FROM_YEAR = 2016;
function windows(): Win[] {
  const out: Win[] = [{ from: '00000101', to: `${FROM_YEAR}0101`, stts: '01' }];
  const last = new Date().getFullYear() + 1;
  for (let y = FROM_YEAR; y <= last; y++) out.push({ from: `${y}0101`, to: y === last ? '29990101' : `${y + 1}0101` });
  return out;
}
const MAX_PAGES = 200; // split a window in half (by date) when it is deeper than this
function halve(w: Win): [Win, Win] | null {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const lo = Math.max(d(w.from), Date.UTC(1900, 0, 1));
  const hi = Math.min(d(w.to), Date.UTC(new Date().getFullYear() + 2, 0, 1));
  if (hi - lo < 2 * 86400000) return null;
  const mid = new Date(lo + Math.floor((hi - lo) / 86400000 / 2) * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  return [{ ...w, to: mid }, { ...w, from: mid }];
}

const ymd = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

function toRow(svc: Svc, r: Row): Row {
  const x = Number(r.CRD_INFO_X);
  const y = Number(r.CRD_INFO_Y);
  const [lon, lat] = Number.isFinite(x) && Number.isFinite(y) && x && y ? toWgs('EPSG:5174', x, y) : [null, null];
  const addr = String(r.ROAD_NM_ADDR || r.LOTNO_ADDR || '');
  const area = Number(r.FCLT_TOTAL_SCL ?? r.LCTN_AREA);
  return {
    // 관리번호 is only unique within one 인허가 업종
    mgt_no: `${svc}:${r.MNG_NO}`,
    opn_svc_id: svc,
    opn_svc_nm: SERVICES[svc].label,
    bplc_nm: r.BPLC_NM,
    apv_perm_ymd: ymd(r.LCPMT_YMD),
    dcb_ymd: ymd(r.CLSBIZ_YMD),
    trd_state_nm: r.SALS_STTS_NM,
    dtl_state_nm: r.DTL_SALS_STTS_NM,
    site_area: Number.isFinite(area) && area > 0 ? area : null,
    uptae_nm: SERVICES[svc].uptae(r),
    rdn_whl_addr: r.ROAD_NM_ADDR || null,
    site_whl_addr: r.LOTNO_ADDR || null,
    x_5174: Number.isFinite(x) ? x : null,
    y_5174: Number.isFinite(y) ? y : null,
    lon,
    lat,
    opn_sfteam_code: r.OPN_ATMY_GRP_CD,
    multused_yn: r.MLT_UTZTN_BSNSSP_YN ?? null,
    update_gbn: r.DAT_UPDT_SE,
    update_dt: r.DAT_UPDT_PNT,
    last_mod_ts: r.LAST_MDFCN_PNT,
    sido_nm: addr.split(' ')[0] || null,
  };
}

async function crawl(svc: Svc) {
  const jobOf = (w: Win) => `license_api:${svc}:${w.from}-${w.to}${w.stts ? `:s${w.stts}` : ''}`;
  const mark = db.prepare('INSERT OR REPLACE INTO etl_progress (job, page, rows, done_at) VALUES (?, ?, ?, ?)');
  const doneIn = db.prepare('SELECT page FROM etl_progress WHERE job = ?');
  const items = (j: any): Row[] => {
    const it = j?.response?.body?.items?.item;
    return Array.isArray(it) ? it : it ? [it] : [];
  };
  // A busy gateway answers 200 with OpenAPI_ServiceResponse/HTTP_ERROR instead of data: retry those,
  // and never record a page as done unless the body has the normal response envelope.
  const fetchPage = async (w: Win, page: number) => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const j = await getJson(url(svc, w, page), [svc, `${w.from}-${w.to}${w.stts ? `_s${w.stts}` : ''}_p${page}`]);
      const code = j?.response?.header?.resultCode;
      if (j?.response?.body && (!code || code === '0' || code === '00')) return j;
      log(`${svc} ${w.from}~${w.to} p${page}: ${j?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg ?? j?.response?.header?.resultMsg ?? 'unexpected'} (try ${attempt})`);
      await sleep(5000 * attempt);
    }
    return null;
  };
  const save = (w: Win, page: number, list: Row[]) => {
    upsert('license_event', list.map((r) => toRow(svc, r)));
    mark.run(jobOf(w), page, list.length, new Date().toISOString());
  };

  // the first call can hit the same random gateway timeout: retry it like any page
  const all = await fetchPage({ from: '00000101', to: '29990101' }, 1);
  const total = Number(all?.response?.body?.totalCount ?? -1);
  if (total < 0) throw new Error(`${svc}: unexpected response ${JSON.stringify(all).slice(0, 200)}`);

  // plan: page 1 of each window gives its size (and its first rows); split windows that are too deep
  const plan: { w: Win; pages: number }[] = [];
  const skipped: Win[] = []; // page 1 kept failing: left for the next run
  const queue = windows();
  while (queue.length) {
    const w = queue.shift()!;
    const first = await fetchPage(w, 1);
    if (!first) {
      skipped.push(w);
      continue;
    }
    const pages = Math.ceil(Number(first.response.body.totalCount ?? 0) / PAGE);
    const parts = pages > MAX_PAGES ? halve(w) : null;
    if (parts) {
      queue.unshift(...parts);
      continue;
    }
    if (!doneIn.all(jobOf(w)).length) save(w, 1, items(first));
    plan.push({ w, pages });
  }
  const todo = plan.flatMap(({ w, pages }) => {
    const done = new Set((doneIn.all(jobOf(w)) as { page: number }[]).map((r) => r.page));
    return Array.from({ length: pages }, (_, i) => i + 1).filter((p) => !done.has(p)).map((page) => ({ w, page }));
  });
  const nPages = plan.reduce((s, x) => s + x.pages, 0);
  log(`${svc}: total ${total}, ${plan.length} 인허가일 구간, pages ${nPages}, to fetch ${todo.length}${skipped.length ? `, 건너뛴 구간 ${skipped.length} (다음 실행에서 다시)` : ''}`);

  let next = 0;
  let fetched = 0;
  let failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { w, page } = todo[next++];
      const j = await fetchPage(w, page);
      if (!j) {
        failed++;
        continue; // not marked done, so the next run retries it
      }
      save(w, page, items(j));
      if (++fetched % 200 === 0) log(`${svc}: ${nPages - todo.length + fetched}/${nPages} pages`);
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    const got = db.prepare(`SELECT count(*) n, sum(rows) r FROM etl_progress WHERE job LIKE ?`).get(`license_api:${svc}:%`) as { n: number; r: number };
    const stored = (db.prepare('SELECT count(*) n FROM license_event WHERE opn_svc_id = ?').get(svc) as { n: number }).n;
    const complete = got.n >= nPages && !failed && !skipped.length;
    // one meta row per 인허가 업종 (license_event also holds 일반음식점 from the CSV)
    upsert('meta_source', [
      {
        table_name: `license_event:${svc}`,
        source: `행정안전부 인허가 ${SERVICES[svc].label} (공공데이터포털 API)`,
        endpoint: `apis.data.go.kr/1741000/${svc}/info (인허가일 구간별)`,
        std_period: `수집 ${new Date().toISOString().slice(0, 10)}`,
        status: complete ? 'loaded' : 'partial',
        note: `인허가 ${FROM_YEAR}년 이후 전부 + 그 이전은 영업 중만. 전국 ${total}행 중 ${stored}행 적재 (${got.n}/${nPages} 페이지)${complete ? '' : ' — 다시 실행하면 이어 받음'}`,
        row_count: stored,
        loaded_at: new Date().toISOString(),
      },
    ]);
    log(`${svc}: ${got.n}/${nPages} pages, ${stored}/${total} rows stored${complete ? ' — complete' : ''}${failed ? `, ${failed} pages failed (re-run to retry)` : ''}${skipped.length ? `, ${skipped.length} windows skipped` : ''}`);
  }
}

const arg = process.argv[2] ?? 'all';
const list: Svc[] = arg === 'all' ? (Object.keys(SERVICES) as Svc[]) : [arg as Svc];
for (const svc of list) {
  if (!(svc in SERVICES)) throw new Error(`unknown service ${svc}`);
  await crawl(svc);
  await sleep(1000);
}
