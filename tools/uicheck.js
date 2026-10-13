/* 界面自检：用隐藏窗口加载真实渲染层，把 10 个页签切一遍，确认
     · 免登录（BLUEV_NO_LOGIN=1）能进主界面
     · 10 个页签都能渲染、标题对得上
     · 渲染层零控制台报错（含未捕获异常 / 未处理的 Promise）
     · 左侧「运行日志」页与底部日志栏**是同一份内容**，能筛、能真导出
   用法：npx electron tools/uicheck.js       （tools/run-all.sh 里就是这么调的）

   注意：userData 会被指到临时目录，不会动你本机的 config.json / auth.json / project.json。
   同理，运行日志的导出目录也会被临时改掉 —— 默认输出目录是「我的文档\输出\得物」，自检不许往那里写。
*/
const { app, BrowserWindow } = require('electron');
require('./test-runtime')({ app });
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// 界面自检隔离真实设备，自动刷新只读取空测试现场。
require(path.join(ROOT, 'src/main/services/emulators.js')).discover = async () => ({ instances: [], errors: [] });
require(path.join(ROOT, 'src/main/services/adb.js')).devices = async () => [];
process.env.BLUEV_NO_LOGIN = '1';   // 自检只验界面，账号逻辑有自己的测试
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-uicheck-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('disable-gpu');

// ★ 下标 = 页签编号 - 1。页签 5「发布单」2026-10-03 已按用户要求删除，编号**不重排**
//   ⇒ 第 5 位留 null 占位（否则 6~12 的标题会整体错位一格）。
const TABS = ['素材整理', '合规检查', '文案生成', null /* 货号颜色校验：全员隐藏 */, null /* 5 发布单：已删 */, '模拟器发布', '设置', '品牌统计', '品牌与权限', '运行日志', '高级设置', '本地词库', '更新日志'];
const errors = [];      // 会让自检失败
const notes = [];       // 只打印，不算失败（警告级）

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src/main/store.js'));
  const project = require(path.join(ROOT, 'src/main/project.js'));
  const logbus = require(path.join(ROOT, 'src/main/logbus.js'));
  const ipc = require(path.join(ROOT, 'src/main/ipc.js'));
  const auth = require(path.join(ROOT, 'src/main/auth.js'));
  const updater = require(path.join(ROOT, 'src/main/updater.js'));
  store.load();
  project.load();
  auth.load();
  ipc.register();

  // ---- 随包内置的外部依赖（adb / 中文输入法 apk）：文件在不在、和来源说明对不对得上 ----
  // 这两样是「新同事装上就能用」的前提，所以放在最前面验，后面的界面断言都建在它之上。
  const adbMod = require(path.join(ROOT, 'src/main/services/adb.js'));
  const videoMod = require(path.join(ROOT, 'src/main/services/video.js'));
  const VENDOR_ADB = path.join(ROOT, 'vendor', 'adb');
  const VENDOR_KBD = path.join(ROOT, 'vendor', 'adbkeyboard');
  const VENDOR_FF = path.join(ROOT, 'vendor', 'ffmpeg');
  const md5 = p => require('crypto').createHash('md5').update(fs.readFileSync(p)).digest('hex');
  const prov = ['adb/adb.exe', 'adb/AdbWinApi.dll', 'adb/AdbWinUsbApi.dll', 'adbkeyboard/ADBKeyboard.apk', 'ffmpeg/ffmpeg.exe', 'dewu/dewu_6.0.5.apk'].map(rel => {
    const p = path.join(ROOT, 'vendor', rel);
    if (!fs.existsSync(p)) return { rel, ok: false, md5: '' };
    const hex = md5(p);
    return { rel, ok: true, md5: hex, from: p };
  });
  ok('★ 内置 adb / 中文输入法 apk / ffmpeg 都在仓库里（这样才谈得上"装上就能用"）',
    prov.every(x => x.ok), prov.map(x => x.rel + (x.ok ? '✓' : '✗')).join(' '));
  const readmeTxt = fs.readFileSync(path.join(ROOT, 'vendor', 'README.md'), 'utf8');
  ok('★ 每个内置文件的 md5 都能在 vendor/README.md 里对上（二进制与来源说明不许各说各话）',
    prov.every(x => x.ok && readmeTxt.includes(x.md5)),
    prov.map(x => `${x.rel}=${x.md5.slice(0, 8)}…`).join(' '));
  ok('★ adb 的 Apache 2.0 许可与署名跟着一起进包（许可要求：附全文 + 保留 NOTICE）',
    fs.existsSync(path.join(VENDOR_ADB, 'LICENSE.txt')) && fs.existsSync(path.join(VENDOR_ADB, 'NOTICE.txt')),
    fs.readdirSync(VENDOR_ADB).join(' '));
  // ffmpeg 是 GPL-3.0：许可全文必须跟着一起进包（拿不到全文 = 合规说不清）
  ok('★ ffmpeg 的 GPL-3.0 许可全文跟着一起进包（许可要求：附全文）',
    fs.existsSync(path.join(VENDOR_FF, 'LICENSE.txt')) && /GNU GENERAL PUBLIC LICENSE/.test(fs.readFileSync(path.join(VENDOR_FF, 'LICENSE.txt'), 'utf8')),
    fs.readdirSync(VENDOR_FF).join(' '));
  const pkgJson = require(path.join(ROOT, 'package.json'));
  const erTxt = JSON.stringify((pkgJson.build && pkgJson.build.extraResources) || []);
  ok('★ 打包配置会把 vendor/adb、vendor/adbkeyboard、vendor/ffmpeg 搬进 resources/（否则内置了也进不了安装包）',
    erTxt.includes('vendor/adb') && erTxt.includes('vendor/adbkeyboard') && erTxt.includes('vendor/ffmpeg'), erTxt);
  ok('★ 内置文件不进 asar 的 files 列表（asar 是压缩归档，里面的 exe 不能执行）',
    !((pkgJson.build && pkgJson.build.files) || []).some(f => String(f).includes('vendor')),
    JSON.stringify((pkgJson.build && pkgJson.build.files) || []));
  // 照 index.js 的样子把路径接一次（uicheck 不走 index.js，不接的话界面 vendor 状态永远是空的）
  adbMod.setBundledAdbDir(VENDOR_ADB);
  adbMod.setBundledApkPath(path.join(VENDOR_KBD, 'ADBKeyboard.apk'));
  videoMod.setBundledFfmpegDir(VENDOR_FF);
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  ok('★ 主进程启动时确实把这些路径注了进去（漏接 = 白内置）',
    /setBundledAdbDir\(/.test(idxSrc) && /setBundledApkPath\(/.test(idxSrc) && /setBundledFfmpegDir\(/.test(idxSrc),
    `setBundledAdbDir=${/setBundledAdbDir\(/.test(idxSrc) ? '有' : '缺'} · setBundledApkPath=${/setBundledApkPath\(/.test(idxSrc) ? '有' : '缺'} · setBundledFfmpegDir=${/setBundledFfmpegDir\(/.test(idxSrc) ? '有' : '缺'}`);
  // ffmpeg 是**真的能执行**才叫内置成功（存着但跑不起来 = 假内置）
  ok('★ 内置那份 ffmpeg 真能跑起来（不是只把文件放那儿）',
    videoMod.status().source === 'bundled' && videoMod.status().usable, JSON.stringify(videoMod.status()));

  // ★★ 2026-10-08 新增：**得物 App 安装包**（MuMu 自带的应用商店里搜不到得物 ⇒ 设置页给两个按钮）。
  //   与 adb/ffmpeg 同一套口径：文件在不在、代码里的常量与实际文件对不对得上、打包配置搬不搬。
  const dewuMod = require(path.join(ROOT, 'src/main/services/dewuapk.js'));
  dewuMod.setBundledDir(path.join(ROOT, 'vendor', 'dewu'));
  const dStat = dewuMod.status();
  const dProv = prov.find(x => x.rel === 'dewu/dewu_6.0.5.apk') || { ok: false, md5: '' };
  ok('★ 得物安装包也随包内置了（仓库里那份在，且大小与 dewuapk.js 里写死的 BYTES 一致）',
    dStat.exists && dStat.sizeOk && dProv.ok,
    `exists=${dStat.exists} bytes=${dStat.bytes} expect=${dStat.expectBytes}`);
  // 三处必须一致：实际文件算出来的 md5 / 代码里写死的 MD5 / vendor/README.md 台账里那一行。
  // 少一处对账，「发给每个人的是不是同一份」就没人能核（md5 只能证明没被换过，见 vendor/README.md）
  ok('★ 得物安装包三处对账一致：实际文件 md5 == dewuapk.js 里的 MD5 == vendor/README.md 台账',
    dProv.md5 === dewuMod.MD5 && readmeTxt.includes(dewuMod.MD5) && dStat.md5 === dewuMod.MD5,
    `file=${dProv.md5.slice(0, 8)}… · code=${dewuMod.MD5.slice(0, 8)}… · readme=${readmeTxt.includes(dewuMod.MD5) ? '有' : '缺'}`);
  ok('★ 打包配置会把 vendor/dewu 搬进 resources/dewu（否则"内置了"也进不了安装包）',
    erTxt.includes('vendor/dewu'), erTxt);

  // ★★ 2026-10-08 新增：这个包在仓库里是**分卷**存的 —— 单文件 133,315,131 字节（127.1 MiB）
  //   超过 Gitee / GitHub 的「单文件 100 MiB 上限」，实测会把**整次 push** 打回来
  //   （remote: ... size: 120.666MB, exceeds quota 100MB），gzip -9 压到 120.6 MiB 也过不去。
  //   所以切成 .part01/.part02 进 git，拼回来的单文件按需生成。这一段验三件事：
  //   ① 片段齐、字节数之和 == dewuapk.js 写死的 BYTES；② 每一片都 <100 MiB；
  //   ③ 拼接脚本在、且**接到了打包命令上**（少一处，「clone 下来就能打出带内置包的安装包」就不成立）。
  const DEWU_DIR = path.join(ROOT, 'vendor', 'dewu');
  const dewuParts = fs.readdirSync(DEWU_DIR).filter(f => f.startsWith(dewuMod.FILE + '.part')).sort();
  const partSize = f => fs.statSync(path.join(DEWU_DIR, f)).size;
  const partsSum = dewuParts.reduce((n, f) => n + partSize(f), 0);
  ok('★ 得物安装包是「分卷」存的，片段字节数之和 == dewuapk.js 里写死的 BYTES',
    dewuParts.length >= 2 && partsSum === dewuMod.BYTES,
    `parts=${dewuParts.length} sum=${partsSum} expect=${dewuMod.BYTES}`);
  ok('★ 分卷的每一片都小于 100 MiB（有一片越线，整次推送照样被远端拒）',
    dewuParts.length >= 2 && dewuParts.every(f => partSize(f) < 100 * 1024 * 1024),
    dewuParts.map(f => `${f}=${partSize(f)}`).join(' '));
  const asmPath = path.join(ROOT, 'tools', 'dewuapk-assemble.js');
  const scripts = pkgJson.scripts || {};
  // 顺着「打包命令 → npm run 的那个脚本 → 真正的文件」这条链查，不是只 grep 一个词。
  // ★ 第一版这里直接拿 /dewuapk-assemble/ 去匹配 dist:win，而 dist:win 里写的是 `npm run assemble:dewuapk`
  //   ⇒ 断言自己写错、造出一条**假红**（2026-10-08 实测踩到：产品接线是对的，红的却是测试）。
  //   同时钉住**顺序** —— 先拼后打；顺序反了 electron-builder 搬的还是不存在的那份，等于白接。
  const distWires = n => {
    const v = scripts[n] || '';
    const iAsm = v.search(/dewuapk-assemble|assemble:dewuapk/);
    const iBuild = v.indexOf('electron-builder');
    if (!(iAsm >= 0 && iBuild > iAsm)) return false;
    if (/dewuapk-assemble\.js/.test(v)) return true;
    return [...v.matchAll(/npm run\s+([^\s&|]+)/g)].some(m => /dewuapk-assemble\.js/.test(scripts[m[1].trim()] || ''));
  };
  ok('★ 拼接脚本在、打包命令**先拼后打**、且这一步真能落到脚本文件上（缺席 ⇒ 新机器 clone 后打不出带内置包的安装包）',
    fs.existsSync(asmPath) && distWires('dist:win') && distWires('dist:win-only'),
    `脚本=${fs.existsSync(asmPath) ? '在' : '缺'} · dist:win=${distWires('dist:win') ? '接上' : '没接'} · dist:win-only=${distWires('dist:win-only') ? '接上' : '没接'}`);
  // 两层一起看：① .gitignore 里有那条**精确规则**（内容级）② 真问一次 git 会不会把它收进去（行为级）。
  //   ★ 只留 ② 的话，机器上没 git 时 `check-ignore` 抛 ENOENT ⇒ 这一步会「空过」= 静默假绿，所以两层都要。
  const giTxt = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const giLine = /^\/vendor\/dewu\/dewu_6\.0\.5\.apk\s*$/m.test(giTxt);
  let ignoredReally = 'no-git';
  try {
    require('child_process').execFileSync('git', ['check-ignore', '-q', path.join('vendor', 'dewu', dewuMod.FILE)], { cwd: ROOT, stdio: 'ignore' });
    ignoredReally = true;
  } catch (e) {
    ignoredReally = e && e.code === 'ENOENT' ? 'no-git' : false;
  }
  ok('★ 拼回来的单文件真被 git 忽略（内容级 .gitignore 那条 + 行为级 git check-ignore；误 add 进去 = 远端拒收整次推送）',
    giLine && ignoredReally !== false,
    `.gitignore 那条=${giLine ? '在' : '缺'} · git check-ignore=${ignoredReally}`);

  // 播两个品牌：「提示词配置」里那组「选择 / 默认选择」的断言要有行可点。
  // 自检跑在临时 userData 上，碰不到本机的 config.json / auth.json
  const brands = require(path.join(ROOT, 'src/main/brands.js'));
  brands.add({ name: '自检品牌A', promptWrite: 'A 的口吻' });
  brands.add({ name: '自检品牌B', promptWrite: 'B 的口吻' });

  // 照 src/main/index.js 的样子把更新模块也初始化一次。
  // 不初始化的话 update:status 回的是「谁都没动过」的默认值（message 空），
  // 界面上「为什么不可用」那句真实原因就传不到，这一栏等于没测。
  // packaged=false（自检跑的是源码）⇒ 应当如实说「开发模式」。
  updater.init({ send: () => {}, packaged: app.isPackaged, version: app.getVersion() });

  const win = new BrowserWindow({
    show: false,                       // 隐藏窗口：不打断正在用电脑的人
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  logbus.attach(win);

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const where = sourceId ? ` (${String(sourceId).split('/').pop()}:${line})` : '';
    if (level >= 3) errors.push('[console] ' + message + where);
    else if (level === 2) notes.push('[warn] ' + message + where);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push('[preload] ' + p + '：' + err.message));
  win.webContents.on('render-process-gone', (_e, d) => errors.push('[renderer gone] ' + JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`[load] ${code} ${desc}`));

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));   // 等 boot() 把配置/工程/日志都取回来
  if (process.env.BLUEV_UPDATE_PREVIEW_ONLY === '1') {
    win.setSize(1280, 1000);
    win.showInactive();
    for (const stage of ['downloading', 'verifying', 'installing']) {
      await win.webContents.executeJavaScript(`state.info.version = '1.1.1'; state.update = { current: '1.1.1', status: '${stage}', percent: 47, message: '${stage === 'downloading' ? '正在下载安装包…' : stage === 'verifying' ? '正在校验安装包，请稍候…' : '校验完成，正在启动更新…App 即将退出，更新完成后自动打开'}' }; state.tab = 13; renderAll(); document.querySelector('#pane').scrollTop = 0;`);
      await new Promise(r => setTimeout(r, 700));
      fs.writeFileSync(path.join(ROOT, '../investigation-20261012/update-' + stage + '-preview.png'), (await win.webContents.capturePage()).toPNG());
    }
    console.log('PASS 更新进度三阶段预览已生成（仅预览，不替代完整回归）');
    app.exit(0); return;
  }
  if (process.env.BLUEV_FEEDBACK_PREVIEW_ONLY === '1') {
    win.setSize(1280, 900);
    await win.webContents.executeJavaScript(`state.tab = 7; renderAll(); document.querySelector('[data-act="feedback:open"]').click();`);
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(path.join(ROOT, '../investigation-20261012/feedback-preview.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS 反馈窗口预览已生成（仅预览，不替代完整回归）');
    app.exit(0); return;
  }
  if (process.env.BLUEV_RELEASE_PREVIEW_ONLY === '1') {
    win.setSize(1280, 1500);
    await win.webContents.executeJavaScript(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); state.info.version = '1.1.1'; state.tab = 13; renderAll(); document.querySelector('#pane').scrollTop = 0;`);
    await new Promise(r => setTimeout(r, 700));
    fs.writeFileSync(path.join(ROOT, '../investigation-20261012/changelog-preview.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS 更新日志预览已生成（仅预览，不替代完整回归）');
    app.exit(0); return;
  }

  // 文件夹工具按钮在系统开启「减少动态效果」时也必须继续慢速播放，不能整段停成静态。
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const folderMotion = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.folder-tool-link');
    const before = getComputedStyle(b, '::before'), after = getComputedStyle(b, '::after');
    const text = getComputedStyle(b.querySelector('.folder-tool-text'));
    return { names: [before.animationName, after.animationName, text.animationName],
      durations: [before.animationDuration, after.animationDuration, text.animationDuration] };
  })()`);
  await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  cdp.detach();
  ok('文件夹工具在系统减少动态效果时仍慢速播放渐变和外圈动画',
    folderMotion.names[0] === 'folder-tool-gradient' && folderMotion.names[1] === 'folder-tool-border-flow'
      && folderMotion.names[2] === 'folder-tool-gradient' && folderMotion.durations.every(x => x === '18s'),
    JSON.stringify(folderMotion));

  ok('左侧导航包含新增更新日志，共 11 个页签', await win.webContents.executeJavaScript('document.querySelectorAll(".nav").length') === 11,
    await win.webContents.executeJavaScript('document.querySelectorAll(".nav").length + " 个"'));
  ok('★「运行日志」确实排在「执行」组下面（不是随便接在末尾）',
    await win.webContents.executeJavaScript(`(() => {
      const navs = [...document.querySelectorAll('.side > *')];
      const iExec = navs.findIndex(e => e.className === 'grp' && e.textContent.trim() === '执行');
      const iLog = navs.findIndex(e => e.dataset && e.dataset.tab === '10');
      const iOther = navs.findIndex((e, i) => i > iExec && e.className === 'grp' && e.textContent.trim() === '其他');
      // 在「执行」这一个分组标题之后、下一个分组标题（其他）之前
      return iExec >= 0 && iLog > iExec && iOther > iLog;
    })()`));
  // 品牌和权限必须自成一块：设置页里不能再出现品牌管理 / 账号管理（2026-10-01 用户要求）
  const escapedBrandId = await win.webContents.executeJavaScript(`(() => {
    const before = state.brandsMeta;
    const id = 'x"><img id="audit-injected" src="x">';
    try {
      state.brandsMeta = { brands: [{ id, name: '测试品牌', enabled: true }], mine: [id] };
      const fragment = document.createElement('div');
      fragment.innerHTML = bmListHtml();
      return !fragment.querySelector('#audit-injected') && fragment.querySelector('[data-id]').dataset.id === id;
    } finally { state.brandsMeta = before; }
  })()`);
  ok('品牌 ID 含 HTML 字符时仍作为文本，不能注入控件', escapedBrandId);
  const moved = await win.webContents.executeJavaScript(`(async () => {
    const pane = () => document.querySelector('#pane').textContent;
    document.querySelector('.nav[data-tab="7"]').click();
    await new Promise(r => setTimeout(r, 150));
    const inSettings = { brand: /品牌管理/.test(pane()), acct: /账号与安全/.test(pane()) };
    document.querySelector('.nav[data-tab="9"]').click();
    await new Promise(r => setTimeout(r, 150));
    const t9 = pane();
    return { inSettings, t9brand: /品牌管理|我的品牌权限/.test(t9), t9acct: /账号与安全/.test(t9) };
  })()`);
  ok('设置页里不再有「品牌管理 / 账号与安全」（已挪走）',
    !moved.inSettings.brand && !moved.inSettings.acct, JSON.stringify(moved.inSettings));
  ok('页签 9「品牌与权限」里装的是品牌管理 + 账号与安全',
    moved.t9brand && moved.t9acct, JSON.stringify({ brand: moved.t9brand, acct: moved.t9acct }));
  ok('标题栏有「当前品牌」下拉（归属全靠它，必须一眼看得见）',
    await win.webContents.executeJavaScript('!!document.getElementById("brandSel")'));

  const locked = await win.webContents.executeJavaScript('document.body.classList.contains("locked")');
  ok('BLUEV_NO_LOGIN=1 免登录直接进主界面', locked === false, locked ? '仍停在登录页' : '');
  ok('登录校验确实关掉了（auth.enabled()===false）', auth.enabled() === false);

  // boot() 之后的交互阶段：把未捕获异常也收进来
  await win.webContents.executeJavaScript(`
    (() => {
      window.__errs = window.__errs || [];
      if (!window.__hooked) {
        window.__hooked = 1;
        window.addEventListener('error', e => window.__errs.push('error: ' + (e.message || '')));
        window.addEventListener('unhandledrejection', e => window.__errs.push('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)));
      }
      return true;
    })()
  `);

  // 页签 9 前面单独测过（品牌与权限）；10 是新增的「运行日志」。
  // ★ 页签 5「发布单」2026-10-03 已删 ⇒ 从遍历名单里去掉（编号不重排，5 是空位）。
  const phs = [];        // 收集各页签真实渲染出来的 placeholder（见下方守卫断言）
  for (const i of [1, 2, 3, 6, 7, 8, 10, 12]) {
    await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.nav[data-tab="${i}"]'); if (b) b.click(); return true; })()`);
    await new Promise(r => setTimeout(r, 150));
    const info = await win.webContents.executeJavaScript(`(() => {
      const pane = document.querySelector('#pane');
      const h2 = document.querySelector('#head h2');
      const ph = [...document.querySelectorAll('#pane [placeholder]')].map(e => e.getAttribute('placeholder'));
      return { size: pane ? pane.innerHTML.length : 0, title: h2 ? h2.textContent : '', ph };
    })()`);
    phs.push(...(info.ph || []));
    ok(`页签 ${i}「${TABS[i - 1]}」能渲染`, info.size > 20 && info.title === TABS[i - 1], `标题「${info.title}」· ${info.size} 字节`);
  }

  // ---- 工程状态 / 配置「不是数据」时，renderAll 不许白屏（2026-10-04 新增）----
  // 根因：主进程 guard() 拒绝时**返回 `{ok:false,error}`、不抛异常**，而 config:get / project:get
  //   都走这个 guard ⇒ 渲染层那句 `state.config = await appApi.configGet()` 会把**拒绝对象当成配置**
  //   存下来（会话失效 / 账号被停用后点「连接/使用设备」就会走到）。各页渲染又直接读深层字段
  //   （`project.compliance.stats` / `config.copy.rotateStrategy` / `config.publish.intervalSec`），
  //   读一层就抛 ⇒ **整页白屏、一句话都不给**。
  //   实测崩溃页数（tools/_rv-projectnull.js，11 页逐个 renderAll）：project=null 6 页 /
  //   config=null 5 页 / project=拒绝 2 页 / config=拒绝 2 页。
  // ★ 断言分三层，缺一层就是假绿：
  //   ① 正向对照：真值下同一圈遍历必须**每页都真渲染**（证明遍历真跑了，不是空==空）；
  //   ② 四种坏形状下逐页 renderAll 都不许抛；
  //   ③ 坏形状下每页都得有交代（写清原因的壳 或 登录页），不许留白。
  const shield = await win.webContents.executeJavaScript(`(() => {
    const DENY = { ok: false, error: '未登录或登录已过期，请重新登录' };
    const ALL = [1, 2, 3, 6, 7, 8, 9, 10, 11, 12];
    const good = { project: JSON.parse(JSON.stringify(state.project)), config: JSON.parse(JSON.stringify(state.config)) };
    const clone = o => JSON.parse(JSON.stringify(o));
    const run = (proj, cfg) => {
      const res = { threw: [], shell: 0, gate: 0, rendered: 0, said: '' };
      const keep = { p: state.project, c: state.config, t: state.tab };
      state.project = proj; state.config = cfg;
      for (const k of ALL) {
        if (!TABS[k]) continue;
        state.tab = k;
        try {
          renderAll();
          const paneTxt = (document.querySelector('#pane') || {}).textContent || '';
          if (document.body.classList.contains('locked')) res.gate++;
          else if (/先不渲染/.test(paneTxt)) { res.shell++; if (!res.said) res.said = paneTxt.slice(0, 60); }
          else res.rendered++;
        } catch (e) { res.threw.push(k + ':' + ((e && e.message) || e)); }
      }
      state.project = keep.p; state.config = keep.c; state.tab = keep.t;
      return res;
    };
    const out = {
      good: run(clone(good.project), clone(good.config)),
      pNull: run(null, clone(good.config)),
      cNull: run(clone(good.project), null),
      pDeny: run(DENY, clone(good.config)),
      cDeny: run(clone(good.project), DENY),
      back: run(clone(good.project), clone(good.config))
    };
    renderAll();
    return JSON.stringify(out);
  })()`);
  const sh = JSON.parse(shield);
  const bads = [['project=null', sh.pNull], ['config=null', sh.cNull], ['project=拒绝对象', sh.pDeny], ['config=拒绝对象', sh.cDeny]];
  ok('★ 正向对照：真值下 10 页**每页都真渲染**、一条异常都没有（证明下面那圈遍历真在跑，不是空==空）',
    sh.good.threw.length === 0 && sh.good.rendered === 10,
    `渲染 ${sh.good.rendered}/10 · 异常 ${sh.good.threw.length}${sh.good.threw.length ? ' → ' + sh.good.threw.join(',') : ''}`);
  ok('★★ 工程状态/配置「不是数据」时，renderAll 一页都不许抛（原来 project=null 崩 6 页、config=null 崩 5 页）',
    bads.every(([, r]) => r.threw.length === 0),
    bads.map(([n, r]) => `${n}:${r.threw.length ? '崩' + r.threw.length + '(' + r.threw[0] + ')' : '0'}`).join(' · '));
  ok('★★ 每种坏形状下每一页都要有交代（说清原因的壳 或 登录页）—— 不许留白',
    bads.every(([, r]) => r.shell + r.gate === 10),
    bads.map(([n, r]) => `${n}:壳${r.shell}+登录${r.gate}`).join(' · '));
  ok('★ 壳里把**原因**写出来了（拒绝的要说"未登录/已过期"，没读到的要说"还没读到"），不是一句"暂无数据"糊弄',
    sh.pDeny.said.indexOf('未登录') >= 0 && sh.cDeny.said.indexOf('未登录') >= 0
      && /还没读到/.test(sh.pNull.said) && /还没读到/.test(sh.cNull.said),
    JSON.stringify(bads.map(([n, r]) => [n, r.said])));
  ok('★ 自证还原：把真值放回去后 10 页照常渲染、零异常（这套探针自己没把界面弄坏）',
    sh.back.threw.length === 0 && sh.back.rendered === 10,
    `渲染 ${sh.back.rendered}/10 · 异常 ${sh.back.threw.length}`);

  // ---- 页签 12「本地词库」：真读 DOM 断言（不是看源码里有没有那行字）----
  // ★ 开发免登录状态也可编辑本机词库。
  //   管理员与普通成员的保存权限由 logintest 用真实会话覆盖。
  const lexPage = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="12"]').click();
    const pane = document.querySelector('#pane');
    for (let k = 0; k < 30 && !pane.querySelector('#lxg-风格'); k++) await new Promise(r => setTimeout(r, 100));
    const txt = pane.textContent;
    const h3 = [...pane.querySelectorAll('.box h3')].map(e => e.textContent);
    return {
      size: pane.innerHTML.length,
      title: document.querySelector('#head h2').textContent,
      hasRedlines: /三条红线/.test(txt),
      editableBoxes: h3.filter(t => /^(风格|氛围|色感|场景|人群|季节|情绪|收尾)（/.test(t)).length,
      lockedBox: h3.findIndex(t => t.indexOf('收尾') >= 0 && t.indexOf('锁定') >= 0),
      hasStyles: /T01/.test(txt) && /T15/.test(txt),
      inputs: pane.querySelectorAll('[data-lx-in]').length,
      addBtns: pane.querySelectorAll('[data-lx-add]').length,
      delBtns: pane.querySelectorAll('[data-lx-del]').length,
      hasXlsxHint: /Excel 工作簿（\.xlsx）/.test(txt),
      transferActions: [...document.querySelectorAll('#head [data-act^="lex:"]')].map(b => b.dataset.act),
      transferLabels: [...document.querySelectorAll('#head .lx-transfer')].map(b => b.textContent.trim()),
      statusText: (document.querySelector('#lxStatus') || {}).textContent || ''
    };
  })()`);
  ok('★ 页签 12「本地词库」能渲染出来', lexPage.size > 200 && lexPage.title === '本地词库', `${lexPage.title} · ${lexPage.size} 字节`);
  ok('★ 本地词库页常驻「三条红线」提示（材质/极限/别的平台名）', lexPage.hasRedlines === true);
  ok('★ 8 个可编辑组都在页面上（风格/氛围/色感/场景/人群/季节/情绪）',
    lexPage.editableBoxes === 8, String(lexPage.editableBoxes));
  ok('★ 收尾显示为可编辑词组，没有锁定块',
    lexPage.lockedBox === -1, '第 ' + (lexPage.lockedBox + 1) + ' 个 box');
  ok('★ T01~T15 句式骨架照实列出来（只读展示）', lexPage.hasStyles === true);
  ok('★ 开发免登录态可以编辑本机词库',
    lexPage.inputs === 8 && lexPage.addBtns === 8 && lexPage.delBtns > 0,
    `inputs=${lexPage.inputs} add=${lexPage.addBtns} del=${lexPage.delBtns}`);
  ok('★ 词库页明确标出仅在本机生效',
    /本机词库/.test(lexPage.statusText), lexPage.statusText.slice(0, 70));
  ok('★ 本地词库导入导出明确使用 Excel 工作簿',
    lexPage.hasXlsxHint && lexPage.transferActions.includes('lex:export') && lexPage.transferActions.includes('lex:import'),
    JSON.stringify({ hint: lexPage.hasXlsxHint, actions: lexPage.transferActions }));
  ok('词库按钮仅显示「导出」「导入」', JSON.stringify(lexPage.transferLabels) === JSON.stringify(['导出', '导入']));


  // ---- 界面里不许再出现「别人家的品牌名」 ----
  // 给「清掉测试数据 + 示例品牌名」立个长期守卫：源码与**真实渲染出来的** placeholder
  // 都不许再冒出来。placeholder 不属于 textContent，只查页面文本必然漏掉这一批。
  const BAN = /(斯凯奇|UR视频|UR女人|skechers|卡宾|TW男装|TW女装)/i;
  const uiSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const srcHit = uiSrc.match(BAN);
  ok('★ 界面源码里没有举例品牌名（UR / 斯凯奇 / skechers / 卡宾 / TW男装…）', !srcHit, srcHit ? srcHit[0] : '');
  const phHit = phs.join(' | ').match(BAN);
  ok(`★ 渲染出来的 placeholder 里没有举例品牌名（查了 ${phs.length} 个输入框）`, !phHit, phHit ? phHit[0] : '');

  // ---- ★★ 产出类任务的「品牌归属」不许漏带（2026-10-03 实测事故）----
  // 现象：标题栏明明选着品牌，在「模拟器发布」页点「导入内容报告」却弹「请先选择品牌」。
  // 根因：BRAND_SCOPED_TYPES 里的任务本来都走 runJob()（在那里统一补 brandId），
  //       只有这一条是绕过 runJob、直接调 appApi.run 的 ⇒ 主进程收到的 brandId 是空的。
  // 判据：源码里**不许**再出现 `appApi.run('<产出类任务>'` 这种裸调用
  //       （只查代码行 —— 注释里正解释这件事，直接搜全文必然自命中）。
  {
    const codeOnly = t => t.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    const code = codeOnly(uiSrc);
    const bare = [];
    for (const t of ['copy.generate', 'report.import', 'sheet.export', 'publish.run', 'publish.rerun']) {
      // ★ 判据必须盯「有没有带 brandArgs」，不能只查「出现了什么字」——
      //   `appApi.run('x', brandArgs('x', …))` 里同样含 `appApi.run('x'` 这个子串，
      //   只查子串会把**已经修好的行**误判成漏点（2026-10-03 第一版就这么误报了一条假红）。
      //   ★ 另一个坑：`\s*(?!brandArgs\()` 的 `\s*` 能匹配空字符，前瞻会退到空位上做检查、恒真 ⇒
      //     好版也报红。负向前瞻必须**紧跟逗号**写：`,(?!\s*brandArgs\()`。
      if (new RegExp("appApi\\.run\\('" + t.replace('.', '\\.') + "',(?!\\s*brandArgs\\()").test(code)) bare.push(t);
    }
    ok('★★ 产出类任务（文案生成 / 导入内容报告 / 导出发布单 / 开始发布 / 发布重跑）都先过 brandArgs()，没有裸调 appApi.run 的漏点',
      bare.length === 0, bare.length ? '裸调用：' + bare.join(' / ') : '');
    ok('★ brandArgs() 就是「补上标题栏品牌」的那一处，且 runJob 也走它（只有一处逻辑，不会两边各写一遍）',
      /function brandArgs\(type, args\)/.test(code) && /const a = brandArgs\(type, args\);/.test(code));
  }

  // ---- 「演示节奏（mock）」这个纯演示开关已按用户要求整条删除 ----
  // ★ 光删勾选框不够：出厂 mock=true 时**真实发布**也会用 5 秒间隔。
  //   所以这里连源码里对 cfg.mock 的读取一起查（只查代码行，避免注释命中 —— 注释里正解释这件事）。
  {
    // 判据：把**注释**（// 与 /* */）和 `'mock'` 这个字符串字面量都剥掉之后，这四个文件里
    // 不该再出现 mock。★ 为什么不能直接搜 mock：`mode === 'mock'` 是「没设备时的模拟通道」，
    // 与被删的「演示节奏」是两件事 —— 一刀切会把它误报成没删干净。
    const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
      .replace(/'mock'/g, "''").replace(/"mock"/g, '""');
    const hits = [];
    for (const rel of ['src/main/store.js', 'src/main/jobs.js', 'src/main/services/publisher.js',
      'src/renderer/app.js']) {
      if (/\bmock\b/i.test(strip(fs.readFileSync(path.join(ROOT, rel), 'utf8')))) hits.push(rel);
    }
    ok('★「演示节奏（mock）」整条链路已删（配置默认值 + 主进程/界面所有读取点，注释与模拟通道除外）',
      hits.length === 0, hits.join(' / '));
    // 界面上的勾选框与「演示节奏」字样也要真没了（placeholder 不算 textContent，所以另查源码）
    const uiSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    ok('★ 界面上没有 mock 勾选框、也没有「演示节奏」字样',
      !/data-cfg="publish\.mock"/.test(uiSrc2) && !/演示节奏/.test(uiSrc2));
  }

  // ---- 本轮新加的按钮：按各自页签确认挂上了 ----
  const onTab = async (tab, act) => {
    await win.webContents.executeJavaScript(`document.querySelector('.nav[data-tab="${tab}"]').click()`);
    await new Promise(r => setTimeout(r, 100));
    return await win.webContents.executeJavaScript(`!!document.querySelector('[data-act="${act}"]')`);
  };
  ok('页签 2 有「导出报告」', await onTab(2, 'comp:export'));
  ok('页签 3 有「选择素材目录并启动任务」', await onTab(3, 'copy:pickRun'));
  // ★ 2026-10-08 用户要求删除页签 3 的「按当前素材生成」（原话：一般没点目录的时候不会有当前素材，
  //   两个功能重复了）。按老规矩**读真 DOM** 证明它真没了 —— 光删源码行不算。
  ok('★ 页签 3「按当前素材生成」已删除（DOM 里连按钮都不剩，不是藏起来）',
    !(await onTab(3, 'copy:run')));
  // 一并钉住**读取链**也真删了。★ 负向断言只认**代码行**：注释里会提到这串名字（解释为什么删），
  //   不剥注释就会把注释当命中去误报（老坑）。
  {
    const codeNoCmt = t => t.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
    const appCode = codeNoCmt(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8'));
    ok('★ 页签 3 的动作处理器 copy:run 已从渲染层源码删除（不是只藏按钮）',
      !/'copy:run'/.test(appCode) && !/"copy:run"/.test(appCode));
    const jobsCode = codeNoCmt(fs.readFileSync(path.join(ROOT, 'src', 'main', 'jobs.js'), 'utf8'));
    // ★ 判据要选**只属于被删分支**的写法。别拿「请先做素材整理」当判据 —— 那句还留在
    //   compliance.scan / verify.check 里（是共用文案），拿它判会**恒为真 ⇒ 假 FAIL**。
    ok('★ 主进程「拿当前工程 items 生成」那条分支已删（它独享的回写 copyRows 与 generate(st().items) 都没了）',
      !/copywriter\.generate\(st\(\)\.items/.test(jobsCode)
      && !/copyRows:\s*r\.rows/.test(jobsCode)
      && !/s0\.flatDir/.test(jobsCode));
    ok('★ 缺 sourceDir 时改为**显式报错**（不许 case 落空、静默返回 undefined）',
      /文案生成必须指定素材目录/.test(jobsCode));
  }
  // ★「发布单」页签 2026-10-03 已删（用户要求）。删了就必须**读真 DOM**证明它真没了 ——
  //   光删源码行不算，以后有人把按钮加回来、或 index.html 里留了个隐藏按钮，都发现不了。
  ok('★ 页签 5「发布单」已删除（导航里连按钮都不剩，不是藏起来）',
    await win.webContents.executeJavaScript(`!document.querySelector('.nav[data-tab="5"]')`));
  // ★ 它独有的三个功能必须还在、且落在「模拟器发布」页上 —— 否则就是「删干净了功能」。
  ok('★「导出 xlsx」已挪到页签 6「模拟器发布」（原发布单页唯一独有功能，不能删丢）', await onTab(6, 'sheet:export'));
  ok('★「打开文件 / 打开目录」也在页签 6（紧挨发布单路径那一行，没变成死代码）',
    (await onTab(6, 'sheet:open')) && (await onTab(6, 'sheet:dir')));
  ok('页签 6 有「重导出日志」', await onTab(6, 'pub:exportLog'));
  // ★ 2026-10-02：这几个「装一次就不再动」的入口按用户要求从日常页面收进「高级设置」。
  //   断言也跟着搬 —— 搬了就得能证明它**不在老地方了**，否则「收起来」等于没发生。
  // ★ 2026-10-03 用户要求：**失败恢复动作整块删除** —— 不是「从这一页挪到那一页」，而是哪一页都没有了。
  //   负向断言必须**真读 DOM**：光删源码行证明不了界面上真的没有这个入口。
  ok('★「失败恢复动作」已整块删除：任何一页都点不到这个入口',
    !(await onTab(6, 'pub:recoverEdit')) && !(await onTab(11, 'pub:recoverEdit')));
  // 同批删掉的还有「失败重试 N 次」下拉（用户：发布失败**不重试**）
  const retryCfgGone = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="6"]').click();
    await new Promise(r => setTimeout(r, 150));
    return !document.querySelector('[data-cfg="publish.retry"]');
  })()`);
  ok('★「失败重试 N 次」下拉也已删除（页签 6 上没有 [data-cfg="publish.retry"]）', retryCfgGone === true);
  ok('页签 6 不再有「抓取页面结构」「导入 UI 定位表」',
    !(await onTab(6, 'pub:dump')) && !(await onTab(6, 'pub:map')));
  ok('页签 11 有「抓取页面结构」「导入 UI 定位表」',
    (await onTab(11, 'pub:dump')) && (await onTab(11, 'pub:map')));
  ok('页签 8 有「查询」（品牌统计）', await onTab(8, 'stats:refresh'));
  // ★ 2026-10-03 用户给的流程：「从模拟器发布的入口导入，选择发布间隔时间，点击开始发布」
  //   ⇒ 导入入口必须也能在这一页点到，而且这一页本来就有间隔下拉与开始发布。
  ok('页签 6 有「导入 AI 内容报告」（从模拟器发布的入口导入）', await onTab(6, 'sheet:importReport'));
  {
    const onSix = await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-cfg="publish.intervalSec"]')`);
    ok('页签 6 紧挨着就有「发布间隔」下拉（导入完接着选间隔 → 开始发布）', onSix === true);
    ok('页签 6 的「开始发布」还在', await onTab(6, 'pub:run'));
  }
  // ★ 2026-10-05：**内容主图**怎么定，必须在界面上看得见 —— 这是用户唯一能控制主图的入口，
  //   界面上找不到就等于这个功能没做（用户口径：标记用数字 1）。读真 DOM 的 innerText，
  //   不查源码字符串（源码里有不代表用户看得见）。
  {
    const mainHint = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-tab="6"]').click();
      await new Promise(r => setTimeout(r, 150));
      const el = document.getElementById('pane');
      const t = el ? el.innerText : '';
      return { hasMain: t.indexOf('内容主图') >= 0,
               hasFirst: t.indexOf('排在最前面那张') >= 0,
               hasMark: t.indexOf('以 1 开头') >= 0 };
    })()`);
    ok('★ 页签 6 界面上写清了「内容主图」怎么定（默认第 1 张 / 名字以 1 开头）',
      mainHint.hasMain && mainHint.hasFirst && mainHint.hasMark, JSON.stringify(mainHint));
  }

  // ---- ★ 主题：app 默认浅色 + 顶栏「项目」左边一点即切（用户 2026-10-03 要求） ----
  //   为什么不能只查源码里有没有这个按钮：位置错了（塞进设置页）、点了不生效（没走 IPC）、
  //   切了不落盘（下次启动忘掉）—— 三种都是「看起来做了」。这里全用真窗口真点一遍。
  //   ★ 2026-10-08 起是**三档**（日间 / 夜间 / 玻璃），控件是**Dock**（三个图标常驻、
  //     指针靠近按距离弹簧放大）。**不再是单键循环** ⇒ 这里改成「点某一档的图标，直接切到那一档」。
  //     ★ 只查 class 只能证明「class 切了」，证明不了「皮肤真换了」⇒ 玻璃那档配一条**实算证据**
  //       （.app 真的不再铺底色 + .side 真的是半透明底）。
  //     ★★ 玻璃的「磨砂」不是 CSS 给的，是**系统亚克力**（建窗时 backgroundMaterial:'acrylic'），
  //       做法是把页面底色挖空让它透上来 ⇒ 所以这里必须钉住「.app 透明」和「有 backgroundMaterial」，
  //       缺了任何一条，「玻璃」都会退化成一块实心暗色。
  //     ★ 弹簧放大不能只查源码（源码里写了 rAF ≠ 真会放大）⇒ 另配一条**真窗口实测**（见下面 mag）。
  const clickSkin = async (skin) => {
    await win.webContents.executeJavaScript(
      `document.querySelector('#themeDock .tdock[data-skin="${skin}"]').click()`);
    await new Promise(r => setTimeout(r, 320));
    return win.webContents.executeJavaScript(`(() => {
      const de = document.documentElement;
      const appEl = document.querySelector('.app');
      const sideEl = document.querySelector('.side');
      const sb = sideEl ? getComputedStyle(sideEl) : null;
      const onEl = document.querySelector('#themeDock .tdock.on');
      return {
        dark: de.classList.contains('dark'),
        glass: de.classList.contains('glass'),
        on: onEl ? onEl.dataset.skin : '',
        appBg: appEl ? getComputedStyle(appEl).backgroundColor : '',
        sideBg: sb ? sb.backgroundColor : '',
        sideBlur: sb ? (sb.backdropFilter || sb.webkitBackdropFilter || 'none') : 'none',
        bodyBg: getComputedStyle(document.body).backgroundColor
      };
    })()`);
  };

  const themeDom = await win.webContents.executeJavaScript(`(() => {
    const dock = document.getElementById('themeDock');
    const proj = document.getElementById('brandSel');
    return {
      found: !!dock && !!proj,
      sameParent: !!(dock && proj && dock.parentElement === proj.parentElement),
      beforeProj: !!(dock && proj && (dock.compareDocumentPosition(proj) & Node.DOCUMENT_POSITION_FOLLOWING) > 0),
      inTitlebar: !!(dock && dock.closest('.titlebar')),
      skins: dock ? [...dock.querySelectorAll('.tdock')].map(b => b.dataset.skin) : [],
      on: dock && dock.querySelector('.tdock.on') ? dock.querySelector('.tdock.on').dataset.skin : '',
      // 用户要求「不要新增（当前：日间 这种东西）」⇒ Dock 里只许有图标，不许有文字/标签元素
      text: dock ? dock.textContent.trim() : 'x',
      labelEls: dock ? dock.querySelectorAll('span,.chip,.label').length : -1,
      hasEmptyBtn: dock ? [...dock.querySelectorAll('.tdock')].some(b => !b.querySelector('svg')) : true,
      dark: document.documentElement.classList.contains('dark'),
      glass: document.documentElement.classList.contains('glass')
    };
  })()`);
  ok('★ 主题 Dock 在标题栏、位于品牌选择左边',
    themeDom.found && themeDom.sameParent && themeDom.beforeProj && themeDom.inTitlebar,
    JSON.stringify(themeDom));
  ok('★ Dock 正好三档、顺序是 日间→夜间→玻璃，且每个图标都画得出来（没有空按钮）',
    JSON.stringify(themeDom.skins) === JSON.stringify(['light', 'dark', 'glass']) && !themeDom.hasEmptyBtn,
    JSON.stringify({ skins: themeDom.skins, hasEmptyBtn: themeDom.hasEmptyBtn }));
  ok('★ Dock 里**只有图标**，没有任何文字/标签（用户：不要「当前：日间」那种东西）',
    themeDom.text === '' && themeDom.labelEls === 0,
    JSON.stringify({ text: themeDom.text, labelEls: themeDom.labelEls }));
  ok('★ app 默认浅色，且默认点亮的正是「日间」那一档',
    themeDom.dark === false && themeDom.glass === false && themeDom.on === 'light',
    JSON.stringify({ dark: themeDom.dark, glass: themeDom.glass, on: themeDom.on }));
  // 点「夜间」
  const skin1 = await clickSkin('dark');
  ok('★ 点 Dock 的「夜间」图标 → 切到夜间、点亮该档、并存进配置（下次启动还是这个）',
    skin1.dark === true && skin1.glass === false && skin1.on === 'dark' && store.get('ui.theme') === 'dark',
    JSON.stringify(skin1) + ' saved=' + store.get('ui.theme'));
  // 点「玻璃」（★ 第三档，与日/夜同级）
  const skin2 = await clickSkin('glass');
  ok('★ 点「玻璃」图标 → 切到第三档「玻璃」，点亮该档、也存进配置',
    skin2.glass === true && skin2.dark === false && skin2.on === 'glass' && store.get('ui.theme') === 'glass',
    JSON.stringify(skin2) + ' saved=' + store.get('ui.theme'));
  ok('★ 「玻璃」不只是换了个 class：页面底色真的挖空了（.app 透明 + body 透明）、.side 真的是半透明底',
    /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent/.test(skin2.appBg)
    && /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent/.test(skin2.bodyBg)
    && /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(skin2.sideBg),
    JSON.stringify({ appBg: skin2.appBg, bodyBg: skin2.bodyBg, sideBg: skin2.sideBg }));
  // 点回「日间」（把状态还给后面的用例）
  const skin3 = await clickSkin('light');
  ok('★ 点「日间」图标 → 转回日间，且**只有日间这一档被点亮**（选中态唯一）',
    skin3.dark === false && skin3.glass === false && skin3.on === 'light'
    && store.get('ui.theme') === 'light'
    && await win.webContents.executeJavaScript(`document.querySelectorAll('#themeDock .tdock.on').length`) === 1,
    JSON.stringify(skin3) + ' saved=' + store.get('ui.theme'));

  // ★★ 「按距离放大」分两层验：
  //   ① 映射本身（纯函数 dockGain）—— 确定性，不受 rAF 时序影响；
  //   ② 真窗口接线 —— 合成 pointer 事件，**轮询到收敛**。
  //   ⚠️ 为什么②不能「等固定时长再看」：隐藏窗口里 rAF 被节流且不稳（同一页面实测 2~170fps 都有，
  //      第一版写成固定等 500ms ⇒ 只走了 1 个积分步、断言读到 [0,0,0] 的假红）。
  {
    const map = await win.webContents.executeJavaScript(`(() => {
      const R = 52;
      return {
        has: typeof dockGain === 'function',
        at0: dockGain(0, R),            // 正下方：满增益
        atHalf: dockGain(R / 2, R),     // 半径一半
        atR: dockGain(R, R),            // 半径处：完全不放大
        beyond: dockGain(R * 3, R),     // 更远：仍不放大（已 clamp）
        mono: dockGain(10, R) > dockGain(30, R) && dockGain(30, R) > dockGain(50, R)
      };
    })()`);
    ok('★ 「距离→放大」是平滑单调衰减：正下方=1、半径一半=0.5、到半径就归零（纯函数实测）',
      map.has && Math.abs(map.at0 - 1) < 1e-9 && Math.abs(map.atHalf - 0.5) < 1e-9
      && Math.abs(map.atR) < 1e-9 && Math.abs(map.beyond) < 1e-9 && map.mono,
      JSON.stringify(map));

    const mag = await win.webContents.executeJavaScript(`(async () => {
      const dock = document.getElementById('themeDock');
      const items = [...dock.querySelectorAll('.tdock')];
      const cx = items.map(el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
      const read = () => items.map(el => (+el.style.getPropertyValue('--s')) || 1);
      dock.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      // 指针正对中间那个（夜间）
      dock.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx[1], clientY: 10 }));
      const t0 = Date.now();
      let hit = read();
      while (Date.now() - t0 < 8000 && !(hit[1] > 1.3 && hit[1] > hit[0] + 0.05 && hit[1] > hit[2] + 0.05)) {
        await new Promise(r => setTimeout(r, 120)); hit = read();
      }
      dock.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      const t1 = Date.now();
      let back = read();
      while (Date.now() - t1 < 8000 && !back.every(v => Math.abs(v - 1) < 0.02)) {
        await new Promise(r => setTimeout(r, 120)); back = read();
      }
      return { hit, back, ms: Date.now() - t0 };
    })()`);
    ok('★ 真窗口实测：指针正对的图标被放到最大、两侧更小（「按距离放大」真的生效，不是只写了源码）',
      mag.hit[1] > 1.3 && mag.hit[1] > mag.hit[0] + 0.05 && mag.hit[1] > mag.hit[2] + 0.05,
      JSON.stringify(mag));
    ok('★ 指针离开后三个图标都弹回 1（弹簧收尾、不留放大残留）',
      mag.back.every(v => Math.abs(v - 1) < 0.02), JSON.stringify({ back: mag.back, ms: mag.ms }));
  }
  {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    ok('★ 放大是**按需启停的 rAF 弹簧**：绝不挂常驻 rAF（收敛且指针离开就停）',
      /function bindThemeDock\(\)/.test(appSrc)
      && /if \(moving \|\| hot\) \{ raf = requestAnimationFrame\(frame\); \}/.test(appSrc)
      && /else \{ raf = 0; prev = 0; \}/.test(appSrc)
      && /bindThemeDock\(\);/.test(appSrc));
    ok('★ 弹簧按**真实 dt** 推进（不是每帧固定推 H 秒，否则手感会随帧率变）',
      /const dt = prev \? Math\.min\(\(now - prev\) \/ 1000, 0\.05\) : H;/.test(appSrc)
      && /const n = Math\.max\(1, Math\.min\(Math\.round\(dt \/ H\), 60\)\);/.test(appSrc));
    ok('★ 放大增益只走那一个纯函数 dockGain（自检测的就是它，不是另抄一份公式）',
      /function dockGain\(d, R\)/.test(appSrc) && /st\[i\]\.ts = 1 \+ \(TDOCK\.max - 1\) \* g;/.test(appSrc)
      && /const g = dockGain\(clientX - cx\[i\], TDOCK\.R\);/.test(appSrc));
  }
  {
    const cssSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
    ok('★ 旧单键的图标显隐规则已整段删除、新 Dock 样式已就位（不留「三档皮肤下仍只显一个图标」的死规则）',
      !/#themeBtn\b/.test(cssSrc2.replace(/\/\*[\s\S]*?\*\//g, ''))
      && /\.theme-dock \.tdock\{/.test(cssSrc2)
      && /\.theme-dock \.tdock\.on\{/.test(cssSrc2));
  }

  // 设置页那个下拉要**整条撤掉**（不是藏起来）：入口只留顶栏那一个，否则两处状态迟早各说各话
  const appSrcTheme = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  ok('★ 设置页「外观 → 主题」下拉已撤（themeSel 一个都不剩，含绑定代码）',
    !/themeSel/.test(appSrcTheme), (appSrcTheme.match(/themeSel/g) || []).length + ' 处');
  // ★ 2026-10-03 用户原话：「设置里的外观要直接隐藏掉，与最顶上的功能重复了」
  //   断言必须**读真 DOM**（切到设置页，看真正渲染出来的小标题）—— 源码里没有这个词，
  //   证明不了界面上没渲染它。并且必须配一条**正向对照**（得能读到「路径」「外部依赖」），
  //   否则页面万一没渲染，`不含外观` 就成了「空 == 空」的假绿。
  {
    await win.webContents.executeJavaScript(`document.querySelector('.nav[data-tab="7"]').click()`);
    await new Promise(r => setTimeout(r, 150));
    const setHeads = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#pane h3')].map(h => h.textContent.trim())`);
    // ★ 2026-10-04：「路径」块已按用户要求撤掉 ⇒ 这条「页面渲染出来了」的兜底判据换成
    //   仍真在的「外部依赖」（拿已撤掉的块当对照，就是「空==空」).
    ok('★ 设置页确实渲染出来了（有「外部依赖」这一块，不是空页面）',
      setHeads.includes('外部依赖'), JSON.stringify(setHeads));
    ok('★ 设置页里**不再有**「外观」这一块（用户要求：与顶栏主题按钮重复）',
      !setHeads.includes('外观'), JSON.stringify(setHeads));
    ok('★ 但「运行环境」没跟着一起丢（已挪进「外部依赖」）',
      await win.webContents.executeJavaScript(`/运行环境/.test(document.querySelector('#pane').innerText)`));

    // ★★ 2026-10-08 新增：得物安装包那一行（MuMu 自带的应用商店里搜不到得物的兜底）。
    //   必须读**真 DOM** —— 源码里有那行字证明不了页面上真渲染了它。
    const apkUi = await win.webContents.executeJavaScript(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#pane table tbody tr'));
      var tr = rows.filter(function(r){ return r.textContent.indexOf('得物 App 安装包') >= 0; })[0] || null;
      var btns = tr ? [].slice.call(tr.querySelectorAll('[data-act]')) : [];
      return {
        rowCount: rows.length,
        found: !!tr,
        rowText: tr ? tr.textContent : '',
        acts: btns.map(function(b){ return b.dataset.act; }),
        disabled: btns.filter(function(b){ return b.disabled; }).map(function(b){ return b.dataset.act; }),
        paneText: (document.querySelector('#pane') || {}).innerText || ''
      };
    })()`);
    ok('★ 设置页「外部依赖」表里多了「得物 App 安装包」那一行（模拟器商店里搜不到得物时的兜底）',
      apkUi.found, `共 ${apkUi.rowCount} 行 · ${String(apkUi.rowText).replace(/\s+/g, ' ').slice(0, 80)}`);
    ok('★ 那一行挂着「下载到本机 / 装进模拟器」两枚按钮，且内置那份在的时候**是能点的**（不是灰的）',
      apkUi.acts.join(',') === 'apk:save,apk:install' && apkUi.disabled.length === 0,
      `acts=${apkUi.acts.join(',')} disabled=[${apkUi.disabled.join(',')}]`);
    ok('★ 旁边写着「把 apk 拖进 MuMu 窗口就会自动安装」这句提示（用户要的就是这个动作）',
      /拖进 MuMu 窗口/.test(apkUi.paneText) && /已经装过得物就不会再动它/.test(apkUi.paneText),
      String(apkUi.paneText).replace(/\s+/g, ' ').slice(0, 130));

    // 负向对照：把「内置那份」指到空目录 ⇒ 两枚按钮必须灰掉、状态变「缺」。
    // 少了这一条，「disabled 跟着 apk 状态走」与「写死 disabled」在回归里长得一模一样（拆不开的假绿）。
    dewuMod.setBundledDir(path.join(ROOT, 'vendor', '__not_here__'));
    await win.webContents.executeJavaScript(`(async function(){ state.info = await window.api.info(); renderAll(); })()`);
    await new Promise(r => setTimeout(r, 200));
    const apkGone = await win.webContents.executeJavaScript(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#pane table tbody tr'));
      var tr = rows.filter(function(r){ return r.textContent.indexOf('得物 App 安装包') >= 0; })[0] || null;
      var btns = tr ? [].slice.call(tr.querySelectorAll('[data-act]')) : [];
      return { found: !!tr, n: btns.length, disabled: btns.filter(function(b){ return b.disabled; }).length, text: tr ? tr.textContent : '' };
    })()`);
    ok('★ 负向对照：内置的得物安装包「不在」时两枚按钮都变灰、状态写「缺」（disabled 跟着真实状态走，不是写死的）',
      apkGone.found && apkGone.n === 2 && apkGone.disabled === 2 && /缺/.test(apkGone.text),
      `n=${apkGone.n} disabled=${apkGone.disabled} · ${String(apkGone.text).replace(/\s+/g, ' ').slice(0, 70)}`);
    // ★ 还原 + 自证：不还原 ⇒ 后面所有断言都建在「得物安装包缺失」的界面上
    dewuMod.setBundledDir(path.join(ROOT, 'vendor', 'dewu'));
    await win.webContents.executeJavaScript(`(async function(){ state.info = await window.api.info(); renderAll(); })()`);
    await new Promise(r => setTimeout(r, 200));
    ok('★ 测试自己收尾：把内置目录还原后那一行又变回「内置」且按钮可点（证明上面的变灰是状态造成的，不是渲染坏了）',
      await win.webContents.executeJavaScript(`(function(){
        var rows = [].slice.call(document.querySelectorAll('#pane table tbody tr'));
        var tr = rows.filter(function(r){ return r.textContent.indexOf('得物 App 安装包') >= 0; })[0] || null;
        var btns = tr ? [].slice.call(tr.querySelectorAll('[data-act]')) : [];
        return !!tr && btns.length === 2 && btns.every(function(b){ return !b.disabled; }) && tr.textContent.indexOf('内置') >= 0;
      })()`));

    // ★★ 全链路活体：真的**点一下**「装进模拟器」。
    //   自检环境里没有设备 ⇒ 必须如实报「还没选设备」，而且这句必须从**主进程**回来
    //   （按钮 → ACTS → preload → ipc → jobs → dewuapk 这条链上断一处，这里就收不到这句话，
    //    只会静悄悄地什么都不发生 —— 那正是"按钮点了没反应"这种最难查的毛病）。
    await win.webContents.executeJavaScript(`(async function(){ document.querySelector('[data-act="apk:install"]').click(); })()`);
    await new Promise(r => setTimeout(r, 1200));
    const apkToast = await win.webContents.executeJavaScript(`(document.querySelector('#toast') || {}).textContent || ''`);
    ok('★ 点「装进模拟器」真的走完整条链（没设备时如实回「还没选设备」，不是点了没反应）',
      /还没选设备/.test(apkToast), JSON.stringify(apkToast).slice(0, 110));
    // ★ 三枚按钮都得有处理器：界面上有按钮、ACTS 里没处理器 = 死按钮（点了什么都不发生）。
    //   「覆盖重装」那一枚平时不渲染（只在"设备上已经装了"之后才出现），所以只能源码级钉住它。
    const apkSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    ok('★ 三枚按钮在 ACTS 里都接着处理器（apk:save / apk:install / apk:installForce）',
      /'apk:save':\s*async/.test(apkSrc) && /'apk:install':\s*async/.test(apkSrc) && /'apk:installForce':\s*async/.test(apkSrc),
      ['apk:save', 'apk:install', 'apk:installForce'].map(a => a + '=' + (new RegExp("'" + a + "':\\s*async").test(apkSrc) ? '有' : '缺')).join(' '));
  }
  const winSrc = fs.readFileSync(path.join(ROOT, 'src/main/window.js'), 'utf8');
  ok('★ 主进程的主题口径 = 日间/夜间/玻璃 三档（「跟随 Windows 设置」已取消）',
    /function normTheme\(v\) \{ return v === 'dark' \? 'dark' : 'light'; \}/.test(winSrc)
    && /const SKINS = \['light', 'dark', 'glass'\]/.test(winSrc)
    && /function normSkin\(v\)/.test(winSrc)
    && /function nextSkin\(v\)/.test(winSrc)
    && /function applyStoredTheme\(\)/.test(winSrc));
  // ★ 两条容易写错的地方，各钉一条：
  //   ① 玻璃在**原生窗口层**按深色走（否则「界面玻璃、原生标题栏浅色」半浅半深）；
  //   ② 界面皮肤的真值走 `theme` 字段 —— 渲染层若拿 shouldUseDarkColors 反推，玻璃会被认成夜间。
  ok('★ 玻璃在原生窗口层按深色走、界面皮肤的真值单独走 theme 字段',
    /function nativeForSkin\(s\) \{ return normSkin\(s\) === 'light' \? 'light' : 'dark'; \}/.test(winSrc)
    && /theme: normSkin\(store\.get\('ui\.theme'\)\)/.test(winSrc));
  // ★★ 「玻璃」的磨砂 = **系统亚克力**（不是 CSS）。它有两个只能靠源码钉住的硬约束，都实测过：
  //   ① 必须**建窗时**挂 backgroundMaterial —— 运行时 win.setBackgroundMaterial('acrylic') 会把窗口画成纯黑；
  //   ② 深色↔玻璃 切换时 nativeTheme.themeSource **不变**（两者在原生层都是 dark，见 nativeForSkin）
  //      ⇒ `nativeTheme.on('updated')` 不触发 ⇒ 必须显式调 refreshBackdrop() 重算窗口底色，
  //      否则玻璃档后面还停在上一次的实心色，亚克力一点也透不出来。
  ok('★ 亚克力在**建窗时**挂上（backgroundMaterial: acrylic）—— 运行时再设会变纯黑',
    /backgroundMaterial:\s*'acrylic'/.test(winSrc));
  ok('★ 玻璃档窗口底色 = 全透明，且 bgColor/refreshBackdrop 都导出了（否则把亚克力盖死）',
    /normSkin\(store\.get\('ui\.theme'\)\) === 'glass'[\s\S]{0,80}return '#00000000'/.test(winSrc)
    && /bgColor, refreshBackdrop/.test(winSrc));
  ok('★ theme:set / theme:toggle 都显式调 refreshBackdrop()（深色↔玻璃 不触发 updated，必须手动重算）',
    (fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8').match(/winmod\.refreshBackdrop\(\)/g) || []).length >= 2);
  {
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
    ok('★ 玻璃档页面底色真透明（body 挖空），旧的自画「极光底」已删除',
      /html\.glass body\{background:transparent\}/.test(cssSrc)
      && !/radial-gradient\(1100px 720px at 12% 6%/.test(cssSrc));
  }
  ok('★ 启动时在**建窗口之前**就把主题应用上（窗口底色按它算，晚了会先闪一下）',
    /winmod\.applyStoredTheme\(\);\r?\n\s*project\.load\(\);/.test(fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')));

  // ★★ 「记住最后一次选的皮肤」不能只验「切完能存进配置」（上面已验那几条）——
  //   那只证明值写进了**内存**。真会丢的是「防抖还没到就退出」这一段：
  //   store.set 排的是 **250ms 防抖定时器**，而进程退出不会等它。
  //   本机实测（真 app + 临时 userData）：点「玻璃」图标后 **60ms** 关窗口，
  //   config.json 里 `ui.theme` 仍是旧值 'light' ⇒ 用户看到的就是「选了没记住」。
  //   ⇒ 这里做**行为级**验证：排一次写入（故意不等）→ 立刻 flush() → 磁盘上必须已经是新值。
  {
    const cfgFile = store.file();
    const themeOnDisk = () => {
      try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')).ui.theme; }
      catch (e) { return '(读不到: ' + e.code + ')'; }
    };
    store.flush();                                   // ① 先落一次盘：保证文件存在、并清掉可能挂着的旧定时器
    const before = themeOnDisk();
    const other = before === 'glass' ? 'dark' : 'glass';
    store.set({ ui: { theme: other } });             // ② 只排队（250ms 防抖），故意不等
    const mid = themeOnDisk();                       // ③ 防抖窗口内：必须还是旧值
    store.flush();                                   // ④ 退出路径干的事
    const after = themeOnDisk();                     // ⑤ 必须已经是新值
    store.set({ ui: { theme: before } });            // ⑥ 还原，别影响后面的用例
    store.flush();
    ok('★ store.flush() 把「还没到防抖点」的皮肤改动**同步**写进 config.json（退出不丢最后一次选择）',
      mid === before && after === other,
      `防抖窗口内=${mid} → flush 后=${after}（期望 ${before} → ${other}）`);
  }
  {
    const idxSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
    const m = idxSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .match(/app\.on\('before-quit'[\s\S]{0,400}?\n\}\);/);
    const body = m ? m[0] : '';
    ok('★ 退出钩子调的是 store.flush()（同步落盘），不是那个「只重排防抖定时器」的旧写法',
      /store\.flush\(\)/.test(body) && !/store\.set\(/.test(body),
      body ? body.replace(/\s+/g, ' ').slice(0, 140) : '没找到 before-quit 处理器');
  }


  ok('页签 8 有「导出 xlsx」（品牌统计）', await onTab(8, 'stats:export'));

  const statsRangeUi = await win.webContents.executeJavaScript(`(async () => {
    const saved = { opts: JSON.parse(JSON.stringify(state.statsOpts)), stats: state.stats,
      query: state.statsQueryOpts && JSON.parse(JSON.stringify(state.statsQueryOpts)) };
    const nav = document.querySelector('.nav[data-tab="8"]'); nav.click();
    await new Promise(r => setTimeout(r, 120));
    const range = document.querySelector('#stDays');
    range.value = 'custom'; range.dispatchEvent(new Event('change'));
    const from = document.querySelector('#stFrom'), to = document.querySelector('#stTo');
    const local = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    if (from && to) {
      from.value = local(Date.now() - 3600000); from.dispatchEvent(new Event('change'));
      to.value = local(Date.now() + 60000); to.dispatchEvent(new Event('change'));
      document.querySelector('#pane [data-act="stats:refresh"]').click();
      for (let i = 0; i < 30 && state.statsBusy; i++) await new Promise(r => setTimeout(r, 100));
      from.value = local(Date.now() - 7200000); from.dispatchEvent(new Event('change'));
    }
    const result = { fields: !!from && !!to, types: from && to ? [from.type, to.type] : [],
      label: state.stats && state.stats.range && state.stats.range.label,
      dateInToolbar: (() => {
        const chip = document.querySelector('#pane .acct-toolbar .stats-range');
        return !!chip && /我的品牌|全部品牌/.test(chip.previousElementSibling.textContent)
          && chip.textContent.includes(state.stats.range.from) && chip.textContent.includes(state.stats.range.to)
          && !document.querySelector('#pane .tagline');
      })(),
      exportsDisabled: [...document.querySelectorAll('.act [data-act^="stats:export"]')].every(x => x.disabled),
      text: document.querySelector('#pane').textContent };
    state.statsOpts = saved.opts; state.stats = saved.stats; state.statsQueryOpts = saved.query;
    renderAll();
    return result;
  })()`);
  ok('品牌统计支持自定义起止日期和时间，并按自定义区间查询',
    statsRangeUi.fields && statsRangeUi.types.every(x => x === 'datetime-local') && statsRangeUi.label === '自定义时间',
    JSON.stringify({ fields: statsRangeUi.fields, types: statsRangeUi.types, label: statsRangeUi.label }));
  ok('统计日期移到品牌权限右侧，不再单独占用日期卡片', statsRangeUi.dateInToolbar);
  ok('筛选条件改动后必须重新查询才能导出，统计页已精简多余说明',
    statsRangeUi.exportsDisabled && !/共享位置|数据文件：|只追加、不自动裁剪/.test(statsRangeUi.text),
    `exportDisabled=${statsRangeUi.exportsDisabled} verbose=${/共享位置|数据文件：|只追加、不自动裁剪/.test(statsRangeUi.text)}`);

  // ---- 左侧「运行日志」页：与底部日志栏**同一份内容**、能筛、能真导出 ----
  // 用户原话是「同步 app 下端的日志」⇒ 必须验两处**内容逐行一致**。
  // 只验「多了一个页签」证明不了同步 —— 那恰恰是最容易做成两套数据的地方。
  // 日志由主进程 logbus 产生，这里直接往总线上灌几条（走的就是真的 log:entry 推送链路）。
  {
    // 先把导出目录挪到临时目录：默认是「我的文档\输出\得物」，自检不许往用户那儿写文件
    store.set({ paths: { output: path.join(TMP, 'out') } });

    logbus.info('ENG-INFO 自检：这段只用来验证「运行日志」页与底部日志栏同步');
    logbus.error('ENG-ERR 自检：故意造一条错误日志（用来验级别筛选）');
    // ★ 2026-10-05 用户口径「只给大结论」：再灌一条**过程明细**（tier='detail'）——
    //   它必须**不进界面**（底部日志栏与运行日志页都不许有它），
    //   但要留在 state.logs 里：任务行「查看详情」与 run-log.jsonl 台账都靠它。
    logbus.info('ENG-DETAIL 自检：这条是过程明细，不该出现在界面任何地方', null, logbus.DETAIL);
    await new Promise(r => setTimeout(r, 250));

    const gotoLogPage = `document.querySelector('.nav[data-tab="10"]').click(); await new Promise(r => setTimeout(r, 200));`;
    const ui0 = await win.webContents.executeJavaScript(`(async () => {
      ${gotoLogPage}
      const txt = els => els.map(e => e.textContent.replace(/\\s+/g, ' ').trim());
      return {
        bar: txt([...document.querySelectorAll('#log > div')]),
        pane: txt([...document.querySelectorAll('#logPaneLines > div')]),
        hasLogBadge: !!document.querySelector('[data-st="10"]'),
        detailInState: state.logs.filter(e => e.tier === 'detail').length,
        count: (document.querySelector('#logPaneCount') || {}).textContent || '',
        barCount: (document.querySelector('#logBarCount') || {}).textContent || '',
        countOnTitleRow: (function () { var c = document.querySelector('#logPaneCount'); var r = c && c.closest ? c.closest('.row') : null; return !!(r && r.querySelector('h3')); })(),
        acts: [...document.querySelectorAll('#pane [data-act]')].map(e => e.dataset.act),
        hasLv: !!document.querySelector('#logLv'), hasQ: !!document.querySelector('#logQ'), hasDays: !!document.querySelector('#logDays'),
        hasClear: !!document.querySelector('#logClear') || !!document.querySelector('[data-act="log:clear"]')
      };
    })()`);
    ok('★ 左侧「运行日志」页与底部日志栏是同一份内容（逐行一致）',
      ui0.bar.length > 0 && JSON.stringify(ui0.bar) === JSON.stringify(ui0.pane),
      `日志栏 ${ui0.bar.length} 行 / 页内 ${ui0.pane.length} 行`);
    ok('刚灌进去的那两条两处都看得到（说明走的是真推送链路，不是各自造的数据）',
      ui0.pane.some(l => /ENG-INFO/.test(l)) && ui0.bar.some(l => /ENG-INFO/.test(l)),
      ui0.pane.slice(-2).join(' | ').slice(0, 120));
    ok('★★ 过程明细（tier=detail）**不进界面**：底部日志栏与运行日志页都不许有它（2026-10-05 用户：只给大结论）',
      !ui0.bar.some(l => /ENG-DETAIL/.test(l)) && !ui0.pane.some(l => /ENG-DETAIL/.test(l)),
      JSON.stringify({ bar: ui0.bar.slice(-2), pane: ui0.pane.slice(-2) }).slice(0, 200));
    ok('★★ 但明细**留在 state.logs 里**（任务行「查看详情」与 run-log.jsonl 台账都靠它，不许丢）',
      ui0.detailInState >= 1, `${ui0.detailInState} 条明细在内存里`);
    ok('★ 左侧「运行日志」模块上**不再有角标**（2026-10-05 用户：不要显示有多少条）',
      ui0.hasLogBadge === false, String(ui0.hasLogBadge));
    ok('运行日志页和底部均不显示总条数', !ui0.count && !ui0.barCount && !ui0.countOnTitleRow);
    ok('只保留时间筛选器，移除级别和搜索', ui0.hasDays && !ui0.hasLv && !ui0.hasQ);
    const rangeUi = await win.webContents.executeJavaScript(`(async () => {
      const sel = document.querySelector('#logDays');
      sel.value = 'custom'; sel.dispatchEvent(new Event('change'));
      state.logFilter.fromAt = localDateTimeInput(Date.now()+86400000);
      state.logFilter.toAt = localDateTimeInput(Date.now()+172800000);
      renderAll();
      const empty = document.querySelectorAll('#logPaneLines > div').length;
      const bar = document.querySelectorAll('#log > div').length;
      state.logFilter.toAt = state.logFilter.fromAt;
      state.logFilter.fromAt = '';
      renderAll();
      const invalid = !document.querySelector('#logRangeError').hidden && document.querySelector('[data-act="log:export"]').disabled;
      state.logFilter.fromAt = localDateTimeInput(Date.now()-86400000);
      state.logFilter.toAt = localDateTimeInput(Date.now()+60000);
      renderAll();
      return {empty,bar,invalid, restored:document.querySelectorAll('#logPaneLines > div').length};
    })()`);
    ok('未来时间没有日志，底部不受筛选影响', rangeUi.empty===0 && rangeUi.bar===ui0.bar.length);
    ok('无效时间范围提示错误并禁止导出', rangeUi.invalid);
    ok('恢复有效时间后日志重新出现', rangeUi.restored>0);

    // ★ 导出（**在筛选状态下点**）：这一条才是「导出的就是屏幕上这些」的硬证据，
    //   只验「文件存在」是不够的 —— 那样把「永远导出全量」放过去也看不出来
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-act="log:export"]').click();
      await new Promise(r => setTimeout(r, 900));
    })()`);
    const outDir = path.join(TMP, 'out');
    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    const logName = files.find(f => /^运行日志_\d{8}-\d{6}\.log$/.test(f)) || '';
    const jsonName = files.find(f => /^运行日志_\d{8}-\d{6}\.jsonl$/.test(f)) || '';
    ok('★ 点「导出日志」后输出目录里真的出现了 .log 与 .jsonl（文件名带时间戳到秒）',
      !!logName && !!jsonName, files.join(' ') || '(目录是空的)');
    const logTxt = logName ? fs.readFileSync(path.join(outDir, logName), 'utf8') : '';
    const exportedRows = jsonName ? fs.readFileSync(path.join(outDir,jsonName),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    ok('导出遵循自定义时间范围且与界面一致', /时间=/.test(logTxt) && exportedRows.length===rangeUi.restored && exportedRows.every(e=>e.t >= Date.now()-86400000 && e.t <= Date.now()+60000));
    ok('导出的是给人看的那份：每行带完整日期时间 + 中文等级',
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[错误\] ENG-ERR/.test(logTxt),
      (logTxt.split('\n').filter(l => /ENG-ERR/.test(l))[0] || '').slice(0, 70));

    const ui3 = await win.webContents.executeJavaScript(`(() => ({
      acts: [...document.querySelectorAll('#pane [data-act]')].map(e => e.dataset.act),
      text: document.querySelector('#pane').textContent
    }))()`);
    ok('导出后页面上多出「打开文件 / 打开所在文件夹」（导完要能找到它）',
      ui3.acts.includes('log:openFile') && ui3.acts.includes('log:revealFile'), JSON.stringify(ui3.acts));
    ok('页面上写的是「上次导出」的真实文件名（不是一句含糊的"导出成功"）',
      !!logName && ui3.text.includes(logName), ui3.text.replace(/\s+/g, ' ').slice(-100));

    // 日志不可清除：先恢复全量筛选，再验证新日志到来时两处继续保留历史并同步更新。
    await win.webContents.executeJavaScript(`(() => {
      state.logFilter = {days:0,rangeMode:'preset',fromAt:'',toAt:''};
      renderAll();
    })()`);
    await new Promise(r => setTimeout(r, 200));
    const beforePush = await win.webContents.executeJavaScript(`(() => ({
      bar: [...document.querySelectorAll('#log > div')].map(e => e.textContent),
      pane: [...document.querySelectorAll('#logPaneLines > div')].map(e => e.textContent)
    }))()`);
    logbus.warn('ENG-WARN 自检：检查日志不可清除且持续同步');
    await new Promise(r => setTimeout(r, 250));
    const afterPush = await win.webContents.executeJavaScript(`(() => ({
      bar: [...document.querySelectorAll('#log > div')].map(e => e.textContent),
      pane: [...document.querySelectorAll('#logPaneLines > div')].map(e => e.textContent)
    }))()`);
    ok('★ 新日志推送后两处都保留历史并同步显示（无清除入口）',
      afterPush.bar.length >= beforePush.bar.length && afterPush.pane.length >= beforePush.pane.length
        && afterPush.bar.some(x => /ENG-WARN/.test(x)) && afterPush.pane.some(x => /ENG-WARN/.test(x)),
      JSON.stringify(afterPush).slice(0, 150));

    // 源码锚点：两处不许各写一套渲染逻辑（那正是「两份数据」的前兆）
    // ★ 2026-10-05：先剥掉整行注释再匹配、窗口放宽到 1200 —— 原来的 400/500 字符窗口是
    //   拍脑袋定的，加进「明细不进界面」那几行代码后立刻**假红**（函数本身没变味，
    //   只是变长）。要不要共用一套渲染，判据是「有没有调用同一个函数」，不是「隔多少字符」。
    const appSrcLog = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    const appCodeLog = appSrcLog.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok('★ 两边共用同一个数组与同一套渲染函数（没有第二份日志）',
      /function pushLog\(e\)[\s\S]{0,1200}appendToLogPane\(e\)/.test(appCodeLog)
        && /function renderLogs\(\)[\s\S]{0,1200}renderLogPaneLines\(\)/.test(appCodeLog)
        && !/state\.logs2|state\.paneLogs/.test(appSrcLog),
      `pushLog→页内=${/appendToLogPane\(e\)/.test(appSrcLog) ? '有' : '缺'} · renderLogs→页内=${/renderLogPaneLines\(\)/.test(appSrcLog) ? '有' : '缺'}`);
    ok('★ 导出走 IPC（渲染层没有 fs），且主进程会把失败如实报回来（不吞）',
      /appApi\.logExport\(/.test(appSrcLog)
        && /ipcRenderer\.invoke\('log:export', payload\)/.test(fs.readFileSync(path.join(ROOT, 'src/preload/index.js'), 'utf8'))
        && /导出运行日志失败/.test(fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8')));
  }

  // 设置页对所有账号撤掉分发入口，并忽略旧版本的状态推送。
  const panel = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.nav[data-tab="7"]').click();
    return { box: !!document.querySelector('#versionUpdate'),
      text: document.querySelector('#head').textContent + document.querySelector('#pane').textContent,
      deps: /外部依赖/.test(document.querySelector('#pane').textContent) };
  })()`);
  ok('更新面板已从设置页移走', panel.box === false);
  ok('设置页不再重复显示检查更新入口', !/检查更新/.test(panel.text));
  ok('设置页其他功能正常显示', panel.deps === true);
  const updaterSource = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
  ok('启动时不再初始化或调度联网检查', !/updater\.(init|scheduleStartupCheck)/.test(updaterSource));
  win.webContents.send('update:changed', { supported: true, status: 'available', latest: '99.0.0' });
  await new Promise(r => setTimeout(r, 100));
  ok('旧状态事件不会显示分发面板', await win.webContents.executeJavaScript(`!document.querySelector('#updBox')`));

  // ---- 2026-10-03 用户要求：**非管理员**在设置页看不到「自动更新 / 版本信息」，版本号挪到左上角 ----
  // ★ 负向断言必须**真读 DOM**（不是看源码里有没有那行字），而且必须配**正向对照** ——
  //   否则「这一页整个渲染失败、一片空白」也能让「不含『应用更新』」通过（空 == 空的假绿）。
  // ★ uicheck 跑在 BLUEV_NO_LOGIN=1 下 ⇒ requireLogin=false ⇒ canAdmin() 恒为 true（没账号也算管理员），
  //   所以非管理员那一支只能在渲染层把 state.auth 换掉再重画。这条路已实测可行：
  //   `state` 是经典脚本的顶层 const，executeJavaScript 在同一个 realm 里直接读得到、改得动，
  //   改完 canAdmin() 立刻变 false（探针 2026-10-03 验证）。
  {
    const gate = await win.webContents.executeJavaScript(`(async () => {
      const nav7 = document.querySelector('.nav[data-tab="7"]');
      const saved = state.auth;
      const out = {};
      // ① 管理员视角（当下就是这一支）：这一块必须在 —— 作为下面「消失」的对照基线
      nav7.click();
      await new Promise(r => setTimeout(r, 200));
      out.admin = {
        updBox: !!document.querySelector('#pane #versionUpdate'),
        head: (document.querySelector('#head') || {}).textContent || '',
        // ★ 2026-10-04：管理员视角也要查「路径」块在不在 —— 用户要求的是「对所有人隐藏」，
        //   所以两个视角都得覆盖，不能只验普通成员那一支。
        hasPathBlock: /输出目录|隔离目录/.test(document.querySelector('#pane').textContent)
      };
      // ② 切成普通成员再重画：整块必须消失，副标题也不许再提「应用更新」
      state.auth = { requireLogin: true, isAdmin: false, user: { username: 'u1', displayName: '普通成员', role: 'user' } };
      out.canAdmin_nonadmin = canAdmin();
      renderAll();
      const pane = document.querySelector('#pane');
      const head = document.querySelector('#head');
      out.nonadmin = {
        updBox: !!pane.querySelector('#versionUpdate'),
        paneText: pane.textContent,
        head: head.textContent,
        h3: [...pane.querySelectorAll('.box h3')].map(e => e.textContent),
        // ★ 2026-10-04：原来这里用「有路径块」当「这一页还在正常渲染」的正向对照。
        //   现在路径块按用户要求撤了 ⇒ 对照改用「外部依赖 + 保存按钮 + 运行环境那一行」；
        //   同时把它翻成**负向**判据：这一页恰恰不许再出现「输出目录 / 隔离目录」。
        // ★ 2026-10-05：设置页页脚那句「品牌与权限」提示按用户要求删了 ⇒ 对照换成
        //   「运行环境」（外部依赖盒里那一行，页面上稳定存在），不再挂在被删掉的文字上。
        hasPathBlock: /输出目录|隔离目录/.test(pane.textContent),
        hasDeps: /外部依赖/.test(pane.textContent),
        hasRuntime: /运行环境/.test(pane.textContent),
        descText: (document.querySelector('#head') || {}).textContent || '',
        saveBtn: !!document.querySelector('[data-act="cfg:save"]')
      };
      // ③ 还原登录态，别污染后面的套件
      state.auth = saved;
      renderAll();
      out.restored = { canAdmin: canAdmin(), updBox: !!document.querySelector('#pane #versionUpdate') };
      return out;
    })()`);

    ok('管理员设置页不重复显示更新入口',
      !!gate && gate.admin.updBox === false,
      gate ? 'updBox=' + gate.admin.updBox + ' head=' + JSON.stringify((gate.admin.head || '').slice(0, 60)) : 'gate=null');
    ok('★ 切到普通成员后 renderAll：canAdmin() 真的变 false（机制先自证，免得断言建在空地基上）',
      !!gate && gate.canAdmin_nonadmin === false, JSON.stringify(gate && gate.canAdmin_nonadmin));
    ok('普通成员设置页不重复显示更新入口',
      !!gate && gate.nonadmin.updBox === false,
      gate ? 'h3=' + JSON.stringify(gate.nonadmin.h3) : '');
    ok('普通成员设置页不残留旧更新文案',
      !!gate && !/应用更新|检查更新/.test(gate.nonadmin.paneText),
      gate ? JSON.stringify((gate.nonadmin.paneText || '').replace(/\s+/g, ' ').slice(0, 90)) : '');
    ok('★ 非管理员设置页副标题也不再提「应用更新」（界面文字得跟界面上真有的东西对得上）',
      !!gate && !/应用更新/.test(gate.nonadmin.head),
      gate ? JSON.stringify((gate.nonadmin.head || '').replace(/\s+/g, ' ').slice(0, 110)) : '');
    // ★★ 2026-10-04 用户要求：设置页整块「路径」（输出目录 / 隔离目录 + 两个「修改」按钮）对所有人隐藏。
    //   两个视角各一条 —— 只验非管理员那一支会漏掉「管理员还看得见」这种半拉子改法。
    ok('★★ 设置页（管理员视角）：整块「路径」已撤掉 —— 页面里不许再出现「输出目录 / 隔离目录」',
      !!gate && gate.admin.hasPathBlock === false,
      gate ? 'hasPathBlock=' + gate.admin.hasPathBlock : 'gate=null');
    ok('★★ 设置页（普通成员视角）：同样看不到「路径」块（对所有人隐藏，不是只对某一种角色）',
      !!gate && gate.nonadmin.hasPathBlock === false,
      gate ? 'hasPathBlock=' + gate.nonadmin.hasPathBlock : 'gate=null');
    ok('★ 设置页副标题跟着改口：不再提「路径」（界面文字得跟界面上真有的东西对得上）',
      !!gate && !/路径、/.test(gate.admin.head + gate.nonadmin.descText),
      gate ? JSON.stringify((gate.nonadmin.descText || '').replace(/\s+/g, ' ').slice(0, 90)) : '');
    ok('普通成员外部依赖正常显示，去掉无效保存按钮',
      !!gate && gate.nonadmin.hasDeps && !gate.nonadmin.saveBtn && gate.nonadmin.hasRuntime,
      gate ? 'deps=' + gate.nonadmin.hasDeps + ' save=' + gate.nonadmin.saveBtn + ' runtime=' + gate.nonadmin.hasRuntime : '');
    ok('还原管理员登录态后设置页仍无重复更新面板',
      !!gate && gate.restored.updBox === false && gate.restored.canAdmin === true,
      JSON.stringify(gate && gate.restored));

    // ★★ 2026-10-04：上面几条验的是「渲染出来看不见」。再补源码级两条 ——
    //   ① 入口与处理器都删干净（**只查代码行**：注释里正解释这件事，全文搜必然自命中）；
    //   ② ★ **底层读取链一条都没动** —— 这次是「撤界面入口」不是「删功能」。
    //      真把配置读取点删了，导出报告 / 运行日志 / 统计会当场报「没有配置输出目录」（静默丢数据的反例）。
    {
      // ★ 这里要连 **HTML 注释**（`<!-- … -->`）一起剥 —— app.js 的界面是模板字符串拼出来的，
      //   说明性注释写成 HTML 形式；只剥 `/* */` 与 `//` 时，注释里的 `cfg:path` 会把断言误判成红
      //   （实测第一版就是这么红的：报 cfg:path=true，而代码里其实一处都没有）。
      const codeOnly = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
        .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
      const uiCode = codeOnly(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8'));
      ok('★★ 设置页「路径」的入口与处理器都从源码里删干净（没留下没人调用的 data-act / action 死代码）',
        !/cfg:path/.test(uiCode) && !/<h3>路径<\/h3>/.test(uiCode) && !/c\.paths/.test(uiCode),
        'cfg:path=' + /cfg:path/.test(uiCode) + ' h3路径=' + /<h3>路径<\/h3>/.test(uiCode) + ' c.paths=' + /c\.paths/.test(uiCode));
      const rd = 'store\\.get\\(\'paths\\.(output|rejected)\'\\)';
      const chain = ['src/main/ipc.js', 'src/main/jobs.js', 'src/main/services/compliance.js',
        'src/main/services/sheet.js', 'src/main/services/stats.js', 'src/main/services/runlog.js'];
      const broken = chain.filter(rel => !new RegExp(rd).test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
      const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'store.js'), 'utf8');
      ok('★★ 撤的只是界面入口：**两个目录的读取链与出厂默认值都还在**（报告 / 日志 / 统计 / 隔离照旧读配置）',
        broken.length === 0 && /paths:\s*\{\s*output:\s*d\.output,\s*rejected:\s*d\.rejected\s*\}/.test(storeSrc),
        broken.length || !/paths:\s*\{\s*output:\s*d\.output/.test(storeSrc)
          ? '已读不到配置：' + (broken.join(' / ') || 'store 默认值接线断了') : '');
    }

    // 版本号：左上角 app 名字后面那枚 chip
    const ver = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#appVer');
      const nameEl = document.querySelector('.titlebar .name');
      return {
        exists: !!el,
        text: el ? el.textContent : '',
        inTitlebar: !!(el && el.closest('.tb-left') && el.closest('.titlebar')),
        afterName: !!(el && nameEl && (nameEl.compareDocumentPosition(el) & 4)),
        info: (state.info && state.info.version) || ''
      };
    })()`);
    ok('★ 左上角 app 名字后面有版本号（#appVer 在标题栏、且在名字之后）',
      !!ver && ver.exists && ver.inTitlebar && ver.afterName,
      JSON.stringify(ver && { exists: ver.exists, inTitlebar: ver.inTitlebar, afterName: ver.afterName }));
    ok('★ 版本号显示的就是 app:info.version（一致性断言，不写死版本号）',
      !!ver && !!ver.info && ver.text.split(' · ')[0] === 'v' + ver.info,
      JSON.stringify(ver && { text: ver.text, info: ver.info }));

    // 源码级守卫：更新界面与渲染函数必须彻底移除。
    const srcA = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const codeOnly = t => t.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
    const codeA = codeOnly(srcA);
    ok('★ 源码不再包含自动更新面板或按钮处理器',
      !/function updateHtml\(/.test(codeA) && !/data-act=\"upd:/.test(codeA) && !/'upd:check'/.test(codeA));

  }

  // 货号颜色校验对所有账号隐藏，包括管理员；旧 tab=4 与 Ctrl+4 都不能进入。
  {
    const t4 = await win.webContents.executeJavaScript(`(async () => {
      const saved = state.auth, savedTab = state.tab;
      const title = () => (document.querySelector('#head h2') || {}).textContent || '';
      const out = { navPresent: !!document.querySelector('.nav[data-tab="4"]'), hidden: !!(TABS[4] && TABS[4].hidden) };
      // 管理员强行设置旧 tab=4 也必须回到首页
      state.tab = 4;
      renderAll();
      out.adminOldTab = { tab: state.tab, title: title() };
      // 普通成员同样不能通过直接 tab 状态或快捷键进入
      state.auth = { requireLogin: true, isAdmin: false, user: { username: 'u1', displayName: '普通成员', role: 'user' } };
      state.tab = 4; renderAll();
      out.memberOldTab = { tab: state.tab, title: title() };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '4', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      out.ctrl4 = { tab: state.tab, title: title() };
      state.auth = saved; state.tab = savedTab;
      renderAll();
      return out;
    })()`);
    ok('★ 货号颜色校验对管理员也没有导航入口', !!t4 && !t4.navPresent && t4.hidden, JSON.stringify(t4));
    ok('★ 管理员旧 tab=4 会跳回首页', !!t4 && t4.adminOldTab.tab === 1 && t4.adminOldTab.title === '素材整理', JSON.stringify(t4 && t4.adminOldTab));
    ok('★ 普通成员旧 tab=4 与 Ctrl+4 都无法进入', !!t4 && t4.memberOldTab.tab === 1 && t4.ctrl4.tab === 1, JSON.stringify(t4 && { member: t4.memberOldTab, key: t4.ctrl4 }));

    // 源码级守卫：页面按钮必须完全不存在，不能只依赖登录角色隐藏。
    const html4 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    ok('★ 源码级：导航 HTML 不再包含货号颜色校验 tab', !/data-tab="4"/.test(html4));
  }

  // ---- 发布间隔的「连续发布」档（0 秒）----
  // 用户要求：发完一条直接开始发第二条。界面上必须真能选到这一档；
  // 而且配成 0 之后**选中的就得是它**（0 是 falsy，很容易在选中判断里被 `|| 60` 兜回 60 秒）。
  const ivSel = await win.webContents.executeJavaScript(`(async () => {
    const prev = state.config.publish.intervalSec;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const goto6 = async () => { document.querySelector('.nav[data-tab="6"]').click(); await wait(200); };
    const read = () => {
      const sel = document.querySelector('#pane select[data-cfg="publish.intervalSec"]');
      if (!sel) return null;
      const o = sel.options[sel.selectedIndex];
      const pane = document.querySelector('#pane');
      return { values: [...sel.options].map(x => x.value), picked: sel.value,
               text: o ? o.textContent : '', paneText: pane ? pane.textContent : '' };
    };
    await goto6();
    state.config.publish.intervalSec = 60; renderAll(); await goto6();
    const as60 = read();
    state.config.publish.intervalSec = 0; renderAll(); await goto6();
    const as0 = read();
    state.config.publish.intervalSec = prev; renderAll();
    return { as60, as0 };
  })()`);
  ok('界面：发布间隔里有「连续发布」这一档（value=0）',
    !!ivSel && !!ivSel.as0 && Array.isArray(ivSel.as0.values) && ivSel.as0.values.includes('0'),
    JSON.stringify(ivSel && ivSel.as0 && ivSel.as0.values));
  ok('★ 界面：配 0 时选中的就是「连续发布」（没有被兜成 60 秒）',
    !!ivSel && !!ivSel.as0 && ivSel.as0.picked === '0',
    JSON.stringify(ivSel && ivSel.as0 && { picked: ivSel.as0.picked, text: ivSel.as0.text }));
  ok('★ 正向对照：配 60 时选中的是「固定 60 秒」（证明上面那条不是恒真）',
    !!ivSel && !!ivSel.as60 && ivSel.as60.picked === '60',
    JSON.stringify(ivSel && ivSel.as60 && { picked: ivSel.as60.picked, text: ivSel.as60.text }));

  // ★ 界面自洽：选了「连续发布」，页面上那句「93% 的时间是在等间隔」就必须消失 ——
  //   否则界面一边说"不等了"、一边说"大部分时间都在等"，等于骗人。
  const hintCont = (ivSel && ivSel.as0 && ivSel.as0.paneText) || '';
  const hintFix = (ivSel && ivSel.as60 && ivSel.as60.paneText) || '';
  ok('★ 界面自洽：连续发布档下，提示换成"不再叠加等待"，且不再出现「93% 的时间是在等间隔」',
    hintCont.includes('不再等待') && !hintCont.includes('93% 的时间是在等间隔'),
    JSON.stringify({ hasNew: hintCont.includes('不再叠加等待'), hasOld: hintCont.includes('93% 的时间是在等间隔') }));
  // ★★ 2026-10-13 用户口径：「预估耗时都不准，比如图文 30s 那些，直接删了吧。」
  //   ⇒ 这一页不许再出现任何整批/单条秒数承诺（「预计约 N 分钟」「≈30 秒」都要消失）。
  //   反向对照：上面那条「连续发布」的说明必须还在（证明这页不是被整段删空）。
  ok('★ 预估耗时已删除：两个档位都不再出现「预计约」或「≈30 秒」这类承诺',
    !hintCont.includes('预计约') && !hintFix.includes('预计约')
    && !hintCont.includes('≈30 秒') && !hintFix.includes('≈30 秒')
    && !hintFix.includes('93% 的时间是在等间隔'),
    JSON.stringify({ cont预计: hintCont.includes('预计约'), fix预计: hintFix.includes('预计约'),
      cont30: hintCont.includes('≈30 秒'), fix30: hintFix.includes('≈30 秒'),
      fix连续: hintFix.includes('连续发布') }));

  // ---- 文案提示词弹窗：点「提示词配置」要直接弹出来 ----
  // 改之前它只是把页签跳到设置页，露出两个从来没被代码读过的输入框 —— 看不懂也改不动
  const modal = await win.webContents.executeJavaScript(`
    (async () => {
      const mask = document.getElementById('bmodal');
      const before = !!mask && mask.hidden;
      document.querySelector('.nav[data-tab="3"]').click();
      await new Promise(r => setTimeout(r, 120));
      const btn = document.querySelector('[data-act="copy:prompt"]');
      const hasBtn = !!btn;
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 150));
      const open = !!mask && !mask.hidden;
      const text = mask ? mask.textContent : '';
      if (mask) mask.click();                      // 点遮罩关
      await new Promise(r => setTimeout(r, 120));
      const closed = !!mask && mask.hidden;
      return { before, hasBtn, open, closed, hasTitle: /文案提示词/.test(text), len: text.length };
    })()
  `);
  ok('文案生成页有「提示词配置」按钮', modal.hasBtn);
  ok('点「提示词配置」直接弹出弹窗（不再跳去设置页那两个没人看得懂的输入框）',
    modal.before && modal.open && modal.hasTitle, JSON.stringify(modal));
  ok('点遮罩能关掉弹窗', modal.closed);

  // ---- 「提示词配置」列表每行三个按钮：配置 / 选择 / 默认选择 ----
  // 重点是**两个按钮的行为必须不一样**：「选择」只动本次（不落盘），「默认选择」才写进配置。
  // 只断言「按钮在」证明不了它们没被做成同一个东西 —— 所以要去点，然后读配置对。
  const picks = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.nav[data-tab="3"]').click();
      await new Promise(r => setTimeout(r, 120));
      document.querySelector('[data-act="copy:prompt"]').click();
      await new Promise(r => setTimeout(r, 220));
      const box = () => document.getElementById('bmBox');
      const rowsEl = () => [...box().querySelectorAll('.brow')];
      const navOf = r => r ? [...r.querySelectorAll('button')].map(e => e.dataset.act) : [];
      const rowById = id => rowsEl().find(r => {
        const b = r.querySelector('[data-act="bm:pick"]');
        return b && b.dataset.id === id;
      });
      const first = rowsEl()[0] || null;
      const ids = rowsEl().map(r => r.querySelector('[data-act="bm:pick"]').dataset.id);
      const target = ids[1] || ids[0] || '';
      const cfg0 = await window.api.configGet();
      const before = ((cfg0.copy || {}).defaultBrandId) || '';
      let afterPick = null;
      if (target) {
        rowById(target).querySelector('[data-act="bm:pick"]').click();
        await new Promise(r => setTimeout(r, 320));
        const c1 = await window.api.configGet();
        afterPick = {
          defaultUnchanged: (((c1.copy || {}).defaultBrandId) || '') === before,
          headerSel: (document.getElementById('brandSel') || {}).value || '',
          marked: /本次/.test(box().textContent)
        };
        const again = rowById(target);
        if (again) again.querySelector('[data-act="bm:default"]').click();
        await new Promise(r => setTimeout(r, 480));
      }
      const c2 = await window.api.configGet();
      const out = {
        rows: ids.length,
        nav: navOf(first),
        labelPick: first ? first.querySelector('[data-act="bm:pick"]').textContent.trim() : '',
        labelDefault: first ? first.querySelector('[data-act="bm:default"]').textContent.trim() : '',
        target, afterPick,
        defaultAfter: (((c2.copy || {}).defaultBrandId) || '')
      };
      const closeBtn = box() && box().querySelector('[data-act="bm:close"]');
      if (closeBtn) closeBtn.click();
      return out;
    })()
  `);
  ok('提示词列表每行都是「配置 / 选择 / 默认选择」三个按钮（顺序也对）',
    picks.rows >= 2 && picks.nav.join(',') === 'bm:open,bm:pick,bm:default',
    `${picks.rows} 行 · ${picks.nav.join(' / ')} · ${picks.labelPick}/${picks.labelDefault}`);
  ok('★「选择」= 只影响这一次：不写进配置，但标题栏的当前品牌跟着变',
    !!picks.afterPick && picks.afterPick.defaultUnchanged && picks.afterPick.headerSel === picks.target,
    JSON.stringify(picks.afterPick) + ' · target=' + picks.target);
  ok('★「默认选择」= 写进配置（重启后还是它）',
    !!picks.target && picks.defaultAfter === picks.target, `默认品牌 → ${picks.defaultAfter}`);

  // ---- 品牌弹窗的编辑视图（2026-10-05 用户要求）----
  // ① 「筛选排序提示词」这个模块**整块删除**（它从没接进任何流程，只存不用）；
  // ② 「文案生成提示词」输入框**拉长**（改前 100px 只够看五行）。
  // 这两条都只能靠**真的渲染出来量**才算数：CSS 写没写对、模块删没删净，
  // computedStyle 与真实 DOM 说了算 —— 源码里 grep 到一行字证明不了界面上是什么样。
  const edView = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.nav[data-tab="3"]').click();
      await new Promise(r => setTimeout(r, 120));
      document.querySelector('[data-act="copy:prompt"]').click();
      await new Promise(r => setTimeout(r, 220));
      const box = document.getElementById('bmBox');
      const openBtn = box.querySelector('[data-act="bm:open"]');
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 220));
      const ta = document.getElementById('bmWrite');
      const cs = ta ? getComputedStyle(ta) : null;
      const mb = box.querySelector('.mb');
      const out = {
        hasWrite: !!ta,
        height: ta ? Math.round(ta.getBoundingClientRect().height) : 0,
        minH: cs ? parseFloat(cs.minHeight) : 0,
        filterBox: !!document.getElementById('bmFilter'),
        filterWord: /筛选排序/.test(box.textContent),
        boxH: Math.round(box.getBoundingClientRect().height),
        winH: window.innerHeight,
        rowsHint: (function () {
          const lh = cs ? parseFloat(cs.lineHeight) : 0;
          return (ta && lh) ? Math.floor(ta.getBoundingClientRect().height / lh) : 0;
        })()
      };
      const c = box.querySelector('[data-act="bm:close"]');
      if (c) c.click();
      return out;
    })()
  `);
  ok('★「文案生成提示词」输入框够高（≥240px；改前 100px 只够看五行）',
    edView.hasWrite && edView.height >= 240,
    `实测 ${edView.height}px（约 ${edView.rowsHint} 行）· min-height ${edView.minH}px`);
  ok('★「筛选排序提示词」模块已整块删除：弹窗里连输入框和标题都没有',
    !edView.filterBox && !edView.filterWord,
    JSON.stringify({ input: edView.filterBox, 标题: edView.filterWord }));
  ok('★ 弹窗编辑视图没有被撑到窗口外（超长时靠 .mb 自己滚动）',
    edView.boxH <= edView.winH + 1, `mbox ${edView.boxH}px / 窗口高 ${edView.winH}px`);

  // ---- 设置项要在**每一页**都能存 ----
  // 「文案生成」和「模拟器发布」两页里也有设置项（发布间隔 / adb 路径），
  // 以前只有「设置」页绑了保存 —— 那两页改了其实从没存过，而且界面上一点提示都没有，看着像生效了。
  const cfgSaved = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 150));
    return !document.querySelector('[data-cfg="copy.rotateStrategy"]')
      && /T01–T15/.test(HELP.copy.html()) && !/T01–T15/.test(document.querySelector('#pane').innerText);
  })()`);
  ok('★ 文案生成页不提供轮换选项，自动轮换说明收进说明书', cfgSaved === true, String(cfgSaved));

  // ★ 2026-10-02：adb 路径输入框已从「模拟器发布」页删掉（内置即用，摆着只是干扰），
  //   手填入口挪到「设置 → 高级设置」（仅管理员）。所以这里**两件事都要验**：
  //   ① 日常页面上它真的没了；② 高级设置里那个入口能存、且立刻生效。
  const adbSaved = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="6"]').click();
    await new Promise(r => setTimeout(r, 150));
    const daily = !!document.querySelector('[data-cfg="publish.adbPath"]');
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 150));
    const el = document.querySelector('[data-cfg="publish.adbPath"]');
    if (!el) return { daily, found: false };
    el.value = 'D:/fake/adb.exe';
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const cfg = await window.api.configGet();
    return { daily, found: true, saved: ((cfg.publish || {}).adbPath) || '' };
  })()`);
  ok('★ 模拟器发布页不再摆 adb 路径输入框（内置即用，摆着只是干扰）',
    adbSaved.daily === false, JSON.stringify(adbSaved));
  ok('「高级设置」里能填 adb 完整路径，且真的存进了配置',
    adbSaved.found && adbSaved.saved === 'D:/fake/adb.exe', JSON.stringify(adbSaved));
  ok('★ 填完立刻生效、不用重启（自检第一行会回显用的是哪个 adb）',
    adbMod.getAdbPath() === 'D:/fake/adb.exe', adbMod.getAdbPath());

  // ---- 三段解析：手填 > 内置 > 系统 PATH（纯状态读取，不起真 adb 进程） ----
  adbMod.setAdbPath('');
  const autoPick = adbMod.getActiveAdb();
  ok('★ adb 路径留空 ⇒ 自动用「程序内置」那份（新同事装上就能用，不用自己翻模拟器目录）',
    autoPick.source === 'bundled' && /adb\.exe$/.test(autoPick.path), JSON.stringify(autoPick));
  adbMod.setAdbPath(path.join(VENDOR_ADB, 'adb.exe'));
  const minePick = adbMod.getActiveAdb();
  ok('★ 手填了就用你填的 —— 内置的不许悄悄替掉你的配置',
    minePick.source === 'configured', JSON.stringify(minePick));
  adbMod.setAdbPath('D:/fake/adb.exe');   // 还原：下面「设备检查」那几条断言指望它

  // ★ 设备检查：给「不懂 adb 的人」看的那套说法 —— 一句结论 + 下一步动作，术语收进折叠区。
  //   这一组守的是「界面不许拿术语糊用户」这个意图，和具体检查项无关（换检查项也不用改）。
  //   跑之前 adbPath 已经是 D:/fake/adb.exe（不存在）；这里再把「内置目录」临时指到一个不存在的
  //   地方 ⇒ 必然落到「连 adb 都找不到」那条引导上，本机有没有模拟器都不影响结果。测完立刻还原。
  adbMod.setBundledAdbDir(path.join(TMP, 'no-such-vendor'));
  const probeUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="6"]').click();
    await new Promise(r => setTimeout(r, 120));
    const btn = document.querySelector('[data-act="pub:probe"]');
    if (!btn) return { err: '找不到检查按钮' };
    const btnLabel = btn.textContent.trim();
    btn.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (document.body.textContent.includes('设备检查结果')) break;
    }
    const box = document.querySelector('.device-probe');
    if (!box) return { err: '结果面板没出现', btnLabel };
    const det = box.querySelector('details');
    return {
      btnLabel,
      headline: (box.querySelector('.b') || {}).textContent || '',
      hasDetails: !!det,
      open: det ? det.hasAttribute('open') : null,
      summary: det ? det.querySelector('summary').textContent.trim() : '',
      guidances: box.querySelectorAll('div[style*="border-left"]').length,
      body: box.textContent
    };
  })()`);
  adbMod.setBundledAdbDir(VENDOR_ADB);
  adbMod.setBundledApkPath(path.join(VENDOR_KBD, 'ADBKeyboard.apk'));
  ok('检查按钮的名字是给用户看的（不再是术语「驱动自检」）',
    probeUi.btnLabel === '检查能不能发布', probeUi.btnLabel || probeUi.err || '?');
  ok('★ 结果先用一句人话回答「能不能发」',
    /还不能真机发布|能发布|一切就绪/.test(probeUi.headline || ''), probeUi.headline || probeUi.err || '?');
  ok('★ 折叠区外就能看到「下一步点哪里」（不是只有一张术语表）',
    probeUi.hasDetails && (probeUi.guidances > 0 || /一切就绪/.test(probeUi.headline || '')),
    `引导块 ${probeUi.guidances} 个 · 结论「${probeUi.headline}」`);
  ok('技术详情默认收起、并写明「一般不用看」',
    probeUi.hasDetails && probeUi.open === false && /一般不用看/.test(probeUi.summary || ''),
    `折叠「${probeUi.summary}」 open=${probeUi.open}`);
  ok('★ 设备检查里会写清「这个 adb 是哪来的」（手填 / 内置 / 系统 PATH），不让人猜',
    /你填的那个不存在/.test(probeUi.body || ''),
    /你填的那个不存在/.test(probeUi.body || '') ? '结果里写出了 adb 的来源' : '结果面板里没有出现来源字样');

  // 中文输入法由程序自动配置；真实 install / enable / set 三步在 adbtest 中验
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  // ★ 自检引导里承诺的按钮名，界面上必须真有 —— 2026-10-02 用户就是被一句
  //   「在下面的设备列表里点它的『选用』」指到了一个**空的**列表上（配置里 0 台设备，
  //   而那时候的「检测在线」根本不会把设备加进列表）。
  ok('★ 引导文案里的按钮名与界面上的按钮对得上（不许把人指到不存在的东西上）',
    appSrc.includes('pub:devScan') && appSrc.includes('扫描设备')
      && appSrc.includes('pub:useFound') && appSrc.includes('加入并使用')
      && /扫描设备/.test(fs.readFileSync(path.join(ROOT, 'src/main/services/adb.js'), 'utf8'))
      && /加入并使用/.test(fs.readFileSync(path.join(ROOT, 'src/main/services/adb.js'), 'utf8'))
      && !/「检测在线」/.test(fs.readFileSync(path.join(ROOT, 'src/main/services/adb.js'), 'utf8')));
  const jobsSrc = fs.readFileSync(path.join(ROOT, 'src/main/jobs.js'), 'utf8');
  const adbSrc = fs.readFileSync(path.join(ROOT, 'src/main/services/adb.js'), 'utf8');
  ok('★ 输入法由检查流程自动配置，发布入口也有依赖保障，界面不要求用户另行下载',
    /await ensureKeyboard\(serial\)/.test(adbSrc)
      && /await adb\.ensureKeyboard\(serial\)/.test(fs.readFileSync(path.join(ROOT, 'src/main/services/publisher.js'), 'utf8'))
      && !appSrc.includes('pub:installIme')
      && !jobsSrc.includes('publish.installIme')
      && /连接设备后自动安装并启用/.test(appSrc)
      && /安装包缺少内置文件/.test(appSrc),
    '设备检查、发布前置保障与设置页文案均接入自动配置');

  // 设置页「外部依赖」：内置的不许还写着「待接入」
  const depUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="7"]').click();
    await new Promise(r => setTimeout(r, 200));
    const t = document.querySelector('#pane').textContent;
    return {
      adbRow: /模拟器驱动 adb/.test(t), imeRow: /中文输入法 ADBKeyboard/.test(t),
      ffRow: /视频转 MP4/.test(t), builtin: /程序内置/.test(t),
      ffPathInput: !!document.querySelector('[data-cfg="publish.ffmpegPath"]'),
      srcPathRow: !!document.querySelector('[data-key="paths.source"]'),
      llmRow: !!document.querySelector('[data-cfg="copy.llm.enabled"]'),
      skuRow: !!document.querySelector('[data-cfg="verify.api.endpoint"]'),
      modeRow: !!document.querySelector('[data-cfg="verify.mode"]')
    };
  })()`);
  ok('设置页「外部依赖」如实说 adb / 中文输入法 / ffmpeg 都是内置的（不再是「待接入」）',
    depUi.adbRow && depUi.imeRow && depUi.ffRow && depUi.builtin, JSON.stringify(depUi));
  ok('★ 设置页不再摆「文案模型」「SKU 接口」「货号颜色下拉」（都收进高级设置）',
    !depUi.llmRow && !depUi.skuRow && !depUi.modeRow, JSON.stringify(depUi));
  ok('★ 设置页不再摆「ffmpeg 路径」输入框（内置即用）', depUi.ffPathInput === false, JSON.stringify(depUi));
  // ★ 2026-10-02（第三轮）：「素材根目录」整项删除 —— 它只是选择框的起点，实际每次都现场选
  //   （结果存 project.sourceDir）。留着它只会让人以为「素材必须放在这个目录下」。
  //   负向断言要盯**配置项本身**（data-key="paths.source"），不是看界面上有没有「素材」两个字。
  ok('★ 设置页不再摆「素材根目录」配置项（整项删除，不是藏起来）', depUi.srcPathRow === false, JSON.stringify(depUi));
  // 删功能要连**读取链**一起删：控件没了、配置键与读取点还在 = 行为没变（只是看不见了）。
  // 这里直接扫主进程源码 —— 不许再有 paths.source / paths: { source。
  const srcMain = ['src/main/store.js', 'src/main/project.js', 'src/main/jobs.js', 'src/main/ipc.js',
    'src/main/util/winpath.js', 'src/main/services/report.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  ok('★ 主进程与出厂配置里不再有 paths.source（读取链一起删干净）',
    !/paths\.source/.test(srcMain) && !/paths: \{ source\b/.test(srcMain),
    `paths.source=${(srcMain.match(/paths\.source/g) || []).length} · 配置键=${(srcMain.match(/paths: \{ source\b/g) || []).length}`);
  // 而高级设置页里它们都在（而且「文案模型 / 货号颜色 / 外部依赖路径」三块默认是**收起**的）
  // ★ 2026-10-08：云端协作整块已从这一页删掉 ⇒ 这里不再需要等它、也不再比对「实际在用的地址」。
  const advUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 200));
    const pane = document.querySelector('#pane');
    const has = s => !!pane.querySelector(s);
    const ds = [...pane.querySelectorAll('details.box')];
    // ★★ 2026-10-08 用户要求：「云端协作」整块**从界面上删掉**（不给任何人看到）⇒ 负向断言。
    //   整块一起盯（5 个控件 / 4 个按钮 / 2 个状态行），少列一个键都会漏。
    const cloudBlock = has('[data-cfg="cloud.enabled"]') || has('[data-cfg="cloud.url"]')
      || has('[data-cfg="cloud.anonKey"]') || has('[data-cfg="cloud.machineName"]')
      || has('[data-cfg="cloud.intervalSec"]') || has('[data-act="cloud:test"]')
      || has('[data-act="cloud:sync"]') || has('[data-act="cloud:exp"]')
      || has('[data-act="cloud:imp"]') || has('#cloudState') || has('#cloudEff');
    const cloudModalDom = !!document.querySelector('#cmodal');
    return {
      adbPath: has('[data-cfg="publish.adbPath"]'), ffPath: has('[data-cfg="publish.ffmpegPath"]'),
      dump: has('[data-act="pub:dump"]'), map: has('[data-act="pub:map"]'),
      recover: has('[data-act="pub:recoverEdit"]'),
      // ★ 2026-10-08 用户要求：「文案模型」整块从这一页**搬走**（到「文案生成 → 模型配置」弹窗），
      //   并且成为**唯一**模型入口 ⇒ 这一页必须**一个模型控件都不剩**（含旧的接口自检按钮）。
      //   少列一个键都会漏 —— 上一版就是只删了「启用」忘了别的（负向断言要覆盖整块）。
      llmBlock: has('[data-cfg="copy.llm.enabled"]') || has('[data-cfg="copy.llm.vision"]')
        || has('[data-cfg="copy.llm.imageCount"]') || has('[data-cfg="copy.llm.imageMaxSide"]')
        || has('[data-cfg="copy.llm.endpoint"]') || has('[data-cfg="copy.llm.apiKey"]') || has('[data-cfg="copy.llm.model"]')
        || has('[data-act="copy:llmtest"]') || has('[data-act="copy:model"]'),
      sku: has('[data-cfg="verify.api.endpoint"]'),
      mode: has('[data-cfg="verify.mode"]'), conc: has('[data-cfg="copy.concurrency"]'),
      cloudBlock, cloudModalDom,
      collapsed: ds.length, openCount: ds.filter(d => d.open).length
    };
  })()`);
  ok('★ 高级设置页收齐了这些入口（UI 定位表 / 并发路数 / SKU 接口 / adb、ffmpeg 路径）',
    advUi.adbPath && advUi.ffPath && advUi.dump && advUi.map
      && advUi.sku && advUi.mode && advUi.conc, JSON.stringify(advUi));
  // ★★ 2026-10-08 用户要求：「云端协作」整块**从界面上删掉**（原话「不用给任何人看到」）
  //   ⇒ 负向断言盯着整块（控件 / 按钮 / 状态行 / 弹窗一个都不能剩）。哪天被加回来这里必红；
  //   只删一半（例如控件删了、弹窗留着）也会红。
  ok('★★ 高级设置页不再有「云端协作」整块（控件 / 导出导入按钮 / 状态行 / 弹窗）',
    advUi.cloudBlock === false && advUi.cloudModalDom === false,
    JSON.stringify({ cloudBlock: advUi.cloudBlock, cloudModalDom: advUi.cloudModalDom }));
  // ★★ 2026-10-08 用户要求「设置里的模型直接删了」：负向断言盯着整块搬走，不然哪天被加回来照样全绿
  ok('★ 高级设置页不再有「文案模型」整块（含旧的接口自检按钮）—— 已搬到「文案生成 → 模型配置」',
    advUi.llmBlock === false, JSON.stringify({ llmBlock: advUi.llmBlock }));
  // ★ 2026-10-03 用户要求删掉的那一块：负向断言盯着（不然哪天被加回来，整套回归照样全绿）
  ok('★ 高级设置页不再有「失败恢复动作」（整块删了，不是藏起来）',
    advUi.recover === false, JSON.stringify({ recover: advUi.recover }));
  // 【已删】原来这 3 条钉的是云端协作块里「当前实际在用」那一行（界面上「留空＝跟随内置」的
  //   唯一可见出口）。2026-10-08 用户要求整块删掉 ⇒ 这几条的**对象已不存在**，
  //   改由上面那条负向断言盯着（块不许回来）。别再照抄回来 —— 它守的那个界面已经没有了。
  // 三块：并发路数 / 货号颜色 / 外部依赖路径
  //   （★ 2026-10-08 起是 3 块：「文案模型」已搬到「文案生成 → 模型配置」弹窗，
  //     「云端协作」整块已删）
  //   ★ 数字要跟着块数改：不改的话删/搬一块之后这里会**假红**（不是那一块出问题，是计数过期）。
  ok('★ 高级设置里「可选」的三块默认是收起的（折叠区，不占地方）',
    advUi.collapsed === 3 && advUi.openCount === 0, JSON.stringify(advUi));
  // 【已迁走】原来这里钉「文案模型块里有 看图开关 / 送图张数 / 缩放尺寸 / 接口自检」——
  //   2026-10-08 用户要求搬进「文案生成 → 模型配置」弹窗 ⇒ 这几条改为在下面那一段里钉（同口径，只是换了地方）。

  // 详细规则收进说明书，保留看图生成、报告时间戳与发布导入说明。
  // 同时钉住**旧口径已删**：「标题格式轮换」那套壳不再对用户宣传（它就是「像 AI 做的」的来源）。
  const copyUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 200));
    const t = document.querySelector('#pane').textContent;
    document.querySelector('#pane [data-act="help:open"]').click();
    const help = document.querySelector('#hmBox').textContent;
    document.querySelector('#hmBox [data-act="help:close"]').click();
    return { picture: /看图写/.test(help), report: /AI内容报告/.test(help) && /时间戳/.test(help), back: /模拟器发布/.test(help) && /导入报告/.test(help), oldFmt: /标题格式/.test(t) };
  })()`);
  ok('★ 文案说明书写明了标题是看图写的', copyUi.picture === true, JSON.stringify(copyUi));
  ok('★ 文案说明书保留报告时间戳与发布导入说明',
    copyUi.report === true && copyUi.back === true, JSON.stringify(copyUi));
  ok('★ 旧口径「标题格式轮换」不再出现在这一页（F01~F10 已降级为离线模板专用）',
    copyUi.oldFmt === false, JSON.stringify(copyUi));

  // ★★ 模型配置在「文案生成」页，是**所有已登录账号都能编辑**的唯一入口。
  //   原话：「后续模型调用都通过这个口子来，设置里的模型直接删了」「可设置默认模型，
  //   第一次填写后，后续默认选用这个」。逐条钉住：
  //     ① 普通成员也能看见按钮，且在「提示词配置」**左边**；② 点它是**开弹窗**，不是跳设置页；
  //     ③ 弹窗里配得全（启用 / 地址 / Key / 默认模型 / 拉清单 / 自检 / 保存）；
  //     ④ 「实际在用」显示真值，且**不带明文 key**；
  //     ⑤ 改完点「保存」真落进 copy.llm.model —— 这就是「后续默认选用这个」的落点。
  //   ★ 高级设置那一块的**负向**断言在上面 advUi 段（哪天被加回来要能抓）。
  //   ★ 注：注入代码里**不写正则转义**（`\s` 这类在模板串里会被吃掉一个反斜杠 ⇒ 静默变味），
  //     需要比对就看子串，不做空白归一。
  {
    const lmUi = await win.webContents.executeJavaScript(`(async () => {
      const savedAuth = state.auth;
      state.auth = { requireLogin: true, isAdmin: false, user: { username: 'member1', displayName: '普通成员', role: 'user' } };
      renderAll();
      document.querySelector('.nav[data-tab="3"]').click();
      await new Promise(r => setTimeout(r, 250));
      // ★ 动作按钮在 #head 的 .act 里（不是 #pane —— #pane 是页面正文）
      const act = document.querySelector('#head .act');
      const modelBtn = act ? act.querySelector('[data-act="copy:model"]') : null;
      const promptBtn = act ? act.querySelector('[data-act="copy:prompt"]') : null;
      const sameRow = !!(modelBtn && promptBtn && modelBtn.parentElement === promptBtn.parentElement);
      const beforePrompt = !!(modelBtn && promptBtn
        && (modelBtn.compareDocumentPosition(promptBtn) & Node.DOCUMENT_POSITION_FOLLOWING) > 0);
      if (modelBtn) modelBtn.click();
      // 「实际在用」那一行要过一次 IPC：等它从「读取中」变成真值
      for (let i = 0; i < 30; i++) {
        const t = (document.getElementById('lmCur') || {}).textContent || '';
        if (t && t.indexOf('读取中') < 0) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const mask = document.getElementById('lmmodal');
      const box = document.getElementById('lmBox');
      const has = s => !!(box && box.querySelector(s));
      const eff = await window.api.llmEffective();
      const memberCanAdmin = canAdmin();
      state.auth = savedAuth;
      return {
        modelBtn: !!modelBtn, sameRow, beforePrompt,
        memberCanAdmin,
        open: !!mask && mask.hidden === false,
        fEnabled: has('#lmEnabled'), fEndpoint: has('#lmEndpoint'), fKey: has('#lmKey'), fModel: has('#lmModel'),
        onlineOnly: box.querySelector('#lmEnabled').value === 'true' && box.querySelector('#lmEnabled').disabled && box.querySelector('#lmEnabled').options.length === 1,
        visionLocked: ['lmVision','lmCount','lmSide'].every(id => box.querySelector('#'+id).disabled),
        listBtn: has('[data-act="lm:list"]'), testBtn: has('[data-act="lm:test"]'), saveBtn: has('[data-act="lm:save"]'),
        effText: (document.getElementById('lmCur') || {}).textContent || '',
        effKeys: Object.keys(eff).sort(),
        effKeyLeak: Object.prototype.hasOwnProperty.call(eff, 'apiKey') || Object.prototype.hasOwnProperty.call(eff, 'key')
      };
    })()`);
    ok('★ 「模型配置」按钮在「文案生成」页，紧挨在「提示词配置」**左边**（用户指定位置）',
      lmUi.modelBtn && lmUi.sameRow && lmUi.beforePrompt,
      JSON.stringify({ btn: lmUi.modelBtn, sameRow: lmUi.sameRow, before: lmUi.beforePrompt }));
    ok('普通成员不是管理员，但仍能看到并打开「模型配置」',
      lmUi.memberCanAdmin === false && lmUi.modelBtn === true && lmUi.open === true,
      JSON.stringify({ canAdmin: lmUi.memberCanAdmin, button: lmUi.modelBtn, open: lmUi.open }));
    ok('★ 点它**开弹窗**（不是跳到设置页）：启用 / 接口地址 / API Key / 默认模型 / 拉清单 / 自检 / 保存 一个不缺',
      lmUi.open && lmUi.fEnabled && lmUi.fEndpoint && lmUi.fKey && lmUi.fModel
        && lmUi.listBtn && lmUi.testBtn && lmUi.saveBtn, JSON.stringify(lmUi));
    ok('★ 弹窗里「实际在用」显示的是**真值**（不是空框、不是停在「读取中」）',
      lmUi.effText.indexOf('实际在用') >= 0 && lmUi.effText.indexOf('读取中') < 0,
      JSON.stringify({ eff: lmUi.effText }));
    ok('模型配置固定使用在线模型，不再提供离线模板选项', lmUi.onlineOnly);
    ok('送图、每条张数和缩放尺寸均灰置禁用', lmUi.visionLocked);
    ok('★ 「实际在用」只回一个「配没配」的布尔，**不带明文 key**（少一条泄漏面）',
      lmUi.effKeyLeak === false && lmUi.effKeys.indexOf('apiKeySet') >= 0, JSON.stringify(lmUi.effKeys));
  }
  // 改「默认模型」→ 保存 → 真落进配置
  {
    const oldModel = store.get('copy.llm.model') || '';
    const visionBefore = store.get('copy.llm');
    const sv = await win.webContents.executeJavaScript(`(async () => {
      const box = document.getElementById('lmBox');
      const m = box && box.querySelector('#lmModel');
      if (!m) return { ok: false, why: '弹窗里的 #lmModel 找不到' };
      m.value = '__uicheck_default_model__';
      box.querySelector('#lmVision').value = 'false';
      box.querySelector('#lmCount').value = '4';
      box.querySelector('#lmSide').value = '1568';
      box.querySelector('[data-act="lm:save"]').click();
      await new Promise(r => setTimeout(r, 400));
      return { ok: true, closed: document.getElementById('lmmodal').hidden === true };
    })()`);
    const after = store.get('copy.llm.model');
    const visionAfter = store.get('copy.llm');
    ok('保存模型不修改灰置的送图参数', ['vision','imageCount','imageMaxSide'].every(k => visionBefore[k] === visionAfter[k]));
    ok('★ 改完点「保存」真的写进 copy.llm.model、并自动关掉弹窗（＝「后续默认选用这个」）',
      sv.ok && after === '__uicheck_default_model__' && sv.closed === true,
      JSON.stringify({ saved: after, closed: sv.closed, why: sv.why || '' }));
    // 还原：自检共用一个临时 userData，别把后面的用例带偏
    store.set({ copy: { llm: { model: oldModel } } });
  }
  // 「拉取模型清单」这条链路：要么真列出可选模型，要么把「拉不到」的原因写出来（不许静默）
  {
    const lr = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-tab="3"]').click();
      await new Promise(r => setTimeout(r, 200));
      document.querySelector('[data-act="copy:model"]').click();
      await new Promise(r => setTimeout(r, 250));
      const box = document.getElementById('lmBox');
      if (!box) return { brows: 0, text: '弹窗没开', err: false };
      box.querySelector('[data-act="lm:list"]').click();
      // 一次网络往返（拿不到清单时是真失败，要给足时间；共 20s 上限）
      let brows = 0, text = '';
      for (let i = 0; i < 80; i++) {
        const b = document.getElementById('lmList');
        text = (b && b.textContent) || '';
        brows = b ? b.querySelectorAll('.brow').length : 0;
        if (brows > 0 || text.indexOf('拉不到清单') >= 0) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return { brows, text: text.slice(0, 160), err: text.indexOf('拉不到清单') >= 0 };
    })()`);
    ok('★ 「拉取模型清单」不静默失败：要么列出可选模型，要么把「拉不到」的原因写在弹窗里',
      lr.brows > 0 || lr.err === true, JSON.stringify(lr));
    await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('[data-act="lm:close"]'); if (b) b.click(); })()`);
  }

  // ★ 2026-10-04 用户要求：文案生成页那张表**不摆「货号 / 颜色」两列**
  //   原话：「反正 AI 内容报告会显示具体货号和颜色，这里就不展示了」。
  //   正负两面都要钉住：两列真的没了（负向）+ 其余四列还在（正向对照，别把孩子跟洗澡水一起倒）。
  {
    const keepItems = project.get().items;
    const keepCopy = project.get().copyRows;
    project.patch({
      copyRows: [],
      items: [
        { id: '3261163003+1', absDir: 'D:\\素材\\flat_20261002-2329\\3261163003_1', sku: '0901_2', color: '3261163003', files: [] },
        { id: '3261132007+煤黑色01+1', absDir: 'D:\\素材\\flat_20261002-2329\\3261132007+煤黑色01_1', sku: '3261132007', color: '煤黑色01', files: [] }
      ]
    });
    const cols = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-tab="3"]').click();
      await new Promise(r => setTimeout(r, 200));
      const t = document.querySelector('#pane table');
      return { heads: t ? Array.from(t.querySelectorAll('thead th')).map(x => x.textContent.trim()) : [],
               cells: t ? t.querySelectorAll('tbody tr td').length : 0 };
    })()`);
    ok('★ 文案生成页的表格不再摆「货号 / 颜色」两列（理由：报告里会写清具体货号与颜色）',
      cols.heads.length > 0 && !cols.heads.includes('货号') && !cols.heads.includes('颜色'), JSON.stringify(cols.heads));
    ok('★ 但「叶子目录 / 标题 / 生成来源 / 状态」还在（少两列 ≠ 少一半）',
      ['叶子目录', '标题', '生成来源', '状态'].every(h => cols.heads.includes(h)), JSON.stringify(cols.heads));
    ok('★ 表头列数与单元格数自洽（删列时最容易把 thead/tbody 删得不一样多 ⇒ 整张表错位）',
      cols.cells === cols.heads.length * 2, `表头 ${cols.heads.length} 列 · 2 行共 ${cols.cells} 个单元格`);
    project.patch({ items: keepItems, copyRows: keepCopy });
  }

  // ★ 2026-10-02（第三轮）：云端配置的「下发」—— 导出 / 导入两个动作 + 一个弹窗。
  //   【已删 2026-10-08】用户要求「云端协作」整块从界面删掉 ⇒ 弹窗 #cmodal 已从 index.html 移除，
  //   原来那条「弹窗必须挂在 .app 外面」的正向断言随之作废（负向断言在下面「高级设置页」那组）。
  //   下面这几个变量**必须保留** —— 紧随其后的「说明书弹窗」那条断言还在用它们。
  const idxHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const iLines = idxHtml.split(/\r?\n/);
  const appOpen = iLines.findIndex(l => /<div class="app"(?:\s[^>]*)?>/.test(l));
  const appClose = iLines.findIndex((l, i) => i > appOpen && /^<\/div>/.test(l));

  // ---- ★ 2026-10-03：「批次设置」那六百多字长文 ⇒ 「说明书」弹窗（用户要求）----
  //   ① 结构：弹窗在 index.html 且挂在 .app 外面（跟上面那个同规矩）
  const hmodalAt = iLines.findIndex(l => /id="hmodal"/.test(l));
  ok('★ 说明书弹窗在 index.html 且挂在 .app 外面（塞进 #pane 会被 overflow 裁掉、长文还滚不动）',
    appOpen >= 0 && appClose > appOpen && hmodalAt > appClose && /id="hmBox"/.test(idxHtml),
    JSON.stringify({ appOpen, appClose, hmodalAt }));

  //   ② 行为：真点一下「看说明书」→ 弹窗开、内容对；Esc / 点遮罩能关，点弹窗本体不关。
  //   ③ 双向对账：注册表 HELP 里每条都得有按钮能打开（光删按钮 ⇒ 留下打不开的死条目）；
  //      按钮的 data-topic 也得真在注册表里（topic 写错字 ⇒ 点了没反应，最容易被漏掉的那种）。
  //   ④ 负向：那几段长文**不在页面上**了（搬走 ≠ 复制一份，贴两处）。
  const helpUi = await win.webContents.executeJavaScript(`(async () => {
    const keys = Object.keys(HELP).sort();
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 200));
    const pane = document.querySelector('#pane');
    const paneText = pane.textContent;
    // 页面上不该再出现那几段长文的特征句（它们已经搬进说明书）
    const longOnPage = /按「卖点 → 氛围感 → 上身体验 → 搭配」铺开/.test(paneText)
      || /只看相邻两条|当前批次已整理时|KIDS_AI内容报告|4~5 行短句/.test(paneText);
    const btn = pane.querySelector('[data-act="help:open"]');
    if (!btn) return { keys, hasBtn: false, longOnPage };
    const topic = btn.getAttribute('data-topic') || '';
    btn.click();
    await new Promise(r => setTimeout(r, 160));
    const mask = document.getElementById('hmodal');
    const box = document.getElementById('hmBox');
    const opened = !!mask && mask.hidden === false && !!box;
    const body = box ? box.querySelector('.mb') : null;
    const txt = box ? box.textContent : '';
    const h3 = box ? box.querySelector('h3') : null;
    // 长文必须落在 .mb 里 —— .mbox 是 overflow:hidden，直接灌进去会被裁掉且滚不动
    const scrollable = !!body && body.scrollHeight > 0 && box.firstElementChild !== body;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 130));
    const closedByEsc = mask ? mask.hidden === true : false;
    btn.click();                       // 再开一次，验「点遮罩关」与「点弹窗本体不关」
    await new Promise(r => setTimeout(r, 130));
    box.click();
    await new Promise(r => setTimeout(r, 110));
    const stayOnBoxClick = mask.hidden === false;
    mask.click();
    await new Promise(r => setTimeout(r, 130));
    const closedByMask = mask.hidden === true;
    return { keys, hasBtn: true, topic, opened, scrollable, closedByEsc, stayOnBoxClick, closedByMask,
      longOnPage,
      hasRules: /只看相邻两条/.test(txt) && /4~5 行短句/.test(txt) && /不是拿货号颜色套模板/.test(txt)
        && /处理后的目录 B/.test(txt) && txt.includes('本机 Excel/WPS') && /T01–T15/.test(txt),
      title: h3 ? h3.textContent : '' };
  })()`);
  ok('★「批次设置」里有「看说明书」按钮，且 data-topic 指向注册表里真实存在的条目',
    helpUi.hasBtn === true && helpUi.keys.includes(helpUi.topic),
    JSON.stringify({ keys: helpUi.keys, topic: helpUi.topic }));
  ok('★ 点「看说明书」真的弹出说明书，内容在 .mb 里（滚得动，不会被 .mbox 的 overflow 裁掉）',
    helpUi.opened === true && helpUi.scrollable === true, JSON.stringify({ opened: helpUi.opened, scrollable: helpUi.scrollable }));
  ok('★ 说明书里确实有那几条硬规则（重复只看相邻两条 / 正文 4~5 行 / 标题不是套模板）',
    helpUi.hasRules === true && /说明书/.test(helpUi.title || ''), JSON.stringify({ title: helpUi.title, rules: helpUi.hasRules }));
  // ★ closedByEsc / closedByMask 必须配「**真的开过**」这个前提：弹窗没打开时它本来就是 hidden，
  //   只看这两个布尔值会**空过**（假绿 —— 弹窗压根没弹出来，Esc 当然「关得掉」）。
  ok('★ 说明书 Esc 能关、点遮罩能关、点弹窗本体不关（选字拖一下鼠标不会把弹窗弄没）',
    helpUi.opened === true && helpUi.closedByEsc === true && helpUi.stayOnBoxClick === true && helpUi.closedByMask === true,
    JSON.stringify({ opened: helpUi.opened, esc: helpUi.closedByEsc, stay: helpUi.stayOnBoxClick, mask: helpUi.closedByMask }));
  ok('★ 那 4 段长文已不在页面上（是搬进说明书，不是复制一份贴两处）',
    helpUi.longOnPage === false, JSON.stringify({ longOnPage: helpUi.longOnPage }));

  // 【已删】原来这里点「导入配置」验弹窗能开、Esc 能关。2026-10-08 用户要求删掉云端协作整块，
  //   按钮和弹窗都不在了 ⇒ 改成**负向**：容器本身也不许留在 index.html 里
  //   （留一个空容器，就等于给「藏起来的入口」留了后门）。
  ok('★★ 云端配置弹窗的容器已从 index.html 里删掉（不是留着藏起来）',
    !fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8').includes('id="cmodal"'),
    '#cmodal 仍在 index.html');

  // ★ 2026-10-02（第二轮）：用户点名「并发路数」也挪进高级设置 —— 它是运行参数（撞接口限流的旋钮），
  //   和「必带话题」那种**改产出**的业务内容不是一回事。两件事都要验：
  //   ① 文案生成页真的没了（负向）；② 高级设置里能改、且真的存进了配置（测完还原，别污染后面的套件）。
  const concUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 150));
    const q = () => document.querySelector('[data-cfg="copy.concurrency"]');
    const daily = !!q();
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 150));
    const el = q();
    if (!el) return { daily, found: false };
    const before = ((await window.api.configGet()).copy || {}).concurrency;
    const target = before === 5 ? 6 : 5;
    el.value = String(target);
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const after = ((await window.api.configGet()).copy || {}).concurrency;
    // ★ 还原必须**重新取一次**元素：在「高级设置」页存任何一项，saveCfgFromDom 都会把这一页的
    //   adb / ffmpeg 路径一起收进 patch ⇒ 命中它末尾那段 renderAll ⇒ 手里那个 el 已脱离文档。
    //   而 saveCfgFromDom 读的是**活的 DOM** ⇒ 往旧节点写值 = 空操作（不是产品缺陷，是测试写法的坑）。
    //   stale 只作诊断留痕，**不当断言**（免得将来把那段 renderAll 优化掉时误报）。
    const stale = !document.contains(el);
    const el2 = q();
    el2.value = String(before);
    el2.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const restored = ((await window.api.configGet()).copy || {}).concurrency;
    return { daily, found: true, before, target, after, stale, restored };
  })()`);
  ok('★ 文案生成页不再摆「并发路数」（它是撞限流的旋钮，不是业务参数）',
    concUi.daily === false, JSON.stringify(concUi));
  ok('★「高级设置」里能改并发路数，且真的存进了配置（测完已还原成原值）',
    concUi.found && concUi.after === concUi.target && concUi.restored === concUi.before, JSON.stringify(concUi));
  // ★ 存 ffmpeg 路径要真的走得通：主进程 ipc.js 里那段是 `video.setFfmpegPath(...)`，
  //   曾经漏了 `require('./services/video')` ⇒ 一改就 ReferenceError（这条断言就是为它加的）
  const ffSaved = await win.webContents.executeJavaScript(`(async () => {
    const el = document.querySelector('[data-cfg="publish.ffmpegPath"]');
    if (!el) return { found: false };
    el.value = 'D:/fake/ffmpeg.exe';
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const cfg = await window.api.configGet();
    return { found: true, saved: ((cfg.publish || {}).ffmpegPath) || '' };
  })()`);
  ok('★ 改 ffmpeg 路径真的存得下（不许接口报错吞掉）',
    ffSaved.found && ffSaved.saved === 'D:/fake/ffmpeg.exe', JSON.stringify(ffSaved));
  // ★ 三段解析的真实契约：手填的不存在、又有内置可用 ⇒ source 退回 'bundled'，
  //   但 **configuredMissing 必须为真**（不能连「你填的那个不存在」这件事一起丢掉）。
  const ffStatus = videoMod.status();
  ok('★ 改完立刻生效：填的路径不存在 ⇒ 退回内置，且如实标出 configuredMissing',
    ffStatus.source === 'bundled' && ffStatus.configuredMissing === true
      && ffStatus.usable === true, JSON.stringify(ffStatus));
  // 而且界面上要**说出来**：设置页「外部依赖」里那一行得同时出现「不存在」与「内置」。
  // ★ 这条同时守住另一件事：app:info 必须回传 ffmpeg 状态 —— 漏了的话这行永远是「状态取不到」，
  //   界面等于在骗人（上一轮就是这么漏的，所以这里断言的是**渲染出来的行文本**，不是源码里有没有那行字）。
  const ffRow = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="7"]').click();
    await new Promise(r => setTimeout(r, 250));
    const tr = [...document.querySelectorAll('#pane .tw table tbody tr')].find(x => /视频转 MP4/.test(x.textContent));
    return tr ? tr.textContent.replace(/\s+/g, ' ').trim() : '';
  })()`);
  ok('★「外部依赖」表如实写出「手填的路径不存在、已退回内置」（不静默忽略拼错的路径）',
    /不存在/.test(ffRow) && /内置/.test(ffRow), ffRow);
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 150));
    const el = document.querySelector('[data-cfg="publish.ffmpegPath"]');
    el.value = ''; el.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 400));
  })()`);
  const ffBack = videoMod.status();
  ok('清空 ffmpeg 路径 ⇒ 完全退回内置（configuredMissing 回到假）',
    ffBack.source === 'bundled' && ffBack.configuredMissing === false, JSON.stringify(ffBack));
  // ★ 2026-10-03（用户要求）：设置页那块「内容与校验（对齐真机）」整块删掉 ——
  //   它只有两行指路（文案提示词 / 货号颜色），功能在「品牌与权限」「高级设置」两页里都有，重复。
  //   「入口还在」那条正断言在上一段（点「提示词配置」弹窗）已经守住，这里只查负向。
  const setPane = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.nav[data-tab="7"]').click();
    const pane = document.querySelector('#pane');
    return {
      barePrompt: !!pane.querySelector('[data-cfg="copy.promptWrite"]'),
      dupBox: /内容与校验/.test(pane.textContent),
      promptBtn: !!pane.querySelector('[data-act="copy:prompt"]'),
      logRow: /更新日志/.test(pane.textContent) || !!pane.querySelector('[data-act^="upd:log"]')
    };
  })()`);
  ok('★ 设置页既没有那两个没被代码读过的裸输入框，也没有重复的「内容与校验」整块（入口只在文案生成页）',
    setPane.barePrompt === false && setPane.dupBox === false && setPane.promptBtn === false,
    JSON.stringify(setPane));
  // ★ 2026-10-03（用户要求）：「更新日志」那条整链删除（界面行 + upd:log:* 三个动作 + 主进程落盘）。
  //   删功能要有负向断言盯着 —— 否则以后有人把那一行加回来，整套回归照样全绿。
  //   这条只看**设置页真实渲染出来的 DOM**，不看源码（注释里正当提到「更新日志」四个字不算数）。
  ok('★ 设置页的「更新日志」已整条删除（界面上没有这一行，也没有 upd:log:* 动作）',
    setPane.logRow === false, JSON.stringify(setPane));

  // ---- ★ 2026-10-03 用户要求：**「失败恢复动作」界面整块删除** ----
  //   原来这里有一段「点『编辑恢复动作』→ 填文本框 → 保存 → 回读校验」的端到端测试。
  //   控件、三个动作（pub:recoverEdit / pub:recoverCancel / pub:recoverSave）、配置键 uiMap.recover
  //   连同主进程的 publish.setRecover 与 publisher.recover 全删了 ⇒ 那一段没有测试对象。
  //   接手的是上面两条**负向**断言：「任何一页都点不到这个入口」+「高级设置页不再有」。

  // ---- 待办①端到端：真起一个批次，看「运行中的批次」出现取消按钮、跑完又消失 ----
  const batchSrc = path.join(TMP, '自检素材', '自检批次源');
  const jpeg = require(path.join(ROOT, 'node_modules', 'jpeg-js'));
  store.set({ copy: { llm: { enabled: false } } }); // 本套件验界面任务状态，不能调用收费接口。
  const px = Buffer.alloc(120 * 120 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 240; px[i + 1] = 240; px[i + 2] = 242; px[i + 3] = 255; }
  const shot = jpeg.encode({ data: px, width: 120, height: 120 }, 90).data;
  for (let i = 0; i < 120; i++) {
    const d = path.join(batchSrc, `26FW-YB1${String(i).padStart(3, '0')}+冠军白+1`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '1.jpg'), shot);
  }
  await win.webContents.executeJavaScript(`document.querySelector('.nav[data-tab="3"]').click()`);
  const batchRun = await win.webContents.executeJavaScript(`
    (async () => {
      const dir = ${JSON.stringify(batchSrc)};
      // 不看轮询：120 条本地文案可能 5ms 就跑完，25ms 的定时器一次都不一定轮得到。
      // 直接挂在 job:started 上（注册在 app.js 之后，所以是在它 renderAll 之后同步取 DOM），这样是确定性的。
      let sawBox = false, sawCancel = false;
      window.api.onJobStart(() => {
        const box = document.querySelector('[data-batches="copy.generate"]');
        sawBox = !!box;
        sawCancel = !!(box && box.querySelector('[data-act="batch:cancelAll"]'));
      });
      const r = await window.api.run('copy.generate', { brandId: ${JSON.stringify(brands.byName('自检品牌A').id)}, sourceDir: dir, batchId: '自检批次_20260930_000000', label: '自检批次_20260930_000000' });
      await new Promise(res => setTimeout(res, 400));
      const box = document.querySelector('[data-batches="copy.generate"]');
      return {
        ok: r.ok, error: r.error || '',
        sawBox, sawCancel,
        count: r.ok ? r.result.count : -1,
        afterEmpty: !!box && /没有正在处理的批次/.test(box.textContent)
      };
    })()
  `);
  ok('启动批次后「运行中的批次」出现（含全部取消按钮）', batchRun.ok && batchRun.sawCancel,
    batchRun.ok
      ? `批次 ${batchRun.count} 篇${batchRun.sawBox ? '' : '（面板没出现）'}`
      : batchRun.error);
  ok('批次跑完后从面板消失', batchRun.afterEmpty);

  // 品牌标记：界面上是**两处**内联 SVG（标题栏 17、登录卡 26），而打包图标 build/icon.ico
  // 由 tools/make-icon.js **从 index.html 里读出那个 SVG** 生成 ⇒ index.html 是唯一来源。
  // （踩过的坑：曾经是三份来源，换 logo 只改一处也不会报错；也曾经用「断言具体图形」的方式绑，
  //   结果一换 logo 断言就得跟着改 —— 现在改成绑「两处一致」+「图标颜色来自界面」，与图形无关。）
  const brand = await win.webContents.executeJavaScript(`
    (() => {
      const pick = (sel) => {
        const svg = document.querySelector(sel + ' svg');
        if (!svg) return null;
        const rect = svg.querySelector('rect');
        return {
          ds: [...svg.querySelectorAll('path')].map(p => p.getAttribute('d')),
          rects: svg.querySelectorAll('rect').length,
          rectFill: rect ? rect.getAttribute('fill') : null,
          strokes: [...svg.querySelectorAll('path')].map(p => p.getAttribute('stroke')),
          viewBox: svg.getAttribute('viewBox')
        };
      };
      // 注意选择器：登录卡那个 span 只有 class="glogo"，没有 id（别写成 #glogo —— 会静默查不到，
      // 于是「两处 logo 一致」这条断言会因为「只找到一处」而变红，看着像 logo 有问题）
      return { title: pick('#logo'), gate: pick('.glogo') };
    })()
  `);
  const sameD = !!(brand.title && brand.gate &&
    JSON.stringify(brand.title.ds) === JSON.stringify(brand.gate.ds));
  ok('标题栏与登录卡的 logo 是同一份矢量（两处 path 逐字相同）', sameD,
    sameD ? `viewBox ${brand.title.viewBox}` : `标题栏 ${JSON.stringify(brand.title)} / 登录卡 ${JSON.stringify(brand.gate)}`);

  const ico = (() => {
    try {
      const { PNG } = require('pngjs');
      const b = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
      const n = b.readUInt16LE(4);
      let fine = b.readUInt16LE(2) === 1 && n >= 6;
      const sizes = [];
      let best = null;
      for (let i = 0; i < n; i++) {
        const off = 6 + i * 16;
        let w = b[off]; if (w === 0) w = 256;
        const len = b.readUInt32LE(off + 8);
        const pos = b.readUInt32LE(off + 12);
        // 越界、或该条不是内嵌 PNG（Vista 起 ICO 允许直接放 PNG）—— 都算坏
        if (pos + len > b.length || !(b[pos] === 0x89 && b.toString('ascii', pos + 1, pos + 4) === 'PNG')) { fine = false; continue; }
        sizes.push(w);
        if (!best || w > best.w) best = { w, pos, len };
      }
      let corner = null;
      if (best) {
        const png = PNG.sync.read(b.subarray(best.pos, best.pos + best.len));
        const m = Math.floor(png.width / 8);
        const i = (m * png.width + m) * 4;
        corner = [png.data[i], png.data[i + 1], png.data[i + 2]];
      }
      return { fine, n, sizes, corner, size: b.length };
    } catch (e) { return { fine: false, n: 0, sizes: [], corner: null, size: 0, err: e.message }; }
  })();
  ok('打包图标 build/icon.ico 结构可解、尺寸齐全（256 与 16 都在，每条都是内嵌 PNG）',
    ico.fine && ico.sizes.includes(256) && ico.sizes.includes(16),
    ico.fine ? `${ico.sizes.join('/')} · ${ico.size} B` : (ico.err || '结构损坏'));

  // ★ 行为级：打包图标里的底色，必须对得上界面那个标记的颜色。
  //   只有这一条能抓住「换了 logo 却没重新生成 ico」——「ico 存在且结构完好」是查不出来的。
  const htmlColor = (brand.title && (brand.title.rectFill || (brand.title.strokes || [])[0])) || '';
  const htmlHex = (/^#([0-9a-f]{6})$/i.exec(String(htmlColor).trim()) || [, ''])[1].toLowerCase();
  const icoHex = ico.corner ? ico.corner.map(v => v.toString(16).padStart(2, '0')).join('') : '';
  const close = !!htmlHex && !!icoHex &&
    [0, 2, 4].every(i => Math.abs(parseInt(htmlHex.slice(i, i + 2), 16) - parseInt(icoHex.slice(i, i + 2), 16)) <= 8);
  ok('打包图标的底色与界面标记一致（换了 logo 没重新生成图标就会红）', close,
    `界面 ${htmlColor || '?'} / ico #${icoHex || '?'}`);

  const mk = fs.readFileSync(path.join(ROOT, 'tools', 'make-icon.js'), 'utf8');
  const mkReads = /['"]renderer['"]\s*,\s*['"]index\.html['"]/.test(mk);
  const mkSpan = /class="logo"/.test(mk);
  ok('图标生成脚本从 index.html 读标记（唯一来源，不许再另写一份 SVG）',
    mkReads && mkSpan,
    `读 index.html=${mkReads ? '有' : '没有'} · 找 <span class="logo">=${mkSpan ? '有' : '没有'}`);

  // ---- 2026-10-02 本轮：登录页去黑框 + 删出厂账号提示 / 颜色校验不再拦发布 / 商品池不再有示例数据 ----
  {
    const authSrc = fs.readFileSync(path.join(ROOT, 'src/main/auth.js'), 'utf8');
    const gateSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    const gateHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
    const poolSrc = fs.readFileSync(path.join(ROOT, 'src/main/services/pool.js'), 'utf8');
    const vSrc = fs.readFileSync(path.join(ROOT, 'src/main/services/verify.js'), 'utf8');
    const winSrc = fs.readFileSync(path.join(ROOT, 'src/main/window.js'), 'utf8');
    // ★ 负向断言只看**代码行**：下面两处源码里的注释正在解释「原来长什么样 / 为什么删」，
    //   一刀切会把注释误报成「没删干净」（实测踩过一次：注释里写着 defaultHint / 示例数据）。
    const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    // ① 登录页固定浅色：不能只改渲染层 —— 窗口底色也必须跟着浅，否则深色系统下先闪一块近黑
    ok('★ 登录页固定浅色（.gate 子树重声明浅色变量 + 登录门期间窗口底色也用浅色）',
      /\.gate\{[\s\S]{0,60}--bg:#f2f1ed; --panel:#ffffff;/.test(cssSrc)
      && /const GATE_BG = '#ffffff';/.test(winSrc)
      && /backgroundColor: locked \? GATE_BG : bg,/.test(winSrc)
      && /win\.setBackgroundColor\(GATE_BG\)/.test(winSrc)
      && /win\.setBackgroundColor\(bgColor\(\)\)/.test(winSrc));

    // ② 出厂账号提示：元素 / 代码 / 字段三处一起没了（只删一处会留下悬空读取）
    ok('★ 出厂账号提示已整条删除（index.html 元素 / app.js 那段 / auth.js 的 defaultHint 字段）',
      !/id="lgTip"/.test(gateHtml) && !/gtip/.test(codeOnly(cssSrc))
      && !/lgTip/.test(codeOnly(gateSrc)) && !/defaultHint/.test(codeOnly(authSrc)));

    // ③ 颜色校验不再拦发布：verify.js 里 `block = true;` 只许剩一处（多色漏填）
    const trueCount = (vSrc.match(/block = true;/g) || []).length;
    ok('★ 「颜色不匹配 / 主色不符」都不再拦发布（源码里 block = true; 只剩「多色漏填」那一处）',
      trueCount === 1 && /多色货号须指定颜色/.test(vSrc), 'block = true; 出现 ' + trueCount + ' 处');

    // ④ 商品池出厂没有任何示例数据
    ok('★ 商品池出厂没有示例货号（源码里不再有 SAMPLE / 示例数据）',
      !/SAMPLE/.test(codeOnly(poolSrc)) && !/示例数据/.test(codeOnly(poolSrc))
      && /skus: \{\}/.test(codeOnly(poolSrc)));

    // ⑤ 规则要写在「模拟器发布」页上（删掉那段文字时必须红）
    const pubHint = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-tab="6"]').click();
      await new Promise(r => setTimeout(r, 200));
      return document.querySelector('#pane').textContent || '';
    })()`);
    ok('★ 「模拟器发布」页写清了颜色规则（不是必需项 / 都不会拦住发布 / 默认选第一件商品）',
      /颜色校验不是必需项/.test(pubHint) && /都不会拦住发布/.test(pubHint)
      && /默认选第一件商品/.test(pubHint));
  }

  // ---- 2026-10-02 第二轮：品牌管理的「文案」按钮删除；账号权限改成行内按钮 + 弹窗 ----
  {
    const A = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    const H = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    const C = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
    // ★ 负向只看代码行：注释里正当地写着「原来那条下拉工具栏已经删了」，一刀切会误报
    const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    const A2 = codeOnly(A);
    const brandsFn = A2.slice(A2.indexOf('function brandsHtml()'), A2.indexOf('function adminUsersHtml()'));
    const adminFn = A2.slice(A2.indexOf('function adminUsersHtml()'), A2.indexOf('function upPermHtml'));

    // ① 品牌管理表里不再挂「文案」按钮（读的那条链要一起没了，不然旧路还能走回来）
    ok('★ 品牌管理表里没有「文案」按钮了（提示词统一在「文案生成 → 提示词配置」里改）',
      brandsFn.length > 0 && !/bm:open/.test(brandsFn) && !/>文案</.test(brandsFn),
      '这一段里 bm:open 出现 ' + (brandsFn.match(/bm:open/g) || []).length + ' 次');

    // ② 账号管理：行内两个入口
    ok('★ 账号管理表每行右侧是「配置权限 / 重置密码」两个按钮',
      /data-act="up:perm"/.test(adminFn) && /data-act="up:pwd"/.test(adminFn));

    // 新成员必须能在创建时直接选择启用品牌；云端 create_user 的首个约束就是至少一个品牌。
    const createAction = A2.slice(A2.indexOf("'auth:create': async () =>"), A2.indexOf("'auth:toggle': async"));
    ok('★ 新建成员表单可勾选启用品牌，创建前校验并把品牌 ID 一并提交',
      /data-new-brand=/.test(adminFn) && /filter\(b => b\.enabled !== false\)/.test(adminFn)
      && /普通成员至少选择一个启用品牌/.test(createAction)
      && /brands: role === 'user' \? brands : \[\]/.test(createAction));

    // ③ 旧的两条下拉工具栏连元素带动作一起删（只删控件、留着读取点 = 行为没变）
    ok('★ 旧的下拉工具栏整条删除（#pbUser / #rsUser / #rsPwd / auth:brands / >保存品牌权限< / permUserId 一个都不剩）',
      !/id="pbUser"/.test(A2) && !/id="rsUser"/.test(A2) && !/id="rsPwd"/.test(A2)
      && !/auth:brands/.test(A2) && !/>保存品牌权限</.test(A2) && !/permUserId/.test(A2));

    // ④ 弹窗容器：挂在 index.html，与品牌弹窗并列、在 .app 外面（塞进 .body 会被 overflow 裁掉）
    ok('★ 账号操作弹窗的容器在 index.html（#umodal + #umBox + 窄一档的 .mbox-sm）',
      /id="umodal"/.test(H) && /id="umBox"/.test(H) && /\.mbox-sm\{/.test(C));

    // ⑤ 两个视图与四个动作 + 两条关闭路径（Esc / 点遮罩）
    ok('★ 弹窗两个视图与四个动作都在（upPermHtml / upPwdHtml / up:permSave / up:pwdSave / up:close）',
      /function upPermHtml\(/.test(A2) && /function upPwdHtml\(/.test(A2)
      && /'up:permSave'/.test(A2) && /'up:pwdSave'/.test(A2) && /'up:close'/.test(A2));
    ok('★ 弹窗的关闭路径齐（Esc / 点遮罩 / 按钮都走 closeUserModal）',
      /closeUserModal\(\)/.test(A2) && /e\.target === umask/.test(A2)
      && /state\.userModal\) \{ closeUserModal\(\)/.test(A2));

    // ⑥ 权限判定不许只看界面：保存走真 IPC（authUpdateUser），不是只改内存
    ok('★ 弹窗保存权限走真 IPC（appApi.authUpdateUser(id, { brands: ids })），不是只改内存',
      /appApi\.authUpdateUser\(id, \{ brands: ids \}\)/.test(A2));
  }

  // ---- 2026-10-02 第三轮：登录页「白底白字 + 卡片外色块」/ emulator-5554 假序列号 / 视频复用图文 ----
  {
    const C3 = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
    const W3 = fs.readFileSync(path.join(ROOT, 'src/main/window.js'), 'utf8');
    const P3 = fs.readFileSync(path.join(ROOT, 'src/main/services/publisher.js'), 'utf8');
    const A3 = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    const J3 = fs.readFileSync(path.join(ROOT, 'src/main/jobs.js'), 'utf8');
    // ★ 负向只看代码行：publisher.js 的注释里正当地写着「绝不许再兜底 emulator-5554」
    const codeOnly3 = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');

    // ① 白底白字的根因：光重声明变量不够 —— body 上的 color:var(--tx) 已经按深色主题
    //    求过值，后代继承的是那个算完的浅字色。必须在 .gate 上**显式**给 color。
    ok('★ 登录页 .gate 显式声明了 color:var(--tx)（只重声明变量治不了继承来的白字）',
      /\.gate\{[\s\S]*?\n  color:var\(--tx\);/.test(C3));

    // ② 卡片外面不许再有底色块：gate 背景与卡片同色（纯白），且窗口＝卡片
    ok('★ 登录页卡片外不再有色块（gate 背景纯白 + 窗口宽 = 卡片宽 340 + 上下不留呼吸位）',
      /\.gate\{[^}]*background:#ffffff;/.test(C3)
      && !/\.gate\{[^}]*background:var\(--bg\)/.test(C3)
      && /const GATE_WIDTH = 340;/.test(W3)
      && /const GATE_PAD_Y = 0;/.test(W3)
      && /const GATE_BG = '#ffffff';/.test(W3));

    // ③ 假序列号兜底必须没了：没选设备时要老实报「还没选设备」，
    //    不许拿一台不存在的 emulator-5554 去 probe（那会让界面报「你选的设备…没连上」）
    ok('★ publisher.js 不再兜底假序列号（没选设备就报「还没选设备」）',
      !/\|\| 'emulator-5554'/.test(codeOnly3(P3))
      && /const serial = device \|\| c\.device \|\| \(list\[0\] && list\[0\]\.serial\) \|\| '';/.test(P3)
      && /还没选设备/.test(P3));

    // ③b ★★ 2026-10-03：同一族缺陷还有一个 —— publisher.run() 里的
    //     `|| '127.0.0.1:5555'` 兜底。后果与 emulator-5554 那次一模一样：
    //     没选设备也能“跑起来”，实际拿一台不存在的设备去发，界面与台账却是绿的。
    //    判据（可复算）：代码行里不得出现 `|| '127.0.0.1:任意端口'`；且 run() 里
    //    必须是 `|| ''` + 一条“还没选设备”的显式报错。
    ok('★ publisher.run() 不兜底任何硬编码序列号，没选设备直接报错',
      !/\|\|\s*'127\.0\.0\.1:\d+'/.test(codeOnly3(P3))
      && !/\|\|\s*"127\.0\.0\.1:\d+"/.test(codeOnly3(P3))
      && /const serial = \(state\.publish && state\.publish\.device\) \|\| c\.device \|\| '';/.test(P3)
      && /mode === 'adb' && !serial/.test(codeOnly3(P3)));

    // ④ ★★ 面向用户的文案里**一个设备名字例都不许有**。
    //    上一版只查了 app.js 的「如 emulator-5554」，结果 adb.js 的
    //    「（雷电 / MuMu 默认就叫 emulator-5554）」整段溜过去了 —— 用户直接截图打脸。
    //    判据（可复算）：src/ 下所有 js/html/css 里，emulator-5554 只允许出现在**注释行**。
    const straySerials = [];
    (function walk(p) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!/\.(js|html|css)$/.test(e.name)) continue;
        fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((ln, i) => {
          if (!ln.includes('emulator-5554')) return;
          const t = ln.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          straySerials.push(path.relative(ROOT, f) + ':' + (i + 1));
        });
      }
    })(path.join(ROOT, 'src'));
    ok('★ 面向用户的文案里不再出现序列号示例（emulator-5554 只许出现在注释里）',
      straySerials.length === 0, straySerials.join(' | '));

    // ⑤ 「还没选设备」这条提示的正文里**连动态拼进去的设备名也不许有** ——
    //    用户看到界面上冒出一串英文数字，分不清那是模拟器真名还是程序写死的，一律不出现。
    const ADB3 = fs.readFileSync(path.join(ROOT, 'src/main/services/adb.js'), 'utf8');
    const saySeg = (() => {
      const i = ADB3.indexOf('还没选设备（但检测到你有模拟器在线）');
      if (i < 0) return '';
      const j = ADB3.indexOf(": '三步：", i);
      return j < 0 ? '' : ADB3.slice(i, j);
    })();
    ok('★ 「还没选设备」的提示正文里不点名任何设备（连动态拼的也不许）',
      saySeg.length > 0 && !/\$\{/.test(saySeg), saySeg.slice(0, 110));

    // ⑥ 视频没单独配时复用图文 steps（用户实测两者发布位置一样）
    //   ★ 2026-10-04 改成**行为级**：以前这里拿正则匹配 publisher 里那一行源码
    //     （`const steps = isVideo ? …`），结果我在别处重构时那行写法一变、语义一字没改，
    //     测试就红了 —— 「锁死写法」的断言挡不住真问题、却每次重构都误报。
    //     现在直接喂三种输入验语义（uimap.stepsFor 是纯函数）。
    const uimapMod = require(path.join(ROOT, 'src/main/services/uimap.js'));
    const MAP_NOV = { steps: [{ action: 'tapText', value: 'A' }], videoSteps: [] };
    const MAP_WITHV = { steps: [{ action: 'tapText', value: 'A' }], videoSteps: [{ action: 'tapText', value: 'B' }] };
    ok('★ 视频复用图文定位表：videoSteps 空 ⇒ 用 steps；配了 ⇒ 用 videoSteps；图文恒用 steps',
      JSON.stringify(uimapMod.stepsFor(MAP_NOV, true)) === JSON.stringify(MAP_NOV.steps)
      && JSON.stringify(uimapMod.stepsFor(MAP_WITHV, true)) === JSON.stringify(MAP_WITHV.videoSteps)
      && JSON.stringify(uimapMod.stepsFor(MAP_WITHV, false)) === JSON.stringify(MAP_WITHV.steps)
      // 老表/空表也不能炸（以前就是这个位置抛错，用户看到「视频条会直接失败」）
      && JSON.stringify(uimapMod.stepsFor(null, true)) === '[]'
      && JSON.stringify(uimapMod.stepsFor({}, true)) === '[]'
      && !/视频条会直接失败/.test(J3));
    // 反向对照：证明这条断言真在查东西 —— 把「视频优先 videoSteps」这件事喂反，必须不成立
    ok('★ 反向对照：图文那条路**不许**被 videoSteps 影响（否则上面那条是空==空）',
      JSON.stringify(uimapMod.stepsFor(MAP_WITHV, false)) !== JSON.stringify(MAP_WITHV.videoSteps));

    // ⑦ 界面不再说「视频未配」（改成「视频复用图文」，免得用户以为还要再抓一次）
    ok('★ 界面把「视频未配」改成「视频复用图文」',
      !/视频未配/.test(codeOnly3(A3)) && /视频复用图文/.test(A3));
  }

  // ---- 2026-10-03（第十一次会话）：「删功能」真正会漏的那一环 —— 别处还在指路 ----
  //   用户原话：「目前发布单没啥用，删了吧」「去掉发布失败重试次数和失败恢复动作」。
  //   页签、下拉框、配置键谁都会删；**真正会被漏掉的是别处还在指着它的那几句话** ——
  //   用户照着那句提示去点，点到一个不存在的页面，只会以为程序坏了（比不删更糟）。
  //   实测就是踩在这上面：模拟器发布页空态写着「先到「发布单」导出 xlsx」，
  //   而「发布单」页签当天已删；高级设置页的副标题也还列着已整块删掉的「失败恢复动作」。
  {
    const A4 = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    const H4 = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    // ★ 只留「用户能看见的字」：剥掉块注释 / HTML 注释 / 行注释。
    //   块注释用**保持行数**的剥法（内容换成空格、\n 留着）—— 否则剥完行号会整体错位，
    //   报出来的位置是假的，等于把「可复算的证据」变成猜。
    const visibleOnly = s => s
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    const A4c = visibleOnly(A4);
    const H4c = visibleOnly(H4);

    // ① 「发布单」页签已删 ⇒ 任何用户可见文案都不许再让人「到『发布单』去」
    ok('★ 用户可见文案不再把用户指到已删除的「发布单」页签',
      !/到「发布单」/.test(A4c) && !/「发布单」页/.test(A4c)
      && /请先导入 AI 内容报告/.test(A4c));

    // ② 已删功能的名字不许再出现在用户可见文案里
    //    （「失败恢复动作」「失败重试 N 次」是 2026-10-03 用户要求整块删的两项）
    const deadNames = ['失败恢复动作', '恢复动作', '失败重试', '重试次数', '演示节奏'];
    const hits = [];
    [['src/renderer/app.js', A4c], ['src/renderer/index.html', H4c]].forEach(([f, s]) => {
      s.split('\n').forEach((ln, i) => {
        deadNames.forEach(w => { if (ln.indexOf(w) >= 0) hits.push(f + ':' + (i + 1) + ' ' + w); });
      });
    });
    ok('★ 已删功能的名字不再出现在用户可见文案里（失败恢复动作 / 失败重试 / 重试次数 / 演示节奏）',
      hits.length === 0, hits.join(' | ') || '无');
  }

  // ---- 2026-10-03（第十二次会话）：窗口最小尺寸 / 侧栏永远在左侧 ----
  //   用户原话：「目录始终固定在左侧，不能因窗口变小就放到上面。并且限制窗口的最小尺寸」。
  //   ★ 实测根因（不是猜的）：styles.css 原来有条
  //       @media (max-width:900px){ .body{flex-direction:column} .side{…flex-direction:row…} }
  //     会把侧栏翻到顶上横排；而主窗口的 minWidth **恰好也是 900** ⇒ 窗口一缩到最小就正好命中，
  //     用户每次拖到底都会看到侧栏跳上去。实测：窗口 940 侧栏还竖着，930 起翻。
  //   ★ 这组断言盯的是「用户把窗口拖到最小」这个**真实动作**，不是盯源码里有没有某行字。
  {
    const sleep5 = ms => new Promise(r => setTimeout(r, ms));
    const winMod = require(path.join(ROOT, 'src/main/window.js'));
    const MIN = winMod.MAIN_MIN;
    ok('★ window.js 导出了主窗口最小尺寸（自检拿真值，不在测试里另写一份数字）',
      !!(MIN && MIN.w > 0 && MIN.h > 0), JSON.stringify(MIN));
    ok('★ 最小宽度留得下侧栏(156) + 内容区左右边距(88)',
      !!MIN && MIN.w > 244, MIN ? (MIN.w + ' > 244') : '缺');

    // ① 源码级：不许再存在「把侧栏改成横排」的媒体查询
    const C5 = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
    const cssNoComment = C5.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const mediaBlocks = cssNoComment.match(/@media[^{]*\{[\s\S]*?\n\}/g) || [];
    const flip = mediaBlocks.filter(b => /\.side\b[\s\S]{0,240}?flex-direction\s*:\s*row/.test(b));
    ok('★ styles.css 里没有「窄屏把侧栏改成横排」的媒体查询（用户：目录永远在左侧）',
      flip.length === 0,
      flip.length ? flip[0].slice(0, 90).replace(/\s+/g, ' ') : `共 ${mediaBlocks.length} 个媒体查询块，无侧栏横排`);

    // ② 源码级：最小尺寸两处走同一个常量（以前 createWindow 和 setLoginMode 各写一份 900/600，
    //    改一处漏一处就会「登录一次之后最小尺寸又变回去」）
    const winSrc5 = fs.readFileSync(path.join(ROOT, 'src/main/window.js'), 'utf8');
    const winCode5 = winSrc5.split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    ok('★ 两处最小尺寸都走 MAIN_MIN_* 常量、没有写死的数字',
      /minWidth:\s*locked\s*\?\s*340\s*:\s*MAIN_MIN_W/.test(winCode5)
      && /setMinimumSize\(MAIN_MIN_W,\s*MAIN_MIN_H\)/.test(winCode5)
      && !/minWidth:\s*locked\s*\?\s*340\s*:\s*\d/.test(winCode5),
      `MAIN_MIN_* 出现 ${(winCode5.match(/MAIN_MIN_[WH]/g) || []).length} 次`);

    // ③ 让「品牌统计」页真的渲染出那张宽表 —— 空数据下它只有空态，量不到宽度等于没测（假绿）
    const savedStats = await win.webContents.executeJavaScript('JSON.stringify(state.stats)');
    await win.webContents.executeJavaScript(`(function(){
      // ★ 桩必须与真实**同形态**（形状照抄 src/main/services/stats.js 的 return）：
      //   少一个字段就会让渲染层抛异常 —— 第一版只写了 totals/brands/untagged，缺 range，
      //   于是 app.js 读 s.range.label 直接崩，把「渲染层零控制台报错」那条绊红了。
      //   空数组是合法的（logsShown=0），不能省字段。
      state.stats = {
        generatedAt: Date.now(),
        range: { days: 7, label: '最近 7 天', fromTs: 0, from: '2026-09-27', to: '2026-10-03' },
        sources: {
          publishLog: { file: 'C:/tmp/publish-log.jsonl', entries: 3, entriesInRange: 3, size: 512 },
          runLog: { file: 'C:/tmp/run-log.jsonl', entries: 1, size: 128 }
        },
        totals: { rows: 3, ok: 3, fail: 0, other: 0, batches: 2, runs: 1, runFails: 0,
                  filtered: false, consideredInRange: 3, totalInLog: 3 },
        logsShown: 0, logsTotal: 0,
        brands: [{ id: 'b1', name: '自检品牌甲', rows: 2, ok: 2, fail: 0, other: 0, batches: 1,
                   lastDay: '2026-10-03', byDay: [{ date: '2026-10-03', rows: 2, ok: 2, fail: 0, other: 0 }],
                   users: [{ displayName: '自检执行人', rows: 2 }], enabled: true, orphan: false }],
        untagged: { id: '__none__', name: '未标品牌', rows: 1, ok: 1, fail: 0, other: 0, batches: 1,
                    lastDay: '2026-10-03', byDay: [], users: [], enabled: true, orphan: false },
        orphans: [], daily: [], users: [], logs: [], notes: []
      };
    })()`);

    const statsInteraction = await win.webContents.executeJavaScript(`(() => {
      const oldTab = state.tab;
      state.tab = 8;
      const b = state.stats.brands[0], oldUsers = b.users;
      b.users = [1,2,3].map(i => ({ userId:'u'+i, username:'账号'+i, displayName:i === 3 ? '<img src=x onerror=alert(1)>' : '执行人'+i, rows:i, ok:i, fail:0 }));
      state.stats.account = { available:true, rows:9, ok:7, fail:2 };
      renderAll();
      const btn = document.querySelector('[data-act="stats:users"]');
      const folded = !!btn && btn.textContent.includes('3');
      if(btn) btn.click();
      const popup = !document.querySelector('#umodal').hidden && document.querySelectorAll('#umBox tbody tr').length === 3;
      const escaped = !document.querySelector('#umBox img');
      closeUserModal();
      const centered = [...document.querySelectorAll('.stats-page th,.stats-page td')].every(e => getComputedStyle(e).textAlign === 'center');
      const account = document.querySelector('#pane').textContent.includes('账号汇总') && document.querySelector('#pane').textContent.includes('已发布篇数')
        && !document.querySelector('#pane').textContent.includes('全部时间（跨设备）');
      b.users = b.users.slice(0,2); renderAll();
      const inline = !document.querySelector('[data-act="stats:users"]') && document.querySelector('#pane').textContent.includes('执行人1');
      b.users = oldUsers; delete state.stats.account; state.tab = oldTab; renderAll();
      return { folded,popup,escaped,centered,account,inline };
    })()`);
    ok('品牌执行人超过两位折叠为可点击按钮', statsInteraction.folded);
    ok('实际点击执行人按钮弹出完整名单', statsInteraction.popup);
    ok('执行人弹窗转义名称，阻止 HTML 注入', statsInteraction.escaped);
    ok('品牌统计表头和数据全部居中', statsInteraction.centered);
    ok('统计页显示本账号累计成功篇数', statsInteraction.account);
    ok('两位执行人保持行内显示', statsInteraction.inline);

    try {
      // 把窗口缩到应用允许的最小尺寸 —— 这就是「用户把窗口拖到底」
      win.setSize(MIN.w, MIN.h);
      await sleep5(420);

      const geo = JSON.parse(await win.webContents.executeJavaScript(`(function(){
        var s=document.querySelector('#side'), m=document.querySelector('.main'), b=document.querySelector('.body');
        var rs=s.getBoundingClientRect(), rm=m.getBoundingClientRect();
        return JSON.stringify({
          vw: window.innerWidth, vh: window.innerHeight,
          sideFlex: getComputedStyle(s).flexDirection,
          bodyDir: getComputedStyle(b).flexDirection,
          sideX: Math.round(rs.x), sideY: Math.round(rs.y), sideW: Math.round(rs.width), sideH: Math.round(rs.height),
          mainX: Math.round(rm.x), mainY: Math.round(rm.y), mainH: Math.round(rm.height)
        });
      })()`));
      ok('★ 缩到最小尺寸后侧栏仍是**竖排**（不是横排贴到顶上）—— 正是用户反馈的那一幕',
        geo.sideFlex === 'column' && geo.bodyDir === 'row', JSON.stringify(geo));
      // 「并排」的判据：侧栏贴左(sideX=0)、主区紧贴侧栏右边(mainX=sideW)、两者**顶部对齐**。
      //   堆叠时主区会从最左边开始（mainX=0），这条就红了。
      // ★ 两个自己绊自己的写法，都实测踩过，别再写回去：
      //   ① 「主区比侧栏高」—— 并排时两者本来就等高（实测 sideH=mainH=429）；
      //   ② 「主区顶到 y=0」—— 上面还有自绘标题栏，实测 mainY=38 就是它。
      ok('★ 缩到最小尺寸后侧栏仍在**左侧**、内容区在它右边（不是上下堆叠）',
        geo.sideX === 0 && geo.mainX >= geo.sideW - 1 && geo.sideW === 156
        && Math.abs(geo.sideY - geo.mainY) <= 1,
        `sideX=${geo.sideX} sideY=${geo.sideY} sideW=${geo.sideW} mainX=${geo.mainX} mainY=${geo.mainY}`);

      // ④ 最小尺寸够不够用：11 个页签挨个切一遍，看有没有横向溢出 / 表格横滚
      const navs5 = JSON.parse(await win.webContents.executeJavaScript(
        "JSON.stringify([].slice.call(document.querySelectorAll('.nav')).filter(function(b){return !b.hidden}).map(function(b){return b.getAttribute('data-tab')}))"));
      let worstTab = '-', worstOver = 0, worstTbl = 0, tblTab = '-';
      for (const t of navs5) {
        await win.webContents.executeJavaScript(`document.querySelector('.nav[data-tab="${t}"]').click();`);
        await sleep5(80);
        const m = JSON.parse(await win.webContents.executeJavaScript(`(function(){
          var p=document.querySelector('#pane');
          var tws=[].slice.call(p.querySelectorAll('.tw')), mx=0;
          tws.forEach(function(x){ mx=Math.max(mx,x.scrollWidth-x.clientWidth); });
          return JSON.stringify({ paneOver: p.scrollWidth-p.clientWidth, tblOver: mx });
        })()`));
        if (m.paneOver > worstOver) { worstOver = m.paneOver; worstTab = 'tab' + t; }
        if (m.tblOver > worstTbl) { worstTbl = m.tblOver; tblTab = 'tab' + t; }
      }
      ok('★ 最小尺寸下没有页签横向溢出（内容不会被裁掉）',
        worstOver === 0, `最大 ${worstOver}px @ ${worstTab}（切了 ${navs5.length} 个页签）`);
      ok('★ 最小尺寸930px下品牌统计表格不横向滚动',
        worstTbl === 0, `最大表横滚 ${worstTbl}px @ ${tblTab}`);
    } finally {
      // ★ 还原：窗口尺寸 + 假 stats + 回到第 1 页。不还原 ⇒ 后面的断言全建在被改过的界面上。
      win.setSize(1280, 820);
      await win.webContents.executeJavaScript(`(function(){
        state.stats = ${savedStats};
        state.tab = 1; renderAll();
      })()`);
      await sleep5(220);
    }
  }

  const deviceUi = await win.webContents.executeJavaScript(`(() => {
    deviceScanAt = Date.now(); state.tab = 6;
    state.devFound = [{name:'MuMu新窗口',serial:'127.0.0.1:21347',state:'device',online:true,configured:false},
      {name:'MuMu启动窗口',serial:'',state:'starting',online:false,configured:false}];
    renderAll();
    paintDevices();
    const text = document.getElementById('devicesPanel').textContent;
    const result = {named:text.includes('MuMu新窗口')&&text.includes('21347'),
      states:text.includes('已连接')&&text.includes('启动中'),
      noSerial:!document.getElementById('devName')&&!document.getElementById('devSerial')&&!document.querySelector('[data-act="pub:addDev"]'),
      noManual:!text.includes('确认它开了')&&text.includes('自动连接')};
    state.devFound = null; state.tab = 1; renderAll(); return result;
  })()`);
  ok('设备界面显示实例名称与实际端口', deviceUi.named);
  ok('设备界面区分已连接与启动中', deviceUi.states);
  ok('自动刷新后也没有手填序列号入口', deviceUi.noSerial);
  ok('设备界面不再要求用户手动排查 ADB', deviceUi.noManual);
  const simplified = await win.webContents.executeJavaScript(`(() => {
    state.tab = 6; renderAll();
    const acts = [...document.querySelectorAll('#head [data-act]')].map(b => b.dataset.act);
    const text = document.querySelector('#pane').textContent;
    const keep = state.probe;
    state.probe = { device:{serial:'test-device'}, appPackage:null, adbKeyboard:false, adbKeyboardActive:false, fix:[
      {level:'bad',title:'模拟器里没找到得物',how:'请先安装',act:{act:'go:dewu',label:'去设置下载得物'}},
      {level:'bad',title:'中文标题和正文发不出去（没装中文输入法）',how:'需配置输入法'}
    ] };
    renderAll();
    const beforeClickCards = document.querySelectorAll('#pane .device-probe > div[style*="border-left:3px solid"]').length;
    const onlyDewu = beforeClickCards === 1 && document.querySelector('#pane').textContent.includes('去设置下载得物')
      && !document.querySelector('#pane').textContent.includes('中文标题和正文发不出去');
    const imeRow = [...document.querySelectorAll('#pane details tr')].find(tr => tr.textContent.includes('中文输入 ADBKeyboard'));
    const imePending = !!imeRow && imeRow.textContent.includes('未检查') && !imeRow.textContent.includes('不满足');
    const jump = document.querySelector('[data-act="go:dewu"]');
    jump.click();
    const routed = state.tab === 7 && !!document.querySelector('[data-act="apk:save"]') && !!document.querySelector('[data-act="apk:install"]');
    state.probe = keep; state.tab = 1; renderAll();
    return { acts, noInternals: !/模拟通道|定位表.*步|视频.*步/.test(text), routed, onlyDewu, imePending,
      names: [...document.querySelectorAll('.name,#loginForm .gname')].every(e => e.textContent === '得物蓝V素材发布工具') };
  })()`);
  ok('发布页顶部只保留导入、停止、开始三个入口', simplified.acts.join(',') === 'sheet:importReport,pub:stop,pub:run');
  ok('发布页不显示模拟通道和定位步骤等内部信息', simplified.noInternals);
  ok('缺少得物时可一键跳到设置的下载及安装入口', simplified.routed);
  ok('得物未安装且输入法也不可用时只显示一条红色引导', simplified.onlyDewu);
  ok('未安装得物时输入法标为未检查，不误报第二个红色故障', simplified.imePending);
  ok('登录页和正式页面标题统一删除蓝V后的空格', simplified.names);
  const regressionUi = await win.webContents.executeJavaScript(`(() => {
    const previousProbe = state.probe, previousCompliance = state.project.compliance;
    try {
      state.probe = {device:null,appPackage:null,fix:[{level:'bad',title:'设备离线',how:'请重新连接'}]};
      const offline = probeHtml().includes('设备离线') && !probeHtml().includes('一切就绪');
      state.probe = {device:{serial:'online'},appPackage:'com.shizhuang.duapp',fix:[{level:'bad',title:'输入法不可用',how:'请重新连接'}]};
      const installed = probeHtml().includes('输入法不可用');
      state.project.compliance = {stats:{ok:0,todo:65,manual:28,total:93},rows:[
        ...Array.from({length:65},(_,i)=>({file:'auto'+i,type:'视频',status:'todo',issue:'转码',action:'转 MP4'})),
        ...Array.from({length:28},(_,i)=>({file:'manual'+i,type:'视频',status:'manual',issue:'无法读取视频时长',action:'人工确认'}))
      ]};
      const container = document.createElement('div'); container.innerHTML = TABS[2].render();
      const rows = [...container.querySelectorAll('tbody tr')];
      return {offline,installed,complete:rows.length===93 && rows.filter(r=>r.textContent.includes('manual')).length===28,
        first:rows[0].textContent.includes('manual0'),noProject:!document.querySelector('#chipProj'),
        noCounts:!document.querySelector('#side .st,#side [data-st]')};
    } finally {state.probe=previousProbe;state.project.compliance=previousCompliance;}
  })()`);
  ok('设备离线时连接故障仍显示，不被误报为就绪', regressionUi.offline);
  ok('已安装得物时输入法错误仍显示', regressionUi.installed);
  ok('合规结果超过60条时28项未自动处理仍完整可见且优先显示', regressionUi.complete && regressionUi.first);
  ok('主工作页移除顶部项目标识', regressionUi.noProject);
  ok('左侧所有模块移除数字和状态角标', regressionUi.noCounts);
  const complianceBusy = await win.webContents.executeJavaScript(`(() => {
    const saved = { jobs: state.jobs, compliance: state.project.compliance, tab: state.tab };
    try {
      state.tab = 2;
      const results = [];
      for (const type of ['compliance.scanParent', 'compliance.scan', 'compliance.fix']) {
        state.jobs = [{ id: '合规进度测试', type, progress: { done: 1, total: 3, label: '当前批次' } }];
        state.project.compliance = { rows: [], stats: null };
        renderAll();
        const first = !!document.querySelector('#prog') && document.querySelector('#pane').textContent.includes('正在');
        updateProgress({ done: 2, total: 3, label: '下一批次' });
        const updated = document.querySelector('#progTxt').textContent.includes('2 / 3');
        state.project.compliance = { rows: [{ file: '上次报告.jpg', status: 'manual', issue: '尺寸不足' }], stats: { total: 1, manual: 1 } };
        renderAll();
        results.push(first && updated && !!document.querySelector('#prog') && document.querySelector('#pane').textContent.includes('上次报告.jpg'));
      }
      return results;
    } finally { state.jobs = saved.jobs; state.project.compliance = saved.compliance; state.tab = saved.tab; renderAll(); }
  })()`);
  ok('首次父目录检查、普通检查和处理均显示并更新进度，重新检查保留上次报告', complianceBusy.length === 3 && complianceBusy.every(Boolean));
  const { dialog } = require('electron');
  const originalDirDialog = dialog.showOpenDialog;
  let dirOptions = null;
  dialog.showOpenDialog = async (...args) => { dirOptions = args[args.length - 1]; return { canceled:true, filePaths:[] }; };
  try {
    await win.webContents.executeJavaScript(`(async () => {
      const keep = state.project.flatDir;
      state.project.flatDir = 'C:\\\\素材\\\\flat_20261010';
      try { await ACTS['copy:pickRun'](); } finally { state.project.flatDir = keep; }
    })()`);
    ok('文案目录选择器直接打开生成目录的母目录', dirOptions && dirOptions.defaultPath === path.join('C:\\素材'));
    for (const fixture of [
      { flatDir: path.join(TMP, '整理后', 'flat_测试'), sourceDir: path.join(TMP, '原始', '素材'), name: '已有整理结果' },
      { flatDir: '', sourceDir: path.join(TMP, '原始', '素材'), name: '尚未整理' }
    ]) {
      const options = [];
      dialog.showOpenDialog = async (...args) => { options.push(args[args.length - 1]); return { canceled:true, filePaths:[] }; };
      await win.webContents.executeJavaScript(`(async () => {
        const keepFlat = state.project.flatDir, keepSource = state.project.sourceDir;
        try {
          Object.assign(state.project, ${JSON.stringify({ flatDir: fixture.flatDir, sourceDir: fixture.sourceDir })});
          await ACTS['copy:pickRun']();
          await ACTS['comp:parent']();
        } finally {state.project.flatDir=keepFlat;state.project.sourceDir=keepSource;}
      })()`);
      const expected = path.dirname(fixture.flatDir || fixture.sourceDir);
      ok(`${fixture.name}时合规父目录与文案目录弹窗打开同一母目录`, options.length === 2 && options.every(o => o.defaultPath === expected));
    }
    for (const fixture of [
      { name: '本次刚生成报告', generated: path.join(TMP, '本次报告', 'AI内容报告.xlsx'), imported: path.join(TMP, '旧报告', '旧.xlsx'), flatDir: path.join(TMP, '整理后') },
      { name: '重启后已有导入报告', generated: '', imported: path.join(TMP, '旧报告', '旧.xlsx'), flatDir: path.join(TMP, '整理后') },
      { name: '还没有报告但已整理', generated: '', imported: '', flatDir: path.join(TMP, '整理后') },
      { name: '尚未整理', generated: '', imported: '', flatDir: '' },
      { name: '没有素材', generated: '', imported: '', flatDir: '', sourceDir: '' }
    ]) {
      const sourceDir = fixture.sourceDir === '' ? '' : path.join(TMP, '原素材');
      const selected = [];
      dialog.showOpenDialog = async (...args) => { selected.push(args[args.length - 1]); return { canceled:true, filePaths:[] }; };
      await win.webContents.executeJavaScript(`(async () => {
        const keep = {report:lastCopyReport,publish:state.project.publish,flat:state.project.flatDir,source:state.project.sourceDir};
        try {
          lastCopyReport = ${JSON.stringify(fixture.generated)} ? {file:${JSON.stringify(fixture.generated)}} : null;
          state.project.publish = {reportFile:${JSON.stringify(fixture.imported)}};
          state.project.flatDir = ${JSON.stringify(fixture.flatDir)};
          state.project.sourceDir = ${JSON.stringify(sourceDir)};
          await ACTS['sheet:importReport']();
        } finally {lastCopyReport=keep.report;state.project.publish=keep.publish;state.project.flatDir=keep.flat;state.project.sourceDir=keep.source;}
      })()`);
      const expected = fixture.generated || fixture.imported || fixture.flatDir || sourceDir || undefined;
      ok(`${fixture.name}时导入报告定位正确，取消后不继续弹窗`, selected.length === 1
        && selected[0].defaultPath === expected && selected[0].properties.includes('openFile')
        && selected[0].filters[0].extensions.join(',') === 'xlsx');
    }
  } finally { dialog.showOpenDialog = originalDirDialog; }
  // 点击小报告按钮只能打开刚生成的本地 Excel，不能打开目录或另存副本。
  const reportFixture = path.join(TMP, '本次AI内容报告.xlsx');
  fs.writeFileSync(reportFixture, '仅测试打开路径，不启动真实办公软件');
  const { shell } = require('electron');
  const originalOpenPath = shell.openPath, originalReveal = shell.showItemInFolder;
  let openedReport = '', revealCount = 0;
  shell.openPath = async file => { openedReport = file; return ''; };
  shell.showItemInFolder = () => { revealCount++; };
  try {
    const buttonState = await win.webContents.executeJavaScript(`(async () => {
      const previous = lastCopyReport;
      try {
        await afterCopy({result:{reportFile:${JSON.stringify(reportFixture)},reportRows:3}});
        const container = document.createElement('div'); container.innerHTML = TABS[3].render();
        const button = container.querySelector('[data-act="copy:openReport"]');
        await ACTS['copy:openReport']();
        const generated = container.textContent;
        await afterCopy({result:{reportFile:${JSON.stringify(reportFixture)},reportRows:28,reportFlagged:28,reportProblems:[]}});
        const suggestionsOnly = TABS[3].render();
        await afterCopy({result:{reportFile:${JSON.stringify(reportFixture)},reportRows:3,reportFlagged:3,
          reportProblems:[{text:'缺货号',rows:1},{text:'正文为空',rows:2}]}});
        const actualErrors = TABS[3].render();
        return {small:button.classList.contains('sm'), icon:!!button.querySelector('svg'), label:button.getAttribute('aria-label'),generated,suggestionsOnly,actualErrors};
      } finally {lastCopyReport=previous;renderAll();}
    })()`);
    ok('生成后提供带下载图标的小报告按钮', buttonState.small && buttonState.icon && /本地/.test(buttonState.label));
    ok('报告按钮直接打开本次本地 Excel，不打开资源管理器', openedReport === reportFixture && revealCount === 0);
    ok('报告无实际错误时显示文案已生成，不再声称自动核对一致', /文案已生成/.test(buttonState.generated) && !/自动核对一致|待核对/.test(buttonState.generated));
    ok('28 行风格建议不会被页面报成 28 行待核对', /文案已生成/.test(buttonState.suggestionsOnly) && !/待核对|自动核对一致/.test(buttonState.suggestionsOnly));
    ok('报告真实字段错误具体显示原因和数量', /缺货号 1 行/.test(buttonState.actualErrors) && /正文为空 2 行/.test(buttonState.actualErrors) && !/文案已生成|待核对/.test(buttonState.actualErrors));
  } finally {shell.openPath = originalOpenPath;shell.showItemInFolder = originalReveal;}
  const rowRefresh = await win.webContents.executeJavaScript(`(() => {
    const keep = { project: state.project, tab: state.tab };
    try {
      state.project = Object.assign({}, state.project, { publish: { rows: [{ id: 'live-row', seq: 1, dir: 'live-row', result: '', status: '排队' }] } });
      state.tab = 6; renderAll();
      const before = publishRowElement('live-row');
      const directoryBefore = before.children[1].getBoundingClientRect();
      updatePublishRow({ id: 'live-row', startAt: '12:34:56', startedAtMs: Date.now() - 4000, elapsed: 0, status: '清相册', result: '' });
      refreshPublishElapsed();
      const started = before.querySelector('[data-publish-start]').textContent === '12:34:56';
      const ticking = parseFloat(before.querySelector('[data-publish-elapsed]').textContent) >= 3.5;
      const phase = before.querySelector('[data-publish-status]').textContent.includes('清相册');
      const stable = before === publishRowElement('live-row');
      updatePublishRow({ id: 'live-row', status: '写媒体库确认 123456s' });
      const directoryAfter = before.children[1].getBoundingClientRect();
      const layoutStable = directoryBefore.x === directoryAfter.x && directoryBefore.width === directoryAfter.width
        && directoryBefore.height === directoryAfter.height;
      updatePublishRow({ id: 'live-row', result: '发布成功', elapsed: 7.5, reason: '<img id="row-injected" src="x">' });
      refreshPublishElapsed();
      const stopped = before.querySelector('[data-publish-elapsed]').textContent === '7.5s';
      const escaped = !document.querySelector('#row-injected');
      updatePublishRow({ id: 'live-row', result: '失败', reason: '测试失败' });
      const retry = !!before.querySelector('[data-publish-action] [data-act="pub:rerun"]');
      updatePublishRow({ id: 'live-row', result: '', reason: '', elapsed: 0, startedAtMs: Date.now() });
      const retryCleared = !before.querySelector('[data-publish-action] button');
      state.tab = 1;
      updatePublishRow({ id: 'live-row', startAt: '13:00:00' });
      state.tab = 6; renderAll();
      const retained = publishRowElement('live-row').querySelector('[data-publish-start]').textContent === '13:00:00';
      return { started, ticking, phase, stable, stopped, escaped, retained, retry, retryCleared, layoutStable };
    } finally { state.project = keep.project; state.tab = keep.tab; renderAll(); }
  })()`);
  ok('发布行开始时间、阶段与实时耗时更新，且不重建该行',
    rowRefresh.started && rowRefresh.ticking && rowRefresh.phase && rowRefresh.stable, JSON.stringify(rowRefresh));
  ok('发布状态文字增长不会改变素材目录列的位置、宽度和行高', rowRefresh.layoutStable, JSON.stringify(rowRefresh));
  ok('发布结束耗时停止、切换页面数据保留、错误文字安全转义',
    rowRefresh.stopped && rowRefresh.escaped && rowRefresh.retained && rowRefresh.retry && rowRefresh.retryCleared, JSON.stringify(rowRefresh));
  // IntersectionObserver 在完全隐藏的窗口里会暂停画布；短暂显示测试窗口验证真实可见播放。
  win.showInactive();
  const releaseCheck = await win.webContents.executeJavaScript(`(async () => {
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    state.tab = 13; renderAll();
    document.querySelector('#pane').scrollTop = 0;
    document.querySelector('[data-release-canvas]').scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 500));
    const c = document.querySelector('[data-release-canvas]');
    const first = c.toDataURL();
    const flow = document.querySelector('.release-flow');
    const offset = getComputedStyle(flow).strokeDashoffset;
    await new Promise(r => setTimeout(r, 500));
    const second = c.toDataURL();
    const pipelineAnimated = offset !== getComputedStyle(flow).strokeDashoffset;
    await new Promise(r => setTimeout(r, 500));
    const animated = first !== second && second !== c.toDataURL();
    const media = window.matchMedia;
    let reducedAnimated = false;
    try {
      window.matchMedia = query => query.includes('prefers-reduced-motion') ? { matches: true } : media.call(window, query);
      window.releaseMotion.mount();
      await new Promise(r => setTimeout(r, 300));
      const reducedFirst = c.toDataURL();
      await new Promise(r => setTimeout(r, 500));
      reducedAnimated = reducedFirst !== c.toDataURL();
    } finally { window.matchMedia = media; }
    if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete document.hidden;
    const stations = document.querySelectorAll('.release-pipeline li').length;
    const dateGroups = document.querySelectorAll('.release-date').length;
    state.tab = 12; renderAll();
    if (!state.lex) await loadLexicon();
    const cells = [...document.querySelectorAll('.skeleton-table tbody td:nth-child(2)')];
    const namesFit = cells.length === 15 && cells.every(c => c.scrollWidth <= c.clientWidth);
    state.tab = 13; renderAll();
    return { animated, pipelineAnimated, reducedAnimated, canvasFrames: c.dataset.frame, canvasSize: [c.width,c.height], stations, dateGroups, namesFit, updatePanel: !!document.querySelector('#versionUpdate [data-act="update:check"]') };
  })()`);
  win.hide();
  ok('更新日志轮廓连续变化、流程动画移动，减少动态效果模式仍缓慢播放', releaseCheck.animated && releaseCheck.pipelineAnimated && releaseCheck.reducedAnimated && releaseCheck.stations === 5 && releaseCheck.dateGroups === 1, JSON.stringify(releaseCheck));
  ok('句式名称完整显示、更新日志页提供检查更新', releaseCheck.namesFit && releaseCheck.updatePanel, JSON.stringify(releaseCheck));
  const updateNotice = await win.webContents.executeJavaScript(`(() => {
    const saved = { update: state.update, auth: state.auth, tab: state.tab };
    try {
      state.auth = { requireLogin: true, user: { username: '测试', role: 'member' } };
      state.update = { status: 'available', build: 1, latestBuild: 2 };
      ACTS['update:open']();
      const nav = document.querySelector('.nav[data-tab="13"]');
      const found = state.tab === 13 && nav.classList.contains('has-update') && !!document.querySelector('[data-act="update:download"]');
      state.update = { status: 'current', build: 2, latestBuild: 2 }; renderAll();
      return found && !nav.classList.contains('has-update');
    } finally { state.update = saved.update; state.auth = saved.auth; state.tab = saved.tab; renderAll(); }
  })()`);
  ok('普通成员在更新日志下载更新，有新版显示紫色圆点、最新版本移除圆点', updateNotice);
  const updateProgressUi = await win.webContents.executeJavaScript(`(() => {
    const saved = state.update;
    try {
      state.update = { status: 'downloading', percent: 47 }; let box = document.createElement('div'); box.innerHTML = updatePanelHtml();
      const download = box.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '47' && box.textContent.includes('47%') && !box.querySelector('progress');
      state.update = { status: 'verifying', percent: 28 }; box.innerHTML = updatePanelHtml();
      const verifying = box.textContent.includes('校验安装包') && box.querySelector('[data-act="update:check"]').disabled && !box.querySelector('[data-act="update:install"]');
      state.update = { status: 'installing', percent: 100 }; box.innerHTML = updatePanelHtml();
      return download && verifying && !!box.querySelector('.indeterminate') && !box.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow') && box.textContent.includes('每小时自动检查');
    } finally { state.update = saved; }
  })()`);
  ok('更新下载显示同款细进度条、校验状态禁用按钮、安装启动显示不确定进度', updateProgressUi);
  const feedbackUi = await win.webContents.executeJavaScript(`(() => {
    const saved = state.tab;
    try {
      state.tab = 7; renderAll();
      document.querySelector('[data-act="feedback:open"]').click();
      const input = document.querySelector('#feedbackText'); input.value = '测试反馈';
      const dialog = document.querySelector('.feedback-dialog'), style = getComputedStyle(dialog);
      const opened = !document.querySelector('#feedbackModal').hidden && input.maxLength === 1000
        && dialog.getAttribute('role') === 'dialog' && style.paddingTop === '28px'
        && dialog.getBoundingClientRect().width <= 520
        && dialog.textContent.includes('反馈会同步至开发');
      document.querySelector('[data-act="feedback:close"]').click();
      state.tab = 6; renderAll();
      const reminder = document.querySelector('#pane').textContent.includes('确保目前账号草稿箱为空');
      state.tab = 8; renderAll();
      return opened && document.querySelector('#feedbackModal').hidden && reminder && !document.querySelector('[data-act="stats:checkPath"]');
    } finally { state.tab = saved; renderAll(); }
  })()`);
  ok('设置反馈弹窗可输入和关闭、发布前提醒草稿箱为空、统计页移除检测输出目录按钮', feedbackUi);
  if (process.env.BLUEV_CAPTURE_RELEASE === '1') {
    await win.webContents.executeJavaScript(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); state.tab = 13; renderAll(); document.querySelector('#pane').scrollTop = 0;`);
    await new Promise(r => setTimeout(r, 500));
    const capture = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, '../investigation-20261012/changelog-preview.png'), capture.toPNG());
    await win.webContents.executeJavaScript(`delete document.hidden;`);
  }
  const rendererErrs = await win.webContents.executeJavaScript('window.__errs || []');
  rendererErrs.forEach(e => errors.push('[page] ' + e));

  ok('渲染层零控制台报错', errors.length === 0, errors.join(' | ') || '无');
  if (notes.length) console.log('\n--- 警告级日志(' + notes.length + ' 条，不算失败) ---\n' + notes.slice(0, 8).join('\n'));

  console.log('\nuserData(临时): ' + TMP);
  app.exit(errors.length ? 1 : 0);
}).catch(e => {
  console.error('UI CHECK ERROR', e && e.stack || e, '\nCaptured renderer errors:', errors.join(' | '));
  app.exit(1);
});
