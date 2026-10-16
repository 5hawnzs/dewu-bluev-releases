# 2026-10-17 残留发布页自动收掉 + 主/备用入口真机发版验收

## 问题（用户口径的「卡点」）
上一次中断（程序被关、报错、或用户自己停掉）会把得物留在**发布流程页**
（`TotalPublishProcessActivity` / `VideoEditActivity` / `UploadActivity`）上。旧行为是**直接拒绝**：
`当前停在可能含未完成内容的页面 X，不能自动返回以免保存草稿、丢弃内容或中断上传`。
后果是**之后每一批都在这里失败**，只能人工去把那一页点掉 —— 这正是用户说的「发布进程被中断、卡住」。

日志取证（另一台设备的真实失败记录）：`latest-publish.json` 里同一批反复出现
`没能准备得物首页或草稿箱发布入口：当前停在可能含未完成内容的页面 TotalPublishProcessActivity`。

## 实现
`src/main/services/entrydialogs.js`
- 新增 `inspectPublishExit(nodes)`：认发布页自己的返回确认条。**必须先认出提示语**
  （`确定要返回编辑吗|返回编辑吗|是否保存草稿`）才去找出口 —— 真机上发布页底部本来就有一颗
  `tvSaveExit「存草稿」`，只按文字找出口会点到它、空转（这条是写实现时实测踩到的，已注释记死）。
- 出口只认 **「保存并退出」**：它是唯一「内容不丢 + 又能离开发布流程」的按钮（内容进「我-个人主页」草稿）。
  另外两个（返回编辑 / 取消）不解决卡点，绝不替用户选。
- 真机取证：可点的是**容器**不是文字（`tvSaveDraft` 的 `clickable=false`，可点的是同区域的
  `layoutSaveDraft`）⇒ 按文字找节点，再挑「中心点落在它身上的可点容器」。
- 新增 `hasUploadInFlight(nodes)`：这一屏正在上传/发布 ⇒ **一个键都不按**。
- 新增 `rectOf(node)`；导出 `inspectPublishExit` / `hasUploadInFlight`。

`src/main/services/adb.js`
- 新增 `leaveUnfinishedPage({serial, focus, pkg, budgetMs, note})`，三条判据：
  ① 正在上传/发布 ⇒ 不按键，如实停批；
  ② 先按返回让页面自己弹确认条，出现「保存并退出」就点它（**只点一次**）⇒ 无损退出，本批继续；
  ③ 拿不到那个出口 ⇒ 照旧拒绝（保护不变），并说清「没有不丢内容的出口」。
- `ensureApp` → `navigateInside` 里原来「直接拒绝」的分支改成先走 `leaveUnfinishedPage`；
  `ensureApp` 新增可选 `onNote`，把「已按页面自带的『保存并退出』退出」这件事写进运行日志
  （内容进草稿不是被丢掉，用户要看得见）。

`src/main/services/publisher.js`
- 两处 `ensureApp` 调用传 `onNote`。
- **提速**：备用入口的「清掉上一轮『是否继续编辑』弹窗」那一次读屏，结果直接当下一跳
  （点「动态」）的页面结构用（`runStep` 新增可选第 5 参 `presetXml`）。同一屏不再抓两次 ——
  这一条把 `albumreadytest` 的「没有弹窗不新增抓屏」判据从 4 次读屏拉回 **3 次**（原有口径）。

## 行为验证
夹具/契约（`node tools/*.js`，全部 exit 0）：
- `publishcontinuationtest` 4 → **27 项**。新增 4 组用例钉住新口径：
  ① 三种发布流程页**没有**可用出口时：停批、**不盲点**（`input tap` 一次都没有）、不 `am start`/`am force-stop`、
     不推素材（允许按返回探查 —— 那是唯一安全的探查手段）；
  ② 确认条里有「保存并退出」⇒ 点它一次，本批**照常发完**，且除三跳入口外**一次多余的点都没有**
     （钉住「必须先认提示语」：不认就会点到发布页自带的「存草稿」）；
  ③ 确认条里只有「返回编辑 / 取消」⇒ 停批，绝不替用户选；
  ④ 这一屏正在上传 ⇒ **连返回都不按**；已经停在确认条上 ⇒ 不重复按返回，直接点掉。
  另有两处旧断言按新口径更新（`!/input /` → `!/input tap/`），判据本身（后台首页不绕过编辑页保护）不变。
- `diagnosticstest` 夹具补上 `adb.js` 新增的 `./uimap`、`./entrydialogs` 两个依赖（12 项）。
- `publish-contenttest`：原来只打 JSON、一句 `PASS` 都不打，而 `run-all.js` 按 PASS 行数计数
  ⇒ 这 12 条（6 个素材复核场景 × 主/备用入口）**被误判成没过**。现在断言即 PASS 行（3/3/3/1/2/2 项）。
- `adbtest` 449 项、`albumreadytest` 90 项、`transitiontest` 28 项、`publish-transitiontest` 10 项、
  `publish-sequencetest` 4 项、`frontendstatetest` 11 项 —— 全过。

**真机实测（MuMu 12 / 得物 6.0.5 / 127.0.0.1:16384，走生产代码 `publisher.run`）**
1. 起手设备**正停在**含未完成内容的发布页。主入口真发布：
   `[warn] 收掉上一次中断留下的发布页：按页面自带的「保存并退出」退出（内容会存进「我-个人主页」的草稿，不会丢），继续本批`
   → `行 1[视频] 发布完成（耗时 70.2s）` → **1 条 / 0 失败**，总耗时 76.6s。
2. 主入口发完后设备留在草稿箱，**备用入口**那一轮会沿用草稿箱出口（没有真走相机），
   所以先把 App 退回首页再重跑：`当前账号页面没有「主页」按钮，切换动态流相机入口`
   → `已通过动态流相机进入发布流程，跳过账号主页入口` → **1 条 / 0 失败**，总耗时 89.3s。
3. 结论：**主入口与备用入口都在真机上真实发布成功**，且新口径在真机上按设计生效。

完整回归 `node tools/run-all.js`：全部通过（日志 `../.local-runall-final.log`）。

## 顺带结论：另一个设备的 `p.join is not a function`
失败记录 `machine_id=m_fb6e1a86`（批20261016-2143，12.2s，图文）只有原因串、没有堆栈。
对所有能拿到的构建做了取证：
- 装上机 `resources/app.asar`（2117 个条目、1494 个 JS 全量解包扫描）里 `p.join(` 只有 2 处，
  都在 `node_modules/libheif-js/libheif-wasm/libheif-bundle.*` 的 `var p=new Array(l); a=p.join("")`，**是安全的**；
- 今天全部 7 份备份包（2026101606–12）、`app.asar.unpacked`、仓库 `src`/`tools`、`D:\work` 下各版本
  都没有可疑的 `p.join(`；只有老的 `D:\work\dewu-bluev-publisher\node_modules\oauth-sign`（Twitter OAuth 签名，本仓库已不依赖）。
⇒ 这一条**不属于当前代码**（很可能是另一台设备上更早的构建，或旧依赖链）。
另外确认：行级异常**不会**中断整批（`publisher.js` 的 catch 只在 `ALBUM_*`/`UI_COORDINATES`/`PUBLISH_*`
这几类上置 `stoppedReason`），所以它的影响面是「那一条失败」，不是「整批卡死」。

## 实际限制与仍未做的
- 已测量的耗时大头（真机）：`选择并核验视频封面` 11.6–12.3s、`选视频后的转场` 8.2–11.4s、
  `右上角「主页」（已在主页 tab 则跳过）` 12.7s、`未完成草稿拦截 · 点「放弃」` 6.3s、`好物1 · 选结果第 1 格` 6.1s。
  其中守卫步那几秒是**首次遇到不 idle 的某一屏**的代价（按步骤名学习后同批不再付）；要再降只能改成
  「按前台 Activity 学」，属结构调整，本次没做。
- 上一轮真机发布用的是**已经发过一次的同一篇内容**（用户授权以历史内容复测）。产品口径「已回写报告的内容
  不会再被引用」由 `publisher.runBatch` 只处理 `result !== '发布成功'` 的行保证，本次未改动该逻辑。
- 未在**真实无主页账号**上验证（本机账号有主页，只能用 `--route=fallback` 强制走相机那一段）。

---

# 追加（同一天更晚）：`0x80000003` 弹框 = 图形进程崩了带走整个程序

## 用户报的现象
两张 Windows 弹框截图：
- `electron.exe - 应用程序错误`（02:03，开发态）
- `得物蓝V素材发布工具.exe - 应用程序错误`（02:47，装机版）

正文一样：`应用程序发生异常 unknown software exception (0x80000003)，位置为 0x00007FF…6E49`。
两次都落在「正在替换安装内容」的时间窗里（unpacked 02:42:30、asar 02:50:58），所以一开始怀疑是半拷的原生件；
取证后**主因不是它**，见下。

## 根因（本仓库自己早就记过，只是没落到正式包上）
`0x80000003` 就是 `int3`，Windows 上对应 `__debugbreak()`。远程桌面 / 向日葵这类环境里 GPU 进程会反复退出，
Chromium 数到上限走 `LOG(FATAL)`：

```
FATAL:gpu_data_manager_impl_private.cc(449) GPU process isn't usable. Goodbye.
```

Windows 上 `LOG(FATAL)` 就是 `__debugbreak()` ⇒ 弹 `unknown software exception (0x80000003)` 并且**整个程序退出**。
发布跑到一半被它带走，表现就是用户说的「发布中断 / 卡死」。

证据链：
- `bluev-adb-fix/docs/knowledge/archive/worklog/2026-09-30.md:80` 记的就是这条：
  `FATAL:...GPU process isn't usable. Goodbye.`（退出码 2147483651）→「加 `--in-process-gpu --disable-gpu` 即活」。
- `tools/run-all.js:62` 的 `ELECTRON_FLAGS` 也写着同样的理由 —— **但只加给了自检脚本，正式包一直没加**。
  所以自检永远是绿的、用户那边照旧崩，这正是「为什么一直有这种报错」的答案。
- 事件日志/WER 里没有我们 exe 的 `0x80000003` 记录（只有 AweSun 的 `0xc0000005`）⇒ 不是被 WER 记档的通用崩溃，
  与「未捕获的 C++ 异常」不符，更符合 `__debugbreak`。
- 安装目录 `debug.log` 有 crashpad `TransactNamedPipe: 管道的另一端上无任何进程 (0xE9)`；最后一条为 00:32，
  修复版覆盖（02:50）之后不再新增。

## 实现（TDD：先红后绿）
新增 `src/main/startupflags.js`（`wanted()` / `apply()`）：
默认 `disableHardwareAcceleration()` + `appendSwitch('disable-gpu','in-process-gpu')`；
口子 `--enable-gpu` 或 `BLUEV_ENABLE_GPU=1/true`（空串、`0` 不算）；ready 之后才调用则返回 `reason:'late'`
并**如实记一条日志**，不假装生效。

新增 `src/main/crashguard.js`：crashpad 转储落 `userData/crashdumps`（`uploadToServer:false`），
监听 `child-process-gone` / `render-process-gone` / `uncaughtException` / `unhandledRejection`；
全部 try/catch，日志通道坏了也不影响运行；**主进程异常只记录不退出**（不能让留档机制帮倒忙）。

`src/main/index.js`：这两件事都在 `requestSingleInstanceLock()` 与 `app.whenReady` **之前**做完
（实测位置：guard 1263 / apply 1418 / whenReady 2174）—— 开关挂晚了 Electron 不认。

自检：`startupflagstest` 6 项、`crashguardtest` 7 项、`deployguardtest` 5 项（`tools/run-all.js` 已登记）。

## 真机 A/B（同一台机器、同一个已安装的 exe）
| 启动方式 | 进程总数 | gpu-process | crashpad-handler | renderer |
| --- | --- | --- | --- | --- |
| 默认（修复生效） | 4 | **0** | 1 | 1 |
| 显式 `--enable-gpu` 对照 | 5 | **1** | — | — |

⇒ 开关真的在起作用，不是碰巧。

## 覆盖与发布摘要
- 构建：`node tools/prepare-distribution.js` → build **2026101613**、262864643 字节、
  `sha256 5e7ee59561246737e85dff8d47ae6c17030c2def1fb9e35f5f6217fdddbb7aef`。
- GitHub 分发通道：已发布 `v1.1.2-build.2026101613` 并更新 `latest.json`（上一版线上是 2026101605）。
- 本机覆盖：`prepare-publish-confirmation.cjs`（1787 文件核验、替换 src/ 72 文件）→
  `apply-publish-confirmation.cjs` PASS；装后 asar `BUILD=2026101613`，
  原生件自检 `unpacked-check.json` problems 0（顺带清掉上一次覆盖误拷出来的
  `resources/app.asar.unpacked/app.asar.unpacked` 重复副本：100 个文件 / 20.6MB）。
- `tools/apply-publish-confirmation.cjs`：装完追加原生件自检，不通过即回滚（父仓库脚本，不提交）。

## 最终代码上的备用入口真机复验（本轮）
走用户自己的**已安装 App**（`--remote-debugging-port=9222`，通过 CDP 点真实按钮）：
报告 `video-app-acceptance/AI内容报告_备用1613复核.xlsx`（单条视频、
素材 `E:\bluev_beta\flat_20261002-2329\3261132028+米白色12_1`），设备 `127.0.0.1:16384`。

- 点「开始试发」→ 日志第一条就是
  `强制备用入口：定位表里没有「动态」页签步骤，仍按内置的动态流相机入口走`；
- 21 个阶段全部 `ok`，包括 `选视频后的转场 · 等到设置封面页 8.1s`（其间点「下一步」2 次并确认目标屏）、
  `选择并核验视频封面 12.7s`、`提交发布 4.5s`、`等待提交退出 0.75s`；
- 结果：`发布成功【目标 1 条，成功 1 条，失败 0 条】`，单条 70.8s、整批 71.4s，报告已回写（1 行）。

## 逐段转场夹具复核（本轮重跑，主入口 / 备用入口各一遍）
`transition-audit-20261016/*.json`（02:52 重跑，正反例成对）：

| 场景 | 主入口 | 备用入口 | 判定 |
| --- | --- | --- | --- |
| 确认标题后提交（正例） | ok 1 / fail 0 | ok 1 / fail 0 | 提交 1 次，正常收尾 |
| 选材不足自动补选（正例） | ok 1 / fail 0 | ok 1 / fail 0 | 点「下一步」1 次后提交 |
| 目标节点读不到（反例） | 停批 | 停批 | 保留现场，**一次都不盲点、不提交** |
| 同页重建节点（反例） | 停批 | 停批 | 有限重读后仍无法确认 ⇒ 停批 |
| 只选到 1/3 张图（反例） | 停批 | 停批 | 不许把「部分选中」当成功 |
| 标题无法确认（反例） | 停批 | 停批 | `etTitle` 读不到 ⇒ 停批 + 保留现场 |

正例全绿、反例全部**停批而不是瞎点**：用户报的那几种「找不到节点 / 继续编辑提示」对应的都是
「读不到就必须停下、保留现场」，不会再出现「悄悄提交了错内容」或整批无声卡死。

## 更新日志页（用户口径的回归点）
装机版「应用更新」页实测：版本 chip 显示 `v1.1.2 · 构建号 2026101613`；
整页文本里 `备用入口` / `试发` 均为 **false**；10 月 17 日只列三条核心标题，
新增的第一条是「稳定性：图形环境异常时程序不再整体退出，发布不会中途中断」。

## 仍未做 / 限制
- 反例夹具是**故意注入**的（喂进去的 dump 里真的没有目标节点），它验的是「读不到时的行为」，
  不代表真机上会出现这些画面；真机的主/备用入口两条路本轮都已真实发布成功。
- 本轮没有再动发布链路本身（`publisher.run` 未改），只加了进程级开关与崩溃留档；
  提速项（`选视频后的转场` 8–11s、`选择并核验视频封面` 12s、守卫步首屏 6s）保持 99b9dbb 的状态，未继续优化。
- 备用入口复验用的是**已经发布过的同一篇历史内容**（用户授权：已回写报告的内容拿来复测，
  不会再次被引用）。产品侧「已回写的不再引用」由 `publisher.runBatch` 只处理
  `result !== '发布成功'` 的行保证。
