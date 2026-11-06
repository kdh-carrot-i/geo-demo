-- Commerce DB schema (data/commerce.sqlite). ERD: docs/03_DB_설계.md, docs/erd.mmd.
-- Wide Seoul API facts declare only their keys here; measure columns are added by the loader from the API fields.

PRAGMA journal_mode = WAL;

-- ── dimensions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS region_legal (
  bjd_cd TEXT PRIMARY KEY,            -- 법정동 10자리
  sido_cd TEXT, sgg_cd TEXT, umd_cd TEXT, ri_cd TEXT,
  locatadd_nm TEXT, locallow_nm TEXT
);
CREATE TABLE IF NOT EXISTS region_admin (
  adm_cd TEXT PRIMARY KEY,            -- 행안부 행정동 8자리
  adm_nm TEXT, sgg_cd TEXT, sgg_nm TEXT,
  sgis_adm_cd TEXT                    -- 통계청(SGIS) 행정동 8자리
);
CREATE TABLE IF NOT EXISTS sgis_adm_stats (
  sgis_adm_cd TEXT, year TEXT, adm_nm TEXT,
  PRIMARY KEY (sgis_adm_cd, year)
);
CREATE TABLE IF NOT EXISTS trade_area_seoul (
  trdar_cd TEXT PRIMARY KEY,
  trdar_se_cd TEXT, trdar_se_cd_nm TEXT, trdar_cd_nm TEXT,
  signgu_cd TEXT, signgu_cd_nm TEXT, adstrd_cd TEXT, adstrd_cd_nm TEXT,
  xcnts_value REAL, ydnts_value REAL,   -- EPSG:5181
  lon REAL, lat REAL, relm_ar NUMERIC
);
CREATE TABLE IF NOT EXISTS trade_zone_sbiz (
  trar_no TEXT PRIMARY KEY,
  main_trar_nm TEXT, ctprvn_cd TEXT, signgu_cd TEXT, signgu_nm TEXT,
  trar_area NUMERIC, coord_num INTEGER, wkt TEXT, stdr_dt TEXT
);
CREATE TABLE IF NOT EXISTS industry_store (
  scls_cd TEXT PRIMARY KEY,
  lcls_cd TEXT, lcls_nm TEXT, mcls_cd TEXT, mcls_nm TEXT, scls_nm TEXT
);
CREATE TABLE IF NOT EXISTS industry_svc (
  svc_induty_cd TEXT PRIMARY KEY,
  svc_induty_cd_nm TEXT
);
-- 업종 코드 대응표 (etl/industry-map.ts). 기준축 = 상가정보 소분류(scls_cd).
--   system = 'seoul_svc' : 서울 서비스업종 코드(CS…) ↔ 소분류
--   system = 'ftc'       : 공정위 업종 '대분류>중분류' ↔ 소분류
--   match_type = exact(같은 업종) / group(여러 소분류의 묶음) / partial(비슷하나 범위가 다름)
CREATE TABLE IF NOT EXISTS industry_map (
  system TEXT, code TEXT, code_nm TEXT, scls_cd TEXT, scls_nm TEXT, match_type TEXT, note TEXT,
  PRIMARY KEY (system, code, scls_cd)
);
-- 지역 코드 대응표 (etl/region-map.ts). 한 행 = 한 단계(level)의 대응 관계.
--   sido : 법정동 시도 2 ↔ SGIS 시도 2          (12 전남광주 → 24 광주 + 36 전남, 1:n)
--   sgg  : 법정동 시군구 5 ↔ SGIS 시군구 5
--   dong : 법정동 10 ↔ 행정동 8 ↔ SGIS 행정동 8 (weight = 해당 법정동 점포 중 이 행정동 비율)
-- 없는 코드는 ''로 둔다. valid_from = 법정동코드 생성일(adpt_de), valid_to = '' (현행).
CREATE TABLE IF NOT EXISTS region_code_map (
  level TEXT, sido_cd TEXT, sgg_cd TEXT, bjd_cd TEXT, adm_cd TEXT, sgis_cd TEXT,
  name TEXT, sgis_name TEXT, weight REAL, match_type TEXT, valid_from TEXT, valid_to TEXT, note TEXT,
  PRIMARY KEY (level, sgg_cd, bjd_cd, adm_cd, sgis_cd)
);
CREATE INDEX IF NOT EXISTS ix_rcm_adm ON region_code_map (adm_cd);
CREATE INDEX IF NOT EXISTS ix_rcm_sgis ON region_code_map (sgis_cd);
-- 폐지 법정동코드 → 현재 코드 (etl/legal-code-history.ts, 이름 매칭). 1:N은 weight로 나눔
CREATE TABLE IF NOT EXISTS region_legal_history (
  old_cd TEXT, old_nm TEXT, new_cd TEXT, new_nm TEXT, level TEXT, weight REAL, match_type TEXT, note TEXT,
  PRIMARY KEY (old_cd, new_cd)
);
CREATE INDEX IF NOT EXISTS ix_rlh_new ON region_legal_history (new_cd);
CREATE TABLE IF NOT EXISTS grid_100m (
  grid_cd TEXT PRIMARY KEY, lon REAL, lat REAL, adm_cd TEXT
);

-- ── facts: supply ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store (
  bizes_id TEXT PRIMARY KEY,
  bizes_nm TEXT, brch_nm TEXT,
  inds_lcls_cd TEXT, inds_lcls_nm TEXT, inds_mcls_cd TEXT, inds_mcls_nm TEXT, inds_scls_cd TEXT, inds_scls_nm TEXT,
  ksic_cd TEXT, ksic_nm TEXT,
  ctprvn_cd TEXT, signgu_cd TEXT, signgu_nm TEXT, adong_cd TEXT, adong_nm TEXT, ldong_cd TEXT, ldong_nm TEXT,
  lno_cd TEXT, plot_sct_cd TEXT, lno_adr TEXT, rdnm_cd TEXT, rdnm_adr TEXT,
  bld_mng_no TEXT, bld_nm TEXT, dong_no TEXT, flr_no TEXT, ho_no TEXT,
  lon REAL, lat REAL, std_ym TEXT
);
CREATE INDEX IF NOT EXISTS ix_store_adong ON store (adong_cd, inds_mcls_cd);
CREATE INDEX IF NOT EXISTS ix_store_scls ON store (inds_scls_cd);
CREATE INDEX IF NOT EXISTS ix_store_lonlat ON store (lon, lat);
CREATE INDEX IF NOT EXISTS ix_store_pnu ON store (lno_cd);

CREATE TABLE IF NOT EXISTS license_event (
  mgt_no TEXT PRIMARY KEY, opn_svc_id TEXT, opn_svc_nm TEXT, bplc_nm TEXT,
  apv_perm_ymd TEXT, dcb_ymd TEXT, trd_state_nm TEXT, dtl_state_nm TEXT,
  site_area NUMERIC, rdn_whl_addr TEXT, x_5174 REAL, y_5174 REAL, lon REAL, lat REAL
);

CREATE TABLE IF NOT EXISTS ta_store_q (
  stdr_yyqu_cd TEXT, trdar_cd TEXT, svc_induty_cd TEXT,
  PRIMARY KEY (stdr_yyqu_cd, trdar_cd, svc_induty_cd)
);

CREATE TABLE IF NOT EXISTS franchise_brand_y (
  yr TEXT, corp_nm TEXT, brand_nm TEXT,
  PRIMARY KEY (yr, corp_nm, brand_nm)
);

-- ── facts: performance ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ta_sales_q (
  stdr_yyqu_cd TEXT, trdar_cd TEXT, svc_induty_cd TEXT,
  PRIMARY KEY (stdr_yyqu_cd, trdar_cd, svc_induty_cd)
);
CREATE TABLE IF NOT EXISTS store_card_sales_m (
  base_ym TEXT, store_key TEXT, bizes_id TEXT, est_amt NUMERIC, est_cnt NUMERIC, source TEXT,
  PRIMARY KEY (base_ym, store_key)
);

-- ── facts: demand ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ta_flpop_q (stdr_yyqu_cd TEXT, trdar_cd TEXT, PRIMARY KEY (stdr_yyqu_cd, trdar_cd));
CREATE TABLE IF NOT EXISTS ta_repop_q (stdr_yyqu_cd TEXT, trdar_cd TEXT, PRIMARY KEY (stdr_yyqu_cd, trdar_cd));
CREATE TABLE IF NOT EXISTS ta_wrcpop_q (stdr_yyqu_cd TEXT, trdar_cd TEXT, PRIMARY KEY (stdr_yyqu_cd, trdar_cd));
CREATE TABLE IF NOT EXISTS living_pop_dong_h (
  stdr_de_id TEXT, tmzon_pd_se TEXT, adstrd_code_se TEXT,
  PRIMARY KEY (stdr_de_id, tmzon_pd_se, adstrd_code_se)
);
CREATE TABLE IF NOT EXISTS subway_daily (
  use_ymd TEXT, sbwy_rout_ln_nm TEXT, sbwy_stns_nm TEXT, gton_tnope NUMERIC, gtoff_tnope NUMERIC, reg_ymd TEXT,
  PRIMARY KEY (use_ymd, sbwy_rout_ln_nm, sbwy_stns_nm)
);
CREATE TABLE IF NOT EXISTS subway_hourly_m (
  use_mm TEXT, line_nm TEXT, station_nm TEXT, hr INTEGER, ride NUMERIC, alight NUMERIC,
  PRIMARY KEY (use_mm, line_nm, station_nm, hr)
);

-- ── facts: cost ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rone_stat (
  statbl_id TEXT, statbl_nm TEXT, dtacycle_cd TEXT, wrttime_idtfr_id TEXT, wrttime_desc TEXT,
  grp_id INTEGER, grp_nm TEXT, grp_fullnm TEXT,   -- 지역(서울>도심>광화문 등)
  cls_id INTEGER, cls_nm TEXT, cls_fullnm TEXT, itm_id INTEGER, itm_nm TEXT, ui_nm TEXT, dta_val NUMERIC,
  PRIMARY KEY (statbl_id, dtacycle_cd, wrttime_idtfr_id, grp_id, cls_id, itm_id)
);
CREATE TABLE IF NOT EXISTS trade_commercial (id INTEGER PRIMARY KEY, q_sgg_cd TEXT, q_deal_ym TEXT);
CREATE INDEX IF NOT EXISTS ix_trade_com ON trade_commercial (q_sgg_cd, q_deal_ym);
CREATE TABLE IF NOT EXISTS trade_apt (id INTEGER PRIMARY KEY, q_sgg_cd TEXT, q_deal_ym TEXT);
CREATE INDEX IF NOT EXISTS ix_trade_apt ON trade_apt (q_sgg_cd, q_deal_ym);
CREATE TABLE IF NOT EXISTS franchise_cost_y (
  yr TEXT, corp_nm TEXT, brand_nm TEXT,
  PRIMARY KEY (yr, corp_nm, brand_nm)
);
CREATE TABLE IF NOT EXISTS parcel (
  pnu TEXT PRIMARY KEY, jimok TEXT, area_m2 NUMERIC, official_price NUMERIC, price_ym TEXT, land_use TEXT, wkt TEXT
);
CREATE TABLE IF NOT EXISTS building (
  bld_mng_no TEXT PRIMARY KEY, pnu TEXT, bld_nm TEXT, grnd_flr_cnt NUMERIC, ugrnd_flr_cnt NUMERIC,
  tot_area NUMERIC, main_purps TEXT, hhld_cnt NUMERIC, useapr_day TEXT, wkt TEXT
);

-- ── meta ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_source (
  table_name TEXT PRIMARY KEY, source TEXT, endpoint TEXT, std_period TEXT,
  row_count INTEGER, status TEXT, loaded_at TEXT, note TEXT
);

-- ── 별칭 (etl/brand-alias.ts, etl/area-alias.ts) ────────────
-- 공정위 등록명 ↔ 상가정보 상호. 대표 브랜드 = 최신 연도 등록명 (겹치면 "등록명 [가맹본부]")
CREATE TABLE IF NOT EXISTS brand_member (yr TEXT, corp_nm TEXT, brand_nm TEXT, group_nm TEXT, PRIMARY KEY (yr, corp_nm, brand_nm));
CREATE INDEX IF NOT EXISTS ix_brand_member_group ON brand_member (group_nm);
CREATE TABLE IF NOT EXISTS brand_group (group_nm TEXT PRIMARY KEY, corp_nm TEXT, induty_mlsfc_nm TEXT, yr TEXT, frcs_cnt INTEGER, n_store INTEGER, n_alias INTEGER);
-- alias = 정규화한 이름 (소문자, 한글·영숫자만). kind: manual | ftc(등록명) | part(괄호·슬래시 부분) | derived(업종 꼬리말 뗌)
CREATE TABLE IF NOT EXISTS brand_alias (alias TEXT PRIMARY KEY, group_nm TEXT, kind TEXT, n_store INTEGER);
-- 상권 별칭: 카카오 테마거리 + 수동 별칭(객리단길 → 객사길). alias = 정규화한 이름, 같은 이름이 여러 곳이면 place_id로 구분
CREATE TABLE IF NOT EXISTS area_alias (
  alias TEXT, place_id TEXT, name TEXT, target TEXT, kind TEXT, category TEXT,
  sido TEXT, sgg TEXT, address TEXT, lat REAL, lon REAL,
  PRIMARY KEY (alias, place_id)
);
-- 주민등록 인구·세대 (etl/resident-pop.ts): 법정동(읍면동·리) 월별, 연령은 최근 월만 (a_* 열은 API 열 이름 그대로)
CREATE TABLE IF NOT EXISTS resident_pop_bjd (
  stats_ym TEXT, stdg_cd TEXT, sgg_cd TEXT, name TEXT, tot NUMERIC, male NUMERIC, female NUMERIC, hh_cnt NUMERIC, hh_nmpr REAL,
  PRIMARY KEY (stats_ym, stdg_cd)
);
CREATE INDEX IF NOT EXISTS ix_rpb_cd ON resident_pop_bjd (stdg_cd);
CREATE TABLE IF NOT EXISTS resident_age_bjd (stats_ym TEXT, stdg_cd TEXT, name TEXT, PRIMARY KEY (stats_ym, stdg_cd));
-- 부산 행정동 생활인구 (etl/busan-livepop.ts): 월 하루 평균, 주거·직장·방문
CREATE TABLE IF NOT EXISTS busan_livepop_dong_h (
  std_ym TEXT, adm_cd TEXT, adm_nm TEXT, hour INTEGER, home NUMERIC, work NUMERIC, visit NUMERIC, PRIMARY KEY (std_ym, adm_cd, hour)
);
CREATE TABLE IF NOT EXISTS busan_livepop_dong_age (
  std_ym TEXT, adm_cd TEXT, adm_nm TEXT, age_band TEXT, home NUMERIC, work NUMERIC, visit NUMERIC, PRIMARY KEY (std_ym, adm_cd, age_band)
);
-- 국민연금 가입 사업장 (etl/nps-workplace.ts): 법정동까지 주소, 사업자등록번호·개인 사업장명 미저장
CREATE TABLE IF NOT EXISTS nps_workplace (
  ym TEXT, seq INTEGER, bjd_cd TEXT, adm_cd TEXT, road_addr TEXT, jibun_addr TEXT, corp INTEGER, name TEXT,
  ind_cd TEXT, ind_nm TEXT, members NUMERIC, bill NUMERIC, gained NUMERIC, lost NUMERIC, PRIMARY KEY (ym, seq)
);
CREATE INDEX IF NOT EXISTS ix_nps_bjd ON nps_workplace (bjd_cd);
-- 주택 인허가 (etl/housing-permit.ts): 세대 있는 사업만, 법정동별 이어 받기
CREATE TABLE IF NOT EXISTS housing_permit (
  pk TEXT PRIMARY KEY, bjd_cd TEXT, pnu TEXT, plat_plc TEXT, bld_nm TEXT, purps TEXT, hhld INTEGER, main_bld INTEGER, tot_area REAL,
  apprv_day TEXT, stcns_sched_day TEXT, stcns_day TEXT, use_inspt_sched_day TEXT, use_inspt_day TEXT, demol TEXT
);
CREATE INDEX IF NOT EXISTS ix_hp_bjd ON housing_permit (bjd_cd);
CREATE TABLE IF NOT EXISTS housing_permit_done (bjd_cd TEXT PRIMARY KEY, rows INTEGER, fetched_at TEXT);
-- 건축 인허가 비주거 (etl/arch-permit.ts): 2022-08 이후, 300㎡ 이상 근생·판매·업무 등
CREATE TABLE IF NOT EXISTS arch_permit (
  pk TEXT PRIMARY KEY, bjd_cd TEXT, pnu TEXT, plat_plc TEXT, bld_nm TEXT, purps TEXT, arch_gb TEXT, tot_area REAL, plat_area REAL,
  main_bld INTEGER, pms_day TEXT, stcns_sched_day TEXT, real_stcns_day TEXT, use_apr_day TEXT
);
CREATE INDEX IF NOT EXISTS ix_ap_bjd ON arch_permit (bjd_cd);
CREATE TABLE IF NOT EXISTS arch_permit_done (bjd_cd TEXT PRIMARY KEY, rows INTEGER, fetched_at TEXT);
