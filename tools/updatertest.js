'use strict';
/*
 * 自动更新状态机回归（纯 Node，不需要打包、不需要联网、不需要桌面会话）。
 *
 * 为什么单独一套：这条链横跨「主进程状态机 → ipc → 渲染层三个状态」，
 * smoke 碰不到它，uicheck 只能看见界面有没有画出来，抓不到
 * 「事件来了状态没变」和「偷偷自动重启」这两类。
 *
 * ★ 本套最要紧的两条断言（改 updater.js 时别把它们删了）：
 *   ① update-downloaded 之后 **autoUpdater.quitAndInstall 一次都不能被调用** ——
 *      这个工具随时可能在跑批量发布，静默重启会把任务掐断且没有回滚。
 *   ② autoDownload / autoInstallOnAppQuit 两个开关必须是 false。
 *
 * 用法：node tools/updatertest.js
 */
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const upd = require(path.join(ROOT, 'src/main/updater.js'));

let bad = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) bad++;
};

/** 假 autoUpdater：只保留 updater.js 真正用到的那几个成员 */
function fakeUpdater() {
  const f = new EventEmitter();
  f.calls = { check: 0, download: 0, install: 0, installArgs: null };
  f.autoDownload = true;            // 故意给错值，验 updater 会把它压成 false
  f.autoInstallOnAppQuit = true;    // 同上
  f.checkForUpdates = () => { f.calls.check++; f.emit('checking-for-update'); return Promise.resolve(null); };
  f.downloadUpdate = () => { f.calls.download++; return Promise.resolve(null); };
  f.quitAndInstall = (...a) => { f.calls.install++; f.calls.installArgs = a; };
  return f;
}

const sent = [];
const send = (ch, payload) => sent.push({ ch, payload });
const initBase = extra => Object.assign({ send, packaged: true, version: '1.0.0', setTimer: () => {} }, extra || {});

(async () => {
  /* ---------- A. 开发模式（没打包）：如实说不可用，不是报错 ---- */
  let f = fakeUpdater();
  upd._reset();
  upd._setUpdater(f);
  let st = upd.init(initBase({ packaged: false }));
  ok('未打包：supported=false（不假装能更新）', st.supported === false);
  ok('未打包：说明里点明「开发模式」', /开发模式/.test(st.message), st.message);
  let r = await upd.check({ manual: true });
  ok('未打包：check 明确返回失败并给出原因', r.ok === false && !!r.error, r.error);
  ok('未打包：排定时自检也排不上', upd.scheduleStartupCheck() === false);

  /* ---------- B. 便携版：不支持自动更新，不能装死 ---- */
  f = fakeUpdater();
  upd._reset();
  upd._setUpdater(f);
  process.env.PORTABLE_EXECUTABLE_FILE = 'D:/tmp/portable.exe';
  st = upd.init(initBase());
  ok('便携版：supported=false', st.supported === false);
  ok('便携版：说明里点明「便携版」并给出替代动作', /便携版/.test(st.message) && /安装版/.test(st.message), st.message);
  delete process.env.PORTABLE_EXECUTABLE_FILE;

  /* ---------- C. 正常启动 ---- */
  f = fakeUpdater();
  upd._reset();
  upd._setUpdater(f);
  st = upd.init(initBase());
  ok('安装版：supported=true，状态 idle，带出当前版本', st.supported === true && st.status === 'idle' && st.current === '1.0.0');
  ok('★ autoDownload 被压成 false（不许自己偷偷下 88MB）', f.autoDownload === false);
  ok('★ autoInstallOnAppQuit 被压成 false（退出时也不许偷偷装）', f.autoInstallOnAppQuit === false);
  ok('延迟自检：第一次排上', upd.scheduleStartupCheck() === true);
  ok('延迟自检：只排一次（不是定时轮询）', upd.scheduleStartupCheck() === false);

  /* ---------- D. 状态机：检查中 → 有新版本 → 下载中 → 可安装 ---- */
  sent.length = 0;
  r = await upd.check({ manual: true });
  ok('手动检查：返回 ok 且真的调了 checkForUpdates', r.ok === true && f.calls.check === 1);
  st = upd.status();
  ok('状态：checking（「检查中」这一态界面要显示出来）', st.status === 'checking', st.status);
  ok('检查来源标记：手动检查 manual=true（启动自检是 false）', st.manual === true);
  ok('广播：状态变化都推了 update:changed', sent.length > 0 && sent.every(s => s.ch === 'update:changed'), sent.map(s => s.ch).join(','));
  const atChecking = sent[sent.length - 1].payload;

  f.emit('update-available', { version: '1.0.1' });
  st = upd.status();
  ok('状态：available 且带出新版本号', st.status === 'available' && st.latest === '1.0.1', JSON.stringify({ s: st.status, l: st.latest }));
  // 这条拦的是「把 state 本体直接推给界面」——那样后面的状态变化会把已经推出去的对象一起改掉，
  // 界面拿到的历史事件全部变成「当前值」，排查问题时看到的全是假象
  ok('广播：推的是**当时的快照**，后续状态变化不会把已推出去的对象一起改掉',
     atChecking.status === 'checking' && atChecking.latest === '', JSON.stringify(atChecking));
  ok('★ 发现新版本后**没有**自动开始下载', f.calls.download === 0);

  f.emit('download-progress', { percent: 42.6, transferred: 1000, total: 2000, bytesPerSecond: 500 });
  st = upd.status();
  ok('状态：downloading 且百分比被夹进 0..100',
     st.status === 'downloading' && st.percent === 42.6 && st.total === 2000, JSON.stringify({ p: st.percent }));
  f.emit('download-progress', { percent: 999 });
  ok('状态：异常百分比（999）会被夹到 100', upd.status().percent === 100, upd.status().percent);

  f.emit('update-downloaded', { version: '1.0.1' });
  st = upd.status();
  ok('状态：ready 且进度归 100', st.status === 'ready' && st.percent === 100, JSON.stringify({ s: st.status, p: st.percent }));
  ok('★★ 下载完**绝不自动重启**：quitAndInstall 一次都没被调用', f.calls.install === 0, '调用次数 ' + f.calls.install);

  /* ---------- E. 只有用户点「立即安装」才装 ---- */
  r = await upd.install();
  ok('安装：用户点了才真的调 quitAndInstall', r.ok === true && f.calls.install === 1);
  ok('安装：参数是 (false, true) —— 静默安装 + 装完重启，不弹向导',
     JSON.stringify(f.calls.installArgs) === '[false,true]', JSON.stringify(f.calls.installArgs));

  /* ---------- F. 已是最新 / 出错 ---- */
  f = fakeUpdater();
  upd._reset();
  upd._setUpdater(f);
  upd.init(initBase());
  f.emit('update-not-available', { version: '1.0.0' });
  st = upd.status();
  ok('状态：uptodate', st.status === 'uptodate', st.status);
  ok('uptodate 时安装按钮该是禁用的（没有可装的包）', (await upd.install()).ok === false);

  f.emit('error', new Error('ENOTFOUND release.example.com'));
  st = upd.status();
  ok('状态：error 且把原始错误带出来（不许吞成「未知错误」）',
     st.status === 'error' && /ENOTFOUND/.test(st.message), st.message);

  /* ---------- G. 重复点击 / 下载中不许再查 ---- */
  f = fakeUpdater();
  upd._reset();
  upd._setUpdater(f);
  upd.init(initBase());
  let slow = null;
  f.checkForUpdates = () => { f.calls.check++; f.emit('checking-for-update'); return new Promise(res => { slow = res; }); };
  const p1 = upd.check({ manual: true });
  const p2 = await upd.check({ manual: true });
  ok('连点两次「检查更新」：第二次被挡住并说明原因', p2.ok === false && /正在检查/.test(p2.error), p2.error);
  if (slow) slow();
  await p1;
  // 光看 status 是验不出来的（它会一直停在 checking）。要看的是**闸门有没有复位**：
  // 复位了才谈得上「再查一次」，没复位界面就永远卡在「检查中」，用户只剩重启应用一条路
  f.checkForUpdates = () => { f.calls.check++; return Promise.resolve(null); };
  const p3 = await upd.check({ manual: true });
  ok('第一次检查结束后闸门复位，还能再查一次（不会卡死在「检查中」）', p3.ok === true, JSON.stringify(p3));

  console.log('\n以上断言全部通过时，说明「下载完不自动重启」这条底线是活的。');
  console.log(bad ? ('有 ' + bad + ' 项未通过') : '全部通过');
  process.exit(bad ? 1 : 0);
})().catch(e => {
  console.error('UPDATER TEST ERROR', e);
  process.exit(1);
});
