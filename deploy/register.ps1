# 콘솔에서 직접 만든 EC2를 배포 대상으로 등록한다 (aws-create.ps1 대신, AWS CLI 키 없이).
#   powershell -File deploy\register.ps1 -Ip 3.34.x.x -InstanceId i-xxxx -Pem C:\Users\...\Downloads\geo-demo.pem
# 개인 키를 ~/.ssh/geo-demo.pem 으로 옮겨 권한을 본인만으로 줄이고, deploy\state.json 을 만든다.
param([Parameter(Mandatory)][string]$Ip, [string]$InstanceId = '', [Parameter(Mandatory)][string]$Pem)
. "$PSScriptRoot\config.ps1"

if (-not (Test-Path $Pem)) { throw "키 파일이 없습니다: $Pem" }
if ((Resolve-Path $Pem).Path -ne $KeyPath) {
  New-Item -ItemType Directory -Force (Split-Path $KeyPath) | Out-Null
  if (Test-Path $KeyPath) { icacls $KeyPath /grant:r "$($env:USERNAME):F" | Out-Null }
  Move-Item -Force $Pem $KeyPath
}
# OpenSSH는 다른 사용자가 읽을 수 있는 키를 거부한다
icacls $KeyPath /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null

$hostName = ($Ip -replace '\.', '-') + '.sslip.io'
[ordered]@{ instance_id = $InstanceId; ip = $Ip; host = $hostName; created_by = 'console'; registered_at = (Get-Date).ToString('s') } |
  ConvertTo-Json | Set-Content -Path $StatePath -Encoding utf8

& ssh.exe -i $KeyPath -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "ubuntu@$Ip" 'echo ssh-ok; uname -m; free -h | head -2; df -h / | tail -1'
if ($LASTEXITCODE) { throw 'SSH 접속 실패: 보안 그룹의 SSH(22) 허용 IP, 인스턴스 상태, 사용자 이름(ubuntu)을 확인하십시오.' }
Write-Host ''
Write-Host "등록 완료. 접속 주소 https://$hostName"
Write-Host "  1) Kakao Developers > 플랫폼 > Web 사이트 도메인에 https://$hostName 추가"
Write-Host '  2) powershell -File deploy\push.ps1 -Setup -Data'
