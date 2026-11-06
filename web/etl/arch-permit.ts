// 건축 인허가 (국토교통부 건축HUB 건축인허가정보, 공공데이터포털 15136267) → arch_permit.
// 허가·착공·사용승인 일정으로 "곧 생길 상가·업무 공간"(경쟁 공급, 공실 위험)과 새 업무시설(직장인 수요)을 본다.
// 기록이 많아(역삼동 2024년 이후만 1천 건) 건축HUB 이관(2022-08-13) 뒤 생성된 기록 중 연면적 300㎡ 이상
// 상업·업무·숙박·문화 등 비주거 시설만 남긴다. 주택은 etl/housing-permit.ts.
// 점포가 있는 법정동을 서울부터 점포 많은 순으로, 받은 곳은 건너뛰며 하루 호출 한도 안에서 이어 받는다.
//
//   BUDGET_DATA_GO_KR=9000 npx tsx etl/arch-permit.ts
import { resolve } from 'node:path';
import { BudgetExceeded, callStats, DATA_DIR, dgk, getJson, log, openDb, sleep, type Row } from './lib.ts';

const OP = '1613000/ArchPmsHubService/getApBasisOulnInfo';
const SINCE = '20220814';
const MIN_AREA = 300;
// 상권에 영향을 주는 비주거 용도 (주택·창고·공장·축사·가설 등은 뺀다)
const PURPOSE = /근린생활|판매|업무|숙박|문화및집회|운동|위락|교육연구|의료|노유자|관광휴게/;

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS arch_permit (
  pk TEXT PRIMARY KEY, bjd_cd TEXT, pnu TEXT, plat_plc TEXT, bld_nm TEXT, purps TEXT, arch_gb TEXT, tot_area REAL, plat_area REAL,
  main_bld INTEGER, pms_day TEXT, stcns_sched_day TEXT, real_stcns_day TEXT, use_apr_day TEXT);
CREATE INDEX IF NOT EXISTS ix_ap_bjd ON arch_permit (bjd_cd);
CREATE TABLE IF NOT EXISTS arch_permit_done (bjd_cd TEXT PRIMARY KEY, rows INTEGER, fetched_at TEXT);`);

const day = (v: unknown) => (/^\d{8}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);
const txt = (v: unknown) => String(v ?? '').trim() || null;

async function fetchBjd(bjd: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const url = dgk(OP, { sigunguCd: bjd.slice(0, 5), bjdongCd: bjd.slice(5), numOfRows: '100', pageNo: String(page), startDate: SINCE, _type: 'json' });
    // 가끔 빈 본문·503이 온다: 몇 번 더 받아 본다
    let j: any;
    for (let i = 1; ; i++) {
      try {
        j = await getJson(url);
        if (!j?.response?.body) throw new Error(`응답 형식 이상: ${JSON.stringify(j).slice(0, 160)}`);
        break;
      } catch (e) {
        if (e instanceof BudgetExceeded || i >= 3) throw e;
        await sleep(3000 * i);
      }
    }
    const body = j.response.body;
    const it = body.items?.item;
    const items: Row[] = Array.isArray(it) ? it : it ? [it] : [];
    for (const x of items) {
      const area = Number(x.totArea) || 0;
      if (area < MIN_AREA || !PURPOSE.test(String(x.mainPurpsCdNm ?? ''))) continue;
      out.push({
        pk: String(x.mgmPmsrgstPk), bjd_cd: bjd,
        pnu: `${bjd}${x.platGbCd === '1' ? '2' : '1'}${String(x.bun ?? '').padStart(4, '0')}${String(x.ji ?? '').padStart(4, '0')}`,
        plat_plc: txt(x.platPlc), bld_nm: txt(x.bldNm), purps: txt(x.mainPurpsCdNm), arch_gb: txt(x.archGbCdNm),
        tot_area: area, plat_area: Number(x.platArea) || null, main_bld: Number(x.mainBldCnt) || null,
        pms_day: day(x.archPmsDay), stcns_sched_day: day(x.stcnsSchedDay), real_stcns_day: day(x.realStcnsDay), use_apr_day: day(x.useAprDay),
      });
    }
    if (page * 100 >= Number(body.totalCount ?? 0)) break;
  }
  return out;
}

const targets = db
  .prepare(
    `SELECT ldong_cd bjd, count(*) n FROM store WHERE ldong_cd IS NOT NULL AND ldong_cd NOT IN (SELECT bjd_cd FROM arch_permit_done)
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
    upsert('arch_permit', rows);
    upsert('arch_permit_done', [{ bjd_cd: t.bjd, rows: rows.length, fetched_at: new Date().toISOString() }]);
    if (++done % 100 === 0) log(`${done.toLocaleString()} 법정동 (${JSON.stringify(callStats())})`);
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  log('호출 한도 도달 — 내일 다시 실행하면 이어 받는다');
}

if (failed.length) log(`실패 ${failed.length}곳 (다음 실행에 다시): ${failed.slice(0, 10).join(', ')}`);
const s = db.prepare(`SELECT (SELECT count(*) FROM arch_permit_done) d, count(*) n, sum(tot_area) a FROM arch_permit`).get() as { d: number; n: number; a: number };
log(`이번 ${done} 법정동, 누적 ${s.d.toLocaleString()} 법정동 · 허가 ${s.n.toLocaleString()} · 연면적 ${Math.round(s.a ?? 0).toLocaleString()}㎡`);
meta('arch_permit', {
  source: '국토교통부 건축HUB 건축인허가정보 (공공데이터포털 15136267)', endpoint: OP, std_period: new Date().toISOString().slice(0, 7), status: targets.length > done ? 'partial' : 'loaded',
  note: `2022-08 이후 기록, 연면적 ${MIN_AREA}㎡ 이상 비주거(근생·판매·업무 등). 점포 있는 법정동 ${s.d.toLocaleString()}곳`,
});
db.close();
