# 20. 지오코딩 · 주소/POI 검색 · 행정구역 · 필지(PNU) 조회

대상: XRayMap CS 디컴파일 결과 (`re/decompiled/main/scripts`, `re/decompiled/modules/<mod>.swf/scripts`).
표기: `main/` = `re/decompiled/main/scripts/`, `mods/` = `re/decompiled/modules/`.
범위 결정은 `00_scope.md` 따름 (DB/getdb/설정/파일 API는 제외, 지오코딩→카카오 로컬, 필지→NSDI/VWorld).

> 근거 원칙: 아래 모든 서술은 인용한 파일/라인에서 직접 확인한 것. 서버 측 PHP/DB 함수의 **응답 내용은 클라이언트에 없음**. 클라이언트가 어떻게 파싱하는지로부터 역추정한 것은 "(추정)"으로 표시함.

---

## 0. 요약

| 기능 | 원본 호출 | 응답 파싱 | 좌표계 | 웹 대체 |
|---|---|---|---|---|
| 상단 검색창(POI 우선→주소) | `daum_poi_search.php?sSearch=` → 실패 시 `daum_geocodingForWebXRayMap.php?sAddress=` | `name^comment^lng^lat|…` | WGS84 경위도 | 카카오 `keyword.json` → `address.json` |
| 위치검색 모듈(단건 주소) | `daum_geocodingForWebXRayMapSearch.php?sKey=&sAddress=` | `^`→`|` 후 `[4]=lng,[5]=lat,[6]=매칭코드(1~4)` | WGS84 | 카카오 `address.json` |
| 정책지도 주소입력(단건) | `daum_geocodingForWebXRayMapLoop.php?sKey=&sAddress=` | 위와 동일 | WGS84 | 카카오 `address.json` |
| 일괄 지오코딩(modGeocoding) | `{m_sGeocodingURL}[:port]/ADDRESS=NEW_<난독화>_END&PRJ=GEO` (geocoding.kr) | `x|y|<정제구분문자열>` | `PRJ=GEO` = WGS84 | `/api/geocode/batch` (카카오 address → keyword 폴백) |
| 우클릭 필지 하이라이트 + "주소 획득" | `pnu_total.php` POST `X=lng&Y=lat` | `<폴리곤좌표>#^#<정보1>|<정보2>|…` (첫 항목 `PNU:<19자리>`) | WGS84 | VWorld `LP_PA_CBND_BUBUN`(geomFilter=POINT) + NED 토지특성 |
| 지점→PNU+주소(간단) | `pnu_simple.php` POST `X=lng&Y=lat` | `PNU^주소…` | WGS84 | 카카오 coord2address+coord2regioncode → PNU 조합, 또는 VWorld |
| 좌표→주소(DB 함수) | `getdb.php` POST `sSQL=SELECT FN_HOUS2ADDRESS(FN_XY2HOUS(kx,ky)) FROM DUAL` | 주소 문자열 1개 | 입력 KATEC | 카카오 `coord2address.json` |
| 행정경계 선/면, 콤보 | `getdb.php` + 서버에서 내려받는 SQL 템플릿(`xray_province_*`) / 로컬 KML `./KML/MEGA_2015.xml`, `CTY_2015.xml` | `x,y,x,y…|…` / KML Placemark name=행정코드 | WGS84 | 정적 GeoJSON(시도/시군구/읍면동) + 카카오 `coord2regioncode` (+VWorld `LT_C_AD*` 선택) |

---

## 1. 개별 호출 상세

### 1.1 `daum_poi_search.php` / `daum_geocodingForWebXRayMap.php` — 메인 검색창

- 트리거: 메인 검색 텍스트박스에서 Enter → `bizgismap_cs.as:10027 txtSearch_keyUpHandler` → 빈 문자열이면 "검색할 단어를 입력하세요" 경고, 아니면 `UserListForSearch` 팝업 생성 후 `setResult(text)` (`bizgismap_cs.as:10038-10042`).
- `UserListForSearch.setResult` → `setPoiResult` (`main/UserListForSearch.as:207-212`).
- **POI 검색** (`UserListForSearch.as:278-342`)
  - URL: `http://bizgis_api1.gislab.co.kr/daum_poi_search.php?sSearch=<encodeURIComponent(검색어)>` (L334-335)
  - 메서드: `POST`, 본문 없음(파라미터는 쿼리스트링), `dataFormat=BINARY` → `readMultiByte(...,"UTF-8")` (L291-292, L336-339)
  - 응답이 4자 미만이면 → **주소 검색으로 폴백** `setAddressResult(sSearch)` (L295-303)
  - 파싱: trim → `<b>`, `</b>` 제거 → `split("|")` → 마지막 원소(빈 꼬리) 제외(`while i < n-1`) → 각 행 `split("^")`: `[0]=name, [1]=comment, [2]=lng, [3]=lat` (L304-326)
- **주소 검색** (`UserListForSearch.as:214-276`)
  - URL: `http://bizgis_api1.gislab.co.kr/daum_geocodingForWebXRayMap.php?sAddress=<encodeURIComponent>` (L268-269), POST, UTF-8
  - 파싱 동일: `name^comment^lng^lat|…|` (L244-253)
- 좌표계: 결과를 `new LatLng(lat, lng)` 로 그대로 `panTo` (L140-142) → **WGS84 경위도**.
- UI: 150×290 `TitleWindow` "검색결과" (L78-81), 검색창 바로 아래 위치(alpha 0.9), `List` + `RendererStateOnlyText`(name/comment 2줄로 추정). 항목 클릭 → `panTo` + 선택마커(`addSelectedMarkerNoTimer`) (L121-143).
- 같은 팝업이 "정책지도 XML 검색" 결과에도 재사용됨(`setResultForXmlSearch`, `name^…^sub_idx^tab_idx^item_idx`) — 지오코딩과 무관, 정책지도 메뉴 이동 기능 (L165-205, `UserListButton_w.as:1161`).

### 1.2 `daum_geocodingForWebXRayMapSearch.php` — 위치검색 모듈(modLocationSearch)

- `mods/modLocationSearch.swf/scripts/module/modLocationSearch.as:260-323 RunBizgisGeocoding`
- URL: `http://bizgis_api1.gislab.co.kr/daum_geocodingForWebXRayMapSearch.php?sKey=4a2732842a11e638069c653f4439c6105f1e8d58&sAddress=<encodeURIComponent>` (L305-310); POST, 본문 `address=<원문주소>` (L316-320), `dataFormat=TEXT`.
- 응답 파싱: `"^"`→`"|"` 치환 후 `split("|")` (L274-275). 사용 필드: `[4]=lng`, `[5]=lat`, `[6]=매칭코드`. `[0..3]`은 클라이언트에서 미사용(의미 불명).
  - `"1"` 정확 → 마커+이동 / `"2"` "일치하는 지번이 없습니다. 인근지번으로 이동합니다." / `"3"` "…행정동 대표위치로 이동합니다." / `"4"` "…법정동 대표위치로 이동합니다." / 그 외 "입력된 주소에 문제가 있습니다." (L276-298)
- 같은 모듈의 다른 탭: KATEC / TM / 경위도 수동 입력 → `KA2GEO`/`TM2GEO` 변환 후 마커 (L217-258). 서버 호출 없음.

### 1.3 `daum_geocodingForWebXRayMapLoop.php` — 단건/루프 지오코딩

- 정책지도 "주소 입력" 팝업: `mods/modPolicy_Analyst.swf/scripts/com/seld/draw/UserSearchLatLngOrAddress.as:168-233`
  - URL `http://bizgis_api1.gislab.co.kr/daum_geocodingForWebXRayMapLoop.php?sKey=4a27…8d58&sAddress=…` (L215-220), POST `address=` (L226-230)
  - 파싱 동일(`[4]=lng,[5]=lat,[6]=1..4`), 1~4면 `setBestCenter(…,19)` + 마커 + "지적도면에서 확인하세요" 툴팁 (L184-189, L123-166)
- 일괄 루프(키 로테이션): `modGeocoding.as:960-1092 RunBizgisGeocoding`, `mods/modHEALTH_Upload.swf/scripts/module/modHEALTH_Upload.as:1925-2058`
  - 호스트/키 10쌍: `http://bizgis_api{N}.gislab.co.kr/...Loop.php`, N=1..10, 키는 40자리 hex 10개 하드코딩 (`modGeocoding.as:1021-1064`, `modHEALTH_Upload.as:1986-2029`)
  - 응답에 `-9999` 또는 `Too Many` 포함 → 다음 N으로 같은 행 재시도, N=10에서도 실패면 "허가된 일일 지오코딩 개수가 초과되었습니다" 후 중단 (`modGeocoding.as:980-991`) → **서버측 일일 쿼터를 클라이언트가 키 돌려막기로 회피**.
  - 주소 전처리: `'`,`"` → 공백, `" 일반 "` → `" "` (L1077-1080)
  - modGeocoding에서는 이 경로가 **사실상 죽은 코드**: 진입점 `SetGeocodingServer`는 항상 `RunBIZGIS2016Geocoding`만 호출(L864-867). `RunBizgisGeocoding`은 `RunGeocoding`(asp.geocoding.co.kr, L869-958)의 IOError 핸들러에서 EDU/ANA 회사일 때만 호출되는데 `RunGeocoding` 자체가 호출되지 않음.
- 네이버 경로 `RunNaverGeocoding` (`modGeocoding.as:1289-1374`, `naver_geocoding_temp.php`, 키 3개)도 호출처 없음(죽은 코드).

### 1.4 geocoding.kr — 일괄 지오코딩 실제 경로 (`RunBIZGIS2016Geocoding`)

- `mods/modGeocoding.swf/scripts/module/modGeocoding.as:1094-1274`
- 베이스: `app.m_sGeocodingURL` 기본 `"http://www.geocoding.kr"` (`bizgismap_cs.as:439`).
- 포트 탐지 `setPort()` (`modGeocoding.as:327-383`): `POST {base}:8088/ADDRESS=%EA%B0%95%EC%9B%90%EB%8F%84`(="강원도"), 응답을 **EUC-KR**로 디코드, "광역시" 포함 시 port=`8088`; IOError면 port="" 및 base를 `http://www.geocoding.kr`로 리셋; `m_bReleaseMode==false`(개발)면 `1818`.
- 요청 URL: `{base}[:port]/ADDRESS=NEW_<obf>_END&PRJ=GEO` (L1227-1234), POST 본문 `address=<원문>` (L1265-1269), `dataFormat=TEXT`.
- `<obf>` 난독화 (L1251-1263): `encodeURIComponent` → `encodeSpetialChar`(`! ' ( ) * + - .` 퍼센트 인코딩, 단 `,`는 `%` 없이 `"2C"`로 치환 — 버그, L1276-1287) → Base64 → `=` 를 `"JUVDJTgEJUVDJTg"`로 치환 → 문자 스왑 J↔D, V↔T → 문자열 뒤집기. **암호화 아님(가역적 치환)**.
- 응답 파싱 (`DrawGeocoding`, L1476-1523): `split("|")` → `[0]=x(lng)`, `[1]=y(lat)`, `[2]`=정제구분 문자열(부분일치). `PRJ=GEO`이고 결과를 `LatLng(y,x)` 로 쓰므로 WGS84 경위도.

### 1.5 `pnu_total.php` — 우클릭 필지 폴리곤 + 지적정보

- URL: 개발모드 `http://www.biz-gis.com/XRayMap/pnu_total.php`, 릴리스 `getUrl(2)+"/pnu_total.php"` = `{m_sURL}/XRayMap/pnu_total.php` (`main/com/seld/draw/URL_Return.as:216-228`, `bizgismap_cs.as:9449-9453`).
- 호출: `bizgismap_cs.as:10671-10741 addPnuPolygon(LatLng)` — POST, form `X=<lng>`, `Y=<lat>` (WGS84) (L10733-10737), BINARY→UTF-8.
- 응답: `ResetString`(rtrim 후 `"|#"` 앞부분만, `bizgismap_cs.as:2787-2793`) → 길이>10이면 `split("#^#")`:
  - `[0]` = 필지 경계 좌표 문자열 → `getPolygonByString(s,"GEO")` (`main/com/CMT/UserControlFun.as:554-662`): `"x,y,x,y,…"`(`^`도 `,`로 취급), 다중 링은 `|`, 내부 홀은 `#inner#` 구분. WGS84.
  - `[1]` = 지적정보, `split("|")` → `m_aSelectedPNUInfoNoAutoRemove` 배열 (L10703-10712).
  - 첫 원소 형식: `"<라벨>:<PNU 19자리>"` — `modMemoInsert2.as:299-301`에서 `_loc2_[0].length > 19 && indexOf(":")>0` 이면 `split(":")[1]`을 PNU로 사용. 나머지 원소의 라벨/필드(지목·면적·공시지가 등)는 **클라이언트 코드에 하드코딩되어 있지 않음** → 서버가 만든 `"라벨:값"` 줄을 그대로 표시(추정).
- 표시: 빨간 테두리(stroke 0xFF0000, alpha 0.5, width 2), 채우기 투명 폴리곤 (`bizgismap_cs.as:3535-3563 addSelectedPNUNoAutoRemove`, 스타일 L3542).
- 트리거:
  - 지도 우클릭 시 항상 (`bizgismap_cs.as:1120-1135`: 메뉴 표시 + 마커 + `addPnuPolygon`)
  - 버퍼 생성 모듈 `mods/modBufferCreateBy_R…/modBufferCreateBy_R.as:324-335` (200ms 폴링 최대 10회로 결과 대기 후 정보 텍스트 앞에 붙임)
  - 메모 입력 `mods/modMemoInsert2…/modMemoInsert2.as:281-318` (같은 폴링, `txtCoordString`에 정보 + `경위도:lng, lat` 표시)
- 우클릭 메뉴 (`bizgismap_cs.as:11035-11041`): `좌표 획득`(index 0) / `주소 획득`(index 1) / `메뉴 닫기`(99).
  - `좌표 획득` (L10207-10244): 경위도(소수 9/8자리 자름), TM, 카텍, UTMK 정수 + 줌 → Alert, Yes 시 클립보드 복사.
  - `주소 획득` (L10245-10313): pnu_total 결과가 있으면 정보 줄을 `\n`으로 join → Alert "주소 및 지적정보 클립보드에 복사". 없으면 **폴백**: `GEO2KA` → `getdb.php`에 `SELECT FN_HOUS2ADDRESS(FN_XY2HOUS(kx,ky)) FROM DUAL` → Alert "주소를 클립보드에 복사(지적정보 미추출)" (L10297-10311; URL 하드코딩 `http://bizgis.gislab.co.kr/getdb.php`, L10300).

### 1.6 `pnu_simple.php`

- URL 규칙 `URL_Return.as:230-242` (pnu_total과 동일 패턴).
- `mods/modWizardsNPB…/modWizardsNPB.as:235-292`: 사용자 영역 원의 중심(WGS84 `m_fLng`,`m_fLat`)으로 POST `X`,`Y` → 응답 길이>19면 `split("^")`: `[0]=PNU`, `[1]=주소` (L258-262). 같은 함수에서 KATEC 좌표(`GEO2KA`, 소수1자리)도 따로 계산(L275-277).
- `mods/modHEALTH_Analyst…/modHEALTH_Analyst.as:2855-2909`: 지도중심 lng/lat(소수6자리) POST → `split("^")[1]`(주소)을 텍스트필드 `txtLatLngName5/6`에 표시.
- 오류 시 "Pnu API Error" Alert.

### 1.7 DB 함수 `FN_XY2HOUS`, `FN_HOUS2ADDRESS(2)` (getdb.php, 클라이언트 SQL)

| 위치 | SQL | 엔드포인트 | 용도 |
|---|---|---|---|
| `bizgismap_cs.as:10297-10311` | `SELECT FN_HOUS2ADDRESS(FN_XY2HOUS(kx,ky)) FROM DUAL` | `http://bizgis.gislab.co.kr/getdb.php` (하드코딩) | 우클릭 주소 획득 폴백 |
| `modMemoInsert2.as:403-445` / `modMemoInsert.as:406` | `SELECT FN_XY2HOUS(kx,ky) FROM DUAL` | `{m_sURL}/{m_sASP_DB}` | 메모 저장용 m_sPNU(=HOUS 코드) |
| `modMemoInsert2.as:447-491` / `modMemoInsert.as:450` | `SELECT FN_HOUS2ADDRESS(FN_XY2HOUS(kx,ky)) FROM DUAL` | 동일 | 메모 좌표 텍스트에 주소 표시 |
| `mods/modTOZInsert…/modTOZInsert.as:616` | `FN_HOUS2ADDRESS2(FN_XY2HOUS(…))` | 동일 | TOZ 고객 전용 |
| `mods/modSB_Analyst…:1525`, `mods/modTOZ_Analyst…:1839` | `FN_HOUS2ADDRESS(FN_XY2HOUS(…))` | 동일 | 상권분석 리포트 주소 |

- 입력 좌표 = **KATEC**(Bessel TM, lon0=128, lat0=38, k=0.9999, FE=400000, FN=600000; `main/com/seld/draw/GeoTrans.as:60-66`, datum shift `-146.43,507.89,681.46` L88-90). `GEO2KA` (`bizgismap_cs.as:9938-9944`), 메모에서는 `int()` 절사(`modMemoInsert2.as:384-395`).
- 전송: form `sSQL=<UserURLUtil.encodeURL(SQL)>` (UTF-8 percent-encoding, 공백 `+`; `main/com/seld/draw/UserURLUtil.as:19-…`), 응답 `decodeURL`(기본 param2=0이면 no-op, L92-106) → `ResetString`.
- `FN_XY2HOUS` 반환값은 "HOUS"(주택/필지) ID로, 메모의 `m_sPNU`에 저장되므로 PNU 또는 PNU 유사 코드(추정, 확인 불가).

---

## 2. 일괄 지오코딩 흐름 (modGeocoding)

진입: `ShowGeocodingPanel()` → `module/modGeocoding.swf`, 창 제목 "Geocoding" (`bizgismap_cs.as:6775-6795`, `7322-7333`).

### 2.1 입력
- 텍스트 붙여넣기(`txtGeocodingString`) 또는 엑셀(.xlsx만) 열기 → 시트 선택(최대 10) → 셀을 탭으로 join해 텍스트로 변환 후 자동 파싱 (`modGeocoding.as:1689-1873 CallBtnOpenExcel`).
- 구분자: 탭/콤마/파이프 (`sSplitWord`, L179-188). 콤마 선택 시 경고 (L597-600).
- 줄바꿈 정규화 `\n\r`,`\r\n`,`\r` → `\n`, 빈 줄 제거 (L1678-1687). 마지막 줄 길이<5면 버림 (L590-593).
- 첫 줄 헤더 옵션(`chk_FirstRowFieldName`); 아니면 `Field_1..n` (L603-625).
- 주소 컬럼 자동선택: 헤더 `indexOf("주소") > 0` 인 컬럼 (L645-648) — **버그: 헤더가 정확히 "주소"(index 0)면 자동선택 안 됨**. 수동 선택 `cmbAddSplit1` 필수(L422-426).
- 통계값 컬럼(`cmbStatValue`, 숫자형, 반경분석 종속변수용) 선택 가능 (L400-403, L718-725).
- 구분자가 콤마가 아니면 셀 내부 콤마를 공백으로 치환 (L696-699), 구분자 주변 공백 제거 (L700-701).

### 2.2 제한
- 공개판(회사명 없음·관리자 아님): **100행 초과분 잘라냄** + 경고 (L684-692), 열 때도 "1회 100건" 안내 (L277-298, L1943-1949). 회사 라이선스는 "1회당 1만건" 문구만 있고 클라이언트 강제 없음 (L1928-1941).
- 특정 클라이언트 IP(`211.236.4.196`) 접속 시 차단 경고 (L178, L304-324).
- 모든 제한은 **클라이언트 측에서만** 적용.

### 2.3 실행 / 레이트 리밋
- `CleanAddString` → 진행바 "지오코딩 중..." → `SetGeocodingServer` → `RunBIZGIS2016Geocoding(…,0)` (L710-743, L864-867).
- **완전 순차**: 응답 COMPLETE 이벤트에서 다음 행 요청(재귀). 동시성 1, 별도 지연/타이머 없음 → 사실상 RTT가 레이트 리밋 (L1118-1223). 진행바 `n/N 진행 중...`.
- 첫 번째로 "정좌표"가 아닌 결과가 나오면 한 번만 사용자에게 지도 표출 필터를 물음: `정좌표만`(1, 기본) / `정좌표+인근좌표만`(2) / `전체`(3) (L1138-1195).
- IOError 시 해당 주소 Alert + 행의 주소를 `"지오코딩 에러(지오코딩 버그로 처리 못함)"`로 덮고 다음 행 진행 (L1109-1117). **버그**: 결과 배열에 push하지 않아 이후 결과-행 인덱스가 어긋남; 마지막 행 오류 시 범위 밖 인덱스로 "주소 없음"을 한 번 더 요청.
- 빈 주소 → `"주소 없음"`으로 요청하고 행 주소를 `"주소 없음(문자열에 '엔터'가 들어간 경우 문제가 발생할 수 있음)"`으로 표시 (L1235-1245).

### 2.4 결과 분류 (`DrawGeocoding`, L1476-1523) — 응답 `[2]` 문자열 부분일치, 우선순위 순

| 원본 클래스 | 판정 조건 (`[2]`에 포함) | 비고 |
|---|---|---|
| 정좌표 | `정좌표` | 지번/건물 정확 매칭 |
| 인근좌표 | `인근좌표` | 인근 지번 |
| 도로중심좌표 | `도로중심좌표` | |
| 행정동좌표 | `행정동` | |
| 법정동좌표 | `법정동` | |
| 시군구좌표 | `시군구` | |
| 광역시좌표 | `광역시` | |
| 정제실패 | 그 외 | 좌표를 **123.77474, 32.53129**(제주 남서 해상)로 강제 |

- 지도 표출 필터: 3=전체, 2=정좌표/인근좌표, 1=정좌표만 (L1524).
- 그리드 행 클릭 시 결과가 `정좌표`/`인근좌표`/`Not Guarantee` 이면 이동+마커, 아니면 "정좌표나 인근좌표가 아닙니다." (L1646-1672).

### 2.5 출력
- 지도 레이어: `RunGetDBAfter("POINT", …, "USER_ADD_POINT", sVal, …, layerName)` (L1570), 레이어명 기본 `"Geocoding 결과"`, 색상 `colorPoint`, `chkExtentMove`면 범위 이동.
  - 행 문자열: `ID(=i+1),주소,[통계값],[나머지 컬럼…],정제결과,지번,X,Y` (L1530-1548)
  - 필드 정의 `g_sUserAddPointFields`: `ID,주소,[#stat#<통계필드>,]<기타헤더…>,정제결과,지번,X_AXIS,Y_AXIS` (L1398-1422)
  - `지번` 값은 항상 `"생략"` (L1472) — 실제 지번 미제공.
- 그리드: 원본 컬럼 + `결과`,`지번`,`x`,`y` (L745-768). **버그**: 부가 배열은 필터 통과 행만 담는데 행 인덱스로 붙여서 필터가 1/2일 때 열이 밀림.
- 내보내기: CSV 저장 / 클립보드(팝업) — 좌표계 선택 `경위도` / `TM` / `카텍` (`loadDGInCSV(dg,2,{1|2|3})`, L449-515).

### 2.6 `UserAddressList.as`는 지오코딩이 아님
- `main/UserAddressList.as`: 영역 내 아파트/빌라 **주소 리스트(DM) 추출**. `getdb` 카운트/추출 SQL(`APT_CLSS`, `AREA`, `PRICE`, `ROWNUM<max`)을 클라이언트가 조립(L470-580) → 결과를 `address_List.html`로 POST 팝업(L442-468). 기업계정 전용(L219-247). DB 의존 → **웹 범위 제외**.
- `modAddPoint`는 X/Y 컬럼(경위도/TM/KATEC/UTM/GRS80/구GRS) 기반 포인트 추가로 지오코딩 호출 없음 (`modAddPoint.as:679-718`). `modStoreList`는 회사 DB(`m_sCompanyGetDBURL`) 조회만 (`modStoreList.as:275-345`). 둘 다 지오코딩 API 없음.

---

## 3. 역지오코딩 / 필지 속성

- 클릭(우클릭) → `pnu_total.php`(필지 폴리곤 + 정보 줄) → 실패 시 `FN_HOUS2ADDRESS(FN_XY2HOUS)`(주소만). §1.5 참조.
- **표시되는 필지 속성 목록은 클라이언트에 정의되어 있지 않다.** 클라이언트는 서버가 준 `"라벨:값"` 줄 배열을 그대로 Alert/텍스트박스에 출력하며, 코드에서 확정되는 것은 첫 줄의 `PNU`(19자리)뿐 (`modMemoInsert2.as:299-303`, `bizgismap_cs.as:10262-10263`, `modBufferCreateBy_R.as:329-331`).
  - 지목/면적/공시지가/용도지역 등이 포함되는지는 **미확인**(서버 응답 캡처 필요).
- 참고: 공시지가·지목은 `modAnalystTool`의 DB 분석(`OBJ_#YYYY# = '전'/'답'/'대'/'임'`, `chkLandPrice*`, `modAnalystTool.as:1833-1866`, `5959-6023`)에서 별도 사용 — DB 기반이라 범위 제외.
- 웹 버전 권장 표시 항목(NSDI 기준, 원본 대비 확장): 주소(지번/도로명), PNU, 지목, 면적(㎡), 개별공시지가(원/㎡, 기준년월), 용도지역(1/2), 이용상황, 지형높이/형상, 도로접면.

---

## 4. 행정구역 (UserProvince*, modAddProvince, modProvinceWhere)

### 4.1 경계 데이터의 출처
1. **SQL 템플릿 + getdb** (선 경계/라벨/선택 하이라이트/콤보)
   - SQL 템플릿은 클라이언트에 없음. `UserSQL`이 시작 시 `{m_sURL}/getFileList.php`(sPath=`m_sSQL_Folder`, sCompany)로 목록을 받아 `Base64.getEncryptDecoding` 후 개별 SQL을 내려받음 (`main/com/seld/draw/UserSQL.as:89-179`). 템플릿이 `http://…#URL#<SQL>` 형태면 다른 DB URL로 보냄 (`UserProvince.as:231-235` 등).
   - 사용 템플릿 ID: `xray_province_도경계_etc`, `xray_province_시경계_etc`, `xray_province_동경계_etc`, `xray_province_동경계ByCtyCD_etc` (`main/com/seld/draw/UserProvince.as:229,313,397,502`), 라벨 `xray_provincelabel_시군구 라벨_etc`, `…행정동 라벨_etc`, `…행정동 라벨ByCtyCD_etc` (L129,145,167), 선택 경계 `xray_province_선택한행정경계_etc` (`bizgismap_cs.as:4054,4182`), 콤보 `xray_provincecombo_광역시콤보_etc`, `…시군구콤보_etc` (`modProvinceWhere.as:272,276`), 인접 시군구 계산 (`UserProvinceSearchByCoord.as:209-211`), 공간연산 `xray_province_공간연산_행정경계_etc` (`modDensityAnalystTool/UserPolygonPointStat.as:79`).
   - 경계 요청 시 현재 화면 범위를 상하좌우 1/4씩 넓힌 bbox를 템플릿에 넣음 (`UserProvince.as:223-229`).
   - 응답: `"x,y,x,y,…|x,y,…"`(GEO=WGS84) → 도/시/동 경계는 `LineString`(선)으로 그림, 속성 `{"TYPE":"DO"}` 등 (`UserProvince.as:203-215`). 선택 경계는 폴리곤(stroke 파랑 255, alpha .7, fill 0.1) (`bizgismap_cs.as:4015-4043,4056-4062`). 인접 계산 응답은 `coords…,NAME,CTY_CD` (`UserProvinceSearchByCoord.as:278-283`).
   - 코드 체계: `CTY_CD` 5자리(시군구) / 2자리(시도) — `CTY_CD = 'xxxxx'` 또는 `CTY_CD LIKE 'xx%'` 로 WHERE 조립 (`modProvinceWhere.as:206-216`). 동(DONG) 코드는 "행정동" 기준(라벨 템플릿명 근거).
2. **로컬 KML (행정구역 주제도/단계구분도)**
   - `UserProvinceDraw.CreatePolygon`: 데이터 첫 행 코드가 2자리면 `./KML/MEGA_2015.xml`(시도), 아니면 `./KML/CTY_2015.xml`(시군구) 로드 (`main/com/seld/draw/UserProvinceDraw.as:44-51`).
   - KML Placemark `name` == 행정코드 로 사용자 데이터와 조인 (`UserKMLPoly.as:752-763`), 좌표 `lon,lat`(KML) (`UserKMLPoly.as:722-733`), 내부링 지원(L780-791). 로드 진행바 "행정경계 레이어 로딩 중..." (L696-704).
   - 설치본 `C:\XRayMap\bizgismap_pro\`에는 `KML/` 폴더가 **없음** → 런타임에 받거나(웹모드 상대경로) 누락. (미확인)
3. **하드코딩 시도 코드** (`mods/modAddProvince…/modAddProvince.as:277`): 전국, 서울11, 부산26, 대구27, 인천28, 광주29, 대전30, 울산31, 세종36, 경기41, 강원42, 충북43, 충남44, 전북45, 전남46, 경북47, 경남48, 제주50 (2015 기준; 현재 강원 51, 전북 52로 변경됨 → 웹에서는 신·구 코드 매핑 필요).

### 4.2 modAddProvince (행정구역 주제도)
- 사용자 표(텍스트/붙여넣기: 탭/콤마/파이프) + `행정구역 코드` 컬럼 + `통계 Value` 컬럼 선택 → `RunGetDBAfter("PROVINCE", …, "<값행>##AND##<라벨행>##AND##<코드필드명>##AND##<통계필드명>")` → `MOD_ValueClassification_SetClass2` → KML 조인 단계구분도 (`modAddProvince.as:320-343, 547-636`; `UserGetDataBase.as:644-647`). 비숫자 통계값은 "0" 처리(L596-602). 최대 10000행(L525-529).
- 샘플 양식 다운로드 `http://www.biz-gis.com/XRayMap/Province_2015.xlsx` (L727-734).
- "DB에서 가져오기": 인구/APT/빌라/직장인구/소득/요식업/지형 통계를 `xray_table_행정경계_광역시주제도_etc` / `…시군구주제도_etc` 템플릿 + 클라이언트 조립 WHERE/SELECT(`ROUND(SUM(…))`, `CTY_CD LIKE`)로 조회 (L750-863, L931-987) → **DB 의존, 범위 제외**(웹은 사용자 업로드 데이터만).

### 4.3 modProvinceWhere (행정구역 조건 입력)
- 시도 콤보 → 시군구 콤보(`전체`=-9999 포함) → 목록 누적 (`modProvinceWhere.as:222-252, 282-443`). 콤보 응답 `"이름,코드|…"`, 시도명에서 "특별/광역/자치" 제거 (L309-321).
- 확인 → `SetProvinceWhere(labels, "AND (CTY_CD = … )")` + `addSelectedProvince(codes)` (선택 경계 하이라이트) (L203-220).

---

## 5. 웹 대체 매핑

### 5.1 원본 → 대체 API 매핑표

| 원본 | 웹 프록시 | 업스트림 | 비고 |
|---|---|---|---|
| `daum_poi_search.php` | `GET /api/geocode?q=&mode=auto` (keyword 우선) | Kakao `GET https://dapi.kakao.com/v2/local/search/keyword.json?query=&page=&size=(≤15)` | 응답 `documents[].place_name, address_name, road_address_name, x(lng), y(lat), category_name, phone, place_url` |
| `daum_geocodingForWebXRayMap.php` / `…Search.php` / `…Loop.php` | `GET /api/geocode?q=&mode=address` | Kakao `GET /v2/local/search/address.json?query=&analyze_type=similar|exact&size(≤30)` | `documents[].address_type` (REGION/ROAD/REGION_ADDR/ROAD_ADDR), `x,y`, `address.{b_code,h_code,mountain_yn,main_address_no,sub_address_no,region_*}`, `road_address.{road_name,main_building_no,building_name,zone_no}` |
| geocoding.kr 일괄 (`RunBIZGIS2016Geocoding`) | `POST /api/geocode/batch` | Kakao address.json, 실패 시 keyword.json 폴백 | 서버측 동시성/쿼터 관리, 결과 클래스 매핑(§5.2) |
| `FN_HOUS2ADDRESS(FN_XY2HOUS)` / 우클릭 "주소 획득" | `GET /api/reverse?lon=&lat=` | Kakao `GET /v2/local/geo/coord2address.json?x=&y=` + `GET /v2/local/geo/coord2regioncode.json?x=&y=` | `coord2address` 응답에는 법정동코드가 없으므로 `coord2regioncode`의 `region_type=="B"` `code`(10자리) 사용 |
| `pnu_simple.php` (PNU^주소) | `GET /api/reverse?lon=&lat=` (응답에 `pnu` 포함) | Kakao 위 2개로 PNU 조합: `b_code(10) + (mountain_yn=="Y"?"2":"1") + pad4(main) + pad4(sub)` | 조합 PNU는 "추정 PNU"(카카오 지번 기준). 정확도 요구 시 아래 VWorld 사용 |
| `pnu_total.php` (폴리곤 + 지적정보) | `GET /api/parcel?lon=&lat=` 또는 `?pnu=` | VWorld 데이터 API `GET https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=&domain=&format=json&crs=EPSG:4326&geometry=true&attribute=true&geomFilter=POINT(lon lat)` (PNU면 `attrFilter=pnu:=:<pnu>`) | 응답 `response.status`, `response.result.featureCollection.features[]`(GeoJSON), properties `pnu, addr, jibun, bonbun, bubun, jiga, gosi_year, gosi_month` (필드명 **확인 필요**) |
| (지적정보 줄: 지목/면적/용도지역 등) | `/api/parcel` 응답에 병합 | NSDI/VWorld NED 토지특성: `GET https://api.vworld.kr/ned/data/getLandCharacteristics?pnu=&stdrYear=&format=json&numOfRows=&pageNo=&key=&domain=` | 필드 예 `lndcgrCodeNm(지목), lndpclAr(면적), prposArea1Nm/prposArea2Nm(용도지역), ladUseSittnNm(이용상황), tpgrphHgCodeNm, tpgrphFrmCodeNm, roadSideCodeNm, pblntfPclnd(공시지가), stdrYear` — **엔드포인트·필드명 확인 필요** |
| (공시지가 이력) | `/api/parcel?pnu=&include=price` | NED 개별공시지가 `GET https://api.vworld.kr/ned/data/getIndvdLandPriceAttr?pnu=&stdrYear=&format=json&key=` | **확인 필요** |
| (토지이용계획) | `/api/parcel?pnu=&include=landuse` | NED 토지이용계획 `GET https://api.vworld.kr/ned/data/getLandUseAttr?pnu=&format=json&key=` | **확인 필요** |
| 행정경계 선/면 (`xray_province_*`), KML `MEGA_2015`/`CTY_2015` | `GET /api/regions?level=sido|sigungu|emd&parent=` (목록) / 정적 `/data/regions/{level}.geojson` | 정적 GeoJSON 번들(빌드 시 준비) 권장. 대안: VWorld `data=LT_C_ADSIDO_INFO` / `LT_C_ADSIGG_INFO` / `LT_C_ADEMD_INFO` (props `ctprvn_cd/ctp_kor_nm`, `sig_cd/sig_kor_nm`, `emd_cd/emd_kor_nm`) | VWorld 레이어명·속성명 **확인 필요**. VWorld는 **법정동** 경계, 원본 동경계는 **행정동** → 행정동 경계는 통계청 SGIS 경계 또는 공개 행정동 GeoJSON 필요(**확인 필요**) |
| 점→행정구역 코드 (`UserProvinceSearchByCoord`) | `GET /api/regions/at?lon=&lat=` | Kakao `coord2regioncode.json` (H=행정동, B=법정동, `code` 10자리, 앞 5자리=시군구) | 원본 `CTY_CD`(5자리) = 코드 앞 5자리(단, 2015 vs 현행 코드 차이 매핑 필요) |
| 콤보 (`xray_provincecombo_*`) | `GET /api/regions?level=sido` / `?level=sigungu&parent=11` | 정적 JSON(행정표준코드) | |

공통: 카카오 헤더 `Authorization: KakaoAK {REST_KEY}`, 좌표 `x=lon, y=lat` WGS84 기본(`input_coord`/`output_coord`로 WTM·KTM 등 지정 가능). 키는 **서버 프록시에서만** 보관.

### 5.2 결과 클래스 매핑 (원본 정제구분 → 카카오 판정)

| 웹 `matchType` | 원본 라벨 | 판정 규칙(카카오 address.json) |
|---|---|---|
| `EXACT` | 정좌표 | `analyze_type=exact` 결과 존재 & `address_type ∈ {REGION_ADDR, ROAD_ADDR}` |
| `NEAR` | 인근좌표 | exact 실패, `similar`에서 `REGION_ADDR/ROAD_ADDR` 1건 이상(번지 불일치) |
| `ROAD` | 도로중심좌표 | `address_type == ROAD`(도로명만, 건물번호 없음) |
| `ADMIN_DONG` | 행정동좌표 | `REGION` & `address.region_3depth_h_name` 있고 법정동명 없음 |
| `LEGAL_DONG` | 법정동좌표 | `REGION` & `region_3depth_name` 존재 |
| `SIGUNGU` | 시군구좌표 | `REGION` & `region_2depth_name`까지만 |
| `SIDO` | 광역시좌표 | `REGION` & `region_1depth_name`만 |
| `POI` | (원본 없음, 검색창 POI) | address 0건 → keyword.json 첫 결과 |
| `FAIL` | 정제실패 | 모두 실패. 원본처럼 해상 좌표를 넣지 말고 `lon/lat = null` |

원본 Loop 코드(1=정확, 2=인근지번, 3=행정동 대표, 4=법정동 대표; `modLocationSearch.as:276-298`)는 각각 `EXACT/NEAR/ADMIN_DONG/LEGAL_DONG`에 대응. 표출 필터(정좌표만 / +인근 / 전체)는 클라이언트 옵션 `displayFilter: 'exact'|'exactNear'|'all'`로 유지.

### 5.3 일괄 처리 정책 (웹)
- 원본은 동시성 1·무지연 순차(§2.3). 웹은 서버에서 동시성 제한(예: 4~8)+토큰버킷(예: 초당 10건)+재시도(429/5xx 지수 백오프)+동일 주소 캐시. 카카오 일일 쿼터/초당 제한 수치는 **확인 필요**(앱 등급별 상이).
- 행 수 제한: 원본 공개판 100행(클라이언트 전용 제한). 웹은 서버측 상한(예: 1회 1,000~10,000행, 설정값)으로 강제.
- 키 로테이션으로 쿼터 우회하는 원본 방식(§1.3)은 **재현하지 않음**.
- 입력: CSV/TSV/파이프 텍스트, .xlsx(SheetJS) → 브라우저에서 행 파싱 후 주소 배열만 서버로 전송. 헤더 "주소" 정확일치도 자동 선택(원본 버그 수정).
- 출력 컬럼: 원본 컬럼 + `결과(matchType 한글)`, `지번`(원본은 항상 "생략" → 웹은 카카오 지번주소로 채움), `도로명`, `x`, `y`; 내보내기 좌표계 경위도/TM/KATEC 선택은 proj4로 클라이언트 변환.

### 5.4 TypeScript 타입 (프록시 계약)

```ts
// ---------- 공통 ----------
export type LonLat = { lon: number; lat: number };          // WGS84 (EPSG:4326)
export type ApiError = { error: { code: 'BAD_REQUEST'|'UPSTREAM'|'QUOTA'|'NOT_FOUND'|'INTERNAL'; message: string } };

export type MatchType =
  | 'EXACT'       // 정좌표
  | 'NEAR'        // 인근좌표
  | 'ROAD'        // 도로중심좌표
  | 'ADMIN_DONG'  // 행정동좌표
  | 'LEGAL_DONG'  // 법정동좌표
  | 'SIGUNGU'     // 시군구좌표
  | 'SIDO'        // 광역시좌표
  | 'POI'         // 키워드(POI) 검색 결과
  | 'FAIL';       // 정제실패

export const MATCH_LABEL_KO: Record<MatchType, string> = {
  EXACT: '정좌표', NEAR: '인근좌표', ROAD: '도로중심좌표', ADMIN_DONG: '행정동좌표',
  LEGAL_DONG: '법정동좌표', SIGUNGU: '시군구좌표', SIDO: '광역시좌표', POI: 'POI', FAIL: '정제실패',
};

// ---------- GET /api/geocode?q=...&mode=auto|address|keyword&size=10&lon=&lat= ----------
export interface GeocodeQuery {
  q: string;
  mode?: 'auto' | 'address' | 'keyword';   // auto = 원본 검색창 동작: keyword → (결과 없음) address  ※원본은 POI 우선
  size?: number;                           // address ≤30, keyword ≤15
  near?: LonLat;                           // keyword 정렬용(선택)
}
export interface GeocodeCandidate {
  name: string;               // POI명 또는 주소 (원본 name)
  comment?: string;           // 보조 텍스트: 카테고리/도로명 등 (원본 comment)
  matchType: MatchType;
  position: LonLat;
  jibunAddress?: string;      // address.address_name
  roadAddress?: string;       // road_address.address_name
  bCode?: string;             // 법정동코드 10자리
  hCode?: string;             // 행정동코드 10자리
  pnu?: string;               // b_code + 산여부 + 본번4 + 부번4 (조합, 추정치)
  zoneNo?: string;
  category?: string;          // keyword 결과
  placeUrl?: string;
  source: 'kakao-address' | 'kakao-keyword';
}
export interface GeocodeResponse { query: string; candidates: GeocodeCandidate[] }

// ---------- POST /api/geocode/batch ----------
export interface BatchGeocodeRequest {
  rows: { id: string | number; address: string }[];   // 서버 상한 적용
  fallbackKeyword?: boolean;                           // 주소 실패 시 keyword 시도 (default true)
}
export interface BatchGeocodeRow {
  id: string | number;
  input: string;
  matchType: MatchType;
  position: LonLat | null;    // FAIL이면 null (원본의 해상 더미좌표 사용 안 함)
  jibunAddress?: string;
  roadAddress?: string;
  bCode?: string;
  pnu?: string;
  error?: string;             // 업스트림 오류 메시지(행 단위)
}
export interface BatchGeocodeResponse {
  rows: BatchGeocodeRow[];
  stats: Record<MatchType, number> & { total: number };
}
// 대량은 NDJSON 스트리밍(Content-Type: application/x-ndjson, 행 단위 BatchGeocodeRow) 또는 job+polling 중 택1

// ---------- GET /api/reverse?lon=&lat= ----------
export interface ReverseResponse {
  position: LonLat;
  jibunAddress?: string;          // coord2address.address.address_name
  roadAddress?: string;           // coord2address.road_address.address_name
  buildingName?: string;
  legalDong?: RegionRef;          // coord2regioncode region_type=B
  adminDong?: RegionRef;          // coord2regioncode region_type=H
  pnu?: string;                   // 조합 PNU (추정)
  mountain?: boolean;
  mainNo?: string; subNo?: string;
}
export interface RegionRef {
  code: string;                   // 10자리
  name: string;                   // address_name
  sido: string; sigungu: string; dong: string; ri?: string;
  sigunguCode: string;            // code.slice(0,5)  (원본 CTY_CD 대응)
}

// ---------- GET /api/parcel?pnu=  |  /api/parcel?lon=&lat= ----------
export interface ParcelResponse {
  pnu: string;                    // 19자리
  address: string;                // 지번주소
  jibun?: string;                 // 예 "123-4대"
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;   // EPSG:4326
  // 아래는 NED 토지특성/공시지가/토지이용 (가용 시)
  landCategory?: string;          // 지목 (lndcgrCodeNm)
  areaM2?: number;                // 면적 (lndpclAr)
  officialPrice?: { wonPerM2: number; year: string; month?: string };   // 개별공시지가
  zoning?: string[];              // 용도지역 (prposArea1Nm, prposArea2Nm)
  landUse?: string;               // 이용상황
  terrainHeight?: string; terrainShape?: string; roadSide?: string;
  infoLines: string[];            // 원본 호환: "PNU:…", "지목:…" 형태의 표시용 줄 (클립보드 복사)
  sources: ('vworld-cadastral' | 'vworld-ned-landchar' | 'vworld-ned-price' | 'vworld-ned-landuse')[];
}

// ---------- GET /api/regions?level=sido|sigungu|emd&parent=  ----------
export type RegionLevel = 'sido' | 'sigungu' | 'emd';
export interface RegionListItem { code: string; name: string; level: RegionLevel; parent?: string; legacyCodes?: string[] }
export interface RegionsResponse { level: RegionLevel; items: RegionListItem[] }
// 경계 지오메트리: GET /api/regions/geometry?level=&codes=11,26  → GeoJSON.FeatureCollection (props: code,name,level)
// 점→지역:       GET /api/regions/at?lon=&lat=                  → { legal: RegionRef; admin: RegionRef }
```

### 5.5 좌표계 메모 (proj4)
- GEO(앱 내부 경위도) = WGS84 (`GeoTrans.as:58-59`).
- KATEC (`GeoTrans.as:60-66,88-90`): `+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 +ellps=bessel +towgs84=-146.43,507.89,681.46 +units=m +no_defs`
- TM (`GeoTrans.as:67-73`): lon0=2.2166185948963 rad ≈ 127.00289°(구 중부원점, 10.405″ 보정), lat0=38, k=1, FE=200000, FN=500000, Bessel (+ 같은 datum shift).
- 원본 "TM"/"카텍" 내보내기 및 KATEC 기반 DB 함수 대응 시 위 정의 사용.

---

## 6. 미확인 사항 (Unknowns)

1. `pnu_total.php` 정보 줄(`#^#` 뒤)의 실제 라벨/필드 구성 — 지목·면적·공시지가·용도지역 포함 여부 불명. 실제 응답 캡처 필요.
2. `pnu_simple.php` 응답의 `^` 이후 필드(주소 외 추가 필드 유무).
3. `daum_geocodingFor…Search/Loop.php` 응답 `[0]..[3]` 의미, `daum_poi_search.php`의 `comment` 내용(주소/카테고리?).
4. geocoding.kr 응답 `[2]` 외 필드(`[3]` 이후) 및 정확한 클래스 문자열 집합(`Not Guarantee`가 등장하는 경로, `modGeocoding.as:1663`).
5. `FN_XY2HOUS` 반환 코드 체계(PNU 19자리인지 자체 HOUS ID인지).
6. `xray_province_*` SQL 템플릿 내용과 테이블/좌표 컬럼(서버에서 내려받음, 클라이언트 미포함). 동경계가 행정동인지 법정동인지(라벨명상 행정동으로 추정).
7. `./KML/MEGA_2015.xml`, `CTY_2015.xml` 실제 위치(설치본에 없음) 및 코드 체계(2015 시군구).
8. NSDI/VWorld NED 엔드포인트·필드명(§5.1 "확인 필요" 표시 항목), `LP_PA_CBND_BUBUN` 속성명, `LT_C_AD*` 레이어명, VWorld 키의 `domain` 바인딩 요건.
9. 카카오 로컬 API 일일/초당 쿼터 수치.
10. 행정동 경계 GeoJSON의 공식 출처(SGIS 등) 및 라이선스.

---

## 7. 보안 관찰

- **하드코딩 API 키/식별자**
  - Daum Loop/Search 키 10개(40자리 hex): `modGeocoding.as:1021-1061`, `modHEALTH_Upload.as:1986-2026`, `modLocationSearch.as:305`, `UserSearchLatLngOrAddress.as:215`.
  - Naver 지오코딩 프록시 키 3개: `modGeocoding.as:1343,1348,1353`.
  - VWorld WMS API 키(+domain): `bizgismap_cs.as:1476`.
  - 클라이언트 IP 블랙리스트 `211.236.4.196`: `modGeocoding.as:178`.
- **쿼터 우회 설계**: `-9999`/`Too Many` 응답 시 10개 호스트·키를 순차 전환 (`modGeocoding.as:980-991`) — 웹에서 재현 금지.
- **클라이언트에서 SQL 조립 → `getdb.php?sSQL=`**: `FN_XY2HOUS/FN_HOUS2ADDRESS` (`bizgismap_cs.as:10298`, `modMemoInsert2.as:426,472` 등), `CTY_CD = '…'`/`LIKE '…%'` 문자열 결합(`modProvinceWhere.as:210-214`, `modAddProvince.as:825`, `UserProvinceSearchByCoord.as:209`, `bizgismap_cs.as:4056-4068`), `ROWNUM`, `APT_CLSS`, `ROUND(SUM(…))` 등(`UserAddressList.as:485-580`, `modAddProvince.as:833-845`). 서버가 임의 SQL을 실행하는 구조로 보이며(SQL 인젝션/임의 쿼리 노출) — 웹은 DB 계층 전체 제거.
- **SQL 템플릿 배포**: `getFileList.php` + "Base64.getEncryptDecoding"(난독화)로 SQL 목록을 클라이언트에 내려줌 (`UserSQL.as:89-179`) — 스키마 노출.
- **평문 HTTP 전송**: 모든 엔드포인트 `http://` (bizgis_api*.gislab.co.kr, www.geocoding.kr(:8088/1818), biz-gis.com, bizgis.gislab.co.kr/getdb.php). 위치·주소 데이터 평문 노출, 중간자 변조 가능.
- **난독화를 보안으로 사용**: geocoding.kr 주소 인코딩은 Base64+문자 스왑+역순(가역) (`modGeocoding.as:1251-1263`); 동시에 POST 본문에 원문 `address`도 같이 전송(L1266) → 의미 없음.
- **라이선스/사용량 제한이 클라이언트 전용**: 100행 제한(`modGeocoding.as:684-692`), 관리자 목록 `m_saAddminList` 비교(L671-679), 기업계정 판정(`UserAddressList.as:219-247`) — 우회 용이.
- **crossdomain 정책 로드**: `Security.loadPolicyFile("http://www.geocoding.kr/crossdomain.xml")` 외 3건 (`bizgismap_cs.as:175-178`) — HTTP 정책 파일 신뢰.
- **오류 메시지에 SQL 노출**: `Alert.show(sSQL,"ERROR",…)` (`UserProvinceSearchByCoord.as:246`).
- 웹 재구현 지침: 카카오/VWorld 키는 서버 env에만, 프록시는 HTTPS, 입력 길이·행 수 서버측 검증, 업스트림 응답은 스키마 검증 후 정규화해 전달, 레이트리밋/캐시 서버측 강제, 사용자 업로드 주소는 로그에 남기지 않거나 마스킹.
