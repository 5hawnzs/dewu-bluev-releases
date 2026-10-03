'use strict';
/** 工程状态（单一数据源）：主进程持有，变更后广播给渲染层 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const wp = require('./util/winpath');
const store = require('./store');
const flatten = require('./services/flatten');

let saveTimer = null;

/**
 * 工程状态里的 items **每次进出都按叶子文件夹名重认一遍货号/颜色**。
 *
 * ★★ 为什么非做不可（2026-10-04 用户第二遍报「货号里还是批次目录名」）：
 *   items 是**素材整理那一次**算好的，之后文案生成 / 出报告 / 发布都只读它，谁都不会回文件夹看第二眼。
 *   旧版（把批次目录当货号的那个版本）存下来的 `sku:'0901_2' / color:'3261163003'` 就**一直躺在
 *   project.json 里**，报告的好物列直接取 `it.sku/it.color` ⇒ 一直错；而且**重跑文案生成也修不好**
 *   （文案生成不重算这两个字段）。实测同一份 absDir 现在读出来是 `3261163003 / ''`（对的）。
 *   ⇒ 在这里按文件夹名重读，用户**不必重跑素材整理**、也不必改报告。
 * ★ 只动「按文件夹名能确凿认出来」的那些（flatten.refineItem 只认 how='plus'/'sku'），
 *   其余原样返回 —— 宁可留一条让人去补，也不写一个假货号。
 */
function healItems(list) {
  if (!Array.isArray(list) || !list.length) return list;
  let changed = 0;
  const out = list.map(it => {
    const r = flatten.refineItem(it);
    if (r !== it) changed++;
    return r;
  });
  if (!changed) return list;             // 一条都没变 ⇒ 原样返回同一个数组（不做无谓的引用替换/广播）
  try {
    require('./logbus').info(`工程状态里有 ${changed} 条素材的货号/颜色按叶子文件夹名纠正了`
      + `（旧版存下的「批次目录名当货号」已修，报告与发布都会跟着对）`);
  } catch (e) { /* 日志不可用不影响纠正本身 */ }
  return out;
}

function blank() {
  return {
    projectName: store.get('projectName') || '蓝V 项目',
    sourceDir: '',                   // ★ 不预填：素材目录每次现场选（「设置 → 素材根目录」已删，2026-10-02）
    flatDir: '',
    updatedAt: 0,
    items: [],        // 素材整理产出的叶子目录条目
    compliance: { rows: [], stats: null, scannedAt: 0 },
    verify: { rows: [], checkedAt: 0 },
    sheet: { file: '', rowCount: 0, colCount: 26, locked: false, exportedAt: 0 },
    publish: { rows: [], connected: false, running: false, startedAt: 0 }
  };
}

let state = blank();

function file() { return path.join(app.getPath('userData'), 'project.json'); }

function load() {
  try {
    const raw = fs.readFileSync(wp.toLong(file()), 'utf8');
    state = Object.assign(blank(), JSON.parse(raw));
    state.items = healItems(state.items);   // 旧工程里的错货号/颜色，开场就纠正（见 healItems）
  } catch (e) { /* 首次启动 */ }
  return state;
}

function get() { return state; }

function patch(p) {
  state = Object.assign(state, p || {});
  // ★ 每次变更都把 items 过一遍自愈：工程状态可能是**旧版程序**留下的（或者本进程启动后
  //   才换上的新程序），只在 load() 那一次纠正是不够的 —— 见 healItems。
  state.items = healItems(state.items);
  state.updatedAt = Date.now();
  broadcast();
  scheduleSave();
  return state;
}

function reset() {
  state = blank();
  broadcast();
  scheduleSave();
  return state;
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('project:changed', state);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file());
    } catch (e) { /* 只读盘等场景静默降级 */ }
  }, 400);
}

module.exports = { load, get, patch, reset, broadcast };
