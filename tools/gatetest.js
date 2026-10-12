/* 登录门「窗口尺寸」回归：未登录时窗口必须收缩成刚好装下登录卡片的小窗，
   登录成功后还原成正常尺寸，退出登录再收缩；且登录门期间的临时尺寸不许写进 config.json。

   为什么单独一套：这条链横跨 渲染层量卡片高度 → preload → ipc → main 改窗口，
   uicheck 只验界面、logintest 只验账号逻辑，两边都盖不到「窗口尺寸」。
   曾经的真坑：开场就以小窗启动时没记住「正常几何」，登录成功后窗口会一直卡在 380 宽。

   用法：npx electron tools/gatetest.js     （tools/run-all.js 里就是这么调的）
   注意：userData 会被指到临时目录，不会动你本机的 auth.json / config.json / project.json。
*/
const { app, screen } = require('electron');
require('./test-runtime')({ app });
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-gate-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('disable-gpu');

const GATE_MAX_W = 344;     // 登录小窗的宽度上限（现在窗口＝卡片 340，只留渲染取整的余量）
const PAD_Y = 0;            // 与 src/main/window.js 的 GATE_PAD_Y 保持一致（窗口＝卡片，不留呼吸位）

let bad = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) bad++;
};
const geoSig = b => b.width + 'x' + b.height;

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src/main/store.js'));
  const project = require(path.join(ROOT, 'src/main/project.js'));
  const auth = require(path.join(ROOT, 'src/main/auth.js'));
  const ipc = require(path.join(ROOT, 'src/main/ipc.js'));
  const winmod = require(path.join(ROOT, 'src/main/window.js'));

  store.load();
  project.load();
  auth.load();      // 全新数据目录 ⇒ 用出厂账号建库（admin / BlueV@2026）
  ipc.register();

  const USER = auth.DEFAULT_USER;
  const PASS = auth.DEFAULT_PASS;

  const w = winmod.createWindow(true);            // true = 以登录门开场
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1500));    // 等渲染层量高 + fitGate 回调走完

  const js = s => w.webContents.executeJavaScript(s);
  const cardH = () => js('Math.round(document.querySelector(".gate .gcard").getBoundingClientRect().height)');
  const isLocked = () => js('document.body.classList.contains("locked")');
  const gateDisplay = () => js('getComputedStyle(document.querySelector("#gate")).display');

  let g = w.getBounds();
  let ch = await cardH();
  ok('未登录：窗口是紧凑小窗，不再是大窗', g.width <= GATE_MAX_W, geoSig(g));
  ok('未登录：窗口高 = 卡片高 + 上下呼吸位', Math.abs(g.height - (ch + PAD_Y * 2)) <= 3, '窗' + g.height + ' / 卡' + ch);
  ok('未登录：业务界面整块隐藏、登录门显示', (await isLocked()) === true && (await gateDisplay()) !== 'none');
  ok('未登录：窗口禁止拉伸 / 禁止最大化', w.isResizable() === false && w.isMaximizable() === false);

  // 用户报过：卡片外挂了一条独立标题带（左上角标题 + 右上角 ×），卡片本身又有边框，
  // 于是那两个东西醒目地浮在边框外面 —— 观感就是「没在框内」。
  // 现在关闭口缩进卡片右上角，拖拽区改用整块遮罩，卡片外不再有任何东西。
  const gx = await js(`(() => {
    const b = document.querySelector('#gateClose'), c = document.querySelector('.gate .gcard');
    if (!b || !c) return null;
    const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
    return { l: Math.round(br.left - cr.left), t: Math.round(br.top - cr.top),
             r: Math.round(cr.right - br.right), b: Math.round(cr.bottom - br.bottom),
             w: Math.round(br.width), h: Math.round(br.height) };
  })()`);
  ok('登录页：关闭按钮缩在卡片右上角、四边都落在边框内',
     !!gx && gx.l > 0 && gx.t > 0 && gx.r > 0 && gx.b > 0 && gx.w >= 20 && gx.h >= 20,
     JSON.stringify(gx));

  // 更狠的一条：登录门里任何「可见」元素都不许越过卡片边框（零尺寸的报错行/提示行不算）。
  // 拦住的是「在卡片外又挂了个浮层」这类改法，不管它叫什么名字。
  const outside = await js(`(() => {
    const c = document.querySelector('.gate .gcard');
    if (!c) return { err: 'no card' };
    const cr = c.getBoundingClientRect();
    const out = [];
    for (const el of document.querySelectorAll('#gate *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.left < cr.left - 0.6 || r.right > cr.right + 0.6 ||
          r.top < cr.top - 0.6 || r.bottom > cr.bottom + 0.6) {
        out.push((el.id || el.getAttribute('class') || el.tagName) + ':' +
          [r.left, r.top, r.right, r.bottom].map(n => Math.round(n)).join(','));
      }
    }
    return { out };
  })()`);
  ok('登录页：卡片外没有任何可见元素（标题/× 不许浮在边框外）',
     !!outside && !!outside.out && outside.out.length === 0, JSON.stringify(outside));

  // ★ 2026-10-02 用户第三次反馈「登录框外面还有一块色块」⇒ 窗口必须**恰好等于卡片**：
  //   宽度差超过 2px 就说明卡片左右又露出了底色（那圈底色就是用户说的「色块」）。
  const cardW = await js('Math.round(document.querySelector(".gate .gcard").getBoundingClientRect().width)');
  ok('登录页：窗口宽 = 卡片宽（卡片左右不留边，外面不许露底色）',
     Math.abs(g.width - cardW) <= 2, '窗' + g.width + ' / 卡' + cardW);

  // ★ 「白底白字」回归：卡片里任何**有文字的可见元素**，前景色与它实际铺在的背景色必须能分辨。
  //   之前 .gname 从 body 继承了「深色主题算好的浅字色」，白卡片上就是白字（对比度 1.13）。
  const contrast = await js(`(() => {
    const card = document.querySelector('.gate .gcard');
    if (!card) return { err: 'no card' };
    const rgb = (c) => {
      const i = c.indexOf('(');
      if (i < 0) return null;
      const p = c.slice(i + 1, c.indexOf(')')).split(',').map(s => parseFloat(s));
      if (!p.length || !isFinite(p[0])) return null;
      if (p.length >= 4 && p[3] === 0) return null;      // 全透明 = 这里没背景，继续往上找
      return p;
    };
    const lum = (p) => {
      const f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
    };
    const bgLum = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const p = rgb(getComputedStyle(n).backgroundColor);
        if (p) return lum(p);
        n = n.parentElement;
      }
      return 1;
    };
    const bad = [];
    for (const el of card.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const txt = (el.childNodes.length === 1 && el.firstChild.nodeType === 3) ? el.textContent.trim() : '';
      if (!txt) continue;
      const fp = rgb(getComputedStyle(el).color);
      if (!fp) continue;
      const fg = lum(fp), bg = bgLum(el);
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      if (ratio < 3) bad.push((el.className || el.tagName) + ' ' + txt.slice(0, 14) + ' 对比度 ' + ratio.toFixed(2));
    }
    return { bad };
  })()`);
  ok('登录页：卡片里没有「前景≈背景」的文字（白底白字回归）',
     !!contrast && !!contrast.bad && contrast.bad.length === 0, JSON.stringify(contrast));

  // 走渲染层自己的流程：填表 + 提交（等同于用户敲完点「登录」）
  // 保留一次未执行的量高回调，复现它晚于主窗口恢复的执行顺序。
  await js(`(() => {
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => { window.__lateGateFit = callback; return 0; };
    fitGateWindow();
    window.requestAnimationFrame = original;
  })()`);
  await js(`(() => {
    document.querySelector('#lgUser').value = ${JSON.stringify(USER)};
    document.querySelector('#lgPwd').value = ${JSON.stringify(PASS)};
    document.querySelector('#loginForm').requestSubmit();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 1200));

  g = w.getBounds();
  ok('登录页没有报错（口令被接受）', (await js('document.querySelector("#lgErr").textContent')) === '');
  ok('登录后：窗口还原成正常尺寸', g.width >= 900, geoSig(g));
  ok('登录后：登录门消失、业务界面出来', (await isLocked()) === false && (await gateDisplay()) === 'none');
  ok('登录后：窗口恢复可拉伸 / 可最大化', w.isResizable() === true && w.isMaximizable() === true);
  await js(`(() => {
    // 模拟 ui-ready 已返回、登录遮罩尚未隐藏的瞬间，旧量高回调不能收回主窗口。
    document.querySelector('#gate').hidden = false;
    document.body.classList.add('locked');
    window.__lateGateFit();
    document.querySelector('#gate').hidden = true;
    document.body.classList.remove('locked');
    delete window.__lateGateFit;
  })()`);
  await new Promise(r => setTimeout(r, 100));
  ok('登录前排队的量高回调晚到时不会再次缩小或锁住主窗口',
    w.getBounds().width >= 900 && w.isResizable() && w.isMaximizable(), geoSig(w.getBounds()));
  const savedAfterLogin = store.get('window.bounds') || {};
  ok('登录后：落盘的窗口尺寸不是小窗（下次启动不会变小）', !savedAfterLogin.width || savedAfterLogin.width >= 900, JSON.stringify(savedAfterLogin));

  // 真坑：登录小窗是 win.center() 摆在屏幕正中的，尺寸跳回 1280×820 时位置没跟着走，
  // 窗口右下整块甩出屏幕（1280×784 屏实测超右 450 / 下 258）——观感就是「文字冲出边框」。
  const disp = screen.getDisplayMatching(g).workArea;
  const inside = g.x >= disp.x && g.y >= disp.y &&
                 g.x + g.width <= disp.x + disp.width &&
                 g.y + g.height <= disp.y + disp.height;
  ok('登录后：窗口完整落在屏幕工作区内（右下不会被屏幕切掉）', inside,
     geoSig(g) + ' @' + g.x + ',' + g.y + ' / 工作区 ' + disp.width + 'x' + disp.height);

  // 单元级：把「明显出屏」的几何喂给夹具，必须被夹回来（这条不依赖本机屏幕有多大）
  let clamped = null, clampErr = '';
  try { clamped = winmod.fitToWorkArea({ x: -99999, y: -99999, width: 99999, height: 99999 }); }
  catch (e) { clampErr = e.message; }
  ok('fitToWorkArea：离谱几何必被夹回工作区',
     !!clamped && clamped.x >= disp.x && clamped.y >= disp.y &&
     clamped.width <= disp.width && clamped.height <= disp.height &&
     clamped.x + clamped.width <= disp.x + disp.width &&
     clamped.y + clamped.height <= disp.y + disp.height,
     clampErr || JSON.stringify(clamped));

  // 点标题栏右上角的「退出」
  await js('document.querySelector("#btnLogout").click()');
  await new Promise(r => setTimeout(r, 1200));

  g = w.getBounds();
  ch = await cardH();
  ok('退出登录：窗口重新收缩成小窗', g.width <= GATE_MAX_W, geoSig(g));
  ok('退出登录：高度再次贴合卡片', Math.abs(g.height - (ch + PAD_Y * 2)) <= 3, '窗' + g.height + ' / 卡' + ch);
  ok('退出登录：登录门回来', (await isLocked()) === true);
  const savedAtGate = store.get('window.bounds') || {};
  ok('正式窗口开启渲染进程沙箱且关闭 Node 集成',
    w.webContents.getLastWebPreferences().sandbox === true && w.webContents.getLastWebPreferences().nodeIntegration === false);
  ok('登录门的临时尺寸不写进 config.json', !savedAtGate.width || savedAtGate.width >= 900, JSON.stringify(savedAtGate));

  console.log('\nuserData(临时): ' + TMP);
  console.log(bad ? ('有 ' + bad + ' 项未通过') : '全部通过');
  app.exit(bad ? 1 : 0);
}).catch(e => {
  console.error('GATE TEST ERROR', e);
  app.exit(1);
});
