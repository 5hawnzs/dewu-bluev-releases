#!/bin/bash
# 一键回归（macOS / Linux 用这个脚本；Windows 直接 `node tools\run-all.js`）
#   用法：bash tools/run-all.sh [名字过滤，如 smoke]
#
# 这里只做两件事：找到 node、然后交给跨平台的 tools/run-all.js
# （本机没有全局 node，见 docs/HANDOFF.md §3；Windows 上的环境见 docs/WINDOWS-E2E.md）
set -u
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  for d in /Users/shuo/.workbuddy/binaries/node/versions/*/bin; do
    if [ -x "$d/node" ]; then export PATH="$d:$PATH"; break; fi
  done
fi
command -v node >/dev/null 2>&1 || { echo "找不到 node：先 export PATH=<node 安装目录>/bin:\$PATH"; exit 2; }

exec node tools/run-all.js "$@"
