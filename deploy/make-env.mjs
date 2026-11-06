// 서버용 .env(deploy/.env.demo)를 web/.env 에서 만든다. 키 값은 화면에 출력하지 않는다.
//   node deploy/make-env.mjs            새로 만들기 (이미 있으면 DEMO_HOST만 갱신)
//   node deploy/make-env.mjs --rotate   시연용 API 키·비밀번호 다시 발급
// 시연 서버는 외부에 열리므로: 경기 유동인구(내부 한정) 제외, API 키·비밀번호는 로컬과 다른 새 값.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const out = path.join(here, '.env.demo');
const rotate = process.argv.includes('--rotate');
const parse = (file) => {
  const m = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) m.set(line.slice(0, i).trim(), line.slice(i + 1));
  }
  return m;
};

const env = parse(path.join(here, '..', 'web', '.env'));
const prev = existsSync(out) ? parse(out) : new Map();
const state = existsSync(path.join(here, 'state.json')) ? JSON.parse(readFileSync(path.join(here, 'state.json'), 'utf8').replace(/^﻿/, '')) : null;

for (const k of ['NGROK_BASIC_AUTH', 'NGROK_AUTHTOKEN']) env.delete(k);
env.set('API_PORT', '8787');
env.set('DATA_SCOPE', 'external');
env.set('AGENT_API_KEYS', !rotate && prev.get('AGENT_API_KEYS') ? prev.get('AGENT_API_KEYS') : `agk_demo_${randomBytes(18).toString('base64url')}`);
env.set('DEMO_BASIC_AUTH', !rotate && prev.get('DEMO_BASIC_AUTH') ? prev.get('DEMO_BASIC_AUTH') : `demo:${randomBytes(12).toString('base64url')}`);
env.set('DEMO_HOST', state?.host ?? prev.get('DEMO_HOST') ?? '');

const body = ['# 시연 서버(EC2)용. deploy/make-env.mjs 가 생성. 채팅·문서에 붙여 넣지 말 것.', ...[...env].map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
writeFileSync(out, body, { mode: 0o600 });
const missing = ['DEMO_HOST', 'KAKAO_JS_KEY', 'KAKAO_REST_KEY', 'VWORLD_KEY'].filter((k) => !env.get(k));
console.log(`${out} 작성 (${env.size}개 항목${rotate ? ', 시연 키 재발급' : ''})${missing.length ? ` — 비어 있음: ${missing.join(', ')}` : ''}`);
