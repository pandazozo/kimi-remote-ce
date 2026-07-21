#!/bin/bash
# R001-questions-status-pending
# 现象: AskUserQuestion/审批卡片在 H5 永不渲染,用户无法作答(智能蜂群会话真机报障)
# 根因: /questions 与 /approvals 端点裸调返回 40001(expected "pending"),必须带 ?status=pending
# 出处: 2026-07-20 v0.4.2
set -uo pipefail
BASE="${BASE:-https://kimi.pengpengco.com}"
PASSWORD="${PASSWORD:?need PASSWORD}"
SID="${SID:?need SID(任一真实会话 id)}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

curl -sf -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" -o /dev/null || { echo "FAIL: login"; exit 1; }

for EP in questions approvals; do
  # 带 status=pending 必须返回 items 结构(code=0)
  R=$(curl -s -b "$JAR" "$BASE/api/v1/sessions/$SID/$EP?status=pending")
  echo "$R" | jq -e '.code==0 and (.data.items != null)' >/dev/null \
    || { echo "FAIL: $EP?status=pending 未返回 items: ${R:0:120}"; exit 1; }
  # 裸调必须仍返回 40001(契约行为,防止上游悄悄改成裸调可用导致我们漏参数)
  R2=$(curl -s -b "$JAR" "$BASE/api/v1/sessions/$SID/$EP")
  echo "$R2" | jq -e '.code==40001' >/dev/null \
    || echo "WARN: $EP 裸调不再返回 40001(契约已变,可移除该参数)"
done
echo "R001 OK"
