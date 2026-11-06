"""Shared loaders for the v0 models. Reads data/commerce.sqlite read-only."""
import sqlite3
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "commerce.sqlite"
OUT = ROOT / "ml" / "out"
OUT.mkdir(exist_ok=True)


def connect() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def q(sql: str, params=()) -> pd.DataFrame:
    with connect() as con:
        return pd.read_sql_query(sql, con, params=params)


def prev_quarter(yq: str, n: int = 1) -> str:
    y, k = int(yq[:4]), int(yq[4])
    i = y * 4 + (k - 1) - n
    return f"{i // 4}{i % 4 + 1}"


def area_panel() -> pd.DataFrame:
    """One row per 상권 × 업종 × 분기 with demand, supply and sales columns (Seoul)."""
    sales = q("""
        select stdr_yyqu_cd yq, trdar_cd, svc_induty_cd ind, svc_induty_cd_nm ind_nm,
               thsmon_selng_amt sales_amt, thsmon_selng_co sales_cnt
        from ta_sales_q""")
    store = q("""
        select stdr_yyqu_cd yq, trdar_cd, svc_induty_cd ind,
               similr_induty_stor_co stores, frc_stor_co frc_stores,
               opbiz_rt open_rt, clsbiz_rt close_rt
        from ta_store_q""")
    tot = q("""
        select stdr_yyqu_cd yq, trdar_cd, sum(similr_induty_stor_co) area_stores
        from ta_store_q group by 1, 2""")
    fl = q("""
        select stdr_yyqu_cd yq, trdar_cd, tot_flpop_co flpop,
               tmzon_11_14_flpop_co * 1.0 / nullif(tot_flpop_co, 0) flpop_lunch_sh,
               tmzon_17_21_flpop_co * 1.0 / nullif(tot_flpop_co, 0) flpop_eve_sh,
               (sat_flpop_co + sun_flpop_co) * 1.0 / nullif(tot_flpop_co, 0) flpop_wkend_sh,
               (agrde_20_flpop_co + agrde_30_flpop_co) * 1.0 / nullif(tot_flpop_co, 0) flpop_2030_sh
        from ta_flpop_q""")
    re = q("""
        select stdr_yyqu_cd yq, trdar_cd, tot_repop_co repop, tot_hshld_co hshld, apt_hshld_co apt_hshld
        from ta_repop_q""")
    wr = q("select stdr_yyqu_cd yq, trdar_cd, tot_wrc_popltn_co wrcpop from ta_wrcpop_q")
    ta = q("""
        select trdar_cd, trdar_se_cd ta_type, trdar_cd_nm ta_nm, signgu_cd, adstrd_cd, relm_ar, lon, lat
        from trade_area_seoul""")
    df = (store.merge(sales, on=["yq", "trdar_cd", "ind"], how="left")
          .merge(tot, on=["yq", "trdar_cd"], how="left")
          .merge(fl, on=["yq", "trdar_cd"], how="left")
          .merge(re, on=["yq", "trdar_cd"], how="left")
          .merge(wr, on=["yq", "trdar_cd"], how="left")
          .merge(ta, on="trdar_cd", how="left"))
    df["sales_per_store"] = df["sales_amt"] / df["stores"].where(df["stores"] > 0)
    return df


def sgis_by_adm() -> pd.DataFrame:
    """SGIS 행정동 stats keyed by 8-digit 행정동 code (adm_cd). Several adm_cd can share one sgis_cd."""
    return q("""
        select distinct m.adm_cd, s.tot_ppltn sg_pop, s.household_cnt sg_hshld,
               s.tot_worker sg_worker, s.corp_cnt sg_corp, s.ppltn_dnsty sg_dnsty, s.avg_age sg_age
        from region_code_map m join sgis_adm_stats s on s.sgis_adm_cd = m.sgis_cd
        where m.level = 'dong'""").drop_duplicates("adm_cd")
