"""매출 예측 v0: LightGBM on Seoul 상권 × 업종 quarterly sales per store.

Two feature sets:
  seoul    - everything the Seoul 상권 API provides (유동·직장·상주인구, 점포, 개폐업)
  national - only features we can also build nationwide (점포 수, SGIS 행정동 인구·가구·사업체, 면적)
Split by 상권 and time: 10% of 상권 for validation (latest-1 quarter), another 10% for test (latest quarter),
the rest for training (earlier quarters). Test 상권 are never seen in training.
Run: ml/.venv/Scripts/python ml/sales_v0.py
"""
import json

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import OUT, area_panel, prev_quarter, sgis_by_adm

BASE = ["ind", "stores", "frc_stores", "area_stores", "relm_ar", "qtr"]
SEOUL = BASE + ["ta_type", "open_rt", "close_rt", "flpop", "flpop_lunch_sh", "flpop_eve_sh",
                "flpop_wkend_sh", "flpop_2030_sh", "repop", "hshld", "apt_hshld", "wrcpop"]
NATIONAL = BASE + ["sg_pop", "sg_hshld", "sg_worker", "sg_corp", "sg_dnsty", "sg_age"]
CATS = ["ind", "ta_type"]


def metrics(y_log: np.ndarray, p_log: np.ndarray) -> dict:
    y, p = np.expm1(y_log), np.expm1(p_log)
    ape = np.abs(p - y) / y
    return {
        "r2_log": round(1 - ((y_log - p_log) ** 2).sum() / ((y_log - y_log.mean()) ** 2).sum(), 3),
        "mape_median": round(float(np.median(ape)), 3),
        "within_30pct": round(float((ape <= 0.3).mean()), 3),
        "within_50pct": round(float((ape <= 0.5).mean()), 3),
    }


def panel() -> pd.DataFrame:
    """Feature panel shared with serve.py (all rows, including cells without sales)."""
    df = area_panel().merge(sgis_by_adm(), left_on="adstrd_cd", right_on="adm_cd", how="left")
    df["qtr"] = df.yq.str[4].astype(int)
    for c in CATS:
        df[c] = df[c].astype("category")
    return df


def main():
    df = panel()
    df = df[(df.stores > 0) & (df.sales_amt > 0)].copy()
    df["y"] = np.log1p(df.sales_per_store)

    # Spatial + time split: test 상권 are never seen in training, so area-specific
    # columns (e.g. relm_ar) cannot act as an ID. This mimics scoring a new site.
    latest = df.yq.max()
    valid_q, test_q = prev_quarter(latest), latest
    areas = df.trdar_cd.drop_duplicates().sample(frac=1, random_state=7)
    n = len(areas) // 10
    va_areas, te_areas = set(areas.iloc[:n]), set(areas.iloc[n:2 * n])
    seen = ~df.trdar_cd.isin(va_areas | te_areas)
    tr = df[seen & (df.yq < valid_q)]
    va = df[df.trdar_cd.isin(va_areas) & (df.yq == valid_q)]
    te = df[df.trdar_cd.isin(te_areas) & (df.yq == test_q)]

    # Baseline: median sales per store of the same 업종 in training data.
    med = tr.groupby("ind", observed=True).y.median()
    report = {"quarters": {"train": sorted(tr.yq.unique().tolist()), "valid": valid_q, "test": test_q},
              "rows": {"train": len(tr), "valid": len(va), "test": len(te)},
              "baseline_industry_median": metrics(te.y.values, te.ind.map(med).astype(float).fillna(tr.y.median()).values)}

    importances = {}
    for name, feats in [("seoul", SEOUL), ("national", NATIONAL)]:
        model = lgb.LGBMRegressor(n_estimators=5000, learning_rate=0.03, num_leaves=31, min_child_samples=100, reg_lambda=5,
                                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
        model.fit(tr[feats], tr.y, eval_X=va[feats], eval_y=va.y,
                  callbacks=[lgb.early_stopping(100, verbose=False)])
        pred = model.predict(te[feats])
        report[name] = metrics(te.y.values, pred)
        # Residual quantiles on unseen 상권, used by serve.py to turn a point estimate into p10~p90.
        resid = te.y.values - pred
        report[name]["resid_log_q10"], report[name]["resid_log_q90"] = (round(float(v), 4) for v in np.quantile(resid, [0.1, 0.9]))
        report[name]["best_iteration"] = model.best_iteration_
        model.booster_.save_model(str(OUT / f"sales_v0_{name}.txt"))
        imp = pd.Series(model.booster_.feature_importance("gain"), index=feats)
        importances[name] = (imp / imp.sum()).sort_values(ascending=False).round(3).head(10).to_dict()

    report["top_features_gain_share"] = importances
    (OUT / "sales_v0_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
