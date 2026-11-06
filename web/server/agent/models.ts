// Step 4: model predictions via the long-lived Python worker (ml/serve.py, line-delimited JSON).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const ML_DIR = path.resolve(import.meta.dirname, '../../../ml');
const PYTHON = process.env.ML_PYTHON ?? path.join(ML_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const CALL_TIMEOUT_MS = 30_000;

export interface SurvivalResult {
  /** food = 일반음식점 모델, cvs = 편의점 모델, cafe = 카페 모델 */
  model?: 'food' | 'cvs' | 'cafe';
  close_3y_prob: number;
  survival_3y_prob: number;
  score: number;
  variant: 'full' | 'location';
  uptae_used: string;
  reference_n: number;
  features: Record<string, number | null>;
}

export type SalesResult =
  | { available: false; reason: string }
  | { available: true; quarter: string; unit: string; p10: number; p50: number; p90: number; benchmark_per_store: number | null; benchmark_stores: number };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class Worker {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private seq = 0;

  private start(): Promise<void> {
    this.ready ??= new Promise((resolve, reject) => {
      const proc = spawn(PYTHON, ['serve.py'], { cwd: ML_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.proc = proc;
      proc.stderr.on('data', (d: Buffer) => process.stderr.write(d));
      proc.on('error', (e) => {
        this.reset(e);
        reject(e);
      });
      proc.on('exit', (code) => this.reset(new Error(`ml worker exited (${code})`)));
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg: { id: number; ok: boolean; ready?: boolean; result?: unknown; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.ready) return resolve();
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'ml error'));
      });
    });
    return this.ready;
  }

  private reset(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.proc = undefined;
    this.ready = undefined;
  }

  async call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    await this.start();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ml ${op} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  /** Start loading models in the background so the first request does not pay the ~15 s warm-up. */
  warm() {
    this.start().catch((e) => console.error('[ml] worker failed to start:', e.message));
  }
}

export const ml = new Worker();

export const predictSurvival = (a: { lat: number; lng: number; uptae: string; sido_nm: string | null; site_area?: number }) =>
  ml.call<SurvivalResult>('survival', a);

export const predictSurvivalCvs = (a: { lat: number; lng: number; brand: string | null; sido_nm: string | null }) =>
  ml.call<SurvivalResult>('survival_cvs', a);

/** names: 상호·프랜차이즈 브랜드명 — 브랜드 판별은 학습과 같은 규칙(survival_cafe_v0.BRANDS)으로 Python 쪽에서 한다 */
export const predictSurvivalCafe = (a: { lat: number; lng: number; names: string[]; sido_nm: string | null }) =>
  ml.call<SurvivalResult>('survival_cafe', a);

export const predictSales =(a: { trdar_cd: string; ind: string }) => ml.call<SalesResult>('sales', a);

type Range = { p10: number; p50: number; p90: number };
export type SalesV2Result =
  | { available: false; reason: string }
  | {
      available: true;
      model: 'sales-v2' | 'sales-v3';
      unit: string;
      card_industry: string;
      /** v3: 업종 묶음 (카페·디저트 / 음식점 / 편의점·슈퍼 / 기타) */
      group?: string;
      floor: string;
      site_area: number | null;
      /** 카드 결제 규모 → 총매출 환산 비율 (서울 상권 비교 중앙값) */
      calib_ratio: number | null;
      variants: Record<'franchise' | 'independent', { card: Range; total_est: Range | null; brand: string | null; calib_ratio?: number; calib_basis?: string; closure?: { prob_12m: number; peer_rate: number | null } | null }>;
      context: { neighbours_same_industry: number; neighbour_median_card: number | null };
      brand_matched: string | null;
      first_month_note?: string;
    };
/** 전국 매장 매출 v2·v3 (사내 카드매출 학습, ml/sales_v3_serve.py · 없으면 sales_v2_serve.py). 모델 파일이 없으면 available=false */
export const predictSalesV2 = (a: { lat: number; lng: number; pnu: string | null; scls: string; store_name?: string; floor?: number; site_area?: number }) =>
  ml.call<SalesV2Result>('sales_v2', a);
