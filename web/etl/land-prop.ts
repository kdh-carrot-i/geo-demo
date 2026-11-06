// 토지특성 (사내 S3 cla-raw-data/land_prop_info) → data/internal.sqlite land_pnu.
// 필지마다 도로 접면(광대로·중로·소로·세로 × 한면·각지), 용도지역, 지형 높이·모양, 대지면적, 공시지가.
// 매출 모델의 "자리의 미세한 조건" (대로변·코너). 시도마다 가장 최근 시점 하나를 쓴다
// (2024-07-30에 경북 외 16개 시도, 2024-08-02에 경북).
//
//   npx tsx etl/land-prop.ts
import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'land_prop_info');
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };

// 시도별 가장 최근 시점
const latest = new Map<string, string>();
for (const d of readdirSync(SRC).filter((x) => x.startsWith('base_dt=')).sort()) {
  for (const s of readdirSync(join(SRC, d))) {
    const sido = /sido_cd=(\d+)/.exec(s)?.[1];
    if (sido) latest.set(sido, join(SRC, d, s, 'data.parquet'));
  }
}

/** "광대소각" "중로한면" "세로(가)" "맹지" → 도로 등급·코너 여부 */
function road(nm: string): { road_class: string | null; corner: number | null } {
  const s = nm.replace(/\s/g, '');
  if (!s) return { road_class: null, corner: null };
  const road_class = /광대/.test(s) ? '광대로' : /중로/.test(s) ? '중로' : /소로/.test(s) ? '소로' : /세로/.test(s) ? '세로' : /맹지/.test(s) ? '맹지' : '기타';
  // 각지 = 두 도로 이상에 닿은 코너 필지 ("광대소각", "중로각지", "세각(가)")
  const corner = /각/.test(s) ? 1 : 0;
  return { road_class, corner };
}

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`DROP TABLE IF EXISTS land_pnu;
CREATE TABLE land_pnu (pnu TEXT PRIMARY KEY, base_dt TEXT, road_fig TEXT, road_class TEXT, corner INTEGER, use_zone TEXT, land_use TEXT,
  land_height TEXT, land_fig TEXT, plottage REAL, price NUMERIC);`);
const COLS = ['base_dt', 'pnu', 'plottage', 'one_main_purps_nm', 'land_use_nm', 'land_height_nm', 'land_fig_nm', 'road_fig_nm', 'land_deal_amount'];
let total = 0;
for (const [sido, f] of [...latest].sort()) {
  const file = await asyncBufferFromFile(f);
  const md = await parquetMetadataAsync(file);
  const n = Number(md.num_rows);
  for (let start = 0; start < n; start += 300000) {
    const rows = await parquetReadObjects({ file, metadata: md, columns: COLS, rowStart: start, rowEnd: Math.min(n, start + 300000), compressors });
    total += upsert('land_pnu', rows.flatMap((x): Row[] => {
      const pnu = String(x.pnu ?? '');
      if (!/^\d{19}$/.test(pnu)) return [];
      const rf = String(x.road_fig_nm ?? '').trim();
      return [{
        pnu, base_dt: x.base_dt, road_fig: rf || null, ...road(rf), use_zone: x.one_main_purps_nm ?? null, land_use: x.land_use_nm ?? null,
        land_height: x.land_height_nm ?? null, land_fig: x.land_fig_nm ?? null, plottage: Number(x.plottage) || null, price: Number(x.land_deal_amount) || null,
      }];
    }));
  }
  log(`시도 ${sido}: ${n.toLocaleString()}필지 (${f.split('base_dt=')[1].slice(0, 10)})`);
}
const top = db.prepare('select road_fig, count(*) n from land_pnu group by 1 order by 2 desc limit 15').all() as { road_fig: string; n: number }[];
log(`land_pnu ${total.toLocaleString()} · 도로 접면: ${top.map((r) => `${r.road_fig}:${r.n}`).join(' ')}`);
meta('land_pnu', { source: '토지특성 (사내 S3 land_prop_info)', endpoint: 'Parquet', std_period: '2024-07/08', status: 'loaded', note: '도로 접면·용도지역·지형·공시지가' });
db.close();
