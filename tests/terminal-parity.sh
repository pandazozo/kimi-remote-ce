#!/usr/bin/env python3
"""terminal-parity — H5 可见内容 vs 终端 wire.jsonl 真值 对账(owner 2026-07-20 钦定验收机制)

终端(TUI)的渲染真源是 ~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl;
H5 的渲染真源是 kimi server API。本脚本对比两侧最近 N 个可渲染项,输出:
  ① 内容对账:wire 里的 user/assistant/tool 条目在 API 是否都有对应(缺一罚一)
  ② 信息富度差距:终端有而 H5 缺的类别(流式增量文本/todos/子代理行/工具摘要等)
用法: TOKEN=xxx ./tests/terminal-parity.sh [session_id] [N]
"""
import json, os, subprocess, sys, glob

TOKEN = os.environ.get("TOKEN") or sys.exit("need TOKEN")
UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:58627")
SID = sys.argv[1] if len(sys.argv) > 1 else "session_67e5d54b-d241-4f45-ace6-34c086d6c5e6"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20

def api(path):
    out = subprocess.run(
        ["curl", "-s", "--max-time", "30", "-H", f"Authorization: Bearer {TOKEN}", f"{UPSTREAM}{path}"],
        capture_output=True, text=True).stdout
    return json.loads(out)

# --- 找 wire.jsonl ---
pat = os.path.expanduser(f"~/.kimi-code/sessions/*/{SID}/agents/main/wire.jsonl")
hits = glob.glob(pat)
if not hits:
    sys.exit(f"wire.jsonl 未找到: {pat}")
wire_path = hits[0]

# --- wire 侧:提取最近 N 个可渲染条目 ---
wire_items = []
with open(wire_path, errors="replace") as f:
    for line in f:
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type") or ""
        payload = e.get("payload") or {}
        msg = payload.get("message") or {}
        role = msg.get("role") or ""
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                wire_items.append((f"{role or t}:text", (b.get("text") or "")[:60]))
            elif bt == "tool_use":
                wire_items.append((f"{role or t}:tool_use", b.get("tool_name") or b.get("name") or ""))
            elif bt == "tool_result":
                wire_items.append((f"{role or t}:tool_result", ""))
            elif bt == "thinking":
                wire_items.append((f"{role or t}:thinking", ""))
wire_items = wire_items[-N:]

# --- API 侧(H5 数据源)最近 N 条 ---
resp = api(f"/api/v1/sessions/{SID}/messages?page_size={N}")
items = (resp.get("data") or {}).get("items") or []
api_set = []
for m in items:
    role = m.get("role") or ""
    content = m.get("content")
    if not isinstance(content, list):
        continue
    for b in content:
        if not isinstance(b, dict):
            continue
        bt = b.get("type")
        if bt == "text":
            api_set.append((f"{role}:text", (b.get("text") or "")[:60]))
        elif bt == "tool_use":
            api_set.append((f"{role}:tool_use", b.get("tool_name") or b.get("name") or ""))
        elif bt == "tool_result":
            api_set.append((f"{role}:tool_result", ""))
        elif bt == "thinking":
            api_set.append((f"{role}:thinking", ""))

# --- ① 内容对账 ---
api_texts = {t for k, t in api_set if k.endswith(":text")}
missing = [w for w in wire_items if w[0].endswith(":text") and w[1] and not any(w[1][:30] in a for a in api_texts)]

# --- ② 富度差距(终端有,H5 需逐项核对能力)---
snap = api(f"/api/v1/sessions/{SID}/snapshot")
f = (snap.get("data") or {}).get("in_flight_turn") or {}
richness = {
    "流式增量文本(in_flight assistant_text/thinking_text)": bool(f.get("assistant_text") or f.get("thinking_text")),
    "running_tools 实时": bool(f.get("running_tools")),
    "wire 条目总数(窗口内)": len(wire_items),
    "API 条目总数(窗口内)": len(api_set),
}

print(f"== terminal-parity @ {SID} (wire 最近 {len(wire_items)} / API 最近 {len(api_set)}) ==")
print("① 内容对账:", "全部覆盖" if not missing else f"缺 {len(missing)} 条 wire 文本")
for k, v in missing[:5]:
    print("   MISS:", k, v[:50])
print("② 富度能力:")
for k, v in richness.items():
    print(f"   {k}: {v}")
verdict = "PASS" if not missing else f"WARN({len(missing)} miss)"
print(f"== 判定: {verdict} ==")
