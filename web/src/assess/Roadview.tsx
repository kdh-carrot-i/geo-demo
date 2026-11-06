// Kakao roadview at the chosen spot, with "담기" to keep the current view for the 로드뷰 판독.
import { useEffect, useRef, useState } from 'react';
import { TabCapture } from './capture';
import { loadKakao } from './kakao';

interface Props {
  lat: number;
  lng: number;
  kakaoJsKey: string | null;
  shots: Blob[];
  onShots: (b: Blob[]) => void;
}

const MAX_SHOTS = 4;

export function Roadview({ lat, lng, kakaoJsKey, shots, onShots }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const capture = useRef<TabCapture | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'none' | 'nokey' | 'error'>(kakaoJsKey ? 'loading' : 'nokey');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!kakaoJsKey || !el.current) return;
    let cancelled = false;
    setState('loading');
    loadKakao(kakaoJsKey)
      .then((kakao) => {
        if (cancelled || !el.current) return;
        const rv = new kakao.maps.Roadview(el.current);
        const pos = new kakao.maps.LatLng(lat, lng);
        new kakao.maps.RoadviewClient().getNearestPanoId(pos, 60, (panoId: number | null) => {
          if (cancelled) return;
          if (panoId === null) return setState('none');
          rv.setPanoId(panoId, pos);
          setState('ready');
        });
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setState('error');
          setMsg(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [kakaoJsKey, lat, lng]);

  useEffect(() => () => capture.current?.stop(), []);

  async function shoot() {
    if (!el.current) return;
    setBusy(true);
    setMsg(null);
    try {
      capture.current ??= new TabCapture();
      const b = await capture.current.shoot(el.current);
      onShots([...shots, b].slice(0, MAX_SHOTS));
    } catch (e) {
      setMsg(e instanceof DOMException && e.name === 'NotAllowedError' ? '화면 공유를 허용해야 담을 수 있습니다.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    const ok = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type) && f.size <= 5 * 1024 * 1024);
    if (ok.length < files.length) setMsg('JPG·PNG·WebP, 장당 5MB 이하만 담을 수 있습니다.');
    onShots([...shots, ...ok].slice(0, MAX_SHOTS));
  }

  return (
    <div className="rv">
      <div className="rv-view">
        {/* Kakao owns this node's children; React must not render inside it */}
        <div className="rv-canvas" ref={el} />
        {state !== 'ready' && (
          <div className="rv-empty">
            {state === 'loading' && '로드뷰를 불러오는 중…'}
            {state === 'none' && '이 위치 60m 안에 촬영된 로드뷰가 없습니다. 지도에서 가까운 도로 쪽을 눌러 위치를 옮겨 보세요.'}
            {state === 'nokey' && '로드뷰를 보려면 서버에 카카오 JavaScript 키(KAKAO_JS_KEY)를 설정해야 합니다. 지금은 아래에서 사진 파일로 담을 수 있습니다.'}
            {state === 'error' && msg}
          </div>
        )}
      </div>
      <div className="rv-bar">
        {state === 'ready' && TabCapture.supported() && (
          <button type="button" onClick={shoot} disabled={busy || shots.length >= MAX_SHOTS}>
            📷 지금 화면 담기 ({shots.length}/{MAX_SHOTS})
          </button>
        )}
        <label className="link">
          사진 파일로 담기
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        </label>
        <span className="muted">방향을 돌려 가며 정면·좌우를 담으면 판독이 정확해집니다. 담은 화면은 분석에만 쓰고 저장하지 않습니다.</span>
      </div>
      {msg && state === 'ready' && <p className="warn">{msg}</p>}
      {shots.length > 0 && (
        <ul className="shots">
          {shots.map((b, i) => (
            <li key={i}>
              <Thumb blob={b} alt={`담은 로드뷰 ${i + 1}`} />
              <button type="button" aria-label="빼기" onClick={() => onShots(shots.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Thumb({ blob, alt }: { blob: Blob; alt: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt={alt} /> : null;
}
