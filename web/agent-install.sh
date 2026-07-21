#!/bin/bash
# kimi-remote 成员机一键接入(agent installer)
# 用法: bash <(curl -fsSL https://your.domain/agent-install.sh)
# 流程:登录 → 生成/复用 SSH 密钥 → 注册机器(分配远端端口)→ 写 launchd 隧道 → 上线验证
set -euo pipefail

GATEWAY="${GATEWAY:-https://your.domain}"
SSH_HOST="${SSH_HOST:-user@your.server.ip}"
KEY="$HOME/.ssh/kimi-remote-tunnel"
PLIST="$HOME/Library/LaunchAgents/com.kimi-remote.tunnel.plist"

echo "== kimi-remote 成员机接入 =="

# --- 0. 前置检查 ---
command -v ssh >/dev/null || { echo "需要 ssh"; exit 1; }
command -v curl >/dev/null || { echo "需要 curl"; exit 1; }
command -v jq >/dev/null || { echo "需要 jq(brew install jq)"; exit 1; }
command -v ssh-keygen >/dev/null || { echo "需要 ssh-keygen"; exit 1; }

# --- 1. 收集信息 ---
read -rp "网关地址 [$GATEWAY]: " x; GATEWAY="${x:-$GATEWAY}"
read -rp "用户名: " USERNAME
read -rsp "密码: " PASSWORD; echo
DEFAULT_MID="$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-' || hostname -s | tr '[:upper:]' '[:lower:]')"
read -rp "机器标识(小写字母数字-) [$DEFAULT_MID]: " MACHINE_ID; MACHINE_ID="${MACHINE_ID:-$DEFAULT_MID}"

# --- 2. 登录 ---
echo "==> 登录网关…"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$GATEWAY/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
[ "$CODE" = "204" ] || { echo "登录失败(HTTP $CODE),检查用户名/密码"; exit 1; }

# --- 3. SSH 密钥 ---
if [ ! -f "$KEY" ]; then
  echo "==> 生成隧道专用密钥 $KEY"
  ssh-keygen -t ed25519 -N '' -C "kimi-remote-tunnel-$MACHINE_ID" -f "$KEY" >/dev/null
fi
PUBKEY="$(cat "$KEY.pub")"

# --- 4. 注册机器 ---
echo "==> 注册机器 $MACHINE_ID …"
RESP=$(curl -s -b "$JAR" -X POST "$GATEWAY/machines/register" \
  -H 'content-type: application/json' \
  -d "{\"machine_id\":\"$MACHINE_ID\",\"note\":\"$(hostname)\"}")
if ! echo "$RESP" | jq -e '.code==0' >/dev/null; then
  echo "注册失败: $(echo "$RESP" | jq -r '.msg // .')" >&2; exit 1
fi
REMOTE_PORT=$(echo "$RESP" | jq -r '.data.remote_port')
echo "    分配到远端端口: $REMOTE_PORT"

# --- 5. 上传公钥(由网关在注册时同请求处理则略;此处为独立步骤的兼容写法)---
PUBRESP=$(curl -s -b "$JAR" -X POST "$GATEWAY/machines/$MACHINE_ID/pubkey" \
  -H 'content-type: application/json' \
  -d "{\"pubkey\":\"$(echo "$PUBKEY" | sed 's/"/\\"/g')\"}")
echo "$PUBRESP" | jq -e '.code==0' >/dev/null || {
  echo "公钥登记失败: $(echo "$PUBRESP" | jq -r '.msg // .')" >&2; exit 1; }

# --- 5.5 本地 adapter(凭证不出机:machine_token 换 kimi token 在本地完成)---
MACHINE_TOKEN=$(echo "$RESP" | jq -r '.data.machine_token')
mkdir -p "$HOME/.kimi-remote"
cat > "$HOME/.kimi-remote/adapter.env" <<EOF
MACHINE_TOKEN=$MACHINE_TOKEN
EOF
chmod 600 "$HOME/.kimi-remote/adapter.env"

curl -fsSL "$GATEWAY/agent/local-adapter.js" -o "$HOME/.kimi-remote/local-adapter.js"

cat > "$HOME/Library/LaunchAgents/com.kimi-remote.adapter.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kimi-remote.adapter</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>set -a; source "$HOME/.kimi-remote/adapter.env"; set +a; exec node "$HOME/.kimi-remote/local-adapter.js"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kimi-remote-adapter.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/kimi-remote-adapter.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.kimi-remote.adapter" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kimi-remote.adapter.plist"

# --- 6. 写 launchd 隧道 ---
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$HOME/.kimi-remote-tunnel.sh" <<EOF
#!/bin/bash
# kimi-remote 隧道(成员机 $MACHINE_ID)— 由 agent-install.sh 生成
set -u
while true; do
  if ! curl -sf --max-time 3 http://127.0.0.1:58627/api/v1/healthz >/dev/null 2>&1; then
    "\$HOME/.kimi-code/bin/kimi" server run --keep-alive >/dev/null 2>&1 || true
    sleep 5
  fi
  /usr/bin/ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=3 \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -i "$KEY" \
    -R "127.0.0.1:${REMOTE_PORT}:127.0.0.1:58628" \
    "$SSH_HOST"
  echo "[\$(date '+%F %T')] tunnel exited rc=\$?, retry after清理" >&2
  /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -i "$KEY" \
    "$SSH_HOST" "fuser -k ${REMOTE_PORT}/tcp >/dev/null 2>&1 || true" </dev/null >/dev/null 2>&1 || true
  sleep 3
done
EOF
chmod +x "$HOME/.kimi-remote-tunnel.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kimi-remote.tunnel</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME/.kimi-remote-tunnel.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kimi-remote-tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/kimi-remote-tunnel.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/com.kimi-remote.tunnel" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# --- 7. 上线验证 ---
echo "==> 等待隧道上线…"
ok=""
for _ in $(seq 1 10); do
  sleep 3
  H=$(curl -s --max-time 6 -b "$JAR" "$GATEWAY/m/$MACHINE_ID/api/v1/healthz" || true)
  if echo "$H" | jq -e '.data.ok==true' >/dev/null 2>&1; then ok=1; break; fi
done
if [ -n "$ok" ]; then
  echo "✅ 接入成功!打开 $GATEWAY 即可看到机器 $MACHINE_ID 的会话"
else
  echo "⚠ 隧道尚未就绪,查 ~/Library/Logs/kimi-remote-tunnel.log;网关侧显示离线属正常重试过程"
fi
