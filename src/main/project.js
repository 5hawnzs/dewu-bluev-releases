'use strict';
/** 工程状态（单一数据源）：主进程持有，变更后广播给渲染层 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const wp = require('./util/winpath');
const store = require('./store');

let saveTimer = null;

function blank() {
  return {
    projectName: store.get('projectName') || '蓝V 项目',
    sourceDir: store.get('paths.source'),
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
  } catch (e) { /* 首次启动 */ }
  return state;
}

function get() { return state; }

function patch(p) {
  state = Object.assign(state, p || {});
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
