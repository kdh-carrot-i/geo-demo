"""카드 매장 ↔ 인허가 매장 연결 (면적·인허가일) → data/internal.sqlite store_area.

인허가(일반음식점·휴게음식점·담배소매업, commerce.sqlite license_event)의 소재지면적(담배는 없음)과 인허가일을 카드 매장(card_sales_m)에 붙인다.
  1) 인허가 지번주소 → PNU (법정동 이름 → 코드, 옛 시도 이름은 region_legal_history로 새 코드) 후 PNU + 정규화 상호가 같으면 연결
  2) 같은 PNU 안에서 한쪽 상호가 다른 쪽을 포함하면 연결 ("스타벅스 강남점" ⊃ "스타벅스")
  3) 좌표 30m 안에서 상호 유사도 0.8 이상이면 연결
영업 중이거나 2024년 이후 폐업한 인허가만 쓴다 (카드 매출은 2025-09~).
Run: ml/.venv/Scripts/python ml/link_area.py
"""
import difflib
import re
import sqlite3
import unicodedata

import numpy as np
import pandas as pd

from common import DB, ROOT

INTERNAL = ROOT / "data" / "internal.sqlite"
NEAR_M = 30


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s if isinstance(s, str) else "").lower()
    s = re.sub(r"^\(?주\)|\(주\)$|주식회사", "", s)
    return re.sub(r"[^0-9a-z가-힣]", "", s)


def bjd_lookup(con) -> dict:
    cur = pd.read_sql_query("select bjd_cd, locatadd_nm from region_legal", con)
    d = {re.sub(r"\s+", " ", n.strip()): c for c, n in cur.itertuples(index=False)}
    try:
        old = pd.read_sql_query("select old_nm, new_cd from region_legal_history where level in ('umd','ri') and weight = 1", con)
        for n, c in old.itertuples(index=False):
            d.setdefault(re.sub(r"\s+", " ", n.strip()), c)
    except Exception:
        pass
    return d


ADDR = re.compile(r"^(.*?)\s+(산\s*)?(\d+)(?:-(\d+))?(?:\s|$|,)")


def to_pnu(addr: str, lookup: dict):
    if not isinstance(addr, str) or not addr:
        return None
    m = ADDR.match(addr.strip())
    if not m:
        return None
    name, san, bun, ji = m.group(1), m.group(2), m.group(3), m.group(4) or "0"
    name = re.sub(r"\s+", " ", name)
    # 세종처럼 시군구 없는 주소, "경기도 수원시 장안구 …" 같은 일반구 주소 모두 region_legal 이름과 같은 꼴
    code = lookup.get(name)
    if not code:
        return None
    return f"{code}{'2' if san else '1'}{int(bun):04d}{int(ji):04d}"


def main():
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        lookup = bjd_lookup(con)
        lic = pd.read_sql_query("""
            select mgt_no, opn_svc_id src, bplc_nm, site_area, apv_perm_ymd apv, site_whl_addr, lon, lat
            from license_event
            where opn_svc_id in ('07_24_04_P', 'rest_cafes', 'tobacco_retailers')
              and (dcb_ymd is null or dcb_ymd = '' or dcb_ymd >= '2024-01-01')""", con)
    lic["pnu"] = [to_pnu(a, lookup) for a in lic.site_whl_addr]
    lic["nm"] = lic.bplc_nm.map(norm)
    print(f"인허가 {len(lic):,}곳, 주소 → PNU {lic.pnu.notna().mean():.1%}")

    with sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True) as con:
        cs = pd.read_sql_query("""
            select store_key, max(name) name, max(pnu) pnu, avg(lon) lon, avg(lat) lat, max(kb_ind) kb_ind
            from card_sales_m group by store_key""", con)
    cs["nm"] = cs.name.map(norm)
    print(f"카드 매장 {len(cs):,}곳")

    out = {}
    # 1) PNU + 상호
    k1 = lic.dropna(subset=["pnu"]).drop_duplicates(["pnu", "nm"]).set_index(["pnu", "nm"])
    hit = cs.join(k1[["site_area", "src", "apv"]], on=["pnu", "nm"], how="inner")
    for r in hit.itertuples(index=False):
        out[r.store_key] = (r.site_area, r.src, "pnu+name", r.apv)
    print(f"1) PNU+상호 {len(out):,}")

    # 2) 같은 PNU, 상호 포함 관계
    by_pnu = {p: g[["nm", "site_area", "src", "apv"]].to_numpy() for p, g in lic.dropna(subset=["pnu"]).groupby("pnu")}
    n2 = 0
    for r in cs[~cs.store_key.isin(out)].itertuples(index=False):
        cands = by_pnu.get(r.pnu)
        if cands is None or len(r.nm) < 2:
            continue
        for nm, area, src, apv in cands:
            if len(nm) >= 2 and (nm in r.nm or r.nm in nm):
                out[r.store_key] = (area, src, "pnu+contains", apv)
                n2 += 1
                break
    print(f"2) PNU 안 상호 포함 {n2:,}")

    # 3) 좌표 30m + 상호 유사도
    L = lic.dropna(subset=["lon", "lat"]).copy()
    cell = 0.0005  # 약 50m 칸
    L["gx"], L["gy"] = (L.lon // cell).astype(int), (L.lat // cell).astype(int)
    grid = {k: g[["nm", "site_area", "src", "lon", "lat", "apv"]].to_numpy() for k, g in L.groupby(["gx", "gy"])}
    n3 = 0
    rest = cs[~cs.store_key.isin(out) & cs.lon.notna()]
    for r in rest.itertuples(index=False):
        gx, gy = int(r.lon // cell), int(r.lat // cell)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for nm, area, src, lon, lat, apv in grid.get((gx + dx, gy + dy), ()):
                    d = 6371000 * np.hypot(np.radians(lon - r.lon) * np.cos(np.radians(r.lat)), np.radians(lat - r.lat))
                    if d > NEAR_M:
                        continue
                    s = difflib.SequenceMatcher(None, r.nm, nm).ratio()
                    if s >= 0.8 and (best is None or s > best[0]):
                        best = (s, area, src, apv)
        if best:
            out[r.store_key] = (best[1], best[2], "near+similar", best[3])
            n3 += 1
    print(f"3) 30m 안 상호 유사 {n3:,}")

    # 담배소매업은 면적이 없다: 면적은 0 이하면 비우고 인허가일(apv_ymd)은 그대로
    res = pd.DataFrame([(k, a if a and a > 0 else None, s, t, apv) for k, (a, s, t, apv) in out.items()],
                       columns=["store_key", "site_area", "lic_src", "match_type", "apv_ymd"])
    # 다른 적재(신한 등)가 같은 DB에 쓰는 중일 수 있다: 결과를 먼저 파일로 남기고, 잠금이 풀릴 때까지 기다려 쓴다
    res.to_csv(INTERNAL.parent / "store_area.csv", index=False, encoding="utf-8")
    with sqlite3.connect(INTERNAL, timeout=1800) as con:
        con.execute("drop table if exists store_area")
        res.to_sql("store_area", con, index=False)
        con.execute("create index ix_store_area on store_area (store_key)")
    food = cs.kb_ind.fillna("").str.startswith("식생활")
    linked = cs.store_key.isin(out)
    print(f"연결 {len(res):,} / {len(cs):,} ({len(res) / len(cs):.1%}) · 식생활 매장 중 {linked[food].mean():.1%}")
    print(res.site_area.describe().round(1).to_string())


if __name__ == "__main__":
    main()
