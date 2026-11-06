// Read-only access to the commerce DB plus a small writable store for API state (assessments, chat).
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = path.resolve(import.meta.dirname, '../../../data');

export const commerce = new DatabaseSync(path.join(DATA, 'commerce.sqlite'), { readOnly: true });

export const state = new DatabaseSync(path.join(DATA, 'api.sqlite'));
state.exec(`
  create table if not exists assessment (
    id text primary key,
    created_at text not null,
    completed_at text,
    status text not null,
    request_json text not null,   -- biz_no and image bytes are never stored
    result_json text
  );
  create table if not exists message (
    id text primary key,
    assessment_id text not null references assessment(id),
    role text not null,
    text text not null,
    created_at text not null
  );
  create index if not exists message_by_assessment on message(assessment_id, created_at);
`);

export type Row = Record<string, unknown>;

export function all<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
  return commerce.prepare(sql).all(...params) as T[];
}

export function one<T = Row>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return commerce.prepare(sql).get(...params) as T | undefined;
}

/** Latest quarter present in the Seoul 상권 tables. */
export const LATEST_Q = (one<{ q: string }>('select max(stdr_yyqu_cd) q from ta_sales_q')?.q ?? '') as string;
