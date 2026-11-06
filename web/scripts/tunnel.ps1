# ngrok 터널로 심사 화면(Vite 8000, /api는 8787로 프록시)을 외부에 연다.
# 기본 인증(아이디:비밀번호)은 web/.env의 NGROK_BASIC_AUTH, API는 AGENT_API_KEYS로 따로 보호된다.
#   powershell -File web/scripts/tunnel.ps1
$envFile = Join-Path $PSScriptRoot '..\.env'
$line = Get-Content $envFile | Where-Object { $_ -match '^NGROK_BASIC_AUTH=' } | Select-Object -First 1
if (-not $line) { Write-Error 'web/.env에 NGROK_BASIC_AUTH=아이디:비밀번호 가 없습니다.'; exit 1 }
$auth = $line.Substring('NGROK_BASIC_AUTH='.Length).Trim()
ngrok http 8000 --basic-auth="$auth" --log=stdout --log-level=warn
