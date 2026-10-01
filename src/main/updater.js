'use strict';
/**
 * 应用自动更新（阶段 1：单通道 = 正式源 stable）
 *
 * ★★ 两条「不许顺手加上」的铁律，改这个文件前先读一遍：
 *
 *   1. **绝不自动重启安装**。这个工具随时可能在跑批量发布（一跑几十分钟），
 *      静默重启会把任务拦腰截断，而且发到一半的批次没有回滚。所以一律
 *      「下载好 → 界面上点『立即安装』才真的重启」。electron-updater 的
 *      `autoInstallOnAppQuit` 也保持关闭 —— 否则用户下次关窗口时也会被装上。
 *
 *   2. **不在运行时改更新源地址**。源地址在打包时写进 `resources/app-update.yml`
 *      （在 asar 外面，编译进包）。electron-updater 官方明确不要 `setFeedURL`；
 *      而且测试版 / 正式版是靠**两个不同的源地址**隔离的，运行时能改就等于把
 *      两条通道混成一条，「测试版没验过的东西跑到正式版」就拦不住了。
 *
 * 设计上刻意做成「可注入」：`init()` 收依赖、`_setUpdater()` 收假实现。
 * 这样 tools/updatertest.js 能在纯 Node 里把整个状态机跑一遍，
 * 不需要真的打包、也不需要真的连网。
 */
const logbus = require('./logbus');

/** 发现新版本**不**自动开始下载：包有 88 MB，先让人知道再下，别偷偷占带宽 */
const AUTO_DOWNLOAD = false;

/** 启动后延迟自检：先让窗口起来、把该干的活干上，别和启动抢 IO */
const STARTUP_DELAY_MS = 20 * 1000;

/** 便携版的判据：electron-builder 的 portable target 会设这两个环境变量 */
function portableExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR || '';
}

const state = {
  supported: false,   // 这个包到底能不能自动更新（开发模式 / 便携版 = false）
  status: 'idle',     // idle|checking|available|downloading|ready|uptodate|error
  current: '',        // 当前版本（app.getVersion()）
  latest: '',         // 源上发现的版本
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  message: '',
  at: 0,
  manual: false       // 这次是用户点的，还是启动自检
};

let send = () => {};
let autoUpdater = null;
let loadErr = '';
let timer = null;
let started = false;
let checking = false;

function snapshot() {
  return Object.assign({}, state);
}

function broadcast() {
  state.at = Date.now();
  try { send('update:changed', snapshot()); } catch (e) { /* 窗口可能已经关了 */ }
}

/** 只在「状态真的变了」时才记日志：下载进度每秒好几条，全记会把日志刷没 */
function patch(p, log) {
  const changed = Object.keys(p).some(k => state[k] !== p[k]);
  Object.assign(state, p);
  if (changed && log) {
    const line = typeof log === 'function' ? log(snapshot()) : log;
    if (line) logbus.info(line);
  }
  broadcast();
  return snapshot();
}

/**
 * 把两个开关压成我们要的值。**必须在这里统一做**，不能只写在 loadUpdater 里 ——
 * 否则测试注入假实现时拿到的是另外一套默认值，「不许偷偷下载/安装」这条就验不到。
 */
function normalize(up) {
  up.autoDownload = AUTO_DOWNLOAD;          // ★ 不许自己下 88MB
  up.autoInstallOnAppQuit = false;          // ★ 见文件头铁律 1
  up.logger = null;                         // 它默认会往控制台刷一堆，没必要
  return up;
}

/**
 * 把 electron-updater 拿进来。**必须懒加载 + try**：
 * 开发模式（没打包）下它拿不到 app-update.yml，一 require 就可能抛；
 * 而「更新模块坏了」绝不该让整个应用起不来。
 */
function loadUpdater() {
  if (autoUpdater) return autoUpdater;
  if (loadErr) return null;
  try {
    autoUpdater = normalize(require('electron-updater').autoUpdater);
    wire(autoUpdater);
    return autoUpdater;
  } catch (e) {
    loadErr = (e && e.message) || String(e);
    return null;
  }
}

function wire(up) {
  up.on('checking-for-update', () => {
    patch({ status: 'checking', message: '正在检查更新…' });
  });
  up.on('update-available', info => {
    const v = (info && info.version) || '';
    patch({ status: 'available', latest: v, percent: 0 },
      s => `发现新版本 ${s.current} → ${v}（还没下载；要下就在「设置 → 应用更新」里点「下载更新」）`);
  });
  up.on('update-not-available', info => {
    const v = (info && info.version) || state.current;
    patch({ status: 'uptodate', latest: v, message: '已经是最新版本' },
      s => (s.manual ? `检查更新：已是最新版本（${s.current}）` : ''));
  });
  up.on('download-progress', p => {
    patch({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Number(p && p.percent) || 0)),
      transferred: (p && p.transferred) || 0,
      total: (p && p.total) || 0,
      bytesPerSecond: (p && p.bytesPerSecond) || 0,
      message: '正在下载更新…'
    });
  });
  up.on('update-downloaded', info => {
    const v = (info && info.version) || state.latest;
    // ★ 到这里**什么都不做**，只把状态改成「可安装」等用户点。见文件头铁律 1
    patch({ status: 'ready', latest: v, percent: 100, message: '已下载完成，可以安装' },
      s => `新版本 ${v} 已下载完成。点「立即安装」才会重启生效（不会自动重启）`);
  });
  up.on('error', err => {
    const msg = (err && err.message) || String(err || '未知错误');
    patch({ status: 'error', message: msg }, () => `检查更新失败：${msg}`);
  });
}

/**
 * @param {object} opts
 * @param {(ch:string, payload:any)=>void} opts.send  事件广播（主进程里 = 发给所有窗口）
 * @param {boolean} opts.packaged                     app.isPackaged
 * @param {string}  opts.version                      app.getVersion()
 * @param {(ms:number, fn:Function)=>{}} [opts.setTimer] 便于测试注入
 */
function init(opts) {
  const o = opts || {};
  if (o.send) send = o.send;
  if (o.version) state.current = o.version;
  if (o.setTimer) timer = o.setTimer;

  const dev = o.packaged === false;
  const port = portableExe();

  if (dev) {
    state.supported = false;
    state.status = 'idle';
    state.message = '开发模式（未打包）不检查更新：自动更新只在安装版里生效';
    return snapshot();
  }
  if (port) {
    // 便携版是「每次启动自解压到临时目录」的，装不了更新 —— 如实说，别给个点了没用的按钮
    state.supported = false;
    state.status = 'idle';
    state.message = '当前是便携版，不支持自动更新；要用自动更新请改装安装版（…-x64-win.exe）';
    return snapshot();
  }

  state.supported = true;
  state.status = 'idle';
  state.message = '';
  return snapshot();
}

/** 启动后延迟自检一次（只做一次，别写成定时轮询 —— 那是给常驻服务用的） */
function scheduleStartupCheck() {
  if (started || !state.supported) return false;
  started = true;
  timer = timer || setTimeout;
  timer(STARTUP_DELAY_MS, () => { check({ manual: false }); });
  return true;
}

async function check(opts) {
  const manual = !!(opts && opts.manual);
  if (!state.supported) return { ok: false, error: state.message || '这个版本不支持自动更新' };
  if (checking) return { ok: false, error: '正在检查中，稍等一下' };
  if (state.status === 'downloading') return { ok: false, error: '正在下载更新，下载完再检查' };

  const up = loadUpdater();
  if (!up) return { ok: false, error: `更新模块不可用：${loadErr}` };

  checking = true;
  patch({ manual });
  try {
    await up.checkForUpdates();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    patch({ status: 'error', message: msg }, () => `检查更新失败：${msg}`);
    checking = false;
    return { ok: false, error: msg };
  }
  checking = false;
  return { ok: true };
}

async function download() {
  if (!state.supported) return { ok: false, error: state.message || '这个版本不支持自动更新' };
  if (state.status === 'downloading') return { ok: false, error: '正在下载中' };
  // 允许「idle → 直接下」：用户可能刚启动就点，还没走完一次检查
  const up = loadUpdater();
  if (!up) return { ok: false, error: `更新模块不可用：${loadErr}` };
  try {
    await up.downloadUpdate();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    patch({ status: 'error', message: msg }, () => `下载更新失败：${msg}`);
    return { ok: false, error: msg };
  }
  return { ok: true };
}

/** ★ 只有这一个入口会重启应用，而且必须由用户点。别在别处调 quitAndInstall */
async function install() {
  if (state.status !== 'ready') return { ok: false, error: '还没有下载完成的更新包' };
  const up = loadUpdater();
  if (!up) return { ok: false, error: `更新模块不可用：${loadErr}` };
  logbus.warn(`正在安装新版本 ${state.latest}，应用会立即重启`);
  // 不 await：quitAndInstall 正常路径下会把进程带走，await 后面的代码不保证执行
  up.quitAndInstall(false, true);
  return { ok: true };
}

const status = () => snapshot();

/* ---- 以下两个只在测试里用 ---- */
/** 注入假实现。**必须走和真身同一条 normalize**，否则测出来的开关状态不是真的 */
function _setUpdater(fake) { autoUpdater = normalize(fake); loadErr = ''; wire(autoUpdater); return autoUpdater; }
function _reset() {
  autoUpdater = null; loadErr = ''; timer = null; started = false; checking = false;
  Object.assign(state, {
    supported: false, status: 'idle', current: '', latest: '', percent: 0,
    transferred: 0, total: 0, bytesPerSecond: 0, message: '', at: 0, manual: false
  });
}

module.exports = {
  init, scheduleStartupCheck, check, download, install, status,
  portableExe, AUTO_DOWNLOAD, STARTUP_DELAY_MS,
  _setUpdater, _reset
};
