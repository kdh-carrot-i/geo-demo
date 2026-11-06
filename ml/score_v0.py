"""상권점수 v0: rule-based percentile score per 상권 × 업종 (Seoul), plus a backtest.

Sub-scores are percentiles (0-100); see docs/08_API_명세.md 4장 for the definition.
Run: ml/.venv/Scripts/python ml/score_v0.py
"""
import json

import numpy as np
import pandas as pd

from common import OUT, area_panel, prev_quarter

WEIGHTS = {"sales_power": 0.30, "demand": 0.25, "competition": 0.20, "stability": 0.15, "growth": 0.10}


def pct(s: pd.Series, by: pd.Series | None = None) -> pd.Series:
    if by is None:
        return s.rank(pct=True) * 100
    return s.groupby(by).rank(pct=True) * 100


def score_quarter(df: pd.DataFrame, yq: str) -> pd.DataFrame:
    cur = df[df.yq == yq].copy()
    yoy = df[df.yq == prev_quarter(yq, 4)][["trdar_cd", "ind", "sales_amt"]].rename(columns={"sales_amt": "sales_yoy"})
    close4 = (df[df.yq.isin([prev_quarter(yq, i) for i in range(4)])]
              .groupby(["trdar_cd", "ind"])["close_rt"].mean().rename("close_rt_4q").reset_index())
    cur = cur.merge(yoy, on=["trdar_cd", "ind"], how="left").merge(close4, on=["trdar_cd", "ind"], how="left")

    area = cur.drop_duplicates("trdar_cd")[["trdar_cd", "flpop", "wrcpop", "repop"]]
    area["demand"] = (0.5 * pct(area.flpop) + 0.25 * pct(area.wrcpop) + 0.25 * pct(area.repop))
    cur = cur.merge(area[["trdar_cd", "demand"]], on="trdar_cd", how="left")

    cur["sales_power"] = pct(cur.sales_per_store, cur.ind)
    cur["stores_per_10k_flpop"] = cur.stores / (cur.flpop / 1e4).where(cur.flpop > 0)
    cur["competition"] = 100 - pct(cur.stores_per_10k_flpop, cur.ind)
    cur["stability"] = 100 - pct(cur.close_rt_4q, cur.ind)
    cur["sales_yoy_rt"] = cur.sales_amt / cur.sales_yoy - 1
    cur["growth"] = pct(cur.sales_yoy_rt, cur.ind)

    parts = pd.DataFrame({k: cur[k] for k in WEIGHTS})
    w = pd.Series(WEIGHTS)
    avail = parts.notna()
    cur["score"] = (parts.fillna(0) * w).sum(axis=1) / (avail * w).sum(axis=1)
    cur["score_parts_used"] = avail.sum(axis=1)
    return cur


def backtest(df: pd.DataFrame, yq: str, horizon: int = 3) -> dict:
    """Score at yq, then compare with what happened over the next `horizon` quarters."""
    s = score_quarter(df, yq)
    fut_q = [prev_quarter(yq, -i) for i in range(1, horizon + 1)]
    fut = df[df.yq.isin(fut_q)].groupby(["trdar_cd", "ind"]).agg(
        fut_close_rt=("close_rt", "mean"), fut_sps=("sales_per_store", "mean")).reset_index()
    m = s.merge(fut, on=["trdar_cd", "ind"], how="inner")
    m = m[m.stores >= 3]  # tiny cells make rates meaningless
    m["fut_sps_chg"] = m.fut_sps / m.sales_per_store - 1
    no_stab = (m[["sales_power", "demand", "competition", "growth"]].fillna(50)
               * pd.Series({k: WEIGHTS[k] for k in ["sales_power", "demand", "competition", "growth"]})).sum(axis=1)
    m["decile"] = pd.qcut(m.score, 10, labels=False, duplicates="drop") + 1
    by_dec = m.groupby("decile").agg(n=("score", "size"), score=("score", "mean"),
                                     fut_close_rt=("fut_close_rt", "mean")).round(2)
    return {
        "score_quarter": yq,
        "future_quarters": fut_q,
        "cells": int(len(m)),
        "spearman_score_vs_future_close_rt": round(m.score.corr(m.fut_close_rt, method="spearman"), 3),
        "spearman_score_wo_stability_vs_future_close_rt": round(no_stab.corr(m.fut_close_rt, method="spearman"), 3),
        "spearman_stability_vs_future_close_rt": round(m.stability.corr(m.fut_close_rt, method="spearman"), 3),
        "future_close_rt_by_decile": by_dec.reset_index().to_dict(orient="records"),
    }


def main():
    df = area_panel()
    latest = df.yq.max()
    s = score_quarter(df, latest)
    cols = ["yq", "trdar_cd", "ta_nm", "ta_type", "ind", "ind_nm", "stores", "sales_per_store", "flpop",
            "score", *WEIGHTS, "score_parts_used"]
    s[cols].round(2).to_csv(OUT / f"score_v0_{latest}.csv", index=False, encoding="utf-8-sig")

    bt = backtest(df, prev_quarter(latest, 3))
    report = {
        "weights": WEIGHTS,
        "latest_quarter": latest,
        "rows_scored": int(s.score.notna().sum()),
        "score_distribution": s.score.describe().round(1).to_dict(),
        "backtest": bt,
    }
    (OUT / "score_v0_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
