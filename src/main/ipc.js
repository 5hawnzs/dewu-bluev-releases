'use strict';
const { ipcMain, dialog, shell, app, BrowserWindow, nativeTheme } = require('electron');
const store = require('./store');
const project = require('./project');
const logbus = require('./logbus');
const jobs = require('./jobs');
const auth = require('./auth');
const imaging = require('./services/imaging');
const pool = require('./services/pool');
const wp = require('./util/winpath');

function win() {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return w && !w.isDestroyed() ? w : null;
}

/** 业务通道一律要先登录；静态信息/外观/窗口控制类通道放行 */
function guard(fn) {
  return async (e, ...args) => {
    if (!auth.enabled()) return fn(e, ...args);
    if (!auth.current()) return { ok: false, error: '未登录或登录已过期，请重新登录' };
    return fn(e, ...args);
  };
}

function register() {
  // ---- 账号与登录：登录页本身要用，不设门禁 ----
  ipcMain.handle('auth:status', () => auth.status());
  ipcMain.handle('auth:login', (_e, u, p, remember) => auth.login(u, p, remember));
  ipcMain.handle('auth:logout', () => auth.logout());
  ipcMain.handle('auth:change-password', (_e, oldP, newP) => auth.changePassword(oldP, newP));
  ipcMain.handle('auth:users', () => auth.listUsers());
  ipcMain.handle('auth:create-user', (_e, input) => auth.createUser(input));
  ipcMain.handle('auth:update-user', (_e, id, patch) => auth.updateUser(id, patch));
  ipcMain.handle('auth:reset-password', (_e, id, newP) => auth.resetPassword(id, newP));
  ipcMain.handle('auth:remove-user', (_e, id) => auth.removeUser(id));

  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    isWin: wp.isWin(),
    arch: process.arch,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    engine: imaging.engineName(),
    hasHeif: imaging.hasHeif(),
    pool: { size: pool.size(), source: pool.get().source, updatedAt: pool.get().updatedAt },
    userData: app.getPath('userData')
  }));

  ipcMain.handle('config:get', guard((_e, key) => store.get(key)));
  ipcMain.handle('config:set', guard((_e, patch) => { store.set(patch); return store.get(); }));

  ipcMain.handle('project:get', guard(() => project.get()));
  ipcMain.handle('log:history', guard(() => logbus.history()));

  ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, themeSource: nativeTheme.themeSource }));
  ipcMain.handle('theme:set', (_e, source) => { nativeTheme.themeSource = source || 'system'; return nativeTheme.shouldUseDarkColors; });

  ipcMain.handle('job:run', guard((_e, type, args) => jobs.run(type, args || {})));
  ipcMain.handle('job:cancel', guard((_e, type) => jobs.cancel(type)));
  ipcMain.handle('job:busy', guard((_e, type) => jobs.busy(type)));

  ipcMain.handle('dialog:dir', guard(async (_e, opts) => {
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: (opts && opts.title) || '选择目录',
      defaultPath: (opts && opts.defaultPath) || store.get('paths.source'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('dialog:file', guard(async (_e, opts) => {
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: (opts && opts.title) || '选择文件',
      defaultPath: (opts && opts.defaultPath) || undefined,
      filters: (opts && opts.filters) || [{ name: '商品池', extensions: ['csv', 'tsv', 'txt', 'json'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('shell:open', guard(async (_e, p) => {
    if (!p) return false;
    const err = await shell.openPath(p);
    return err === '' ? true : err;
  }));
  ipcMain.handle('shell:reveal', guard((_e, p) => { if (p) shell.showItemInFolder(p); return true; }));

  // ---- 窗口控制（自绘标题栏） ----
  ipcMain.on('win:min', () => { const w = win(); if (w) w.minimize(); });
  ipcMain.on('win:toggle-max', () => {
    const w = win(); if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('win:close', () => { const w = win(); if (w) w.close(); });
  ipcMain.handle('win:is-max', () => { const w = win(); return w ? w.isMaximized() : false; });
  ipcMain.on('win:flash', () => { const w = win(); if (w) w.flashFrame(true); });
}

module.exports = { register };
