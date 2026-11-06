// Build region_code_map (지역 코드 대응표) in data/commerce.sqlite.
//   sido / sgg : 법정동코드(region_legal) ↔ SGIS 시도·시군구 (SGIS addr/stage, ~18 calls), matched by name
//   dong       : 법정동 ↔ 행정동 from store co-occurrence (weight = store share), 행정동 ↔ SGIS 행정동 by name within the 시군구
// Usage: tsx etl/region-map.ts
import { resolve } from 'node:path';
import { DATA_DIR, E, getJson, log, openDb, type Row } from './lib.ts';

const { db, upsert, meta, dropCache } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec('DROP TABLE IF EXISTS region_code_map');
dropCache('region_code_map');
db.exec(`CREATE TABLE region_code_map (
  level TEXT, sido_cd TEXT, sgg_cd TEXT, bjd_cd TEXT, adm_cd TEXT, sgis_cd TEXT,
  name TEXT, sgis_name TEXT, weight REAL, match_type TEXT, valid_from TEXT, valid_to TEXT, note TEXT,
  PRIMARY KEY (level, sgg_cd, bjd_cd, adm_cd, sgis_cd));
  CREATE INDEX ix_rcm_adm ON region_code_map (adm_cd);
  CREATE INDEX ix_rcm_sgis ON region_code_map (sgis_cd);`);

/** Name key: no spaces or separators, so "종로1.2.3.4가동" = "종로1·2·3·4가동" and "수원시 장안구" = "수원시장안구". */
const norm = (s: string) => s.replace(/[\s·.,()]/g, '');
/** 시도 group key: the 2026 merged 전남광주통합특별시 covers SGIS's 광주광역시 and 전라남도. */
const sidoGroup = (name: string) => (/전남광주|광주광역시|전라남도/.test(name) ? '전남광주' : norm(name));

// Manual mappings for restructurings that name matching cannot see (SGIS boundaries are 2024; 법정동 codes are 2026).
// 2026-07-01 인천 행정체제 개편: 중구·동구·서구 → 제물포구·영종구·서해구·검단구 (구역 비율 미반영, 확인 필요)
const SGG_RESTRUCTURE: Record<string, { sgis: string[]; note: string }> = {
  '28125': { sgis: ['23010', '23020'], note: '제물포구 ← 중구(영종 제외)+동구, 2026-07-01 개편 — 확인 필요' },
  '28155': { sgis: ['23010'], note: '영종구 ← 중구 영종·용유, 2026-07-01 개편 — 확인 필요' },
  '28275': { sgis: ['23080'], note: '서해구 ← 서구(검단 제외), 2026-07-01 개편 — 확인 필요' },
  '28290': { sgis: ['23080'], note: '검단구 ← 서구 검단, 2026-07-01 개편 — 확인 필요' },
};
// 행정동 분동: SGIS 2024 still has the pre-split dong
const DONG_SPLIT: Record<string, { sgis: string; note: string }> = {
  '11230515': { sgis: '11060810', note: '신설동 ← 용신동 분동 (SGIS 2024는 분동 전)' },
  '11230533': { sgis: '11060810', note: '용두동 ← 용신동 분동 (SGIS 2024는 분동 전)' },
};
// 서울 생활인구 API still uses pre-renumbering 행정동 codes (no names in that API, so matched by code order).
// 확인 필요: 행정안전부 행정동 변경내역 파일로 검증할 것.
const LEGACY_CODE: Record<string, { now: string; note: string }> = {
  '11305590': { now: '11305595', note: '강북구 번1동 코드 변경 추정' },
  '11305600': { now: '11305603', note: '강북구 번2동 코드 변경 추정' },
  '11305606': { now: '11305608', note: '강북구 번3동 코드 변경 추정' },
  '11305610': { now: '11305615', note: '강북구 수유1동 코드 변경 추정' },
  '11305620': { now: '11305625', note: '강북구 수유2동 코드 변경 추정' },
  '11305630': { now: '11305635', note: '강북구 수유3동 코드 변경 추정' },
  '11680740': { now: '11680675', note: '강남구 일원2동 → 개포3동 추정' },
};
// same place, different official names
const SGG_ALIAS: Record<string, string> = { 세종특별자치시: '세종시' };

// ── SGIS 시도·시군구 목록 ─────────────────────────────────
const H = 'https://sgisapi.mods.go.kr/OpenAPI3';
const at = (await getJson(`${H}/auth/authentication.json?consumer_key=${E.SGIS_SERVICE_ID}&consumer_secret=${E.SGIS_SECRET_KEY}`)).result.accessToken;
const sgisSido = ((await getJson(`${H}/addr/stage.json?accessToken=${at}`, ['sgis', 'stage_sido'])).result ?? []) as Row[];
const sgisSgg: { cd: string; name: string; sido: string }[] = [];
for (const s of sgisSido) {
  const j = await getJson(`${H}/addr/stage.json?accessToken=${at}&cd=${s.cd}`, ['sgis', `stage_${s.cd}`]);
  for (const g of (j.result ?? []) as Row[]) sgisSgg.push({ cd: String(g.cd), name: String(g.addr_name), sido: String(s.addr_name) });
}
log(`SGIS 시도 ${sgisSido.length}, 시군구 ${sgisSgg.length}`);

// ── 법정동 시도·시군구 ────────────────────────────────────
type Legal = { bjd_cd: string; sido_cd: string; sgg_cd: string; locatadd_nm: string; locallow_nm: string; adpt_de: string };
const legalSido = db.prepare(`SELECT * FROM region_legal WHERE sgg_cd='000' AND umd_cd='000'`).all() as Legal[];
const legalSgg = db.prepare(`SELECT * FROM region_legal WHERE sgg_cd<>'000' AND umd_cd='000' AND ri_cd='00'`).all() as Legal[];
// 세종(36) has no 시도-level row in the 2026 code list; derive its name from the 시군구 row
const sidoName = new Map(legalSido.map((r) => [r.sido_cd, r.locatadd_nm]));
for (const r of legalSgg) if (!sidoName.has(r.sido_cd)) sidoName.set(r.sido_cd, r.locatadd_nm.split(' ')[0]);

const rows: Row[] = [];

// sido
const unmatchedSido: string[] = [];
for (const [cd, name] of sidoName) {
  const hits = sgisSido.filter((s) => sidoGroup(String(s.addr_name)) === sidoGroup(name));
  if (!hits.length) unmatchedSido.push(`${cd} ${name}`);
  const from = legalSido.find((r) => r.sido_cd === cd)?.adpt_de ?? '';
  for (const s of hits)
    rows.push({ level: 'sido', sido_cd: cd, sgg_cd: '', bjd_cd: '', adm_cd: '', sgis_cd: s.cd, name, sgis_name: s.addr_name, weight: 1 / hits.length, match_type: hits.length > 1 ? 'name-merged' : 'name', valid_from: from, valid_to: '' });
}

// sgg: match "시도그룹 + 시군구명(시도 이름 제외)"
const sggKey = (sidoName: string, rest: string) => `${sidoGroup(sidoName)}|${norm(rest)}`;
const sgisByKey = new Map<string, (typeof sgisSgg)[number][]>();
for (const g of sgisSgg) {
  const k = sggKey(g.sido, g.name);
  sgisByKey.set(k, [...(sgisByKey.get(k) ?? []), g]);
}
const unmatchedSgg: string[] = [];
const legalToSgisSgg = new Map<string, string>();
const sgisByCd = new Map(sgisSgg.map((g) => [g.cd, g]));
for (const r of legalSgg) {
  const [sido, ...rest] = r.locatadd_nm.split(' ');
  const sgg5 = r.bjd_cd.slice(0, 5);
  // 세종 has no 시군구 token of its own: the 시도 name doubles as the 시군구 name
  const sggName = rest.join('') || (SGG_ALIAS[sido] ?? sido);
  let hits = sgisByKey.get(sggKey(sido, sggName)) ?? [];
  let matchType = 'name';
  let note = '';
  if (!hits.length && SGG_RESTRUCTURE[sgg5]) {
    hits = SGG_RESTRUCTURE[sgg5].sgis.map((c) => sgisByCd.get(c)!).filter(Boolean);
    matchType = 'restructure';
    note = SGG_RESTRUCTURE[sgg5].note;
  }
  if (!hits.length && rest.length === 2) {
    // a new 일반구 (e.g. 화성시 병점구) that SGIS still records only as its parent city
    hits = sgisByKey.get(sggKey(sido, rest[0])) ?? [];
    matchType = 'parent';
    note = `SGIS에는 상위 시(${rest[0]})만 있음`;
  }
  if (hits.length === 1) legalToSgisSgg.set(sgg5, hits[0].cd);
  if (hits.length) {
    for (const g of hits)
      rows.push({ level: 'sgg', sido_cd: r.sido_cd, sgg_cd: sgg5, bjd_cd: '', adm_cd: '', sgis_cd: g.cd, name: r.locatadd_nm, sgis_name: `${g.sido} ${g.name}`, weight: matchType === 'name' ? 1 / hits.length : null, match_type: matchType, valid_from: r.adpt_de, valid_to: '', note });
    continue;
  }
  // a city that only exists as a parent of 일반구 (e.g. 수원시) has no SGIS row of its own
  const hasChildren = legalSgg.some((x) => x !== r && x.locatadd_nm.startsWith(r.locatadd_nm + ' '));
  if (!hasChildren) unmatchedSgg.push(`${sgg5} ${r.locatadd_nm}`);
}

// dong (where store data exists): 법정동 ↔ 행정동 by store co-occurrence, 행정동 ↔ SGIS by name within the 시군구
const pairs = db
  .prepare(
    `SELECT ldong_cd bjd_cd, max(ldong_nm) ldong_nm, adong_cd adm_cd, max(adong_nm) adong_nm, max(signgu_cd) sgg_cd, max(signgu_nm) sgg_nm, count(*) n
     FROM store WHERE ldong_cd IS NOT NULL AND adong_cd IS NOT NULL GROUP BY ldong_cd, adong_cd`,
  )
  .all() as { bjd_cd: string; ldong_nm: string; adm_cd: string; adong_nm: string; sgg_cd: string; sgg_nm: string; n: number }[];
const perLegal = new Map<string, number>();
for (const p of pairs) perLegal.set(p.bjd_cd, (perLegal.get(p.bjd_cd) ?? 0) + p.n);
const sgisDong = db.prepare(`SELECT sgis_adm_cd cd, adm_nm nm FROM sgis_adm_stats`).all() as { cd: string; nm: string }[];
const admToSgis = new Map<string, { cd: string; nm: string } | null>();
for (const p of pairs) {
  if (admToSgis.has(p.adm_cd)) continue;
  const sgisSgg5 = legalToSgisSgg.get(p.sgg_cd);
  // 인천 개편 구(제물포구 등)는 SGIS 2024의 옛 구 여러 곳에 걸쳐 있다: 그 안에서 같은 이름의 행정동을 찾는다
  const sggs = sgisSgg5 ? [sgisSgg5] : (SGG_RESTRUCTURE[p.sgg_cd]?.sgis ?? []);
  const cands = sgisDong.filter((d) => sggs.some((s) => d.cd.startsWith(s)) && norm(d.nm) === norm(p.adong_nm));
  const split = DONG_SPLIT[p.adm_cd] && sgisDong.find((d) => d.cd === DONG_SPLIT[p.adm_cd].sgis);
  // 2024 이후 번호 분동 (운서동 → 운서1동·운서2동): SGIS에는 분동 전 이름만 있다
  // 면 → 읍 승격 (양지면 → 양지읍)도 같은 방식
  const parentNm = norm(p.adong_nm).replace(/\d+동$/, '동').replace(/읍$/, '면');
  const parent = parentNm !== norm(p.adong_nm) ? sgisDong.filter((d) => sggs.some((s) => d.cd.startsWith(s)) && norm(d.nm) === parentNm) : [];
  admToSgis.set(p.adm_cd, cands.length === 1 ? cands[0] : split ?? (parent.length === 1 ? parent[0] : null));
}
const legalFrom = new Map((db.prepare(`SELECT bjd_cd, adpt_de FROM region_legal`).all() as { bjd_cd: string; adpt_de: string }[]).map((r) => [r.bjd_cd, r.adpt_de]));
for (const p of pairs) {
  const s = admToSgis.get(p.adm_cd);
  rows.push({
    level: 'dong', sido_cd: p.bjd_cd.slice(0, 2), sgg_cd: p.sgg_cd, bjd_cd: p.bjd_cd, adm_cd: p.adm_cd, sgis_cd: s?.cd ?? '',
    name: `${p.sgg_nm} ${p.ldong_nm} → ${p.adong_nm}`, sgis_name: s?.nm ?? '', weight: Math.round((p.n / perLegal.get(p.bjd_cd)!) * 1000) / 1000,
    match_type: !s ? 'store' : DONG_SPLIT[p.adm_cd] ? 'store+split' : 'store+name', valid_from: legalFrom.get(p.bjd_cd) ?? '', valid_to: '',
    note: [`점포 ${p.n}`, DONG_SPLIT[p.adm_cd]?.note].filter(Boolean).join('; '),
  });
}
// Seoul API 행정동 codes (상권·생활인구) that store does not use: pre-split codes such as 용신동, 상일동.
// Link them to SGIS by exact name, else to the numbered dongs that replaced them (상일동 → 상일1동, 상일2동).
const legacy = db
  .prepare(
    `SELECT DISTINCT adstrd_cd cd, adstrd_cd_nm nm, signgu_cd sgg FROM trade_area_seoul
     WHERE adstrd_cd NOT IN (SELECT DISTINCT adong_cd FROM store WHERE adong_cd IS NOT NULL)`,
  )
  .all() as { cd: string; nm: string; sgg: string }[];
const legacyLog: string[] = [];
for (const l of legacy) {
  const sgisSgg5 = legalToSgisSgg.get(l.sgg);
  const inSgg = sgisSgg5 ? sgisDong.filter((d) => d.cd.startsWith(sgisSgg5)) : [];
  const exact = inSgg.filter((d) => norm(d.nm) === norm(l.nm));
  const stem = norm(l.nm).replace(/동$/, '');
  const numbered = exact.length ? [] : inSgg.filter((d) => new RegExp(`^${stem}\\d+동$`).test(norm(d.nm)));
  const hits = exact.length ? exact : numbered;
  legacyLog.push(`${l.cd} ${l.nm} → ${hits.map((h) => h.nm).join('+') || '없음'}`);
  for (const h of hits)
    rows.push({
      level: 'dong', sido_cd: '11', sgg_cd: l.sgg, bjd_cd: '', adm_cd: l.cd, sgis_cd: h.cd, name: `${l.nm} (서울 API 구코드)`, sgis_name: h.nm,
      weight: Math.round((1 / hits.length) * 1000) / 1000, match_type: exact.length ? 'legacy-name' : 'legacy-split', valid_from: '', valid_to: '',
      note: '서울 상권·생활인구 API가 쓰는 분동 전 행정동 코드',
    });
}
// 생활인구 old codes → reuse the SGIS link of the current code
for (const [old, { now, note }] of Object.entries(LEGACY_CODE)) {
  const cur = admToSgis.get(now);
  const curName = pairs.find((p) => p.adm_cd === now)?.adong_nm ?? '';
  if (!cur) continue;
  rows.push({
    level: 'dong', sido_cd: '11', sgg_cd: old.slice(0, 5), bjd_cd: '', adm_cd: old, sgis_cd: cur.cd, name: `${curName} (생활인구 구코드 ${old} → ${now})`, sgis_name: cur.nm,
    weight: 1, match_type: 'legacy-code', valid_from: '', valid_to: '', note: `${note} — 확인 필요`,
  });
  legacyLog.push(`${old} → ${now} ${curName}`);
}
upsert('region_code_map', rows);
log(`서울 API 구코드 행정동 ${legacyLog.length}: ${legacyLog.join(' / ')}`);

// ── 결과 요약 ────────────────────────────────────────────
const admTotal = admToSgis.size;
const admLinked = [...admToSgis.values()].filter(Boolean).length;
const unlinkedAdm = [...admToSgis].filter(([, v]) => !v).map(([k]) => k);
const unlinkedNames = unlinkedAdm.map((c) => pairs.find((p) => p.adm_cd === c)!).map((p) => `${p.adm_cd} ${p.sgg_nm} ${p.adong_nm}`);
log(`sido 행 ${rows.filter((r) => r.level === 'sido').length}, 미매칭 ${unmatchedSido.length} ${unmatchedSido.join(' / ')}`);
log(`sgg 행 ${rows.filter((r) => r.level === 'sgg').length}, 법정 시군구 ${legalSgg.length} 중 미매칭 ${unmatchedSgg.length}: ${unmatchedSgg.join(' / ')}`);
log(`dong 행 ${pairs.length} (법정동 ${perLegal.size} × 행정동 ${admTotal}), 행정동→SGIS 연결 ${admLinked}/${admTotal}`);
if (unlinkedNames.length) log(`SGIS 미연결 행정동: ${unlinkedNames.join(' / ')}`);
meta('region_code_map', {
  source: '법정동코드 + SGIS 행정구역 + 상가정보 점포 위치', endpoint: 'SGIS addr/stage, store', std_period: '2026-10 (법정동 2026-07-01 개편 반영)', status: 'loaded',
  note: `시도·시군구·동 전국 (동 단위는 상가정보 점포 위치 기준). 행정동→SGIS ${admLinked}/${admTotal}. 시군구 미매칭 ${unmatchedSgg.length}`,
});
db.close();
