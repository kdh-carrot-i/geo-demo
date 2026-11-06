// API proxy: keeps Kakao / VWorld keys on the server so they never ship in the client bundle.
import './env.ts'; // 반드시 첫 import
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { agentRouter } from './agent/routes.ts';
import { kakaoRouter } from './kakao.ts';
import { vworldRouter } from './vworld.ts';

const app = express();
app.disable('x-powered-by');
// 시연 접속 기록: ACCESS_LOG 파일에 요청마다 JSON 한 줄 (시각·IP·메서드·경로·상태·소요 ms). 정적 파일은 뺀다.
if (process.env.ACCESS_LOG) {
  const file = path.resolve(process.env.ACCESS_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  app.use((req, res, next) => {
    if (/^\/assets\/|\.(js|css|png|svg|ico|woff2?)$/.test(req.path)) return next();
    const t0 = performance.now();
    res.on('finish', () => {
      const line = {
        t: new Date().toISOString(),
        ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim(),
        m: req.method,
        // 키가 쿼리에 실려 와도 남기지 않는다
        url: req.originalUrl.replace(/([?&](?:api_?key|key|serviceKey|token)=)[^&]*/gi, '$1***'),
        s: res.statusCode,
        ms: Math.round(performance.now() - t0),
        ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
      };
      fs.appendFile(file, JSON.stringify(line) + '\n', () => {});
    });
    next();
  });
}
// Agent API first: it takes multipart and larger JSON (base64 images) with its own parsers.
app.use('/api/v1', agentRouter());
app.use(express.json({ limit: '1mb' }));

app.use('/api', kakaoRouter());
app.use('/api', vworldRouter());

// Agent API contract (draft). Swagger UI at /api/docs; design notes in docs/08_API_명세.md.
const specPath = path.join(import.meta.dirname, 'openapi.yaml');
app.get('/api/openapi.yaml', (_req, res) => {
  res.type('application/yaml').sendFile(specPath);
});
app.get('/api/docs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Agent API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/api/openapi.yaml', dom_id: '#ui' });</script>
</body></html>`);
});

// Browser config. The Kakao *JavaScript* key is meant to be public (it is locked to registered domains),
// unlike the REST key which stays server-side.
app.get('/api/config', (_req, res) => {
  res.json({ kakaoJsKey: process.env.KAKAO_JS_KEY ?? null });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    kakao: Boolean(process.env.KAKAO_REST_KEY),
    vworld: Boolean(process.env.VWORLD_KEY),
    dataGoKr: Boolean(process.env.DATA_GO_KR_SERVICE_KEY),
    rOne: Boolean(process.env.R_ONE_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

// 배포(EC2)에서는 빌드한 화면(dist)도 여기서 함께 서빙한다. 개발 중에는 vite가 서빙하므로 끈다.
if (process.env.SERVE_DIST) {
  app.use(express.static(path.resolve(import.meta.dirname, '../dist'), { maxAge: '1h', index: 'index.html' }));
}

const port = Number(process.env.API_PORT ?? 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
});
