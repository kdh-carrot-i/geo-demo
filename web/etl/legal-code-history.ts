// Build region_legal_history (폐지 법정동코드 → 현재 코드) in data/commerce.sqlite, so older DW records
// (광주 29·전남 46 → 전남광주통합특별시 12, 강원 42 → 51, 전북 45 → 52, 인천 중구·동구·서구 → 제물포·영종·서해·검단구) join today's codes.
// Source: 행정표준코드관리시스템 법정동코드 전체자료 (data/raw/법정동코드 전체자료.txt, CP949, 폐지 코드 포함).
// The file has no old→new column, so codes are matched by name:
//   1) same 시도 group + same name below the 시도 ("광주광역시 광산구 송정동" → "전남광주통합특별시 광산구 송정동")
//   2) a 시군구 that was split or renamed (인천 중구 등): same 시도 + same name below the 시군구, if unique
//   3) a 시군구 or 시도 with no match of its own: the current 시군구/시도 its children went to, weighted by child count
// Usage: tsx etl/legal-code-history.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const FILE = resolve(DATA_DIR, 'raw', '법정동코드 전체자료.txt');
const lines = new TextDecoder('euc-kr').decode(readFileSync(FILE)).split(/\r?\n/).slice(1).filter(Boolean);
type Code = { cd: string; nm: string; alive: boolean };
const codes: Code[] = lines.map((l) => {
  const [cd, nm, st] = l.split('\t');
  return { cd, nm: nm.trim(), alive: st.trim() === '존재' };
});

/** 시도 group: old and new names of the same 시도 (광주직할시·광주광역시·전라남도 → 전남광주, 강원도 → 강원 …). */
function sidoGroup(sido: string) {
  if (/광주|전라남|전남/.test(sido)) return '전남광주';
  if (/전라북|전북/.test(sido)) return '전북';
  if (/충청북|충북/.test(sido)) return '충북';
  if (/충청남|충남/.test(sido)) return '충남';
  if (/경상북|경북/.test(sido)) return '경북';
  if (/경상남|경남/.test(sido)) return '경남';
  return sido.replace(/(특별자치시|특별자치도|특별시|광역시|직할시|도)$/, '');
}
const split = (nm: string) => {
  const [sido, ...rest] = nm.split(' ');
  return { group: sidoGroup(sido), rest };
};
const level = (cd: string) => (cd.slice(2) === '00000000' ? 'sido' : cd.slice(5) === '00000' ? 'sgg' : cd.slice(8) === '00' ? 'umd' : 'ri');

// index of current codes: group|full name below 시도, and group|name below 시군구 (for renamed 시군구)
const alive = codes.filter((c) => c.alive);
// a 면 promoted to 읍 keeps its name stem (문막면 → 문막읍): compare names with 읍·면 folded together
const fold = (s: string) => s.replace(/(\S)[읍면](?= |$)/g, '$1@');
const byRest = new Map<string, Code[]>();
const byTail = new Map<string, Code[]>();
const push = (m: Map<string, Code[]>, k: string, c: Code) => m.set(k, [...(m.get(k) ?? []), c]);
for (const c of alive) {
  const { group, rest } = split(c.nm);
  push(byRest, `${group}|${rest.join(' ')}`, c);
  // below the 시군구 token(s): "수원시 장안구 연무동" → "연무동"; only 읍면동·리 levels
  if (level(c.cd) === 'umd' || level(c.cd) === 'ri') push(byTail, `${group}|${level(c.cd)}|${tailOf(c.nm)}`, c);
}
const byRestFolded = new Map<string, Code[]>();
for (const c of alive) {
  const { group, rest } = split(c.nm);
  push(byRestFolded, `${group}|${fold(rest.join(' '))}`, c);
}
function tailOf(nm: string) {
  // drop 시도 and every 시·군·구 token: what remains is 읍면동 (+ 리)
  const rest = nm.split(' ').slice(1);
  let i = 0;
  while (i < rest.length - 1 && /(시|군|구)$/.test(rest[i])) i++;
  return rest.slice(i).join(' ');
}
const sidoAlive = new Map(alive.filter((c) => level(c.cd) === 'sido').map((c) => [split(c.nm).group, c]));

const rows: Row[] = [];
const matched = new Map<string, Code>();
const dead = codes.filter((c) => !c.alive);
let byName = 0;
let byDong = 0;
for (const c of dead) {
  const lv = level(c.cd);
  if (lv === 'sido' || lv === 'sgg') continue; // 3) below
  const { group, rest } = split(c.nm);
  let hits = byRest.get(`${group}|${rest.join(' ')}`) ?? [];
  let type = 'name';
  if (hits.length !== 1) {
    hits = byTail.get(`${group}|${lv}|${tailOf(c.nm)}`) ?? [];
    type = 'dong-name';
  }
  if (hits.length !== 1) {
    hits = (byRestFolded.get(`${group}|${fold(rest.join(' '))}`) ?? []).filter((h) => level(h.cd) === lv);
    type = 'eup-myeon';
  }
  if (hits.length !== 1 || hits[0].cd === c.cd) continue;
  matched.set(c.cd, hits[0]);
  type === 'name' ? byName++ : byDong++;
  const NOTE: Record<string, string | null> = { name: null, 'dong-name': '시군구 이름이 바뀌어 읍면동 이름으로 매칭', 'eup-myeon': '면 → 읍 승격 (또는 반대)' };
  rows.push({ old_cd: c.cd, old_nm: c.nm, new_cd: hits[0].cd, new_nm: hits[0].nm, level: lv, weight: 1, match_type: type, note: NOTE[type] });
}

// 2b) same 읍면동 name in two new 시군구 (인천 동구 금곡동 vs 서구 금곡동): keep the candidate in a 시군구
// where the other 읍면동 of the old 시군구 went
const destOf = new Map<string, Set<string>>();
for (const [old, now] of matched) {
  const k = old.slice(0, 5);
  destOf.set(k, (destOf.get(k) ?? new Set()).add(now.cd.slice(0, 5)));
}
for (const c of dead) {
  const lv = level(c.cd);
  if (matched.has(c.cd) || (lv !== 'umd' && lv !== 'ri')) continue;
  const dest = destOf.get(c.cd.slice(0, 5));
  const hits = (byTail.get(`${split(c.nm).group}|${lv}|${tailOf(c.nm)}`) ?? []).filter((h) => dest?.has(h.cd.slice(0, 5)));
  if (hits.length !== 1) continue;
  matched.set(c.cd, hits[0]);
  byDong++;
  rows.push({ old_cd: c.cd, old_nm: c.nm, new_cd: hits[0].cd, new_nm: hits[0].nm, level: lv, weight: 1, match_type: 'dong-name', note: '같은 이름 동이 여럿: 옛 시군구의 다른 동이 옮겨 간 시군구로 판정' });
}

// 3) 시군구·시도: same name if unique, else where the children went
let sggRows = 0;
for (const c of dead) {
  const lv = level(c.cd);
  if (lv !== 'sido' && lv !== 'sgg') continue;
  const { group, rest } = split(c.nm);
  if (lv === 'sido') {
    const now = sidoAlive.get(group);
    if (now && now.cd !== c.cd) rows.push({ old_cd: c.cd, old_nm: c.nm, new_cd: now.cd, new_nm: now.nm, level: lv, weight: 1, match_type: 'name', note: null });
    continue;
  }
  const same = (byRest.get(`${group}|${rest.join(' ')}`) ?? []).filter((x) => level(x.cd) === 'sgg');
  if (same.length === 1 && same[0].cd !== c.cd) {
    rows.push({ old_cd: c.cd, old_nm: c.nm, new_cd: same[0].cd, new_nm: same[0].nm, level: lv, weight: 1, match_type: 'name', note: null });
    sggRows++;
    continue;
  }
  const prefix = c.cd.slice(0, 5);
  const counts = new Map<string, number>();
  for (const [old, now] of matched) if (old.startsWith(prefix) && level(old) === 'umd') counts.set(now.cd.slice(0, 5), (counts.get(now.cd.slice(0, 5)) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  for (const [sgg5, n] of counts) {
    const now = alive.find((x) => x.cd === `${sgg5}00000`);
    if (!now) continue;
    rows.push({ old_cd: c.cd, old_nm: c.nm, new_cd: now.cd, new_nm: now.nm, level: lv, weight: Math.round((n / total) * 1000) / 1000, match_type: 'children', note: `하위 읍면동 ${n}/${total}곳이 옮겨 간 시군구` });
    sggRows++;
  }
}

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec('DELETE FROM region_legal_history');
upsert('region_legal_history', rows);

// coverage for the recent restructurings (the codes older DW records actually use)
const recent = (cd: string) => /^(29|46|42|45)/.test(cd) || /^(28110|28140|28260)/.test(cd);
const deadRecent = dead.filter((c) => recent(c.cd));
const linked = new Set(rows.map((r) => r.old_cd));
const missRecent = deadRecent.filter((c) => !linked.has(c.cd));
log(`폐지 ${dead.length}, 연결 ${linked.size} (이름 ${byName}, 읍면동 이름 ${byDong}, 시군구·시도 ${rows.length - byName - byDong})`);
log(`최근 개편 지역(광주·전남·강원·전북·인천 중/동/서구) 폐지 ${deadRecent.length} 중 미연결 ${missRecent.length}`);
log(`미연결 예: ${missRecent.slice(0, 15).map((c) => `${c.cd} ${c.nm}`).join(' / ')}`);
meta('region_legal_history', {
  source: '행정표준코드관리시스템 법정동코드 전체자료 (폐지 코드 포함)', endpoint: 'data/raw/법정동코드 전체자료.txt', std_period: '2026-11', status: 'loaded',
  note: `폐지 코드 → 현재 코드 (이름 매칭, 공식 대응표 아님). 연결 ${linked.size}/${dead.length}`,
});
db.close();
