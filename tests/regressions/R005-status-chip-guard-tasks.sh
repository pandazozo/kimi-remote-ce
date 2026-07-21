#!/bin/bash
# R005-status-chip-guard-tasks
# 现象: 会话主轮空闲但后台任务(bash/subagent/cron)仍在跑时,聊天页状态 chip 长期显示「空闲」,
#       底部却持续有工具输出 —— owner 真机报障(2026-07-20「运行状态不准确,为什么测试没发现」)
# 根因: ①renderStatusChip 只有 busy/pend/idle 三态,无「守护」态;②守护任务数据(loadActivity)
#       仅在进入会话时拉一次、不轮询,后台任务后来起跑 chip 永不更新
# 修复: chip 增加「守护 N」态(优先级 待处理>运行中>守护>空闲);/tasks 并入 4s 状态轮询
#       (refreshGuardTasks);切回页面立即 pollStatusOnce
# 出处: 2026-07-20 v0.4.11
set -uo pipefail
BASE="${BASE:-https://kimi.pengpengco.com}"
PASSWORD="${PASSWORD:?need PASSWORD}"
SID="${SID:?need SID(任一真实会话 id)}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

curl -sf -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" -o /dev/null || { echo "FAIL: login"; exit 1; }

# ① /tasks 契约:必须返回 items 数组(chip 守护态的数据源)
R=$(curl -s -b "$JAR" "$BASE/api/v1/sessions/$SID/tasks")
echo "$R" | jq -e '.code==0 and (.data.items != null)' >/dev/null \
  || { echo "FAIL: /tasks 未返回 items: ${R:0:120}"; exit 1; }

# ② 前端修复在场(prod 现行 app.js):chip 守护态 + 守护任务并入状态轮询
APP=$(curl -s "$BASE/app.js")
echo "$APP" | grep -q 'st-guard' || { echo "FAIL: prod app.js 缺 st-guard 守护态"; exit 1; }
echo "$APP" | grep -q 'refreshGuardTasks(sid)' || { echo "FAIL: prod app.js 守护任务未并入状态轮询"; exit 1; }
echo "$APP" | grep -q 'visibilitychange.*pollStatusOnce\|refreshInteractions(); pollStatusOnce' \
  || echo "WARN: visibilitychange 未挂 pollStatusOnce(切回页面 chip 刷新仍靠 4s 轮询兜底)"

echo "R005 OK"
