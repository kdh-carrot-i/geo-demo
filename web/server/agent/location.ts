// Step 1: pin down where the site is — coordinates, 행정동, PNU and (in Seoul) the 상권분석 상권.
import { geocode, reverse } from '../kakao.ts';
import { all } from './db.ts';
import { distanceM } from './geo.ts';
import { ApiProblem } from './problem.ts';

export interface Location {
  lat: number;
  lng: number;
  address_road: string | null;
  address_jibun: string | null;
  pnu: string | null;
  adm_cd: string | null;
  adm_nm: string | null;
  sgg_nm: string | null;
  sido_nm: string | null;
  trade_area: { code: string; name: string; type: string; distance_m: number } | null;
  /** 소상공인 상권영역 (전국 1,227곳, 경계 다각형) containing the site */
  sbiz_zone: { no: string; name: string; sgg_nm: string; area_m2: number } | null;
  coverage: 'seoul' | 'national';
}

const MAX_ADDRESS_GAP_M = 500;
const TA_TYPE: Record<string, string> = { A: '골목상권', D: '발달상권', R: '전통시장', U: '관광특구' };

interface TradeArea {
  trdar_cd: string;
  trdar_cd_nm: string;
  trdar_se_cd: string;
  lat: number;
  lon: number;
  relm_ar: number;
}
let tradeAreas: TradeArea[] | undefined;

/** Seoul 상권 are stored as centroid + area only, so match the nearest centroid within ~1.5 × its radius. */
function nearestTradeArea(lat: number, lng: number): Location['trade_area'] {
  tradeAreas ??= all<TradeArea>('select trdar_cd, trdar_cd_nm, trdar_se_cd, lat, lon, relm_ar from trade_area_seoul');
  let best: Location['trade_area'] = null;
  for (const t of tradeAreas) {
    const d = distanceM(lat, lng, t.lat, t.lon);
    const reach = Math.max(150, 1.5 * Math.sqrt(t.relm_ar / Math.PI));
    if (d <= reach && (!best || d < best.distance_m)) {
      best = { code: t.trdar_cd, name: t.trdar_cd_nm, type: TA_TYPE[t.trdar_se_cd] ?? t.trdar_se_cd, distance_m: Math.round(d) };
    }
  }
  return best;
}

interface Zone {
  no: string;
  name: string;
  sgg_nm: string;
  area_m2: number;
  rings: number[][][];
  box: [number, number, number, number];
}
let zones: Zone[] | undefined;

/** WKT POLYGON / MULTIPOLYGON → rings of [lon, lat]; holes are just more rings (even-odd rule below). */
export function rings(wkt: string): number[][][] {
  return [...wkt.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(',').map((p) => p.trim().split(/\s+/).map(Number)));
}

export function inside(lon: number, lat: number, rs: number[][][]): boolean {
  let hit = false;
  for (const r of rs) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

function sbizZone(lat: number, lng: number): Location['sbiz_zone'] {
  zones ??= all<{ trar_no: string; main_trar_nm: string; signgu_nm: string; trar_area: number; wkt: string }>(
    'select trar_no, main_trar_nm, signgu_nm, trar_area, wkt from trade_zone_sbiz where wkt is not null',
  ).map((z) => {
    const rs = rings(z.wkt);
    const xs = rs.flat().map((p) => p[0]);
    const ys = rs.flat().map((p) => p[1]);
    return { no: String(z.trar_no), name: z.main_trar_nm, sgg_nm: z.signgu_nm, area_m2: Number(z.trar_area), rings: rs, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  const z = zones.find((x) => lng >= x.box[0] && lng <= x.box[2] && lat >= x.box[1] && lat <= x.box[3] && inside(lng, lat, x.rings));
  return z ? { no: z.no, name: z.name, sgg_nm: z.sgg_nm, area_m2: z.area_m2 } : null;
}

function pnuOf(bCode?: string, mountain?: boolean, mainNo?: string, subNo?: string): string | null {
  if (!bCode || !mainNo) return null;
  return `${bCode}${mountain ? '2' : '1'}${mainNo.padStart(4, '0')}${(subNo || '0').padStart(4, '0')}`;
}

export async function resolveLocation(input: { lat?: number; lng?: number; address?: string }): Promise<Location> {
  let { lat, lng } = input;
  if (input.address) {
    const hits = await geocode(input.address);
    if (hits.length === 0 && lat === undefined) {
      throw new ApiProblem(422, '주소를 찾을 수 없음', `지오코딩 결과가 없습니다: ${input.address}`);
    }
    if (hits.length > 0) {
      if (lat !== undefined && lng !== undefined) {
        const gap = distanceM(lat, lng, hits[0].lat, hits[0].lon);
        if (gap > MAX_ADDRESS_GAP_M) {
          throw new ApiProblem(422, '좌표와 주소가 다름', `좌표와 주소 위치가 ${Math.round(gap)}m 떨어져 있습니다 (허용 ${MAX_ADDRESS_GAP_M}m).`);
        }
      } else {
        ({ lat, lon: lng } = hits[0]);
      }
    }
  }
  if (lat === undefined || lng === undefined) throw new ApiProblem(400, '위치 없음', 'lat/lng 또는 address가 필요합니다.');

  const r = await reverse(lng, lat);
  const parts = (r.hName ?? '').split(' ');
  const sido = parts[0] || null;
  const isSeoul = sido?.startsWith('서울') ?? false;
  return {
    lat,
    lng,
    address_road: r.road ?? null,
    address_jibun: r.jibun ?? null,
    pnu: pnuOf(r.bCode, r.mountain, r.mainNo, r.subNo),
    adm_cd: r.hCode ? r.hCode.slice(0, 8) : null,
    adm_nm: parts.at(-1) || null,
    sgg_nm: parts.length > 2 ? parts.slice(1, -1).join(' ') : null,
    sido_nm: sido,
    trade_area: isSeoul ? nearestTradeArea(lat, lng) : null,
    sbiz_zone: sbizZone(lat, lng),
    coverage: isSeoul ? 'seoul' : 'national',
  };
}
