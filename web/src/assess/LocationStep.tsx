// Step 1: find the site (주소·장소 검색 via Kakao) and confirm it — "이 주소가 맞나요?"
import { useState } from 'react';
import { api } from '../api';
import type { GeocodeResult } from '../shared/api-types';
import { Roadview } from './Roadview';
import { SiteMap } from './SiteMap';
import type { Place } from './types';

interface Props {
  kakaoJsKey: string | null;
  place: Place | null;
  shots: Blob[];
  onPlace: (p: Place | null) => void;
  onShots: (b: Blob[]) => void;
  onConfirm: () => void;
}

export function LocationStep({ kakaoJsKey, place, shots, onPlace, onShots, onConfirm }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeocodeResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adm, setAdm] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.geocode(q.trim());
      setHits(r);
      if (!r.length) setErr('검색 결과가 없습니다. 도로명·지번 주소나 건물·상호 이름으로 다시 찾아보세요.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function choose(h: GeocodeResult) {
    onShots([]);
    onPlace({ lat: h.lat, lng: h.lon, label: h.label, road: h.road, jibun: h.jibun });
    void describe(h.lat, h.lon);
  }

  async function describe(lat: number, lng: number) {
    setAdm(null);
    try {
      const r = await api.reverse(lng, lat);
      setAdm(r.hName ?? null);
      return r;
    } catch {
      return null;
    }
  }

  async function move(lat: number, lng: number) {
    onShots([]);
    const r = await describe(lat, lng);
    onPlace({ lat, lng, label: r?.road ?? r?.jibun ?? '선택한 위치', road: r?.road, jibun: r?.jibun });
  }

  if (place) {
    return (
      <section className="card">
        <h2>이 주소가 맞나요?</h2>
        <div className="confirm-addr">
          <strong>{place.road ?? place.label}</strong>
          <span>
            {place.jibun && place.jibun !== place.road ? `지번 ${place.jibun}` : ''}
            {adm ? ` · ${adm}` : ''}
          </span>
          {place.label !== place.road && place.label !== place.jibun && <span className="muted">검색한 이름: {place.label}</span>}
        </div>
        <div className="confirm-grid">
          <div>
            <SiteMap lat={place.lat} lng={place.lng} onPick={move} height={340} />
            <p className="muted small">위치가 조금 다르면 지도에서 정확한 자리를 누르세요.</p>
          </div>
          <Roadview lat={place.lat} lng={place.lng} kakaoJsKey={kakaoJsKey} shots={shots} onShots={onShots} />
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => onPlace(null)}>
            아니요, 다시 찾기
          </button>
          <button type="button" className="primary" onClick={onConfirm}>
            네, 맞아요 →
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>어디를 검토하나요?</h2>
      <form className="search-row" onSubmit={search}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="도로명·지번 주소 또는 건물·상호 이름 (예: 서울 중구 세종대로 110)" />
        <button className="primary" disabled={busy}>
          {busy ? '찾는 중…' : '찾기'}
        </button>
      </form>
      {err && <p className="warn">{err}</p>}
      {hits && hits.length > 0 && (
        <ul className="hits">
          {hits.map((h, i) => (
            <li key={i}>
              <button type="button" onClick={() => choose(h)}>
                <strong>{h.label}</strong>
                <span>
                  {h.road ?? h.jibun}
                  {h.category ? ` · ${h.category.split(' > ').slice(-1)[0]}` : ''}
                  {h.precision === 'region' ? ' · 지역 중심점' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
