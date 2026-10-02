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

/* 登录门窗口：宽度 = 卡片 340 + 左右各 20；
   高度先给个兜底值，渲染层量出卡片实际高度后回调 fitGate() 收紧，避免上下留白 */
const GATE_WIDTH = 380;
const GATE_HEIGHT = 336;
const GATE_PAD_Y = 18;        // 卡片上下各留的呼吸位
// ★ 登录页固定浅色（渲染层 .gate 里也把浅色变量重声明了一遍）⇒ 窗口底色也必须跟着浅，
//   否则深色系统下会先闪一块近黑再被页面盖住。主界面仍跟随系统主题。
const GATE_BG = '#f2f1ed';

/** 主界面窗口底色：跟随系统深色 */
function bgColor() { return nativeTheme.shouldUseDarkColors ? '#111113' : '#f2f1ed'; }

function createWindow(locked) {
  const b = store.get('window.bounds') || {};
  const bg = bgColor();
  // 「正常几何」= 不做登录门收缩时本该用的那套尺寸/位置。
  // 开场就是小窗时也必须先把它记下来，否则登录成功后 setLoginMode(false) 没有还原目标，
  // 窗口会一直卡在 380 宽的小尺寸上（这条被 gateflow 的行为测试抓到过）。
  const normal = {
    width: clamp(b.width, 980, 2400, 1280),
    height: clamp(b.height, 640, 1600, 820)
  };
  if (b.x != null) normal.x = b.x;
  if (b.y != null) normal.y = b.y;
  loginMode = !!locked;           // 未登录：开场就是小窗，避免「先大后小」闪一下
  normalGeo = locked ? { bounds: normal, maximized: !!store.get('window.maximized') } : null;

  // 非登录门：开局几何也先夹回工作区，免得换了显示器后窗口落在屏幕外找不着
  const start = locked ? { width: GATE_WIDTH, height: GATE_HEIGHT } : fitToWorkArea(normal);

  win = new BrowserWindow({
    title: '得物蓝V 素材发布工具',
    width: start.width,
    height: start.height,
    minWidth: locked ? 320 : 900,
    minHeight: locked ? 320 : 600,
    x: start.x,
    y: start.y,
    resizable: !locked,           // 登录门是个「刚好装下卡片」的小窗，不允许拉伸
    maximizable: !locked,
    frame: false,                 // 自绘 Windows 标题栏（最小化/最大化/关闭在右上角）
    backgroundColor: locked ? GATE_BG : bg,   // 登录门是固定浅色，见 GATE_BG
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false   // 发布任务在后台也要走完
    }
  });

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
    win.setMinimumSize(320, 320);
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
    win.setMinimumSize(900, 600);
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
    themeSource: nativeTheme.themeSource
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

module.exports = { createWindow, getWindow, attach, theme, setLoginMode, fitGate, fitToWorkArea };
