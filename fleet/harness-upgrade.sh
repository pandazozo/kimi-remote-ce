#!/bin/bash
# harness-upgrade.sh — 机队 agent harness 每日健壮升级(SOL 评审加固版 v2)
# M5 统一编排,经 ssh 驱动 m1/m2ts(远端零安装);每日本地 05:47 launchd 触发。
# 设计原则(SOL 评审逐条落地):
#   1. 分渠道升级:npm / brew / codex 自更新(codex update);kimi(网关上游)与桌面 app(ZCode/WorkBuddy)只采版本不动
#   2. 验收基准=各渠道最新(npm registry latest);坏了才回滚到快照版本,版本没变≠失败
#   3. 升级前冷备会话目录(7 天滚动);不重启任何运行中进程
#   4. 台账 JSONL(远端行回传带来源前缀);失败/回滚汇总一条飞书告警;周一版本周报
# 用法: harness-upgrade.sh          # 本机升级
#       harness-upgrade.sh --fleet  # M5 上编排三机
#       harness-upgrade.sh --report # 汇总三机版本表发飞书
set -uo pipefail

FLEET_TOOLS=( "@openai/codex:codex" "@google/gemini-cli:gemini" "opencode-ai:opencode" "mmx-cli:mmx" )  # 2026-07-21 claude-code 全线下线(封号风控,owner 令),不再纳入升级
BACKUP_ROOT="$HOME/.harness-backup"
LEDGER="$HOME/.harness-upgrade.jsonl"
LOG() { printf '%s\n' "$(date -u +%FT%TZ) $(hostname -s) $*" | tee -a "$LEDGER" >&2; }

DEVICE="$(hostname -s)"
TODAY="$(date +%F)"
mkdir -p "$BACKUP_ROOT"

# ---------- 渠道探测 ----------
detect_source() { # $1=npm包名 $2=bin名 → npm|brew|codex-native|report-only|none
  command -v "$2" >/dev/null 2>&1 || { echo none; return; }
  npm ls -g "$1" --depth=0 2>/dev/null | grep -q "$1@" && { echo npm; return; }
  command -v brew >/dev/null 2>&1 && brew list --versions "$1" >/dev/null 2>&1 && { echo brew; return; }
  [ "$2" = "codex" ] && { echo codex-native; return; }
  echo report-only
}

# ---------- 单工具升级 ----------
upgrade_tool() { # $1=npm包名 $2=bin名
  local pkg="$1" bin="$2"
  local src; src="$(detect_source "$pkg" "$bin")"
  [ "$src" = "none" ] && { LOG "skip $pkg (not installed)"; return 0; }

  local prev after latest
  prev="$($bin --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || echo '?')"

  case "$src" in
    report-only)
      LOG "report-only $pkg $prev (非 npm/brew 管理,仅台账)"
      return 0 ;;
    codex-native)
      codex update >/dev/null 2>&1 || true
      after="$($bin --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || echo '?')"
      [ "$after" = "?" ] && { LOG "FAILED $pkg codex-native upgrade ($prev -> ?)"; return 1; }
      [ "$after" != "$prev" ] && LOG "upgraded $pkg $prev -> $after (codex-native)" || LOG "ok $pkg $prev (codex-native latest)"
      return 0 ;;
    brew)
      brew upgrade "$pkg" >/dev/null 2>&1 || true
      after="$($bin --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || echo '?')"
      [ "$after" = "?" ] && { LOG "FAILED $pkg brew upgrade ($prev -> ?)"; return 1; }
      [ "$after" != "$prev" ] && LOG "upgraded $pkg $prev -> $after (brew)" || LOG "ok $pkg $prev (brew latest)"
      return 0 ;;
  esac

  # npm 渠道:registry latest 为验收基准,坏了才回滚
  latest="$(npm view "$pkg" version 2>/dev/null || echo '?')"
  local outdated
  outdated="$(npm outdated -g "$pkg" --no-fund --no-audit 2>/dev/null | tail -n +2 | head -1)"
  [ -z "$outdated" ] && { LOG "ok $pkg $prev (latest)"; return 0; }

  if pgrep -f "npm (i|install|update) -g" >/dev/null 2>&1; then
    LOG "defer $pkg (another npm -g running)"; return 0
  fi

  # 冷备会话目录(只备有的;7 天滚动)
  for d in ".codex/sessions" ".gemini/history" ".mmx/history"; do  # 2026-07-21 摘 .claude/projects(claude 已下线)
    [ -d "$HOME/$d" ] && rsync -a --delete "$HOME/$d/" "$BACKUP_ROOT/$TODAY/$d/" 2>/dev/null || true
  done

  npm i -g "$pkg@latest" --no-fund --no-audit >/dev/null 2>&1
  # 验收用 npm ls(与安装渠道同视角,免疫 PATH 里老二进制遮挡)
  after="$(npm ls -g "$pkg" --depth=0 2>/dev/null | grep -oE '@[0-9]+\.[0-9]+(\.[0-9]+)?$' | tr -d '@' | head -1 || echo '?')"

  if [ "$after" != "?" ] && { [ "$after" = "$latest" ] || [ "$latest" = "?" ]; }; then
    [ "$after" != "$prev" ] && LOG "upgraded $pkg $prev -> $after" || LOG "ok $pkg $prev (latest)"
    # 遮挡预警:PATH 解析到的二进制与 npm 版本不一致(用户实际跑的是旧版)
    local binv
    binv="$($bin --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || echo '?')"
    [ "$binv" != "?" ] && [ "$binv" != "$after" ] && \
      LOG "SHADOW-WARN $pkg: PATH 里 $(command -v "$bin") 是 $binv,npm 里是 $after,需人工处理旧二进制"
    return 0
  fi
  npm i -g "$pkg@$prev" --no-fund --no-audit >/dev/null 2>&1 || true
  LOG "ROLLBACK $pkg ($prev, registry latest $latest, verify got $after)"
  return 1
}

# ---------- 本机升级 ----------
local_upgrade() {
  local fails=0
  for app in "ZCode" "WorkBuddy"; do
    v="$(defaults read "/Applications/$app.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
    LOG "app $app $v (tracked-only)"
  done
  for entry in "${FLEET_TOOLS[@]}"; do
    upgrade_tool "${entry%%:*}" "${entry##*:}" || fails=$((fails+1))
  done
  find "$BACKUP_ROOT" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
  return $fails
}

# ---------- 飞书 ----------
LARK_CLI="${LARK_CLI:-$(command -v lark-cli || command -v lark-cli)}"
ALERT_USER_OPEN_ID="${ALERT_USER_OPEN_ID:-}"
send() {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 "$LARK_CLI" im +messages-send --as bot \
    --user-id "$ALERT_USER_OPEN_ID" --text "$1" \
    --idempotency-key "$(uuidgen | tr '[:upper:]' '[:lower:]')" >/dev/null 2>&1
}

# ---------- 三机编排 ----------
fleet_upgrade() {
  local_upgrade >/dev/null || true
  local h out
  for h in m1 m2ts; do
    # 远端零安装:脚本经 stdin 推送执行,台账行回传并带来源前缀
    out="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$h" "export PATH=\"\$HOME/.local/bin:\$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH\"; bash -s 2>&1" < "$0")"
    if [ -z "$out" ]; then LOG "fleet $h unreachable/failed"; else printf '%s\n' "$out" | sed "s/^/[$h] /" >> "$LEDGER"; fi
  done
  local recent
  recent="$(grep "$TODAY" "$LEDGER" | grep -E "ROLLBACK|FAILED|failed" || true)"
  [ -n "$recent" ] && send "⚠️ harness 每日升级有失败/回滚:\n$recent\n详查 $LEDGER"
}

# ---------- 版本周报 ----------
fleet_report() {
  local out="📦 机队 harness 版本周报 ($(date +%m-%d))\n"
  out+="$(hostname -s)(本机):\n"
  for entry in "${FLEET_TOOLS[@]}"; do
    b="${entry##*:}"; v="$($b --version 2>/dev/null | head -1 || echo 未装)"
    out+="  ${entry%%:*}  $v\n"
  done
  for h in m1 m2ts; do
    out+="$h:\n"
    v="$(ssh -o ConnectTimeout=8 -o BatchMode=yes "$h" "export PATH=\"\$HOME/.local/bin:\$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH\"; for b in codex gemini opencode mmx; do printf '%s | ' \"\$b:\$(\$b --version 2>/dev/null | head -1 || echo 未装)\"; done; echo" 2>/dev/null || echo unreachable)"
    out+="  $v"
  done
  out+="kimi(本机): $(kimi --version 2>/dev/null || echo '?')(网关上锁,手动节奏)"
  send "$out"
}

case "${1:-}" in
  --fleet) fleet_upgrade ;;
  --report) fleet_report ;;
  *) local_upgrade ;;
esac
exit 0
