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

   用法：npx electron tools/logintest.js
   注意：userData 指到临时目录，不会动你本机的 auth.json / config.json / project.json。
*/
const { app, BrowserWindow } = require('electron');
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
      tip: () => (document.getElementById('lgTip') || {}).textContent || '',
      user: () => (document.getElementById('chipUser') || {}).textContent || '',
      title: () => (document.querySelector('#head h2') || {}).textContent || '',
      login: async (u, p, rem) => {
        document.getElementById('lgUser').value = u;
        document.getElementById('lgPwd').value = p;
        document.getElementById('lgRem').checked = !!rem;
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 900));
        return { locked: window.__t.locked(), err: window.__t.err(), user: window.__t.user(), title: window.__t.title() };
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
  const boot = await js(`({ locked: __t.locked(), appHidden: __t.appHidden(), gateShown: __t.gateShown(), tip: __t.tip(), err: __t.err() })`);
  ok('未登录时停在登录门（业务界面整块隐藏）', boot.locked && boot.appHidden && boot.gateShown,
    JSON.stringify({ locked: boot.locked, appHidden: boot.appHidden, gateShown: boot.gateShown }));
  ok('登录页提示了出厂账号（拿到包的人不用猜）', /admin/.test(boot.tip) && /BlueV@2026/.test(boot.tip), boot.tip.trim().slice(0, 80));

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

  // ---- ③ 错口令 / 不存在的账号：明确报错、不放进去，且不泄露账号是否存在 ----
  const wrong = await js(`__t.login(${JSON.stringify(ADMIN)}, 'definitely-wrong', false)`);
  ok('口令错 → 明确报错且仍在登录页', wrong.locked && /账号或密码不正确/.test(wrong.err), wrong.err);
  const noUser = await js(`__t.login('no-such-user', 'whatever', false)`);
  ok('账号不存在 → 提示与口令错一致（不泄露账号是否存在）', noUser.locked && noUser.err === wrong.err, noUser.err);

  // ---- ④ 正确口令 + 记住登录 → 进主界面 ----
  const inApp = await js(`__t.login(${JSON.stringify(ADMIN)}, ${JSON.stringify(PASS)}, true)`);
  ok('口令正确 → 进入主界面', !inApp.locked && inApp.title === '素材整理', `locked=${inApp.locked} 标题=${inApp.title}`);
  ok('标题栏显示当前账号与角色', /管理员/.test(inApp.user), inApp.user);
  const allowed = await js(`(async () => { const c = await window.api.configGet(); return !!(c && c.paths && c.paths.output); })()`);
  ok('登录后业务通道放行（能读到配置）', allowed === true);
  const tabs = await js(`(async () => {
    const titles = [];
    for (let i = 1; i <= 7; i++) {
      document.querySelector('.nav[data-tab="' + i + '"]').click();
      await new Promise(r => setTimeout(r, 90));
      titles.push(__t.title());
    }
    return titles;
  })()`);
  ok('登录后 7 个页签都能渲染', tabs.length === 7 && tabs.every(t => t && t.length > 1), tabs.join(' / '));

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

  // ---- ⑧ 退出登录 → 回到登录门，业务通道再次被拦 ----
  const out = await js(`__t.logout()`);
  ok('退出登录回到登录门', out.locked && out.gateShown && out.appHidden, JSON.stringify(out));
  const blockedAgain = await js(`(async () => (await window.api.run('copy.generate', {})).error)()`);
  ok('退出后业务通道重新被拦', /未登录|过期/.test(blockedAgain || ''), blockedAgain);

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
