"""매출 v1 보정: KB카드 매출 → 총매출 환산 비율.

KB 데이터는 KB카드로 결제된 금액만 담는다. 서울시 상권분석 추정매출(전 카드사 + 현금 추정, 상권 × 업종, 월)과
같은 상권 범위의 KB 매장 매출 합을 비교해 상권별 비율을 구하고, 그 분포(중앙값·사분위)를 환산 비율로 쓴다.
상권 범위 = 서울 상권 중심에서 면적 환산 반경 (150~1,000m, 서버 area.ts와 같은 규칙).
KB에는 2026-04~06이 없어 서울시 2026년 2분기와 가장 가까운 2026-03·07 평균을 쓴다.
Run: ml/.venv/Scripts/python ml/sales_v1_calib.py → ml/out/sales_v1_calib.json
"""
import json
import sqlite3

import numpy as np
import pandas as pd

from common import DB, OUT, ROOT

INTERNAL = ROOT / "data" / "internal.sqlite"
MONTHS = ("202603", "202607")


def main():
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        q = con.execute("select max(stdr_yyqu_cd) from ta_sales_q").fetchone()[0]
        ta = pd.read_sql_query(f"""
            select t.trdar_cd, t.lat, t.lon, t.relm_ar, t.trdar_se_cd_nm kind, s.amt
            from trade_area_seoul t join (select trdar_cd, sum(thsmon_selng_amt) amt from ta_sales_q where stdr_yyqu_cd = '{q}' group by 1) s
              on s.trdar_cd = t.trdar_cd""", con)
    with sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True) as con:
        kb = pd.read_sql_query(f"""
            select store_key, avg(lat) lat, avg(lon) lon, avg(amt) amt from card_sales_m
            where ym in {MONTHS} and bjd_cd like '11%' and lat is not null group by store_key""", con)
    r = np.clip(np.sqrt(ta.relm_ar / np.pi), 150, 1000)

    # 격자 색인으로 반경 안 KB 매장 합
    cell = 0.01
    kb["gx"], kb["gy"] = (kb.lon // cell).astype(int), (kb.lat // cell).astype(int)
    groups = {k: g for k, g in kb.groupby(["gx", "gy"])}
    sums = []
    for (lat, lon, rad) in zip(ta.lat, ta.lon, r):
        gx, gy = int(lon // cell), int(lat // cell)
        cand = pd.concat([groups[(gx + dx, gy + dy)] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (gx + dx, gy + dy) in groups])
        d = 6371000 * np.hypot(np.radians(cand.lon - lon) * np.cos(np.radians(lat)), np.radians(cand.lat - lat))
        sums.append(cand.amt[d <= rad].sum())
    ta["kb"] = sums
    ok = ta[(ta.kb > 0) & (ta.amt > 0)].copy()
    ok["ratio"] = ok.amt / ok.kb
    out = {
        "seoul_quarter": q, "kb_months": list(MONTHS), "areas": int(len(ok)),
        "ratio_median": round(float(ok.ratio.median()), 3),
        "ratio_q25": round(float(ok.ratio.quantile(0.25)), 3), "ratio_q75": round(float(ok.ratio.quantile(0.75)), 3),
        "by_area_kind": {k: round(float(g.ratio.median()), 3) for k, g in ok.groupby("kind")},
        "note": "총매출 ≈ KB카드 매출 × ratio_median. 상권 간 차이가 커서(사분위 범위) 범위 예측에 함께 반영한다.",
    }
    (OUT / "sales_v1_calib.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
