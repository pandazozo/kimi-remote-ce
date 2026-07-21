#!/bin/bash
# session-janitor — 会话生命周期自动归档(2026-07-21 owner 钦定机制)
# 规则(只归档不删除;归档可逆):
#   探针类(probe/dbg/test/verdict 等正则)  → 立即归档
#   空会话(New Session 且无 last_prompt)   → 立即归档
#   /usage 等一次性系统会话                → 立即归档
#   系统 spawn(裁决处理器等)完成 >1 天     → 归档(源头 submit-watcher 已改自归档)
#   兜底:任意会话 idle >14 天              → 归档
# 护栏:busy/main_turn_active 跳过;pending_interaction 跳过;创建 <1h 跳过;正则锚定。
# 模式:JANITOR_MODE=dry(默认,只预报不执行)| archive(真归档)。首周 dry 观察。
set -u
ADAPTER="${ADAPTER_URL:-http://127.0.0.1:58629}"
ADAPTER_ENV="${ADAPTER_ENV:-$HOME/.kimi-remote-adapter.env}"
MODE="${JANITOR_MODE:-dry}"
ALERT_USER_OPEN_ID="${ALERT_USER_OPEN_ID:-ou_c3efb4bab62fd9b84d41d90b024f8394}"
LARK_CLI="${LARK_CLI:-$(command -v lark-cli || command -v lark-cli)}"
IDLE_DAYS="${IDLE_DAYS:-14}"

TOKEN="${MACHINE_TOKEN:-$(grep -E '^MACHINE_TOKEN=' "$ADAPTER_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")}"
[ -n "${TOKEN:-}" ] || { echo "JANITOR-ERROR: 无 MACHINE_TOKEN"; exit 1; }

now=$(date +%s)
PROBE_RE='^(dbg[0-9]*|bytes|body[0-9]*|final-.*|wiretap|burst|doorlog|clienterr|verdict.*|srvside|clash-vs-direct|gw-.*|cleanroom.*|.*-probe|.*-probe-[0-9]+|smoke|R[0-9]{3}.*|state-probe|e2e-.*|ws-probe.*|model.*-probe|fullerr-probe|recipe-probe|revive.*|live-question-probe|quota-check.*|2img-probe|2big-probe|imgfile-probe|listbusy-probe|state-gw-probe|auq.*|red-probe)$'
SPAWN_PREFIX_RE='^(你是 ZAIOS 的 H5 裁决自动处理器|H5裁决·)'

hits=()
while IFS=$'\t' read -r sid title busy pend last_prompt created updated; do
  [ "$busy" = "true" ] && continue
  [ "$pend" != "none" ] && [ -n "$pend" ] && continue
  age=$(( (now - updated) / 86400 ))
  born=$(( (now - created) / 60 ))
  [ "$born" -lt 60 ] && continue   # 创建 <1h 不碰
  rule=""
  if [[ "$title" =~ $PROBE_RE ]]; then rule="探针"
  elif [ "$title" = "New Session" ] && [ -z "$last_prompt" ]; then rule="空会话"
  elif [ "$title" = "/usage" ]; then rule="一次性系统会话"
  elif [[ "$title" =~ $SPAWN_PREFIX_RE ]] && [ "$age" -ge 1 ]; then rule="系统spawn>${age}d"
  elif [ "$age" -ge "$IDLE_DAYS" ]; then rule="idle>${IDLE_DAYS}d"
  fi
  [ -n "$rule" ] && hits+=("$sid	$rule	$title")
done < <(curl -s --max-time 20 "$ADAPTER/api/v1/sessions?page_size=100&include_archive=false" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.items[] | select(.archived|not) |
    [ .id, (.title//""), (.busy|tostring), (.pending_interaction//"none"),
      (.last_prompt//""), ((.created_at|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601)//0),
      ((.updated_at|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601)//0) ] | @tsv')

n=${#hits[@]}
[ "$n" = "0" ] && { echo "JANITOR-OK 无命中"; exit 0; }

lines=""
for h in "${hits[@]}"; do
  sid="${h%%	*}"; rest="${h#*	}"; rule="${rest%%	*}"; title="${rest#*	}"
  lines="${lines}
· [${rule}] ${title:0:40}"
  if [ "$MODE" = "archive" ]; then
    curl -s --max-time 10 -X POST "$ADAPTER/api/v1/sessions/$sid:archive" \
      -H "Authorization: Bearer $TOKEN" -o /dev/null
  fi
done

if [ "$MODE" = "archive" ]; then
  msg="🧹 会话 janitor:已归档 ${n} 个(可逆,归档不是删除):$lines"
else
  msg="🧹 会话 janitor(dry-run 预报):${n} 个命中归档规则,暂未执行:$lines"
fi
echo "$msg" | head -30
# 每日最多一条飞书(state 节流)
STATE_FILE="${STATE_FILE:-$HOME/.kimi-session-janitor.state}"
last=0; [ -f "$STATE_FILE" ] && source "$STATE_FILE"
if [ $((now - last)) -ge 86400 ]; then
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 "$LARK_CLI" im +messages-send --as bot \
    --user-id "$ALERT_USER_OPEN_ID" --text "$msg" \
    --idempotency-key "$(uuidgen | tr '[:upper:]' '[:lower:]')" >/dev/null 2>&1
  printf 'last=%s\n' "$now" > "$STATE_FILE"
fi
