// Shared ETL helpers: SQLite upsert with auto-added columns, throttled + budgeted HTTP per host, raw (lake) capture, key redaction.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import proj4 from 'proj4';

export const WEB_ROOT = resolve(import.meta.dirname, '..');
export const DATA_DIR = resolve(WEB_ROOT, '..', 'data');
try {
  process.loadEnvFile(resolve(WEB_ROOT, '.env'));
} catch {
  // real env
}
export const E = process.env;
const secrets = [E.SEOUL_OPEN_API_KEY, E.DATA_GO_KR_SERVICE_KEY, E.R_ONE_KEY, E.SGIS_SERVICE_ID, E.SGIS_SECRET_KEY, E.VWORLD_KEY, E.KAKAO_REST_KEY, E.GG_OPEN_API_KEY].filter(Boolean) as string[];
export const redact = (s: string) => secrets.reduce((a, k) => a.split(k).join('***').split(encodeURIComponent(k)).join('***'), s);
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), redact(a.map(String).join(' ')));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

proj4.defs('EPSG:5181', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:5174', '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43');
export const toWgs = (crs: string, x: number, y: number): [number, number] | [null, null] =>
  Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0 ? (proj4(crs, 'EPSG:4326', [x, y]) as [number, number]) : [null, null];

// ── db ──────────────────────────────────────────────────────
export type Row = Record<string, unknown>;
const NUMERIC_COL = /(_co|_amt|_cnt|_rt|_ar|_area|amount|_val|ppltn|_per|_idx|dnsty|family|house|worker|_nope|tnope|_age|price|^lon|^lat|^hr)$/;

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // several loaders (and the API server, read-only) may use the DB at once: wait for locks instead of failing
  db.exec('PRAGMA busy_timeout = 120000');
  db.exec(readFileSync(resolve(import.meta.dirname, 'schema.sql'), 'utf8'));
  const colCache = new Map<string, Set<string>>();
  const columns = (table: string) => {
    let s = colCache.get(table);
    if (!s) {
      s = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      colCache.set(table, s);
    }
    return s;
  };
  const cell = (col: string, v: unknown): string | number | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v).trim();
    if (s === '') return null;
    if (NUMERIC_COL.test(col) && /^-?[\d,]+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
    return s;
  };
  const upsert = (table: string, rows: Row[]) => {
    if (!rows.length) return 0;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const have = columns(table);
    for (const n of cols) {
      if (have.has(n)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN "${n}" ${NUMERIC_COL.test(n) ? 'NUMERIC' : 'TEXT'}`);
      have.add(n);
    }
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
  };
  const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const meta = (table_name: string, m: { source: string; endpoint?: string; std_period?: string; status: string; note?: string }) =>
    upsert('meta_source', [{ table_name, ...m, row_count: count(table_name), loaded_at: new Date().toISOString() }]);
  return { db, upsert, count, meta, dropCache: (t: string) => colCache.delete(t) };
}

// ── http: per-host throttle + call budget + raw capture ─────
export class BudgetExceeded extends Error {}
interface HostPolicy {
  minIntervalMs: number;
  budget: number;
}
const policies: Record<string, HostPolicy> = {
  // 운영계정이면 INTERVAL_DATA_GO_KR 을 낮춰 빠르게 받는다 (기본 0.9초 간격은 개발계정 기준)
  'apis.data.go.kr': { minIntervalMs: Number(E.INTERVAL_DATA_GO_KR ?? 900), budget: Number(E.BUDGET_DATA_GO_KR ?? 1200) },
  'www.reb.or.kr': { minIntervalMs: 300, budget: Number(E.BUDGET_RONE ?? 600) },
  'sgisapi.mods.go.kr': { minIntervalMs: 200, budget: 200 },
  'api.vworld.kr': { minIntervalMs: 500, budget: 10 },
  'openapi.seoul.go.kr': { minIntervalMs: 100, budget: 2000 },
  'dapi.kakao.com': { minIntervalMs: 150, budget: Number(E.BUDGET_KAKAO ?? 3000) },
};
const hostState = new Map<string, { last: number; used: number; chain: Promise<void> }>();
export const callStats = () => Object.fromEntries([...hostState].map(([h, s]) => [h, s.used]));

async function slot(host: string) {
  const p = policies[host] ?? { minIntervalMs: 0, budget: Infinity };
  const s = hostState.get(host) ?? { last: 0, used: 0, chain: Promise.resolve() };
  hostState.set(host, s);
  const turn = s.chain.then(async () => {
    if (s.used >= p.budget) throw new BudgetExceeded(`${host} budget ${p.budget} reached`);
    const wait = s.last + p.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    s.last = Date.now();
    s.used++;
  });
  s.chain = turn.catch(() => undefined);
  return turn;
}

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
/** Save a response body under data/lake/raw/{source}/{yyyymmdd}/{name}.gz — the lake's immutable bronze layer. */
export function saveRaw(source: string, name: string, body: string) {
  const p = resolve(DATA_DIR, 'lake', 'raw', source, today, `${name.replace(/[^\w.-]+/g, '_')}.gz`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, gzipSync(body));
}

export async function getText(url: string, opts: { raw?: [string, string]; tries?: number; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
  const host = new URL(url).host.split(':')[0];
  let last: unknown;
  for (let i = 1; i <= (opts.tries ?? 4); i++) {
    await slot(host);
    try {
      const r = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(60000) });
      const text = await r.text();
      if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
      if (opts.raw) saveRaw(opts.raw[0], opts.raw[1], text);
      return { status: r.status, text };
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      last = e;
      await sleep(2000 * i);
    }
  }
  throw new Error(redact(`fetch failed: ${String(last)}`));
}
export async function getJson(url: string, raw?: [string, string], headers?: Record<string, string>): Promise<any> {
  const { text } = await getText(url, { raw, headers });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(redact(`non-JSON: ${text.slice(0, 200)}`));
  }
}

// ── response shapes ─────────────────────────────────────────
export const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const snakeRow = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [snake(k), v]));
export const lowerRow = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));

/** data.go.kr JSON shapes vary by provider; take the first array of objects. */
export function findItems(j: unknown): Row[] {
  if (Array.isArray(j)) return j.length && typeof j[0] === 'object' && !Array.isArray(j[0]) && !('head' in (j[0] as object)) ? (j as Row[]) : j.flatMap(findItems);
  if (j && typeof j === 'object') {
    for (const v of Object.values(j)) {
      const f = findItems(v);
      if (f.length) return f;
    }
  }
  return [];
}
export function findTotal(j: unknown): number {
  if (j && typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) {
      if (/^(total_?count|list_total_count)$/i.test(k)) return Number(v);
      const t = findTotal(v);
      if (t >= 0) return t;
    }
  }
  return -1;
}
export function dataGoKrError(t: string): string | null {
  const m = t.match(/<(returnAuthMsg|errMsg)>([^<]+)</)?.[2];
  if (m || /SERVICE_KEY|LIMITED_NUMBER|SERVICE ERROR|NO_OPENAPI|NOT_REGISTERED/.test(t)) return m ?? t.slice(0, 160);
  return null;
}
export const xmlItems = (t: string): Row[] =>
  [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map((x) => [snake(x[1]), x[2].trim()])));
export const xmlTotal = (t: string) => Number(t.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] ?? -1);

export const dgk = (path: string, q: Record<string, string>) => `https://apis.data.go.kr/${path}?${new URLSearchParams({ serviceKey: E.DATA_GO_KR_SERVICE_KEY!, ...q })}`;
export const pages = (total: number, size: number) => Array.from({ length: Math.max(0, Math.ceil(total / size)) }, (_, i) => i + 1);
