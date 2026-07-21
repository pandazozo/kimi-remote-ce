#!/bin/bash
# parity-check — H5 显示数据 vs 上游真值 对账(owner 2026-07-20 要求的机制)
# 逐会话核对:① busy 状态(列表 vs snapshot.in_flight_turn)② 最新消息(网关可见 vs 上游直连)
# 用法: BASE=https://kimi.pengpengco.com PASSWORD=xxx TOKEN=<kimi-token> ./tests/parity-check.sh
# 本机直连上游模式(推荐,绕过网关): TOKEN=xxx ./tests/parity-check.sh
set -uo pipefail

UPSTREAM="${UPSTREAM:-http://127.0.0.1:58627}"
TOKEN="${TOKEN:?need kimi token}"
BASE="${BASE:-}"; PASSWORD="${PASSWORD:-}"
JAR=""; [ -n "$BASE" ] && JAR="$(mktemp)" && trap 'rm -f "$JAR"' EXIT

MIS=0; TOTAL=0
note() { echo "$1"; }
mis() { echo "MISMATCH: $1"; MIS=$((MIS+1)); }

# 经网关的认证(如果给了 BASE)
if [ -n "$BASE" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}")
  [ "$code" = "204" ] || { echo "网关登录失败 HTTP $code"; exit 1; }
fi

up() { curl -s --max-time 15 -H "Authorization: Bearer $TOKEN" "$UPSTREAM$1"; }
gw() { [ -n "$BASE" ] && curl -s --max-time 30 -b "$JAR" "$BASE$1" || up "$1"; }

echo "== parity check @ $(date '+%F %T') upstream=$UPSTREAM ${BASE:+via $BASE} =="

IDS=$(up "/api/v1/sessions?page_size=25" | jq -r '.data.items[].id')
for SID in $IDS; do
  TOTAL=$((TOTAL+1))
  TITLE=$(up "/api/v1/sessions?page_size=25" | jq -r ".data.items[] | select(.id==\"$SID\") | .title[:24]")

  # ① 状态对账:列表 busy vs snapshot in_flight_turn
  LB=$(up "/api/v1/sessions?page_size=25" | jq -r ".data.items[] | select(.id==\"$SID\") | .busy")
  IF=$(up "/api/v1/sessions/$SID/snapshot" | jq -r 'if .data.in_flight_turn then "true" else "false" end')
  if [ "$LB" != "$IF" ]; then
    mis "[$TITLE] busy: 列表=$LB vs in_flight=$IF"
  fi

  # ② 最新消息对账:上游直连 vs 网关可见(消息 id + created_at)
  U_LAST=$(up "/api/v1/sessions/$SID/messages?page_size=1" | jq -r '.data.items[0] | "\(.id)@\(.created_at)"' 2>/dev/null)
  G_LAST=$(gw "/api/v1/sessions/$SID/messages?page_size=1" | jq -r '.data.items[0] | "\(.id)@\(.created_at)"' 2>/dev/null)
  if [ "$U_LAST" != "$G_LAST" ]; then
    mis "[$TITLE] 最新消息: 上游=$U_LAST vs 网关可见=$G_LAST"
  fi

  echo "ok? [$TITLE] busy=$LB/$IF last=${U_LAST:0:44}"
done

echo "== 结果: $TOTAL 个会话, $MIS 处不一致 =="
[ "$MIS" = 0 ]
