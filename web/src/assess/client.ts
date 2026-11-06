// Agent API client for the 심사 화면. The API key (when the server requires one) is kept in localStorage.
import type { AreaCandidate, AreaReport, Assessment, HistoryItem, Industry, OpportunityResult, WatchDetail, WatchItem } from './types';

const KEY_STORE = 'agent-api-key';

function apiKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

export function setApiKey(k: string) {
  try {
    localStorage.setItem(KEY_STORE, k);
  } catch {
    // private mode: the key lives only for this request
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** When the server requires a key (AGENT_API_KEYS), ask once and keep it in localStorage. */
let asking: Promise<string | null> | null = null;
function askKey(): Promise<string | null> {
  asking ??= Promise.resolve(window.prompt('API 키를 입력하세요 (관리자에게 받은 X-API-Key)')).then((k) => {
    asking = null;
    if (k?.trim()) setApiKey(k.trim());
    return k?.trim() || null;
  });
  return asking;
}

/** fetch under /api/v1 with the stored key; on 401 asks for the key once and retries. */
export async function apiFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  const k = apiKey();
  if (k) headers.set('x-api-key', k);
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (res.status === 401 && retry) {
    // another request may have stored a key while this one was in flight: use it before asking again
    const now = apiKey();
    if ((now && now !== k) || (await askKey())) return apiFetch(path, init, false);
  }
  return res;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.detail ?? body.title ?? `HTTP ${res.status}`);
  return body as T;
}

export interface AssessInput {
  lat: number;
  lng: number;
  industry?: string;
  floor_area_m2?: number;
  /** 1층 = 1, 지하 = -1 */
  floor?: number;
  store_name?: string;
  biz_no?: string;
  radius_m: number;
  client_ref?: string;
  images: Blob[];
}

export const agent = {
  config: () => fetch('/api/config').then((r) => r.json() as Promise<{ kakaoJsKey: string | null }>),
  industries: (q: string) => call<{ items: Industry[] }>(`/industries?q=${encodeURIComponent(q)}`).then((r) => r.items),
  history: () => call<{ items: HistoryItem[] }>('/assessments?limit=30').then((r) => r.items),
  areas: (q: string, allPlaces = false) =>
    call<{ items: AreaCandidate[]; places: { shown: number; total: number; filter: string } }>(`/areas?q=${encodeURIComponent(q)}${allPlaces ? '&all_places=1' : ''}`),
  watchList: () => call<{ items: WatchItem[] }>('/watch').then((r) => r.items),
  watchGet: (id: string) => call<WatchDetail>(`/watch/${id}`),
  watchAdd: (w: { name: string; lat: number; lng: number; industry_code?: string | null; industry_name?: string | null; brand?: string | null; radius_m?: number; memo?: string }) =>
    call<WatchDetail>('/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(w) }),
  watchDelete: (id: string) => apiFetch(`/watch/${id}`, { method: 'DELETE' }),
  /** 인쇄용 리포트: 키 헤더가 필요해 받아서 새 탭에 연다 */
  async openReport(id: string) {
    const w = window.open('', '_blank');
    const res = await apiFetch(`/assessments/${id}/report?format=html`);
    const html = await res.text();
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  },
  areaReport: (id: string) => call<AreaReport>(`/areas/report?id=${encodeURIComponent(id)}`),
  opportunities: (industry: string, sido = '', sgg = '', upcoming = false) =>
    call<OpportunityResult>(`/opportunities?industry=${industry}&limit=30${sido ? `&sido=${encodeURIComponent(sido)}` : ''}${sido && sgg ? `&sgg=${encodeURIComponent(sgg)}` : ''}${upcoming ? '&upcoming=1' : ''}`),
  get: (id: string, wait = 0) => call<Assessment>(`/assessments/${id}?wait=${wait}`),
  create(input: AssessInput) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(input)) {
      if (k === 'images' || v === undefined || v === '') continue;
      fd.set(k, String(v));
    }
    fd.set('roadview_auto', 'false');
    input.images.forEach((b, i) => fd.append('roadview_images', b, `roadview-${i + 1}.jpg`));
    return call<{ assessment_id: string }>('/assessments', { method: 'POST', body: fd });
  },
  messages: (id: string) =>
    call<{ messages: { message_id: string; role: 'user' | 'assistant'; text: string }[] }>(`/assessments/${id}/messages`).then((r) => r.messages),

  /** Streams an answer (SSE over fetch). Calls onDelta per chunk; resolves with the full text. */
  async ask(id: string, message: string, onDelta: (t: string) => void): Promise<string> {
    const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
    const res = await apiFetch(`/assessments/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ message }) });
    if (!res.ok || !res.body) {
      const b = await res.json().catch(() => ({}));
      throw new ApiError(res.status, b.detail ?? b.title ?? `HTTP ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null');
        if (event === 'delta') {
          full += data.text;
          onDelta(data.text);
        } else if (event === 'error') throw new ApiError(500, data.detail ?? data.title);
      }
    }
    return full;
  },
};
