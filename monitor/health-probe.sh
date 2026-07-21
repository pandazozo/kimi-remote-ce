#!/bin/bash
# kimi-remote 生产健康探针
# 每 2 分钟由 launchd 触发一次:连续 3 次失败才告警(防 Clash 重启秒级抖动误报),
# 恢复自动报喜。告警走 lark-cli bot 私信 owner。
# 手动测试: PROBE_URL=http://127.0.0.1:59999 ./health-probe.sh (连跑 3 次应触发一次告警)
set -u

PROBE_URL="${PROBE_URL:-https://kimi.pengpengco.com/healthz}"
STATE_FILE="${STATE_FILE:-$HOME/.kimi-remote-health.state}"
ALERT_USER_OPEN_ID="${ALERT_USER_OPEN_ID:-}"
LARK_CLI="${LARK_CLI:-$(command -v lark-cli || command -v lark-cli)}"
FAIL_THRESHOLD=3
ALERT_COOLDOWN_SEC=1800   # 同类告警 30 分钟内不重复

# state: fails|last_alert_epoch|alerting(0/1)
fails=0; last_alert=0; alerting=0
[ -f "$STATE_FILE" ] && source "$STATE_FILE"
now=$(date +%s)

save() { printf 'fails=%s\nlast_alert=%s\nalerting=%s\n' "$fails" "$last_alert" "$alerting" > "$STATE_FILE"; }

send() { # $1=消息文本
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 "$LARK_CLI" im +messages-send --as bot \
    --user-id "$ALERT_USER_OPEN_ID" --text "$1" \
    --idempotency-key "$(uuidgen | tr '[:upper:]' '[:lower:]')" >/dev/null 2>&1
}

body="$(curl -s --max-time 10 "$PROBE_URL" 2>/dev/null)"
if echo "$body" | grep -q '"ok":true' && echo "$body" | grep -q '"upstream":true'; then
  if [ "$alerting" = "1" ]; then
    send "✅ Kimi Remote 已恢复:健康检查通过(上游 Mac 在线)。$(date '+%H:%M')"
  fi
  fails=0; alerting=0
else
  fails=$((fails+1))
  if [ "$fails" -ge "$FAIL_THRESHOLD" ] && [ $((now - last_alert)) -ge "$ALERT_COOLDOWN_SEC" ]; then
    reason="网关不可达"
    echo "$body" | grep -q '"upstream":false' && reason="Mac 离线/隧道断(网关正常,上游不可达)"
    [ -z "$body" ] && reason="完全无响应(域名/网关/网络)"
    send "🚨 Kimi Remote 异常:${reason}。已连续 ${fails} 次检查失败。地址 ${PROBE_URL}。排障见 docs/DEPLOY.md(先查 Clash 是否 rule 模式)。$(date '+%m-%d %H:%M')"
    last_alert=$now; alerting=1
  fi
fi
save
