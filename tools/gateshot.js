/* 登录页「真窗口截图 + 计算色取证」工具（**不参与回归**，手动跑）：
   把「白底白字（前景≈背景）」「卡片外面有色块」这类**只能看**的问题变成可核对的数字。
   用法：  env -u ELECTRON_RUN_AS_NODE npx electron tools/gateshot.js [输出.png]
   输出：① 控制台逐元素列出登录卡内每个可见文字元素的**实际** color / background / 字号；
        ② PNG 截图（默认 D:/work/_gate.png）。
   ★ 不改任何用户数据：userData 指到临时目录。
   ★ 跑之前必须删掉 ELECTRON_RUN_AS_NODE（否则 electron 当 node 跑，秒退 0）。
   配套的**行为断言**在 tools/gatetest.js（窗口宽 = 卡片宽 / 卡片里没有「前景≈背景」的文字）；
   这个脚本是排障用的 —— 改完登录页想看清到底哪个字看不见，跑它一眼就能定位。 */
const { app, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-shot-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');

const OUT = process.argv[2] || 'D:/work/_gate.png';

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src/main/store.js'));
  const project = require(path.join(ROOT, 'src/main/project.js'));
  const auth = require(path.join(ROOT, 'src/main/auth.js'));
  const ipc = require(path.join(ROOT, 'src/main/ipc.js'));
  const winmod = require(path.join(ROOT, 'src/main/window.js'));

  store.load(); project.load(); auth.load(); ipc.register();

  console.log('系统深色模式 =', nativeTheme.shouldUseDarkColors);

  const w = winmod.createWindow(true);   // true = 以登录门开场
  await new Promise(r => w.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 1800));   // 等渲染层量高 + fitGate 回调

  w.show();
  w.focus();
  await new Promise(r => setTimeout(r, 500));

  const js = s => w.webContents.executeJavaScript(s);

  const probe = await js(`(function(){
    var out = {};
    var g = document.querySelector('#gate');
    var card = document.querySelector('.gate .gcard');
    out.gateBg = getComputedStyle(g).backgroundColor;
    out.cardBg = getComputedStyle(card).backgroundColor;
    out.win = { w: window.innerWidth, h: window.innerHeight };
    var r = card.getBoundingClientRect();
    out.cardRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    out.htmlClass = document.documentElement.className;
    out.bodyClass = document.body.className;
    out.items = [];
    var els = card.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var txt = (e.childNodes.length === 1 && e.firstChild.nodeType === 3) ? e.textContent.trim() : '';
      var st = getComputedStyle(e);
      var rc = e.getBoundingClientRect();
      if (rc.width < 1 || rc.height < 1) continue;
      var cn = (typeof e.className === 'string' && e.className) ? '.' + e.className.split(' ').join('.') : '';
      out.items.push({
        tag: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + cn,
        text: txt.slice(0, 24),
        color: st.color,
        bg: st.backgroundColor,
        fs: st.fontSize,
        rect: { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) }
      });
    }
    return JSON.stringify(out);
  })()`);

  const info = JSON.parse(probe);
  console.log('gate 背景 =', info.gateBg, '| 卡片背景 =', info.cardBg);
  console.log('窗口 =', info.win.w + 'x' + info.win.h, '| 卡片 =', JSON.stringify(info.cardRect));
  console.log('html.class =', JSON.stringify(info.htmlClass), '| body.class =', JSON.stringify(info.bodyClass));
  console.log('--- 登录卡内可见元素（实际计算色） ---');
  for (const it of info.items) {
    console.log('  ' + it.tag.padEnd(28) + ' color=' + it.color.padEnd(22) + ' bg=' + it.bg.padEnd(22) + ' ' + it.fs + '  ' + it.text);
  }

  const img = await w.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('截图已存:', OUT, fs.statSync(OUT).size, 'B');

  setTimeout(() => { app.quit(); }, 300);
});
