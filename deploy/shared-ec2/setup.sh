#!/usr/bin/env bash
# 다른 서비스가 도는 EC2(Amazon Linux 2023)에 한 번: 전용 계정 geo + /opt/geo 안에만 설치한다.
# 시스템 패키지·스왑·방화벽·기존 서비스는 건드리지 않는다. 서비스는 등록만 하고 켜지 않는다.
set -euo pipefail
APP=/opt/geo
NODE=v24.22.1

id geo >/dev/null 2>&1 || sudo useradd --system --home-dir "$APP" --shell /sbin/nologin geo
sudo mkdir -p "$APP"/{bin,data,logs,web,ml}
sudo chown -R geo:geo "$APP"
sudo chmod 750 "$APP"
run() { sudo -u geo env HOME="$APP" PATH="$APP/bin:$PATH" "$@"; }

if [ ! -x "$APP/node/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" -o /tmp/geo-node.tar.xz
  run mkdir -p "$APP/node"
  sudo tar -xJf /tmp/geo-node.tar.xz -C "$APP/node" --strip-components=1 --no-same-owner
  sudo chown -R geo:geo "$APP/node"
  rm -f /tmp/geo-node.tar.xz
fi
if [ ! -x "$APP/bin/uv" ]; then
  curl -fsSL https://astral.sh/uv/install.sh -o /tmp/geo-uv.sh
  run env UV_INSTALL_DIR="$APP/bin" UV_NO_MODIFY_PATH=1 sh /tmp/geo-uv.sh
  rm -f /tmp/geo-uv.sh
fi
if [ ! -x "$APP/bin/ngrok" ]; then
  curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/geo-ngrok.tgz
  sudo tar -xzf /tmp/geo-ngrok.tgz -C "$APP/bin" --no-same-owner
  sudo chown geo:geo "$APP/bin/ngrok"
  rm -f /tmp/geo-ngrok.tgz
fi

sudo tee /etc/systemd/system/geo-api.service >/dev/null <<'UNIT'
[Unit]
Description=geo_reverse 시연 API + 화면 (127.0.0.1:8790)
After=network-online.target
Wants=network-online.target

[Service]
User=geo
WorkingDirectory=/opt/geo/web
Environment=NODE_ENV=production
Environment=SERVE_DIST=1
Environment=HOME=/opt/geo
Environment=PATH=/opt/geo/node/bin:/usr/bin:/bin
Environment=ACCESS_LOG=/opt/geo/logs/demo-access.log
ExecStart=/opt/geo/node/bin/node node_modules/tsx/dist/cli.mjs server/index.ts
Restart=on-failure
RestartSec=5
# 같은 서버의 다른 서비스를 밀어내지 않도록 상한
MemoryMax=6G
CPUQuota=200%
Nice=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/geo
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/geo-ngrok.service >/dev/null <<'UNIT'
[Unit]
Description=geo_reverse 시연 터널 (ngrok → 127.0.0.1:8790)
After=geo-api.service
Requires=geo-api.service

[Service]
User=geo
Environment=HOME=/opt/geo
ExecStart=/opt/geo/bin/ngrok http 8790 --config /opt/geo/ngrok.yml --log=stdout --log-level=warn
Restart=on-failure
RestartSec=10
MemoryMax=256M
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/geo

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
"$APP/node/bin/node" -v 2>/dev/null || sudo -u geo "$APP/node/bin/node" -v
sudo -u geo "$APP/bin/uv" --version
sudo -u geo "$APP/bin/ngrok" version
