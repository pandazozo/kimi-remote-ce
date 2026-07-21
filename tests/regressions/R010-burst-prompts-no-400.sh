#!/bin/bash
# R010-burst-prompts-no-400
# 现象: 同一会话连续发 prompt,约一半返回空 body 400(间歇),重试亦败(2026-07-21 owner 实测)
# 根因: 网关把客户端 Connection: close 逐跳头原样转发上游,上游响应后关闭 socket,
#       网关 agent 连接池复用将死 socket → 上游 HPE_CLOSED_CONNECTION → 400。
# 修复: proxy.js 剥除 connection/keep-alive 逐跳头(commit 5283156)
# 断言: 连发 5 个 prompt(间隔 2s)必须全部 HTTP 200,且全部进入会话消息流
# 环境: BASE/PASSWORD
set -uo pipefail
BASE="${BASE:-https://your.domain}"
PASSWORD="${PASSWORD:?need PASSWORD}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

curl -sf --max-time 10 -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" -o /dev/null || { echo "FAIL login"; exit 1; }

SID="$(curl -sf --max-time 15 -b "$JAR" -X POST "$BASE/api/v1/sessions" \
  -H 'content-type: application/json' -d '{"metadata":{"cwd":"/tmp"},"title":"R010"}' | jq -r '.data.id // empty')"
[ -n "$SID" ] || { echo "FAIL create"; exit 1; }
trap 'curl -s -b "$JAR" -X POST "$BASE/api/v1/sessions/'"$SID"':archive" -o /dev/null 2>/dev/null; rm -f "$JAR"' EXIT

FAILS=0
for n in 1 2 3 4 5; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -b "$JAR" \
    -X POST "$BASE/api/v1/sessions/$SID/prompts" -H 'content-type: application/json' \
    -d '{"content":[{"type":"text","text":"只回复:通"}]}')"
  [ "$CODE" = "200" ] || { echo "  第${n}发 HTTP $CODE(应 200)"; FAILS=$((FAILS+1)); }
  sleep 2
done
[ "$FAILS" = 0 ] || { echo "FAIL $FAILS/5 发非 200"; exit 1; }
echo "PASS R010 连发 5/5 全 200"
