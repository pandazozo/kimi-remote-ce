#!/bin/bash
# run-all.sh — 全量测试入口(分层)
# 用法:
#   tests/run-all.sh           # 默认:单元测试 + 回归用例(regressions/)
#   tests/run-all.sh --quick   # 仅单元测试(秒级)
#   tests/run-all.sh --full    # 全部:单元 + 回归 + 生产冒烟 + 真值对账(需 BASE/PASSWORD/TOKEN 环境变量)
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-default}"
FAIL=0

echo "==================== ① 单元测试 ===================="
tests/run-unit.sh || FAIL=1

if [ "$MODE" = "--quick" ]; then
  echo "== quick 模式结束 =="; exit $FAIL
fi

echo ""
echo "==================== ② 回归用例 ===================="
if ls tests/regressions/R*.sh tests/regressions/R*.js 2>/dev/null | grep -v README >/dev/null 2>&1; then
  for f in $(ls tests/regressions/R*.sh tests/regressions/R*.js 2>/dev/null | grep -v README); do
    echo "--- $f ---"
    case "$f" in *.sh) bash "$f" ;; *.js) node "$f" ;; esac && RC=0 || RC=1; if [ "${RC:-0}" = 0 ]; then echo "PASS $f"; else echo "FAIL $f"; FAIL=1; fi
  done
else
  echo "(无回归用例)"
fi

if [ "$MODE" = "--full" ]; then
  echo ""
  echo "==================== ③ 生产冒烟 ===================="
  BASE="${BASE:-https://your.domain}" PASSWORD="${PASSWORD:?need PASSWORD}" tests/smoke.sh || FAIL=1
  echo ""
  echo "==================== ③.5 视觉走查 ===================="
  if [ -f tests/visual/run-visual.sh ]; then
    VISUAL_BASE="${VISUAL_BASE:-${BASE:-https://your.domain}}" PASSWORD="${PASSWORD:?need PASSWORD}" bash tests/visual/run-visual.sh || FAIL=1
  else
    echo "SKIP tests/visual/ 不存在"
  fi
  echo ""
  echo "==================== ④ 真值对账 ===================="
  TOKEN="${TOKEN:?need TOKEN}" tests/parity-check.sh || FAIL=1
fi

echo ""
echo "==================== 结果: $([ $FAIL = 0 ] && echo 全部通过 || echo 有失败) ===================="
exit $FAIL
