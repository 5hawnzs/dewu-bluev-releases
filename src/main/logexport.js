'use strict';
/**
 * 运行日志导出（**纯模块：不 require electron、不碰 store**）
 *
 * 为什么单独拆出来：导出的**内容**与**文件名**是用户要拿去对账、发给同事的东西，
 * 必须能被单测钉住。塞进 ipc.js 里就只能靠「点一遍界面」才验得到。
 *
 * 三条口径（沿用这个项目一贯的做法）：
 *   1. **导出的是「你看到的那些」** —— 传进来的 entries 已经由渲染层按筛选取好，
 *      这里**不再自作主张过滤**；但会把筛选条件写进文件头 ——
 *      否则过几天没人说得清「怎么少了半天日志」。
 *   2. **不造假** —— 0 条就写 0 条，文件头永远写清「本次导出 N 条 / 缓冲区共 M 条」，
 *      差多少一眼看得出来；不许把「筛选后 3 条」写成「共 3 条日志」。
 *   3. **行尾固定 `\n`**（不是 os.EOL）—— 导出的文件会被记事本 / Excel / 别人的机器打开，
 *      行尾跟着平台变会让 diff 变得莫名其妙。
 *
 * 时间也做了处理：底部日志条只显示 `HH:MM:SS`（当天的会话够用），
 * 但导出文件是**长期留存**的，所以每行写完整日期时间 —— 跨天之后才分得清。
 */
const fs = require('fs');
const path = require('path');
const wp = require('./util/winpath');

const LEVELS = ['info', 'ok', 'warn', 'error'];
const LEVEL_LABEL = { info: '信息', ok: '成功', warn: '警告', error: '错误' };

function levelLabel(level) {
  return LEVEL_LABEL[level] || LEVEL_LABEL.info;
}

/** 各等级条数。认不出的等级算进 info（和界面上的配色兜底同一个口径） */
function countByLevel(entries) {
  const out = { info: 0, ok: 0, warn: 0, error: 0, total: 0 };
  for (const e of (entries || [])) {
    const k = LEVEL_LABEL[e && e.level] ? e.level : 'info';
    out[k] += 1;
    out.total += 1;
  }
  return out;
}

/** `运行日志_20261002-021833`（沿用「品牌发布统计_时间戳」那套，但**多带秒**）
 *  ★ 为什么日志要多带秒：别的导出是「一次产出，导完就用」；日志是**排障时反复导**的
 *    —— 复现完再导一次，精确到分钟的话第二次会**悄悄覆盖**第一次，把要留的那份弄丢。
 */
function fileBase(date) {
  const d = date || new Date();
  const p = x => String(x).padStart(2, '0');
  return `运行日志_${wp.stamp(d)}${p(d.getSeconds())}`;
}

function fullTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 筛选条件写成一行人话：级别=全部 · 关键字=（无） */
function filterText(filter) {
  const f = filter || {};
  const lv = f.level && LEVEL_LABEL[f.level] ? LEVEL_LABEL[f.level] : '全部';
  const q = f.q == null || String(f.q) === '' ? '（无）' : String(f.q);
  return `级别=${lv} · 关键字=${q}`;
}

function formatText(entries, meta) {
  const list = entries || [];
  const m = meta || {};
  const c = countByLevel(list);
  const head = [
    '运行日志导出',
    `导出时间：${fullTime(m.exportedAt || Date.now())}`,
    `应用版本：${m.appVersion || '（未知）'}`,
    `筛选条件：${filterText(m.filter)}`,
    // ★ 这两行是「不造假」的关键：筛选后条数 与 内存里到底存了多少，分开写
    `本次导出：${c.total} 条`,
    `内存缓冲区：共 ${Number(m.bufferTotal) || 0} 条（两者不一致 = 上面那条筛选条件筛掉了一部分）`,
    `分等级：信息 ${c.info} · 成功 ${c.ok} · 警告 ${c.warn} · 错误 ${c.error}`,
    '------------------------------------------------------------'
  ];
  const body = list.map(e => `${fullTime(e && e.t)} [${levelLabel(e && e.level)}] ${(e && e.msg) == null ? '' : e.msg}`);
  // 末行空串 ⇒ 文件以换行结尾（很多编辑器/工具默认如此，缺了会被标「\ No newline at end of file」）
  return head.concat(body).join('\n').replace(/\r?\n/g, '\n') + '\n';
}

/** 一行一条 JSON：给「拿脚本再分析」用；多余字段原样保留（meta 里有批次等线索） */
function formatJsonl(entries) {
  const list = entries || [];
  if (!list.length) return '';
  return list.map(e => JSON.stringify({
    t: (e && e.t) || null,
    time: fullTime(e && e.t),
    level: LEVEL_LABEL[e && e.level] ? e.level : 'info',
    levelText: levelLabel(e && e.level),
    msg: (e && e.msg) == null ? '' : e.msg,
    meta: (e && e.meta) || null
  })).join('\n') + '\n';
}

function paths(outputDir, date) {
  const base = fileBase(date);
  return { text: path.join(outputDir, base + '.log'), json: path.join(outputDir, base + '.jsonl') };
}

/**
 * 真落盘。成功返回 { text, json, count }；失败**原样抛**（不吞），
 * 由调用方决定怎么跟用户说 —— 「导出失败却说导出成功」是这里最不能出的事。
 */
function writeFiles(opts) {
  const o = opts || {};
  const outputDir = o.outputDir;
  if (!outputDir) throw new Error('没有输出目录：请先到「设置」里选输出目录');
  const list = o.entries || [];
  const p = paths(outputDir, o.date);
  fs.mkdirSync(wp.toLong(outputDir), { recursive: true });
  fs.writeFileSync(wp.toLong(p.text), formatText(list, o.meta), 'utf8');
  // jsonl 只有 0 条时会是空串 —— 仍然写出来，保证「点了导出就有两个文件」这件事不骗人
  fs.writeFileSync(wp.toLong(p.json), formatJsonl(list), 'utf8');
  return { text: p.text, json: p.json, count: list.length };
}

module.exports = {
  LEVELS, LEVEL_LABEL, levelLabel, countByLevel, fileBase, fullTime, filterText,
  formatText, formatJsonl, paths, writeFiles
};
