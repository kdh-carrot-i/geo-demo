"""편의점 모델 실험: 약 750m 격자 대신 100~300m 안 경쟁·상권 변수를 넣으면 나아지는가.

재료: 카드 편의점 매장(세븐일레븐 포함) + k7_cvs 2026-09(CU·GS25·이마트24 전체 위치·서비스).
같은 시군구 분할, 새 자리 조건(가게 나이 24개월)으로 기존 v3 변수와 비교하고, 주변 중앙값과 같은 가게로 견준다.
v3.build는 13분 걸려 data/v3_build.pkl에 저장해 다시 쓴다 (--refresh로 다시 만든다).
Run: ml/.venv/Scripts/python -u ml/cvs_micro.py → ml/out/cvs_micro_report.json
"""
import json
import subprocess
import sys

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import sales_v3 as v3
from common import OUT, ROOT

CACHE = ROOT / "data" / "v3_build.pkl"
K7 = ROOT / "data" / "cvs_points.csv"
SELF_M = 20
R = ("100", "200", "300", "500")


def xy(lat, lon):
    return np.c_[np.radians(lon) * 6371000 * np.cos(np.radians(36.5)), np.radians(lat) * 6371000]


def build():
    if CACHE.exists() and "--refresh" not in sys.argv:
        return pd.read_pickle(CACHE)
    df = v3.build().reset_index(drop=True)
    df.to_pickle(CACHE)
    return df


def add_micro(te_all):
    d = te_all
    cv = d[d.kb_ind.astype(str) == "유통|편의점"]
    k7 = pd.read_csv(K7)
    pts = pd.concat([cv[["lat", "lon"]].assign(brand=cv.brand.astype(str)), k7[["lat", "lon", "brand"]]], ignore_index=True)
    pts["k"] = pts.lat.round(4).astype(str) + "," + pts.lon.round(4).astype(str)
    pts = pts.drop_duplicates("k")
    tree = cKDTree(xy(pts.lat.to_numpy(), pts.lon.to_numpy()))
    allt = cKDTree(xy(d.lat.to_numpy(), d.lon.to_numpy()))
    amt = d.amt.to_numpy(float)
    g = d[d.group == "편의점·슈퍼"].copy()
    q = xy(g.lat.to_numpy(), g.lon.to_numpy())
    # 자기 위치(20m 안)는 뺀다
    for r in R:
        g[f"cvs_{r}"] = tree.query_ball_point(q, float(r), return_length=True) - tree.query_ball_point(q, SELF_M, return_length=True)
    dist, _ = tree.query(q, k=8)
    g["cvs_near"] = [next((x for x in row if x > SELF_M), np.nan) for row in dist]
    for r in ("100", "200", "300"):
        lists = allt.query_ball_point(q, float(r))
        g[f"all_{r}"] = [len(x) - 1 for x in lists]
        g[f"all_amt_{r}"] = [np.log1p(amt[x].sum()) for x in lists]  # 자기 매출은 아래에서 뺀다
    own = g.amt.to_numpy(float)
    for r in ("100", "200", "300"):
        g[f"all_amt_{r}"] = np.log1p(np.maximum(np.expm1(g[f"all_amt_{r}"]) - own, 0))
    return g


def fit(tr, va, feats):
    cats = [c for c in v3.CATS if c in feats]
    p = {"objective": "regression", "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 50, "feature_fraction": 0.8,
         "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1}
    return lgb.train(p, lgb.Dataset(tr[feats], tr.y, categorical_feature=cats), num_boost_round=3000,
                     valid_sets=[lgb.Dataset(va[feats], va.y, categorical_feature=cats)], callbacks=[lgb.early_stopping(100, verbose=False)])


def err(y, p):
    a, b = np.expm1(y), np.expm1(p)
    e = np.abs(b - a) / a
    return {"n": int(len(a)), "err": round(float(np.median(e)), 3), "within_30": round(float((e <= .3).mean()), 3), "ratio": round(float(np.median(b / a)), 3)}


def main():
    df = build()
    v3.step(f"변수 {len(df):,}")
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    n = len(sggs)
    test, valid = set(sggs[: int(n * .15)]), set(sggs[int(n * .15): int(n * .25)])
    g = add_micro(df)
    v3.step(f"좁은 범위 변수 {len(g):,}")
    tr, va, te = g[~g.sgg.isin(test | valid)], g[g.sgg.isin(valid)], g[g.sgg.isin(test)]
    MICRO = [f"cvs_{r}" for r in R] + ["cvs_near"]
    AREA = [f"all_{r}" for r in ("100", "200", "300")] + [f"all_amt_{r}" for r in ("100", "200", "300")]
    new = te.assign(store_age_m=24.0)
    rep = {}
    masks = {"전체": np.ones(len(te), bool), "프랜차이즈": (te.franchise == 1).to_numpy()}
    med = te.nb_same_med.notna().to_numpy()
    for name, feats in (("기존", v3.FEATS), ("+경쟁", v3.FEATS + MICRO), ("+상권", v3.FEATS + AREA), ("+둘다", v3.FEATS + MICRO + AREA)):
        m = fit(tr, va, feats)
        p = m.predict(new[feats], num_iteration=m.best_iteration)
        rep[name] = {k: err(te.y.to_numpy()[x], p[x]) for k, x in masks.items()}
        rep[name]["같은가게"] = {k: err(te.y.to_numpy()[x & med], p[x & med]) for k, x in masks.items()}
        if name == "+둘다":
            gain = m.feature_importance("gain")
            rep["top"] = dict(sorted(((f, round(float(x / gain.sum()), 3)) for f, x in zip(feats, gain)), key=lambda x: -x[1])[:12])
        v3.step(f"{name} {json.dumps(rep[name], ensure_ascii=False)}")
    rep["주변 중앙값"] = {k: err(te.y.to_numpy()[x & med], np.log1p(te.nb_same_med.to_numpy()[x & med])) for k, x in masks.items()}
    (OUT / "cvs_micro_report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: rep[k] for k in ("주변 중앙값", "top")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
