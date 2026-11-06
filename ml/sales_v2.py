"""매출 예측 v2 (종합): 상권 + 유동인구 + 과거 매출 + 가맹 브랜드 + 매장 규모 + 배후 구매력.

정답: KB카드 가맹점 월평균 매출 (sales_v1과 같음, 3개월 이상·월 30만 원 이상).
총매출로 볼 때는 서울 상권 비교로 구한 환산 비율(sales_v1_calib.json)을 곱한다 — 모델은 KB 규모로 학습한다.

변수 묶음 (새 자리에 문을 연다면 그때 알 수 있는 것만):
  업종·브랜드  kb_ind, brand(상호 → 공정위 별칭), franchise, brand_avg_sales·brand_stores(공정위 최신 연도)
  매장 조건    floor(상가정보), site_area(인허가 소재지면적, 외식 위주)
  상권·경쟁    주변 약 750m 격자 매장 수·같은 업종 수·같은 업종 KB 매출 중앙값·전체 KB 매출 합 (sales_v1과 같음)
  과거 매출    같은 건물(PNU) 신한 매출 합(자기 제외, 최근 12개월 평균)·신한 매장 수, 주변 같은 업종 신한 매출 중앙값
  유동인구     반경 약 300m 격자 보행인구 합·점심/저녁 비중 (walk_pop_cell, 2022-05~2023-04)
  배후 구매력  KCB 거주·직장 동 평균 소득·카드소비, 국민연금 직장인·소득, 주민등록 인구
  동네 업종    KCB 소상공인 동 × 업종 대분류: 평균 사업소득·폐업률·연체 비율 (최근 12개월)
  미래 수요    1km 안 3년 내 입주 예정 세대 (주택인허가)

검증: 시군구 단위 분할 (sales_v1과 같은 시드) → v1과 같은 시험 매장으로 비교.
Run: ml/.venv/Scripts/python ml/sales_v2.py
"""
import json
import sqlite3
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

import sales_v1 as v1
from common import DB, OUT, ROOT

INTERNAL = ROOT / "data" / "internal.sqlite"
WALK_CELL = 0.003  # 약 300m (위도)
FEATS = v1.FEATS + [
    "brand_avg_sales", "brand_stores", "site_area",
    "pnu_sh_amt", "pnu_sh_n", "nb_sh_same_med",
    "walk_300", "walk_lunch", "walk_eve",
    "res_income", "res_spend", "work_income", "work_spend",
    "soho_income", "soho_close_rt", "soho_dlq_rt",
    "upcoming_hh_1km",
]
CATS = v1.CATS


T0 = time.time()


def step(msg):
    """진행 로그 (파일로 돌려도 바로 보이게)"""
    print(f"[{time.time() - T0:6.0f}s] {msg}", flush=True)


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def add_brand_ftc(df):
    with ro(DB) as con:
        b = pd.read_sql_query("""
            select m.group_nm brand, max(y.avrg_sls_amt) brand_avg_sales, max(y.frcs_cnt) brand_stores
            from brand_member m join franchise_brand_y y on y.brand_nm = m.brand_nm and y.yr = m.yr
            where m.yr = (select max(yr) from franchise_brand_y) group by m.group_nm""", con)
    b.loc[b.brand_avg_sales <= 0, "brand_avg_sales"] = np.nan
    return df.merge(b, on="brand", how="left")


def add_area(df):
    with ro(INTERNAL) as con:
        a = pd.read_sql_query("select store_key, site_area from store_area", con)
    return df.merge(a.drop_duplicates("store_key"), on="store_key", how="left")


def add_shinhan(df):
    """신한 최근 12개월: 같은 건물(PNU) 합(자기 제외), 주변 같은 업종 신한 중앙값 (KB 업종 기준으로 잇기 위해 KB 매장에 매칭된 것만)"""
    # sh_recent: 신한 마지막 12개월 매장별 평균 (8,768만 행을 월 인덱스로 무작위 읽으면 수 시간 걸려, 한 번 순차로 요약해 둔 표)
    with ro(INTERNAL) as con:
        sh = pd.read_sql_query("select store_key, pnu, amt sh_amt from sh_recent", con)
    pnu = sh.groupby("pnu").agg(p_sum=("sh_amt", "sum"), p_n=("sh_amt", "size")).reset_index()
    df = df.merge(pnu, on="pnu", how="left").merge(sh[["store_key", "sh_amt"]].drop_duplicates("store_key"), on="store_key", how="left")
    own = df.sh_amt.fillna(0)
    # 서빙 표와 같은 기준: 신한 매장 3곳 이상인 건물만 (한 매장 매출이 드러나지 않게)
    df["pnu_sh_amt"] = (df.p_sum.fillna(0) - own).where(df.p_n >= 3)
    df["pnu_sh_n"] = (df.p_n.fillna(0) - df.sh_amt.notna().astype(int)).where(df.p_n.notna())
    # 주변 같은 업종 신한 중앙값: KB 격자·업종 그대로, 신한 매출이 있는 KB 매장만
    key = df.loc[df.sh_amt.notna(), ["cx", "cy", "kb_ind", "sh_amt"]]
    exp = pd.concat([key.assign(cx=key.cx + dx, cy=key.cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    med = exp.groupby(["cx", "cy", "kb_ind"], observed=True).agg(m=("sh_amt", "median"), n=("sh_amt", "size")).reset_index()
    df = df.merge(med, on=["cx", "cy", "kb_ind"], how="left")
    df["nb_sh_same_med"] = df.m.where(df.n >= 5)
    return df.drop(columns=["p_sum", "p_n", "sh_amt", "m", "n"])


def add_walk(df):
    with ro(INTERNAL) as con:
        w = pd.read_sql_query("select lon, lat, walk, sh_1113, sh_1719 from walk_pop_cell where walk is not null", con)
    w["gx"] = np.floor(w.lon / (WALK_CELL * 1.25)).astype(int)
    w["gy"] = np.floor(w.lat / WALK_CELL).astype(int)
    w["l"] = w.walk * w.sh_1113.fillna(0)
    w["e"] = w.walk * w.sh_1719.fillna(0)
    g = w.groupby(["gx", "gy"]).agg(walk=("walk", "sum"), l=("l", "sum"), e=("e", "sum")).reset_index()
    nb = pd.concat([g.assign(gx=g.gx + dx, gy=g.gy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    nb = nb.groupby(["gx", "gy"]).sum().reset_index()
    df["gx"] = np.floor(df.lon / (WALK_CELL * 1.25)).astype(int)
    df["gy"] = np.floor(df.lat / WALK_CELL).astype(int)
    df = df.merge(nb, on=["gx", "gy"], how="left")
    df["walk_300"] = df.walk
    df["walk_lunch"] = df.l / df.walk
    df["walk_eve"] = df.e / df.walk
    return df.drop(columns=["gx", "gy", "walk", "l", "e"])


def add_kcb(df):
    df["dong8"] = df.pnu.str[:8]
    with ro(INTERNAL) as con:
        inc = pd.read_sql_query("select dong8, res_income, res_spend, work_income, work_spend from kcb_dong_income", con)
        last = con.execute("select max(ym) from kcb_soho_m").fetchone()[0]
        y0 = f"{int(last[:4]) - 1}{last[4:]}"
        soho = pd.read_sql_query(f"""
            select dong8, sic, avg(avg_biz_income) soho_income,
                   sum(biz_close_cnt) * 1.0 / nullif(sum(biz_cnt), 0) soho_close_rt,
                   sum(biz_dlq_cnt) * 1.0 / nullif(sum(biz_cnt), 0) soho_dlq_rt
            from kcb_soho_m where ym > '{y0}' group by dong8, sic""", con)
    df["sic"] = df.ksic.fillna("").str[:1]
    return df.merge(inc, on="dong8", how="left").merge(soho, on=["dong8", "sic"], how="left")


def add_housing(df):
    with ro(DB) as con:
        hp = pd.read_sql_query("""
            select lat, lon, hhld from housing_permit
            where lat is not null and use_inspt_day is null and use_inspt_sched_day >= strftime('%Y%m%d','now')""", con)
    df["upcoming_hh_1km"] = 0.0
    if hp.empty:
        return df
    cell = 0.01
    df["hx"], df["hy"] = np.floor(df.lon / cell).astype(int), np.floor(df.lat / cell).astype(int)
    out = np.zeros(len(df))
    idx = {k: g.index.to_numpy() for k, g in df.groupby(["hx", "hy"])}
    for lat, lon, hh in hp.itertuples(index=False):
        hx, hy = int(lon // cell), int(lat // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                ii = idx.get((hx + dx, hy + dy))
                if ii is None:
                    continue
                d = 6371000 * np.hypot(np.radians(df.lon.to_numpy()[ii] - lon) * np.cos(np.radians(lat)), np.radians(df.lat.to_numpy()[ii] - lat))
                out[ii[d <= 1000]] += hh
    df["upcoming_hh_1km"] = out
    return df.drop(columns=["hx", "hy"])


def build() -> pd.DataFrame:
    step("매장 불러오기")
    df = v1.stores()
    step(f"매장 {len(df):,}")
    with ro(INTERNAL) as con:
        ksic = pd.read_sql_query("select store_key, max(ksic) ksic from card_sales_m group by store_key", con)
    df = df.merge(ksic, on="store_key", how="left")
    df = v1.public_feats(v1.neighbours(df))
    step("주변 격자·공공 변수")
    # 서빙 표와 같은 기준: 주변(3×3) 매장 5곳 미만이면 매출 합을 비운다
    df.loc[df.nb_stores + 1 < 5, "nb_amt_sum"] = np.nan
    for f in (add_brand_ftc, add_area, add_shinhan, add_walk, add_kcb, add_housing):
        df = f(df)
        step(f"{f.__name__} 완료")
    df["y"] = np.log1p(df.amt)
    cnt = df.brand.value_counts()
    df["brand"] = np.where(df.brand.isna(), "-", np.where(df.brand.map(cnt).fillna(0) >= v1.BRAND_MIN, df.brand, "기타 브랜드"))
    for c in CATS:
        df[c] = df[c].astype("category")
    return df


def export_store(df: pd.DataFrame, resid: dict):
    """서빙용 표 (ml/sales_v2_serve.py가 읽는다): 새 자리의 변수를 학습 때와 같은 방식으로 다시 계산하는 데 쓴다."""
    import pickle

    with ro(DB) as con:
        st = pd.read_sql_query("select lno_cd pnu, bizes_nm, inds_scls_cd scls from store where lno_cd is not null", con)
    st["key"] = st.pnu + "|" + st.bizes_nm.map(v1.norm_name)
    link = df[["pnu", "name", "kb_ind", "ksic"]].copy()
    link["key"] = link.pnu + "|" + link.name.map(v1.norm_name)
    j = st.merge(link[["key", "kb_ind", "ksic"]], on="key")
    # 상가정보 소분류 → 가장 흔한 KB 업종·표준산업 대분류 (연결된 매장 20곳 이상인 소분류만)
    j["kb_ind"] = j.kb_ind.astype(str)
    mode = j.groupby("scls").agg(n=("kb_ind", "size"), kb_ind=("kb_ind", lambda s: s.value_counts().index[0]),
                                 sic=("ksic", lambda s: s.dropna().str[:1].value_counts().index[0] if s.notna().any() else None))
    scls_map = mode[mode.n >= 20].drop(columns="n").to_dict("index")

    # 매장 단위 값은 남기지 않는다: 3×3 칸 합계·중앙값만, 매장 5곳 미만이면 값을 비운다 (한 매장 매출이 드러나지 않게)
    MIN_N = 5
    nine = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
    base = df[["cx", "cy", "kb_ind", "amt"]].assign(kb_ind=df.kb_ind.astype(str))
    cell = base.groupby(["cx", "cy"]).agg(n=("amt", "size"), s=("amt", "sum")).reset_index()
    nb = pd.concat([cell.assign(cx=cell.cx + dx, cy=cell.cy + dy) for dx, dy in nine]).groupby(["cx", "cy"]).agg(nb_n=("n", "sum"), nb_sum=("s", "sum"))
    nb.loc[nb.nb_n < MIN_N, "nb_sum"] = np.nan
    cell_n = cell.set_index(["cx", "cy"]).n
    cell_ind_n = base.groupby(["cx", "cy", "kb_ind"]).size()
    exp = pd.concat([base.assign(cx=base.cx + dx, cy=base.cy + dy) for dx, dy in nine])
    nb_ind = exp.groupby(["cx", "cy", "kb_ind"]).amt.agg(n="size", med="median").astype({"n": "int32", "med": "float32"})
    nb_ind.loc[nb_ind.n < MIN_N, "med"] = np.nan
    with ro(INTERNAL) as con:
        sh = pd.read_sql_query("select store_key, pnu, amt a from sh_recent", con)
        inc = pd.read_sql_query("select dong8, res_income, res_spend, work_income, work_spend from kcb_dong_income", con).set_index("dong8")
        w = pd.read_sql_query("select lon, lat, walk, sh_1113, sh_1719 from walk_pop_cell where walk is not null", con)
        ls = con.execute("select max(ym) from kcb_soho_m").fetchone()[0]
        soho = pd.read_sql_query(f"""
            select dong8, sic, avg(avg_biz_income) soho_income, sum(biz_close_cnt) * 1.0 / nullif(sum(biz_cnt), 0) soho_close_rt,
                   sum(biz_dlq_cnt) * 1.0 / nullif(sum(biz_cnt), 0) soho_dlq_rt
            from kcb_soho_m where ym > '{int(ls[:4]) - 1}{ls[4:]}' group by dong8, sic""", con).set_index(["dong8", "sic"])
    # 같은 건물 신한 합: 3곳 이상인 건물만
    pnu_sh = sh.groupby("pnu").a.agg(["sum", "size"])
    pnu_sh = pnu_sh[pnu_sh["size"] >= 3]
    shk = base.assign(store_key=df.store_key.to_numpy()).merge(sh[["store_key", "a"]].drop_duplicates("store_key"), on="store_key")
    exp = pd.concat([shk.assign(cx=shk.cx + dx, cy=shk.cy + dy) for dx, dy in nine])
    sh_nb_ind = exp.groupby(["cx", "cy", "kb_ind"]).a.agg(n="size", med="median")
    sh_nb_ind = sh_nb_ind[sh_nb_ind.n >= MIN_N].med.astype("float32")
    w["gx"] = np.floor(w.lon / (WALK_CELL * 1.25)).astype(int)
    w["gy"] = np.floor(w.lat / WALK_CELL).astype(int)
    w["l"] = w.walk * w.sh_1113.fillna(0)
    w["e"] = w.walk * w.sh_1719.fillna(0)
    walk = w.groupby(["gx", "gy"])[["walk", "l", "e"]].sum().reset_index()
    walk = pd.concat([walk.assign(gx=walk.gx + dx, gy=walk.gy + dy) for dx, dy in nine]).groupby(["gx", "gy"])[["walk", "l", "e"]].sum()
    with ro(DB) as con:
        b = pd.read_sql_query("""
            select m.group_nm brand, max(y.avrg_sls_amt) brand_avg_sales, max(y.frcs_cnt) brand_stores
            from brand_member m join franchise_brand_y y on y.brand_nm = m.brand_nm and y.yr = m.yr
            where m.yr = (select max(yr) from franchise_brand_y) group by m.group_nm""", con).set_index("brand")
    calib = json.loads((OUT / "sales_v1_calib.json").read_text(encoding="utf-8")) if (OUT / "sales_v1_calib.json").exists() else {"ratio_median": None}
    store = {
        "nb": nb, "cell_n": cell_n, "cell_ind_n": cell_ind_n, "nb_ind": nb_ind, "pnu_sh": pnu_sh, "sh_nb_ind": sh_nb_ind, "walk_nb": walk,
        "kcb_inc": inc, "soho": soho, "min_n": MIN_N,
        "brand_ftc": b, "scls_map": scls_map, "categories": {c: list(df[c].cat.categories) for c in CATS},
        "resid": resid, "calib": calib, "cell_size": v1.CELL, "walk_cell": WALK_CELL,
    }
    with open(OUT / "sales_v2_store.pkl", "wb") as f:
        pickle.dump(store, f)
    step(f"서빙용 표 저장 (소분류 대응 {len(scls_map)}개, {(OUT / 'sales_v2_store.pkl').stat().st_size / 1e6:.0f}MB)")


def main():
    df = build()
    step("학습 시작")
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    n = len(sggs)
    test_sgg, valid_sgg = set(sggs[: int(n * 0.15)]), set(sggs[int(n * 0.15): int(n * 0.25)])
    part = np.where(df.sgg.isin(test_sgg), "test", np.where(df.sgg.isin(valid_sgg), "valid", "train"))
    tr, va, te = df[part == "train"], df[part == "valid"], df[part == "test"]

    params = {"objective": "regression", "learning_rate": 0.05, "num_leaves": 255, "min_data_in_leaf": 100,
              "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1}
    model = lgb.train(params, lgb.Dataset(tr[FEATS], tr.y, categorical_feature=CATS), num_boost_round=4000,
                      valid_sets=[lgb.Dataset(va[FEATS], va.y, categorical_feature=CATS)], callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(100)])
    step(f"학습 끝 (트리 {model.best_iteration})")
    p = model.predict(te[FEATS], num_iteration=model.best_iteration)
    pv = model.predict(va[FEATS], num_iteration=model.best_iteration)
    fr_v = va.franchise.to_numpy() == 1
    resid = {g: (round(float(np.quantile((va.y - pv)[m], 0.1)), 4), round(float(np.quantile((va.y - pv)[m], 0.9)), 4))
             for g, m in [("franchise", fr_v), ("independent", ~fr_v)]}

    yt = te.y.to_numpy()
    fr = te.franchise.to_numpy() == 1
    has_area = te.site_area.notna().to_numpy()
    gain = model.feature_importance("gain")
    report = {
        "stores": {"train": len(tr), "valid": len(va), "test": len(te)},
        "split": "시군구 단위 (sales_v1과 같은 시드)",
        "model": {**v1.metrics(yt, p), "best_iteration": model.best_iteration},
        "by_franchise": {"franchise": v1.metrics(yt[fr], p[fr]), "independent": v1.metrics(yt[~fr], p[~fr])},
        "with_site_area": v1.metrics(yt[has_area], p[has_area]),
        "resid_log_q10_q90": resid,
        "coverage": {c: round(float(te[c].notna().mean()), 3) for c in ["site_area", "pnu_sh_amt", "walk_300", "res_income", "soho_income", "brand_avg_sales"]},
        "top_features_gain_share": dict(sorted(((f, round(float(g / gain.sum()), 3)) for f, g in zip(FEATS, gain)), key=lambda x: -x[1])[:15]),
    }
    prev = OUT / "sales_v1_report.json"
    if prev.exists():
        report["v1_same_split"] = json.loads(prev.read_text(encoding="utf-8"))["model"]
    model.save_model(str(OUT / "sales_v2.txt"), num_iteration=model.best_iteration)
    (OUT / "sales_v2_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1), flush=True)
    export_store(df, resid)


if __name__ == "__main__":
    main()
