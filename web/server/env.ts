// .env 를 다른 모듈보다 먼저 읽는다. index.ts 의 첫 import 여야 한다:
// ES 모듈은 import 를 본문보다 먼저 실행하므로, 본문에서 읽으면 모듈 최상단 상수(DATA_SCOPE 등)가 .env 를 못 본다.
try {
  // ENV_FILE: 시연용 설정(deploy/.env.demo)으로 따로 띄울 때. 이미 있는 환경 변수는 덮어쓰지 않는다.
  process.loadEnvFile(process.env.ENV_FILE ?? '.env');
} catch {
  // .env is optional; keys may come from the real environment
}
