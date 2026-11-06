"""카드 결제 규모 → 총매출 환산 비율을 브랜드별로 (사내 카드매출 ↔ 공정위 가맹점 평균 매출).

공정위 가맹사업 정보공개서의 가맹점 평균 매출(avrg_sls_amt, 천 원/년)은 카드·현금을 합친 총매출이다.
같은 브랜드로 잡힌 카드 매장(3개월 이상, 월 30만 원 이상)의 월 카드매출 평균과 나누면 브랜드마다 "총매출 ÷ 카드매출" 비율이 나온다.
  - 브랜드 비율: 카드 매장 20곳 이상 + 공정위 가맹점 20곳 이상인 브랜드
  - 업종 비율: 같은 KB 업종 브랜드 비율의 중앙값 (브랜드가 없거나 표본이 적은 매장에 쓴다)
  - 전체 비율: 모든 브랜드 비율의 중앙값 (서울 상권 비교로 구한 2.0과 견준다)
주의: 공정위 값은 직전 연도 실적, 카드매출은 2025-09~2026-09 — 1년 남짓 시차.
Run: ml/.venv/Scripts/python ml/calib_brand.py → ml/out/sales_calib_brand.json
"""
import json
import sqlite3

import numpy as np
import pandas as pd

import sales_v1 as v1
from common import DB, OUT

MIN_STORES = 20


def main():
    df = v1.stores()  # brand = 상호 → 공정위 대표 브랜드
    df = df[df.brand.notna()]
    card = df.groupby("brand").agg(card_mean=("amt", "mean"), card_median=("amt", "median"), n=("amt", "size"),
                                   kb_ind=("kb_ind", lambda s: s.astype(str).value_counts().index[0])).reset_index()
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        ftc = pd.read_sql_query("""
            select m.group_nm brand, max(y.avrg_sls_amt) avg_sales_k, max(y.frcs_cnt) frcs, max(y.yr) yr
            from brand_member m join franchise_brand_y y on y.brand_nm = m.brand_nm and y.yr = m.yr
            where m.yr = (select max(yr) from franchise_brand_y) and y.avrg_sls_amt > 0 group by m.group_nm""", con)
    t = card.merge(ftc, on="brand")
    t = t[(t.n >= MIN_STORES) & (t.frcs >= MIN_STORES)].copy()
    t["ftc_monthly"] = t.avg_sales_k * 1000 / 12
    t["ratio"] = t.ftc_monthly / t.card_mean
    # 표본 매장이 공정위 가맹점 수보다 훨씬 적으면(카드 매장 매칭이 덜 됨) 평균이 흔들린다: 극단값은 업종 중앙값으로 대체 판단용으로만 남긴다
    t["coverage"] = t.n / t.frcs
    ok = t[(t.ratio > 0.5) & (t.ratio < 15)]
    by_ind = ok.groupby("kb_ind").ratio.agg(["median", "size"])
    by_ind = by_ind[by_ind["size"] >= 3]
    out = {
        "brands": {r.brand: {"ratio": round(float(r.ratio), 3), "card_stores": int(r.n), "ftc_stores": int(r.frcs), "kb_ind": r.kb_ind} for r in ok.itertuples()},
        "by_kb_ind": {k: {"ratio": round(float(v["median"]), 3), "brands": int(v["size"])} for k, v in by_ind.iterrows()},
        "overall_median": round(float(ok.ratio.median()), 3),
        "overall_q25_q75": [round(float(ok.ratio.quantile(0.25)), 3), round(float(ok.ratio.quantile(0.75)), 3)],
        "brands_used": int(len(ok)), "brands_dropped_extreme": int(len(t) - len(ok)),
        "note": "총매출 ≈ 카드 결제 규모 × ratio. 브랜드 → 업종 → 전체 순으로 쓴다. 공정위 값은 직전 연도 실적.",
    }
    (OUT / "sales_calib_brand.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"브랜드 {len(ok)}개 (극단값 제외 {len(t) - len(ok)}), 전체 중앙값 {out['overall_median']} (사분위 {out['overall_q25_q75']})")
    print("업종별:", json.dumps(dict(sorted(out["by_kb_ind"].items(), key=lambda x: -x[1]["brands"])[:12]), ensure_ascii=False))
    print("예시:", json.dumps({b: out["brands"][b] for b in list(out["brands"])[:0]} or {r.brand: round(r.ratio, 2) for r in ok.sort_values("n", ascending=False).head(12).itertuples()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
