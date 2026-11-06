"""행정동 유동인구 추정 v0 — 경기 실측(KT)으로 학습, 전국 행정동에 적용.

LICENSE: 경기 유동인구는 공공누리 2유형(상업적 이용 금지). 2026-11-02 결정으로 내부 심사 한정 사용,
실 서비스(외부) 오픈 전 외부 자문 (docs/10_데이터_이용조건.md L-1·L-2). 결과 테이블에도 그 표시를 남긴다.

Target: 내국인 시간당 평균 유동인구 (2026-08 31일 × 24시간 평균), log 변환.
Features: 전국에서 구할 수 있는 것만 — SGIS 인구·가구·종사자·사업체·밀도·평균연령, 상가정보 대분류별 점포 수.
검증: 시 단위 leave-one-group-out (경기 17개 시). 서울 생활인구와 정의가 달라(있는 인구 vs 움직이는 인구)
서울은 학습에 넣지 않고 순위 상관만 참고로 본다.

  .venv/Scripts/python flowpop_v0.py          # → out/flowpop_v0.json, out/flowpop_v0_report.json, DB flowpop_est_dong
"""
import json
import sqlite3
from datetime import datetime

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import LinearRegression, RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import LeaveOneGroupOut

from common import DB, OUT, q

BANDS = {"00-06": (0, 6), "06-11": (6, 11), "11-14": (11, 14), "14-17": (14, 17), "17-21": (17, 21), "21-24": (21, 24)}
LCLS = ["G2", "I1", "I2", "L1", "M1", "N1", "P1", "Q1", "R1", "S2"]
SGIS_COLS = ["tot_ppltn", "household_cnt", "tot_worker", "corp_cnt", "ppltn_dnsty", "avg_age", "aged_child_idx"]


def features() -> pd.DataFrame:
    """One row per 행정동 (store adong_cd), nationwide."""
    sg = q(f"""
        select m.adm_cd, max(m.sgg_cd) sgg_cd, {', '.join(f'max(s.{c}) {c}' for c in SGIS_COLS)}
        from region_code_map m join sgis_adm_stats s on s.sgis_adm_cd = m.sgis_cd
        where m.level = 'dong' and m.adm_cd <> '' group by m.adm_cd""")
    for c in SGIS_COLS:
        sg[c] = pd.to_numeric(sg[c], errors="coerce")
    st = q(f"""
        select adong_cd adm_cd, max(adong_nm) adm_nm, max(signgu_nm) sgg_nm, count(*) st_all,
               {', '.join(f"sum(inds_lcls_cd = '{c}') st_{c}" for c in LCLS)},
               sum(flr_no is not null and flr_no not in ('1', '')) st_upper
        from store where adong_cd is not null group by adong_cd""")
    df = st.merge(sg, on="adm_cd", how="left")
    df["area_km2"] = df.tot_ppltn / df.ppltn_dnsty.where(df.ppltn_dnsty > 0)
    for c in ["tot_ppltn", "household_cnt", "tot_worker", "corp_cnt", "st_all", *[f"st_{c}" for c in LCLS]]:
        df[f"log_{c}"] = np.log1p(df[c])
    df["log_area"] = np.log(df.area_km2.clip(lower=0.01))
    df["store_dnsty"] = np.log1p(df.st_all / df.area_km2.clip(lower=0.01))
    df["worker_per_pop"] = df.tot_worker / df.tot_ppltn.clip(lower=1)
    df["food_sh"] = df.st_I2 / df.st_all.clip(lower=1)
    df["upper_sh"] = df.st_upper / df.st_all.clip(lower=1)
    df["sido"] = df.adm_cd.str[:2]
    return df


FEATS = [
    "log_tot_ppltn", "log_household_cnt", "log_tot_worker", "log_corp_cnt", "ppltn_dnsty", "avg_age", "aged_child_idx",
    "log_area", "log_st_all", *[f"log_st_{c}" for c in LCLS], "store_dnsty", "worker_per_pop", "food_sh", "upper_sh",
]


def target() -> pd.DataFrame:
    hourly = q("""
        select admi_cd adm_cd, max(cty_nm) cty_nm, time_cd h, avg(tot_cnt) v
        from gg_flowpop_dong_h where forn_gb = 'N' group by admi_cd, time_cd""")
    g = hourly.groupby("adm_cd")
    t = g.agg(cty_nm=("cty_nm", "first"), hourly_avg=("v", "mean")).reset_index()
    tot = g.v.sum()
    for k, (a, b) in BANDS.items():
        t[f"sh_{k}"] = t.adm_cd.map(hourly[(hourly.h >= a) & (hourly.h < b)].groupby("adm_cd").v.sum() / tot)
    t["city"] = t.cty_nm.str.split().str[0]  # 수원시 장안구 → 수원시
    return t


# 시 단위 검증에서 Ridge(log 피처 전체)가 LightGBM·잔차 부스팅보다 나았다 (R² 0.893 vs 0.847~0.873).
# 선형이라 학습 범위 밖(농촌 등)에서도 트리처럼 상한에 붙지 않는다. 대신 예측은 학습 범위의 0.5~2배로 자른다.
def ridge():
    return make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 3, 20)))


def metrics(y, p):
    """y, p in log space. MAPE-style error in original units too."""
    err = np.exp(p) / np.exp(y) - 1
    return {"r2_log": round(1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2), 3),
            "spearman": round(spearmanr(y, p).statistic, 3),
            "median_abs_pct_err": round(float(np.median(np.abs(err))), 3),
            "within_50pct": round(float(np.mean(np.abs(err) <= 0.5)), 3)}


def main():
    f = features()
    t = target()
    d = t.merge(f, on="adm_cd", how="inner").dropna(subset=["tot_ppltn"])
    d = d[d.hourly_avg > 0]
    y = np.log(d.hourly_avg.values)
    fill = d[FEATS].median()
    X = d[FEATS].fillna(fill)
    groups = d.city.values
    print(f"train 행정동 {len(d)} / 경기 실측 {len(t)}, 시 {d.city.nunique()}")

    # leave-one-city-out
    oof = np.zeros(len(d))
    oof_base = np.zeros(len(d))
    base_X = np.c_[np.log1p(d.tot_ppltn + d.tot_worker)]
    for tr, te in LeaveOneGroupOut().split(X, y, groups):
        oof[te] = ridge().fit(X.iloc[tr], y[tr]).predict(X.iloc[te])
        oof_base[te] = LinearRegression().fit(base_X[tr], y[tr]).predict(base_X[te])
    by_city = {c: metrics(y[groups == c], oof[groups == c]) | {"n": int((groups == c).sum())} for c in sorted(set(groups))}
    # residual spread for a range: log-residual quantiles out of fold
    res = y - oof
    q10, q90 = np.quantile(res, [0.1, 0.9])

    model = ridge().fit(X, y)
    sc, rg = model.named_steps["standardscaler"], model.named_steps["ridgecv"]
    (OUT / "flowpop_v0.json").write_text(json.dumps({
        "features": FEATS, "fill": fill.round(6).tolist(), "mean": sc.mean_.round(6).tolist(), "scale": sc.scale_.round(6).tolist(),
        "coef": rg.coef_.round(6).tolist(), "intercept": round(float(rg.intercept_), 6), "alpha": float(rg.alpha_),
        "clip_log": [round(float(y.min() - np.log(2)), 4), round(float(y.max() + np.log(2)), 4)], "residual_log_q10_q90": [round(q10, 3), round(q90, 3)],
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    # time-band shares: nearest-neighbour average of the 10 most similar 경기 행정동 (feature space, standardised)
    mu, sd = X.mean(), X.std().replace(0, 1)
    Z = ((X - mu) / sd).fillna(0).values
    share_cols = [f"sh_{k}" for k in BANDS]

    # apply nationwide
    a = f.dropna(subset=["tot_ppltn"]).copy()
    a["est_log"] = np.clip(model.predict(a[FEATS].fillna(fill)), y.min() - np.log(2), y.max() + np.log(2))
    Za = ((a[FEATS] - mu) / sd).fillna(0).values
    nn = np.argsort(((Za[:, None, :] - Z[None, :, :]) ** 2).sum(-1), axis=1)[:, :10]
    for i, c in enumerate(share_cols):
        a[c] = d[c].values[nn].mean(1)
    # how far outside the 경기 training range (share of features outside its 5~95% band)
    lo, hi = X.quantile(0.05), X.quantile(0.95)
    a["out_of_range"] = ((a[FEATS] < lo) | (a[FEATS] > hi)).mean(axis=1).round(3)

    measured = t.set_index("adm_cd")
    a["kind"] = np.where(a.adm_cd.isin(measured.index), "measured", "estimated")
    a["hourly_avg"] = np.where(a.kind == "measured", a.adm_cd.map(measured.hourly_avg), np.exp(a.est_log))
    for c in share_cols:
        a[c] = np.where(a.kind == "measured", a.adm_cd.map(measured[c]), a[c])
    # 학습 범위(경기) 밖 피처가 많을수록 범위를 넓힌다: 잔차 분위 × (1 + 범위 밖 비율)
    widen = 1 + a.out_of_range
    a["p10"] = np.where(a.kind == "measured", a.hourly_avg, np.exp(a.est_log + q10 * widen))
    a["p90"] = np.where(a.kind == "measured", a.hourly_avg, np.exp(a.est_log + q90 * widen))

    # 서울: 정의가 다른 데이터와 순위만 비교 (참고)
    seoul = a[a.sido == "11"][["adm_cd", "est_log"]]
    lv = q("select adstrd_code_se adm_cd, avg(case when tmzon_pd_se between '10' and '17' then tot_lvpop_co end) day_lv from living_pop_dong_h group by 1")
    fl = q("""select t.adstrd_cd adm_cd, sum(f.tot_flpop_co) flpop from ta_flpop_q f join trade_area_seoul t using (trdar_cd)
              where f.stdr_yyqu_cd = (select max(stdr_yyqu_cd) from ta_flpop_q) group by 1""")
    s1 = seoul.merge(lv, on="adm_cd")
    s2 = seoul.merge(fl, on="adm_cd")
    seoul_check = {
        "vs_living_pop_daytime": {"n": len(s1), "spearman": round(spearmanr(s1.est_log, s1.day_lv).statistic, 3)},
        "vs_trade_area_flpop_sum": {"n": len(s2), "spearman": round(spearmanr(s2.est_log, s2.flpop).statistic, 3),
                                     "note": "상권이 있는 동만, 상권 유동인구 합계라 동 전체가 아님"},
    }

    imp = dict(sorted(zip(FEATS, rg.coef_.round(3).tolist()), key=lambda kv: -abs(kv[1])))
    report = {
        "model": "flowpop_v0", "trained_at": datetime.now().isoformat(timespec="seconds"),
        "target": "내국인 시간당 평균 유동인구 (경기 2026-08, KT)", "train_n": len(d), "cities": int(d.city.nunique()),
        "validation": "leave-one-city-out (경기 시 단위)",
        "model_oof": metrics(y, oof), "baseline_log_pop_plus_worker": metrics(y, oof_base),
        "residual_log_q10_q90": [round(q10, 3), round(q90, 3)],
        "model_type": f"Ridge (alpha {rg.alpha_:.3g}, 표준화 피처)", "by_city": by_city, "seoul_rank_check": seoul_check, "coef_standardised": imp,
        "applied": {"n": len(a), "measured": int((a.kind == "measured").sum()),
                    "out_of_range_gt_30pct": int((a.out_of_range > 0.3).sum())},
        "license": "공공누리 2유형 원천 — 내부 심사 한정 (docs/10 L-1·L-2)",
    }
    (OUT / "flowpop_v0_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ["model_oof", "baseline_log_pop_plus_worker", "residual_log_q10_q90", "seoul_rank_check", "applied"]}, ensure_ascii=False, indent=1))

    out = a[["adm_cd", "adm_nm", "sgg_nm", "kind", "hourly_avg", "p10", "p90", *share_cols, "out_of_range"]].copy()
    out.columns = [c.replace("-", "_") for c in out.columns]
    for c in ["hourly_avg", "p10", "p90"]:
        out[c] = out[c].round(0)
    for c in out.columns:
        if c.startswith("sh_"):
            out[c] = out[c].round(4)
    con = sqlite3.connect(DB, timeout=120)
    con.execute("drop table if exists flowpop_est_dong")
    out.to_sql("flowpop_est_dong", con, index=False)
    con.execute("create unique index ix_flowpop_est_dong on flowpop_est_dong (adm_cd)")
    con.execute("delete from meta_source where table_name = 'flowpop_est_dong'")
    con.execute(
        "insert into meta_source (table_name, source, endpoint, std_period, row_count, status, loaded_at, note) values (?,?,?,?,?,?,?,?)",
        ("flowpop_est_dong", "ml/flowpop_v0.py — 경기 유동인구(KT)로 학습한 행정동 추정", "ml/out/flowpop_v0.json", "202608", len(out), "loaded",
         datetime.now().isoformat(timespec="seconds"),
         f"경기 실측 {report['applied']['measured']} + 추정 {len(out) - report['applied']['measured']}. "
         f"시 단위 검증 R²(log) {report['model_oof']['r2_log']}. 공공누리 2유형 원천 — 내부 심사 한정, 외부 제공 전 외부 자문 (docs/10 L-1·L-2)"))
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
