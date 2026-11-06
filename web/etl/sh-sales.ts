// 신한카드 가맹점 월 추정매출 (사내 S3 cla-raw-data/sh_bldg_sales, Parquet GZIP) → data/internal.sqlite sh_sales_m.
// pred_slng_amt는 매장 총매출이 아니라 신한카드 결제 규모다 (같은 매장 KB 매출의 약 0.82배, 2025-04 vs 2025-09 104만 곳 비교).
// 2021-01부터라 매장별 월 추이(다음 달 매출)와 KB와 합친 매출 정답에 쓴다.
// 사업자등록번호(biz_reg_no)는 읽지 않는다. 매장 구분: 신한 가맹점 번호(mct_n), KB와 잇는 키는 PNU + 정규화 상호(store_key).
//
//   npx tsx etl/sh-sales.ts            받은 달은 건너뛴다
import { readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'sh_bldg_sales');
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS sh_sales_m (
  ym TEXT, mct_n TEXT, store_key TEXT, name TEXT, pnu TEXT, ind TEXT, amt NUMERIC, cnt NUMERIC,
  sh_weekend REAL, sh_lunch REAL, sh_evening REAL, sh_2030 REAL, sh_local REAL,
  PRIMARY KEY (ym, mct_n));
CREATE INDEX IF NOT EXISTS ix_shm_key ON sh_sales_m (store_key);
CREATE INDEX IF NOT EXISTS ix_shm_mct ON sh_sales_m (mct_n);`);

const COLS = ['base_dt', 'mct_n', 'mct_nm', 'pnu', 'mct_ry_nm', 'pred_slng_amt', 'est_cnt', 'we_rt', 'time_1114_rt', 'time_1819_rt', 'time_2021_rt',
  'f20_rt', 'f30_rt', 'm20_rt', 'm30_rt', 'local_rt'];
const normName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0)) || 0;
const pct = (v: unknown) => (v == null ? null : Math.round(num(v) * 10) / 1000); // 0~100 → 0~1

function toRow(x: Record<string, unknown>): Row | null {
  const pnu = String(x.pnu ?? '');
  const name = String(x.mct_nm ?? '').trim();
  if (!x.mct_n || !/^\d{19}$/.test(pnu)) return null;
  return {
    ym: String(x.base_dt).slice(0, 7).replace('-', ''), mct_n: String(x.mct_n), store_key: `${pnu}|${normName(name)}`, name, pnu,
    ind: x.mct_ry_nm ?? null, amt: num(x.pred_slng_amt), cnt: num(x.est_cnt),
    sh_weekend: pct(x.we_rt), sh_lunch: pct(x.time_1114_rt), sh_evening: x.time_1819_rt == null ? null : pct(num(x.time_1819_rt) + num(x.time_2021_rt)),
    sh_2030: x.f20_rt == null ? null : pct(num(x.f20_rt) + num(x.f30_rt) + num(x.m20_rt) + num(x.m30_rt)), sh_local: pct(x.local_rt),
  };
}

const files = readdirSync(SRC)
  .filter((d) => statSync(join(SRC, d)).isDirectory())
  .flatMap((d) => readdirSync(join(SRC, d)).filter((f) => f.endsWith('.parquet')).map((f) => join(SRC, d, f)))
  .sort();
const have = new Set((db.prepare('SELECT DISTINCT ym FROM sh_sales_m').all() as { ym: string }[]).map((r) => r.ym));
const BATCH = 200000;
for (const f of files) {
  const ym = /base_dt=(\d{4})-(\d{2})/.exec(f)!.slice(1).join('');
  if (have.has(ym)) continue;
  const file = await asyncBufferFromFile(f);
  const md = await parquetMetadataAsync(file);
  const total = Number(md.num_rows);
  let kept = 0;
  for (let start = 0; start < total; start += BATCH) {
    const objs = await parquetReadObjects({ file, metadata: md, columns: COLS, rowStart: start, rowEnd: Math.min(total, start + BATCH), compressors });
    kept += upsert('sh_sales_m', objs.map(toRow).filter((r): r is Row => r !== null));
  }
  log(`${ym}: ${total.toLocaleString()}행 중 ${kept.toLocaleString()} 적재`);
}

const s = db.prepare('SELECT count(*) n, count(DISTINCT mct_n) k, min(ym) a, max(ym) b FROM sh_sales_m').get() as { n: number; k: number; a: string; b: string };
log(`sh_sales_m ${s.n.toLocaleString()}행 · 가맹점 ${s.k.toLocaleString()} · ${s.a}~${s.b}`);
meta('sh_sales_m', {
  source: '신한카드 가맹점 월 추정매출 (사내 S3 cla-raw-data/sh_bldg_sales)', endpoint: 'Parquet', std_period: `${s.a}~${s.b}`, status: 'loaded',
  note: '사내 데이터. 신한카드 결제 규모(총매출 아님). 사업자등록번호 미저장',
});
db.close();
