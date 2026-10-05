---
name: headless-ui-selftest
description: 用本机已装的 Chrome/Edge 无头模式，对纯前端页面（单文件 SPA、静态部署的 index.html）做「真实浏览器交互验证 + 视觉验收 + 线上冒烟」；也含「目标是 Electron 应用时改用隐藏窗口 + capturePage」的做法，以及强度再上一档的「真窗口 show:true + 真鼠标（过 elementFromPoint 命中测试）+ 真键盘」验收（含三处模拟不了的明说做法：IME→insertText / 原生 select→focus+方向键 / 原生 confirm→渲染层接管，以及 `debugger.attach` 挂死实测、`show:true` 下 `capturePage` 抛 `Current display surface not available for capture` 要置顶重试、以及"查界面"断言的三种假通过形态与"运行时覆盖"做反向验证）。当用户要求"验证前端交互/点击是否正常""做个预览给我看""点开弹窗/放大/拖拽有没有 bug""不要装 Playwright 也要能自动化测试页面""把界面截图给我看""人在真窗口里手点一遍"时使用。含可复用的三件套脚本模板（预览页生成器 / 浏览器内自检注入 / dump-dom 取结果）、抽真实代码的三种切法（标记切 / 括号配对 / 纯函数抠出来直接 eval，后者快两个数量级且不依赖 Chrome），以及用「断网闸门」（`webRequest` 把非白名单请求全 `cancel`）证明页面**零第三方依赖**——三条断言缺一不可（A 本地资源真加载 / B 全程没往 CDN 发请求 / C 后端数据真渲染），并附「首包比后续慢一个数量级 ⇒ 等待窗口太小会假红」这个实测坑；以及 16 个实测踩坑（含「自检页表格少格子 → 假 FAIL」「结束标记命中起点之前 → 抽空」「数据桩比真实数据宽松 → 假绿」「锚点距离写成字符数 → 假红」「harness 桩跟不上被测函数的新依赖 → 一次假红十几条」五个最误导的坑，以及「怎么测复制才不误判」）；另含「整页长图两遍法」——`--screenshot` 只截视口，要整页必须先量 `scrollHeight` 再按该高度截图（含量高/截图同宽度、单页 ≤3200px 分页、免 Pillow 读 PNG 尺寸）；另含「云沙箱托管（`*.app.workbuddy.host`）的实测边界」——同目录重部署=同地址、109 MB 单文件可托管、**不支持 Range/没有 content-length ⇒ 不能当 electron-updater 更新源**，以及「下载按钮返回 200 但正文其实是回落首页 ⇒ 判据必须落到文件头（PK/MZ）」这个只有**点开每个 tab 真发一次请求**才抓得到的坑，还有「给 Electron 脚本传参要用环境变量、别用位置参数」，以及四处 2026-10-03 实测的坑（新增：**脚本放在子目录里跑 ⇒ `app.getAppPath()` 指向该子目录 ⇒ `app.getVersion()` 变成 Electron 版本、按 appPath 算的内置依赖探测全报「缺」，极易误判成"打包漏带文件"**）：**隐藏窗口 `capturePage` 可能返回"上一帧"（判据是 md5，实测第一次截到的是切页前那一屏）**、**断言失败不影响进程退出码（`app.exit(0)` 会把 `process.exitCode` 覆盖掉 ⇒ 只能数 `^FAIL` 行，别拿 `$?` 判）**、**`executeJavaScript` 与页面同 realm、能直接读写经典脚本顶层的 `const state` / `function renderAll` ⇒ 换掉 `state.auth` 再 `renderAll()` 就能在同一窗口里演"非管理员"，是验权限门控最省事的做法（先存后改、改完必还原、必配正向对照）**。
agent_created: true
---

# 无头浏览器做前端交互自检（不装 Playwright）

## 何时用
- 纯逻辑单测（抽取函数 + 假 DOM）已经绿了，但**事件冒泡、真实拖拽、键盘优先级、CSS 层级、图片 onload 时序**这些只有真浏览器才准。
- 用户要「看一眼效果」：比起描述，一个能点的离线预览页 + 截图更有效。
- 静态部署的站点改完，要确认「没白屏、没报错」（历史最高频故障就是白屏）。

**不要**为了这个去装 Playwright（要下 ~500MB Chromium）。Windows 上 Chrome/Edge 本来就有：

```bash
# 探测（Bash 工具里用 /c/... 形式）
ls "/c/Program Files/Google/Chrome/Application/chrome.exe" \
   "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
```

## 三件套脚本模板（复制改一改就能用）

### 1) 预览页生成器 —— 关键：**从源文件抽真实代码，不要复制粘贴**
```js
const html = fs.readFileSync(path.join(__dirname, 'deploy', 'index.html'), 'utf8');
function grab(a, b) {          // 半开区间抽取，锚点失配就抛错（别静默返回空串）
  const s = html.indexOf(a); if (s < 0) throw new Error('start not found: ' + a);
  const e = html.indexOf(b, s); if (e < 0) throw new Error('end not found: ' + b);
  return html.slice(s, e);
}
const css  = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const mask = grab('<div class="popup-mask" id="popupMask"', '\n<script>');   // 组件标记
const impl = grab("var ZOOM = { open:false", '// ---------- 下一个模块');    // 实现函数
```
拼成 `_preview/xxx_preview.html`：
- 真实 `<style>` + 真实组件标记 + 真实实现函数（`new Function` / 直接内联都行）；
- **缺失的依赖要用桩补齐**（`toast` / `safeSrc` / `esc` 这些也从源文件抽，别重写）；
- 一个「已打开状态」的假容器（`<div class="modal-mask show">` + 内联 `display:flex`）；
- 用 `?z=N` 之类的 query 参数控制自动演示（截图用）；**不带参数时不要自动打开**，方便人手动点。
- 放 `deploy/` **之外**，绝不污染线上产物。

### 2) 浏览器内自检注入器 —— 把结果写进 DOM，再用 dump-dom 取回
```js
let page = fs.readFileSync('_preview/xxx_preview.html', 'utf8');
page = page.replace('</body>', `<script>
(function(){
  var out=[],pass=0,fail=0;
  function t(name, ok, msg){ ok ? (pass++, out.push('PASS '+name))
                               : (fail++, out.push('FAIL '+name+' -> '+msg)); }
  var wait = ms => new Promise(r => setTimeout(r, ms));
  async function waitImg(){                       // ★ 图片必须 await，否则一连串假失败
    for (var i=0;i<80 && !(img.complete && img.naturalWidth);i++) await wait(25);
  }
  (async function(){
    card.click(); await waitImg();
    t('1 点开后面板显示', mask.classList.contains('show'), 'show='+mask.classList.contains('show'));
    stage.dispatchEvent(new MouseEvent('mousedown', {clientX:600,clientY:400,button:0,bubbles:true,cancelable:true}));
    window.dispatchEvent(new MouseEvent('mousemove', {clientX:600,clientY:250,bubbles:true}));
    window.dispatchEvent(new MouseEvent('mouseup',   {clientX:600,clientY:250,bubbles:true}));
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}));
    var d=document.createElement('div'); d.id='SELFTEST';
    d.textContent = 'SELFTEST_RESULT PASS='+pass+' FAIL='+fail+' :: '+out.join(' | ');
    document.body.appendChild(d);
  })();
})();
<\/script>`);
```
- 事件挂在哪就 dispatch 到哪（挂在 `window` 的要 `window.dispatchEvent`）；
- 想让某个函数「不被调用」，覆盖成计数桩：`window.closeDetail = function(){ detailClosed++ }`；
- 结尾写一个 `SELFTEST_RESULT ...` 单行文本，方便正则提取。
- 注意 `<\/script>` 转义，否则提前闭合。

### 3) 跑起来 + 取结果（一条命令跑完）
```bash
# 自检（结果在 DOM 里）
chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir="$TMP/chrome-pv" --virtual-time-budget=20000 --window-size=1440,900 \
  --dump-dom "file:///C:/path/_preview/xxx_selftest.html?open=0" | grep -o 'SELFTEST_RESULT[^<]*'

# 截图（视觉验收）
chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir="$TMP/chrome-pv" --virtual-time-budget=5000 --window-size=1440,900 \
  --screenshot="out.png" "file:///C:/path/_preview/xxx_preview.html?z=4"

# 线上冒烟（防白屏）
chrome --headless=new --dump-dom "$URL" > _live_dom.html
grep -o 'id="btnLogin"' _live_dom.html            # 关键首屏标记存在 = 没白屏
grep -o '<div class="toast show"[^<]*' _live_dom.html   # 不该有 error 兜底提示
```
把这三步包成一个 `test_xxx_browser.js`（`child_process.execFileSync` + 正则解析 + 退出码），
找不到浏览器时**标记 SKIP 而不是 FAIL**（无浏览器环境不误报）。

### ⚠️ `--screenshot` **只截视口，不会自适应整页** —— 要整页长图用「两遍法」

`--window-size=1000,600` 截出来就是 **1000×600**，页面再长也只在视口里截（实测，2026-10-01）。
想要一张**完整长图**（例如把一份长报告/长页面导出成图片发给别人）：

1. **量高**：在页面里挂一段脚本把真实高度写进 DOM，再 `--dump-dom` 读回来 ——
   ```html
   <script>window.addEventListener('load',function(){
     document.documentElement.setAttribute('data-page-h',
       String(document.documentElement.scrollHeight));});</script>
   ```
   ```bash
   H=$(chrome --headless=new --disable-gpu --dump-dom --virtual-time-budget=4000 \
       --window-size=1240,800 "file:///C:/path/page.html" | grep -o 'data-page-h="[0-9]*"' | grep -o '[0-9]*')
   ```
2. **截图**：用刚量到的高度当窗口高：
   ```bash
   chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
     --screenshot="long.png" --window-size=1240,$((H+24)) "file:///C:/path/page.html"
   ```

要点：
- **量高与截图必须用同一个 `body { width: <W>px }`**，否则换行不同、高度对不上，底部会被截掉。
- `scrollHeight` 在视口大于内容时会返回视口高（示例里 800）⇒ 别把它当"内容只有 800px"。
- **单张别超过 ~3200px 高**：太长的图在聊天/工单/反馈系统里会被缩略到看不清
  ⇒ 按内容块**贪心对半分页**（每页量高，超限就把最后几块挪到下一页）。
- **判读 PNG 尺寸不需要 Pillow**：读 PNG 头第 16–24 字节即 IHDR 的宽高：
  `struct.unpack('>II', open(p,'rb').read(33)[16:24])`。
- `--user-data-dir` 指到临时目录（`tempfile.gettempdir()`）。**别放在交付目录下**：
  工作区里的 `shutil.rmtree` 可能被 safe-delete 钩子拦（`SAFE_DELETE_FAIL_CLOSED`），留下垃圾。
- **`--window-size` 的高度别指望能开很大**：实测 7823px 的长页不是所有环境都能一次截完
  ⇒ 更稳的分段法 = 给 `body` 加负 `margin-top` 生成 N 份副本，各截固定高（`-0 / -2600 / -5200px`）：
  ```bash
  # 生成 part2.html：<style>body{margin-top:-2600px !important}</style> 注入 </head> 前
  chrome --headless=new --hide-scrollbars --window-size=1440,2600 \
    --screenshot="part2.png" "file:///C:/.../part2.html"
  ```
  headless **不能滚动**，这是"分段看长页"最省事的办法。

**并发缺陷的另一条判据：stderr 必须 0 字节。** 页面区块 id 全齐（`id="xxx"` 都 grep 得到）
≠ 页面没报错 —— 脚本在区块渲染完**之后**才抛异常时，`--dump-dom` 照样能拿到完整 DOM。
所以每次 `--dump-dom` 都要**同时把 stderr 落文件并断言其字节数为 0**：

```bash
... --dump-dom "file:///$TMP/fm.html" > "$TMP/dom.html" 2>"$TMP/err.txt"
echo "stderr 字节 = $(wc -c < "$TMP/err.txt")"   # 必须 0
```

- 反复重跑前**先删上一轮的 `*.png`**，否则新旧分页混在一起；但只在真的要渲染时删
  （否则 `--no-image` 这类开关会把已有产物误删）。

### ⚠️ 要截「某个页签 / 某张表」时，别直接截自检页

自检脚本会在页面里**自己点来点去**（切页签、开弹窗、跑断言），所以截到的是**它最后停的那一屏**，
不是你要的那一屏（实测：想截「达人检索」表，截出来的是「用户管理」页，因为 ⑧ 组在那里结束）。

做法：另生成一个**截图专用页** = 自检页去掉断言脚本，再补一段「等数据真的渲染出来 → 强制切到目标视图」：

```js
(function(){
  var n = 0, t = setInterval(function(){
    n++;
    if (document.querySelectorAll('#recBody tr').length > 0) {      // 等目标区域真的有内容
      if (window.switchView) switchView('v1');                      // SPA 的全局切视图函数
      else { var b = document.querySelector('.side-tab[data-v="v1"]'); if (b) b.click(); }
      clearInterval(t);
    }
    if (n > 80) clearInterval(t);
  }, 120);
})();
```

- **必须轮询等数据**：`--virtual-time-budget` 只推进时间，不保证你的异步 fetch 已回填（截图 15s 起）。
- **宽表要一次装下**：`--window-size=1920,900`（本项目检索表 `min-width:1786px`，18 列）。
- **`--screenshot` 给 Windows 绝对路径**（`--screenshot="C:\\...\\out.png"`，实测可用）。
- 视觉改动的最好验收是**三层**：源码断言（`test_*.js`）+ 真浏览器渲染断言（自检页里的 `getBoundingClientRect`/列序）+ 截图留档；
  截图顺便还能证明「没白屏、列没被压扁」。

### ⚠️ 目标不是静态站、而是 Electron 应用？—— 改成「隐藏窗口 + capturePage」

Electron 项目（主进程 / preload / renderer 三层）没法用 Chrome CLI 截，得**借 electron 自己跑一个一次性脚本**：
`app.whenReady()` → 建隐藏 `BrowserWindow` → `loadFile(index.html)` → 用 `executeJavaScript` 点按钮 → `capturePage()` 存 PNG。
（2026-10-01 得物蓝V 项目实测跑通，参考 `D:\work\e2e\shot-brandmodal.js`。）

**四个必踩的坑：**

1. ★★ **`app.commandLine.appendSwitch('disable-gpu')` 不够，必须从命令行传**
   `--in-process-gpu --disable-gpu`。只写 appendSwitch 实测直接
   `FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.` 连窗口都起不来。
   ⇒ 启动写：`electron --in-process-gpu --disable-gpu D:/path/to/shot.js`。
2. ★★ **别用 `process.argv[2]` 接自己的参数** —— 命令行里的 `--disable-gpu` 会**先被 script 拿走当 argv[2]**，
   于是输出目录变成 `.\--disable-gpu\xxx.png`（文件确实生成了，但路径诡异、极难发现）。
   ⇒ 参数**写死在脚本里**，或改用 `process.argv.slice(2).filter(a => !a.startsWith('--'))`。
3. ★★ **`userData` 指到临时目录 ≠「空数据」** —— 应用自带的默认配置会照常生效。
   实测：想 `add` 一个叫 `TW男装` 的品牌，结果被「同名品牌已存在」正确地拒了 ——
   因为出厂默认配置里有 `copy.brand = 'TW男装'`，启动时的 `ensure()` 把它**迁移成了一个真实品牌**。
   ⇒ 造样例数据前**先打印一遍现有清单**，别假设是空的；撞名失败时先怀疑这一点，而不是怀疑业务代码。
4. ★★ **要启动「已打包的 exe」（不是 `electron shot.js`）时，必须先把 `ELECTRON_RUN_AS_NODE` 从环境里删掉。**
   本机 shell（WorkBuddy 自己的宿主就是 Electron）常带着 `ELECTRON_RUN_AS_NODE=1`，会**漏给子进程** ⇒
   这个 exe 会退化成**纯 Node**，症状非常误导：
   - **无参数启动 ⇒ 秒退、exit code 0、什么都不落盘**（连 Chromium 的 `Cache`/`Preferences` 都不建）；
   - 带参数启动 ⇒ `你的应用.exe: bad option: --in-process-gpu`。
   ★ **判据：`bad option: --xxx` 是 Node.js 的报错格式**（Chromium 从不会这么说）—— 看见它就该想到"它被当 Node 跑了"。
   ⇒ 启动写：`env -u ELECTRON_RUN_AS_NODE ./你的应用.exe`（`NODE_OPTIONS` 也会漏，一并 `-u` 更干净）。
   **别因为"秒退 0"就断定"这个 exe / 这个包坏了"** —— 本项目实测差点据此写出「对照实验证明是该 exe 自身毛病」
   的错误结论，锅其实在环境变量。（同类坑：驱动脚本跑 electron 套件不删它会 `PASS 0 / FAIL 0` 被误读成全绿。）
   判「**真的起来了**」的可靠信号：进程持续存活（`timeout` 返回 `124`）+ 主进程写出了 `userData/auth.json`
   + `userData` 下出现 Chromium 缓存目录。**只看到"进程没了"就下结论是不够的，要先看它有没有写出过文件。**

5. ★★ **`capturePage()` 在隐藏窗口上可能给你「上一帧」** —— 判据是 **md5**，不是肉眼
   （2026-10-03 得物蓝V 实测）：已经切到设置页、也断言过 `state.tab===7` 且 `#pane` 文本已更新，
   可紧接着 `capturePage()` 存下来的却是**切页前那一屏**。把两张图的 md5 与"已知页面的帧"一对就露馅
   （`97ba630a…` 其实是「素材整理」首页，不是「设置」页 —— 我说它"实时"的时候看走眼了）。
   同一次运行里再截一次就正常 ⇒ **不是"隐藏窗口不画"，而是"第一次可能拿到旧帧"**。
   - **做法**：① 切页后多等一会儿（≥300ms）再截；② 更稳的是**连截两次取第二次**；
     ③ 关键截图**顺手把页标题（如 `#head h2`）一起打出来**，图文对得上才算数。
   - 先别急着上 `show:true`：隐藏窗口下 `capturePage` 本身是实时的
     —— **判据**：同一窗口先截 A 页、再切 B 页截第二张，两张 md5 不同即证明实时。
   - 附带一条：**读图工具会按"图像内容"去重**，改完图再读同一路径可能被回一句
     「内容未变化」⇒ 别指望靠它确认"图更新了"，用 `md5sum` / 文件字节数判。
6. ★★ **断言失败 ≠ 退出码非 0 —— 别拿 `$?` 判"有没有抓住"**（2026-10-03 实测）：
   harness 里的 `ok()` 往往只设 `process.exitCode = 1`，而脚本收尾写成
   `app.exit(errors.length ? 1 : 0)`，`errors` 只收 console/preload/renderer 级异常、
   **不含断言失败** ⇒ **有 FAIL 时退出码仍是 0**。
   统计口径只能是**数 `^FAIL` 行**；拿退出码判会得出"全绿"的错误结论（和"套件中断≠没抓住"是同一类坑）。

7. ★★ **脚本放在子目录下跑 ⇒ `app.getAppPath()` 指向那个子目录，一切「按 appPath 算路径」的逻辑全错**
   （2026-10-03 得物蓝V 实测，一次误判差点写成"打包漏带文件"）：
   `electron tools/shot.js` 这种跑法下 `app.getAppPath()` = **`<仓库>\tools`**（不是仓库根！），
   连带 `app.getVersion()` 返回的是 **Electron 自己的版本**（实测 `31.7.7`，而应用是 `1.0.9`）。
   - **症状极具误导**：设置页「外部依赖」表（内置 adb / 输入法 apk / ffmpeg）**三行全报"没内置/缺"**，
     看着像打包时 `extraResources` 漏带了；截图角落还挂着一个来路不明的版本号。
   - **判据（一句话）**：**界面上的版本号 == Electron 版本 ⇒ 先怀疑这一条，别去查打包配置。**
   - **实测法**：跑个 3 行探针打印 `app.isPackaged / app.getAppPath() / app.getVersion() /
     process.resourcesPath`，再把各处 `vendorDir()` 算出的**完整路径**打出来对照 ——
     一眼看到 `<仓库>\tools\vendor\adb\adb.exe 存在=false`，而 `<仓库>\vendor\adb\adb.exe 存在=true`
     （两行一对比，根因就钉死了，不用猜）。
   - **修法**：① 探针里**显式**用 `path.resolve(__dirname, '..')` 当仓库根（项目的 `_screen.js`
     就是这么绕开的），**不要用 `app.getAppPath()`**；② 想验「用户真实看到什么」就
     **对打包后的 exe 跑**（`app.isPackaged=true` ⇒ 走 `process.resourcesPath`，这才是用户环境）；
     ③ **别把这次的结果当产品缺陷去改代码**。

**要看「管理员专属」界面时**：不要设 `BLUEV_NO_LOGIN`（那样 `auth.current()` 为 null，渲染层按非管理员画，字段全是只读）。
正确做法是**在同一个进程里调应用自己的登录函数**：`auth.load(); auth.login('admin', '口令', true);` 再 `ipc.register()`。

★★ **另一条更快、零副作用的路子：直接在渲染层换 `state.auth` 再重画**（当"造登录态"很麻烦时首选）。
`executeJavaScript` 与页面**在同一个 realm**，经典 `<script src>` 顶层写的 `const state` / `function renderAll`
**读得到、也改得动**（实测 `typeof state === 'object'`）。

```js
await win.webContents.executeJavaScript(`(async () => {
  const saved = state.auth;                       // ★ 先存原值，后面必须还原
  state.auth = { requireLogin:true, isAdmin:false, user:{ username:'u1', role:'user' } };
  renderAll();                                    // canAdmin() 立刻变 false，界面按普通成员重画
  const nonAdmin = { updBox: !!document.querySelector('#pane #updBox') };
  state.auth = saved; renderAll();                // ★ 还原，否则污染后面所有断言
  return nonAdmin;
})()`);
```

这就是验「权限门控（管理员看得到 / 普通成员看不到）」最省事的办法：**同一个窗口里演两个角色**，
比开两个进程干净得多。三条纪律：
- **先存后改、改完必还原**（不还原 ⇒ 后面的断言全建在错误的角色上）；
- **机制先自证**：加一条 `canAdmin() 真的变 false` 的断言，免得整套断言建在"其实没切成"的空地基上；
- **负向断言必配正向对照**：只查「这块消失了」不够 —— 页面整个渲染失败也能让它通过（空 == 空的假绿）
  ⇒ 同时断言「这一页仍照常渲染」（如「路径 / 外部依赖 / 保存」都在）。

**`capturePage()` 只截视口**（和 `--screenshot` 一样的限制）：弹窗比窗口高就截不全。
⇒ 把窗口开大（实测 `1240×980` 够放一个长表单弹窗），或先 `executeJavaScript` 滚到目标位置。

### ★★ 强度还要再上一档：要「人手在真窗口里点一遍」—— `show:true` + 真输入事件

`executeJavaScript('el.click()')` **跳过了浏览器命中测试**：元素被浮层盖住、或那个坐标上压根是别的东西，
它照样"成功"。所以它只能证明"代码逻辑通"，**证明不了"这个按钮真的点得着"**。
（2026-10-02 得物蓝V 第 9 页签验收实测踩齐，可复用脚本：`D:\work\e2e\accept-tab9.js`，38 条断言 + 17 张截图。）

```js
// ★ 真鼠标：坐标取真实中心点，且**每次点前先核对那个坐标上真的是它自己**
const r = await win.webContents.executeJavaScript(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  el.scrollIntoView({ block: 'center' });                 // 不在视野里 => 坐标无效
  const b = el.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
const hit = await win.webContents.executeJavaScript(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  const t = document.elementFromPoint(${r.x}, ${r.y});
  return !!t && (el === t || el.contains(t) || t.contains(el));   // 不是它就判 FAIL，别假装点到
})()`);
win.webContents.sendInputEvent({ type: 'mouseMove', ...r });
win.webContents.sendInputEvent({ type: 'mouseDown', ...r, button: 'left', clickCount: 1 });
win.webContents.sendInputEvent({ type: 'mouseUp',   ...r, button: 'left', clickCount: 1 });
```

- **真键盘**：`{type:'char', keyCode: ch}`；`{type:'keyDown', keyCode:'A', modifiers:['control']}`；
  方向键 `keyCode: 'Down'`/`'Up'`（Accelerator 那套键名）。

**★ 三处模拟不了，明写出来别冒充：**

| 做不到的 | 替代做法 | 被替掉的到底是什么 |
|---|---|---|
| 中文 / IME 组字 | `webContents.insertText('中文')`（等价"输入法上屏"） | 只有"手指打中文"；纯 ASCII 要走真 `char` 事件 |
| 原生 `<select>` | 真鼠标点它会弹**系统级下拉菜单**（独立窗口，`sendInputEvent` 到不了）⇒ 改成 `focus()` + **真方向键**（不弹菜单） | "点开下拉"；**持久化那一步仍用真鼠标点按钮** |
| 原生 `confirm()` | 见下（CDP 在这台机器上用不了） | 只有"人按下那个按钮" |

★★ **`webContents.debugger.attach()` 会挂死** —— 2026-10-02 实测：用 8 秒竞速超时抓到；
第一次没设超时，**卡满 8 分 45 秒**才被人工杀掉。
⇒ 想走 CDP 的（`Page.handleJavaScriptDialog` 回答 confirm、`Emulation.setDeviceMetricsOverride` 改视口、性能指标）
**在这台机器上先别指望**。替代：**在渲染层接管 `window.confirm`**（记录参数 + 返回预设答案），
断言的仍然是真实行为——**点删除会不会先弹框 / 框里写了什么 / 点取消后到底删没删**，
再补一条**源码级断言**佐证那一步确实是 `window.confirm`。

★★ **`show:true` 时 `capturePage()` 会抛异常**：`Current display surface not available for capture`
（窗口被别的窗口盖住 / 那一刻没在绘制，而且**时好时坏**：同一轮里有的张成功、有的连试 3 次全失败）。
⇒ 截图前 `win.show(); win.setAlwaysOnTop(true); win.focus();` + 退避重试（5 次 × 800ms），
**仍失败就放弃这一张、绝不打断断言**（否则整轮白跑）。
★ 副作用要跟用户讲：**跑验收时窗口会强制置顶弹出来**，脚本结束恢复。

★ **日志别接 `| tail`** —— 管道会一直缓冲到进程退出才吐，卡住时**完全看不到进度**，
只能靠猜（实测为此白跑了两轮）。改成脚本内 `fs.appendFileSync` 实时落盘 +
一个 `setTimeout` 看门狗（超时打印"最后停在哪个 stage"）+ **每条 `await` 前打一个 stage 标记**。

★★ **"查界面"的断言极易假通过 —— 实测一次踩全三种形态：**

1. **整页 `textContent` 里找标记词**：**页面自己的说明文字里可能本来就有这几个字**
   （实测第 9 页的提示写着"…在「品牌统计」里单列为「已删除的品牌」"）⇒ 断言**恒真**。
2. **当屏查**：内存里的数据可能和屏幕不一致。实测 `auth.load()` 第一行就是 `if (db) return db;`
   —— **已加载就短路** ⇒ 直接改 `auth.json` 文件**不影响运行中的进程**，界面照旧"看起来是对的"。
3. **只查"新值出现没出现"**：值被存成**另一个合法长相的东西**（id → 名字）时照样绿。

⇒ **优先断言"落盘的数据"（直接读 JSON 文件），界面断言只作"观测"不计入覆盖率**；
要用界面断言，**必须先让坏版变红一次**证明它查得动（见下）。

★ **反向验证的更省事做法：运行时覆盖** ——
`const orig = mod.fn; mod.fn = (…a) => { /* 顺带把数据搞坏 */ return orig(…a); }`
**不碰任何源码文件** ⇒ 对"同一仓库里有**另一个会话**正在改文件"的场景**零风险**，
也没有"破坏脚本崩了把源码留在坏版"的老问题。
★ 前提：调用方必须是 `mod.fn(...)` 属性调用（实测 `ipc` 就是这么调的）；
如果调用方在 require 时**解构**了函数，就覆盖不到 —— 先确认这一点再动手。

## 实测踩坑（每条都真实踩过）

1. **生成器的模板字符串会吞反斜杠**：`\.` `\(` `\s` 在 `\`\`` 模板里会变成 `.` `(` `s`，
   于是生成出去的正则 `/^translate\(0\s*px\)/` 变成 `/^translate(0s*px)/` → 断言莫名失败。
   **别在生成器里写正则**，用 `indexOf` / `startsWith`。
2. **Chrome 会规范化 style 值**：`translate(0.0px, 0.0px)` → `translate(0px, 0px)`、
   `scale(1.0000)` → `scale(1)`。断言别写死小数形式，两种都接受。
3. **`--virtual-time-budget` 要给够**（截图 5s、有异步自检 15~20s），否则图还没 `onload` 就截/断。
   凡是有图片的断言，先 `await` 到 `naturalWidth > 0`。
4. **无头下 `navigator.clipboard.writeText` 的 promise 可能长时间不落地**（`execCommand` 也常返回 false）
   → 「复制成功提示」这类断言要**轮询 2s**，别固定等 100ms。
   更稳的测法（同步证据 + 桩）见下面踩坑 9。
5. `file://` 跑相对路径：`img/a.jpg` 这种**带子目录的相对路径**会被页面的 URL 白名单拒掉
   （只认 `/a/b`、`./a`、纯文件名）→ 预览页写 `./img/a.jpg`。
6. `--dump-dom` 会把文本里的 `>` 转义成 `&gt;` → 解析断言消息时记得替换回来。
7. ⚠️ **自检页里的表格行必须补齐「真实列数」，否则量的是错列**（本轮真踩，且**症状极具
   误导性**）：页面用了 `table-layout: fixed`，自检 fixture 只写了 3 个 `<td>`，
   于是「筛选条件」这一格**落到了第 1 列（46px 的勾选列）**，量出来是
   `chip=153 / td=46` ——看起来像「标签溢出被截断」的真 bug，其实是**自检页自己比真实页面少格子**。
   **判据**：量宽度类断言时，若「格子宽度 = 某个明显无关的固定列宽」，先数格子数。
   **修法**：fixture 的 `<td>` 数量、列序、`<col>`/`w-*` 类名**必须与真页面完全同构**，
   宁可多写几格空的。**真 bug** 与**假 FAIL** 怎么区分、以及「自动生成结果被当用户输入」
   这类只有真跑交互才抓得到的坑，见 `android-scrape-diagnostics` §16.7。
8. ⚠️ **`grab` 的结束标记必须「从起点往后」找**。本技能模板里的 `grab` 写的是
   `html.indexOf(b, s)`（对的），但**自己另写抽取函数时极易写成裸 `indexOf(b)`** ——
   如果这个标记在目标函数**之前**也出现过一次，就会抽到**前一段**甚至**空串**，
   于是断言全 FAIL 而代码看起来毫无问题（最容易白查的一类）。
   ```js
   const e = html.indexOf(b);        // ❌ 可能命中起点之前那一处
   const e = html.indexOf(b, s);     // ✅
   ```
   **判据**：抽出来的片段不含期望的函数名、或长度为 0 → 先怀疑结束标记，别怀疑被测代码。
   结束标记选**紧贴本函数末尾的独有行**（如 `    return changed;\n  }`），不要用
   「另一个函数的签名」——它很可能定义在更前面。
9. **测「复制」不能只看 toast**（无头下 `execCommand('copy')` 常返回 false、
   `navigator.clipboard.writeText` 的 promise 可能悬着，见坑 4）。把证据拆两层，分别测：
   - **「事件确实走进了复制逻辑」** → 断言元素上**同步**出现的标记类，完全不依赖剪贴板：
     ```js
     el.dispatchEvent(new MouseEvent('dblclick', {bubbles:true, cancelable:true}));
     t('走到了复制逻辑', el.classList.contains('copy-flash'), 'flash 未出现');  // 同步，最可靠
     ```
   - **「成功路径的文案带上了被复制的值」** → 给剪贴板打「一定成功」的桩，再轮询 2s：
     ```js
     navigator.clipboard.writeText = function(){ return Promise.resolve(); };
     ```
   只测 toast 会把「浏览器拦截剪贴板」的**兜底提示误判成成功**。两层都过才算真过。

10. ★★ **数据桩不能比真实数据更宽松 —— 空数组 / 兜底分支会制造「假绿」**
    （2026-09-21 真踩：一个**已经上线**的真 bug 被自测全程放过）。
    被测代码里凡是「有配置就跟随配置，没配置就用默认值」这种**兜底**，桩里若放
    `filter_configs: []`，被测代码就**每次都走默认值分支** → 「默认值功能其实没生效」
    这个真 bug 在自测里**恒绿**，而线上那条生效配置里 `types: []` 恰好把默认值冲掉。
    - **修法**：桩里的数据必须**与线上同形态** —— 照抄一条真实记录（字段名、类型、缺省全照抄）。
      留空 = 你亲手把被测路径剪掉了一半。
    - **再加一道锁**：写一条断言**核对桩里确实放了那条会触发问题的数据**
      （如 `sb.__SBFIX.filter_configs[0].config.types.length === 0`；
      为此在桩末尾导出 `window.__SBFIX = FIX;`）。否则下一个人「为了让测试变绿」
      把桩清空，bug 又会被蒙过去 —— 这是**测试本身**要被测试。
    - **反向验证（最硬的证据）**：把**改前的源码**换回去、**保留新桩和新断言** → 必须**变红**。
      红色输出留档（本例：改前实测列出 5 行，把线上 bug 在桩里复现了）。
      **只做「改后全绿」不做「改前必红」，等于没验证。**
11. ★★ **别把「两个锚点之间的距离」写成字符数**（本项目第二次踩）：
    用 `[\s\S]{0,120}` 这类**字符数窗口**卡 `indexOf(A)` 到 `indexOf(B)` 之间，
    只要中间有人加一行注释就**假红**，而你会跑去查业务代码 —— 纯浪费。
    - **改法**：断言**相对顺序**就够 —— `html.indexOf(A) < html.indexOf(B)`；
      真要卡距离，用**结构锚点**（下一个函数签名 / `\n  }` 这种行尾），不要用数字。
12. **懒渲染（只在「脏」时才重绘）会让「切页」断言漏测**：视图切换若走
    `if (dirty[v]) render(v)`，那「v1 → v3 → v1」时 `syncXxx()` **一次都不会被调用**，
    两边互相残留错值。**写切页断言时一定要走完整的「A→B→A」往返**，
    并在被测代码里保证「每次切进来都同步一次」（v1 每次重绘 / 不脏的视图至少同步条件值）。
13. ★★ **harness 的桩要「跟得上被测函数的新依赖」—— 否则一次假红十几条**
    （2026-09-21 真踩：改完功能后 12 条断言同时 ERR，看着像产品崩了，其实全是桩的问题）。
    - **形态一：被测函数读 DOM 控件**。`document.getElementById` 的桩若一律 `return null`，
      一跑就是 `Cannot read properties of null (reading 'value')`。
      **修法**：按 id 返回控件对象，并把取值槽位做成可改对象（不同用例喂不同值）：
      ```js
      const UI = { date:'', valid:'', kw:'', likes:'', pub:'', mineOnly:false };
      const docStub = { getElementById: function (id) {
        if (id === 'fDate') return { value: UI.date };
        if (id === 'fLikes') return { value: UI.likes };
        if (id === 'fMineOnly') return { checked: !!UI.mineOnly };
        return null;   // 其余控件确实不存在 → 仍返回 null（被测代码会做存在性判断）
      } };
      ```
    - **形态二：被测函数新增了内部辅助调用**。用 `new Function(...)` 拼 harness 的，
      凡是真实函数体内新调用的函数（如新加的 `isHhKey()`），**必须一起从源文件抠进去**，
      否则报 `xxx is not defined`。
    - **判据（一句话）**：错误信息里的名字若是**你自己的桩/辅助函数名**，就是桩的问题 ——
      **别去改产品代码**。
    - **加一道锁**：给每个抠进来的代码块配一条**抽取自检**断言（`srcXxx.length > N`），
      否则锚点一漂就退化成「在空字符串上做断言」，一堆 PASS 全是假的。
14. ★★★ **量「这一格到底需要多宽 / 有没有被裁」—— 三个坑连踩（2026-09-21 实测）**：
    任务是「某列内容显示不全，要把列加宽」，必须拿到**真实像素**才能定数字。三个坑：
    - **① 探针必须放进同一个样式上下文**。把待测 HTML 放进一个游离的 `<div>` 量宽度，
      会继承 `body` 的字号；而真实单元格的字号来自 `table{font-size:13px}` ——
      实测**整体偏大 23%**，据此定列宽会做出错误的决定。
      **修法**：探针放进真 `<table><tbody><tr><td>`，直接量 **td 的宽度 = 该列需要的宽度**。
    - **② 量「自然需求宽度」必须用 `width:max-content`**。直接量真单元格里的子元素
      什么也证明不了：父级有 `overflow:hidden` 时 `scrollWidth` 恒等于格宽。
      把同一段标记放进 `width:max-content` 的容器（此时 `max-width:100%` 解析为内容宽，
      不再收缩），量到的才是「不被压时它要多宽」。
    - **③ 判据是 `td.scrollWidth > td.clientWidth`，不是子元素宽度**。
      反直觉的事实：宽度不足时 flex 子项**不会**变窄（`flex-shrink` 救不了绝对定位外的场景），
      它们保持原宽**溢出**、再被父级 `overflow:hidden` 裁掉 —— 排在后面的直接看不见。
      实测：96px 的格子里三枚标签宽仍是 42/60/60px，而 `scrollWidth=216 / clientWidth=96`。
      **只看子元素宽度会得出「一切都好」的错误结论**。
    - **定完数字还要反向验证**：把改前的 CSS 文件喂进去（`env XXX_IDX=<改前文件>`），
      新断言**必须变红**；顺便留下红色输出里的真实数字（`scroll 216 > client 96`）当证据。
15. ★★ **收窄一列之前，必须同时量「表头」和「最长内容」**（同一个任务里真踩）：
    某列单元格内容实测只要 62px，于是收到 66px —— 结果**表头**（粗体 4 个汉字）要 72px，
    当场被截成「内容…」。数值断言当时是**绿的**（它只量了内容），是**出对照截图时肉眼发现的**。
    - **修法**：给 18 个表头逐个加一条「`th.scrollWidth <= th.clientWidth`」的断言，
      并把「这一列不许低于 X px」钉成源码护栏（防止以后被顺手改窄）。
    - **推论**：任何「按内容定宽度」的结论，都要问一句「表头 / 空态 / 极端取值装得下吗」。
16. ★★ **「改前 / 改后」并排截图不是装饰，是最后一道验收**：把同一套 fixture 用**两套 CSS**
    各渲染一遍、滚到**同一位置**截图、纵向拼成一张图（PIL 即可，注意 PIL 默认字体画不了中文
    → 标签文字要放在 HTML 里让浏览器渲染，别用 PIL 写字）。
    本轮它一次抓到两点：表头被截（见坑 15）、以及「三个标记同排的行会折成第二行」这个副作用
    ——**两者数值断言都没报**。用户看到这张图能直接确认修好了，比一段数字有说服力。

## 线上部署校验（静态站）
```js
const local = fs.readFileSync('deploy/index.html','utf8');
const remote = await (await fetch(URL + '?t=' + Date.now())).text();
console.log(sha256(local) === sha256(remote) ? 'OK 线上=本地' : '不一致');
// 再逐条 grep 关键标记（新功能标记 / 旧写法已移除 / 版本号 / vendor 可达 / CSP 还在）
```
比只看 HTTP 200 靠谱得多：能立刻抓出「部署了旧产物」「关键文件没上传」。

★ 但「线上能打开」≠「不依赖外网」。要证明某个页面**零第三方依赖**（把 CDN 依赖换成本地文件之后
最常见的一步），做法是**断网闸门**：把除「本站 + 自己的后端」之外的一切请求 `cancel` 掉，
再看它还能不能正常渲染。闸门全放行时你只能证明「现在能通」，闸门一关才证明「不靠别人」。

```js
// Electron 隐藏窗口版（纯 Chrome 无头没法按请求拦截，所以这里用 Electron）
// 白名单：file:// 与自己的后端域；其余一律 cancel 并记账
win.webContents.session.webRequest.onBeforeRequest((d, cb) => {
  hits.push(d.url);
  if (d.url.startsWith('file://')) return cb({});
  if (/^https:\/\/[a-z0-9-]+\.supabase\.co([:/]|$)/.test(d.url)) return cb({});   // 换成你自己的后端域
  blocked.push(d.url);                 // ← 断言「blocked 为空 / 不含 CDN 域」
  cb({ cancel: true });
});
```

三条断言要**一起**看（少一条就漏掉一半）：

| 断言 | 看什么 | 能抓出 |
|---|---|---|
| A 本地资源真加载了 | `window.<SDK>.createClient` 是函数 | 内置文件没上传 / 路径写错 / 被扩展拦 |
| B **全程没往 CDN 发请求** | `blocked` 为空，且 host 里没有 `esm.sh`/`jsdelivr`/`unpkg` | 只改了注释，代码里还留着 `import('https://...')` |
| C 后端数据真渲染出来 | 连上 + 表格有行 | 白屏、SDK 装了但用错 |

★ **反向验证（不做就等于没验）**：把页面改回「从 CDN 动态 import」的旧写法、闸门保持关着 ⇒ 必须红。
实测：删掉本地 `<script>` ⇒ 红 **A、C**；换回 `import('https://esm.sh/...')` ⇒ 红 **B、C**（`blocked` 里出现 `esm.sh`）。
只做正向（闸门开着能渲染）**什么都证明不了** —— CDN 通的时候两种写法都绿。

### ⚠️ 这里有个「假红」陷阱：**首包比后续慢一个数量级**
跨网络到 SaaS 后端的**第一个请求要建连**，实测 `8643ms`，之后只剩 `748/756/379ms`。
等待窗口设成 20 秒时，基线会莫名卡在「读取中…」→ 看着像代码坏了，其实是**窗口不够**。
对策：窗口给到 60 秒，并且每 5 秒**主动补点一次刷新按钮**（按钮 `disabled` 说明正在读，跳过即可）。
规律：遇到「改动前好好的、改动后突然连不上」，**先量一次首包延迟，再怀疑代码**。

### ★★ 云沙箱托管（CloudStudio / `*.app.workbuddy.host`）的实测边界

把静态站分发给同事时用得上。下面每条都是量出来的，不是猜的：

| 事实 | 实测 |
|---|---|
| **同目录重部署 = 同一个地址** | 同一目录连续部署两次，返回的 sandboxId 完全相同 ⇒ 改文件重部署，**链接不用换**；换个目录就是另一个地址 |
| 单文件大到 **109 MB 也能托管** | 114 027 790 B 的 exe 整包下回来、sha256 与本地一致，6.9~10.1 s（11~16 MB/s） |
| ★ **不支持 Range** | 带 `Range: bytes=0-99` 仍返回 **200 + 整包**，无 `content-range` / `accept-ranges` |
| ★ **没有 `content-length`** | `transfer-encoding: chunked` |
| 网关会**抹掉部分响应头** | `cache-control` 看不到；但 `server: CloudStudio Gateway`、`eo-cache-status`（腾讯 EdgeOne CDN）看得见 |

⇒ 结论：当「给人点着下载」的静态站没问题；**当 electron-updater 的更新源不行**（差量下载靠 Range）。

### ★★ 验「下载按钮」必须真发一次请求 —— **200 不等于拿到了那个文件**

这类站一般都配了「路径不存在 ⇒ 回落 index.html」。于是一个**拼错的下载地址会返回 200 + 首页 HTML**，
只看状态码完全看不出来。判据要落到**内容**：

```js
const r = await fetch(url, { headers: { Range: 'bytes=0-511' } });
const b = new Uint8Array(await r.arrayBuffer());
const kind = (b[0] === 0x50 && b[1] === 0x4b) ? 'ZIP ✓'
           : (b[0] === 0x4d && b[1] === 0x5a) ? 'EXE(MZ) ✓'
           : /^<!DOCTYPE html|^<html/i.test(Buffer.from(b).toString('utf8')) ? '★ 回落首页，不是文件' : '?';
```
（注意上一条：沙箱不支持 Range，这个请求会把整包拉回来 —— 大文件别在循环里跑。小文件无所谓。）

★ 真踩过：站点里「用线上版本文件拼下载地址」的代码
`p.versionUrl.replace(/\/[^\/]*$/, '')`，对**不带斜杠**的 `versionUrl`（如 `'version.json'`）**不匹配** ⇒
整个文件名被留下 ⇒ 拼出 `version.json/dl/xxx.zip` ⇒ **200 + 首页**；而页面本身渲染一切正常、tab 也都在。
修法：`replace(/[^\/]*$/, '')`（只去掉文件名、留下目录）。
**这类 bug 只有「点开每个 tab、对每个下载地址真发一次请求」才抓得到。**

★ 配套：切 tab 要**每次都重新 querySelector**。`renderTabs()` 会重建整个 tab 栏，
先一次性取好的按钮数组，从第二个开始全是**游离节点** ⇒ `click()` 不冒泡到父级监听 ⇒ 静默无效
（表现为「切不动」，读到的还是上一个 tab 的内容）。

### ⚠️ 给 Electron 脚本传参别用位置参数
Electron 自己的开关（`--in-process-gpu`、`--disable-gpu`…）会混进 `process.argv`，
`process.argv[2]` 拿到的可能是 `'--in-process-gpu'`。用**环境变量**传（`HUB_URL=... node ...`），
否则脚本可能静默什么都不做（表现为「跑了，但没输出」）。

★ 如果非要走位置参数，注意 `argv` 里除了开关还夹着**脚本路径本身**：
`process.argv.slice(2).filter(a => !a.startsWith('-') && !a.endsWith('.js'))`。
实测（2026-10-04）：只滤了开关 ⇒ 输出路径变成 `tools/_shot-settings.js`，
把那张图写进了一个叫 `--disable-gpu` 的文件里。

### ⚠️⚠️ 驱动「真应用的渲染层」时：**别绕过它的启动流程**（2026-10-04 实测，白查两轮）

用 `executeJavaScript` 直接改 state 再调它的渲染函数，看起来最省事，实际有三个坑叠在一起：

1. **模块级 state 还是空的。** 应用的 `state.project` / `state.config` 是在启动流程
   （`boot()` → `enterApp()`）里灌进去的；绕过它 ⇒ 各页渲染直接读深路径就是
   `Cannot read properties of null`。而这个异常在 `executeJavaScript` 里是
   **未捕获 rejection** —— Electron **不退进程**，表现为「脚本挂住几分钟、一个产物都没有」。
   ⇒ 给脚本装 `process.on('unhandledRejection')` + 硬超时。
2. **事件监听根本没接线。** 点 nav 没反应，是因为 `onclick` 是在应用自己的 `bindOnce()` 里绑的，
   而 `bindOnce()` 只在 `enterApp()` 里被调一次 ⇒ 你要**手工补调一次**（`bindOnce()`），
   否则**点什么都不会发生**，截出来是空页面而你还在查 CSS。
3. **注入真值别二次编码。** `REAL_CFG` 如果已经是 JSON **文本**，再 `JSON.stringify()` 一次就变成
   「字符串」⇒ 应用看到的是「没有配置」，直接走兜底分支（你可能因此误判成「应用坏了」）。

正确顺序（等价于「正常启动之后」的状态，截到的才是用户真会看到的）：

```
主进程读出真值：store.get() / project.get()
→ 注入渲染层：state.config = <JSON 字面量>; state.project = <JSON 字面量>; state.auth = {...角色...}
→ document.body.classList.remove('locked')
→ 补接线：bindOnce()
→ renderAll()  →  capturePage()
```

⇒ 通用心法：**先让它自己启动一遍，再只补它没做的那一步**；能走真流程就别自己造状态。

## 抽真实代码的两种切法（选错会静默抽错）

`grab(a, b)`（标记切）**默认够用，但会在两种情况下抽歪**：

| 目标代码里含 | 后果 | 正确做法 |
|---|---|---|
| 正则量词，如 `/^\d{4}-\d{2}/` | 结束标记提前命中 → 函数被截断 | **括号配对** |
| 正则里的引号，如 `/[&<>"']/g` | 引号配对错乱 → 同上 | **括号配对** |

```js
// 从 `function xxx(` 起数括号，引号/正则内不计数（够用版）
function balanced(src, anchor) {
  const s = src.indexOf(anchor); if (s < 0) throw new Error('anchor not found: ' + anchor);
  let i = src.indexOf('{', s), d = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(s, i + 1);
  }
  throw new Error('unbalanced: ' + anchor);
}
```

**例外必须记住**：目标不是函数时（例如 `var SPEED_PRESETS = [ ... ];` 是数组、
`const X = {...}` 是对象），数括号也要数 `[]` / 对象括号，容易出错 → **这种仍然用标记切**。
判断标准一句话：**「它是不是一个函数」——是就用配对，不是就找它后面第一个稳定的注释/空行标记。**

## 第三种切法（优先级最高）：纯函数根本不用进浏览器 —— 抠出来直接 `eval`

如果目标是个**纯函数**（只依赖 `parseInt` / `isNaN` / 字符串方法这类内置，不碰 DOM、
不读全局变量），那就**完全不需要无头浏览器**：把它的源码抠出来在 Node 里 `eval` 一下，
直接喂用例断言返回值。

```js
// 比上面的 balanced() 多跳过行注释 —— 注释里的 } 会截断配对
function extractFn(src, sig) {
  const a = src.indexOf(sig);
  if (a < 0) return '';
  let i = src.indexOf('{', a), d = 0, q = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) {                                   // 字符串里：只找配对的引号
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (!d) return src.slice(a, i + 1); }
  }
  return '';
}
const fmtX = eval('(' + extractFn(html, 'function fmtX(v) {') + ')');
t('抠到了线上真实的 fmtX（锚点未失配，后面的行为断言才有效）', () => !!fmtX && /*len*/ true);
t('空串不能被当成 0', () => fmtX('') === undefined);
```

三个好处，都实打实：

1. **测的是线上真实源码**，不是副本 —— 和生成自检页一样的安全级别，但零抽取风险。
2. **快两个数量级**，而且能直接进 `node test_xxx.js` 这套常规回归，**不依赖本机有没有
   Chrome**（生成自检页的路子在没装 Chrome 的机器上只能 SKIP → 悄悄失去保护）。
3. 断言写起来极方便，边界用例（空串 / `null` / 纯空格 / 数字 vs 字符串 / 非法值）
   可以一次列七八条，全跑不到 1 毫秒。

**两个前提必须先确认，否则会得到「假绿」或一直 ERR**：

- 这个函数**真的是纯函数** —— 扫一眼它的函数体，凡是引用了外部变量（`state.xxx`、
  `user.email`、别的模块函数）就不能这么测，得把这些依赖也一并抽出来，或者退回浏览器方案。
- **必须额外断言「抠到了且长度合理」**。锚点失配时 `extractFn` 返回 `''`，
  `eval('()')` 直接抛错 → 一堆 ERR 还能发现；但如果你把 `eval` 包了 try/catch 就会变成假绿。
  所以显式加一条「抠到了」的守卫断言，把「锚点失配」和「逻辑错了」区分开。

### ★★ 抽取锚点与「函数签名」同生共死（2026-09-21 真踩，最误导的一类）

用**函数签名**当锚点（`extractFn(html, 'async function runNow() {')`）时，
**重构把函数拆成「包装 + 实现体」后锚点会落空** —— 抽取返回 `''`；
若断言写成 `'' .includes('闸门') === false` 之类，于是**「抠不到函数体」被误判成「这里没有闸门」**：
报出来是「产品缺功能」，实际是「测试的锚点过期了」，**方向完全反了**，能白查很久。

- **修法**：锚点改指**拆分后仍然存在的那一个**（如 `async function runNowOnce() {`），
  并在锚点处**留一行注释警告后人别改回去**（否则下次重构又会踩）。
- **同时**给断言加「抠到了」的前置守卫 —— 让锚点失效变成显式的 `FAIL 抠不到`，
  而不是「悄悄通过」或「悄悄判负」。
- **断言方式优先级**（越靠前越耐重构）：
  1. **行为断言**（把真实代码块 `exec` 出来喂用例）—— 只锁语义，重构不假红；
  2. **codeOnly 字符串断言**（先剥掉行注释再 `includes`）—— 注释里提到被禁写法不会误命中；
  3. 原串 `includes` —— 最脆，改注释/空白就红，只留给「这行必须原样存在」的接线检查。
- **负向断言（"不能出现 X"）务必走第 2 级**：否则你在注释里解释「这里不能用 `X` 的写法」
  就会把断言自己撞红（本项目实测踩过：注释里写出了被禁的 `toISOString().slice(0,10)`）。
  实在要写进注释，就换一种**不出现该字面量**的说法。

## 三个必须（少一个就会得到「一片空白」然后白查半小时）

1. **结果必须写进 DOM**。`--dump-dom` 读的是 DOM，**读不到 `window.xxx`**。
   把 `PASS/FAIL` 汇总塞进 `<div id="selftest-result">`，再用
   `grep -o 'SELFTEST_RESULT[^<]*'` 取回。
2. **页面必须挂 `window.onerror` 写 `<title>`**，否则脚本里的语法错误只会得到一张空白页，
   连报错信息都没有：
   ```js
   window.onerror = function (m) { document.title = 'ERR ' + m; };
   ```
   取回时先看 `<title>` 是不是 `ERR ...`，再谈断言。
3. **注入的自检脚本里别写裸 `\n`**。生成器用的模板字符串会把 `\n` 变成**真换行**，
   把 `out.push('a\nb')` 拆成两行 → `Uncaught SyntaxError`。用
   `String.fromCharCode(10)` 或先把整段脚本 `JSON.stringify` 再注入。
