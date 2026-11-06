// 건축물대장 표제부 (사내 S3 cla-raw-data/k7_building_register, 최신 base_dt 청크들) → data/internal.sqlite bld_pnu.
// 필지(PNU)마다 건물 조건으로 요약: 동 수, 연면적 합·최대, 대표 주용도, 가장 이른/늦은 사용승인 연도, 주차대수, 세대수.
// 매출 모델의 "자리의 조건" 변수 (건물 규모·연식·용도). 총괄표제부는 빼고 표제부만 센다.
//
//   npx tsx etl/bld-title.ts
import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'k7_building_register');
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };
// 콘솔 다운로드가 중간에 끊긴 달이 있다: 청크가 가장 많은(=다 받은) 달 중 가장 최근 달을 쓴다
const dirs = readdirSync(SRC).filter((d) => d.startsWith('base_dt=')).map((d) => ({ d, n: readdirSync(join(SRC, d)).filter((f) => f.endsWith('.parquet')).length }));
const full = Math.max(...dirs.map((x) => x.n));
const latest = dirs.filter((x) => x.n === full).map((x) => x.d).sort().at(-1)!;
const files = readdirSync(join(SRC, latest)).filter((f) => f.endsWith('.parquet')).map((f) => join(SRC, latest, f));
log(`${latest}: 청크 ${files.length}개`);

type Acc = { n: number; area: number; maxArea: number; uses: Map<string, number>; first: number; last: number; park: number; hh: number };
const acc = new Map<string, Acc>();
const COLS = ['TY_CD', 'DOC_KND_CD_NM', 'BULD_TT_AREA', 'BULD_USP_DV_NM', 'APR_YMD', 'PRK_PSS_CNT', 'HSHD_CNT', 'PNU_CD'];
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
let rows = 0;
for (const f of files) {
  const file = await asyncBufferFromFile(f);
  const md = await parquetMetadataAsync(file);
  const total = Number(md.num_rows);
  for (let start = 0; start < total; start += 250000) {
    for (const r of await parquetReadObjects({ file, metadata: md, columns: COLS, rowStart: start, rowEnd: Math.min(total, start + 250000), compressors })) {
      rows++;
      if (String(r.DOC_KND_CD_NM ?? '').includes('총괄')) continue;
      const pnu = String(r.PNU_CD ?? '');
      if (!/^\d{19}$/.test(pnu)) continue;
      const a = acc.get(pnu) ?? { n: 0, area: 0, maxArea: 0, uses: new Map(), first: 9999, last: 0, park: 0, hh: 0 };
      const area = num(r.BULD_TT_AREA);
      a.n++;
      a.area += area;
      a.maxArea = Math.max(a.maxArea, area);
      const use = String(r.BULD_USP_DV_NM ?? '').trim();
      if (use) a.uses.set(use, (a.uses.get(use) ?? 0) + area + 1);
      const y = Number(String(r.APR_YMD ?? '').slice(0, 4));
      if (y > 1900 && y < 2100) (a.first = Math.min(a.first, y)), (a.last = Math.max(a.last, y));
      a.park += num(r.PRK_PSS_CNT);
      a.hh += num(r.HSHD_CNT);
      acc.set(pnu, a);
    }
  }
}
log(`표제부 ${rows.toLocaleString()}행 → 필지 ${acc.size.toLocaleString()}`);

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`DROP TABLE IF EXISTS bld_pnu;
CREATE TABLE bld_pnu (pnu TEXT PRIMARY KEY, buildings INTEGER, tot_area REAL, max_area REAL, main_use TEXT, first_year INTEGER, last_year INTEGER, parking INTEGER, households INTEGER);`);
const out: Row[] = [];
for (const [pnu, a] of acc) {
  out.push({
    pnu, buildings: a.n, tot_area: Math.round(a.area), max_area: Math.round(a.maxArea),
    main_use: [...a.uses].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
    first_year: a.first === 9999 ? null : a.first, last_year: a.last || null, parking: a.park, households: a.hh,
  });
  if (out.length >= 100000) upsert('bld_pnu', out.splice(0));
}
upsert('bld_pnu', out);
meta('bld_pnu', { source: '건축물대장 표제부 (사내 S3 k7_building_register)', endpoint: 'Parquet', std_period: latest.replace('base_dt=', ''), status: 'loaded', note: '필지별 건물 조건 요약' });
log(`bld_pnu ${acc.size.toLocaleString()} 필지`);
db.close();
