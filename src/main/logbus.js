'use strict';
/** 运行日志总线：环形缓存 + 实时推送到渲染层 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
const history = [];
const MAX = 500;
let win = null;

function attach(w) { win = w; }

/**
 * ★ 2026-10-05 用户口径：「给用户不用这么细，就给大结论」。
 *
 * 日志分两级（`opts.tier`）：
 *   （不传 / 'ui'）大结论 —— 面向用户：任务开始、结束、结果【目标/成功/失败】与真出错的告警。
 *   'detail'      过程明细 —— 逐步流水（每步耗时 / 坐标 / 屏幕守卫 / 清相册 / 抽帧…）。
 *                  界面**默认不显示**（底部日志栏与「运行日志」页都只画大结论），
 *                  但它照样进内存 History 与 run-log.jsonl 台账，
 *                  任务行的「查看详情」也照样能按批次逐条回看 —— 只是不再往用户脸上刷。
 *
 * 默认是「大结论」：老调用点（logbus.ok/info/warn/error）一行都不用改就保持可见，
 * 只有**明确要沉底的流水**才需要传 `{ tier: 'detail' }`（见 jobs.js 的 ctx.log）。
 * 这条默认值刻意的 —— 万一哪里漏标了，症状是「多显示一条」，而不是「结论被吞掉」。
 */
function push(level, msg, meta, opts) {
  const entry = { t: Date.now(), level, msg, meta: meta || null };
  if (opts && opts.tier === 'detail') entry.tier = 'detail';
  history.push(entry);
  if (history.length > MAX) history.shift();
  bus.emit('log', entry);
  if (win && !win.isDestroyed()) win.webContents.send('log:entry', entry);
  return entry;
}

/**
 * 任务流水（`ctx.log`）该走哪一级 —— 规则只在这里写一次，测试直接钉这个函数。
 *
 * 默认**沉底**（'detail'）：`ctx.log` 是「每步耗时 / 坐标 / 屏幕守卫 / 清相册」那类流水，
 * 用户 2026-10-05 明确说「给用户不用这么细」。两条例外必须留给用户看，它们本身就是结论：
 *   ① `level === 'error'`：真出错了 —— 「太细」不是把错误藏起来的理由；
 *   ② `opts.ui === true`：调用点显式声明的结论（即 `ctx.conclude`）。
 *
 * ★ 与 `push` 的默认值（大结论）**故意相反**：`push` 面向的是 logbus.ok/info 这类
 *   「本来就是说给用户听的」调用点，漏标的症状是多显示一条；而 `ctx.log` 是流水通道，
 *   漏标的症状是刷屏。两个默认值各自往「坏处更小」的方向兜。
 */
function tierOf(level, opts) {
  if (opts && opts.ui === true) return 'ui';
  if (level === 'error') return 'ui';
  return 'detail';
}

module.exports = {
  attach,
  history: () => history.slice(),
  info: (m, meta, opts) => push('info', m, meta, opts),
  ok: (m, meta, opts) => push('ok', m, meta, opts),
  warn: (m, meta, opts) => push('warn', m, meta, opts),
  error: (m, meta, opts) => push('error', m, meta, opts),
  DETAIL: { tier: 'detail' },     // 给调用点用的常量，避免各处硬写字符串
  tierOf,
  bus
};
