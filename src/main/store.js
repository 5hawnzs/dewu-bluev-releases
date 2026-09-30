'use strict';
/** 配置持久化：写在 userData/config.json，卸载时保留（nsis deleteAppDataOnUninstall=false） */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const wp = require('./util/winpath');

let cache = null;
let saveTimer = null;

function file() { return path.join(app.getPath('userData'), 'config.json'); }

function defaults() {
  const d = wp.defaultPaths();
  return {
    projectName: 'TW男装 蓝V',
    paths: { source: d.source, output: d.output, rejected: d.rejected },
    // 真机做法：扁平名用 _ 连接层级路径；原素材完全不动（不改名、不移动）
    flatten: { mode: 'auto', connector: '_', touchOriginal: false, withStamp: true },
    // 真机规格：必须 JPG / ≥1764 像素²(约42×42) / 边长 150~1500 / 超限自动等比缩放 / 视频按扩展名判 .mp4 且 <600s
    compliance: {
      maxImageMB: 10, maxVideoSec: 600, isolateJunk: true,
      requireJpg: true, minPixels: 1764, minSide: 150, maxSide: 1500,
      autoScale: true, videoExtMustBeMp4: true
    },
    copy: {
      concurrency: 6,
      rotateStrategy: 'F01-F10 轮换',
      requiredTopic: '#TW男装',
      extraTopics: 4,
      brand: 'TW男装',                 // 真机有「品牌管理」，文案生成按品牌取词
      promptFilter: '',                // 筛选排序提示词
      promptWrite: '',                 // 文案生成提示词
      llm: { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini', temperature: 0.9 },
      pool: { 品类: ['#TW男装', '#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活', '#日常搭配'] }
    },
    // 真机是调接口查得物后台（SKU APIKey），查不到仅告警不阻断
    verify: {
      useImageColor: true, autoApproveKnown: true,
      mode: 'local',
      api: { endpoint: '', apiKey: '' }
    },
    publish: {
      device: '',                      // 选中的设备 serial（多设备矩阵）
      devices: [],                     // [{id, name, serial}] 一个设备 = 一个账号
      intervalSec: 60,                 // 真机是固定 1 分钟间隔，带倒计时
      intervalMinSec: 60,
      intervalMaxSec: 60,
      retry: 2,
      mock: true,
      mockIntervalSec: 5
    },
    window: { bounds: null, maximized: false },
    ui: { theme: 'system' }
  };
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  cache = defaults();
  try {
    const raw = fs.readFileSync(wp.toLong(file()), 'utf8');
    cache = mergeDeep(cache, JSON.parse(raw));
  } catch (e) { /* 首次启动 */ }
  return cache;
}

function get(key) {
  const c = load();
  if (!key) return c;
  return key.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
}

function set(patch) {
  cache = mergeDeep(load(), patch);
  scheduleSave();
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, file());
    } catch (e) { /* 只读盘等场景静默降级 */ }
  }, 250);
}

module.exports = { get, set, load, defaults, file };
