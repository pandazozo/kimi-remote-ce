#!/bin/bash
# kimi-remote 执行器看门狗(端到端 turn 执行探针)
# 背景:2026-07-20 事故——kimi-code 0.24+ v2 引擎下,API 会话 turn 执行是惰性的
# (需 adapter 常驻 WS 订阅激活),且 model 缺省时失败完全静默(消息面无错误、
# 状态假空闲)。健康探针只能发现"服务挂了",发现不了"服务活着但 prompt 被静默吞掉"。
# 本探针定期走生产路径(adapter)真实创建会话→发 prompt→等 assistant 回复,
# 超时或失败即告警,恢复自动报喜。告警走 lark-cli bot 私信 owner。
# 手动测试: ./executor-watchdog.sh (正常时 60~120s 内输出 OK)
set -u

ADAPTER_URL="${ADAPTER_URL:-http://127.0.0.1:58629}"
ADAPTER_ENV="${ADAPTER_ENV:-$HOME/.kimi-remote-adapter.env}"
STATE_FILE="${STATE_FILE:-$HOME/.kimi-remote-executor-watchdog.state}"
ALERT_USER_OPEN_ID="${ALERT_USER_OPEN_ID:-ou_c3efb4bab62fd9b84d41d90b024f8394}"
LARK_CLI="${LARK_CLI:-$(command -v lark-cli || command -v lark-cli)}"
TIMEOUT_SEC="${TIMEOUT_SEC:-120}"
POLL_EVERY=6
ALERT_COOLDOWN_SEC=1800

if [ -z "${MACHINE_TOKEN:-}" ]; then
  MACHINE_TOKEN="$(grep -E '^MACHINE_TOKEN=' "$ADAPTER_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")"
fi
if [ -z "$MACHINE_TOKEN" ]; then echo "WATCHDOG-ERROR: MACHINE_TOKEN 取不到($ADAPTER_ENV)"; exit 1; fi

fails=0; last_alert=0; alerting=0
[ -f "$STATE_FILE" ] && source "$STATE_FILE"
now=$(date +%s)
save() { printf 'fails=%s\nlast_alert=%s\nalerting=%s\n' "$fails" "$last_alert" "$alerting" > "$STATE_FILE"; }
send() {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 "$LARK_CLI" im +messages-send --as bot \
    --user-id "$ALERT_USER_OPEN_ID" --text "$1" \
    --idempotency-key "$(uuidgen | tr '[:upper:]' '[:lower:]')" >/dev/null 2>&1
}
api() { # $1=method $2=path $3=body(可空)
  # 注意:无 body 时绝不能带 content-type: application/json(kimi fastify 会以 50001 拒绝空 JSON body)
  # macOS 自带 bash 3.2 + set -u:空数组展开会 unbound,不用数组,分两路写死
  if [ -n "${3:-}" ]; then
    curl -s --max-time 15 -X "$1" "$ADAPTER_URL$2" \
      -H "Authorization: Bearer $MACHINE_TOKEN" -H 'content-type: application/json' -d "$3"
  else
    curl -s --max-time 15 -X "$1" "$ADAPTER_URL$2" \
      -H "Authorization: Bearer $MACHINE_TOKEN"
  fi
}

SID=""
cleanup() { [ -n "$SID" ] && api POST "/h/kimi/api/v1/sessions/$SID:archive" >/dev/null 2>&1; }
trap cleanup EXIT

ok=0; detail=""
SID="$(api POST /h/kimi/api/v1/sessions '{"metadata":{"cwd":"/tmp"},"title":"executor-watchdog"}' | jq -r '.data.id // empty' 2>/dev/null)"
if [ -z "$SID" ]; then
  detail="adapter 创建会话失败(adapter 宕机或 token 失效)"
else
  api POST "/h/kimi/api/v1/sessions/$SID/prompts" '{"content":[{"type":"text","text":"只回复两个字:活着"}]}' >/dev/null
  waited=0
  while [ "$waited" -lt "$TIMEOUT_SEC" ]; do
    sleep "$POLL_EVERY"; waited=$((waited+POLL_EVERY))
    if api GET "/h/kimi/api/v1/sessions/$SID/messages?page_size=5" | jq -e '[.data.items[]?|select(.role=="assistant")]|length>0' >/dev/null 2>&1; then
      ok=1; break
    fi
  done
  [ "$ok" = "0" ] && detail="prompt 已接受但 ${TIMEOUT_SEC}s 内无 assistant 回复(疑似 v2 惰性执行未被激活 / adapter WS 订阅器掉线 / model 解析失败)"
fi

if [ "$ok" = "1" ]; then
  if [ "$alerting" = "1" ]; then
    send "✅ Kimi Remote 执行器已恢复:探针会话 ${TIMEOUT_SEC}s 内正常收到回复。$(date '+%H:%M')"
  fi
  fails=0; alerting=0; echo "WATCHDOG-OK (${waited:-0}s)"
else
  fails=$((fails+1))
  if [ $((now - last_alert)) -ge "$ALERT_COOLDOWN_SEC" ]; then
    send "🚨 Kimi Remote 执行器异常:${detail}。用户发消息会显示已发送但永远无回复(静默故障,2026-07-20 事故同款)。连续 ${fails} 次。排障:查 launchd com.pengpeng.kimi-remote-adapter 与 kimi web(58627)。$(date '+%m-%d %H:%M')"
    last_alert=$now; alerting=1
  fi
  echo "WATCHDOG-FAIL: $detail"
fi
save
