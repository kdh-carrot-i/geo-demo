import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // must match a platform domain registered for the Kakao key (localhost:8000 / 8080)
    port: 8000,
    strictPort: true,
    // ngrok 터널로 열 때 (scripts/tunnel.ps1) — 그 밖의 외부 호스트 이름은 막는다
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
