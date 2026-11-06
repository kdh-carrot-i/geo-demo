// 격자 유동인구 (사내 S3 cla-raw-data/walk_pop, 월 × 시도 Parquet) → data/internal.sqlite walk_pop_cell.
// 받은 범위: 전국 17개 시도 2021-01 ~ 2023-04(일부 06). 칸(cell_id)마다 마지막 12개월 평균으로 줄인다.
// 보행 인구(corc_walk_popl_cnt)·통신 기반 인구(corc_ntwk_popl_cnt)·상주인구, 시간대·연령 칸은 값이 있을 때만 평균.
//
//   npx tsx etl/walk-pop.ts
import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'walk_pop');
const MONTHS = 12;
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`DROP TABLE IF EXISTS walk_pop_cell;
CREATE TABLE walk_pop_cell (
  cell_id TEXT PRIMARY KEY, lon REAL, lat REAL, sido TEXT, adm_cd TEXT, emd_cd TEXT, months INTEGER, ym_from TEXT, ym_to TEXT,
  walk REAL, ntwk REAL, resd REAL, sh_male REAL, sh_u20 REAL, sh_20 REAL, sh_30 REAL, sh_40 REAL, sh_50 REAL,
  sh_0810 REAL, sh_1113 REAL, sh_1416 REAL, sh_1719 REAL, sh_2022 REAL);
CREATE INDEX ix_wpc_ll ON walk_pop_cell (lat, lon);`);

const VALS = ['corc_walk_popl_cnt', 'corc_ntwk_popl_cnt', 'resd_pop_cnt', 'walk_male_cnt', 'walk_u20_cnt', 'walk_20_cnt', 'walk_30_cnt', 'walk_40_cnt', 'walk_50_cnt',
  'tmzn_0810_cnt', 'tmzn_1113_cnt', 'tmzn_1416_cnt', 'tmzn_1719_cnt', 'tmzn_2022_cnt'] as const;
const COLS = ['cell_id', 'cell_xcrd', 'cell_ycrd', 'adng_cd', 'emd_cd', ...VALS];
const num = (v: unknown) => (v == null ? null : typeof v === 'bigint' ? Number(v) : Number(v));

// 시도별 받은 달 목록
const bySido = new Map<string, string[]>();
for (const d of readdirSync(SRC)) {
  const ym = /base_dt=(\d{4}-\d{2})/.exec(d)?.[1];
  if (!ym) continue;
  for (const s of readdirSync(join(SRC, d))) {
    const sido = /sido_cd=(\d+)/.exec(s)?.[1];
    if (sido) bySido.set(sido, [...(bySido.get(sido) ?? []), ym]);
  }
}

for (const [sido, yms] of [...bySido].sort()) {
  const use = yms.sort().slice(-MONTHS);
  type Acc = { lon: number; lat: number; adm: string; emd: string; n: number; sum: number[]; cnt: number[] };
  const acc = new Map<string, Acc>();
  for (const ym of use) {
    const f = join(SRC, `base_dt=${ym}-01`, `sido_cd=${sido}`, 'data.parquet');
    const file = await asyncBufferFromFile(f);
    const md = await parquetMetadataAsync(file);
    const total = Number(md.num_rows);
    for (let start = 0; start < total; start += 300000) {
      const rows = await parquetReadObjects({ file, metadata: md, columns: COLS, rowStart: start, rowEnd: Math.min(total, start + 300000), compressors });
      for (const r of rows) {
        const id = String(r.cell_id);
        let a = acc.get(id);
        if (!a) {
          a = { lon: num(r.cell_xcrd)!, lat: num(r.cell_ycrd)!, adm: String(r.adng_cd ?? ''), emd: String(r.emd_cd ?? ''), n: 0, sum: VALS.map(() => 0), cnt: VALS.map(() => 0) };
          acc.set(id, a);
        }
        a.n++;
        VALS.forEach((k, i) => {
          const v = num(r[k]);
          if (v != null && Number.isFinite(v)) (a.sum[i] += v), a.cnt[i]++;
        });
      }
    }
  }
  const mean = (a: Acc, i: number) => (a.cnt[i] ? a.sum[i] / a.cnt[i] : null);
  const rows: Row[] = [];
  for (const [id, a] of acc) {
    const walk = mean(a, 0);
    const share = (i: number) => {
      const v = mean(a, i);
      return v != null && walk ? Math.round((v / walk) * 1000) / 1000 : null;
    };
    rows.push({
      cell_id: id, lon: a.lon, lat: a.lat, sido, adm_cd: a.adm, emd_cd: a.emd, months: a.n, ym_from: use[0], ym_to: use.at(-1),
      walk: walk == null ? null : Math.round(walk * 10) / 10, ntwk: mean(a, 1), resd: mean(a, 2),
      sh_male: share(3), sh_u20: share(4), sh_20: share(5), sh_30: share(6), sh_40: share(7), sh_50: share(8),
      sh_0810: share(9), sh_1113: share(10), sh_1416: share(11), sh_1719: share(12), sh_2022: share(13),
    });
    if (rows.length >= 50000) upsert('walk_pop_cell', rows.splice(0));
  }
  upsert('walk_pop_cell', rows);
  log(`시도 ${sido}: ${use[0]}~${use.at(-1)} ${use.length}개월, 칸 ${acc.size.toLocaleString()}`);
}

const s = db.prepare('SELECT count(*) n, min(ym_from) a, max(ym_to) b FROM walk_pop_cell').get() as { n: number; a: string; b: string };
log(`walk_pop_cell ${s.n.toLocaleString()}칸 · ${s.a}~${s.b}`);
meta('walk_pop_cell', { source: '격자 유동인구 (사내 S3 cla-raw-data/walk_pop)', endpoint: 'Parquet', std_period: `${s.a}~${s.b}`, status: 'loaded', note: '사내 데이터. 칸별 마지막 12개월 평균' });
db.close();
