# 배포 공통 설정. 다른 deploy/*.ps1 이 dot-source 한다.
$ErrorActionPreference = 'Stop'

$AwsProfile   = 'geo'              # aws configure --profile geo
$Region       = 'ap-northeast-2'   # 서울
$Name         = 'geo-demo'         # 키 페어·보안 그룹·인스턴스·고정 IP 이름 태그
$InstanceType = 't3.medium'        # 메모리 4GB: 모델 프로세스(serve.py)가 약 1.6GB
$DiskGb       = 30
$KeyPath      = Join-Path $HOME '.ssh\geo-demo.pem'
$StatePath    = Join-Path $PSScriptRoot 'state.json'   # aws-create.ps1 이 만든 리소스 ID·IP
$EnvPath      = Join-Path $PSScriptRoot '.env.demo'    # 서버용 .env (make-env.mjs 로 생성, 값은 출력하지 않음)
$RepoRoot     = Split-Path $PSScriptRoot -Parent
$RemoteRoot   = '/opt/geo'

$AwsExe = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $AwsExe) { $AwsExe = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' }

function Aws {
  $out = & $AwsExe --profile $AwsProfile --region $Region @args
  if ($LASTEXITCODE) { throw "aws $($args[0..1] -join ' ') 실패 (exit $LASTEXITCODE)" }
  $out
}

function Get-State {
  if (-not (Test-Path $StatePath)) { throw "서버가 아직 없습니다. 먼저 deploy\aws-create.ps1 을 실행하십시오." }
  Get-Content $StatePath -Raw | ConvertFrom-Json
}

function Ssh-Args($s) { @('-i', $KeyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', "ubuntu@$($s.ip)") }

function Invoke-Remote($s, [string]$cmd) {
  & ssh.exe @(Ssh-Args $s) $cmd
  if ($LASTEXITCODE) { throw "원격 명령 실패 (exit $LASTEXITCODE): $cmd" }
}

function Copy-ToRemote($s, [string]$local, [string]$remote) {
  & scp.exe -i $KeyPath -o StrictHostKeyChecking=accept-new $local "ubuntu@$($s.ip):$remote"
  if ($LASTEXITCODE) { throw "업로드 실패: $local" }
}
