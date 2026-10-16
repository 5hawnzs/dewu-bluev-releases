'use strict';
const { app, BrowserWindow, crashReporter } = require('electron');
const path = require('path');
const store = require('./store');
const project = require('./project');
const logbus = require('./logbus');
const winmod = require('./window');
const ipc = require('./ipc');
const auth = require('./auth');
const wp = require('./util/winpath');
const imaging = require('./services/imaging');
const pool = require('./services/pool');
const adb = require('./services/adb');
const video = require('./services/video');
const dewuapk = require('./services/dewuapk');   // 内置的得物 App 安装包（模拟器商店搜不到得物时用）
const cloudsync = require('./services/cloudsync');

// Windows 通知/任务栏分组需要显式 AppUserModelID
if (wp.isWin()) app.setAppUserModelId('com.bluev.publisher');

const DEV = process.argv.includes('--dev');

/**
 * ★★ 2026-10-17 用户报的「unknown software exception (0x80000003)」：
 *    远程桌面/向日葵这类环境下 GPU 进程反复退出，Chromium 数到上限直接 FATAL 掉**整个程序**
 *    （Windows 上 FATAL = __debugbreak = 就是这个弹框），发布跑到一半会被它带走。
 *    开关必须在单实例判断与 app.whenReady **之前**挂上（晚了 Electron 根本不认），
 *    理由与实测记录见 startupflags.js 顶部。
 *    同时装上崩溃留档：下次万一还有原生崩溃，日志里能说出是哪个进程、什么原因。
 */
const startupflags = require('./startupflags');
const crashguard = require('./crashguard');
crashguard.install({
  app, crashReporter, logbus,
  userData: app.getPath('userData'),
  build: require('./githubupdates').BUILD
});
const startup = startupflags.apply({ app, log: message => logbus.warn(message) });
if (startup.disabled) {
  logbus.info('图形环境：已关掉硬件加速与独立 GPU 进程（软件渲染），避免发布途中被图形进程崩溃带走', null, { tier: 'detail' });
}

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

  app.whenReady().then(async () => {
    store.load();
    // ★★ 配置迁移必须**说出来**（不许静默改用户配置）：旧版把 90/180 写进 config.json，
    //    1.0.9 的默认值虽已改成 0，但 mergeDeep 顶不动老值 ⇒ 这里做一次性归零并如实告知。
    for (const m of store.takeMigrations()) logbus.warn(m);
    // ★ 主题必须先定下来再建窗口：窗口底色 bgColor() 按它算，晚了会先闪一下别的色（见 window.normTheme）
    winmod.applyStoredTheme();
    project.load();
    auth.load();          // 正式包云端登录；开发模式仍可用临时本地 auth.json
    // adb：手填路径 > 程序内置（vendor/adb → 打包后 resources/adb）> 系统 PATH。
    // 内置那份是为了「新同事装上就能用，不用自己去模拟器安装目录里翻 adb.exe」。
    // 中文输入法 apk 也内置；设备连接并在线后由设备检查自动安装、启用。
    adb.setAdbPath(store.get('publish.adbPath'));
    adb.setBundledAdbDir(vendorDir('adb'));
    adb.setBundledApkPath(path.join(vendorDir('adbkeyboard'), 'ADBKeyboard.apk'));
    // 得物 App 安装包也内置一份：MuMu 自带的应用商店里**搜不到得物**，
    // 这一份是"核过 md5 的现成安装包"，设置页给「下载到本机 / 装进模拟器」两个按钮。
    dewuapk.setBundledDir(vendorDir('dewu'));
    // ffmpeg：同一套三段解析（手填 > 内置 > 系统 PATH）。得物只收 mp4，所以非 mp4 的视频
    // 要能就地转 —— 内置那份（GPL-3.0 静态版，见 vendor/README.md）是「装上就能用」的关键。
    video.setFfmpegPath(store.get('publish.ffmpegPath'));
    video.setBundledFfmpegDir(vendorDir('ffmpeg'));
    // 启动时预检本机视频工具，并为已选设备（或唯一在线设备）自动准备中文输入法。
    // 多台设备且未选择时不猜目标；设备连接/检查时还会再自动准备。
    video.version().then(v => {
      if (v) logbus.info(`视频依赖就绪：${v}`);
      else logbus.error(`视频依赖不可用：${video.status().path || '未找到 ffmpeg'}，非 MP4 视频将无法自动转换`);
    }).catch(e => logbus.error(`视频依赖检查失败：${e.message}`));
    (async () => {
      try {
        if (!(await adb.version())) {
          logbus.error(`模拟器连接依赖不可用：adb 找不到或无法启动（${adb.getActiveAdb().path}）`);
          return;
        }
        const list = await adb.devices();
        const selected = store.get('publish.device') || '';
        let target = selected ? list.find(d => d.serial === selected && d.state === 'device') : null;
        if (!selected) {
          const candidates = new Map();
          for (const device of list.filter(d => d.state === 'device')) {
            const installed = await adb.packages(device.serial);
            if (!installed.some(p => /shizhuang|duapp|poizon|dewu/i.test(p))) continue;
            const id = await adb.shell(device.serial, 'settings get secure android_id');
            const identity = id.ok && String(id.stdout || '').trim() && String(id.stdout).trim() !== 'null'
              ? String(id.stdout).trim() : device.serial;
            if (!candidates.has(identity)) candidates.set(identity, device);
          }
          if (candidates.size === 1) target = candidates.values().next().value;
        }
        if (!target) {
          logbus.info(selected ? `设备依赖待准备：已选设备 ${selected} 当前不在线`
            : '设备依赖待准备：请连接并选择一台模拟器');
          return;
        }
        const r = await adb.ensureKeyboard(target.serial);
        if (r.ok) logbus.ok(`设备依赖就绪：${target.serial} 的内置中文输入法${r.alreadyReady ? '已启用' : '已自动安装并启用'}`);
        else logbus.error(`设备依赖配置失败：${target.serial} 的中文输入法（${r.step}）：${r.error}`);
      } catch (e) {
        logbus.error(`设备依赖检查失败：${e.message}`);
      }
    })();
    ipc.register();

    const st = await auth.status();
    const w = winmod.createWindow(st.requireLogin && !st.user);   // 未登录：直接以「登录小窗」开场
    winmod.attach();

    logbus.info(`工具就绪 · ${wp.isWin() ? 'Windows' : process.platform} · 图片引擎 ${imaging.engineName()}`);
    // ★★ 2026-10-08：这条原来是 `warn`，前提是「缺 sharp/libheif 才是异常」——
    //   现在 hasHeif() 恒 false（预编译 libvips 因专利不带 HEVC 解码器，实测见 imaging.js），
    //   于是它**每次启动都会成立**。它是本工具的固定事实、不是故障，所以：
    //   ① 级别降成 info（沉在日志里，不冒告警吓人）；② 文案改成「该怎么办」。
    if (!imaging.hasHeif()) {
      logbus.info('HEIC(HEVC) 不支持：素材里的 .heic 会被标为「需先转 JPG」交人工，不阻断其它环节');
    }

    // 安装包由维护者手动提供；应用启动时不访问分发服务器。

    logbus.info(st.requireLogin
      ? (st.user ? `已登录：${st.user.displayName}（${st.user.role === 'admin' ? '管理员' : '成员'}）` : '登录校验已开启，请输入账号密码')
      : '登录校验已关闭（BLUEV_NO_LOGIN=1）');

    // 云端协作：只推新增发布结果与任务起止摘要，**发布本身不依赖它**。
    // 没启用就一次都不联网；启用了也是本机主动往外推，不开端口、不接收指令。
    cloudsync.start();
    if (store.get('cloud.enabled')) {
      logbus.info(`云端同步已开启 · 每 ${store.get('cloud.intervalSec') || 30} 秒推一次发布结果与任务摘要`);
    }

    w.once('ready-to-show', () => { if (DEV) w.webContents.openDevTools({ mode: 'detach' }); });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const s = await auth.status();
        const nw = winmod.createWindow(s.requireLogin && !s.user);
        winmod.attach(nw);
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ★★ 退出前必须**同步**落盘（2026-10-08 用户要求：「记住最后一次选的皮肤，下次打开默认还是它」）。
 *
 * 原来这里写的是 `store.set({})` —— 那是**假兜底**：store.set 内部只是
 * scheduleSave() 再排一个 **250ms 防抖定时器**，而进程退出根本等不到它。
 * 实测：点顶栏「玻璃」图标后 **60ms** 关窗口，磁盘上 `ui.theme` 仍是旧值 `'light'`
 * ⇒ 用户会以为「皮肤选了没记住」。⇒ 改成 store.flush()：取消定时器并当场 writeFileSync。
 * （顺带把窗口尺寸、品牌选择等所有 250ms 内的改动一起救回来。）
 */
app.on('before-quit', () => {
  for (const error of require('./services/sleepguard').releaseAll()) logbus.warn(`退出时解除防睡眠保护失败：${error}`);
  try { store.flush(); } catch (e) { /* ignore */ }
});
