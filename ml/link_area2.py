"""전체 인허가(LOCALDATA 195개 업종)로 카드 매장의 면적·인허가일을 넓힌다 → data/internal.sqlite store_area2.

link_area.py는 음식점·카페·담배만 본다. 담배소매업은 면적이 비어 있어 편의점은 크기를 몰랐다. 편의점은 안전상비의약품·휴게음식점·
즉석판매·쓰레기봉투 같은 인허가를 함께 갖는 경우가 많아, 같은 매장의 다른 인허가에서 면적을 가져온다.
연결: 지번주소 → PNU, PNU + 정규화 상호 일치 → 같은 PNU 안 상호 포함. 같은 매장에 인허가가 여럿이면 면적 중앙값.
영업 중이거나 2025년 이후 폐업한 인허가만 쓴다 (카드 매출은 2025-09~).
Run: ml/.venv/Scripts/python -u ml/link_area2.py
"""
import sqlite3
import sys
import zipfile

import pandas as pd

from common import DB, ROOT
from link_area import bjd_lookup, norm, to_pnu

INTERNAL = ROOT / "data" / "internal.sqlite"
ZIP = ROOT / "data" / "raw" / "s3" / "cla-raw-data" / "localdata" / "base_dt=2026-04-01" / "_zip_files" / "LOCALDATA_ALL_CSV.zip"
SKIP = ("통신판매업", "가축", "대기오염", "수질오염", "폐기물", "방문판매", "집단급식소", "출판사", "식품제조가공", "식품자동판매기", "다단계")
COLS = ["소재지면적", "소재지전체주소", "사업장명", "인허가일자", "폐업일자"]


def licenses():
    z = zipfile.ZipFile(ZIP)
    out = []
    for i in z.infolist():
        n = i.filename.encode("cp437", "ignore").decode("cp949", "replace")
        if not n.endswith(".csv") or any(s in n for s in SKIP):
            continue
        with z.open(i) as f:
            try:
                d = pd.read_csv(f, encoding="cp949", encoding_errors="replace", usecols=COLS, dtype=str, on_bad_lines="skip", low_memory=False)
            except ValueError:
                continue  # 면적·주소 열이 없는 업종
        d = d[d["폐업일자"].isna() | (d["폐업일자"] >= "2025-01-01")]
        d = d.assign(svc=n.split("_P_")[-1].removesuffix(".csv"))
        out.append(d)
        print(n[:44], len(d), flush=True)
    return pd.concat(out, ignore_index=True)


def main():
    lic = licenses()
    lic["area"] = pd.to_numeric(lic["소재지면적"], errors="coerce")
    print(f"인허가 {len(lic):,}, 면적 있음 {(lic.area > 0).mean():.1%}", flush=True)
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        lookup = bjd_lookup(con)
    # 옛 지번 표기 "64번지 1호" → "64-1"
    addr = lic["소재지전체주소"].str.replace(r"(\d+)번지\s*(\d+)호?", r"\1-\2", regex=True).str.replace(r"(\d+)번지", r"\1", regex=True)
    lic["pnu"] = [to_pnu(a, lookup) for a in addr]
    lic = lic.dropna(subset=["pnu"])
    lic["nm"] = lic["사업장명"].map(norm)
    lic = lic[lic.nm.str.len() >= 2]
    print(f"주소 → PNU {len(lic):,}", flush=True)
    with sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True) as con:
        cs = pd.read_sql_query("select store_key, max(name) name, max(pnu) pnu, max(kb_ind) kb_ind from card_sales_m group by store_key", con)
    cs["nm"] = cs.name.map(norm)
    a = lic[(lic.area > 0) & (lic.area < 100000)]
    k1 = cs.merge(a[["pnu", "nm", "area", "svc", "인허가일자"]], on=["pnu", "nm"])
    done = set(k1.store_key)
    by_pnu = {p: g[["nm", "area", "svc", "인허가일자"]].to_numpy() for p, g in a[a.pnu.isin(set(cs.pnu))].groupby("pnu")}
    rows = []
    for r in cs[~cs.store_key.isin(done)].itertuples(index=False):
        c = by_pnu.get(r.pnu)
        if c is None or len(r.nm) < 2:
            continue
        for nm, area, svc, apv in c:
            if nm in r.nm or r.nm in nm:
                rows.append((r.store_key, area, svc, apv))
    k2 = pd.DataFrame(rows, columns=["store_key", "area", "svc", "인허가일자"])
    print(f"1) PNU+상호 {k1.store_key.nunique():,} · 2) 상호 포함 {k2.store_key.nunique():,}", flush=True)
    both = pd.concat([k1[["store_key", "area", "svc", "인허가일자"]].assign(m="exact"), k2.assign(m="contains")], ignore_index=True)
    res = both.groupby("store_key").agg(area=("area", "median"), n=("area", "size"), svc=("svc", "first"), apv=("인허가일자", "min"), m=("m", "first")).reset_index()
    res.to_csv(INTERNAL.parent / "store_area2.csv", index=False, encoding="utf-8")
    with sqlite3.connect(INTERNAL, timeout=1800) as con:
        con.execute("drop table if exists store_area2")
        res.to_sql("store_area2", con, index=False)
        con.execute("create index ix_store_area2 on store_area2 (store_key)")
    # 편의점에 연결되는 휴게음식점 면적은 커피·조리 공간(중앙값 3.3㎡)이지 매장 크기가 아니다: 학습에 쓰지 않는다
    res.loc[res.store_key.isin(cs.store_key[cs.kb_ind == "유통|편의점"]), "area"] = None
    with sqlite3.connect(INTERNAL, timeout=1800) as con:
        res.to_sql("store_area2", con, index=False, if_exists="replace")
        con.execute("create index ix_store_area2 on store_area2 (store_key)")
    x = cs.merge(res, on="store_key", how="left")
    x["top"] = x.kb_ind.fillna("").str.split("|").str[0]
    print(x.groupby("top").area.agg(["size", "count", "median"]).assign(rate=lambda t: t["count"] / t["size"]).sort_values("size", ascending=False).head(14).round(2).to_string())


if __name__ == "__main__":
    main()
