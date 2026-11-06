// 브랜드 별칭 표: 공정위 가맹사업 등록명(franchise_brand_y) ↔ 상가정보 상호(store.bizes_nm)를 잇는다.
// 등록명은 "메가엠지씨커피(MEGA MGC COFFEE)", 간판·상호는 "메가커피 강남역점"처럼 달라서 이름만으로는 못 찾는다.
//   brand_member  연도별 등록명 → 대표 브랜드 (같은 가맹본부가 해마다 표기를 바꿔도 하나로: "지에스25(GS25)" → "GS25")
//   brand_group   대표 브랜드 (최신 연도 등록명) + 가맹점 수 + 상가정보에서 찾은 매장 수
//   brand_alias   정규화한 별칭 → 대표 브랜드 (등록명·괄호/슬래시 부분·업종 꼬리말 뗀 이름·수동 별칭)
// 매칭 규칙은 server/agent/brand-name.ts. API 호출 없음 — 공정위·상가정보를 다시 적재한 뒤 돌린다.
//
//   npx tsx etl/brand-alias.ts
import { resolve } from 'node:path';
import { aliasesOf, matchPrefix, normName, type AliasKind } from '../server/agent/brand-name.ts';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

/** 간판·상호에 흔한 표기 → 공정위 등록명 (등록명에서 자동으로 못 만드는 것만). 상가정보에서 많이 안 잡히는 큰 브랜드를 보고 채웠다 */
const MANUAL: [string, string][] = [
  ['메가커피', '메가엠지씨커피(MEGA MGC COFFEE)'],
  ['메가mgc커피', '메가엠지씨커피(MEGA MGC COFFEE)'],
  ['megacoffee', '메가엠지씨커피(MEGA MGC COFFEE)'],
  ['컴포즈', '컴포즈커피(COMPOSE COFFEE)'],
  ['이디야', '이디야커피'],
  ['처갓집', '처갓집양념치킨'],
  ['씨유', '씨유(CU)'],
  ['지에스25', 'GS25'],
  ['gs편의점', 'GS25'],
  ['세븐일레븐', '세븐일레븐'],
  ['7eleven', '세븐일레븐'],
  ['이마트24', '이마트24(emart24)'],
  ['파리바게트', '파리바게뜨'],
  ['bbq', '비비큐(BBQ)'],
  ['bbq치킨', '비비큐(BBQ)'],
  ['bhc', '비에이치씨(BHC)'],
  ['bhc치킨', '비에이치씨(BHC)'],
  ['배스킨라빈스31', '배스킨라빈스'],
  ['베스킨라빈스', '배스킨라빈스'],
  ['투썸', '투썸플레이스'],
  ['a투썸플레이스', '투썸플레이스'],
  ['본죽', '본죽&비빔밥'],
  ['본죽비빔밥', '본죽&비빔밥'],
  ['동대문엽기떡볶이', '불닭발땡초동대문엽기떡볶이'],
  ['엽기떡볶이', '불닭발땡초동대문엽기떡볶이'],
  ['불닭발동대문엽기떡볶이', '불닭발땡초동대문엽기떡볶이'],
  ['던킨도너츠', '던킨/던킨도너츠'],
  ['던킨', '던킨/던킨도너츠'],
  ['매머드커피', '매머드익스프레스(Mammoth Express)'],
  ['매머드익스프레스', '매머드익스프레스(Mammoth Express)'],
  ['텐퍼센트커피', '텐퍼센트스페셜티커피'],
  ['텐퍼센트', '텐퍼센트스페셜티커피'],
  ['60계치킨', '60계'],
  ['호식이두마리', '호식이두마리치킨'],
  ['역전할머니맥주', '역전할머니맥주1982'],
  ['명륜진사갈비', '명륜진사갈비'],
  ['맘스터치', '맘스터치'],
  ['현대자동차블루핸즈', '블루핸즈(bluehands)'],
  ['현대블루핸즈', '블루핸즈(bluehands)'],
  ['두마리찜닭두찜', '두찜'],
  ['지코바', '지코바양념치킨'],
  ['gs더프레시', 'GS THE FRESH'],
  ['지에스더프레시', 'GS THE FRESH'],
];

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec('DELETE FROM brand_member; DELETE FROM brand_group; DELETE FROM brand_alias;');

// ── 1. 연도별 등록명을 대표 브랜드로 묶기 (union-find) ──
type Brand = { yr: string; corp_nm: string; brand_nm: string; frcs_cnt: number | null; induty_mlsfc_nm: string };
const rows = db.prepare('SELECT yr, corp_nm, brand_nm, frcs_cnt, induty_mlsfc_nm FROM franchise_brand_y WHERE brand_nm IS NOT NULL').all() as Brand[];
const parent = rows.map((_, i) => i);
const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const union = (a: number, b: number) => void (parent[find(a)] = find(b));
// 같은 가맹본부 안에서 별칭(꼬리말 뗀 것 제외)이 겹치면 같은 브랜드
const byCorpAlias = new Map<string, number>();
rows.forEach((r, i) => {
  for (const a of aliasesOf(r.brand_nm).filter((x) => x.kind !== 'derived')) {
    const k = `${normName(r.corp_nm ?? '')}|${a.alias}`;
    const j = byCorpAlias.get(k);
    if (j === undefined) byCorpAlias.set(k, i);
    else union(i, j);
  }
});
// 가맹본부가 바뀌어도 등록명이 같고 같은 해에 겹치지 않으면 같은 브랜드 (양도·법인 전환)
const byFull = new Map<string, number[]>();
rows.forEach((r, i) => byFull.set(normName(r.brand_nm), [...(byFull.get(normName(r.brand_nm)) ?? []), i]));
for (const is of byFull.values()) {
  const yrs = is.map((i) => rows[i].yr);
  if (is.length > 1 && new Set(yrs).size === yrs.length) is.slice(1).forEach((i) => union(i, is[0]));
}
const members = new Map<number, number[]>();
rows.forEach((_, i) => members.set(find(i), [...(members.get(find(i)) ?? []), i]));

// 대표 이름 = 최신 연도에서 가맹점 수가 가장 많은 등록명. 이름이 겹치면 가맹본부를 붙인다
interface Group { nm: string; head: Brand; idx: number[] }
const groups: Group[] = [...members.values()].map((idx) => {
  const head = idx.map((i) => rows[i]).sort((a, b) => b.yr.localeCompare(a.yr) || (b.frcs_cnt ?? 0) - (a.frcs_cnt ?? 0))[0];
  return { nm: head.brand_nm, head, idx };
});
const nameCount = new Map<string, number>();
for (const g of groups) nameCount.set(g.nm, (nameCount.get(g.nm) ?? 0) + 1);
for (const g of groups) if (nameCount.get(g.nm)! > 1) g.nm = `${g.head.brand_nm} [${g.head.corp_nm}]`;
const frcs = (g: Group) => g.head.frcs_cnt ?? 0;
log(`공정위 등록명 ${rows.length}건 → 대표 브랜드 ${groups.length}개`);

// ── 2. 별칭 → 대표 브랜드. 같은 별칭을 여러 브랜드가 내면 종류(수동 > 등록명 > 부분 > 꼬리말 뗌) → 가맹점 수 순 ──
const RANK: Record<AliasKind, number> = { manual: 0, ftc: 1, part: 2, derived: 3 };
const cand = new Map<string, { g: Group; kind: AliasKind }[]>();
for (const g of groups) {
  const seen = new Map<string, AliasKind>();
  for (const i of g.idx) for (const a of aliasesOf(rows[i].brand_nm)) if (!seen.has(a.alias) || RANK[a.kind] < RANK[seen.get(a.alias)!]) seen.set(a.alias, a.kind);
  for (const [alias, kind] of seen) cand.set(alias, [...(cand.get(alias) ?? []), { g, kind }]);
}
const alias = new Map<string, { g: Group; kind: AliasKind }>();
let ambiguous = 0;
for (const [a, cs] of cand) {
  const best = Math.min(...cs.map((c) => RANK[c.kind]));
  const top = cs.filter((c) => RANK[c.kind] === best).sort((x, y) => frcs(y.g) - frcs(x.g));
  // 같은 등록명을 가맹본부 여럿이 따로 낸 경우(지역 본부 등)가 대부분이라 가맹점 수가 가장 많은 쪽으로
  alias.set(a, top[0]);
  if (top.length > 1) ambiguous++;
}
const byHeadName = new Map(groups.map((g) => [g.head.brand_nm, g]));
for (const [a, target] of MANUAL) {
  const g = byHeadName.get(target) ?? groups.find((x) => x.idx.some((i) => rows[i].brand_nm === target));
  if (!g) {
    log(`수동 별칭 대상 없음: ${a} → ${target}`);
    continue;
  }
  alias.set(normName(a), { g, kind: 'manual' });
}
log(`별칭 ${alias.size}개 (여러 브랜드가 낸 별칭 ${ambiguous}개는 가맹점 수가 많은 쪽으로)`);

// ── 3. 상가정보 전 점포에 규칙을 돌려 브랜드별 매장 수 (매칭률 점검용) ──
const nStore = new Map<Group, number>();
const nAlias = new Map<string, number>();
let total = 0;
let hit = 0;
for (const s of db.prepare('SELECT bizes_nm, brch_nm FROM store WHERE bizes_nm IS NOT NULL').iterate() as Iterable<{ bizes_nm: string; brch_nm: string | null }>) {
  total++;
  const m = matchPrefix(s.bizes_nm, (a) => alias.get(a), s.brch_nm);
  if (!m) continue;
  hit++;
  nStore.set(m.value.g, (nStore.get(m.value.g) ?? 0) + 1);
  nAlias.set(m.alias, (nAlias.get(m.alias) ?? 0) + 1);
}
log(`상가정보 ${total.toLocaleString()}곳 중 브랜드 매칭 ${hit.toLocaleString()}곳 (${((100 * hit) / total).toFixed(1)}%)`);

// ── 4. 저장 ──
const member: Row[] = groups.flatMap((g) => g.idx.map((i) => ({ yr: rows[i].yr, corp_nm: rows[i].corp_nm, brand_nm: rows[i].brand_nm, group_nm: g.nm })));
upsert('brand_member', member);
const aliasCount = new Map<Group, number>();
for (const v of alias.values()) aliasCount.set(v.g, (aliasCount.get(v.g) ?? 0) + 1);
upsert('brand_group', groups.map((g) => ({ group_nm: g.nm, corp_nm: g.head.corp_nm, induty_mlsfc_nm: g.head.induty_mlsfc_nm, yr: g.head.yr, frcs_cnt: g.head.frcs_cnt, n_store: nStore.get(g) ?? 0, n_alias: aliasCount.get(g) ?? 0 })));
upsert('brand_alias', [...alias].map(([a, v]) => ({ alias: a, group_nm: v.g.nm, kind: v.kind, n_store: nAlias.get(a) ?? 0 })));
const period = (db.prepare("SELECT std_period p FROM meta_source WHERE table_name = 'store'").get() as { p?: string } | undefined)?.p ?? '';
const note = `상가정보 ${total}곳 중 ${hit}곳 매칭`;
for (const t of ['brand_member', 'brand_group', 'brand_alias'])
  meta(t, { source: '공정위 가맹사업 정보공개 + 상가정보 상호 (파생)', endpoint: 'etl/brand-alias.ts', std_period: period, status: 'ok', note });

// 큰 브랜드인데 상가정보에서 적게 잡히는 것: 수동 별칭 후보
const weak = groups
  .filter((g) => frcs(g) >= 300 && !/택시|taxi|콜|영어|수학|교실|학습|논술|약국/i.test(g.nm))
  .map((g) => ({ g: g.nm, frcs: frcs(g), store: nStore.get(g) ?? 0 }))
  .filter((x) => x.store < 0.5 * x.frcs)
  .sort((a, b) => b.frcs - a.frcs);
log(`가맹점 300곳 이상인데 상가정보 매칭이 절반 미만: ${weak.length}개`);
for (const w of weak.slice(0, 40)) log(`  ${w.g}  가맹 ${w.frcs} / 상가 ${w.store}`);
