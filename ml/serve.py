"""Model worker for the Agent API. Line-delimited JSON over stdin/stdout, one request per line.

  {"id": 1, "op": "ping"}
  {"id": 2, "op": "survival", "lat": 37.56, "lng": 126.98, "uptae": "한식", "sido_nm": "서울특별시", "site_area": 66}
  {"id": 3, "op": "sales", "trdar_cd": "3110008", "ind": "CS100001"}
  {"id": 4, "op": "survival_cvs", "lat": 37.56, "lng": 126.98, "brand": "GS25", "sido_nm": "서울특별시"}
  {"id": 5, "op": "survival_cafe", "lat": 37.56, "lng": 126.98, "names": ["메가커피 시청점"], "sido_nm": "서울특별시"}
  {"id": 6, "op": "sales_v2", "lat": 37.50, "lng": 127.04, "pnu": "1168010100107370000", "scls": "I21201", "store_name": "메가커피", "floor": 1, "site_area": 66}

Started and kept alive by web/server/agent/models.ts. Logs go to stderr; stdout carries only responses.
"""
import json
import sys
import time
from datetime import date

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import OUT
from sales_v0 import CATS, SEOUL, panel
from survival_v0 import DAY0, NAMES, R, VARIANTS, LicenseIndex, add_derived
import survival_cafe_v0 as cafe
import survival_cvs_v0 as cvs


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Models:
    def __init__(self):
        t0 = time.time()
        self.lic = LicenseIndex()
        self.surv = {v: lgb.Booster(model_file=str(OUT / f"survival_v0_{v}.txt")) for v in VARIANTS}
        # Reference distribution for percentiles: predictions on the cached 2021H2-2022 cohort, per 업태.
        ref = pd.read_pickle(OUT / "survival_v0_features.pkl")
        ref = ref[ref.apv_perm_ymd >= "2021-07"]
        self.uptae_cats = ref.uptae_nm.cat.categories
        self.sido_cats = ref.sido_nm.cat.categories
        self.ref = {}
        for v, X in VARIANTS.items():
            p = self.surv[v].predict(ref[X])
            self.ref[v] = {u: np.sort(p[(ref.uptae_nm == u).values]) for u in self.uptae_cats}
            self.ref[v]["*"] = np.sort(p)

        # 편의점 (담배소매업 인허가) — shares the 음식점 index as its demand proxy
        self.cvs = cvs.CvsIndex(food=self.lic)
        self.cvs_model = lgb.Booster(model_file=str(OUT / "survival_cvs_v0.txt"))
        cref = pd.read_pickle(OUT / "survival_cvs_v0_features.pkl")
        cref = cref[cref.apv_perm_ymd >= "2021-07"]
        self.cvs_brand_cats = cref.brand.cat.categories
        self.cvs_sido_cats = cref.sido_nm.cat.categories
        cp = self.cvs_model.predict(cref[cvs.X_COLS])
        self.cvs_ref = {b: np.sort(cp[(cref.brand == b).values]) for b in self.cvs_brand_cats}
        self.cvs_ref["*"] = np.sort(cp)

        # 카페 (휴게음식점 커피숍 인허가) — same layout as 편의점; skipped until survival_cafe_v0.py has been run
        self.cafe_model = None
        if (OUT / "survival_cafe_v0.txt").exists():
            self._load_cafe()

        rep = json.loads((OUT / "sales_v0_report.json").read_text(encoding="utf-8"))
        self.sales_resid = (rep["seoul"]["resid_log_q10"], rep["seoul"]["resid_log_q90"])
        self.sales = lgb.Booster(model_file=str(OUT / "sales_v0_seoul.txt"))
        df = panel()
        self.quarter = df.yq.max()
        self.panel = df[df.yq == self.quarter].copy()
        log(f"[ml] ready in {time.time() - t0:.1f}s (licenses {len(self.lic.lic):,}, quarter {self.quarter})")

    def _load_cafe(self):
        self.cafe = cafe.CafeIndex(food=self.lic)
        self.cafe_model = lgb.Booster(model_file=str(OUT / "survival_cafe_v0.txt"))
        fref = pd.read_pickle(OUT / "survival_cafe_v0_features.pkl")
        fref = fref[fref.apv_perm_ymd >= "2021-07"]
        self.cafe_brand_cats = fref.brand.cat.categories
        self.cafe_sido_cats = fref.sido_nm.cat.categories
        fp = self.cafe_model.predict(fref[cafe.X_COLS])
        self.cafe_ref = {b: np.sort(fp[(fref.brand == b).values]) for b in self.cafe_brand_cats}
        self.cafe_ref["*"] = np.sort(fp)

    def survival(self, lat: float, lng: float, uptae: str, sido_nm: str, site_area: float | None) -> dict:
        xy = self.lic.to_xy([lng], [lat])
        nb, d = self.lic.tree.query_radius(xy, r=R, return_distance=True)
        t = float((np.datetime64(date.today()) - DAY0).astype(int))
        row = dict(zip(NAMES, self.lic.features(nb[0], d[0], t, uptae)))
        row.update(site_area=site_area, open_month=date.today().month, multused_yn="N",
                   uptae_nm=uptae if uptae in self.uptae_cats else "기타",
                   sido_nm=sido_nm if sido_nm in self.sido_cats else None)
        X = add_derived(pd.DataFrame([row]))
        X["uptae_nm"] = pd.Categorical(X.uptae_nm, categories=self.uptae_cats)
        X["sido_nm"] = pd.Categorical(X.sido_nm, categories=self.sido_cats)
        X["multused_yn"] = pd.Categorical(X.multused_yn, categories=["N", "NA", "Y"])
        variant = "full" if site_area else "location"
        p_close = float(self.surv[variant].predict(X[VARIANTS[variant]])[0])
        ref = self.ref[variant].get(row["uptae_nm"])
        if ref is None or len(ref) < 200:
            ref = self.ref[variant]["*"]
        # Higher score = lower closure risk than peers of the same 업태.
        score = 100 * (1 - np.searchsorted(ref, p_close) / len(ref))
        feats = {k: (None if pd.isna(v) else round(float(v), 4)) for k, v in X.iloc[0][NAMES + ["churn_12m"]].items()}
        return {"model": "food", "close_3y_prob": round(p_close, 4), "survival_3y_prob": round(1 - p_close, 4),
                "score": round(float(score), 1), "variant": variant, "uptae_used": row["uptae_nm"],
                "reference_n": int(len(ref)), "features": feats}

    def survival_cvs(self, lat: float, lng: float, brand: str | None, sido_nm: str | None) -> dict:
        brand = brand if brand in self.cvs_brand_cats else "기타"
        xy = LicenseIndex.to_xy([lng], [lat])
        nb, d = self.cvs.tree.query_radius(xy, r=cvs.R, return_distance=True)
        t = float((np.datetime64(date.today()) - DAY0).astype(int))
        row = dict(zip(cvs.NAMES, self.cvs.features(nb[0], d[0], t, brand, lng, lat)))
        row.update(open_month=date.today().month, brand=brand, sido_nm=sido_nm if sido_nm in self.cvs_sido_cats else None)
        X = cvs.add_derived(pd.DataFrame([row]))
        X["brand"] = pd.Categorical(X.brand, categories=self.cvs_brand_cats)
        X["sido_nm"] = pd.Categorical(X.sido_nm, categories=self.cvs_sido_cats)
        p_close = float(self.cvs_model.predict(X[cvs.X_COLS])[0])
        ref = self.cvs_ref.get(brand)
        if ref is None or len(ref) < 200:
            ref = self.cvs_ref["*"]
        score = 100 * (1 - np.searchsorted(ref, p_close) / len(ref))
        feats = {k: (None if pd.isna(v) else round(float(v), 4)) for k, v in X.iloc[0][cvs.NAMES + ["churn_12m"]].items()}
        return {"model": "cvs", "close_3y_prob": round(p_close, 4), "survival_3y_prob": round(1 - p_close, 4),
                "score": round(float(score), 1), "variant": "location", "uptae_used": brand if brand != "기타" else "편의점(브랜드 미확인)",
                "reference_n": int(len(ref)), "features": feats}

    def survival_cafe(self, lat: float, lng: float, names: list[str | None], sido_nm: str | None) -> dict:
        if self.cafe_model is None:
            raise ValueError("카페 생존 모델 파일 없음 (ml/survival_cafe_v0.py 실행 후 worker 재시작 필요)")
        brand = cafe.brand_of(*names)
        brand =brand if brand in self.cafe_brand_cats else "기타"
        xy = LicenseIndex.to_xy([lng], [lat])
        nb, d = self.cafe.tree.query_radius(xy, r=cafe.R, return_distance=True)
        t = float((np.datetime64(date.today()) - DAY0).astype(int))
        row = dict(zip(cafe.NAMES, self.cafe.features(nb[0], d[0], t, brand, lng, lat)))
        row.update(open_month=date.today().month, brand=brand, sido_nm=sido_nm if sido_nm in self.cafe_sido_cats else None)
        X = cafe.add_derived(pd.DataFrame([row]))
        X["brand"] = pd.Categorical(X.brand, categories=self.cafe_brand_cats)
        X["sido_nm"] = pd.Categorical(X.sido_nm, categories=self.cafe_sido_cats)
        p_close = float(self.cafe_model.predict(X[cafe.X_COLS])[0])
        # 비교 집단: 같은 브랜드 신규 개점 (200곳 미만이면 카페 전체), 브랜드 미확인이면 개인·기타 카페
        ref, peer = self.cafe_ref.get(brand), brand if brand != "기타" else "개인·기타 카페"
        if ref is None or len(ref) < 200:
            ref, peer = self.cafe_ref["*"], "카페 전체"
        score = 100 * (1 - np.searchsorted(ref, p_close) / len(ref))
        feats = {k: (None if pd.isna(v) else round(float(v), 4)) for k, v in X.iloc[0][cafe.NAMES + ["churn_12m"]].items()}
        return {"model": "cafe", "close_3y_prob": round(p_close, 4), "survival_3y_prob": round(1 - p_close, 4),
                "score": round(float(score), 1), "variant": "location", "uptae_used": peer,
                "reference_n": int(len(ref)), "features": feats}

    def sales_v2(self, req: dict) -> dict:
        """전국 매장 매출 (사내 카드매출 학습). v3 파일(sales_v3_export.py)이 있으면 v3, 없으면 v2. 첫 요청 때 불러온다."""
        if not hasattr(self, "_sales_v2"):
            if not ((OUT / "sales_v2.txt").exists() and (OUT / "sales_v2_store.pkl").exists()):
                return {"available": False, "reason": "sales_v2 모델 파일 없음 (ml/sales_v2.py 실행 전)"}
            t0 = time.time()
            if (OUT / "sales_v3_store.pkl").exists():
                from sales_v3_serve import SalesV3
                self._sales_v2 = SalesV3()
            else:
                from sales_v2_serve import SalesV2
                self._sales_v2 = SalesV2()
            log(f"[ml] {type(self._sales_v2).__name__} loaded in {time.time() - t0:.1f}s")
        return self._sales_v2.predict(req["lat"], req["lng"], req.get("pnu"), req.get("scls"), req.get("store_name"), req.get("floor"), req.get("site_area"))

    def sales_seoul(self, trdar_cd: str, ind: str) -> dict:
        area = self.panel[self.panel.trdar_cd == trdar_cd]
        if area.empty:
            return {"available": False, "reason": "상권 데이터 없음"}
        cell = area[area.ind == ind]
        if cell.empty:
            # 업종이 아직 없는 상권: 상권 공통 값만 쓰고 점포 수는 0으로 둔다.
            cell = area.iloc[[0]].copy()
            cell["ind"] = pd.Categorical([ind], categories=self.panel.ind.cat.categories)
            cell[["stores", "frc_stores", "open_rt", "close_rt", "sales_amt", "sales_per_store"]] = [0, 0, np.nan, np.nan, np.nan, np.nan]
        X = cell[SEOUL].copy()
        for c in CATS:
            X[c] = pd.Categorical(X[c].astype(str), categories=self.panel[c].cat.categories)
        p50 = float(self.sales.predict(X)[0])
        q10, q90 = self.sales_resid
        to_won = lambda v: round(float(np.expm1(v)), -4)
        bench = cell.sales_per_store.iloc[0]
        return {"available": True, "quarter": self.quarter, "unit": "KRW/month",
                "p10": to_won(p50 + q10), "p50": to_won(p50), "p90": to_won(p50 + q90),
                "benchmark_per_store": None if pd.isna(bench) else round(float(bench), -4),
                "benchmark_stores": int(cell.stores.iloc[0])}


def main():
    # Windows pipes default to the ANSI code page; the Node side speaks UTF-8.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    models = Models()
    print(json.dumps({"id": 0, "ok": True, "ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "ping":
                out = {"pong": True}
            elif op == "survival":
                out = models.survival(req["lat"], req["lng"], req["uptae"], req["sido_nm"], req.get("site_area"))
            elif op == "survival_cvs":
                out = models.survival_cvs(req["lat"], req["lng"], req.get("brand"), req.get("sido_nm"))
            elif op == "survival_cafe":
                out = models.survival_cafe(req["lat"], req["lng"], req.get("names") or [], req.get("sido_nm"))
            elif op == "sales":
                out = models.sales_seoul(str(req["trdar_cd"]), req["ind"])
            elif op == "sales_v2":
                out = models.sales_v2(req)
            else:
                raise ValueError(f"unknown op {op}")
            print(json.dumps({"id": req.get("id"), "ok": True, "result": out}, ensure_ascii=False), flush=True)
        except Exception as e:  # report and keep serving
            log(f"[ml] error: {e!r}")
            print(json.dumps({"id": req.get("id"), "ok": False, "error": str(e)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
