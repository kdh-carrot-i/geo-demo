#!/usr/bin/env bash
# push.ps1 이 올린 묶음을 서버에 반영: 코드 풀기, .env, 의존성(바뀐 경우만), DB, Caddy, 재시작.
#   bash apply.sh <bundle.tgz> [data]
set -euo pipefail
APP=/opt/geo
BUNDLE=$1
WITH_DATA=${2:-}
UV=$(command -v uv || echo "$HOME/.local/bin/uv")

mkdir -p "$APP"
# 코드만 교체 (data, .venv, node_modules, .env 는 남김)
rm -rf "$APP/web/server" "$APP/web/src" "$APP/web/dist" "$APP/ml/out"
tar -xzf "$BUNDLE" -C "$APP"
rm -f "$BUNDLE"

# .env: 이 파일에만 키가 있다. 소유자만 읽기
install -m 600 /tmp/geo.env "$APP/web/.env" && rm -f /tmp/geo.env
envget() { grep -E "^$1=" "$APP/web/.env" | tail -1 | cut -d= -f2-; }

# Node 의존성: lock 파일이 바뀐 경우만
cd "$APP/web"
LOCK_SUM=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat node_modules/.lock.sha 2>/dev/null)" != "$LOCK_SUM" ]; then
  npm ci --no-audit --no-fund
  echo "$LOCK_SUM" > node_modules/.lock.sha
fi

# Python: requirements 가 바뀐 경우만
cd "$APP/ml"
REQ_SUM=$(sha256sum requirements.txt | cut -d' ' -f1)
if [ ! -x .venv/bin/python ] || [ "$(cat .venv/.req.sha 2>/dev/null)" != "$REQ_SUM" ]; then
  "$UV" python install 3.14
  "$UV" venv --python 3.14 --allow-existing .venv
  "$UV" pip install --python .venv/bin/python -r requirements.txt
  echo "$REQ_SUM" > .venv/.req.sha
fi

# DB: 압축 해제 후 교체 (서비스를 잠시 멈춤). 상태 DB(api.sqlite)는 서버에 없을 때만
if [ "$WITH_DATA" = "data" ]; then
  sudo systemctl stop geo-api || true
  zstd -d -f /tmp/commerce.sqlite.zst -o "$APP/data/commerce.sqlite.new"
  mv -f "$APP/data/commerce.sqlite.new" "$APP/data/commerce.sqlite"
  rm -f /tmp/commerce.sqlite.zst "$APP/data/commerce.sqlite-wal" "$APP/data/commerce.sqlite-shm"
  if [ ! -f "$APP/data/api.sqlite" ]; then mv /tmp/api.sqlite "$APP/data/api.sqlite"; else rm -f /tmp/api.sqlite; fi
fi
[ -f "$APP/data/commerce.sqlite" ] || { echo "data/commerce.sqlite 없음: push.ps1 -Data 로 올리십시오"; exit 1; }

# Caddy: 접속 주소 + basic auth (비밀번호는 bcrypt 해시로만 저장)
HOST=$(envget DEMO_HOST)
AUTH=$(envget DEMO_BASIC_AUTH)
[ -n "$HOST" ] && [ -n "$AUTH" ] || { echo ".env 에 DEMO_HOST / DEMO_BASIC_AUTH 가 없음"; exit 1; }
HASH=$(caddy hash-password --plaintext "${AUTH#*:}")
printf '%s {\n\tencode gzip\n\tbasic_auth {\n\t\t%s %s\n\t}\n\treverse_proxy 127.0.0.1:8787\n}\n' "$HOST" "${AUTH%%:*}" "$HASH" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload-or-restart caddy

sudo systemctl restart geo-api
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then echo "geo-api up: https://$HOST"; exit 0; fi
  sleep 2
done
echo "geo-api 가 응답하지 않음:"; sudo journalctl -u geo-api -n 40 --no-pager; exit 1
