#!/bin/bash
# R011-large-attachments-file-ref
# 现象: 手机连发两张截图「发送失败」,重试必败(2026-07-21 owner 实测)
# 根因: H5 将图片 base64 内联进 prompt body;两张 iPhone 截图编码后 ~1.2MB,
#       撞 kimi server prompts 的 fastify bodyLimit 1MB → 50001 Request body is too large。
# 修复: 附件一律走 /api/v1/files 上传(8MB+ 实测),prompt 只带 file_id 引用;
#       <300KB 小图保留 base64 内联(commit a3be6b0)
# 断言: ①两张 ~450KB 图分别上传 /api/v1/files 得 file_id ②双 file_id 图片的 prompt 被接受(200)
# 环境: BASE/PASSWORD
set -uo pipefail
BASE="${BASE:-https://kimi.pengpengco.com}"
PASSWORD="${PASSWORD:?need PASSWORD}"
JAR="$(mktemp)"; trap 'rm -f "$JAR" /tmp/r011-a.bin /tmp/r011-b.bin' EXIT

curl -sf --max-time 10 -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" -o /dev/null || { echo "FAIL login"; exit 1; }

dd if=/dev/urandom of=/tmp/r011-a.bin bs=1000 count=450 2>/dev/null
dd if=/dev/urandom of=/tmp/r011-b.bin bs=1000 count=450 2>/dev/null
FID1="$(curl -sf --max-time 60 -b "$JAR" -F "file=@/tmp/r011-a.bin" -F "name=a.jpg" "$BASE/api/v1/files" | jq -r '.data.file_id // .data.id // empty')"
FID2="$(curl -sf --max-time 60 -b "$JAR" -F "file=@/tmp/r011-b.bin" -F "name=b.jpg" "$BASE/api/v1/files" | jq -r '.data.file_id // .data.id // empty')"
[ -n "$FID1" ] && [ -n "$FID2" ] || { echo "FAIL upload($FID1/$FID2)"; exit 1; }

SID="$(curl -sf --max-time 15 -b "$JAR" -X POST "$BASE/api/v1/sessions" \
  -H 'content-type: application/json' -d '{"metadata":{"cwd":"/tmp"},"title":"R011"}' | jq -r '.data.id // empty')"
[ -n "$SID" ] || { echo "FAIL create"; exit 1; }
trap 'curl -s -b "$JAR" -X POST "$BASE/api/v1/sessions/'"$SID"':archive" -o /dev/null 2>/dev/null; rm -f "$JAR" /tmp/r011-a.bin /tmp/r011-b.bin' EXIT

CODE="$(jq -n --arg f1 "$FID1" --arg f2 "$FID2" '{content:[{type:"text",text:"两张图"},{type:"image",source:{kind:"file",file_id:$f1}},{type:"image",source:{kind:"file",file_id:$f2}}]}' \
  | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -b "$JAR" \
      -X POST "$BASE/api/v1/sessions/$SID/prompts" -H 'content-type: application/json' --data-binary @-)"
[ "$CODE" = "200" ] || { echo "FAIL 双图 file_id prompt HTTP $CODE(应 200)"; exit 1; }
echo "PASS R011 双 ~450KB 图上传+双 file_id prompt 200"
