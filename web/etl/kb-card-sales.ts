// KB카드 가맹점 월 매출 (사내 S3 cla-raw-data/kb_card_sales, Parquet) → data/internal.sqlite card_sales_m.
// 매장(가맹점) × 월. 사내 데이터라 공개 데이터 DB(commerce.sqlite)와 분리한다.
// 사업자등록번호는 읽지 않는다(저장 금지): 매장 구분은 PNU + 정규화한 상호명(store_key).
// 70여 개 열은 모델에 쓸 비율로 줄인다 (연령·성별·시간대·요일·관외 거주 고객 비중).
//
//   npx tsx etl/kb-card-sales.ts            data/raw/s3/cla-raw-data/kb_card_sales 아래 전부 (받은 달은 건너뜀)
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'kb_card_sales');
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS card_sales_m (
  ym TEXT, store_key TEXT, name TEXT, pnu TEXT, bjd_cd TEXT, lon REAL, lat REAL, kb_ind TEXT, ksic TEXT,
  amt NUMERIC, cnt NUMERIC, franchise INTEGER,
  sh_male REAL, sh_20 REAL, sh_30 REAL, sh_40 REAL, sh_50 REAL, sh_60 REAL,
  sh_weekend REAL, sh_morning REAL, sh_lunch REAL, sh_afternoon REAL, sh_evening REAL, sh_night REAL, sh_outside REAL,
  PRIMARY KEY (ym, store_key));
CREATE INDEX IF NOT EXISTS ix_csm_key ON card_sales_m (store_key);
CREATE INDEX IF NOT EXISTS ix_csm_bjd ON card_sales_m (bjd_cd);`);

// 사업자등록번호는 빼고 필요한 열만 읽는다
const COLS = [
  '기준년월', '상호명', 'pnu코드', 'x좌표', 'y좌표', 'kb카드_업종분류명', '표준산업분류코드_10차', '총매출금액', '총매출건수',
  ...['10대', '20대', '30대', '40대', '50대', '60대이상'].flatMap((a) => [`매출금액_남성_${a}`, `매출금액_여성_${a}`]),
  ...['일', '월', '화', '수', '목', '금', '토'].map((d) => `매출금액_${d}`),
  ...['01_04', '05_10', '11_14', '15_17', '18_19', '20_21', '22_24'].map((h) => `매출금액_${h}`),
  '매출금액_프랜차이즈', '매출금액_관외거주',
];
const normName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0)) || 0;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function toRow(x: Record<string, unknown>): Row | null {
  const amt = num(x['총매출금액']);
  const pnu = x['pnu코드'] == null ? '' : String(x['pnu코드']);
  const name = String(x['상호명'] ?? '').trim();
  if (!name || !/^\d{19}$/.test(pnu)) return null;
  const by = (k: string) => num(x[`매출금액_${k}`]);
  const ages = ['10대', '20대', '30대', '40대', '50대', '60대이상'];
  const age = (a: string) => by(`남성_${a}`) + by(`여성_${a}`);
  const ageTot = ages.reduce((s, a) => s + age(a), 0);
  const male = ages.reduce((s, a) => s + by(`남성_${a}`), 0);
  const days = ['일', '월', '화', '수', '목', '금', '토'].reduce((s, d) => s + by(d), 0);
  const hours = ['01_04', '05_10', '11_14', '15_17', '18_19', '20_21', '22_24'].reduce((s, h) => s + by(h), 0);
  const sa = (v: number) => (ageTot ? r3(v / ageTot) : null);
  const sh = (v: number) => (hours ? r3(v / hours) : null);
  return {
    ym: String(x['기준년월']), store_key: `${pnu}|${normName(name)}`, name, pnu, bjd_cd: pnu.slice(0, 10),
    lon: num(x['x좌표']) || null, lat: num(x['y좌표']) || null, kb_ind: x['kb카드_업종분류명'] ?? null, ksic: x['표준산업분류코드_10차'] ?? null,
    amt, cnt: num(x['총매출건수']), franchise: by('프랜차이즈') > 0 ? 1 : 0,
    sh_male: sa(male), sh_20: sa(age('20대')), sh_30: sa(age('30대')), sh_40: sa(age('40대')), sh_50: sa(age('50대')), sh_60: sa(age('60대이상')),
    sh_weekend: days ? r3((by('토') + by('일')) / days) : null,
    sh_morning: sh(by('05_10')), sh_lunch: sh(by('11_14')), sh_afternoon: sh(by('15_17')), sh_evening: sh(by('18_19') + by('20_21')), sh_night: sh(by('22_24') + by('01_04')),
    sh_outside: amt ? r3(by('관외거주') / amt) : null,
  };
}

// 2025-11부터는 같은 열의 CSV(UTF-8, 열 이름 앞에 "carroti_final_YYYYMM." 접두어)로 들어 있다
const files = readdirSync(SRC)
  .filter((d) => statSync(join(SRC, d)).isDirectory())
  .flatMap((d) => readdirSync(join(SRC, d)).filter((f) => /\.(parquet|csv)$/.test(f)).map((f) => join(SRC, d, f)))
  .sort();

/** 따옴표 안 쉼표를 지키는 CSV 한 줄 나누기 */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') (cur += '"'), i++;
      else q = !q;
    } else if (ch === ',' && !q) (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadCsv(f: string): Promise<{ total: number; kept: number }> {
  const rl = createInterface({ input: createReadStream(f, 'utf8'), crlfDelay: Infinity });
  let head: string[] | null = null;
  let batch: Row[] = [];
  let total = 0;
  let kept = 0;
  for await (const line of rl) {
    if (!line) continue;
    if (!head) {
      const first = cells(line.replace(/^﻿/, '')).map((h) => h.replace(/^[^.]*\./, ''));
      // 열 이름 줄이 없는 달(2025-11 등)은 Parquet 달과 같은 열 순서다
      if (first.includes('기준년월')) {
        head = first;
        continue;
      }
      head = parquetColumns;
    }
    total++;
    const c = cells(line);
    const x: Record<string, unknown> = {};
    // 사업자등록번호 열은 담지 않는다
    head.forEach((h, i) => {
      if (h !== '사업자등록번호') x[h] = c[i];
    });
    const r = toRow(x);
    if (r) batch.push(r);
    if (batch.length >= 50000) kept += upsert('card_sales_m', batch.splice(0));
  }
  kept += upsert('card_sales_m', batch);
  return { total, kept };
}
// 열 이름 없는 CSV에 쓸 열 순서: 첫 Parquet 파일의 스키마
const firstParquet = files.find((f) => f.endsWith('.parquet'));
if (!firstParquet) throw new Error('열 순서를 알 Parquet 파일이 없다');
const parquetColumns = (await parquetMetadataAsync(await asyncBufferFromFile(firstParquet))).schema.slice(1).map((s) => s.name);
const have = new Set((db.prepare('SELECT DISTINCT ym FROM card_sales_m').all() as { ym: string }[]).map((r) => r.ym));
const BATCH = 100000;
for (const f of files) {
  const ym = /(\d{6})\.(parquet|csv)$/.exec(f)?.[1] ?? '';
  if (have.has(ym)) continue;
  if (f.endsWith('.csv')) {
    const { total, kept } = await loadCsv(f);
    log(`${ym}: ${total.toLocaleString()}행 중 ${kept.toLocaleString()} 적재 (CSV)`);
    continue;
  }
  const file = await asyncBufferFromFile(f);
  const md = await parquetMetadataAsync(file);
  const total = Number(md.num_rows);
  let kept = 0;
  for (let start = 0; start < total; start += BATCH) {
    const objs = await parquetReadObjects({ file, metadata: md, columns: COLS, rowStart: start, rowEnd: Math.min(total, start + BATCH) });
    const rows = objs.map(toRow).filter((r): r is Row => r !== null);
    kept += upsert('card_sales_m', rows);
  }
  log(`${ym}: ${total.toLocaleString()}행 중 ${kept.toLocaleString()} 적재`);
}

const s = db.prepare('SELECT count(*) n, count(DISTINCT store_key) k, min(ym) a, max(ym) b FROM card_sales_m').get() as { n: number; k: number; a: string; b: string };
log(`card_sales_m ${s.n.toLocaleString()}행 · 매장 ${s.k.toLocaleString()} · ${s.a}~${s.b}`);
meta('card_sales_m', {
  source: 'KB카드 가맹점 월 매출 (사내 S3 cla-raw-data/kb_card_sales)', endpoint: 'Parquet', std_period: `${s.a}~${s.b}`, status: 'loaded',
  note: '사내 데이터(내부 심사 한정). 사업자등록번호 미저장, 매장 구분 = PNU + 상호명',
});
db.close();
