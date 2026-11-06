// 상호 → 프랜차이즈 브랜드 매칭 규칙 (DB 없이 쓰는 순수 함수: 서버 brand.ts와 etl/brand-alias.ts가 함께 쓴다).
// 1) 이름 정규화: 전각→반각, 소문자, 한글·영숫자만 남김 ("메가MGC 커피 강남역점" → "메가mgc커피강남역점")
// 2) 별칭 표(brand_alias)에서 가장 긴 접두어부터 찾는다. 뒤에 남는 부분은 지점명으로 본다.
// 3) 짧은 별칭(한글 2자·영문 3자 이하, 예: 씨유·cu)과 업종 꼬리말을 떼어 만든 별칭(온누리약국 → 온누리)은
//    뒤가 비었거나 "…점"으로 끝날 때만 인정한다 ("씨유미용실"·"온누리식당"이 잡히지 않게). 앞쪽의 업종 말(치킨·숯불양념…)은
//    건너뛰고 보며, 지점명 칸(brch_nm)이 따로 있으면 뒤의 한글 4자 이하는 지역명으로 본다 ("공차부산" + "서면점").
//    영문 별칭 바로 뒤에 영문이 이어지면 어떤 길이든 인정하지 않는다 ("cuisine" ≠ CU).

export const normName = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\(?주\)|\(주\)$/g, '')
    .replace(/[^0-9a-z가-힣]/g, '');

/** 공정위 등록명에서 흔히 빠지는 업종 꼬리말: "이디야커피" → "이디야", "교촌치킨" → "교촌" */
const TAIL_WORDS = '커피|coffee|치킨|chicken|피자|pizza|베이커리|bakery|카페|cafe|떡볶이|토스트|버거|burger|약국|코리아|korea|양념|숯불|통닭|찜닭|바베큐|구이|아이스크림|할인점';
const GENERIC_TAIL = new RegExp(`(${TAIL_WORDS})+$`);
/** 짧은 별칭 뒤에 붙어도 되는 업종 말 ("지코바" + "숯불양념치킨") */
const FILLER = new RegExp(`^(${TAIL_WORDS}|숍|샵|코인워시|본점|직영)+`);
/** 그 자체로는 브랜드가 아닌 말: 별칭으로 쓰지 않는다 */
const GENERIC_WORD = new RegExp(
  '^(커피|coffee|치킨|chicken|피자|pizza|카페|cafe|베이커리|약국|편의점|마트|식당|분식|김밥|호프|노래방|pc방|미용실|헤어|네일|세탁|세탁소|빨래방|부동산|학원|교습소|공부방|' +
    '영어|수학|잉글리쉬|잉글리시|english|태권도|피아노|택시|코리아|korea|the|더|요가|필라테스|키즈|키즈카페|헬스|스터디카페|독서실|무인카페|비빔밥|국밥|칼국수|냉면|족발|보쌈|곱창|막창|' +
    '삼겹살|갈비|짬뽕|쌀국수|떡볶이|순대|찜닭|돈까스|우동|초밥|스시|라멘|마라탕|샐러드|도시락|반찬|정육|과일|꽃|안경|스튜디오|사진관|펫|애견|아이스크림|할인점|맥주|포차|' +
    '불닭발|순대국|소머리국밥|해장국|감자탕|부대찌개|생맥주|이자카야|와인|스크린골프|당구|볼링|코인노래방)$',
);

export type AliasKind = 'manual' | 'ftc' | 'part' | 'derived';

/** 공정위 등록명 하나에서 나오는 별칭들. 괄호·슬래시·& 로 나뉜 부분과 업종 꼬리말을 뗀 이름까지 */
export function aliasesOf(brandNm: string): { alias: string; kind: AliasKind }[] {
  const out = new Map<string, AliasKind>();
  const add = (s: string, kind: AliasKind) => {
    const a = normName(s);
    if (a.length < 2 || GENERIC_WORD.test(a) || /^\d+$/.test(a) || out.has(a)) return;
    out.set(a, kind);
  };
  add(brandNm, 'ftc');
  const outside = brandNm.replace(/\([^)]*\)/g, ' ');
  const inParens = [...brandNm.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  // "&"·"/"로 나뉜 조각은 짧으면 흔한 말이라 버린다 ("아트&하트" → "아트" ✗). 괄호 안 영문 표기는 짧아도 둔다 ("씨유(CU)" → "cu")
  const split = [outside, ...inParens].flatMap((p) => p.split(/[/&,+]| - /)).filter((p) => !isShort(normName(p)));
  const parts = [...inParens, ...split];
  for (const p of [outside, ...parts]) add(p, 'part');
  for (const p of [outside, ...parts]) {
    const n = normName(p);
    const t = n.replace(GENERIC_TAIL, '');
    // 꼬리말을 떼고 한글 2자 이하만 남으면 너무 흔한 말이 된다 (스타·아이·팔도)
    if (t !== n && !isShort(t)) add(t, 'derived');
  }
  return [...out].map(([alias, kind]) => ({ alias, kind }));
}

const isShort = (a: string) => (/^[가-힣]+$/.test(a) ? a.length <= 2 : a.length <= 3);

/** 정규화한 상호 `key`에서 별칭 `alias`(접두어) 뒤의 나머지가 지점명으로 받아들일 만한가 */
/** "…점"이어도 지점명이 아닌 말 */
const NOT_BRANCH = /(주점|상점|매점|판매점|대리점|전문점|할인점|백화점|편의점|음식점|정육점|철물점|양복점|제과점)$/;

export function acceptRest(alias: string, kind: AliasKind, rest: string, hasBranch = false): boolean {
  if (/[a-z]$/.test(alias) && /^[a-z]/.test(rest)) return false;
  if (!isShort(alias) && kind !== 'derived') return true;
  const branchy = (r: string) => r === '' || (/점$/.test(r) && !NOT_BRANCH.test(r));
  // 꼬리말을 뗀 별칭은 그 자리에 다른 업종 말이 올 수 있어("팔도" + "커피") 업종 말 건너뛰기·지역명 허용을 하지 않는다
  if (kind === 'derived') return branchy(rest);
  const r = rest.replace(FILLER, '');
  return branchy(r) || (hasBranch && /^[가-힣]{1,4}$/.test(r));
}

/** 가장 긴 접두어 별칭. lookup은 정규화된 별칭 → 값, branch는 상가정보 지점명(brch_nm) */
export function matchPrefix<T extends { kind: AliasKind }>(name: string, lookup: (alias: string) => T | undefined, branch?: string | null): { value: T; alias: string; rest: string } | null {
  const key = normName(name);
  for (let n = key.length; n >= 2; n--) {
    const alias = key.slice(0, n);
    const value = lookup(alias);
    if (value === undefined) continue;
    const rest = key.slice(n);
    if (acceptRest(alias, value.kind, rest, !!branch)) return { value, alias, rest };
  }
  return null;
}
