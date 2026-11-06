// Where every number comes from. Indicators and score inputs point at these keys; the response's
// `provenance` lists only the keys actually used, in a fixed order, so the screen can number them.
import { LATEST_Q, one } from './db.ts';

export interface Source {
  key: string;
  /** same as provider (kept for clients of the earlier provenance shape) */
  source: string;
  provider: string;
  dataset: string;
  /** API service name / endpoint (or file) the data was collected from */
  api: string;
  fields: string;
  scope: string;
  as_of: string;
  used_for: string[];
  /** 이용 범위 제한이 있는 소스만: 예) 내부 심사 한정 */
  license?: string;
}

/**
 * internal (기본): 내부 심사 서비스. 공공누리 2유형처럼 상업 이용이 제한된 소스도 쓴다 (2026-11-02 결정, docs/10 L-1·L-2).
 * external: 외부 제공. 아래 INTERNAL_ONLY 소스를 쓰지 않는다. 외부 오픈 전 외부 자문으로 확정한다.
 */
export const DATA_SCOPE: 'internal' | 'external' = process.env.DATA_SCOPE === 'external' ? 'external' : 'internal';
export const INTERNAL_ONLY = new Set(['gg_flowpop', 'model_flowpop']);
export const INTERNAL_ONLY_LICENSE = '내부 심사 한정 — 원천 공공누리 2유형(상업적 이용 금지). 외부 제공 전 외부 자문 (docs/10 L-1·L-2)';
export const internalDataAllowed = () => DATA_SCOPE === 'internal';

const metaPeriod = (table: string) => one<{ p: string }>('select std_period p from meta_source where table_name = ?', table)?.p ?? '';
function rentPeriod() {
  const w = one<{ w: string }>("select max(wrttime_idtfr_id) w from rone_stat where statbl_nm like '임대동향 층별임대료%' and wrttime_idtfr_id like '20%'")?.w;
  return w ? `${w.slice(0, 4)}년 ${Number(w.slice(4))}분기` : '';
}
const q = (yq: string) => (yq ? `${yq.slice(0, 4)}년 ${yq[4]}분기` : '');

/** Static description of each source; `as_of` filled from meta_source where we have it. */
function registry(): Record<string, Omit<Source, 'key' | 'source' | 'used_for'>> {
  const sgis = (() => {
    try {
      return JSON.parse(metaPeriod('sgis_adm_stats')) as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  })();
  return {
    kakao_local: {
      provider: '카카오',
      dataset: '로컬 API — 주소 검색·좌표→행정구역',
      api: 'dapi.kakao.com/v2/local/search/address, geo/coord2address, geo/coord2regioncode',
      fields: '도로명·지번 주소, 법정동·행정동 코드',
      scope: '전국, 실시간',
      as_of: '요청 시점',
    },
    seoul_trdar: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울시 상권분석서비스 — 상권영역',
      api: 'openapi.seoul.go.kr · TbgisTrdarRelm',
      fields: '상권 코드·이름·유형, 중심 좌표, 면적',
      scope: '서울 1,650개 상권',
      as_of: '현행',
    },
    sbiz_zone: {
      provider: '소상공인시장진흥공단 (공공데이터포털)',
      dataset: '상권영역 (주요 상권 경계)',
      api: 'apis.data.go.kr · B553077/api/open/sdsc2/storeZoneInAdmi',
      fields: '상권 번호·이름, 경계 다각형, 면적',
      scope: '전국 1,227개 상권',
      as_of: '2024-01-01 기준',
    },
    seoul_flpop: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울시 상권분석서비스 — 길단위인구(상권)',
      api: 'openapi.seoul.go.kr · VwsmTrdarFlpopQq',
      fields: 'tot_flpop_co(총 유동인구), 시간대별·연령대별·요일별 유동인구',
      scope: '상권 단위, 분기',
      as_of: q(LATEST_Q),
    },
    seoul_repop: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울시 상권분석서비스 — 상주인구(상권)',
      api: 'openapi.seoul.go.kr · VwsmTrdarRepopQq',
      fields: 'tot_repop_co(상주인구), tot_hshld_co(가구), apt_hshld_co(아파트 가구)',
      scope: '상권 단위, 분기',
      as_of: q(LATEST_Q),
    },
    seoul_wrcpop: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울시 상권분석서비스 — 직장인구(상권)',
      api: 'openapi.seoul.go.kr · VwsmTrdarWrcPopltnQq',
      fields: 'tot_wrc_popltn_co(직장인구)',
      scope: '상권 단위, 분기',
      as_of: q(LATEST_Q),
    },
    seoul_sales: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울시 상권분석서비스 — 추정매출(상권)',
      api: 'openapi.seoul.go.kr · VwsmTrdarSelngQq',
      fields: 'thsmon_selng_amt(월 매출 금액) ÷ 점포 수',
      scope: '상권 × 서비스업종, 분기 공개(금액은 월 단위)',
      as_of: q(LATEST_Q),
    },
    seoul_store: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울시 상권분석서비스 — 점포(상권)',
      api: 'openapi.seoul.go.kr · VwsmTrdarStorQq',
      fields: 'similr_induty_stor_co(유사업종 점포 수 = 일반 + 프랜차이즈)',
      scope: '상권 × 서비스업종, 분기',
      as_of: q(LATEST_Q),
    },
    seoul_livingpop: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울 생활인구 (내국인) — 250m 격자를 행정동으로 합산 (2026-08부터 행정동 단위 생산 종료)',
      api: 'data.seoul.go.kr · OA-22784 일별 파일 (Open API Se250MSpopLocalResd)',
      fields: '생활인구합계 (격자 × 시간, 3명 이하 연령 칸은 비공개)',
      scope: '행정동 × 시간, 최근 7일 평균',
      as_of: metaPeriod('living_pop_dong_h'),
    },
    busan_livingpop: {
      provider: '부산광역시 (공공데이터포털)',
      dataset: '부산 행정동 생활인구 — 시간대 (통신 기지국)',
      api: 'apis.data.go.kr · 6260000/DongPopTimeService/getDongPopTime (15164444)',
      fields: 'hpopAvg·wpopAvg·vpopAvg (주거·직장·방문 인구, 하루 평균)',
      scope: '행정동 × 시간, 최근 월 하루 평균',
      as_of: metaPeriod('busan_livepop_dong_h'),
    },
    model_sales_v2: {
      provider: '자체 모델',
      dataset: '자체 매출 모델 — 매장 단위 월 매출, 전국 (업종 묶음별)',
      api: '자체 모델 (서버 내부 계산)',
      fields: 'p10·p50·p90 (프랜차이즈·개인), 카드 결제 규모와 총매출 환산값',
      scope: '학습: 카드 가맹점 월 매출 (3개월 이상, 월 30만 원 이상), 시군구 단위 검증',
      as_of: metaPeriod('card_sales_m'),
    },
    card_sales: {
      provider: '사내 데이터 (카드 가맹점 매출, 신용정보사 동네 통계, 격자 유동인구)',
      dataset: '사내 데이터 저장소 (카드매출·동네 소득·업종 통계·격자 유동인구)',
      api: '사내 데이터 (원자료는 화면·API에 내보내지 않음)',
      fields: '매장 월 매출·건수, 동네 소득·업종 통계, 격자 보행인구',
      scope: '학습과 주변 비교값(중앙값)에만 사용',
      as_of: metaPeriod('card_sales_m'),
    },
    arch_permit: {
      provider: '국토교통부 (건축HUB, 공공데이터포털)',
      dataset: '건축HUB 건축인허가정보 — 기본개요 (15136267)',
      api: 'apis.data.go.kr · 1613000/ArchPmsHubService/getApBasisOulnInfo',
      fields: '주용도·연면적·허가일·착공일·사용승인일 (2022-08 이후 기록, 300㎡ 이상 비주거)',
      scope: '법정동. 건물(PNU)별 최신 기록',
      as_of: metaPeriod('arch_permit'),
    },
    housing_permit: {
      provider: '국토교통부 (건축HUB, 공공데이터포털)',
      dataset: '건축HUB 주택인허가정보 — 기본개요 (15136560)',
      api: 'apis.data.go.kr · 1613000/HsPmsHubService/getHpBasisOulnInfo',
      fields: '세대수·승인일·착공·사용검사(입주) 예정일, 좌표는 카카오 주소 검색',
      scope: '3년 내 입주 예정 100세대 이상 단지',
      as_of: metaPeriod('housing_permit'),
    },
    nps_workplace: {
      provider: '국민연금공단 (공공데이터포털)',
      dataset: '국민연금 가입 사업장 내역 (15083277)',
      api: 'data.go.kr 파일 (월별 CSV)',
      fields: '가입자수·당월고지금액 (사업장별, 법정동까지 주소)',
      scope: '법정동. 법인 3인·개인 10인 이상. 직원은 본사 주소로 등록돼 300인 이하만 근무지로 봄',
      as_of: metaPeriod('nps_workplace'),
    },
    resident_registry: {
      provider: '행정안전부 (공공데이터포털)',
      dataset: '법정동별 주민등록 인구 및 세대현황 (15108071)',
      api: 'apis.data.go.kr · 1741000/stdgPpltnHhStus',
      fields: '총인구·세대수·세대당 인구 (월별)',
      scope: '법정동 (필지 PNU 앞 10자리), 최근 월과 12개월 전',
      as_of: metaPeriod('resident_pop_bjd'),
    },
    sgis_population: {
      provider: '통계청 (SGIS 통계지리정보서비스)',
      dataset: '총조사 주요지표 — 인구',
      api: 'sgisapi.mods.go.kr · OpenAPI3/stats/population.json',
      fields: 'tot_ppltn(총인구), ppltn_dnsty(인구밀도), avg_age(평균 연령)',
      scope: '전국 행정동',
      as_of: sgis.population ? `${sgis.population}년` : '',
    },
    sgis_household: {
      provider: '통계청 (SGIS 통계지리정보서비스)',
      dataset: '총조사 주요지표 — 가구',
      api: 'sgisapi.mods.go.kr · OpenAPI3/stats/household.json',
      fields: 'household_cnt(가구 수)',
      scope: '전국 행정동',
      as_of: sgis.household ? `${sgis.household}년` : '',
    },
    sgis_company: {
      provider: '통계청 (SGIS 통계지리정보서비스)',
      dataset: '전국사업체조사 — 사업체',
      api: 'sgisapi.mods.go.kr · OpenAPI3/stats/company.json',
      fields: 'corp_cnt(사업체 수), tot_worker(종사자 수)',
      scope: '전국 행정동',
      as_of: sgis.company ? `${sgis.company}년` : '',
    },
    sbiz_store: {
      provider: '소상공인시장진흥공단 (공공데이터포털)',
      dataset: '상가(상권)정보 — 시도별 파일',
      api: 'data.go.kr 파일데이터 15083033 (같은 내용 API: B553077/api/open/sdsc2)',
      fields: '상호·지점명, 업종 소분류, 시도, 층, 좌표',
      scope: '전국 점포 단위',
      as_of: metaPeriod('store'),
    },
    license_food: {
      provider: '행정안전부 (지방행정 인허가 데이터)',
      dataset: '일반음식점 인허가 (파일)',
      api: '업종별 CSV 파일 다운로드 · general_food_store.csv',
      fields: '인허가일, 폐업일, 영업 상태, 업태, 시설 면적, 좌표',
      scope: '전국 점포 단위',
      as_of: metaPeriod('license_event'),
    },
    rone_rent: {
      provider: '한국부동산원 (R-ONE 부동산통계)',
      dataset: '상업용부동산 임대동향 — 층별 임대료, 지역별 공실률',
      api: 'www.reb.or.kr/r-one/openapi · SttsApiTblData (통계표: 층별임대료·공실률 2024년3분기~/2026년3분기~)',
      fields: '층별 ㎡당 월 임대료(중대형·소규모 상가), 공실률',
      scope: '조사 상권(전국 약 300곳) 또는 시도, 분기',
      as_of: rentPeriod(),
    },
    molit_building: {
      provider: '국토교통부 (건축HUB, 공공데이터포털)',
      dataset: '건축물대장 — 표제부·층별개요',
      api: 'apis.data.go.kr · 1613000/BldRgstHubService/getBrTitleInfo, getBrFlrOulnInfo',
      fields: '주용도, 구조, 층수, 연면적, 건폐율·용적률, 사용승인일, 층별 용도·면적',
      scope: '필지(PNU) 단위, 실시간',
      as_of: '요청 시점',
    },
    vworld_cadastral: {
      provider: '국토교통부 (브이월드)',
      dataset: '연속지적도 · 공시지가',
      api: 'api.vworld.kr/req/data · LP_PA_CBND_BUBUN',
      fields: 'jiga(개별공시지가 원/㎡), 고시 연월',
      scope: '필지, 실시간',
      as_of: '요청 시점',
    },
    nts_status: {
      provider: '국세청 (공공데이터포털)',
      dataset: '사업자등록 상태조회',
      api: 'api.odcloud.kr · nts-businessman/v1/status',
      fields: '납세자 상태(계속·휴업·폐업), 과세유형',
      scope: '요청한 번호 1건, 실시간 (번호는 저장하지 않음)',
      as_of: '요청 시점',
    },
    model_survival: {
      provider: '자체 모델',
      dataset: '자체 3년 생존 모델 — 음식점',
      api: '자체 모델 (서버 내부 계산)',
      fields: '반경 내 음식점 수·개폐업·과거 폐업률, 업태, 시도, 면적',
      scope: '전국 일반음식점 인허가 2018~2022 개업 31.8만 건으로 학습',
      as_of: '2026-10-30 학습',
    },
    model_survival_cvs: {
      provider: '자체 모델',
      dataset: '자체 3년 생존 모델 — 편의점',
      api: '자체 모델 (서버 내부 계산)',
      fields: '가장 가까운 편의점 거리, 반경 내 편의점·같은 브랜드·담배 판매점 수, 개점·실제 폐업, 주변 음식점 수, 브랜드, 시도',
      scope: '전국 편의점 인허가 2019~2020 개점 1.6만 건으로 학습 (간판 교체·양도는 폐업에서 제외)',
      as_of: '2026-11-03 학습',
    },
    license_tobacco: {
      provider: '행정안전부 (지방행정 인허가 데이터)',
      dataset: '담배소매업 인허가 (편의점 판별: 상호의 브랜드명)',
      api: 'apis.data.go.kr · 1741000/tobacco_retailers/info (인허가일 구간별 조회)',
      fields: '인허가일, 폐업일, 영업 상태, 상호, 좌표',
      scope: '전국, 2016년 이후 인허가 전부 + 그 이전은 영업 중만',
      as_of: metaPeriod('license_event:tobacco_retailers'),
    },
    model_survival_cafe: {
      provider: '자체 모델',
      dataset: '자체 3년 생존 모델 — 카페',
      api: '자체 모델 (서버 내부 계산)',
      fields: '가장 가까운 카페 거리, 반경 내 카페·같은 브랜드·프랜차이즈 카페·휴게음식점 수, 개점·실제 폐업, 주변 음식점 수, 브랜드, 시도',
      scope: '전국 카페(휴게음식점 커피숍) 인허가 2019~2020 개점 2.8만 건으로 학습 (간판 교체·양도는 폐업에서 제외)',
      as_of: '2026-11-04 학습',
    },
    license_rest_cafe: {
      provider: '행정안전부 (지방행정 인허가 데이터)',
      dataset: '휴게음식점 인허가 (카페 판별: 업태 커피숍, 일반음식점 업태 까페 포함)',
      api: 'apis.data.go.kr · 1741000/rest_cafes/info (인허가일 구간별 조회)',
      fields: '인허가일, 폐업일, 영업 상태, 업태, 상호, 좌표',
      scope: '전국, 2016년 이후 인허가 전부 + 그 이전은 영업 중만',
      as_of: metaPeriod('license_event:rest_cafes'),
    },
    model_sales: {
      provider: '자체 모델',
      dataset: '자체 월 매출 모델 — 서울 상권',
      api: '자체 모델 (서버 내부 계산)',
      fields: '상권 인구·점포·개폐업률, 업종',
      scope: '서울 상권 × 업종 8개 분기로 학습',
      as_of: '2026-10-30 학습',
    },
    kakao_category: {
      provider: '카카오',
      dataset: '로컬 API — 카테고리로 장소 검색',
      api: 'dapi.kakao.com/v2/local/search/category (SW8 지하철역, PK6 주차장, MT1·SC4·AC5·HP8·PM9·BK9·PO3·CT1·AT4·AD5)',
      fields: '장소명, 거리, 반경 안 개수(total_count)',
      scope: '전국, 중심 반경, 실시간',
      as_of: '요청 시점',
    },
    seoul_subway: {
      provider: '서울시 (서울 열린데이터광장)',
      dataset: '서울 지하철 역별 승하차 — 일별, 시간대별',
      api: 'openapi.seoul.go.kr · CardSubwayStatsNew, CardSubwayTime',
      fields: '역·노선별 승차·하차 인원 → 하루 평균, 가장 붐비는 시간대',
      scope: '서울 지하철역',
      as_of: metaPeriod('subway_daily'),
    },
    ftc_franchise: {
      provider: '공정거래위원회 (공공데이터포털)',
      dataset: '가맹사업 정보 — 브랜드별 가맹점 현황·창업 금액',
      api: 'apis.data.go.kr · 1130000/FftcBrandFrcsStatsService/getBrandFrcsStats, FftcBrandFntnStatsService/getBrandFntnStats',
      fields: '가맹점 수, 신규 개점, 계약 종료·해지, 평균 매출, 3.3㎡당 매출, 가맹비·교육비·보증금·기타 비용',
      scope: '브랜드 단위 (전국, 지역 구분 없음), 연',
      as_of: metaPeriod('franchise_brand_y').split(',')[0] ? `${metaPeriod('franchise_brand_y').split(',')[0]}년 공개분` : '',
    },
    regional_subway: {
      provider: '부산·대구·인천·광주·대전 교통공사',
      dataset: '도시철도 역별 일별(시간대별) 승하차 인원',
      api: 'data.go.kr 파일데이터 3057229(부산) · 15002503(대구) · 15159353(인천) · 15060048(광주) · 15060591(대전)',
      fields: '역별 승차+하차 → 하루 평균, 가장 붐비는 시간 (인천은 시간대 없음)',
      scope: '서울 밖 도시철도역',
      as_of: metaPeriod('subway_station_stats'),
    },
    bus_stop: {
      provider: '국토교통부 · 서울시',
      dataset: '전국 버스정류장 위치정보 (TAGO 연계 지자체) + 서울시 버스정류소 위치정보',
      api: 'data.go.kr 파일데이터 15067528 · openapi.seoul.go.kr busStopLocationXyInfo',
      fields: '정류장명, 위도·경도',
      scope: '전국 정류장 (서울은 서울시 API로 보강, 연 1회 수집본)',
      as_of: metaPeriod('bus_stop'),
    },
    gg_flowpop: {
      provider: '경기도 (경기데이터드림, 원천 KT)',
      dataset: '경기도 유동인구 행정동 단위 집계 (내국인)',
      api: '경기데이터드림 파일 다운로드 · 경기유동인구_행정동 단위 집계',
      fields: '시간대·성별·연령별 유동인구 → 시간당 평균, 시간대 비중',
      scope: '경기 17개 시 416개 행정동, 한 달 평균',
      as_of: metaPeriod('gg_flowpop_dong_h'),
    },
    model_flowpop: {
      provider: '자체 모델',
      dataset: '행정동 유동인구 추정 flowpop-v0 (Ridge 회귀)',
      api: '자체 모델 (서버 내부 계산)',
      fields: 'SGIS 인구·가구·종사자·사업체·밀도, 상가정보 대분류별 점포 수',
      scope: '경기 실측 408개 행정동으로 학습, 전국 행정동에 적용 (시 단위 검증 R² 0.89)',
      as_of: '2026-11-02 학습',
    },
    claude_vision: {
      provider: 'Anthropic',
      dataset: 'Claude — 로드뷰 판독·요약',
      api: 'api.anthropic.com · messages',
      fields: '고객이 담은 로드뷰 화면',
      scope: '요청 1건 (이미지는 저장하지 않음)',
      as_of: '요청 시점',
    },
  };
}

/** Fixed display order so the footnote numbers are stable across assessments. */
const ORDER = [
  'kakao_local', 'seoul_trdar', 'sbiz_zone', 'seoul_flpop', 'seoul_repop', 'seoul_wrcpop', 'seoul_livingpop', 'busan_livingpop', 'resident_registry', 'nps_workplace', 'arch_permit', 'housing_permit', 'model_sales_v2', 'card_sales',
  'gg_flowpop', 'model_flowpop', 'seoul_subway', 'regional_subway', 'bus_stop', 'kakao_category', 'sgis_population', 'sgis_household', 'sgis_company', 'seoul_sales', 'seoul_store', 'sbiz_store', 'ftc_franchise',
  'license_food', 'rone_rent', 'molit_building', 'vworld_cadastral', 'nts_status', 'model_survival', 'model_survival_cvs', 'license_tobacco', 'model_survival_cafe', 'license_rest_cafe', 'model_sales', 'claude_vision',
];

export class SourceTracker {
  private used = new Map<string, Set<string>>();

  use(key: string, purpose: string): string {
    if (!this.used.has(key)) this.used.set(key, new Set());
    this.used.get(key)!.add(purpose);
    return key;
  }

  list(): Source[] {
    const reg = registry();
    // `source` repeats provider for clients written against the earlier provenance shape
    return ORDER.filter((k) => this.used.has(k)).map((k) => ({
      key: k,
      source: reg[k].provider,
      ...reg[k],
      used_for: [...this.used.get(k)!],
      ...(INTERNAL_ONLY.has(k) ? { license: INTERNAL_ONLY_LICENSE } : {}),
    }));
  }
}
