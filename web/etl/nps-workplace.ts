// 국민연금 가입 사업장 내역 (국민연금공단, 공공데이터포털 15083277, 월별 CSV) → nps_workplace.
// 사업장마다 가입자 수·당월 고지금액이 있어 법정동 단위 직장인 수와 평균 소득(추정)을 낸다.
// 주소는 번지 없이 법정동·도로명까지만 공개된다 (예: "서울특별시 금천구 가산동") → 건물·필지 단위로는 잇지 못한다.
// 대상: 법인 3인 이상, 개인 10인 이상 (2025-07부터). 등록 상태(1)만 남긴다.
//
// 개인정보: 사업자등록번호는 읽지 않는다(저장 금지). 개인 사업장 이름은 사람 이름일 수 있어 법인 이름만 남긴다.
//
//   npx tsx etl/nps-workplace.ts data/raw/<파일>.csv
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb, WEB_ROOT, type Row } from './lib.ts';

const file = resolve(WEB_ROOT, '..', process.argv[2] ?? '');
const buf = readFileSync(file);
// 파일마다 UTF-8(BOM) 또는 CP949
const text = buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? buf.toString('utf8').slice(1) : new TextDecoder('euc-kr').decode(buf);
const lines = text.split(/\r?\n/);

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
  return out.map((s) => s.trim());
}

const head = cells(lines[0]);
const col = (re: RegExp) => {
  const i = head.findIndex((h) => re.test(h));
  if (i < 0) throw new Error(`열 없음: ${re} (헤더: ${head.join(',')})`);
  return i;
};
const C = {
  ym: col(/^자료생성년월/),
  name: col(/^사업장명/),
  status: col(/^사업장가입상태코드/),
  jibun: col(/^사업장지번상세주소/),
  road: col(/^사업장도로명상세주소/),
  bjd: col(/^고객법정동주소코드/),
  adm: col(/^고객행정동주소코드/),
  form: col(/^사업장형태구분코드/),
  indCd: col(/^사업장업종코드$/),
  indNm: col(/^사업장업종코드명/),
  members: col(/^가입자수/),
  bill: col(/^당월고지금액/),
  gained: col(/^신규취득자수/),
  lost: col(/^상실가입자수/),
};

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`DROP TABLE IF EXISTS nps_workplace;
CREATE TABLE nps_workplace (
  ym TEXT, seq INTEGER, bjd_cd TEXT, adm_cd TEXT, road_addr TEXT, jibun_addr TEXT, corp INTEGER, name TEXT,
  ind_cd TEXT, ind_nm TEXT, members NUMERIC, bill NUMERIC, gained NUMERIC, lost NUMERIC, PRIMARY KEY (ym, seq));
CREATE INDEX ix_nps_bjd ON nps_workplace (bjd_cd);`);

const rows: Row[] = [];
let skipped = 0;
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const c = cells(lines[i]);
  if (c[C.status] !== '1') {
    skipped++;
    continue;
  }
  const corp = c[C.form] === '1';
  const bjd = c[C.bjd];
  rows.push({
    ym: c[C.ym], seq: i, bjd_cd: bjd, adm_cd: c[C.adm], road_addr: c[C.road], jibun_addr: c[C.jibun],
    corp: corp ? 1 : 0, name: corp ? c[C.name] : null,
    ind_cd: c[C.indCd], ind_nm: c[C.indNm], members: Number(c[C.members]) || 0, bill: Number(c[C.bill]) || 0,
    gained: Number(c[C.gained]) || 0, lost: Number(c[C.lost]) || 0,
  });
  if (rows.length >= 50000) upsert('nps_workplace', rows.splice(0));
}
upsert('nps_workplace', rows);

const s = db.prepare('SELECT count(*) n, sum(members) m, max(ym) ym FROM nps_workplace').get() as { n: number; m: number; ym: string };
log(`사업장 ${s.n.toLocaleString()} (탈퇴 ${skipped.toLocaleString()} 제외), 가입자 ${s.m.toLocaleString()}, 기준 ${s.ym}`);
meta('nps_workplace', {
  source: '국민연금공단 국민연금 가입 사업장 내역 (공공데이터포털 15083277)', endpoint: 'CSV 파일', std_period: s.ym, status: 'loaded',
  note: '법인 3인·개인 10인 이상 사업장, 등록 상태만. 주소는 법정동·도로명까지(번지 없음). 사업자등록번호 미저장, 개인 사업장 이름 미저장',
});
db.close();
