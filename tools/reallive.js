'use strict';
/* 真机「真发布」驱动：走**生产代码** publisher.run()，把当前发布队列真发出去。
   ─────────────────────────────────────────────────────────────────────────
   为什么需要它：App 的 GUI 在本沙箱里起不来（Electron 窗口被拦），
   但发布链路全在 src/main/services/publisher.js 里、不依赖窗口。
   本脚本就是把 jobs.js 里 `publish.run` 那一段**原样**搬出来跑：

     ★ 用**真配置**（不复制、不改 paths.output）——因为要真发、要写真台账。
     ★ 用**真素材**（project.items 指向的真实叶子目录）。
     ★ 走**真序列号** 127.0.0.1:16384。

   用法：
     node tools/reallive.js                # 按 project.publish.rows 全发
     node tools/reallive.js --dry          # 只走到「提交发布」前一步（不点提交）
     node tools/reallive.js --dry --route=fallback --reset
                                           # 强制走备用入口（动态流相机）；--reset 把已成功的行改回待发布
   前置：模拟器在线、得物已登录且停在首页。

   ★ 为什么要有 --route / --reset（2026-10-17）：
     · 主入口和备用入口必须**都能真机走通**。本机账号有「主页」按钮 ⇒ 不强制就永远只测主入口，
       而远端无主页按钮的账号走的正是备用那一段 —— 必须能指定路线单独验。
     · `publisher.runBatch` 只处理 `result !== '发布成功'` 的行（已回写的行不重复发布，这是产品口径）。
       想拿历史内容重跑就得先把那几行改回待发布 —— 所以 `--reset` 会**先备份 project.json**，
       再只清掉结果字段；配合 `--dry` 使用不会真的发出去。
*/
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const ROUTE = (process.argv.find(a => a.startsWith('--route=')) || '').slice('--route='.length);
const RESET = process.argv.includes('--reset');

// ---- 把 electron 换成薄壳：store/project/logbus 都只 require electron 的 app.getPath ----
const USERDATA = 'C:/Users/Administrator/AppData/Roaming/dewu-bluev-publisher';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return '__electron_stub__';
  return origResolve.call(this, request, ...rest);
};
const stub = {
  app: {
    getPath: () => USERDATA,
    getAppPath: () => ROOT,
    isPackaged: false,
    setAppUserModelId: () => {},
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  BrowserWindow: function () { return { webContents: { send: () => {}, on: () => {} }, on: () => {}, loadFile: () => {}, isMinimized: () => false, restore: () => {}, focus: () => {}, flashFrame: () => {}, show: () => {}, hide: () => {} }; },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openExternal: () => {}, openPath: () => {} },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {} }; },
  Notification: function () { return { show: () => {} }; },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) },
};
// ★ 2026-10-17：`project.patch()` 会 `BrowserWindow.getAllWindows()` 广播给界面。
//   干跑没有窗口 ⇒ 必须明确返回「一个窗口都没有」，否则 patch 直接 TypeError（实测踩到）。
stub.BrowserWindow.getAllWindows = () => [];
require.cache['__electron_stub__'] = { id: '__electron_stub__', filename: '__electron_stub__', loaded: true, exports: stub };

const store = require(path.join(ROOT, 'src/main/store'));
const project = require(path.join(ROOT, 'src/main/project'));
const logbus = require(path.join(ROOT, 'src/main/logbus'));
const publisher = require(path.join(ROOT, 'src/main/services/publisher'));
const adb = require(path.join(ROOT, 'src/main/services/adb'));

// ★★ 2026-10-04（踩过，必须记死）：**必须**把「内置 adb」告诉 adb 模块。
//   生产代码是在 `src/main/index.js:57` 调的：`adb.setBundledAdbDir(vendorDir('adb'))`。
//   这个脚本早期漏了这一句 ⇒ 生效 adb 退回 PATH 上那个 **MuMu 自带的 36.0.0**，
//   而它与仓库内置的 37.0.1 会**抢 5037**：谁后启动谁把 server 换掉 ⇒
//   正在跑的链路撞上「server 刚被换走」那一瞬 ⇒
//     `adb: device 'emulator-5554' not found` /「连当前前台都读不到」
//   而**真因被埋没**（报错只说读不到前台，像设备掉线，其实是我们用了错的 adb）。
//   ★ 教训：**测试驱动必须与生产用同一个 adb**，否则量出来的失败是环境的、不是产品的。
adb.setBundledAdbDir(path.join(ROOT, 'vendor', 'adb'));

store.load();
project.load();

console.log('adb = ' + adb.getActiveAdb().path + '（来源 ' + adb.getActiveAdb().source + '）');

const st = () => project.get();
const c = store.get('publish') || {};

// --reset：把「发布成功」的行改回待发布，好让 runBatch 真的跑它（只动结果字段，不动素材与文案）。
//   先备份 project.json —— 走的是真工程文件，改坏了要能一眼回退。
if (RESET) {
  const state0 = st();
  const rows0 = (state0.publish && state0.publish.rows) || [];
  const file = path.join(USERDATA, 'project.json');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = file + '.bak-before-reset-' + stamp;
  try {
    require('fs').copyFileSync(file, backup);
    console.log('★ --reset：已备份 ' + backup);
  } catch (e) { console.log('★ --reset：备份失败（继续）：' + e.message); }
  rows0.forEach(r => { r.result = ''; r.reason = ''; r.status = '待发布'; r.elapsed = 0; });
  project.patch({ publish: Object.assign({}, state0.publish, { rows: rows0 }) });
  console.log(`★ --reset：${rows0.length} 行已改回待发布`);
}

console.log('=== 本次要发的 ===');
const state = st();
const rows = (state.publish && state.publish.rows) || [];
rows.forEach(r => console.log(` seq${r.seq} ${r.id} | ${r.title} | goods=${JSON.stringify(r.goodsList)}`));
console.log('mode=', c.mode, '| device=', store.get('publish.device') || c.device, '| intervalSec=', c.intervalSec);
if (ROUTE) console.log('★ --route=' + ROUTE + '（main = 强制主入口，fallback = 强制动态流相机）');

const serial = process.argv.find(a => a.startsWith('--serial='))?.slice(9) || store.get('publish.device') || c.device || '127.0.0.1:16384';

// 组装 publisher.run 要的 state（与 jobs.js 一致：publish.rows + items + copyRows + verify）
const runState = {
  items: state.items || [],
  copyRows: state.copyRows || [],
  verify: state.verify || { rows: [] },
  publish: Object.assign({}, state.publish, {
    device: serial,
    mode: 'adb',
    // 不传 --route 就保持工程里的设置（与 App 行为一字不差）。
    forceAlternateEntry: ROUTE === 'main' ? false : ROUTE === 'fallback' ? true : !!(state.publish || {}).forceAlternateEntry,
  }),
};
// dry：剔除「提交发布」那一步（与 pubsim 同一手法）
if (DRY) {
  const um = JSON.parse(JSON.stringify(c.uiMap || {}));
  for (const key of ['steps', 'videoSteps']) {
    if (um[key]) um[key] = um[key].filter(s => !/提交发布/.test(s.name || ''));
  }
  runState.publish.uiMap = um;
  console.log('★ DRY：已剔除「提交发布」步，不会真发');
}

let last = '';
const log = (m, lv) => { console.log(`[${lv || 'info'}] ${m}`); };

(async () => {
  await publisher.connect(serial);
  console.log('=== 开始 ===');
  const t0 = Date.now();
  // ★★ 2026-10-04：逐步计时（用户问「为什么选择素材 8s / 点关联好物 5s」）。
  //   publisher.run 把每一步的真实毫秒数推进这个数组；跑完按耗时倒序打出来。
  const stepTiming = [];
  await publisher.run(runState, {
    log,
    stepTiming,
    progress: (p) => { const s = `${p.done}/${p.total} ${p.label || ''}`; if (s !== last) { last = s; console.log('  · ' + s); } },
    onRow: (r) => { console.log(`  → seq${r.seq} ${r.dir} : ${r.status} ${r.result || ''} ${r.reason ? '(' + r.reason + ')' : ''}`); },
    cancelled: () => false,
    actor: { username: 'admin', displayName: '真机实测' },
    brand: { brandId: (state.publish && state.publish.brandId) || 'test', brandName: (state.publish && state.publish.brandName) || '真机实测' },
  });
  const total = (Date.now() - t0) / 1000;

  // ---- 逐步耗时表 --------------------------------------------------------
  //  分两档看：①「每一步各花了多久」（看哪一步是开销大头）
  //            ②「同一步在各条之间差多少」（看是不是只有第 1 条慢 —— 第 1 条要「学」这一屏不 idle）
  if (stepTiming.length) {
    console.log('\n=== 逐步耗时（按耗时倒序，只列 ≥0.3s 的）===');
    const byName = new Map();
    for (const t of stepTiming) {
      if (!byName.has(t.name)) byName.set(t.name, []);
      byName.get(t.name).push(t);
    }
    const rowsSum = new Map();
    for (const t of stepTiming) {
      const k = t.name;
      if (!rowsSum.has(k)) rowsSum.set(k, { name: k, total: 0, n: 0, max: 0, min: Infinity });
      const s = rowsSum.get(k);
      s.total += t.ms; s.n++; s.max = Math.max(s.max, t.ms); s.min = Math.min(s.min, t.ms);
    }
    [...rowsSum.values()]
      .map(s => ({ ...s, avg: s.total / s.n }))
      .filter(s => s.avg >= 300)
      .sort((a, b) => b.avg - a.avg)
      .forEach(s => {
        console.log('  ' + String(Math.round(s.avg)).padStart(6) + ' ms 均值 ×' + s.n
          + '  (min ' + Math.round(s.min) + ' / max ' + Math.round(s.max) + ')  ' + s.name);
      });
    const sum = stepTiming.reduce((a, b) => a + b.ms, 0);
    console.log('  ---- 界面步骤合计 ' + (sum / 1000).toFixed(1) + 's；其余（推素材/清相册/等间隔等）'
      + (total - sum / 1000).toFixed(1) + 's');
    console.log('\n=== 每一条里最慢的 5 步 ===');
    const byRow = new Map();
    for (const t of stepTiming) {
      if (!byRow.has(t.row)) byRow.set(t.row, []);
      byRow.get(t.row).push(t);
    }
    for (const [rowName, list] of byRow) {
      console.log('  [' + rowName + ']');
      list.slice().sort((a, b) => b.ms - a.ms).slice(0, 5)
        .forEach(t => console.log('    ' + String(Math.round(t.ms)).padStart(6) + ' ms  ' + t.name));
    }
  }

  console.log(`\n=== 结束，总耗时 ${total.toFixed(1)}s ===`);
  st().publish.rows.forEach(r => console.log(` seq${r.seq} ${r.id} → ${r.status} ${r.result} ${r.reason ? '(' + String(r.reason).slice(0, 80) + ')' : ''}`));
  process.exit(0);
})().catch(e => { console.error('★ 失败:', e && e.stack || e); process.exit(1); });
