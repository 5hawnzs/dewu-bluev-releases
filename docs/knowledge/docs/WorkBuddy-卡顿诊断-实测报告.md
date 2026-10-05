# WorkBuddy「一直卡着」——实测诊断报告

> 时间：2026-10-02 12:15 ~ 12:30 · 机器：本机（Administrator）· 应用版本：**5.0.3**
> 触发提问：**「为啥一直卡着？」**

## 结论（一句话）

**这不是你的机器不够，也不是项目代码的问题 —— 是 WorkBuddy 客户端的渲染进程（界面）缺陷：它已经涨到 3.14 GB，
并且在 10-02 00:17 被杀过一次；界面卡住时是「崩溃 + 会话视图反复重建」，不是「算得慢」。**
本机修不了，只能**规避 + 升级 + 报官方**。

---

## 1. 先把症状分流：这是「崩」，不是「慢」

按经验，抱怨卡顿要先分清两件事 —— 查法完全不同：

| 症状 | 该查哪里 |
|---|---|
| 「慢 / 一顿一顿」 | 资源、并行会话、定时任务、单个大会话 |
| **「点不了 / 卡住 / 自动消失」（你说的这类）** | **崩溃报告**，不用去量资源 |

你说的「一直卡着」+ 我这边**两条命令发出去没有任何返回**，属于第二类 ⇒ 直接去读崩溃报告。

## 2. 实测证据（每条都可复算）

### 证据 ①：界面进程吃了 3.14 GB

```bash
tasklist | grep -i workbuddy | awk '{print $1, $5, $6}'
```

实测有 **11 个** WorkBuddy 进程，其中**一个吃 `3,289,516 K ≈ 3.14 GB`** —— 那是渲染（界面）进程。
`AppStartup.log` 显示 `uptimeSec=42945`（12:13）⇒ 这个进程**已连续运行约 12 小时没重启**
（起点 = 00:17 崩溃后自动重启那一刻）。

> 参照：同一天的日志探针显示 **agent 进程只有 rss 311~414 MB、CPU 0.0~0.3%**。
> ⇒ **卡在界面侧，不在「会话跑得重」**。这一组对照能把锅一次分清。

### 证据 ②：渲染进程被杀过，累计 15 次

`%USERPROFILE%\.workbuddy\logs\Crash-Log\` 下 **14 份报告**，逐条统计：

| 事件类型 | 次数 |
|---|---|
| `renderer_crash`（界面进程死亡） | **15** |
| `child_process_crash`（NetworkService 陪葬） | 13 |
| `gpu_crash`（陪葬） | 12 |
| `renderer_js_error`（前端未捕获异常） | 24 |
| **OOM / 内存耗尽** | **0** |

最近一次（`crash-report-main-34396-20261001T155414.json`）：

```
00:12:06  renderer_js_error  Uncaught TypeError: Cannot read properties of undefined (reading 'length')
                             at summarizeBlocks (connector-*.js:36244)   ← WorkBuddy 自己的界面代码
00:17:18  renderer_crash     Renderer process gone: reason=killed, exitCode=1
00:17:18  child_process_crash NetworkService gone: reason=killed, exitCode=1
00:17:19  gpu_crash
```

**00:12 前端抛错 → 00:17 界面进程被杀**，三连（渲染 + 网络 + GPU）⇒ 整个界面死亡。

### 证据 ③：卡住的当下，是「冷启动风暴 + 会话视图反复重建」

`AppStartup.log` 尾部：

```
12:08:11.352 [SessionSwitch] sessionId=c8355447-…
12:08:11.377 [SessionSwitch] sessionId=c8355447-…    ← 同一个会话 id
12:08:11.403 [SessionSwitch] …
（…1.3 秒内共 12 条…）
12:09:18 / 12:10:49 / 12:11:25 / 12:12:30 / 12:13:12  还在不停地切
```

**1.3 秒内连发 12 次会话切换**，同时段工作区日志里一个新 agent 进程正在冷启动：

```
[Startup] McpManager.list: starting (scope=all)              ← 全量扫连接器
[Startup] McpManager: non-interactive projection enabled
[LSPManager] LSP Manager initialized
[PluginPolicyService] loadPolicies for the first time
[HotReload] cwd changed to "E:\WORKBUDDY\2026-09-30-17-35-35", rebinding watchers
```

⇒ **每切一次就要把会话视图重建一次**，再叠上冷启动那套全量扫描 —— 这就是「卡住不动、点不了」的直接现场。

### 证据 ④：我这边「卡着不返回」的那一次

上一轮（约 01:02）我发出去的两条命令**返回空**，11 小时后重跑一切正常（本地 git 秒回、远端查询 2 秒）。
那一轮正好落在 **00:12 抛错 → 00:17 崩溃 → 自动重启**的窗口里 ⇒
**工具结果没落盘**，和「一卡消息就没了」是同一个机制。

## 3. 排除项（也必须写出来，否则就是猜）

- **定时任务：排除。** 查了全部定时任务，**15 条全部是 PAUSED** ⇒ 不是「每小时定时任务不断拉会话」那种病因。
- **内存耗尽：排除。** 14 份崩溃报告里 `out of memory` **一次都没出现**。
- **崩溃循环：不成立。** 崩溃时间点分散（9/21、9/22×2、9/24、10/1×2、10/2），**间隔不规律** ⇒
  不是「每隔固定几分钟崩一次」那种看门狗循环。
- **CPU / 磁盘：这次取不到。** 不是没查，是**查不了**：`wmic` 被安全策略拉黑（不允许、也不建议绕过）、
  本机 PowerShell 工具连结果文件都不落盘。⇒ **如实说取不到，不写猜测数字。**

## 4. ★★ 最要紧的一条：你现在升级也收不到修复

`logs\update\update-20261002.log` 里，**每小时一条**：

```
[WARN ] [win32] Update blocked by install dir guard     ← 20:17 / 21:17 / 22:17 / 23:17 / 00:17 / 01:17 / 02:17 / 03:17 …
```

安装目录守卫把自动更新**拦下了**（安装在 `C:\Users\Administrator\AppData\Local\Programs\WorkBuddy`）。
⇒ **官方就算在新版本里修了 `renderer_crash`，你这台机器也收不到** —— 必须**手动装**，
或者装到**非受保护目录**（如 `D:\WorkBuddy`）里。

## 5. 怎么办（按性价比排序）

1. **现在就能见效：彻底退出 WorkBuddy 再打开**（不是最小化 —— 要确认进程清零）。
   界面进程超过 1500 MB 就该重启，你现在是 **3.14 GB**。
2. **少开并行会话**：每开一个会话就是一组进程，界面要渲染的内容成倍增长。
3. **手动升级到最新版**（自动更新被拦，见 §4）；或**换到 `D:\WorkBuddy` 这类目录重装**，之后自动更新才走得通。
4. **报官方**：把 `%USERPROFILE%\.workbuddy\logs\Crash-Log\` 整个目录给官方 ——
   里面有 14 份报告、15 次同型 `renderer_crash`、0 次 OOM，是干净的证据包。
   （应用内路径：设置 → 帮助与反馈 → 意见反馈；正文框只有 300 字符，长内容建议渲成图片或直接附日志包。）

## 6. 结论措辞上的分寸（不越界）

- 能证明的：**崩溃发生时，界面进程已经涨到 3.14 GB、且已连续运行约 12 小时**。
- **不能**断言的：不能说「涨到 3.14 GB 就一定会崩」—— 除非做过对照复现。
  所以上面的措辞一律写成「观测到」，不写成「因为」。

---

## 附：这次顺带完成的收尾

| 事情 | 结果 |
|---|---|
| 前一轮的 `6dbf671`（左侧「运行日志」页） | **没丢**：`git merge-base --is-ancestor` 为真，已在 `origin/main` |
| README 里的回归计数（662 / brandtest 76 / uicheck 94 / logintest 65） | **已按 12:21 实测更正**为 671 / 80 / 96 / 67，提交 `406602d` 并推送（远端已确认） |
| 本次推送有没有带别人的提交 | **没有**：`6194456..406602d` 只有 1 个提交，且只含 README 那 5 行 |
| 工作区里并行会话的改动 | **一行未碰**（`package.json`、`index.js`、`ipc.js`、`store.js`、`app.js`、`uicheck.js`、`vendor/README.md`，以及新增的 `video.js` / `videotest.js` / **`vendor/ffmpeg/`**） |

> ★ **顺带说一句你可能会关心的**：工作区里出现了**未提交**的 `vendor/ffmpeg/`、`src/main/services/video.js`、
> `tools/videotest.js` —— 也就是**另一个并行会话正在给应用内置 ffmpeg / 做视频转码**。
> 这不是我这一轮做的（我一行没碰）。而项目记忆里记的是「**从不转码视频（无 ffmpeg）**，非 `.mp4` 只标 `manual`」——
> 这条结论**正在被推翻**。等你那边的方向定了，记忆和文档要一起改，别留着两套说法。
