// 부산 행정동 생활인구 (부산광역시, 공공데이터포털 15164444 시간대 / 15164376 연령, 통신 기지국 기반, 2023-01~).
// 월 × 행정동 × 시간(또는 연령대)의 하루 평균 — 주거(h)·직장(w)·방문(v) 인구로 나뉜다. 합이 서울 생활인구와 같은 정의.
//   busan_livepop_dong_h   : std_ym, adm_cd(8자리), hour(0~23), home, work, visit
//   busan_livepop_dong_age : std_ym, adm_cd, age_band, home, work, visit
// 전체를 다시 받는다 (시간대 약 22만 행, 1,000행씩 약 230회 호출).
//
//   npx tsx etl/busan-livepop.ts
import { resolve } from 'node:path';
import { DATA_DIR, dgk, findItems, findTotal, getJson, log, openDb, pages, type Row } from './lib.ts';

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS busan_livepop_dong_h (
  std_ym TEXT, adm_cd TEXT, adm_nm TEXT, hour INTEGER, home NUMERIC, work NUMERIC, visit NUMERIC, PRIMARY KEY (std_ym, adm_cd, hour));
CREATE TABLE IF NOT EXISTS busan_livepop_dong_age (
  std_ym TEXT, adm_cd TEXT, adm_nm TEXT, age_band TEXT, home NUMERIC, work NUMERIC, visit NUMERIC, PRIMARY KEY (std_ym, adm_cd, age_band));`);

const SIZE = 1000;
async function load(path: string, table: string, map: (x: Row) => Row) {
  const q = (p: number) => dgk(path, { pageNo: String(p), numOfRows: String(SIZE), resultType: 'json' });
  const first = await getJson(q(1));
  const total = findTotal(first);
  let n = upsert(table, findItems(first).map(map));
  for (const p of pages(total, SIZE).slice(1)) {
    n += upsert(table, findItems(await getJson(q(p))).map(map));
    if (p % 20 === 0) log(`${table} ${n}/${total}`);
  }
  log(`${table} ${n}/${total}`);
}
const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
// hcode 는 10자리 (행정동 8자리 + "00")
const base = (x: Row) => ({ std_ym: x.stdYm, adm_cd: String(x.hcode).slice(0, 8), adm_nm: x.hname, home: num(x.hpopAvg), work: num(x.wpopAvg), visit: num(x.vpopAvg) });

await load('6260000/DongPopTimeService/getDongPopTime', 'busan_livepop_dong_h', (x) => ({ ...base(x), hour: Number(String(x.times).replace(/\D/g, '')) % 24 }));
await load('6260000/DongPopAgeService/getDongPopAge', 'busan_livepop_dong_age', (x) => ({ ...base(x), age_band: x.ages }));

const c = db.prepare(`SELECT count(DISTINCT adm_cd) d, min(std_ym) a, max(std_ym) b FROM busan_livepop_dong_h`).get() as { d: number; a: string; b: string };
log(`부산 행정동 ${c.d}, ${c.a}~${c.b}`);
for (const t of ['busan_livepop_dong_h', 'busan_livepop_dong_age'])
  meta(t, {
    source: '부산광역시 행정동 생활인구 (공공데이터포털 15164444·15164376, 통신 기지국)', endpoint: '6260000/DongPopTimeService · DongPopAgeService', std_period: `${c.a}~${c.b}`, status: 'loaded',
    note: '월별 하루 평균, 주거·직장·방문 인구. 이용허락범위 제한 없음(포털 표기, 원문 확인 필요)',
  });
db.close();
