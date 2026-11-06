// 소상공인 상권영역(전국 1,227곳) × 업종 소분류 점포 수 → zone_store_total, zone_store_scls, sido_scls_share.
// 유망 입지 찾기(GET /api/v1/opportunities)가 업종별 순위를 바로 계산하도록 미리 센다. store를 다시 적재하면 다시 돌린다.
//
//   npx tsx etl/zone-stats.ts
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb, type Row } from './lib.ts';

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));

type Zone = { no: string; rings: number[][][]; box: [number, number, number, number] };
const rings = (wkt: string) => [...wkt.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(',').map((p) => p.trim().split(/\s+/).map(Number)));
function inside(lon: number, lat: number, rs: number[][][]) {
  let hit = false;
  for (const r of rs)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  return hit;
}

const zones: Zone[] = (db.prepare('SELECT trar_no, wkt FROM trade_zone_sbiz WHERE wkt IS NOT NULL').all() as { trar_no: string; wkt: string }[]).map((z) => {
  const rs = rings(z.wkt);
  const xs = rs.flat().map((p) => p[0]);
  const ys = rs.flat().map((p) => p[1]);
  return { no: String(z.trar_no), rings: rs, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
});
// grid index: 0.01° cells → zones whose box touches the cell
const CELL = 0.01;
const grid = new Map<string, Zone[]>();
for (const z of zones)
  for (let x = Math.floor(z.box[0] / CELL); x <= Math.floor(z.box[2] / CELL); x++)
    for (let y = Math.floor(z.box[1] / CELL); y <= Math.floor(z.box[3] / CELL); y++) grid.set(`${x},${y}`, [...(grid.get(`${x},${y}`) ?? []), z]);

const total = new Map<string, number>();
const sidoVotes = new Map<string, Map<string, number>>();
const byScls = new Map<string, number>(); // `${zone}|${scls}`
const sidoScls = new Map<string, number>(); // `${sido}|${scls}`
const sidoTotal = new Map<string, number>();
let n = 0;
for (const s of db.prepare('SELECT lon, lat, inds_scls_cd, ctprvn_cd FROM store WHERE lon IS NOT NULL').iterate() as Iterable<{ lon: number; lat: number; inds_scls_cd: string; ctprvn_cd: string }>) {
  n++;
  sidoScls.set(`${s.ctprvn_cd}|${s.inds_scls_cd}`, (sidoScls.get(`${s.ctprvn_cd}|${s.inds_scls_cd}`) ?? 0) + 1);
  sidoTotal.set(s.ctprvn_cd, (sidoTotal.get(s.ctprvn_cd) ?? 0) + 1);
  const cands = grid.get(`${Math.floor(s.lon / CELL)},${Math.floor(s.lat / CELL)}`);
  if (!cands) continue;
  const z = cands.find((c) => s.lon >= c.box[0] && s.lon <= c.box[2] && s.lat >= c.box[1] && s.lat <= c.box[3] && inside(s.lon, s.lat, c.rings));
  if (!z) continue;
  total.set(z.no, (total.get(z.no) ?? 0) + 1);
  const v = sidoVotes.get(z.no) ?? new Map<string, number>();
  v.set(s.ctprvn_cd, (v.get(s.ctprvn_cd) ?? 0) + 1);
  sidoVotes.set(z.no, v);
  byScls.set(`${z.no}|${s.inds_scls_cd}`, (byScls.get(`${z.no}|${s.inds_scls_cd}`) ?? 0) + 1);
}

db.exec(`DROP TABLE IF EXISTS zone_store_total; DROP TABLE IF EXISTS zone_store_scls; DROP TABLE IF EXISTS sido_scls_share;
  CREATE TABLE zone_store_total (trar_no TEXT PRIMARY KEY, total INTEGER, ctprvn_cd TEXT);
  CREATE TABLE zone_store_scls (trar_no TEXT, scls_cd TEXT, n INTEGER, PRIMARY KEY (trar_no, scls_cd));
  CREATE TABLE sido_scls_share (ctprvn_cd TEXT, scls_cd TEXT, n INTEGER, share REAL, PRIMARY KEY (ctprvn_cd, scls_cd));
  CREATE INDEX ix_zone_store_scls ON zone_store_scls (scls_cd);`);
upsert('zone_store_total', [...total].map(([no, t]) => ({ trar_no: no, total: t, ctprvn_cd: [...sidoVotes.get(no)!].sort((a, b) => b[1] - a[1])[0][0] })) as Row[]);
upsert('zone_store_scls', [...byScls].map(([k, v]) => ({ trar_no: k.split('|')[0], scls_cd: k.split('|')[1], n: v })) as Row[]);
upsert('sido_scls_share', [...sidoScls].map(([k, v]) => ({ ctprvn_cd: k.split('|')[0], scls_cd: k.split('|')[1], n: v, share: v / sidoTotal.get(k.split('|')[0])! })) as Row[]);
const inZones = [...total.values()].reduce((a, b) => a + b, 0);
meta('zone_store_total', {
  source: '상가정보 점포 × 소상공인 상권영역 경계 (point-in-polygon)',
  endpoint: 'etl/zone-stats.ts',
  std_period: (db.prepare("SELECT std_period p FROM meta_source WHERE table_name = 'store'").get() as { p: string } | undefined)?.p ?? '',
  status: 'loaded',
  note: `상권영역 ${total.size}/${zones.length}곳, 점포 ${n.toLocaleString()} 중 상권 안 ${inZones.toLocaleString()}`,
});
log(`zones ${total.size}/${zones.length}, stores ${n}, in zones ${inZones}, zone×scls ${byScls.size}`);
