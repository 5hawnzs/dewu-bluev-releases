'use strict';
/** 主窗口：Windows 无边框 + 自绘标题栏，尺寸/最大化状态持久化 */
const { BrowserWindow, nativeTheme, screen } = require('electron');
const path = require('path');
const store = require('./store');
const logbus = require('./logbus');

let win = null;
let saveTimer = null;
let loginMode = false;        // 登录门模式：窗口收缩成「刚好装下登录卡片」
let normalGeo = null;         // 进登录门前记住的正常几何，登录成功后原样还原

/* 登录门窗口：宽度 = 卡片宽 340（左右**不留边**）；高度先给兜底值，
   渲染层量出卡片实际高度后回调 fitGate() 收紧 —— 目标就是「窗口＝卡片」。
   ★ 2026-10-02 用户第三次反馈「登录框外面还有一块色块」⇒ 不再留呼吸位：
     卡片以外的每一像素都是多余底色，全部去掉。 */
const GATE_WIDTH = 340;
const GATE_HEIGHT = 336;
const GATE_PAD_Y = 0;         // 卡片外不留呼吸位（留了就露出一圈底色 = 用户说的「色块」）
// ★ 登录页固定浅色，且窗口＝卡片 ⇒ 窗口底色必须**与卡片同色（纯白）**。
//   深色系统下若还是近黑，会在卡片四周露出一圈（用户说的「黑边框」）；
//   浅色下若用米色 #f2f1ed，卡片四周一样会露出一圈（用户说的「色块」）。
//   主界面仍跟随系统主题（见 bgColor）。
const GATE_BG = '#ffffff';

/* 主窗口最小尺寸（★ 2026-10-03 实测定的数，不是拍的）：
   宽度：品牌统计页那张表需要 660px，加上侧栏 186px 与内容区左右边距 88px = 934。
        实测窗口 940 时表格不横滚、930 起开始横滚 ⇒ 取 960 留余量。
   高度：侧栏在 520 高就不需要滚动；640 让内容区第一屏还能多露出一块面板。
   ★★ 这个值**必须 > 900**：styles.css 里原本有条 @media (max-width:900px) 会把侧栏翻到顶上，
      而旧 minWidth 恰好也是 900 ⇒ 窗口一缩到最小就正好命中，侧栏跳上去（用户 2026-10-03 反馈）。
      那条断点已删，但**改小这个值之前务必先读 styles.css 末尾那段警告**。
   ★ 两处引用（createWindow 与 setLoginMode）都用这两个常量 —— 以前是各写一次 900/600，
     改一处漏一处就会「登录一次之后最小尺寸又变回去」。 */
const MAIN_MIN_W = 960;
const MAIN_MIN_H = 640;

/**
 * 主界面窗口底色：按**当前皮肤**（不是系统主题）—— 见 normSkin。
 * ★ 玻璃档必须返回**全透明**（`#00000000`）：窗口下面挂着系统亚克力（见 createWindow 的
 *   backgroundMaterial），底色不透明就把亚克力彻底盖死、一点也透不出来。
 *   浅色/深色照旧给实心色 —— 反正页面底色本来也是不透明的，两层一致。
 */
function bgColor() {
  if (normSkin(store.get('ui.theme')) === 'glass') return '#00000000';
  return nativeTheme.shouldUseDarkColors ? '#111113' : '#f2f1ed';
}

/**
 * 皮肤切换后重算窗口底色。
 * ★ 为什么非要有这个函数：切 深色→玻璃 时 `nativeTheme.themeSource` **没变**（两者在原生层都是
 *   dark，见 nativeForSkin）⇒ 那个 `nativeTheme.on('updated')` 根本不会触发 ⇒ 窗口底色会一直
 *   停在上一次的实心色，玻璃档就变成「界面透明、后面却是一块实心暗色」，亚克力透不出来。
 *   所以 theme:set / theme:toggle 必须显式叫一次它。
 */
function refreshBackdrop() {
  if (!win || win.isDestroyed() || loginMode) return;   // 登录门底色固定浅色（GATE_BG），不掺和
  win.setBackgroundColor(bgColor());
}

/**
 * 原生窗口那一层的主题口径（2026-10-03 用户拍板）：「app 颜色默认为浅色」，
 * 并且「跟随 Windows 设置」这一档取消。
 * ★ 判据只认 'dark'，别的（老配置里的 'system'、空值、写坏的值）**一律当浅色**：
 *   反过来写（只认 'light'）会让 'system' 落进「既不是浅也不是深」的缝里，
 *   那就又变回「跟着系统走」了 —— 正是这次要取消的东西。
 * ★★ 这个函数**只管两档**（原生窗口/滚动条/窗口底色），别把「玻璃」塞进来 ——
 *    玻璃是界面上的皮肤，在原生层按深色走即可（见 nativeForSkin）。
 */
function normTheme(v) { return v === 'dark' ? 'dark' : 'light'; }

/**
 * 界面皮肤口径（2026-10-08 用户要求）：「玻璃」和 日间 / 夜间 是**同一级别**的第三档，
 * 点顶栏那个按钮三档循环：浅色 → 深色 → 玻璃 → 浅色。
 * ★ 为什么不复用 normTheme：那个函数有测试盯着它「只认两档」，
 *   而且它表达的是「原生窗口该用深色还是浅色」，和「界面上用哪张皮」根本不是一回事。
 */
const SKINS = ['light', 'dark', 'glass'];
function normSkin(v) { return v === 'dark' ? 'dark' : (v === 'glass' ? 'glass' : 'light'); }
function nextSkin(v) { return SKINS[(SKINS.indexOf(normSkin(v)) + 1) % SKINS.length]; }

/**
 * 皮肤 → 原生窗口层面该走哪一档。玻璃是深色磨砂玻璃 ⇒ 窗口底色/滚动条/原生控件都按深色，
 * 免得出现「界面是玻璃、原生那块却是浅色」的半浅半深。
 */
function nativeForSkin(s) { return normSkin(s) === 'light' ? 'light' : 'dark'; }

/**
 * 把存下来的主题真正应用上。★ 必须在 createWindow **之前**调 ——
 * 窗口底色 bgColor() 就是按它算的，晚了会在深色系统上先闪一块近黑（用户要的是「默认浅色」）。
 */
function applyStoredTheme() {
  nativeTheme.themeSource = nativeForSkin(store.get('ui.theme'));
  return nativeTheme.themeSource;
}

function createWindow(locked) {
  const b = store.get('window.bounds') || {};
  const bg = bgColor();
  // 「正常几何」= 不做登录门收缩时本该用的那套尺寸/位置。
  // 开场就是小窗时也必须先把它记下来，否则登录成功后 setLoginMode(false) 没有还原目标，
  // 窗口会一直卡在 380 宽的小尺寸上（这条被 gateflow 的行为测试抓到过）。
  const normal = {
    // 下限跟随 MAIN_MIN_W（原来写死 980）：否则用户拖到 960 关掉再开会被悄悄抬回 980
    // ——「我明明缩过，怎么又变大了」。高度的 640 与 MAIN_MIN_H 本来就是同一个数。
    width: clamp(b.width, MAIN_MIN_W, 2400, 1280),
    height: clamp(b.height, MAIN_MIN_H, 1600, 820)
  };
  if (b.x != null) normal.x = b.x;
  if (b.y != null) normal.y = b.y;
  loginMode = !!locked;           // 未登录：开场就是小窗，避免「先大后小」闪一下
  normalGeo = locked ? { bounds: normal, maximized: !!store.get('window.maximized') } : null;

  // 非登录门：开局几何也先夹回工作区，免得换了显示器后窗口落在屏幕外找不着
  const start = locked ? { width: GATE_WIDTH, height: GATE_HEIGHT } : fitToWorkArea(normal);

  win = new BrowserWindow({
    title: '得物蓝V素材发布工具',
    width: start.width,
    height: start.height,
    minWidth: locked ? 340 : MAIN_MIN_W,
    minHeight: locked ? 320 : MAIN_MIN_H,
    x: start.x,
    y: start.y,
    resizable: !locked,           // 登录门是个「刚好装下卡片」的小窗，不允许拉伸
    maximizable: !locked,
    frame: false,                 // 自绘 Windows 标题栏（最小化/最大化/关闭在右上角）
    backgroundColor: locked ? GATE_BG : bg,   // 登录门是固定浅色，见 GATE_BG；玻璃档是全透明，见 bgColor
    // ★ 系统亚克力（Win11 的 DWM 材料）——「玻璃」档的磨砂就是它（模糊后的桌面壁纸）。
    //   ★★ 必须在这里（**建窗时**）挂上：实测运行时 `win.setBackgroundMaterial('acrylic')`
    //      会把窗口画成纯黑（探针 P3），所以只能在构造选项里定。
    //   ★ 浅色/深色档不会受影响：页面底色本就不透明（styles.css `body{background:var(--bg)}`），
    //     亚克力在它下面、被盖得严严实实。登录门同理（底色是纯白 GATE_BG）。
    //   ★ Win10 会忽略这个选项 ⇒ 玻璃档退化成「清晰透出桌面」（仍然能透，只是不磨砂）。
    backgroundMaterial: 'acrylic',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false   // 发布任务在后台也要走完
    }
  });

  require('./security').protectWindow(win.webContents);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (loginMode) {
      win.center();                     // 登录门：小窗居中，不读「上次最大化」
    } else {
      const max = store.get('window.maximized');
      if (max) win.maximize();
    }
    win.show();
  });

  const save = () => {
    if (!win || win.isDestroyed() || loginMode) return;   // 登录门的尺寸不落盘，免得覆盖用户正常的窗口大小
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const bb = win.getBounds();
      store.set({ window: { bounds: bb, maximized: win.isMaximized() } });
    }, 300);
  };
  win.on('resized', save);
  win.on('moved', save);
  win.on('maximize', () => { if (!loginMode) store.set({ window: { maximized: true } }); });
  win.on('unmaximize', () => { if (!loginMode) store.set({ window: { maximized: false } }); });

  win.on('maximize', () => win.webContents.send('win:max', true));
  win.on('unmaximize', () => win.webContents.send('win:max', false));

  nativeTheme.on('updated', () => {
    if (win.isDestroyed()) return;
    // 登录门期间窗口底色固定在浅色（见 GATE_BG），不跟着系统变
    if (!loginMode) win.setBackgroundColor(bgColor());
    win.webContents.send('theme:changed', theme());
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('theme:changed', theme());
  });

  return win;
}

/**
 * 把目标几何夹回「它所在的显示器工作区」内，且尺寸不超过工作区。
 * 场景：开场就是登录小窗（窗口被 win.center() 摆在屏幕正中），登录成功后尺寸跳回
 * 1280×820 —— 若直接沿用那个居中点，窗口右下会整块甩到屏幕外
 * （实测 1280×784 屏上超出右 450px / 下 258px，主界面被屏幕边缘切掉）。
 */
function fitToWorkArea(b) {
  const probe = {
    x: b.x != null ? b.x : 0,
    y: b.y != null ? b.y : 0,
    width: Math.round(b.width || 0) || GATE_WIDTH,
    height: Math.round(b.height || 0) || GATE_HEIGHT
  };
  const wa = screen.getDisplayMatching({
    x: probe.x, y: probe.y, width: probe.width, height: probe.height
  }).workArea;
  probe.width = Math.min(probe.width, wa.width);
  probe.height = Math.min(probe.height, wa.height);
  // 没记过位置 ⇒ 居中放；记过 ⇒ 先用原位置，最后统一夹回
  probe.x = b.x != null ? probe.x : wa.x + Math.round((wa.width - probe.width) / 2);
  probe.y = b.y != null ? probe.y : wa.y + Math.round((wa.height - probe.height) / 2);
  probe.x = Math.min(Math.max(probe.x, wa.x), wa.x + wa.width - probe.width);
  probe.y = Math.min(Math.max(probe.y, wa.y), wa.y + wa.height - probe.height);
  return probe;
}

/**
 * 登录门开关。
 *   开：记住当前窗口几何 → 收缩成刚好装下登录卡片的小窗（居中、禁拉伸、禁最大化）
 *   关：还原成登录前的尺寸/位置与最大化状态
 * 登录门期间的几何变化有意不写进 config.json（save() 在 loginMode 下直接返回），
 * 否则会出现「登录前 1280×820、退出登录再进来变成 380×336」。
 */
function setLoginMode(on) {
  if (!win || win.isDestroyed()) return;
  const next = !!on;
  if (next === loginMode) return;
  if (next) {
    normalGeo = { bounds: win.getBounds(), maximized: win.isMaximized() };
    loginMode = true;                     // 先置位：让下面的 unmaximize 不落盘
    if (win.isMaximized()) win.unmaximize();
    win.setMinimumSize(340, 340);
    win.setResizable(false);
    win.setMaximizable(false);
    win.setBackgroundColor(GATE_BG);      // 登录页固定浅色，窗口底色跟着走
    win.setBounds({ width: GATE_WIDTH, height: GATE_HEIGHT });
    win.center();
  } else {
    loginMode = false;
    win.setBackgroundColor(bgColor());    // 回主界面：底色交还给系统主题
    win.setResizable(true);
    win.setMaximizable(true);
    win.setMinimumSize(MAIN_MIN_W, MAIN_MIN_H);
    const g = normalGeo;
    normalGeo = null;
    if (g) {
      // 必须夹回工作区：登录小窗是居中的，尺寸一跳大就会把右下甩到屏幕外
      if (g.bounds) win.setBounds(fitToWorkArea(g.bounds));
      if (g.maximized) win.maximize();
    }
  }
}

/** 渲染层量出登录卡片的实际高度后回调：把窗口收紧到「卡片高度 + 上下呼吸位」 */
function fitGate(cardHeight) {
  if (!win || win.isDestroyed() || !loginMode) return;
  const raw = Math.round(Number(cardHeight) || 0) + GATE_PAD_Y * 2;
  if (!(raw > 0)) return;
  const target = Math.max(200, Math.min(760, raw));
  if (Math.abs(win.getBounds().height - target) < 2) return;
  win.setBounds({ height: target });
  win.center();
}

function theme() {
  return {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource,
    // ★ 界面皮肤的真值（light / dark / glass）。渲染层**必须**按这个切 class ——
    //   拿 shouldUseDarkColors 反推会把「玻璃」认成「深色」（它在原生层就是深色）。
    theme: normSkin(store.get('ui.theme'))
  };
}

function getWindow() { return win; }

function attach() {
  logbus.attach(win);
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!n || Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// MAIN_MIN 导出给自检用：断言「窗口缩到最小尺寸时侧栏仍在左侧」必须拿这个真值，
// 不能在测试里另写一个数字（两处各写一份 = 改了一处测试就假绿）。
module.exports = {
  createWindow, getWindow, attach, theme, normTheme, applyStoredTheme, setLoginMode, fitGate, fitToWorkArea,
  normSkin, nextSkin, nativeForSkin, SKINS, bgColor, refreshBackdrop,
  MAIN_MIN: { w: MAIN_MIN_W, h: MAIN_MIN_H }
};
