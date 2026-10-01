/* 界面自检：用隐藏窗口加载真实渲染层，把 9 个页签切一遍，确认
     · 免登录（BLUEV_NO_LOGIN=1）能进主界面
     · 9 个页签都能渲染、标题对得上
     · 渲染层零控制台报错（含未捕获异常 / 未处理的 Promise）
   用法：npx electron tools/uicheck.js       （tools/run-all.sh 里就是这么调的）

   注意：userData 会被指到临时目录，不会动你本机的 config.json / auth.json / project.json。
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

const TABS = ['素材整理', '合规检查', '文案生成', '货号颜色校验', '发布单', '模拟器发布', '设置', '品牌统计', '品牌与权限'];
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

  ok('左侧导航是 9 个页签', await win.webContents.executeJavaScript('document.querySelectorAll(".nav").length') === 9);
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

  for (let i = 1; i <= 8; i++) {
    await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.nav[data-tab="${i}"]'); if (b) b.click(); return true; })()`);
    await new Promise(r => setTimeout(r, 150));
    const info = await win.webContents.executeJavaScript(`(() => {
      const pane = document.querySelector('#pane');
      const h2 = document.querySelector('#head h2');
      return { size: pane ? pane.innerHTML.length : 0, title: h2 ? h2.textContent : '' };
    })()`);
    ok(`页签 ${i}「${TABS[i - 1]}」能渲染`, info.size > 20 && info.title === TABS[i - 1], `标题「${info.title}」· ${info.size} 字节`);
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
  ok('页签 6 有「失败恢复动作」', await onTab(6, 'pub:recoverEdit'));
  ok('页签 8 有「查询」（品牌统计）', await onTab(8, 'stats:refresh'));
  ok('页签 8 有「导出 xlsx」（品牌统计）', await onTab(8, 'stats:export'));

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
      packaged: true, version: '9.9.9', channel: 'stable'
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

  const adbSaved = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav[data-tab="6"]').click();
    await new Promise(r => setTimeout(r, 150));
    const el = document.querySelector('[data-cfg="publish.adbPath"]');
    if (!el) return { found: false };
    el.value = 'D:/fake/adb.exe';
    el.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const cfg = await window.api.configGet();
    return { found: true, saved: ((cfg.publish || {}).adbPath) || '' };
  })()`);
  ok('模拟器发布页能填 adb 完整路径（自检那句提示承诺过这个入口）',
    adbSaved.found && adbSaved.saved === 'D:/fake/adb.exe', JSON.stringify(adbSaved));
  const adbMod = require(path.join(ROOT, 'src/main/services/adb.js'));
  ok('★ 填完立刻生效、不用重启（自检第一行会回显用的是哪个 adb）',
    adbMod.getAdbPath() === 'D:/fake/adb.exe', adbMod.getAdbPath());
  ok('设置页把那两个裸输入框换成了「打开文案提示词」入口',
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.nav[data-tab="7"]').click();
      const pane = document.querySelector('#pane');
      return !pane.querySelector('[data-cfg="copy.promptWrite"]')
        && !pane.querySelector('[data-cfg="copy.promptFilter"]')
        && !!pane.querySelector('[data-act="copy:prompt"]');
    })()`));

  // ---- 失败恢复动作：界面能编辑、能存进配置（走真实 IPC，不直连模块） ----
  const rec = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.nav[data-tab="6"]').click();
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

  // 品牌标记：界面上是**两处**内联 SVG（标题栏 17、登录卡 26），加上打包图标 build/icon.ico，
  // 一共**三份来源**。换 logo 最容易「只改一处」，所以这里把它们绑住 ——
  // 光断言「有 path」不够：旧的「方底 + 白 V」也有 path。
  const brand = await win.webContents.executeJavaScript(`
    (() => {
      const pick = (sel) => {
        const svg = document.querySelector(sel + ' svg');
        if (!svg) return null;
        return {
          ds: [...svg.querySelectorAll('path')].map(p => p.getAttribute('d')),
          rects: svg.querySelectorAll('rect').length,
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
    sameD ? `viewBox ${brand.title.viewBox}` :
      `标题栏 ${JSON.stringify(brand.title)} / 登录卡 ${JSON.stringify(brand.gate)}`);
  ok('logo 是新字母标（两笔 V、无方底），不是旧的「方底 + 白 V」',
    sameD && brand.title.rects === 0 && brand.title.ds.length === 2 &&
    brand.title.ds.includes('M300 308L512 728L724 308'),
    `rects=${brand.title ? brand.title.rects : '?'} paths=${brand.title ? brand.title.ds.length : '?'}`);

  const ico = (() => {
    try {
      const b = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
      const n = b.readUInt16LE(4);
      let fine = b.readUInt16LE(2) === 1 && n >= 6;
      for (let i = 0; i < n && fine; i++) {
        const off = 6 + i * 16;
        const len = b.readUInt32LE(off + 8);
        const pos = b.readUInt32LE(off + 12);
        // 越界、或该条不是内嵌 PNG（Vista 起 ICO 允许直接放 PNG）—— 都算坏
        if (pos + len > b.length) fine = false;
        else if (!(b[pos] === 0x89 && b.toString('ascii', pos + 1, pos + 4) === 'PNG')) fine = false;
      }
      return { fine, n, size: b.length };
    } catch (e) { return { fine: false, n: 0, size: 0, err: e.message }; }
  })();
  ok('打包图标 build/icon.ico 在内且结构可解（每个尺寸都是内嵌 PNG）', ico.fine,
    ico.fine ? `${ico.n} 个尺寸 / ${ico.size} B` : (ico.err || '结构损坏'));

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
