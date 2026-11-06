"""카드 매장 ↔ 상가정보 점포 층 연결 → data/internal.sqlite store_floor.

sales_v1은 PNU + 정규화 상호가 정확히 같을 때만 층을 붙여 20%만 연결됐다. 면적 연결(link_area.py)과 같은 3단계로 넓힌다.
  1) PNU + 상호 같음  2) 같은 PNU 안 상호 포함 관계  3) 좌표 30m 안 상호 유사도 0.8 이상
층은 지하(B) / 1 / 2 / 3+ 로 나눈다.
Run: ml/.venv/Scripts/python ml/link_floor.py
"""
import difflib
import re
import sqlite3

import numpy as np
import pandas as pd

from common import DB, ROOT
from link_area import norm

INTERNAL = ROOT / "data" / "internal.sqlite"
NEAR_M = 30


def bucket(f) -> str | None:
    f = str(f or "").strip()
    if not f:
        return None
    if re.match(r"^(B|지하|-)", f, re.I):
        return "B"
    m = re.match(r"(\d+)", f)
    if not m:
        return None
    n = int(m.group(1))
    return "1" if n <= 1 else "2" if n == 2 else "3+"


def main():
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        st = pd.read_sql_query("select lno_cd pnu, bizes_nm, flr_no, lon, lat from store where lno_cd is not null and flr_no is not null and flr_no <> ''", con)
    st["fl"] = st.flr_no.map(bucket)
    st = st.dropna(subset=["fl"])
    st["nm"] = st.bizes_nm.map(norm)
    print(f"상가정보 층 있는 점포 {len(st):,}")
    with sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True) as con:
        cs = pd.read_sql_query("select store_key, max(name) name, max(pnu) pnu, avg(lon) lon, avg(lat) lat from card_sales_m group by store_key", con)
    cs["nm"] = cs.name.map(norm)

    out = {}
    k1 = st.drop_duplicates(["pnu", "nm"]).set_index(["pnu", "nm"])
    for r in cs.join(k1[["fl"]], on=["pnu", "nm"], how="inner").itertuples(index=False):
        out[r.store_key] = (r.fl, "pnu+name")
    print(f"1) PNU+상호 {len(out):,}")
    by_pnu = {p: g[["nm", "fl"]].to_numpy() for p, g in st.groupby("pnu")}
    n2 = 0
    for r in cs[~cs.store_key.isin(out)].itertuples(index=False):
        for nm, fl in by_pnu.get(r.pnu, ()):
            if len(nm) >= 2 and len(r.nm) >= 2 and (nm in r.nm or r.nm in nm):
                out[r.store_key] = (fl, "pnu+contains")
                n2 += 1
                break
    print(f"2) PNU 안 상호 포함 {n2:,}")
    cell = 0.0005
    st["gx"], st["gy"] = (st.lon // cell).astype(int), (st.lat // cell).astype(int)
    grid = {k: g[["nm", "fl", "lon", "lat"]].to_numpy() for k, g in st.dropna(subset=["lon", "lat"]).groupby(["gx", "gy"])}
    n3 = 0
    for r in cs[~cs.store_key.isin(out) & cs.lon.notna()].itertuples(index=False):
        gx, gy = int(r.lon // cell), int(r.lat // cell)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for nm, fl, lon, lat in grid.get((gx + dx, gy + dy), ()):
                    if 6371000 * np.hypot(np.radians(lon - r.lon) * np.cos(np.radians(r.lat)), np.radians(lat - r.lat)) > NEAR_M:
                        continue
                    s = difflib.SequenceMatcher(None, r.nm, nm).ratio()
                    if s >= 0.8 and (best is None or s > best[0]):
                        best = (s, fl)
        if best:
            out[r.store_key] = (best[1], "near+similar")
            n3 += 1
    print(f"3) 30m 안 상호 유사 {n3:,}")
    res = pd.DataFrame([(k, f, t) for k, (f, t) in out.items()], columns=["store_key", "floor", "match_type"])
    res.to_csv(INTERNAL.parent / "store_floor.csv", index=False, encoding="utf-8")
    with sqlite3.connect(INTERNAL, timeout=1800) as con:
        con.execute("drop table if exists store_floor")
        res.to_sql("store_floor", con, index=False)
        con.execute("create index ix_store_floor on store_floor (store_key)")
    print(f"연결 {len(res):,} / {len(cs):,} ({len(res) / len(cs):.1%})")
    print(res.floor.value_counts().to_string())


if __name__ == "__main__":
    main()
