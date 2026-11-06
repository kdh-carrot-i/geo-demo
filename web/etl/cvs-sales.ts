// 편의점·소매 가맹점 월 카드매출 (사내 S3 cla-raw-data/k7_card_sales, Parquet) → data/internal.sqlite cvs_sales_m.
// 브랜드 코드: CU, GS(GS25), K7(세븐일레븐), EM(이마트24), ET(기타 — 슈퍼마켓·잡화점·개인 편의점 등). 2025-09 ~ 2026-09, 월 약 10만 곳.
// 사업자등록번호(BIZR_NO)는 읽지 않는다. 매장 구분: PNU + 정규화 상호 (card_sales_m과 같은 키).
//
//   npx tsx etl/cvs-sales.ts
import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const SRC = resolve(DATA_DIR, 'raw', 's3', 'cla-raw-data', 'k7_card_sales');
const compressors = { GZIP: (input: Uint8Array) => new Uint8Array(gunzipSync(input)) };
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'internal.sqlite'));
db.exec(`DROP TABLE IF EXISTS cvs_sales_m;
CREATE TABLE cvs_sales_m (ym TEXT, store_key TEXT, name TEXT, pnu TEXT, lon REAL, lat REAL, brand TEXT, ind_cd TEXT, ind_nm TEXT, amt NUMERIC, cnt NUMERIC,
  PRIMARY KEY (ym, store_key));
CREATE INDEX ix_cvs_key ON cvs_sales_m (store_key);`);
const normName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const COLS = ['ST_DT', 'CMPTT_BRND_CD', 'SHNM_NM', 'PNU_CD', 'XCORD', 'YCORD', 'TYBIZ_CD', 'TYBIZ_NM', 'SAL_AMT', 'SAL_CNT'];
let n = 0;
for (const d of readdirSync(SRC).filter((x) => x.startsWith('base_dt=')).sort()) {
  const file = await asyncBufferFromFile(join(SRC, d, 'data.parquet'));
  const rows = await parquetReadObjects({ file, metadata: await parquetMetadataAsync(file), columns: COLS, compressors });
  n += upsert('cvs_sales_m', rows.flatMap((x): Row[] => {
    const pnu = String(x.PNU_CD ?? '');
    const name = String(x.SHNM_NM ?? '').trim();
    if (!/^\d{19}$/.test(pnu) || !name) return [];
    return [{
      ym: String(x.ST_DT).replace(/\D/g, '').slice(0, 6), store_key: `${pnu}|${normName(name)}`, name, pnu, lon: Number(x.XCORD) || null, lat: Number(x.YCORD) || null,
      brand: x.CMPTT_BRND_CD ?? null, ind_cd: x.TYBIZ_CD ?? null, ind_nm: x.TYBIZ_NM ?? null, amt: Number(x.SAL_AMT) || 0, cnt: Number(x.SAL_CNT) || 0,
    }];
  }));
}
const s = db.prepare('SELECT count(*) n, count(DISTINCT store_key) k, min(ym) a, max(ym) b FROM cvs_sales_m').get() as { n: number; k: number; a: string; b: string };
log(`cvs_sales_m ${s.n.toLocaleString()}행 · 매장 ${s.k.toLocaleString()} · ${s.a}~${s.b} (적재 ${n.toLocaleString()})`);
meta('cvs_sales_m', { source: '편의점·소매 가맹점 월 카드매출 (사내 S3 k7_card_sales)', endpoint: 'Parquet', std_period: `${s.a}~${s.b}`, status: 'loaded', note: '사내 데이터. 브랜드 코드 CU·GS·K7·EM·ET' });
db.close();
