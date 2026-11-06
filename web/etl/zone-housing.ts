// 상권영역별 입주 예정 세대 → zone_housing (유망 입지 찾기의 "앞으로 생길 수요").
// housing_permit(주택 인허가) 중 아직 입주(사용검사) 전이고 앞으로 3년 안에 입주 예정인 100세대 이상 단지만 골라,
// 카카오 주소 검색으로 좌표를 찾고(housing_permit.lat/lon), 상권영역 경계에서 1km 안(중심 기준 반경 + 1km)이면 그 상권에 더한다.
//
//   npx tsx etl/zone-housing.ts
import { resolve } from 'node:path';
import { DATA_DIR, E, getJson, log, openDb, type Row } from './lib.ts';

const NEAR_M = 1000;
const MIN_HH = 100;
const YEARS = 3;

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
for (const c of ['lat REAL', 'lon REAL', 'geo_by TEXT']) {
  try {
    db.exec(`ALTER TABLE housing_permit ADD COLUMN ${c}`);
  } catch {
    // 이미 있음
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const today = ymd(new Date());
const until = ymd(new Date(Date.now() + YEARS * 365.25 * 864e5));
type P = { pk: string; plat_plc: string; bld_nm: string | null; hhld: number; use_inspt_sched_day: string; lat: number | null; lon: number | null };
const projects = db
  .prepare(
    `SELECT pk, plat_plc, bld_nm, hhld, use_inspt_sched_day, lat, lon FROM housing_permit
     WHERE use_inspt_day IS NULL AND hhld >= ? AND apprv_day >= '20180101' AND coalesce(demol, '') NOT LIKE '%멸%'
       AND use_inspt_sched_day BETWEEN ? AND ?`,
  )
  .all(MIN_HH, today, until) as P[];
log(`입주 예정 단지 ${projects.length} (${today}~${until}, ${MIN_HH}세대 이상)`);

// ── 좌표: 카카오 주소 검색 ("…동 810번지" → "…동 810"), 실패하면 단지 이름으로 키워드 검색 ──
if (!E.KAKAO_REST_KEY) throw new Error('KAKAO_REST_KEY 없음 (web/.env)');
// KA 헤더가 없으면 이 키는 401 (등록 도메인 확인)
const headers = { Authorization: `KakaoAK ${E.KAKAO_REST_KEY}`, KA: `sdk/1.0 os/javascript lang/ko-KR origin/${E.KAKAO_ORIGIN ?? 'http://localhost:8000'}` };
const setGeo = db.prepare('UPDATE housing_permit SET lat = ?, lon = ?, geo_by = ? WHERE pk = ?');
let geocoded = 0;
for (const p of projects.filter((x) => x.lat == null)) {
  const addr = p.plat_plc.replace(/\s*-?(\d+(?:-\d+)?)번지.*$/, ' $1').replace(/\s+-(\d)/, ' $1').trim();
  let doc = (await getJson(`https://dapi.kakao.com/v2/local/search/address.json?${new URLSearchParams({ query: addr })}`, undefined, headers)).documents?.[0];
  let by = 'address';
  if (!doc && p.bld_nm) {
    doc = (await getJson(`https://dapi.kakao.com/v2/local/search/keyword.json?${new URLSearchParams({ query: `${p.plat_plc.split(' ').slice(0, 2).join(' ')} ${p.bld_nm}` })}`, undefined, headers)).documents?.[0];
    by = 'keyword';
  }
  if (!doc) continue;
  p.lat = Number(doc.y);
  p.lon = Number(doc.x);
  setGeo.run(p.lat, p.lon, by, p.pk);
  geocoded++;
}
const located = projects.filter((p) => p.lat != null);
log(`좌표 새로 찾음 ${geocoded}, 좌표 있는 단지 ${located.length}/${projects.length}`);

// ── 상권영역: 중심과 등가 반경 (경계에서 1km 안 ≈ 중심에서 반경 + 1km) ──
const rings = (wkt: string) => [...wkt.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(',').map((pt) => pt.trim().split(/\s+/).map(Number)));
const zones = (db.prepare('SELECT trar_no, wkt, trar_area FROM trade_zone_sbiz WHERE wkt IS NOT NULL').all() as { trar_no: string; wkt: string; trar_area: number }[]).map((z) => {
  const pts = rings(z.wkt).flat();
  return {
    no: String(z.trar_no),
    lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    r: Math.sqrt(Number(z.trar_area) / Math.PI),
  };
});
const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return 6371000 * Math.hypot(x, y);
};

const rows: Row[] = [];
for (const z of zones) {
  const near = located
    .map((p) => ({ p, d: dist(z, { lat: p.lat!, lon: p.lon! }) }))
    .filter((x) => x.d <= z.r + NEAR_M)
    .sort((a, b) => b.p.hhld - a.p.hhld);
  if (!near.length) continue;
  rows.push({
    trar_no: z.no,
    upcoming_hh: near.reduce((s, x) => s + x.p.hhld, 0),
    projects: near.length,
    detail: JSON.stringify(near.slice(0, 3).map((x) => ({ name: x.p.bld_nm, hh: x.p.hhld, move_in: x.p.use_inspt_sched_day, distance_m: Math.round(x.d) }))),
  });
}
db.exec('DROP TABLE IF EXISTS zone_housing; CREATE TABLE zone_housing (trar_no TEXT PRIMARY KEY, upcoming_hh INTEGER, projects INTEGER, detail TEXT);');
upsert('zone_housing', rows);
log(`입주 예정 단지가 가까운 상권영역 ${rows.length}/${zones.length}`);
meta('zone_housing', {
  source: '건축HUB 주택인허가 + 카카오 주소 좌표 + 소상공인 상권영역', endpoint: 'etl/zone-housing.ts', std_period: `${today}~${until}`, status: 'loaded',
  note: `입주 전·${YEARS}년 안 입주 예정·${MIN_HH}세대 이상 단지, 상권 경계 ${NEAR_M}m 안 (중심+등가반경 근사)`,
});
db.close();
