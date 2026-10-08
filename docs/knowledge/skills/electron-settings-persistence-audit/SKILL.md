---
name: electron-settings-persistence-audit
description: 排查并修复「设置/偏好记不住」——用户说「我选了 X，下次打开又变回去了」「皮肤/主题/勾选项没保存」时用。核心是**先证明它到底有没有实现**（别把已实现的重做一遍），再用「退出丢盘」这把尺子找真洞：防抖写盘（debounce）在进程退出时**不会跑**，而「退出钩子里再 set 一次」是**假兜底**（只把同一个定时器又排一遍）。含：①三处核对点（写入端 / 启动读取端 / 真机开-关-再开实测）；②★ 真机复现「点完立刻关窗口」的探针写法与 before/after 数字；③修法（同步 flush + 退出钩子）；④两条配套断言（行为级 + 源码级，**缺一即白写**）；⑤读用户**真实配置**当佐证（只读）。
agent_created: true
---

# 「设置记不住」排查与修复（Electron / Node 桌面应用）

## 何时用

- 用户说：「我选了深色/玻璃，下次打开又变回日间」「勾选没保存」「设置过一会儿就忘了」。
- 用户提的是**需求**而不是故障：「记住用户最后一次选择的 X，后续打开默认还是它」。

## 0 · ★★★ 第一步先证「到底有没有实现」，别急着重做

这类需求**经常本来就已经实现了**。先做三处核对，再决定要不要写代码：

| 核对点 | 找什么 |
|---|---|
| **写入端** | 切换那个设置的 handler 里，有没有真的落盘（`store.set(...)` / `fs.writeFileSync` / `localStorage.setItem`） |
| **启动读取端** | 启动序列里，有没有在**建窗口/渲染之前**把存下来的值应用上（晚了会先闪一下默认值） |
| **真机实测** | 起真 app → 点**真控件** → 关掉 → **再打开** → 看是不是还在 |

★ 佐证：**读用户本机真实的那份配置**（只读！别改）——
`%APPDATA%\<appName>\config.json`（Windows）、`~/Library/Application Support/<appName>/`（macOS）。
里面已经是用户选的档位 ⇒ 说明写入+读取链路在**他机器上**是通的。

⇒ 若三处都通：老实告诉他「这条本来就实现了」，并给出实测数字。
**不要把已实现的东西重做一遍**（白改 + 引入回归风险）。

## 1 · ★★★ 真会丢的地方：防抖写盘 + 进程退出

绝大多数配置模块为了少写盘都用 **debounce**：

```js
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, 250);      // ★ 250ms 防抖
}
```

**进程退出不会等这个定时器。** 于是「切完设置 → 马上关窗口」这次改动**永久丢失**。

更坑的是**假兜底**——很多代码里已经有这么一句，看起来已经兜住了：

```js
app.on('before-quit', () => { store.set({}); });   // ← 假兜底！
```

`store.set` 内部只是再排一个**同一个**定时器，照样等不到。
（本项目实测：这句存在了很多轮，故障照旧。）

### 复现（必做，拿 before 数字）

写一个**跑完即删**的探针，用项目自带的 electron 起真 app、临时 userData（不动用户真配置）：

```js
// mode=run1: 全新配置 → 点真控件切到目标值 → 等落盘 → 报告 → 退出
// mode=run2: 沿用同一份配置 → 只看**启动时**的值（验「记住」）
// mode=run3: 全新配置 → 点控件 → **只等 60ms 就退出**（验防抖丢盘）
process.env.<跳过登录门的开关> = '1';
app.setPath('userData', UD);            // ★ 必须在 require 主进程入口之前
require('./src/main/index.js');
// 点真控件（不要直接调内部函数，那样验不到接线）：
// win.webContents.executeJavaScript("document.querySelector('<选择器>').click()")
```

★ 跑脚本：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/electron/dist/electron.exe _probe.js run3`
（`ELECTRON_RUN_AS_NODE` 不清掉 ⇒ electron 退化成纯 Node，`require('electron').app` 是 undefined）

判读：**退出后**再从磁盘读（别在进程内读，那是内存值）。

## 2 · 修法

```js
// store.js —— 抽出同步写盘，别在 set 里改成同步（跑批时写盘频繁）
function writeNow() { if (!cache) return; /* mkdir + write tmp + rename */ }
function scheduleSave() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 250); }
/** 退出路径专用：取消防抖并当场写盘 */
function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } writeNow(); }

// index.js
app.on('before-quit', () => { try { store.flush(); } catch (e) {} });
```

★ 修完顺手确认：**所有** 250ms 内的改动（不止用户抱怨那一个）都被救回来了。
★ 救不回来的：`app.exit()` / 强杀 / 崩溃 —— 这些**不经过** `before-quit`，要如实说明。

## 3 · ★★ 两条配套断言，缺一条就等于白写

1. **行为级**（证明同步写盘真的发生）：先 `flush()` 清掉可能挂着的旧定时器 → `set(新值)` →
   立刻读磁盘**必须还是旧值**（证明确实存在防抖窗口）→ `flush()` → 读磁盘**必须已是新值**。
   ★ 「先 flush 一次」不能省：否则上一条用例遗留的定时器会在你读之前把新值写进去 ⇒ 偶发假失败。
   ★ 用完把值**还原**，别污染后面的用例。
2. **源码级**（钉住调用点）：退出钩子里必须是 `flush()`，且**不许**再出现旧的 `set(`。
   ★ 负向断言先剥注释（注释里常常正好写着那个旧写法，会把断言打成假红）。
   ★ **只写 `flush()` 函数、不钉「谁调它」= 白写**。

## 4 · 反向对照（证明断言不是空的）

逐条把产品改坏，断言必须**只打中你指的那一条**：①退出钩子还原成旧写法 ⇒ 源码断言红；
②`flush()` 改空函数 ⇒ 行为断言红。各应在 **1 条 FAIL**、其余全 PASS。
★ 还原一律**跑前备份到临时目录、跑完 `cp` 还原**，**禁 `git checkout -- <file>`**（会抹掉未提交的在制品）。
细节见技能 `bilateral-fix-verification`。

## 5 · 收尾

- 全量回归：跑项目的一键回归入口（本项目 `node tools/run-all.js`，先清 `NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE`）。
- 探针脚本删掉；before/after 备份目录留着，写进报告。
- 报告里写清**同类但未修的洞**（例如窗口几何常另有一个 300ms 防抖 ⇒「拖完立刻关」仍丢尺寸），别假装全修完了。
