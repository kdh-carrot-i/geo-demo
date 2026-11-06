// Agent API v1 — contract in ../openapi.yaml, design in docs/08_API_명세.md.
import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { areaReport, searchAreas } from './area.ts';
import { opportunities } from './opportunity.ts';
import { addWatch, deleteWatch, getWatch, listWatch } from './watch.ts';
import { lookupBuildings } from './building.ts';
import { buildingDongAt } from './building-dong.ts';
import { all as dbAll, one, state } from './db.ts';
import { searchIndustries } from './industry.ts';
import { chat, llmAvailable } from './llm.ts';
import { resolveLocation } from './location.ts';
import { ml } from './models.ts';
import {
  AssessmentRequest,
  list,
  load,
  newId,
  runAssessment,
  saveNew,
  setStatus,
  type AssessmentResult,
  type RoadviewImage,
} from './pipeline.ts';
import { ApiProblem, sendProblem } from './problem.ts';
import { reportHtml, reportSections } from './report.ts';
import { internalDataAllowed } from './sources.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude API per-image limit
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_RUNNING = Number(process.env.AGENT_MAX_RUNNING ?? 2);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 4, fields: 20 } });

// --- auth: X-API-Key against AGENT_API_KEYS (comma separated). Unset = local dev, open. ---
function auth() {
  // read at router creation, after index.ts has loaded .env
  const keys = (process.env.AGENT_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean).map((k) => Buffer.from(k));
  if (!keys.length) console.warn('[agent] AGENT_API_KEYS not set — API is open (local development only)');
  return (req: Request, res: Response, next: NextFunction) => {
    if (!keys.length) return next();
    const got = Buffer.from(req.get('x-api-key') ?? '');
    if (keys.some((k) => k.length === got.length && timingSafeEqual(k, got))) return next();
    sendProblem(res, new ApiProblem(401, '인증 실패', 'X-API-Key 헤더가 없거나 올바르지 않습니다.'), req.originalUrl);
  };
}

// --- a tiny in-process queue so a burst of requests does not start N Claude calls at once ---
let running = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

const idempotency = new Map<string, { id: string; at: number }>();

function imagesFrom(req: Request): RoadviewImage[] {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const fromFiles = files.map((f) => {
    if (!IMAGE_TYPES.has(f.mimetype)) throw new ApiProblem(400, '이미지 형식 오류', `${f.originalname}: JPG/PNG/WebP만 받습니다.`);
    return { data: f.buffer.toString('base64'), media_type: f.mimetype as RoadviewImage['media_type'] };
  });
  const b64 = (req.body?.roadview_images_base64 ?? []) as { data?: string; media_type?: string }[];
  if (!Array.isArray(b64)) throw new ApiProblem(400, '이미지 형식 오류', 'roadview_images_base64는 배열이어야 합니다.');
  const fromJson = b64.map((im) => {
    if (!im?.data || !IMAGE_TYPES.has(im.media_type ?? '')) throw new ApiProblem(400, '이미지 형식 오류', 'data와 media_type(image/jpeg|png|webp)이 필요합니다.');
    if (Buffer.byteLength(im.data, 'base64') > MAX_IMAGE_BYTES) throw new ApiProblem(413, '이미지가 너무 큼', '장당 5MB 이하만 받습니다.');
    return { data: im.data, media_type: im.media_type as RoadviewImage['media_type'] };
  });
  const all = [...fromFiles, ...fromJson];
  if (all.length > 4) throw new ApiProblem(400, '이미지 개수 초과', '최대 4장입니다.');
  return all;
}

function isPartial(r: AssessmentResult) {
  return r.warnings.some((w) => w.includes('실패') || w.includes('ANTHROPIC_API_KEY'));
}

export function agentRouter() {
  const r = Router();
  r.use(express.json({ limit: '25mb' }));
  r.use(auth());
  ml.warm();

  r.post('/assessments', (req, res, next) => {
    upload.array('roadview_images', 4)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const detail: Record<string, string> = {
          LIMIT_FILE_SIZE: '이미지는 장당 5MB 이하만 받습니다.',
          LIMIT_FILE_COUNT: '이미지는 최대 4장입니다.',
          LIMIT_UNEXPECTED_FILE: '이미지는 roadview_images 필드로 최대 4장 보냅니다.',
        };
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return sendProblem(res, new ApiProblem(status, '업로드 오류', detail[err.code] ?? err.message), req.originalUrl);
      }
      if (err) return next(err);
      try {
        const idemKey = req.get('idempotency-key');
        const prev = idemKey ? idempotency.get(idemKey) : undefined;
        if (prev && Date.now() - prev.at < 864e5) {
          const a = load(prev.id);
          if (a) return res.status(202).location(`/api/v1/assessments/${prev.id}`).json({ assessment_id: prev.id, status: a.status, links: links(prev.id) });
        }
        const parsed = AssessmentRequest.safeParse(req.body ?? {});
        if (!parsed.success) throw new ApiProblem(400, '요청 형식 오류', parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
        const images = imagesFrom(req);
        const id = newId('asm_');
        saveNew(id, parsed.data);
        if (idemKey) idempotency.set(idemKey, { id, at: Date.now() });

        void withSlot(async () => {
          setStatus(id, 'running');
          try {
            const result = await runAssessment(parsed.data, images);
            setStatus(id, isPartial(result) ? 'partial' : 'done', result);
          } catch (e) {
            const p = e instanceof ApiProblem ? e : new ApiProblem(500, '분석 실패', (e as Error).message);
            if (!(e instanceof ApiProblem)) console.error(e);
            setStatus(id, 'failed', { error: { title: p.title, status: p.status, detail: p.detail } });
          }
        });
        res.status(202).location(`/api/v1/assessments/${id}`).json({ assessment_id: id, status: 'queued', estimated_seconds: images.length ? 40 : 20, links: links(id) });
      } catch (e) {
        sendProblem(res, e, req.originalUrl);
      }
    });
  });

  r.get('/assessments', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
    res.json({ items: list(limit) });
  });

  r.get('/assessments/:id', async (req, res) => {
    const wait = Math.min(60, Math.max(0, Number(req.query.wait ?? 0) || 0));
    const deadline = Date.now() + wait * 1000;
    let a = load(req.params.id);
    while (a && (a.status === 'queued' || a.status === 'running') && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 500));
      a = load(req.params.id);
    }
    if (!a) return sendProblem(res, new ApiProblem(404, '평가 없음'), req.originalUrl);
    res.json(a);
  });

  r.get('/assessments/:id/report', (req, res) => {
    const a = load(req.params.id) as (AssessmentResult & ReturnType<typeof load>) | undefined;
    if (!a) return sendProblem(res, new ApiProblem(404, '평가 없음'), req.originalUrl);
    if (a.status !== 'done' && a.status !== 'partial') return sendProblem(res, new ApiProblem(409, '아직 분석 중', `status=${a.status}`), req.originalUrl);
    const format = String(req.query.format ?? 'html');
    if (format === 'json') return res.json(reportSections(a));
    if (format === 'pdf') return sendProblem(res, new ApiProblem(501, 'PDF 준비 중', '지금은 html 리포트를 브라우저에서 인쇄해 PDF로 저장하십시오.'), req.originalUrl);
    res.type('html').send(reportHtml(a));
  });

  r.get('/assessments/:id/messages', (req, res) => {
    if (!load(req.params.id)) return sendProblem(res, new ApiProblem(404, '평가 없음'), req.originalUrl);
    const messages = state.prepare('select id message_id, role, text, created_at from message where assessment_id = ? order by created_at').all(req.params.id);
    res.json({ messages });
  });

  r.post('/assessments/:id/messages', async (req, res) => {
    const a = load(req.params.id);
    if (!a) return sendProblem(res, new ApiProblem(404, '평가 없음'), req.originalUrl);
    if (a.status !== 'done' && a.status !== 'partial') return sendProblem(res, new ApiProblem(409, '아직 분석 중'), req.originalUrl);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 4000) return sendProblem(res, new ApiProblem(400, '요청 형식 오류', 'message는 1~4000자 문자열이어야 합니다.'), req.originalUrl);
    if (!llmAvailable()) return sendProblem(res, new ApiProblem(503, '대화 기능 비활성', 'ANTHROPIC_API_KEY가 설정되지 않았습니다.'), req.originalUrl);

    const history = state
      .prepare('select role, text from message where assessment_id = ? order by created_at')
      .all(req.params.id) as { role: 'user' | 'assistant'; text: string }[];
    const insert = state.prepare('insert into message (id, assessment_id, role, text, created_at) values (?, ?, ?, ?, ?)');
    const sse = (req.get('accept') ?? '').includes('text/event-stream');
    if (sse) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const { text } = await chat(a, history.slice(-20), message, sse ? (t) => send('delta', { text: t }) : undefined);
      const now = new Date().toISOString();
      insert.run(newId('msg_'), req.params.id, 'user', message, now);
      const message_id = newId('msg_');
      insert.run(message_id, req.params.id, 'assistant', text, new Date().toISOString());
      const citations = (a as { provenance?: unknown[] }).provenance ?? [];
      if (sse) {
        send('done', { message_id, citations });
        res.end();
      } else res.json({ message_id, text, citations });
    } catch (e) {
      if (sse) {
        send('error', { title: '대화 실패', detail: (e as Error).message });
        res.end();
      } else sendProblem(res, e, req.originalUrl);
    }
  });

  r.get('/coverage', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) return sendProblem(res, new ApiProblem(400, '요청 형식 오류', 'lat(33~39), lng(124~132)가 필요합니다.'), req.originalUrl);
    try {
      const loc = await resolveLocation({ lat, lng });
      const seoul = loc.coverage === 'seoul';
      res.json({
        coverage: loc.coverage,
        adm_nm: loc.adm_nm,
        trade_area: loc.trade_area,
        items: {
          score: { available: true, confidence: 'B', note: '생존 확률은 음식점 업종 (다른 업종은 업종별 인허가 데이터 추가 예정)' },
          survival_3y: { available: true, confidence: 'B', note: '음식점 업종. 다른 업종은 업종별 인허가 데이터 추가 예정' },
          sales_forecast: { available: true, confidence: 'C', note: '전국 매장 단위 모델(sales-v2, 사내 카드매출 학습)이 있으면 그것으로, 없으면 서울 상권 평균 모델(v0). 프랜차이즈·개인 두 가지 범위' },
          floating_pop: { available: seoul && Boolean(loc.trade_area), confidence: 'A', note: seoul ? '' : '서울 상권 유동인구는 서울만 있음. 서울 밖은 flowpop_dong 참고' },
          flowpop_dong: (() => {
            const kind = !seoul && internalDataAllowed() && loc.adm_cd ? one<{ kind: string }>('select kind from flowpop_est_dong where adm_cd = ?', loc.adm_cd)?.kind : undefined;
            return {
              available: Boolean(kind),
              confidence: kind === 'measured' ? 'B' : 'C',
              note: seoul
                ? '서울은 서울 상권 유동인구·생활인구를 씀'
                : !internalDataAllowed()
                  ? '외부 제공 모드에서는 제공하지 않음 (원천이 공공누리 2유형) — 상업 라이선스 확보 시 제공'
                  : kind === 'measured'
                    ? '경기도 실측 (내부 심사 한정)'
                    : kind
                      ? '경기 실측으로 학습한 추정값 (내부 심사 한정)'
                      : '이 행정동은 추정에 필요한 SGIS 통계가 없음',
            };
          })(),
          living_pop: { available: seoul, confidence: 'A' },
          residents: { available: true, confidence: 'A' },
          competitors: { available: true, confidence: 'A', note: '전국 상가정보 (밀집도는 같은 시도 평균과 비교)' },
          rent: { available: true, confidence: 'B', note: 'R-ONE 조사 상권(1km 안) 또는 시도 평균의 층별 임대료·공실률' },
          buildings: { available: true, confidence: 'A', note: '해당 필지의 건축물대장 (표제부·층별개요). 반경 집계는 준비 중' },
          vision: { available: llmAvailable(), confidence: 'C', note: '로드뷰 이미지 첨부 시' },
        },
      });
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  r.get('/industries', (req, res) => {
    const items = searchIndustries(String(req.query.q ?? '')).map((s) => ({ ...s, survival_model: s.code.startsWith('I2') || s.code === 'G20405' }));
    res.json({ items });
  });

  // 상권 분석: 이름으로 후보를 찾고 (경계 있는 상권영역 → 서울 상권 → 카카오 장소), 고른 후보의 리포트를 바로 돌려준다.
  r.get('/areas', async (req, res) => {
    try {
      res.json(await searchAreas(String(req.query.q ?? ''), req.query.all_places === 'true' || req.query.all_places === '1'));
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  // 필지 상세 (지도 도구의 건물 클릭): 건축물대장 표제부·층별개요 + 그 필지에 입점한 상가정보 점포
  // 건물(동) 선택: 누른 지점의 동 외곽선 + 그 동의 건축물대장·추정 거주인구
  r.get('/buildings/at', async (req, res) => {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) throw new ApiProblem(400, '좌표 오류', 'lat(33~39)과 lng(124~132)이 필요합니다.');
      res.json(await buildingDongAt(lat, lng));
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  r.get('/parcels/:pnu', async (req, res) => {
    try {
      const pnu = String(req.params.pnu);
      if (!/^\d{19}$/.test(pnu)) throw new ApiProblem(400, 'PNU 형식 오류', 'PNU는 19자리 숫자입니다.');
      const stores = dbAll<{ bizes_nm: string; brch_nm: string | null; inds_lcls_nm: string; inds_mcls_nm: string; inds_scls_nm: string; flr_no: string | null; ho_no: string | null; bld_nm: string | null }>(
        'select bizes_nm, brch_nm, inds_lcls_nm, inds_mcls_nm, inds_scls_nm, flr_no, ho_no, bld_nm from store where lno_cd = ? order by flr_no, bizes_nm',
        pnu,
      );
      const byLcls = new Map<string, number>();
      for (const s of stores) byLcls.set(s.inds_lcls_nm, (byLcls.get(s.inds_lcls_nm) ?? 0) + 1);
      res.json({
        pnu,
        buildings: await lookupBuildings(pnu).catch(() => null),
        stores: {
          total: stores.length,
          by_lcls: [...byLcls].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
          items: stores.slice(0, 300).map((s) => ({ name: s.bizes_nm + (s.brch_nm ? ` ${s.brch_nm}` : ''), industry: `${s.inds_mcls_nm} › ${s.inds_scls_nm}`, lcls: s.inds_lcls_nm, floor: s.flr_no, ho: s.ho_no, building: s.bld_nm })),
          as_of: one<{ p: string }>("select std_period p from meta_source where table_name = 'store'")?.p ?? '',
        },
        sources: ['국토교통부 건축HUB 건축물대장 (getBrTitleInfo, getBrFlrOulnInfo)', '소상공인시장진흥공단 상가(상권)정보'],
      });
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  // 출자 매장 모니터링: 등록 때 주변 상황을 기준선으로 저장하고, 볼 때마다 지금과 비교한다
  r.get('/watch', (req, res) => {
    try {
      res.json({ items: listWatch() });
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });
  r.post('/watch', express.json(), async (req, res) => {
    try {
      const b = req.body ?? {};
      res.status(201).json(await addWatch({ name: b.name, lat: Number(b.lat), lng: Number(b.lng), industry_code: b.industry_code, industry_name: b.industry_name, brand: b.brand, radius_m: b.radius_m, memo: b.memo }));
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });
  r.get('/watch/:id', (req, res) => {
    try {
      res.json(getWatch(String(req.params.id)));
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });
  r.delete('/watch/:id', (req, res) => {
    try {
      deleteWatch(String(req.params.id));
      res.status(204).end();
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  // 유망 입지 찾기: 업종을 고르면 상권영역별 "활발한데 덜 밀집한 곳" 순위
  r.get('/opportunities', (req, res) => {
    try {
      const industry = String(req.query.industry ?? '');
      if (!industry) throw new ApiProblem(400, '요청 형식 오류', 'industry(상가정보 소분류 코드)가 필요합니다.');
      res.json(
        opportunities({
          industry,
          sido: req.query.sido ? String(req.query.sido) : undefined,
          sgg: req.query.sgg ? String(req.query.sgg) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          upcomingOnly: req.query.upcoming === '1' || req.query.upcoming === 'true',
        }),
      );
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  r.get('/areas/report', async (req, res) => {
    try {
      const id = String(req.query.id ?? '');
      if (!id) throw new ApiProblem(400, '요청 형식 오류', 'id가 필요합니다. GET /areas?q=상권이름 결과의 id를 쓰십시오.');
      res.json(await areaReport(id));
    } catch (e) {
      sendProblem(res, e, req.originalUrl);
    }
  });

  return r;
}

function links(id: string) {
  return { self: `/api/v1/assessments/${id}`, report: `/api/v1/assessments/${id}/report`, messages: `/api/v1/assessments/${id}/messages` };
}
