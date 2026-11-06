# 10. 지도 코어 (Map Core) 분석

대상: `re/decompiled/main/scripts` (경로는 이 디렉터리 기준, 별도 표기 없으면). 원본 설치본: `C:\XRayMap\bizgismap_pro`.
표기: `파일:라인` 또는 `파일#함수`.

---

## 1. 지도 초기화 / 투영

### 1.1 지도(뷰) 투영과 타일 투영
- `FxMap` 선언 (`bizgismap_cs.as:11678-11694`):
  - `projection = "EPSG:4326"`, `maxExtent = "-180,-90,180,90"`, `center = "126.98307,37.56965"`
  - **`scaleY = 1.25`**, `scaleX = 1` (`bizgismap_cs.as:11692-11693`)
  - 자식: `FxKeyboardHandler`, `FxDragHandler`, `FxWheelHandler`, `FxClickHandler`, `ScaleLine`, `FxSelectFeaturesHandler`(비활성), `LayerManager`(숨김), `MeasurePath`, `MeasureSurface` (`:11694`)
- 배경 타일 레이어(`org/openscales/core/layer/osm/VWorld.as:43-51`)는 `EPSG:900913`(=EPSG:3857), 21단계 해상도 `generateResolutions(21, 156543.0339)`, maxExtent `±20037508.34`, tileOrigin = 좌상단(-20037508.34, 20037508.34), 256px.
- 즉 **지도는 경위도(EPSG:4326) 평면에 메르카토르 타일을 늘려서(stretch) 표시**한다. OpenScales `Grid.as:228` 에서 `ProjProjection.isStretchable(layer, map)` 이면 타일 bounds 를 맵 투영으로 재투영해 비율을 늘려 그린다. 여기에 컨테이너 `scaleY=1.25`(≈ 1/cos(37.5°)=1.26)를 줘서 한국 위도대에서 경위도 평면이 대략 정각(conformal)으로 보이도록 보정한 것으로 판단됨. (추정 — 아래 "모르는 것" 참고)
- 모든 앱 내부 좌표(Location/LatLng)는 **경도/위도(WGS84 degree)** 이다 (`com/CMT/UserControlFun.as#getLocationByLatLng` :1626 → `new Location(lng, lat)`).
- 웹 포팅에서는 그냥 **EPSG:3857 뷰 + 데이터는 EPSG:4326** 으로 처리하면 된다 (원래 의도와 시각적으로 동일하고 더 정확).

### 1.2 줌 ↔ 해상도
- `UserControlFun.as#get_bing_resolution` (:1404): `res_m = 10^((22 - 4.7438 - z) * log10(4) / 2)` = `2^(17.2562 - z)` → z0=156543.057, z15=4.7773, z18=0.5972, z20=0.14929. **표준 WebMercator 줌과 동일** (오차 <1e-6). 하한 0.1492910930898944(z20), 상한 156543.
- `setZoom(z)` (:1341): `floor`, `MINZOOM=19`(:40) 초과면 19로, 1 미만이면 1로 클램프 → `map.resolution = Resolution(res_m, "EPSG:900913")`.
- `getZoom()` (:1355): `round(get_zoom_from_bing_resolution(map.resolution.value) )` — 맵 해상도(도 단위)에서 역산 후 `-17` 보정. 결과적으로 표준 z.
- 초기화 (`bizgismap_cs.as:1374-1378`):
  - `map.defaultZoomInFactor = 0.5`, `defaultZoomOutFactor = 2` (1단계씩)
  - `setMaxZoom(2)` → `maxResolution` = z2 해상도(가장 축소), `setMinZoom(19)` → `minResolution` = z19 (가장 확대). (이름이 반대로 붙어있음)
  - **`setCenter(LatLng(37.56965, 126.98307), 15)`** — 서울 시청 부근, z15.
  - `getMaxZoom()` → **18** 고정 (`bizgismap_cs.as:9841`); VWorld 레이어 생성 시 참조 (`VWorld.as:56`).
- 이후 서버 `set.ini` 로딩 후 `InitMapBySetFile()`(`com/seld/draw/UserInit.as:2299-2313`)에서 `setCenter(LatLng(m_fLat, m_fLng), m_nZoom)` 으로 덮어씀. 값은 `set.ini` 2~4행(`UserInit.as#LoadXRayMapBaseInfo` :543-545) — **서버 파일이라 값 미확인**. 웹판은 정적 config 로 대체(기본값 37.56965/126.98307/15 권장).
- 더블클릭 줌: `UserControlFun.as#mouseMapDownHandler` :1693 → `twoClicks` → `map.zoomIn(px)`; 그리기/측정 모드에서는 `StopDoubleClickZoom()` 로 비활성 (`modTOC.as#SetMouseMode`).
- 측정 모드에서 더블클릭 = 측정 종료 (`bizgismap_cs.as#onMapDoubleClicked` :1396-1418).

### 1.3 좌표계 변환 (`com/seld/draw/GeoTrans.as`)
자체 구현 TM 정·역변환 + 3-파라미터 Molodensky 대신 지심좌표 경유 변환. 상수(`GeoTrans()` :50-90, 라디안→도 환산 포함):

| 상수 | 타원체 a / b | lat_0 | lon_0 | k | x_0 | y_0 | datum |
|---|---|---|---|---|---|---|---|
| `GEO`(0) | 6378137 / 6356752.3142 | – | – | – | – | – | WGS84 |
| `KATEC`(1) | 6377397.155 / 6356078.963342249 (Bessel) | 38 | 128 | 0.9999 | 400000 | 600000 | Bessel+towgs84 |
| `TM`(2) | Bessel | 38 | **127.002890277777** (127°00'10.405") | 1.0 | 200000 | 500000 | Bessel+towgs84 |
| `GRS80`(3) | 6378137 / 6356752.3141 | 38 | 127 | 1.0 | 200000 | **600000** (GEO2GRS) / 500000 (GEO2GRS_OLD) | 없음 |
| `UTMK`(4) | 6378137 / 6356752.314140356 | 38 | 127.5 | 0.9996 | 1000000 | 2000000 | 없음 |

- datum shift (Bessel→WGS84, 지심 XYZ 가산): `towgs84 = -146.43, 507.89, 681.46` (`GeoTrans.as:88-90`, `geocentric_to_wgs84` :541). GRS80/UTMK/GEO 간에는 shift 없음 (`transform` :391).
- `AD_C = 1.0026` (Bowring 역변환, :48/509).
- 앱 래퍼 (`bizgismap_cs.as:9910-10020`): `GEO2KA`, `KA2GEO`, `GEO2TM`, `TM2GEO`, `GEO2UTM`, `UTM2GEO`, `GEO2GRS`, `GRS2GEO`, `GEO2GRS_OLD`, `GRS_OLD2GEO`.
- **TM 경험식 보정** (`bizgismap_cs.as:911-917`, `getTM_X_byKTM`/`getTM_Y_byKTM` :9924-9936, 역 `getKTM_*_byTM` :9910-9922):
  ```
  a1 = -0.000014723386563, a2 = 0.000013912266726
  b1 = 5.223810949,        b2 = -7.734590529
  GEO2TM:  X = x + (-6e-6*x + a1*y + b1);  Y = y + (-6e-6*y + a2*x + b2)
  TM2GEO:  x = X - (-6e-6*X + a1*Y + b1);  y = Y - (-6e-6*Y + a2*X + b2)   (이후 TM→GEO)
  ```
  (GeoTrans 의 TM 결과를 수 m 단위로 보정하는 1차 affine. 보정량 ≈ +5 m / −8 m 수준.)
- 사용처: 지도 우클릭 "좌표 획득" (`bizgismap_cs.as#menuClickForMap` :10207-10243) → 경위도/TM/카텍/UTMK(정수 m) + Zoom 을 Alert 및 클립보드 복사. `UserControlFun.as#GetConvertCoordString` :423 (입력 좌표계 "KA"/"UTM"/"TM"/"GRS"/"GRS_OLD" → GEO). 면적은 KATEC 평면으로 변환 후 계산 (`UserControlFun.as#getAreaByPolygon` :298, `GEOPoly2KAPoly` :313).
- 거리(GeoTrans): `getDistancebyGeo` 하버사인, 지구반경 6376.5 km (`GeoTrans.as:355-365`).

### 1.4 `lib\defs\*.js` (설치본)
`js_func.html:31-33` 에서 `lib/geocent.js`, `lib/tmerc.js`, `lib/cscs.js` 는 로드되지만 **`lib/defs/*.js` 는 로드되지 않고**, AS 코드에서 `csList`/cscs 호출도 없음 (`domWindow.*` 호출 목록: `GetBufferCoord`, `GetColorRampString`, `GetDataClassification*`, `GetSpreadCoordByCNT*`, `SetMBR`, `SetStatus` 뿐). 즉 **잔재 파일**. 참고용 값 (한국 관련만):
- `KOREA_CENTER_TM_3param.js`: `+proj=tmerc +lat_0=38 +lon_0=127.0028902777777777776 +x_0=200000 +y_0=500000 +k=1.0 +a=6377397.155 +b=6356078.9633422494 +towgs84=-146.43,507.89,681.46,0,0,0,0` (원본에 `+lon_0=+lon_0=` 오타 있음)
- `TM128_katech_3param.js`: `+proj=tmerc +lat_0=38 +lon_0=128 +x_0=400000 +y_0=600000 +k=0.9999 +a=6377397.155 +b=6356078.9633422494 +towgs84=-146.43,507.89,681.46,0,0,0,0`
- `TM128_katech_7param.js`: 동일하나 `+k=1.0 +towgs84=-145.90,505.03,685.75,-1.162,2.347,1.592,6.342` (k 가 1.0 인 점 주의 — GeoTrans 의 0.9999 와 다름)
- `UTM_K.js`: `+proj=tmerc +lat_0=38 +lon_0=127.5 +x_0=1000000 +y_0=2000000 +k=0.9996 +ellps=WGS84` (= EPSG:5179)
- 나머지(EPSG102757/102758/26591/26912/4139/4181/4302, GOOGLE_WGS84)는 한국과 무관한 cscs 샘플.

---

## 2. 배경지도 (Base map)

### 2.1 레이어 클래스 `org/openscales/core/layer/osm/VWorld.as` (앱이 수정한 TMS 서브클래스)
- `getURL(bounds)` (:132-215): `z`=표준 줌, `x`,`y`=XYZ(좌상단 원점) → **`{url}/{z}/{x}/{y}.{ext}`** (x 다음 y 순서).
- 분기 (`m_nType` = `setVWorldOrOstOrGoogleMode`, `m_bPng` = `setPngMode`):
  - type 1, png: `url + /z/x/y.png`; 단 **z<6 이면 `https://c.tile.openstreetmap.org`** 로 대체 (:150-153)
  - type 1, jpeg: `url + /z/x/y.jpeg`; z<6 이면 OSM (:161-172) — OSM 은 .jpeg 가 없으므로 사실상 버그
  - type 2/3: URL 무시하고 **`http://a.tile.openstreetmap.org/z/x/y.png|.jpeg`** 고정 (:174-213)
- 범위 밖 타일은 `icon/404.png` (`OSM.MISSING_TILE_URL`).
- 줌 시작 시 레이어 폭이 맵 3배 초과면 숨겼다가 100ms 타이머로 복원 (깜박임 방지, :71-130).
- attribution: `DataOriginator("OpenStreetMap","http://www.biz-gis.com","http://www.biz-gis.com/image/vw.png")` (:22).
- 지도 우하단 로고 이미지: `imgVW`(visible, 내장 `icon_vw.png`), `imgNaver`(hidden), `imgSDMP_Molit`(hidden), CI 이미지 `http://www.biz-gis.com/image/ci2.png`(hidden) (`bizgismap_cs.as:11755-11805`).

### 2.2 배경지도 URL
- 실제 URL 3종은 서버 `set.ini` 8번째 줄 `m_sURL|BaseMapURL|BaseMapURL2|BaseMapURL3` (`UserInit.as:565-568`) — **코드에 하드코딩 없음**.
- 유일한 단서: 응답 체크용 프로브 URL `http://xdworld.vworld.kr:8080/2d/Base/service/14/13975/6344.png` (`bizgismap_cs.as:1622`, `setBaseMapType`). → 구 VWorld XDWorld 2D 타일 서비스. 추정값:
  - `m_sBaseMapURL`  = `http://xdworld.vworld.kr:8080/2d/Base/service` (png, 일반)
  - `m_sBaseMapURL2` = `http://xdworld.vworld.kr:8080/2d/Satellite/service` (jpeg, 영상)
  - `m_sBaseMapURL3` = `http://xdworld.vworld.kr:8080/2d/Hybrid/service` (png, 하이브리드 오버레이)
  (Base 만 코드로 확인, 나머지 2개는 png/jpeg 분기 로직과 VWorld 서비스 명명 규칙으로부터의 **추정**.)
- 이 구 엔드포인트는 현재 폐지됨. 웹판은 VWorld WMTS: `https://api.vworld.kr/req/wmts/1.0.0/{KEY}/{Base|Satellite|Hybrid|white|midnight}/{z}/{y}/{x}.{png|jpeg}` (**y/x 순서 주의**, 원본은 x/y) 사용 권장, 키는 프록시로 보호.

### 2.3 배경지도 전환 로직 (`bizgismap_cs.as`)
- `setBaseMapType(nType)` (:1563-1631): 15초 타이머 + `http://www.biz-gis.com/XRayMap/LicenseCheck.php?url=<프로브타일>` 요청. 성공 → `setBaseMapType2(nType)`; 실패/타임아웃 → `changeBaseMap` (:1633) 이 "국토부 배경지도 서버의 응답이 느립니다. OSM 으로 변경?" 확인창 → 예 → 세 URL 모두 `https://c.tile.openstreetmap.org`, `m_bGoogleMapMode=true` (→ type 3 = OSM).
- `setBaseMapType2(nType)` (:1666-1731):
  - 1 = 일반: `m_oBaseMap.url = BaseMapURL`, png
  - 2 = 영상: `url = BaseMapURL2`, jpeg
  - 3 = 하이브리드: `m_oBaseMap.url = BaseMapURL2`(jpeg) + 두번째 레이어 `m_oBaseMap2 = VWorld(..., "VWorldMap2", BaseMapURL3)`(png, 기본 m_bPng=true) 를 인덱스 1 에 추가
  - 레이어 이름: `"_#BOTTOM#_VWorldMap"`, `"_#BOTTOM#_VWorldMap2"`; 생성 시 기본 필터 = `getColorMatrixFilter(1)` (회색조) (:1694); `proxy = m_sLicenseCheck` (릴리즈 모드에서 `"LicenseCheck.php?url="`, :1363-1370) → **모든 타일이 biz-gis 서버 프록시 경유** (웹판: 제외).
- 메뉴 (메인 메뉴 XML 은 서버 파일, 라벨 미확인; 코드값만) `UserInit.as#mainMenuClick` :1814-1880:
  - `5-1-4` → `setBaseMapType(2)` (영상), `5-1-5` → `setBaseMapType(1)` (일반), `5-1-6` → `setBaseMapType(3)` (하이브리드); `5-1-1..3` 은 no-op
  - `5-2-1`→색상 3, `5-2-2`→4, `5-2-3`→1, `5-2-4`→2, `5-2-5`→1, `5-2-9`→9
  - `5-3-1` → `setBaseMapVWorldOrOstOrGoogle(1)` (VWorld), `5-3-2` → `(2)` (OSM)
  - `5-4-1..3` → `setBaseMapMask(1..3)`
  - 초기값: `set.ini` 14번째 줄 `mapType|colorType` (`UserInit.as:547-555`) → `setBaseMapType`, `setBaseMapColor` (:570-571).

### 2.4 배경지도 색상 필터 (`bizgismap_cs.as#getColorMatrixFilter` :1765-1795) — Flash 4x5 ColorMatrix
- 1 (회색조): `[0.31231,0.51799,0.0697,0,0, 0.26231,0.56799,0.0697,0,0, 0.26231,0.51799,0.1197,0,0, 0,0,0,1,0]`
- 2 (밝은/색감 유지 저채도): `[0.66231,0.51799,0.0697,0,0, 0.26231,0.91799,0.0697,0,0, 0.26231,0.51799,0.4697,0,0, 0,0,0,1,0]`
- 3 (원본): 단위행렬
- 4 (밝게): `[1.12,0,0,0,14.78, 0,1.12,0,0,14.78, 0,0,1.12,0,14.78, 0,0,0,1,0]`
- 9 (배경 숨김): 알파행 0 → 완전 투명
- `setBaseMapColor(0)` 은 무시 (:1752).

### 2.5 배경 마스크 (`setBaseMapMask` → `com/seld/draw/UserDrawProvinceBoundary.as#setModeColor` :74-110)
선택한 행정구역 바깥을 덮는 스프라이트: 1 = 검정 alpha 0.5, 2 = 검정 alpha 1, 3 = 흰색 alpha 1. 선택 폴리곤 영역은 `BlendMode.ERASE` 로 구멍.

### 2.6 Naver / Daum / Google / Bing
- Naver: 로고 이미지만 존재(`imgNaver`, hidden). Naver 타일 레이어 없음. (Naver 지오코딩은 모듈 `modGeocoding` — 다른 담당 영역)
- Daum: 로드뷰 외부 페이지만 (§5). Daum 타일 없음.
- Google: `m_bGoogleMapMode` 플래그/`setVWorldOrOstOrGoogleMode` 이름뿐, 실제로는 OSM URL 사용. Bing: 해상도 함수 이름(`get_bing_resolution`)뿐.

---

## 3. WMS/WFS 오버레이

### 3.1 VWorld WMS (지적도·용도지역) — `bizgismap_cs.as#AddPolyLayer(n)` :1462-1552
- URL: `http://map.vworld.kr/js/wms.do?APIKEY=10CF5698-511B-3812-92EB-CD2EBDC39CE7&DOMAIN=http://www.biz-gis.com` (:1476)
- OpenScales `WMS` 레이어, 이름 `"_#BOTTOM#_VWorldLayer"`, `version 1.3.0`, `tiled=true`, `proxy = LicenseCheck.php?url=`; 배경 바로 위(인덱스 1, 하이브리드면 2)에 삽입. `LAYERS`와 `STYLES`에 같은 값(소문자) 지정.
- n=1(지적도)일 때 줌 <15 면 15로 강제 줌 + "현재 화면에서는 지적도를 활성화활 수 없어 줌인하였습니다." 알림.
- n=10 분기: version 1.1.1, image/png, transparent, 256x256, alpha 0.75 (TOC 에 버튼 없음 — 호출처 미확인). 그 외 alpha 1.
- 하나의 WMS 레이어를 재사용하며 `layers` 만 교체 (한번에 하나만 표시).
- 2~9번은 클릭 시 범례 이미지 표시 (`modTOC.as#btnPolyLayer_clickHandler` :6870 → `MOD_Legend_SetLegendByImage(n)`).

| n | TOC 라벨 (`modTOC.as` `_modTOC_LabelNN_c` :10117-10270) | VWorld layer (lowercase로 전송) |
|---|---|---|
| 1 | 지적도 — 지적경계와 지번 | `lp_pa_cbnd_bonbun,lp_pa_cbnd_bubun` |
| 2 | 용도지역도 — 도시지역 | `lt_c_uq111` |
| 3 | 용도지역도 — 관리지역 | `lt_c_uq112` |
| 4 | 용도지역도 — 농림지역 | `lt_c_uq113` |
| 5 | 용도지역도 — 보전지역 (자연환경보전지역) | `lt_c_uq114` |
| 6 | 용도구역도 — 국토계획구역 | `lt_c_uq141` |
| 7 | 용도구역도 — 도시자연공원구역 | `lt_c_uq162` |
| 8 | 용도구역도 — 개발제한구역 | `lt_c_ud801` |
| 9 | 토지이용계획도 | `lt_c_lhblpn` |

- 현재 VWorld WMS 엔드포인트: `https://api.vworld.kr/req/wms?service=WMS&request=GetMap&version=1.3.0&layers=...&styles=...&crs=EPSG:3857&format=image/png&transparent=true&key={KEY}&domain={DOMAIN}` 로 대체 (구 `map.vworld.kr/js/wms.do` 는 폐지).

### 3.2 행정경계 (시도/시군구/읍면동)
- WMS 가 아니라 **자체 DB SQL** 로 경계선 문자열을 받아 벡터로 그림: `com/seld/draw/UserProvince.as#CreateDoBoundary` :167-240 (`objSQL.GetSQL("xray_province_도경계_etc", bounds*1.5)` → `m_sURL/m_sASP_DB` POST → `lng^lat,...|...` 문자열 → `LineStringFeature`, alpha 0.4). Si/Dong 도 동일 패턴. 라벨: `RunDispalyLabel("xray_provincelabel_광역시 라벨_etc" | "...시군구 라벨_etc" | "...행정동 라벨_etc")`.
- TOC 기본값 (`modTOC.as#CallClickShow*Province` :1801-1838): 선 두께 시도 3 / 시군구 2 / 읍면동 1, 라벨 크기 10, 색상/체크 각각 컬러피커. "중첩 모드"(`chkProvinceOverlay`) 미체크면 기존 경계 제거 후 그림. 현재 화면 extent 기준(±25% 확장).
- DB API 는 범위 밖 → 웹판: VWorld WFS(`lt_c_adsido_info`, `lt_c_adsigg_info`, `lt_c_ademd_info`) 또는 정적 GeoJSON/벡터타일로 대체.

### 3.3 기타
- WFS/WMTS 사용 없음. "기본 POI" 패널(`modTOC.as#initBaseLayer` :3673, `setBasePointLayer.ini`)은 서버 DB 기반 POI 레이어 → 범위 밖.

---

## 4. TOC / 레이어 관리 (`module/modTOC.as`)

### 4.1 상단 툴바 (아이콘 버튼, `modTOC.as:10460-10740`, 핸들러 `SetMouseMode` :846-974)
| 버튼 id | toolTip | 동작 | 모드 |
|---|---|---|---|
| `btnRefresh` | 리플레시 | 측정 해제, `MEASURE_LABEL`·측정도형·핫스팟 제거, 기본 레이어 강제 재그리기 (`CallBtnRefresh` :4302) | – |
| `btnGoBack` | 이전 화면으로 이동 | 뷰 히스토리 스택 pop (`CallBtnGoBack` :6457) | – |
| `btnGoNext` | 다음 화면으로 이동 | redo 스택 (`CallBtnGoNext` :6477) | – |
| `btnZoomIn` | Zoom In | `map.zoomIn()` (:4312) | – |
| `btnZoomOut` | Zoom Out | `map.zoomOut()` (:4317) | – |
| `btnMapDragMode` | 일반모드 | 팬 모드, 그리기/박스줌 해제 | 1 |
| `btnDragZoomIn` | Drag ZoomIn | 드래그 박스 줌인 (클릭만 하면 1단계 줌인) | 2 |
| `btnDragZoomOut` | Drag ZoomOut | 드래그 박스 줌아웃 | 3 |
| `btnPolyMode` | 다각형 그리기 | `objUserCreateArea.StartDrawPolygon()` | 4 |
| `btnCircleMode` | 원 그리기 | `StartDrawCircle()`; 클릭 시 반경 버퍼 생성 (`onMapMouseDown` :6240) | 5 |
| `btnMeasureLineMode` | 거리 계산 | OpenScales `MeasurePath` 활성 | 9 |
| `btnMeasureAreaMode` | 면적 계산 | `MeasureSurface` 활성 | 10 |
| `btnDT` | 차량이동거리 | 이동거리 분석 모드 (TOC 아코디언 0번으로) | 12 |
| `btnUserInfo` | 사용자 정보 입력 | 클릭 위치에 메모 등록 (회사별 분기, DB 저장 → 범위 밖) | 6 |
| `btnLoadView` | Daum 로드뷰 | 클릭 위치로 로드뷰 새 창 (§5) | 7 |
| (버튼 없음) | – | `CallBtn3DMapView` → 모드 8: 클릭 위치로 `3D.html` 새 창 (호출처 없음, 사실상 미사용) | 8 |
- 뷰 히스토리: `onMapRealMoveEnd` (:6164-6205) 에서 이동 종료마다 `{oCenter, nZoom}` push, redo 스택 초기화. GoBack/Next 로 이동 시 저장 생략(`m_bExtentSaveMode=false`).
- 상태표시: `app.txtFuncInfo.text` 에 "Map Pan Mode" / "Map ZoomIn Mode" / ... 표시.
- 커서: 모드별 커스텀 커서 (`UserInit.as#onMapMouseMove` :2653, `UserInit_UserCursorN`).

### 4.2 TOC 좌측 패널 (아코디언 `accTOC`)
- 상단: `btnDeleteAll` "모든 레이어와 지도 초기화" (`__btnDeleteAll_click` :8965 → `CallBtnAllErase`), 분석영역 라디오 "현재화면"/"행정구역 조건" (`radioAreaMode1/2`, :7019-7049 → `CallBtnAreaMode1/2` :4348/4358).
- 패널 1 "사용자 분석 결과 Layer" (:7148): `dgLayerList` (분석 레이어 목록, `m_oTOCAnalysisLayerList` 항목: `flag`(on/off), `Type`(Density/Cell/…), `Ect`(색상표/범례 문자열)). 버튼: Add Layer(파일 열기 `RunBtnAddLayer`), Remove All, SMS/메일 공유, 애니메이션 재생(`btnLayerPlay`). 행 선택 시 범례 표시(`onClickedUserLayerDataGrid` :4533).
  - 우클릭 메뉴 `MouseRightMenuForTOC` (`bizgismap_cs.as:11056`): 속성 테이블 열기 / 반경 분석 / 수치추정(보간법) 분석 / 밀집도 분석 / 행정구역 통계 분석 / 색상 및 심볼 변경 / 색상 및 심볼 스크립트 복사·적용 / 라벨 변경 / 레이어가 보여지도록 지도 이동 / ↑ 한단계 올리기(`UpStepLayer` :4645) / ↓ 내리기(`DownStepLayer` :4668) / 레이어 삭제 / 레이어 파일로 저장 / 웹링크 URL 취득 / KML로 저장 / 이름 바꾸기.
- 패널 2 "행정경계" (:7327): 시도/시군구/읍면동 경계 행 (선색·두께, 라벨색·크기, 표시 체크) + 표시 버튼 + "중첩 모드" 체크 + 사용자 라인 3개(`chkUserLine1..3`).
- 패널 3 "지적도 및 국가공간정보" (:8014): `btnPolyLayer1..9` (§3.1 표).
- 패널 4 "기본 POI" (:8859): 서버 POI 레이어 목록 + Check All / Uncheck All (`selectAllBaseLayer_clickHandler` :6756 / `deselectAll...` :6734).
- TOC 열기/닫기: `btnTOCOpen/Close` → `setFullSize` (:645).

### 4.3 레이어 스택 규칙 (`com/CMT/UserOPSTOC.as`)
레이어 identifier 앞 10자 접두사로 자동 정렬 (`getAddBestLayerIndex` :283, `setBestLayerOrder` :396). 위→아래:
`_#MAPTOP#_` > `_#POINTS#_` > `_#-LINE-#_` > `_#-POLY-#_` > `_#-AREA-#_` > `_#RASTER#_` > `_#BOTTOM#_` (배경·WMS). `_#-TEMP-#_` 는 임시.
OpenScales 기본 `LayerManager`(`ctlLayerManager`)는 `visible=false` (`bizgismap_cs.as:12041`) — 실제 UI 는 modTOC.

---

## 5. 지도 컨트롤

| 기능 | 원본 | 상세 |
|---|---|---|
| 드래그 팬 | `FxDragHandler` (`bizgismap_cs.as:11961`) | 그리기/측정/박스줌 모드에서 `dragHandler.handler.active=false` |
| 휠 줌 | `FxWheelHandler` (:11975) | |
| 키보드 | `FxKeyboardHandler` (:11947) | |
| 더블클릭 줌인 | `UserControlFun#mouseMapDownHandler` :1693 | 그리기 모드에서 비활성 |
| 줌 버튼 | `modTOC` btnZoomIn/Out | 1단계 |
| 박스 줌 인/아웃 | `com/seld/draw/UserBoxZoom.as` | 드래그 bbox 에 fit (`setCenterByBound`); 줌아웃은 현재 extent 를 (현재−박스)/2 만큼 확장 (:134-168); 단순 클릭이면 zoomIn/zoomOut |
| 축척막대 | `ScaleLine` left 70, bottom 2, width 70 (:12003) | |
| 거리 측정 | OpenScales `MeasurePath`, `displaySystem="km"` (:1380) | 측지(geodesic) 길이 /1000, 소수 2자리 절사(`Distance.as#getMeasure`); 클릭 지점마다 누적 거리 라벨 (`onMeasure` :1421); 더블클릭 종료 시 빨강(255) 2px alpha 0.4 선 남김 (`addMeasureLineonMap` :3374) |
| 면적 측정 | `MeasureSurface`, "km" | geodesicArea /1e6 → `km²` (`Surface.as#getMeasure`); 종료 시 폴리곤(채움 255 alpha 0.2, 선 alpha 0.7, 2px) (`addMeasurePolyonMap` :3350) |
| 좌표 획득 | 지도 우클릭 메뉴 "좌표 획득" (`bizgismap_cs.as:11038`, `menuClickForMap` :10207) | 경위도/TM/카텍/UTMK + Zoom 표시·복사 |
| 주소 획득 | 우클릭 "주소 획득" (index 1) | 역지오코딩 → 지오코딩 담당 영역; 우클릭 시 `addPnuPolygon` 으로 필지 폴리곤 하이라이트 (:1134) |
| 로드뷰 | 모드 7, `modTOC.as:6313-6328` | `URL_Return.GetRoadViewUrl()` = `http://www.biz-gis.com/XRayMap/daum_loadview.html` (`URL_Return.as:194-203`), **POST** `sLat`, `sLng` → `navigateToURL(_blank)`. 1회 후 이전 모드 복귀 |
| 3D | 모드 8, `modTOC.as:6330-6345` | `URL_Return.Get3DUrl()` = `http://www.biz-gis.com/XRayMap/3D.html` (릴리즈: `getUrl(2)+"/3D.html"`), POST `sLat`,`sLng`; 툴바 버튼 없음 |
| 지도 MBR 통지 | `htmlForJS.domWindow.SetMBR(sw, ne)` (`UserInit.as:2312`) | HTML 래퍼 상태용 — 웹판 불필요 |
| 줌 중 배경 숨김 | `UserControlFun#setCenterByLocation` :1457 | 2단계 이상 줌인 시 배경 숨기고 100ms 후 redraw — 웹판 불필요 |

---

## 6. OpenLayers port notes

| 원본 | OL / proj4 구성 |
|---|---|
| 뷰 투영 4326 + 메르카토르 타일 stretch + scaleY 1.25 | `new View({ projection: 'EPSG:3857', center: fromLonLat([126.98307, 37.56965]), zoom: 15, minZoom: 2, maxZoom: 19 })` (스트레치/scaleY 재현 불필요). `constrainResolution: true`(정수 줌). |
| 줌 1단계 (factor 0.5/2) | `zoomDelta: 1`, `defaults({zoomDelta:1})`, `MouseWheelZoom` 기본 |
| 데이터 좌표 = 경위도 | 피처는 `EPSG:4326` 으로 보관, 읽을 때 `featureProjection: 'EPSG:3857'` |
| GeoTrans KATEC | `proj4.defs('KATEC','+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 +ellps=bessel +towgs84=-146.43,507.89,681.46,0,0,0,0 +units=m +no_defs')` |
| GeoTrans TM (Bessel, 10.405" 보정) | `proj4.defs('TM_BESSEL_MID','+proj=tmerc +lat_0=38 +lon_0=127.002890277777 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-146.43,507.89,681.46,0,0,0,0 +units=m +no_defs')` + §1.3 affine 보정 함수 별도 구현(GEO2TM 후 가산, TM2GEO 전 감산) |
| GeoTrans GRS80 (FN 600000) | `EPSG:5186`: `+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs` |
| GeoTrans GRS80_OLD (FN 500000) | `EPSG:5181`: 위와 동일, `+y_0=500000` |
| GeoTrans UTMK | `EPSG:5179`: `+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs` |
| 등록 | `import { register } from 'ol/proj/proj4'; register(proj4);` |
| VWorld 배경 (일반/영상/하이브리드) | `TileLayer` + `XYZ({ url: '/proxy/vworld/wmts/{layer}/{z}/{y}/{x}.{ext}' })`; Base=png, Satellite=jpeg, Hybrid=png 를 Satellite 위에 2번째 `TileLayer`. z<6 OSM 대체 로직은 생략 가능(VWorld z6~19 지원; 그 이하 필요시 `minZoom` 으로 OSM 레이어 병용). |
| OSM 대체 | `new OSM()` (https 타일). 배경 서버 응답 실패 시(타일 `tileloaderror` 다수 발생) OSM 전환 확인창 재현 가능 |
| 배경 색상 필터 1/2/4/9 | 캔버스 `prerender/postrender` 에서 `ctx.filter`(grayscale 등) 또는 `layer.on('postrender')` 에서 ImageData 에 4x5 행렬 적용; 간단히 CSS `filter: grayscale(...)`를 레이어 `className` 으로 지정 (`new TileLayer({className:'bm-gray'})`). 9 = `setVisible(false)` / opacity 0 |
| 배경 마스크 1/2/3 | 벡터 레이어: 세계 bbox 폴리곤에서 선택 행정구역을 hole 로 뺀 폴리곤, fill 검정 0.5 / 검정 1 / 흰색 1 |
| VWorld WMS 지적/용도지역 | 단일 `TileLayer` + `TileWMS({ url: '/proxy/vworld/wms', params: { LAYERS, STYLES: LAYERS, VERSION:'1.3.0', FORMAT:'image/png', TRANSPARENT:true, CRS:'EPSG:3857' } })`; 레이어 교체는 `source.updateParams({LAYERS, STYLES})`; 지적도는 `minZoom: 15` + 줌 강제 |
| 행정경계 (DB) | `VectorLayer` + VWorld WFS(GetFeature, `lt_c_adsido_info` 등) 또는 정적 GeoJSON/PMTiles. 스타일: `Stroke({width:3/2/1, color})`, `Text` 라벨 크기 10 |
| 레이어 접두사 순서 | `zIndex`: BOTTOM 0, RASTER 10, AREA 20, POLY 30, LINE 40, POINT 50, MAPTOP 60 |
| 팬/휠/키보드/더블클릭 | `ol/interaction/defaults` (DragPan, MouseWheelZoom, KeyboardPan/Zoom, DoubleClickZoom). 그리기/측정 모드에서 DoubleClickZoom·DragPan `setActive(false)` |
| 박스 줌 인 | `DragZoom({ condition: always, out: false })` (모드 2일 때만 활성) |
| 박스 줌 아웃 | `DragZoom({ out: true })` (원본 공식과 유사) |
| 축척막대 | `ScaleLine({ units: 'metric' })` 좌하단 |
| 거리/면적 측정 | `Draw({type:'LineString'|'Polygon'})` + `ol/sphere` `getLength`/`getArea` (geodesic) → km / km², 소수 2자리 절사; 꼭짓점마다 누적 `Overlay` 라벨; 더블클릭 종료 |
| 뷰 히스토리 | `map.on('moveend')` 에서 `{center, zoom}` 스택, 뒤로/앞으로 버튼 |
| 좌표 획득 | `contextmenu` 이벤트 → `toLonLat` → proj4 로 KATEC/TM(+보정)/UTMK 변환 → 모달 + `navigator.clipboard.writeText` |
| 로드뷰 | 클릭 좌표로 Kakao Map JS SDK `RoadviewClient.getNearestPanoId` + `Roadview` 를 앱 내 패널에 띄우거나 `https://map.kakao.com/link/roadview/{lat},{lng}` 새 창 (biz-gis 페이지 대체) |
| 3D | 미사용 → 제외 (필요 시 VWorld 3D 링크) |

---

## 7. 모르는 것 (Unknowns)
1. `set.ini` 실제 내용 — 초기 위경도/줌(2~4행), 배경지도 URL 3종(8행), mapType|colorType(14행). 서버 파일이라 디컴파일본/설치본에 없음. Satellite/Hybrid URL 은 추정.
2. 메인 메뉴 XML(`m_sMenuXmlPath`, 서버) — 메뉴 코드 `5-1-x`, `5-2-x`, `5-3-x`, `5-4-x` 의 화면 라벨 미확인.
3. `scaleY=1.25` 의 정확한 의도 — 코드 주석 없음. 부모 스케일(`m_fgScaleX/Y`, `bizgismap_cs.as:1355-1362`, `map.onSetScale`)과 결합되는 방식으로 미루어 메르카토르 근사 보정으로 추정.
4. `AddPolyLayer(10)` 의 호출처/레이어 (TOC 에 버튼 없음).
5. `daum_loadview.html`, `3D.html` 의 내용(외부 서버 — 접속하지 않음). POST 파라미터 `sLat`/`sLng` 만 확인.
6. `MeasurePath`/`MeasureSurface` 의 `_accuracies` 기본 자릿수 — 미지정 시 `trunc` 기본 2자리로 추정.
7. 패널 2 행정경계의 첫 행 라벨(시도) 텍스트 — 라벨/버튼 배치 순서상 Do=시도, Si=시군구, Dong=읍면동으로 판단.

---

## 보안 관찰
- **하드코딩 VWorld API 키**: `10CF5698-511B-3812-92EB-CD2EBDC39CE7` (DOMAIN=`http://www.biz-gis.com`) — `bizgismap_cs.as:1476`. 도메인 바인딩 키이지만 SWF 에서 평문 노출. 웹판에서 재사용 금지, 자체 키를 서버 프록시에 보관.
- **평문 HTTP**: VWorld WMS(`http://map.vworld.kr`), OSM type 2/3 (`http://a.tile.openstreetmap.org`, `VWorld.as:176-206`), 로드뷰/3D 페이지, `LicenseCheck.php`, 모든 biz-gis/gislab 엔드포인트가 http. MITM 으로 타일/스크립트 페이지 변조 가능.
- **타일 프록시 `LicenseCheck.php?url=`** (`bizgismap_cs.as:1369`, `:1620-1622`): 임의 URL 을 인자로 받아 중계하는 구조 → 서버측 오픈 프록시/SSRF 가능성 (서버 미확인, 접속하지 않음).
- **crossdomain 정책 다수 로드**: `Security.loadPolicyFile` 로 policymap.or.kr, bizgis.gislab.co.kr, subdata1.gislab.co.kr, cjp.gislab.co.kr, biz-gis.com, oohmediaindex.com, geocoding.kr(:80, :8088), policymap.geocoding.kr, sdm.geocoding.kr:8080 (`bizgismap_cs.as:169-178`) 모두 http.
- **set.ini 에 키 포함**: `m_sXrayMapKey`(5행), `m_sGeocodingKey`(6행)를 서버에서 평문 http 로 받아 클라이언트에 보관 (`UserInit.as:546-547`, `app.key`).
- **행정경계 조회가 클라이언트 생성 SQL** 을 `m_sURL/m_sASP_DB`(getdb.php)로 POST (`UserProvince.as#CreateDoBoundary` :226-240) — 서버측 SQL 인젝션 노출 구조 (범위 밖이지만 기록).
- 로드뷰/3D 는 사용자 좌표를 제3자(biz-gis) 페이지로 POST 전송 (`modTOC.as:6313-6345`) — 위치정보 외부 전송.
- 원격 이미지 로드: `http://www.biz-gis.com/XRayMap/icon/resize.png` (`bizgismap_cs.as:11936`), CI 이미지들 (:5422-5466) — 외부 의존/추적 가능.
