"""매출 기반 폐업 위험 v1: 신한 월 매출(2021-01~2025-04) ↔ 인허가 폐업일 (음식점·휴게음식점·담배소매).

매장 연결: 인허가 지번주소 → PNU + 정규화 상호 = store_key (link_area.py의 to_pnu, 신한 store_key의 앞부분과 같은 꼴).
시점을 둘 잡는다. 각 시점에 영업 중인(최근 3달 매출 있음 + 인허가 살아 있음) 가게가 다음 12개월 안에 폐업 신고했는가가 답.
  2023-04 시점 → 2023-05~2024-04 폐업 (학습)
  2024-04 시점 → 2024-05~2025-04 폐업 (시험: 나중 시점 + 학습에 없던 시군구)
모델 둘:
  궤적 모델(existing)  최근 12개월 매출 수준·최근 3달 추세·들쭉날쭉함·영업 달수 + 입지  → 이미 영업 중인 가게 진단용
  자리 모델(site)      매출 수준(동네 같은 업종 대비)·업종·면적·가게 나이·입지. 추세 없음  → 새 자리에는 예측 매출을 넣는다
신한 8,768만 행은 시점별 합계로 한 번만 줄여 data/closure_sh.pkl에 둔다 (--refresh로 다시 만든다). 집계에 상호는 남기지 않는다.
Run: ml/.venv/Scripts/python -u ml/closure_v1.py → ml/out/closure_v1_{existing,site}.txt, closure_v1_report.json
"""
import json
import pickle
import sqlite3
import sys
import time

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from common import DB, OUT, ROOT
from link_area import bjd_lookup, norm, to_pnu

INTERNAL = ROOT / "data" / "internal.sqlite"
CACHE = ROOT / "data" / "closure_sh.pkl"
SNAPS = {"202304": ("202205", "202302", "202305", "202404"), "202404": ("202305", "202402", "202405", "202504")}  # 시점: 12달 시작, 최근 3달 시작, 폐업 창 시작·끝
T0 = time.time()
CATS = ["group", "sido", "use_zone", "road_class", "bld_use"]
SITE = ["lamt", "rel_dong", "age_m", "site_area", "dong_same", "bld_n", "bld_area", "bld_age", "land_price", "corner"] + CATS
EXISTING = SITE + ["active_m", "trend_3", "cv"]
NO_SALES = [f for f in SITE if f not in ("lamt", "rel_dong")]  # 매출이 폐업 예측에 얼마나 보태는지 재는 비교용
YOUNG_M = 24
NOISE_SD = 0.8  # 예측 매출 오차 흉내: v3 오차 중앙값 약 50% ≈ 로그 표준편차 0.8
# 신한 업종 이름은 KB와 달라 따로 묶는다 (sales_v3.GROUPS와 같은 네 묶음)
SH_GROUP = {"커피전문점": "카페·디저트", "제과점": "카페·디저트",
            "한식": "음식점", "일반대중음식": "음식점", "중식": "음식점", "일식": "음식점", "양식": "음식점", "패스트푸드": "음식점", "부페": "음식점",
            "편의점": "편의점·슈퍼", "할인점/슈퍼마켓": "편의점·슈퍼", "연쇄점": "편의점·슈퍼"}


def step(m):
    print(f"[{time.time() - T0:7.0f}s] {m}", flush=True)


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def sales_snapshots() -> pd.DataFrame:
    if CACHE.exists() and "--refresh" not in sys.argv:
        return pd.read_pickle(CACHE)
    parts = []
    with ro(INTERNAL) as con:
        for t, (a, r, _, _) in SNAPS.items():
            step(f"신한 {t} 시점 집계")
            d = pd.read_sql_query(f"""
                select store_key, max(pnu) pnu, max(ind) ind, sum(amt) s12, count(*) active_m,
                       sum(case when ym >= '{r}' then amt else 0 end) s3, sum(case when ym >= '{r}' then 1 else 0 end) m3, sum(amt * 1.0 * amt) s2
                from sh_sales_m not indexed where ym between '{a}' and '{t}' and amt > 0 and store_key is not null
                group by store_key""", con)
            parts.append(d.assign(t=t))
    df = pd.concat(parts, ignore_index=True)
    df.to_pickle(CACHE)
    return df


def licenses() -> pd.DataFrame:
    with ro(DB) as con:
        lookup = bjd_lookup(con)
        lic = pd.read_sql_query("""
            select bplc_nm, site_area, apv_perm_ymd apv, dcb_ymd dcb, site_whl_addr
            from license_event where opn_svc_id in ('07_24_04_P', 'rest_cafes', 'tobacco_retailers')
              and (dcb_ymd is null or dcb_ymd = '' or dcb_ymd >= '2021-01-01')""", con)
    lic["pnu"] = [to_pnu(a, lookup) for a in lic.site_whl_addr]
    lic = lic.dropna(subset=["pnu"])
    lic["key"] = lic.pnu + "|" + lic.bplc_nm.map(norm)
    lic["dcb"] = lic.dcb.fillna("").str.replace("-", "").str[:6]
    lic["apv_m"] = lic.apv.fillna("").astype(str).str.replace("-", "").str[:6]
    return lic[["key", "site_area", "apv_m", "dcb"]]


def build() -> pd.DataFrame:
    sh = sales_snapshots()
    step(f"신한 시점 집계 {len(sh):,}행")
    sh["key"] = sh.store_key.str.split("|").str[0] + "|" + sh.store_key.str.split("|").str[1].map(norm)
    lic = licenses()
    step(f"인허가 {len(lic):,}건")
    rows = []
    for t, (_, _, w0, w1) in SNAPS.items():
        s = sh[(sh.t == t) & (sh.m3 > 0)]
        # 그 시점에 살아 있던 인허가 중 가장 늦게 난 것
        L = lic[(lic.apv_m <= t) & ((lic.dcb == "") | (lic.dcb > t))].sort_values("apv_m").drop_duplicates("key", keep="last")
        d = s.merge(L, on="key")
        d["closed"] = ((d.dcb >= w0) & (d.dcb <= w1)).astype(int)
        y, m = int(t[:4]), int(t[4:])
        ay, am = pd.to_numeric(d.apv_m.str[:4], errors="coerce"), pd.to_numeric(d.apv_m.str[4:], errors="coerce")
        d["age_m"] = (y - ay) * 12 + (m - am)
        rows.append(d)
    df = pd.concat(rows, ignore_index=True)
    step(f"연결 {len(df):,} · 폐업 비율 {df.closed.mean():.3f}")

    df["amt"] = df.s12 / df.active_m
    df["lamt"] = np.log1p(df.amt)
    prior = (df.s12 - df.s3) / (df.active_m - df.m3).clip(lower=1)
    df["trend_3"] = np.log1p(df.s3 / df.m3) - np.log1p(prior)
    var = (df.s2 / df.active_m - df.amt ** 2).clip(lower=0)
    df["cv"] = np.sqrt(var) / df.amt
    df["bjd"] = df.pnu.str[:10]
    df["group"] = df.ind.map(SH_GROUP).fillna("기타")
    g = df.groupby(["t", "bjd", "ind"]).lamt
    df["dong_same"] = g.transform("size")
    df["rel_dong"] = (df.lamt - g.transform("median")).where(df.dong_same >= 5)
    df["sido"], df["sgg"] = df.pnu.str[:2], df.pnu.str[:5]
    df.loc[df.site_area <= 0, "site_area"] = np.nan
    with ro(INTERNAL) as con:
        b = pd.read_sql_query("select pnu, buildings bld_n, tot_area bld_area, first_year, main_use bld_use from bld_pnu", con)
        land = pd.read_sql_query("select pnu, road_class, corner, use_zone, price land_price from land_pnu", con)
    b["bld_age"] = 2026 - b.first_year
    df = df.merge(b.drop(columns=["first_year"]), on="pnu", how="left").merge(land, on="pnu", how="left")
    for c in CATS:
        df[c] = df[c].astype(str).replace({"nan": None, "None": None}).astype("category")
    return df


def fit(tr, va, feats):
    p = {"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 200, "feature_fraction": 0.8,
         "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1}
    cats = [c for c in CATS if c in feats]
    return lgb.train(p, lgb.Dataset(tr[feats], tr.closed, categorical_feature=cats), num_boost_round=2000,
                     valid_sets=[lgb.Dataset(va[feats], va.closed, categorical_feature=cats)],
                     callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)])


def score(y, p):
    q = np.quantile(p, 0.9)
    return {"auc": round(float(roc_auc_score(y, p)), 3), "ap": round(float(average_precision_score(y, p)), 3), "base_rate": round(float(y.mean()), 3),
            "mean_pred": round(float(p.mean()), 3),
            "top10_rate": round(float(y[p >= q].mean()), 3), "bottom50_rate": round(float(y[p <= np.median(p)].mean()), 3)}


def main():
    df = build()
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    n = len(sggs)
    test_sgg, valid_sgg = set(sggs[: int(n * 0.15)]), set(sggs[int(n * 0.15): int(n * 0.25)])
    early = df.t == "202304"
    tr = df[early & ~df.sgg.isin(test_sgg | valid_sgg)]
    va = df[early & df.sgg.isin(valid_sgg)]
    te = df[~early & df.sgg.isin(test_sgg)]
    step(f"학습 {len(tr):,} · 검증 {len(va):,} · 시험 {len(te):,}")

    # 매출 수준 구간별 실제 폐업률 (모델 없이 본 관계)
    a = df[df.rel_dong.notna()]
    deciles = {}
    for g, x in a.groupby("group", observed=True):
        b = pd.qcut(x.rel_dong, 10, labels=False, duplicates="drop")
        deciles[g] = {int(k): round(float(v), 3) for k, v in x.groupby(b).closed.mean().items()}

    report = {"snapshots": SNAPS, "stores": {"train": len(tr), "valid": len(va), "test": len(te)}, "close_rate_by_rel_decile": deciles, "models": {}}
    for name, feats in (("existing", EXISTING), ("site", SITE), ("site_no_sales", NO_SALES)):
        step(f"{name} 학습")
        m = fit(tr, va, feats)
        p = m.predict(te[feats], num_iteration=m.best_iteration)
        y = te.closed.to_numpy()
        young = (te.age_m <= YOUNG_M).to_numpy()
        gain = m.feature_importance("gain")
        report["models"][name] = {
            "all": score(y, p),
            "by_group": {g: score(y[(te.group == g).to_numpy()], p[(te.group == g).to_numpy()]) for g in te.group.cat.categories if (te.group == g).sum() > 500},
            "young": score(y[young], p[young]),
            "top_features": dict(sorted(((f, round(float(x / gain.sum()), 3)) for f, x in zip(feats, gain)), key=lambda x: -x[1])[:10]),
        }
        if name == "site":
            # 새 자리에는 실제 매출이 없고 예측 매출이 들어간다: 시험 매장 매출에 그만큼 오차를 섞어 성능이 얼마나 남는지 본다
            e = np.random.default_rng(42).normal(0, NOISE_SD, len(te))
            noisy = te[feats].assign(lamt=te.lamt + e, rel_dong=te.rel_dong + e)
            pn = m.predict(noisy, num_iteration=m.best_iteration)
            report["models"][name]["noisy_sales"] = {"all": score(y, pn), "young": score(y[young], pn[young]),
                                                     "by_group": {g: score(y[(te.group == g).to_numpy()], pn[(te.group == g).to_numpy()]) for g in te.group.cat.categories if (te.group == g).sum() > 500}}
        print(json.dumps({name: report["models"][name]}, ensure_ascii=False, indent=1), flush=True)
        m.save_model(str(OUT / f"closure_v1_{name}.txt"), num_iteration=m.best_iteration)
    report["categories"] = {c: list(df[c].cat.categories) for c in CATS}
    (OUT / "closure_v1_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(OUT / "closure_v1_ref.pkl", "wb") as f:
        # 비교 기준: 개업 1년 안 가게의 업종 묶음별 다음 12개월 폐업률
        young = df[df.age_m <= 12].groupby("group", observed=True).closed.mean().round(3).to_dict()
        pickle.dump({"categories": report["categories"], "feats_site": SITE, "young_rate": young}, f)
    step("완료")


if __name__ == "__main__":
    main()
