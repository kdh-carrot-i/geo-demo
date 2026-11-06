# 코드(+선택: DB)를 시연 서버에 올리고 재시작한다.
#   powershell -File deploy\push.ps1                 코드만 (화면 빌드 → 묶음 → 업로드 → 반영)
#   powershell -File deploy\push.ps1 -Data           DB도 (data\deploy\ 의 압축본, 없으면 pack-data.py 먼저 실행)
#   powershell -File deploy\push.ps1 -Setup -Data    첫 배포: 서버 설치(Node·Python·Caddy)부터
param([switch]$Setup, [switch]$Data, [switch]$RepackData, [switch]$SkipBuild)
. "$PSScriptRoot\config.ps1"
$s = Get-State

# 0. 서버용 .env (DEMO_HOST 를 state.json 에 맞춤)
node "$PSScriptRoot\make-env.mjs"
if ($LASTEXITCODE) { throw '.env.demo 생성 실패' }

# 1. 화면 빌드
if (-not $SkipBuild) {
  Push-Location (Join-Path $RepoRoot 'web')
  try { npm run build; if ($LASTEXITCODE) { throw '화면 빌드 실패' } } finally { Pop-Location }
}

# 2. 코드 묶음 (서버가 실제로 쓰는 것만)
$files = @('web/package.json', 'web/package-lock.json', 'web/dist', 'web/server', 'web/src/shared', 'ml/requirements.txt')
$files += Get-ChildItem (Join-Path $RepoRoot 'ml') -Filter *.py | ForEach-Object { "ml/$($_.Name)" }
$files += Get-ChildItem (Join-Path $RepoRoot 'ml\out') -File | Where-Object { $_.Extension -in '.txt', '.pkl', '.json' } | ForEach-Object { "ml/out/$($_.Name)" }
$list = Join-Path $env:TEMP 'geo-bundle.list'
[IO.File]::WriteAllLines($list, [string[]]$files)
$bundle = Join-Path $env:TEMP 'geo-bundle.tgz'
& "$env:SystemRoot\System32\tar.exe" -czf $bundle -C $RepoRoot --exclude '__pycache__' -T $list
if ($LASTEXITCODE) { throw '묶음 생성 실패' }
Write-Host ("코드 묶음 {0:N1} MB" -f ((Get-Item $bundle).Length / 1MB))

# 3. 서버 설치 (처음 한 번)
if ($Setup) {
  Copy-ToRemote $s (Join-Path $PSScriptRoot 'remote\setup.sh') '/tmp/geo-setup.sh'
  Invoke-Remote $s 'bash /tmp/geo-setup.sh'
}

# 4. DB
if ($Data) {
  $zst = Join-Path $RepoRoot 'data\deploy\commerce.sqlite.zst'
  if ($RepackData -or -not (Test-Path $zst)) {
    & (Join-Path $RepoRoot 'ml\.venv\Scripts\python.exe') -I (Join-Path $PSScriptRoot 'pack-data.py')
    if ($LASTEXITCODE) { throw 'DB 압축 실패' }
  }
  Write-Host ("DB 업로드 {0:N2} GB … (회선에 따라 수 분~수십 분)" -f ((Get-Item $zst).Length / 1GB))
  Copy-ToRemote $s $zst '/tmp/commerce.sqlite.zst'
  Copy-ToRemote $s (Join-Path $RepoRoot 'data\deploy\api.sqlite') '/tmp/api.sqlite'
}

# 5. 반영
Copy-ToRemote $s $bundle '/tmp/geo-bundle.tgz'
Copy-ToRemote $s $EnvPath '/tmp/geo.env'
Copy-ToRemote $s (Join-Path $PSScriptRoot 'remote\apply.sh') '/tmp/geo-apply.sh'
Invoke-Remote $s ("bash /tmp/geo-apply.sh /tmp/geo-bundle.tgz " + ($(if ($Data) { 'data' } else { '' })))
Remove-Item $bundle, $list
Write-Host "배포 완료: https://$($s.host)"
