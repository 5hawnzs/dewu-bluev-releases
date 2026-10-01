/* 界面自检：用隐藏窗口加载真实渲染层，把 8 个页签切一遍，确认
     · 免登录（BLUEV_NO_LOGIN=1）能进主界面
     · 8 个页签都能渲染、标题对得上
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

const TABS = ['素材整理', '合规检查', '文案生成', '货号颜色校验', '发布单', '模拟器发布', '设置', '品牌统计'];
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

  ok('左侧导航是 8 个页签', await win.webContents.executeJavaScript('document.querySelectorAll(".nav").length') === 8);
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
