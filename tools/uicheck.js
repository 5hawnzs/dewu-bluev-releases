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

const TABS = ['素材整理', '合规检查', '文案生成', '货号颜色校验', '发布单', '模拟器发布', '设置', '品牌统计', '品牌与权限', '运行日志'];
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

  ok('左侧导航是 11 个页签（新增「高级设置」，排在最后）', await win.webContents.executeJavaScript('document.querySelectorAll(".nav").length') === 11,
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

  // 页签 9 前面单独测过（品牌与权限）；10 是新增的「运行日志」
  const phs = [];        // 收集各页签真实渲染出来的 placeholder（见下方守卫断言）
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
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

  // ---- 界面里不许再出现「别人家的品牌名」 ----
  // 给「清掉测试数据 + 示例品牌名」立个长期守卫：源码与**真实渲染出来的** placeholder
  // 都不许再冒出来。placeholder 不属于 textContent，只查页面文本必然漏掉这一批。
  const BAN = /(斯凯奇|UR视频|UR女人|skechers|卡宾|TW男装|TW女装)/i;
  const uiSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const srcHit = uiSrc.match(BAN);
  ok('★ 界面源码里没有举例品牌名（UR / 斯凯奇 / skechers / 卡宾 / TW男装…）', !srcHit, srcHit ? srcHit[0] : '');
  const phHit = phs.join(' | ').match(BAN);
  ok(`★ 渲染出来的 placeholder 里没有举例品牌名（查了 ${phs.length} 个输入框）`, !phHit, phHit ? phHit[0] : '');

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
  ok('页签 5 有「导入 AI 内容报告」', await onTab(5, 'sheet:importReport'));
  ok('页签 6 有「重导出日志」', await onTab(6, 'pub:exportLog'));
  // ★ 2026-10-02：这几个「装一次就不再动」的入口按用户要求从日常页面收进「高级设置」。
  //   断言也跟着搬 —— 搬了就得能证明它**不在老地方了**，否则「收起来」等于没发生。
  ok('页签 11 有「失败恢复动作」', await onTab(11, 'pub:recoverEdit'));
  ok('页签 6 不再有「失败恢复动作」', !(await onTab(6, 'pub:recoverEdit')));
  ok('页签 6 不再有「抓取页面结构」「导入 UI 定位表」',
    !(await onTab(6, 'pub:dump')) && !(await onTab(6, 'pub:map')));
  ok('页签 11 有「抓取页面结构」「导入 UI 定位表」',
    (await onTab(11, 'pub:dump')) && (await onTab(11, 'pub:map')));
  ok('页签 8 有「查询」（品牌统计）', await onTab(8, 'stats:refresh'));
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
      logFile: path.join(TMP, 'logs', 'update.log')
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

  // ---- 更新日志开关：默认关，开了要真的落盘；而且必须把更新库自己的 logger 接管过来 ----
  // 为什么值得在界面层再验一次：这个开关的价值全在「开完以后真的能拿到硬证据」。
  // 只验主进程函数存在是不够的 —— 按钮没接线 / 状态没刷新，用户点了也是白点。
  {
    const logPath = path.join(TMP, 'logs', 'update.log');
    store.set({ update: { log: false } });      // 清掉可能残留的偏好，从「关」开始
    updater.setLogEnabled(false, logPath);

    const readBox = () => win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav[data-tab="7"]').click();
      await new Promise(r => setTimeout(r, 250));
      const box = document.querySelector('#updBox');
      return box ? { acts: [...box.querySelectorAll('[data-act]')].map(e => e.dataset.act), text: box.textContent } : null;
    })()`);

    const b0 = await readBox();
    ok('更新可用时设置页有「更新日志」一行 + 开启 / 打开日志文件两个按钮（默认关）',
       !!b0 && /更新日志/.test(b0.text) && b0.acts.includes('upd:log:on') && b0.acts.includes('upd:log:open'),
       JSON.stringify(b0 && { has: /更新日志/.test(b0.text), acts: b0.acts }));
    ok('★ 关着的时候也写明「默认关闭」+ 为什么值得开（差分退回全量只有这里看得见）',
       !!b0 && /默认关闭/.test(b0.text) && /差分/.test(b0.text),
       (b0 && b0.text || '').replace(/\s+/g, ' ').slice(0, 130));
    ok('★ 关着时不许假装在记录：界面上不出现「记录中」，磁盘上也没有日志文件',
       !!b0 && !/记录中/.test(b0.text) && !fs.existsSync(logPath));
    ok('★ 界面上写明日志里只有版本号/字节数，不含素材品牌 SKU（不违「数据不出本机」）',
       !!b0 && /不含/.test(b0.text) && /SKU/.test(b0.text), (b0 && b0.text || '').replace(/\s+/g, ' ').slice(-90));

    // 点「开启」→ 走真 IPC（ipcMain.handle('update:set-log')）
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-act="upd:log:on"]').click();
      await new Promise(r => setTimeout(r, 500));
    })()`);
    const onBox = await readBox();
    ok('★ 点「开启」后日志文件真的建出来了（不是只改了个界面状态）', fs.existsSync(logPath), logPath);
    ok('★ 界面立刻变成「记录中」，按钮变成「关闭」（用户看得见自己开的开关生效了）',
       !!onBox && /记录中/.test(onBox.text) && onBox.acts.includes('upd:log:off'),
       JSON.stringify(onBox && { rec: /记录中/.test(onBox.text), acts: onBox.acts }));
    ok('★ 开启后界面上能看到日志落到哪（update.log 的完整路径）', !!onBox && /update\.log/.test(onBox.text));
    ok('★ 开关写进配置（重启后还记得，不用每次重开）', store.get('update.log') === true, String(store.get('update.log')));

    // 点「关闭」→ 停写，但已写下的内容不许删
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-act="upd:log:off"]').click();
      await new Promise(r => setTimeout(r, 500));
    })()`);
    const offBox = await readBox();
    ok('★ 点「关闭」后停写，且已经写下的内容不会被删',
       fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').length > 0 && !updater.logStatus().enabled);
    ok('关闭后界面回到「默认关闭」，而且仍然告诉你文件在哪（下次要翻还找得到）',
       !!offBox && /默认关闭/.test(offBox.text) && !/记录中/.test(offBox.text) && /update\.log/.test(offBox.text),
       (offBox && offBox.text || '').replace(/\s+/g, ' ').slice(0, 120));
    ok('关闭也写进配置', store.get('update.log') === false, String(store.get('update.log')));
  }

  // 源码级锚点：日志关着时不挂 logger，开着时**必须**接管 ——
  // 以后若有人图省事把它改回 `up.logger = null`，「差分退回全量」这条线索就又没了
  {
    const updSrc = fs.readFileSync(path.join(ROOT, 'src/main/updater.js'), 'utf8');
    ok('★ updater.js 里 logger 是「按开关挂」的（开着才接管，关着不挂）',
       /up\.logger\s*=\s*\(logFd !== null\)\s*\?\s*fileLogger\s*:\s*null/.test(updSrc),
       (updSrc.match(/up\.logger\s*=[^\n]*/) || ['(找不到)'])[0].trim());
    ok('★ 下载完成时会把「这次下了多少字节」记下来（判断差分有没有生效只认这个数）',
       /logLine\('downloaded'[^\n]*state\.total/.test(updSrc),
       (updSrc.match(/logLine\('downloaded'[^\n]*/) || ['(找不到)'])[0].trim().slice(0, 110));
    ok('★ 日志文件有上限、不会无限长大', /const LOG_MAX_BYTES = \d+ \* 1024 \* 1024/.test(updSrc), (updSrc.match(/const LOG_MAX_BYTES[^\n]*/) || [''])[0]);
    ok('★ 日志路径算在 userData 下（不在仓库里，仓库目录可能是只读的）',
       /function defaultLogFile\(userDataDir\)[\s\S]{0,120}logs/.test(updSrc));
  }

  // 把更新模块还原成「未打包」的初始状态，免得影响后面还在用同一进程的断言
  updater._reset();
  updater.init({ send: () => {}, packaged: app.isPackaged, version: app.getVersion() });

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
  // 而高级设置页里它们都在（而且「文案模型 / 货号颜色 / 外部依赖路径」三块默认是**收起**的）
  const advUi = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="11"]').click();
    await new Promise(r => setTimeout(r, 200));
    const pane = document.querySelector('#pane');
    const has = s => !!pane.querySelector(s);
    const ds = [...pane.querySelectorAll('details.box')];
    return {
      adbPath: has('[data-cfg="publish.adbPath"]'), ffPath: has('[data-cfg="publish.ffmpegPath"]'),
      dump: has('[data-act="pub:dump"]'), map: has('[data-act="pub:map"]'),
      recover: has('[data-act="pub:recoverEdit"]'),
      llm: has('[data-cfg="copy.llm.enabled"]'), sku: has('[data-cfg="verify.api.endpoint"]'),
      mode: has('[data-cfg="verify.mode"]'),
      collapsed: ds.length, openCount: ds.filter(d => d.open).length
    };
  })()`);
  ok('★ 高级设置页收齐了这些入口（UI 定位表 / 失败恢复 / 文案模型 / SKU 接口 / adb、ffmpeg 路径）',
    advUi.adbPath && advUi.ffPath && advUi.dump && advUi.map && advUi.recover
      && advUi.llm && advUi.sku && advUi.mode, JSON.stringify(advUi));
  ok('★ 高级设置里「可选」的三块默认是收起的（折叠区，不占地方）',
    advUi.collapsed === 3 && advUi.openCount === 0, JSON.stringify(advUi));
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
  ok('设置页把那两个裸输入框换成了「打开文案提示词」入口',
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.nav[data-tab="7"]').click();
      const pane = document.querySelector('#pane');
      return !pane.querySelector('[data-cfg="copy.promptWrite"]')
        && !pane.querySelector('[data-cfg="copy.promptFilter"]')
        && !!pane.querySelector('[data-act="copy:prompt"]');
    })()`));

  // ---- 失败恢复动作：界面能编辑、能存进配置（走真实 IPC，不直连模块）----
  // （2026-10-02 起这个入口在「高级设置」页，不在「模拟器发布」页）
  const rec = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.nav[data-tab="11"]').click();
      await new Promise(r => setTimeout(r, 120));
      document.querySelector('[data-act="pub:recoverEdit"]').click();
      await new Promise(r => setTimeout(r, 120));
      const box = document.getElementById('recoverBox');
      const opened = !!box;
      if (box) box.value = JSON.stringify([{ name: '删除卡片', action: 'tapText', value: '删除' }, { action: 'wait', value: 600 }]);
      document.querySelector('[data-act="pub:recoverSave"]').click();
      await new Promise(r => setTimeout(r, 500));
      const cfg = await window.api.configGet();
      return { opened, recover: ((cfg.publish || {}).uiMap || {}).recover || [], closed: !document.getElementById('recoverBox') };
    })()
  `);
  ok('失败恢复动作：界面能编辑并保存进配置', rec.opened && rec.recover.length === 2 && rec.closed, JSON.stringify(rec.recover));

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
