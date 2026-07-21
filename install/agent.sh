#!/bin/bash
# install/agent.sh — kimi-remote 设备代理安装器(在你的 Mac/工作站上跑)
# 做:校验前置 → kimi server 驻留 → adapter 驻留 → SSH 隧道驻留 → 端到端自检
# 用法: bash install/agent.sh [--config ../config.env]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CONFIG="${2:-$ROOT/config.env}"
[ -f "$CONFIG" ] || { echo "❌ 缺 $CONFIG(先 cp config.example.env config.env 并填写)"; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"

step() { echo; echo "==> $*"; }
die() { echo "❌ $*"; exit 1; }
KIMI_PORT="${KIMI_PORT:-58627}"
ADAPTER_PORT="${ADAPTER_PORT:-58629}"
FLEET_PORT="${FLEET_PORT:-58628}"
LABEL_PREFIX="com.kimi-remote"
UID_N="$(id -u)"

step "1/6 前置校验"
[ "$(uname)" = "Darwin" ] || die "本安装器面向 macOS(linux 版在 roadmap)"
command -v node >/dev/null || die "缺 node >= 22(brew install node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node 需 >= 22(当前 $NODE_MAJOR):brew install node"
command -v kimi >/dev/null || die "缺 kimi CLI:https://code.kimi.com/kimi-code/install.sh"
: "${TUNNEL_SSH:?config.env 缺 TUNNEL_SSH(user@server)}"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$TUNNEL_SSH" true 2>/dev/null || \
  die "免密 SSH 不通:先 ssh-copy-id $TUNNEL_SSH"

step "2/6 kimi server 驻留(launchd)"
kimi web --no-open --port "$KIMI_PORT" >/dev/null 2>&1 || true
sleep 3
curl -sf --max-time 5 "http://127.0.0.1:$KIMI_PORT/api/healthz" >/dev/null 2>&1 || die "kimi server 未就绪(kimi web --no-open 手动看报错)"
[ -f "$HOME/.kimi-code/server.token" ] || die "缺 ~/.kimi-code/server.token"
echo "kimi server ✓ (127.0.0.1:$KIMI_PORT)"

step "3/6 adapter 驻留(launchd)"
TOKEN="$(cat "$HOME/.kimi-code/server.token")"
cat > "$HOME/.kimi-remote-adapter.env" <<EOF
MACHINE_TOKEN=$TOKEN
KIMI_UPSTREAM=http://127.0.0.1:$KIMI_PORT
ADAPTER_PORT=$ADAPTER_PORT
FLEET_UPSTREAM=http://127.0.0.1:$FLEET_PORT
EOF
chmod 600 "$HOME/.kimi-remote-adapter.env"
PLIST="$HOME/Library/LaunchAgents/$LABEL_PREFIX.adapter.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL_PREFIX.adapter</string>
<key>ProgramArguments</key><array>
<string>/bin/bash</string><string>-c</string>
<string>set -a; . "$HOME/.kimi-remote-adapter.env"; set +a; exec node "$ROOT/adapters/server.js"</string></array>
<key>WorkingDirectory</key><string>$ROOT/adapters</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/kimi-remote-adapter.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/kimi-remote-adapter.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$UID_N/$LABEL_PREFIX.adapter" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"
sleep 3
curl -sf --max-time 5 "http://127.0.0.1:$ADAPTER_PORT/api/v1/meta" -H "Authorization: Bearer $TOKEN" >/dev/null \
  && echo "adapter ✓ (127.0.0.1:$ADAPTER_PORT)" || die "adapter 未就绪:tail ~/Library/Logs/kimi-remote-adapter.log"

step "4/6 fleet 探针驻留(机群页读面,可选)"
if [ -d "$ROOT/fleet" ] && [ -f "$ROOT/fleet/agent.js" ]; then
  FTOKEN="${FLEET_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
  FPLIST="$HOME/Library/LaunchAgents/$LABEL_PREFIX.fleet.plist"
  cat > "$FPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL_PREFIX.fleet</string>
<key>ProgramArguments</key><array>
<string>/usr/bin/env</string><string>FLEET_TOKEN=$FTOKEN</string>
<string>$(command -v node)</string><string>$ROOT/fleet/agent.js</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/kimi-remote-fleet.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/kimi-remote-fleet.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$UID_N/$LABEL_PREFIX.fleet" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$FPLIST"
  echo "fleet ✓ (127.0.0.1:$FLEET_PORT,token 在本机 launchd 内)"
fi

step "5/6 SSH 隧道驻留(launchd)"
TPLIST="$HOME/Library/LaunchAgents/$LABEL_PREFIX.tunnel.plist"
PORTS="${TUNNEL_PORTS:-$KIMI_PORT:$KIMI_PORT,$ADAPTER_PORT:$ADAPTER_PORT,$FLEET_PORT:$FLEET_PORT}"
RARGS=""
IFS=',' read -ra PAIRS <<< "$PORTS"
for p in "${PAIRS[@]}"; do
  RARGS="$RARGS<string>-R</string><string>${p%%:*}:127.0.0.1:${p##*:}</string>"
done
cat > "$TPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL_PREFIX.tunnel</string>
<key>ProgramArguments</key><array>
<string>/usr/bin/ssh</string><string>-N</string><string>-T</string>
<string>-o</string><string>ServerAliveInterval=30</string>
<string>-o</string><string>ServerAliveCountMax=3</string>
<string>-o</string><string>ExitOnForwardFailure=yes</string>
$RARGS
<string>$TUNNEL_SSH</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/kimi-remote-tunnel.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/kimi-remote-tunnel.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$UID_N/$LABEL_PREFIX.tunnel" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$TPLIST"
sleep 4

step "6/6 端到端自检(从网关侧探)"
ok=1
ssh -o BatchMode=yes "$TUNNEL_SSH" "curl -sf --max-time 6 http://127.0.0.1:$KIMI_PORT/api/healthz >/dev/null" \
  && echo "隧道 kimi 端口 ✓" || { echo "隧道 kimi 端口 ✗"; ok=0; }
[ "$ok" = 1 ] || die "自检未过:查 launchctl list | grep $LABEL_PREFIX 与 ~/Library/Logs/kimi-remote-*.log"
echo
echo "✅ 设备接入完成。打开 https://${GATEWAY_DOMAIN:-<你的域名>} 用登录密码开始使用"
