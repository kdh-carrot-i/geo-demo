"""카페 생존 모델 v0: will a newly licensed 카페 close within 3 years? (nationwide, 휴게음식점 인허가)

Same approach as survival_cvs_v0 (편의점): every feature is computed as of the store's 인허가일 from other
licenses around it, so a planned site anywhere can be scored. 카페 = 휴게음식점 업태 '커피숍' (학습 대상) +
일반음식점 업태 '까페' (주변 경쟁 점포로만 셈).

Label differences from the 음식점 model:
- 간판 교체·양도 is not a closure: if another 카페 license opens within 20 m between 30 days before and
  120 days after the 폐업일, the business is treated as continued (e.g. 개인 카페 → 프랜차이즈 전환, 양도 후 재허가).
- Coverage caveat: 휴게음식점 was collected as "인허가 2016+ all, earlier only if still open", so cafes opened before
  2016 and closed before today are missing from the neighbour counts (biggest for the 2018 cohort).

Run: ml/.venv/Scripts/python ml/survival_cafe_v0.py
"""
import json
import re

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.neighbors import KDTree

from common import OUT, q
from survival_v0 import LicenseIndex, days

R = 300
SWITCH_M = 20
CAFE_UPTAE = ("커피숍", "까페")
# 2018~2022 휴게음식점 커피숍 인허가 상호 빈도 상위 브랜드
BRANDS = [
    ("메가커피", re.compile(r"메가\s?(엠지씨|MGC)?\s?커피|MEGA\s?(MGC\s?)?COFFEE", re.I)),
    ("컴포즈커피", re.compile(r"컴포즈|COMPOSE", re.I)),
    ("스타벅스", re.compile(r"스타벅스|STARBUCKS", re.I)),
    ("투썸플레이스", re.compile(r"투썸|A\s?TWOSOME", re.I)),
    ("빽다방", re.compile(r"빽다방")),
    ("이디야", re.compile(r"이디야|EDIYA", re.I)),
    ("더벤티", re.compile(r"더\s?벤티|THE\s?VENTI", re.I)),
    ("텐퍼센트", re.compile(r"텐퍼센트|10\s?%\s?커피", re.I)),
    ("매머드", re.compile(r"매머드|MAMMOTH", re.I)),
    ("공차", re.compile(r"공차|GONG\s?CHA", re.I)),
    ("하삼동커피", re.compile(r"하삼동")),
    ("우지커피", re.compile(r"우지\s?커피")),
    ("커피에반하다", re.compile(r"커피에\s?반하다")),
    ("커피베이", re.compile(r"커피\s?베이|COFFEE\s?BAY", re.I)),
    ("할리스", re.compile(r"할리스|HOLLYS", re.I)),
    ("파스쿠찌", re.compile(r"파스쿠찌|PASCUCCI", re.I)),
    ("엔제리너스", re.compile(r"엔제리너스|ANGEL-?IN-?US", re.I)),
    ("바나프레소", re.compile(r"바나프레소")),
    ("요거프레소", re.compile(r"요거프레소")),
    ("커피빈", re.compile(r"커피빈|COFFEE\s?BEAN", re.I)),
    ("탐앤탐스", re.compile(r"탐앤탐스|TOM\s?N\s?TOMS", re.I)),
]


def brand_of(*names: str | None) -> str:
    for n in names:
        for b, rx in BRANDS:
            if isinstance(n, str) and rx.search(n):
                return b
    return "기타"


NAMES = ["active_all_300", "active_cafe_300", "same_brand_300", "active_brand_cafe_300", "active_cafe_100",
         "opened_cafe_12m_300", "closed_cafe_12m_300", "hist_close3y_rt_300", "hist_n_300", "nearest_cafe_m",
         "food_active_300"]
X_COLS = NAMES + ["churn_12m", "open_month", "brand", "sido_nm"]


class CafeIndex:
    """All 휴게음식점 licenses + 일반음식점 '까페' with a KD-tree, plus the 음식점 index as a demand proxy.
    Shared by training and serving (serve.py)."""

    def __init__(self, food: LicenseIndex | None = None):
        lic = q("""
            select mgt_no, opn_svc_id, bplc_nm, uptae_nm, apv_perm_ymd, dcb_ymd, trd_state_nm, sido_nm, lon, lat
            from license_event
            where (opn_svc_id = 'rest_cafes' or (opn_svc_id = '07_24_04_P' and uptae_nm = '까페'))
              and lon is not null and lat is not null and apv_perm_ymd >= '1990'""")
        lic["open_d"] = days(lic.apv_perm_ymd)
        lic["close_d"] = np.where(lic.trd_state_nm == "폐업", days(lic.dcb_ymd), np.nan)
        lic = lic[lic.open_d.notna()].reset_index(drop=True)
        lic["brand"] = [brand_of(n) for n in lic.bplc_nm]
        self.lic = lic
        self.xy = LicenseIndex.to_xy(lic.lon.values, lic.lat.values)
        self.tree = KDTree(self.xy)
        self.open_d = lic.open_d.values
        self.is_cafe = lic.uptae_nm.isin(CAFE_UPTAE).values
        close = lic.close_d.values.copy()
        # 간판 교체·양도: a new 카페 license right next door around the 폐업일 means the shop kept trading
        # (a 카페 replaced by a 편의점·분식 is a real closure, so only 카페 successors count)
        closed_idx = np.where(~np.isnan(close) & self.is_cafe)[0]
        nbrs = self.tree.query_radius(self.xy[closed_idx], r=SWITCH_M)
        switched = np.zeros(len(lic), bool)
        for i, nb in zip(closed_idx, nbrs):
            nb = nb[(nb != i) & self.is_cafe[nb]]
            if len(nb) and ((self.open_d[nb] >= close[i] - 30) & (self.open_d[nb] <= close[i] + 120)).any():
                switched[i] = True
        self.switched = switched
        # two closing dates: the license's own (for "who is open at t" counts, so a switched shop is not counted
        # twice next to its successor) and the business's (label + real-closure counts: a switch is not a closure)
        self.license_close = np.where(np.isnan(close), np.inf, close)
        self.true_close = np.where(np.isnan(close) | switched, np.inf, close)
        self.brand = lic.brand.values
        self.closed_3y = self.true_close < self.open_d + 3 * 365
        self.food = food or LicenseIndex()

    def features(self, nb: np.ndarray, d: np.ndarray, t: float, brand: str, lon: float, lat: float) -> list[float]:
        open_d, close = self.open_d[nb], self.true_close[nb]
        active = (open_d < t) & (self.license_close[nb] >= t)
        cafe = self.is_cafe[nb]
        hist = cafe & (open_d >= t - 6 * 365) & (open_d < t - 3 * 365)
        ac = active & cafe
        fnb = self.food.tree.query_radius(self.food.to_xy([lon], [lat]), r=R)[0]
        f_active = ((self.food.open_d[fnb] < t) & (self.food.close_or_inf[fnb] >= t)).sum()
        return [
            active.sum(),
            ac.sum(),
            (ac & (self.brand[nb] == brand)).sum() if brand != "기타" else 0,
            (ac & (self.brand[nb] != "기타")).sum(),
            (ac & (d <= 100)).sum(),
            (cafe & (open_d >= t - 365) & (open_d < t)).sum(),
            (cafe & (close >= t - 365) & (close < t)).sum(),
            self.closed_3y[nb][hist].mean() if hist.any() else np.nan,
            hist.sum(),
            d[ac].min() if ac.any() else R * 1.5,
            f_active,
        ]


def add_derived(df: pd.DataFrame) -> pd.DataFrame:
    df["churn_12m"] = (df.opened_cafe_12m_300 + df.closed_cafe_12m_300) / (df.active_cafe_300 + 1)
    return df


def build_features(ix: CafeIndex) -> pd.DataFrame:
    lic = ix.lic
    cohort = lic.index[(lic.opn_svc_id == "rest_cafes").values & (lic.uptae_nm == "커피숍").values
                       & (lic.apv_perm_ymd >= "2018").values & (lic.apv_perm_ymd < "2023").values].values
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
    ix = CafeIndex()
    df = build_features(ix)
    df.to_pickle(OUT / "survival_cafe_v0_features.pkl")
    # 2018 cohort is left out of training like the 편의점 model: its neighbour counts are the most undercounted.
    tr = df[(df.apv_perm_ymd >= "2019") & (df.apv_perm_ymd < "2021")]
    va = df[(df.apv_perm_ymd >= "2021") & (df.apv_perm_ymd < "2021-07")]
    te = df[df.apv_perm_ymd >= "2021-07"]
    # Early stopping on logloss, not AUC: AUC peaks after ~30 trees (brand does most of the ranking) and leaves the
    # probabilities squashed toward the mean (pred 0.21~0.28 vs actual 0.03~0.43 by decile); logloss gives the same AUC, calibrated.
    model = lgb.LGBMClassifier(n_estimators=4000, learning_rate=0.03, num_leaves=7, min_child_samples=500,
                               subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)
    model.fit(tr[X_COLS], tr.y, eval_X=va[X_COLS], eval_y=va.y, eval_metric="binary_logloss", callbacks=[lgb.early_stopping(300, verbose=False)])
    p = model.predict_proba(te[X_COLS])[:, 1]
    indep = (te.brand == "기타").values
    model.booster_.save_model(str(OUT / "survival_cafe_v0.txt"))
    te = te.assign(p=p, decile=pd.qcut(p, 10, labels=False, duplicates="drop") + 1)
    imp = pd.Series(model.booster_.feature_importance("gain"), index=X_COLS)
    closed_cafe = (ix.lic.trd_state_nm.values == "폐업") & ix.is_cafe
    report = {
        "cohort": "카페(휴게음식점 업태 '커피숍') 인허가 2018-01 ~ 2022-12, 좌표 있음",
        "label": "인허가 후 3년 안 실제 폐업 (20m 안 120일 내 카페 재허가 = 간판 교체·양도로 보고 제외)",
        "switch_share_of_closures": round(float(ix.switched[closed_cafe].mean()), 3),
        "rows": {"train(2019-2020)": len(tr), "valid(2021H1)": len(va), "test(2021H2-2022)": len(te)},
        "base_close3y_rate_test": round(float(te.y.mean()), 3),
        "auc_test": round(roc_auc_score(te.y, p), 3),
        "auc_test_brand_other": round(roc_auc_score(te.y[indep], p[indep]), 3),
        "auc_hist_rate_only": round(roc_auc_score(te.y[te.hist_close3y_rt_300.notna()], te.hist_close3y_rt_300.dropna()), 3),
        "close3y_by_brand_test": te.groupby("brand", observed=True).y.agg(["size", "mean"]).round(3).reset_index().to_dict(orient="records"),
        "best_iteration": model.best_iteration_,
        "close3y_by_predicted_decile": te.groupby("decile").agg(n=("y", "size"), pred=("p", "mean"), actual=("y", "mean")).round(3).reset_index().to_dict(orient="records"),
        # 브랜드 효과를 뺀 위치 변별력: 개인·기타 카페만 따로 10분위
        "close3y_by_predicted_decile_brand_other": te[indep].assign(decile=pd.qcut(p[indep], 10, labels=False) + 1).groupby("decile")
            .agg(n=("y", "size"), pred=("p", "mean"), actual=("y", "mean")).round(3).reset_index().to_dict(orient="records"),
        "top_features_gain_share": (imp / imp.sum()).sort_values(ascending=False).round(3).head(10).to_dict(),
        "caveat": "2016년 이전 개업 후 폐업한 카페는 수집 범위 밖이라 과거 시점의 주변 카페 수·선배 폐업률이 조금 틀어진다 (2018 코호트에서 가장 큼)",
    }
    (OUT / "survival_cafe_v0_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
