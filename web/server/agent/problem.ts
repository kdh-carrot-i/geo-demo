// RFC 9457 problem responses.
import type { Response } from 'express';
import { UpstreamError } from '../http.ts';

export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}

export function sendProblem(res: Response, err: unknown, instance?: string) {
  let p: ApiProblem;
  if (err instanceof ApiProblem) p = err;
  else if (err instanceof UpstreamError) p = new ApiProblem(err.status, '외부 API 오류', err.message);
  else {
    console.error(err);
    p = new ApiProblem(500, '서버 오류');
  }
  res
    .status(p.status)
    .type('application/problem+json')
    .json({ type: 'about:blank', title: p.title, status: p.status, detail: p.detail, instance });
}
