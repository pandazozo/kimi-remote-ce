#!/bin/bash
# R013-fresh-session-first-prompt-executes
# 现象: 新建会话发指令永远不执行(「诊断」会话,2026-07-21 owner 实测;0720 事故同款)
# 根因: ①v2 引擎惰性执行:无 WS 订阅的会话 prompt 被静默吞 ②订阅 fire-and-forget 无重试
#       ③网关 REST 直连 58627 绕开 adapter 修复层
# 修复: adapter prompt 前 force 订阅 + 网关 REST 全量走 adapter(commit 5283156)
# 断言: 建会话后立即(≤2s)发 prompt,120s 内必须出现 assistant 消息——守「诊断」场景
# 环境: BASE/PASSWORD
set -uo pipefail
BASE="${BASE:-https://kimi.pengpengco.com}"
PASSWORD="${PASSWORD:?need PASSWORD}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

curl -sf --max-time 10 -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" -o /dev/null || { echo "FAIL login"; exit 1; }

SID="$(curl -sf --max-time 15 -b "$JAR" -X POST "$BASE/api/v1/sessions" \
  -H 'content-type: application/json' -d '{"metadata":{"cwd":"/tmp"},"title":"R013"}' | jq -r '.data.id // empty')"
[ -n "$SID" ] || { echo "FAIL create"; exit 1; }
trap 'curl -s -b "$JAR" -X POST "$BASE/api/v1/sessions/'"$SID"':archive" -o /dev/null 2>/dev/null; rm -f "$JAR"' EXIT

sleep 2  # 「立即」语义:建完就发
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -b "$JAR" \
  -X POST "$BASE/api/v1/sessions/$SID/prompts" -H 'content-type: application/json' \
  -d '{"content":[{"type":"text","text":"只回复:在"}]}')"
[ "$CODE" = "200" ] || { echo "FAIL prompt HTTP $CODE"; exit 1; }

HIT=""
for _ in $(seq 1 20); do
  sleep 6
  if curl -sf --max-time 10 -b "$JAR" "$BASE/api/v1/sessions/$SID/messages?page_size=5" \
      | jq -e '[.data.items[]?|select(.role=="assistant")]|length>0' >/dev/null 2>&1; then
    HIT=1; break
  fi
done
[ -n "$HIT" ] || { echo "FAIL 120s 内无 assistant 回复(惰性执行复发)"; exit 1; }
echo "PASS R013 新会话立即 prompt 120s 内执行"
