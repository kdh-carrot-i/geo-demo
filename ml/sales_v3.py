"""매출 예측 v3: v2 변수 + 자리의 미세한 조건 + 업종 묶음별 모델.

v2(sales_v2.py) 변수에 더하는 것:
  가게      개업 후 개월 수(인허가일, 음식점·카페·담배), 층(link_floor.py로 넓힌 연결)
  건물      필지의 건물 수·연면적·건물 나이·대표 주용도·주차대수 (건축물대장 표제부, bld_pnu)
  땅        도로 접면 등급(광대로·중로·소로·세로)·코너(각지)·용도지역·지형·공시지가 (토지특성, land_pnu)
  경쟁 구성  주변 같은 업종 중 가맹 브랜드 비율, 주변 같은 브랜드 매장 수
업종 묶음(카페·디저트 / 음식점 / 편의점·슈퍼 / 기타)마다 따로 학습하고, 묶음별로 범위(10%·90%)도 따로 학습한다(분위수 회귀).
검증: v1·v2와 같은 시군구 분할 → 같은 시험 매장으로 비교. 변수 효과는 같은 시험 매장에서 그 변수를 비웠을 때와 비교한다.
Run: ml/.venv/Scripts/python -u ml/sales_v3.py
"""
import json
import sqlite3

import lightgbm as lgb
import numpy as np
import pandas as pd

import sales_v1 as v1
import sales_v2 as v2
from common import OUT, ROOT

INTERNAL = ROOT / "data" / "internal.sqlite"
REF_YM = "202609"
FEATS = v2.FEATS + [
    "store_age_m", "bld_n", "bld_area", "bld_age", "bld_use", "bld_parking",
    "road_class", "corner", "use_zone", "land_height", "land_fig", "land_price",
    "nb_branded_share", "nb_same_brand",
]
CATS = v2.CATS + ["bld_use", "road_class", "use_zone", "land_height", "land_fig"]
GROUPS = {
    "카페·디저트": lambda k: k in ("식생활|커피/음료전문점", "식생활|휴게음식점", "식생활|제과점/아이스크림점"),
    "음식점": lambda k: k in ("식생활|한식", "식생활|일반음식점 기타", "식생활|일반주점", "식생활|중식", "식생활|일식/생선회집",
                            "식생활|패스트푸드점", "식생활|양식", "식생활|부페", "식생활|패밀리레스토랑"),
    "편의점·슈퍼": lambda k: k in ("유통|편의점", "유통|슈퍼마켓"),
}
step = v2.step
# 모델 파일 이름 (LightGBM은 한글 경로에 파일을 쓰지 못한다)
SLUG = {"카페·디저트": "cafe", "음식점": "food", "편의점·슈퍼": "cvs", "기타": "other"}


def group_of(k: str) -> str:
    return next((g for g, f in GROUPS.items() if f(k)), "기타")


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def add_store_extra(df):
    with ro(INTERNAL) as con:
        lic = pd.read_sql_query("select store_key, apv_ymd from store_area where apv_ymd is not null", con)
        fl = pd.read_sql_query("select store_key, floor floor2 from store_floor", con)
    lic["d"] = pd.to_datetime(lic.apv_ymd.str[:10], errors="coerce")
    ref = pd.Timestamp(f"{REF_YM[:4]}-{REF_YM[4:]}-01")
    lic["store_age_m"] = ((ref - lic.d).dt.days / 30.44).clip(lower=0)
    df = df.merge(lic[["store_key", "store_age_m"]].drop_duplicates("store_key"), on="store_key", how="left")
    df = df.merge(fl.drop_duplicates("store_key"), on="store_key", how="left")
    # 넓힌 층 연결이 있으면 그것을 쓴다 (v1은 PNU+상호 정확 일치만)
    df["floor"] = df.floor2.fillna(df.floor.astype(str)).replace({"nan": "?"})
    return df.drop(columns=["floor2"])


def add_building(df):
    with ro(INTERNAL) as con:
        b = pd.read_sql_query("select pnu, buildings bld_n, tot_area bld_area, first_year, main_use bld_use, parking bld_parking from bld_pnu", con)
    b["bld_age"] = 2026 - b.first_year
    return df.merge(b.drop(columns=["first_year"]), on="pnu", how="left")


def add_land(df):
    with ro(INTERNAL) as con:
        land = pd.read_sql_query("select pnu, road_class, corner, use_zone, land_height, land_fig, price land_price from land_pnu", con)
    return df.merge(land, on="pnu", how="left")


def add_comp_brands(df):
    """주변 3×3 칸 같은 업종 중 가맹 브랜드 비율, 같은 브랜드 매장 수 (자기 제외)"""
    df = df.assign(kb_s=df.kb_ind.astype(str))
    b = df[["cx", "cy", "kb_s", "brand"]].assign(branded=df.brand.notna().astype(int))
    nine = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
    exp = pd.concat([b.assign(cx=b.cx + dx, cy=b.cy + dy) for dx, dy in nine])
    g = exp.groupby(["cx", "cy", "kb_s"]).agg(nbr=("branded", "sum"), nbn=("branded", "size")).reset_index()
    df = df.merge(g, on=["cx", "cy", "kb_s"], how="left")
    own = df.brand.notna().astype(int)
    df["nb_branded_share"] = ((df.nbr - own) / (df.nbn - 1)).where(df.nbn > 1)
    gb = exp.dropna(subset=["brand"]).groupby(["cx", "cy", "brand"]).size().rename("nsb").reset_index()
    df = df.merge(gb, on=["cx", "cy", "brand"], how="left")
    df["nb_same_brand"] = (df.nsb.fillna(0) - own).clip(lower=0).where(df.brand.notna(), 0)
    return df.drop(columns=["nbr", "nbn", "nsb", "kb_s"])


def build():
    # sales_v2.build는 브랜드를 학습용 범주(상위·기타·-)로 바꾸므로, 원래 브랜드 이름이 필요한 경쟁 구성은 그 전에 계산한다
    df = v1.stores()
    with ro(INTERNAL) as con:
        ksic = pd.read_sql_query("select store_key, max(ksic) ksic from card_sales_m group by store_key", con)
    df = v1.public_feats(v1.neighbours(df.merge(ksic, on="store_key", how="left")))
    df.loc[df.nb_stores + 1 < 5, "nb_amt_sum"] = np.nan
    step("주변 격자·공공 변수")
    df = add_comp_brands(df)
    for f in (v2.add_brand_ftc, v2.add_area, v2.add_shinhan, v2.add_walk, v2.add_kcb, v2.add_housing, add_store_extra, add_building, add_land):
        df = f(df)
        step(f"{f.__name__} 완료")
    df["y"] = np.log1p(df.amt)
    cnt = df.brand.value_counts()
    df["brand"] = np.where(df.brand.isna(), "-", np.where(df.brand.map(cnt).fillna(0) >= v1.BRAND_MIN, df.brand, "기타 브랜드"))
    df["group"] = df.kb_ind.astype(str).map(group_of)
    for c in CATS:
        df[c] = df[c].astype(str).replace({"nan": None, "None": None}).astype("category")
    return df


def fit(tr, va, objective="regression", alpha=None):
    params = {"objective": objective, "learning_rate": 0.05, "num_leaves": 255, "min_data_in_leaf": 100,
              "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1}
    if alpha is not None:
        params["alpha"] = alpha
    return lgb.train(params, lgb.Dataset(tr[FEATS], tr.y, categorical_feature=CATS), num_boost_round=4000,
                     valid_sets=[lgb.Dataset(va[FEATS], va.y, categorical_feature=CATS)],
                     callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(200)])


def ablate(model, te, cols):
    X = te[FEATS].copy()
    for c in cols:
        X[c] = np.nan if c not in CATS else pd.Categorical([None] * len(X), categories=te[c].cat.categories)
    return model.predict(X, num_iteration=model.best_iteration)


def main():
    df = build()
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    n = len(sggs)
    test_sgg, valid_sgg = set(sggs[: int(n * 0.15)]), set(sggs[int(n * 0.15): int(n * 0.25)])
    part = np.where(df.sgg.isin(test_sgg), "test", np.where(df.sgg.isin(valid_sgg), "valid", "train"))

    report = {"groups": {}, "split": "시군구 단위 (v1·v2와 같은 시드)"}
    v2_model = lgb.Booster(model_file=str(OUT / "sales_v2.txt"))
    for g in list(GROUPS) + ["기타"]:
        d = df[df.group == g]
        tr, va, te = d[part[df.group == g] == "train"], d[part[df.group == g] == "valid"], d[part[df.group == g] == "test"]
        step(f"[{g}] 학습 {len(tr):,} · 시험 {len(te):,}")
        m = fit(tr, va)
        q10, q90 = fit(tr, va, "quantile", 0.1), fit(tr, va, "quantile", 0.9)
        p = m.predict(te[FEATS], num_iteration=m.best_iteration)
        yt = te.y.to_numpy()
        lo = q10.predict(te[FEATS], num_iteration=q10.best_iteration)
        hi = q90.predict(te[FEATS], num_iteration=q90.best_iteration)
        fr = te.franchise.to_numpy() == 1
        # 같은 시험 매장, v2 모델 (v2 변수만)
        p2 = v2_model.predict(te[v2.FEATS])
        has_area, has_road = te.site_area.notna().to_numpy(), te.road_class.notna().to_numpy()
        gain = m.feature_importance("gain")
        report["groups"][g] = {
            "stores": {"train": len(tr), "test": len(te)},
            "v3": v1.metrics(yt, p), "v2_same_stores": v1.metrics(yt, p2),
            "v3_franchise": v1.metrics(yt[fr], p[fr]) if fr.sum() > 50 else None,
            "v3_independent": v1.metrics(yt[~fr], p[~fr]),
            "range_coverage_10_90": round(float(((yt >= lo) & (yt <= hi)).mean()), 3),
            # 같은 매장에서 그 변수만 비웠을 때 오차 (변수 효과)
            "ablation": {
                "site_area": {"with": v1.metrics(yt[has_area], p[has_area])["mape_median"], "without": v1.metrics(yt[has_area], ablate(m, te, ["site_area"])[has_area])["mape_median"]},
                "road_corner": {"with": v1.metrics(yt[has_road], p[has_road])["mape_median"], "without": v1.metrics(yt[has_road], ablate(m, te, ["road_class", "corner"])[has_road])["mape_median"]},
                "building": {"with": v1.metrics(yt, p)["mape_median"], "without": v1.metrics(yt, ablate(m, te, ["bld_n", "bld_area", "bld_age", "bld_use", "bld_parking"]))["mape_median"]},
            },
            "top_features": dict(sorted(((f, round(float(x / gain.sum()), 3)) for f, x in zip(FEATS, gain)), key=lambda x: -x[1])[:12]),
        }
        print(json.dumps({g: report["groups"][g]}, ensure_ascii=False, indent=1), flush=True)
        m.save_model(str(OUT / f"sales_v3_{SLUG[g]}.txt"), num_iteration=m.best_iteration)
        q10.save_model(str(OUT / f"sales_v3_{SLUG[g]}_q10.txt"), num_iteration=q10.best_iteration)
        q90.save_model(str(OUT / f"sales_v3_{SLUG[g]}_q90.txt"), num_iteration=q90.best_iteration)
    (OUT / "sales_v3_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    step("완료")


if __name__ == "__main__":
    main()
