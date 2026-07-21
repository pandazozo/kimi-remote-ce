#!/bin/bash
# R004-steer-queue-semantics
# 现象: 排队指令点 ⚡ 插队报错失败(owner 在项目总控会话真机报障:"测试是不是不够充分")
# 根因: H5 把 active prompt 的 id 传给 steer → 40402 "one or more prompts are not pending";
#       实测契约:steer 的目标是【排队项自身】prompt_id(传排队项 id → steered:true)
# 出处: 2026-07-20 v0.4.6
set -uo pipefail
TOKEN="${TOKEN:?need TOKEN}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:58627}"
SID="${SID:?need SID(一个 busy 会话 id)}"

# ① 排队一条探针
PID=$(curl -s -X POST "$UPSTREAM/api/v1/sessions/$SID/prompts" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":[{"type":"text","text":"R004 探针(可忽略)"}]}' | jq -r '.data.prompt_id')
[ -n "$PID" ] && [ "$PID" != "null" ] || { echo "FAIL: 无法创建排队探针"; exit 1; }
sleep 1

# ② 用 active id 必须报 40402(回归锚点:错误语义不得复活)
AID=$(curl -s "$UPSTREAM/api/v1/sessions/$SID/prompts" -H "Authorization: Bearer $TOKEN" | jq -r '.data.active.prompt_id // empty')
if [ -n "$AID" ]; then
  C=$(curl -s -X POST "$UPSTREAM/api/v1/sessions/$SID/prompts:steer" \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"prompt_ids\":[\"$AID\"],\"content\":[{\"type\":\"text\",\"text\":\"R004\"}]}" | jq -r '.code')
  [ "$C" = "40402" ] || { echo "FAIL: 传 active id 未报 40402(语义漂移,需复核 H5 实现)"; exit 1; }
fi

# ③ 用排队项自身 id 必须成功
R=$(curl -s -X POST "$UPSTREAM/api/v1/sessions/$SID/prompts:steer" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"prompt_ids\":[\"$PID\"],\"content\":[{\"type\":\"text\",\"text\":\"R004 探针(可忽略)\"}]}")
echo "$R" | jq -e '.code==0 and .data.steered==true' >/dev/null \
  || { echo "FAIL: steer 排队项失败: ${R:0:120}"; exit 1; }
echo "R004 OK"
