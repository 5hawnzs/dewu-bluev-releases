#!/bin/bash
# 一键回归：五套主进程测试 + 隐藏窗口界面自检
#   用法：bash tools/run-all.sh
#
# 覆盖（断言数见 docs/HANDOFF.md §6）：
#   smoke.js          造临时素材跑完整流水线
#   adbtest.js        假 adb 验证真实发布通道（指令序列 / 坐标点击 / 中文广播输入 / 失败截图）
#   pendingtest.js    发布单被占用 → 整批暂存 → 下次补写；设备矩阵
#   compliancetest.js 合规边界（合格图不会被误隔离）+ 导出报告
#   batchtest.js      多批次并行 / 逐个取消 / 全部取消 / 按批次重导出日志
#   uicheck.js        隐藏窗口加载真实渲染层：7 个页签渲染 + 零控制台报错
#   logintest.js      登录门：未登录拦截 / 口令与记住登录 / 权限 / 防爆破 / 退出
set -u
cd "$(dirname "$0")/.."

# 本机没有全局 node（见 docs/HANDOFF.md §3），自己找一遍
if ! command -v node >/dev/null 2>&1; then
  for d in /Users/shuo/.workbuddy/binaries/node/versions/*/bin; do
    if [ -x "$d/node" ]; then export PATH="$d:$PATH"; break; fi
  done
fi
command -v node >/dev/null 2>&1 || { echo "找不到 node：先 export PATH=<node 安装目录>/bin:\$PATH"; exit 2; }

# 本机 Electron 二进制会因签名问题被 SIGKILL，先自签一遍（幂等，只对 macOS 有意义）
if [ -d node_modules/electron/dist/Electron.app ]; then
  if command -v xattr >/dev/null 2>&1; then xattr -cr node_modules/electron/dist/Electron.app 2>/dev/null; fi
  if command -v codesign >/dev/null 2>&1; then codesign --force --sign - node_modules/electron/dist/Electron.app >/dev/null 2>&1; fi
fi

fails=0
run() {
  local name="$1"; shift
  local out code p f
  out="$("$@" 2>&1)"; code=$?
  p=$(printf '%s\n' "$out" | grep -c '^PASS')
  f=$(printf '%s\n' "$out" | grep -c '^FAIL')
  if [ "$code" -eq 0 ] && [ "$f" -eq 0 ]; then
    printf '  ✅ %-16s PASS %-3s\n' "$name" "$p"
  else
    printf '  ❌ %-16s PASS %-3s FAIL %s (exit %s)\n' "$name" "$p" "$f" "$code"
    printf '%s\n' "$out" | grep -E '^FAIL|^\[.*ERROR|ERROR ' | head -12
    fails=$((fails + 1))
  fi
}

echo "node: $(node -v)"
echo "回归开始（每改一处都要跑完这一套）"
run smoke          node tools/smoke.js
run adbtest        node tools/adbtest.js
run pendingtest    node tools/pendingtest.js
run compliancetest node tools/compliancetest.js
run batchtest      node tools/batchtest.js
run uicheck        ./node_modules/.bin/electron tools/uicheck.js
run logintest      ./node_modules/.bin/electron tools/logintest.js

echo
if [ "$fails" -eq 0 ]; then
  echo "全部通过。"
else
  echo "有 $fails 套没过，失败项已列在上面。"
fi
exit "$fails"
