# 시연 서버 (AWS EC2)

외부 시연용. 시연할 때만 켜고 끝나면 끈다. 꺼 둔 동안은 디스크(30GB)와 고정 IP 요금만 나간다(월 약 $6).

| 항목 | 값 |
|---|---|
| 인스턴스 | t3.medium (4GB) · Ubuntu 24.04 · 서울 리전 |
| 접속 | `https://<고정IP 대시>.sslip.io` (도메인 없이 HTTPS) |
| 앞단 | Caddy: HTTPS 인증서 자동 발급 + basic auth → 127.0.0.1:8787 |
| 앱 | systemd `geo-api`: `tsx server/index.ts` (`SERVE_DIST=1`이면 화면도 서빙) |
| 데이터 | `/opt/geo/data/commerce.sqlite`(읽기 전용) · `api.sqlite`(모니터링 등 상태, 서버에 있으면 덮어쓰지 않음) |
| 범위 | `DATA_SCOPE=external`: 경기 유동인구(내부 한정) 제외 |

## AWS 없이 이 PC에서 시연 (ngrok)
`powershell -File deploy\local-demo.ps1`: `.env.demo` 설정으로 운영 모드 서버(8790)를 따로 띄우고 ngrok 고정 주소로 연다. 개발 서버와 별개이고, Ctrl+C로 함께 내려간다. 기본은 아이디·비밀번호·API 키 없이 열림, `-Auth`를 주면 둘 다 건다. 시연하는 동안 PC가 켜져 있어야 한다. 주소는 Kakao 플랫폼 도메인에 한 번 등록.

## 처음 한 번
**콘솔로 만든 경우 (AWS CLI 키 없이):** EC2 콘솔에서 Ubuntu 24.04 · t3.medium · 30GB · 키 페어 `geo-demo`(.pem) · SSH(내 IP)/HTTP/HTTPS 허용으로 만들고 탄력적 IP를 연결한 뒤,
`powershell -File deploy\register.ps1 -Ip <탄력적IP> -InstanceId <i-…> -Pem <다운로드한 .pem>` → 아래 3·4번. 켜기·끄기는 콘솔(인스턴스 상태 → 시작/중지).

**CLI로 만드는 경우:**
1. `aws configure --profile geo` (IAM 사용자에 EC2 권한 + 액세스 키 필요)
2. `powershell -File deploy\aws-create.ps1`: 키 페어·보안 그룹·EC2·고정 IP. 끝에 접속 주소 출력
3. Kakao Developers > 플랫폼 > Web 사이트 도메인에 그 주소 추가 (지도 JS 키용)
4. `powershell -File deploy\push.ps1 -Setup -Data`: 서버 설치 + 코드 + DB(압축 약 1GB대)

## 평소
- 켜기 / 끄기: `npm run aws:start` / `npm run aws:stop` (web 폴더에서)
- 코드 반영: `npm run aws:push` (DB까지면 `powershell -File deploy\push.ps1 -Data -RepackData`)
- 로그·접속: `powershell -File deploy\ec2.ps1 logs` / `ssh`, 접속 위치가 바뀌면 `allow-ssh`
- 시연 비밀번호·API 키: `deploy\.env.demo`의 `DEMO_BASIC_AUTH`, `AGENT_API_KEYS`. 재발급은 `node deploy\make-env.mjs --rotate` 후 push
- 완전 삭제: `powershell -File deploy\aws-destroy.ps1`

`deploy\.env.demo`, `deploy\state.json`, `~\.ssh\geo-demo.pem`은 이 PC에만 둔다. 채팅·문서에 붙여 넣지 않는다.
