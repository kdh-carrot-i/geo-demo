// Plain-HTML charts for the result view: single-series bars, one value range, hover tooltips.
// Colors come from the --series-1 / text tokens in assess.css (one hue: identity is never color-only).
import { useState } from 'react';

export const won = (v: number | null | undefined) => {
  if (v == null) return '—';
  const man = Math.round(v / 1e4);
  return man >= 1e4 ? `${(man / 1e4).toFixed(man >= 1e5 ? 0 : 1)}억 원` : `${man.toLocaleString()}만 원`;
};

interface Bar {
  label: string;
  value: number | null;
  /** shown under the label */
  note?: string;
  tip: string;
}

/** Horizontal 0–100 bars (score components). Missing values show as a dashed empty track. */
export function ScoreBars({ bars }: { bars: Bar[] }) {
  const [hover, setHover] = useState<number | null>(null);
  return (
    <ul className="hbars" role="list">
      {bars.map((b, i) => (
        <li key={b.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <div className="hbar-head">
            <span className="hbar-label">{b.label}</span>
            <span className="hbar-value">{b.value == null ? '—' : b.value.toFixed(0)}</span>
          </div>
          <div className={`hbar-track${b.value == null ? ' empty' : ''}`} aria-hidden>
            {b.value != null && <div className="hbar-fill" style={{ width: `${Math.max(b.value, 1.5)}%` }} />}
          </div>
          {b.note && <div className="hbar-note">{b.note}</div>}
          {hover === i && <div className="tooltip show">{b.tip}</div>}
        </li>
      ))}
    </ul>
  );
}

/** "06-11" → "06-11시"; other keys (연령대 등) stay as they are */
const hourLabel = (k: string) => (/^\d{2}-\d{2}$/.test(k) ? `${k}시` : k);

/** Vertical bars for a share profile (time of day, age band …). */
export function TimeBars({ data, title, refs }: { data: Record<string, number>; title: string; refs?: React.ReactNode }) {
  const entries = Object.entries(data);
  const max = Math.max(...entries.map(([, v]) => v), 0.0001);
  const peak = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const [hover, setHover] = useState<string | null>(null);
  return (
    <figure className="vbars">
      <figcaption>
        {title} {refs}
      </figcaption>
      <div className="vbars-plot" role="img" aria-label={`${title}: ${entries.map(([k, v]) => `${hourLabel(k)} ${(v * 100).toFixed(0)}%`).join(', ')}`}>
        {entries.map(([k, v]) => (
          <div key={k} className="vbar-col" onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
            <span className="vbar-val">{k === peak ? `${(v * 100).toFixed(0)}%` : ''}</span>
            <div className="vbar" style={{ height: `${(v / max) * 100}%` }} />
            <span className="vbar-x">{k}</span>
            {hover === k && <div className="tooltip show">{`${hourLabel(k)} · ${(v * 100).toFixed(1)}%`}</div>}
          </div>
        ))}
      </div>
    </figure>
  );
}

/** p10–p90 band with the median and the area's actual average on one axis. */
export function RangeBar({ p10, p50, p90, bench }: { p10: number; p50: number; p90: number; bench: number | null }) {
  const max = Math.max(p90, bench ?? 0) * 1.05;
  const x = (v: number) => `${(v / max) * 100}%`;
  const [hover, setHover] = useState<string | null>(null);
  const tip = (k: string, text: string) => hover === k && <div className="tooltip show">{text}</div>;
  return (
    <div className="range">
      <div className="range-track">
        <div className="range-band" style={{ left: x(p10), width: `calc(${x(p90)} - ${x(p10)})` }} onMouseEnter={() => setHover('band')} onMouseLeave={() => setHover(null)}>
          {tip('band', `예상 범위 ${won(p10)} ~ ${won(p90)} (10~90%)`)}
        </div>
        <div className="range-mid" style={{ left: x(p50) }} onMouseEnter={() => setHover('mid')} onMouseLeave={() => setHover(null)}>
          {tip('mid', `중앙값 ${won(p50)}`)}
        </div>
        {bench != null && (
          <div className="range-bench" style={{ left: x(bench) }} onMouseEnter={() => setHover('bench')} onMouseLeave={() => setHover(null)}>
            {tip('bench', `같은 상권 실제 평균 ${won(bench)}`)}
          </div>
        )}
      </div>
      <div className="range-legend">
        <span>
          <i className="sw band" /> 예상 범위 {won(p10)} ~ {won(p90)}
        </span>
        <span>
          <i className="sw mid" /> 중앙값 {won(p50)}
        </span>
        {bench != null && (
          <span>
            <i className="sw bench" /> 상권 실제 평균 {won(bench)}
          </span>
        )}
      </div>
    </div>
  );
}
