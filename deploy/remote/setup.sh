#!/usr/bin/env bash
# 새 EC2(Ubuntu 24.04)에 한 번: 스왑, Node 24, uv(Python 3.14), Caddy, systemd 서비스. 다시 실행해도 안전.
set -euo pipefail
APP=/opt/geo

sudo mkdir -p "$APP/data" && sudo chown -R ubuntu:ubuntu "$APP"

# 스왑 2GB: 모델 프로세스가 1.6GB를 쓰므로 순간 여유분
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg zstd libgomp1 debian-keyring debian-archive-keyring apt-transport-https

# Node 24 (로컬과 같은 메이저: node:sqlite 사용)
if ! node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# uv: Python 3.14 + 모델 패키지
if ! command -v uv >/dev/null && [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

# Caddy: HTTPS 인증서 자동 발급 + basic auth
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

# API + 화면 서비스 (127.0.0.1:8787, 앞단은 Caddy)
sudo tee /etc/systemd/system/geo-api.service >/dev/null <<'EOF'
[Unit]
Description=geo_reverse API + 화면
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/opt/geo/web
Environment=NODE_ENV=production
Environment=SERVE_DIST=1
ExecStart=/usr/bin/node /opt/geo/web/node_modules/tsx/dist/cli.mjs server/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable geo-api caddy >/dev/null
echo "setup done: node $(node -v), $("$HOME/.local/bin/uv" --version 2>/dev/null || uv --version), $(caddy version | cut -d' ' -f1)"
