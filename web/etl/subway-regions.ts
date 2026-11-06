// 서울 밖 도시철도 역별 승하차 (각 교통공사 파일, 공공데이터포털, CP949 CSV) → subway_station_stats.
// 파일마다 형식이 달라 지역별로 읽고, 역별 하루 평균 승하차와 가장 붐비는 시간만 남긴다 (서울은 subway_daily를 그대로 쓴다).
//
//   npx tsx etl/subway-regions.ts data/raw
//
// 이후 기간은 각 기관 API로 갱신한다 (docs/TODO.md).
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb, WEB_ROOT, type Row } from './lib.ts';

const dir = resolve(WEB_ROOT, '..', process.argv[2] ?? 'data/raw');

type Rec = { station: string; line: string; ymd: string; riders: number; byHour: Map<number, number> | null };

const read = (f: string) => {
  const [head, ...lines] = new TextDecoder('euc-kr').decode(readFileSync(resolve(dir, f))).split(/\r?\n/).filter((l) => l.trim());
  return { cols: head.split(',').map((c) => c.trim()), rows: lines.map((l) => l.split(',').map((c) => c.trim())) };
};
/** "05_06", "05시-06시", "03-04시", "24시-01시" → start hour (24 → 0); other columns → null */
const hourOf = (c: string) => {
  const m = /^(\d{2})(?:시)?[-_](\d{2})시?$/.exec(c);
  return m ? Number(m[1]) % 24 : null;
};
function hourly(cols: string[], r: string[]) {
  const m = new Map<number, number>();
  cols.forEach((c, i) => {
    const h = hourOf(c);
    if (h != null) m.set(h, (m.get(h) ?? 0) + (Number(r[i]) || 0));
  });
  return m;
}

const REGIONS: { region: string; match: RegExp; provider: string; parse: (f: string) => Rec[] }[] = [
  {
    region: '부산',
    match: /^부산교통공사_시간대별/,
    provider: '부산교통공사',
    // 역번호,역명,년월일,요일,구분,합계,01시-02시…
    parse: (f) => {
      const { cols, rows } = read(f);
      const [iNm, iYmd, iSum] = ['역명', '년월일', '합계'].map((c) => cols.indexOf(c));
      return rows.map((r) => ({ station: r[iNm], line: '', ymd: r[iYmd], riders: Number(r[iSum]) || 0, byHour: hourly(cols, r) }));
    },
  },
  {
    region: '대구',
    match: /^대구교통공사_역별일별시간별/,
    provider: '대구교통공사',
    // 월,일,역번호,역명,승하차,05시-06시…,일계 — 연도는 파일명 기준일에서
    parse: (f) => {
      const year = /_(\d{4})\d{4}\.csv$/.exec(f)?.[1] ?? '';
      const { cols, rows } = read(f);
      const [iM, iD, iNm, iSum] = ['월', '일', '역명', '일계'].map((c) => cols.indexOf(c));
      // 환승역은 노선 번호가 붙어 나뉜다 (반월당1·반월당2) → 한 역으로 합친다
      return rows.map((r) => ({ station: r[iNm].replace(/[1-3]$/, ''), line: '', ymd: `${year}-${r[iM].padStart(2, '0')}-${r[iD].padStart(2, '0')}`, riders: Number(r[iSum]) || 0, byHour: hourly(cols, r) }));
    },
  },
  {
    region: '광주',
    match: /^광주교통공사_역일시간대별/,
    provider: '광주교통공사',
    // 일자,역번호,역명,구분,05_06…
    parse: (f) => {
      const { cols, rows } = read(f);
      const [iNm, iYmd] = ['역명', '일자'].map((c) => cols.indexOf(c));
      return rows.map((r) => {
        const h = hourly(cols, r);
        return { station: r[iNm], line: '1호선', ymd: r[iYmd], riders: [...h.values()].reduce((a, b) => a + b, 0), byHour: h };
      });
    },
  },
  {
    region: '대전',
    match: /^대전교통공사_시간대별/,
    provider: '대전교통공사',
    // 날짜,역번호,역명,구분,03-04시…
    parse: (f) => {
      const { cols, rows } = read(f);
      const [iNm, iYmd] = ['역명', '날짜'].map((c) => cols.indexOf(c));
      return rows.map((r) => {
        const h = hourly(cols, r);
        return { station: r[iNm], line: '1호선', ymd: r[iYmd], riders: [...h.values()].reduce((a, b) => a + b, 0), byHour: h };
      });
    },
  },
  {
    region: '인천',
    match: /^인천교통공사_역별일별/,
    provider: '인천교통공사',
    // 호선,통행일자,역명,이용인원,승차인원,하차인원 — 시간대 없음
    parse: (f) => {
      const { cols, rows } = read(f);
      const [iLn, iYmd, iNm, iSum] = ['호선', '통행일자', '역명', '이용인원'].map((c) => cols.indexOf(c));
      return rows.map((r) => ({ station: r[iNm], line: `인천${r[iLn]}호선`, ymd: r[iYmd], riders: Number(r[iSum]) || 0, byHour: null }));
    },
  },
];

const stationKey = (s: string) => s.replace(/\(.*\)/, '').replace(/역$/, '').trim();

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));
db.exec(`DROP TABLE IF EXISTS subway_station_stats;
  CREATE TABLE subway_station_stats (region TEXT, station TEXT, lines TEXT, date_from TEXT, date_to TEXT, days INTEGER,
    daily_avg INTEGER, peak_hour INTEGER, provider TEXT, PRIMARY KEY (region, station));`);

const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
const summary: string[] = [];
for (const R of REGIONS) {
  const f = files.filter((x) => R.match.test(x)).sort().at(-1);
  if (!f) {
    log(`${R.region}: 파일 없음`);
    continue;
  }
  const recs = R.parse(f).filter((r) => r.station && r.ymd);
  const by = new Map<string, { lines: Set<string>; days: Set<string>; riders: number; hours: Map<number, number>; from: string; to: string }>();
  for (const r of recs) {
    const k = stationKey(r.station);
    const s = by.get(k) ?? { lines: new Set(), days: new Set(), riders: 0, hours: new Map(), from: r.ymd, to: r.ymd };
    if (r.line) s.lines.add(r.line);
    s.days.add(r.ymd);
    s.riders += r.riders;
    for (const [h, v] of r.byHour ?? []) s.hours.set(h, (s.hours.get(h) ?? 0) + v);
    if (r.ymd < s.from) s.from = r.ymd;
    if (r.ymd > s.to) s.to = r.ymd;
    by.set(k, s);
  }
  const rows: Row[] = [...by].map(([station, s]) => ({
    region: R.region,
    station,
    lines: [...s.lines].join(',') || null,
    date_from: s.from,
    date_to: s.to,
    days: s.days.size,
    daily_avg: Math.round(s.riders / Math.max(1, s.days.size)),
    peak_hour: s.hours.size ? [...s.hours].sort((a, b) => b[1] - a[1])[0][0] : null,
    provider: R.provider,
  }));
  upsert('subway_station_stats', rows);
  const from = rows.map((r) => String(r.date_from)).sort()[0];
  const to = rows.map((r) => String(r.date_to)).sort().at(-1);
  summary.push(`${R.region} ${rows.length}역 ${from}~${to}`);
  log(`${R.region}: ${f} → ${rows.length} stations, ${from}~${to}`);
}
meta('subway_station_stats', {
  source: '부산·대구·인천·광주·대전 교통공사 역별 승하차 파일 (공공데이터포털)',
  endpoint: 'data.go.kr 3057229, 15002503, 15159353, 15060048, 15060591',
  std_period: summary.join(' / '),
  status: 'loaded',
  note: '역별 하루 평균 승하차(승차+하차)와 가장 붐비는 시간. 인천은 시간대 없음. 이후 기간은 각 기관 API로 갱신 예정',
});
