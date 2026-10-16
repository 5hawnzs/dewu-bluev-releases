'use strict';
/**
 * 崩溃留档：把「unknown software exception」这种只有一行 Windows 弹框的崩溃，
 * 变成运行日志里能对账的一行，同时在本地留下 minidump。
 *
 * 为什么要做：用户那边只看到弹框、只记得「一直报这种错」，我们这边既没有日志也没有转储 ⇒
 * 只能靠猜。这个模块不解决崩溃本身（那是 startupflags 的事），它解决「下次能不能查明」。
 *
 * 三条口径：
 *   1. **原因照实说**：认不出的 reason 原样带出来，不翻译成「未知问题」也不吞掉。
 *   2. **留档不许帮倒忙**：日志通道 / crashpad 起不来时静默降级，绝不把程序带崩。
 *   3. **主进程异常只记录、不退出**：发布跑一半时，最坏的结果是「弹个框整个没了」。
 *      记下来 + 写进界面日志，让用户知道发生了什么，比让它静默死掉强。
 */
const fs = require('fs');
const path = require('path');
const logbus = require('./logbus');

/** Electron 给的原因码 → 用户能看懂的说法（对不上就原样输出） */
const REASONS = {
  'clean-exit': '正常退出',
  'abnormal-exit': '异常结束',
  killed: '被外部结束',
  crashed: '异常退出',
  oom: '内存不足被系统终止',
  'launch-failed': '进程起不来',
  'integrity-failure': '完整性校验失败'
};

function reasonText(reason) {
  const key = String(reason == null ? '' : reason);
  if (!key) return '原因未报告';
  return REASONS[key] || key;
}

/**
 * 纯函数：结束详情 → 一行日志。
 * kind 是进程类别（GPU / Utility / 渲染进程…），details 是 Electron 给的明细。
 */
function describeGone(kind, details = {}) {
  const name = String(kind || details.type || details.name || '子进程');
  const label = name === 'GPU' ? '图形进程（GPU）' : name;
  const reason = String(details.reason == null ? '' : details.reason);
  const code = details.exitCode == null ? '' : `，退出码 ${details.exitCode}`;
  if (reason === 'clean-exit') return { level: 'info', msg: `${label}已正常退出${code}` };
  const hint = reason === 'oom'
    ? '：多为素材过大或同时处理太多，建议分批'
    : '：若重复出现，请到「运行日志」导出日志（已在本机留下转储）';
  return { level: 'warn', msg: `${label}${reasonText(reason)}${code}${hint}` };
}

function safe(fn) {
  try { return fn(); } catch (e) { return undefined; }
}

/**
 * 装上留档：转储目录 + crashpad + 进程结束 / 主进程异常监听。
 * 依赖全部注入（便于自检用替身验，不接真 Electron）。
 */
function install({
  app, crashReporter, logbus: bus = logbus, userData,
  build = '', fs: fileSystem = fs, path: pathModule = path
} = {}) {
  if (!app || typeof app.on !== 'function') return { installed: false, reason: 'no-app' };
  const report = (level, msg) => safe(() => {
    const target = bus && typeof bus[level] === 'function' ? bus[level].bind(bus) : null;
    if (target) target(msg);
  });

  // ① 本地转储目录：出事后能拿到 minidump，而不是只有用户嘴里的「弹了个框」
  const dumps = userData ? pathModule.join(userData, 'crashdumps') : '';
  if (dumps) {
    safe(() => fileSystem.mkdirSync(dumps, { recursive: true }));
    safe(() => app.setPath('crashDumps', dumps));
  }

  // ② crashpad：只留本机，绝不上传（用户素材相关的进程内存不往外送）
  safe(() => crashReporter.start({
    productName: '得物蓝V素材发布工具',
    companyName: '蓝V',
    submitURL: 'https://localhost.invalid',
    uploadToServer: false,
    compress: false,
    extra: { build: String(build == null ? '' : build) }
  }));

  // ③ 进程结束：GPU / 渲染 / 工具进程各有各的说法，全部落到界面日志
  safe(() => app.on('child-process-gone', (event, details) => {
    const line = describeGone(details && details.type, details || {});
    report(line.level, line.msg);
  }));
  safe(() => app.on('render-process-gone', (event, contents, details) => {
    const line = describeGone('界面进程', details || {});
    report(line.level, `${line.msg}（界面会自行重载；正在跑的发布在后台继续，请留意任务行结果）`);
  }));

  // ④ 主进程自己的异常：记录 + 说清「程序不退出」，别静默死掉
  safe(() => process.on('uncaughtException', error => {
    const detail = error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error);
    report('error', `主进程未捕获异常（已记录，程序不退出）：${detail}`);
  }));
  safe(() => process.on('unhandledRejection', reason => {
    const detail = reason && reason.stack ? reason.stack.split('\n').slice(0, 3).join(' | ') : String(reason);
    report('error', `主进程未处理的异步错误（已记录，程序不退出）：${detail}`);
  }));

  return { installed: true, dumps };
}

module.exports = { install, describeGone, reasonText, REASONS };
