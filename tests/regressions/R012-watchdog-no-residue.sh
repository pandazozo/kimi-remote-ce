#!/bin/bash
# R012-watchdog-no-residue
# 现象: 会话列表被 executor-watchdog 探针刷屏(每 10 分钟一条,22 个孤儿)(2026-07-21 owner 实测)
# 根因: 看门狗清理调用带 content-type: application/json 但 body 为空,kimi fastify 50001 拒绝,
#       归档全军覆没且错误被 >/dev/null 吞掉;叠加 macOS bash3.2 set -u 空数组 unbound。
# 修复: api() 无 body 不带 content-type + 不用空数组(commit ca9c95c)
# 断言: 连跑 2 次看门狗后,未归档 executor-watchdog 会话数必须为 0
# 环境: 本机(需 adapter 58629 + ~/.kimi-remote-adapter.env)
set -uo pipefail
ADAPTER="${ADAPTER_URL:-http://127.0.0.1:58629}"
TOKEN="${MACHINE_TOKEN:-$(grep -E '^MACHINE_TOKEN=' "$HOME/.kimi-remote-adapter.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'")}"
[ -n "${TOKEN:-}" ] || { echo "SKIP 无 MACHINE_TOKEN(非本机环境)"; exit 0; }

bash "$(dirname "$0")/../../monitor/executor-watchdog.sh" >/dev/null 2>&1
bash "$(dirname "$0")/../../monitor/executor-watchdog.sh" >/dev/null 2>&1

LEFT="$(curl -s --max-time 15 "$ADAPTER/api/v1/sessions?page_size=100&include_archive=false" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '[.data.items[]|select(.archived|not)|select(.title=="executor-watchdog")]|length')"
[ "$LEFT" = "0" ] || { echo "FAIL 看门狗残留 $LEFT 个未归档会话"; exit 1; }
echo "PASS R012 看门狗连跑 2 次零残留"
