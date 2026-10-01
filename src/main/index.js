'use strict';
const { app, BrowserWindow } = require('electron');
const store = require('./store');
const project = require('./project');
const logbus = require('./logbus');
const winmod = require('./window');
const ipc = require('./ipc');
const auth = require('./auth');
const updater = require('./updater');
const wp = require('./util/winpath');
const imaging = require('./services/imaging');
const pool = require('./services/pool');

// Windows 通知/任务栏分组需要显式 AppUserModelID
if (wp.isWin()) app.setAppUserModelId('com.bluev.publisher');

const DEV = process.argv.includes('--dev');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = winmod.getWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
    w.flashFrame(true);
  });

  app.whenReady().then(() => {
    store.load();
    project.load();
    auth.load();          // 首次启动会建好管理员账号（userData/auth.json）
    ipc.register();

    const st = auth.status();
    const w = winmod.createWindow(st.requireLogin && !st.user);   // 未登录：直接以「登录小窗」开场
    winmod.attach();

    logbus.info(`工具就绪 · ${wp.isWin() ? 'Windows' : process.platform} · 图片引擎 ${imaging.engineName()}`);
    if (!imaging.hasHeif()) {
      logbus.warn('HEIC 解码不可用（缺少 sharp/libheif）：HEIC 会被标为需人工处理，不阻断其它环节');
    }
    logbus.info(`商品池：${pool.size()} 个货号（${pool.get().source}）`);

    // 自动更新：这里只「初始化 + 排一次延迟自检」。
    // 下载和安装都必须由用户在「设置 → 应用更新」里点 —— 见 updater.js 文件头的两条铁律
    updater.init({
      send: (ch, payload) => {
        for (const bw of BrowserWindow.getAllWindows()) {
          if (!bw.isDestroyed()) bw.webContents.send(ch, payload);
        }
      },
      packaged: app.isPackaged,
      version: app.getVersion()
    });
    const upSt = updater.status();
    if (upSt.supported) {
      updater.scheduleStartupCheck();
      logbus.info(`自动更新已启用 · 当前 ${upSt.current} · 启动约 ${Math.round(updater.STARTUP_DELAY_MS / 1000)} 秒后自检一次（下载/安装都要手动点）`);
    } else {
      logbus.info(`自动更新不可用：${upSt.message}`);
    }

    logbus.info(st.requireLogin
      ? (st.user ? `已登录：${st.user.displayName}（${st.user.role === 'admin' ? '管理员' : '成员'}）` : '登录校验已开启，请输入账号密码')
      : '登录校验已关闭（BLUEV_NO_LOGIN=1）');

    w.once('ready-to-show', () => { if (DEV) w.webContents.openDevTools({ mode: 'detach' }); });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const s = auth.status();
        const nw = winmod.createWindow(s.requireLogin && !s.user);
        winmod.attach(nw);
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { store.set({}); } catch (e) { /* ignore */ }
});
