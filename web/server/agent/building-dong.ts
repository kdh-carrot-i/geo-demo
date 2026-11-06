// 건물(동) 단위 조회 (지도 도구 "건물(동) 선택"): VWorld 건축물정보(LT_C_BLDGINFO)의 동 외곽선 → 필지(PNU) → 건축물대장 표제부·층별개요 중 그 동.
// 아파트 대단지처럼 필지 하나에 여러 동이 있는 곳을 동별로 나눠 본다. PNU는 그대로 상위 키이고 동은 그 아래 단계.
// 점포는 상가정보에 동 정보가 없고(전국 0%) 좌표도 주소 지점에 몰려 있어 동으로 나눌 수 없다: 필지 단위로만 센다.
import { fetchJson } from '../http.ts';
import { callAll, toBuildingInfo, toFloors, txt, type BuildingInfo, type FloorInfo } from './building.ts';
import { one } from './db.ts';
import { residentRegistry, sgisAdm } from './indicators.ts';
import { resolveLocation } from './location.ts';
import { ApiProblem } from './problem.ts';

interface VwFeature {
  id?: string;
  geometry: GeoJSON.Geometry;
  properties: Record<string, string>;
}

/** 동 이름 비교용: "제101동" = "101동" = "101" */
const dongKey = (s: string) => s.replace(/\s|^제/g, '').replace(/동$/, '').toLowerCase();

async function vworldBuildingAt(lng: number, lat: number): Promise<VwFeature | null> {
  const q = new URLSearchParams({
    service: 'data',
    request: 'GetFeature',
    data: 'LT_C_BLDGINFO', // 건축물정보 (국토교통부 GIS건물통합정보): 동별 외곽선
    key: process.env.VWORLD_KEY ?? '',
    domain: process.env.VWORLD_DOMAIN ?? 'localhost',
    format: 'json',
    crs: 'EPSG:4326',
    geometry: 'true',
    attribute: 'true',
    size: '10',
    geomFilter: `POINT(${lng} ${lat})`,
  });
  const j = await fetchJson<{ response: { status: string; error?: { text: string }; result?: { featureCollection: { features: VwFeature[] } } } }>(`https://api.vworld.kr/req/data?${q}`, undefined, 10000);
  if (j.response.status === 'NOT_FOUND') return null;
  if (j.response.status !== 'OK') throw new ApiProblem(502, 'VWorld 오류', j.response.error?.text ?? j.response.status);
  // 겹치면 이름·동이 있는 쪽
  const fs = j.response.result?.featureCollection.features ?? [];
  return fs.find((f) => f.properties.dong_nm || f.properties.bld_nm) ?? fs[0] ?? null;
}

export interface BuildingDong {
  outline: {
    geometry: GeoJSON.Geometry;
    name: string;
    dong: string;
    floors_above: number | null;
    floors_below: number | null;
    source: string;
  };
  pnu: string | null;
  address: string | null;
  /** 건축물대장 표제부 중 이 동 (못 찾으면 null) */
  register: (BuildingInfo & { floors: FloorInfo[]; floors_note: string | null }) | null;
  match: string;
  /** 거주인구 추정 = 동 세대수 × 행정동 평균 가구원수 (실제 동별 주민 수는 공개되지 않음) */
  residents: { households: number; persons_per_household: number; persons: number; basis: string } | null;
  /** 같은 필지(단지) 전체. buildings = 주건축물 수 (부속건축물 제외) */
  parcel: { buildings: number; households: number | null; stores: number; store_note: string };
  sources: string[];
}

export async function buildingDongAt(lat: number, lng: number): Promise<BuildingDong> {
  const [f, loc] = await Promise.all([vworldBuildingAt(lng, lat), resolveLocation({ lat, lng })]);
  if (!f) throw new ApiProblem(404, '건물 없음', '이 지점에 건물 외곽선이 없습니다. 건물 위를 누르거나 "필지 선택"을 쓰십시오.');
  const p = f.properties;
  const outline = {
    geometry: f.geometry,
    name: txt(p.bld_nm),
    dong: txt(p.dong_nm),
    floors_above: Number(p.grnd_flr) || null,
    floors_below: Number(p.ugrnd_flr) || null,
    source: 'VWorld 건축물정보 (LT_C_BLDGINFO)',
  };

  const pnu = loc.pnu;
  let register: BuildingDong['register'] = null;
  let match = '필지(PNU)를 찾지 못해 건축물대장을 연결하지 못했습니다.';
  let parcelBuildings = 0;
  let parcelHouseholds: number | null = null;
  if (pnu && process.env.DATA_GO_KR_SERVICE_KEY) {
    const title = await callAll('getBrTitleInfo', pnu);
    // 총괄표제부는 단지 합계라 동 목록에서 뺀다
    const dongs = title.items.filter((x) => txt(x.regstrKindCdNm) !== '총괄표제부');
    parcelBuildings = dongs.filter((x) => txt(x.mainAtchGbCdNm) !== '부속건축물').length;
    const hh = dongs.reduce((s, x) => s + (Number(x.hhldCnt) || 0), 0);
    parcelHouseholds = hh || null;
    let hit = outline.dong ? dongs.filter((x) => dongKey(txt(x.dongNm)) === dongKey(outline.dong)) : [];
    if (hit.length) match = `건축물대장 표제부를 동 이름 "${outline.dong}"으로 연결`;
    else if (dongs.length === 1) {
      hit = dongs;
      match = '필지에 건물이 하나뿐이라 그 표제부를 연결';
    } else {
      // 동 이름이 없으면 층수가 같은 주건축물이 하나뿐일 때만 연결
      const sameFloors = dongs.filter((x) => Number(x.grndFlrCnt) === outline.floors_above && txt(x.mainAtchGbCdNm) === '주건축물');
      if (sameFloors.length === 1) {
        hit = sameFloors;
        match = `동 이름이 없어 지상 ${outline.floors_above}층 주건축물로 연결 (추정)`;
      } else match = `필지에 건물이 ${dongs.length}개라 이 외곽선(${outline.dong || '동 이름 없음'})과 맞는 표제부를 고르지 못했습니다.`;
    }
    if (hit.length) {
      const x = hit[0];
      await new Promise((r) => setTimeout(r, 300));
      // 층별개요는 한 번에 100건까지라 대단지(헬리오시티 2,295건)는 앞 500건만 본다
      const floors = await callAll('getBrFlrOulnInfo', pnu).catch(() => ({ total: 0, items: [] }));
      const key = dongKey(txt(x.dongNm));
      const mine = toFloors(floors.items.filter((fl) => dongKey(txt(fl.dongNm)) === key));
      register = {
        ...toBuildingInfo(x),
        floors: mine,
        floors_note:
          !mine.length && floors.total > floors.items.length
            ? `필지 전체 층별개요가 ${floors.total.toLocaleString()}건이라 앞 ${floors.items.length}건만 조회했고 이 동은 그 안에 없습니다.`
            : null,
      };
    }
  }

  // 가구원수: 주민등록 법정동 월별 세대당 인구가 있으면 그것(최신·필지와 같은 법정동), 없으면 SGIS 행정동 인구 ÷ 가구
  const reg = residentRegistry(pnu?.slice(0, 10));
  const sg = reg?.persons_per_household ? undefined : sgisAdm(loc);
  const pph = reg?.persons_per_household ?? (sg?.tot_ppltn && sg.household_cnt ? sg.tot_ppltn / sg.household_cnt : null);
  const pphBasis = reg?.persons_per_household
    ? `${reg.scope} 세대당 인구 ${pph!.toFixed(2)}명`
    : `${loc.adm_nm ?? '행정동'} 평균 가구원수 ${pph?.toFixed(2)}명 (SGIS ${sg?.year}, 인구 ÷ 가구)`;
  const hhDong = register?.households ?? null;
  const residents =
    hhDong && pph && /주택/.test(register?.main_use ?? '')
      ? {
          households: hhDong,
          persons_per_household: Math.round(pph * 100) / 100,
          persons: Math.round(hhDong * pph),
          basis: `건축물대장 세대수 ${hhDong.toLocaleString()} × ${pphBasis}. 실제 동별 주민 수는 공개되지 않아 추정값`,
        }
      : null;

  const stores = pnu ? (one<{ n: number }>('select count(*) n from store where lno_cd = ?', pnu)?.n ?? 0) : 0;
  return {
    outline,
    pnu,
    address: loc.address_road ?? loc.address_jibun,
    register,
    match,
    residents,
    parcel: {
      buildings: parcelBuildings,
      households: parcelHouseholds,
      stores,
      store_note: '상가정보에는 동 정보가 없어(전국 0%) 점포는 필지(단지) 전체로만 셉니다.',
    },
    sources: ['VWorld 건축물정보 (국토교통부 GIS건물통합정보)', '국토교통부 건축HUB 건축물대장 (표제부·층별개요)', 'SGIS 행정동 인구·가구', '소상공인시장진흥공단 상가(상권)정보'],
  };
}
