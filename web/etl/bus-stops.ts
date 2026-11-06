// 국토교통부 전국 버스정류장 위치정보 (공공데이터포털 파일 15067528, CP949 CSV) → bus_stop.
// BIS가 국가대중교통정보센터(TAGO)와 연계된 지자체의 정류장. 연 1회 수집본이라 이후 변동은 반영되지 않는다.
// 서울 시내버스는 서울시 BIS라 이 파일에 거의 없다 (경기 버스가 서는 4천여 곳만) → 서울 열린데이터광장
// busStopLocationXyInfo(1.1만 곳)를 더하고, 같은 이름·30m 안에서 겹치는 파일 쪽 서울 정류장은 지운다.
//
//   npx tsx etl/bus-stops.ts "data/raw/국토교통부_전국 버스정류장 위치정보_20261020.csv"
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DATA_DIR, E, log, openDb, WEB_ROOT, type Row } from './lib.ts';

const file = resolve(WEB_ROOT, '..', process.argv[2] ?? '');
const text = new TextDecoder('euc-kr').decode(readFileSync(file)); // CP949 ⊃ EUC-KR for these names
const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
const cols = head.split(',').map((c) => c.trim());
const at = (name: string) => {
  const i = cols.indexOf(name);
  if (i < 0) throw new Error(`column ${name} not in ${cols.join(',')}`);
  return i;
};
const [iNo, iNm, iLat, iLon, iYmd, iShort, iCity, iCityNm, iMgr] = ['정류장번호', '정류장명', '위도', '경도', '정보수집일', '모바일단축번호', '도시코드', '도시명', '관리도시명'].map(at);

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`DROP TABLE IF EXISTS bus_stop;
  CREATE TABLE bus_stop (stop_id TEXT PRIMARY KEY, stop_nm TEXT, lat REAL, lon REAL, collected_ymd TEXT, short_no TEXT, city_cd TEXT, city_nm TEXT, mgr_nm TEXT);`);

const rows: Row[] = [];
let bad = 0;
for (const l of lines) {
  // names may contain commas inside quotes
  const c = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  const lat = Number(c[iLat]);
  const lon = Number(c[iLon]);
  if (!(lat > 33 && lat < 39 && lon > 124 && lon < 132)) {
    bad++;
    continue;
  }
  rows.push({ stop_id: c[iNo], stop_nm: c[iNm], lat, lon, collected_ymd: c[iYmd], short_no: c[iShort] || null, city_cd: c[iCity], city_nm: c[iCityNm], mgr_nm: c[iMgr] });
}
for (let i = 0; i < rows.length; i += 20000) upsert('bus_stop', rows.slice(i, i + 20000));
db.exec('CREATE INDEX ix_bus_stop_geo ON bus_stop (lat, lon)');

// ── 서울 시내버스 정류소 (서울 열린데이터광장, 공공누리 1유형) ──
const SKIP_TYPES = /선착장|가상/;
const seoul: Row[] = [];
for (let from = 1; ; from += 1000) {
  const j = (await (await fetch(`http://openapi.seoul.go.kr:8088/${E.SEOUL_OPEN_API_KEY}/json/busStopLocationXyInfo/${from}/${from + 999}/`)).json()) as {
    busStopLocationXyInfo?: { list_total_count: number; row: { STOPS_NO: string; STOPS_NM: string; XCRD: string; YCRD: string; NODE_ID: string; STOPS_TYPE: string }[] };
  };
  const b = j.busStopLocationXyInfo;
  if (!b) throw new Error(`seoul busStopLocationXyInfo ${from}: unexpected response`);
  for (const r of b.row) {
    if (SKIP_TYPES.test(r.STOPS_TYPE ?? '')) continue;
    seoul.push({ stop_id: `SEOUL:${r.NODE_ID}`, stop_nm: r.STOPS_NM, lat: Number(r.YCRD), lon: Number(r.XCRD), collected_ymd: new Date().toISOString().slice(0, 10), short_no: r.STOPS_NO, city_cd: '11', city_nm: '서울특별시', mgr_nm: `서울시 (${r.STOPS_TYPE})` });
  }
  if (from + 999 >= b.list_total_count) break;
}
upsert('bus_stop', seoul);
// drop file rows in Seoul that duplicate a Seoul stop (same name within 30 m)
const fileSeoul = db.prepare("SELECT stop_id, stop_nm, lat, lon FROM bus_stop WHERE city_nm = '서울특별시' AND stop_id NOT LIKE 'SEOUL:%'").all() as { stop_id: string; stop_nm: string; lat: number; lon: number }[];
const byName = new Map<string, Row[]>();
for (const s of seoul) byName.set(String(s.stop_nm), [...(byName.get(String(s.stop_nm)) ?? []), s]);
const dupIds = fileSeoul
  .filter((f) => (byName.get(f.stop_nm) ?? []).some((s) => Math.hypot((Number(s.lat) - f.lat) * 111000, (Number(s.lon) - f.lon) * 88000) <= 30))
  .map((f) => f.stop_id);
const del = db.prepare('DELETE FROM bus_stop WHERE stop_id = ?');
db.exec('BEGIN');
for (const id of dupIds) del.run(id);
db.exec('COMMIT');
log(`seoul: ${seoul.length} stops added, ${dupIds.length} duplicate file rows removed`);
const n = (db.prepare('SELECT count(*) n FROM bus_stop').get() as { n: number }).n;
const cities = (db.prepare('SELECT count(DISTINCT city_cd) n FROM bus_stop').get() as { n: number }).n;
meta('bus_stop', {
  source: '국토교통부 전국 버스정류장 위치정보 (공공데이터포털 파일 15067528) + 서울시 버스정류소 위치정보 (busStopLocationXyInfo)',
  endpoint: `data/raw/${basename(file)}`,
  std_period: String(rows[0]?.collected_ymd ?? ''),
  status: 'loaded',
  note: `정류장 ${n.toLocaleString()}곳, 도시 ${cities}. 파일은 BIS가 TAGO와 연계된 지자체만 (연 1회 수집), 서울은 서울시 API ${seoul.length}곳으로 보강 (겹침 ${dupIds.length} 제거). 좌표 오류 ${bad}건 제외`,
});
log(`bus_stop: ${n} stops, ${cities} cities, skipped ${bad}`);
