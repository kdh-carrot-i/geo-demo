// 상권 별칭 사전 area_alias: 카카오 테마거리(여행 > 관광,명소 > 테마거리 …) 전국 + 수동 별칭(객리단길 → 객사길 등).
// 상권 검색(GET /areas?q=)이 "황리단길"·"객리단길"처럼 상권영역 이름에 없는 말도 받아 그 지점을 품은 상권영역을 돌려주게 한다.
// 카카오 키워드 검색은 한 질의에 45곳까지만 주므로 전국 사각형을 4등분해 내려가며 45곳 이하가 될 때까지 나눠 묻는다.
// 응답 원본은 data/lake/raw/kakao_theme/ 에 저장. 호출 상한 BUDGET_KAKAO (기본 3,000).
//
//   npx tsx etl/area-alias.ts
import { resolve } from 'node:path';
import { normName } from '../server/agent/brand-name.ts';
import { callStats, DATA_DIR, E, getJson, log, openDb, type Row } from './lib.ts';

/** 별칭 → 카카오에서 찾을 대상 이름, 주소에 들어 있어야 할 지역 (흔히 쓰는 별명만, 대상이 확실한 것) */
const MANUAL: [string, string, string][] = [
  ['객리단길', '객사길', '전주시'],
  ['객사거리', '객사길', '전주시'],
  ['황남동카페거리', '황리단길', '경주시'],
  ['서울대입구샤로수길', '샤로수길', '관악구'],
  ['가로수길', '신사동가로수길', '강남구'],
  ['세로수길', '신사동가로수길', '강남구'],
  ['익선동', '익선동한옥거리', '종로구'],
  ['힙지로', '을지로노가리골목', '중구'],
  ['을지로노가리', '을지로노가리골목', '중구'],
  ['동명동카페거리', '동리단길 카페거리', '광주'],
  ['전포카페거리', '전리단길', '부산진구'],
  ['봉리단길', '봉리단길', '김해시'], // 카카오 테마거리에는 다른 지역 봉리단길만 있음
  ['연트럴파크', '경의선숲길 연남동', '마포구'],
  ['해방촌', '해방촌골목형상점가', '용산구'],
  ['문래창작촌', '문래창작촌', '영등포구'],
];

const KAKAO = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const headers = { Authorization: `KakaoAK ${E.KAKAO_REST_KEY}`, KA: `sdk/1.0 os/javascript lang/ko-KR origin/${E.KAKAO_ORIGIN ?? 'http://localhost:8000'}` };
interface Doc { id: string; place_name: string; category_name: string; address_name: string; road_address_name: string; x: string; y: string }
const kakao = async (q: Record<string, string>, tag: string) =>
  (await getJson(`${KAKAO}?${new URLSearchParams(q)}`, ['kakao_theme', tag], headers)) as { documents: Doc[]; meta: { total_count: number; pageable_count: number; is_end: boolean } };

if (!E.KAKAO_REST_KEY) throw new Error('KAKAO_REST_KEY 없음 (web/.env)');
const { upsert, meta, db } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));

// ── 1. 테마거리 전국: 사각형을 나눠 가며 수집 ──
const themes = new Map<string, Doc>();
let tiles = 0;
async function sweep(x1: number, y1: number, x2: number, y2: number, depth = 0): Promise<void> {
  const rect = [x1, y1, x2, y2].map((v) => v.toFixed(4)).join(',');
  const q = { query: '테마거리', category_group_code: 'AT4', rect, size: '15' };
  const first = await kakao({ ...q, page: '1' }, `rect_${rect}_p1`);
  const total = first.meta.total_count;
  if (!total) return;
  // 45곳이 넘으면 나눈다 (아주 작은 사각형은 그대로 45곳까지만)
  if (total > 45 && depth < 9) {
    const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
    for (const [a, b, c, d] of [[x1, y1, mx, my], [mx, y1, x2, my], [x1, my, mx, y2], [mx, my, x2, y2]]) await sweep(a, b, c, d, depth + 1);
    return;
  }
  tiles++;
  const docs = [...first.documents];
  for (let p = 2; !first.meta.is_end && p <= Math.ceil(Math.min(45, first.meta.pageable_count) / 15); p++) docs.push(...(await kakao({ ...q, page: String(p) }, `rect_${rect}_p${p}`)).documents);
  for (const d of docs) if (d.category_name.includes('테마거리')) themes.set(d.id, d);
}
await sweep(124.5, 33.0, 131.0, 38.7);
log(`테마거리 ${themes.size}곳 (사각형 ${tiles}개, 카카오 호출 ${JSON.stringify(callStats())})`);

const region = (addr: string) => {
  const [sido, ...rest] = addr.split(' ');
  // 시 아래 구가 있으면 "수원시 팔달구"까지
  const sgg = rest[1] && /구$/.test(rest[1]) && /시$/.test(rest[0]) ? `${rest[0]} ${rest[1]}` : (rest[0] ?? '');
  return { sido, sgg };
};
const row = (alias: string, d: Doc, kind: 'kakao_theme' | 'manual', target: string): Row => ({
  alias: normName(alias),
  place_id: d.id,
  name: alias,
  target,
  kind,
  category: d.category_name.split(' > ').slice(2).join(' > ') || d.category_name,
  ...region(d.address_name),
  address: d.road_address_name || d.address_name,
  lat: Number(d.y),
  lon: Number(d.x),
});
const rows: Row[] = [...themes.values()].map((d) => row(d.place_name, d, 'kakao_theme', d.place_name));

// ── 2. 수동 별칭: 수집한 테마거리에서 먼저 찾고, 없으면 카카오 키워드 검색 첫 결과(지역이 맞는 것) ──
let missed = 0;
for (const [alias, target, hint] of MANUAL) {
  let d = [...themes.values()].find((t) => normName(t.place_name) === normName(target) && t.address_name.includes(hint));
  if (!d) d = (await kakao({ query: `${hint.replace(/(시|구)$/, '')} ${target}`, size: '5' }, `manual_${alias}`)).documents.find((x) => x.address_name.includes(hint));
  if (!d) {
    missed++;
    log(`수동 별칭 대상 못 찾음: ${alias} → ${target} (${hint})`);
    continue;
  }
  log(`  ${alias} → ${d.place_name} · ${d.address_name} · ${d.category_name}`);
  rows.push(row(alias, d, 'manual', d.place_name));
}

db.exec('DELETE FROM area_alias');
upsert('area_alias', rows);
meta('area_alias', {
  source: '카카오 로컬 키워드 검색 (테마거리) + 수동 별칭',
  endpoint: 'dapi.kakao.com/v2/local/search/keyword.json?query=테마거리&category_group_code=AT4&rect=…',
  std_period: new Date().toISOString().slice(0, 10),
  status: 'ok',
  note: `테마거리 ${themes.size}곳 + 수동 별칭 ${MANUAL.length - missed}개`,
});
log(`area_alias ${rows.length}행 (카카오 호출 ${JSON.stringify(callStats())})`);
