# 시연 서버 리소스를 한 번 만든다: 키 페어, 보안 그룹(22=내 IP, 80·443=전체), EC2(Ubuntu 24.04), 고정 IP.
#   powershell -File deploy\aws-create.ps1
# 만든 리소스 ID와 IP는 deploy\state.json 에 남긴다. 지울 때는 deploy\aws-destroy.ps1.
. "$PSScriptRoot\config.ps1"

if (Test-Path $StatePath) { throw "이미 만든 서버가 있습니다 ($StatePath). 다시 만들려면 aws-destroy.ps1 먼저." }
$who = Aws sts get-caller-identity --query Arn --output text
Write-Host "AWS 사용자: $who / 리전 $Region"

# 1. 키 페어 (개인 키는 이 PC에만: ~/.ssh/geo-demo.pem)
# 없으면 aws가 stderr로 오류를 내는데, 5.1에서 Stop 상태로 stderr를 돌리면 예외가 되므로 잠시 Continue
$ErrorActionPreference = 'Continue'
$existing = & $AwsExe --profile $AwsProfile --region $Region ec2 describe-key-pairs --key-names $Name --query 'KeyPairs[0].KeyName' --output text 2>$null
$found = $LASTEXITCODE -eq 0 -and $existing -eq $Name
$ErrorActionPreference = 'Stop'
if ($found) {
  if (-not (Test-Path $KeyPath)) { throw "AWS에 키 페어 '$Name'이 있는데 $KeyPath 가 없습니다. 콘솔에서 키 페어를 지우고 다시 실행하십시오." }
} else {
  New-Item -ItemType Directory -Force (Split-Path $KeyPath) | Out-Null
  $pem = Aws ec2 create-key-pair --key-name $Name --key-type ed25519 --query KeyMaterial --output text
  [IO.File]::WriteAllText($KeyPath, (($pem -join "`n").Trim() + "`n"))
  # OpenSSH는 다른 사용자가 읽을 수 있는 키를 거부한다
  icacls $KeyPath /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
  Write-Host "키 페어 생성: $KeyPath"
}

# 2. 보안 그룹
$vpc = Aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text
if (-not $vpc -or $vpc -eq 'None') { throw '기본 VPC가 없습니다. 관리자에게 기본 VPC(또는 사용할 퍼블릭 서브넷) 확인을 요청하십시오.' }
$sg = Aws ec2 create-security-group --group-name $Name --description 'geo_reverse demo' --vpc-id $vpc --query GroupId --output text
$myIp = (Invoke-RestMethod 'https://checkip.amazonaws.com').Trim()
Aws ec2 authorize-security-group-ingress --group-id $sg --protocol tcp --port 22 --cidr "$myIp/32" | Out-Null
foreach ($p in 80, 443) { Aws ec2 authorize-security-group-ingress --group-id $sg --protocol tcp --port $p --cidr 0.0.0.0/0 | Out-Null }
Write-Host "보안 그룹 $sg (SSH는 $myIp 만)"

# 3. EC2: Canonical 공식 Ubuntu 24.04 최신 이미지
$ami = Aws ec2 describe-images --owners 099720109477 --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text
$bdm = Join-Path $env:TEMP 'geo-bdm.json'
# PowerShell 5.1은 네이티브 인자 안의 큰따옴표를 지우므로 JSON은 파일로 넘긴다
[IO.File]::WriteAllText($bdm, "[{`"DeviceName`":`"/dev/sda1`",`"Ebs`":{`"VolumeSize`":$DiskGb,`"VolumeType`":`"gp3`",`"DeleteOnTermination`":true}}]")
$iid = Aws ec2 run-instances --image-id $ami --instance-type $InstanceType --key-name $Name --security-group-ids $sg `
  --block-device-mappings "file://$bdm" --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' `
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$Name}]" "ResourceType=volume,Tags=[{Key=Name,Value=$Name}]" `
  --query 'Instances[0].InstanceId' --output text
Write-Host "인스턴스 $iid ($InstanceType, $ami) 시작 대기…"
Aws ec2 wait instance-running --instance-ids $iid

# 4. 고정 IP: 껐다 켜도 주소가 같아야 Kakao·VWorld 등록이 유지된다
$alloc = (Aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$Name}]" --query '[AllocationId,PublicIp]' --output text) -split '\s+'
Aws ec2 associate-address --instance-id $iid --allocation-id $alloc[0] | Out-Null
$ip = $alloc[1]
$hostName = ($ip -replace '\.', '-') + '.sslip.io'

[ordered]@{ instance_id = $iid; security_group = $sg; allocation_id = $alloc[0]; ip = $ip; host = $hostName; ami = $ami; created_at = (Get-Date).ToString('s') } |
  ConvertTo-Json | Set-Content -Path $StatePath -Encoding utf8

Write-Host ''
Write-Host "완료. 고정 IP $ip / 접속 주소 https://$hostName"
Write-Host '다음:'
Write-Host "  1) Kakao Developers > 앱 > 플랫폼 > Web 사이트 도메인에 https://$hostName 추가"
Write-Host "  2) powershell -File deploy\push.ps1 -Setup -Data   (첫 배포: 서버 설치 + 코드 + DB)"
