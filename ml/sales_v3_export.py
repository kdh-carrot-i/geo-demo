"""매출 v3 서빙 준비: 범위 폭 보정 + 서빙용 표 (ml/sales_v3_serve.py가 읽는다).

1) 범위 폭: 업종 묶음마다 검증 시군구에서 [p50 − s·(p50 − q10), p50 + s·(q90 − p50)] 안에 실제가 80% 들도록 s를 찾는다
   (학습한 10%·90% 분위수 그대로는 75~77%만 들어 약간 좁다).
2) 서빙용 표: sales_v2 표(3×3 칸 합계·중앙값, 매장 단위 값 없음)에 더해
   주변 같은 업종 가맹 브랜드 비율·같은 브랜드 매장 수(개수만), 브랜드·업종별 총매출 환산 비율(calib_brand.py).
   건물(bld_pnu)·토지(land_pnu)는 서빙 때 필지로 직접 조회한다.
Run: ml/.venv/Scripts/python -u ml/sales_v3_export.py
"""
import json
import pickle

import lightgbm as lgb
import numpy as np
import pandas as pd

import sales_v2 as v2
import sales_v3 as v3
from common import OUT

TARGET = 0.8


def main():
    v3.step("변수 만들기")
    df = v3.build()
    sggs = np.array(sorted(df.sgg.unique()))
    rng = np.random.default_rng(42)
    rng.shuffle(sggs)
    n = len(sggs)
    valid_sgg = set(sggs[int(n * 0.15): int(n * 0.25)])
    va = df[df.sgg.isin(valid_sgg)]

    scale = {}
    for g, slug in v3.SLUG.items():
        d = va[va.group == g]
        m, lo, hi = (lgb.Booster(model_file=str(OUT / f"sales_v3_{slug}{s}.txt")) for s in ("", "_q10", "_q90"))
        p, q10, q90 = m.predict(d[v3.FEATS]), lo.predict(d[v3.FEATS]), hi.predict(d[v3.FEATS])
        y = d.y.to_numpy()
        best = 1.0
        for s in np.arange(1.0, 2.01, 0.02):
            if ((y >= p - s * np.maximum(p - q10, 0)) & (y <= p + s * np.maximum(q90 - p, 0))).mean() >= TARGET:
                best = float(s)
                break
        scale[g] = round(best, 2)
        v3.step(f"[{g}] 범위 폭 ×{best:.2f}")

    # 경쟁 구성: 3×3 칸 같은 업종 매장 수·가맹 브랜드 수, 칸별 브랜드 매장 수 (개수만)
    nine = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
    b = df[["cx", "cy"]].assign(kb=df.kb_ind.astype(str), br=df.brand.astype(str))
    b["branded"] = (~b.br.isin(["-"])).astype(int)
    exp = pd.concat([b.assign(cx=b.cx + dx, cy=b.cy + dy) for dx, dy in nine])
    comp = exp.groupby(["cx", "cy", "kb"]).agg(n=("branded", "size"), branded=("branded", "sum"))
    same_brand = exp[exp.branded == 1].groupby(["cx", "cy", "br"]).size()

    calib = json.loads((OUT / "sales_calib_brand.json").read_text(encoding="utf-8"))
    store = {
        "range_scale": scale, "comp": comp, "same_brand": same_brand, "calib_brand": calib,
        "categories": {c: list(df[c].cat.categories) for c in v3.CATS}, "groups": list(v3.SLUG),
    }
    with open(OUT / "sales_v3_store.pkl", "wb") as f:
        pickle.dump(store, f)
    v3.step(f"서빙용 표 저장 ({(OUT / 'sales_v3_store.pkl').stat().st_size / 1e6:.0f}MB) · 범위 폭 {scale}")


if __name__ == "__main__":
    main()
