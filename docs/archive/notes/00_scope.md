# XRayMap CS → 웹 재구현: 범위 결정

대상: `C:\XRayMap\bizgismap_pro` (biz-gis.com/XRayMap 설치본, VER 2024072502)
- `bizgismap_cs.exe` = Adobe AIR CaptiveAppEntry 스텁 (로직 없음)
- 실제 로직 = `bizgismap_cs.swf` (AS3/Flex + OpenScales) + `module/*.swf` 60개
- 디컴파일 결과: `re/decompiled/main`, `re/decompiled/modules` (JPEXS FFDec 26.4.0)

## 서버 API 처리 방침

| 원본 기능 | 원본 엔드포인트 | 웹 버전 |
|---|---|---|
| 라이선스 | LicenseCheck.php, checkLicenseClient.php, getdbFreeCheck.php | **제외** |
| 로그인 | _login_ok.php, AUTO_LOGIN | **제외** |
| DB | getdb.php?sSQL=, setdb.php | **제외** (로컬 데이터: 파일 업로드/브라우저 저장으로 대체) |
| 설정 | get.php?FILE=set.ini 등 | **제외** (정적 config로 대체) |
| 푸시 | Push_Server/* | **제외** |
| 파일 | writefile.php, deletefolder.php, getFileList.php 등 | **제외** |
| 지오코딩 | bizgis_api1.gislab.co.kr/daum_geocodingForWebXRayMap.php, daum_poi_search.php | **카카오 로컬 API** (서버 프록시로 키 보호) |
| 필지조회 | pnu_simple.php, pnu_total.php | **국가공간정보포털(NSDI)/브이월드 API** (서버 프록시) |

## 지역 범위 (2026-10-29)
1차는 **서울**에 맞춰 진행(유동인구 = 서울 열린데이터광장). 전국 확장은 이후 유료 유동인구 데이터 + ETL로 검토.
데이터 소스는 지역 의존 부분(유동인구)을 어댑터로 분리해 두어 전국 데이터로 교체 가능하게 한다.

## 궁극 목표 (2026-10-29)
**상권 분석 AI Agent 서비스** — 모델 학습 또는 정보 제공에 필요한 정보가 무엇이고, 어디까지 수집 가능한지 확인하는 단계.
진행 순서: **DB화 → 시각화**.
레퍼런스: 소상공인365(bigdata.sbiz.or.kr), 오픈업(openub.com), 빅밸류(bigvalue.ai) — 추가 예정.
산출물: `re/notes/70_reference_services.md`(레퍼런스 지표 역분석), `re/notes/80_data_catalog.md`(지표→소스 매핑·수집 가능성).

## 보안
리버스 엔지니어링을 진행하면서 `re/notes/security.md`에 계속 기록한다.

## 스택
Vite + React + TypeScript + OpenLayers + proj4, 키 보호용 Node(Express) 프록시 → `web/`
