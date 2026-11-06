// 건축물대장 (국토교통부 건축HUB, 공공데이터포털): 표제부 + 층별개요 for the parcel the site sits on.
// Looked up live by PNU; a failure only drops this block (the assessment still completes).
import { fetchJson } from '../http.ts';

const BASE = 'https://apis.data.go.kr/1613000/BldRgstHubService';

export interface BuildingInfo {
  name: string;
  kind: string;
  main_use: string;
  detail_use: string;
  structure: string;
  floors_above: number | null;
  floors_below: number | null;
  height_m: number | null;
  total_area_m2: number | null;
  building_area_m2: number | null;
  site_area_m2: number | null;
  coverage_ratio: number | null;
  floor_area_ratio: number | null;
  approval_date: string | null;
  age_years: number | null;
  households: number | null;
  elevators: number | null;
  parking: number | null;
  seismic_design: boolean | null;
}

export interface FloorInfo {
  building: string;
  floor: string;
  use: string;
  detail_use: string;
  area_m2: number | null;
}

export interface Buildings {
  address: string | null;
  buildings: BuildingInfo[];
  /** 필지의 표제부 전체 건수 (buildings는 앞 30건만) */
  buildings_total: number;
  floors: FloorInfo[];
  floors_truncated: boolean;
}

export type Item = Record<string, string | number | null | undefined>;

export const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n !== 0 ? n : null;
};
export const txt = (v: unknown) => String(v ?? '').trim();

function parsePnu(pnu: string) {
  // PNU = 법정동(10) + 대지구분(1: 1 일반, 2 산) + 본번(4) + 부번(4); the API uses platGbCd 0 일반 / 1 산
  return {
    sigunguCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGbCd: pnu[10] === '2' ? '1' : '0',
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
  };
}

async function call(op: string, pnu: string, rows: number, page = 1): Promise<{ total: number; items: Item[] }> {
  const q = new URLSearchParams({ serviceKey: process.env.DATA_GO_KR_SERVICE_KEY ?? '', ...parsePnu(pnu), numOfRows: String(rows), pageNo: String(page), _type: 'json' });
  const j = await fetchJson<{ response?: { body?: { totalCount?: number; items?: { item?: Item | Item[] } | '' } } }>(`${BASE}/${op}?${q}`, undefined, 15000);
  const body = j.response?.body;
  const it = body && typeof body.items === 'object' ? body.items.item : undefined;
  return { total: Number(body?.totalCount ?? 0), items: Array.isArray(it) ? it : it ? [it] : [] };
}

/** 대단지는 표제부가 수백 건: 100건씩 maxPages까지 (초당 호출 제한 때문에 쪽 사이를 띄운다) */
export async function callAll(op: string, pnu: string, maxPages = 5): Promise<{ total: number; items: Item[] }> {
  const first = await call(op, pnu, 100);
  const items = [...first.items];
  for (let p = 2; p <= maxPages && items.length < first.total; p++) {
    await new Promise((r) => setTimeout(r, 300));
    items.push(...(await call(op, pnu, 100, p)).items);
  }
  return { total: first.total, items };
}

function ymd(v: unknown): string | null {
  const s = txt(v);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null;
}

/** 표제부 한 건 → BuildingInfo */
export function toBuildingInfo(x: Item, now = new Date()): BuildingInfo {
  const approval = ymd(x.useAprDay);
  const sum = (...ks: string[]) => ks.reduce((s, k) => s + (num(x[k]) ?? 0), 0);
  return {
    name: [txt(x.bldNm), txt(x.dongNm)].filter(Boolean).join(' '),
    kind: [txt(x.regstrKindCdNm), txt(x.mainAtchGbCdNm)].filter(Boolean).join(' · '),
    main_use: txt(x.mainPurpsCdNm),
    detail_use: txt(x.etcPurps),
    structure: txt(x.strctCdNm),
    floors_above: num(x.grndFlrCnt),
    floors_below: num(x.ugrndFlrCnt),
    height_m: num(x.heit),
    total_area_m2: num(x.totArea),
    building_area_m2: num(x.archArea),
    site_area_m2: num(x.platArea),
    coverage_ratio: num(x.bcRat),
    floor_area_ratio: num(x.vlRat),
    approval_date: approval,
    age_years: approval ? Math.floor((now.getTime() - new Date(approval).getTime()) / (365.25 * 864e5)) : null,
    households: num(x.hhldCnt) ?? num(x.fmlyCnt) ?? num(x.hoCnt),
    elevators: sum('rideUseElvtCnt', 'emgenUseElvtCnt') || null,
    parking: sum('indrAutoUtcnt', 'oudrAutoUtcnt', 'indrMechUtcnt', 'oudrMechUtcnt') || null,
    seismic_design: x.rserthqkDsgnApplyYn === '1' ? true : x.rserthqkDsgnApplyYn === '0' ? false : null,
  };
}

const floorRank = (x: Item) => (txt(x.flrGbCdNm) === '지하' ? -1 : txt(x.flrGbCdNm) === '옥탑' ? 1000 : 0) + (num(x.flrNo) ?? 0) * (txt(x.flrGbCdNm) === '지하' ? -1 : 1);

/** 층별개요 → FloorInfo (동 → 층 순서) */
export function toFloors(items: Item[]): FloorInfo[] {
  return [...items]
    .sort((a, b) => txt(a.dongNm).localeCompare(txt(b.dongNm)) || floorRank(a) - floorRank(b))
    .map((x) => ({
      building: txt(x.dongNm),
      floor: txt(x.flrNoNm) || `${txt(x.flrGbCdNm)} ${txt(x.flrNo)}층`,
      use: txt(x.mainPurpsCdNm),
      detail_use: txt(x.etcPurps),
      area_m2: num(x.area),
    }));
}

export async function lookupBuildings(pnu: string | null): Promise<Buildings | null> {
  if (!pnu || !/^\d{19}$/.test(pnu) || !process.env.DATA_GO_KR_SERVICE_KEY) return null;
  const title = await call('getBrTitleInfo', pnu, 30);
  if (!title.items.length) return null;
  // the per-second limit on data.go.kr: space the two calls
  await new Promise((r) => setTimeout(r, 300));
  const floors = await call('getBrFlrOulnInfo', pnu, 100).catch(() => ({ total: 0, items: [] as Item[] }));

  const now = new Date();
  const buildings = title.items
    .map((x) => toBuildingInfo(x, now))
    // 주건축물 first, then by floor area
    .sort((a, b) => Number(b.kind.includes('주건축물')) - Number(a.kind.includes('주건축물')) || (b.total_area_m2 ?? 0) - (a.total_area_m2 ?? 0));

  return {
    address: txt(title.items[0].newPlatPlc) || txt(title.items[0].platPlc) || null,
    buildings,
    buildings_total: title.total,
    floors: toFloors(floors.items),
    floors_truncated: floors.total > floors.items.length,
  };
}
