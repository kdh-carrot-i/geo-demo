// 건축물대장 층별개요(사내 S3 bld_flr_info, 2025-06) → data/internal.sqlite bld_flr: 필지(PNU)·층별 면적과 주용도.
// 매장 면적이 인허가에 없는 업종(편의점 등)의 크기를 "같은 층 면적 ÷ 같은 층 가게 수"로 어림하는 데 쓴다.
//   npx tsx etl/s3.ts get bld_flr_info/ 'base_dt=2025-06-01' && npx tsx etl/bld-flr.ts
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'bld_flr_info', 'base_dt=2025-06-01');
const compressors = { GZIP: (i: Uint8Array) => { const o = gunzipSync(i); return new Uint8Array(o.buffer, o.byteOffset, o.length); } };
const COLS = ['sigungu_cd', 'bjdong_cd', 'plat_gb_cd', 'bun', 'ji', 'flr_gb_cd', 'flr_no', 'main_purps_cd_nm', 'tot_area'];
const CHUNK = 500_000;

const agg = new Map<string, { area: number; n: number; use: Map<string, number> }>();
for (const d of readdirSync(SRC).sort()) {
  const f = resolve(SRC, d, 'data.parquet');
  if (!statSync(f, { throwIfNoEntry: false })) continue;
  const file = await asyncBufferFromFile(f);
  const rows = Number((await parquetMetadataAsync(file)).num_rows);
  for (let s = 0; s < rows; s += CHUNK) {
    const r = (await parquetReadObjects({ file, columns: COLS, rowStart: s, rowEnd: Math.min(s + CHUNK, rows), compressors })) as Record<string, unknown>[];
    for (const x of r) {
      const area = Number(x.tot_area);
      if (!(area > 0) || !x.sigungu_cd || !x.bun) continue;
      const pnu = `${x.sigungu_cd}${x.bjdong_cd}${x.plat_gb_cd === '1' ? '2' : '1'}${String(x.bun).padStart(4, '0')}${String(x.ji ?? '0').padStart(4, '0')}`;
      if (!/^\d{19}$/.test(pnu)) continue;
      const fl = (x.flr_gb_cd === '10' ? -1 : 1) * Number(x.flr_no ?? 0);
      const k = `${pnu}|${fl}`;
      let a = agg.get(k);
      if (!a) agg.set(k, (a = { area: 0, n: 0, use: new Map() }));
      a.area += area;
      a.n += 1;
      const u = String(x.main_purps_cd_nm ?? '');
      a.use.set(u, (a.use.get(u) ?? 0) + area);
    }
  }
  log(`${d} ${rows.toLocaleString()}행 · 누적 ${agg.size.toLocaleString()}칸`);
}
const db = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec('PRAGMA busy_timeout = 1800000');
db.exec('DROP TABLE IF EXISTS bld_flr; CREATE TABLE bld_flr (pnu TEXT, floor INTEGER, area REAL, units INTEGER, main_use TEXT, PRIMARY KEY (pnu, floor))');
const ins = db.prepare('INSERT INTO bld_flr VALUES (?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (const [k, a] of agg) {
  const [pnu, fl] = k.split('|');
  const use = [...a.use].sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;
  ins.run(pnu, Number(fl), Math.round(a.area * 10) / 10, a.n, use);
}
db.exec('COMMIT');
log(`bld_flr ${agg.size.toLocaleString()}행`);
