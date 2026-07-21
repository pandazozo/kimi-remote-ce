#!/bin/bash
# 单元测试入口:gateway 模块 + web/md.js
# 用法: tests/run-unit.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== gateway 单元测试 =="
(cd gateway && node --test)

echo ""
echo "== web/md.js 单元测试 =="
node --test tests/md.test.js

echo ""
echo "== 全部单元测试通过 =="
