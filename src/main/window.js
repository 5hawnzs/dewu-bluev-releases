'use strict';
/** 主窗口：Windows 无边框 + 自绘标题栏，尺寸/最大化状态持久化 */
const { BrowserWindow, nativeTheme, screen } = require('electron');
const path = require('path');
const store = require('./store');
const logbus = require('./logbus');

let win = null;
let saveTimer = null;

function createWindow() {
  const b = store.get('window.bounds') || {};
  const bg = nativeTheme.shouldUseDarkColors ? '#111113' : '#f2f1ed';

  win = new BrowserWindow({
    title: '得物蓝V 素材发布工具',
    width: clamp(b.width, 980, 2400, 1280),
    height: clamp(b.height, 640, 1600, 820),
    minWidth: 900,
    minHeight: 600,
    x: b.x,
    y: b.y,
    frame: false,                 // 自绘 Windows 标题栏（最小化/最大化/关闭在右上角）
    backgroundColor: bg,
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
    const max = store.get('window.maximized');
    if (max) win.maximize();
    win.show();
  });

  const save = () => {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const bb = win.getBounds();
      store.set({ window: { bounds: bb, maximized: win.isMaximized() } });
    }, 300);
  };
  win.on('resized', save);
  win.on('moved', save);
  win.on('maximize', () => store.set({ window: { maximized: true } }));
  win.on('unmaximize', () => store.set({ window: { maximized: false } }));

  win.on('maximize', () => win.webContents.send('win:max', true));
  win.on('unmaximize', () => win.webContents.send('win:max', false));

  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) win.webContents.send('theme:changed', theme());
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('theme:changed', theme());
  });

  return win;
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

module.exports = { createWindow, getWindow, attach, theme };
