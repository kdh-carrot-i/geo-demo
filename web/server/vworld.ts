// VWorld (국가공간정보) — replaces the original pnu_simple.php / pnu_total.php, and proxies base-map tiles
// so the key stays server-side.
// NOTE(확인 필요): request params below follow VWorld Data API 2.0; verify against the official docs
// once a key is issued, and add NED 토지특성/공시지가 services for the "total" parcel view.
import { Router } from 'express';
import { fetchJson, num, requireEnv, sendError, UpstreamError } from './http.ts';
import type { ParcelResult } from '../src/shared/api-types.ts';

interface VWorldDataResp {
  response: {
    status: 'OK' | 'NOT_FOUND' | 'ERROR';
    error?: { text: string };
    result?: {
      featureCollection: {
        features: Array<{
          geometry: GeoJSON.Geometry;
          properties: Record<string, string>;
        }>;
      };
    };
  };
}

const PNU_RE = /^\d{19}$/;

export async function cadastral(filter: { point?: [number, number]; pnu?: string }): Promise<ParcelResult[]> {
  const params = new URLSearchParams({
    service: 'data',
    request: 'GetFeature',
    data: 'LP_PA_CBND_BUBUN', // 연속지적도
    key: requireEnv('VWORLD_KEY'),
    domain: process.env.VWORLD_DOMAIN ?? 'localhost',
    format: 'json',
    crs: 'EPSG:4326',
    geometry: 'true',
    attribute: 'true',
    size: '10',
  });
  if (filter.point) params.set('geomFilter', `POINT(${filter.point[0]} ${filter.point[1]})`);
  if (filter.pnu) params.set('attrFilter', `pnu:=:${filter.pnu}`);

  const body = await fetchJson<VWorldDataResp>(`https://api.vworld.kr/req/data?${params}`);
  const r = body.response;
  if (r.status === 'NOT_FOUND') return [];
  if (r.status !== 'OK' || !r.result) throw new UpstreamError(`vworld: ${r.error?.text ?? r.status}`, 502);
  return r.result.featureCollection.features.map((f) => ({
    pnu: f.properties.pnu,
    address: f.properties.addr,
    jibun: f.properties.jibun,
    // 공시지가/기준연월 are carried by the cadastral layer itself
    officialPrice: num(f.properties.jiga),
    priceYearMonth: f.properties.gosi_year && f.properties.gosi_month ? `${f.properties.gosi_year}-${f.properties.gosi_month}` : undefined,
    geometry: f.geometry,
    raw: f.properties,
  }));
}

const TILE_LAYERS: Record<string, string> = {
  Base: 'png',
  gray: 'png',
  white: 'png',
  midnight: 'png',
  Hybrid: 'png',
  Satellite: 'jpeg',
};

export function vworldRouter() {
  const r = Router();

  r.get('/parcel', async (req, res) => {
    const pnu = typeof req.query.pnu === 'string' ? req.query.pnu : undefined;
    const lon = num(req.query.lon);
    const lat = num(req.query.lat);
    if (pnu !== undefined && !PNU_RE.test(pnu)) {
      res.status(400).json({ error: 'pnu must be 19 digits' });
      return;
    }
    if (pnu === undefined && (lon === undefined || lat === undefined)) {
      res.status(400).json({ error: 'pnu or lon/lat is required' });
      return;
    }
    try {
      res.json(await cadastral(pnu ? { pnu } : { point: [lon!, lat!] }));
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get('/tiles/vworld/:layer/:z/:y/:x', async (req, res) => {
    // VWorld renamed the gray base map to "white"; keep the old name working for existing clients.
    const layer = req.params.layer === 'gray' ? 'white' : req.params.layer;
    const ext = TILE_LAYERS[layer];
    const [z, y, x] = [req.params.z, req.params.y, req.params.x].map(Number);
    if (!ext || ![z, y, x].every(Number.isInteger) || z < 0 || z > 19) {
      res.status(400).end();
      return;
    }
    try {
      const key = requireEnv('VWORLD_KEY');
      const up = await fetch(`https://api.vworld.kr/req/wmts/1.0.0/${key}/${layer}/${z}/${y}/${x}.${ext}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!up.ok) {
        res.status(up.status === 404 ? 404 : 502).end();
        return;
      }
      res.setHeader('Content-Type', up.headers.get('content-type') ?? `image/${ext}`);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
