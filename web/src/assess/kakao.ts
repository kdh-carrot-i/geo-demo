// Kakao Maps JS SDK loader (roadview only). The key comes from /api/config.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    kakao?: any;
  }
}

let loading: Promise<any> | undefined;

export function loadKakao(appKey: string): Promise<any> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
    s.async = true;
    s.onload = () => window.kakao.maps.load(() => resolve(window.kakao));
    s.onerror = () => {
      loading = undefined;
      reject(new Error('카카오 지도 SDK를 불러오지 못했습니다 (키·등록 도메인 확인)'));
    };
    document.head.appendChild(s);
  });
  return loading;
}
