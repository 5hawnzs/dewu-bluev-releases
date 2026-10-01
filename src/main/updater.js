'use strict';
/**
 * 应用自动更新（阶段 2：正式版 + 测试版两条通道，**同一个安装包**、运行时切）
 *
 * ★★ 两条「不许顺手加上」的铁律，改这个文件前先读一遍：
 *
 *   1. **绝不自动重启安装**。这个工具随时可能在跑批量发布（一跑几十分钟），
 *      静默重启会把任务拦腰截断，而且发到一半的批次没有回滚。所以一律
 *      「下载好 → 界面上点『立即安装』才真的重启」。electron-updater 的
 *      `autoInstallOnAppQuit` 也保持关闭 —— 否则用户下次关窗口时也会被装上。
 *
 *   2. **不在运行时改「源地址」**。源地址在打包时写进 `resources/app-update.yml`
 *      （在 asar 外面，编译进包）。electron-updater 官方明确不要 `setFeedURL`；
 *      换了就等于把所有已装客户端指到别处甚至直接失联，只能重发包。
 *
 *      ★ 但「**通道名**」是可以在运行时改的，而且是官方 API（见下面 `setChannel`）：
 *        同一个源地址下，通道名只决定读哪个清单文件 —— 正式版读 `latest.yml`、
 *        测试版读 `beta.yml`。源码依据（node_modules/electron-updater/out/）：
 *          · GenericProvider.get channel → `this.updater.channel || this.configuration.channel`
 *          · getChannelFilename(channel) → `${channel}.yml`，再拼到 `configuration.url` 后面
 *          · AppUpdater 有公开的 `set channel()`，注释原话：「Overrides `channel` in the
 *            update configuration.」
 *        ⇒ 所以「一个安装包 + 界面上勾选测试版」是成立的，不用出两个包、也不用重装。
 *        ★ 隔离性没有被破坏：正式版用户读的一直是 `latest.yml`，
 *          测试版没验过的东西不会自己跑到正式版去 —— 测试版是**显式 opt-in**。
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

/**
 * 界面上的通道名 → electron-updater 的 channel（也就是源上那个 yml 的文件名）。
 * ★ 源地址不在这个表里，也永远不进这个表 —— 源地址编译在包里（文件头铁律 2）。
 */
const CHANNELS = { stable: 'latest', beta: 'beta' };
const CHANNEL_LABEL = { stable: '正式版', beta: '测试版' };
const DEFAULT_CHANNEL = 'stable';

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
  manual: false,      // 这次是用户点的，还是启动自检
  channel: DEFAULT_CHANNEL,               // stable | beta（用户选的通道）
  channelLabel: CHANNEL_LABEL[DEFAULT_CHANNEL]
};

let send = () => {};
let autoUpdater = null;
let loadErr = '';
let timer = null;
let started = false;
let checking = false;
let channel = DEFAULT_CHANNEL;
/**
 * 「用户刚改过通道」的一次性放行。只在这一次检查里允许降级 —— 见 applyChannel。
 * 检查跑完（没抛异常）就复位。失败时保留，否则网络抖一下用户就再也没法等回正式版。
 */
let justSwitched = false;

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
 * 把「通道」落到实处。
 * ★ 这里改的是 **channel（= 读哪个 yml）**，**不是源地址** —— 源地址永远是包里
 *   `app-update.yml` 那个，运行时改不了也不许改（文件头铁律 2）。
 */
function applyChannel(up) {
  if (!up) return up;
  up.channel = CHANNELS[channel] || CHANNELS[DEFAULT_CHANNEL];
  // ★ 上面这句会踩到一个副作用：electron-updater 的 channel setter 会**顺手把
  //   allowDowngrade 设成 true**（源码注释原话：「allowDowngrade will be automatically
  //   set to true. If this behavior is not suitable for you, simple set allowDowngrade
  //   explicitly after.」）。放任它的后果是：正式版用户只要被人往源上放一个旧包，
  //   就会被**悄悄降级**。所以这里显式压回来，只给「用户刚切完通道」的那一次检查放行
  //   （从测试版回正式版必须允许降级，否则切了也回不去）。
  up.allowDowngrade = !!justSwitched;
  return up;
}

/**
 * 切换更新通道（正式版 / 测试版）。
 * ★ 只是换一个 yml 文件名：**源地址不变**，所以不会失联、也不用重发包、更不用重装。
 * 持久化由调用方负责（ipc.js 写 store），这里只保证内存状态和 updater 对象一致。
 */
function setChannel(next) {
  if (!CHANNELS[next]) {
    return { ok: false, error: `通道只能是 stable（正式版）或 beta（测试版），收到：${next}` };
  }
  if (next === channel) return { ok: true, channel, label: CHANNEL_LABEL[next], unchanged: true };

  const from = channel;
  channel = next;
  // ★ 只有「测试版 → 正式版」这一次需要允许降级 —— 正式版的版本号本来就比测试版小，
  //   不放行的话用户切了也回不去。反过来（正式 → 测试）**不许**降级：测试版理应是更新的，
  //   要是源上那份比本机还旧，那更该停下来让人看一眼，而不是默默把应用降下去。
  justSwitched = (from === 'beta' && next === 'stable');

  const up = loadUpdater();
  if (up) applyChannel(up);

  // ★ 切了通道，上一次的检查/下载结果就**不作数**了：
  //   已经下好的那个包是「另一条通道」的版本，装上去等于没切。
  const was = state.status;
  patch({
    status: (was === 'ready' || was === 'available' || was === 'downloading') ? 'idle' : was,
    channel,
    channelLabel: CHANNEL_LABEL[next],
    latest: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0,
    message: `已切到${CHANNEL_LABEL[next]}通道，下次检查按这条通道走`
  }, `更新通道：${CHANNEL_LABEL[from]} → ${CHANNEL_LABEL[next]}`);

  return { ok: true, channel, from, label: CHANNEL_LABEL[next] };
}

/**
 * @param {object} opts
 * @param {(ch:string, payload:any)=>void} opts.send  事件广播（主进程里 = 发给所有窗口）
 * @param {boolean} opts.packaged                     app.isPackaged
 * @param {string}  opts.version                      app.getVersion()
 * @param {string}  [opts.channel]                    持久化的通道偏好（stable|beta），非法值忽略
 * @param {(ms:number, fn:Function)=>{}} [opts.setTimer] 便于测试注入
 */
function init(opts) {
  const o = opts || {};
  if (o.send) send = o.send;
  if (o.version) state.current = o.version;
  if (o.setTimer) timer = o.setTimer;

  // 通道偏好先落地：不支持自动更新的情况下界面也要能显示「当前在哪条通道」
  if (o.channel && CHANNELS[o.channel]) channel = o.channel;
  state.channel = channel;
  state.channelLabel = CHANNEL_LABEL[channel];
  // updater 已经加载过的话（测试注入 / 热重入）顺手同步一次，别让它停在旧通道上。
  // ★ 这里**不主动 loadUpdater()**：init 阶段不该去碰 electron-updater（开发模式下它可能直接抛），
  //   真正的第一次使用是 check()，那次会重新落一遍。
  if (autoUpdater) applyChannel(autoUpdater);

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

  applyChannel(up);   // ★ 每次检查前都按「当前通道」重新落到 updater 上，别指望它记着
  checking = true;
  patch({ manual });
  try {
    await up.checkForUpdates();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    patch({ status: 'error', message: msg }, () => `检查更新失败：${msg}`);
    checking = false;
    // ★ 失败时**保留** justSwitched：网络抖一下就把「允许降级」用掉的话，
    //   从测试版切回正式版的用户会永远等不到降级
    return { ok: false, error: msg };
  }
  justSwitched = false;   // 这一次检查已经按「允许降级」跑过了
  applyChannel(up);       // ★ 立刻收回放行，别让 updater 长时间停在 allowDowngrade=true
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
  channel = DEFAULT_CHANNEL; justSwitched = false;
  Object.assign(state, {
    supported: false, status: 'idle', current: '', latest: '', percent: 0,
    transferred: 0, total: 0, bytesPerSecond: 0, message: '', at: 0, manual: false,
    channel: DEFAULT_CHANNEL, channelLabel: CHANNEL_LABEL[DEFAULT_CHANNEL]
  });
}

module.exports = {
  init, scheduleStartupCheck, check, download, install, status, setChannel, applyChannel,
  portableExe, AUTO_DOWNLOAD, STARTUP_DELAY_MS, CHANNELS, CHANNEL_LABEL, DEFAULT_CHANNEL,
  _setUpdater, _reset
};
