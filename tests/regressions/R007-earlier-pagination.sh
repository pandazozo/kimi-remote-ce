#!/bin/bash
# R007-earlier-pagination
# 现象: 会话详情页「加载更早消息」按钮不出现/点了没反应(owner 手机实测,v0.4.17)
# 根因: 前端 quiet 刷新把 state.msgs 重置为最新一页,冲掉已加载的更早消息;本用例守接口侧前提:
#       messages 分页契约(before_id 翻页必须返回严格更早、无重叠、has_more 在场)——前端修复依赖该契约。
# 出处: 2026-07-20 修复于 web/app.js(loadMessages 增量合并 + loadEarlier 滚动锚定)
set -uo pipefail

KIMI_BASE="${KIMI_BASE:-http://127.0.0.1:58627}"
TOKEN="${TOKEN:-$(cat ~/.kimi-code/server.token 2>/dev/null)}"
[ -n "$TOKEN" ] || { echo "SKIP: 无 kimi server token"; exit 0; }

J() { python3 -c "$1"; }
get() { curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$KIMI_BASE$1"; }

# 健康检查:server 不在 → 跳过(本用例只在本机环境有意义)
get /api/v1/healthz >/dev/null 2>&1 || get /api/v1/meta >/dev/null 2>&1 || { echo "SKIP: kimi server 不可达($KIMI_BASE)"; exit 0; }

# 找一个消息数足够翻页的会话(page_size=3 且 has_more=true)
SID=$(get "/api/v1/sessions?page_size=30" | J '
import json,sys
try: items=json.load(sys.stdin)["data"]["items"]
except Exception: sys.exit(0)
for s in items: print(s["id"])
' | while read -r sid; do
  hm=$(get "/api/v1/sessions/$sid/messages?page_size=3" | J '
import json,sys
try: d=json.load(sys.stdin)["data"]
except Exception: sys.exit(0)
print("yes" if d.get("has_more") and len(d.get("items",[]))==3 else "")')
  [ "$hm" = "yes" ] && { echo "$sid"; break; }
done)
[ -n "$SID" ] || { echo "SKIP: 没有可翻页的会话(消息都太少)"; exit 0; }

# 契约断言 ①:第一页每条消息必须有 id/created_at/role
get "/api/v1/sessions/$SID/messages?page_size=3" > /tmp/r007-p1.json
python3 - <<'EOF' || { echo "FAIL: 第一页消息缺 id/created_at/role"; exit 1; }
import json,sys
d=json.load(open('/tmp/r007-p1.json'))['data']
assert d.get('has_more') is True, 'has_more 必须为 true'
for m in d['items']:
    assert m.get('id') and m.get('created_at') and m.get('role'), f"字段缺失: {m.keys()}"
EOF

# 契约断言 ②:before_id=<本页最旧 id> → 返回严格更早、零重叠
OLDEST=$(python3 -c "
import json
d=json.load(open('/tmp/r007-p1.json'))['data']
items=sorted(d['items'],key=lambda m:m['created_at'])
print(items[0]['id'])")
get "/api/v1/sessions/$SID/messages?page_size=3&before_id=$OLDEST" > /tmp/r007-p2.json
python3 - <<EOF || exit 1
import json
p1=json.load(open('/tmp/r007-p1.json'))['data']['items']
p2=json.load(open('/tmp/r007-p2.json'))['data']
ids1={m['id'] for m in p1}
ids2={m['id'] for m in p2['items']}
overlap = ids1 & ids2
assert not overlap, f"FAIL: before_id 翻页与第一页有重叠 {overlap}"
oldest_ts = min(m['created_at'] for m in p1)
for m in p2['items']:
    assert m['created_at'] <= oldest_ts, f"FAIL: before_id 返回了不更早的消息 {m['created_at']} > {oldest_ts}"
assert 'has_more' in p2, "FAIL: 翻页响应缺 has_more 字段"
EOF

echo "R007 OK"
