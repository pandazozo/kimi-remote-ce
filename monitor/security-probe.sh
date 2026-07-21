#!/bin/bash
# kimi-remote 安全探针:登录爆破 / 白名单拦截 / 限流尖峰 → 飞书告警
# 原理:ssh 拉取服务器 nginx access.log 自上次偏移量以来的新增行,统计状态码。
# 不依赖网关代码改动,任何版本网关都生效。每 5 分钟由 launchd 触发。
# 手动测试: SEC_TEST=1 ./security-probe.sh (用内置假日志,应触发 1 条告警)
set -u

REMOTE="${REMOTE:-opc-prod}"
LOG_PATH="${LOG_PATH:-/var/log/nginx/access.log}"
STATE_FILE="${STATE_FILE:-$HOME/.kimi-remote-secprobe.state}"
ALERT_USER_OPEN_ID="${ALERT_USER_OPEN_ID:-ou_c3efb4bab62fd9b84d41d90b024f8394}"
LARK_CLI="${LARK_CLI:-$(command -v lark-cli || command -v lark-cli)}"
# 阈值(5 分钟窗口):同 IP 登录 401 ≥10 次;全站 403 ≥20 次;429 ≥5 次
TH_LOGIN_401=10; TH_403=20; TH_429=5
ALERT_COOLDOWN_SEC=3600

offset=0; last_alert=0
[ -f "$STATE_FILE" ] && source "$STATE_FILE"
now=$(date +%s)
save() { printf 'offset=%s\nlast_alert=%s\n' "$offset" "$last_alert" > "$STATE_FILE"; }

send() {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 "$LARK_CLI" im +messages-send --as bot \
    --user-id "$ALERT_USER_OPEN_ID" --text "$1" \
    --idempotency-key "$(uuidgen | tr '[:upper:]' '[:lower:]')" >/dev/null 2>&1
}

if [ "${SEC_TEST:-}" = "1" ]; then
  # 内置假日志:同 IP 12 次登录 401 + 25 次 403 + 6 次 429
  chunk="$(for i in $(seq 1 12); do echo "1.2.3.4 - - [20/Jul/2026:10:00:00 +0800] \"POST /login HTTP/1.1\" 401 30"; done; for i in $(seq 1 25); do echo "5.6.7.8 - - [20/Jul/2026:10:01:00 +0800] \"GET /api/v1/shutdown HTTP/1.1\" 403 40"; done; for i in $(seq 1 6); do echo "9.9.9.9 - - [20/Jul/2026:10:02:00 +0800] \"POST /login HTTP/1.1\" 429 20"; done)"
  new_size=${#chunk}
else
  # 当前文件大小;日志轮转(变小)则从头读
  cur_size="$(ssh -o ConnectTimeout=8 -o BatchMode=yes "$REMOTE" "stat -c %s $LOG_PATH" 2>/dev/null || echo 0)"
  [ -z "$cur_size" ] && cur_size=0
  # 首次运行:不分析历史日志,只记录当前位置(避免把 OPC 生产几个月的日志全量误报)
  if [ ! -f "$STATE_FILE" ]; then offset=$cur_size; save; exit 0; fi
  if [ "$cur_size" -lt "$offset" ]; then offset=0; fi
  if [ "$cur_size" -eq "$offset" ]; then save; exit 0; fi
  chunk="$(ssh -o ConnectTimeout=8 -o BatchMode=yes "$REMOTE" "tail -c +$((offset+1)) $LOG_PATH" 2>/dev/null)"
  new_size=$((cur_size - offset))
  offset=$cur_size
fi

[ -z "$chunk" ] && { save; exit 0; }

login401_ip="$(printf '%s\n' "$chunk" | awk '$9==401 && $7=="/login" {print $1}' | sort | uniq -c | sort -rn | head -1)"
n401=$(echo "$login401_ip" | awk '{print $1+0}')
ip401=$(echo "$login401_ip" | awk '{print $2}')
n403=$(printf '%s\n' "$chunk" | awk '$9==403' | wc -l | tr -d ' ')
n429=$(printf '%s\n' "$chunk" | awk '$9==429' | wc -l | tr -d ' ')

alerts=""
[ "$n401" -ge "$TH_LOGIN_401" ] && alerts="${alerts}登录爆破:${ip401} 5分钟内 ${n401} 次密码错误(401)。"
[ "$n403" -ge "$TH_403" ] && alerts="${alerts}白名单拦截尖峰:${n403} 次 403(有人试探被禁路径)。"
[ "$n429" -ge "$TH_429" ] && alerts="${alerts}限流触发:${n429} 次 429。"

if [ -n "$alerts" ] && [ $((now - last_alert)) -ge "$ALERT_COOLDOWN_SEC" ]; then
  send "🛡️ Kimi Remote 安全告警:${alerts}详见服务器 nginx access.log。$(date '+%m-%d %H:%M')"
  last_alert=$now
fi
save
