"""편의점 생존 모델 v0: will a newly licensed 편의점 close within 3 years? (nationwide, 담배소매업 인허가)

Same approach as survival_v0 (일반음식점): every feature is computed as of the store's 인허가일 from other
licenses around it, so a planned site anywhere can be scored. 편의점 = 담배소매업 인허가 중 5대 브랜드 상호.

Label differences from the 음식점 model:
- 간판 교체·양도 is not a closure: if another 담배소매업 license opens within 20 m between 30 days before and
  120 days after the 폐업일, the business is treated as continued (e.g. 미니스톱 → 세븐일레븐 인수, GS25 ↔ CU 전환).
- Coverage caveat: 담배소매업 was collected as "인허가 2016+ all, earlier only if still open", so stores opened before
  2016 and closed before today are missing from the neighbour counts (biggest for the 2018 cohort).

Run: ml/.venv/Scripts/python ml/survival_cvs_v0.py
"""
import json
import re

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.neighbors import KDTree

from common import OUT, q
from survival_v0 import DAY0, LicenseIndex, days

R = 300
SWITCH_M = 20
BRANDS = [
    ("GS25", re.compile(r"GS\s?25|지에스\s?25|지에스\(GS\)25", re.I)),
    ("CU", re.compile(r"(^|[^A-Za-z])CU([^A-Za-z]|$)|씨유|훼미리마트")),
    ("세븐일레븐", re.compile(r"세븐일레븐|7-?eleven|코리아세븐", re.I)),
    ("이마트24", re.compile(r"이마트\s?24|위드미", re.I)),
    ("미니스톱", re.compile(r"미니스톱")),
]


def brand_of(name: str | None) -> str:
    for b, rx in BRANDS:
        if isinstance(name, str) and rx.search(name):
            return b
    return "기타"


NAMES = ["active_all_300", "active_cvs_300", "same_brand_300", "active_cvs_100", "opened_cvs_12m_300",
         "closed_cvs_12m_300", "hist_close3y_rt_300", "hist_n_300", "nearest_cvs_m", "food_active_300"]
X_COLS = NAMES + ["churn_12m", "open_month", "brand", "sido_nm"]


class CvsIndex:
    """All 담배소매업 licenses (편의점 + 슈퍼·마트 등) with a KD-tree, plus the 음식점 index as a demand proxy.
    Shared by training and serving (serve.py)."""

    def __init__(self, food: LicenseIndex | None = None):
        lic = q("""
            select mgt_no, bplc_nm, apv_perm_ymd, dcb_ymd, trd_state_nm, sido_nm, lon, lat
            from license_event where opn_svc_id = 'tobacco_retailers' and lon is not null and lat is not null and apv_perm_ymd >= '1990'""")
        lic["open_d"] = days(lic.apv_perm_ymd)
        lic["close_d"] = np.where(lic.trd_state_nm == "폐업", days(lic.dcb_ymd), np.nan)
        lic = lic[lic.open_d.notna()].reset_index(drop=True)
        lic["brand"] = [brand_of(n) for n in lic.bplc_nm]
        self.lic = lic
        self.xy = LicenseIndex.to_xy(lic.lon.values, lic.lat.values)
        self.tree = KDTree(self.xy)
        self.open_d = lic.open_d.values
        close = lic.close_d.values.copy()
        # 간판 교체·양도: a new license right next door around the 폐업일 means the shop kept trading
        closed_idx = np.where(~np.isnan(close))[0]
        nbrs = self.tree.query_radius(self.xy[closed_idx], r=SWITCH_M)
        switched = np.zeros(len(lic), bool)
        for i, nb in zip(closed_idx, nbrs):
            nb = nb[nb != i]
            if len(nb) and ((self.open_d[nb] >= close[i] - 30) & (self.open_d[nb] <= close[i] + 120)).any():
                switched[i] = True
        self.switched = switched
        # two closing dates: the license's own (for "who is open at t" counts, so a switched shop is not counted
        # twice next to its successor) and the business's (label + real-closure counts: a switch is not a closure)
        self.license_close = np.where(np.isnan(close), np.inf, close)
        self.true_close = np.where(np.isnan(close) | switched, np.inf, close)
        self.is_cvs = (lic.brand != "기타").values
        self.brand = lic.brand.values
        self.closed_3y = self.true_close < self.open_d + 3 * 365
        self.food = food or LicenseIndex()

    def features(self, nb: np.ndarray, d: np.ndarray, t: float, brand: str, lon: float, lat: float) -> list[float]:
        open_d, close = self.open_d[nb], self.true_close[nb]
        active = (open_d < t) & (self.license_close[nb] >= t)
        cvs = self.is_cvs[nb]
        hist = cvs & (open_d >= t - 6 * 365) & (open_d < t - 3 * 365)
        ac = active & cvs
        fnb = self.food.tree.query_radius(self.food.to_xy([lon], [lat]), r=R)[0]
        f_active = ((self.food.open_d[fnb] < t) & (self.food.close_or_inf[fnb] >= t)).sum()
        return [
            active.sum(),
            ac.sum(),
            (ac & (self.brand[nb] == brand)).sum(),
            (ac & (d <= 100)).sum(),
            (cvs & (open_d >= t - 365) & (open_d < t)).sum(),
            (cvs & (close >= t - 365) & (close < t)).sum(),
            self.closed_3y[nb][hist].mean() if hist.any() else np.nan,
            hist.sum(),
            d[ac].min() if ac.any() else R * 1.5,
            f_active,
        ]


def add_derived(df: pd.DataFrame) -> pd.DataFrame:
    df["churn_12m"] = (df.opened_cvs_12m_300 + df.closed_cvs_12m_300) / (df.active_cvs_300 + 1)
    return df


def build_features(ix: CvsIndex) -> pd.DataFrame:
    lic = ix.lic
    cohort = lic.index[ix.is_cvs & (lic.apv_perm_ymd >= "2018").values & (lic.apv_perm_ymd < "2023").values].values
    feats = np.full((len(cohort), len(NAMES)), np.nan)
    nbrs, dists = ix.tree.query_radius(ix.xy[cohort], r=R, return_distance=True)
    for k, (i, nb, d) in enumerate(zip(cohort, nbrs, dists)):
        keep = nb != i
        feats[k] = ix.features(nb[keep], d[keep], ix.open_d[i], ix.brand[i], lic.lon[i], lic.lat[i])
        if k % 10000 == 0:
            print(f"features {k}/{len(cohort)}", flush=True)
    df = pd.concat([lic.loc[cohort].reset_index(drop=True), pd.DataFrame(feats, columns=NAMES)], axis=1)
    df["y"] = ix.closed_3y[cohort].astype(int)
    df["switched"] = ix.switched[cohort]
    df["open_month"] = df.apv_perm_ymd.str[5:7].astype(int)
    add_derived(df)
    for c in ["brand", "sido_nm"]:
        df[c] = df[c].fillna("NA").astype("category")
    return df


def main():
    ix = CvsIndex()
    df = build_features(ix)
    df.to_pickle(OUT / "survival_cvs_v0_features.pkl")
    # 2018 cohort is left out of training: its neighbour counts are the most undercounted (see caveat). Test 0.593 vs 0.582.
    tr = df[(df.apv_perm_ymd >= "2019") & (df.apv_perm_ymd < "2021")]
    va = df[(df.apv_perm_ymd >= "2021") & (df.apv_perm_ymd < "2021-07")]
    te = df[df.apv_perm_ymd >= "2021-07"]
    model = lgb.LGBMClassifier(n_estimators=4000, learning_rate=0.01, num_leaves=15, min_child_samples=300,
                               subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
    model.fit(tr[X_COLS], tr.y, eval_X=va[X_COLS], eval_y=va.y, eval_metric="auc", callbacks=[lgb.early_stopping(300, verbose=False)])
    p = model.predict_proba(te[X_COLS])[:, 1]
    model.booster_.save_model(str(OUT / "survival_cvs_v0.txt"))
    te = te.assign(p=p, decile=pd.qcut(p, 10, labels=False, duplicates="drop") + 1)
    imp = pd.Series(model.booster_.feature_importance("gain"), index=X_COLS)
    closed_raw = np.isfinite(np.where(ix.lic.trd_state_nm.values == "폐업", 1.0, np.inf))
    report = {
        "cohort": "편의점(담배소매업 중 5대 브랜드 상호) 인허가 2018-01 ~ 2022-12, 좌표 있음",
        "label": "인허가 후 3년 안 실제 폐업 (20m 안 120일 내 재허가 = 간판 교체·양도로 보고 제외)",
        "switch_share_of_closures": round(float(ix.switched[closed_raw].mean()), 3),
        "rows": {"train(2019-2020)": len(tr), "valid(2021H1)": len(va), "test(2021H2-2022)": len(te)},
        "base_close3y_rate_test": round(float(te.y.mean()), 3),
        "auc_test": round(roc_auc_score(te.y, p), 3),
        "auc_hist_rate_only": round(roc_auc_score(te.y[te.hist_close3y_rt_300.notna()], te.hist_close3y_rt_300.dropna()), 3),
        "close3y_by_brand_test": te.groupby("brand", observed=True).y.agg(["size", "mean"]).round(3).reset_index().to_dict(orient="records"),
        "best_iteration": model.best_iteration_,
        "close3y_by_predicted_decile": te.groupby("decile").agg(n=("y", "size"), pred=("p", "mean"), actual=("y", "mean")).round(3).reset_index().to_dict(orient="records"),
        "top_features_gain_share": (imp / imp.sum()).sort_values(ascending=False).round(3).head(10).to_dict(),
        "caveat": "2016년 이전 개업 후 폐업한 점포는 수집 범위 밖이라 과거 시점의 주변 점포 수가 조금 적게 잡힌다 (2018 코호트에서 가장 큼)",
    }
    (OUT / "survival_cvs_v0_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
