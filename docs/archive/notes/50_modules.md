# 50 — 모듈 인벤토리 (module/*.swf 60개)

근거: `re/decompiled/modules/<mod>.swf/scripts/module/*.as`, 로더는 `re/decompiled/main/scripts/bizgismap_cs.as`(이하 `main`), 메뉴 코드는 `main/scripts/com/seld/draw/UserInit.as` `mainMenuClick`(이하 `UserInit`).
정적 분석만 수행. 행 번호는 디컴파일 결과 기준.

## 로딩 방식 요약

- 거의 모든 모듈은 `new ModuleLoader(); url = "module/modXXX.swf"` 형태로 `main`의 `ShowXXXPanel()` / `MOD_XXX_*()` 함수에서 로드(팝업 TitleWindow 또는 slideLeft/Right/Bottom 패널에 addElement).
- 고객사 분석 모듈은 `SetSlidePanel(sCompany)` (`main:4832`)에서 **로그인/설정으로 정해진 회사 코드(`m_sCompanyName`)** 로 URL을 조립: `"module/mod" + sCompany + "_Analyst.swf"` (`main:5020`). 호출원: `UserLogIn.as:93/120`, `UserLogInProcess.as:313/340`, `UserInit.as:928`(HEALTH), `main:2330`.
- 메뉴 항목(`sVal == "x-y"`)의 메뉴 XML은 서버 `get.php?FILE=<company>menu.xml` 에서 받음(`UserInit:1415-1416`) → 메뉴 구성 자체는 서버/고객사별.
- `modTOC`, `modCallOutView`, `modLeftSimpleMenuForDensityRedraw`, `modLeftSimpleMenuForFLOATING` 는 **메인 SWF에 정적으로 컴파일**되어 있음(`main:195-199`, `main:9682`, `main:11859/11871/12325`, 소스는 `main/scripts/module/*.as`). 같은 이름의 독립 SWF는 디컴파일 결과에 메인 클래스가 없음(FlexModuleFactory의 `mainClassName`만 존재 → FFDec 누락 또는 빈 껍데기, **미확인**). 웹 포팅 시 `main/scripts/module/*.as` 를 기준으로 할 것.
- "app-getdb" = 모듈이 `parentApplication.objSQL.GetSQL()` + `m_sURL/m_sASP_DB`(set.ini에서 받은 `getdb.php`) 또는 `RunTotalFun`/`objUserGetDataBase`를 통해 SQL을 서버로 보내는 경로(→ 범위상 **제외된 API**). "app-setdb" = `objUserSetDataBase.SetDB()`(setdb.php).

## 분류 기준
- **CORE**: 범용 GIS 기능 → 포팅 대상(데이터 소스만 로컬 파일/카카오/VWorld/NSDI 로 대체).
- **CUSTOMER**: 특정 고객사 전용(HEALTH/SEOUL/AURI/TOZ/CJP/SJ/SB/JJ/ORBITECH/SMARTCARD/PUBLIC_BUILDING/Policy/GJE/FLOATING/NPB). "범용 로직 가치" 열에 포팅할 만한 일반화 로직 여부 기재.
- **EXCLUDED**: 제외 API(로그인·회원·업로드/백업·SMS/EMAIL·서버 파일·서버 설정 편집·SQL 콘솔)에만 의존.

## 인벤토리

| # | 모듈 | 용도 (1줄) | 로드/트리거 (main) | 서버 엔드포인트 | 분류 | 비고 / 범용 로직 가치 |
|---|---|---|---|---|---|---|
| 1 | modAddPoint | 엑셀/CSV에서 X/Y(경위도·카텍) 필드를 지정해 포인트 레이어 추가, 마커 아이콘(modMarkerList) 선택 | `ShowAddPointPanel` `main:7249` ← 메뉴 `4-2` (`UserInit:1802`) | 없음(로컬 파일, `com/excel`) / `RunTotalFun` 1회 | **CORE** | 파일 업로드 기반이라 웹에 그대로 적합 |
| 2 | modAddProvince | 행정구역 코드별 통계(엑셀 템플릿)를 받아 단계구분도로 표시 | `ShowAddProvincePanel` `main:7297` ← 메뉴 `4-3` (`UserInit:1806`) | 템플릿 다운로드 `http://www.biz-gis.com/XRayMap/Province_2015.xlsx`; 경계는 app-getdb | **CORE** | 경계 폴리곤은 VWorld/정적 GeoJSON 으로 대체 |
| 3 | modAnalystTool | 하단 슬라이드의 "분석 도구": 레이어 조건(빌라·코스닥기업·지목 등) 체크 후 실행 | `InitStage` `main:1801` (항상 로드, slideBottom) | `RunTotalFun`(19회) → app-getdb | **CORE** (UI) | 레이어 카탈로그·데이터는 서버 SQL 의존 → 로컬 레이어 목록으로 재설계 |
| 4 | modAttributeTable | 분석 레이어 속성표, 평균/최소/최대, 영역 포함조건, 엑셀 저장 | `ShowAttributeTable` `main:7190` ← TOC 레이어 메뉴 `main:10355/10366` | 없음 | **CORE** | "인증된 계정에서만 다운로드" 분기는 제거 |
| 5 | modAURI_Analyst | AURI(건축공간연구원) 건물 에너지(전기/가스) 분석 패널(행정동/블록/시군구) | `SetSlidePanel("AURI")` `main:5020` | app-getdb; `http://company.biz-gis.com/AURI_NOTICE1`, `http://www.policymap.or.kr/XRayMap/Chart_htmls/auri/Data_List.html` | CUSTOMER(AURI) | 낮음 — 지역 선택→집계 차트 패턴만 참고 |
| 6 | modBufferAnalyst_By_List | 좌표/주소 목록 각각에 반경 버퍼를 만들고 영역별 정보 추출·클립보드 복사 | `ShowBufferAnalyst_By_ListPanel` `main:6470` ← 메뉴 `3-9`; `MOD_Analyst_iLoad*` `main:6508/6548/6591` | app-getdb(`m_sASP_DB`) | **CORE** | 다중 버퍼 생성은 포팅, 통계 추출은 로컬 데이터로 |
| 7 | modBufferCreateBy_R | 지점+반경(≤500km) 입력으로 원형 버퍼 생성 | `MOD_BufferCreateBy_R_CreateBuffer` `main:8217` ← TOC 메뉴 `modTOC.as:6243` | 없음 | **CORE** | turf.buffer 로 대체 |
| 8 | modCallOutView | 지도 위 콜아웃(말풍선) 뷰 | 메인 정적 클래스 `main:9682/9696` (독립 SWF는 미사용 추정) | 없음 | **CORE** | 소스는 `main/scripts/module/modCallOutView.as` |
| 9 | modDTCreateBy_Min | 차량/도보 이동시간(5–120분) 등시선 영역 생성(서울만) | `MOD_DTCreateBy_Minite` `main:8172` ← TOC `modTOC.as:6431` | `UserSpatialAnalystDTDraw` → `http://www.biz-gis.com/api/dtapi.php` (`UserSpatialAnalystDTDraw.as:184`) | **CORE** (백엔드 대체 필요) | 등시선 API(예: OSRM/Valhalla/상용) 서버 프록시로 교체 |
| 10 | modDensityAnalystTool | 행정구역 단위 집계(합/평균) 및 밀도분석 설정 | `ShowDensityAnalystTool` `main:8483` ← 메뉴 `3-2/3-3/3-4` | 없음(직접) — 결과 그리기는 app-getdb | **CORE** | 집계 로직 포팅 |
| 11 | modFLOATING_Analyst | 유동인구(FLOATING) 시계열·유입지 분석, 차트/PPT 템플릿 출력 | `SetSlidePanel("FLOATING")` | app-getdb; `http://www.policymap.or.kr/XRayMap/Chart_htmls/floating/*`; SMS `http://bizgis.gislab.co.kr/sms_mail/sms_forUrl.php` | CUSTOMER(FLOATING) | 낮음 — 차트/PPT 내보내기 패턴 정도 |
| 12 | modFloatingArea | 유동인구 노출/내부 영역 작성·저장(원격 텍스트 파일) | `SetMMS_Area` `main:9100` ← 메뉴 `8-9` (`UserInit:2011`) | `URL_Return.GetPlugInMMSReadFileUrl()` = `http://policymap.cafe24.com/XRayMap/floating_area/_readFile.php` 및 `_writeFile/_renameFile` | CUSTOMER(FLOATING) | 영역 저장은 로컬 저장으로 대체 가능(낮음) |
| 13 | modGeocoding | 엑셀 주소 일괄 지오코딩 → 포인트 레이어 | `ShowGeocodingPanel` `main:6790` ← 메뉴 `4-1` (`UserInit:1793`); `MOD_Geocoding_DrawGeocoding` `main:7328` | `http://bizgis_api{1..10}.gislab.co.kr/daum_geocodingForWebXRayMapLoop.php?sKey=..`, `naver_geocoding_temp.php`, `http://asp.geocoding.co.kr/land/geocoding_real.asp` (하드코딩 키, security.md S-11) | **CORE** | 카카오 로컬 API(서버 프록시)로 교체. 공개버전 100건 제한 로직 참고 |
| 14 | modHEALTH_Analyst | 헬스맵(국립중앙의료원) 진료권·진료과목 단계별 분석, 병원 선택 팝업 내장 | `SetSlidePanel("HEALTH")` (`UserInit:928`) | app-getdb(12회, HEALTH 은 XOR 난독화 추가, security.md S-03) | CUSTOMER(HEALTH) | 중간 — "단계별 조건 → 집계 → 표/지도" 위저드 구조 |
| 15 | modHEALTH_HOSPITAL | 병원 리스트 선택 팝업(강원 시범) | 독립 로드 없음 — 동일 클래스가 modHEALTH_Analyst 내부 포함(`modHEALTH_Analyst.as:2822`) | app-getdb(`HEALTH_table_병원리스트_etc`) | CUSTOMER(HEALTH) | 독립 SWF는 미사용 추정 |
| 16 | modHEALTH_KAIST_List | 최적 병원 배치안(KAIST) 리스트 지도 출력 | main/다른 모듈에서 참조 없음(orphan) | app-getdb(`HEALTH_table_최적배치안리스트_etc`) | CUSTOMER(HEALTH) | 없음 |
| 17 | modHEALTH_Upload | 헬스맵용 진료권 엑셀 업로드 + 지오코딩 | `ShowHealthmapUploadPanel` `main:6814` ← 메뉴 `9-10` | `/getdb.php`, `/setdb_upload.php`, 지오코딩 프록시(13과 동일 키) | CUSTOMER(HEALTH) / 업로드는 EXCLUDED | 없음 |
| 18 | modImageView | 사용자 위치 메모에 첨부된 서버 이미지 크게 보기 | `MOD_ImageView_ShowContents` `main:7397` ← `main:5163` | `<m_sURL>/getImageFileList.php`, `<m_sURL>/<UserLocation>/ShowImage.php` | **EXCLUDED** (서버 파일) | 로컬 메모 기능 재설계 시 브라우저 저장 이미지로 |
| 19 | modJJ_Analyst | 전주(INFLOW_CD 45113/45111) 유입·시계열 분석 및 PPT 보고서 | `SetSlidePanel("JJ")` | `getdb.php`, `setdb.php`, `http://jj.policymap.kr/XRayMap/Chart_htmls/jj/report_*.xml` | CUSTOMER(JJ) | 낮음 |
| 20 | modJJ2_Analyst | modJJ 의 2차 버전(거의 동일) | `SetSlidePanel("JJ2")` | 19와 동일 | CUSTOMER(JJ) | 낮음 |
| 21 | modLeftSimpleMenu | 좌측 간이 메뉴(구버전, 2020-12 빌드) | 현 main에 로더/선언 없음(`UserInit:1000` 의 `app.MOD_LeftSimpleMenu` 참조는 dead) | 없음(디컴파일 메인 클래스 없음) | EXCLUDED(미사용) | — |
| 22 | modLeftSimpleMenuForDensityRedraw | 밀도 재그리기용 좌측 간이 메뉴 | 메인 정적 클래스 `main:197/11859` | 없음 | **CORE** | 소스 `main/scripts/module/modLeftSimpleMenuForDensityRedraw.as` |
| 23 | modLeftSimpleMenuForFLOATING | 유동인구용 좌측 간이 메뉴 | 메인 정적 클래스 `main:199/11871` | 없음 | CUSTOMER(FLOATING) | 낮음 |
| 24 | modLegend | 범례 패널(이미지 범례 포함) | `MOD_Legend_SetLegend*` `main:7502/7557` ← `modTOC.as:4563-4575` | 상대경로 `../icon/legend_image/<id>.png` | **CORE** | |
| 25 | modLocationSearch | 주소/좌표(경위도·카텍) 검색 이동 | `ShowLocationSearchPanel` `main:6405` ← 메뉴 `2-1` | `http://bizgis_api1.gislab.co.kr/daum_geocodingForWebXRayMapSearch.php?sKey=..` | **CORE** | 카카오 로컬 API(키는 서버) |
| 26 | modLogin | 로그인/비밀번호 변경/가입 요청 다이얼로그 | `MOD_Login_Show2` `main:9047` ← 메뉴 `0-1/0-3/0-4` | 직접 없음 → `UserLogInProcess.CheckLogin2` (getdb SQL) | **EXCLUDED** | security.md S-05/S-06 |
| 27 | modMemberList | 회원 승인/차단/권한 관리 | `MOD_MemberList_OpenWindow` `main:6312` ← 메뉴 `0-5` | app-getdb + app-setdb (회원 테이블) | **EXCLUDED** | |
| 28 | modMemoInsert | 지도 위치 메모(제목/내용/이미지) 등록 | `MOD_MemoInsert_Insert` `main:7908` ← `modTOC.as:6309` | `/imageupload.php`, app-setdb(INSERT `GISUTD.XRY_INFO_USER_LOCATION`, `modMemoInsert.as:518-533`) | **EXCLUDED** (서버) | 기능은 로컬 메모로 재구현 가치 있음 |
| 29 | modMemoInsert2 | 메모 + 참고 문서 첨부 | `MOD_MemoInsert_Insert2` `main:7964` ← `modTOC.as:6297` | `/docupload.php`, app-setdb | **EXCLUDED** | 28과 같음 |
| 30 | modORBITECH_Analyst | 환경영향평가 Tool(작업지점·방위각·행정동 추출) | `SetSlidePanel("ORBITECH")` | app-getdb | CUSTOMER(ORBITECH) | 중간 — 방위각 섹터 생성 로직 |
| 31 | modPolicy_Analyst | 정책지도(지자체 GS/GH/DDM/…/GJE/COWAY/NPB 등) 지표 트리 → 시군구/행정동/사용자영역 분석, 보고서 마법사 호출 | `SetSlidePanel` `main:4903/4934/4964` (`checkPolycymap` 회사들, `iSetCD`) | app-getdb(13), `http://bizgis_api1.gislab.co.kr/daum_geocodingForWebXRayMapLoop.php`, `http://www.biz-gis.com/XRayMap/html_module/production/_chart.html` | CUSTOMER(Policy) | **높음** — 지표 트리 + 행정단위 단계구분도는 범용 "통계지도" 로 일반화 가치 |
| 32 | modProvinceWhere | 분석 대상 행정구역(광역/시군구) 조건 입력 | `ShowProvinceWherePanel` `main:6424` ← `modTOC.as:4333/4363` | app-getdb(`xray_provincecombo_시군구콤보_etc`) | **CORE** | 행정구역 코드표는 정적 JSON 으로 |
| 33 | modPUBLIC_BUILDING_Analyst | 공공건축물(국유/도유/군유, 역세권 50M 등) 분석 | `SetSlidePanel("PUBLIC_BUILDING")` | app-getdb | CUSTOMER(PUBLIC_BUILDING) | 낮음 |
| 34 | modSaveImage | 지도 이미지(컬러/흑백, 범례 포함) 저장 | `ShowSaveImagePanel` `main:7225` ← 메뉴 `1-19` | 없음 | **CORE** | OpenLayers canvas export 로 |
| 35 | modSB_Analyst | 커피전문점(파스쿠치/투썸/커피빈 등) 경쟁 상권·가중치 반경 분석 | `SetSlidePanel("SB")` | app-getdb; `http://www.biz-gis.com/XRayMap/Chart_htmls/sb/report_ppt.xml` | CUSTOMER(SB) | 중간 — 가중 반경 상권 점수 |
| 36 | modSEOUL_Analyst | 서울 발달상권/골목상권 블록 탐색, 로컬 폴더에 결과 저장, 완료 SMS | `SetSlidePanel("SEOUL")` | app-getdb; SMS `http://bizgis.gislab.co.kr/sms_mail/sms_forUrl.php`; 로컬 `File` 쓰기(65회) | CUSTOMER(SEOUL) | 중간 — 블록 union 알고리즘은 참고 가치 |
| 37 | modServerFileDialog | 서버 사용자 폴더 파일 열기/저장/삭제 | `MOD_ServerFileDialog_*` `main:8064/8096/8128` ← `modTOC.as:1571`, `main:6078` | `/getUserFileList.php`, `/getFileServerText.php`, `/deletefile.php`, `/deletefolder.php` (파라미터 XOR 난독화, `modServerFileDialog.as:419-478`) | **EXCLUDED** | 프로젝트 파일 → 로컬 다운로드/업로드로 대체 |
| 38 | modShowDensitySymbol | 밀도 레이어 색상/Search R/투명도 편집 | `ShowDensitySymbol` `main:8684` ← `main:10539` | 없음 | **CORE** | |
| 39 | modShowLabelSymbol | 라벨 표현 항목/정렬/투명도 | `ShowLabelSymbol` `main:8547` ← `main:10555` | 없음 | **CORE** | |
| 40 | modShowLineSymbol | 라인 색상/분류 심볼 | `ShowLineSymbol` `main:8749` ← `main:10535` | 없음 | **CORE** | |
| 41 | modShowPointSymbol | 포인트 심볼(도형/이미지 마커) 편집, modMarkerList 포함 | `ShowPointSymbol` `main:8878` ← `main:10520` | `../icon/marker_list/<id>.png` | **CORE** | |
| 42 | modShowPolygonSymbol | 폴리곤 색상·분류 심볼 | `ShowPolySymbol` `main:8815` ← `main:10526` | 없음 | **CORE** | |
| 43 | modSJ_Analyst | 포인트/집계구/읍면동 단위 연면적 등 집계 | `SetSlidePanel("SJ")` | app-getdb | CUSTOMER(SJ) | **중간~높음** — 다단위 집계는 범용화 가능 |
| 44 | modSMARTCARD_Analyst | 교통카드 OD(출발/도착/환승, 출퇴근 시간대) 분석 | `SetSlidePanel("SMARTCARD")` | app-getdb | CUSTOMER(SMARTCARD) | 중간 — OD 흐름 시각화 |
| 45 | modSMS_EMAIL | 결과 URL 단축 후 SMS/이메일 전송, 클립보드 복사 | `ShowSMS_EMAILPanel` `main:5764` ← `UserSetDataBase.as:333` | `http://www.biz-gis.com/XRayMap_Html5/getShortURL.php`, `http://bizgis.gislab.co.kr/sms_mail/{sms,mail}_forUrl.php` | **EXCLUDED** | 클립보드 공유만 유지 |
| 46 | modSourceViewer | 개발자용 SQL 콘솔: 임의 SQL 실행·결과 표시 | `ShowSourceViewerPanel` `main:5790` ← 메뉴 `9-9` | `objUserGetDataBase.RunGetDBBySQLDebug(txtSQL)` → getdb (`modSourceViewer.as:223-235`) | **EXCLUDED** | security.md S-01 근거 |
| 47 | modStoreList | 고객사 점포 리스트·통계 추출(slideLeft) | `SetSlidePanel` PAT/HIMART/DEMO/APT/KNOC/YAKULT `main:4887` | `sDBURL` = app-getdb | CUSTOMER(PAT 계열) | 짝인 `modPAT/HIMART/APT/KNOC/YAKULT_Analyst.swf` 는 설치본에 없음 |
| 48 | modTableAndSummary | 질의 결과 표 + 요약(성별/연령) + 엑셀 저장 | `ShowTableAndSummaryPanel` `main:5675` ← `main:2701`, modHEALTH_Analyst | 없음(데이터는 호출자가 전달) | **CORE** | |
| 49 | modTOC | 레이어 목록(TOC), 레이어 컨텍스트 메뉴(심볼/범례/버퍼/메모/파일 저장 등) | 메인 정적 클래스 `MODULE_TOC` `main:195/12325` | 내부에서 getdb, Push 토큰 조회(`modTOC.as:1147`) 등 | **CORE** | 소스 `main/scripts/module/modTOC.as`(독립 SWF는 메인 클래스 없음). Push/서버파일 부분은 제거 |
| 50 | modTOZ_Analyst | TOZ(스터디센터/카페) 가중 반경 상권 분석, 보고서 | `SetSlidePanel("TOZ")` | app-getdb; `http://www.biz-gis.com/XRayMap/Chart_htmls/toz/20141124/report_*` | CUSTOMER(TOZ) | 중간 (SB 와 유사) |
| 51 | modTOZInsert | TOZ 센터/TSF/FASTCAFE 등록·수정 | `MOD_TOZInsert_Insert/Update` `main:7732/7819` ← `modTOC.as:6259-6267` | app-setdb (INSERT/UPDATE `CUSTOMER.XRY_TOZ`, `modTOZInsert.as:761-855`) | CUSTOMER(TOZ) → 사실상 EXCLUDED | 없음 |
| 52 | modUIDesign | 관리자용 레이어 UI XML 템플릿 생성기(필드→체크박스 XML) | `ShowUIDesignPanel` `main:5701` ← 메뉴 `9-8` | `/XRayMap/templet_ui/get.php`, `/get.php`, `XRayMap/policymap_php/addField.php`, `_writeFile.php`, `getdb.php` | **EXCLUDED** | 서버 설정 편집 |
| 53 | modUIXML_Editor | 서버 UI XML 읽기/수정/저장 | `ShowUIXML_EditorPanel` `main:5732` ← modPolicy_Analyst | `m_sXML_GetUrl`(`_readFile`→`_writeFile` 치환, `modUIXML_Editor.as:236/335`) | **EXCLUDED** | |
| 54 | modUpdateAndBackUp | 고객사 서버 버전 업데이트/백업/복원 | `ShowUpdateAndBackUpPanel` `main:7273` ← 메뉴 `9-7`, 비상코드(`main:1963`) | `http://bizgis.gislab.co.kr/XRayMap/Ver/<COMPANY>/_readFile.php`, `<base>/_backup_{list,zip,unzip,remotedownload,deleteTempZip}.php` | **EXCLUDED** | security.md S-07 |
| 55 | modUpload_GJE | GJE 엑셀 업로드(주소 지오코딩 + 서버 적재) | `ShowUpLoadPanel` `main:6833` ← 메뉴 `1-11` | `upload_GJE1.php`, `upload_GJE1_update.php`, `upload_GJE2.php`, 템플릿 `http://www.biz-gis.com/XRayMap/data/GJE_Upload.xlsx` | CUSTOMER(GJE) / EXCLUDED(업로드) | 엑셀 파싱·주소 검증 로직만 참고 |
| 56 | modUploadViewer_GJE | GJE 업로드 이력 조회/삭제 | `ShowUpLoadViewerPanel` `main:6864` ← 메뉴 `1-12` | app-getdb, app-setdb, `upload_GJE3_delete.php` | CUSTOMER(GJE) / EXCLUDED | 없음 |
| 57 | modUserAreaAnalyst | 사용자 영역의 인구 구성(연령비율 등)과 유사지역 추출 | `MOD_UserAreaAnalyst_SetLocalInfoByPolyFeature` `main:7442` ← `main:5220`, `UserCreateArea.as:3189` | app-getdb(12) | **CORE** (데이터 대체 필요) | 통계 격자/집계구 데이터 확보 시 포팅 |
| 58 | modValueClassification | 값 기반 등급 분류(시작/끝 값, 분류 개수, 색상 반전) | `MOD_ValueClassification_SetClass*` `main:8273-8386` ← `UserGetDataBase.as:630/642`, `UserPointDraw.as:818` | 없음 | **CORE** | |
| 59 | modWizardsCJP | CJP(CJ그룹) 보고서 마법사(지도 캡처→보고서) | main/모듈 어디에서도 로드 안 됨(orphan) | 없음(`RunTotalFun` 1회) | CUSTOMER(CJP) | 없음 |
| 60 | modWizardsNPB | NPB/정책지도 보고서 마법사(지도·대중교통·공공건축물 캡처 → PPT) | `ShowReportWizard` `main:8577` ← modPolicy_Analyst | `URLRequest(sUrl)` 3회(템플릿 URL은 런타임 결정, **미확인**) | CUSTOMER(NPB) | 중간 — "지도 캡처 → 보고서" 마법사 UX |

## 집계
- CORE 24: modAddPoint, modAddProvince, modAnalystTool, modAttributeTable, modBufferAnalyst_By_List, modBufferCreateBy_R, modCallOutView, modDTCreateBy_Min, modDensityAnalystTool, modGeocoding, modLeftSimpleMenuForDensityRedraw, modLegend, modLocationSearch, modProvinceWhere, modSaveImage, modShowDensitySymbol, modShowLabelSymbol, modShowLineSymbol, modShowPointSymbol, modShowPolygonSymbol, modTableAndSummary, modTOC, modUserAreaAnalyst, modValueClassification (+ 데이터/백엔드 대체가 필요한 것: AnalystTool, BufferAnalyst_By_List, DTCreateBy_Min, UserAreaAnalyst).
- CUSTOMER 24 (AURI, FLOATING_Analyst, FloatingArea, HEALTH_Analyst/HOSPITAL/KAIST_List/Upload, JJ, JJ2, LeftSimpleMenuForFLOATING, ORBITECH, Policy, PUBLIC_BUILDING, SB, SEOUL, SJ, SMARTCARD, StoreList, TOZ_Analyst, TOZInsert, Upload_GJE, UploadViewer_GJE, WizardsCJP, WizardsNPB). 범용 가치 높음/중간: Policy_Analyst, SJ, ORBITECH, SB/TOZ, SMARTCARD, SEOUL, HEALTH_Analyst, WizardsNPB.
- EXCLUDED 12 (Login, MemberList, MemoInsert, MemoInsert2, ImageView, ServerFileDialog, SMS_EMAIL, SourceViewer, UIDesign, UIXML_Editor, UpdateAndBackUp, LeftSimpleMenu). 업로드 성격의 GJE/HEALTH_Upload/TOZInsert 는 CUSTOMER 로 분류했지만 실질적으로 제외 API 의존.
- 합계 24 + 24 + 12 = 60.

## main에서 참조되지만 설치본에 없는 모듈 (참고)
`modPAT_Analyst`, `modHIMART_Analyst`, `modAPT_Analyst`, `modKNOC_Analyst`, `modYAKULT_Analyst` (`main:4855-4874`), `modEDU_BusLine` (`main:6345`), `modPAT_ProvinceAnalyst` (`main:6367/8429`), `modShinsegae` (`main:6386`), `modPlanner` (`main:6624/7364`), `modAPT/DEMO/PAT_StoreAnalyst` (`main:6665-6745`), `modEditData` (`main:7603`), `modPAT_ChartAnalyst` (`main:8410`), `modPolicy_Analyst_Idx_<n>` (`main:4999`), 그리고 `SetSlidePanel` 의 DTV/RT/SEOULBIGDATA/SKE/LH_HAPPYHOUSE/GSC `_Analyst` (`main:5017-5020`). 모두 고객사 전용 → 포팅 대상 아님.

## 미확인 사항
1. 독립 SWF `modTOC/modCallOutView/modLeftSimpleMenu*` 의 메인 클래스가 디컴파일 결과에 없음 — FFDec 실패인지 실제 빈 껍데기인지 미확인(메인 정적 버전으로 충분하다고 판단).
2. 메뉴 코드(`x-y`) ↔ 실제 메뉴 라벨 매핑은 서버 메뉴 XML(`get.php?FILE=…menu.xml`)에 있어 정적으로 확인 불가.
3. GJE, NPB, SJ, SB 고객사의 실명은 소스에서 확인되지 않음(SB 는 커피전문점 상권, JJ 는 전주(행정코드 45111/45113)로 추정).
4. modWizardsNPB 의 `sUrl` 실제 값(`modWizardsNPB.as:283/604/644`)은 런타임 결정.
5. modHEALTH_KAIST_List / modWizardsCJP / modLeftSimpleMenu 는 로더가 없어 사용되지 않는 것으로 보이나, 서버 메뉴 XML 에서 동적으로 로드될 가능성은 배제 못 함(정적 grep 결과 `module/` + 변수 조립은 `main:4999`, `main:5020` 두 곳뿐).
