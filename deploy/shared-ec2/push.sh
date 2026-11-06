#!/usr/bin/env bash
# 공유 EC2 배포: 화면 빌드 → 묶음 → 업로드 → apply.sh. 터널 전환은 여기서 하지 않는다 (시험 후 따로).
#   bash deploy/shared-ec2/push.sh [data]
# 사내 DB는 건물·토지 표만 올린다. 카드매출 원본·S3 키는 올리지 않는다.
set -euo pipefail
cd "$(dirname "$0")/../.."
KEY="${EC2_KEY:?EC2_KEY 경로 필요}"
HOST="${EC2_HOST:?EC2_HOST 필요}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o LogLevel=ERROR "$HOST")
SCP=(scp -i "$KEY" -o BatchMode=yes -o LogLevel=ERROR)
WITH_DATA=${1:-}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

(cd web && npm run build >/dev/null)
ls ml/*.py > "$T/list"
find ml/out -maxdepth 1 -type f \( -name '*.txt' -o -name '*.pkl' -o -name '*.json' \) >> "$T/list"
printf '%s\n' web/package.json web/package-lock.json web/dist web/server web/src/shared ml/requirements.txt >> "$T/list"
tar -czf "$T/bundle.tgz" --exclude __pycache__ -T "$T/list"

# 서버 .env: 시연 설정 기준, 쓰지 않는 값은 뺀다 (값은 출력하지 않는다)
node -e "
const fs=require('fs');const drop=/^(DW_AWS_|DEMO_BASIC_AUTH|DEMO_HOST|API_PORT|AGENT_API_KEYS|DATA_SCOPE|NGROK_)/;
const lines=fs.readFileSync('web/.env','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.trimStart().startsWith('#')&&!drop.test(l));
fs.writeFileSync(process.argv[1],[...lines,'API_PORT=8790','DATA_SCOPE=external','AGENT_API_KEYS= '].join('\n')+'\n',{mode:0o600})" "$T/geo.env"

"${SSH[@]}" 'rm -rf /tmp/geo-up && mkdir -m 700 /tmp/geo-up'
cp "$(cygpath "$LOCALAPPDATA")/ngrok/ngrok.yml" "$T/ngrok.yml"
FILES=("$T/bundle.tgz" "$T/geo.env" "$T/ngrok.yml" deploy/shared-ec2/apply.sh)
[ "$WITH_DATA" = data ] && FILES+=(data/deploy/commerce.sqlite.zst data/deploy/internal.sqlite.zst)
"${SCP[@]}" "${FILES[@]}" "$HOST:/tmp/geo-up/"
"${SSH[@]}" "bash /tmp/geo-up/apply.sh $WITH_DATA"
