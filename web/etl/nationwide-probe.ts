// Nationwide API feasibility run: measure how far each source can be collected by API, load the cheap ones,
// and record totals / calls-needed in api_feasibility. Large sources are sized with numOfRows=1 instead of pulled.
// Usage: tsx etl/nationwide-probe.ts [--only=step,..] [--store-load=11,30]   (store-load = full 상가정보 pull for those 시도)
import { existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import {
  BudgetExceeded, DATA_DIR, E, callStats, dataGoKrError, dgk, findItems, findTotal, getJson, getText, log, lowerRow, openDb, pages, redact, snakeRow, toWgs, xmlTotal,
  type Row,
} from './lib.ts';

const { db, upsert, count, meta, dropCache } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS api_feasibility (
  source TEXT, scope TEXT, unit TEXT, total_rows INTEGER, page_size INTEGER, calls_full INTEGER, calls_used INTEGER,
  verdict TEXT, note TEXT, probed_at TEXT, PRIMARY KEY (source, scope))`);
const feas = (r: { source: string; scope: string; unit?: string; total_rows?: number; page_size?: number; calls_full?: number; calls_used?: number; verdict: string; note?: string }) =>
  upsert('api_feasibility', [{ ...r, probed_at: new Date().toISOString() }]);

const used = (host: string) => (callStats()[host] as number | undefined) ?? 0;
const DG = 'apis.data.go.kr';

/** data.go.kr call that throws on auth/quota errors and returns parsed JSON. */
async function dgJson(path: string, q: Record<string, string>, raw?: [string, string]) {
  const { text } = await getText(dgk(path, q), { raw });
  const err = dataGoKrError(text);
  if (err) throw new Error(err);
  return JSON.parse(text);
}

// 2026 법정동코드 merges 광주(29)+전남(46) into 12 and has no 시도 row for 세종(36); other APIs may still use the old codes,
// so probe every sido_cd present plus the legacy ones (empty codes simply return 0).
const sidos = () => {
  const now = (db.prepare(`SELECT DISTINCT sido_cd c FROM region_legal WHERE sido_cd IS NOT NULL`).all() as { c: string }[]).map((r) => r.c);
  return [...new Set([...now, '29', '36', '46'])].sort().map((c) => ({ c }));
};
/** 5-digit LAWD codes used by 실거래 APIs: city codes that have 일반구 children are replaced by the 구. */
function sggs() {
  const all = (db.prepare(`SELECT DISTINCT substr(bjd_cd,1,5) c, max(locatadd_nm) n FROM region_legal WHERE umd_cd='000' AND sgg_cd<>'000' GROUP BY 1`).all() as { c: string; n: string }[]);
  return all.filter((x) => !(x.c[4] === '0' && all.some((y) => y.c !== x.c && y.c.slice(0, 4) === x.c.slice(0, 4))));
}

const steps: Record<string, () => Promise<void>> = {
  async region_legal() {
    const path = '1741000/StanReginCd/getStanReginCdList';
    const before = used(DG);
    const q = (p: number) => ({ type: 'json', pageNo: String(p), numOfRows: '1000' });
    const take = (j: unknown) => upsert('region_legal', findItems(j).filter((r) => r.region_cd).map(({ region_cd, ...r }) => ({ bjd_cd: region_cd, ...r })));
    const first = await dgJson(path, q(1), ['stanregincd', 'p1']);
    const total = Number(JSON.stringify(first).match(/"totalCount":\s*"?(\d+)/)?.[1] ?? 0);
    take(first);
    for (const p of pages(total, 1000).slice(1)) take(await dgJson(path, q(p), ['stanregincd', `p${p}`]));
    meta('region_legal', { source: '행안부 법정동코드', endpoint: path, std_period: 'current', status: 'loaded', note: '전국' });
    feas({ source: '법정동코드', scope: '전국', unit: '법정동', total_rows: total, page_size: 1000, calls_full: Math.ceil(total / 1000), calls_used: used(DG) - before, verdict: 'API 전량 ✅', note: `시도 ${sidos().length}, 실거래용 시군구 ${sggs().length}` });
  },

  async store() {
    const base = 'B553077/api/open/sdsc2';
    const before = used(DG);
    let sum = 0;
    const per: string[] = [];
    for (const s of sidos()) {
      const j = await dgJson(`${base}/storeListInDong`, { divId: 'ctprvnCd', key: s.c, type: 'json', numOfRows: '1', pageNo: '1' });
      const t = Math.max(0, findTotal(j));
      sum += t;
      per.push(`${s.c}:${t}`);
    }
    const snap = await dgJson(`${base}/storeListByDate`, { key: '20260630', type: 'json', numOfRows: '1', pageNo: '1' });
    const snapTotal = findTotal(snap);
    feas({ source: '상가정보', scope: '전국(시도별 합)', unit: '점포', total_rows: sum, page_size: 1000, calls_full: Math.ceil(sum / 1000) + sidos().length, calls_used: used(DG) - before, verdict: 'API 전량 가능 (호출량 큼)', note: per.join(' ') });
    feas({ source: '상가정보', scope: '분기 스냅샷 storeListByDate', unit: '점포', total_rows: snapTotal, page_size: 1000, calls_full: Math.ceil(snapTotal / 1000), verdict: '분기 기준일(20260630)만 응답, 행별 변경구분 포함', note: '증분이 아닌 전체 스냅샷' });

    const load = process.argv.find((a) => a.startsWith('--store-load='))?.split('=')[1]?.split(',') ?? [];
    for (const c of load) {
      const b0 = used(DG);
      const q = (p: number) => ({ divId: 'ctprvnCd', key: c, type: 'json', numOfRows: '1000', pageNo: String(p) });
      const first = await dgJson(`${base}/storeListInDong`, q(1), ['sdsc2_store', `${c}_p1`]);
      const total = findTotal(first);
      upsert('store', findItems(first).map(snakeRow));
      const failed: number[] = [];
      for (const p of pages(total, 1000).slice(1)) {
        try {
          upsert('store', findItems(await dgJson(`${base}/storeListInDong`, q(p), ['sdsc2_store', `${c}_p${p}`])).map(snakeRow));
        } catch (e) {
          if (e instanceof BudgetExceeded) throw e;
          failed.push(p);
        }
        if (p % 100 === 0) log(`  store ${c} ${p}/${Math.ceil(total / 1000)}`);
      }
      feas({ source: '상가정보', scope: `시도 ${c} 전량 적재`, unit: '점포', total_rows: total, page_size: 1000, calls_full: Math.ceil(total / 1000), calls_used: used(DG) - b0, verdict: failed.length ? '부분' : '적재 ✅', note: failed.length ? `실패 페이지 ${failed.join(',')}` : undefined });
    }
    if (load.length) {
      db.exec(`INSERT OR REPLACE INTO industry_store (scls_cd, lcls_cd, lcls_nm, mcls_cd, mcls_nm, scls_nm)
               SELECT inds_scls_cd, max(inds_lcls_cd), max(inds_lcls_nm), max(inds_mcls_cd), max(inds_mcls_nm), max(inds_scls_nm) FROM store WHERE inds_scls_cd IS NOT NULL GROUP BY 1`);
      db.exec(`INSERT OR REPLACE INTO region_admin (adm_cd, adm_nm, sgg_cd, sgg_nm)
               SELECT substr(adong_cd,1,8), max(adong_nm), max(signgu_cd), max(signgu_nm) FROM store WHERE adong_cd IS NOT NULL GROUP BY 1`);
      // the store API carries no 기준년월 field; the quarterly snapshot date answered by storeListByDate is the reference
      meta('store', { source: '소상공인 상가(상권)정보', endpoint: `${base}/storeListInDong`, std_period: '2026Q2 (기준일 20260630)', status: 'loaded', note: `시도 ${load.join(',')}` });
      meta('industry_store', { source: 'store 에서 도출', status: 'loaded' });
      meta('region_admin', { source: 'store 에서 도출', status: 'loaded' });
    }
  },

  async trade_zone() {
    const path = 'B553077/api/open/sdsc2/storeZoneInAdmi';
    const before = used(DG);
    for (const s of sidos()) {
      const q = (p: number) => ({ divId: 'ctprvnCd', key: s.c, type: 'json', numOfRows: '1000', pageNo: String(p) });
      const take = (j: unknown) => upsert('trade_zone_sbiz', findItems(j).map((r) => { const { coords, ...rest } = snakeRow(r); return { ...rest, wkt: coords }; }));
      const first = await dgJson(path, q(1), ['sdsc2_zone', `${s.c}_p1`]);
      take(first);
      for (const p of pages(findTotal(first), 1000).slice(1)) take(await dgJson(path, q(p), ['sdsc2_zone', `${s.c}_p${p}`]));
    }
    meta('trade_zone_sbiz', { source: '소상공인 상권영역', endpoint: path, status: 'loaded', note: '전국, wkt=POLYGON(WGS84)' });
    feas({ source: '소상공인 상권영역', scope: '전국', unit: '상권', total_rows: count('trade_zone_sbiz'), page_size: 1000, calls_full: used(DG) - before, calls_used: used(DG) - before, verdict: 'API 전량 ✅' });
  },

  async trade_sample() {
    const list = sggs();
    const month = '202609';
    const apis: [string, string][] = [
      ['상업업무용 실거래', '1613000/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade'],
      ['아파트 실거래', '1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade'],
    ];
    for (const [name, path] of apis) {
      const before = used(DG);
      const sample: string[] = [];
      let maxRows = 0;
      // one 시군구 per 시도 (the first), one month, numOfRows=1 → totalCount
      for (const s of sidos()) {
        const g = list.find((x) => x.c.startsWith(s.c));
        if (!g) continue;
        const { text } = await getText(dgk(path, { LAWD_CD: g.c, DEAL_YMD: month, numOfRows: '1', pageNo: '1' }));
        const err = dataGoKrError(text);
        if (err) throw new Error(err);
        const t = xmlTotal(text);
        maxRows = Math.max(maxRows, t);
        sample.push(`${g.c}:${t}`);
      }
      const full = list.length * 12;
      feas({ source: name, scope: `전국 ${list.length}개 시군구 × 12개월`, unit: '거래', page_size: 1000, calls_full: full, calls_used: used(DG) - before, verdict: 'API 전량 가능 (월 1회 증분)', note: `표본 ${month} 최대 ${maxRows}건/시군구 → 대부분 1페이지. ${sample.join(' ')}` });
    }
  },

  async building() {
    const path = '1613000/BldRgstHubService/getBrTitleInfo';
    const before = used(DG);
    const one = await getText(dgk(path, { sigunguCd: '11110', bjdongCd: '10100', _type: 'json', numOfRows: '100', pageNo: '1' }));
    const err = dataGoKrError(one.text);
    let dongTotal = -1;
    let perPage = 0;
    try {
      const j = JSON.parse(one.text);
      dongTotal = findTotal(j);
      perPage = findItems(j).length;
    } catch {
      dongTotal = xmlTotal(one.text);
    }
    const umd = (db.prepare(`SELECT count(*) n FROM region_legal WHERE umd_cd<>'000' AND ri_cd='00'`).get() as { n: number }).n;
    feas({
      source: '건축HUB 표제부', scope: '법정동 단위(번지 생략) 조회', unit: '건축물', total_rows: dongTotal, page_size: perPage || 100,
      calls_full: undefined, calls_used: used(DG) - before,
      verdict: err ? `오류: ${err}` : dongTotal > 0 ? '법정동 단위 일괄 조회 가능 — 전국은 파일 권장' : '번지 없이 조회 불가',
      note: `종로구 청운동 ${dongTotal}건, 페이지당 ${perPage}건. 전국 법정동 ${umd}개 × 수 페이지 → 수만 호출, 세움터 개방 파일이 현실적`,
    });
  },

  async franchise() {
    const apis: [string, string, string][] = [
      ['franchise_brand_y', '1130000/FftcBrandFrcsStatsService/getBrandFrcsStats', '공정위 브랜드별 가맹점 현황'],
      ['franchise_cost_y', '1130000/FftcBrandFntnStatsService/getBrandFntnStats', '공정위 브랜드별 창업금액'],
    ];
    for (const [table, path, label] of apis) {
      const before = used(DG);
      const years: string[] = [];
      for (const yr of ['2025', '2024', '2023']) {
        const q = (p: number) => ({ pageNo: String(p), numOfRows: '1000', resultType: 'json', yr });
        const first = await dgJson(path, q(1), [table, `${yr}_p1`]);
        const items = findItems(first);
        if (!items.length) continue;
        upsert(table, items.map((r) => ({ yr, ...snakeRow(r) })));
        for (const p of pages(findTotal(first), 1000).slice(1)) upsert(table, findItems(await dgJson(path, q(p), [table, `${yr}_p${p}`])).map((r) => ({ yr, ...snakeRow(r) })));
        years.push(yr);
      }
      meta(table, { source: label, endpoint: path, std_period: years.join(','), status: 'loaded', note: '전국(브랜드 단위)' });
      feas({ source: label, scope: '전국 3개년', unit: '브랜드', total_rows: count(table), page_size: 1000, calls_full: used(DG) - before, calls_used: used(DG) - before, verdict: 'API 전량 ✅' });
    }
  },

  async sgis() {
    const H = 'sgisapi.mods.go.kr';
    const before = used(H);
    const tok = await getJson(`https://${H}/OpenAPI3/auth/authentication.json?consumer_key=${E.SGIS_SERVICE_ID}&consumer_secret=${E.SGIS_SECRET_KEY}`);
    const at = tok.result.accessToken;
    // without low_search=1 SGIS answers -100 (no result); its 시도 codes are 통계청 codes (부산 21 …), not 법정동 codes
    const top = await getJson(`https://${H}/OpenAPI3/stats/population.json?accessToken=${at}&year=2024&low_search=1`);
    const sidoCodes: string[] = (top.result ?? []).map((r: Row) => String(r.adm_cd));
    const merged = new Map<string, Row>();
    const years: Record<string, string> = {};
    for (const [kind, ys] of [['population', [2024, 2023]], ['household', [2024, 2023]], ['company', [2023, 2022]]] as const) {
      for (const y of ys) {
        let got = 0;
        for (const c of sidoCodes) {
          const j = await getJson(`https://${H}/OpenAPI3/stats/${kind}.json?accessToken=${at}&year=${y}&adm_cd=${c}&low_search=2`, ['sgis', `${kind}_${y}_${c}`]);
          for (const { adm_cd, adm_nm, ...r } of (j.result ?? []) as Row[]) {
            const k = String(adm_cd);
            merged.set(k, { ...(merged.get(k) ?? { sgis_adm_cd: adm_cd, adm_nm, year: '2024' }), ...r, ...(kind === 'population' ? {} : { [`${kind}_year`]: String(y) }) });
            got++;
          }
        }
        if (got) {
          years[kind] = String(y);
          break;
        }
      }
    }
    upsert('sgis_adm_stats', [...merged.values()]);
    meta('sgis_adm_stats', { source: 'SGIS 총조사 주요지표·가구·사업체', std_period: JSON.stringify(years), status: 'loaded', note: `전국 시도 ${sidoCodes.length}` });
    feas({ source: 'SGIS 인구·가구·사업체', scope: `전국 행정동 (시도 ${sidoCodes.length} × low_search=2)`, unit: '행정동', total_rows: merged.size, calls_full: used(H) - before, calls_used: used(H) - before, verdict: 'API 전량 ✅', note: `연도 ${JSON.stringify(years)}; 집계구 단위는 경계 파일 신청 필요` });
  },

  async rone() {
    const H = 'www.reb.or.kr';
    const before = used(H);
    db.exec('DROP TABLE IF EXISTS rone_stat');
    dropCache('rone_stat');
    db.exec(`CREATE TABLE rone_stat (statbl_id TEXT, statbl_nm TEXT, dtacycle_cd TEXT, wrttime_idtfr_id TEXT, wrttime_desc TEXT,
      grp_id INTEGER, grp_nm TEXT, grp_fullnm TEXT, cls_id INTEGER, cls_nm TEXT, cls_fullnm TEXT, itm_id INTEGER, itm_nm TEXT, ui_nm TEXT, dta_val NUMERIC,
      PRIMARY KEY (statbl_id, dtacycle_cd, wrttime_idtfr_id, grp_id, cls_id, itm_id))`);
    const list: Row[] = [];
    for (let p = 1; p < 20; p++) {
      const j = await getJson(`https://${H}/r-one/openapi/SttsApiTbl.do?KEY=${E.R_ONE_KEY}&Type=json&pIndex=${p}&pSize=1000`);
      const rows: Row[] = j.SttsApiTbl?.[1]?.row ?? [];
      list.push(...rows);
      if (rows.length < 1000) break;
    }
    const targets = list.filter((r) => /(임대가격지수|공실률|임대료|권리금|투자수익률)/.test(String(r.STATBL_NM)) && /(오피스|중대형|소규모|집합|상가|상업)/.test(String(r.STATBL_NM)));
    let truncated = 0;
    let tables = 0;
    for (const t of targets) {
      const id = String(t.STATBL_ID);
      let loaded = 0;
      for (const cyc of ['QY', 'YY', 'HY', 'MM']) {
        let p = 1;
        for (; p <= 40; p++) {
          const j = await getJson(`https://${H}/r-one/openapi/SttsApiTblData.do?KEY=${E.R_ONE_KEY}&Type=json&STATBL_ID=${id}&DTACYCLE_CD=${cyc}&pIndex=${p}&pSize=1000`, ['rone', `${id}_${cyc}_p${p}`]);
          const rows: Row[] = j.SttsApiTblData?.[1]?.row ?? [];
          loaded += upsert('rone_stat', rows.map((r) => ({ ...lowerRow(r), statbl_nm: t.STATBL_NM })));
          if (rows.length < 1000) break;
        }
        if (p > 40) truncated++;
        if (loaded) break;
      }
      if (loaded) tables++;
    }
    const range = db.prepare('SELECT min(wrttime_idtfr_id) a, max(wrttime_idtfr_id) b FROM rone_stat').get() as { a: string; b: string };
    meta('rone_stat', { source: 'R-ONE 상업용부동산 임대동향·권리금', endpoint: 'SttsApiTblData.do', std_period: `${range.a}~${range.b}`, status: 'loaded', note: `통계표 ${tables}/${targets.length}, 전 지역` });
    feas({ source: 'R-ONE 임대동향·권리금', scope: `전국 (통계표 ${targets.length}개)`, unit: '지역×상권×기간', total_rows: count('rone_stat'), page_size: 1000, calls_full: used(H) - before, calls_used: used(H) - before, verdict: truncated ? `부분 (표 ${truncated}개 40페이지 초과)` : 'API 전량 ✅', note: `데이터 있는 표 ${tables}` });
  },

  async vworld() {
    const H = 'api.vworld.kr';
    const before = used(H);
    const params = new URLSearchParams({
      service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN', key: E.VWORLD_KEY!, domain: E.VWORLD_DOMAIN ?? 'localhost',
      format: 'json', crs: 'EPSG:4326', geometry: 'false', attribute: 'true', size: '1000', page: '1', attrFilter: 'pnu:like:1111010100',
    });
    const j = await getJson(`https://${H}/req/data?${params}`);
    const r = j.response;
    const total = Number(r?.record?.total ?? -1);
    const got = r?.result?.featureCollection?.features?.length ?? 0;
    feas({
      source: '브이월드 연속지적(공시지가 포함)', scope: '법정동 1개 (종로구 청운동) 표본', unit: '필지', total_rows: total, page_size: got, calls_used: used(H) - before,
      verdict: r?.status === 'OK' ? 'API는 건별·소량 조회용 — 전국은 파일' : `응답 ${r?.status} ${r?.error?.text ?? ''}`,
      note: `페이지당 ${got}건 반환. 전국 약 3,900만 필지 ÷ 1,000 ≈ 39,000 호출 → 국가공간정보포털 SHP 파일 사용`,
    });
  },

  async license() {
    const FOOD_CSV = resolve(DATA_DIR, 'raw', 'general_food_store.csv');
    if (!existsSync(FOOD_CSV)) return;
    const map: Record<string, string> = {
      관리번호: 'mgt_no', 개방자치단체코드: 'opn_sfteam_code', 인허가일자: 'apv_perm_ymd', 영업상태명: 'trd_state_nm', 상세영업상태명: 'dtl_state_nm',
      폐업일자: 'dcb_ymd', 소재지면적: 'site_area', 사업장명: 'bplc_nm', 업태구분명: 'uptae_nm', 도로명주소: 'rdn_whl_addr', 지번주소: 'site_whl_addr',
      '좌표정보(X)': 'x_5174', '좌표정보(Y)': 'y_5174', 다중이용업소여부: 'multused_yn', 시설총규모: 'fac_tot_scp', 데이터갱신구분: 'update_gbn', 데이터갱신시점: 'update_dt', 최종수정시점: 'last_mod_ts',
    };
    db.exec(`DELETE FROM license_event WHERE opn_svc_id = '07_24_04_P'`);
    const parse = (line: string) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"') {
            if (line[i + 1] === '"') (cur += '"'), i++;
            else q = false;
          } else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') out.push(cur), (cur = '');
        else cur += c;
      }
      out.push(cur);
      return out;
    };
    const decoder = new TextDecoder('euc-kr');
    let header: string[] | null = null;
    let carry = '';
    let pending = '';
    let batch: Row[] = [];
    let seen = 0;
    const handle = (line: string) => {
      if (pending) line = pending + '\n' + line;
      if ((line.match(/"/g)?.length ?? 0) % 2) {
        pending = line;
        return;
      }
      pending = '';
      if (!line) return;
      const f = parse(line);
      if (!header) {
        header = f.map((h) => h.trim());
        return;
      }
      seen++;
      const raw: Row = {};
      header.forEach((h, i) => map[h] && (raw[map[h]] = f[i]?.trim()));
      const addr = String(raw.rdn_whl_addr || raw.site_whl_addr || '').split(/\s+/);
      const [lon, lat] = toWgs('EPSG:5174', Number(raw.x_5174), Number(raw.y_5174));
      batch.push({ ...raw, opn_svc_id: '07_24_04_P', opn_svc_nm: '일반음식점', lon, lat, sido_nm: addr[0] ?? null, sgg_nm: addr[1] ?? null });
      if (batch.length >= 10000) (upsert('license_event', batch), (batch = []));
      if (seen % 500000 === 0) log(`  license ${seen}`);
    };
    for await (const chunk of createReadStream(FOOD_CSV)) {
      const text = carry + decoder.decode(chunk as Buffer, { stream: true });
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const l of lines) handle(l);
    }
    handle(carry + decoder.decode());
    upsert('license_event', batch);
    const open = (db.prepare(`SELECT count(*) n FROM license_event WHERE dcb_ymd IS NULL`).get() as { n: number }).n;
    meta('license_event', { source: '지방행정 인허가 일반음식점 (CSV)', endpoint: 'data/raw/general_food_store.csv', status: 'loaded', note: `전국 ${seen}행, 영업중 ${open}; 좌표 EPSG:5174→WGS84` });
    feas({ source: '인허가 일반음식점', scope: '전국 CSV', unit: '사업장(폐업 포함)', total_rows: count('license_event'), verdict: '파일 전량 ✅ (API 불필요)', note: `데이터갱신구분(I/U/D)·갱신시점으로 증분 가능` });
  },
};

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]?.split(',');
const only = arg('only');
const order = ['region_legal', 'store', 'trade_zone', 'trade_sample', 'building', 'franchise', 'sgis', 'rone', 'vworld', 'license'];
const t0 = Date.now();
for (const name of order) {
  if (only && !only.includes(name)) continue;
  const t = Date.now();
  log(`▶ ${name}`);
  try {
    await steps[name]();
    log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(0)}s) calls=${JSON.stringify(callStats())}`);
  } catch (e) {
    log(`✘ ${name}: ${redact(String(e)).slice(0, 300)}`);
    feas({ source: `step:${name}`, scope: '-', verdict: e instanceof BudgetExceeded ? '예산 초과로 중단' : '실패', note: redact(String(e)).slice(0, 300) });
  }
}
for (const r of db.prepare('SELECT source, scope, total_rows, calls_full, calls_used, verdict FROM api_feasibility ORDER BY source').all() as Row[])
  log(`  ${r.source} | ${r.scope} | rows=${r.total_rows ?? ''} full=${r.calls_full ?? ''} used=${r.calls_used ?? ''} | ${r.verdict}`);
log(`done ${((Date.now() - t0) / 60000).toFixed(1)} min, calls=${JSON.stringify(callStats())}`);
db.close();
