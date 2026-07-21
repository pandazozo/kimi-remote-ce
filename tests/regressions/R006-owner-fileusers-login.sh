#!/bin/bash
# R006-owner-fileusers-login
# 现象: 创建首个邀请用户后,owner 原密码登录 401(生产事故)
# 根因: 旧逻辑「有文件用户则禁用单 owner 密码」,语义过严
# 出处: 2026-07-20 v0.4.0(此处为端到端复核;单测见 gateway/test/users.test.js)
set -uo pipefail
BASE="${BASE:-https://kimi.pengpengco.com}"
PASSWORD="${PASSWORD:?need PASSWORD}"

# owner 单密码(无用户名)必须能登录
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/login" \
  -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}")
[ "$C" = "204" ] || { echo "FAIL: owner 登录 $C(回归:文件用户挤掉 owner)"; exit 1; }
echo "R006 OK"
