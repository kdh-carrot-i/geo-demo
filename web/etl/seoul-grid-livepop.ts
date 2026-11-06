// 서울 생활인구(내국인) 250m 격자 → 행정동 합계 (living_pop_dong_h).
// 서울시가 2026-07-31로 행정동 단위(SPOP_LOCAL_RESD_DONG) 생산을 끝내고 국가표준 250m 격자([내국인] 서울 생활인구(250m),
// OA-22784, Open API Se250MSpopLocalResd)로 바꿨다. 격자 행마다 행정동 코드가 붙어 있어(격자가 동 경계에 걸리면 조각으로 나뉨)
// 일자·시간·행정동별로 생활인구합계를 더하면 예전 행정동 값과 같은 형태가 된다.
// API는 하루 25만 행(250회 호출)이라 일별 ZIP 파일(약 15MB)을 받는다. 3명 이하 연령 칸은 [*]로 가려져 있어 합계만 쓴다.
//
//   npx tsx etl/seoul-grid-livepop.ts        최근 7일 (공개는 4일 늦다)
//   npx tsx etl/seoul-grid-livepop.ts 14
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DATA_DIR, log, openDb, saveRaw } from './lib.ts';

const days = Number(process.argv[2] ?? 7);
const PAGE = 'https://data.seoul.go.kr/dataList/OA-22784/F/1/datasetView.do';
const FILE = 'https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false';
// Windows 기본 tar(bsdtar)는 zip을 푼다 (Git Bash의 GNU tar는 못 푼다)
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';

const { db, upsert, meta } = openDb(resolve(DATA_DIR, 'commerce.sqlite'));

// 파일 목록: downloadFile('261031') ↔ 250_LOCAL_RESD_20261031 (일별). 월별 파일(…_202609)은 건너뛴다
const html = await (await fetch(PAGE, { signal: AbortSignal.timeout(60000) })).text();
const files = [...html.matchAll(/250_LOCAL_RESD_(\d{8})[\s\S]{0,400}?downloadFile\('(\d+)'\)/g)]
  .map((m) => ({ ymd: m[1], seq: m[2] }))
  .filter((f, i, a) => a.findIndex((x) => x.ymd === f.ymd) === i)
  .sort((a, b) => b.ymd.localeCompare(a.ymd))
  .slice(0, days);
if (!files.length) throw new Error('일별 파일 목록을 찾지 못했다 (페이지 구조 변경?)');

const loaded: string[] = [];
for (const f of files) {
  const r = await fetch(FILE, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ infId: 'OA-22784', seqNo: '', seq: f.seq, infSeq: '1' }),
    signal: AbortSignal.timeout(300000),
  });
  const zip = Buffer.from(await r.arrayBuffer());
  if (zip.subarray(0, 2).toString() !== 'PK') throw new Error(`${f.ymd}: zip이 아님 (HTTP ${r.status})`);
  // bsdtar는 표준입력의 zip을 못 읽는다: 임시 파일로 쓰고 푼다
  const tmp = resolve(tmpdir(), `250_LOCAL_RESD_${f.ymd}.zip`);
  writeFileSync(tmp, zip);
  const csv = new TextDecoder('euc-kr').decode(execFileSync(TAR, ['-xOf', tmp], { maxBuffer: 512 * 1024 * 1024 }));
  rmSync(tmp);
  saveRaw('seoul_grid_livepop', `250_LOCAL_RESD_${f.ymd}.csv`, csv);

  // "일자","시간","행정동코드","250M격자","생활인구합계",…
  const sum = new Map<string, number>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const c = line.split(',', 5).map((s) => s.replace(/"/g, '').trim());
    const v = Number(c[4]);
    if (!Number.isFinite(v)) continue;
    const k = `${c[1]}|${c[2]}`;
    sum.set(k, (sum.get(k) ?? 0) + v);
  }
  if (sum.size < 1000) throw new Error(`${f.ymd}: 행정동×시간 ${sum.size}건뿐 — 파일 형식 확인 필요 (기존 데이터는 그대로 둠)`);
  db.prepare('DELETE FROM living_pop_dong_h WHERE stdr_de_id = ?').run(f.ymd);
  upsert(
    'living_pop_dong_h',
    [...sum].map(([k, v]) => {
      const [h, adm] = k.split('|');
      return { stdr_de_id: f.ymd, tmzon_pd_se: h, adstrd_code_se: adm, tot_lvpop_co: Math.round(v * 10000) / 10000 };
    }),
  );
  loaded.push(f.ymd);
  log(`${f.ymd}: 격자 행 → 행정동 ${new Set([...sum.keys()].map((k) => k.split('|')[1])).size}곳`);
}

// 서버는 테이블 전체를 "최근 1주"로 평균한다: 받은 기간보다 오래된 날은 지운다
const oldest = loaded.at(-1)!;
db.prepare('DELETE FROM living_pop_dong_h WHERE stdr_de_id < ?').run(oldest);
meta('living_pop_dong_h', {
  source: '서울 생활인구(내국인) 250m 격자 → 행정동 합계', endpoint: 'OA-22784 일별 파일 (Open API Se250MSpopLocalResd)', std_period: `${oldest}~${loaded[0]}`, status: 'loaded',
  note: `최근 ${loaded.length}일. 2026-08부터 행정동 단위 생산 종료 → 격자 합산`,
});
db.close();
