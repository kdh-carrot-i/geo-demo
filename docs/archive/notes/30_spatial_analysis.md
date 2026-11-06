# 30. 공간분석 기능 역공학 (밀도/보간/분류/버퍼/DT/영역요약/컨투어)

범위: `re/notes/00_scope.md` 기준으로 서버 DB(getdb.php `sSQL`)·라이선스·로그인·설정·푸시·파일 API는 **제외**한다. 그래서 아래 분석은 모두 **사용자가 올린 데이터로 클라이언트에서 계산**하는 쪽으로 다시 설계한다.

경로 약어
- `M/` = `re/decompiled/main/scripts/`
- `D/` = `M/com/seld/draw/`
- `MOD/<name>/` = `re/decompiled/modules/<name>.swf/scripts/module/`
- `JS/` = `C:\XRayMap\bizgismap_pro\` (js_func.html, lib/*.js)

인용은 `파일:줄` 또는 `파일#함수` 형식이다. 줄 번호는 FFDec 디컴파일 결과 기준이다.

---

## 0. 공통 전제 (모든 분석에 영향)

| 항목 | 원본 동작 | 근거 |
|---|---|---|
| 지도 좌표계 | OpenScales 맵, `projection:"EPSG:4326"`, `scaleY:1.25`. 화면은 경위도 등장방형에 세로 1.25배(≈1/cos 37°) 스케일 | `M/bizgismap_cs.as:11691-11693` |
| 래스터 분석 좌표 | 밀도와 보간은 **경위도(도) 단위**로 거리를 계산한다. `dx=Δlng`, `dy=Δlat`를 그대로 유클리드로 합산하므로 지상 기준으로는 원이 아니라 남북으로 약 1.26배 긴 타원이 된다 | `D/UserSpatialAnalystDensityDraw.as:779-781`, `D/UserSpatialAnalystInterpolationDraw.as:323-325` |
| 래스터 범위 | **현재 화면 extent × 화면 픽셀 크기**. 결과는 뷰포트에 묶여 있고, 지도를 이동하면 "체크된 밀도를 현재 영역 조건으로 다시 계산" 메뉴로 재계산한다 | `D/UserSpatialAnalystDensityDraw.as:1899-1900`, `M/module/modLeftSimpleMenuForDensityRedraw.as:220`, `M/module/modTOC.as:5187-5243` |
| 투영 변환 | GEO↔KATEC/TM/UTMK/GRS80 변환은 자체 GeoTrans로 한다. KATEC: Bessel, k0=0.9999, lon0=128°, lat0=38°, FE=400000, FN=600000. TM: Bessel, lon0≈127.0029°, FE=200000, FN=500000. UTMK: GRS80, k0=0.9996, lon0=127.5°, FE=1000000, FN=2000000 | `D/GeoTrans.as:53-87`, `M/bizgismap_cs.as:9938-10014` |
| 서버 측 원 조건 | 서버 SQL의 원 필터는 투영좌표(KA/TM/UTM, m)에서 `SQRT((cx-X)^2+(cy-Y)^2) <= R_m`로 계산한다 | `D/UserSQL.as` (GetSQL, `#CIRCLEWHERE#` 치환부, `:1060` 이후) |

**웹 재구현 권장**
- 거리 기반 계산(커널, IDW, 버퍼)은 **EPSG:5179(UTM-K, m)** 또는 EPSG:3857로 투영한 뒤 미터 단위로 한다. proj4 정의는 5179/5174/5181 등 표준 EPSG를 쓴다. 원본의 Bessel→WGS84 datum shift 파라미터는 이번에 확인하지 못했다(미확인 항목 참고).
- 원본의 "타원 커널"을 재현할 필요는 없다고 판단한다. 원본 화면과 같은 모양이 꼭 필요하면 `compat` 옵션으로 경위도 거리 모드를 따로 둔다.

---

## 1. 밀도 분석 (Density / 커널 히트맵)

### 1.1 진입점과 입력
- **사용자 포인트 레이어**: 분석도구 → 밀도(mode 1)를 선택하면 `UserPointDraw.DrawDensity2(bWeighted)`가 실행된다 (`MOD/modDensityAnalystTool/modDensityAnalystTool.as:441-450`).
  - 입력 문자열은 `"VAL,X,Y|VAL,X,Y|..."` 형식이다. X=lng, Y=lat.
  - 가중치를 쓰지 않으면 `VAL=1.0`, 쓰면 `VAL=STAT 필드 값`이다. STAT가 -9999이면 `"0 "`이 들어간다 (`D/UserPointDraw.as:870-900`).
  - 레이어 타입은 `"FILEDENSITY"`, 초기 셀 크기 인자는 0, 투명도는 `DEFAULT_USERPT_ALPHA=0.8`, SizeMode는 `app.m_nDensitySizeMode`(기본값 3)를 쓴다 (`D/UserPointDraw.as:52, 905-910`, `M/bizgismap_cs.as:401`).
  - 레이어에 STAT 필드가 있으면 "가중 값으로 활용 가능… 적용/무시/취소" 확인창이 뜬다 (`D/UserPointDraw.as:821-868`).
- **서버 DB 밀도**(`xray_default_*_density`: 인구, 유동인구, 아파트, 직장, 기업, 요식업 등): `UserGetDataBase`가 서버 SQL 결과로 `DrawDensity`를 호출한다. 이때 `fAlpha=0.8`, 셀 크기는 `m_fCELLSIZEByCoord_Geo`이다 (`D/UserGetDataBase.as:439-457`, 메뉴 목록은 `MOD/modAnalystTool/modAnalystTool.as` 의 `RunTotalFun(...)` 호출 931–2740줄). 화면 이동 후 재계산할 때도 `getdb.php`에 다시 POST한다 (`D/UserSpatialAnalystDensityDraw.as:286-403`).
  - → **웹 버전에서는 제외**한다. 원본의 서버 SQL은 그리드로 미리 집계된 `VAL,X,Y`를 돌려주었다. 같은 일을 클라이언트에서 `binPoints()`(아래 1.3 ①)로 처리한다.

### 1.2 UI 파라미터 (modShowDensitySymbol, "레이어 밀도 심볼 변경")
처음 그릴 때(redraw가 아닐 때) 이 팝업이 먼저 뜨고, 확인을 눌러야 그리기가 시작된다 (`D/UserSpatialAnalystDensityDraw.as:530-561`).

| 컨트롤 | 값 / 기본값 | 근거 |
|---|---|---|
| 밀도분석 Search R (`cmbSearchR`) | 1 "좁은 지역 분석 (Search R 작음)", 2 "다소 좁은", 3 "보통"(기본, `m_nDensitySizeMode=3`), 4 "다소 넓은", 5 "넓은 지역 분석 (Search R 큼)" | `MOD/modShowDensitySymbol/modShowDensitySymbol.as:302-325` |
| 표현 색상 (`lstColor`) | 10개 램프 중 선택 → `objUserColorLamp.getColorLampArray(idx+1)` | 같은 파일 `:522-566` |
| 색상 반전 | 체크하면 배열 역순 | `:546-565` |
| 등급별 투명도 (10행) | 기본 `[0.14,0.2,0.43,0.57,0.71,0.86,1,1,1,1]`. 1행 라벨 "1 등급(밀도 낮음)", 10행 라벨 "10 등급(밀도 높음)" | `:277-288, 568-582`, `D/UserSpatialAnalystDensityDraw.as:207-210` |
| 레이어 전체 투명도 | `m_fAlpha*100` (기본 80) | `:368, 436` |

`app.m_bSmallDensityMode`가 켜져 있으면 SizeMode를 1로 강제하고, `m_bDensitySmallSearchR`이면 3을 1로 바꾼다 (`D/UserSpatialAnalystDensityDraw.as:549-552, 595-598`).

### 1.3 알고리즘 (정확한 재현)
`DrawDensity2` → `SetBestCellSize` → `SetBestSearchR_and_RasterCellSize` → `SetValXYDataArrayByCell` → `SetRasterDataArrayByCell` → `CalculateDensityManager(1)` → `SetRasterArrayX2` → `setMultiHotspots` → `setClassificationX2` → `DrawDensityRasterX2` (`D/UserSpatialAnalystDensityDraw.as:565-629, 719-725`).

① **사전 binning** (`SetBestCellSize` `:631-644`, `SetValXYDataArrayByCell` `:1766-1854`)
- `ratio = geoWPerPixel / geoHPerPixel`
- 셀 크기 인자 `>0`(DB 경로)이면 `cellW = 인자`, 아니면(파일 포인트) `cellW = (E−W)/100` (`VALXY_CELL_WIDTH_CNT=100`, `:43`). `cellH = cellW/ratio`.
- 각 점은 `row=int((y−S)/cellH)`, `col=int((x−W)/cellW)` bin에 들어간다. bin 값은 **VAL 합**이고, 좌표는 **bin 중심**으로 바뀐다. extent 밖의 점은 버린다.
- 그다음 `SetStandardDeviation`(`:1856-1890`)을 호출한다. bin 값들의 모표준편차 σ와 평균 μ를 구해 `σ/μ > 10`이면 `m_bNaturalBreak=true`로 둔다. `σ/μ > 20`이면 "값이 과도하게 편중되어 있습니다…" 경고를 띄운다.

② **래스터 격자** (`:599-606, 1892-1916, 668-671`)
- `RASTER_CELL_PIXEL_SIZE` = 2 (맵 픽셀 수 `W*H < 1280*800` 또는 고해상도 옵션) 또는 4.
- `nRasterW = int(mapW/px)`, `nRasterH = int(mapH/px)`. 셀 크기(도) = `geoPerPixel*px`.

③ **Search R** (`:646-667`): `R = (E−W)/{40,35,30,25,20}[sizeMode−1]` (도 단위, 화면 폭 대비 비율). `RI = R/cellH_raster`, `RJ = R/cellW_raster` (셀 수).

④ **커널 누적** (`CalculateDensityManager` `:674-843`, nMode=1 고정 `:620`)
- 각 bin 점의 래스터 위치: `i = int((Y−S)/cellH)`, `j = nRasterW − int((X−W)/cellW)`. 열 인덱스가 **좌우 반전**되어 있는데, 그릴 때 다시 반전하므로 결과는 상쇄된다.
- 탐색 창은 `[i−RI−1, i+RI+1)` × `[j−RJ−1, j+RJ+1)`이다. 상한이 배타적이어서 마지막 행·열은 빠진다.
- 거리: `d = sqrt(((j0−j)*cellW)^2 + ((i0−i)*cellH)^2)` (도 단위).
- `d==0`이면 `+= VAL`, `0<d<R`이면 **선형(콘) 커널** `+= VAL * (R−d)/R`.
- 셀의 초기값은 -9999(NoData)이고, 처음 기여를 받을 때 0으로 바뀐다. 이 과정에서 max/min을 갱신한다.
- 정규화는 하지 않는다. 결과는 반경 내 가중합이다.

⑤ **X2 업샘플** (`SetRasterArrayX2` `:1511-1759`, `nZ=2`)
- 2배 격자의 `[2i][2j]`에 원래 값을 넣는다.
- 나머지 내부 셀은 8-이웃 중 NoData가 아닌 값의 평균으로 채운다(1패스).
- 가장자리 셀은 별도 루프로 채우지만 결과는 버려지고 `_loc3_` 복사본으로 덮어쓰인다. 그래서 가장자리는 실질적으로 NoData로 남는다. 버그로, 해당 루프에서 `_loc6_=-1` (`:1710`)이다.

⑥ **핫스팟 후보** (`setMultiHotspots` `:845-949`, X2 격자 기준)
- 7×7 창(±3)에서 중심값이 최대인 셀이 후보다.
- 점수는 `VAL = 중심 + 창 내 합`이다. 중심이 두 번 더해진다.
- 점수 내림차순으로 정렬한 뒤, `top < VAL*10`(최고점의 1/10 초과)이고 기존 핫스팟과의 격자거리가 `RASTER_CELL_PIXEL_SIZE*20`보다 큰 후보만 채택한다. 최대 5개.
- 결과는 `m_latlngMaxVals`, `m_aIJMaxVals`에 저장되고 중첩 핫스팟 분석(§1.6)에서 쓰인다.

⑦ **분류** (`setClassificationX2` `:1117-1254`, 클래스 수 `RASTER_CLASS_CNT=10`)
- 기본(`m_bNaturalBreak=false`): `step=(max−min)/10`, `class = int(v/step) * sign(v)`. **`v−min`이 아니라 `v`를 나누고**, 음수 값은 부호가 뒤집힌다.
- NaturalBreak 모드:
  - 정렬된 값 배열 s(n개)로 분위 경계 `q=[s0, s[⌊n/9⌋·k] (k=1..8), s(n−1)]`를 만든다.
  - 등간격 경계 `e=[s0, max/9·k, s(n−1)]`를 만든다.
  - 최종 경계는 `b=(q+e)/2`이다.
  - 경계가 음수와 양수에 걸쳐 있으면 |b|가 가장 작은 내부 경계를 0으로 둔다.
  - `class = 1 + (b[k] ≥ v를 만족하는 첫 k)`.

⑧ **렌더** (`DrawDensityRasterX2` `:1373-1509`)
- 셀마다 `idx = min(class, 9)`로 정하고 `fill(m_faClassColor[idx], m_faClassAlpha[idx])`로 `px/2` 크기 사각형을 칠한다.
- 비트맵 전체 alpha는 `m_fAlpha`이다.
- 레이어명에 "증가/침수취약/감소/침수안전"이 들어가면 램프를 바꾸는 코드(`_loc4_`)가 있지만, X2 경로에서는 **쓰이지 않는다**. 비X2 경로(`DrawDensityRaster` `:1266-1305`)에서만 쓰이는데, 이 경로는 비활성이다(`m_bX2=true`, `:39`).
- TOC에는 타입 `"Density"`로 등록된다. 재계산용 상태 문자열은 `type#|#select#|#where#|#ect#|#para#|#colors#|#alphas#|#sizeMode#|#layerAlpha` 형식이다 (`:1494`).

⑨ **범례 문자열** (`SetColorTableString` `:2190-2207`, private이고 외부 호출은 확인하지 못함)
- 형식: `"반경 {int(R*16500*meterPerPixel/10)*10}m 내 수치(인구/세대 또는 개수 등)를 의미|color,hi~lo|..."`
- 상수 16500의 의미는 미확인이다.

### 1.4 기본 색 램프 (밀도)
`m_faClassColor` 기본값은 `getColorLampArray(1)`이다 (`D/UserSpatialAnalystDensityDraw.as:203-206`). 램프 1은 JS 램프를 로드한 뒤 `setDefaultColorArray()`에서 **자체 jet 계열 함수로 덮어쓴다** (`D/UserColorLamp.as:148-206`). Flash `beginFill`은 상위 alpha 바이트를 무시하므로 RGB만 의미가 있다.

```
p=i/10 (i=0..9)
R = p<.33?0 : p<.66? trunc((p-.33)/.33*255) : 255
G = p<.33? trunc(p/.33*255) : p<.66? 255 : trunc((1-(p-.66)/.34)*255)
B = p<.33?0 : p<.66? trunc((1-(p-.33)/.33)*255) : 0
→ #000000,#004d00,#009a00,#00e700,#36ffc8,#83ff7b,#d0ff2e,#ffe100,#ff9500,#ff4b00
```
(위 값은 별도로 작성한 재구현 스크립트로 계산했다. 원본 JS는 실행하지 않았다.)

### 1.5 서버 의존성
- 파일 포인트 밀도(FILEDENSITY)는 **완전히 클라이언트에서** 처리된다.
- DB 밀도는 `getdb.php` `sSQL`에 의존한다 (`:364-395`). 원본 DB 데이터는 받지 않으므로, 웹 버전에서는 사용자 CSV/GeoJSON 포인트를 같은 경로로 넣는다.

### 1.6 밀도 중첩 HotSpot (modTOC)
- `setDensityOverlayHotSpotArea(weights?)` (`M/module/modTOC.as:5344-5435`)
  - 체크된(on) Density 레이어들의 핫스팟 후보(§1.3 ⑥)를 모은다.
  - 각 후보 위치에서 레이어마다 `getCalHotSoptAreaByLatLng` 값을 구해 가중합한다. 이 함수는 X2 격자에서 ±`px*10` 셀 창 안의 **분류된 클래스 값** 합을 돌려준다 (`D/UserSpatialAnalystDensityDraw.as:2099-2157`).
- `setDensityMultiHotspots` (`:5437-5537`)
  - 점수 내림차순으로 정렬하고, 상위 후보와의 격자거리가 `px*20` 미만인 후보는 0으로 만든다(NMS). 상위 5개를 고른다.
  - 각 핫스팟에 반경 `meterPerPixel*40/1000` km의 원(GetBufferCoord)을 그린다. 흰 테두리, fill alpha 0.2이고 라벨은 "n등급"이다.
- 계산기 모드(`:5260-5342`)는 레이어별 가중치를 사용자가 직접 입력한다. 기본은 `"레이어" * 1.0`이고, 체크된 밀도 레이어가 2개 이상이어야 한다.

### 1.7 TS 의사코드 (권장 구현: 미터 단위, 뷰 독립)
```ts
type Pt = { x: number; y: number; w: number };           // EPSG:5179 meters
interface DensityOpts {
  extent: [number, number, number, number];  // minx,miny,maxx,maxy (m)
  cellPx: 2 | 4; widthPx: number; heightPx: number;
  sizeMode: 1|2|3|4|5;                        // R = extentW / [40,35,30,25,20]
  preBinCols?: number;                        // default 100 (원본 FILEDENSITY)
  classAlphas?: number[];                     // [0.14,0.2,0.43,0.57,0.71,0.86,1,1,1,1]
  colors?: string[];                          // 10 colors
}
const DIV = [40, 35, 30, 25, 20];

export function kernelDensity(pts: Pt[], o: DensityOpts) {
  const [x0, y0, x1, y1] = o.extent;
  const W = Math.floor(o.widthPx / o.cellPx), H = Math.floor(o.heightPx / o.cellPx);
  const cw = (x1 - x0) / W, ch = (y1 - y0) / H;
  const R = (x1 - x0) / DIV[o.sizeMode - 1];
  // ① pre-bin (원본: (E-W)/100, 합, bin 중심)
  const bcw = (x1 - x0) / (o.preBinCols ?? 100), bch = bcw;   // 미터 단위면 정사각
  const bins = new Map<string, Pt>();
  for (const p of pts) {
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    const c = Math.floor((p.x - x0) / bcw), r = Math.floor((p.y - y0) / bch);
    const k = r + ':' + c, b = bins.get(k);
    if (b) b.w += p.w; else bins.set(k, { x: x0 + (c + .5) * bcw, y: y0 + (r + .5) * bch, w: p.w });
  }
  // ② 콘 커널
  const grid = new Float32Array(W * H).fill(NaN);
  const rj = Math.ceil(R / cw) + 1, ri = Math.ceil(R / ch) + 1;
  let max = -Infinity, min = Infinity;
  for (const b of bins.values()) {
    const bj = Math.floor((b.x - x0) / cw), bi = Math.floor((b.y - y0) / ch);
    for (let i = Math.max(0, bi - ri); i <= Math.min(H - 1, bi + ri); i++)
      for (let j = Math.max(0, bj - rj); j <= Math.min(W - 1, bj + rj); j++) {
        const d = Math.hypot((bj - j) * cw, (bi - i) * ch);
        if (d >= R && d !== 0) continue;
        const k = i * W + j, add = d === 0 ? b.w : b.w * (R - d) / R;
        grid[k] = (Number.isNaN(grid[k]) ? 0 : grid[k]) + add;
        if (grid[k] > max) max = grid[k]; if (grid[k] < min) min = grid[k];
      }
  }
  // ③ 분류 (원본 호환: int(v/step), step=(max-min)/10; 편중 시 hybrid breaks)
  const vals = [...bins.values()].map(b => b.w);
  const mu = vals.reduce((a, v) => a + v, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mu) ** 2, 0) / vals.length);
  const natural = sd / mu > 10;
  const cls = new Int8Array(W * H).fill(-1);
  const step = (max - min) / 10;
  let breaks: number[] | null = null;
  if (natural) {
    const s = Array.from(grid).filter(v => !Number.isNaN(v)).sort((a, b) => a - b), n = s.length;
    const q = [s[0], ...[1,2,3,4,5,6,7,8].map(k => s[Math.floor(n / 9) * k]), s[n - 1]];
    const e = [s[0], ...[1,2,3,4,5,6,7,8].map(k => max / 9 * k), s[n - 1]];
    breaks = q.map((v, k) => (v + e[k]) / 2);
  }
  for (let k = 0; k < grid.length; k++) {
    const v = grid[k]; if (Number.isNaN(v)) continue;
    let c = breaks ? breaks.findIndex(b => b >= v) + 1 : Math.trunc(Math.abs(v) / step);
    cls[k] = Math.min(Math.max(c, 0), 9);
  }
  return { W, H, cw, ch, grid, cls, R, natural };     // → canvas ImageData → ol/source/ImageStatic
}
```
렌더링: `ImageData`의 각 셀에 `colors[cls]`와 `alpha=classAlphas[cls]*255`를 넣고, OL `ImageLayer`+`ImageStatic`(extent)로 올린다. 레이어 opacity는 `m_fAlpha`로 맞춘다. 원본의 X2 평균 업샘플은 canvas `imageSmoothingEnabled`나 2× 박스 필터로 대신할 수 있다. 화면 이동 시 재계산할지는 옵션으로 둔다.

---

## 2. 그리드(셀) 집계 / "CELL" 레이어

- 서버 SQL 템플릿의 `#fWidthSize#`와 `#fHeightSize#`는 **둘 다 셀 높이값으로** 치환된다. 셀 폭은 `cellW = (E−W)/nCellWidthCNT`, 셀 높이는 `cellH = cellW*0.8`이다. 투영 레이어(KA/TM/UTM)는 정수 m 단위로 계산한다 (`D/UserSQL.as:1060-1130, 1189-1213`).
- `nCellWidthCNT` 기본값은 70이다 (`M/bizgismap_cs.as:583`). `mapW/(70+k)`를 반올림한 픽셀 크기가 4의 배수가 되는 첫 k를 고른다 (`D/UserSQL.as:1084-1102`).
- 실제 집계(GROUP BY FLOOR(X/size) 등)는 **서버 SQL 안에 있어서 클라이언트 코드로는 보이지 않는다**. 결과는 `"VAL,X,Y|…"`이고, ShapeType이 `"CELL"`이면 값 분류(§4)를 거쳐 보간 래스터(§3)로 그려진다 (`D/UserGetDataBase.as:622-643`). 값이 100개 미만이면 "분석을 수행할 값이 부족합니다…" 확인창이 뜬다.
- 예: `xray_default_소득지도_cell`, `xray_default_표준지 가격_cell` (`MOD/modAnalystTool/modAnalystTool.as:2102, 2463, 2524`).

**웹 재구현**: 사용자 포인트를 정사각 m 격자로 집계한다(sum/mean/count 선택). 결과 셀 중심점을 §3 보간이나 직접 셀 폴리곤 choropleth로 표현한다.
```ts
export function gridAggregate(pts: Pt[], cell: number, agg: 'sum'|'mean'|'count') {
  const m = new Map<string, { s: number; n: number; c: number; r: number }>();
  for (const p of pts) {
    const c = Math.floor(p.x / cell), r = Math.floor(p.y / cell), k = c + ',' + r;
    const o = m.get(k) ?? { s: 0, n: 0, c, r }; o.s += p.w; o.n++; m.set(k, o);
  }
  return [...m.values()].map(o => ({ x: (o.c + .5) * cell, y: (o.r + .5) * cell,
    w: agg === 'sum' ? o.s : agg === 'mean' ? o.s / o.n : o.n }));
}
```

---

## 3. 보간 (수치추정 / Interpolation, IDW)

### 3.1 진입점
- 분석도구 → 수치추정(mode 2)에서 가중 필드는 **필수**다. 비어 있으면 "수치추정분석은 반드시 가중 값 적용 필드를 선택하여야 합니다." 경고가 뜬다 (`MOD/modDensityAnalystTool/modDensityAnalystTool.as:452-460`).
- 실행 경로: `UserPointDraw.DrawInterpolation2()`가 STAT가 -9999가 아닌 점만 `"VAL,X,Y|…"`로 모은다 → `MOD_ValueClassification_SetClass` → "범례구분" 창(§4)에서 분류를 확정 → `RunInterpolation` → `UserSpatialAnalystInterpolationDraw.DrawInterpolation` (`D/UserPointDraw.as:791-819`, `M/bizgismap_cs.as:8233-8281`, `MOD/modValueClassification/modValueClassification.as:1617-1659`).
- 레이어 alpha는 범례구분 창의 투명도 입력값(기본 "50" → 0.5)을 쓴다. `m_oTempUserClassification`이 이미 있으면 창을 건너뛰고 0.6을 쓴다 (`modValueClassification.as:1992`, `M/bizgismap_cs.as:8250-8257`).

### 3.2 알고리즘 (`D/UserSpatialAnalystInterpolationDraw.as`)
- 격자: `RASTER_CELL_PIXEL_SIZE=4` 고정(2px로 바뀌는 로직 없음), sizeMode=3이므로 `R=(E−W)/30` (`:33, 168-176, 194-220`).
- **셀 할당** (`SetValXYDataArrayAndRasterArrayByCell` `:1083-1218`): 점을 래스터 셀(`j = W − int(...)`, 좌우 반전)에 넣고 **평균값**(sum/cnt)을 저장한다. 사전 bin은 없다.
- **1단계 희소 채움** (`CalculateInterpolationManager` `:222-408`)
  - 대상은 4칸 간격(i,j += 4)의 빈 셀이다.
  - 반경을 r=1..15 정사각 링으로 넓혀 가며 `d < 15*cellH(도)`인 값 셀을 모은다.
  - **매 링마다 정사각 전체를 다시 스캔하고 누적하므로 안쪽 점이 중복 가산된다.** 6개 이상 모이면 멈춘다.
  - 값은 `Σ v_k·(1/d_k)/Σ(1/d_k)` (IDW, power=1).
- **2단계 전체 채움** (`CalculateInterpolationManager2` `:410-602`)
  - 모든 빈 셀이 대상이다. 링 r=1..`RJ`(=R/cellW, 예: 1280px 화면이면 ≈10.7)로 넓히고, 4개 이상 모이면 멈춘다.
  - 거리 조건 `_loc3_ > d`에서 `_loc3_`는 **셀 개수 RJ**이고 `d`는 도 단위라서 사실상 항상 참이다(버그). 실질적으로 "최근접 정사각 링 내 ≥4점 IDW(p=1, 중복 가산)"이다.
  - `m_faDis` = 평균거리. 이 단계에서 4개 미만이면 NoData로 남는다.
- **X2 업샘플** (`SetRasterArrayX2` `:815-1076`): 밀도와 같지만 **0을 NoData로 취급**한다. 실제 값이 0인 셀은 사라진다.
- **렌더** (`DrawInterpolationRasterX2` `:746-808`)
  - `v≠0 && v≠-9999`인 셀만 그리고, 색은 `GetColor(v)`로 정한다: `b[k] ≤ v < b[k+1]` → `color[k]`, `v ≥ b_last` → 마지막 색, 그 외는 -1 (`:1457-1475`).
  - 셀 alpha = `min(1, 2*(1 − dis/RJ))`이다. 단위가 섞여 있어서 실제로는 거의 항상 1이다.
  - TOC 타입은 `"Cell"`, 범례는 `""|GetLegendColor(-1)` = `"color,hi~lo|…"`(상위 클래스부터) 형식이다 (`:170, 806`; `D/UserClassification.as:673-700`).
  - 핫스팟 후보 계산(`setMultiHotspots`)도 수행한다 (`:452, 604-688`).

### 3.3 TS 의사코드 (권장: 정석 IDW, 미터)
```ts
export function idwGrid(pts: Pt[], ext: [number,number,number,number], W: number, H: number,
                        opts = { power: 1, minN: 4, maxRingCells: 11, cellAvg: true }) {
  const [x0,y0,x1,y1] = ext, cw = (x1-x0)/W, ch = (y1-y0)/H;
  const seed = new Float64Array(W*H).fill(NaN), cnt = new Uint32Array(W*H);
  for (const p of pts) { const j = Math.floor((p.x-x0)/cw), i = Math.floor((p.y-y0)/ch);
    if (i<0||j<0||i>=H||j>=W) continue; const k=i*W+j;
    seed[k] = (Number.isNaN(seed[k])?0:seed[k]) + p.w; cnt[k]++; }
  for (let k=0;k<seed.length;k++) if (cnt[k]) seed[k]/=cnt[k];          // 셀 평균
  const out = Float64Array.from(seed);
  for (let i=0;i<H;i++) for (let j=0;j<W;j++) {
    if (!Number.isNaN(seed[i*W+j])) continue;
    let sw=0, sv=0, n=0;
    for (let r=1; r<=opts.maxRingCells && n<opts.minN; r++)             // 링 확장(중복 없이)
      for (let ii=i-r; ii<=i+r; ii++) for (let jj=j-r; jj<=j+r; jj++) {
        if (Math.max(Math.abs(ii-i),Math.abs(jj-j))!==r) continue;
        if (ii<0||jj<0||ii>=H||jj>=W) continue; const v=seed[ii*W+jj]; if (Number.isNaN(v)) continue;
        const d=Math.hypot((jj-j)*cw,(ii-i)*ch), w=1/d**opts.power; sw+=w; sv+=w*v; n++; }
    if (n>=opts.minN) out[i*W+j]=sv/sw;
  }
  return out;  // → classify(§4) → color
}
```
원본의 중복 가산 효과(안쪽 링 가중치 증가)까지 재현하려면 `compat` 플래그로 "링마다 정사각 전체 재스캔"을 켜는 방식이 있다. 다만 권장하지 않는다.

---

## 4. 값 분류 (범례구분, modValueClassification + UserClassification + geostats)

### 4.1 UI
| 항목 | 값 | 근거 |
|---|---|---|
| 방식 라디오 | 1 "Eq Interval.", 2 "Natural brk.", 3 "Quantile."(**기본**), 4 "단일 값"(Unique). 회사가 NET/SMARTCARD이면 Natural이 기본 | `MOD/modValueClassification/modValueClassification.as:317-325, 1751-1799` |
| 분류 개수 `cmbClass` | 1..20, 기본 **5** (`selectedIndex=4`). 값 개수가 6 이하이면 `n−2`개 | `:334-343, 636-641` |
| 표현 색상 `lstColor` | 13개 램프(idx+1 → JS `GetColorRampString(n, mode)`), 기본 0(모드1) | `:557-601, 2158-2197` |
| 색상 반전 | 체크 | `:589-598` |
| 투명도 | 기본 "50"% | `:1992` |
| 경계선 색 | `m_PolyBoundaryColor` (블록/행정 폴리곤 모드) | `:673, 1341` |
| 선 두께 | Line 모드에서 클래스별 기본 "3" | `:541-551` |
| 클래스 행 편집 | 좌측(시작값)을 바꾸면 이전 행의 끝값 = 값 − 0.0001, 우측(끝값)을 바꾸면 다음 행의 시작값 = 값 + 0.0001 | `:1039-1105` |

표시 규칙: 클래스 k(>0)의 시작값은 경계값이 정수면 `b+0.1`, 소수면 `b + 10^-소수자리`(toFixed(7))이다 (`:1186-1206`).

### 4.2 경계 계산 (`D/UserClassification.as`)
- 생성자 `(values, CONTR_CNT+1)`: **`param2--` 하므로 geostats nbClass = 클래스 수**이다. 값을 정렬하고, min이 -9999이면 그보다 큰 첫 값을 min으로 쓴다 (`:30-72`).
- JS 쪽은 `SetDataClassification(join(","))` → `new geostats(values)`이다 (`JS/js_func.html:742-757`). geostats는 생성 시 `setPrecision()`로 최대 소수 자릿수에 맞춰 값을 **반올림**한다 (`JS/lib/geostats.js:192-224`).
- 사용하는 방식은 3가지뿐이다: Eq(1), Jenks(2), Quantile(3) (`D/UserClassification.as:270-286`). **StdDev, Geometric, Arithmetic JS 함수는 정의되어 있지만 AS3에서 호출하는 곳이 없다**(domWindow 호출 전수 grep 결과).
- 고유값 수가 1이면 `[v,v]`로 nbClass=1로 처리하고, `고유값 수 < nbClass+1`이면 Jenks와 Quantile을 EqInterval로 대체한다 (`:150-175`).
- 후처리 (`GetClassArrayByJavaScript2` `:287-347`)
  - `",NaN"`을 제거하고 숫자로 정렬한다.
  - 첫 경계가 min보다 크면 min으로, 마지막 경계가 max보다 작으면 max로 바꾼다.
  - 소수 10자리를 넘으면 toFixed(10)으로 자른다.
  - **연속 중복 경계는 `(prev+cur+next)/3`으로 벌린다**(앞쪽 비교 1패스, 뒤쪽 비교 1패스).
- geostats 공식 (`JS/lib/geostats.js`)
  - EqInterval `:523-550`: `b_i = min + i*(max−min)/n`, `b_n = max`.
  - Quantile `:553-590`: `step = N/n`. 내부 경계는 `sorted[round(i*step+0.49)−1]`이고 앞에 sorted[0]을 붙인다. 마지막 값 추가 조건 `bounds[N−1] !== last`는 사실상 버그로, 대부분 max를 추가한다.
  - Jenks `:767-877`: 표준 Fisher-Jenks(분산 최소) 구현이다. `kclass[0]==kclass[1]`이면 kclass[0]=0이다.
  - StdDev `:597-668`: σ는 모표준편차를 **소수 2자리로 반올림**한 값이다 (`:352-396`).
  - Geometric `:677-719`: 값에 0 이하가 있으면 alert를 띄우고 중단한다.
  - Arithmetic `:727-760`.
  - Unique `:884-907`.
- 값→색 (`GetColor` `:567-609`): `b[k] ≤ v < b[k+1]` → `color[k]`, `v < b0` → **#000000**, `v ≥ b_last` → 마지막 색. geostats `getClass`는 `v ≤ b[i+1]`(상한 포함)이지만 AS3는 하한 포함이라 서로 다르다.
- Unique 모드: `GetColorFromUniqueValue` — 문자열이 같거나 `'값'` 따옴표 형태가 일치하면 해당 색 (`:486-521`).
- 결과 레이어 직렬화 (`modValueClassification.as:1517-1529`): `"PROVINCE_BLOCK|fields|colors|breaks|valField|alpha|cdField"`, Line은 `colors^widths` (`:1431-1445`).

### 4.3 TS 의사코드
```ts
export type Method = 'eq'|'quantile'|'jenks'|'stddev'|'geometric'|'arithmetic'|'unique';
export function classify(values: number[], nClass: number, m: Method): number[] {
  const v = values.filter(x => x !== -9999 && Number.isFinite(x)).sort((a,b)=>a-b);
  const min = v[0], max = v[v.length-1], uniq = [...new Set(v)];
  if (uniq.length === 1) return [min, min];
  if ((m === 'jenks' || m === 'quantile') && uniq.length < nClass + 1) m = 'eq';  // 원본 fallback
  let b: number[];
  switch (m) {
    case 'eq': b = Array.from({length:nClass+1},(_,i)=>min+i*(max-min)/nClass); b[nClass]=max; break;
    case 'quantile': { const st=v.length/nClass; b=[v[0]];
      for (let i=1;i<nClass;i++) b.push(v[Math.round(i*st+0.49)-1]); b.push(max); break; }
    case 'jenks': b = jenks(v, nClass); break;              // simple-statistics ckmeans 대신 Fisher-Jenks 그대로 이식
    case 'stddev': { const mu=v.reduce((a,x)=>a+x,0)/v.length;
      const sd=Math.round(Math.sqrt(v.reduce((a,x)=>a+(x-mu)**2,0)/v.length)*100)/100;
      b = stdDevBounds(mu, sd, nClass); break; }            // geostats.js:597-668 그대로
    case 'geometric': { if (min<=0) throw new Error('양수만'); const lmin=Math.log10(min), it=(Math.log10(max)-lmin)/nClass;
      b = Array.from({length:nClass},(_,i)=>10**(lmin+i*it)); b.push(max); break; }
    case 'arithmetic': { const den=nClass*(nClass+1)/2, it=(max-min)/den; b=[min];
      for (let i=1;i<=nClass;i++) b.push(b[i-1]+i*it); break; }
    case 'unique': return uniq;
  }
  // 원본 후처리
  b.sort((a,c)=>a-c); if (min<b[0]) b[0]=min; if (max>b[b.length-1]) b[b.length-1]=max;
  for (let i=1;i<b.length-1;i++) if (b[i-1]===b[i]) b[i]=(b[i-1]+b[i]+b[i+1])/3;
  for (let i=1;i<b.length-1;i++) if (b[i]===b[i+1]) b[i]=(b[i-1]+b[i]+b[i+1])/3;
  return b.map(x => +x.toFixed(10));
}
export const colorOf = (v: number, b: number[], c: string[]) => {
  for (let k=0;k<c.length;k++) if (v>=b[k] && v<b[k+1]) return c[k];
  return v < b[0] ? '#000000' : c[c.length-1];
};
```

---

## 5. 색 램프 (GetColorRampString / UserColorLamp)

- JS 구현 (`JS/js_func.html:693-740`): `Rainbow().setNumberRange(1,n).setSpectrum(...)` 후 `colourAt(1..n)`. stop 사이를 **균등 구간으로 나누고 RGB 선형 보간 + Math.round**한다 (`JS/lib/rainbowvis.js`).
- 모드별 stop:

| mode | stops |
|---|---|
| 1 | #32a833 #fdfe57 #fe001a (녹→황→적) |
| 2 | #fe001a #fdfc56 #00fcfd #1719ee |
| 3 | #fcfe92 #34d652 #101373 |
| 4 | #ffffff #000000 |
| 5 | #b6edef #100f8a |
| 6 | #c2523c #fbfc01 #0dc738 #0b2b7a |
| 7 | #fff2ff #ff00ff #1100ff #16fff0 #40ff00 #ffff02 #ffff02 |
| 8 | #ccffcb #0dcc0e |
| 9 | #f4f500 #f50001 |
| 10 | #ffff80 #6b0600 |
| 11 | 36색 범주형 파스텔-진 (`:720`) |
| 12 | 36색 범주형 파스텔 (`:722`) |
| 13 | 34색 범주형 진한 색 (`:724`) |
| 그 외(0) | red → black |

- 모드 11~13도 **보간 대상**이다. n이 stop 수보다 작으면 인접 범주색이 섞인 색이 나온다. 범주 그대로 쓰려면 n=stop 수여야 한다.
- 계산값(10등급, 자체 재구현으로 산출)
  - m1: 32a833,5fbb3b,8cce43,b9e14b,e6f453,fde250,fda943,fe7135,fe3828,fe001a
  - m2: fe001a,fe542e,fda842,fdfc56,a9fc8e,54fcc5,00fcfd,08b0f8,0f65f3,1719ee
  - m3: fcfe92,d0f584,a3ec76,77e367,4ada59,30c056,28955d,206a64,183e6c,101373
  - m5: b6edef,a4d4e4,91bcd9,7fa3cd,6c8ac2,5a72b7,4759ac,3540a0,222895,100f8a
  - 5등급 m1: 32a833,98d345,fdfe57,fe7f39,fe001a
- `UserColorLamp`(밀도용 10등급): lamp1 = §1.4 jet(덮어씀), lamp2..7 = mode1..6, lamp8 = mode8, lamp9 = mode9, lamp10 = mode10. **mode7은 빠져 있다** (`D/UserColorLamp.as:55-91, 103-146`).
- `GetDataClassificationColorByVal`(JS)은 mode 1~5만 지원한다 (`JS/js_func.html:852-878`). AS3에서 호출하는 곳은 없다.

```ts
export function rampColors(stops: string[], n: number): string[] {
  if (n === 1) return [stops[0]];
  const k = stops.length - 1, inc = (n - 1) / k, hex = (s: string, c: number) => parseInt(s.slice(c*2, c*2+2), 16);
  return Array.from({ length: n }, (_, t) => {
    const x = t + 1, g = k === 1 ? 0 : Math.min(Math.floor((x - 1) / inc), k - 1);
    const lo = 1 + inc * g, hi = 1 + inc * (g + 1), f = (Math.min(Math.max(x, lo), hi) - lo) / (hi - lo);
    const a = stops[g].replace('#',''), b = stops[g + 1].replace('#','');
    return '#' + [0,1,2].map(c => Math.round(hex(a,c) + (hex(b,c) - hex(a,c)) * f).toString(16).padStart(2,'0')).join('');
  });
}
```

---

## 6. 반경 버퍼 (modBufferCreateBy_R, "버퍼 생성")

- UI: 지도 클릭 위치(위경도/TM/카텍 표시) + `txtBufferR`(단위 **km**, 기본값 없음). `"1,2,3"`처럼 여러 반경을 입력할 수 있다. 검증은 **마지막 값 기준**으로 `0 < R < 500`이다 (`MOD/modBufferCreateBy_R/modBufferCreateBy_R.as` RunBtnCreateBufferInputR, 라벨 "반경", "km" `:442-458`).
- 원 좌표: JS `GetBufferCoord(lat,lng,R_km)` (`JS/js_func.html:377-397`)
  - 구면 목적지 공식(Aviation Formulary)으로 계산한다. 지구반경 **6378.8 km**, **10° 간격 37점**(0..360°, 폐합)이다.
  - 경도 부호 관례는 서경이 양수(`lng1−dlng`)라서 링 방향이 반대(시계방향)로 나온다. 원 자체 모양은 같다.
  - Detail 버전은 5° 간격이다 (`:399-419`). 리사이즈와 핫스팟도 같은 함수를 쓴다.
- 결과 처리: `objUserCreateArea.SetServerCoord(..., circle=true, R_km)`가 `TYPE:"CIRCLE"`, `R_KM` 속성을 가진 사용자 영역을 만든다 (`D/UserCreateArea.as:146-304`).
  - 다중 반경은 **링 여러 개를 가진 Polygon 하나**로 만들어진다. OpenScales에서 첫 링이 외곽, 나머지가 hole이 되는 구조라 even-odd 방식의 띠 모양으로 렌더링될 가능성이 크다(미확인).
- 원 판정 (`CheckUserAreaCircle` `D/UserCreateArea.as:1429-1502`): 링 점이 11개 이상이고 중심(KATEC)까지 거리 비가 0.98~1.02이면 원으로 본다. 반경은 50m 단위로 반올림해 km로 저장한다.
- 리사이즈 (`DrawResizeCircle` `:2601-2691`): 핸들까지의 KATEC 거리 / 최대 R 비율로 모든 반경을 비례 조정하고 "반경: x.xxKm" 알림을 띄운다.
- **서버 의존 없음** (JS 헬퍼만 사용).

```ts
import circle from '@turf/circle';
export const bufferRings = (lng: number, lat: number, radiiKm: number[], steps = 36) =>
  radiiKm.map(r => circle([lng, lat], r, { steps, units: 'kilometers' }));   // 다중 반경은 개별 Feature 권장
// 원본 동일 좌표가 필요하면:
export function bufferCoordCompat(lat: number, lng: number, rKm: number, stepDeg = 10) {
  const d = rKm / 6378.8, la = lat*Math.PI/180, lo = lng*Math.PI/180, out: [number,number][] = [];
  for (let a = 0; a <= 360; a += stepDeg) { const tc = a*Math.PI/180;
    const y = Math.asin(Math.sin(la)*Math.cos(d) + Math.cos(la)*Math.sin(d)*Math.cos(tc));
    const dl = Math.atan2(Math.sin(tc)*Math.sin(d)*Math.cos(la), Math.cos(d) - Math.sin(la)*Math.sin(y));
    const x = ((lo - dl + Math.PI) % (2*Math.PI)) - Math.PI; out.push([x*180/Math.PI, y*180/Math.PI]); }
  return out;
}
```

---

## 7. 목록 기반 버퍼 분석 (modBufferAnalyst_By_List, "Layer Analysis tool")

- 입력 소스 (`MOD/modBufferAnalyst_By_List/modBufferAnalyst_By_List.as`)
  - (a) TOC의 Point/Geocoding 레이어: `TITLE,x,y,STAT` (`:483-594`). TITLE이 비어 있으면 "No. n"을 쓴다.
  - (b) "▶좌표 값 직접 입력": 텍스트 `PRJ|NAME,x,y[,VALUE]\n…` 형식이고 PRJ는 GEO/TM/UTM/KA 중 하나다 (`:629-715`).
- 분석 반경 `txtBufferRadius`(km)은 0보다 커야 한다. 10km를 넘으면 "입력된 반경(..Km)이 너무 광범위합니다" 확인창이 뜬다. TOZ 고객사는 기본 0.5 (`:497, 790-819`).
- 대상이 300개 이하이면 대상마다 원 버퍼를 생성·표시(`CreateBuffer`)한 뒤 영역별로 집계한다. 300개를 넘으면 원을 그리지 않고 집계만 한다(`SetSummary1Simple`) (`:821-970`).
- **집계 = 서버 SQL**(`getdb.php`, 원 조건 `GetSQL(type, …, true, lat, lng, R_m)`) (`:984-1134`).
  - 결과 행: `NAME|v1|v2^…`. 빈 값은 0으로 채운다(`|^`→`|0^` 등).
  - 결과를 모아 **클립보드 TSV로 복사**한다. 기본 헤더는 거주인구, 아파트, 빌라, 직장인구, 요식업, 소득 분위 등 약 60개 컬럼 (`:1322-1358`). TOZ/SEOUL 전용 헤더도 따로 있다 (`:1229-1317`).
- **웹 재구현**: 대상점 × 반경(m)마다 사용자 레이어를 집계한다.
  - 포인트 레이어: 개수, 그리고 선택 필드의 합/평균/최대/최소.
  - 폴리곤 레이어: 면적 비례 배분(turf `intersect` + `area`).
  - 결과는 표 + CSV/TSV 다운로드로 제공한다.
```ts
export function bufferSummary(targets: {name:string; lng:number; lat:number}[], rM: number,
                              layers: {name:string; pts: {lng:number;lat:number;v?:number}[]}[]) {
  return targets.map(t => {
    const row: Record<string, number|string> = { NAME: t.name };
    for (const L of layers) {
      const inR = L.pts.filter(p => haversineM(t.lat, t.lng, p.lat, p.lng) <= rM);
      const vs = inR.map(p => p.v).filter((v): v is number => v != null && v !== -9999);
      row[`${L.name}_cnt`] = inR.length;
      row[`${L.name}_sum`] = vs.reduce((a,b)=>a+b,0);
      row[`${L.name}_avg`] = inR.length ? (row[`${L.name}_sum`] as number) / inR.length : 0; // 원본: sum/전체개수
    }
    return row;
  });
}
```

---

## 8. 사용자 영역 요약 (UserCreateArea 툴팁, UserAreaGetSummaryDB, modUserAreaAnalyst)

### 8.1 영역 툴팁 "#n 요약정보" (`D/UserCreateArea.as#CreateToolTip :636-663`)
영역을 생성하거나 수정할 때 4가지를 조회한다.
1. `GetAndSetAreaInfo` (`:728-789`): **서버** `xray_userareatooltip_poly_인구` 또는 `…_circle_인구`(원은 중심과 R_m 사용). HEALTH 고객사는 매출정보를 조회한다. → **제외**.
2. `GetAndSetAreaUserPointCountAndStat` (`:557-634`): **클라이언트**. TOC의 각 Point/Geocoding 레이어에 대해 `UserPointDraw.CalcCountAndStatByUserArea(polygon)`를 호출한다 (`D/UserPointDraw.as:3665-…`).
   - `polygon.containsPoint`로 개수를 센다. STAT가 -9999가 아닌 점만 합·최대·최소에 넣는다.
   - **평균 = 합/전체 포함 개수**(STAT 없는 점 포함).
   - 표시 형식: "▶'레이어' 레이어 영역 내 통계 / 영역내 포함 개수 / '필드' 총합 / 평균 / 최대값 / 최소값".
   - 자릿수: |x|>1000 → 0자리, >1 → 1자리, >0.1 → 2자리, >0.01 → 3자리, 그 외 → 5자리.
3. `GetAndSetAreaCompanyInfo` / `CompanyStoreInfo` (`:791-937`): 서버 → 제외.

### 8.2 영역별 일괄 집계 (`D/UserAreaGetSummaryDB.as`)
- 모든 사용자 영역 `#1..#n`에 대해 서버 SQL(원이면 원 조건)을 실행하고, `n|-9999|값…` 행을 모아 표(`URL_Return.GetTableUrl`) 팝업이나 클립보드로 내보낸다 (`:37-270`). → 서버 의존이므로 **8.1-2와 같은 로컬 집계로 대체**한다.

### 8.3 영역 상세분석 (modUserAreaAnalyst)
- 영역 하나에 대해 인구, 아파트, 직장, 요식업, 소득 프로파일을 서버 SQL로 받아 차트를 그린다. 시·도 평균과 비교한다 (`MOD/modUserAreaAnalyst/modUserAreaAnalyst.as:617-2040`).
- **유사 지역 찾기**: 민감도 슬라이더(50~100, 기본 **90**, step 1; `:3746-3749`). `tol = 100 − 민감도`(%p)로 비율 조건 `X비율 > v−tol AND X비율 < v+tol`을 만든다. 소득은 `±v*tol/100`이다 (`SetWhere :2535-2635`). 블록 목록은 서버에서 조회한다 (`:2648-2916`).
- → 원본 서버 데이터에 의존하므로 **제외**한다. 다만 같은 "유사도 범위 필터"는 사용자 폴리곤 레이어의 속성 비율에 그대로 적용할 수 있다(옵션).

### 8.4 행정구역별 포인트 집계 (modDensityAnalystTool mode 3)
- `UserPolygonPointStat.calcPolygonPointStatAndDrawProvince` (`MOD/modDensityAnalystTool/../com/seld/draw/UserPolygonPointStat.as:20-377`)
  - 행정경계(광역/시군구/행정동, MEGA/CTY/DONG/BDONG/JDONG)를 **서버에서** 받는다.
  - 포인트마다 처음 포함되는 폴리곤 하나에만 배정한다(aFlag).
  - 집계값은 개수(-1) / 합(0) / 평균(1, 합/개수, 0개면 0)이다.
  - 멀티폴리곤(AREA_RANK>1)은 rank 1 행에 합산한다.
  - 버그: "현재 폴리곤 포함 수 ≥ 전체 점 수"이면 조기 종료하고, 그 경우 남은 폴리곤이 결과에서 빠진다 (`:250-253`).
  - 결과는 `PROVINCE_BLOCK` choropleth(§4)로 그린다.
  - UI: 집계단위 라디오(광역시/시군구/행정동), 분석 범위(전국/시도 코드 목록 `:240`), 통계 방법 "합"/"평균". 행정동 단위는 범위 지정이 필수다 (`MOD/modDensityAnalystTool/modDensityAnalystTool.as:216-510`).
- **웹**: 사용자가 올린 행정경계 GeoJSON(또는 브이월드 경계)과 포인트를 공간조인한다. turf `booleanPointInPolygon`에 rbush 인덱스를 함께 쓴다.

```ts
export function areaPointStats(poly: GeoJSON.Polygon|GeoJSON.MultiPolygon, pts: {lng:number;lat:number;stat?:number}[]) {
  let n=0, sum=-9999, mx=-9999, mn=-9999;
  for (const p of pts) if (booleanPointInPolygon([p.lng,p.lat], poly)) { n++;
    const s=p.stat; if (s==null || s===-9999) continue;
    sum = sum===-9999 ? s : sum+s; if (mx===-9999||s>mx) mx=s; if (mn===-9999||s<mn) mn=s; }
  return { count:n, sum, avg: sum===-9999? -9999 : sum/n, max:mx, min:mn };   // 원본: avg = sum / 전체 n
}
const fmt = (x:number) => x.toFixed(Math.abs(x)>1000?0:Math.abs(x)>1?1:Math.abs(x)>0.1?2:Math.abs(x)>0.01?3:5);
```

---

## 9. 즐겨찾기 영역 (modFloatingArea) — "유동 영역"이 아님

- 이 모듈의 실제 기능은 **즐겨찾기 영역 추가/수정/삭제**다. "노출 영역"(필수)과 "내부 영역"(선택, 미선택 시 노출 영역과 같음), 영역 명칭으로 구성된다 (`MOD/modFloatingArea/modFloatingArea.as:288-344, 1011-1230`).
- 영역 문자열 형식 (`D/UserCreateArea.as#getAreaStringByIdx :2185-2219`, 전체 대문자화):
  `COORD:<lng lat…>|MOVE:FALSE|CIRCLE:<bool>|CIRCLE_LAT:..|CIRCLE_LNG:..|CIRCLE_R_KM:..|TOOLTIP:TRUE|LOOP:FALSE|HOTSPOT_AREA:..`
- 저장은 `UserURLUtil.getBase64andMD`로 인코딩한 `area1#^#area2` 문자열을 서버 파일 `{m_sFloatingGubun}_{명칭}.txt`로 보낸다(`floating_area/_writeFile.php` 등). 목록은 `#^^#` 구분이다 (`:681-886`, `D/URL_Return.as:113-118`).
- → 서버 파일 API는 **제외**한다. **IndexedDB/localStorage에 GeoJSON FeatureCollection**(properties: name, kind: exposure|inner, circle {lat,lng,rKm})으로 저장한다. 공간분석 알고리즘은 없다.
- 참고: "Floating" 데이터를 쓰는 별도 모듈(`modFLOATING_Analyst`, INJE/HS/MY 고객사)이 있지만 이번 범위 밖이다.

---

## 10. DT = 차량/도보 이동시간 권역 (Drive-Time / Walk-Time Isochrone)

### 10.1 현재(실사용) 경로: **외부 서버 API**
- 생성자는 항상 `getDTByAPI`만 호출한다 (`D/UserSpatialAnalystDTDraw.as:138-215`).
  - POST `http://www.biz-gis.com/api/dtapi.php`, 파라미터 `X=lng, Y=lat, MINUTE=<분>, PRJ=GEO, GUBUN=DT|WT|NEW_WT, UTF8=TRUE`.
  - 응답은 `decodeURL`로 디코딩한다. `"ERROR"`를 포함하면 alert를 띄우고, 아니면 `"lng,lat|lng,lat|…"` 링 하나를 받는다.
- 후처리 `SetSimplifyCoordsResult` (`:1810-1890`): 꼭짓점이 20개를 넘으면, 인접 세 점의 각이 180°±15° 이내인 점을 제거한다. 마지막 점 처리에서 y에 x를 쓰는 버그가 있다 (`:1857`).
- 결과는 `objUserCreateArea.SetServerCoord(…)`로 사용자 영역(폴리곤)이 된다 (`MOD/modDTCreateBy_Min/modDTCreateBy_Min.as:320-375`).
- UI (`modDTCreateBy_Min.as:190-274`)
  - `cmbGUBUN`: "차량이동거리"(1) / "도보이동거리"(2, "서울시만 분석 가능합니다.").
  - 분 입력 범위는 **5~120분**. 공개(비로그인/비관리자) 버전은 **10분 이하**로 제한되는데, 이 검사는 **클라이언트에서만** 한다.
  - GSC 고객사는 기본 30분. `JS_CALL.setGSC`는 30분 고정 (`D/JS_CALL.as:657-705`).

### 10.2 레거시(코드만 남아 있고 호출되지 않음) 로컬 cost-distance
`UserSpatialAnalystDTDraw1` / `_wt`는 private이고 생성자에서 호출하지 않는다. 그래도 알고리즘은 남아 있다.
- 탐색 반경은 `R_m = maxMin*450`(차량) 또는 `*50`(도보)이다. 반경에 따라 비용 래스터 테이블(`XRY_DT_COST_{30..360}M`, `XRY_WT_COST_{1..27}M`)과 셀 크기를 고르고, 서버에서 `COST_MIN`(밀도 모드에서는 `COST_MIN + COST_MIN*DEN/3`)을 받는다 (`:342-477, 217-340`).
- 시작점이 도로 셀이 아니면 ±3셀 링에서 가장 가까운 비용 셀로 옮긴다(`SetReLocation :1391-1465`). 실패하면 "클릭한 지점이 도로상에 위치하지 않습니다."를 띄운다.
- 누적비용: 시작=0, `k=0,1,2…` 정사각 링을 반복하며 8-이웃 완화(relaxation)를 한다.
  `DT[c] = min_n DT[n] + (cost[n] + cost[c]) * (diag ? √2 : 1)` (ArcGIS의 /2가 **없음**). 변화가 없거나 최대값을 넘으면 종료한다 (`SetDrivingTimeRaster :1467-1618`, `CalcDrivingTimeValue :1620-1757`).
- 분 단위 클래스로 스냅(`setClassification :847-888`)하고, NoData 셀을 8-이웃 평균으로 메운 뒤 테두리를 NoData로 만든다(`AfterFiltering :936-1052`).
- 등시선 외곽은 `≤min` 셀 비트맵을 2배로 확대한 뒤 **MarchingSquares9Grid**로 블롭 외곽선을 추적한다 → `CleanLine`(같은 기울기 점 제거) → KATEC→GEO (`getDtLineString :1054-1142`).

### 10.3 웹 재구현 제안
- 도로망 기반 isochrone은 데이터와 엔진이 필요하므로 클라이언트만으로는 불가능하다. 선택지:
  - (A) **OpenRouteService / Valhalla isochrone API**를 Node 프록시로 호출(키 보호). profile은 driving-car / foot-walking, range는 분×60초.
  - (B) 오프라인 근사: 사용자가 올린 도로 GeoJSON으로 클라이언트 그래프를 만들고 Dijkstra(속도 속성) → 도달 노드 → `turf.concave`/알파셰이프.
  - (C) 최소 대안: 평균속도 기반 원(차량 기본 30km/h 등, 가정값)을 그리고 "근사"라고 표시.
- 5~120분 제약은 유지한다. 공개 버전의 10분 제한은 원본에서도 클라이언트 검사일 뿐이고 정책 판단 사항이므로 이식하지 않거나 서버 프록시에서 강제한다.

```ts
export async function isochrone(lng: number, lat: number, minutes: number, mode: 'car'|'walk') {
  if (minutes < 5 || minutes > 120) throw new Error('5~120분');
  const r = await fetch('/api/isochrone', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ lng, lat, seconds: minutes*60, profile: mode==='car'?'driving-car':'foot-walking' }) });
  const fc = await r.json() as GeoJSON.FeatureCollection<GeoJSON.Polygon>;
  return simplify(fc.features[0], { tolerance: 0.0002 });      // 원본 15° 각도 단순화 대체
}
```

---

## 11. 컨투어 / 외곽 추적 (MarchingSquares9Grid)

- `M/com/graphics/MarchingSquares9Grid.as:1-163`
  - 입력 비트맵을 2배로 확대한다.
  - 위에서부터 첫 불투명 픽셀을 찾고, 그 지점의 3×3 이웃 패턴(9비트 문자열)을 `_variations` 표(36개 패턴 → 이동방향)로 바꿔 경계를 따라간다.
  - 시작점으로 돌아왔을 때 점이 50개 미만이면 노이즈로 보고 10줄 아래부터 다시 찾는다. **외곽 링 하나만** 돌려준다. 구멍과 다중 블롭은 지원하지 않는다.
  - `MAX_POINTS=10000`을 넘으면 throw한다.
- 사용처는 레거시 DT 하나뿐이다 (`D/UserSpatialAnalystDTDraw.as:1098`). 밀도와 보간은 래스터로만 그리고 등치선은 만들지 않는다.
- **웹 대체**: `d3-contour`(`contours().thresholds(breaks)`)나 `@turf/isobands`로 분류 경계별 밴드 폴리곤을 만든다. 밀도/보간 결과를 벡터 등치선으로 내보낼 수 있다.
```ts
import { contours } from 'd3-contour';
export const bands = (grid: Float32Array, W: number, H: number, breaks: number[]) =>
  contours().size([W, H]).thresholds(breaks)(Array.from(grid, v => Number.isNaN(v) ? -Infinity : v));
// 결과 좌표(격자 인덱스) → x = x0 + gx*cw, y = y0 + gy*ch 로 변환
```

---

## 12. 서버 의존 요약과 클라이언트 대체

| 기능 | 원본 의존 | 웹 대체 |
|---|---|---|
| 파일 포인트 밀도 | 없음(로컬) | §1.7 그대로 |
| DB 밀도(인구·유동·아파트 등 17종) | getdb.php sSQL + 자사 DB | 제외(데이터 없음). 사용자 데이터로만 실행 |
| CELL 집계/보간 | 서버 GROUP BY | §2 gridAggregate → §3 IDW |
| 값 분류/색 | 로컬 JS(geostats, rainbowvis) | §4/§5 TS 이식 |
| 반경 버퍼 | 로컬 JS | turf.circle |
| 목록 버퍼 집계 | 서버 SQL | §7 로컬 집계 + CSV |
| 영역 툴팁(포인트 통계) | 로컬 | §8.1 |
| 영역 툴팁(인구)/일괄 집계/상세분석/유사지역 | 서버 SQL | 제외 또는 사용자 레이어 대상 |
| 행정구역 포인트 집계 | 행정경계만 서버 | 사용자/공공 경계 GeoJSON + 공간조인 |
| 즐겨찾기 영역 | 서버 파일 php | IndexedDB |
| DT/WT 등시선 | biz-gis dtapi.php | ORS/Valhalla 프록시 또는 근사 |
| 밀도 중첩 HotSpot | 로컬 | §1.6 이식 |

---

## 13. 미확인 / 열린 질문

1. 서버 SQL 템플릿(`GetSQLByArray`)의 실제 집계식(셀 GROUP BY, 툴팁 인구 컬럼)은 클라이언트에 없다. set.ini 계열 설정 파일이나 서버 쪽에 있을 것으로 추정한다.
2. `SetColorTableString`의 상수 `16500`의 의미, 그리고 이 범례 문자열이 실제로 TOC 범례에 쓰이는지(private이고 외부 호출이 보이지 않음).
3. TOC에 Density 레이어의 범례가 어떻게 그려지는지(색 10칸 + "낮음/높음" 추정). `modTOC` 범례 렌더 코드는 확인하지 않았다.
4. 다중 반경 버퍼(한 Polygon에 여러 링)의 실제 렌더 결과(hole/even-odd 여부).
5. `dtapi.php`의 GUBUN=`NEW_WT`(코드 "3")를 고르는 UI가 없다(콤보에는 1과 2만 있음). 응답 포맷이 단일 링인지 멀티폴리곤인지도 미확인이다.
6. GeoTrans의 Bessel→WGS84 datum 변환 파라미터(7-param, Molodensky 등). 상수 위치를 확인하지 않았으므로 proj4 정의는 별도 노트에서 검증해야 한다.
7. `m_bDensityHighResolution`과 `m_bDensitySmallSearchR`을 켜는 UI 경로(`D/UserInit.as:2087` 주변) 미확인.
8. `UserSQLPoly` 폴리곤 choropleth의 테두리 두께와 투명도 세부값(`D/UserSQLPoly.as:173-375`)은 일부만 확인했다.
9. modLeftSimpleMenuForDensityRedraw는 버튼 4개(재계산 / 중첩 HotSpot / 계산기 HotSpot / HotSpot 삭제)뿐이고 로직은 modTOC에 있다 (`M/module/modLeftSimpleMenuForDensityRedraw.as:104-175, 220-287`). 재계산은 체크된 Density 레이어마다 서버(또는 FILEDENSITY 캐시 문자열)로 다시 계산한다.

---

## 보안 관찰

- **클라이언트가 원문 SQL을 서버에 보냄**: 모든 DB 분석이 `getdb.php`에 `sSQL`(Base64 등으로 인코딩만 함)을 POST한다 (`D/UserSpatialAnalystDensityDraw.as:389-395`, `D/UserAreaGetSummaryDB.as:115-122` 등). 행정코드(`AND MEGA_CD ='..'`, `UserPolygonPointStat.as:68-78`), 원 조건, DT 비용 쿼리(`UserSpatialAnalystDTDraw.as:328-334`) 같은 WHERE 절을 문자열 연결로 만든다. 서버가 이를 그대로 실행한다면 임의 SQL 실행이 가능한 구조다. 웹 버전은 이 경로를 쓰지 않는다(범위에서 제외됨).
- **평문 HTTP**: `http://www.biz-gis.com/api/dtapi.php`(DT), `http://www.biz-gis.com/XRayMap/floating_area/_readFile.php`(+`_writeFile`, `_renameFile`)를 TLS 없이 호출한다 (`D/UserSpatialAnalystDTDraw.as:184`, `D/URL_Return.as:118`). 웹 프록시는 HTTPS만 쓴다.
- **파일명 주입 가능성**: 즐겨찾기 영역 저장 시 서버 파일명이 `{gubun}_{사용자 입력 명칭}.txt`이고 클라이언트 검증이 없다 (`MOD/modFloatingArea/modFloatingArea.as:720, 777`). 서버 측 경로 검증이 없다면 경로 조작 위험이 있다(서버는 확인하지 않음).
- **권한 제한이 클라이언트 측에만 있음**: "공개용 버전 10분 이하" DT 제한(`modDTCreateBy_Min.as:249-256`)과 고객사별 기능 분기(`m_sCompanyName`)가 클라이언트 조건문뿐이라 우회할 수 있다.
- **난독화 ≠ 보호**: 저장 영역은 `getBase64andMD` 인코딩만 거친다(암호화로 보기 어려움).
- 분석 코드 자체에 키나 비밀번호 하드코딩은 발견하지 못했다(이번 범위 파일 기준).
- 원본 JS/AS3 코드는 실행하지 않았다. 색 램프 표는 별도 재구현 스크립트(스크래치 디렉터리)로 계산했고, 어떤 서버에도 접속하지 않았다.
