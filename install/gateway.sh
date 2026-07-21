#!/bin/bash
# install/gateway.sh — kimi-remote 网关安装器(在你的云服务器上跑)
# 做:校验前置 → 生成密钥/env → docker 网关 → nginx+certbot → 健康自检
# 用法: sudo bash install/gateway.sh [--config ../config.env]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CONFIG="${2:-$ROOT/config.env}"
[ -f "$CONFIG" ] || { echo "❌ 缺 $CONFIG(先 cp config.example.env config.env 并填写)"; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"

step() { echo; echo "==> $*"; }
die() { echo "❌ $*"; exit 1; }

step "1/6 前置校验"
command -v docker >/dev/null || die "缺 docker:https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "缺 docker compose 插件"
command -v nginx >/dev/null || die "缺 nginx:apt install nginx"
command -v certbot >/dev/null || die "缺 certbot:apt install certbot python3-certbot-nginx"
command -v node >/dev/null || die "缺 node >=18(仅用于生成密码哈希)"
: "${GATEWAY_DOMAIN:?config.env 缺 GATEWAY_DOMAIN}"
: "${LOGIN_PASSWORD:?config.env 缺 LOGIN_PASSWORD}"
IP="$(curl -s --max-time 8 https://api.ipify.org || true)"
echo "域名: $GATEWAY_DOMAIN  本机公网 IP: ${IP:-未知}(请确认 DNS 已指向)"

step "2/6 生成密钥与 deploy/.env(明文密码不落盘)"
JWT="${JWT_SECRET:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"
HASH="$(node -e 'const {hashPassword}=require(process.argv[1]);console.log(hashPassword(process.argv[2]))' "$ROOT/gateway/src/users.js" "$LOGIN_PASSWORD")"
FLEET="${FLEET_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
mkdir -p "$ROOT/deploy"
umask 077
cat > "$ROOT/deploy/.env" <<EOF
KIMI_UPSTREAM=http://127.0.0.1:${KIMI_PORT:-58627}
ADAPTER_UPSTREAM=http://127.0.0.1:${ADAPTER_PORT:-58629}
KIMI_TOKEN=${KIMI_TOKEN:-}
LOGIN_PASSWORD_SCRYPT=$HASH
JWT_SECRET=$JWT
HOST=127.0.0.1
PORT=${GATEWAY_PORT:-8080}
FLEET_TOKEN=$FLEET
FLEET_UPSTREAM=http://127.0.0.1:${FLEET_PORT:-58628}
EOF
echo "deploy/.env 已生成(权限 600)"

step "3/6 构建并启动网关容器"
cd "$ROOT/gateway"
docker compose -p kimi-remote build --quiet
docker compose -p kimi-remote up -d
sleep 3
docker ps --format '{{.Names}} {{.Status}}' | grep kimi-remote || die "容器未起来:docker compose -p kimi-remote logs"

step "4/6 nginx 反代"
VHOST="/etc/nginx/sites-available/kimi-remote"
cat > "$VHOST" <<EOF
server {
    server_name $GATEWAY_DOMAIN;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT:-8080};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
    listen 80;
}
EOF
grep -q connection_upgrade /etc/nginx/nginx.conf || sed -i 's|http {|http {\n    map $http_upgrade $connection_upgrade { default upgrade; "" close; }|' /etc/nginx/nginx.conf
ln -sf "$VHOST" /etc/nginx/sites-enabled/kimi-remote
nginx -t
systemctl reload nginx

step "5/6 证书(certbot)"
certbot --nginx -d "$GATEWAY_DOMAIN" --non-interactive --agree-tos -m "admin@$GATEWAY_DOMAIN" --redirect || \
  echo "⚠️ certbot 未成功(DNS 未生效时常见):稍后手动 certbot --nginx -d $GATEWAY_DOMAIN"

step "6/6 健康自检"
ok=1
curl -sf --max-time 8 "http://127.0.0.1:${GATEWAY_PORT:-8080}/healthz" | grep -q '"ok":true' && echo "网关 healthz ✓" || { echo "网关 healthz ✗"; ok=0; }
[ "$ok" = 1 ] || die "自检未过"
echo
echo "✅ 网关就绪: https://$GATEWAY_DOMAIN"
echo "下一步:在你的 Mac/工作站上跑 install/agent.sh(它会通过 SSH 隧道把设备接上来)"
