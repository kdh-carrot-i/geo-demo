import type { Response } from 'express';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new UpstreamError(`upstream ${new URL(url).host} responded ${res.status}`, 502);
  }
  return (await res.json()) as T;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new UpstreamError(`${name} is not configured on the server`, 503);
  return v;
}

export function sendError(res: Response, err: unknown) {
  if (err instanceof UpstreamError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
}

export function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
