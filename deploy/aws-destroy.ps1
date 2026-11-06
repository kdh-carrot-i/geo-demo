# 시연 서버를 완전히 지운다 (인스턴스·디스크·고정 IP·보안 그룹·키 페어). 되돌릴 수 없음.
#   powershell -File deploy\aws-destroy.ps1
. "$PSScriptRoot\config.ps1"
$s = Get-State
$ok = Read-Host "인스턴스 $($s.instance_id) ($($s.ip))와 디스크·고정 IP를 지웁니다. 계속하려면 '삭제' 입력"
if ($ok -ne '삭제') { Write-Host '취소'; exit 1 }

Aws ec2 disassociate-address --public-ip $s.ip | Out-Null
Aws ec2 release-address --allocation-id $s.allocation_id | Out-Null
Aws ec2 terminate-instances --instance-ids $s.instance_id | Out-Null
Aws ec2 wait instance-terminated --instance-ids $s.instance_id
Aws ec2 delete-security-group --group-id $s.security_group | Out-Null
Aws ec2 delete-key-pair --key-name $Name | Out-Null
Remove-Item $StatePath
Write-Host "삭제 완료. 개인 키 $KeyPath 는 남겨 두었습니다 (필요 없으면 직접 삭제)."
