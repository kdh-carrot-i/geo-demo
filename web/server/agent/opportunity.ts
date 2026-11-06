// 유망 입지 찾기: 업종 하나를 골라 전국(또는 시도) 상권영역마다 "상권은 활발한데 그 업종은 덜 밀집한 곳" 순위.
// 미리 센 zone_store_total / zone_store_scls / sido_scls_share (etl/zone-stats.ts)만 읽어 바로 계산한다.
import { all, one } from './db.ts';
import { industryCatalog } from './industry.ts';
import { ApiProblem } from './problem.ts';

const MIN_STORES = 100;

export interface Opportunity {
  id: string;
  name: string;
  sido: string;
  sgg: string;
  area_m2: number;
  stores_total: number;
  same_industry: number;
  /** 이 상권의 업종 비중 ÷ 같은 시도 비중 */
  lq: number;
  /** 시도(또는 전국) 안 순위 — 시군구로 걸러도 그대로 */
  rank?: number;
  /** 후보 상권 중 전체 점포 수 백분위 (0~100) */
  activity: number;
  /** 100 − 50 × LQ (0~100): 덜 밀집할수록 높다 */
  room: number;
  /** 3년 안 입주 예정 세대 (상권 경계 1km 안, 100세대 이상 단지) */
  upcoming_hh: number;
  /** 입주 예정 세대로 본 성장 여지 (0~100, 5,000세대 = 100) */
  growth: number;
  upcoming: { name: string | null; hh: number; move_in: string; distance_m: number }[];
  score: number;
  note: string | null;
}

export function opportunities(input: { industry: string; sido?: string; sgg?: string; limit?: number; upcomingOnly?: boolean }) {
  const code = input.industry.trim().toUpperCase();
  const ind = industryCatalog().find((s) => s.code === code);
  if (!ind) throw new ApiProblem(400, '업종 코드 오류', `상가정보 소분류 코드가 아닙니다: ${input.industry}. GET /industries?q= 로 찾으십시오.`);
  const limit = Math.min(100, Math.max(1, input.limit ?? 30));
  const sido = input.sido?.trim();
  // 시군구는 상권이 몇 곳뿐이라 그 안에서 순위를 매기지 않는다: 시도(없으면 전국) 기준으로 점수를 매긴 뒤 시군구로 거른다
  const sgg = sido ? input.sgg?.trim() : undefined;

  const rows = all<{ trar_no: string; total: number; ctprvn_cd: string; n: number; main_trar_nm: string; ctprvn_nm: string; signgu_nm: string; trar_area: number; hh: number | null; detail: string | null }>(
    `select t.trar_no, t.total, t.ctprvn_cd, coalesce(s.n, 0) n, z.main_trar_nm, z.ctprvn_nm, z.signgu_nm, z.trar_area, h.upcoming_hh hh, h.detail
     from zone_store_total t join trade_zone_sbiz z on z.trar_no = t.trar_no
     left join zone_store_scls s on s.trar_no = t.trar_no and s.scls_cd = ?
     left join zone_housing h on h.trar_no = t.trar_no
     where t.total >= ? ${sido ? 'and z.ctprvn_nm like ?' : ''}`,
    code, MIN_STORES, ...(sido ? [`${sido}%`] : []),
  );
  if (!rows.length) return { industry: { code, name: ind.name }, sido: sido ?? null, sgg: sgg ?? null, count: 0, items: [] as Opportunity[], sgg_options: [], method: METHOD };
  const share = new Map(all<{ c: string; s: number }>('select ctprvn_cd c, share s from sido_scls_share where scls_cd = ?', code).map((r) => [r.c, r.s]));
  const national = one<{ s: number }>('select sum(n) * 1.0 / (select count(*) from store) s from sido_scls_share where scls_cd = ?', code)?.s ?? 0;
  const totals = rows.map((r) => r.total).sort((a, b) => a - b);
  const pctile = (v: number) => {
    let lo = 0;
    while (lo < totals.length && totals[lo] < v) lo++;
    return (100 * lo) / Math.max(1, totals.length - 1);
  };

  const items: Opportunity[] = rows.map((r) => {
    const base = share.get(r.ctprvn_cd) ?? national;
    const lq = base ? r.n / r.total / base : 0;
    const activity = Math.min(100, pctile(r.total));
    const room = Math.max(0, Math.min(100, 100 - 50 * lq));
    const hh = r.hh ?? 0;
    const growth = Math.min(100, hh / 50);
    return {
      id: `zone:${r.trar_no}`,
      name: r.main_trar_nm,
      sido: r.ctprvn_nm,
      sgg: r.signgu_nm,
      area_m2: Math.round(Number(r.trar_area)),
      stores_total: r.total,
      same_industry: r.n,
      lq: Math.round(lq * 100) / 100,
      activity: Math.round(activity * 10) / 10,
      room: Math.round(room * 10) / 10,
      upcoming_hh: hh,
      growth: Math.round(growth * 10) / 10,
      upcoming: r.detail ? JSON.parse(r.detail) : [],
      score: Math.round((0.45 * activity + 0.45 * room + 0.1 * growth) * 10) / 10,
      note: r.n === 0 ? `이 상권에 ${ind.name} 점포가 없음 — 수요가 없는 업종일 수도 있어 현장 확인 필요` : null,
    };
  });
  items.sort((a, b) => b.score - a.score || b.stores_total - a.stores_total);
  const ranked = items.map((x, i) => ({ ...x, rank: i + 1 }));
  const picked = (sgg ? ranked.filter((x) => x.sgg === sgg || x.sgg.startsWith(`${sgg} `)) : ranked).filter((x) => !input.upcomingOnly || x.upcoming_hh > 0);
  // 시도 안 시군구 목록 (상권 수): 화면의 시군구 선택용. 구가 있는 시는 시 단위도 함께 ("수원시" ⊃ "수원시 권선구")
  const sggCount = new Map<string, number>();
  if (sido)
    for (const x of items) {
      sggCount.set(x.sgg, (sggCount.get(x.sgg) ?? 0) + 1);
      const city = x.sgg.split(' ')[0];
      if (city !== x.sgg) sggCount.set(city, (sggCount.get(city) ?? 0) + 1);
    }
  return {
    industry: { code, name: ind.name },
    sido: sido ?? null,
    sgg: sgg ?? null,
    /** 점수를 매긴 상권 수 (시도 또는 전국) */
    count: items.length,
    /** 시군구로 거른 뒤 상권 수 */
    count_filtered: picked.length,
    items: picked.slice(0, limit),
    sgg_options: [...sggCount].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([name, zones]) => ({ name, zones })),
    method: METHOD,
    sources: ['소상공인시장진흥공단 상가(상권)정보 (점포)', '소상공인시장진흥공단 상권영역 (경계)', '국토교통부 건축HUB 주택인허가 (입주 예정 세대)'],
    as_of: one<{ p: string }>("select std_period p from meta_source where table_name = 'store'")?.p ?? '',
  };
}

const METHOD =
  `전국 소상공인 상권영역 중 점포 ${MIN_STORES}곳 이상인 곳을 비교한다. 활성도 = 후보 상권 안에서 전체 점포 수의 백분위, ` +
  '여유도 = 100 − 50 × 입지계수(이 상권의 업종 비중 ÷ 같은 시도 비중). ' +
  '성장 = 상권 경계 1km 안 3년 내 입주 예정 세대(100세대 이상 단지, 건축HUB 주택인허가) ÷ 50, 최대 100(5,000세대). 점수 = 활성도 45% + 여유도 45% + 성장 10%. ' +
  '"상권은 활발한데 이 업종은 시도 평균보다 적고, 곧 입주가 몰리는 곳"이 위로 온다. 시군구를 고르면 점수는 시도 기준 그대로 두고 그 시군구 상권만 보여 준다. 현재 인구·임대료·매출은 아직 반영하지 않은 1차 선별이므로 상권 리포트로 확인한다.';
