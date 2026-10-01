'use strict';
/**
 * 执行日志落盘（run-log.jsonl）
 *
 * 为什么非要有它：`logbus` 是**内存环形缓冲**（500 条），程序一关就没了。
 * 「管理员查看各品牌的执行日志」如果只接 logbus，那就只能在对方刚跑完、还没关窗口的时候看 ——
 * 那不叫能查日志。所以任务级的执行记录必须落盘。
 *
 * 与 publish-log.jsonl 的分工：
 *   publish-log —— 逐条发布结果（序号 / 素材 / 成功失败 / 耗时），算「数量与频次」用它
 *   run-log     —— 任务级流水（谁、什么时候、跑了哪个任务、哪个品牌、成没成、多久）
 *
 * 两个刻意的设计：
 *   1. **品牌名是快照**。品牌日后改名或删除，历史日志里仍保留当时那个名字 ——
 *      否则翻旧账时名字会跟着变，对不上。
 *   2. **不自动轮转/裁剪**。和 publish-log 一样只追加（体量在界面上可见，要清理由人来决定）——
 *      自动裁剪意味着「某天的日志悄悄没了」，查账时才发现。
 *
 * 位置：<输出目录>/run-log.jsonl
 */
const fs = require('fs');
const path = require('path');
const store = require('../store');
const wp = require('../util/winpath');

function file() { return path.join(store.get('paths.output'), 'run-log.jsonl'); }

/** kind: 'start' | 'log' | 'end'（end 带 ok / elapsedSec / error） */
function append(entry) {
  try {
    const f = file();
    fs.mkdirSync(wp.toLong(path.dirname(f)), { recursive: true });
    fs.appendFileSync(wp.toLong(f), JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n', 'utf8');
    return true;
  } catch (e) {
    // 写日志失败不能反过来把任务搞挂（和 sheet.appendLog 一个口径）
    return false;
  }
}

function read() {
  try {
    return fs.readFileSync(wp.toLong(file()), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function size() {
  try { return fs.statSync(wp.toLong(file())).size; } catch (e) { return 0; }
}

/**
 * 按条件取日志，最新的在前。
 * scopeIds 为数组时（非管理员）只返回这些品牌下的记录 —— 认不出品牌的记录不给，
 * 因为没法确认它属不属于对方。
 */
function query(opts = {}) {
  const days = opts.days == null ? 0 : Number(opts.days) || 0;
  const fromTs = days > 0 ? Date.now() - days * 86400000 : 0;
  const scope = Array.isArray(opts.scopeIds) ? opts.scopeIds.map(String) : null;
  const rawBrand = String(opts.brandId == null ? '' : opts.brandId);
  const onlyUntagged = rawBrand === '__none__';            // 与 stats.UNTAGGED_FILTER 同一个哨兵值
  const wantBrand = onlyUntagged ? '' : rawBrand;
  const wantUser = opts.userId ? String(opts.userId) : '';
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;

  let all = Array.isArray(opts.preloaded) ? opts.preloaded : read();
  if (fromTs) all = all.filter(e => Number(e.ts) >= fromTs);
  if (onlyUntagged) all = all.filter(e => !e.brandId);
  else if (wantBrand) all = all.filter(e => String(e.brandId || '') === wantBrand);
  if (wantUser) all = all.filter(e => String(e.userId || '') === wantUser);
  if (scope) all = all.filter(e => e.brandId && scope.includes(String(e.brandId)));
  all.reverse();                                  // 最新在前
  return limit ? all.slice(0, limit) : all;
}

module.exports = { file, append, read, size, query };
