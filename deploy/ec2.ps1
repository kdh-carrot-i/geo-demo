# 시연 서버 켜기·끄기 등. 끈 동안은 디스크·고정 IP 요금만 나간다.
#   powershell -File deploy\ec2.ps1 start | stop | status | ssh | logs | allow-ssh
param([Parameter(Mandatory)][ValidateSet('start', 'stop', 'status', 'ssh', 'logs', 'allow-ssh')][string]$Action)
. "$PSScriptRoot\config.ps1"
$s = Get-State

switch ($Action) {
  'start' {
    Aws ec2 start-instances --instance-ids $s.instance_id | Out-Null
    Aws ec2 wait instance-running --instance-ids $s.instance_id
    Write-Host "켜는 중… 화면이 뜰 때까지 기다립니다 (모델 로딩 포함 1~2분)"
    # 앞단 basic auth 때문에 401이 와도 서버가 떠 있다는 뜻
    for ($i = 0; $i -lt 40; $i++) {
      try { Invoke-WebRequest "https://$($s.host)/api/health" -UseBasicParsing -TimeoutSec 5 | Out-Null; break }
      catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { break } }
      Start-Sleep 5
    }
    Write-Host "접속: https://$($s.host)  (비밀번호·API 키는 deploy\.env.demo 의 DEMO_BASIC_AUTH / AGENT_API_KEYS)"
  }
  'stop' {
    Aws ec2 stop-instances --instance-ids $s.instance_id | Out-Null
    Aws ec2 wait instance-stopped --instance-ids $s.instance_id
    Write-Host '꺼짐. 이제 서버 시간 요금은 나가지 않습니다.'
  }
  'status' {
    Aws ec2 describe-instances --instance-ids $s.instance_id --query 'Reservations[0].Instances[0].[State.Name,InstanceType,LaunchTime]' --output text
    Write-Host "https://$($s.host)"
  }
  'ssh' { & ssh.exe @(Ssh-Args $s) }
  'logs' { Invoke-Remote $s 'sudo journalctl -u geo-api -n 120 --no-pager' }
  'allow-ssh' {
    # 집·사무실처럼 접속 위치가 바뀌었을 때 지금 IP를 SSH 허용에 추가
    $myIp = (Invoke-RestMethod 'https://checkip.amazonaws.com').Trim()
    Aws ec2 authorize-security-group-ingress --group-id $s.security_group --protocol tcp --port 22 --cidr "$myIp/32" | Out-Null
    Write-Host "SSH 허용 추가: $myIp"
  }
}
