#!/bin/bash
# 视觉走查壳子:检查 Playwright 可用性,不可用则 SKIP 退出 0。
# 可用时把 NODE_PATH 指到 npx 缓存里的 playwright 安装,再跑 walkthrough.js。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG_PREFIX="[run-visual]"

# 1. 解析候选 playwright 模块路径(优先级)
RESOLVED_NODE_PATH=""
if [ -n "${NODE_PATH:-}" ]; then
  RESOLVED_NODE_PATH="$NODE_PATH"
fi

probe_node() {
  NODE_PATH="$1" node -e "require('playwright');process.exit(0)" 2>/dev/null
}

# 用户已显式给出 NODE_PATH,但仍未命中(例如升级/误填)→ 仍继续找
if [ -n "$RESOLVED_NODE_PATH" ] && probe_node "$RESOLVED_NODE_PATH"; then
  : # 用用户的
else
  # 2. 探测 npm 默认全局缓存:$(npm config get cache 2>/dev/null)/_npx
  NPM_CACHE_DIR="$(npm config get cache 2>/dev/null || true)"
  if [ -n "$NPM_CACHE_DIR" ] && [ -d "$NPM_CACHE_DIR/_npx" ]; then
    for d in "$NPM_CACHE_DIR/_npx"/*/node_modules; do
      if probe_node "$d"; then
        RESOLVED_NODE_PATH="$d"
        break
      fi
    done
  fi
  # 3. 兜底路径:owner 提示的 npx hash 缓存
  if [ -z "$RESOLVED_NODE_PATH" ]; then
    for d in "$HOME"/.npm/_npx/*/node_modules; do
      if probe_node "$d"; then
        RESOLVED_NODE_PATH="$d"
        break
      fi
    done
  fi
fi

if [ -z "$RESOLVED_NODE_PATH" ]; then
  echo "SKIP: Playwright 不可用 — 未在 NODE_PATH / npm _npx 缓存中找到 playwright 模块"
  echo "SKIP: 提示:运行 npx --yes playwright@1.45.0 install chromium 之后,本壳子会自动复用"
  exit 0
fi

echo "$LOG_PREFIX NODE_PATH=$RESOLVED_NODE_PATH"
export NODE_PATH="$RESOLVED_NODE_PATH"
exec node "$HERE/walkthrough.js" "$@"
