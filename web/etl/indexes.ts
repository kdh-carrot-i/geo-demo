// 서빙 쿼리용 인덱스. API 서버는 DB를 읽기 전용으로 열어서 여기서 만든다. 테이블을 새로 적재(DROP → CREATE)한 뒤 다시 실행.
//   npx tsx etl/indexes.ts
// 근거 (2026-11-03 측정, 모니터링 1곳당): 반경 인허가 0.70초, 인허가 최신 날짜 0.70초, 임대료 0.45초, 시도 코드 0.55초 → 인덱스 없음
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb } from './lib.ts';

const { db } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
const INDEXES: [string, string][] = [
  // 반경 조회 (모니터링·자리의 과거·상권분석 개폐업·생존 모델 입력): 업종 + 위도 범위
  ['ix_license_event_svc_lat', 'license_event (opn_svc_id, lat, lon)'],
  // 업종별 최신 인허가일 (as_of)
  ['ix_license_event_svc_apv', 'license_event (opn_svc_id, apv_perm_ymd)'],
  // R-ONE 임대료·공실률 (상권 이름 + 항목)
  ['ix_rone_stat_grp_itm', 'rone_stat (grp_fullnm, itm_nm)'],
  ['ix_rone_stat_cls_itm', 'rone_stat (cls_fullnm, itm_nm)'],
  // 시도 이름 → 코드
  ['ix_store_ctprvn_nm', 'store (ctprvn_nm)'],
];
for (const [name, on] of INDEXES) {
  const t = Date.now();
  db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${on}`);
  log(`${name}: ${Date.now() - t}ms`);
}
db.exec('ANALYZE');
log('ANALYZE done');
