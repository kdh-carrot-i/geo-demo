"""매출 v3 서빙: v2 변수 계산(sales_v2_serve)에 건물·토지·경쟁 구성을 더하고, 업종 묶음별 모델로 예측한다.

필요한 파일: ml/out/sales_v3_{cafe,food,cvs,other}{,_q10,_q90}.txt, sales_v3_store.pkl (sales_v3_export.py), sales_v2_store.pkl.
  가게 나이   개업 24개월(안정기) 기준으로 예측한다. 첫 달은 안정기보다 10~15% 낮다 (ramp_curve.py).
  범위        묶음별 10%·90% 분위수 모델을 검증 지역에서 80%가 들도록 넓힌 폭
  총매출 환산  브랜드 비율 → 같은 업종 브랜드 비율 중앙값 → 전체 중앙값 (calib_brand.py, 공정위 가맹점 평균 매출 ↔ 카드매출)
  폐업 위험    closure_v1의 자리 모델에 예측 카드매출을 넣은 "개업 1년 안 폐업" 확률. 동네 대비 매출은 주변 750m 같은 업종 중앙값과 비교한다
              (학습은 법정동 같은 업종 기준이라 범위가 약간 다르다). 신한은 KB의 약 0.82배라 금액 변수만 맞춘다.
건물(bld_pnu)·토지(land_pnu)는 필지로 사내 DB에서 조회한다 (공공데이터를 옮겨 둔 표).
"""
import pickle
import sqlite3

import lightgbm as lgb
import numpy as np
import pandas as pd

import sales_v3 as v3
from common import OUT, ROOT
from sales_v2_serve import SalesV2

INTERNAL = ROOT / "data" / "internal.sqlite"
STABLE_AGE_M = 24
SH_PER_KB = 0.82


class SalesV3(SalesV2):
    def __init__(self):
        super().__init__()
        with open(OUT / "sales_v3_store.pkl", "rb") as f:
            self.s3 = pickle.load(f)
        self.models = {g: tuple(lgb.Booster(model_file=str(OUT / f"sales_v3_{slug}{x}.txt")) for x in ("", "_q10", "_q90"))
                       for g, slug in v3.SLUG.items()}
        self.cats3 = self.s3["categories"]
        cb = self.s3["calib_brand"]
        self.ratio_brand = {b: v["ratio"] for b, v in cb["brands"].items()}
        self.ratio_ind = {k: v["ratio"] for k, v in cb["by_kb_ind"].items()}
        self.ratio_all = cb["overall_median"]
        self.closure, self.closure_ref = None, None
        if (OUT / "closure_v1_site.txt").exists() and (OUT / "closure_v1_ref.pkl").exists():
            self.closure = lgb.Booster(model_file=str(OUT / "closure_v1_site.txt"))
            with open(OUT / "closure_v1_ref.pkl", "rb") as f:
                self.closure_ref = pickle.load(f)

    def _row(self, sql, *params):
        with sqlite3.connect(f"file:{INTERNAL}?mode=ro", uri=True) as con:
            return con.execute(sql, params).fetchone()

    def _ratio(self, brand, kb_ind):
        if brand and brand in self.ratio_brand:
            return self.ratio_brand[brand], "브랜드"
        if kb_ind in self.ratio_ind:
            return self.ratio_ind[kb_ind], "업종"
        return self.ratio_all, "전체"

    def _close_risk(self, f, card_p50, group):
        if self.closure is None:
            return None
        ref = self.closure_ref
        med = f["nb_same_med"]
        row = dict(f, lamt=np.log1p(card_p50 * SH_PER_KB), rel_dong=np.nan if pd.isna(med) else np.log1p(card_p50) - np.log1p(med),
                   age_m=0.0, dong_same=np.nan, group=group)
        X = pd.DataFrame([row])[ref["feats_site"]]
        for c, cats in ref["categories"].items():
            X[c] = pd.Categorical(X[c].astype(str).where(X[c].notna(), None), categories=cats)
        for c in X.columns:
            if c not in ref["categories"]:
                X[c] = pd.to_numeric(X[c], errors="coerce")
        return {"prob_12m": round(float(self.closure.predict(X)[0]), 3), "peer_rate": ref["young_rate"].get(group)}

    def predict(self, lat, lng, pnu, scls, store_name=None, floor=None, site_area=None):
        m = self.s["scls_map"].get(scls)
        if not m:
            return {"available": False, "reason": f"업종 {scls}의 카드 매출 업종 대응이 없음 (연결된 매장 20곳 미만)"}
        kb_ind, sic = m["kb_ind"], m.get("sic")
        fl = "?" if floor is None else "B" if floor < 0 else "1" if floor <= 1 else "2" if floor == 2 else "3+"
        f, ctx = self.features(lat, lng, pnu, kb_ind, sic, fl, site_area)
        b = self._row("select buildings, tot_area, first_year, main_use, parking from bld_pnu where pnu = ?", pnu) if pnu else None
        land = self._row("select road_class, corner, use_zone, land_height, land_fig, price from land_pnu where pnu = ?", pnu) if pnu else None
        f.update({
            "store_age_m": float(STABLE_AGE_M),
            "bld_n": b[0] if b else None, "bld_area": b[1] if b else None, "bld_age": (2026 - b[2]) if b and b[2] else None,
            "bld_use": b[3] if b else None, "bld_parking": b[4] if b else None,
            "road_class": land[0] if land else None, "corner": land[1] if land else None, "use_zone": land[2] if land else None,
            "land_height": land[3] if land else None, "land_fig": land[4] if land else None, "land_price": land[5] if land else None,
        })
        cx, cy = int(np.floor(lng / (self.s["cell_size"] * 1.25))), int(np.floor(lat / self.s["cell_size"]))
        comp = self._get(self.s3["comp"], (cx, cy, kb_ind))
        f["nb_branded_share"] = float(comp.branded / comp.n) if comp is not None and comp.n else np.nan
        group = v3.group_of(kb_ind)
        model, mlo, mhi = self.models[group]
        scale = self.s3["range_scale"].get(group, 1.0)
        brand = self.match_brand(store_name) if store_name else None
        variants = {}
        for v, fr, br in [("franchise", 1, brand or "기타 브랜드"), ("independent", 0, "-")]:
            row = dict(f, franchise=fr, brand=br if br in self.cats3["brand"] else ("기타 브랜드" if br != "-" else "-"))
            bf = self.s["brand_ftc"].loc[br] if br in self.s["brand_ftc"].index else None
            row["brand_avg_sales"] = None if bf is None or not bf.brand_avg_sales else bf.brand_avg_sales
            row["brand_stores"] = None if bf is None else bf.brand_stores
            sb = self._get(self.s3["same_brand"], (cx, cy, br)) if v == "franchise" and brand else None
            row["nb_same_brand"] = float(sb) if sb is not None else 0.0
            X = pd.DataFrame([row])[v3.FEATS]
            for c in v3.CATS:
                X[c] = pd.Categorical(X[c].astype(str).where(X[c].notna(), None), categories=self.cats3[c])
            for c in X.columns:
                if c not in v3.CATS:
                    X[c] = pd.to_numeric(X[c], errors="coerce")
            p, lo, hi = (float(mm.predict(X)[0]) for mm in (model, mlo, mhi))
            lo, hi = p - scale * max(p - lo, 0), p + scale * max(hi - p, 0)
            card = {"p10": round(float(np.expm1(lo)), -4), "p50": round(float(np.expm1(p)), -4), "p90": round(float(np.expm1(hi)), -4)}
            ratio, basis = self._ratio(brand if v == "franchise" else None, kb_ind)
            variants[v] = {"card": card, "total_est": {k: round(x * ratio, -4) for k, x in card.items()}, "brand": row["brand"] if v == "franchise" else None,
                           "calib_ratio": ratio, "calib_basis": basis, "closure": self._close_risk(f, card["p50"], group)}
        return {"available": True, "model": "sales-v3", "unit": "KRW/month", "card_industry": kb_ind, "group": group, "floor": fl,
                "site_area": site_area, "calib_ratio": variants["franchise" if brand else "independent"]["calib_ratio"],
                "variants": variants, "context": ctx, "brand_matched": brand, "first_month_note": "개업 첫 달은 안정기보다 10~15% 낮다"}
