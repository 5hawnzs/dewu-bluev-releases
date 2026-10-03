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
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
process.env.BLUEV_NO_LOGIN = '1';   // 自检只验界面，账号逻辑有自己的测试
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-uicheck-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('disable-gpu');

// ★ 下标 = 页签编号 - 1。页签 5「发布单」2026-10-03 已按用户要求删除，编号**不重排**
//   ⇒ 第 5 位留 null 占位（否则 6~12 的标题会整体错位一格）。
const TABS = ['素材整理', '合规检查', '文案生成', '货号颜色校验', null /* 5 发布单：已删 */, '模拟器发布', '设置', '品牌统计', '品牌与权限', '运行日志', '高级设置', '热词库'];
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
  const prov = ['adb/adb.exe', 'adb/AdbWinApi.dll', 'adb/AdbWinUsbApi.dll', 'adbkeyboard/ADBKeyboard.apk', 'ffmpeg/ffmpeg.exe'].map(rel => {
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
      spellcheck: false
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

  ok('左侧导航是 11 个页签（「发布单」2026-10-03 已删；「高级设置」「热词库」排在最后）', await win.webContents.executeJavaScript('document.querySelectorAll(".nav").length') === 11,
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
  for (const i of [1, 2, 3, 4, 6, 7, 8, 10, 12]) {
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

  // ---- 页签 12「热词库」：真读 DOM 断言（不是看源码里有没有那行字）----
  // ★ BLUEV_NO_LOGIN 下没有账号 ⇒ isAdmin=false ⇒ 这一页应当是**只读**的。
  //   「可编辑」那一支由 logintest 用管理员会话覆盖 —— 两边合起来才算把两个分支都测到。
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
      editableBoxes: h3.filter(t => /^(风格|氛围|色感|场景|人群|季节|情绪)（/.test(t)).length,
      lockedBox: h3.findIndex(t => t.indexOf('收尾') >= 0 && t.indexOf('锁定') >= 0),
      hasStyles: /T01/.test(txt) && /T10/.test(txt),
      inputs: pane.querySelectorAll('[data-lx-in]').length,
      addBtns: pane.querySelectorAll('[data-lx-add]').length,
      delBtns: pane.querySelectorAll('[data-lx-del]').length,
      statusText: (document.querySelector('#lxStatus') || {}).textContent || ''
    };
  })()`);
  ok('★ 页签 12「热词库」能渲染出来', lexPage.size > 200 && lexPage.title === '热词库', `${lexPage.title} · ${lexPage.size} 字节`);
  ok('★ 热词库页常驻「三条红线」提示（材质/极限/别的平台名）', lexPage.hasRedlines === true);
  ok('★ 7 个可编辑组都在页面上（风格/氛围/色感/场景/人群/季节/情绪）',
    lexPage.editableBoxes === 7, String(lexPage.editableBoxes));
  ok('★ 「收尾」组在页面上、且明确标着「已锁定，不可编辑」',
    lexPage.lockedBox >= 0, '第 ' + (lexPage.lockedBox + 1) + ' 个 box');
  ok('★ T01~T10 句式骨架照实列出来（只读展示）', lexPage.hasStyles === true);
  ok('★ 免登录态（没有账号 ＝ 不是管理员）这一页是只读：没有任何加词框、增删按钮',
    lexPage.inputs === 0 && lexPage.addBtns === 0 && lexPage.delBtns === 0,
    `inputs=${lexPage.inputs} add=${lexPage.addBtns} del=${lexPage.delBtns}`);
  ok('★ 只读时把原因写在页面上（不是默默少几个按钮，让人以为坏了）',
    /只读/.test(lexPage.statusText), lexPage.statusText.slice(0, 70));


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

  // ---- ★ 主题：app 默认浅色 + 顶栏「项目」左边一点即切（用户 2026-10-03 要求） ----
  //   为什么不能只查源码里有没有这个按钮：位置错了（塞进设置页）、点了不生效（没走 IPC）、
  //   切了不落盘（下次启动忘掉）—— 三种都是「看起来做了」。这里全用真窗口真点一遍。
  const themeDom = await win.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('themeBtn');
    const proj = document.getElementById('chipProj');
    return {
      found: !!btn && !!proj,
      sameParent: !!(btn && proj && btn.parentElement === proj.parentElement),
      beforeProj: !!(btn && proj && (btn.compareDocumentPosition(proj) & Node.DOCUMENT_POSITION_FOLLOWING) > 0),
      inTitlebar: !!(btn && btn.closest('.titlebar')),
      dark: document.documentElement.classList.contains('dark'),
      title: btn ? btn.title : ''
    };
  })()`);
  ok('★ 主题切换按钮在标题栏、且紧挨在「项目」左边（用户指定的位置）',
    themeDom.found && themeDom.sameParent && themeDom.beforeProj && themeDom.inTitlebar,
    JSON.stringify(themeDom));
  ok('★ app 默认浅色（出厂默认就是 light，老配置里的 system 也按浅色算）',
    themeDom.dark === false, JSON.stringify({ dark: themeDom.dark, title: themeDom.title }));
  await win.webContents.executeJavaScript(`document.getElementById('themeBtn').click()`);
  await new Promise(r => setTimeout(r, 320));
  const themeDark = await win.webContents.executeJavaScript(`document.documentElement.classList.contains('dark')`);
  ok('★ 点一下真的切成深色，并且存进了配置（下次启动还是这个）',
    themeDark === true && store.get('ui.theme') === 'dark',
    JSON.stringify({ dark: themeDark, saved: store.get('ui.theme') }));
  await win.webContents.executeJavaScript(`document.getElementById('themeBtn').click()`);
  await new Promise(r => setTimeout(r, 320));
  const themeLight = await win.webContents.executeJavaScript(`document.documentElement.classList.contains('dark')`);
  ok('★ 再点一下切回浅色，也存进了配置',
    themeLight === false && store.get('ui.theme') === 'light',
    JSON.stringify({ dark: themeLight, saved: store.get('ui.theme') }));

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
    ok('★ 设置页确实渲染出来了（有「路径」「外部依赖」，不是空页面）',
      setHeads.includes('路径') && setHeads.includes('外部依赖'), JSON.stringify(setHeads));
    ok('★ 设置页里**不再有**「外观」这一块（用户要求：与顶栏主题按钮重复）',
      !setHeads.includes('外观'), JSON.stringify(setHeads));
    ok('★ 但「运行环境」没跟着一起丢（已挪进「外部依赖」）',
      await win.webContents.executeJavaScript(`/运行环境/.test(document.querySelector('#pane').innerText)`));
  }
  const winSrc = fs.readFileSync(path.join(ROOT, 'src/main/window.js'), 'utf8');
  ok('★ 主进程的主题口径只有浅色/深色两档（「跟随 Windows 设置」已取消）',
    /function normTheme\(v\) \{ return v === 'dark' \? 'dark' : 'light'; \}/.test(winSrc)
    && /function applyStoredTheme\(\)/.test(winSrc));
  ok('★ 启动时在**建窗口之前**就把主题应用上（窗口底色按它算，晚了会先闪一下）',
    /winmod\.applyStoredTheme\(\);\r?\n\s*project\.load\(\);/.test(fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')));


  ok('页签 8 有「导出 xlsx」（品牌统计）', await onTab(8, 'stats:export'));

  // ---- 左侧「运行日志」页：与底部日志栏**同一份内容**、能筛、能真导出 ----
  // 用户原话是「同步 app 下端的日志」⇒ 必须验两处**内容逐行一致**。
  // 只验「多了一个页签」证明不了同步 —— 那恰恰是最容易做成两套数据的地方。
  // 日志由主进程 logbus 产生，这里直接往总线上灌几条（走的就是真的 log:entry 推送链路）。
  {
    // 先把导出目录挪到临时目录：默认是「我的文档\输出\得物」，自检不许往用户那儿写文件
    store.set({ paths: { output: path.join(TMP, 'out') } });

    logbus.info('ENG-INFO 自检：这段只用来验证「运行日志」页与底部日志栏同步');
    logbus.error('ENG-ERR 自检：故意造一条错误日志（用来验级别筛选）');
    await new Promise(r => setTimeout(r, 250));

    const gotoLogPage = `document.querySelector('.nav[data-tab="10"]').click(); await new Promise(r => setTimeout(r, 200));`;
    const ui0 = await win.webContents.executeJavaScript(`(async () => {
      ${gotoLogPage}
      const txt = els => els.map(e => e.textContent.replace(/\\s+/g, ' ').trim());
      return {
        bar: txt([...document.querySelectorAll('#log > div')]),
        pane: txt([...document.querySelectorAll('#logPaneLines > div')]),
        badge: (document.querySelector('[data-st="10"]') || {}).textContent || '',
        count: (document.querySelector('#logPaneCount') || {}).textContent || '',
        barCount: (document.querySelector('#logBarCount') || {}).textContent || '',
        countOnTitleRow: (function () { var c = document.querySelector('#logPaneCount'); var r = c && c.closest ? c.closest('.row') : null; return !!(r && r.querySelector('h3')); })(),
        acts: [...document.querySelectorAll('#pane [data-act]')].map(e => e.dataset.act),
        hasLv: !!document.querySelector('#logLv'), hasQ: !!document.querySelector('#logQ')
      };
    })()`);
    ok('★ 左侧「运行日志」页与底部日志栏是同一份内容（逐行一致）',
      ui0.bar.length > 0 && JSON.stringify(ui0.bar) === JSON.stringify(ui0.pane),
      `日志栏 ${ui0.bar.length} 行 / 页内 ${ui0.pane.length} 行`);
    ok('刚灌进去的那两条两处都看得到（说明走的是真推送链路，不是各自造的数据）',
      ui0.pane.some(l => /ENG-INFO/.test(l)) && ui0.bar.some(l => /ENG-INFO/.test(l)),
      ui0.pane.slice(-2).join(' | ').slice(0, 120));
    ok('★ 运行日志页的条数在标题那一行的右边（2026-10-03 用户：右边不显示有多少条）',
      ui0.countOnTitleRow && /共 \d+ 条|显示 \d+ \/ 共 \d+ 条/.test(ui0.count),
      JSON.stringify({ onTitleRow: ui0.countOnTitleRow, count: ui0.count }));
    ok('★ 底部日志栏右边也显示条数，且与页里的「共 N 条」是同一个数',
      /共 (\d+) 条/.test(ui0.barCount) && /共 (\d+) 条/.test(ui0.count)
        && ui0.barCount.match(/共 (\d+) 条/)[1] === ui0.count.match(/共 (\d+) 条/)[1],
      JSON.stringify({ barCount: ui0.barCount, paneCount: ui0.count, barLines: ui0.bar.length }));
    ok('页上有「级别下拉 + 关键字 + 清空 + 导出」四件东西',
      ui0.hasLv && ui0.hasQ && ui0.acts.includes('log:clear') && ui0.acts.includes('log:export'),
      JSON.stringify(ui0.acts));

    // 级别筛选：只该影响这一页；底部日志栏不许跟着变（它就是「刚才发生了什么」）
    const ui1 = await win.webContents.executeJavaScript(`(async () => {
      const sel = document.querySelector('#logLv');
      sel.value = 'error'; sel.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      return {
        pane: [...document.querySelectorAll('#logPaneLines > div')].map(e => e.textContent),
        barCount: document.querySelectorAll('#log > div').length,
        count: document.querySelector('#logPaneCount').textContent
      };
    })()`);
    ok('★ 级别筛「错误」后页内只剩错误那条（info 那条被筛掉）',
      ui1.pane.some(l => /ENG-ERR/.test(l)) && !ui1.pane.some(l => /ENG-INFO/.test(l)),
      ui1.pane.join(' | ').slice(0, 100));
    ok('★ 筛选时把「显示 N / 共 M 条」两个数都写出来（只写一个会被当成日志丢了）',
      /显示 \d+ \/ 共 \d+ 条/.test(ui1.count), ui1.count);
    ok('★ 筛选只作用于这一页：底部日志栏一行都没少',
      ui1.barCount === ui0.bar.length, `筛选后 ${ui1.barCount} vs 筛选前 ${ui0.bar.length}`);

    // 关键字筛选（级别调回「全部」，单独验关键字这一路）
    const ui2 = await win.webContents.executeJavaScript(`(async () => {
      const lv = document.querySelector('#logLv');
      lv.value = ''; lv.dispatchEvent(new Event('change'));
      const q = document.querySelector('#logQ');
      q.value = 'ENG-ERR'; q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 200));
      return { pane: [...document.querySelectorAll('#logPaneLines > div')].map(e => e.textContent), count: document.querySelector('#logPaneCount').textContent };
    })()`);
    ok('按关键字筛之后只剩命中的那条（且两个数都写出来）',
      ui2.pane.length === 1 && /ENG-ERR/.test(ui2.pane[0]) && /显示 1 \/ 共 \d+ 条/.test(ui2.count),
      `${JSON.stringify(ui2.count)} ${ui2.pane.join(' | ').slice(0, 60)}`);

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
    ok('★ 导出的是**筛选后**的那些：关键字写进文件头，条数也对得上（1 条）',
      /关键字=ENG-ERR/.test(logTxt) && /本次导出：1 条/.test(logTxt),
      `${(logTxt.match(/筛选条件：[^\n]*/) || [''])[0]} | ${(logTxt.match(/本次导出：[^\n]*/) || [''])[0]}`);
    ok('★ 文件头同时写出「内存缓冲区共 N 条」，且比导出的多（一眼看出这是筛过的）',
      (() => { const m = /内存缓冲区：共 (\d+) 条/.exec(logTxt); return !!m && Number(m[1]) > 1; })(),
      (logTxt.match(/内存缓冲区：[^\n]*/) || [''])[0]);
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

    // 清空：两处一起清（只清一边，「同步」当场破功）
    const cleared = await win.webContents.executeJavaScript(`(async () => {
      const lv = document.querySelector('#logLv'); lv.value = ''; lv.dispatchEvent(new Event('change'));
      const q = document.querySelector('#logQ'); q.value = ''; q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 150));
      document.querySelector('[data-act="log:clear"]').click();
      await new Promise(r => setTimeout(r, 400));
      return {
        bar: document.querySelectorAll('#log > div').length,
        pane: document.querySelectorAll('#logPaneLines > div').length,
        badge: (document.querySelector('[data-st="10"]') || {}).textContent || '',
        count: (document.querySelector('#logPaneCount') || {}).textContent || ''
      };
    })()`);
    ok('★「清空」把底部日志栏与页内**一起**清掉（只清一边就不叫同步了）',
      cleared.bar === 0 && cleared.pane === 0, JSON.stringify(cleared));
    ok('清空后角标回到「—」、条数回到「共 0 条」（界面不许还留着旧数字）',
      cleared.badge === '—' && /共 0 条/.test(cleared.count), `${cleared.badge} / ${cleared.count}`);

    // 清空后再来一条：两处必须**同时**长出来（推送这个方向最容易漏）
    // ★ 这一条才是「同步」的真正守门人：上面那条「逐行一致」是切页时比对的，
    //   而切页会触发一次整体重绘 —— 就算 pushLog 忘了同步页内，切过去也看着是对的。
    //   只有「页面开着的时候新来的日志」才会暴露出来。（定点破坏 L1 已证）
    logbus.warn('ENG-WARN 自检：清空之后再来一条');
    await new Promise(r => setTimeout(r, 250));
    const afterClear = await win.webContents.executeJavaScript(`(() => ({
      bar: [...document.querySelectorAll('#log > div')].map(e => e.textContent),
      pane: [...document.querySelectorAll('#logPaneLines > div')].map(e => e.textContent)
    }))()`);
    ok('★ 清空之后新来的日志两处都长出来了（推送方向也是同步的）',
      afterClear.bar.length === 1 && afterClear.pane.length === 1
        && /ENG-WARN/.test(afterClear.bar[0]) && /ENG-WARN/.test(afterClear.pane[0]),
      JSON.stringify(afterClear).slice(0, 150));

    // 源码锚点：两处不许各写一套渲染逻辑（那正是「两份数据」的前兆）
    const appSrcLog = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    ok('★ 两边共用同一个数组与同一套渲染函数（没有第二份日志）',
      /function pushLog\(e\)[\s\S]{0,400}appendToLogPane\(e\)/.test(appSrcLog)
        && /function renderLogs\(\)[\s\S]{0,500}renderLogPaneLines\(\)/.test(appSrcLog)
        && !/state\.logs2|state\.paneLogs/.test(appSrcLog),
      `pushLog→页内=${/appendToLogPane\(e\)/.test(appSrcLog) ? '有' : '缺'} · renderLogs→页内=${/renderLogPaneLines\(\)/.test(appSrcLog) ? '有' : '缺'}`);
    ok('★ 导出走 IPC（渲染层没有 fs），且主进程会把失败如实报回来（不吞）',
      /appApi\.logExport\(/.test(appSrcLog)
        && /ipcRenderer\.invoke\('log:export', payload\)/.test(fs.readFileSync(path.join(ROOT, 'src/preload/index.js'), 'utf8'))
        && /导出运行日志失败/.test(fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8')));
  }

  // ---- 应用更新面板：这轮测的是「界面诚不诚实」，不是「按钮好不好看」----
  // 自检跑的是没打包的源码 ⇒ app.isPackaged=false ⇒ 自动更新本来就不可用。
  // 所以这一栏必须**如实说不可用**，而不是摆三个点了没反应的按钮出来。
  const updPanel = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="7"]').click();
    await new Promise(r => setTimeout(r, 150));
    const box = document.querySelector('#updBox');
    if (!box) return null;
    return { text: box.textContent, acts: [...box.querySelectorAll('[data-act]')].map(e => e.dataset.act) };
  })()`);
  ok('页签 7 有「应用更新」面板，并写出当前版本号', !!updPanel && /当前版本/.test(updPanel.text),
     (updPanel && updPanel.text || '').slice(0, 120));
  ok('未打包时如实标「开发模式 / 不可用」，且不摆点了没用的按钮',
     !!updPanel && /开发模式/.test(updPanel.text) && updPanel.acts.length === 0,
     (updPanel && updPanel.text || '').slice(0, 120) + ' | 按钮 ' + JSON.stringify(updPanel && updPanel.acts));

  // ---- 更新通道：主进程算对了 ≠ 用户在界面上看得到、点得到，所以这里必须再验一次 ----
  // 造一个「自动更新可用 + 当前在测试版」的状态：假 autoUpdater + packaged=true，
  // 再把 send 接到真窗口上，让 setChannel 的广播真的推到渲染层。
  {
    const { EventEmitter } = require('events');
    const fake = new EventEmitter();
    fake.autoDownload = true; fake.autoInstallOnAppQuit = true;
    fake.checkForUpdates = () => Promise.resolve(null);
    fake.downloadUpdate = () => Promise.resolve(null);
    fake.quitAndInstall = () => {};
    updater._reset();
    updater._setUpdater(fake);
    updater.init({
      send: (ch, payload) => { if (!win.isDestroyed()) win.webContents.send(ch, payload); },
      packaged: true, version: '9.9.9', channel: 'stable',
    });
    updater.setChannel('beta');   // 这一步会广播，渲染层据此重画
  }
  const chanPanel = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="7"]').click();
    await new Promise(r => setTimeout(r, 250));
    const box = document.querySelector('#updBox');
    if (!box) return null;
    const b = n => box.querySelector('[data-act="upd:chan:' + n + '"]');
    const has = e => !!(e && String(e.className).includes('primary'));
    return {
      text: box.textContent, acts: [...box.querySelectorAll('[data-act]')].map(e => e.dataset.act),
      hasRow: /更新通道/.test(box.textContent),
      stable: !!b('stable'), beta: !!b('beta'),
      stablePrimary: has(b('stable')), betaPrimary: has(b('beta'))
    };
  })()`);
  ok('更新可用时：设置页有「更新通道」一行，正式版 / 测试版两个按钮都在',
     !!chanPanel && chanPanel.hasRow && chanPanel.stable && chanPanel.beta,
     JSON.stringify(chanPanel && { hasRow: chanPanel.hasRow, stable: chanPanel.stable, beta: chanPanel.beta }));
  ok('★ 当前通道在界面上看得出来：测试版高亮、正式版不高亮',
     !!chanPanel && chanPanel.betaPrimary && !chanPanel.stablePrimary,
     JSON.stringify(chanPanel && { stablePrimary: chanPanel.stablePrimary, betaPrimary: chanPanel.betaPrimary }) + ' | ' + (chanPanel && chanPanel.text || '').slice(0, 100));
  ok('更新可用时把「检查/下载/安装」三个按钮摆出来（和不可用时形成对照）',
     !!chanPanel && ['upd:check', 'upd:download', 'upd:install'].every(a => chanPanel.acts.includes(a)),
     JSON.stringify(chanPanel && chanPanel.acts));

  // 把更新模块还原成「未打包」的初始状态，免得影响后面还在用同一进程的断言
  updater._reset();
  updater.init({ send: () => {}, packaged: app.isPackaged, version: app.getVersion() });

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
        updBox: !!document.querySelector('#pane #updBox'),
        head: (document.querySelector('#head') || {}).textContent || ''
      };
      // ② 切成普通成员再重画：整块必须消失，副标题也不许再提「应用更新」
      state.auth = { requireLogin: true, isAdmin: false, user: { username: 'u1', displayName: '普通成员', role: 'user' } };
      out.canAdmin_nonadmin = canAdmin();
      renderAll();
      const pane = document.querySelector('#pane');
      const head = document.querySelector('#head');
      out.nonadmin = {
        updBox: !!pane.querySelector('#updBox'),
        paneText: pane.textContent,
        head: head.textContent,
        h3: [...pane.querySelectorAll('.box h3')].map(e => e.textContent),
        // 正向对照：这一页必须**还在正常渲染**，不是白页
        hasPaths: /输出目录|隔离目录/.test(pane.textContent),
        hasDeps: /外部依赖/.test(pane.textContent),
        saveBtn: !!document.querySelector('[data-act="cfg:save"]')
      };
      // ③ 还原登录态，别污染后面的套件
      state.auth = saved;
      renderAll();
      out.restored = { canAdmin: canAdmin(), updBox: !!document.querySelector('#pane #updBox') };
      return out;
    })()`);

    ok('★ 管理员视角：设置页仍有「应用更新」整块（下面非管理员那一支的对照基线）',
      !!gate && gate.admin.updBox === true && /应用更新/.test(gate.admin.head),
      gate ? 'updBox=' + gate.admin.updBox + ' head=' + JSON.stringify((gate.admin.head || '').slice(0, 60)) : 'gate=null');
    ok('★ 切到普通成员后 renderAll：canAdmin() 真的变 false（机制先自证，免得断言建在空地基上）',
      !!gate && gate.canAdmin_nonadmin === false, JSON.stringify(gate && gate.canAdmin_nonadmin));
    ok('★ 非管理员设置页：整块「应用更新」从 DOM 里消失（不是藏起来，是真的不渲染）',
      !!gate && gate.nonadmin.updBox === false,
      gate ? 'h3=' + JSON.stringify(gate.nonadmin.h3) : '');
    ok('★ 非管理员设置页：页面（含副标题）一个字都不提 应用更新/当前版本/新版本/检查更新/下载更新/更新通道/测试版',
      !!gate && !/应用更新|当前版本|新版本|检查更新|下载更新|更新通道|测试版/.test(gate.nonadmin.paneText + gate.nonadmin.head),
      gate ? JSON.stringify((gate.nonadmin.paneText || '').replace(/\s+/g, ' ').slice(0, 90)) : '');
    ok('★ 非管理员设置页副标题也不再提「应用更新」（界面文字得跟界面上真有的东西对得上）',
      !!gate && !/应用更新/.test(gate.nonadmin.head),
      gate ? JSON.stringify((gate.nonadmin.head || '').replace(/\s+/g, ' ').slice(0, 110)) : '');
    ok('★ 正向对照：非管理员这一页**照常渲染**（路径 / 外部依赖 / 保存 都在，不是白页）—— 防「空==空」假绿',
      !!gate && gate.nonadmin.hasPaths && gate.nonadmin.hasDeps && gate.nonadmin.saveBtn,
      gate ? 'paths=' + gate.nonadmin.hasPaths + ' deps=' + gate.nonadmin.hasDeps + ' save=' + gate.nonadmin.saveBtn : '');
    ok('测试自己收尾：还原登录态后「应用更新」又回来了（证明上面的消失是权限造成的，不是渲染坏了）',
      !!gate && gate.restored.updBox === true && gate.restored.canAdmin === true,
      JSON.stringify(gate && gate.restored));

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
      !!ver && !!ver.info && ver.text === 'v' + ver.info,
      JSON.stringify(ver && { text: ver.text, info: ver.info }));

    // 源码级门控（先剥注释：负向只看代码行，注释里正当地写着「原来是裸的 updateHtml()」会误报）
    const srcA = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
    const codeA = codeOnly(srcA);
    const gated = codeA.includes("${canAdmin() ? updateHtml() : ''}");
    const bare = /\$\{updateHtml\(\)\}/.test(codeA);
    ok('★ 源码级：设置页那一行是**门控**渲染（canAdmin() ? updateHtml() : \'\'），没有裸的 updateHtml() 调用',
      gated && !bare, 'gated=' + gated + ' bare=' + bare);
  }

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

  // ---- 设置项要在**每一页**都能存 ----
  // 「文案生成」和「模拟器发布」两页里也有设置项（轮换策略 / 发布间隔 / adb 路径），
  // 以前只有「设置」页绑了保存 —— 那两页改了其实从没存过，而且界面上一点提示都没有，看着像生效了。
  const cfgSaved = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 150));
    const sel = document.querySelector('[data-cfg="copy.rotateStrategy"]');
    const before = ((await window.api.configGet()).copy || {}).rotateStrategy;
    sel.value = before === '随机' ? 'F01-F10 轮换' : '随机';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const after = ((await window.api.configGet()).copy || {}).rotateStrategy;
    return { before, picked: sel.value, after };
  })()`);
  ok('★ 文案生成页的批次设置改了就存（以前只绑了设置页，这页改了没保存）',
    cfgSaved.after === cfgSaved.picked && cfgSaved.after !== cfgSaved.before, JSON.stringify(cfgSaved));

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
    const box = [...document.querySelectorAll('.box')].find(b => b.textContent.includes('设备检查结果'));
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

  // 「一键装上中文输入法」这条链路：界面有按钮 → 主进程有动作 → 真正干活的三步在 adbtest 里验
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
  ok('★ 检查结果的引导块支持挂「一键处理」按钮，并且中文输入法真的接上了',
    /f\.act \?/.test(appSrc) && appSrc.includes("'pub:installIme'")
      && jobsSrc.includes("'publish.installIme'") && /publisher\.installIme\(/.test(jobsSrc),
    `界面按钮=${appSrc.includes("'pub:installIme'") ? '有' : '缺'} · 主进程动作=${jobsSrc.includes("'publish.installIme'") ? '有' : '缺'}`);

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
  // ★ 自检的 userData 是临时目录 ⇒ 配置里云地址必然是空的（留空＝跟随内置），
  //   所以「主进程实际在用的地址」可以直接从主进程问出来，再和界面显示的对比。
  const csNow = require(path.join(ROOT, 'src/main/services/cloudsync.js')).status();
  const advUi = await win.webContents.executeJavaScript(`(async () => {
    const EXPECT = ${JSON.stringify({ url: csNow.url, src: csNow.urlSource })};
    document.querySelector('.nav[data-tab="11"]').click();
    // refreshCloudState 是异步的（要过一次 IPC），别抢在它前面读
    for (let i = 0; i < 20; i++) {
      const t = (document.querySelector('#pane #cloudEff') || {}).textContent || '';
      if (t && !/读取中/.test(t)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const pane = document.querySelector('#pane');
    const has = s => !!pane.querySelector(s);
    const ds = [...pane.querySelectorAll('details.box')];
    const effEl = pane.querySelector('#cloudEff');
    const effText = effEl ? (effEl.textContent || '') : '';
    // ★ 只认「来源：」**后面那一段**：整段里本来就同时有「跟随内置」和「本机指定」两个词
    //   （前面的徽章 + 后面的说明），拿整段去 test 会**两边都命中** ⇒ 说反了也照样绿（假通过）。
    const srcSeg = effText.split('来源：')[1] || '';
    const srcRig = EXPECT.src === 'custom' ? '本机指定' : '跟随内置';
    const srcWrong = EXPECT.src === 'custom' ? '跟随内置' : '本机指定';
    return {
      adbPath: has('[data-cfg="publish.adbPath"]'), ffPath: has('[data-cfg="publish.ffmpegPath"]'),
      dump: has('[data-act="pub:dump"]'), map: has('[data-act="pub:map"]'),
      recover: has('[data-act="pub:recoverEdit"]'),
      llm: has('[data-cfg="copy.llm.enabled"]'),
      // ★ 2026-10-02：「看图写」这一整套要能在界面上被看见 / 被关掉 / 被自检
      vision: has('[data-cfg="copy.llm.vision"]'), imgCount: has('[data-cfg="copy.llm.imageCount"]'),
      imgSide: has('[data-cfg="copy.llm.imageMaxSide"]'), llmTest: has('[data-act="copy:llmtest"]'), sku: has('[data-cfg="verify.api.endpoint"]'),
      mode: has('[data-cfg="verify.mode"]'), conc: has('[data-cfg="copy.concurrency"]'),
      cloud: has('#cloudState') && has('[data-cfg="cloud.url"]') && has('[data-cfg="cloud.anonKey"]')
        && has('[data-act="cloud:exp"]') && has('[data-act="cloud:imp"]'),
      effPresent: !!effEl, effText: effText.slice(0, 120),
      effShown: !!EXPECT.url && effText.includes(EXPECT.url),
      // ★ 来源词必须和主进程报的一致，且**不许出现反面的词**（说反了＝骗人）
      effSrcMatch: srcSeg.includes(srcRig) && !srcSeg.includes(srcWrong),
      effSrcShown: /跟随内置|本机指定/.test(effText),
      srcSeg: srcSeg.slice(0, 60),
      stateUrl: EXPECT.url, stateSrc: EXPECT.src,
      collapsed: ds.length, openCount: ds.filter(d => d.open).length
    };
  })()`);
  ok('★ 高级设置页收齐了这些入口（UI 定位表 / 文案模型 / 并发路数 / SKU 接口 / adb、ffmpeg 路径 / 云端协作含导出导入）',
    advUi.adbPath && advUi.ffPath && advUi.dump && advUi.map
      && advUi.llm && advUi.sku && advUi.mode && advUi.conc && advUi.cloud, JSON.stringify(advUi));
  // ★ 2026-10-03 用户要求删掉的那一块：负向断言盯着（不然哪天被加回来，整套回归照样全绿）
  ok('★ 高级设置页不再有「失败恢复动作」（整块删了，不是藏起来）',
    advUi.recover === false, JSON.stringify({ recover: advUi.recover }));
  // ★★ 2026-10-02 第六轮：云端配置改成「留空＝跟随内置」后，删掉了 applyCloudDefaults，
  //    于是守「界面骗人」的担子全压在这一行上 —— 它必须**无条件**显示主进程真正在用的地址。
  //    （以前是靠「把内置值写回配置」让框里的值 = 在用的值；那条会固化，已删。）
  ok('★ 云端协作块里有「当前实际在用」这一行（「留空＝跟随内置」唯一的可见出口）',
    advUi.effPresent === true, JSON.stringify({ present: advUi.effPresent, text: advUi.effText }));
  ok('★★ 界面显示的地址 == 主进程真正在用的地址（不许「框里空着、后台照推别处」）',
    advUi.effShown === true, JSON.stringify({ stateUrl: advUi.stateUrl, text: advUi.effText }));
  ok('★ 那一行同时说清来源，且**说的和主进程报的一致**（跟随内置 / 本机指定说反了就是骗人）',
    advUi.effSrcShown === true && advUi.effSrcMatch === true && (advUi.stateSrc === 'builtin' || advUi.stateSrc === 'custom'),
    JSON.stringify({ src: advUi.stateSrc, seg: advUi.srcSeg, text: advUi.effText }));
  // 五块：文案模型 / 并发路数 / 货号颜色 / 外部依赖路径 / 云端协作（2026-10-02 新增云端协作）
  ok('★ 高级设置里「可选」的五块默认是收起的（折叠区，不占地方）',
    advUi.collapsed === 5 && advUi.openCount === 0, JSON.stringify(advUi));
  // ★★ 2026-10-02（本轮）：文案模型这一块必须让人能「看见自己在看图写」——
  //   看图开关 / 每条几张图 / 缩到多大 / 一个「接口自检」按钮，缺一个都不行。
  //   （上一版这些事只有跑生成时才暴露，而失败还被静默吞成「本地模板」⇒ 用户只看到模板货。）
  ok('★ 文案模型块里有「看图」开关 + 送图张数 + 缩放尺寸 + 接口自检按钮',
    advUi.vision && advUi.imgCount && advUi.imgSide && advUi.llmTest, JSON.stringify(advUi));

  // 「文案生成」页要说清两件事：标题是看图写的、跑完会落一份 AI 内容报告（可反向导入）。
  // 同时钉住**旧口径已删**：「标题格式轮换」那套壳不再对用户宣传（它就是「像 AI 做的」的来源）。
  const copyUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 200));
    const t = document.querySelector('#pane').textContent;
    return { picture: /看图写/.test(t), report: /AI内容报告/.test(t), back: /反向|当发布单导进来/.test(t), oldFmt: /标题格式/.test(t) };
  })()`);
  ok('★ 「文案生成」页写明了「标题是看图写的」（不是拿货号颜色套模板）', copyUi.picture === true, JSON.stringify(copyUi));
  ok('★ 「文案生成」页写明了跑完会落一份带时间戳的 AI 内容报告，且能反向导入当发布单',
    copyUi.report === true && copyUi.back === true, JSON.stringify(copyUi));
  ok('★ 旧口径「标题格式轮换」不再出现在这一页（F01~F10 已降级为离线模板专用）',
    copyUi.oldFmt === false, JSON.stringify(copyUi));

  // ★ 2026-10-02（第三轮）：云端配置的「下发」—— 导出 / 导入两个动作 + 一个弹窗。
  //   ① 结构：弹窗必须写在 index.html 里，且**在 .app 外面**。
  //      （2026-10-02 真踩过：塞进 #pane 会被 overflow 裁掉，底部按钮点不到；
  //        而且 renderAll 会被进度事件频繁触发 —— 挂在 #pane 里，正在粘贴的内容会被重画没。）
  //   ② 行为：真点一下「导入配置」（它只是开弹窗，不需要任何凭据），确认能开、Esc 能关。
  const idxHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const iLines = idxHtml.split(/\r?\n/);
  const appOpen = iLines.findIndex(l => /<div class="app">/.test(l));
  const appClose = iLines.findIndex((l, i) => i > appOpen && /^<\/div>/.test(l));
  const cmodalAt = iLines.findIndex(l => /id="cmodal"/.test(l));
  ok('★ 云端配置弹窗在 index.html 且挂在 .app 外面（塞进 #pane 会被裁掉、底部按钮点不到）',
    appOpen >= 0 && appClose > appOpen && cmodalAt > appClose && /id="cmBox"/.test(idxHtml),
    JSON.stringify({ appOpen, appClose, cmodalAt }));

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
      || /只看相邻两条/.test(paneText);
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
      hasRules: /只看相邻两条/.test(txt) && /4~5 行短句/.test(txt) && /不是拿货号颜色套模板/.test(txt),
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

  const cloudModalUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 200));
    const btn = document.querySelector('[data-act="cloud:imp"]');
    if (!btn) return { hasBtn: false };
    btn.click();
    await new Promise(r => setTimeout(r, 150));
    const mask = document.querySelector('#cmodal');
    const box = document.querySelector('#cmBox');
    const open = !!mask && !mask.hidden;
    const outsidePane = !!mask && !mask.closest('#pane');
    const hasArea = !!(box && box.querySelector('#cmText'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return { hasBtn: true, open, outsidePane, hasArea, closed: !!mask && mask.hidden };
  })()`);
  ok('★ 点「导入配置」真开出弹窗，且在 #pane 外面、有可粘贴的输入区',
    cloudModalUi.hasBtn && cloudModalUi.open && cloudModalUi.outsidePane && cloudModalUi.hasArea,
    JSON.stringify(cloudModalUi));
  ok('★ Esc 能关掉云端配置弹窗（关不掉的弹窗会挡住整页）', cloudModalUi.closed === true, JSON.stringify(cloudModalUi));

  // ★ 2026-10-02（第二轮）：用户点名「并发路数」也挪进高级设置 —— 它是运行参数（撞接口限流的旋钮），
  //   和「必带话题 / 轮换策略」那种**改产出**的业务内容不是一回事。两件事都要验：
  //   ① 文案生成页真的没了（负向）；② 高级设置里能改、且真的存进了配置（测完还原，别污染后面的套件）。
  const concUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 150));
    const q = () => document.querySelector('[data-cfg="copy.concurrency"]');
    const daily = !!q();
    const rotateKept = !!document.querySelector('[data-cfg="copy.rotateStrategy"]');
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 150));
    const el = q();
    if (!el) return { daily, rotateKept, found: false };
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
    return { daily, rotateKept, found: true, before, target, after, stale, restored };
  })()`);
  ok('★ 文案生成页不再摆「并发路数」（它是撞限流的旋钮，不是业务参数）',
    concUi.daily === false, JSON.stringify(concUi));
  ok('★「高级设置」里能改并发路数，且真的存进了配置（测完已还原成原值）',
    concUi.found && concUi.after === concUi.target && concUi.restored === concUi.before, JSON.stringify(concUi));
  ok('★ 但「轮换策略」还留在文案生成页（它改的是产出，用户得看得见）',
    concUi.rotateKept === true, JSON.stringify(concUi));
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
      barePrompt: !!pane.querySelector('[data-cfg="copy.promptWrite"]') || !!pane.querySelector('[data-cfg="copy.promptFilter"]'),
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
      const r = await window.api.run('copy.generate', { sourceDir: dir, batchId: '自检批次_20260930_000000', label: '自检批次_20260930_000000' });
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

    // ⑤ 视频没单独配时复用图文 steps（用户实测两者发布位置一样）
    ok('★ 视频复用图文定位表（videoSteps 为空时不再抛错，直接走 steps）',
      /const steps = isVideo \? \(vSteps\.length \? vSteps : \(map\.steps \|\| \[\]\)\) : \(map\.steps \|\| \[\]\);/.test(P3)
      && !/视频条会直接失败/.test(J3));

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
      && /先点右上角「导出 xlsx」/.test(A4c));

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

  const rendererErrs = await win.webContents.executeJavaScript('window.__errs || []');
  rendererErrs.forEach(e => errors.push('[page] ' + e));

  ok('渲染层零控制台报错', errors.length === 0, errors.join(' | ') || '无');
  if (notes.length) console.log('\n--- 警告级日志(' + notes.length + ' 条，不算失败) ---\n' + notes.slice(0, 8).join('\n'));

  console.log('\nuserData(临时): ' + TMP);
  app.exit(errors.length ? 1 : 0);
}).catch(e => {
  console.error('UI CHECK ERROR', e);
  app.exit(1);
});
