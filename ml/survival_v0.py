"""생존 모델 v0: will a newly licensed 일반음식점 close within 3 years? (nationwide, 인허가 data only)

Every feature is computed as of the store's 인허가일 from other licenses around it, so the model
can score a planned site anywhere in the country. Label: 폐업일 < 인허가일 + 3년.
Note: 양도양수 (owner change) also shows up as 폐업 + new license, so the label overstates real closures.
Run: ml/.venv/Scripts/python ml/survival_v0.py
"""
import json

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.neighbors import KDTree

from common import OUT, q

R = 300  # metres
DAY0 = np.datetime64("1970-01-01")


def days(s: pd.Series) -> np.ndarray:
    d = pd.to_datetime(s, errors="coerce").values.astype("datetime64[D]")
    out = (d - DAY0).astype("float64")
    out[np.isnat(d)] = np.nan
    return out


NAMES = ["active_300", "active_100", "same_uptae_300", "opened_12m_300", "closed_12m_300",
         "hist_close3y_rt_300", "hist_n_300"]


# full: with 매장 면적 (asked for in the API) / location: location + 업태 only
VARIANTS = {"full": NAMES + ["churn_12m", "site_area", "open_month", "uptae_nm", "sido_nm", "multused_yn"],
            "location": NAMES + ["churn_12m", "open_month", "uptae_nm", "sido_nm"]}


class LicenseIndex:
    """All 일반음식점 licenses with a KD-tree, so neighbour features can be computed as of any date.
    Shared by training (build_features) and serving (serve.py) so both use the same definitions."""

    def __init__(self):
        lic = q("""
            select mgt_no, apv_perm_ymd, dcb_ymd, trd_state_nm, uptae_nm, site_area, multused_yn, sido_nm, lon, lat
            from license_event where opn_svc_id = '07_24_04_P' and lon is not null and lat is not null and apv_perm_ymd >= '1990'""")
        lic["open_d"] = days(lic.apv_perm_ymd)
        lic["close_d"] = np.where(lic.trd_state_nm == "폐업", days(lic.dcb_ymd), np.nan)
        self.lic = lic[lic.open_d.notna()].reset_index(drop=True)
        self.xy = self.to_xy(self.lic.lon.values, self.lic.lat.values)
        self.tree = KDTree(self.xy)
        self.open_d = self.lic.open_d.values
        self.close_or_inf = np.where(np.isnan(self.lic.close_d.values), np.inf, self.lic.close_d.values)
        self.upt = self.lic.uptae_nm.fillna("").values
        self.closed_3y = self.close_or_inf < self.open_d + 3 * 365

    @staticmethod
    def to_xy(lon, lat) -> np.ndarray:
        lon, lat = np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
        return np.c_[lon * 111320 * np.cos(np.radians(lat)), lat * 110574]

    def features(self, nb: np.ndarray, d: np.ndarray, t: float, uptae: str) -> list[float]:
        """Neighbour features (order = NAMES) at day t; nb/d are neighbours within R, excluding self."""
        open_d, close_or_inf = self.open_d[nb], self.close_or_inf[nb]
        active = (open_d < t) & (close_or_inf >= t)
        hist = (open_d >= t - 6 * 365) & (open_d < t - 3 * 365)
        return [
            active.sum(),
            (active & (d <= 100)).sum(),
            (active & (self.upt[nb] == uptae)).sum(),
            ((open_d >= t - 365) & (open_d < t)).sum(),
            ((close_or_inf >= t - 365) & (close_or_inf < t)).sum(),
            self.closed_3y[nb][hist].mean() if hist.any() else np.nan,
            hist.sum(),
        ]


def add_derived(df: pd.DataFrame) -> pd.DataFrame:
    df["churn_12m"] = (df.opened_12m_300 + df.closed_12m_300) / (df.active_300 + 1)
    return df


def build_features() -> pd.DataFrame:
    ix = LicenseIndex()
    lic = ix.lic
    cohort = lic.index[(lic.apv_perm_ymd >= "2018") & (lic.apv_perm_ymd < "2023")].values
    feats = np.full((len(cohort), len(NAMES)), np.nan)
    B = 20000
    for b in range(0, len(cohort), B):
        idx = cohort[b:b + B]
        nbrs, dists = ix.tree.query_radius(ix.xy[idx], r=R, return_distance=True)
        for k, (i, nb, d) in enumerate(zip(idx, nbrs, dists)):
            keep = nb != i
            feats[b + k] = ix.features(nb[keep], d[keep], ix.open_d[i], ix.upt[i])
        print(f"features {min(b + B, len(cohort))}/{len(cohort)}", flush=True)

    df = pd.concat([lic.loc[cohort].reset_index(drop=True), pd.DataFrame(feats, columns=NAMES)], axis=1)
    df["y"] = ix.closed_3y[cohort].astype(int)
    df["open_month"] = df.apv_perm_ymd.str[5:7].astype(int)
    add_derived(df)
    for c in ["uptae_nm", "sido_nm", "multused_yn"]:
        df[c] = df[c].fillna("NA").astype("category")
    return df


def main():
    cache = OUT / "survival_v0_features.pkl"
    df = pd.read_pickle(cache) if cache.exists() else build_features()
    df.to_pickle(cache)
    report = {"cohort": "일반음식점 인허가 2018-01 ~ 2022-12, 좌표 있음"}
    for vname, X in VARIANTS.items():
        report[vname] = fit(df, X, vname)
    (OUT / "survival_v0_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


def fit(df: pd.DataFrame, X: list[str], vname: str) -> dict:
    tr = df[df.apv_perm_ymd < "2021"]
    va = df[(df.apv_perm_ymd >= "2021") & (df.apv_perm_ymd < "2021-07")]
    te = df[df.apv_perm_ymd >= "2021-07"]
    model = lgb.LGBMClassifier(n_estimators=3000, learning_rate=0.03, num_leaves=63, min_child_samples=100,
                               subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
    model.fit(tr[X], tr.y, eval_X=va[X], eval_y=va.y, eval_metric="auc",
              callbacks=[lgb.early_stopping(150, verbose=False)])
    p = model.predict_proba(te[X])[:, 1]
    te = te.assign(p=p, decile=pd.qcut(p, 10, labels=False) + 1)
    model.booster_.save_model(str(OUT / f"survival_v0_{vname}.txt"))

    imp = pd.Series(model.booster_.feature_importance("gain"), index=X)
    by_dec = te.groupby("decile").agg(n=("y", "size"), pred=("p", "mean"), actual_close3y=("y", "mean")).round(3)
    seoul = te.sido_nm == "서울특별시"
    return {
        "rows": {"train(2018-2020)": len(tr), "valid(2021H1)": len(va), "test(2021H2-2022)": len(te)},
        "base_close3y_rate_test": round(float(te.y.mean()), 3),
        "auc_test": round(roc_auc_score(te.y, p), 3),
        "auc_test_seoul": round(roc_auc_score(te.y[seoul], p[seoul.values]), 3),
        "auc_hist_rate_only": round(roc_auc_score(te.y[te.hist_close3y_rt_300.notna()],
                                                  te.hist_close3y_rt_300.dropna()), 3),
        "best_iteration": model.best_iteration_,
        "close3y_by_predicted_decile": by_dec.reset_index().to_dict(orient="records"),
        "top_features_gain_share": (imp / imp.sum()).sort_values(ascending=False).round(3).head(10).to_dict(),
    }


if __name__ == "__main__":
    main()
