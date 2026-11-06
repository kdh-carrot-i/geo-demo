import { apiFetch } from './assess/client';
import type { BatchGeocodeRow, GeocodeResult, ParcelResult, ReverseResult } from './shared/api-types';

async function get<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${path}?${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  geocode: (q: string) => get<GeocodeResult[]>('/api/geocode', { q }),
  reverse: (lon: number, lat: number) => get<ReverseResult>('/api/reverse', { lon, lat }),
  parcelAt: (lon: number, lat: number) => get<ParcelResult[]>('/api/parcel', { lon, lat }),
  parcelByPnu: (pnu: string) => get<ParcelResult[]>('/api/parcel', { pnu }),
  /** 건축물대장 + 입점 점포 (Agent API) */
  async parcelDetail(pnu: string): Promise<unknown> {
    // Agent API (/api/v1)는 AGENT_API_KEYS로 보호된다: 심사 화면과 같은 키(저장값, 없으면 한 번 묻기)를 쓴다
    const res = await apiFetch(`/parcels/${pnu}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.detail ?? body?.title ?? `HTTP ${res.status}`);
    return body;
  },
  /** 건물(동) 선택: 누른 지점의 동 외곽선 + 그 동의 건축물대장 (Agent API) */
  async buildingAt(lon: number, lat: number): Promise<unknown> {
    const res = await apiFetch(`/buildings/at?lat=${lat}&lng=${lon}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.detail ?? body?.title ?? `HTTP ${res.status}`);
    return body;
  },
  async geocodeBatch(addresses: string[]): Promise<BatchGeocodeRow[]> {
    const res = await fetch('/api/geocode/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  },
};
