# ml — 점수·생존·매출 모델 v0

`data/commerce.sqlite`를 읽기 전용으로 읽는다. 설계와 성능 해석은 [docs/08_API_명세.md](../docs/08_API_명세.md) 4~6장에 있다.

```
py -3.14 -m venv ml/.venv
ml/.venv/Scripts/python -m pip install lightgbm pandas scikit-learn pyyaml

cd ml
.venv/Scripts/python score_v0.py      # 규칙 점수 + 백테스트      → out/score_v0_*.csv, score_v0_report.json
.venv/Scripts/python survival_v0.py   # 음식점 3년 생존 (전국)     → out/survival_v0_{full,location}.txt, report
.venv/Scripts/python sales_v0.py      # 서울 상권×업종 점포당 매출 → out/sales_v0_{seoul,national}.txt, report
.venv/Scripts/python survival_cvs_v0.py # 편의점 3년 생존 (담배소매업, 간판 교체 제외) → out/survival_cvs_v0.txt, report
.venv/Scripts/python survival_cafe_v0.py # 카페 3년 생존 (휴게음식점 커피숍, 간판 교체 제외) → out/survival_cafe_v0.txt, report
.venv/Scripts/python flowpop_v0.py    # 행정동 유동인구 (경기 실측 학습) → out/flowpop_v0.json, report, DB flowpop_est_dong
```

- `flowpop_v0.py`의 원천(경기 유동인구)은 공공누리 2유형이라 결과는 **내부 심사 한정**이다 ([docs/10](../docs/10_데이터_이용조건.md)). 시 단위 leave-one-out 검증: Ridge R²(log) 0.89, 인구+종사자 단순회귀 0.86, LightGBM 0.85.
- `survival_v0.py`는 처음 실행할 때 반경 피처를 계산해 `out/survival_v0_features.pkl`에 캐시한다 (수 분 소요). 인허가 데이터를 다시 적재하면 이 파일을 지운다.
- `serve.py`는 `out/survival_cafe_v0.txt`가 없으면 카페 모델만 빼고 뜬다 (요청 시 오류). 학습 후에는 API 서버를 재시작해야 worker가 새 모델을 읽는다.
- 모델 파일은 LightGBM 텍스트 형식이라 Node 서빙 쪽에서도 읽을 수 있다.
