#!/usr/bin/env bash
# Shared helpers for the v0.5 self-hosting installers.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$REPO_ROOT/config.env}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  printf 'ERROR: config.env 不存在: %s\n' "$CONFIG_FILE" >&2
  printf '排障: cp %s/config.example.env %s/config.env，然后填写带 * 的配置项。\n' "$REPO_ROOT" "$REPO_ROOT" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$CONFIG_FILE"
set +a

COLOR_OK='\033[0;32m'
COLOR_WARN='\033[0;33m'
COLOR_ERR='\033[0;31m'
COLOR_RESET='\033[0m'

log() { printf '%b[install]%b %s\n' "$COLOR_OK" "$COLOR_RESET" "$*"; }
warn() { printf '%b[install][WARN]%b %s\n' "$COLOR_WARN" "$COLOR_RESET" "$*" >&2; }

die() {
  printf '%b[install][ERROR]%b %s\n' "$COLOR_ERR" "$COLOR_RESET" "$*" >&2
  printf '排障: 回看上一步命令输出；服务日志可用 docker compose -p kimi-remote logs --tail=100 或 tail -100 ~/Library/Logs/kimi-remote-*.log。\n' >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1。请先安装它，再重跑当前安装器。"
}

require_nonempty() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || die "配置项 $name 不能为空。请编辑 $CONFIG_FILE 后重试。"
}

random_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  elif command -v od >/dev/null 2>&1; then
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  else
    die "无法生成随机密钥：openssl 和 od 均不存在。"
  fi
}

wait_http() {
  local url="$1"
  local expected="${2:-}"
  local attempts="${3:-30}"
  local delay="${4:-2}"
  local body=''
  local i
  for i in $(seq 1 "$attempts"); do
    body="$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    if [[ -n "$body" ]] && { [[ -z "$expected" ]] || printf '%s' "$body" | grep -Fq "$expected"; }; then
      printf '%s' "$body"
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

config_value() {
  local name="$1"
  printf '%s' "${!name:-}"
}
