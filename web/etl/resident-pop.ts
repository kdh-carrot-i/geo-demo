// 주민등록 인구·세대 (행정안전부, 공공데이터포털 15108071 / 연령 15108074): 법정동(읍면동·리) 월별.
//   resident_pop_bjd : 월 × 법정동 — 총인구·남녀·세대수·세대당 인구 (2022-10부터)
//   resident_age_bjd : 최근 월 × 법정동 — 10세 단위 연령·성별 인구
// 시군구마다 3개월 구간으로 조회 (API 제한). 이미 받은 시군구·월은 건너뛰므로 끊겨도 다시 실행하면 이어 받는다.
//
//   npx tsx etl/resident-pop.ts            최근 13개월 (전년 같은 달 비교용)
//   npx tsx etl/resident-pop.ts 40         최근 40개월
//   npx tsx etl/resident-pop.ts 13 --age   + 최근 월 연령별
// 하루 호출 한도(개발계정 10,000건)를 넘지 않게 BUDGET_DATA_GO_KR 로 조절한다 (기본 1,200).
import { resolve } from 'node:path';
import { BudgetExceeded, callStats, DATA_DIR, dgk, findItems, findTotal, getJson, log, openDb, type Row } from './lib.ts';

const months = Number(process.argv[2] ?? 13);
const withAge = process.argv.includes('--age');
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS resident_pop_bjd (
  stats_ym TEXT, stdg_cd TEXT, sgg_cd TEXT, name TEXT, tot NUMERIC, male NUMERIC, female NUMERIC, hh_cnt NUMERIC, hh_nmpr REAL,
  PRIMARY KEY (stats_ym, stdg_cd));
CREATE INDEX IF NOT EXISTS ix_rpb_cd ON resident_pop_bjd (stdg_cd);
CREATE TABLE IF NOT EXISTS resident_age_bjd (stats_ym TEXT, stdg_cd TEXT, name TEXT, PRIMARY KEY (stats_ym, stdg_cd));`);

const POP = '1741000/stdgPpltnHhStus/selectStdgPpltnHhStus';
const AGE = '1741000/stdgSexdAgePpltn/selectStdgSexdAgePpltn';
const ym = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
const addMonths = (s: string, n: number) => ym(new Date(Number(s.slice(0, 4)), Number(s.slice(4)) - 1 + n, 1));

async function page(path: string, q: Record<string, string>, pageNo: number) {
  const j = await getJson(dgk(path, { type: 'JSON', regSeCd: '1', lv: '3', numOfRows: '100', pageNo: String(pageNo), ...q }));
  const code = j?.Response?.head?.resultCode;
  if (code === '3') return { items: [] as Row[], total: 0 }; // NODATA: 그 구간에 자료 없음
  if (code != null && code !== '0') throw new Error(`${j.Response.head.resultMsg} (${code})`);
  return { items: findItems(j), total: Math.max(0, findTotal(j)) };
}
async function all(path: string, q: Record<string, string>) {
  const first = await page(path, q, 1);
  const items = [...first.items];
  for (let p = 2; items.length < first.total; p++) items.push(...(await page(path, q, p)).items);
  return items;
}
const n = (v: unknown) => (v === '' || v == null ? null : Number(v));
const fullName = (x: Row) => [x.ctpvNm, x.sggNm, x.stdgNm, x.liNm].filter(Boolean).join(' ');

// 최근 공표 월: 매달 초에 전월분이 올라온다
let latest = ym(new Date());
for (let i = 0; i < 3; i++, latest = addMonths(latest, -1)) {
  // 아직 오지 않은 달은 INVALID_REQUEST_PARAMETER 오류로 온다
  const probe = await page(POP, { stdgCd: '1111000000', srchFrYm: latest, srchToYm: latest }, 1).catch(() => ({ total: 0 }));
  if (probe.total) break;
}
const from = addMonths(latest, -(months - 1)) < '202210' ? '202210' : addMonths(latest, -(months - 1));
log(`기간 ${from}~${latest}`);

// 시군구: 일반구가 있는 시는 시 코드 하나로 조회하면 구까지 나온다
const sggRows = db
  .prepare(`SELECT bjd_cd, locatadd_nm FROM region_legal WHERE sgg_cd<>'000' AND umd_cd='000' AND ri_cd='00'`)
  .all() as { bjd_cd: string; locatadd_nm: string }[];
const isChild = (r: { locatadd_nm: string }) => sggRows.some((p) => p !== r && r.locatadd_nm.startsWith(p.locatadd_nm + ' '));
const targets = sggRows.filter((r) => !isChild(r));
const have = db.prepare(`SELECT count(*) n FROM resident_pop_bjd WHERE sgg_cd = ? AND stats_ym = ?`);

let loaded = 0;
const failed: string[] = [];
try {
  for (const t of targets) {
    try {
      for (let s = from; s <= latest; s = addMonths(s, 3)) {
        const e = addMonths(s, 2) > latest ? latest : addMonths(s, 2);
        const sgg = t.bjd_cd.slice(0, 5);
        if ((have.get(sgg, e) as { n: number }).n) continue;
        const items = await all(POP, { stdgCd: t.bjd_cd, srchFrYm: s, srchToYm: e });
        const rows = items.map((x) => ({
          stats_ym: x.statsYm, stdg_cd: x.stdgCd, sgg_cd: sgg, name: fullName(x),
          tot: n(x.totNmprCnt), male: n(x.maleNmprCnt), female: n(x.femlNmprCnt), hh_cnt: n(x.hhCnt), hh_nmpr: n(x.hhNmpr),
        }));
        loaded += upsert('resident_pop_bjd', rows);
      }
      log(`${t.locatadd_nm} 완료 (누적 ${loaded}행)`);
    } catch (e) {
      // 서버 시간 초과 등: 이 시군구는 건너뛰고 다음 실행 때 다시 받는다
      if (e instanceof BudgetExceeded) throw e;
      failed.push(t.locatadd_nm);
      log(`${t.locatadd_nm} 건너뜀: ${String(e).slice(0, 80)}`);
    }
  }
  if (failed.length) log(`건너뛴 시군구 ${failed.length}: ${failed.join(', ')}`);

  if (withAge) {
    db.exec(`DELETE FROM resident_age_bjd WHERE stats_ym <> '${latest}'`);
    for (const t of targets) {
      if ((db.prepare(`SELECT count(*) n FROM resident_age_bjd WHERE stats_ym = ? AND stdg_cd LIKE ?`).get(latest, `${t.bjd_cd.slice(0, 5)}%`) as { n: number }).n) continue;
      const items = await all(AGE, { stdgCd: t.bjd_cd, srchFrYm: latest, srchToYm: latest });
      // 연령 열 이름은 API 그대로 (예: 0to9AgeMaleNmprCnt 형태) — 숫자 열만 남긴다
      upsert('resident_age_bjd', items.map((x) => ({
        stats_ym: x.statsYm, stdg_cd: x.stdgCd, name: fullName(x),
        ...Object.fromEntries(Object.entries(x).filter(([k, v]) => /Cnt$/.test(k) && v !== '').map(([k, v]) => [`a_${k}`, Number(v)])),
      })));
      log(`연령 ${t.locatadd_nm}`);
    }
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  log(`호출 한도 도달 — 다시 실행하면 이어 받는다 (${JSON.stringify(callStats())})`);
}

const c = db.prepare(`SELECT count(*) n, count(DISTINCT stats_ym) m, max(stats_ym) last FROM resident_pop_bjd`).get() as { n: number; m: number; last: string };
log(`resident_pop_bjd ${c.n}행, ${c.m}개월, 최근 ${c.last}`);
meta('resident_pop_bjd', {
  source: '행정안전부 법정동별 주민등록 인구 및 세대현황 (공공데이터포털 15108071)', endpoint: POP, std_period: c.last, status: 'loaded',
  note: `법정동(읍면동·리) 월별, 총인구·세대수. ${c.m}개월`,
});
if (withAge) meta('resident_age_bjd', { source: '행정안전부 법정동별 성·연령별 주민등록 인구 (15108074)', endpoint: AGE, std_period: latest, status: 'loaded', note: '최근 월만' });
db.close();
