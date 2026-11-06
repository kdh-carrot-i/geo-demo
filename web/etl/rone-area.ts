// R-ONE 임대동향 상권 → 좌표 (rone_area). R-ONE gives 상권 only as names ("부산>서면/전포"), so each
// leaf name is looked up once with Kakao keyword search; the API then picks the nearest 상권 for a site.
//
//   npx tsx etl/rone-area.ts
import { resolve } from 'node:path';
import { DATA_DIR, E, log, openDb, sleep, type Row } from './lib.ts';

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS rone_area (
  fullnm TEXT PRIMARY KEY, region TEXT, leaf TEXT, depth INTEGER,
  lat REAL, lon REAL, matched_name TEXT, matched_addr TEXT, match_query TEXT)`);

// every area name used by the 층별임대료 (grp_fullnm) and 공실률 (cls_fullnm) tables
const names = new Set(
  (db
    .prepare(
      `SELECT DISTINCT grp_fullnm n FROM rone_stat WHERE statbl_nm LIKE '임대동향 층별임대료%' AND grp_fullnm IS NOT NULL
       UNION SELECT DISTINCT cls_fullnm FROM rone_stat WHERE statbl_nm LIKE '임대동향 지역별 공실률%' AND cls_fullnm IS NOT NULL`,
    )
    .all() as { n: string }[]).map((r) => r.n.trim()),
);
// a leaf is a name no other name extends ("서울>도심" is a grouping, "서울>도심>광화문" a place)
// Catch-all buckets ("부산>기타", "서울>주요지역") are not places: they only get the 시도 average.
const BUCKET = /(^|>)(기타|[^>]*기타|주요지역|도심지역)$/;
const leaves = [...names].filter((n) => n.includes('>') && !BUCKET.test(n) && ![...names].some((m) => m.startsWith(`${n}>`)));
const done = new Set((db.prepare('SELECT fullnm FROM rone_area WHERE lat IS NOT NULL').all() as { fullnm: string }[]).map((r) => r.fullnm));
log(`R-ONE area names ${names.size}, leaves ${leaves.length}, already located ${done.size}`);

const REGION_ALIAS: Record<string, string> = { 전남광주: '', 경기: '경기도', 강원: '강원', 충북: '충청북도', 충남: '충청남도', 전북: '전북', 경북: '경상북도', 경남: '경상남도', 제주: '제주' };

async function keyword(query: string) {
  const r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${new URLSearchParams({ query, size: '5' })}`, {
    headers: { Authorization: `KakaoAK ${E.KAKAO_REST_KEY}`, KA: `sdk/1.0 os/javascript lang/ko-KR origin/${E.KAKAO_ORIGIN ?? 'http://localhost:8000'}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`kakao ${r.status}`);
  return ((await r.json()) as { documents: { place_name: string; address_name: string; x: string; y: string }[] }).documents;
}

const rows: Row[] = [];
for (const full of leaves) {
  if (done.has(full)) continue;
  const parts = full.split('>');
  const region = parts[0];
  const leaf = parts.at(-1)!;
  // "서면/전포" → "서면", "경성대/부경대" → "경성대"; the deepest non-grouping parent gives the city ("전남광주>광주>상무지구")
  const place = leaf.split('/')[0].replace(/(중심|주변|일대)$/, '');
  const city = parts.length > 2 && !['도심', '강남', '여의도', '기타'].includes(parts[1]) ? parts[1] : (REGION_ALIAS[region] ?? region);
  const tries = [`${city} ${place}`.trim(), `${region === '전남광주' ? parts[1] : region} ${place}`, place];
  let hit: { place_name: string; address_name: string; x: string; y: string } | undefined;
  let used = '';
  for (const q of tries) {
    const docs = await keyword(q);
    await sleep(150);
    // keep the hit inside the same 시도 when we can tell
    hit = docs.find((d) => d.address_name.startsWith(city) || d.address_name.startsWith(region)) ?? docs[0];
    used = q;
    if (hit) break;
  }
  rows.push({
    fullnm: full,
    region,
    leaf,
    depth: parts.length,
    lat: hit ? Number(hit.y) : null,
    lon: hit ? Number(hit.x) : null,
    matched_name: hit?.place_name ?? null,
    matched_addr: hit?.address_name ?? null,
    match_query: used,
  });
}
upsert('rone_area', rows);
const located = (db.prepare('SELECT count(*) n FROM rone_area WHERE lat IS NOT NULL').get() as { n: number }).n;
meta('rone_area', {
  source: 'R-ONE 임대동향 상권명 → 카카오 키워드 검색 좌표',
  status: located === leaves.length ? 'loaded' : 'partial',
  note: `상권 ${leaves.length}곳 중 ${located}곳 좌표 확보. 상권 경계가 아니라 대표 지점이므로 반경 매칭에만 사용`,
});
log(`located ${located}/${leaves.length}`);
for (const r of rows.filter((x) => !x.lat).slice(0, 20)) log(`  not found: ${r.fullnm}`);
