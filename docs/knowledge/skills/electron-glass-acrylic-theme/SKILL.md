---
name: electron-glass-acrylic-theme
description: 给 Electron（Windows）桌面应用加一档「透明磨砂玻璃」皮肤，并**实证**它真的透到了桌面——而不是自画一层彩色渐变冒充磨砂。当出现「玻璃档怎么是紫色 / 不是透明磨砂吗」「这个磨砂看起来是假的」「窗口能不能透出桌面壁纸」「要不要用系统亚克力 / acrylic / mica」「切到玻璃档后面还是块实心色」「用 Electron 做毛玻璃 / 云母效果」这类需求时使用。含：①★★ 三配置探针（跑完即删的最小脚本），一次问清 `transparent:true` / `backgroundMaterial:'acrylic'`（**建窗时**）/ `win.setBackgroundMaterial()`（**运行时**）各自到底行不行——实测结论：**只有建窗时的 backgroundMaterial 能糊，运行时设会变纯黑，且它与 transparent 互斥**；★★ **acrylic 能透出后面的其它窗口，只有 mica 是「只采样壁纸、不透窗口」**（2026-10-08 勘误，见 §8）；②★★ 「一个窗口、别的档盖住、玻璃档露出来」的落地范式（建窗永远挂 acrylic；`bgColor()` 按皮肤返 `#00000000`；CSS 把 body 挖成 transparent）；③★★★ **最隐蔽的坑**：切到玻璃档时主题源（`nativeTheme.themeSource`）往往**没变** ⇒ `updated` 事件不触发 ⇒ 窗口底色停在实心色、亚克力透不出来 ⇒ 必须显式 `refreshBackdrop()`，且要断言「谁调它」（只写函数不写调用 = 白写）；④★★ 取证法定：**垫一块纯色底窗**当判据（比看壁纸可靠）、**整屏取景再裁窗口**（capturePage 拍不到窗口外的桌面）、以及「同样的半透明面板压在纯黑上会是多亮」的**反推判据**（实测压黑 ≈`rgb(14,14,18)`，读到 `rgb(66,66,66)` 才说明底下真有东西在透亮）；⑤用**临时 userData** 起真 app 逐档取景（不动用户真配置）、`BLUEV_NO_LOGIN=1` 之类跳过登录门；⑥Windows 版本门槛（Win11 支持，Win10 忽略该选项 ⇒ 退化成「清晰透桌面」，要写明）；⑦裁图别依赖 PIL，用 electron 项目自带的 **sharp**。
agent_created: true
---

# Electron 真·亚克力玻璃皮肤

## 何时用

- 用户要一档「透明磨砂玻璃」主题，且**明确要能透出桌面**（而不是界面上画一层假磨砂）。
- 用户先看到了一版「假磨砂」（自画渐变 + `backdrop-filter`）并质疑「怎么是紫色 / 这是透明的吗」。
- 需要判断 `transparent` / `backgroundMaterial` / `setBackgroundMaterial` 到底哪个能用。

## 0 · 先分清「假磨砂」和「真磨砂」

| | 做法 | 后面是什么 | 代价 |
|---|---|---|---|
| **假磨砂** | `body` 上自画彩色 `radial-gradient` + 面板半透明 + `backdrop-filter` | **你挑的颜色**（永远透不出桌面） | 小，但用户会一眼看出「怎么是紫的」 |
| **真磨砂** | 窗口本身透明/上系统材料 | **桌面壁纸 + 后面所有窗口**（被系统糊过） | 要改 window 配置，平台相关 |

★ 用户说「透明磨砂玻璃质感」时，八成是要**真磨砂**。别用自画渐变糊过去。
★ CSS 的 `backdrop-filter` **糊不到窗口外的桌面** —— 它只糊「页面内、在该元素下面」的内容。
  桌面的模糊只能由**系统**（DWM 材料）给。

## 1 · ★★ 三配置探针（先问清环境，再写代码）

写一个**跑完即删**的最小 Electron 脚本（放进项目根，用项目自带的 electron.exe 跑）：

```bash
env -u ELECTRON_RUN_AS_NODE "./node_modules/electron/dist/electron.exe" "_probe-acrylic.js" "<输出目录>"
```

★ `ELECTRON_RUN_AS_NODE` 不清掉的话，electron 会退化成纯 Node、`require('electron').app` 是 `undefined`。

探针要点：
1. 垫一块**纯色（如品红 `#ff00ff`）全屏底窗** —— 比看壁纸可靠得多（见 §4）。
2. 在其上开三种配置的测试窗：`{transparent:true}` / `{backgroundMaterial:'acrylic'}` / 建完再 `win.setBackgroundMaterial('acrylic')`。
3. `desktopCapturer.getSources({types:['screen']})` 取整屏，按**位置**采样每块窗中心像素。

**本机实测结论（Win11 23H2 build 22631 / Electron 31.7.7）：**

| 配置 | 结果 |
|---|---|
| `transparent: true` | ★**真透**（底窗品红 `rgb(253,0,253)` 直接可见）——但**清晰不糊** |
| `backgroundMaterial:'acrylic'`（**建窗时**） | 能糊，**且能透出后面别的窗口**（压品红窗 `rgb(223,0,223)` vs 压深色应用 `rgb(61,61,61)`，差 **385**） |
| `backgroundMaterial:'mica'` | 能糊，但**只采样壁纸**（压品红窗 `rgb(28,33,37)` vs 压深色应用 `rgb(32,31,37)`，差 **6**）⇒ **不透窗口** |
| `win.setBackgroundMaterial('acrylic')`（**运行时**） | ✗ 窗口被画成**纯黑**，不可用 |

⇒ **定论**：只能用**建窗时**的 `backgroundMaterial`；它与 `transparent` **互斥**
  （两个都给时丙烯覆盖，回不去透明）。⇒ 想要「磨砂」就放弃「**清晰**透出」——
  丙烯是**糊的**，但仍会把后面的窗口糊出来（只是看不清）。
  ★ 顺带：`desktopCapturer` 传了 `thumbnailSize` 时实测能拿到 1:1（2560×1440），
   但**代码里仍要按 `位图尺寸 ÷ 整屏尺寸` 换算**，别假设它一定不缩放。
⇒ ★★ **acrylic 透「窗口后面的窗口」，mica 只透壁纸**（2026-10-08 复测纠正，见 §8）。
  官方口径：Acrylic = "reveals the desktop wallpaper **and other windows that are behind**"；Mica = "**only samples the desktop wallpaper**"。

★★ 采样/裁剪坐标要乘比例，而且分母是**整屏尺寸，不是工作区尺寸**：
  `desktopCapturer` 交回的是**整屏**（含任务栏区）的缩略图。实测整屏 2560×1440 → 缩略图 2475×1392，
  而 `screen.getPrimaryDisplay().workArea` 是 2560×1392（1440 − 48 任务栏）。
  用 `size.height / workArea.height` 会得到 1.0（**错的**），正确是 `size.height / 1440 = 0.9667`。
  差这 3% ⇒ 裁出来的图底部会多出 ~24px 的桌面、采样点也会错位。
  正解：`ratio = size / <整屏 size>`，即 `screen.getPrimaryDisplay().size`。

## 2 · 落地范式：一个窗口，别的档盖住，玻璃档露出来

**核心技巧**：不新建窗口、不在运行时切材料（会变黑）。而是**建窗时就挂 acrylic**，
靠「页面底色透不透」来决定露不露出来。

```js
// window.js
function bgColor() {
  if (normSkin(store.get('ui.theme')) === 'glass') return '#00000000';  // 挖空 ⇒ 露出亚克力
  return nativeTheme.shouldUseDarkColors ? '#111113' : '#f2f1ed';       // 实心 ⇒ 盖住亚克力
}

win = new BrowserWindow({
  frame: false,
  backgroundColor: locked ? GATE_BG : bg,   // 登录门/浅色/深色都是实心
  backgroundMaterial: 'acrylic',            // ★ 永远挂着；建窗时定，运行时别再改
  // ...
});
```

```css
/* styles.css */
html.glass body { background: transparent; }   /* ★ 挖空 —— 填任何颜色都会把亚克力盖死 */
html.glass .app  { background: transparent; }
html.glass { --panel: rgba(22,23,29,.62); /* …半透明面板 ⇒ 烟熏玻璃感 */ }
```

- 浅色/深色档**不受影响**：`body{background:var(--bg)}` 本就不透明，把亚克力盖死。
- 登录门同理：底色是不透明纯色，一样盖住。
- **Win10 会忽略 `backgroundMaterial`** ⇒ 玻璃档退化成「清晰透出桌面」；文档要写明这条兜底。

## 3 · ★★★ 最隐蔽的坑：切到玻璃档，底色不更新

**症状**：代码全对，切到玻璃档后界面透明了，**后面却是一块实心暗色**，亚克力看不见。

**根因**：玻璃档在原生窗口层通常按**深色**走（否则会出现「界面玻璃、原生滚动条浅色」的半浅半深）。
于是 **深色 → 玻璃** 切换时 `nativeTheme.themeSource` **根本没变** ⇒ `nativeTheme.on('updated')`
**不触发** ⇒ 那句 `setBackgroundColor(bgColor())` 不会执行 ⇒ 底色停在上一次的实心值。

**修法**：皮肤切换处**显式**重算。

```js
function refreshBackdrop() {
  if (!win || win.isDestroyed() || loginMode) return;
  win.setBackgroundColor(bgColor());
}
// ipc.js
ipcMain.handle('theme:set',    (_e, s) => { /* …set store… */ winmod.refreshBackdrop(); return winmod.theme(); });
ipcMain.handle('theme:toggle', ()     => { /* …set store… */ winmod.refreshBackdrop(); return winmod.theme(); });
```

★★ **只写 `refreshBackdrop` 不写「谁调它」= 白写。** 回归里要**钉住调用点**，例如
「`ipc.js` 里 `winmod\.refreshBackdrop\(\)` 的出现次数 ≥ 2」。

## 4 · ★★ 怎么证明「真的透到桌面」（别自欺）

1. **垫纯色底窗当判据**：在全屏纯品红窗上开测试窗。
   - 透明配置 ⇒ 窗心读到**品红**；不透明 ⇒ 读到面板色。比看壁纸/看窗外的窗口可靠得多。
   - ★★ **acrylic 也会透底窗**（实测压品红 ⇒ `rgb(223,0,223)`）⇒ 丙烯完全可以用这个方法判；
     **只有 mica 不透窗口**。旧版写的「系统丙烯只糊壁纸、不糊别的窗口」是错的（见 §8）。
   - ★★ 读到「色不对 / 发黑」时先查三件事，别急着下结论：
     ① 测试窗是不是**活动窗**；② 底窗有没有被 `focus()` **抬到测试窗前面**
     （实测踩过：`base.focus()` 之后窗心读到纯品红 `rgb(255,0,255)` —— 那是拍到了底窗本身）；
     ③ 有没有**对照组**：同一个透明窗**去掉 `backgroundMaterial`** 应读到 `rgb(0,0,0)`，
     读到黑才说明「有颜色 = 材料在起作用」，而不是透明像素被拍成了背景。
2. **`capturePage` 拍不到桌面**（它只拍页面内容，透明处是透明像素）⇒ 要看桌面必须
   **`desktopCapturer` 整屏取景再裁窗口区域**。
3. **反推判据（很好用）**：先算「同样的半透明面板压在**纯黑**上应该是多亮」。
   实测 `.side = rgba(17,18,24,.58)` 压纯黑 ≈ `rgb(14,14,18)`；真机玻璃档窗心读到 `rgb(66,66,66)`
   ⇒ 底下**确实有东西在透亮**，不是一块黑。
4. **换位置比较法**（判系统材料是否真在采样）：把两块同样的窗放在屏幕**不同位置**，
   若输出像素**不同** ⇒ 在采样背景（真材料）；若**一模一样** ⇒ 只是画了块纯色（假材料）。

## 5 · 用真 app 取证（不动用户真配置）

```js
const path = require('path'), fs = require('fs'), os = require('os');
const UD = path.join(os.tmpdir(), 'bluev-shot-ud');       // 临时 userData
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ ui: { theme: 'light' } }), 'utf8');
process.env.BLUEV_NO_LOGIN = '1';                          // 该应用的「跳过登录门」开关（按项目实际改）
const { app } = require('electron');
app.setPath('userData', UD);                               // ★ 必须在 require 主进程入口之前
require('./src/main/index.js');
app.whenReady().then(async () => {
  const win = require('./src/main/window.js').getWindow();
  // 点**真按钮**逐档切换，再 desktopCapturer 整屏取景
  await win.webContents.executeJavaScript(`document.getElementById('themeBtn').click()`);
});
```

★ 跑真 app 的脚本要放进项目里跑（`require('electron')` 才会解析成模块），**跑完删掉**。

## 6 · 裁图别依赖 PIL

本机 Python **没有 PIL**。Electron 项目通常自带 **sharp**：

```js
await sharp(src).extract({ left, top, width, height }).toFile(dst);
```

★ 裁窗口区域时记得把窗口坐标**乘上截图/整屏比例**（分母用**整屏**尺寸，不是工作区 —— 差 3% 会让底部多出
  一条桌面，见 §1 末尾），否则边缘差几十像素（不影响判读，但别拿它当对齐证据）。

## 7 · 断言要钉在哪（防止以后被静默改坏）

- 源码级：`backgroundMaterial:'acrylic'` 在**建窗处**；`bgColor()` 的玻璃分支返回 `'#00000000'`；
  `bgColor, refreshBackdrop` 已导出；`ipc` 里 `refreshBackdrop()` ≥2 处；CSS `body` 为 `transparent`。
- 实算级（真窗口读 `getComputedStyle`）：玻璃档 `.app` 与 `body` 的背景是**透明**、面板底色是 `rgba(...)`。
  ★ 只查 `classList` 证明不了「皮真换了」。
- ★★ **断言串写完先对着真文件预跑一遍**（`node -e "…test(regex)…"`）——
  自己把断言写错会造出**假红**，白折腾一轮。

## 8 · ★★★ 勘误 2026-10-08：acrylic **能**透「后面的其它窗口」

用户指出：玻璃档后面有别的应用时，**也能隐隐约约看见那个应用**；而上一轮被写成了「只能透桌面、不能透应用」。

**复测**（Win11 23H2 / Electron 31.7.7）—— 左半屏垫一块**不透明纯品红**窗当「下面那个应用」，
测试窗各拍两次（压品红 / 压右侧深色真实应用，壁纸不变）：

| 材料 | 压品红窗 | 压深色应用 | 两位置差 |
|---|---|---|---|
| `acrylic` | `rgb(223,0,223)` | `rgb(61,61,61)` | **385** |
| `mica` | `rgb(28,33,37)` | `rgb(32,31,37)` | **6** |
| 无材料（对照） | `rgb(0,0,0)` | `rgb(0,0,0)` | 0 |

⇒ **acrylic 透窗口，mica 只透壁纸**。用户是对的。
⇒ 官方口径一致：Acrylic = "reveals the desktop wallpaper **and other windows that are behind**"；
  Mica = "**only samples the desktop wallpaper**"。
⇒ **旧结论的成因**：旧探针只做过「两块窗放在**壁纸**不同位置」（`rgb(83,83,83)` vs `rgb(64,64,64)`，
  恰好是「采样背景」那一档），**从没做过「测试窗压在另一块窗口上」的对照** ⇒
  「不透窗口」是从「只测了壁纸」**推**出来的，不是测出来的。
⇒ 教训：判「透不透 XX」**必须有一组把 XX 放进去的对照**；测试窗要是活动窗、要在底窗之上
  （`base.focus()` 会把底窗抬到测试窗前面，据此得到过一条**看起来像结论的废数据**：窗心读纯品红 = 拍到的是底窗本身）；
  还要配一个「去掉材料」的对照组（应读 `rgb(0,0,0)`），才能排除「透明像素被拍成背景」的假象。
⇒ **产品含义**：用 acrylic 的玻璃档**本来就会透出后面的应用**（≈ 隐隐约约，因为外面还压着半透明面板）——
  这是 Windows 行为，**不是 bug**。若要「只透壁纸」，只能换 `mica`（代价：近乎不透明、玻璃感大减）。
