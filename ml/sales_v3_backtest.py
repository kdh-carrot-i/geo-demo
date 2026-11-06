"""매출 v3 실측 대조: 학습에 쓰지 않은 시군구의 실제 가게 카드매출과 예측을 맞춰 본다.

세 가지 조건으로 재서 "이 정도는 맞는다"의 범위를 잡는다.
  시험 그대로    학습 때와 같은 입력
  새 자리 조건    가게 나이를 서빙과 같게 24개월로 고정
  신한 없음      새 자리 조건 + 같은 건물·주변 신한 매출을 비움. 신한 상호가 KB와 달라 자기 매출이 입력에 남았을 위험의 상한을 잰다
비교 기준:
  주변 중앙값     모델 없이 주변 같은 업종 중앙값을 그대로 쓸 때의 오차 (모델이 이것보다 나아야 쓸모가 있다)
  전달 → 이번 달  같은 가게의 지난달 매출로 이번 달을 맞힐 때의 오차 (가게 매출 자체가 흔들리는 폭)
총매출은 매장별 실측이 없어 카드매출로만 잰다.
Run: ml/.venv/Scripts/python -u ml/sales_v3_backtest.py → ml/out/sales_v3_backtest.json
"""
import json
import sqlite3

import lightgbm as lgb
import numpy as np
import pandas as pd

import sales_v3 as v3
from common import OUT, ROOT

INTERNAL = ROOT / "data" / "internal.sqlite"
MASK_SH = ["pnu_sh_amt", "pnu_sh_n", "nb_sh_same_med"]
MIN_N = 50
AGE_BANDS = [("1년 이내", -1, 12), ("1~2년", 12, 24), ("2~5년", 24, 60), ("5년 넘음", 60, 10000)]


def errors(actual, pred):
    ape = np.abs(pred - actual) / actual
    return {"n": int(len(actual)), "err_median": round(float(np.median(ape)), 3), "within_30": round(float((ape <= 0.3).mean()), 3),
            "within_50": round(float((ape <= 0.5).mean()), 3), "pred_over_actual": round(float(np.median(pred / actual)), 3)}


def month_noise(keys):
    """같은 가게의 전달 → 이번 달 오차, 마지막 달 값"""
    mem = sqlite3.connect("file::memory:", uri=True)
    mem.execute(f"attach database 'file:{INTERNAL}?mode=ro' as i")
    pd.DataFrame({"store_key": keys}).to_sql("keys", mem, index=False)
    mem.execute("create unique index ix_keys on keys (store_key)")
    m = pd.read_sql_query("select c.store_key, c.ym, c.amt from i.card_sales_m c not indexed join keys k on k.store_key = c.store_key where c.amt > 0", mem)
    m = m.sort_values(["store_key", "ym"])
    m["prev"] = m.groupby("store_key").amt.shift(1)
    m["prev_ym"] = m.groupby("store_key").ym.shift(1)
    mid = lambda ym: pd.to_numeric(ym.str[:4]) * 12 + pd.to_numeric(ym.str[4:])
    pair = m[m.prev.notna()]
    return pair[(mid(pair.ym) - mid(pair.prev_ym)) == 1], m


def score(d, parts, pair):
    a = np.expm1(d.y.to_numpy())
    out = {k: errors(a, np.expm1(p[d.index.to_numpy()])) for k, p in parts.items()}
    out["range_80"] = round(float(((d.y >= parts["lo"][d.index.to_numpy()]) & (d.y <= parts["hi"][d.index.to_numpy()])).mean()), 3) if "lo" in parts else None
    for k in ("lo", "hi"):
        out.pop(k, None)
    med = d.nb_same_med.notna().to_numpy()
    if med.sum() >= MIN_N:
        out["주변 중앙값"] = errors(a[med], d.nb_same_med.to_numpy()[med])
        # 주변 가게가 5곳 미만이면 중앙값이 없다: 공정하게 비교하려고 같은 가게로 모델도 잰다
        out["새 자리 조건(같은 가게)"] = errors(a[med], np.expm1(parts["새 자리 조건"][d.index.to_numpy()])[med])
    p = pair[pair.store_key.isin(d.store_key)]
    if len(p) >= MIN_N:
        out["전달 → 이번 달"] = errors(p.amt.to_numpy(float), p.prev.to_numpy(float))
    return out


def main():
    df = v3.build().reset_index(drop=True)
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    test = sggs[: int(len(sggs) * 0.15)]
    te = df[df.sgg.isin(set(test))].reset_index(drop=True)
    scale = pd.read_pickle(OUT / "sales_v3_store.pkl")["range_scale"]
    v3.step(f"시험 시군구 {len(test)}곳 · 가게 {len(te):,} · 강남구 포함 {'11680' in set(test)}")

    parts = {k: np.full(len(te), np.nan) for k in ("시험 그대로", "새 자리 조건", "신한 없음", "lo", "hi")}
    for g, slug in v3.SLUG.items():
        i = (te.group == g).to_numpy()
        m, q10, q90 = (lgb.Booster(model_file=str(OUT / f"sales_v3_{slug}{x}.txt")) for x in ("", "_q10", "_q90"))
        X = te.loc[i, v3.FEATS]
        new = X.assign(store_age_m=float(v3_age))
        no_sh = new.assign(**{c: np.nan for c in MASK_SH})
        parts["시험 그대로"][i] = m.predict(X)
        parts["새 자리 조건"][i] = p = m.predict(new)
        parts["신한 없음"][i] = m.predict(no_sh)
        parts["lo"][i] = p - scale[g] * np.maximum(p - q10.predict(new), 0)
        parts["hi"][i] = p + scale[g] * np.maximum(q90.predict(new) - p, 0)

    pair, months = month_noise(te.store_key.unique())
    v3.step(f"월별 쌍 {len(pair):,}")
    rep = {"test_sgg": [str(s) for s in test], "all": score(te, parts, pair), "groups": {}, "brands": {}}
    for g in v3.SLUG:
        d = te[te.group == g]
        rep["groups"][g] = {"전체": score(d, parts, pair), "프랜차이즈": score(d[d.franchise == 1], parts, pair), "개인": score(d[d.franchise == 0], parts, pair)}
    # 개업 시기별: 새 자리 예측이 실제 새 가게와 맞는지 (개업일은 인허가와 연결된 가게만 안다)
    rep["age"] = {}
    for name, lo, hi in AGE_BANDS:
        d = te[(te.store_age_m > lo) & (te.store_age_m <= hi)]
        if len(d) < MIN_N:
            continue
        rep["age"][name] = {"전체": score(d, parts, pair)}
        for g in v3.SLUG:
            for k, x in (("프랜차이즈", d[(d.group == g) & (d.franchise == 1)]), ("개인", d[(d.group == g) & (d.franchise == 0)])):
                if len(x) >= MIN_N:
                    rep["age"][name][f"{g}/{k}"] = score(x, parts, pair)
    top = te[te.brand.astype(str).ne("-") & te.brand.astype(str).ne("기타 브랜드")].brand.astype(str).value_counts().head(12)
    for b in top.index:
        rep["brands"][b] = score(te[te.brand.astype(str) == b], parts, pair)
    (OUT / "sales_v3_backtest.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: rep[k] for k in ("all", "age")}, ensure_ascii=False, indent=1), flush=True)
    v3.step("완료")


v3_age = 24

if __name__ == "__main__":
    main()
