# 40. 사용자 데이터 라이프사이클 & UI (XRayMap CS)

이 문서는 XRayMap CS의 사용자 데이터 흐름과 UI를 정리한 것입니다. 범위는 메뉴·툴바, 가져오기, 메모리 레이어 모델, 심볼·라벨·범례, 내보내기, 속성 테이블, 그리기·측정 도구, 그리고 서버 저장을 브라우저 저장으로 바꾸는 방법입니다.

## 경로 약어

경로는 `re/decompiled/` 기준입니다.

| 약어 | 경로 |
|---|---|
| MAIN | `main/scripts/bizgismap_cs.as` |
| INIT | `main/scripts/com/seld/draw/UserInit.as` |
| TOC | `main/scripts/module/modTOC.as` |
| SHP | `main/scripts/UserShpOpenBox.as` |
| UGD | `main/scripts/com/seld/draw/UserGetDataBase.as` |
| USD | `main/scripts/com/seld/draw/UserSetDataBase.as` |
| UPD | `main/scripts/com/seld/draw/UserPointDraw.as` |
| UEF | `main/scripts/com/seld/draw/UserExportFile.as` |
| UCA | `main/scripts/com/seld/draw/UserCreateArea.as` |
| URL | `main/scripts/com/seld/draw/UserURLUtil.as` |
| AP | `modules/modAddPoint.swf/scripts/module/modAddPoint.as` |
| MAT | `modules/modAttributeTable.swf/scripts/module/modAttributeTable.as` |
| PS | `modules/modShowPointSymbol.swf/.../modShowPointSymbol.as` |
| LS | `modules/modShowLineSymbol.swf/.../modShowLineSymbol.as` |
| POLYS | `modules/modShowPolygonSymbol.swf/.../modShowPolygonSymbol.as` |
| LBL | `modules/modShowLabelSymbol.swf/.../modShowLabelSymbol.as` |
| DS | `modules/modShowDensitySymbol.swf/.../modShowDensitySymbol.as` |
| VC | `modules/modValueClassification.swf/.../modValueClassification.as` |
| LEG | `modules/modLegend.swf/.../modLegend.as` |
| SI | `modules/modSaveImage.swf/.../modSaveImage.as` |
| MTS | `modules/modTableAndSummary.swf/.../modTableAndSummary.as` |
| MMI | `modules/modMemoInsert.swf/.../modMemoInsert.as` |
| MMI2 | `modules/modMemoInsert2.swf/.../modMemoInsert2.as` |
| MIV | `modules/modImageView.swf/.../modImageView.as` |
| JSF | `C:\XRayMap\bizgismap_pro\js_func.html` (geostats와 색상 램프를 담은 로컬 JS) |

## 확인 범위

- 직접 확인한 파일: MAIN, INIT, TOC, SHP, UGD, USD, UPD(일부), UEF, UCA(일부), URL.
- 심볼·범례·이미지 모듈과 AddPoint·AttributeTable·메모 모듈은 보조 분석으로 정리했습니다.
- 그 결과 중 PS:1009, LBL:311-317, AP:1231, AP:597은 원문과 다시 대조했습니다.
- `modLeftSimpleMenu.swf`와 독립 `modCallOutView.swf`에는 module 클래스가 디컴파일되어 있지 않습니다.
  - 그래서 MAIN에 컴파일되어 들어간 `main/scripts/module/modCallOutView.as`, `modLeftSimpleMenuFor*.as`를 대신 사용했습니다.

---

## 1. 메뉴·툴바 구조와 최상위 워크플로

### 1.1 상단 MenuBar: 서버 XML 구동

- MenuBar 자체는 MAIN:11509 `_bizgismap_cs_MenuBar1_i`에서 만들어집니다. 다만 메뉴 항목은 하드코딩되어 있지 않습니다.
- `initStep2()`가 메뉴 XML을 서버에서 받아 `mainMenuBar.dataProvider`에 넣습니다 (INIT:1386-1420).
  - 요청 주소: `get.php?FILE=<company><suffix>` (INIT:1416).
  - 파일 이름 `m_sMenuXmlPath`는 회사명 뒤에 설정 배열의 12번째 값을 붙여 만듭니다 (INIT:573).
- **설치본에는 메뉴 XML이 없습니다.** `C:\XRayMap\bizgismap_pro`에 `*menu*.xml`이 없으므로 라벨 원문은 알 수 없습니다(Unknown).
- 클릭 처리는 `mainMenuClick` (INIT:1524-2078)이 `@value` 코드로 분기합니다. 항목에 `@sqlcode`가 있으면 `RunTotalFun(sqlcode)`, 즉 서버 SQL 레이어로 갑니다 (INIT:1550-1555).

| value | handler (근거) | 기능 | 웹 재구현 |
|---|---|---|---|
| 0-1~0-5 | `MOD_Login_Show`, `setLogout`, `MOD_MemberList_OpenWindow` (INIT:1556-1575) | 로그인, 회원 | **제외** |
| 1-1 | `RunOpenProjectFile` → `TOC.OpenProjectFile` (MAIN:6023, TOC:2830) | 프로젝트(.utd) 열기 | 유지 (로컬 파일) |
| 1-2 | `RunSaveProjectFile` → `TOC.SaveProjectFile` (MAIN:5981, TOC:1902) | 프로젝트(.utd) 저장 | 유지 (다운로드) |
| 1-2-1 | `RunOpenShpFile` → `TOC.OpenShpFile` → `UserShpOpenBox` (MAIN:6012, TOC:1501) | SHP+DBF 열기 | 유지 |
| 1-3 / 1-4 / 1-5 | 서버 파일 대화상자 열기·저장·편집 (MAIN:6061-6095, TOC:1525) | 서버 프로젝트 저장소 | **제외** → IndexedDB 프로젝트 목록 |
| 1-6 | `saveFromMapToImage` (MAIN:9115) | 지도 이미지 저장 | 유지 |
| 1-7 / 1-8 | `RunSavePTFileToServer(false/true)` → `writefile.php` (TOC:1579, USD:214) | 공유 URL 발행 (일반, 전체화면) | **제외** (또는 파일 공유) |
| 1-9 | `saveAsImage2(oCanvaForImageSave)` (MAIN:9140) | PNG 저장 | 유지 |
| 1-10 | `objUserEditStartStop.setMode()` (`UserEditStartStop.as`) | 관리자 데이터 편집 모드 | 제외. 포인트 드래그 편집만 별도로 검토 |
| 1-11 / 1-12 | `ShowUpLoadPanel` / `ShowUpLoadViewerPanel` (MAIN:6823, 6854) | 회사별(GJE) 업로드 | 제외 |
| 1-15 | `RunSaveKMLFile` → `SaveTotalKmlFile` (TOC:2493) | "모든 레이어 KML 내보내기 미지원" 알림만 띄움 | 레이어별 KML로 대체 |
| 1-16 / 1-17 | `RunSaveHTML5File` (TOC:2511) | HTML5 지도 내보내기. 배경색 Gray / Color / MidNight 선택 | 1-16: 로컬 HTML 다운로드 유지 가능. 1-17: 서버 업로드라 제외 |
| 1-19 | `ShowSaveImagePanel` → modSaveImage (MAIN:7210) | 고해상도 이미지 저장 | 유지 |
| 1-97 / 1-98 / 1-99 | iframe 열기 (INIT:1700-1720) | 외부 웹페이지 | 제외 |
| 2-1 | `ShowLocationSearchPanel` | 위치 검색 | 20_geocoding 참조 |
| 3-1 | `OpenSlideBottom` | 하단 슬라이드 | 30번 문서 참조 |
| 3-2 / 3-3 / 3-4 | `ShowDensityAnalystTool("",1/2/3)` | 밀도, 보간, 행정구역 통계 | 30번 문서 참조 |
| 3-7 ~ 3-12 | Shinsegae, Block, Buffer_By_List, SlideRight, AreaGetSummaryDB | 분석 패널 (서버 DB 기반이 대부분) | 30번 문서 참조 |
| 3-22 / 3-23 / 3-24 | `setSmallSearchRMenuList`, `setHighResolutionMenuList`, `setProvinceMaskMenuList` (INIT:2080-2240) | 토글 설정. 메뉴 라벨 끝의 `(×)`·`(○)` 문자열로 상태를 표시 | 설정 스토어 |
| 3-31 | `setMaxPointCnt` (INIT:1479-1522) | 포인트 출력 개수. 최대 50000, `objSQL.m_nLIMIT_CNT` | 설정 |
| 4-1 | `ShowGeocodingPanel` | 주소 지오코딩 → "Geocoding" 레이어 | 20번 문서 참조 |
| 4-2 | `ShowAddPointPanel` → modAddPoint (MAIN:7234) | 엑셀·붙여넣기로 포인트 추가 | **핵심 유지** |
| 4-3 | `ShowAddProvincePanel` | 행정구역 추가 | 30번 문서 참조 |
| 5-1-4 ~ 5-1-6 | `setBaseMapType(2/1/3)` | 배경지도 종류 | 10번 문서 참조 |
| 5-2-x | `setBaseMapColor(1/2/3/4/9)` | 배경지도 색상 필터 | 10번 문서 참조 |
| 5-3-x | `setBaseMapVWorldOrOstOrGoogle` | 배경지도 공급자 | 10번 문서 참조 |
| 5-4-x | `setBaseMapMask` | 마스크 | 10번 문서 참조 |
| 6-x | 외부 링크, 고객지원 Alert, 버전 정보 (INIT:1890-1975) | 도움말 | 정적 About |
| 7-x | 교육 링크, 버스노선 파일 (`MOD_EDU_BusLine_OpenFile`) | 교육용 | 제외 |
| 8-1 / 8-9 | Intro iframe, MMS 영역 | 확장 | 제외 |
| 9-7 / 9-8 / 9-9 / 9-10 / 9-11 | UpdateAndBackUp, UIDesign, SourceViewer, HealthmapUpload, 메모리 상태 | 관리자 도구 | **제외** |
| 10-1 | `ShowPlannerPanel` | 플래너 | 제외 또는 후순위 |
| 그 외 | `RunTotalFun(sVal)` (INIT:2066) | 서버 SQL 레이어 | 제외 |

### 1.2 TOC 툴바 (modTOC 상단 아이콘)

마우스 모드는 `SetMouseMode(n)` (TOC:846-972)이 관리합니다. 툴바 아이콘 이미지는 `modTOC_imgToolbar*`이고, 원본 PNG는 `C:\XRayMap\bizgismap_pro\icon\toolbar`에 있습니다.

| 버튼 | handler | 모드 | 기능 |
|---|---|---|---|
| btnRefresh | `CallBtnRefresh` (TOC:4302) | – | 베이스 레이어 다시 그리기 |
| btnGoBack / btnGoNext | TOC:6457 / 6477 | – | 범위 이력 (`m_oaGoBackExtent`) |
| btnZoomIn / btnZoomOut | TOC:4312 / 4317 | – | 줌 |
| btnMapDragMode | `SetMouseMode(1)` | 1 | 이동(Pan) |
| btnDragZoomIn / Out | 2 / 3 | 2, 3 | 박스 줌 (`UserBoxZoom`) |
| btnPolyMode | 4 → `objUserCreateArea.StartDrawPolygon()` | 4 | 사용자 분석영역(다각형) 그리기 |
| btnCircleMode | 5 → `StartDrawCircle()` | 5 | 원형 분석영역 |
| btnUserInfo | 6 (TOC:1001; 일부 회사는 비활성) | 6 | 사용자 정보(메모) 마킹. 지도 클릭 시 `MOD_MemoInsert_Insert` (TOC:6245-6309) |
| btnLoadView | 7 | 7 | Daum 로드뷰 |
| btnMeasureLineMode | 9, `oMeasurePath.active` (TOC:1022, 921-931) | 9 | 거리 측정 |
| btnMeasureAreaMode | 10, `oMeasureSurface.active` (TOC:1028, 933-943) | 10 | 면적 측정 |
| btnDT | 12 (TOC:1492) | 12 | 차량 이동거리 (드라이브타임, 서버) |
| btnAddLayer | `RunBtnAddLayer` → `OpenLayerFile` (TOC:3407) | – | .ly 레이어 파일 추가 |
| btnDeleteAll | `RunBtnRemoveLayerAll` (TOC:4762) | – | 사용자 레이어 모두 삭제 |
| chkOnlyOneLayerMode | TOC:1628-1650 | – | 한 번에 레이어 하나만 표시 |
| btnLayerPlay | `CallClickLayerPlay2` (TOC:1744) | – | 레이어를 순서대로 켜는 애니메이션 |
| btnShareSMS_Mail | `CallClickSMS_Mail` (TOC:1709) → `RunSaveHTML5File(cluster, true)` | – | HTML5 공유: 서버 업로드 후 SMS·메일. **제외** |

- 모드 91, 92, 93은 경쟁점 분석이나 신규 출점 같은 회사별 기능입니다 (TOC:950-965).
- 플로팅 좌측 메뉴 `modLeftSimpleMenuForFLOATING`에는 버튼 네 개가 있습니다: 폴리곤 모드, 원 모드, `OpenAreaFile`, `SaveAreaFile` (보조 분석 LSF:125-145).

### 1.3 우클릭 컨텍스트 메뉴 (MAIN:10972-11060 XML, 핸들러 MAIN:10141-10594)

**TOC 레이어 우클릭** (XML3, MAIN:11056 → `menuClickForTOC` MAIN:10322)

| index | 라벨 | 동작 | 대상 레이어 |
|---|---|---|---|
| 0 | 속성 테이블 열기 | `ShowAttributeTable` | Point, Geocoding, 그리고 Ect가 PROVINCE_* 또는 LINE인 레이어 |
| 1 | 반경 분석 | `MOD_Analyst_iLoadPointListByLayer` | Point |
| 2 | 수치추정(보간법) 분석 | `ShowDensityAnalystTool(name,2)` | Point |
| 3 | 밀집도 분석 | `ShowDensityAnalystTool(name,1)` | Point |
| 4 | 행정구역 통계 분석 | `ShowDensityAnalystTool(name,3)` | Point |
| 5 | 색상 및 심볼 변경 | Point·Polygon(Block)·Line·Density별 Symbol 모듈 | 아래 4장 |
| 51 | 색상 및 심볼 스크립트 복사 | `SYSC:` 문자열을 클립보드로 (MAIN:10420-10432) | Point |
| 52 | 색상 및 심볼 스크립트 적용 | 입력창 → Ect[5..9]·Color 교체 (MAIN:10434-10490) | Point |
| 14 | 라벨 변경 | `ShowLabelSymbol(idx,name,layer,fields,Ect[9])` | – |
| 6 / 7 / 8 | 레이어로 이동, 위로, 아래로 | `MoveToLayer`, `UpStepLayer`, `DownStepLayer` (TOC:4691, 4645, 4668) | – |
| 9 | 레이어 삭제 | `RemoveLayer` (TOC:4895) | – |
| 10 | 레이어 파일로 저장 | `SaveLayerFileByLayerSaveFun` → .ly (TOC:4599) | – |
| 11 | 웹링크 URL 취득 | `SaveLayerToServer` → writefile.php (TOC:1610) | **제외** |
| 12 | KML로 저장 | `SaveKMLFile` (TOC:2637) | – |
| 13 | 이름 바꾸기 | `RenameLayer` (TOC:4837) | – |

**지도 우클릭** (XML2, MAIN:11038 → `menuClickForMap` MAIN:10184)

- 좌표 획득: 경위도, TM, 카텍, UTMK 좌표와 줌을 클립보드에 복사합니다 (MAIN:10220-10245).
- 주소 획득: `http://bizgis.gislab.co.kr/getdb.php`에 `SELECT FN_HOUS2ADDRESS(FN_XY2HOUS(x,y)) FROM DUAL`을 POST합니다 (MAIN:10285-10300). 웹에서는 역지오코딩 API로 대체합니다.

**사용자 영역 우클릭** (XML4~XML10, `menuClickForSelectedPolygon` MAIN:10141)

- 해당영역 상세 분석, 영역 편집, 영역 삭제, 정보 추출, 고객 리스트(회사별) 같은 항목이 있습니다.
- 상세 분석은 `UCA.SetServerCoord(...)`로 서버 통계를 요청하므로 30번 문서 범위입니다.

### 1.4 대표 사용자 워크플로 (웹 재구현 기준)

1. **데이터 올리기**: 4-2 "포인트 추가"(xlsx 또는 붙여넣기)나 1-2-1 "SHP 열기"를 사용합니다. 좌표계를 고르면 TOC에 Point 또는 Polygon 레이어가 추가됩니다.
2. **보기·스타일**: TOC 우클릭에서 색상·심볼, 라벨, 속성 테이블을 엽니다.
3. **분석**: 반경, 밀도, 보간, 행정구역 통계(30번 문서)를 실행하면 Density, Cell, Polygon 결과 레이어가 생깁니다.
4. **영역**: 툴바에서 다각형·원 영역을 그립니다. 영역 안 포인트의 개수와 통계가 툴팁·콜아웃에 표시됩니다 (UCA:557 `GetAndSetAreaUserPointCountAndStat`).
5. **저장·공유**: .utd 프로젝트, .ly 레이어, .ply 영역, KML, PNG, TXT(TSV)로 저장합니다.

---

## 2. 가져오기 형식

### 2.1 포인트 추가 (modAddPoint, 메뉴 4-2)

**입력 경로**

| 경로 | 동작 | 근거 |
|---|---|---|
| 텍스트 붙여넣기 (주 경로) | TextArea `txtGeocodingString`에 붙여넣기. 구분자는 탭 / 콤마 / 파이프(`\t` `,` `|`) | AP:183-192, AP:496-507 |
| 엑셀 열기 | **`*.xlsx`만 지원**. `com.excel.Excel(fileRef.data)`로 읽음 | AP:1231 |

- 시트가 여러 개이면 선택 팝업이 뜹니다 (약 10개까지, AP:1166-1208).
- 엑셀 내용은 탭으로 직렬화되어 TextArea에 들어가고 바로 파싱됩니다 (AP:1120-1151).
- 레이어 이름 기본값은 파일명(.xlsx 제거) 또는 시트명입니다.
- xls, csv, txt 파일 선택기는 **없고**, euc-kr 처리도 없습니다. 붙여넣기로만 들어옵니다.

**헤더와 좌표 컬럼**

- "첫번째 행 필드명" 체크박스를 끄면 컬럼 이름이 `Field_N`이 됩니다 (AP:534-541).
- X 컬럼은 헤더가 `X`, `x`, `경도`로 시작하면 자동 선택됩니다. Y는 `Y`, `y`, `위도`입니다 (AP:547-572).
- **주소 컬럼으로 지오코딩하는 기능은 이 모듈에 없습니다.** 주소 지오코딩은 4-1 modGeocoding에서 하며 20번 문서를 참조합니다.

**값 정리와 행 수 제한**

- 구분자가 콤마가 아니면 값 안의 콤마를 제거하고, 구분자 주변 공백을 정리합니다 (AP:618-623).
- **10,000행을 넘으면 거부**합니다. 관리자 목록에 있는 사용자는 예외입니다 (AP:597-614).

**좌표계** (OptGN 라디오, AP:1566-1631, AP:679-698)

| 라벨 | 변환 함수 | 위치 |
|---|---|---|
| 경위도 | 변환 없음 | – |
| TM | `TM2GEO` | MAIN:10014 |
| 카텍 | `KA2GEO` | MAIN:10006 |
| UTMK | `UTM2GEO` | MAIN:9980 |
| GRS80 TM(EPSG:5186) | `GRS2GEO` | MAIN:9988 |
| GRS80 TM(EPSG:5181) | `GRS_OLD2GEO` | MAIN:9997 |

- 변환 결과는 `toFixed(6)`으로 반올림합니다 (AP:753).
- 투영 파라미터는 10번 문서를 참조합니다.

**행이 레이어가 되는 과정** (AP:632-796)

1. 필드 목록은 X/Y를 뺀 헤더입니다. 값 안의 `,`는 `/`로 바꿉니다. 통계 필드는 `#stat#` 접두사를 붙입니다. 끝에 `X_AXIS,Y_AXIS`를 붙여 `app.g_sUserAddPointFields`에 저장합니다.
2. 각 행을 `v1,v2,...,lon,lat`로 만들고 `|`로 이어 붙입니다. X나 Y가 비어 있는 행은 건너뜁니다.
3. `UGD.RunGetDBAfter("POINT", null, "USER_ADD_POINT", sVal, ...)` (AP:785)가 호출됩니다. 이 함수는 다음을 수행합니다 (UGD:466-559).
   - `new UserPointDraw`
   - `CreatePoint`
   - `AddAnalysisLayer`
   - `RunTOCAddLayer(name,"Point",flag,Ect,color,extent,sVal,...)`
4. 옵션은 다음과 같습니다.
   - 레이어명. 비어 있으면 "명칭없음".
   - 색 (`colorPoint`).
   - 마커 모양: 원 0, 사각 1, 삼각 2, 이미지 3 (`../icon/marker_list/<id>.png`).
   - "모든 Point가 화면에 나타나도록 지도 이동".
5. **AddPoint 모듈은 포인트만 생성합니다.** 라인과 폴리곤은 SHP 경로로만 들어옵니다.

### 2.2 SHP+DBF 열기 (`UserShpOpenBox`, 메뉴 1-2-1)

**파일 선택과 읽기**

- `.shp`와 `.dbf`를 각각 따로 `FileReference.browse`로 고릅니다 (SHP:65-67, 241-330).
  - **.prj와 .shx는 읽지 않습니다.** 좌표계는 사용자가 라디오로 선택합니다 (SHP:1043-1103, 앞 표와 같은 6종).
- 두 파일의 이름(확장자 제외)이 같아야 합니다 (SHP:211-238).
- 파서는 `com.vanrijkom.shp.ShpTools.readRecords`와 `com.vanrijkom.dbf.DbfTools/DbfHeader`입니다.

**DBF 인코딩: CP949 고정**

- 필드명은 `DbfField.as:30`에서 `readMultiByte(..., "euc-kr")`로 읽어 `koname`에 넣습니다.
- 값은 `DbfRecord.as:21`에서 같은 방식(`"euc-kr"`)으로 읽습니다.
- → 웹에서는 `TextDecoder('euc-kr')`를 기본으로 쓰고 UTF-8 선택지를 둡니다. `.cpg`가 있으면 그 값을 우선합니다(개선안).

**지원 지오메트리** (CallBtnOK, SHP:332-351)

- Point, PointZ, PointM: `AddPoint` (SHP:353)
  - X_AXIS, Y_AXIS, X, Y 필드는 제외합니다.
  - 값 안의 `,`는 `/`로, `|`는 `:`로 바꿉니다.
  - 결과는 `USER_ADD_POINT` 경로로 Point 레이어가 됩니다 (SHP:380-395).
- Polygon, PolygonZ, PolygonM: `AddPolygon` (SHP:744)
  - 필드 목록: `UUID,<필드...>,COORD`. 원래 `COORD` 필드는 `USER_COORD`로 이름을 바꿉니다 (SHP:943-957).
  - 행 형식: `UUID,attrs...,x^y,x^y,...`를 `|`로 연결합니다 (SHP:868-899).
  - **레코드 6000건에서 잘립니다** (SHP:773, 821).
  - **링(part)마다 별도 행이 됩니다.** 따라서 멀티파트는 행이 쪼개지고, 홀은 별도 폴리곤으로 그려지는 결함이 있습니다 (SHP:877-899).
  - 생성: `UserBlockDraw.CreatePolygon(sVal,sFields,"",null,name,move,0.5,"")` 다음 `RunTOCAddLayer(name,"Polygon","on","PROVINCE_BLOCK|fields|NULL|NULL||0.5|null",color,extent,sVal)` (SHP:786-808).
- Line: `AddLine` (SHP:510)은 구현되어 있지만 **CallBtnOK에서 호출하지 않습니다**. 그래서 "Point와 Polygon shp만 지원합니다" 알림이 뜹니다 (SHP:345).
  - 구현 내용: 6000건 상한 (SHP:542, 590), Ect는 `LINE|fields|NULL|NULL||0.5|null` (SHP:555-567).

**발견된 버그**

- AddPolygon의 EPSG:5186 라디오가 존재하지 않는 `GRSGEO`를 참조합니다 (SHP:929, MAIN에 정의 없음). 런타임 오류가 날 것으로 추정됩니다.

### 2.3 KML

- **사용자 KML 가져오기 기능은 없습니다.**
  - `UserKMLPoly`는 행정구역 경계용 KML(`./KML/MEGA_2015.xml`, `./KML/CTY_2015.xml`)을 URLLoader로 읽어 PROVINCE_POLY 주제도를 그리는 내부 용도입니다 (`UserProvinceDraw.as:44-50`, `UserKMLPoly.as:630-700`).
  - OpenScales의 `ImportFeature` 컨트롤은 MAIN에서 쓰이지 않습니다 (grep 결과 없음).
- KML은 **내보내기 전용**입니다 (5장).
- 웹에서 KML·GeoJSON 가져오기를 추가하는 것은 신규 기능이며, OL의 `KML`·`GeoJSON` format으로 구현할 수 있습니다.

### 2.4 자체 포맷 다시 열기

| 포맷 | 열기 함수 | 필터 | 읽기 방식 |
|---|---|---|---|
| `.utd` 프로젝트 | `TOC.OpenProjectFile` (TOC:2830-2924) | TOC:91 | `readUTFBytes` |
| `.ly` 레이어 | `TOC.OpenLayerFile` (TOC:3413-3470) | TOC:93 | `readUTFBytes`. 파일명이 레이어명이 됨 |
| `.ply` 영역 | `TOC.OpenAreaFile` (TOC:6814) → `UCA.setSaveAreaByString` (UCA:2221) | TOC:95 | – |

- 프로젝트를 열 때 기존 레이어가 있으면 "현재 분석 결과가 초기화 됩니다" 확인 후 모두 지웁니다 (TOC:2906-2918).
- 형식 정의는 3.3절에 있습니다.

---

## 3. 메모리 레이어·데이터 모델

### 3.1 TOC 레이어 레코드 (`m_oTOCAnalysisLayerList`)

`AddLayerList` (TOC:5066-5160)가 리스트 맨 앞에 `unshift`합니다. 즉 index 0이 최상단 레이어입니다.

```
{ Color: String(uint), flag: "on"|"off", Name, Type, Ect, Extent, Val }
```

- 렌더 객체는 같은 인덱스의 `app.m_oaAnalysisLayer[idx]`에 있습니다.
  - 종류: UserPointDraw, UserBlockDraw, UserLineDraw, UserProvinceDraw, UserSpatialAnalystDensityDraw, Interpolation.
- 이름이 비어 있으면 `g_sWorkName` 또는 `Type_HHhMMmSSs`로 짓고, `GetUniqueLayerName`으로 중복을 피합니다 (TOC:5085-5110).
- `Type` 값: `Point`, `Geocoding`, `Polygon`, `Line`, `Density`, `Cell`.
  - TOC 그리드 컬럼은 flag, Type 아이콘, Name 순이고 Index, Ect, Color는 숨김(width 0)입니다 (TOC:9119-9212).
  - 아이콘은 `bizgismap_cs_imgTypeCELL/Den/Line/Polygon` 등입니다.
  - 과제에서 말한 DEN·CELL은 각각 `Density`, `Cell`에 대응합니다.
- `Extent`: `"((lat,lng),(lat,lng))|mapW|mapH|zoom"`. `RunTOCAddLayer`가 뒤에 `|W|H|Zoom`을 붙입니다 (MAIN:5873). 파싱은 TOC:3330-3368입니다.
- Density 레이어의 `Ect`는 다시 그리기 파라미터 9개를 `#|#`로 이은 문자열입니다 (TOC:5112-5115). 서버 SQL을 포함하므로 30번 문서를 참조합니다.

### 3.2 `Ect` 스타일·스키마 문자열 (파이프 구분)

| 레이어 | 형식 | 근거 |
|---|---|---|
| Point / Geocoding | `USER_ADD_POINT \| fields(csv, #stat# 접두) \| classSizes(csv) \| classBreaks(csv) \| statField \| alpha(0..1) \| size \| markerType \| markerImageID \| labelSpec` | UGD:532-555, 재파싱 TOC:3016-3058 |
| Polygon (Block, SHP와 분류결과) | `PROVINCE_BLOCK \| fields \| colors(csv)\|NULL \| breaks(csv)\|NULL \| valField \| alpha \| cdField [\| … \| labelSpec(index 9)]` | TOC:3127-3184, VC:1460 |
| Polygon (행정구역) | `PROVINCE_POLY \| …` (같은 구조). Val은 `rows##AND##cd,val…` | TOC:3080-3125 |
| Line | `LINE \| fields \| colors^widths \| breaks \| valField \| alpha \| cdField [\| labelSpec]` | TOC:3186-3240, VC:1364 |
| Density | 위 3.1 참조 | TOC:5112 |
| Cell | 범례 문자열 (`UserClassification.SetClassByLegendString`) | TOC:2975-2983 |

**labelSpec (index 9)**

```
TRUE|FALSE ^ field ^ colorUint ^ alpha% ^ size ^ align(1 좌 / 2 중 / 3 우) ^ LRmode ^ LRoffset ^ UDmode ^ UDoffset
```

- 기본값은 `FALSE^^^70^10^2^3^0^3^0` (LBL:311-317)입니다.
- mode 값: 1은 +, 2는 −, 3은 미적용입니다.

### 3.3 `Val`(행 데이터) 인코딩

- **Point**: `v1,...,vn,lon,lat|v1,...` 형식이며 필드 순서는 Ect[1]과 같습니다.
  - 렌더 시 각 포인트 feature의 `data`는 `{LABEL, TITLE, VAL:"필드: 값\n…", ID, STAT, POLY}`입니다 (UPD:3208-3213).
  - `ID`는 VAL 텍스트의 **3번째 줄 값**입니다 (UPD:3196-3205).
  - base 포인트 경로(AddPoint)는 같은 ID를 중복으로 보고 건너뜁니다 (UPD:2734-2750).
  - 경위도 범위를 벗어난 포인트는 버리고 `nErrorCNT`만 셉니다 (UPD:3190-3194).
- **Polygon (Block)**: `UUID,attrs…,x^y,x^y…|…`
- **Selected-only 저장**: `GetSelectedFeatureOnlyValAndCoord` 결과를 `|`로 잇고, 이름에 `-Seleted`를 붙입니다 (TOC:1940-1953).

### 3.4 파일 포맷 (.utd / .ly / .ply)

**.utd 프로젝트** (`SaveProjectFile` TOC:1902-1920)

```
lng|lat|zoom|ver[|provinceName|provinceCodes]
##SEPARATE##
<layer N-1>
##SEPARATE##
…
```

- 레이어 블록은 `GetLayerFileString` (TOC:1922-1964)이 만듭니다. 줄 순서는 다음과 같습니다.
  ```
  Color \n Ect \n flag \n index \n mx_internal_uid \n Name \n Type \n Extent \n Val
  ```
- 이것을 `getBase64andMD`로 감쌉니다 (URL:226-275). 처리 순서는 다음과 같습니다.
  1. UTF-8 퍼센트 인코딩. 공백은 `+`, `*-._` 와 영숫자는 그대로 둡니다.
  2. Base64 인코딩.
  3. 결과를 `"BASE64:<b64>#END#"`로 감쌉니다.
- 읽을 때는 순서를 뒤집고 `CreateLayer`로 하나씩 재생성합니다 (TOC:2926-3405).
  - Ect 안에 줄바꿈이 섞여 있으면 `on`/`off` 줄을 찾아 복구합니다 (TOC:3296-3322).
  - 6필드 헤더는 서버 공유본이고 행정구역 마스크를 포함합니다 (TOC:2778-2800).
- 파일명 기본값은 `제목없음.utd`입니다 (TOC:1918).

**.ly 레이어**

- 레이어 블록 하나 뒤에 `\n##SEPARATE##\n`을 붙입니다.
- 파일명은 `<Name>.ly` 또는 `<Name>-Seleted.ly`입니다 (TOC:2711-2746).

**.ply 영역**

- 영역마다 `COORD:<x^y,…>|MOVE:FALSE|CIRCLE:…|CIRCLE_LAT:…|CIRCLE_LNG:…|CIRCLE_R_KM:…|TOOLTIP:TRUE|LOOP:FALSE|HOTSPOT_AREA:…`를 만들고 전체를 대문자로 바꿉니다 (UCA:2185-2218).
- 영역 사이는 `\n##SEPARATE##\n`로 구분하고, 파일명은 `사용자영역.ply`입니다 (TOC:6778-6812).

**웹 호환 권고**

- 기존 사용자 파일을 열 수 있도록 .utd, .ly, .ply의 **읽기는 그대로 지원**합니다.
- 저장은 아래 TS 모델을 JSON(`.xrm.json`)으로 하고, 레거시 포맷 내보내기는 선택 사항으로 둡니다.

### 3.5 제안 TypeScript 모델

```ts
export type LayerType = 'Point' | 'Geocoding' | 'Polygon' | 'Line' | 'Density' | 'Cell';
export type MarkerShape = 0 | 1 | 2 | 3 | 4 | 5; // circle, square, triangle, image, star, cross (UPD:144-149)
export type ClassMethod = 'equal' | 'jenks' | 'quantile' | 'unique';

export interface FieldDef { name: string; isStat?: boolean; type?: 'number' | 'string' }

export interface LabelStyle {            // Ect[9] ↔ "TRUE^field^color^alpha^size^align^lrMode^lrOff^udMode^udOff"
  show: boolean; field: string; color: number; alphaPct: number /*70*/; size: number /*10, draw 기본 12*/;
  align: 1 | 2 | 3; lr: { mode: 1 | 2 | 3; offset: number }; ud: { mode: 1 | 2 | 3; offset: number };
  // 고정값: NanumBarunGothic Bold, 흰색 halo 폭 2 (UserStyle.as:57-58,114)
}

export interface ClassBreaks { method: ClassMethod; field: string; breaks: (number | string)[]; colors?: number[]; sizes?: number[]; widths?: number[]; rampId?: number; reversed?: boolean }

export interface PointStyle {
  color: number; alpha: number /*0.8*/; size: number /*4 → render size+6*/; shape: MarkerShape; iconId?: string /*marker_list/NN.png*/;
  graduated?: ClassBreaks /* bubble: sizes[], breaks[] → Ect[2],[3] */;
}
export interface PolyStyle { fill: number | ClassBreaks; alpha: number /*0.5*/; stroke: number /*0xFFFFFF*/ }
export interface LineStyle { color: number | ClassBreaks; width: number /*3*/; alpha: number }
export interface DensityStyle { classColors: number[/*10*/]; classAlphas: number[/*10*/]; layerAlpha: number; sizeMode: 1|2|3|4|5; rampId: number }

export interface UserLayer {
  id: string;                 // crypto.randomUUID()
  name: string;               // GetUniqueLayerName 규칙 유지
  type: LayerType;
  visible: boolean;           // flag on/off
  order: number;              // TOC index (0 = top)
  fields: FieldDef[];         // Ect[1]
  statField?: string;         // #stat#
  features: GeoJSON.Feature[];// EPSG:4326 (원본 Val 파싱 결과)
  style: PointStyle | PolyStyle | LineStyle | DensityStyle;
  label?: LabelStyle;
  extent?: [number, number, number, number];
  source?: { kind: 'xlsx' | 'paste' | 'shp' | 'ly' | 'utd' | 'analysis'; fileName?: string; crs?: CrsId; encoding?: string };
  raster?: { imageBlobKey: string; extent: number[] } // Density/Cell 결과 캐시
  exportDisabled?: boolean;   // GetExcelDownload()==false 대응
}
export type CrsId = 'EPSG:4326' | 'BESSEL_TM' | 'KATEC' | 'EPSG:5179' | 'EPSG:5186' | 'EPSG:5181';

export interface UserArea { label: string /*#1*/; kind: 'polygon' | 'circle'; coords: [number, number][]; center?: [number, number]; radiusKm?: number; hotspot?: boolean }
export interface Project { version: 1; view: { center: [number, number]; zoom: number }; layers: UserLayer[]; areas: UserArea[]; savedAt: string }
```

---

## 4. 심볼·범례·라벨 스타일

**공통**

- 분류 계산은 로컬 `js_func.html`에서 `geostats`로 합니다 (JSF:742-799).
  - 메서드: `getEqInterval`, `getJenks`, `getQuantile`, unique.
  - 호출하는 곳은 `UserClassification.as:150-345`입니다.
- 웹에서는 geostats npm(또는 simple-statistics `ckmeans`)으로 그대로 옮길 수 있습니다.

**Point** (PS)

- 탭 1 "단일 크기"
  - 모양: 원 / 사각 / 삼각 / 별 / 십자 / 이미지 (PS:204-214).
  - 투명도 기본 80% (PS:1009), 크기 기본 4 (PS:1013).
  - 렌더: fill은 색과 alpha, stroke는 흰색 0.5, 크기는 size+6 (UPD:4565, UPD:162).
- 탭 2 "통계수치에 따른 크기" (버블)
  - 분류: Eq Interval / Natural brk. / Quantile.
  - 분류 개수 2–20, 기본 10 (PS:331-339).
  - 크기 기본값은 4, 6, 8, …이고 기본 방법은 Jenks입니다 (PS:497, 593, 771-780).
  - "크기 반전" 옵션이 있습니다.
  - 렌더 시 크기 매핑은 `GetPointSize` (UPD:1594-1619)가 합니다.
- 이미지 마커
  - `icon/marker_list/NN.png`. 디렉터리에는 PNG 241개와 `1001.psd` 1개가 있습니다.
  - ID 01–174는 색상 변경이 가능하고, 900 이상(901–953, 1001, 1901–1913)은 풀컬러라 색상 변경이 불가합니다 (PS:1283, UPD:1554).

**Polygon / Line** (POLYS, LS, VC)

- 분류: Eq / Jenks / Quantile / 단일값(unique). 분류 개수 1–20, 기본 5.
  - 기본 방법은 Quantile이고, NET과 SMARTCARD 회사만 Jenks입니다 (LS:317-323, 334-342).
- 색상 램프 13종. 정의는 `GetColorRampString` (JSF:693-740)이며 "색상 반전" 옵션이 있습니다.
  - 예: 램프 1은 `#32a833 → #fdfe57 → #fe001a`.
- 선 폭 기본 3 (LS:532). 투명도는 VC 기본 50% (VC:1992).
- 폴리곤 경계선은 흰색 고정이며 UI에서 숨겨져 있습니다 (POLYS:1764-1785).
- **점선, 해칭 같은 패턴은 없습니다.**

**Density** (DS)

- 10단계 고정, 단계별 색과 alpha.
  - alpha 기본값: 0.14, 0.2, 0.43, 0.57, 0.71, 0.86, 1, 1, 1, 1 (DS:568-585).
- 레이어 전체 투명도와 Search R 1–5 설정이 있습니다.
- 값은 Ect가 아니라 객체 필드에 저장합니다 (DS:422-484).

**Label** (LBL)

- 3.2절의 spec 형식을 씁니다. 라인 레이어에서는 컨트롤이 "라벨 위치 / 간격"으로 바뀝니다 (LBL:270-278).

**스타일 스크립트 (51, 52)**

```
SYSC:alpha|size|markerType|markerImageID|labelSpec|Color[|Name]
```

- 복사: MAIN:10420-10432.
- 적용: 입력을 `:`로 나누면 2개, `|`로 나누면 6개 또는 7개여야 합니다 (MAIN:10450-10480).
- 웹에서는 JSON 스타일 프리셋 복사·붙여넣기로 대체하고, `SYSC:` 파서도 함께 제공하는 것을 권장합니다.

**범례** (LEG)

- 입력 형식: `MOD_Legend_SetLegend("comment|color,from~to|…")` (MAIN:7455).
- Line과 Polygon만 `TOC.GetLegendStringForProvince`로 Ect를 범례 문자열로 바꿉니다 (TOC:4993-5028).
- Point와 Density는 범례를 만들지 않습니다 (TOC:5072-5082).
- 렌더 방식: 20×15 스왓치, 폰트 11, 역순, 하한값에 `+0.1` 표시 (LEG:311-389).
- 이미지 범례 `icon/legend_image/{2..10}.png`도 있습니다 (LEG:306).

---

## 5. 내보내기

| 형식 | 함수 | 메커니즘 | 비고 |
|---|---|---|---|
| .utd / .ly / .ply | 3.4절 | `FileReference.save` (MAIN:10117-10139, TOC:2738-2745, 6810) | 로컬 저장 → Blob 다운로드 |
| KML (레이어별) | `SaveKMLFile` (TOC:2637-2709) | OpenScales `KMLFormat` export → `<Name>.kml` | 아래 참조 |
| KML (전체) | `SaveTotalKmlFile` (TOC:2493-2509) | 알림만 표시 | 미지원 |
| HTML5 지도 | `SaveTotalHTML5File` (TOC:2511-2635) | `UserKmlCreate`의 템플릿, 포인트 KML(아이콘 Base64)과 Density 비트맵 Base64를 넣어 `제목없음.html`로 저장 (TOC:2625). 공유 모드는 서버 업로드 (TOC:2629-2630, USD:278-281) | 로컬 HTML 내보내기는 선택 구현 |
| 테이블 TXT | `UEF.loadDGInCSV` (UEF:372-466) | 아래 참조 | 웹은 CSV(UTF-8 BOM)·XLSX(SheetJS) 권장 |
| Excel(.xls) | `UEF.loadDGInExcel` (UEF:336-370) | `m_sURL/exportexcel.php`에 HTML table을 POST | **호출하는 곳 없음(dead)**. 제외 |
| PNG | `saveAsImage2` (MAIN:9140) | PNG 인코딩 후 `capture.png`로 저장 | 아래 참조 |
| 보고서 XML | `SaveReportFile` (MAIN:10077) | "표준 프리젠테이션 XML". 회사별 분석 모듈(FLOATING, JJ, SB, TOZ 등)에서만 호출 | 범위 외 |

**KML (레이어별) 상세**

- Point, Geocoding, Polygon, Line을 지원하고 Density는 실패합니다.
- `GetExcelDownload()==false`인 레이어는 "정보 제한"으로 거부합니다.

**테이블 TXT 상세**

- 출력은 탭 구분 `.txt`이고 `FileReference.save(String)`로 저장하므로 UTF-8입니다.
- 헤더 공백을 제거하고 `Copyright,Source` 컬럼을 붙입니다.
- 값 안의 `,`는 `，`로, 선두 `-`는 `'-`로 바꿉니다 (UEF:152-262).
- 선택 행만 내보내는 옵션과 클립보드 복사 모드가 있습니다.
- 지오코딩 결과는 마지막 두 컬럼을 TM이나 카텍으로 변환할 수 있습니다 (UEF:216-255).

**PNG 상세**

- modSaveImage 옵션: 배경지도 on/off, 종류, 색상, 범례 포함, 고해상 배율 1.0–8.0 (SI:372-440).
- 범례 창이 열려 있으면 이미지에 합성할지 묻습니다 (MAIN:9173).
- 웹에서는 OL `rendercomplete` 이후 canvas를 합성해 `toBlob`으로 저장하고, 배율은 `pixelRatio`로 처리합니다.
- 타일 CORS 조건이 필요합니다.

---

## 6. 속성 테이블·요약

### modAttributeTable (MAT)

- 진입 함수
  - 포인트: `iShowTableForPoint` (MAT:387). VAL의 `필드: 값` 줄을 파싱합니다 (MAT:610-676).
  - 폴리곤·라인: `iShowTableForProvince` (MAT:322).
- 컬럼: `RowID`를 앞에 붙이고, `COORD`와 `AREA_RANK`는 숨깁니다 (MAT:692-734).
- 정렬: 숫자로 읽히면 숫자 정렬, 아니면 문자열 정렬 (MAT:736-771). **텍스트 검색·필터는 없습니다.**
- 영역 조건 필터: 사용자 영역 `#N`을 고르면 그 안의 포인트만 표시하고 나머지는 반투명 처리합니다 (MAT:930-1162).
- 선택과 이동
  - 행을 선택하면 지도에서 하이라이트합니다 (`setSelectedColor`).
  - 더블클릭하면 해당 위치로 지도를 이동합니다 (MAT:861-913).
  - 모두 선택 / 해제 버튼이 있습니다.
- 편집: **행 편집·삭제, 필드 추가·계산은 없습니다.** 통계 필드 지정만 가능하며 숫자 필드여야 합니다 (MAT:796-825, 1201-1222).
- 요약 (포인트 레이어)
  - 전체, 선택, 영역 내 각각에 대해 개수, 합계, 평균, 최대, 최소를 보여줍니다.
  - 계산 함수: `UPD.CalcCountAndStatByTotalData` (UPD:3477), `CalcCountAndStatByUserArea` (UPD:3665), 표시 MAT:454-548.
- 저장
  - "파일 저장"은 TXT로 저장합니다 (MAT:1008).
  - "레이어 저장"은 .ly로 저장합니다 (MAT:1003).
- 서버 호출은 없습니다.

### modTableAndSummary (MTS)

- 표시 전용 창 "영역 상세분석"입니다. 컬럼 이름에 `(n)` 접두가 있으면 숫자 포맷으로 표시합니다 (MTS:221-356).
- 데이터는 서버 SQL에서 옵니다 (`ShowSummaryInfoOnTable` MAIN:2667-2721, getdb).
- 웹에서는 로컬 집계 결과 뷰어로 재사용합니다. 그룹별 합계·평균은 신규 구현이 필요합니다.

### 콜아웃 (`main/scripts/module/modCallOutView.as`)

- 사용자 영역의 요약 말풍선입니다. 페이지는 기본, 세부, 지점별, 포인트 레이어 통계 순입니다 (CO:313-361).
- 포인트 레이어 통계 페이지만 로컬에서 계산할 수 있습니다.

---

## 7. 그리기·편집·측정 도구

**사용자 분석영역** (UCA)

- 다각형 그리기: `StartDrawPolygon` (UCA:411-532)
- 원 그리기: `StartDrawCircle` (UCA:406)
- 라벨 `#N`, 크기 조정 핸들 (`DrawResizeCircle` UCA:2601), 꼭짓점 편집 (`StartEditing` UCA:2871)
- feature `data`: `{LABEL, TYPE:"POLYGON"|"CIRCLE", LAT, LNG, R_KM, TOOLTIP, TOOLTIP_SUMMURY…, AUTOHOTSPOT}` (UCA:430-445, 원형 UCA:317)
- 영역 안 포인트 개수와 통계는 로컬에서 계산합니다 (UCA:557).
- 서버 통계는 `SetToolTipBySQL` (UCA:946)이며 30번 문서 범위입니다.

**측정**

- 사용하는 컨트롤은 OpenScales `MeasurePath`와 `MeasureSurface`입니다 (MAIN:12063-12097).
- `onMeasure` (MAIN:1421-1460)가 클릭 지점마다 `"<값> <단위>"` 라벨을 `MEASURE_LABEL`로 지도에 표시합니다.
- 면적 계산(분석용)은 KATEC 평면에서 합니다: `UserControlFun.getAreaByPolygon` → `GEOPoly2KAPoly` (`com/CMT/UserControlFun.as:298-330`).
- 웹 권장: `ol/sphere`의 `getLength`·`getArea`(측지)를 쓰고, 단위는 m/km, ㎡/km²로 표시합니다.

**포인트 드래그 편집**

- `m_bEditMode`일 때 포인트 feature에 마우스 down/move/up 리스너가 붙습니다 (UPD:3217-3223, 3255-3304).
- 이 모드는 관리자 전용이고 서버 베이스 레이어용입니다 (`UserEditStartStop.as` setMode).
- 웹에서는 OL `Modify`/`Translate`로 사용자 레이어 편집을 신규 제공할 수 있습니다(선택).

**기타**

- 박스 줌: `UserBoxZoom`.
- 범위 이력: TOC GoBack / GoNext.
- 컨트롤 라인 `UserControlLine.as`: 출발지에서 도착지로 이어지는 흐름선(화살표, 라벨)을 그립니다. 분석 결과 표시용이며 30번 문서와 관련됩니다.
- **자유 도형 그리기는 없습니다.** OpenScales DrawingToolbar 클래스는 포함되어 있지만 MAIN에서 쓰이지 않습니다.

---

## 8. 서버 영속화 목록과 브라우저 대체

| 원본 | 엔드포인트 (근거) | 데이터 | 웹 대체 |
|---|---|---|---|
| 서버 프로젝트 저장, 열기, 편집, 전달 (1-3/1-4/1-5, 교사 배포) | `m_sURL/<UserFile_Folder>/writefile.php` POST `sID=<toID>`, `sFileName=<from>.<name>.<date>`, `sContent` (USD:336-395). 목록과 열기는 modServerFileDialog | .utd 본문 | **IndexedDB `projects` 스토어** (자동·수동 저장 슬롯). 공유는 .utd/JSON 파일 다운로드 |
| PT 공유 URL (1-7/1-8) | writefile.php `sID=PT` → `getUrl(1)?sPara=PT\|<id>` (USD:214-299) | .utd | 제외. 대신 "프로젝트 파일 내보내기" |
| 레이어 웹링크 (TOC 11) | writefile.php `sID=LY` → `LAYER_APPEND_TAG://<id>` (USD:249) | .ly | 제외 |
| HTML5 공유, SMS·메일 | `http://bizgis.gislab.co.kr/UserFile/XRY_MEMBER_FILE/writeHtml5_2.php` → 공개 URL `…/HTML5/<id>.html` (USD:251, 280-281) | HTML | 제외. 로컬 HTML 다운로드만 |
| 사용자 메모(정보 등록) | 아래 참조 (MMI:471-568, 856-1085; MMI2:913) | 메모, 위치, 사진·문서 | **IndexedDB `memos` 스토어** (Blob 포함). 주소는 역지오코딩 프록시 |
| 메모 이미지 보기 | `getImageFileList.php`, `<folder>/<CD>/<file>`, `ShowImage.php` (MIV:141-301) | 이미지 | IndexedDB Blob을 `URL.createObjectURL`로 표시 |
| 지도 우클릭 주소 | getdb.php `FN_HOUS2ADDRESS` (MAIN:10285) | – | 카카오 역지오코딩 (프록시) |
| 엑셀 내보내기 | exportexcel.php (UEF:336, dead) | – | SheetJS 로컬 생성 |
| 설정·로그인 상태 | `SharedObject.getLocal("XRAYMAP")` (INIT:209), 키 `ID`, `COMPANY` (`UserLogInProcess.as:588-589`) | 로그인 정보 | 제외. UI 설정만 localStorage |
| 메뉴 XML, 회사 설정 | `get.php?FILE=` (INIT:1416) | – | 정적 JSON 메뉴 정의 |

**사용자 메모(정보 등록) 상세**

- 주소와 PNU는 `getdb.php`의 `FN_XY2HOUS`·`FN_HOUS2ADDRESS`로 조회합니다.
- 이미지는 `imageupload.php`, 문서는 `docupload.php`로 올립니다.
- 마지막으로 `setdb.php`에 `INSERT INTO GISUTD.XRY_INFO_USER_LOCATION(...)`을 보냅니다.

**IndexedDB 스키마 제안** (`idb` 라이브러리 사용)

- `projects{id, name, updatedAt, project: Project}`
- `layers{id, projectId, …UserLayer}`: 대용량 features를 분리 저장합니다.
- `blobs{key, blob}`: 밀도 래스터와 메모 사진입니다.
- `memos{id, lng, lat, title, body, address?, attachments: blobKey[], createdAt}`
- `settings` 스토어는 localStorage로 대체해도 됩니다.

**운영 원칙**

- 업로드한 원본 파일은 기본적으로 저장하지 않고, 파싱 결과만 저장합니다.
- "브라우저에 저장된 데이터 모두 삭제" 버튼을 제공합니다.
- 용량 초과(QuotaExceededError)를 처리합니다. 원본 상한(포인트 1만 행, 출력 5만 개)을 참고해 기본 상한을 설정합니다.

---

## 9. Unknowns

1. 상단 메뉴 라벨과 계층 구조. 서버 `get.php?FILE=<company>…menu` XML이 설치본에 없어서 value 코드와 기능만 확인했습니다.
2. `modLeftSimpleMenu` 원본 항목 (디컴파일에 없음).
3. `com.excel.Excel`의 날짜·수식 셀 처리 방식 (AP의 xlsx 파서 내부를 확인하지 않음).
4. `UserBlockDraw`/`UserLineDraw`의 실제 선 폭·외곽선 렌더 세부 (내부 위임 객체 미추적).
5. Ect[6] `cdField`의 정확한 의미. 행정구역 코드 필드로 추정합니다.
6. `./KML/MEGA_2015.xml`, `CTY_2015.xml`의 실제 위치. 상대 경로인데 설치본에 KML 폴더가 없어 서버 경로로 추정합니다.
7. HTML5 내보내기 템플릿 전체 (`UserKmlCreate.getHTML5`, TOC:2315-2490)의 외부 스크립트 의존성은 세밀히 보지 않았습니다.
8. 포인트 ID 중복 제거(3번째 필드 기준)가 USER_ADD_POINT 경로(CreatePoint2)에도 적용되는지 확인하지 못했습니다. 우선 AddPoint 경로에서만 확인됐습니다.
9. 메뉴 3-x 분석 기능과 Density/Cell 렌더 파라미터는 30번 문서 범위라 여기서는 다루지 않았습니다.

---

## 보안 관찰

이 내용은 `re/notes/security.md`에도 반영해야 합니다.

1. **임의 SQL 실행 엔드포인트**: 클라이언트가 원문 SQL을 `sSQL` 파라미터로 POST합니다.
   - 예: `http://bizgis.gislab.co.kr/getdb.php` (MAIN:10285-10300), MMI:383-469의 `SELECT … FROM DUAL`.
   - `setdb.php`는 같은 URL에서 이름만 치환해 INSERT와 UPDATE를 보냅니다 (USD:117-119, 196-197).
   - 서버가 클라이언트 SQL을 신뢰하는 구조라 SQL 인젝션 수준이 아니라 **DB 전권 노출**입니다.
   - 웹 버전에서는 절대 재현하지 말아야 합니다(범위상 제외).
2. **인증 없는 파일 쓰기**: `writefile.php`가 `sID`(대상 사용자 폴더)와 `sFileName`, `sContent`를 그대로 받습니다 (USD:268-287, 375-385).
   - 수신자 ID를 임의로 지정해 다른 사용자 폴더에 쓰는 것이 가능해 보입니다.
   - 파일명 경로 조작(path traversal) 가능성도 있습니다. 서버 측은 미확인입니다.
3. **추측 가능한 공개 URL**: 공유 ID 형식은 `YYYYMMDD_HHMMSS_tempID<0-999>`입니다 (TOC:1600, 1622, 2629).
   - HTML5 공유본은 `https://bizgis.gislab.co.kr/UserFile/XRY_MEMBER_FILE/HTML5/<id>.html`에 공개됩니다 (USD:251).
   - 시간과 난수 1000개만으로 열거할 수 있어 사용자 데이터가 노출될 수 있습니다.
4. **업로드 엔드포인트**: `imageupload.php?UploadDir=<CD>&sDate=…`, `docupload.php`에 디렉터리 파라미터가 클라이언트에서 전달됩니다 (MMI:983, 1073; MMI2:913).
   - 디렉터리 파라미터 조작 위험이 있습니다.
   - pdf, doc, hwp 업로드 허용 여부의 서버 측 검증은 확인할 수 없었습니다.
5. **평문 HTTP**: 다수 엔드포인트가 `http://`입니다 (getdb, writeHtml5_2 등). 통신 내용과 자격이 노출됩니다.
6. **"보안" 인코딩**: 프로젝트와 레이어 파일의 `BASE64:…#END#`는 퍼센트 인코딩에 Base64를 씌운 것일 뿐이며 암호화나 무결성 검증이 없습니다 (URL:226-275).
   - 함수명의 "MD"는 MD5가 아닙니다.
   - 웹에서 .utd, .ly를 읽을 때는 입력 크기를 제한하고 숫자를 검증해야 합니다.
   - 파일 내용은 신뢰하지 않는 데이터로 다룹니다: 레이어명과 필드명을 DOM에 넣을 때 escape하고, HTML 템플릿에 직접 삽입하지 않습니다.
7. **클라이언트 측 권한 제어**: 다음 제한이 모두 클라이언트 변수로만 판정됩니다.
   - 관리자 목록 `m_saAddminList` (AP:597)
   - `m_bAdmin` (`UserEditStartStop.as`)
   - 회사별 이미지 저장 버튼 (SI:254-268)
   - 레이어 `GetExcelDownload` 내보내기 제한 (TOC:2007)
8. **하드코딩된 연락처와 PII**: 고객지원 Alert에 담당자 실명, 휴대전화, 이메일이 하드코딩되어 있습니다 (INIT:1900-1925). 웹 버전에 복제하지 않습니다.
9. **HTML5 내보내기의 XSS**: 레이어명과 속성값이 KML·HTML 템플릿에 문자열 치환으로 들어갑니다 (TOC:2029-2031, 2098, `UserKmlCreate`).
   - 레이어명은 CDATA로 감쌉니다.
   - 웹에서 HTML 내보내기를 재구현한다면 escape를 적용하거나 데이터를 JSON으로 분리해야 합니다.
