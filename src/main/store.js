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
    projectName: '蓝V 素材发布',
    paths: { source: d.source, output: d.output, rejected: d.rejected },
    // 品牌注册表：[{ id, name, enabled, note, createdAt }]，增删改与权限判定都在 src/main/brands.js
    // 品牌是跨模块维度（文案 / 发布单 / 发布日志 / 统计 / 账号权限），所以放在顶层而不是 copy 下面
    brands: [],
    // 是否已把旧的 `copy.brand` 迁进 brands。用标记而不是「数组为空就补」——
    // 否则管理员故意把品牌删空时，会被下一次启动悄悄塞回来
    brandsSeeded: false,
    // 真机做法：扁平名用 _ 连接层级路径；原素材完全不动（不改名、不移动）
    flatten: { mode: 'auto', connector: '_', touchOriginal: false, withStamp: true },
    // 真机规格：必须 JPG / ≥1764 像素²(约42×42) / 边长 150~1500 / 超限自动等比缩放 / 视频 <600s；
    // 视频格式：得物只收 mp4 ⇒ 非 mp4（.mov/.m4v/...）由内置 ffmpeg 自动转成 mp4（先无损转封装、不兼容再转码）
    compliance: {
      maxImageMB: 10, maxVideoSec: 600, isolateJunk: true,
      requireJpg: true, minPixels: 1764, minSide: 150, maxSide: 1500,
      autoScale: true, videoExtMustBeMp4: true
    },
    copy: {
      concurrency: 6,
      rotateStrategy: 'F01-F10 轮换',
      requiredTopic: '',              // 出厂留空：不预设任何品牌话题，在「设置 → 文案」里填
      extraTopics: 4,
      brand: '',                       // 【已降级为 legacy】出厂留空：不预设任何品牌；只在旧版本升级时作迁移种子
      defaultBrandId: '',              // 「设置 → 品牌管理」里选的默认品牌（brd_xxx），新建任务时预选
      promptFilter: '',                // 筛选排序提示词
      promptWrite: '',                 // 文案生成提示词
      llm: { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini', temperature: 0.9 },
      pool: { 品类: ['#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活', '#日常搭配', '#好物分享'] }   // 出厂只给不含品牌的品类词示例（要 6 个：与「额外话题 4」才够凑出 5 种互不相同的组合）
    },
    // 真机是调接口查得物后台（SKU APIKey），查不到仅告警不阻断
    verify: {
      useImageColor: true, autoApproveKnown: true,
      mode: 'local',
      api: { endpoint: '', apiKey: '' }
    },
    publish: {
      // adb 可执行文件。空 = 自动（优先程序内置的，再退系统 PATH）；填了就用这个完整路径。
      // ★ 2026-10-02 起主界面不再摆这个输入框（内置即用，摆着只是干扰）；要手填去
      //   「设置 → 高级设置」（仅管理员）。自检里仍会回显当前用的到底是哪一个。
      adbPath: '',
      device: '',                      // 选中的设备 serial（多设备矩阵）
      devices: [],                     // [{id, name, serial}] 一个设备 = 一个账号
      intervalSec: 60,                 // 真机是固定 1 分钟间隔，带倒计时
      intervalMinSec: 60,
      intervalMaxSec: 60,
      videoIntervalSec: 90,            // 视频单条更慢（push 抖动大 + 上传久 + 还要等媒体库索引），间隔单独放宽
      videoIndexTimeoutSec: 180,       // 视频推上去后等「相册真的能看到」的上限；超时直接失败报出来，不硬点
      retry: 2,
      // ffmpeg 可执行文件。空 = 自动（优先内置、再退系统 PATH）。与 adbPath 同一套三段解析，
      // 实现在 src/main/services/video.js。同样只在「高级设置」里手填。
      ffmpegPath: ''
    },
    window: { bounds: null, maximized: false },
    ui: { theme: 'system' },
    // 自动更新的**通道偏好**。★ 只存通道名，**源地址永远编译在包里**（不许运行时改，见
    // src/main/updater.js 文件头铁律 2）；通道名只决定读源上哪个清单文件：正式版 latest.yml / 测试版 beta.yml。
    // 存 stable|beta；非法值由 updater.init() 忽略并落回 stable。
    // log = 更新日志开关（默认关）。开着的时候 updater 会把 electron-updater 自己的 logger
    // 一并接进 userData/logs/update.log —— 「差分下载静默退回全量」只有那里看得见。
    // ★ 它**不违**「数据不出本机」：只写版本号/通道名/字节数，不含素材、品牌、SKU。
    update: { channel: 'stable', log: false }
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
