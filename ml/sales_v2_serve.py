"""매출 v2 서빙: 새 자리 하나의 변수를 sales_v2.py 학습 때와 같은 방식으로 계산해 예측한다.

serve.py의 op "sales_v2"가 쓴다. 필요한 파일: ml/out/sales_v2.txt, sales_v2_store.pkl (sales_v2.py가 만든다).
결과는 프랜차이즈일 때·개인일 때 두 가지 (같은 자리·업종·층·면적), 카드 결제 규모 예측에 총매출 환산 비율을 곱한 값.
"""
import pickle
import sqlite3

import lightgbm as lgb
import numpy as np
import pandas as pd

import sales_v1 as v1
from common import DB, OUT
from sales_v2 import CATS, FEATS


class SalesV2:
    def __init__(self):
        with open(OUT / "sales_v2_store.pkl", "rb") as f:
            self.s = pickle.load(f)
        self.model = lgb.Booster(model_file=str(OUT / "sales_v2.txt"))
        self.match_brand = v1.brand_matcher()
        self.cats = self.s["categories"]
        self.ratio = (self.s.get("calib") or {}).get("ratio_median")

    def _q(self, sql, *params):
        with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
            return con.execute(sql, params).fetchone()

    @staticmethod
    def _get(table, key, default=None):
        try:
            return table.loc[key]
        except KeyError:
            return default

    def features(self, lat, lng, pnu, kb_ind, sic, floor, site_area):
        # 서빙 표는 3×3 칸 합계·중앙값만 담는다 (매장 단위 값 없음, 매장 5곳 미만이면 비어 있음)
        s = self.s
        cx, cy = int(np.floor(lng / (s["cell_size"] * 1.25))), int(np.floor(lat / s["cell_size"]))
        nb = self._get(s["nb"], (cx, cy))
        nbi = self._get(s["nb_ind"], (cx, cy, kb_ind))
        sh_med = self._get(s["sh_nb_ind"], (cx, cy, kb_ind))
        gx, gy = int(np.floor(lng / (s["walk_cell"] * 1.25))), int(np.floor(lat / s["walk_cell"]))
        wk = self._get(s["walk_nb"], (gx, gy))
        bjd, dong8 = (pnu or "")[:10], (pnu or "")[:8]
        nps = self._q("""select sum(case when members <= 300 then members else 0 end),
                                sum(case when members <= 300 then bill else 0 end) * 1.0 / nullif(sum(case when members <= 300 then members else 0 end), 0) / 0.095
                         from nps_workplace where bjd_cd = ?""", bjd) or (None, None)
        res = self._q("select tot, hh_nmpr from resident_pop_bjd where stdg_cd = ? order by stats_ym desc limit 1", bjd) or (None, None)
        inc = s["kcb_inc"].loc[dong8] if dong8 in s["kcb_inc"].index else None
        soho = s["soho"].loc[(dong8, sic)] if sic and (dong8, sic) in s["soho"].index else None
        hh = 0
        try:
            d = 0.01
            for h_lat, h_lon, n in sqlite3.connect(f"file:{DB}?mode=ro", uri=True).execute(
                    """select lat, lon, hhld from housing_permit where lat between ? and ? and lon between ? and ?
                       and use_inspt_day is null and use_inspt_sched_day >= strftime('%Y%m%d','now')""", (lat - d, lat + d, lng - d * 1.25, lng + d * 1.25)):
                if 6371000 * np.hypot(np.radians(h_lon - lng) * np.cos(np.radians(lat)), np.radians(h_lat - lat)) <= 1000:
                    hh += n
        except sqlite3.Error:
            pass
        ps = self._get(s["pnu_sh"], pnu) if pnu else None
        nb_same = float(nbi.n) if nbi is not None else 0.0
        walk = float(wk.walk) if wk is not None and wk.walk else None
        f = {
            "kb_ind": kb_ind, "sido": (pnu or "")[:2], "floor": floor,
            "nb_stores": float(nb.nb_n) if nb is not None else 0.0, "nb_same": nb_same,
            "nb_same_med": float(nbi.med) if nbi is not None and not pd.isna(nbi.med) else np.nan,
            "nb_amt_sum": float(nb.nb_sum) if nb is not None and not pd.isna(nb.nb_sum) else np.nan,
            "cell_stores": float(self._get(s["cell_n"], (cx, cy), 0)), "cell_same": float(self._get(s["cell_ind_n"], (cx, cy, kb_ind), 0)),
            "nps_members": nps[0], "nps_income": nps[1], "res_pop": res[0], "res_pph": res[1],
            "site_area": site_area if site_area else np.nan,
            "pnu_sh_amt": float(ps["sum"]) if ps is not None else np.nan, "pnu_sh_n": float(ps["size"]) if ps is not None else np.nan,
            "nb_sh_same_med": float(sh_med) if sh_med is not None else np.nan,
            "walk_300": walk if walk else np.nan, "walk_lunch": float(wk.l / walk) if walk else np.nan, "walk_eve": float(wk.e / walk) if walk else np.nan,
            "res_income": None if inc is None else inc.res_income, "res_spend": None if inc is None else inc.res_spend,
            "work_income": None if inc is None else inc.work_income, "work_spend": None if inc is None else inc.work_spend,
            "soho_income": None if soho is None else soho.soho_income, "soho_close_rt": None if soho is None else soho.soho_close_rt,
            "soho_dlq_rt": None if soho is None else soho.soho_dlq_rt,
            "upcoming_hh_1km": float(hh),
        }
        med = f["nb_same_med"]
        context = {"neighbours_same_industry": int(nb_same), "neighbour_median_card": None if pd.isna(med) else round(med, -4)}
        return f, context

    def predict(self, lat, lng, pnu, scls, store_name=None, floor=None, site_area=None):
        m = self.s["scls_map"].get(scls)
        if not m:
            return {"available": False, "reason": f"업종 {scls}의 카드 매출 업종 대응이 없음 (연결된 매장 20곳 미만)"}
        kb_ind, sic = m["kb_ind"], m.get("sic")
        fl = "?" if floor is None else "B" if floor < 0 else "1" if floor <= 1 else "2" if floor == 2 else "3+"
        f, ctx = self.features(lat, lng, pnu, kb_ind, sic, fl, site_area)
        brand = self.match_brand(store_name) if store_name else None
        variants = {}
        for v, fr, br in [("franchise", 1, brand or "기타 브랜드"), ("independent", 0, "-")]:
            row = dict(f, franchise=fr, brand=br if br in self.cats["brand"] else ("기타 브랜드" if br != "-" else "-"))
            b = self.s["brand_ftc"].loc[br] if br in self.s["brand_ftc"].index else None
            row["brand_avg_sales"] = None if b is None or not b.brand_avg_sales else b.brand_avg_sales
            row["brand_stores"] = None if b is None else b.brand_stores
            X = pd.DataFrame([row])[FEATS]
            for c in CATS:
                X[c] = pd.Categorical(X[c].astype(str), categories=self.cats[c])
            for c in X.columns:
                if c not in CATS:
                    X[c] = pd.to_numeric(X[c], errors="coerce")
            p = float(self.model.predict(X)[0])
            q10, q90 = self.s["resid"][v]
            kb = {k: round(float(np.expm1(p + d)), -4) for k, d in [("p10", q10), ("p50", 0.0), ("p90", q90)]}
            total = {k: round(val * self.ratio, -4) for k, val in kb.items()} if self.ratio else None
            variants[v] = {"card": kb, "total_est": total, "brand": row["brand"] if v == "franchise" else None}
        return {"available": True, "model": "sales-v2", "unit": "KRW/month", "card_industry": kb_ind, "floor": fl,
                "site_area": site_area, "calib_ratio": self.ratio, "variants": variants, "context": ctx,
                "brand_matched": brand}
