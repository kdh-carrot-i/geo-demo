// 소상공인 상가(상권)정보 시도별 CSV (공공데이터포털 15083033) → store (latest, nationwide) + store_snapshot (history).
//
//   npx tsx etl/store-file.ts data/raw/store_info_quar_snapshot_261030 202609 [이전 store의 기준월, 비어 있을 때만]
//
// store          = the newest snapshot, full columns, used by the API (competitors, industry lookup).
// store_snapshot = a slim copy of every snapshot (bizes_id, 업종, 위치), so quarters can be diffed:
//                  a bizes_id present in one quarter and gone in the next is treated as closed.
//                  This is the survival-model label for 업종 without 인허가 (소매 등).
// The previous contents of `store` are copied into store_snapshot before being replaced.
import { createReadStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DATA_DIR, log, openDb, WEB_ROOT, type Row } from './lib.ts';

const [dirArg, stdYm, prevYmArg] = process.argv.slice(2);
if (!dirArg || !/^\d{6}$/.test(stdYm ?? '')) throw new Error('usage: store-file.ts <folder> <YYYYMM>');
const dir = resolve(WEB_ROOT, '..', dirArg);

const COLS: Record<string, string> = {
  상가업소번호: 'bizes_id', 상호명: 'bizes_nm', 지점명: 'brch_nm',
  상권업종대분류코드: 'inds_lcls_cd', 상권업종대분류명: 'inds_lcls_nm', 상권업종중분류코드: 'inds_mcls_cd', 상권업종중분류명: 'inds_mcls_nm',
  상권업종소분류코드: 'inds_scls_cd', 상권업종소분류명: 'inds_scls_nm', 표준산업분류코드: 'ksic_cd', 표준산업분류명: 'ksic_nm',
  시도코드: 'ctprvn_cd', 시도명: 'ctprvn_nm', 시군구코드: 'signgu_cd', 시군구명: 'signgu_nm', 행정동코드: 'adong_cd', 행정동명: 'adong_nm',
  법정동코드: 'ldong_cd', 법정동명: 'ldong_nm', 지번코드: 'lno_cd', 대지구분코드: 'plot_sct_cd', 대지구분명: 'plot_sct_nm',
  지번본번지: 'lno_mnno', 지번부번지: 'lno_slno', 지번주소: 'lno_adr', 도로명코드: 'rdnm_cd', 도로명: 'rdnm', 건물본번지: 'bld_mnno',
  건물부번지: 'bld_slno', 건물관리번호: 'bld_mng_no', 건물명: 'bld_nm', 도로명주소: 'rdnm_adr', 구우편번호: 'old_zipcd', 신우편번호: 'new_zipcd',
  동정보: 'dong_no', 층정보: 'flr_no', 호정보: 'ho_no', 경도: 'lon', 위도: 'lat',
};
const SNAP = ['bizes_id', 'bizes_nm', 'brch_nm', 'inds_scls_cd', 'ctprvn_cd', 'signgu_cd', 'adong_cd', 'lon', 'lat', 'flr_no'];

function parseCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') (cur += '"'), i++;
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

const { db, upsert, meta, count } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS store_snapshot (
  std_ym TEXT, bizes_id TEXT, bizes_nm TEXT, brch_nm TEXT, inds_scls_cd TEXT, ctprvn_cd TEXT, signgu_cd TEXT, adong_cd TEXT,
  lon REAL, lat REAL, flr_no TEXT, PRIMARY KEY (std_ym, bizes_id))`);
db.exec('CREATE INDEX IF NOT EXISTS ix_store_snapshot_id ON store_snapshot (bizes_id, std_ym)');
db.exec('CREATE INDEX IF NOT EXISTS ix_store_snapshot_geo ON store_snapshot (std_ym, lat, lon)');

// 1. keep what `store` held until now as its own snapshot (it came from the API with its own std_ym)
const prev = db.prepare(`SELECT std_ym, count(*) n FROM store GROUP BY std_ym`).all() as { std_ym: string | null; n: number }[];
for (const p of prev) {
  // the API-loaded store has no std_ym column value; the caller says which month it was
  const ym = String(p.std_ym ?? prevYmArg ?? '').slice(0, 6) || 'unknown';
  if (ym === stdYm) continue;
  db.exec('BEGIN');
  db.prepare(
    `INSERT OR IGNORE INTO store_snapshot (std_ym, ${SNAP.join(',')}) SELECT ?, ${SNAP.join(',')} FROM store WHERE std_ym IS ?`,
  ).run(ym, p.std_ym);
  db.exec('COMMIT');
  log(`kept previous store snapshot ${ym}: ${p.n} rows`);
}

// 2. replace `store` with this snapshot, nationwide
db.exec('DELETE FROM store');
db.exec(`DELETE FROM store_snapshot WHERE std_ym = '${stdYm}'`);
const files = readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
let total = 0;
const bySido: Record<string, number> = {};
for (const f of files) {
  const rl = createInterface({ input: createReadStream(resolve(dir, f), 'utf8'), crlfDelay: Infinity });
  let header: string[] | null = null;
  let batch: Row[] = [];
  let n = 0;
  const flush = () => {
    upsert('store', batch);
    upsert('store_snapshot', batch.map((r) => ({ std_ym: stdYm, ...Object.fromEntries(SNAP.map((k) => [k, r[k]])) })));
    batch = [];
  };
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '');
    if (!line.trim()) continue;
    const cells = parseCsv(line);
    if (!header) {
      header = cells.map((h) => COLS[h.trim()] ?? '');
      const missing = Object.values(COLS).filter((c) => !header!.includes(c));
      if (missing.length) throw new Error(`${f}: missing columns ${missing.join(', ')}`);
      continue;
    }
    const row: Row = { std_ym: stdYm };
    header.forEach((k, i) => k && (row[k] = cells[i]));
    if (!row.bizes_id) continue;
    batch.push(row);
    n++;
    if (batch.length >= 20000) flush();
  }
  flush();
  total += n;
  bySido[f.replace(/^.*정보_|_\d{6}\.csv$/g, '')] = n;
  log(`${f}: ${n.toLocaleString()} rows (total ${total.toLocaleString()})`);
}

meta('store', {
  source: '소상공인 상가(상권)정보 (시도별 CSV 파일)',
  endpoint: 'data.go.kr 15083033 파일데이터',
  std_period: `${stdYm.slice(0, 4)}-${stdYm.slice(4)} (전국)`,
  status: 'loaded',
  note: `전국 ${total.toLocaleString()}행. 이전 API 적재분(서울)은 store_snapshot에 보관`,
});
meta('store_snapshot', {
  source: '상가정보 분기 스냅샷 (store 교체 때마다 축적)',
  std_period: (db.prepare('SELECT group_concat(std_ym) s FROM (SELECT DISTINCT std_ym FROM store_snapshot ORDER BY 1)').get() as { s: string }).s,
  status: 'loaded',
  note: '분기 사이에 사라진 bizes_id = 폐업으로 보는 생존 레이블용',
});
log(`done: store ${count('store').toLocaleString()}, snapshot ${count('store_snapshot').toLocaleString()}`, JSON.stringify(bySido));
db.exec('ANALYZE store');
