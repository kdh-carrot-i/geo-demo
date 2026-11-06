# AWS 대신 이 PC에서 시연: 시연용 설정(.env.demo)으로 운영 모드 서버를 따로 띄우고 ngrok 고정 주소로 연다.
#   powershell -File deploy\local-demo.ps1
# 개발 서버(8000/8787)와 별개로 8790 포트. 경기 유동인구 제외(DATA_SCOPE=external).
# Ctrl+C 로 끄면 서버와 터널이 함께 내려간다.
#   기본: 아이디·비밀번호도 API 키도 없이 열린다 (주소를 아는 사람은 누구나 사용)
#   -Auth : 아이디·비밀번호(DEMO_BASIC_AUTH)와 API 키(AGENT_API_KEYS)를 .env.demo 값으로 건다
param([switch]$Auth)
. "$PSScriptRoot\config.ps1"
$Port = 8790
$web = Join-Path $RepoRoot 'web'

if (-not (Test-Path $EnvPath)) { node "$PSScriptRoot\make-env.mjs"; if ($LASTEXITCODE) { throw '.env.demo 생성 실패' } }
$authPair = (Get-Content $EnvPath | Where-Object { $_ -match '^DEMO_BASIC_AUTH=' } | Select-Object -First 1) -replace '^DEMO_BASIC_AUTH=', ''
if ($Auth -and -not $authPair) { throw '.env.demo 에 DEMO_BASIC_AUTH 가 없습니다.' }
if (-not (Test-Path (Join-Path $web 'dist\index.html'))) { Push-Location $web; npm run build; Pop-Location }

$ngrok = (Get-Command ngrok -ErrorAction SilentlyContinue).Source
if (-not $ngrok) { $ngrok = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ngrok.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
if (-not $ngrok) { throw 'ngrok 이 없습니다: winget install Ngrok.Ngrok' }

$env:ENV_FILE = $EnvPath
$env:SERVE_DIST = '1'
$env:API_PORT = "$Port"
# 접속 기록 (월별 파일): deploy\logs\demo-access-YYYYMM.log, 요청마다 JSON 한 줄
$env:ACCESS_LOG = Join-Path $PSScriptRoot ("logs\demo-access-{0}.log" -f (Get-Date -Format 'yyyyMM'))
# 공백 = 키 검사 끔 (빈 문자열은 Windows에서 변수 삭제가 되어 .env.demo 값이 다시 들어온다)
if (-not $Auth) { $env:AGENT_API_KEYS = ' ' }
# 이 스크립트가 도는 동안만 자동 절전을 막는다 (화면은 꺼져도 됨). 끝나면 원래 전원 설정으로 돌아간다.
# 덮개를 닫으면 절전되는 건 막지 못한다 (제어판 > 전원 옵션 > 덮개를 닫으면).
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Power]::SetThreadExecutionState([uint32]'0x80000001') | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

$server = Start-Process -PassThru -NoNewWindow -WorkingDirectory $web -FilePath node -ArgumentList 'node_modules/tsx/dist/cli.mjs', 'server/index.ts'
try {
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
  }
  # 무료 계정의 고정 개발 도메인으로 열린다 (Kakao 에 한 번 등록하면 계속 유지)
  $ngrokArgs = @('http', "$Port", '--log=stdout', '--log-level=warn')
  if ($Auth) { $ngrokArgs += "--basic-auth=$authPair" }
  & $ngrok @ngrokArgs
} finally {
  if (-not $server.HasExited) { & taskkill /PID $server.Id /T /F | Out-Null }
  [Win32.Power]::SetThreadExecutionState([uint32]'0x80000000') | Out-Null
}
