// 경기도 유동인구 행정동 단위 집계 (경기데이터드림 파일, 원천 KT) → gg_flowpop_dong_h.
//
//   npx tsx etl/gg-flowpop.ts "data/raw/경기유동인구_행정동 단위 집계_202608"
//
// LICENSE: 공공누리 2유형 (상업적 이용 금지). 내부 심사 한정 (2026-11-02 결정, docs/10 L-1·L-2): the API reads it only
// through flowpop_est_dong (ml/flowpop_v0.py) and only while DATA_SCOPE is not 'external'.
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DATA_DIR, log, openDb, WEB_ROOT, type Row } from './lib.ts';

const dir = resolve(WEB_ROOT, '..', process.argv[2] ?? '');
const files = readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
if (!files.length) throw new Error(`no csv in ${dir}`);

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS gg_flowpop_dong_h (
  ymd TEXT, admi_cd TEXT, cty_nm TEXT, admi_nm TEXT, time_cd INTEGER, forn_gb TEXT, tot_cnt REAL,
  PRIMARY KEY (ymd, admi_cd, time_cd, forn_gb))`);

const months = new Set<string>();
for (const f of files) {
  const rl = createInterface({ input: createReadStream(resolve(dir, f), 'utf8'), crlfDelay: Infinity });
  let header: string[] | null = null;
  let batch: Row[] = [];
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '');
    if (!line.trim()) continue;
    const cells = line.split(','); // numeric/name fields only, no quoted commas in this file
    if (!header) {
      header = cells.map((h) => h.trim().toLowerCase());
      continue;
    }
    const r: Row = {};
    header.forEach((h, i) => (r[h] = cells[i]));
    let tot = 0;
    for (const h of header) if (h.endsWith('_cnt')) tot += Number(r[h]) || 0;
    const ymd = String(r.etl_ymd);
    months.add(ymd.slice(0, 6));
    batch.push({ ymd, ...Object.fromEntries(header.filter((h) => h !== 'etl_ymd').map((h) => [h, r[h]])), tot_cnt: Math.round(tot * 100) / 100 });
    if (batch.length >= 20000) (upsert('gg_flowpop_dong_h', batch), (batch = []));
  }
  upsert('gg_flowpop_dong_h', batch);
  log(`${f} loaded`);
}
const total = (db.prepare('SELECT count(*) n FROM gg_flowpop_dong_h').get() as { n: number }).n;
const dongs = (db.prepare('SELECT count(DISTINCT admi_cd) n FROM gg_flowpop_dong_h').get() as { n: number }).n;
meta('gg_flowpop_dong_h', {
  source: '경기도 유동인구 행정동 단위 집계 (경기데이터드림 파일, 원천 KT)',
  endpoint: `data/raw/${process.argv[2]?.split(/[\\/]/).pop()}`,
  std_period: [...months].sort().join(','),
  status: 'loaded',
  note: `행정동 ${dongs}, ${total.toLocaleString()}행. 공공누리 2유형(상업 이용 금지) — 내부 심사 한정, 외부 제공 전 외부 자문 (docs/10 L-1·L-2)`,
});
log(`done: ${total.toLocaleString()} rows, ${dongs} 행정동, months ${[...months].join(',')}`);
