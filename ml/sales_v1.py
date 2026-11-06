"""매출 예측 v1 (신규 출점 예상 매출): 매장 단위 실제 카드매출로 학습한 LightGBM.

정답: KB카드 가맹점 월 매출(사내 data/internal.sqlite card_sales_m)의 매장별 월평균 (3개월 이상 매출이 있는 매장).
v0(서울시 상권 × 업종 "평균 점포 매출")와 달리 매장 하나하나가 정답이다.

변수 (모두 "새 자리에 문을 연다면" 그 시점에 알 수 있는 것):
  업종(KB 분류), 프랜차이즈 여부, 브랜드(상호 → 공정위 브랜드 별칭), 층(상가정보 PNU+상호 연결), 시도
  주변 격자(약 250m 칸, 3×3 = 약 750m): 전체 매장 수·같은 업종 수·같은 업종 매출 중앙값·전체 매출 합 (자기 자신 제외)
  법정동: 국민연금 300인 이하 사업장 가입자·월 소득 추정, 주민등록 인구·세대당 인구
  매장 고객 구성(연령·시간대 비중)은 문을 열기 전엔 모르는 값이라 쓰지 않는다.

검증: 시군구 단위로 나눈다 (검증 시군구의 매장·이웃 정보는 학습에 없음). 시험 15% · 검증 10% · 학습 75%.
비교 기준: 업종 중앙값, 주변 같은 업종 중앙값(없으면 업종 중앙값).
Run: ml/.venv/Scripts/python ml/sales_v1.py
"""
import json
import re
import sqlite3
import unicodedata

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import DB, OUT, ROOT

INTERNAL = ROOT / "data" / "internal.sqlite"
CELL = 0.0025  # 약 250m (위도 기준)
MIN_MONTHS = 3
MIN_AMT = 300_000  # KB카드 월평균 30만 원 미만은 사실상 휴업·부업 매장으로 보고 뺀다
BRAND_MIN = 30  # 학습 매장이 이보다 적은 브랜드는 "기타 브랜드"로
FEATS = ["kb_ind", "franchise", "brand", "floor", "sido",
         "nb_stores", "nb_same", "nb_same_med", "nb_amt_sum", "cell_stores", "cell_same",
         "nps_members", "nps_income", "res_pop", "res_pph"]
CATS = ["kb_ind", "brand", "floor", "sido"]


def norm_name(s: str) -> str:
    """서버 brand-name.ts normName과 같은 정규화"""
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"^\(?주\)|\(주\)$", "", s)
    return re.sub(r"[^0-9a-z가-힣]", "", s)


def brand_matcher():
    """상호 → 공정위 대표 브랜드. 별칭 표에서 가장 긴 접두어 (짧은·파생 별칭은 뒤가 비었거나 '…점'일 때만)."""
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        al = pd.read_sql_query("select alias, group_nm, kind from brand_alias", con)
    table = {a: (g, k) for a, g, k in al.itertuples(index=False)}
    lens = sorted({len(a) for a in table}, reverse=True)

    def match(name: str):
        n = norm_name(name)
        for L in lens:
            if L > len(n):
                continue
            hit = table.get(n[:L])
            if not hit:
                continue
            g, kind = hit
            rest = n[L:]
            short = (re.fullmatch(r"[가-힣]{1,2}", n[:L]) or re.fullmatch(r"[a-z0-9]{1,3}", n[:L]))
            if (short or kind == "derived") and rest and not rest.endswith("점"):
                continue
            if re.fullmatch(r"[a-z0-9]+", n[:L]) and re.match(r"[a-z]", rest):
                continue
            return g
        return None

    return match


def floors() -> dict:
    """상가정보 층 (PNU + 정규화 상호) → 지하 / 1층 / 2층 / 3층 이상"""
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        st = pd.read_sql_query("select lno_cd pnu, bizes_nm, flr_no from store where lno_cd is not null and flr_no is not null", con)

    def bucket(f: str) -> str:
        f = str(f).strip()
        if re.match(r"^(B|지하|-)", f, re.I):
            return "B"
        m = re.match(r"(\d+)", f)
        if not m:
            return "?"
        n = int(m.group(1))
        return "1" if n <= 1 else "2" if n == 2 else "3+"

    return {f"{p}|{norm_name(n)}": bucket(f) for p, n, f in st.itertuples(index=False)}


def metrics(y_log: np.ndarray, p_log: np.ndarray) -> dict:
    y, p = np.expm1(y_log), np.expm1(p_log)
    ape = np.abs(p - y) / y
    return {
        "r2_log": round(float(1 - ((y_log - p_log) ** 2).sum() / ((y_log - y_log.mean()) ** 2).sum()), 3),
        "mape_median": round(float(np.median(ape)), 3),
        "within_30pct": round(float((ape <= 0.3).mean()), 3),
        "within_50pct": round(float((ape <= 0.5).mean()), 3),
        "n": int(len(y)),
    }


def stores() -> pd.DataFrame:
    with sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True) as con:
        df = pd.read_sql_query(f"""
            select store_key, max(name) name, max(pnu) pnu, max(kb_ind) kb_ind, max(franchise) franchise, max(bjd_cd) bjd_cd,
                   avg(lon) lon, avg(lat) lat, avg(amt) amt, count(*) months
            from card_sales_m where amt > 0 and lon is not null
            group by store_key having count(*) >= {MIN_MONTHS}""", con)
    n0 = len(df)
    df = df[df.amt >= MIN_AMT].copy()
    print(f"월평균 {MIN_AMT:,}원 미만 {n0 - len(df):,}곳 제외 ({(n0 - len(df)) / n0:.1%})")
    df["sgg"] = df.bjd_cd.str[:5]
    df["sido"] = df.bjd_cd.str[:2]
    match = brand_matcher()
    df["brand"] = [match(n) for n in df.name]
    fl = floors()
    df["floor"] = [fl.get(f"{p}|{norm_name(n)}", "?") for p, n in zip(df.pnu, df.name)]
    print(f"브랜드 잡힘 {df.brand.notna().mean():.1%}, 층 연결 {(df.floor != '?').mean():.1%}")
    return df


def neighbours(df: pd.DataFrame) -> pd.DataFrame:
    """격자 칸 단위 집계 → 3×3 칸 합에서 자기 자신을 뺀다."""
    df["cx"] = np.floor(df.lon / (CELL * 1.25)).astype(int)  # 경도 1도가 위도 1도보다 짧다 (한국 위도 약 0.8배)
    df["cy"] = np.floor(df.lat / CELL).astype(int)
    cell = df.groupby(["cx", "cy"]).agg(c_n=("amt", "size"), c_sum=("amt", "sum")).reset_index()
    cell_ind = df.groupby(["cx", "cy", "kb_ind"]).agg(ci_n=("amt", "size")).reset_index()
    rows = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            rows.append(cell.assign(cx=cell.cx + dx, cy=cell.cy + dy))
    nb = pd.concat(rows).groupby(["cx", "cy"]).agg(nb_n=("c_n", "sum"), nb_sum=("c_sum", "sum")).reset_index()
    rows = [cell_ind.assign(cx=cell_ind.cx + dx, cy=cell_ind.cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
    nbi = pd.concat(rows).groupby(["cx", "cy", "kb_ind"]).agg(nbi_n=("ci_n", "sum")).reset_index()
    df = (df.merge(nb, on=["cx", "cy"], how="left").merge(nbi, on=["cx", "cy", "kb_ind"], how="left")
            .merge(cell, on=["cx", "cy"], how="left").merge(cell_ind, on=["cx", "cy", "kb_ind"], how="left"))
    df["nb_stores"] = df.nb_n - 1
    df["nb_same"] = df.nbi_n - 1
    df["nb_amt_sum"] = df.nb_sum - df.amt
    df["cell_stores"] = df.c_n - 1
    df["cell_same"] = df.ci_n - 1

    # 같은 업종 이웃 매출 중앙값 (자기 제외): 3×3 칸의 같은 업종 매장 매출을 모아 중앙값
    key = df[["cx", "cy", "kb_ind", "amt"]].copy()
    exp = pd.concat([key.assign(cx=key.cx + dx, cy=key.cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    med = exp.groupby(["cx", "cy", "kb_ind"]).amt.median().rename("nb_same_med_incl").reset_index()
    df = df.merge(med, on=["cx", "cy", "kb_ind"], how="left")
    # 자기 자신이 섞인 중앙값: 같은 업종 이웃이 적을수록 자기 값의 영향이 커서, 이웃이 4곳 미만이면 비운다
    df["nb_same_med"] = np.where(df.nb_same >= 4, df.nb_same_med_incl, np.nan)
    return df


def public_feats(df: pd.DataFrame) -> pd.DataFrame:
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        nps = pd.read_sql_query("""
            select bjd_cd, sum(case when members <= 300 then members else 0 end) nps_members,
                   sum(case when members <= 300 then bill else 0 end) * 1.0
                     / nullif(sum(case when members <= 300 then members else 0 end), 0) / 0.095 nps_income
            from nps_workplace group by bjd_cd""", con)
        res = pd.read_sql_query("""
            select stdg_cd bjd_cd, tot res_pop, hh_nmpr res_pph from resident_pop_bjd
            where stats_ym = (select max(stats_ym) from resident_pop_bjd)""", con)
    return df.merge(nps, on="bjd_cd", how="left").merge(res, on="bjd_cd", how="left")


def main():
    df = stores()
    print(f"매장 {len(df):,} (월매출 {MIN_MONTHS}개월 이상)")
    df = public_feats(neighbours(df))
    df["y"] = np.log1p(df.amt)
    # 매장이 적은 브랜드는 하나로 (과적합 방지), 브랜드 없음은 "-"
    cnt = df.brand.value_counts()
    df["brand"] = np.where(df.brand.isna(), "-", np.where(df.brand.map(cnt).fillna(0) >= BRAND_MIN, df.brand, "기타 브랜드"))
    for c in CATS:
        df[c] = df[c].astype("category")

    # 시군구 단위 분할
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    n = len(sggs)
    test_sgg, valid_sgg = set(sggs[: int(n * 0.15)]), set(sggs[int(n * 0.15): int(n * 0.25)])
    part = np.where(df.sgg.isin(test_sgg), "test", np.where(df.sgg.isin(valid_sgg), "valid", "train"))
    tr, va, te = df[part == "train"], df[part == "valid"], df[part == "test"]

    model = lgb.train(
        {"objective": "regression", "learning_rate": 0.05, "num_leaves": 127, "min_data_in_leaf": 100,
         "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1},
        lgb.Dataset(tr[FEATS], tr.y, categorical_feature=CATS),
        num_boost_round=3000,
        valid_sets=[lgb.Dataset(va[FEATS], va.y, categorical_feature=CATS)],
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )
    p = model.predict(te[FEATS], num_iteration=model.best_iteration)
    resid = va.y - model.predict(va[FEATS], num_iteration=model.best_iteration)

    ind_med = tr.groupby("kb_ind", observed=True).y.median()
    base_ind = te.kb_ind.map(ind_med).astype(float).fillna(tr.y.median()).to_numpy()
    base_nb = np.where(te.nb_same_med.notna(), np.log1p(te.nb_same_med.fillna(0)), base_ind)

    gain = model.feature_importance("gain")
    report = {
        "stores": {"train": len(tr), "valid": len(va), "test": len(te)},
        "split": "시군구 단위 (시험 15%, 검증 10%)",
        "baseline_industry_median": metrics(te.y.to_numpy(), base_ind),
        "baseline_neighbour_same_industry_median": metrics(te.y.to_numpy(), base_nb),
        "model": {**metrics(te.y.to_numpy(), p), "best_iteration": model.best_iteration,
                  "resid_log_q10": round(float(np.quantile(resid, 0.1)), 4), "resid_log_q90": round(float(np.quantile(resid, 0.9)), 4)},
        "by_franchise": {
            str(k): metrics(te.y.to_numpy()[m], p[m]) for k, m in [("franchise", te.franchise.to_numpy() == 1), ("independent", te.franchise.to_numpy() == 0)]
        },
        "top_features_gain_share": dict(sorted(((f, round(float(g / gain.sum()), 3)) for f, g in zip(FEATS, gain)), key=lambda x: -x[1])[:10]),
    }
    model.save_model(str(OUT / "sales_v1.txt"), num_iteration=model.best_iteration)
    (OUT / "sales_v1_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
