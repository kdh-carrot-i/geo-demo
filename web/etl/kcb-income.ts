// KCB 거주·직장 동별 소득·카드소비 (사내 S3 cla-raw-data/kcb_stat_cm, 월 × 시도 Parquet) → data/internal.sqlite kcb_dong_income.
// 행 = 거주 법정동 × 직장 법정동 × 성별 × 연령대의 월평균 소득·카드소비 (인원 수는 대부분 -1로 가려져 있다).
// 동마다 거주 기준·직장 기준으로 마지막 12개월 단순 평균을 낸다 (가려지지 않은 econ_cnt는 가중치로 쓰지 않는다: 대부분 비어 있어 편향).
// 받은 범위: 17개 시도 2019-01 ~ 2022-03/04.
//
//   npx tsx etl/kcb-income.ts
import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'kcb_stat_cm');
const MONTHS = 12;
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`DROP TABLE IF EXISTS kcb_dong_income;
CREATE TABLE kcb_dong_income (
  dong8 TEXT PRIMARY KEY, res_income REAL, res_spend REAL, res_n INTEGER, work_income REAL, work_spend REAL, work_n INTEGER,
  sh_2030_res REAL, ym_from TEXT, ym_to TEXT);`);

const bySido = new Map<string, string[]>();
for (const d of readdirSync(SRC)) {
  const ym = /base_dt=(\d{4}-\d{2})/.exec(d)?.[1];
  if (!ym) continue;
  for (const s of readdirSync(join(SRC, d))) {
    const sido = /sido_cd=(\d+)/.exec(s)?.[1];
    if (sido) bySido.set(sido, [...(bySido.get(sido) ?? []), ym]);
  }
}
type Acc = { inc: number; sp: number; n: number; young: number };
const res = new Map<string, Acc>();
const work = new Map<string, Acc>();
let from = '9999';
let to = '0000';
const add = (m: Map<string, Acc>, k: string, inc: number, sp: number, young: boolean) => {
  const a = m.get(k) ?? { inc: 0, sp: 0, n: 0, young: 0 };
  a.inc += inc;
  a.sp += sp;
  a.n++;
  if (young) a.young++;
  m.set(k, a);
};
for (const [sido, yms] of [...bySido].sort()) {
  const use = yms.sort().slice(-MONTHS);
  if (use[0] < from) from = use[0];
  if (use.at(-1)! > to) to = use.at(-1)!;
  for (const ym of use) {
    const file = await asyncBufferFromFile(join(SRC, `base_dt=${ym}-01`, `sido_cd=${sido}`, 'data.parquet'));
    const md = await parquetMetadataAsync(file);
    const total = Number(md.num_rows);
    for (let start = 0; start < total; start += 400000) {
      const rows = await parquetReadObjects({
        file, metadata: md, compressors, rowStart: start, rowEnd: Math.min(total, start + 400000),
        columns: ['cur_lgl_dong_cd', 'com_lgl_dong_cd', 'age_bin', 'avg_mon_income', 'avg_mon_cardspnd'],
      });
      for (const r of rows) {
        const inc = Number(r.avg_mon_income);
        const sp = Number(r.avg_mon_cardspnd);
        if (!(inc > 0) || !(sp >= 0)) continue;
        const young = r.age_bin === '20' || r.age_bin === '30';
        add(res, String(r.cur_lgl_dong_cd), inc, sp, young);
        add(work, String(r.com_lgl_dong_cd), inc, sp, young);
      }
    }
  }
  log(`시도 ${sido}: ${use[0]}~${use.at(-1)}`);
}
const keys = new Set([...res.keys(), ...work.keys()]);
const out: Row[] = [...keys].map((k) => {
  const r = res.get(k);
  const w = work.get(k);
  return {
    dong8: k, res_income: r ? Math.round(r.inc / r.n) : null, res_spend: r ? Math.round(r.sp / r.n) : null, res_n: r?.n ?? 0,
    work_income: w ? Math.round(w.inc / w.n) : null, work_spend: w ? Math.round(w.sp / w.n) : null, work_n: w?.n ?? 0,
    sh_2030_res: r ? Math.round((r.young / r.n) * 1000) / 1000 : null, ym_from: from, ym_to: to,
  };
});
upsert('kcb_dong_income', out);
log(`kcb_dong_income ${out.length.toLocaleString()} 법정동 · ${from}~${to}`);
meta('kcb_dong_income', { source: 'KCB 거주·직장 동별 소득·카드소비 (사내 S3 cla-raw-data/kcb_stat_cm)', endpoint: 'Parquet', std_period: `${from}~${to}`, status: 'loaded', note: '사내 데이터. 법정동별 12개월 평균 (단위: KCB 원자료 그대로)' });
db.close();
