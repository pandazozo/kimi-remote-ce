#!/bin/bash
# kimi-remote 端到端冒烟测试
# 用法: BASE=https://kimi.pengpengco.com PASSWORD='<登录密码>' ./tests/smoke.sh
# 本地开发: BASE=http://127.0.0.1:8080 PASSWORD='kimi-remote-dev' ./tests/smoke.sh
set -uo pipefail

BASE="${BASE:?need BASE}"
PASSWORD="${PASSWORD:?need PASSWORD}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
MARK="SMOKE_OK_$RANDOM"
PASS=0; FAIL=0

ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== kimi-remote smoke @ $BASE =="

# 1. healthz
curl -sf --max-time 10 "$BASE/healthz" | grep -q '"ok":true' \
  && ok "healthz" || bad "healthz"

# 2. 错误密码 → 401
[ "$(code --max-time 10 -X POST "$BASE/login" -H 'content-type: application/json' -d '{"password":"wrong-password"}')" = "401" ] \
  && ok "bad password -> 401" || bad "bad password should be 401"

# 3. 正确登录
[ "$(code --max-time 10 -c "$JAR" -X POST "$BASE/login" -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}")" = "204" ] \
  && ok "login -> 204" || bad "login"

# 4. meta(带 cookie)
curl -sf --max-time 10 -b "$JAR" "$BASE/api/v1/meta" | grep -q '"websocket":true' \
  && ok "meta + capabilities" || bad "meta"

# 5. 白名单:shutdown/gui 必须 403
[ "$(code --max-time 10 -b "$JAR" -X POST "$BASE/api/v1/shutdown")" = "403" ] \
  && ok "shutdown blocked" || bad "shutdown not blocked"
[ "$(code --max-time 10 -b "$JAR" "$BASE/api/v1/gui/store/getItem")" = "403" ] \
  && ok "gui blocked" || bad "gui not blocked"

# 6. 建会话
SID="$(curl -sf --max-time 15 -b "$JAR" -X POST "$BASE/api/v1/sessions" \
  -H 'content-type: application/json' \
  -d '{"metadata":{"cwd":"/tmp"},"title":"smoke"}' | jq -r '.data.id // empty')"
[ -n "$SID" ] && ok "create session ($SID)" || bad "create session"

# 7. 发 prompt(permission auto,避免审批卡住)
if [ -n "$SID" ]; then
  curl -sf --max-time 15 -b "$JAR" -X POST "$BASE/api/v1/sessions/$SID/prompts" \
    -H 'content-type: application/json' \
    -d "{\"content\":[{\"type\":\"text\",\"text\":\"Reply with exactly: $MARK\"}],\"permission_mode\":\"auto\"}" >/dev/null \
    && ok "send prompt" || bad "send prompt"

  # 8. 轮询助手回复(最多 120s)
  HIT=""
  for _ in $(seq 1 24); do
    sleep 5
    if curl -sf --max-time 10 -b "$JAR" "$BASE/api/v1/sessions/$SID/messages?page_size=20" | grep -q "$MARK"; then
      HIT=1; break
    fi
  done
  [ -n "$HIT" ] && ok "assistant replied with marker" || bad "assistant reply timeout"

  # 8b. 多轮:同会话再发第二条,必须再收到第二条回复(2026-07-20 事故:首条静默吞)
  MARK2="SMOKE2_OK_$RANDOM"
  HIT2=""
  if [ -n "$HIT" ]; then
    curl -sf --max-time 15 -b "$JAR" -X POST "$BASE/api/v1/sessions/$SID/prompts" \
      -H 'content-type: application/json' \
      -d "{\"content\":[{\"type\":\"text\",\"text\":\"Reply with exactly: $MARK2\"}],\"permission_mode\":\"auto\"}" >/dev/null
    for _ in $(seq 1 24); do
      sleep 5
      if curl -sf --max-time 10 -b "$JAR" "$BASE/api/v1/sessions/$SID/messages?page_size=20" | grep -q "$MARK2"; then
        HIT2=1; break
      fi
    done
    [ -n "$HIT2" ] && ok "multi-turn: 2nd reply" || bad "multi-turn: 2nd reply timeout"
  fi

  # 9. 上传 8MB 文件 → file_id
  TMPF="$(mktemp)"; dd if=/dev/urandom of="$TMPF" bs=1m count=8 2>/dev/null
  FID="$(curl -sf --max-time 60 -b "$JAR" -F "file=@$TMPF" -F "name=smoke.bin" "$BASE/api/v1/files" | jq -r '.data.file_id // .data.id // empty')"
  rm -f "$TMPF"
  [ -n "$FID" ] && ok "upload 8MB -> file_id" || bad "upload"

  # 10. 归档会话
  [ "$(code --max-time 10 -b "$JAR" -X POST "$BASE/api/v1/sessions/$SID:archive")" = "200" ] \
    && ok "archive session" || bad "archive session"
fi

echo "== 结果: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" = 0 ]
