// 사내 S3(cla-raw-data)를 키로 읽는다. AWS CLI·SDK 없이 Node 서명 요청(SigV4)만 쓴다. 키는 web/.env의 DW_AWS_*, 읽기만 한다.
//   npx tsx etl/s3.ts ls <폴더/>            이 폴더의 파일 목록
//   npx tsx etl/s3.ts get <폴더/> [정규식]   data/raw/s3/cla-raw-data/ 아래로 받는다 (크기가 같은 파일은 건너뛴다)
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, E, log } from './lib.ts';

const BUCKET = 'cla-raw-data';
const region = () => E.DW_AWS_REGION ?? 'ap-northeast-2';
const host = () => `${BUCKET}.s3.${region()}.amazonaws.com`;
export const RAW = resolve(DATA_DIR, 'raw', 's3', BUCKET);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function signed(path: string, query: Record<string, string> = {}) {
  const d = new Date().toISOString().replace(/[:-]|\.\d+/g, '');
  const day = d.slice(0, 8);
  const qs = Object.entries(query).sort().map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const h: Record<string, string> = { host: host(), 'x-amz-date': d, 'x-amz-content-sha256': sha('') };
  const names = Object.keys(h).sort();
  const request = ['GET', path.split('/').map(enc).join('/'), qs, names.map((k) => `${k}:${h[k]}\n`).join(''), names.join(';'), sha('')].join('\n');
  const scope = `${day}/${region()}/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${E.DW_AWS_SECRET_ACCESS_KEY}`, day), region()), 's3'), 'aws4_request');
  const sig = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', d, scope, sha(request)].join('\n')).digest('hex');
  return {
    url: `https://${host()}${path}${qs ? `?${qs}` : ''}`,
    headers: { 'x-amz-date': d, 'x-amz-content-sha256': sha(''), authorization: `AWS4-HMAC-SHA256 Credential=${E.DW_AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` },
  };
}

const tags = (t: string, n: string) => [...t.matchAll(new RegExp(`<${n}>([^<]*)</${n}>`, 'g'))].map((m) => m[1].replace(/&amp;/g, '&'));

export async function list(prefix: string) {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const q: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) q['continuation-token'] = token;
    const s = signed('/', q);
    const res = await fetch(s.url, { headers: s.headers });
    const t = await res.text();
    if (!res.ok) throw new Error(`S3 목록 ${res.status} ${tags(t, 'Code')[0] ?? ''}`);
    const keys = tags(t, 'Key');
    const sizes = tags(t, 'Size');
    keys.forEach((key, i) => out.push({ key, size: Number(sizes[i]) }));
    token = tags(t, 'NextContinuationToken')[0];
  } while (token);
  return out;
}

export async function get(key: string, size: number) {
  const file = resolve(RAW, key);
  if (existsSync(file) && statSync(file).size === size) return file;
  mkdirSync(dirname(file), { recursive: true });
  const s = signed(`/${key}`);
  const res = await fetch(s.url, { headers: s.headers });
  if (!res.ok || !res.body) throw new Error(`S3 받기 ${res.status} ${key}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  return file;
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, prefix, pattern] = process.argv.slice(2);
  const items = (await list(prefix)).filter((x) => x.size > 0 && (!pattern || new RegExp(pattern).test(x.key)));
  if (cmd === 'ls') for (const x of items) console.log(x.key, x.size);
  else if (cmd === 'get') {
    const total = items.reduce((a, x) => a + x.size, 0);
    log(`${prefix} ${items.length}개 ${(total / 1e9).toFixed(2)}GB`);
    let n = 0;
    for (const x of items) {
      await get(x.key, x.size);
      if (++n % 20 === 0 || n === items.length) log(`${n}/${items.length}`);
    }
  }
}
