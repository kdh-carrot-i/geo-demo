// Build industry_map (업종 코드 대응표) in data/commerce.sqlite and validate it against Seoul data.
// Pivot = 상가정보 소분류 (scls_cd). Rules below are hand-written from the three code lists; analysts edit them here.
// Validation: per 서울 행정동, 서울 상권분석 점포수(svc) vs 상가정보 점포수(mapped scls) → Pearson r and count ratio.
// Usage: tsx etl/industry-map.ts
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const { db, upsert, meta, dropCache } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec('DROP TABLE IF EXISTS industry_map');
dropCache('industry_map');
db.exec(`CREATE TABLE industry_map (
  system TEXT, code TEXT, code_nm TEXT, scls_cd TEXT, scls_nm TEXT, match_type TEXT, note TEXT,
  PRIMARY KEY (system, code, scls_cd))`);

type Rule = { exact?: string[]; group?: string[]; partial?: string[]; note?: string };

// ── 서울 서비스업종 100 → 상가정보 소분류 ───────────────────
// 소분류 코드 앞부분(예: 'I201')을 쓰면 그 중분류 전체를 뜻한다.
const SEOUL: Record<string, Rule> = {
  CS100001: { group: ['I201'] }, // 한식음식점
  CS100002: { group: ['I202'] }, // 중식
  CS100003: { group: ['I203'] }, // 일식
  CS100004: { group: ['I204'], partial: ['I205', 'I20601'], note: '동남아·기타 외국식은 별도 분류가 없어 양식에 근사' },
  CS100005: { group: ['I21001', 'I21002'] }, // 제과점: 빵/도넛, 떡/한과
  CS100006: { group: ['I21003', 'I21004', 'I21005'] }, // 패스트푸드: 피자, 버거, 토스트/샌드위치
  CS100007: { exact: ['I21006'] }, // 치킨
  CS100008: { exact: ['I21007'] }, // 분식
  CS100009: { group: ['I21103', 'I21104'], partial: ['I21101', 'I21102'], note: '유흥주점은 별도 분류가 없어 근사' },
  CS100010: { group: ['I21201', 'I21008'] }, // 커피-음료: 카페, 아이스크림/빙수
  CS200001: { exact: ['P10501'] },
  CS200002: { exact: ['P10615'] },
  CS200003: { group: ['P10609', 'P10611'], partial: ['P10613'] },
  CS200004: { exact: ['P10627'] },
  CS200005: { group: ['P10601', 'P10603'], partial: ['P10613'] },
  CS200006: { group: ['Q10201', 'Q10202', 'Q10203', 'Q10204', 'Q10205', 'Q10206', 'Q10207', 'Q10208', 'Q10209', 'Q10212'], partial: ['Q10101', 'Q10102', 'Q10105'] },
  CS200007: { exact: ['Q10210'], partial: ['Q10103'] },
  CS200008: { exact: ['Q10211'], partial: ['Q10104'] },
  CS200009: { exact: ['M11101'] },
  CS200010: { exact: ['M10301'] },
  CS200011: { exact: ['M10302'] },
  CS200012: { exact: ['M10303'] },
  CS200013: { group: ['M10306', 'M10307', 'M10399'] },
  CS200014: { exact: ['M10401'] },
  CS200015: { exact: ['M10402'], partial: ['M10499'] },
  CS200016: { exact: ['R10310'] },
  CS200017: { exact: ['R10311'] },
  CS200018: { exact: ['R10309'] },
  CS200019: { exact: ['R10406'] },
  CS200020: { exact: ['R10404'] },
  CS200021: { group: ['R10405', 'R10499'], partial: ['R10414', 'R10408'] },
  CS200022: { exact: ['R10410'] },
  CS200023: { exact: ['S20201'] },
  CS200024: { group: ['R10307', 'R10306', 'R10308', 'R10312', 'R10313', 'R10316', 'R10314'] },
  CS200025: { exact: ['S20301'] },
  CS200026: { exact: ['S20302'] },
  CS200027: { exact: ['S20401'] },
  CS200028: { exact: ['S20701'] },
  CS200029: { exact: ['S20703'] },
  CS200030: { exact: ['S20702'], partial: ['S20803'] },
  CS200031: { group: ['S20901', 'S20902'] },
  CS200032: { exact: ['S20501'], partial: ['S20101'], note: '컴퓨터 수리는 별도 분류가 없어 근사' },
  CS200033: { exact: ['L10203'] },
  CS200034: { exact: ['I10102'], partial: ['I10101'] },
  CS200035: { partial: ['I10299', 'I10103'], note: '게스트하우스 전용 소분류 없음' },
  CS200036: { exact: ['I10201'] },
  CS200037: { exact: ['R10407'] },
  CS200038: { exact: ['R10202'] },
  CS200039: { exact: ['R10402'] },
  CS200040: { note: '녹음실 — 대응 소분류 없음' },
  CS200041: { exact: ['M11301'] },
  CS200042: { exact: ['M11502'] },
  CS200043: { exact: ['N10201'] },
  CS200044: { exact: ['N10501'], partial: ['N10599'] },
  CS200045: { group: ['N11002', 'N11003'] },
  CS200046: { exact: ['N11004'] },
  CS200047: { exact: ['N11099'], partial: ['N11001'] },
  CS300001: { exact: ['G20404'], partial: ['G20499'] },
  CS300002: { exact: ['G20405'] },
  CS300003: { exact: ['G20801'] },
  CS300004: { exact: ['G20802'] },
  CS300005: { partial: ['G20602'], note: '도매 분류 없음 — 주류 소매로 근사' },
  CS300006: { exact: ['G20501'] },
  CS300007: { exact: ['G20503'] },
  CS300008: { group: ['G20505', 'G20504'] },
  CS300009: { exact: ['G20506'] },
  CS300010: { exact: ['G20509'] },
  CS300011: { group: ['G20901', 'G20902', 'G20905'] },
  CS300012: { exact: ['G20904'] },
  CS300013: { exact: ['G20903'] },
  CS300014: { exact: ['G20910'] },
  CS300015: { exact: ['G20911'] },
  CS300016: { exact: ['G21602'] },
  CS300017: { exact: ['G21701'] },
  CS300018: { exact: ['G21501'] },
  CS300019: { exact: ['G21502'] },
  CS300020: { exact: ['G21301'] },
  CS300021: { exact: ['G21302'] },
  CS300022: { exact: ['G21503'] },
  CS300023: { note: '미용재료 — 대응 소분류 없음' },
  CS300024: { exact: ['G21304'] },
  CS300025: { exact: ['G21305'] },
  CS300026: { exact: ['G21306'] },
  CS300027: { group: ['G20909', 'G20906'] },
  CS300028: { exact: ['G21901'] },
  CS300029: { exact: ['G22001'] },
  CS300030: { partial: ['G22201'], note: '중고 상품 전체로 근사' },
  CS300031: { exact: ['G21101'] },
  CS300032: { exact: ['G20803'] },
  CS300033: { exact: ['G21001'] },
  CS300034: { exact: ['G21203'] },
  CS300035: { exact: ['G21002'], partial: ['M11201'], note: '상가정보로 정확한 대응 불가 — 디자인업은 사무실형이 많아 근사로만' },
  CS300036: { exact: ['G21201'] },
  CS300037: { note: '중고차판매 — 대응 소분류 없음' },
  CS300038: { group: ['G20202', 'G20201'] },
  CS300039: { exact: ['G20301'] },
  CS300040: { note: '재생용품 판매점 — 대응 소분류 없음' },
  CS300041: { exact: ['G21801'] },
  CS300042: { exact: ['G21401'], partial: ['G21402'] },
  CS300043: { note: '전자상거래업 — 점포 기반 분류 없음' },
};

// ── 공정위 업종(대분류>중분류) → 상가정보 소분류 ────────────
const FTC: Record<string, Rule> = {
  '외식>한식': { group: ['I201'] },
  '외식>중식': { group: ['I202'] },
  '외식>일식': { group: ['I203'] },
  '외식>서양식': { group: ['I204'] },
  '외식>기타 외국식': { group: ['I205', 'I20601'] },
  '외식>분식': { exact: ['I21007'] },
  '외식>치킨': { exact: ['I21006'] },
  '외식>피자': { exact: ['I21003'] },
  '외식>패스트푸드': { group: ['I21004', 'I21005'] },
  '외식>제과제빵': { group: ['I21001', 'I21002'] },
  '외식>아이스크림/빙수': { exact: ['I21008'] },
  '외식>커피': { exact: ['I21201'] },
  '외식>음료 (커피 외)': { partial: ['I21201'], note: '음료 전문점도 카페로 분류됨' },
  '외식>주점': { group: ['I211'] },
  '외식>기타 외식': { partial: ['I21099', 'I207'] },
  '도소매>편의점': { exact: ['G20405'] },
  '도소매>종합소매점': { group: ['G20404', 'G20499'] },
  '도소매>화장품': { exact: ['G21503'] },
  '도소매>의류 / 패션': { group: ['G209'] },
  '도소매>농수산물': { group: ['G20501', 'G20503', 'G20504', 'G20505', 'G20506'] },
  '도소매>(건강)식품': { exact: ['G20508'] },
  '도소매>기타도소매': { note: '범위가 넓어 대응하지 않음' },
  '서비스>PC방': { exact: ['R10406'] },
  '서비스>교육 (교과)': { exact: ['P10501'] },
  '서비스>교육 (외국어)': { exact: ['P10615'] },
  '서비스>기타 교육': { group: ['P10609', 'P10611', 'P10613', 'P10617', 'P10625', 'P10627', 'P10629'] },
  '서비스>반려동물 관련': { exact: ['G22001'], partial: ['M11101'] },
  '서비스>부동산 중개': { exact: ['L10203'] },
  '서비스>세탁': { group: ['S209'] },
  '서비스>숙박': { group: ['I101', 'I102'] },
  '서비스>스포츠 관련': { group: ['R103', 'P10601', 'P10603'] },
  '서비스>안경': { exact: ['G21602'] },
  '서비스>약국': { exact: ['G21501'] },
  '서비스>오락': { group: ['R10407', 'R10404', 'R10405', 'R10310'] },
  '서비스>이미용': { group: ['S207'] },
  '서비스>자동차 관련': { group: ['S20301', 'S20302'], partial: ['G20202'] },
  '서비스>임대': { group: ['N110', 'N109'] },
  '서비스>인력 파견': { group: ['N10401', 'N10402', 'N10403'] },
  '서비스>기타 서비스': { note: '범위가 넓어 대응하지 않음' },
  '서비스>운송': { note: '대응 소분류 없음' },
  '서비스>이사': { note: '대응 소분류 없음' },
  '서비스>배달': { note: '대응 소분류 없음' },
  '서비스>유아 관련 (교육 외)': { note: '대응 소분류 없음' },
  '서비스>유아관련': { note: '대응 소분류 없음' },
};

// ── 행 만들기 ─────────────────────────────────────────────
const scls = db.prepare('SELECT scls_cd, scls_nm FROM industry_store').all() as { scls_cd: string; scls_nm: string }[];
const expand = (p: string) => scls.filter((s) => s.scls_cd.startsWith(p));
const svcNames = new Map((db.prepare('SELECT svc_induty_cd c, svc_induty_cd_nm n FROM industry_svc').all() as { c: string; n: string }[]).map((r) => [r.c, r.n]));
const rows: Row[] = [];
const unknownPrefix: string[] = [];
function emit(system: string, code: string, codeNm: string, rule: Rule) {
  let any = false;
  for (const type of ['exact', 'group', 'partial'] as const)
    for (const p of rule[type] ?? []) {
      const hits = expand(p);
      if (!hits.length) unknownPrefix.push(`${code}:${p}`);
      for (const s of hits) {
        rows.push({ system, code, code_nm: codeNm, scls_cd: s.scls_cd, scls_nm: s.scls_nm, match_type: type, note: rule.note ?? '' });
        any = true;
      }
    }
  if (!any) rows.push({ system, code, code_nm: codeNm, scls_cd: '', scls_nm: '', match_type: 'none', note: rule.note ?? '' });
}
const missingSvc = [...svcNames.keys()].filter((c) => !SEOUL[c]);
for (const [code, rule] of Object.entries(SEOUL)) emit('seoul_svc', code, svcNames.get(code) ?? '', rule);
for (const [code, rule] of Object.entries(FTC)) emit('ftc', code, code.split('>')[1], rule);
upsert('industry_map', rows);

// ── 검증 1: 빠진 코드 ─────────────────────────────────────
const usedScls = new Set(rows.filter((r) => r.system === 'seoul_svc' && r.scls_cd).map((r) => r.scls_cd));
const unusedScls = scls.filter((s) => !usedScls.has(s.scls_cd));
const ftcActual = (db.prepare(`SELECT DISTINCT induty_lclas_nm || '>' || induty_mlsfc_nm k FROM franchise_brand_y`).all() as { k: string }[]).map((r) => r.k);
const missingFtc = ftcActual.filter((k) => !FTC[k]);
log(`서울 서비스업종 규칙 ${Object.keys(SEOUL).length}/${svcNames.size}, 규칙 없는 코드: ${missingSvc.join(',') || '없음'}`);
log(`공정위 업종 규칙 ${Object.keys(FTC).length}, 데이터에 있는데 규칙 없는 업종: ${missingFtc.join(', ') || '없음'}`);
log(`존재하지 않는 소분류 접두어: ${unknownPrefix.join(', ') || '없음'}`);
log(`서울 매핑에 안 쓰인 소분류 ${unusedScls.length}개 (서울 서비스업종 100개 밖의 업종)`);

// ── 검증 2: 서울 행정동별 점포수 비교 (최신 분기) ───────────
const q = (db.prepare('SELECT max(stdr_yyqu_cd) q FROM ta_store_q').get() as { q: string }).q;
const svcByAdm = db
  .prepare(
    `SELECT t.adstrd_cd adm, s.svc_induty_cd svc, sum(s.similr_induty_stor_co) n FROM ta_store_q s JOIN trade_area_seoul t ON t.trdar_cd = s.trdar_cd
     WHERE s.stdr_yyqu_cd = ? GROUP BY 1, 2`,
  )
  .all(q) as { adm: string; svc: string; n: number }[];
const sclsByAdm = db.prepare(`SELECT adong_cd adm, inds_scls_cd scls, count(*) n FROM store GROUP BY 1, 2`).all() as { adm: string; scls: string; n: number }[];
const adms = [...new Set(svcByAdm.map((r) => r.adm))];
const sclsIdx = new Map<string, number>();
for (const r of sclsByAdm) sclsIdx.set(`${r.adm}|${r.scls}`, r.n);
const pearson = (a: number[], b: number[]) => {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db2 += (b[i] - mb) ** 2;
  }
  return da && db2 ? num / Math.sqrt(da * db2) : NaN;
};
const report: Row[] = [];
for (const [code, rule] of Object.entries(SEOUL)) {
  const core = [...(rule.exact ?? []), ...(rule.group ?? [])].flatMap(expand).map((s) => s.scls_cd);
  if (!core.length) continue;
  const svcVec = adms.map((a) => svcByAdm.find((r) => r.adm === a && r.svc === code)?.n ?? 0);
  const sclsVec = adms.map((a) => core.reduce((sum, c) => sum + (sclsIdx.get(`${a}|${c}`) ?? 0), 0));
  const svcTotal = svcVec.reduce((x, y) => x + y, 0);
  const sclsTotal = sclsVec.reduce((x, y) => x + y, 0);
  report.push({ code, name: svcNames.get(code), r: Math.round(pearson(svcVec, sclsVec) * 100) / 100, 서울API: svcTotal, 상가정보: sclsTotal });
}
report.sort((a, b) => (a.r as number) - (b.r as number));
const weak = report.filter((x) => !((x.r as number) >= 0.6));
const rs = report.map((x) => x.r as number).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
log(`검증(${q}, 행정동 ${adms.length}개): 업종 ${report.length}개, 상관계수 중앙값 ${rs[Math.floor(rs.length / 2)]}, 0.6 미만 ${weak.length}개`);
for (const w of weak) log(`  약함 ${w.code} ${w.name}: r=${w.r}, 서울API ${w.서울API} / 상가정보 ${w.상가정보}`);

db.exec(`CREATE TABLE IF NOT EXISTS industry_map_check (code TEXT PRIMARY KEY, name TEXT, r REAL, seoul_api_cnt INTEGER, store_cnt INTEGER, quarter TEXT)`);
db.exec('DELETE FROM industry_map_check');
upsert('industry_map_check', report.map((x) => ({ code: x.code, name: x.name, r: x.r, seoul_api_cnt: x.서울API, store_cnt: x.상가정보, quarter: q })));
meta('industry_map', {
  source: '수작업 규칙 (etl/industry-map.ts)', std_period: `검증 ${q}`, status: 'loaded',
  note: `서울 서비스업종 100 + 공정위 업종 ${Object.keys(FTC).length} → 상가정보 소분류. 서울 행정동별 점포수 상관 r 중앙값 ${rs[Math.floor(rs.length / 2)]}, 0.6 미만 ${weak.length}개 (industry_map_check)`,
});
db.close();
