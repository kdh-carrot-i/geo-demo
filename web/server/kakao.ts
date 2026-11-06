// Kakao Local API — replaces the original daum_geocodingForWebXRayMap.php / daum_poi_search.php.
// Docs: https://developers.kakao.com/docs/latest/ko/local/dev-guide
import { Router } from 'express';
import { fetchJson, num, requireEnv, sendError, UpstreamError } from './http.ts';
import type { GeocodeResult, ReverseResult } from '../src/shared/api-types.ts';

const BASE = 'https://dapi.kakao.com/v2/local';

interface KakaoAddressDoc {
  address_name: string;
  address_type: string;
  x: string;
  y: string;
  address: { address_name: string; b_code: string; h_code: string; main_address_no: string; sub_address_no: string; mountain_yn: string } | null;
  road_address: { address_name: string; building_name: string; zone_no: string } | null;
}
interface KakaoKeywordDoc {
  place_name: string;
  address_name: string;
  road_address_name: string;
  category_name: string;
  category_group_code?: string;
  x: string;
  y: string;
}
interface KakaoCoord2AddressDoc {
  address: { address_name: string; region_1depth_name: string; region_2depth_name: string; region_3depth_name: string; main_address_no: string; sub_address_no: string; mountain_yn: string } | null;
  road_address: { address_name: string; building_name: string } | null;
}
interface KakaoRegionDoc {
  region_type: 'B' | 'H';
  code: string;
  address_name: string;
}
interface KakaoResp<T> {
  documents: T[];
  meta?: { total_count: number; is_end?: boolean };
}

async function kakao<T>(path: string, params: Record<string, string>): Promise<T[]> {
  return (await kakaoResp<T>(path, params)).documents;
}

async function kakaoResp<T>(path: string, params: Record<string, string>): Promise<KakaoResp<T>> {
  const key = requireEnv('KAKAO_REST_KEY');
  const qs = new URLSearchParams(params);
  const body = await fetchJson<KakaoResp<T>>(`${BASE}${path}?${qs}`, {
    headers: {
      Authorization: `KakaoAK ${key}`,
      // keys with registered platform domains require the caller's origin in the KA header
      KA: `sdk/1.0 os/javascript lang/ko-KR origin/${process.env.KAKAO_ORIGIN ?? 'http://localhost:8000'}`,
    },
  });
  return body;
}

export interface KeywordPlace {
  name: string;
  address: string;
  road: string | null;
  category: string;
  /** Kakao category group (SW8 지하철역, AT4 관광명소 …); empty for uncategorised places */
  group: string;
  lat: number;
  lng: number;
}

/** Kakao keyword search, up to `pages` × 15 places (Kakao serves at most 3 pages = 45). */
export async function keywordPlaces(query: string, pages = 3): Promise<KeywordPlace[]> {
  const out: KeywordPlace[] = [];
  for (let page = 1; page <= pages; page++) {
    const r = await kakaoResp<KakaoKeywordDoc>('/search/keyword.json', { query, size: '15', page: String(page) });
    for (const d of r.documents)
      out.push({ name: d.place_name, address: d.address_name, road: d.road_address_name || null, category: d.category_name, group: d.category_group_code ?? '', lat: Number(d.y), lng: Number(d.x) });
    if (r.meta?.is_end !== false) break;
  }
  return out;
}

export interface CategoryPlace {
  name: string;
  category: string;
  distance_m: number;
  lat: number;
  lng: number;
}

/**
 * Kakao category search (e.g. SW8 지하철역, PK6 주차장) within a circle. `total` is Kakao's own count;
 * `items` holds at most 15 nearest places.
 */
export async function categorySearch(code: string, lon: number, lat: number, radiusM: number): Promise<{ total: number; items: CategoryPlace[] }> {
  const r = await kakaoResp<KakaoKeywordDoc & { distance: string }>('/search/category.json', {
    category_group_code: code,
    x: String(lon),
    y: String(lat),
    radius: String(Math.min(20000, Math.round(radiusM))),
    sort: 'distance',
    size: '15',
  });
  return {
    total: r.meta?.total_count ?? r.documents.length,
    items: r.documents.map((d) => ({ name: d.place_name, category: d.category_name, distance_m: Number(d.distance), lat: Number(d.y), lng: Number(d.x) })),
  };
}

/** Address search first; fall back to keyword (POI) search like the original two-step lookup. */
export async function geocode(query: string): Promise<GeocodeResult[]> {
  const addr = await kakao<KakaoAddressDoc>('/search/address.json', { query, size: '10' });
  if (addr.length > 0) {
    return addr.map((d) => ({
      source: 'address',
      label: d.road_address?.address_name || d.address_name,
      jibun: d.address?.address_name ?? d.address_name,
      road: d.road_address?.address_name,
      lon: Number(d.x),
      lat: Number(d.y),
      bCode: d.address?.b_code,
      // exact = matched a 지번/도로명 that resolves to a single point
      precision: d.address_type === 'REGION' || d.address_type === 'ROAD' ? 'region' : 'exact',
    }));
  }
  const kw = await kakao<KakaoKeywordDoc>('/search/keyword.json', { query, size: '10' });
  return kw.map((d) => ({
    source: 'keyword',
    label: d.place_name,
    jibun: d.address_name,
    road: d.road_address_name || undefined,
    lon: Number(d.x),
    lat: Number(d.y),
    category: d.category_name,
    precision: 'poi',
  }));
}

export async function reverse(lon: number, lat: number): Promise<ReverseResult> {
  const [addrs, regions] = await Promise.all([
    kakao<KakaoCoord2AddressDoc>('/geo/coord2address.json', { x: String(lon), y: String(lat) }),
    kakao<KakaoRegionDoc>('/geo/coord2regioncode.json', { x: String(lon), y: String(lat) }),
  ]);
  const a = addrs[0];
  const b = regions.find((r) => r.region_type === 'B');
  const h = regions.find((r) => r.region_type === 'H');
  return {
    lon,
    lat,
    jibun: a?.address?.address_name,
    road: a?.road_address?.address_name,
    building: a?.road_address?.building_name || undefined,
    bCode: b?.code,
    hCode: h?.code,
    hName: h?.address_name,
    mountain: a?.address?.mountain_yn === 'Y',
    mainNo: a?.address?.main_address_no,
    subNo: a?.address?.sub_address_no,
  };
}

export function kakaoRouter() {
  const r = Router();

  r.get('/geocode', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q || q.length > 200) {
      res.status(400).json({ error: 'q is required (<=200 chars)' });
      return;
    }
    try {
      res.json(await geocode(q));
    } catch (e) {
      sendError(res, e);
    }
  });

  // Batch geocoding for uploaded address lists. Sequential with a small delay to stay under Kakao quotas.
  r.post('/geocode/batch', async (req, res) => {
    const list: unknown = req.body?.addresses;
    if (!Array.isArray(list) || list.length === 0 || list.length > 500) {
      res.status(400).json({ error: 'addresses must be an array of 1..500 strings' });
      return;
    }
    try {
      const out = [];
      for (const raw of list) {
        const q = String(raw ?? '').trim();
        if (!q) {
          out.push({ query: q, status: 'empty' as const });
          continue;
        }
        try {
          const hits = await geocode(q);
          out.push(hits.length ? { query: q, status: 'ok' as const, best: hits[0], candidates: hits.length } : { query: q, status: 'notfound' as const });
        } catch (e) {
          if (e instanceof UpstreamError && e.status === 503) throw e;
          out.push({ query: q, status: 'error' as const });
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      res.json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get('/reverse', async (req, res) => {
    const lon = num(req.query.lon);
    const lat = num(req.query.lat);
    if (lon === undefined || lat === undefined) {
      res.status(400).json({ error: 'lon and lat are required' });
      return;
    }
    try {
      res.json(await reverse(lon, lat));
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
