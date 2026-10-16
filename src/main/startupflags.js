'use strict';
/**
 * 启动开关：GPU 相关的开关必须在 app ready **之前**定下来，晚了 Electron 不认。
 *
 * 为什么默认关掉 GPU（本机实测，不是照抄网上说法）：
 *   在远程桌面 / 向日葵这类环境里，GPU 进程会反复退出；Chromium 数到上限后走 `LOG(FATAL)`：
 *     `FATAL:gpu_data_manager_impl_private.cc(449) GPU process isn't usable. Goodbye.`
 *   Windows 上 FATAL 就是 `__debugbreak()`（int3）⇒ 弹「unknown software exception (0x80000003)」
 *   并且**整个程序退出**。发布跑到一半被它带走，就是用户说的「发布中断」。
 *   本仓库更早的 worklog 已经踩过同一个坑并给出结论：`--in-process-gpu --disable-gpu` 即活
 *   （见 docs/knowledge/archive/worklog/2026-09-30.md）。那时候只把开关加给了自检脚本
 *   （tools/run-all.js 的 ELECTRON_FLAGS），正式包一直没加，所以用户那边照旧会崩。
 *
 * 代价与口子：关掉后走软件渲染，界面照常（本工具是表单 + 图片预览，不吃 GPU）。
 * 需要还原硬件加速：命令行加 `--enable-gpu`，或设环境变量 `BLUEV_ENABLE_GPU=1`。
 */

/** 是否要关 GPU：只有显式要求时才放行（默认关） */
function wanted({ argv = [], env = {} } = {}) {
  if (argv.includes('--enable-gpu')) return false;
  const flag = String(env.BLUEV_ENABLE_GPU == null ? '' : env.BLUEV_ENABLE_GPU).trim().toLowerCase();
  return !(flag === '1' || flag === 'true');
}

/**
 * 挂开关。返回 `{ disabled, switches, reason }`：
 *   disabled=false 时 reason 说明为什么没挂（explicit / late / no-app），**不假装已生效**。
 */
function apply({ app, argv = process.argv, env = process.env, log } = {}) {
  if (!app || !app.commandLine) return { disabled: false, switches: [], reason: 'no-app' };
  if (app.isReady && app.isReady()) {
    // 开关晚挂等于没挂：如实说，别让「明明设了却还崩」变成下一个悬案
    if (log) log('启动开关设置晚了（app 已 ready），本次不生效：GPU 关闭需要在创建窗口前完成');
    return { disabled: false, switches: [], reason: 'late' };
  }
  if (!wanted({ argv, env })) return { disabled: false, switches: [], reason: 'explicit' };
  if (typeof app.disableHardwareAcceleration === 'function') app.disableHardwareAcceleration();
  // 独立 GPU 进程是「GPU 进程崩了就 FATAL 掉整个程序」的根源：连进程一起省掉。
  const switches = ['disable-gpu', 'in-process-gpu'];
  for (const name of switches) app.commandLine.appendSwitch(name);
  return { disabled: true, switches, reason: 'default' };
}

module.exports = { wanted, apply };
