# archive — 이전 작업 노트 원문

2026-10-29~30 작업 중 쓴 노트 원문을 그대로 보관한다. **최신 내용은 상위 폴더의 01~07 문서**에 통합되어 있으니, 원문은 근거를 더 깊이 볼 때만 연다. 원문 안의 `re/notes/…` 경로는 지금의 `docs/archive/notes/…`를 가리킨다.

## 상권 Agent 기획·데이터 노트 → 통합 문서

| 원문 | 내용 | 통합된 곳 |
|---|---|---|
| `notes/70_reference_services.md` | 소상공인365·오픈업·빅밸류 지표 역분석 (출처 링크 포함) | [02](../02_데이터_확보현황.md) 5장 |
| `notes/80_data_catalog.md` | 지표 → 소스 카탈로그, 2026년 변경 사항 | [02](../02_데이터_확보현황.md) 2·3장 |
| `notes/90_synthesis.md` | 1차 종합 (DW 반영 전) | [02](../02_데이터_확보현황.md) |
| `notes/95_existing_dw.md` | 기존 DW 보유 데이터 상세 | [02](../02_데이터_확보현황.md) 4장 |
| `notes/100_competition_agent_data.md` | 질문 Q1~Q8별 필요 데이터 v0.2 | [02](../02_데이터_확보현황.md) 1·2장, [05](../05_에이전트_설계.md) 2장 |
| `notes/110_nationwide_plan.md` | 전국 확대 계획, 레이크·증분 | [04](../04_수집_갱신.md) |
| `notes/120_erd.md`, `120_erd.mmd` | ERD v1 (병합 전) | [03](../03_DB_설계.md), [`erd.mmd`](../erd.mmd) |
| `notes/130_agent_architecture.md` | 에이전트 아키텍처 v0.1 (상세판) | [05](../05_에이전트_설계.md) |
| `notes/140_nationwide_api_probe.md` | 전국 API 실측 보고 | [02](../02_데이터_확보현황.md) 3장, [04](../04_수집_갱신.md) 3·4장 |
| `notes/security.md` | 보안 요구사항 | [07](../07_보안.md) |

## XRayMap 역분석 기록 (웹 지도 기능 참고용)

원본 프로그램(XRayMap CS, Adobe AIR)을 분석한 기록이다. 지도·지오코딩·공간분석 기능을 웹으로 옮길 때 참고한다. 디컴파일 산출물은 `re/decompiled/`에 있으며 내부 참고용으로만 쓴다.

| 원문 | 내용 |
|---|---|
| `notes/00_scope.md` | 재구현 범위: 제외한 서버 API, 카카오·브이월드 대체 |
| `notes/10_map_core.md` | 지도 초기화, 좌표계 변환, 배경지도, 레이어 |
| `notes/20_geocoding_parcel.md` | 지오코딩·POI 검색·필지 조회, 웹 대체 매핑 |
| `notes/30_spatial_analysis.md` | 밀도·보간·분류·버퍼·컨투어 등 공간분석 |
| `notes/40_data_ui.md` | 데이터 입출력, 화면 |
| `notes/50_modules.md` | 모듈 60개 목록 |
| `notes/60_port_plan.md` | 웹 포팅 단계 |
