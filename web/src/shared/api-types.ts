// Shared between the Express proxy (server/) and the React client.

export interface GeocodeResult {
  source: 'address' | 'keyword';
  label: string;
  jibun?: string;
  road?: string;
  lon: number;
  lat: number;
  bCode?: string;
  category?: string;
  /** exact: single address point, region: 행정구역/도로 중심, poi: keyword hit */
  precision: 'exact' | 'region' | 'poi';
}

export type BatchGeocodeRow =
  | { query: string; status: 'ok'; best: GeocodeResult; candidates: number }
  | { query: string; status: 'notfound' | 'empty' | 'error' };

export interface ReverseResult {
  lon: number;
  lat: number;
  jibun?: string;
  road?: string;
  building?: string;
  bCode?: string;
  hCode?: string;
  hName?: string;
  mountain: boolean;
  mainNo?: string;
  subNo?: string;
}

export interface ParcelResult {
  pnu: string;
  address?: string;
  jibun?: string;
  officialPrice?: number;
  priceYearMonth?: string;
  geometry: GeoJSON.Geometry;
  raw: Record<string, string>;
}
