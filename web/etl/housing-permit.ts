// 주택 인허가 (국토교통부 건축HUB 주택인허가정보, 공공데이터포털 15136560) → housing_permit.
// 아파트 등 공동주택 사업의 승인·착공·사용검사(입주) 일정과 세대수 — "앞으로 생길 수요"(입주 예정 단지)를 본다.
// 법정동 단위로만 조회된다(날짜 필터는 기록 생성일 기준이라 쓰지 않는다). 점포가 있는 법정동을 서울부터 점포 많은 순으로,
// 이미 받은 법정동은 건너뛰며 하루 호출 한도 안에서 이어 받는다.
//
//   BUDGET_DATA_GO_KR=9000 npx tsx etl/housing-permit.ts
import { resolve } from 'node:path';
import { BudgetExceeded, callStats, DATA_DIR, dgk, getJson, log, openDb, sleep, type Row } from './lib.ts';

const OP = '1613000/HsPmsHubService/getHpBasisOulnInfo';
const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS housing_permit (
  pk TEXT PRIMARY KEY, bjd_cd TEXT, pnu TEXT, plat_plc TEXT, bld_nm TEXT, purps TEXT, hhld INTEGER, main_bld INTEGER, tot_area REAL,
  apprv_day TEXT, stcns_sched_day TEXT, stcns_day TEXT, use_inspt_sched_day TEXT, use_inspt_day TEXT, demol TEXT);
CREATE INDEX IF NOT EXISTS ix_hp_bjd ON housing_permit (bjd_cd);
CREATE TABLE IF NOT EXISTS housing_permit_done (bjd_cd TEXT PRIMARY KEY, rows INTEGER, fetched_at TEXT);`);

const day = (v: unknown) => (/^\d{8}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);
const txt = (v: unknown) => String(v ?? '').trim() || null;

async function fetchBjd(bjd: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const url = dgk(OP, { sigunguCd: bjd.slice(0, 5), bjdongCd: bjd.slice(5), numOfRows: '100', pageNo: String(page), _type: 'json' });
    // 가끔 빈 본문이 온다: 몇 번 더 받아 본다
    let j: any;
    for (let i = 1; ; i++) {
      try {
        j = await getJson(url);
        break;
      } catch (e) {
        if (e instanceof BudgetExceeded || i >= 3) throw e;
        await sleep(3000 * i);
      }
    }
    const body = j?.response?.body;
    if (!body) throw new Error(`응답 형식 이상: ${JSON.stringify(j).slice(0, 160)}`);
    const it = body.items?.item;
    const items: Row[] = Array.isArray(it) ? it : it ? [it] : [];
    for (const x of items) {
      // 세대가 없는 단독·근생 행정 기록은 수요 지표에 쓰지 않는다
      if (!(Number(x.totHhldCnt) > 0)) continue;
      const pnu = `${bjd}${x.platGbCd === '1' ? '2' : '1'}${String(x.bun ?? '').padStart(4, '0')}${String(x.ji ?? '').padStart(4, '0')}`;
      out.push({
        pk: String(x.mgmHsrgstPk), bjd_cd: bjd, pnu, plat_plc: txt(x.platPlc), bld_nm: txt(x.bldNm), purps: txt(x.purpsCdNm),
        hhld: Number(x.totHhldCnt), main_bld: Number(x.mainBldCnt) || null, tot_area: Number(x.totArea) || null,
        apprv_day: day(x.apprvDay), stcns_sched_day: day(x.stcnsSchedDay), stcns_day: day(x.stcnsDay),
        use_inspt_sched_day: day(x.useInsptSchedDay), use_inspt_day: day(x.useInsptDay), demol: txt(x.demolExtngGbCdNm),
      });
    }
    if (page * 100 >= Number(body.totalCount ?? 0)) break;
  }
  return out;
}

// 대상: 점포가 있는 법정동, 서울 먼저 그다음 점포 많은 순
const targets = db
  .prepare(
    `SELECT ldong_cd bjd, count(*) n FROM store WHERE ldong_cd IS NOT NULL AND ldong_cd NOT IN (SELECT bjd_cd FROM housing_permit_done)
     GROUP BY ldong_cd ORDER BY (substr(ldong_cd, 1, 2) = '11') DESC, n DESC`,
  )
  .all() as { bjd: string; n: number }[];
log(`남은 법정동 ${targets.length.toLocaleString()}`);

let done = 0;
const failed: string[] = [];
try {
  for (const t of targets) {
    let rows: Row[];
    try {
      rows = await fetchBjd(t.bjd);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      failed.push(t.bjd); // 다음 실행 때 다시 받는다 (done 표시 안 함)
      continue;
    }
    upsert('housing_permit', rows);
    upsert('housing_permit_done', [{ bjd_cd: t.bjd, rows: rows.length, fetched_at: new Date().toISOString() }]);
    if (++done % 100 === 0) log(`${done.toLocaleString()} 법정동 (${JSON.stringify(callStats())})`);
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  log(`호출 한도 도달 — 내일 다시 실행하면 이어 받는다`);
}

const s = db.prepare(`SELECT (SELECT count(*) FROM housing_permit_done) d, count(*) n, sum(hhld) h FROM housing_permit`).get() as { d: number; n: number; h: number };
if (failed.length) log(`실패 ${failed.length}곳 (다음 실행에 다시): ${failed.slice(0, 10).join(', ')}`);
log(`이번 ${done} 법정동, 누적 ${s.d.toLocaleString()} 법정동 · 단지 ${s.n.toLocaleString()} · 세대 ${(s.h ?? 0).toLocaleString()}`);
meta('housing_permit', {
  source: '국토교통부 건축HUB 주택인허가정보 (공공데이터포털 15136560)', endpoint: OP, std_period: new Date().toISOString().slice(0, 7), status: targets.length > done ? 'partial' : 'loaded',
  note: `점포 있는 법정동 ${s.d.toLocaleString()}곳 수집, 세대 있는 사업만`,
});
db.close();
