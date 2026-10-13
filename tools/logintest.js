/* 登录门自检：登录界面能不能用、会不会被绕过
   对应 docs/HANDOFF.md §2 第 3 条「本机登录门：auth:* 通道，guard() 拦截未登录的 job:run 等调用」。

   覆盖：
     · 首次启动自动建管理员；口令只存 scrypt 哈希 + 随机盐，明文不落盘
     · 未登录时界面被登录页盖住（.app 隐藏），业务通道在主进程侧就被 guard() 拦掉
     · 错口令 / 不存在的账号 → 明确报错且不放进；正确口令 + 记住登录 → 进主界面
     · 记住登录写进 auth.json；重启（模块重载）后免密恢复
     · 普通成员看不到账号列表、能改自己密码；停用后不能登录
     · 不能停用/删除自己，不能删掉最后一个管理员
     · 退出登录回到登录门；连错到上限锁定 5 分钟（锁定期间口令正确也进不去）
     · 账号管理页的两个入口（2026-10-02 第二轮）：品牌管理表里不再有「文案」按钮；
       「配置权限 / 重置密码」是**行内按钮 + 弹窗**，旧的两条下拉工具栏（#pbUser / #rsUser / #rsPwd）整条删除；
       弹窗里保存真的写进 auth.json（不是只改界面），保存后自动收起；
       重置密码同样走弹窗：空口令不许提交、填了就真换（新口令能登、旧口令被拒）

   用法：npx electron tools/logintest.js
   注意：userData 指到临时目录，不会动你本机的 auth.json / config.json / project.json。
*/
const { app, BrowserWindow, ipcMain } = require('electron');
require('./test-runtime')({ app });
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-login-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('disable-gpu');

const ADMIN = 'admin';
const PASS = 'BlueV@2026';        // 出厂口令（auth.js DEFAULT_USER / DEFAULT_PASS）
const MEMBER = 'member1';
const MEMBER_PASS = 'Member@123';

const errors = [];
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
  const githubUpdates = require(path.join(ROOT, 'src/main/githubupdates.js'));
  githubUpdates.start = () => {};
  const liveFetch = global.fetch;
  global.fetch = (url, opts) => String(url).startsWith('https://raw.githubusercontent.com/' + githubUpdates.REPO)
    ? Promise.resolve(new Response(JSON.stringify({ version: '1.1.1', build: githubUpdates.BUILD, bytes: 1000000, sha256: '0'.repeat(64), url: 'https://github.com/' + githubUpdates.REPO + '/releases/download/test/test.exe' })))
    : liveFetch(url, opts);
  store.load();
  project.load();
  auth.load();
  ipc.register();

  ok('默认开启登录门（BLUEV_NO_LOGIN 没设）', auth.enabled() === true, 'requireLogin=' + auth.status().requireLogin);

  const win = new BrowserWindow({
    show: false,
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
    if (level >= 3) errors.push('[console] ' + message + (sourceId ? ` (${String(sourceId).split('/').pop()}:${line})` : ''));
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));

  // 页面侧助手：全部走真实界面（填表单 + 提交），不是直接调 IPC 冒充「已登录」
  await win.webContents.executeJavaScript(`
    window.__t = {
      locked: () => document.body.classList.contains('locked'),
      appHidden: () => getComputedStyle(document.querySelector('.app')).display === 'none',
      gateShown: () => getComputedStyle(document.getElementById('gate')).display !== 'none',
      err: () => (document.getElementById('lgErr') || {}).textContent || '',
      // 登录卡片整张的可见文本：出厂账号提示已删，用**真负向**断言盯住「别再冒出来」
      cardText: () => (document.querySelector('.gate .gcard') || {}).textContent || '',
      hasTipEl: () => !!document.getElementById('lgTip'),
      user: () => (document.getElementById('chipUser') || {}).textContent || '',
      title: () => (document.querySelector('#head h2') || {}).textContent || '',
      login: async (u, p, rem) => {
        document.getElementById('lgUser').value = u;
        document.getElementById('lgPwd').value = p;
        document.getElementById('lgRem').checked = !!rem;
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 900));
        const button = document.getElementById('lgGo');
        return { locked: window.__t.locked(), appHidden: window.__t.appHidden(), loading: button.getAttribute('aria-busy') === 'true',
          waveBars: document.querySelectorAll('#gateLoading .gate-wave-bar').length,
          separate: !document.getElementById('gateLoading').hidden && document.getElementById('loginForm').hidden,
          buttonPlain: button.textContent === '登 录' && button.querySelectorAll('.gate-wave-bar').length === 0,
          err: window.__t.err(), user: window.__t.user(), title: window.__t.title() };
      },
      logout: async () => {
        document.getElementById('btnLogout').click();
        await new Promise(r => setTimeout(r, 400));
        return { locked: window.__t.locked(), appHidden: window.__t.appHidden(), gateShown: window.__t.gateShown() };
      }
    };
    true;
  `);
  const js = code => win.webContents.executeJavaScript(code);

  // ---- ① 未登录：界面被登录页盖住 ----
  const boot = await js(`({ locked: __t.locked(), appHidden: __t.appHidden(), gateShown: __t.gateShown(), cardText: __t.cardText(), hasTipEl: __t.hasTipEl(), err: __t.err() })`);
  ok('未登录时停在登录门（业务界面整块隐藏）', boot.locked && boot.appHidden && boot.gateShown,
    JSON.stringify({ locked: boot.locked, appHidden: boot.appHidden, gateShown: boot.gateShown }));
  // ★ 真负向（2026-10-02 用户要求删掉登录页那行 admin）：两条一起盯 ——
  //   ① 卡片文本里不许再出现 admin / BlueV@2026 / 初始账号（换个位置重新写上去也会红）；
  //   ② #lgTip 那个元素必须**真的不存在**，不是 hidden（只藏不删 = 读取链还在）。
  ok('登录页不再回显任何出厂账号 / 口令',
    !/admin/i.test(boot.cardText) && !/BlueV@2026/.test(boot.cardText) && !/初始账号/.test(boot.cardText),
    (boot.cardText || '').replace(/\s+/g, ' ').trim().slice(0, 110));
  ok('出厂账号提示的元素已删除（不是 hidden）', boot.hasTipEl === false, 'hasTipEl=' + boot.hasTipEl);

  // ---- ② 未登录：业务通道在主进程侧就被拦住（不是前端藏起来那种假登录） ----
  const blocked = await js(`(async () => {
    const run = await window.api.run('copy.generate', {});
    const cfg = await window.api.configGet();
    const dir = await window.api.pickDir({});
    return { run: run && run.error, cfg: cfg && cfg.error, dir: dir && dir.error };
  })()`);
  ok('未登录时跑任务被主进程拦下', /未登录|过期/.test(blocked.run || ''), blocked.run);
  ok('未登录时读配置被拦下', /未登录|过期/.test(blocked.cfg || ''), blocked.cfg);
  ok('未登录时选目录被拦下', /未登录|过期/.test(blocked.dir || ''), blocked.dir);

  // 新加的通道最容易漏掉 guard()，而 update:install 是会**重启整个应用**的那一个，
  // 漏了就等于「没登录的人也能把别人正在跑的任务重开掉」。五个一起查。
  const updBlocked = await js(`(async () => {
    const st = await window.api.updateStatus();
    const ck = await window.api.updateCheck();
    const dl = await window.api.updateDownload();
    const ins = await window.api.updateInstall();
    const ch = await window.api.updateSetChannel('beta');
    return { st: st && st.error, ck: ck && ck.error, dl: dl && dl.error, ins: ins && ins.error, ch: ch && ch.error };
  })()`);
  ok('未登录时更新通道全被拦下（含会重启应用的 update:install 和改通道的 update:set-channel）',
    ['st', 'ck', 'dl', 'ins', 'ch'].every(k => /未登录|过期/.test(updBlocked[k] || '')), JSON.stringify(updBlocked));

  // ---- ③ 错口令 / 不存在的账号：明确报错、不放进去，且不泄露账号是否存在 ----
  const wrong = await js(`__t.login(${JSON.stringify(ADMIN)}, 'definitely-wrong', false)`);
  ok('口令错 → 明确报错且仍在登录页', wrong.locked && /账号或密码不正确/.test(wrong.err), wrong.err);
  const noUser = await js(`__t.login('no-such-user', 'whatever', false)`);
  ok('账号不存在 → 提示与口令错一致（不泄露账号是否存在）', noUser.locked && noUser.err === wrong.err, noUser.err);

  // ---- ④ 登录成功后延迟首页配置：主界面准备完成前，登录页须持续显示波形并挡住空白主界面 ----
  const winmod = require(path.join(ROOT, 'src/main/window.js'));
  const originalLoginMode = winmod.setLoginMode;
  const windowChanges = [];
  winmod.setLoginMode = on => { windowChanges.push(on); };
  let delayFirstConfig = true;
  ipcMain.removeHandler('config:get');
  ipcMain.handle('config:get', async (_e, key) => {
    if (delayFirstConfig) { delayFirstConfig = false; await new Promise(r => setTimeout(r, 1500)); }
    if (auth.enabled() && !auth.current()) return { ok: false, error: '未登录或登录已过期，请重新登录' };
    return store.get(key);
  });
  const loading = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, true)`);
  ok('首页加载期间主进程没有提前放大登录窗口', windowChanges.length === 0);
  const exclusive = await js(`(() => {
    const el = document.querySelector('.app');
    const before = el.hidden && el.inert && !document.querySelector('#gate').hidden;
    document.body.classList.remove('locked');
    const stillHidden = getComputedStyle(el).display === 'none';
    document.body.classList.add('locked');
    return before && stillHidden;
  })()`);
  ok('慢加载期间主界面 hidden 且 inert，即使临时移除 locked 也不叠显', exclusive);
  ok('登录确认后显示独立加载页，波形不再占用登录按钮，主界面隐藏',
    loading.locked && loading.appHidden && loading.loading && loading.waveBars === 9 && loading.separate && loading.buttonPlain,
    JSON.stringify({ locked: loading.locked, appHidden: loading.appHidden, loading: loading.loading, waveBars: loading.waveBars }));
  await js('new Promise(r => setTimeout(r, 800))');
  const inApp = await js(`({ locked: __t.locked(), appHidden: __t.appHidden(), title: __t.title(), user: __t.user() })`);
  ok('首页准备完成后才通知主进程放大窗口，且仅一次', windowChanges.length === 1 && windowChanges[0] === false);
  winmod.setLoginMode = originalLoginMode;
  ok('正式界面显示时登录页显式隐藏、主界面解除 inert', await js(`document.querySelector('#gate').hidden && !document.querySelector('.app').hidden && !document.querySelector('.app').inert`));
  ok('口令正确 → 进入主界面', !inApp.locked && inApp.title === '素材整理', `locked=${inApp.locked} 标题=${inApp.title}`);
  ok('标题栏显示当前账号与角色', /管理员/.test(inApp.user), inApp.user);
  const allowed = await js(`(async () => { const c = await window.api.configGet(); return !!(c && c.paths && c.paths.output); })()`);
  ok('登录后业务通道放行（能读到配置）', allowed === true);

  // ★★ 2026-10-04 测试隔离修复：**把输出目录指到本次的临时 TMP 里**。
  //   根因（真机实测复现）：`paths.output` 的默认值是 `~/输出/得物`（winpath.js#defaults），
  //   而统计那一组要读 `<output>/publish-log.jsonl`。本机跑过真机发布后，那个**真实目录**里
  //   有历史日志（本机实测 51 条，其中 30 条 brandId 为空）⇒ 断言
  //   「未标品牌 = 0 条」必然红 —— 而它红的原因**跟被测代码毫无关系**，纯粹是测试没隔离。
  //   这种红最坏：会让人去翻 stats/brands 的代码（我就是先怀疑了自己那几处改动）。
  //   ⇒ 在这一组之前把 output 指进 TMP；后面所有 __t 调用都走这份隔离配置。
  await js(`(async () => { await window.api.configSet({ paths: { output: ${JSON.stringify(path.join(TMP, 'output'))} } }); return true; })()`);
  const tabs = await js(`(async () => {
    const titles = [];
    // ★ 页签号与个数都**从 DOM 上数出来**，不要写死：
    //   ① 原先写 i <= 8 ⇒ 「新增第 9 个页签」这条永远红不了（循环只跑 8 次），断言形同虚设；
    //   ② 2026-10-03 删掉「发布单」页签后，编号在 5 处**留了空位**（1..4、6..12）——
    //      再按 i = 1..n 去 querySelector('.nav[data-tab="i"]') 会在 i=5 拿到 null、
    //      .click() 直接抛异常，整段炸掉。⇒ 改成遍历真实存在的 .nav 按钮（顺序 = index.html 的排列顺序）。
    const btns = [...document.querySelectorAll('.nav')];
    for (const b of btns) {
      b.click();
      await new Promise(r => setTimeout(r, 90));
      titles.push(__t.title());
    }
    return titles;
  })()`);
  ok('登录后 11 个可见页签都能渲染（包含更新日志）',
    tabs.length === 11 && tabs.every(t => t && t.length > 1), `${tabs.length} 个：${tabs.join(' / ')}`);
  // ★ 一律用「有没有这一页」判，**不按第几个** —— 页签编号从 2026-10-03 起在 5 处留了空位，
  //   写死下标会在每次增删页签时失效（上一次就是这么被漏掉的）。
  ok('页签里有「品牌与权限」（品牌 + 账号 + 权限从设置页拆出来的那一页）',
    tabs.includes('品牌与权限'), tabs.join(' / '));
  ok('页签里有「运行日志」（归在左侧「执行」组里；内容和底部日志栏同一份）',
    tabs.includes('运行日志'), tabs.join(' / '));
  ok('页签里有「高级设置」（管理员可见；装一次就不再动的配置都在这里）',
    tabs.includes('高级设置'), tabs.join(' / '));
  ok('页签里不包含「货号颜色校验」（所有账号均不可见）',
    !tabs.includes('货号颜色校验'), tabs.join(' / '));
  ok('页签里有「本地词库」（标题「产品词 + 热门词」用的词库；所有人都能看）',
    tabs.includes('本地词库'), tabs.join(' / '));
  // ★ 负向断言：删掉的页签必须**真的不在**（否则以后有人加回来，整套回归照样全绿）
  ok('★「发布单」页签已删除（2026-10-03 用户要求；导出/打开/目录已挪到「模拟器发布」页）',
    !tabs.includes('发布单'), tabs.join(' / '));

  // ---- ④a 页签 12「本地词库」：**管理员**可编辑（真读 DOM，不是看源码）----
  const lexAdm = await js(`(async () => {
    document.querySelector('.nav[data-tab="12"]').click();
    const pane = document.querySelector('#pane');
    for (let k = 0; k < 30 && !pane.querySelector('#lxg-风格'); k++) await new Promise(r => setTimeout(r, 100));
    const h3 = [...pane.querySelectorAll('.box h3')].map(e => e.textContent);
    const lockedBox = document.querySelector('.lxlock');
    const saveBtn = document.querySelector('[data-act="lex:save"]');
    const resetBtn = document.querySelector('[data-act="lex:reset"]');
    return {
      editable: h3.filter(t => /^(风格|氛围|色感|场景|人群|季节|情绪|收尾)（/.test(t)).length,
      lockBox: h3.findIndex(t => t.indexOf('收尾') >= 0 && t.indexOf('锁定') >= 0),
      inputs: pane.querySelectorAll('[data-lx-in]').length,
      delBtns: pane.querySelectorAll('[data-lx-del]').length,
      lockedCtrls: lockedBox ? lockedBox.querySelectorAll('input,button').length : -1,
      saveDisabled: !!saveBtn && saveBtn.disabled === true,
      resetDisabled: !!resetBtn && resetBtn.disabled === true,
      redlines: /三条红线/.test(pane.textContent)
    };
  })()`);
  ok('★ 管理员进「本地词库」：8 个可编辑组，每组一个加词框、每个词一个删词按钮',
    lexAdm.editable === 8 && lexAdm.inputs === 8 && lexAdm.delBtns === 64,
    `组=${lexAdm.editable} 加词框=${lexAdm.inputs} 删词按钮=${lexAdm.delBtns}`);
  ok('★ 收尾没有锁定块，编辑控件与其他组一致',
    lexAdm.lockBox === -1 && lexAdm.lockedCtrls === -1, `锁定块控件数=${lexAdm.lockedCtrls}`);
  ok('★ 管理员看到的是**可用**的「保存 / 恢复内置」（不是灰的）',
    lexAdm.saveDisabled === false && lexAdm.resetDisabled === false,
    JSON.stringify({ save: lexAdm.saveDisabled, reset: lexAdm.resetDisabled }));
  ok('★ 本地词库页常驻三条红线提示', lexAdm.redlines === true);


  // ---- ⑤ 口令存储与「记住登录」落盘 ----
  const authFile = path.join(TMP, 'auth.json');
  const raw = fs.readFileSync(authFile, 'utf8');
  const db = JSON.parse(raw);
  ok('auth.json 落盘，且只有一个出厂管理员', db.users.length === 1 && db.users[0].username === ADMIN && db.users[0].role === 'admin',
    `users=${db.users.length} role=${db.users[0].role}`);
  ok('明文口令不落盘（只存 scrypt 哈希 + 随机盐）',
    !raw.includes(PASS) && /^[0-9a-f]{32}$/.test(db.users[0].salt) && /^[0-9a-f]{128}$/.test(db.users[0].hash),
    `salt ${String(db.users[0].salt).length} 位 / hash ${String(db.users[0].hash).length} 位`);
  ok('勾了「记住登录」会写 remember（7 天有效期）',
    !!(db.remember && db.remember.until > Date.now() + 6 * 86400000 && db.remember.until < Date.now() + 8 * 86400000),
    db.remember ? new Date(db.remember.until).toISOString() : '没有 remember');

  // ---- ⑥ 重启后凭「记住登录」免密（重载模块＝重跑一次启动流程） ----
  const authPath = require.resolve(path.join(ROOT, 'src/main/auth.js'));
  delete require.cache[authPath];
  const auth2 = require(authPath);
  const st2 = auth2.status();
  ok('重启后免密恢复登录（remember 生效）', st2.requireLogin === true && !!(st2.user && st2.user.username === ADMIN),
    JSON.stringify(st2.user && st2.user.username));

  // ---- ⑦ 账号规则与权限 ----
  const created = await js(`window.api.authCreateUser({ username: ${JSON.stringify(MEMBER)}, displayName: '成员一号', role: 'user', password: ${JSON.stringify(MEMBER_PASS)} })`);
  ok('管理员能新建普通成员', created.ok === true, created.error || created.user && created.user.username);
  const badName = await js(`window.api.authCreateUser({ username: 'ab', role: 'user', password: 'Abc@1234' })`);
  ok('账号名不合规会被拦下并说清规则', badName.ok === false && /3(–|-)32/.test(badName.error), badName.error);
  const badPass = await js(`window.api.authCreateUser({ username: 'member2', role: 'user', password: '123' })`);
  ok('口令太短会被拦下', badPass.ok === false && /至少 6 位/.test(badPass.error), badPass.error);
  const dup = await js(`window.api.authCreateUser({ username: ${JSON.stringify(MEMBER)}, role: 'user', password: 'Abc@1234' })`);
  ok('重复账号会被拦下', dup.ok === false && /已经存在/.test(dup.error), dup.error);

  const asMember = await js(`__t.login(${JSON.stringify(MEMBER)}, ${JSON.stringify(MEMBER_PASS)}, false)`);
  ok('普通成员能登录', !asMember.locked && /成员一号/.test(asMember.user), asMember.user);
  const usersDenied = await js(`window.api.authUsers()`);
  ok('普通成员看不到账号列表（只有管理员能）', usersDenied.ok === false && /只有管理员/.test(usersDenied.error), usersDenied.error);
  const selfPwd = await js(`window.api.authChangePwd(${JSON.stringify(MEMBER_PASS)}, 'Member@456')`);
  ok('普通成员能改自己的密码', selfPwd.ok === true, selfPwd.error || '');

  // 文案模型配置写入本机共用 copy.llm；所有登录账号均可编辑，不限管理员。
  const oldLlm = store.get('copy.llm');
  const memberLlmSet = await js(`window.api.configSet({ copy: { llm: { model: '__member_model_edit__' } } })`);
  ok('普通成员可通过真实 config:set 保存文案模型配置',
    !!memberLlmSet && store.get('copy.llm.model') === '__member_model_edit__',
    store.get('copy.llm.model'));
  store.set({ copy: { llm: oldLlm || {} } });

  const rogueFile = path.join(TMP, 'attacker.html');
  fs.writeFileSync(rogueFile, '<!doctype html><title>隔离来源攻击测试</title>');
  const rogue = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(ROOT, 'src/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  try {
    await rogue.loadFile(rogueFile);
    const rejected = await rogue.webContents.executeJavaScript('window.api.configSet({copy:{llm:{model:"attacker-model"}}})');
    ok('其他本地页面即使加载相同 preload，也无法调用真实 IPC',
      rejected.ok === false && /来源/.test(rejected.error) && store.get('copy.llm.model') !== 'attacker-model');
  } finally { rogue.destroy(); }

  const oldBrands = JSON.stringify(store.get('brands'));
  const injectedBrands = await js(`window.api.configSet({ brands: [{ id: 'stolen', name: '越权品牌' }] })`);
  ok('成员无法绕过品牌管理接口修改品牌注册表', injectedBrands.ok === false && JSON.stringify(store.get('brands')) === oldBrands);
  const injectedCloud = await js(`window.api.configSet({ cloud: { url: 'https://attacker.invalid', anonKey: 'fake' } })`);
  ok('成员无法改写同步目标窃取数据', injectedCloud.ok === false);
  const injectedExe = await js(`window.api.configSet({ publish: { adbPath: 'C:\\\\attack.exe' } })`);
  ok('成员无法通过配置接口替换可执行程序', injectedExe.ok === false);
  const injectedProto = await js(`window.api.configSet(JSON.parse('{"copy":{"__proto__":{"polluted":true}}}'))`);
  ok('配置入口拒绝原型污染载荷', injectedProto.ok === false && !({}).polluted);

  // ---- ⑦a-2 管理员专属页签：「高级设置」11 ----
  // ★ 这条必须真跑一遍（而不是看源码里有没有 syncAdminNav）：页签是 index.html 里的静态按钮，
  //   藏它的逻辑在渲染层，只有登录成普通成员再看 DOM 才算数。
  // 货号颜色校验已经从导航彻底移除；测试在 uicheck 中覆盖管理员和成员的旧链接/快捷键退回行为。
  const advHide = await js(`(async () => {
    const out = {};
    for (const t of ['11']) {
      const btn = document.querySelector('.nav[data-tab="' + t + '"]');
      if (!btn) { out[t] = { err: '页签 ' + t + ' 不存在' }; continue; }
      const hidden = btn.hidden === true && getComputedStyle(btn).display === 'none';
      btn.click();                       // 硬点一下，看会不会真的落在那一页
      await new Promise(r => setTimeout(r, 120));
      out[t] = { hidden, title: __t.title() };
    }
    return out;
  })()`);
  ok('★ 普通成员看不到「高级设置」页签（连图标都不占位）',
    !!advHide && advHide['11'].hidden === true, JSON.stringify(advHide && advHide['11']));
  ok('★ 普通成员就算硬点第 11 个页签也进不去（会被拉回«素材整理»）',
    !!advHide && advHide['11'].title === '素材整理', advHide && advHide['11'].title);

  // ---- ⑦a-3「本地词库」：所有登录成员均可编辑本机词库，仍受红线约束----
  const lexMem = await js(`(async () => {
    const btn = document.querySelector('.nav[data-tab="12"]');
    const visible = !!btn && btn.hidden !== true && getComputedStyle(btn).display !== 'none';
    btn.click();
    const pane = document.querySelector('#pane');
    for (let k = 0; k < 30 && !pane.querySelector('#lxg-风格'); k++) await new Promise(r => setTimeout(r, 100));
    const saveBtn = document.querySelector('[data-act="lex:save"]');
    return {
      visible,
      title: __t.title(),
      groupsShown: !!pane.querySelector('#lxg-风格'),
      inputs: pane.querySelectorAll('[data-lx-in]').length,
      delBtns: pane.querySelectorAll('[data-lx-del]').length,
      saveDisabled: !!saveBtn && saveBtn.disabled === true,
      localChip: /本机词库|仅保存在本机/.test(pane.textContent)
    };
  })()`);
  ok('★ 普通成员**看得见**「本地词库」（不是管理员专属 —— 标题从哪些词里挑，谁都能看）',
    lexMem.visible === true && lexMem.title === '本地词库', lexMem.title);
  ok('★ 普通成员可编辑本机词库：八组加词框、删词按钮、保存可用',
    lexMem.groupsShown && lexMem.inputs === 8 && lexMem.delBtns > 0 && lexMem.saveDisabled === false,
    JSON.stringify(lexMem));
  ok('★ 页面明确本机词库的生效范围', lexMem.localChip === true);
  const memLexSave = await js(`window.api.hotwordsSave([{ key: '风格', words: ['简约百搭'] }, { key: '收尾', words: ['越看越喜欢'] }])`);
  ok('★ 普通成员可保存本机词库，主进程回传真实保存结果',
    memLexSave.ok === true && memLexSave.library.groups.some(g => g.key === '风格' && g.words.includes('简约百搭')) && memLexSave.library.groups.some(g => g.key === '收尾' && g.words.includes('越看越喜欢')), JSON.stringify(memLexSave));
  const memLexReset = await js(`window.api.hotwordsReset()`);
  ok('★ 普通成员可恢复本机内置词库',
    memLexReset.ok === true && memLexReset.library.isCustom === false, JSON.stringify(memLexReset));


  // ---- ⑦b 品牌是管理员专属：普通成员连注册表都改不了 ----
  const memberBrandAdd = await js(`window.api.brandAdd({ name: '成员偷加的品牌' })`);
  ok('普通成员不能新增品牌（主进程侧拦下，不是前端藏起来）',
    memberBrandAdd.ok === false && /只有管理员/.test(memberBrandAdd.error), memberBrandAdd.error);
  const memberBrands = await js(`window.api.brandList()`);
  ok('普通成员的品牌下拉是空的（还没被分配）',
    memberBrands.ok === true && memberBrands.isAdmin === false && memberBrands.mine.length === 0,
    JSON.stringify(memberBrands.mine));
  const memberStats = await js(`window.api.statsQuery({ days: 0 })`);
  ok('普通成员看统计时范围被限死（一个品牌都没有 → 看不到任何品牌的账）',
    memberStats.ok === true && (memberStats.brands || []).length === 0 && memberStats.totals.rows === 0,
    `brands=${(memberStats.brands || []).length} rows=${memberStats.totals && memberStats.totals.rows}`);

  const backAdmin = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  const memberId = (await js(`window.api.authUsers()`)).users.find(u => u.username === MEMBER).id;
  const disabled = await js(`window.api.authUpdateUser(${JSON.stringify(memberId)}, { disabled: true })`);
  ok('管理员能停用普通成员', backAdmin.locked === false && disabled.ok === true, disabled.error || '');
  const memberDenied = await js(`__t.login(${JSON.stringify(MEMBER)}, 'Member@456', false)`);
  // 此刻界面里还挂着管理员会话，所以不是「停在登录页」，而是「这次登录被拒 + 会话仍是管理员」
  ok('停用后不能登录（当前会话不受影响）',
    /已停用/.test(memberDenied.err) && /管理员/.test(memberDenied.user),
    `${memberDenied.err} / 当前会话=${memberDenied.user}`);

  const selfId = (await js(`window.api.authUsers()`)).currentId;
  const selfDisable = await js(`window.api.authUpdateUser(${JSON.stringify(selfId)}, { disabled: true })`);
  ok('不能停用自己', selfDisable.ok === false && /不能停用自己/.test(selfDisable.error), selfDisable.error);
  const selfRemove = await js(`window.api.authRemoveUser(${JSON.stringify(selfId)})`);
  ok('不能删掉自己（否则没人能管账号）', selfRemove.ok === false && /不能删自己/.test(selfRemove.error), selfRemove.error);

  // ---- ⑦c 品牌注册表 ----
  const bAdd = await js(`window.api.brandAdd({ name: '品牌甲' })`);
  ok('管理员能新增品牌', bAdd.ok === true && /^brd_/.test(bAdd.brand.id), bAdd.error || `${bAdd.brand.name} ${bAdd.brand.id}`);
  const bDup = await js(`window.api.brandAdd({ name: '品牌甲' })`);
  ok('重名品牌被拒（同名会让统计合并）', bDup.ok === false && /已经存在/.test(bDup.error), bDup.error);
  const bReserved = await js(`window.api.brandAdd({ name: '未标品牌' })`);
  ok('统计保留名不能当品牌名（否则和「未标品牌」分不开）',
    bReserved.ok === false && /保留名/.test(bReserved.error), bReserved.error);

  // ★ 出厂默认**不预设任何品牌**了 ⇒「多品牌」这个场景必须由测试自己造出来。
  //   旧版是靠出厂自带的那一个品牌凑到 2 个，等于断言依赖种子数据 —— 种子一改就假红。
  const bSecond = await js(`window.api.brandAdd({ name: '品牌乙' })`);
  ok('多品牌场景由测试自己造（不依赖出厂预设品牌）',
    bSecond.ok === true, bSecond.error || (bSecond.brand && bSecond.brand.name));

  const brandId = bAdd.brand.id;
  const bList = await js(`window.api.brandList()`);
  ok('管理员的品牌下拉 = 全部品牌', bList.ok === true && bList.isAdmin === true && bList.mine.length === bList.brands.length && bList.mine.length >= 2,
    `${bList.mine.length}/${bList.brands.length}`);

  // 产出类任务必须有品牌归属：有多个品牌时没选就报错，不替他挑（挑错了归属就是错的）
  const noBrand = await js(`window.api.run('copy.generate', {})`);
  ok('多品牌下不选品牌起产出任务 → 被拦下并列出可选', noBrand.ok === false && /请先选择品牌/.test(noBrand.error), noBrand.error);
  const ghostBrand = await js(`window.api.run('copy.generate', { brandId: 'brd_nope' })`);
  ok('指定一个不存在的品牌 → 明确报「品牌不存在」', ghostBrand.ok === false && /品牌不存在/.test(ghostBrand.error), ghostBrand.error);

  // ---- ⑦d 品牌权限的分配 / 改名不丢 / 删除要清干净 ----
  const assign = await js(`window.api.authUpdateUser(${JSON.stringify(memberId)}, { brands: [${JSON.stringify(brandId)}] })`);
  ok('管理员能给成员分配品牌', assign.ok === true && assign.user.brands.length === 1, assign.error || JSON.stringify(assign.user.brands));
  const badAssign = await js(`window.api.authUpdateUser(${JSON.stringify(memberId)}, { brands: ['brd_不存在'] })`);
  ok('分配一个不存在的品牌会被拒（不静默丢弃）', badAssign.ok === false && /不存在/.test(badAssign.error), badAssign.error);

  const renamed = await js(`window.api.brandUpdate(${JSON.stringify(brandId)}, { name: '品牌甲 2026' })`);
  const afterRename = await js(`window.api.authUsers()`);
  ok('品牌改名后已分配的权限还在（权限记的是 id，不是名字）',
    renamed.ok === true && renamed.brand.name === '品牌甲 2026'
    && afterRename.users.find(u => u.username === MEMBER).brands.includes(brandId),
    `新名=${renamed.brand && renamed.brand.name}`);

  // ---- ⑦d2 账号管理页的两个入口：品牌管理的「文案」按钮已删；
  //            「配置权限 / 重置密码」改成**行内按钮 + 弹窗**，旧的两条下拉工具栏整条删除 ----
  // ★ 负向与正向一起盯：旧工具栏（#pbUser / #rsUser / #rsPwd / 「保存品牌权限」）必须**元素级消失**，
  //   不是 hidden —— 只藏起来的话，那条「先在下拉里选人」的旧路还能走回来。
  // 先造一个**一次性账号**给下面的重置密码用：不动 member1 的口令（后面 ⑦e 还要用 Member@456 登他）
  const probe = await js(`window.api.authCreateUser({ username: 'pwdprobe', displayName: '重置测试', role: 'user', password: 'Probe@1234' })`);
  ok('⑦d2 造一个一次性账号（给「管理员重置别人口令」这条从来没测过的路用）',
    probe.ok === true, probe.error || (probe.user && probe.user.username));

  // 上面那些品牌/账号是直连 IPC 造的，渲染层的 brandsMeta / users 还不知道 ⇒ 重新登录一次，
  // 让 enterApp() 把品牌与账号名单都刷新到最新（新造的 pwdprobe 也要出现在表里），后面才是验「真实界面」。
  const refreshForUI = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  ok('⑦d2 重新登录一次，把渲染层的品牌与账号名单刷到最新（下面按真实界面验）',
    refreshForUI.locked === false, refreshForUI.err || '');

  const acctUI = await js(`(async () => {
    document.querySelector('.nav[data-tab="9"]').click();
    await new Promise(r => setTimeout(r, 250));
    const tables = [...document.querySelectorAll('#pane .tw table')];
    const brandTable = tables.find(t => /有权限的账号/.test(t.querySelector('thead').textContent));
    const acctTable = tables.find(t => /上次登录/.test(t.querySelector('thead').textContent));
    const brandBtns = brandTable ? [...brandTable.querySelectorAll('tbody button')].map(b => b.textContent.trim()) : null;
    const permBtn = acctTable ? acctTable.querySelector('tbody tr [data-act="up:perm"]') : null;
    return {
      brandBtns,
      permLabel: permBtn ? permBtn.textContent.trim() : '',
      hasPwdBtn: !!(acctTable && acctTable.querySelector('tbody tr [data-act="up:pwd"]')),
      oldPerm: !!document.getElementById('pbUser'),
      oldRs: !!(document.getElementById('rsUser') || document.getElementById('rsPwd')),
      saveBtn: [...document.querySelectorAll('#pane button')].some(b => b.textContent.trim() === '保存品牌权限')
    };
  })()`);
  ok('⑦d2 品牌管理表里不再有「文案」按钮（提示词只在「文案生成 → 提示词配置」里改）',
    acctUI.brandBtns !== null && !acctUI.brandBtns.includes('文案'),
    '这一行的按钮现在是：' + (acctUI.brandBtns || []).join(' / '));
  ok('⑦d2 账号管理表每行右侧有「配置权限」按钮（弹窗入口）',
    acctUI.permLabel === '配置权限', 'permLabel=' + JSON.stringify(acctUI.permLabel));
  ok('⑦d2 账号管理表每行右侧还有「重置密码」按钮', acctUI.hasPwdBtn === true, 'hasPwdBtn=' + acctUI.hasPwdBtn);
  ok('⑦d2 旧的两条下拉工具栏整条删除（不是藏起来）：#pbUser / #rsUser / #rsPwd / 「保存品牌权限」都不在了',
    acctUI.oldPerm === false && acctUI.oldRs === false && acctUI.saveBtn === false,
    JSON.stringify({ pbUser: acctUI.oldPerm, rs: acctUI.oldRs, 保存按钮: acctUI.saveBtn }));

  // 行为级：点行内「配置权限」→ 弹窗 → 全勾 → 保存 → 真的写进 auth.json
  const permUI = await js(`(async () => {
    const before = ((await window.api.authUsers()).users || []).find(u => u.username === ${JSON.stringify(MEMBER)});
    const btn = document.querySelector('#pane [data-act="up:perm"]');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 220));
    const mask = document.getElementById('umodal');
    const opened = !!mask && !mask.hidden;
    const boxes = [...document.querySelectorAll('#umBox [data-brand]')];
    const save = document.querySelector('#umBox [data-act="up:permSave"]');
    boxes.forEach(b => { b.checked = true; });
    if (save) save.click();
    await new Promise(r => setTimeout(r, 700));
    const after = ((await window.api.authUsers()).users || []).find(u => u.username === ${JSON.stringify(MEMBER)});
    return {
      opened, boxes: boxes.length, hasSave: !!save,
      closedAfterSave: document.getElementById('umodal').hidden,
      before: (before && before.brands || []).length, after: (after && after.brands || []).length
    };
  })()`);
  ok('⑦d2 点行内「配置权限」弹出弹窗：里面是该账号的品牌勾选框 + 「保存权限」',
    permUI.opened && permUI.boxes >= 2 && permUI.hasSave, JSON.stringify(permUI));
  ok('⑦d2 弹窗里保存**真的写进 auth.json**（不是只改界面）',
    permUI.after > permUI.before && permUI.after === permUI.boxes,
    `${permUI.before} → ${permUI.after} 个品牌（弹窗里 ${permUI.boxes} 个框）`);
  ok('⑦d2 保存成功后弹窗自动收起', permUI.closedAfterSave === true, 'hidden=' + permUI.closedAfterSave);

  // ---- ⑦d3 「重置密码」也走弹窗：空口令不许提交；填了就**真换**（新口令能登、旧口令被拒）----
  // ★ 为什么非要真登一次：这个弹窗看着「点了有反应」，但完全可能只在界面上把框关掉、
  //   口令一个字节都没动。口令这种事没有第二种验收方式 —— 只有「拿新口令能进、拿旧口令进不去」算数。
  // ★ 用一次性账号 pwdprobe，不碰 member1（下面 ⑦e 还要用 Member@456 登他）。
  const pwdUI = await js(`(async () => {
    const tr = [...document.querySelectorAll('#pane tbody tr')].find(x => x.textContent.includes('pwdprobe'));
    const btn = tr ? tr.querySelector('[data-act="up:pwd"]') : null;
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 220));
    const mask = document.getElementById('umodal');
    const opened = !!mask && !mask.hidden;
    const inp = document.getElementById('upPwd');
    const go = document.querySelector('#umBox [data-act="up:pwdSave"]');
    const hasBtns = !!inp && !!go;
    // ① 空口令点「确认重置」→ 不许提交，弹窗也不许关
    if (go) go.click();
    await new Promise(r => setTimeout(r, 250));
    const emptyBlocked = !!mask && !mask.hidden;
    // ② 填新口令 → 确认
    if (inp) inp.value = 'Probe@9999';
    if (go) go.click();
    await new Promise(r => setTimeout(r, 800));
    const closed = !!mask && mask.hidden;
    // ③ 只有主进程那条通道能证明「口令真换了」：新口令能登、旧口令被拒
    //    （登录会把会话换成这个人 —— 所以这一组跑完必须切回管理员）
    const newOk = await window.api.authLogin('pwdprobe', 'Probe@9999', false);
    const oldBad = await window.api.authLogin('pwdprobe', 'Probe@1234', false);
    return { opened, hasBtns, emptyBlocked, closed,
             newOk: newOk.ok === true, oldOk: oldBad.ok === true, oldErr: oldBad.error || '' };
  })()`);
  ok('⑦d3 点行内「重置密码」弹出弹窗（新密码输入框 + 「确认重置」都在）',
    pwdUI.opened && pwdUI.hasBtns, JSON.stringify(pwdUI));
  ok('⑦d3 空口令点「确认重置」不许提交（弹窗不关，得先填新口令）',
    pwdUI.emptyBlocked === true, 'emptyBlocked=' + pwdUI.emptyBlocked);
  ok('⑦d3 填好新口令确认后弹窗自动收起', pwdUI.closed === true, 'closed=' + pwdUI.closed);
  ok('⑦d3 新口令**真的生效**（用 Probe@9999 能登、用初始的 Probe@1234 被拒 —— 不是只把弹窗关了）',
    pwdUI.newOk === true && pwdUI.oldOk === false,
    JSON.stringify({ 新口令能登: pwdUI.newOk, 旧口令能登: pwdUI.oldOk, 旧口令报错: pwdUI.oldErr }));

  // 上一步验口令时把会话换成了 pwdprobe ⇒ 立刻切回管理员（下面 ⑦e 要用管理员 / 成员会话）
  const backAdminPwd = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  ok('⑦d3 切回管理员（上面为了验口令登过 pwdprobe）', backAdminPwd.locked === false, backAdminPwd.err || '');

  // ---- ⑦e 文案提示词：成员能改自己品牌的，改不了别人的；品牌名 / 启停仍归管理员 ----
  // 提示词是「写文案的人」天天要调的东西，全锁给管理员不现实；
  // 但松开的必须**只有那两个字段**，否则等于把整个注册表开放了
  // 这个品牌**故意也配一段提示词**：否则「成员看不到别人的提示词」这条断言
  // 会因为两边都是空串而假通过（空 == 空）
  const bOther = await js(`window.api.brandAdd({ name: '别人的品牌', promptWrite: '别人家的模板，成员不该看到' })`);
  const otherId = bOther.brand.id;

  // ⑦b 里成员被停用过，这里先启用（不然他连登录都进不来）
  await js(`window.api.authUpdateUser(${JSON.stringify(memberId)}, { disabled: false, brands: [${JSON.stringify(brandId)}] })`);
  const privacyAdmin = auth.current();
  logbus.info('PRIVACY-ADMIN-HISTORY');
  require(path.join(ROOT, 'src/main/services/runlog.js')).append({ kind: 'log', userId: privacyAdmin.id,
    brandId, brandName: '品牌甲 2026', level: 'info', msg: 'PRIVACY-ADMIN-AUDIT' });
  const memberIn = await js(`__t.login(${JSON.stringify(MEMBER)}, 'Member@456', false)`);
  ok('⑦e 成员重新启用后能登录（下面用成员会话测提示词权限）', memberIn.locked === false, memberIn.err || '');

  logbus.info('PRIVACY-MEMBER-OWN');
  await logbus.withActor(privacyAdmin, async () => {
    await new Promise(r => setTimeout(r, 40));
    logbus.info('PRIVACY-ADMIN-LATE');
  });
  await new Promise(r => setTimeout(r, 120));
  const privacy = await js(`(async () => {
    const history = await window.api.logHistory();
    const stats = await window.api.statsQuery({ days: 0, includeRunLogs: true, scopeIds: null });
    state.stats = stats; state.tab = 8; renderAll();
    return { history, live: state.logs, stats,
      auditUi: /执行日志/.test(document.querySelector('#pane').textContent),
      exportUi: !!document.querySelector('[data-act="stats:exportLog"]'),
      exportDenied: await window.api.statsExportLog({ days: 0 }) };
  })()`);
  ok('同品牌成员拿不到管理员的历史执行日志，伪造权限参数也无效',
    privacy.stats.ok && privacy.stats.logs.length === 0 && privacy.stats.logsTotal === 0 && privacy.stats.sources.runLog === null);
  ok('成员的品牌统计不显示执行日志及导出入口，后台也拒绝单独导出',
    !privacy.auditUi && !privacy.exportUi && privacy.exportDenied.ok === false);
  ok('成员实时推送与历史查询只包含本人日志，管理员异步任务不会串入',
    [privacy.history, privacy.live].every(es => es.some(e => e.msg === 'PRIVACY-MEMBER-OWN')
      && !es.some(e => /^PRIVACY-ADMIN/.test(e.msg))));
  const privacyOutput = store.get('paths.output');
  store.set({ paths: { output: path.join(TMP, 'privacy-export') } });
  const forgedExport = await js(`window.api.logExport({ entries: [{t:1, level:'info',msg:'PRIVACY-ADMIN-FORGED',meta:{}}], bufferTotal:999, filter:{q:'PRIVACY-'} })`);
  const privateText = forgedExport.ok ? fs.readFileSync(forgedExport.file, 'utf8') : '';
  ok('运行日志导出由主进程筛选，不能夹带其他账号记录',
    forgedExport.ok && privateText.includes('PRIVACY-MEMBER-OWN') && !privateText.includes('PRIVACY-ADMIN'));
  const privateBook = await js(`window.api.statsExport({ days:0, includeRunLogs:true })`);
  const privacyWorkbook = new (require('exceljs').Workbook)();
  await privacyWorkbook.xlsx.readFile(privateBook.file);
  ok('成员导出的品牌统计工作簿不包含历史执行台账', !privacyWorkbook.getWorksheet('执行日志'));
  store.set({ paths: { output: privacyOutput } });

  const mList = await js(`window.api.brandList()`);
  const mineRow = (mList.brands || []).find(b => b.id === brandId);
  const otherRow = (mList.brands || []).find(b => b.id === otherId);
  ok('⑦e 成员只能读取自己品牌，其他品牌不会下发',
    mList.ok === true && mList.isAdmin === false && !!mineRow && !otherRow,
    JSON.stringify({ 自己: !!mineRow, 别人的: (otherRow || {}).promptWrite }));

  const mSave = await js(`window.api.brandPrompts(${JSON.stringify(brandId)}, { promptWrite: '成员自己写的模板' })`);
  ok('⑦e 成员能改自己品牌的提示词（写文案的是运营，不该每次都去找管理员）', mSave.ok === true, mSave.error || '');

  const mSteal = await js(`window.api.brandPrompts(${JSON.stringify(otherId)}, { promptWrite: '我要改别人的' })`);
  ok('⑦e 成员改不了别人品牌的提示词', mSteal.ok === false && /没有/.test(mSteal.error), mSteal.error);

  const mRename = await js(`window.api.brandUpdate(${JSON.stringify(brandId)}, { name: '成员偷改的名' })`);
  ok('⑦e 成员不能借提示词的口子改名（brand:update 仍是管理员专属）',
    mRename.ok === false && /只有管理员/.test(mRename.error), mRename.error);

  // 弹窗：点「提示词配置」→ 列出品牌 → 点进去是「品牌名 + 两段文案 + 两个勾选」
  const modal = await js(`(async () => {
    document.querySelector('.nav[data-tab="3"]').click();
    await new Promise(r => setTimeout(r, 120));
    const btn = document.querySelector('[data-act="copy:prompt"]');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 160));
    const mask = document.getElementById('bmodal');
    const opened = !!mask && !mask.hidden;
    const rows = document.querySelectorAll('#bmBox .brow').length;
    const first = document.querySelector('#bmBox .brow [data-act="bm:open"]');
    if (first) first.click();
    await new Promise(r => setTimeout(r, 160));
    const nm = document.getElementById('bmName');
    return {
      opened, rows,
      name: !!nm, write: !!document.getElementById('bmWrite'),
      enabled: !!document.getElementById('bmEnabled'), pick: !!document.getElementById('bmPick'),
      nameReadOnly: !!nm && nm.readOnly,
      text: (document.getElementById('bmBox') || {}).textContent ? document.getElementById('bmBox').textContent.slice(0, 26) : ''
    };
  })()`);
  ok('⑦e 弹窗打开后每个品牌一行', modal.opened && modal.rows >= 1, JSON.stringify(modal));
  ok('⑦e 点品牌进编辑视图：品牌名 + 文案提示词 + 两个勾选都在',
    modal.name && modal.write && modal.enabled && modal.pick, JSON.stringify(modal));
  ok('⑦e 成员看到的品牌名是只读的（改名归管理员）', modal.nameReadOnly === true, JSON.stringify(modal));
  await js(`(async () => {
    const m = document.getElementById('bmodal');
    if (m && !m.hidden) { const c = document.querySelector('[data-act="bm:close"]'); if (c) c.click(); }
    return true;
  })()`);

  // 切回管理员续跑后面的用例
  const backAdmin2 = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  ok('⑦e 切回管理员（后面几条要管理员会话）', backAdmin2.locked === false, backAdmin2.err || '');
  const adminSee = (await js(`window.api.brandList()`)).brands.find(b => b.id === brandId);
  ok('⑦e 成员写的那段模板真的落到注册表上了（不是只在返回值里改了一下）',
    !!adminSee && adminSee.promptWrite === '成员自己写的模板', JSON.stringify(adminSee && adminSee.promptWrite));

  // 全部已登录账号可检查更新；无新构建时不允许下载或安装。
  const updateActions = async () => js(`(async () => {
    const status = await window.api.updateStatus(), check = await window.api.updateCheck();
    const download = await window.api.updateDownload(), install = await window.api.updateInstall();
    return status.ok && check.ok && check.status === 'current' && !download.ok && !install.ok;
  })()`);
  ok('管理员可以检查更新，无新版本不能下载或安装', await updateActions());
  const adminSettings = await js(`(() => { document.querySelector('.nav[data-tab="13"]').click();
    return !!document.querySelector('#versionUpdate [data-act="update:check"]'); })()`);
  ok('管理员更新日志页提供更新入口', adminSettings);
  const backMember = await js(`__t.login(${JSON.stringify(MEMBER)}, 'Member@456', false)`);
  ok('切换普通成员登录成功', backMember.locked === false);
  ok('普通成员也可以检查更新，无新版本不能安装', await updateActions());
  const customPrompt = await js(`window.api.promptSave('', { name: '成员自定义品牌', promptWrite: '成员独立提示词' })`);
  ok('普通成员可以新增自定义品牌提示词', customPrompt.ok && customPrompt.brand.name === '成员自定义品牌');
  ok('自定义提示词不改变云端品牌权限', !(await js('window.api.brandList()')).brands.some(b => b.id === customPrompt.brand.id));

  const backAdmin3 = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  ok('⑦f 切回管理员（后面几条要管理员会话）', backAdmin3.locked === false, backAdmin3.err || '');

  const bDel = await js(`window.api.brandRemove(${JSON.stringify(brandId)})`);
  ok('删品牌会连带清掉账号上的授权（不留悬空引用）', bDel.ok === true && bDel.usersCleaned === 1, JSON.stringify(bDel));
  const afterDel = await js(`window.api.authUsers()`);
  ok('删除后成员名下确实空了', afterDel.users.find(u => u.username === MEMBER).brands.length === 0,
    JSON.stringify(afterDel.users.find(u => u.username === MEMBER).brands));

  // 历史记录里没有品牌的那些，统计必须单列成「未标品牌」而不是并进某个品牌
  const st = await js(`window.api.statsQuery({ days: 0 })`);
  ok('统计里「未标品牌」是独立的一桶（不是某个品牌的 0）',
    st.ok === true && !!st.untagged && st.untagged.id === '' && st.untagged.rows === 0,
    `untagged=${st.untagged && st.untagged.rows} 品牌数=${(st.brands || []).length}`);
  ok('统计里「只看未标品牌」筛选可用',
    (await js(`window.api.statsQuery({ days: 0, brandId: '__none__' })`)).brands.length === 0);

  // ---- ⑧-0 会话失效（guard 返回拒绝对象）时：回登录门并说明原因，**不许白屏** ----
  // 根因：主进程 guard() 拒绝时**返回 `{ok:false,error}` 而不是抛异常**，而 config:get / project:get
  //   都走 guard ⇒ 渲染层 `state.config = await appApi.configGet()` 这句裸赋值会把**拒绝对象当成配置**
  //   存下来（pub:useDev / pub:useFound 里改设备时真会走到）。各页渲染又直接读深层字段
  //   （`project.compliance.stats` / `config.copy.rotateStrategy`），读一层就抛 ⇒
  //   表现是**整页白屏、一句话都不给**。这条用例就是那次真实顺序：掉线 → 切到「合规检查」。
  // ★ 正向对照在同一段里做（会话还在时必须照常渲染、不许误弹登录门），否则「弹了登录门」可能只是恒真。
  const denyCase = await js(`(async () => {
    const before = { p: state.project, c: state.config, t: state.tab };
    // ① 正向对照：会话还在，同样切到「合规检查」——必须照常渲染、不许锁屏
    let ctrlThrew = '';
    state.tab = 2;
    try { renderAll(); } catch (e) { ctrlThrew = (e && e.message) || String(e); }
    const ctrlLocked = document.body.classList.contains('locked');
    // ② 真的把主进程侧会话退掉 ⇒ 再读 project / config 拿到的就是 guard 的拒绝对象
    await window.api.authLogout();
    const p = await window.api.projectGet();
    const c = await window.api.configGet();
    state.project = p; state.config = c;     // 模拟 pub:useDev / pub:useFound 里那句裸赋值
    state.tab = 2;
    let threw = '';
    try { renderAll(); } catch (e) { threw = (e && e.message) || String(e); }
    const res = {
      ctrlThrew, ctrlLocked,
      pDenied: !!(p && p.ok === false), cDenied: !!(c && c.ok === false),
      threw,
      locked: document.body.classList.contains('locked'),
      gateShown: getComputedStyle(document.getElementById('gate')).display !== 'none',
      err: (document.getElementById('lgErr') || {}).textContent || ''
    };
    // 还原（后面 ⑧⑨ 还要用）：值放回去；登录态交给下面的 ⑧ 用例处理
    state.project = before.p; state.config = before.c; state.tab = before.t;
    return res;
  })()`);
  ok('⑧-0 正向对照：会话还在时切到「合规检查」照常渲染、不锁屏（证明下面那条不是恒真）',
    denyCase.ctrlThrew === '' && denyCase.ctrlLocked === false,
    `threw=${denyCase.ctrlThrew || '无'} locked=${denyCase.ctrlLocked}`);
  ok('⑧-0 前提成立：退掉会话后，主进程确实回的是拒绝对象（不是我以为的「应该会拒」）',
    denyCase.pDenied === true && denyCase.cDenied === true,
    JSON.stringify({ p: denyCase.pDenied, c: denyCase.cDenied }));
  ok('⑧-0 ★★ 拿着拒绝对象切页**不许抛异常**（原来这里直接 Cannot read properties of undefined）',
    denyCase.threw === '', denyCase.threw || '无异常');
  ok('⑧-0 ★★ 掉线时回登录门（而不是把业务界面留成一片空白）',
    denyCase.locked === true && denyCase.gateShown === true,
    JSON.stringify({ locked: denyCase.locked, gateShown: denyCase.gateShown }));
  ok('⑧-0 ★ 登录页上把原因写出来（用户得知道是"掉线了"，不是"这页坏了"）',
    /未登录|过期/.test(denyCase.err || ''), denyCase.err);

  // ---- ⑧ 退出登录 → 回到登录门，业务通道再次被拦 ----
  const out = await js(`__t.logout()`);
  ok('退出登录回到登录门', out.locked && out.gateShown && out.appHidden, JSON.stringify(out));
  ok('退出后登录按钮有文字、可点击，独立加载页隐藏', await js(`!document.getElementById('lgGo').disabled && document.getElementById('lgGo').textContent === '登 录' && document.getElementById('gateLoading').hidden && !document.getElementById('loginForm').hidden`));
  const blockedAgain = await js(`(async () => (await window.api.run('copy.generate', {})).error)()`);
  ok('退出后业务通道重新被拦', /未登录|过期/.test(blockedAgain || ''), blockedAgain);

  // 复现用户截图：返回登录页时遗留禁用状态和按钮里的旧波形。
  const recoveredButton = await js(`(() => {
    const b = document.getElementById('lgGo');
    b.disabled = true; b.innerHTML = '<span class="gate-wave">旧加载动画</span>';
    showGate('已退出登录');
    return !b.disabled && b.textContent === '登 录' && b.getAttribute('aria-busy') === 'false'
      && document.getElementById('gateLoading').hidden && !document.getElementById('loginForm').hidden;
  })()`);
  ok('复现旧波形残留后回到登录页，强制恢复真实可点击登录按钮', recoveredButton);

  // 登录后首页读取失败也必须恢复表单，不留下一个禁用的假按钮。
  ipcMain.removeHandler('config:get');
  ipcMain.handle('config:get', () => ({ ok: false, error: '模拟首页加载失败' }));
  const failedHome = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  ok('首页加载失败返回登录表单并显示原因', failedHome.locked && /模拟首页加载失败/.test(failedHome.err));
  ok('首页加载失败后登录按钮仍有文字且能重新点击', await js(`!document.getElementById('lgGo').disabled && document.getElementById('lgGo').textContent === '登 录' && document.getElementById('gateLoading').hidden && !document.getElementById('loginForm').hidden`));
  ipcMain.removeHandler('config:get');
  let repeatDelay = 0;
  ipcMain.handle('config:get', async (_e, key) => {
    if (repeatDelay) await new Promise(resolve => setTimeout(resolve, repeatDelay));
    if (auth.enabled() && !auth.current()) return { ok: false, error: '未登录或登录已过期，请重新登录' };
    return store.get(key);
  });
  for (let cycle = 1; cycle <= 3; cycle++) {
    repeatDelay = cycle === 2 ? 1200 : 0;
    const clicked = await js(`(async () => {
      document.getElementById('lgUser').value = ${JSON.stringify(ADMIN)};
      document.getElementById('lgPwd').value = ${JSON.stringify(PASS)};
      const button = document.getElementById('lgGo');
      const clickable = !button.disabled && button.textContent === '登 录' && button.getBoundingClientRect().height > 0;
      button.click();
      for (let i = 0; i < 60 && document.body.classList.contains('locked'); i++) await new Promise(r => setTimeout(r, 50));
      return clickable && !document.body.classList.contains('locked') && document.getElementById('gate').hidden;
    })()`);
    ok('真实点击登录按钮后成功进入主界面，第 ' + cycle + ' 轮' + (repeatDelay ? '（慢加载）' : ''), clicked);
    const again = await js(`(async () => {
      await doLogout();
      return document.body.classList.contains('locked') && !document.getElementById('loginForm').hidden
        && document.getElementById('gateLoading').hidden && !document.getElementById('lgGo').disabled
        && document.getElementById('lgGo').textContent === '登 录';
    })()`);
    ok('退出后按钮恢复且加载页隐藏，第 ' + cycle + ' 轮', again);
  }
  repeatDelay = 0;

  // ---- ⑨ 防爆破：连错到上限后锁定，锁定期间口令正确也进不去 ----
  let lockMsg = '', attempts = 0;
  for (let i = 0; i < 9 && !/失败次数过多/.test(lockMsg); i++) {
    attempts++;
    lockMsg = (await js(`__t.login(${JSON.stringify(ADMIN)}, 'wrong-' + ${i}, false)`)).err;
  }
  ok('连错到上限后锁定并说清还要等多久', /失败次数过多/.test(lockMsg), `第 ${attempts} 次：${lockMsg}`);
  const stillLocked = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, false)`);
  ok('锁定期间口令正确也进不去（拦截在主进程，不靠前端）', stillLocked.locked === true && /失败次数过多/.test(stillLocked.err), stillLocked.err);

  ok('登录页/主界面零控制台报错', errors.length === 0, errors.join(' | ') || '无');

  console.log('\nuserData(临时): ' + TMP);
  app.exit(errors.length ? 1 : 0);
}).catch(e => {
  console.error('LOGIN TEST ERROR', e);
  app.exit(1);
});
