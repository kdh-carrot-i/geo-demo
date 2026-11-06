// Seoul-only sources (서울 열린데이터 API) → data/commerce.sqlite. Nationwide sources live in etl/nationwide-probe.ts (schema: etl/schema.sql, ERD: docs/03_DB_설계.md).
// Usage: tsx etl/seoul-sqlite.ts [--only=step,step] [--skip=step,step]   env: QUARTERS (default 8)
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import proj4 from 'proj4';

const ROOT = resolve(import.meta.dirname, '..');
try {
  process.loadEnvFile(resolve(ROOT, '.env'));
} catch {
  // real env
}
const E = process.env;
const secrets = [E.SEOUL_OPEN_API_KEY, E.DATA_GO_KR_SERVICE_KEY, E.R_ONE_KEY, E.SGIS_SERVICE_ID, E.SGIS_SECRET_KEY].filter(Boolean) as string[];
const redact = (s: string) => secrets.reduce((a, k) => a.split(k).join('***').split(encodeURIComponent(k)).join('***'), s);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), redact(a.map(String).join(' ')));

const DATA_DIR = resolve(ROOT, '..', 'data');
const DB_PATH = resolve(DATA_DIR, 'commerce.sqlite');
const FOOD_CSV = resolve(DATA_DIR, 'raw', 'general_food_store.csv');
const QUARTERS = Number(E.QUARTERS ?? 8);
const LATEST_QUARTER = '20262';

proj4.defs('EPSG:5181', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:5174', '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43');
const toWgs = (crs: string, x: number, y: number): [number, number] | [null, null] =>
  Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0 ? (proj4(crs, 'EPSG:4326', [x, y]) as [number, number]) : [null, null];

// ── db helpers ──────────────────────────────────────────────
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf8'));

type Row = Record<string, unknown>;
const NUMERIC_COL = /(_co|_amt|_cnt|_rt|_ar|_area|amount|_val|ppltn|_per|_idx|dnsty|family|house|worker|_nope|tnope|_age|price|^lon|^lat|^hr)$/;
const colCache = new Map<string, Set<string>>();
function columns(table: string) {
  let s = colCache.get(table);
  if (!s) {
    s = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    colCache.set(table, s);
  }
  return s;
}
function ensureColumns(table: string, names: Iterable<string>) {
  const have = columns(table);
  for (const n of names) {
    if (have.has(n)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN "${n}" ${NUMERIC_COL.test(n) ? 'NUMERIC' : 'TEXT'}`);
    have.add(n);
  }
}
function cell(col: string, v: unknown): string | number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v).trim();
  if (s === '') return null;
  if (NUMERIC_COL.test(col) && /^-?[\d,]+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  return s;
}
function upsert(table: string, rows: Row[]) {
  if (!rows.length) return 0;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  ensureColumns(table, cols);
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(...cols.map((c) => cell(c, r[c])));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}
const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
function meta(table_name: string, m: { source: string; endpoint?: string; std_period?: string; status: string; note?: string }) {
  upsert('meta_source', [{ table_name, ...m, row_count: count(table_name), loaded_at: new Date().toISOString() }]);
}

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const snakeRow = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [snake(k), v]));

// ── http helpers ────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getText(url: string, tries = 4): Promise<string> {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`);
      return t;
    } catch (e) {
      last = e;
      await sleep(1500 * i);
    }
  }
  throw new Error(redact(`fetch failed: ${String(last)}`));
}
async function getJson(url: string): Promise<any> {
  const t = await getText(url);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(redact(`non-JSON: ${t.slice(0, 200)}`));
  }
}
async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}
const pages = (total: number, size: number) => Array.from({ length: Math.ceil(total / size) }, (_, i) => i + 1);

// Seoul Open API: /{KEY}/json/{SVC}/{start}/{end}/{filter...}, 1000 rows max per call.
async function seoulPage(svc: string, start: number, end: number, filter = '') {
  const j = await getJson(`http://openapi.seoul.go.kr:8088/${E.SEOUL_OPEN_API_KEY}/json/${svc}/${start}/${end}/${filter}`);
  const v: any = j[svc] ?? Object.values(j)[0];
  const code: string = v?.RESULT?.CODE ?? v?.CODE ?? '';
  if (code === 'INFO-200') return { total: 0, rows: [] as Row[] };
  if (code !== 'INFO-000') throw new Error(`${svc} ${code} ${v?.RESULT?.MESSAGE ?? v?.MESSAGE ?? ''}`);
  const rows = (v.row ?? []).map((r: Row) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k.toLowerCase(), x])));
  return { total: Number(v.list_total_count), rows: rows as Row[] };
}
async function seoulAll(svc: string, filter: string, onRows: (rows: Row[]) => void, conc = 4) {
  const first = await seoulPage(svc, 1, 1000, filter);
  onRows(first.rows);
  const rest = pages(first.total, 1000).slice(1);
  await pool(rest, conc, async (p) => onRows((await seoulPage(svc, (p - 1) * 1000 + 1, p * 1000, filter)).rows));
  return first.total;
}

// data.go.kr JSON shapes vary by provider; take the first array of objects and the first *totalCount*.
function findItems(j: unknown): Row[] {
  if (Array.isArray(j)) return j.length && typeof j[0] === 'object' && !Array.isArray(j[0]) && !('head' in (j[0] as object)) ? (j as Row[]) : j.flatMap(findItems);
  if (j && typeof j === 'object') {
    for (const v of Object.values(j)) {
      const f = findItems(v);
      if (f.length) return f;
    }
  }
  return [];
}
function findTotal(j: unknown): number {
  if (j && typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) {
      if (/^total_?count$/i.test(k)) return Number(v);
      const t = findTotal(v);
      if (t >= 0) return t;
    }
  }
  return -1;
}
function dataGoKrCheck(t: string) {
  if (/SERVICE_KEY|LIMITED_NUMBER|SERVICE ERROR|NO_OPENAPI|NOT_REGISTERED/.test(t)) throw new Error(t.slice(0, 200));
}
const xmlItems = (t: string): Row[] =>
  [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map((x) => [snake(x[1]), x[2].trim()])));
const xmlTotal = (t: string) => Number(t.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] ?? 0);

const DGK = E.DATA_GO_KR_SERVICE_KEY!;
const dgk = (path: string, q: Record<string, string>) => `https://apis.data.go.kr/${path}?${new URLSearchParams({ serviceKey: DGK, ...q })}`;

// ── steps ───────────────────────────────────────────────────
function lastQuarters(latest: string, n: number) {
  let y = Number(latest.slice(0, 4));
  let q = Number(latest.slice(4));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${q}`);
    if (--q === 0) [y, q] = [y - 1, 4];
  }
  return out;
}
function lastMonths(fromYm: string, n: number) {
  const d = new Date(Number(fromYm.slice(0, 4)), Number(fromYm.slice(4)) - 1, 1);
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}`;
  });
}
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

const steps: Record<string, () => Promise<void>> = {
  async trade_area_seoul() {
    const total = await seoulAll('TbgisTrdarRelm', '', (rows) =>
      upsert(
        'trade_area_seoul',
        rows.map((r) => {
          const [lon, lat] = toWgs('EPSG:5181', Number(r.xcnts_value), Number(r.ydnts_value));
          return { ...r, lon, lat };
        }),
      ),
    );
    meta('trade_area_seoul', { source: '서울 상권영역', endpoint: 'TbgisTrdarRelm', std_period: 'current', status: 'loaded', note: `API total ${total}; 중심점만 제공(폴리곤 없음), XY=EPSG:5181→WGS84` });
  },

  async seoul_quarterly() {
    const qs = lastQuarters(LATEST_QUARTER, QUARTERS);
    const svcs: [string, string, string][] = [
      ['ta_sales_q', 'VwsmTrdarSelngQq', '상권-추정매출'],
      ['ta_store_q', 'VwsmTrdarStorQq', '상권-점포'],
      ['ta_flpop_q', 'VwsmTrdarFlpopQq', '상권-길단위인구'],
      ['ta_repop_q', 'VwsmTrdarRepopQq', '상권-상주인구'],
      ['ta_wrcpop_q', 'VwsmTrdarWrcPopltnQq', '상권-직장인구'],
    ];
    for (const [table, svc, label] of svcs) {
      const got: string[] = [];
      for (const q of qs) {
        try {
          const n = await seoulAll(svc, q, (rows) => upsert(table, rows));
          if (n) got.push(q);
          log(`  ${table} ${q}: ${n}`);
        } catch (e) {
          log(`  ${table} ${q}: ERR ${String(e)}`);
        }
      }
      // some services ignore the quarter filter and return the full history, so report what is actually stored
      const r = db.prepare(`SELECT min(stdr_yyqu_cd) a, max(stdr_yyqu_cd) b, count(DISTINCT stdr_yyqu_cd) n FROM ${table}`).get() as { a: string; b: string; n: number };
      meta(table, { source: `서울 상권분석 ${label}`, endpoint: svc, std_period: r.n ? `${r.a}~${r.b}` : '-', status: got.length === qs.length ? 'loaded' : got.length ? 'partial' : 'failed', note: `분기 ${r.n}개 보유 (요청 ${qs.length})` });
    }
    // industry_svc from the facts
    db.exec(`INSERT OR REPLACE INTO industry_svc (svc_induty_cd, svc_induty_cd_nm)
             SELECT svc_induty_cd, max(svc_induty_cd_nm) FROM (SELECT svc_induty_cd, svc_induty_cd_nm FROM ta_sales_q UNION ALL SELECT svc_induty_cd, svc_induty_cd_nm FROM ta_store_q)
             WHERE svc_induty_cd IS NOT NULL GROUP BY svc_induty_cd`);
    meta('industry_svc', { source: '서울 상권분석 서비스업종 (ta_* 에서 도출)', status: 'loaded' });
  },

  async living_pop() {
    const first = await seoulPage('SPOP_LOCAL_RESD_DONG', 1, 1);
    const latest = String(first.rows[0]?.stdr_de_id ?? '');
    const d0 = new Date(Number(latest.slice(0, 4)), Number(latest.slice(4, 6)) - 1, Number(latest.slice(6)));
    const days = Array.from({ length: 7 }, (_, i) => ymd(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i)));
    const got: string[] = [];
    for (const d of days) {
      const n = await seoulAll('SPOP_LOCAL_RESD_DONG', d, (rows) =>
        upsert('living_pop_dong_h', rows.map(({ adstrng_code_se, ...r }) => ({ ...r, adstrd_code_se: adstrng_code_se ?? r.adstrd_code_se }))),
      );
      log(`  living_pop ${d}: ${n}`);
      if (n) got.push(d);
    }
    if (!got.length) {
      // date filter not honoured → keep the first 20 pages as a recent sample
      await pool(pages(20000, 1000), 4, async (p) => {
        const { rows } = await seoulPage('SPOP_LOCAL_RESD_DONG', (p - 1) * 1000 + 1, p * 1000);
        upsert('living_pop_dong_h', rows.map(({ adstrng_code_se, ...r }) => ({ ...r, adstrd_code_se: adstrng_code_se ?? r.adstrd_code_se })));
      });
    }
    const range = db.prepare('SELECT min(stdr_de_id) a, max(stdr_de_id) b FROM living_pop_dong_h').get() as { a: string; b: string };
    meta('living_pop_dong_h', { source: '서울 생활인구(내국인) 행정동', endpoint: 'SPOP_LOCAL_RESD_DONG', std_period: `${range.a}~${range.b}`, status: got.length ? 'loaded' : 'partial', note: got.length ? `최근 ${got.length}일` : '날짜 필터 미지원 → 앞 20,000행 샘플' });
  },

  async subway() {
    const today = new Date();
    const got: string[] = [];
    for (let i = 1; i <= 60 && got.length < 31; i++) {
      const d = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
      const n = await seoulAll('CardSubwayStatsNew', d, (rows) => upsert('subway_daily', rows));
      if (n) got.push(d);
    }
    meta('subway_daily', { source: '서울 지하철 역별 일별 승하차', endpoint: 'CardSubwayStatsNew', std_period: got.length ? `${got.at(-1)}~${got[0]}` : '-', status: got.length ? 'loaded' : 'failed', note: `${got.length}일` });

    const ym = ymd(today).slice(0, 6);
    const months: string[] = [];
    let sample = '';
    for (const m of lastMonths(ym, 15)) {
      if (months.length >= 12) break;
      const n = await seoulAll('CardSubwayTime', m, (rows) => {
        if (!sample && rows[0]) sample = Object.keys(rows[0]).join(',');
        const melted: Row[] = [];
        for (const r of rows) {
          const line = r.sbwy_rout_ln_nm ?? r.line_num;
          const station = r.sttn ?? r.sub_sta_nm ?? r.sbwy_stns_nm;
          const hours = new Map<number, Row>();
          for (const [k, v] of Object.entries(r)) {
            const mm = k.match(/^hr_(\d+)_get_(on|off)_(?:nope|num)$/);
            if (!mm) continue;
            const h = Number(mm[1]);
            const o = hours.get(h) ?? { use_mm: r.use_mm ?? m, line_nm: line, station_nm: station, hr: h };
            o[mm[2] === 'on' ? 'ride' : 'alight'] = v;
            hours.set(h, o);
          }
          melted.push(...hours.values());
        }
        upsert('subway_hourly_m', melted);
      });
      if (n) months.push(m);
    }
    if (!count('subway_hourly_m')) log(`  CardSubwayTime fields: ${sample}`);
    meta('subway_hourly_m', { source: '서울 지하철 호선별 역별 시간대별 승하차', endpoint: 'CardSubwayTime', std_period: months.length ? `${months.at(-1)}~${months[0]}` : '-', status: count('subway_hourly_m') ? 'loaded' : 'failed', note: `${months.length}개월, 시간대 열 → 행 변환` });
  },

  async views_and_pending() {
    db.exec(`
      DROP VIEW IF EXISTS v_store_cnt_adm_mcls;
      CREATE VIEW v_store_cnt_adm_mcls AS
        SELECT substr(adong_cd,1,8) adm_cd, max(adong_nm) adm_nm, max(signgu_nm) sgg_nm, inds_mcls_cd, max(inds_mcls_nm) inds_mcls_nm, count(*) store_cnt
        FROM store GROUP BY 1, inds_mcls_cd;

      DROP VIEW IF EXISTS v_ta_competition_latest;
      CREATE VIEW v_ta_competition_latest AS
        WITH lq AS (SELECT max(stdr_yyqu_cd) q FROM ta_store_q)
        SELECT s.stdr_yyqu_cd, s.trdar_cd, a.trdar_cd_nm, a.trdar_se_cd_nm, a.adstrd_cd_nm, a.lon, a.lat,
               s.svc_induty_cd, s.svc_induty_cd_nm, s.stor_co, s.similr_induty_stor_co, s.frc_stor_co, s.opbiz_rt, s.clsbiz_rt,
               m.thsmon_selng_amt, m.thsmon_selng_co,
               CASE WHEN s.similr_induty_stor_co > 0 THEN m.thsmon_selng_amt / s.similr_induty_stor_co END sales_per_store,
               f.tot_flpop_co
        FROM ta_store_q s JOIN lq ON s.stdr_yyqu_cd = lq.q
        LEFT JOIN ta_sales_q m ON m.stdr_yyqu_cd = s.stdr_yyqu_cd AND m.trdar_cd = s.trdar_cd AND m.svc_induty_cd = s.svc_induty_cd
        LEFT JOIN ta_flpop_q f ON f.stdr_yyqu_cd = s.stdr_yyqu_cd AND f.trdar_cd = s.trdar_cd
        LEFT JOIN trade_area_seoul a ON a.trdar_cd = s.trdar_cd;

      DROP VIEW IF EXISTS v_ta_sales_trend;
      CREATE VIEW v_ta_sales_trend AS
        SELECT c.trdar_cd, c.svc_induty_cd, c.svc_induty_cd_nm, c.stdr_yyqu_cd, c.thsmon_selng_amt, p.thsmon_selng_amt prev_year_amt,
               CASE WHEN p.thsmon_selng_amt > 0 THEN round(100.0 * (c.thsmon_selng_amt - p.thsmon_selng_amt) / p.thsmon_selng_amt, 1) END yoy_pct
        FROM ta_sales_q c LEFT JOIN ta_sales_q p
          ON p.trdar_cd = c.trdar_cd AND p.svc_induty_cd = c.svc_induty_cd AND CAST(p.stdr_yyqu_cd AS INTEGER) = CAST(c.stdr_yyqu_cd AS INTEGER) - 10;

      DROP VIEW IF EXISTS v_food_license_flow_y;
      CREATE VIEW v_food_license_flow_y AS
        SELECT sgg_nm, yr, sum(opened) opened, sum(closed) closed FROM (
          SELECT sgg_nm, substr(apv_perm_ymd,1,4) yr, 1 opened, 0 closed FROM license_event WHERE apv_perm_ymd IS NOT NULL
          UNION ALL SELECT sgg_nm, substr(dcb_ymd,1,4), 0, 1 FROM license_event WHERE dcb_ymd IS NOT NULL
        ) GROUP BY sgg_nm, yr;
    `);
    const pending: [string, string, string][] = [
      ['parcel', '브이월드 연속지적·공시지가·토지특성', '대량 파일(SHP/CSV) 적재 예정 — API는 건별 조회만 사용'],
      ['building', 'GIS건물통합정보·건축물대장', '대량 파일 적재 예정 — 건축HUB API는 건별'],
      ['grid_100m', '국토지리정보원 국가표준격자 100m', '격자 SHP 적재 예정'],
      ['industry_map', '업종 크로스워크(상가정보↔서울↔공정위↔KSIC)', '수작업·규칙 기반 매핑 필요'],
      ['store_card_sales_m', '기존 DW 신한·KB 카드매출', 'DW 이관·재계약 결정 후'],
    ];
    for (const [t, source, note] of pending) if (!count(t)) meta(t, { source, status: 'pending', note });
  },
};

// ── run ─────────────────────────────────────────────────────
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]?.split(',');
const only = arg('only');
const skip = arg('skip') ?? [];
const order = ['trade_area_seoul', 'seoul_quarterly', 'living_pop', 'subway', 'views_and_pending'];
const t0 = Date.now();
for (const name of order) {
  if ((only && !only.includes(name)) || skip.includes(name)) continue;
  const t = Date.now();
  log(`▶ ${name}`);
  try {
    await steps[name]();
    log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  } catch (e) {
    log(`✘ ${name}: ${String(e).slice(0, 300)}`);
    try {
      upsert('meta_source', [{ table_name: `step:${name}`, source: name, status: 'failed', note: redact(String(e)).slice(0, 300), loaded_at: new Date().toISOString() }]);
    } catch {
      // ignore
    }
  }
}
db.exec('PRAGMA optimize');
for (const r of db.prepare('SELECT table_name, status, row_count, std_period FROM meta_source ORDER BY table_name').all() as Row[])
  log(`  ${String(r.table_name).padEnd(22)} ${String(r.status).padEnd(8)} ${String(r.row_count ?? '').padStart(9)}  ${r.std_period ?? ''}`);
log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min → ${DB_PATH}`);
db.close();
