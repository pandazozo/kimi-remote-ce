#!/bin/bash
# R003-pin-preserves-title
# 现象: 会话置顶后标题变成 "undefined"
# 根因: overlay 路由把 title:undefined 传入补丁层,String(undefined) 物化落库
# 出处: 2026-07-20 v0.4.3
set -uo pipefail
BASE="${BASE:-https://kimi.pengpengco.com}"
PASSWORD="${PASSWORD:?need PASSWORD}"
SID="${SID:?need SID(任一真实会话 id)}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

curl -sf -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" -o /dev/null || { echo "FAIL: login"; exit 1; }

# 先设一个标题
curl -s -b "$JAR" -X PUT "$BASE/overlay/sessions/$SID" -H 'content-type: application/json' \
  -d '{"title":"R003-标题"}' | jq -e '.code==0' >/dev/null || { echo "FAIL: set title"; exit 1; }
# 置顶
curl -s -b "$JAR" -X PUT "$BASE/overlay/sessions/$SID" -H 'content-type: application/json' \
  -d '{"pinned":true}' | jq -e '.code==0 and .data.title=="R003-标题" and .data.pinned==true' >/dev/null \
  || { echo "FAIL: 置顶后标题丢失或被改"; exit 1; }
# 取消置顶
curl -s -b "$JAR" -X PUT "$BASE/overlay/sessions/$SID" -H 'content-type: application/json' \
  -d '{"pinned":false}' | jq -e '.code==0 and .data.title=="R003-标题" and (.data.pinned==null)' >/dev/null \
  || { echo "FAIL: 取消置顶后标题丢失"; exit 1; }
# 清理
curl -s -b "$JAR" -X PUT "$BASE/overlay/sessions/$SID" -H 'content-type: application/json' \
  -d '{"title":null}' >/dev/null
echo "R003 OK"
