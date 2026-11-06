// KCB 소상공인 통계 (사내 S3 cla-raw-data/kcb_soho, Parquet) → data/internal.sqlite kcb_soho_m.
// 법정동(8자리) × 표준산업 대분류(1글자) × 월: 사업자 수·신규·폐업, 평균 사업소득, 업력, 대출·연체, 카드 이용.
// -1은 소수 집계를 가린 값으로 보고 비운다.
//
//   npx tsx etl/kcb-soho.ts
import { readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'kcb_soho');
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`DROP TABLE IF EXISTS kcb_soho_m;
CREATE TABLE kcb_soho_m (
  ym TEXT, dong8 TEXT, sic TEXT, biz_cnt NUMERIC, biz_close_cnt NUMERIC, biz_new_cnt NUMERIC, avg_biz_income NUMERIC, avg_biz_age NUMERIC,
  biz_dlq_cnt NUMERIC, biz_cd_dlq_cnt NUMERIC, avg_cd_use_amt NUMERIC, avg_biz_use_amt NUMERIC, sum_biz_ln_amt NUMERIC,
  PRIMARY KEY (ym, dong8, sic));`);

const KEEP = ['biz_cnt', 'biz_close_cnt', 'biz_new_cnt', 'avg_biz_income', 'avg_biz_age', 'biz_dlq_cnt', 'biz_cd_dlq_cnt', 'avg_cd_use_amt', 'avg_biz_use_amt', 'sum_biz_ln_amt'];
const val = (v: unknown) => {
  const n = typeof v === 'bigint' ? Number(v) : v == null ? null : Number(v);
  return n == null || !Number.isFinite(n) || n < 0 ? null : n;
};
let total = 0;
for (const d of readdirSync(SRC).filter((x) => statSync(join(SRC, x)).isDirectory()).sort()) {
  const f = join(SRC, d, 'data.parquet');
  const file = await asyncBufferFromFile(f);
  const rows = await parquetReadObjects({ file, metadata: await parquetMetadataAsync(file), compressors });
  total += upsert('kcb_soho_m', rows.map((x): Row => ({
    ym: String(x.base_dt).slice(0, 7).replace('-', ''), dong8: String(x.lgl_dong_cd), sic: String(x.sic_cd_fst),
    ...Object.fromEntries(KEEP.map((k) => [k, val(x[k])])),
  })));
}
const s = db.prepare('SELECT count(*) n, count(DISTINCT dong8) d, min(ym) a, max(ym) b FROM kcb_soho_m').get() as { n: number; d: number; a: string; b: string };
log(`kcb_soho_m ${s.n.toLocaleString()}행 · 법정동 ${s.d.toLocaleString()} · ${s.a}~${s.b}`);
meta('kcb_soho_m', { source: 'KCB 소상공인 통계 (사내 S3 cla-raw-data/kcb_soho)', endpoint: 'Parquet', std_period: `${s.a}~${s.b}`, status: 'loaded', note: '사내 데이터. 법정동 × 업종 대분류 × 월' });
db.close();
