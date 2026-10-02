'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
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
const adb = require('./services/adb');
const video = require('./services/video');

// Windows 通知/任务栏分组需要显式 AppUserModelID
if (wp.isWin()) app.setAppUserModelId('com.bluev.publisher');

const DEV = process.argv.includes('--dev');

/**
 * 随包分发的第三方文件放哪：打包后在 `resources/<name>`，开发运行时在仓库 `vendor/<name>`。
 * （`extraResources` 把 `vendor/adb`、`vendor/adbkeyboard` 原样搬到 resources 下，不经 asar。）
 */
function vendorDir(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), 'vendor', name);
}

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
    // adb：手填路径 > 程序内置（vendor/adb → 打包后 resources/adb）> 系统 PATH。
    // 内置那份是为了「新同事装上就能用，不用自己去模拟器安装目录里翻 adb.exe」。
    // 中文输入法 apk 也内置，探测页给「一键装上」按钮。
    adb.setAdbPath(store.get('publish.adbPath'));
    adb.setBundledAdbDir(vendorDir('adb'));
    adb.setBundledApkPath(path.join(vendorDir('adbkeyboard'), 'ADBKeyboard.apk'));
    // ffmpeg：同一套三段解析（手填 > 内置 > 系统 PATH）。得物只收 mp4，所以非 mp4 的视频
    // 要能就地转 —— 内置那份（GPL-3.0 静态版，见 vendor/README.md）是「装上就能用」的关键。
    video.setFfmpegPath(store.get('publish.ffmpegPath'));
    video.setBundledFfmpegDir(vendorDir('ffmpeg'));
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
      version: app.getVersion(),
      // 通道偏好从配置里读。非法值 updater 自己会忽略并落回 stable
      channel: store.get('update.channel'),
      // 更新日志（默认关，界面可开）：路径 + 上次的开关偏好。开启后会把 electron-updater
      // 自己的 logger 一并收进文件 —— 「差分下载静默退回全量」只有那里看得见
      logFile: ipc.updateLogFile(),
      logEnabled: !!store.get('update.log')
    });
    // 通道权限复核：勾了「记住我」时启动就已经登录了，这里要把上一次留下的测试版通道按权限收回
    // （否则普通成员一开机就在测试版通道上收测试包，而他连那个按钮都看不见）
    ipc.syncChannelPermission();

    const upSt = updater.status();
    if (upSt.supported) {
      updater.scheduleStartupCheck();
      logbus.info(`自动更新已启用 · 当前 ${upSt.current} · 通道「${upSt.channelLabel}」· 启动约 ${Math.round(updater.STARTUP_DELAY_MS / 1000)} 秒后自检一次（下载/安装都要手动点）`);
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
