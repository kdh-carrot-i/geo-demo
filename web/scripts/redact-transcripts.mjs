// Mask API keys from web/.env inside Claude Code conversation logs (~/.claude/projects/<this project>/*.jsonl).
// Run after closing the Claude Code session; logs touched in the last 10 minutes are skipped as possibly live.
// Usage (from web/): node scripts/redact-transcripts.mjs [--dry-run]
import { readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const env = readFileSync(resolve(import.meta.dirname, '..', '.env'), 'utf8');
const keys = env
  .split(/\r?\n/)
  .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
  .filter((m) => m && /KEY|SECRET|SERVICE_ID/.test(m[1]) && m[2].trim().length >= 8)
  .map((m) => [m[1], m[2].trim()]);

const projectDir = join(homedir(), '.claude', 'projects', 'c--Users-CARROT-I-Desktop-WorkSpace-Carrot-i-geo-reverse');
const recent = Date.now() - 10 * 60 * 1000;

for (const f of readdirSync(projectDir).filter((n) => n.endsWith('.jsonl'))) {
  const p = join(projectDir, f);
  if (statSync(p).mtimeMs > recent) {
    console.log(`건너뜀 (사용 중일 수 있음): ${f}`);
    continue;
  }
  let text = readFileSync(p, 'utf8');
  const found = [];
  for (const [name, value] of keys) {
    for (const v of new Set([value, encodeURIComponent(value)])) {
      if (!text.includes(v)) continue;
      text = text.split(v).join(`***${name}***`);
      found.push(name);
    }
  }
  if (!found.length) continue;
  console.log(`${dryRun ? '[미리보기] ' : ''}${f}: ${[...new Set(found)].join(', ')}`);
  if (!dryRun) {
    writeFileSync(p + '.tmp', text);
    renameSync(p + '.tmp', p);
  }
}
console.log('끝');
