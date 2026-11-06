"""개업 후 매출 곡선 (사내 신한 월 매출 2021~2025 ↔ 공공 인허가 개업일).

지금 매출 모델은 "자리 잡은 가게"의 평균 월 매출을 배운다. 출점 심사에서 궁금한 건 "새로 열면 첫해에 얼마"라서,
인허가일이 2021-07 ~ 2023-04인 가게(음식점·카페·담배)의 신한 월 매출을 개업 후 개월 수로 줄 세워
"개업 후 k개월 매출 ÷ 13~24개월 평균"(안정기 대비 비율)을 업종 묶음별로 구한다.
  - 매장 연결: store_area(인허가 ↔ 카드 매장, PNU + 상호) → 신한도 같은 키(store_key)
  - 신한 8,768만 행은 월 인덱스로 무작위로 읽으면 느려서, 대상 매장 키 표를 만들고 신한 표를 순서대로 한 번 읽는다
Run: ml/.venv/Scripts/python ml/ramp_curve.py → ml/out/sales_ramp.json
"""
import json
import sqlite3

import numpy as np
import pandas as pd

from common import OUT, ROOT
from sales_v3 import group_of

INTERNAL = ROOT / "data" / "internal.sqlite"


def main():
    con = sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True)
    lic = pd.read_sql_query("""
        select a.store_key, a.apv_ymd, a.lic_src, (select max(kb_ind) from card_sales_m c where c.store_key = a.store_key) kb_ind
        from store_area a where a.apv_ymd between '2021-07-01' and '2023-04-30'""", con)
    print(f"대상 가게 {len(lic):,}")
    mem = sqlite3.connect("file::memory:", uri=True)  # URI 모드여야 다른 DB를 읽기 전용(?mode=ro)으로 붙일 수 있다
    mem.execute(f"attach database 'file:{INTERNAL}?mode=ro' as i")
    lic[["store_key"]].to_sql("keys", mem, index=False)
    mem.execute("create unique index ix_keys on keys (store_key)")
    sh = pd.read_sql_query("select s.store_key, s.ym, s.amt from i.sh_sales_m s not indexed join keys k on k.store_key = s.store_key where s.amt > 0", mem)
    print(f"신한 월 매출 {len(sh):,}행 · 가게 {sh.store_key.nunique():,}")

    d = sh.merge(lic, on="store_key")
    open_m = pd.to_datetime(d.apv_ymd.str[:7] + "-01")
    ym = pd.to_datetime(d.ym.str[:4] + "-" + d.ym.str[4:] + "-01")
    d["k"] = ((ym.dt.year - open_m.dt.year) * 12 + (ym.dt.month - open_m.dt.month)).astype(int)
    d = d[(d.k >= 0) & (d.k <= 24)]
    stable = d[(d.k >= 13) & (d.k <= 24)].groupby("store_key").amt.mean().rename("stable")
    d = d.merge(stable, on="store_key")
    # 13~24개월 매출이 6달 이상 있는 가게만 (중간에 닫은 가게는 폐업 위험 모델에서 따로 본다)
    full = d[(d.k >= 13)].groupby("store_key").size()
    d = d[d.store_key.isin(full[full >= 6].index)]
    d["rel"] = d.amt / d.stable
    d["group"] = d.kb_ind.fillna("").map(group_of)
    curves = {}
    for g, x in d.groupby("group"):
        c = x.groupby("k").rel.median()
        curves[g] = {"stores": int(x.store_key.nunique()), "rel_by_month": {int(k): round(float(v), 3) for k, v in c.items()},
                     "first_year_vs_stable": round(float(x[(x.k >= 1) & (x.k <= 12)].groupby("store_key").rel.mean().median()), 3)}
    out = {"cohort": "인허가 2021-07~2023-04 개업, 신한 월 매출", "curves": curves,
           "note": "rel = 개업 후 k개월 매출 ÷ 13~24개월 평균(안정기). 0개월(개업 달)은 일부 영업이라 낮다."}
    (OUT / "sales_ramp.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    for g, c in curves.items():
        r = c["rel_by_month"]
        print(f"{g}: 가게 {c['stores']:,} · 첫해 평균 {c['first_year_vs_stable']} · 1개월 {r.get(1)} · 3개월 {r.get(3)} · 6개월 {r.get(6)} · 12개월 {r.get(12)}")


if __name__ == "__main__":
    main()
