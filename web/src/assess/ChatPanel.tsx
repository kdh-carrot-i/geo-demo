// Follow-up questions about one assessment (streams the answer as it is written).
import { useEffect, useRef, useState } from 'react';
import { agent, ApiError } from './client';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
}

const SUGGESTIONS = ['근처 경쟁점이 많은 편인가요?', '이 점수에서 가장 약한 부분은?', '현장 실사 때 꼭 확인할 것은?'];

export function ChatPanel({ id }: { id: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    agent.messages(id).then((m) => setMsgs(m.map(({ role, text }) => ({ role, text })))).catch(() => {});
  }, [id]);
  // keep the newest message visible inside the log without scrolling the page
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [msgs]);

  async function ask(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setQ('');
    setMsgs((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '' }]);
    try {
      await agent.ask(id, text, (d) =>
        setMsgs((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: 'assistant', text: copy[copy.length - 1].text + d };
          return copy;
        }),
      );
    } catch (e) {
      setMsgs((m) => m.slice(0, -2));
      if (e instanceof ApiError && e.status === 503) setOff('대화 기능은 서버에 Claude API 키(ANTHROPIC_API_KEY)를 설정하면 켜집니다.');
      else setOff((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card chat">
      <h2>이 평가에 대해 묻기</h2>
      <div className="chat-log" ref={log}>
        {msgs.length === 0 && <p className="muted">평가 결과를 근거로 답합니다. 결과에 없는 내용은 없다고 답하고, 어떤 데이터가 있으면 답할 수 있는지 알려 줍니다.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text || (busy && i === msgs.length - 1 ? '…' : '')}
          </div>
        ))}
      </div>
      {off && <p className="warn">{off}</p>}
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip" disabled={busy} onClick={() => ask(s)}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="질문을 입력하세요" maxLength={4000} />
        <button className="primary" disabled={busy || !q.trim()}>
          보내기
        </button>
      </form>
    </section>
  );
}
