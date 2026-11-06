#!/usr/bin/env bash
# push.sh 가 /tmp/geo-up 에 올린 묶음을 /opt/geo 에 반영. 기존 서비스는 건드리지 않는다.
#   bash apply.sh [data]
set -euo pipefail
APP=/opt/geo
UP=/tmp/geo-up
WITH_DATA=${1:-}
run() { sudo -u geo env HOME="$APP" PATH="$APP/node/bin:$APP/bin:/usr/bin:/bin" UV_PYTHON_INSTALL_DIR="$APP/python" "$@"; }

sudo systemctl stop geo-ngrok geo-api 2>/dev/null || true
sudo rm -rf "$APP/web/server" "$APP/web/src" "$APP/web/dist" "$APP/ml/out"
sudo tar -xzf "$UP/bundle.tgz" -C "$APP" --no-same-owner
sudo install -o geo -g geo -m 600 "$UP/geo.env" "$APP/web/.env"
sudo install -o geo -g geo -m 600 "$UP/ngrok.yml" "$APP/ngrok.yml"
sudo chown -R geo:geo "$APP/web" "$APP/ml"

insh() { run sh -c "$1"; }
SUM=$(sudo sha256sum "$APP/web/package-lock.json" | cut -d' ' -f1)
if [ "$(sudo cat "$APP/web/node_modules/.lock.sha" 2>/dev/null)" != "$SUM" ]; then
  insh "cd $APP/web && npm ci --no-audit --no-fund && echo $SUM > node_modules/.lock.sha"
fi
SUM=$(sudo sha256sum "$APP/ml/requirements.txt" | cut -d' ' -f1)
if [ "$(sudo cat "$APP/ml/.venv/.req.sha" 2>/dev/null)" != "$SUM" ]; then
  insh "cd $APP/ml && uv python install 3.14 && uv venv --python 3.14 --allow-existing .venv && uv pip install --python .venv/bin/python -r requirements.txt && echo $SUM > .venv/.req.sha"
fi

if [ "$WITH_DATA" = "data" ]; then
  sudo -u geo zstd -q -d -f "$UP/commerce.sqlite.zst" -o "$APP/data/commerce.sqlite.new"
  sudo -u geo mv -f "$APP/data/commerce.sqlite.new" "$APP/data/commerce.sqlite"
  sudo rm -f "$APP/data/commerce.sqlite-wal" "$APP/data/commerce.sqlite-shm"
fi
if [ -f "$UP/internal.sqlite.zst" ]; then
  sudo -u geo zstd -q -d -f "$UP/internal.sqlite.zst" -o "$APP/data/internal.sqlite.new"
  sudo -u geo mv -f "$APP/data/internal.sqlite.new" "$APP/data/internal.sqlite"
fi
sudo rm -rf "$UP"
sudo systemctl start geo-api
for i in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:8790/api/health >/dev/null && break; sleep 2; done
curl -s -m 3 http://127.0.0.1:8790/api/health; echo
systemctl is-active store-vision
