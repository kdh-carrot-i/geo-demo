// Merge seoul_commerce.sqlite + nationwide_commerce.sqlite → data/commerce.sqlite (the single serving DB for the pilot).
// Base = nationwide DB. Seoul-only tables are copied with their original DDL; Seoul's partial 실거래 and old-key R-ONE are dropped.
// One-off (run 2026-10-30). Since then seoul-sqlite.ts and nationwide-probe.ts write to commerce.sqlite directly,
// so re-running this would replace the live DB with the old snapshots — it refuses unless --force is given.
// Usage: tsx etl/merge-db.ts --force
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR, log } from './lib.ts';

const SEOUL = resolve(DATA_DIR, 'seoul_commerce.sqlite');
const NATION = resolve(DATA_DIR, 'nationwide_commerce.sqlite');
const OUT = resolve(DATA_DIR, 'commerce.sqlite');

if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`${OUT} already exists and is the live DB. Re-run with --force only to rebuild it from the old snapshots.`);
  process.exit(1);
}
if (!existsSync(SEOUL) || !existsSync(NATION)) {
  console.error('source snapshots are gone — nothing to merge.');
  process.exit(1);
}

// tables that exist only in the Seoul build (서울 열린데이터 API)
const SEOUL_ONLY = ['trade_area_seoul', 'industry_svc', 'ta_sales_q', 'ta_store_q', 'ta_flpop_q', 'ta_repop_q', 'ta_wrcpop_q', 'living_pop_dong_h', 'subway_daily', 'subway_hourly_m'];

for (const p of [SEOUL, NATION]) {
  const d = new DatabaseSync(p);
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  d.close();
}
for (const suffix of ['', '-wal', '-shm']) if (existsSync(OUT + suffix)) rmSync(OUT + suffix);
copyFileSync(NATION, OUT);

const db = new DatabaseSync(OUT);
db.exec(`ATTACH DATABASE '${SEOUL.replace(/'/g, "''")}' AS s`);
const ddl = (name: string) => (db.prepare(`SELECT sql FROM s.sqlite_master WHERE name = ?`).get(name) as { sql: string }).sql;
const indexes = (table: string) =>
  (db.prepare(`SELECT sql FROM s.sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`).all(table) as { sql: string }[]).map((r) => r.sql);

db.exec('BEGIN');
for (const t of SEOUL_ONLY) {
  db.exec(`DROP TABLE IF EXISTS main.${t}`);
  db.exec(ddl(t)); // ALTER ADD COLUMN history is folded into sqlite_master.sql, so column order matches
  for (const i of indexes(t)) db.exec(i);
  db.exec(`INSERT INTO main.${t} SELECT * FROM s.${t}`);
  log(`  copied ${t}`);
}

// meta: Seoul rows for Seoul-only tables, pending notes for API-limited tables, fresh row counts everywhere
const metaCols = (db.prepare(`PRAGMA main.table_info(meta_source)`).all() as { name: string }[]).map((c) => c.name).join(',');
db.exec(`INSERT OR REPLACE INTO main.meta_source (${metaCols}) SELECT ${metaCols} FROM s.meta_source WHERE table_name IN (${SEOUL_ONLY.map((t) => `'${t}'`).join(',')})`);
db.exec(`DELETE FROM main.meta_source WHERE table_name LIKE 'step:%'`);
const now = new Date().toISOString();
const pending = db.prepare(`INSERT OR REPLACE INTO main.meta_source (table_name, source, status, note, loaded_at) VALUES (?, ?, 'pending', ?, ?)`);
pending.run('trade_commercial', '국토부 상업업무용 매매 실거래', '공공데이터포털 운영계정 전환 후 전국 12개월 적재 (약 3,060 호출)', now);
pending.run('trade_apt', '국토부 아파트 매매 실거래', '공공데이터포털 운영계정 전환 후 전국 12개월 적재 (약 3,060 호출)', now);
db.exec(`UPDATE main.meta_source SET note = '서울만 적재. 나머지 시도 약 222만 건은 운영계정 전환 후' WHERE table_name = 'store'`);
db.exec(`UPDATE main.meta_source SET status = 'partial', note = '상업용 관련 121개 통계표, 호출 상한 600에서 중단 — 필요한 표만 골라 재적재 예정' WHERE table_name = 'rone_stat'`);
db.exec(`UPDATE main.meta_source SET note = '서울 점포에서 도출 (전국 점포 적재 후 재생성)' WHERE table_name IN ('industry_store', 'region_admin')`);
for (const { name } of db.prepare(`SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT IN ('meta_source','api_feasibility')`).all() as { name: string }[]) {
  const n = (db.prepare(`SELECT count(*) n FROM main.${name}`).get() as { n: number }).n;
  db.prepare(`INSERT INTO main.meta_source (table_name, row_count) VALUES (?, ?) ON CONFLICT(table_name) DO UPDATE SET row_count = excluded.row_count`).run(name, n);
}
db.exec(`UPDATE main.meta_source SET status = 'pending' WHERE row_count = 0 AND status IS NULL`);
db.exec('COMMIT');

// views come from the Seoul build (they reference ta_* and license_event, both present now)
for (const { name, sql } of db.prepare(`SELECT name, sql FROM s.sqlite_master WHERE type='view'`).all() as { name: string; sql: string }[]) {
  db.exec(`DROP VIEW IF EXISTS main.${name}`);
  db.exec(sql);
  log(`  view ${name}`);
}
db.exec('DETACH DATABASE s');
db.exec('ANALYZE');
for (const r of db.prepare(`SELECT table_name, status, row_count FROM meta_source ORDER BY table_name`).all() as Record<string, unknown>[])
  log(`  ${String(r.table_name).padEnd(22)} ${String(r.status ?? '').padEnd(8)} ${String(r.row_count ?? '').padStart(9)}`);
db.close();
log(`done → ${OUT}`);
