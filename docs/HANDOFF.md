# 交接文档 · 得物蓝V 素材发布工具（Windows 桌面版）

> **这一份就是全部交接内容**，包含：交接会话、硬约束、环境坑、已完成、待办、回归要求，
> 以及**真机演示录屏的完整拆解**（原 `VIDEO-DECODED.md` 已并入本文 §7、§8）。
>
> 最后更新：2026-09-30

---

## 0. 怎么用（30 秒）

新建任务时：

1. 工作区打开为 **`/Users/shuo/CodeBuddy/得物蓝v发布app`**（工程在子目录 `dewu-bluev-publisher`，不要打开到工程里面，
   这样本文档、快照、工程都在视野内）；
2. 把下面这段粘进去当第一条消息：

```text
接手 /Users/shuo/CodeBuddy/得物蓝v发布app/dewu-bluev-publisher（Electron，Windows 素材发布工具）。

第一步：完整读 dewu-bluev-publisher/docs/HANDOFF.md 与 README.md，按里面的约束和待办干活。
特别记住四件事：
① 这个文件夹不要改名/移动（应用与构建产物里有绝对路径）；
② 有另一个任务也在改这个工程，src/renderer/app.js 与 src/main/store.js 是重叠文件，只用局部替换、禁止整文件重写；
③ 每改一处必须跑回归（契约见文档 §6，入口 `node tools/run-all.js`）；
   ⚠️ **跑回归时不要设 `BLUEV_NO_LOGIN`** —— `logintest` 专门断言「登录门默认开启（这个变量没设）」，
   外部设了它会失败并**挂住不退出**（实测：设了 3 条 FAIL + 超时；不设 32 项全过）。
   那个变量只用于**手动跑 App**（免登录进主界面）；`uicheck.js` 自己会在进程内设好，不需要外面设；
④ 注释与界面文案用中文，失败要说清「缺什么」，不允许造假成功。
真机口径已固化在文档 §7/§8，不要重跑 OCR。
```

> 想更"重"一点也行：把 §1 的完整会话直接粘贴。**但优先推荐上面这种**——文档改了提示词不用改，单一事实来源。
>
> **在 Windows + 雷电模拟器上测整体流程**：本文档 §0~§3 里的工作区路径与环境坑都是 macOS 侧的，
> 直接照 [`WINDOWS-E2E.md`](WINDOWS-E2E.md) 走（那份第 0 节有给 Windows 端 WorkBuddy 的第一条消息）。

---

## 1. 完整版交接会话（可选，粘贴用）

<details>
<summary>点开复制</summary>

```text
接手「得物蓝V 素材发布工具」后续开发。

【工作区】/Users/shuo/CodeBuddy/得物蓝v发布app
工程在子目录 dewu-bluev-publisher。先读 dewu-bluev-publisher/docs/HANDOFF.md 全文，再读 README.md，最后看 src/。

【硬约束，先看再动手】
1. 这个文件夹不要改名、不要移动。应用配置与构建产物里存的是绝对路径，改名会让工作区/快捷方式/config.json 的 paths.* 全部失效。
2. 有另一个任务同时在改这个工程。src/renderer/app.js（约 51KB）和 src/main/store.js 是双方重叠文件：
   编辑前先确认归属；只用局部替换，禁止对这两个文件整文件重写。
3. 另一个任务的产物请勿改动：src/main/auth.js、index.js、ipc.js、preload/index.js、renderer/index.html、renderer/styles.css
   （本机登录门，auth:* 通道，guard() 会拦截未登录的任务调用）。跑自动化测试时用环境变量 BLUEV_NO_LOGIN=1 绕过登录。
4. 回滚点：/Users/shuo/CodeBuddy/得物蓝v发布app/_snapshot-20260930-1447.tar.gz（含 src + package.json + README）。

【环境】
- node 20.18.0：export PATH="/Users/shuo/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH"
- 本机 Electron 二进制会因签名问题被 SIGKILL，需要先：
  xattr -cr node_modules/electron/dist/Electron.app && codesign --force --sign - node_modules/electron/dist/Electron.app
- 打 Windows 包：npm run dist:win（会先取 win32 版 sharp 预编译包，macOS 上可交叉打包）

【已完成，不要重做】
见文档 §4。

【待做，按优先级】
见文档 §5。

【硬要求：每改一处都要跑回归】
见文档 §6。

【风格】
注释与界面文案用中文；失败必须说清「缺什么」，绝不静默成功。
这条踩过坑：模拟器发布的 adb 通道曾写死 ok=true（一律报成功），属于伪造结果，已修，不要再引入类似写法。

【真机口径】见文档 §7（拆解）与 §8（差异总表）。不要重跑 OCR，证据已存档。
```

</details>

---

## 2. 硬约束（先看）

1. **不要给 `得物蓝v发布app` 改名/移动**。应用内保存的是绝对路径（`config.json` 的 `paths.source/output/rejected`、
   `project.json` 的 `sourceDir/sheet.file`、输出目录下的 `pending-results.json`）；Windows 快捷方式也是绝对路径。
   改名会导致：素材整理扫不到、隔离目录不存在、发布单回写落到别处、暂存结果"看不见"。
   万一改了，重建软链接即可：`ln -sfn "/新路径/dewu-bluev-publisher" "/Users/shuo/CodeBuddy/20260929152625/dewu-bluev-publisher"`
2. **另一个任务在同一棵树上工作**，重叠文件是 `src/renderer/app.js`（~51KB）、`src/main/store.js`。
   只用局部替换，**禁止整文件重写**这两个文件；同一时间只允许一方编辑 `app.js`。
3. **它的产物不要动**：`src/main/auth.js`、`index.js`、`ipc.js`、`preload/index.js`、`renderer/index.html`、`renderer/styles.css`
   （本机登录门：`auth:*` 通道，`guard()` 拦截未登录的 `job:run` 等调用）。   默认管理员 `admin / BlueV@2026`；
   手动跑 App 想免登录：`BLUEV_NO_LOGIN=1`（**只限手动跑**；跑回归不要设它，原因见 §2 第 3 条）。
   登录门本身已有回归：`tools/logintest.js`（59 项，见 §6）—— 覆盖未登录拦截、口令只存哈希、记住登录、
   权限、防爆破、退出；**改这几块之前先跑它**。
4. 回滚点（都在工程外，不打进安装包）：
   - `_snapshot-20260930-1510.tar.gz` —— **含 ①②③④ 的改动**（src + package.json + README + docs + tools）
   - `_snapshot-20260930-1447.tar.gz` —— 这批改动**之前**的状态（含另一个任务的登录门）
5. **自动更新有两条「不许顺手加上」的红线**（`src/main/updater.js` 文件头也写着，改那儿之前先读）：
   a. **绝不自动重启安装**。这工具随时可能在跑批量发布（一跑几十分钟），静默重启会把任务拦腰截断、而且**没有回滚**。
      `autoInstallOnAppQuit` 也必须是 `false`（否则用户下次关窗口时会被装上）。
      安装只能由用户点「立即安装」，而且**有任务在跑时必须拦住**（已经拦在 `ipc.js` 的 `update:install` 里）。
   b. **不在运行时改「源地址」**（`setFeedURL`）。地址编译进 `resources/app-update.yml`，改了等于把已装的
      客户端指到别处甚至直接失联，只能重发包。
      ★★ **但「通道名」是可以在运行时改的，而且是官方 API** —— 2026-10-01 起正式版 / 测试版就是**同一个包**
      靠运行时切 channel 实现的（`updater.js#setChannel`），**不是**靠两个源地址：
      · 源码依据（`node_modules/electron-updater/out/`）：`GenericProvider.get channel` 取
        `updater.channel || configuration.channel`；文件名 = `${channel}.yml`，拼到 `configuration.url` 后面；
        `AppUpdater` 有公开的 `set channel()`，注释原话「Overrides `channel` in the update configuration.」。
      · ⇒ 同一个桶根目录下，正式版读 `latest.yml`、测试版读 `beta.yml`。**源地址永远不变**，
        所以切换不用重装、也不会失联；隔离性也没被破坏（正式版用户读的一直是 `latest.yml`，测试版是显式 opt-in）。
      · ⇒ 于是 `tools/upload-release.js --channel beta` 传的是**桶根的 `beta.yml`**（不是 `beta/` 子目录）。
      · ★ **降级**：`set channel` 的 setter 会顺手把 `allowDowngrade` 设成 true，代码里显式压回来了 ——
        只有「测试版 → 正式版」那一次放行（不放行就切不回去），其余时候**禁止降级**，
        免得源上被人放个旧包就把正式版用户悄悄降下去。`upload-release.js` 另有一道「不许往回发版本」的闸门兜底。

## 3. 环境与已知坑

| 坑 | 表现 | 处置 |
| --- | --- | --- |
| 本机没有 node | `command not found` | `export PATH="/Users/shuo/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH"` |
| Electron 二进制被杀 | 启动即 `SIGKILL`（无其它输出） | `xattr -cr` + `codesign --force --sign - node_modules/electron/dist/Electron.app` |
| 交叉打 Windows 包 | 包里带的是 macOS 版 sharp → Windows 上 HEIC 失效 | 已用 `npm run addon:win` 强制取 `@img/sharp-win32-x64`，`npmRebuild:false` |
| 渲染层白屏 | `Identifier 'api' has already been declared` | `window.api` 是不可配置属性，顶层 `const api` 会冲突 → 用 `appApi` |
| 日志全抛错 | `logbus.push is not a function` | `logbus` 只导出 `info/ok/warn/error`，没有 `push` |
| 打包体积 | 含用不到的 darwin/linux sharp | `files` 里已排除 `**/@img/sharp-{darwin,linux}-*/**` |
| Swift/Vision 不可用 | `failed to build module 'CoreFoundation'` | 工具链与 SDK 版本不匹配；改用 ffmpeg + tesseract.js（见 §9）|

## 4. 已完成（不要重做）

- **素材整理**：扁平名用 `_` 连接原层级路径；**原素材完全不动**；同卷硬链接 / 跨卷复制；`\\?\` 长路径；被占用退避重试
- **合规检查**：必须 JPG、≥1764 像素²（42×42）、边长 150~1500、超限自动等比缩放、视频按扩展名判 `.mp4` 且 <600s、
  垃圾文件隔离到 `_rejected`；支持「**检查父目录**」（每个子文件夹独立出报告并分组）
- **文案生成**：F01–F10 标题格式轮换 + 话题组合代码去重 + 并发按路数均分 + 可接模型（不配则本地模板填空）；
  品牌、筛选排序提示词、文案生成提示词已进配置
- **货号颜色校验**：本地商品池 **或** 接口模式（SKU APIKey）；图片主色反查目录色名；判定文案对齐真机，接口查不到仅告警不阻断
- **发布单**：26 列 exceljs；回写时若 Excel 被 WPS 占用则**整批暂存** `pending-results.json`，下次运行先补写
- **模拟器发布**：真实 ADB 通道（推图 + 媒体扫描 + `uiautomator` 定位 + 点击/输入）；**设备矩阵**（一个设备=一个账号，可增删/检测/选用）；
  **固定 60s 间隔 + 倒计时**；**单条耗时**；失败存截图并**回退**；UI 定位表 `uiMap` 可抓取、可导入
- **2026-09-30 这一轮（原 §5 待办 ①②③④，已完成，别重做）**：多批次并行任务列表 · 合规报告导出 · 发布日志重导出 ·
  失败恢复动作界面可编辑；测试也一并收进 `tools/`（`bash tools/run-all.sh`，115 项断言）
- **2026-10-01 Windows E2E 轮（3 处真缺陷，已修 + 双向验证；完整记录见 `WINDOWS-E2E.md` §9）**：
  - `imaging.js`：init 改成 `sharp.cache({ memory: 64, files: 0 })` —— **关掉 libvips 的输入文件缓存**。
    Windows 上默认 `files:20` 会让合规的「等比缩放 / 压缩 / 转 JPG」在 `unlink` 源文件时**必报 EPERM**
    并残留 `.__tmp_scale_*.jpg`（这三条都是「写临时文件 → 删原文件 → 改名」三步）。
  - `jobs.js` 的 `sheet.export`：重建 `publish.rows` 时按 `id` 把上一批的 `reportRow` 带过来。
    丢了它 → 「先导出发布单、再发布」会把回写报告静默变成「已回写报告：0 行」（不报错，最容易漏）。
  - 新增 `winpath.isFileLockError()`，`report.js` / `sheet.js` 的 `mergeResults` 用它分流：
    **只有真锁错误**（EBUSY / EPERM / EACCES…）才「整批暂存、下次再试」；
    表头缺列这类不可恢复的错误必须原样报出来，不能伪装成「仍被占用」让人一直等一个补不进去的队列。
- **2026-10-01 视频发布支持（代码已实现；只差真机抓 `videoSteps`）**：图文/视频按报告的「内容类型」列分流、
  视频推完等媒体库索引、`uiMap` 增加 `videoSteps`、节奏参数按媒介分开。详见 §5 的「视频发布支持」一节。
  回归从 176 → **199** 项断言（`adbtest` 27→38→46、`reporttest` 28→32）。
- **2026-10-01 真机实测修掉两个静默隐患**：`adb.dump()` 抓不到结构时会拿**上一个页面**的 XML 冒充本页
  （后果是按旧坐标连点 + 报「发布成功」）；得物发布页长期不 idle 导致抓不到。
  两条防线 + 关动画兜底（并还原）见 §5「本次顺手修掉的隐患」。
- **2026-10-01 登录页去留白（界面改动）**：未登录时不再开一个 1280×820 的空壳窗，而是
  **收缩成刚好装下登录卡片的小窗**（`window.js` 的 `setLoginMode()` / `fitGate()`：渲染层量出卡片实际高度后回调收紧，
  提示行显隐导致的高度变化也跟得上）。登录成功自动还原成登录前的尺寸/位置（含最大化状态），退出登录再收回；
  **登录门期间的临时尺寸不写进 `config.json`**，免得「退出登录一次、下次启动窗口就变小了」。
  新增 `tools/gatetest.js`（13 项）守住这条链。
- **2026-10-01 登录成功后窗口会被推出屏幕（真 bug，已修）**：登录小窗是 `win.center()` 摆在屏幕正中的，
  登录成功还原时只 `setBounds({width,height})`、**位置还停在小窗的居中点上** ⇒ 尺寸一跳回 1280×820，
  窗口右下整块甩到屏幕外（1280×784 屏实测超出右 450px / 下 258px），主界面右边和底部被屏幕边缘切掉。
  新增 `fitToWorkArea()`：还原前把几何夹回所在显示器工作区（没记过位置就居中，尺寸超过工作区就缩到工作区），
  开场建窗时也先夹一次。`tools/gatetest.js` 补 2 条断言（行为级「登录后窗口完整在工作区内」+ 单元级
  「离谱几何必被夹回」），拆掉修复时两条都变红。
- **2026-10-01 登录页：卡片外的标题带 / 关闭按钮挪进卡片内（界面改动）**：上一版给无边框小窗加的那条
  独立标题带（左上角标题 + 右上角 ×）是 `position:absolute` 挂在**窗口顶部**的，而登录卡片自己有边框 ⇒
  这两处醒目地浮在卡片边框外面（用户实测反馈「这两个地方没有在灰色边框内」）。
  改法：删掉标题带；窗口拖拽区改用整块 `.gate` 遮罩（交互控件显式 `no-drag`，否则输入框点不进去）；
  关闭口缩进**卡片内部**右上角（`.gx`，24×24，距卡片边框四边各 17px）。
  卡片里的品牌行本来就写着「得物蓝V 素材发布工具」，那条标题带属于重复信息。
  `tools/gatetest.js` 补 2 条断言（「关闭按钮四边都落在卡片边框内」+「卡片外没有任何**可见**元素」），
  把「在卡片外再挂个浮层」这类改法永久拦住 —— 装回旧标题带时这两条必红。

- **2026-10-01 品牌权限 + 按品牌统计（发布频次 / 数量 / 执行日志）**：品牌很多，需要**按账号分配品牌权限**，
  管理员据此查看各品牌的发布频次、数量与执行日志。新增四块：
  - `src/main/brands.js` —— 品牌注册表 + 权限判定。品牌存 **id**（`brd_…`）、**名字随时可改**，
    账号上挂的是 id 列表 ⇒ 改名不会把已分配的权限弄丢；管理员 = 全部启用中的品牌。
    `resolveFor(user, wantedId, { required })` 是唯一的权限闸门：**指定的品牌必须存在、且必须是这个账号能用的**，
    否则报「没有「X」的操作权限」。产出类任务（`copy.generate / report.import / sheet.export / publish.run / publish.rerun`）
    **必须有品牌归属**：账号只分到一个品牌时自动带上（不让他每次都选），多于一个时**不替他挑**、明确要求先选。
  - `src/main/services/runlog.js` —— 执行日志落盘到 `<输出目录>/run-log.jsonl`。原来的 `logbus` **只在内存里、只留 500 条**，
    重启就没了，要按品牌查历史必须落盘。**故意不做自动轮转**（日志被悄悄删掉，比多占点磁盘严重得多）。
  - `src/main/services/stats.js` —— 按品牌聚合 + 导出。除了各品牌自己的条数 / 成功失败 / 按天频次 / 执行人，
    还有**「未标品牌」与「已删除的品牌」两个独立的桶**：历史记录里没有品牌的、以及品牌已被删掉的，
    **各占一行、绝不并进任何品牌**（合并就等于替它编一个归属）。`totals` 直接从累加器取，不是拿明细再求和
    （否则一加筛选，汇总和明细就对不上）。`exportXlsx` 出 4 个表：品牌汇总 / 按天频次 / 品牌×执行人 / 执行日志。
  - 归属记录贯通：`jobs.js` 在**实例化任务之前**就解析好品牌与执行人（被权限拦下的任务不会留下一条假日志），
    再一路带进 `ctx.brand` / `ctx.actor`、日志、`jobs.list()`、发布单批次，以及 `publisher` 写出的
    `publish-log.jsonl` **每一条**（含执行人）。**老记录没有品牌就是「未标品牌」，如实标出来，绝不拿某个品牌顶上。**
  - 界面：新增第 8 个页签「品牌统计」（**故意编号 8**，不动设置 / 测试页的既有编号）——品牌维度的条数 / 成功失败 / 按天频次条、
    「谁发的」、跨品牌汇总、执行人汇总；标题栏加品牌下拉（单品牌自动选中、没有可用品牌时变黄提示）。
    「设置 → 品牌管理」增删改品牌；「设置 → 账号管理」给每个账号勾选品牌。
  - **按品牌的文案提示词（2026-10-01 追加）**：`brands` 增加 `promptWrite` / `promptFilter`。
    点「文案生成 → 提示词配置」**直接弹窗**（品牌名 / 两段提示词 / 是否启用 / 本次选用），不再跳去设置页。
    改前那对 `copy.promptWrite` / `copy.promptFilter` **从来没被任何代码读过** —— 填了不生效，
    这正是「点了看不懂」的根源，已经把那两个裸输入框撤掉。现在真进 system：
    **品牌模板在前**（角色 / 调性 / 写什么），**程序固定的输出约束在后**（JSON 字段名、标题字数）；
    分开是有意的 —— 写模板的人只管内容，解析器依赖的硬约束由代码兜住，漏一句就会让整批 `JSON.parse` 失败而现象像「模型不听话」。
    没配提示词的品牌跑 `copy.generate` **在实例化任务之前就被拦下**（`jobs.run`），`copywriter.generate` 里再兜一道；
    **被拦下的任务不留台账**。提示词**非管理员也能改**（限自己有权限的品牌，且只开放这两个字段），
    改名 / 启停 / 删除仍归管理员。⚠️ 「筛选排序提示词」**当前没接进任何流程**（工具里没有素材筛选 / 排序这一步），
    只是先按品牌存着，弹窗里也这么标着 —— **别当成「配了就有效果」**。
  - ⚠️ **本机权限不是安全边界**：`auth.json` / `config.json` 就在本机 `%APPDATA%` 下，能进这台机器的人可以直接改。
    这套权限的真正作用是**防误操作 + 让统计能对账**，不是防内部的恶意越权；真要隔离得上服务端（当前没有服务端）。
  - 回归：新增 `tools/brandtest.js`（58 项）；`uicheck` 19→23、`logintest` 32→48；合计 **216 → 294** 项断言。
    随后加文案提示词，又补到 `brandtest` 69、`uicheck` 27、`logintest` 58，合计 **319** 项。
  - 再往后加**自动更新**（2026-10-01，见 §2 第 5 条）：新增 `tools/updatertest.js` 与
    `tools/releasetest.js`，`uicheck` 27→29、`logintest` 58→59 ⇒ 合计 **379** 项断言（实测）。
  - 随后接上**测试版通道**（同一个包、运行时切 channel，见 §2 第 5 条 b）：
    `updatertest` 29→48、`releasetest` 28→47、`uicheck` 29→32 ⇒ 合计 **420** 项断言（实测）。

## 5. 待做（按优先级）

> ①②③④ 已于 2026-09-30 完成，实现位置与回归见下面各条；⑤ 明确**不做**（那条地址只是录屏里的示例后台）。

1. ~~**多批次并行任务列表**~~ ✅ **已完成** —— `src/main/jobs.js` 把 `byType` 单例 map 换成任务实例化：
   `running: id → job{id,type,label,batch,token,progress,startedAt}`，`PARALLEL_TYPES` 里的类型（目前是 `copy.generate`）
   不同批次可同时跑，同批次不会起两次；`jobs.list()` 给「运行中的批次」，`jobs.cancel(id)` 停单个、`jobs.cancel(type)` 全部取消。
   批次级文案生成的素材清单自带（`args.sourceDir`），产物各写 `输出目录/batches/<批次>/copy.json`，**不碰**当前项目的单例状态。
   界面：文案生成页 / 模拟器发布页都有「运行中的批次」表格（批次名 · 进度 · 已用时 · 查看详情 / 取消任务 / 全部取消）；
   「查看详情」按 `meta.batch` 从日志总线里筛出该批次这一步的日志。
   启动时用 `job:busy()`（不传类型＝返回清单）对齐状态，刷新页面也看得见在跑的任务。
   ⚠️ 没走新 IPC 通道（`ipc.js`/`preload` 是另一个任务的产物，不动），全部复用 `job:run / job:cancel / job:busy` 三个既有通道。
2. ~~**合规报告导出文件**~~ ✅ **已完成** —— `compliance.exportReport()` → 输出目录 `合规报告_<时间戳>.xlsx`
   （`汇总` 按子文件夹 + `明细` 全量两个工作表）与同名 `.csv`（带 BOM，Windows 双击不乱码）；
   合规页右上新增「导出报告」按钮，导出后自动在资源管理器里定位文件。
3. ~~**发布日志「重导出日志」~~ ✅ **已完成** —— `sheet.exportPublishLog()` → `发布日志_<批次>_<时间戳>.log`（对齐真机的日志行
   `[V] 行 2 [图文] 发布完成，已回填时间 15:34:41（耗时 65.2s）`）+ 同名 `.csv`；不传批次则导出全部并分段。
   `publisher.run` 现在把批次名写进每条 jsonl 与结果（批次默认取发布单文件名），发布页右上新增「重导出日志」按钮。
4. ~~可选：`uiMap` 的恢复动作做成界面可编辑~~ ✅ **已完成** —— 发布页新增「失败恢复动作」：文本框直接编辑 `uiMap.recover`
   （默认给一条示例 `[{"name":"删除卡片","action":"tapText","value":"删除"}]`，没配过也不用猜格式）。
   校验放在主进程 `uimap.normalizeRecover()`：只认 `publisher.recover` **真正会执行**的 `tapText / tapId / tapDesc / wait`，
   写错 action、value 为空、wait 不是毫秒数都会**报错并列出可用值**（不静默跳过 —— 跳过等于「以为回退了，其实没有」）；
   保存走 `publish.setRecover`，只改 `recover` 字段，不动 `steps`。`publisher.recover` 运行前也会再校验一遍，
   拦住手改 `config.json` 或导入旧定位表的情况。
5. **不做**：颜色数据源直连 —— ⚠️ **`https://dw.shike.tech/sku-color` 只是录屏里出现的示例后台，不要访问、不要抓取、不要对接**
   （无凭据、也不是我们的系统）。现实现的做法保持不变：支持导入 CSV/JSON（商品池），或走 `verify.mode=api` + SKU APIKey 调**自己**的接口；
   录屏里那份 Shike BI 后台的列结构仅作列名参考（spuID / skuID / 货号 / 原始规格 / 系统提取颜色 / 人工校正颜色 / 系统提取尺码）。

### 从录屏里挑出的「可抄项」（尚未做，按建议顺序）

| # | 真机怎么做 | 我们现在 | 建议 | 成本 |
| --- | --- | --- | --- | --- |
| 6 | ~~**环节之间用 Excel 交接**：上游产出 `AI内容报告_<ISO时间戳>.xlsx`，颜色预检读它、并把结果写回「执行结果」列~~ | ✅ **已实现「导入 AI 内容报告」**（见下方说明） | — | 已完成 |
| 7 | ~~**品牌管理**：多品牌可新增/编辑/删除（`skechers`…）~~ | ✅ **已实现，且做成了「按账号分配品牌权限 + 按品牌统计」**（见 §4 最后一条与下方说明） | — | 已完成 |
| 8 | 文案结果预览顶部「**共发现 46 个有效文件夹**」，每行带媒介与条数（`图 图文 10` / `口 视频 2`） | 表格只有目录/货号/标题/状态 | 加一行汇总；每行统计 `files` 里的 image / video 数量 | 小 |
| 9 | 合规页有「**取消检查 / 重新选择目录 / 打开文件夹**」 | 只有 4 个按钮（`app.js` TABS[2]）；取消得去发布页 | 给 `job:cancel` 加个按钮（通道 `job:cancel` 已存在，不用动 ipc） | 小 |
| 10 | 素材整理页有「选择素材根目录」+「**选择目标输出目录**」 | 扁平副本固定放在**源目录同级** `flat_<时间戳>`（`flatten.js:114`） | 可加目标目录，但必须提示：**跨卷会从硬链接退化成实体复制**（慢、双倍占用）；默认保持同级 | 小 |
| 11 | 发布单有「**素材来源**」列 | `sheet.js` COLUMNS 有「素材路径」，没有「来源」 | 加一列（`buildRows`） | 小 |
| 12 | 顶部固定「**推荐流程**」步骤条：素材整理 → 素材合规检查 → AI文案生成 → 好物货号颜色预检 → 自动发布 | 左侧 8 个页签，没有步骤引导/完成态 | 侧栏加步骤序号与状态（数据都在 `project` 里，可算出来） | 小 |
| 13 | 措辞：「**好物货号颜色预检**」「**自动发布**」「**必须为 JPG**」 | 「货号颜色校验」「模拟器发布」 | 纯文案对齐，减少与运营的沟通成本 | 极小 |

> **第 6 项已完成（2026-09-30）——「导入 AI 内容报告」**（`src/main/services/report.js` + `report.import`）：
>
> - 表的**列名**识别（列顺序无关）：`素材路径 / 素材来源 / 标题 / 文案 / 内容类型 / 好物1~9_货号+颜色`
>   —— 真机那份 26 列报告和我们自己导出的发布单**都能吃**；
> - 报告的「素材路径」是**绝对路径**（如 `D:\卡宾\20260901`）；**空的时候**会用「导入时选的批次目录」补
>   （真机那份样本 49 行的素材路径就是空的 → 界面会追问一次目录）；
> - **一条内容 = 一个叶子文件夹**（与第一步素材整理同一口径）；同一个路径下的叶子只展开一次，
>   **行数 ≠ 叶子数直接报错**并说清「这个路径下有几个叶子、报告里有几行指向它」，绝不猜着配；
> - 标题/文案：报告里有就用，空的由 `copywriter` 本地生成；好物带全（颜色可为空）；
> - 含视频 / 没图片的叶子标成「校验未通过」并写明原因（真实通道目前只推图片），**不静默丢**；
> - 发布结果回写报告的 **B「实际执行时间」/ C「执行结果」**；被 WPS 占用时整批暂存、下次先补写
>   （`pending-results.json` 按目标分队列：`sheet` / `report`，互不覆盖）；
> - 回归：`tools/reporttest.js`（28 项）。

> **第 7 项已完成（2026-10-01）——「品牌权限 + 按品牌统计」**：真机那版是「在设置里维护一份品牌清单」，
> 我们按实际需求做成了**按账号分配品牌权限**（品牌多、要分人管）+ 品牌维度的统计。
> 实现清单与取舍见 §4 最后一条。**这里刻意没照抄它建议的 `copy.brands: [{name, pool}]`**，两个理由：
> ① 商品池（`pool`）已经存在，品牌不需要再挂一份，两者本来就不是一回事；
> ② 那版要的是「一个全局品牌清单」，而这次真正要的是**每个账号能操作哪些品牌**（权限），不是换个地方列品牌。
> 所以做成 **扁平的 `brands: [{id, name, enabled}]`（权限记 id、名字可改）+ 账号上的 `user.brands: [id]`**。

> ⚠️ 上表剩下的 **#8~#13 是「产品功能待办」**（真机有、我们还没有），**不属于测试范围**；
> 要做请另开一轮，并按 §6 每改一处跑一遍 `node tools\run-all.js`。
> 其中 #11（发布单加「素材来源」列）已由 WINDOWS-E2E §6 的结论确认「暂不加」，理由见那张表。

> 录屏里**已经对齐**的（不用再做）：扁平命名 `_` 连接、原素材完全不动、合规四条规则、父目录分组、「导出报告」、
> 颜色预检 5 种判定文案、设备矩阵、固定 1 分钟间隔 + 倒计时、单条耗时、Excel 占用暂存、失败回退、重导出日志、多批次并行。

### 本次顺手修掉的隐患（不属于待办，但会出错）

- **`adb.dump()` 会用上一个页面的结构冒充本页**（真机实测，最危险的一条）。
  `uiautomator dump` 失败时**不写文件**（实测：页面不 idle 时目标文件仍是上一次的 47 字节哨兵，一字未动），
  而原实现是「共用一个远端路径 → 抓完直接 `cat` → 不检查 dump 的返回」⇒ 失败时 `cat` 出来的是**上一个页面**的 XML，
  `/</` 校验照样通过，于是返回给调用方。后果不是报错而是**静默点错**：
  定点破坏还原成改前版后实测 —— 抓不到结构时它**拿着上一页的坐标连点 5 次**，并把结果标成「**发布成功**」。
  现在做了两条独立防线：① 抓之前先 `rm -f` 远端文件；② 检查 `uiautomator dump` 是否真的回了 `dumped to`，
  不是就走「失败」通道（`dumpEx` 会带回**原因**）。见 `tools/adbtest.js` 的 ⑨~⑫。
- **得物发布页长期不 idle**：进页面后 `ERROR: could not get idle state.`，实测连续 60 次（约 10 分钟）全失败；
  只把 `animator_duration_scale` 置 0 → **同一秒**成功。所以 `dumpEx()` 在「不 idle」时会**临时关掉三个动画开关、
  重试一次、无论成败都在 `finally` 里还原**（不把用户设备的设置留在改过的状态）。
  ⚠️ **不要写成「关掉三个动画是标准解法」**：单变量 A/B 实测在动画=1 时同一页面也能抓到（页面稳定后就不受它影响），
  关动画只是**打断当前正在跑的那个循环动画**的手段，不是根因。
- `compliance.scan`：合格 JPG 走完规则后又被追加了一条「不支持的扩展名 → 隔离」，
  `fix()` 照着做会把**好图搬进 `_rejected`**。已删掉那条，并加 `tools/compliancetest.js` 守住这个边界。
- `jobs.run` 起不来时改成回 `{ok:false, error}`（原来直接抛异常，渲染层不 catch 会变成未捕获的 Promise 报错 → 控制台飘红、还不给提示）。
- 取消任务时不再让各步骤自己的报错冒充失败原因（原来会显示「这个目录里没有找到素材叶子目录」），统一报「任务已取消」并带批次 meta。

### 视频发布支持（2026-10-01 **代码已实现**；只差真机抓 `videoSteps`）

> **已拍板的口径：视频封面用「得物推荐的」** —— 即不点封面区、不上传封面图、不做取帧裁图。
> 这一条省掉了「视频取帧 / 裁图 / 传封面」整块能力（不用引入 ffmpeg），是最大的一处复杂度节省。
>
> ⚠️ 但仍要在真机上确认一件事：得物有些版本封面区**默认未选中**，不点「下一步」会被拦住。
> 真机确实要手点的话，在 `videoSteps` 里补一步「点第一个封面候选」。**不能靠猜** ——
> 抓一次 dump 就能看见（`uimap.suggest()` 生成的表里带 `videoNote` 记着这条）。

链路 5 个环节的现状（已逐处核实代码）：

| # | 环节 | 现状 | 位置 |
| --- | --- | --- | --- |
| 1 | 素材整理 · 合规检查 | ✅ 已支持 | `winpath.VIDEO_EXT`、`compliance.js`、`imaging.videoDurationSec` |
| 2 | 文案生成 | ⚠️ 只有一套图文标题/文案口径，视频未验证（**没改**） | `copywriter.js` |
| 3 | 导入 AI 内容报告 | ✅ **已改为按「内容类型」列分流** | `report.build()`、`winpath.contentKind()` |
| 4 | 推送素材 · 走发布页 | ✅ **已按 kind 分流；视频走 `videoSteps` + 等媒体库索引** | `publisher.runReal()`、`adb.mediaVisible()` |
| 5 | 回写报告 B / C 列 | ✅ 已支持（与图文同一套） | `report.mergeResults` |

改动清单（4 条全部落地）：

1. **`publisher.runReal` 按 `kind` 分流推送**：`row.kind`（从报告导入时按「内容类型」列判定）→
   行上的内容类型原文 → 目录里实际有什么。视频推 mp4，图文推图。
2. **视频推完必须等媒体库索引**：`adb.MEDIA_SCANNER_SCAN_FILE` 只是**发广播**，索引是异步的。
   图片小、扫得快所以一直没暴露；mp4 几十 MB，发完广播就走 UI 会**稳定**卡在「相册里选不到这条视频」，
   而且看起来像点击步骤配错了。新增 `adb.mediaVisible()` 轮询 `content query --uri content://media/external/video/media`
   直到真能看见，上限 `publish.videoIndexTimeoutSec`（默认 180s），超时**明确失败**而不是硬点。
3. **`uiMap` 增加 `videoSteps`**（与 `steps` 并列）。视频发布页与图文**不是一套界面**，
   所以视频条必须走它；**没配就当场失败并说明缺什么**，绝不拿图文那套硬套。
   `uimap.suggest()` 现在一次生成 `steps` + `videoSteps` 两套候选 + 一条 `videoNote`。
   ⛔ **`videoSteps` 的具体坐标必须真机抓 dump 才配得出来**（见 `WINDOWS-E2E.md` 第 4 节）。
4. **节奏参数**：新增 `publish.videoIntervalSec`（默认 90，图文仍是 60）；`estimate()` 与界面预估
   都改成图文「间隔+30s」、视频「间隔+60s」分开算（视频推得久 + 要多等媒体库索引）。

**语义问题（已按建议 A 拍板并实现）**：一个叶子里同时有图又有视频时按哪个发？
→ **以报告「内容类型」列为准**（`图文` 推图、`视频` 推视频）。没标时按目录内容推断（只有图 / 只有视频 都无歧义）；
**两边都有、又没标**才判不了 → 标成「校验未通过：…判不了该发哪个（请在报告里标好内容类型）」，**绝不猜着发**
（同一叶子两种素材都拍在达人素材里是常态，猜错就是发错内容）。

**双向验证（源码级定点破坏 → 必须红 → 还原 → 必须绿）**：`node D:\work\e2e\fix-break.js break|restore|status`
（`break` 后可带编号只破坏一项：`break P6`；同一处缺陷有多条防线时要一起拆：`break P6 P9`）

| 改前版（破坏点） | 改前 | 改后 |
|---|---|---|
| P1 `imaging.js` 的 `files:20` | 转换 0 / 失败 1 / 残留 `.__tmp_scale_*.jpg` | 转换 1 / 失败 0 / 无残留 |
| P2 `jobs.js` 丢 `reportRow` | `[0,0,0,0]` | `[2,3,4,5]` |
| P3 `report.js` 任何异常都当「被占用」 | `busy=true` + 塞暂存 | `busy=false` + 明说原因 + 队列不动 |
| P4 `report.js` 含视频一律不发布 | adbtest **8** 条红 / reporttest **3** 条红 | 0 红 |
| P5 `publisher.js` 只推图片 | 同上（视频条 0 成功、不查媒体库、无 `[视频]` 日志） | 0 红 |
| P6 `adb.js` 抓结构前不删远端文件 | ⑫ 1 条红（`46→45`） | 0 红 |
| P7 `adb.js` 页面不 idle 时没有关动画兜底 | ⑨ 3 条红（`46→43`） | 0 红 |
| P8 `adb.js` 关动画兜底后不还原 | ⑨ 1 条红（`46→45`） | 0 红 |
| **P6+P9 `adb.js` 复用文件 + 不检查 dump 是否成功（= 真正的改前版）** | adbtest **6** 条红（`46→40`）。最要命的两条：⑪ `dump()` **返回上一页残留的 XML**；⑩ 抓不到结构却**拿着上一页的坐标连点 5 次**、结果标成「**发布成功**」 | 0 红（199 项全绿） |

> P6 与 P9 是**同一处缺陷的两条防线**（① 抓前删文件 ② 检查 `uiautomator dump` 是否真的成功）：
> 只拆一条，另一条仍然拦得住残留 —— 想还原「改前版」必须两条一起拆。这条经验写进了
> `fix-break.js` 的注释，免得下次「拆一条看到全绿」就误判成「断言没在查东西」。

> `estimate()` 的向后兼容：`estimate(100)`（不传第二参）仍按全图文算 → `pendingtest` 的
> 「100 条 = 150 分钟」不变。

### 视频发布 · 真机实测卡点（2026-10-01，MuMu 12 / 得物 900×1600）

> 一句话：**代码链路是通的，但一套 `videoSteps` 都还没有真机配出来**。
> 下面每条都是真机上量到的（附原始数字），不是推测。

| # | 卡点 | 真机证据 | 结论 / 怎么配 |
| --- | --- | --- | --- |
| 1 | **发布页抓不到界面结构** | 进入 `media.publish.activity.TotalPublishProcessActivity` 后 `uiautomator dump` 报 `ERROR: could not get idle state.`；连续 **60** 次（约 10 分钟）全失败。只把 `animator_duration_scale` 置 0 → **同一秒**成功（24263 字节）；还原为 1 后仍成功；重新进页面又卡住 | **已修**（见下「顺手修掉的隐患」）。修之前：失败时会 `cat` 到**上一个页面**的结构 → 按旧坐标点 + 报「发布成功」 |
| 2 | **发布入口没有文字** | 首页右上角 `com.shizhuang.duapp:id/ivCamera`，clickable，center `(854,69)`，**无 `text`、`content-desc` 为空** | `suggest()` 猜的 `tapText '上传视频'/'发视频'/'视频号'` **真机上都不存在** → 第一步必失败。改成 `{"action":"tapId","value":"com.shizhuang.duapp:id/ivCamera"}` |
| 3 | **全 App `content-desc` 为空** | 首页 / 发布页 dump 里 `content-desc` 一律为空 | `tapDesc` 一步都用不了 |
| 4 | **「视频」页签无 id、文字不可点击** | `galleryTabLayout [0,204][900,270]` 内三个 `ActionBar$Tab`（全部/照片/视频）**无 id、无文字**但 clickable；文字「视频」是它的子 TextView（`clickable=false`）center `(528,251)`，落在父 Tab `[489,204][567,270]` 里 | `tapText '视频'` **能用**（`findNode` 不校验 clickable），但靠的是「文字节点恰好在 Tab 内」这个巧合 —— 页面改版就会失效 |
| 5 | **相册格子没有文字** | 缩略图是 `imgThumb`(ImageView)，格内只有 `flThumbSelect` 勾选圈，**没有任何文字/描述**；第 1 格 `[0,270][175,446]` center `(88,358)`，勾选圈 center `(138,308)` | `suggest()` 里的 `tapText '${videoName}'` **必然找不到**。只能按格子坐标点（第 1 格 `(88,358)`）或点勾选圈 |
| 6 | **首屏没有「下一步 / 发布」** | 发布页首屏 dump 里没有下一步/发布按钮 | 「确认选视频 → 下一步」只能**选中素材之后**点；具体坐标要真机再抓一次 |
| 7 | **首页也有一个「视频」** | 首页 tab 栏 `tvTabTile`「视频」center `(346,135)` | `tapText '视频'` 在**首页的 dump** 上会命中这个。发布页 dump 里只有页签那一个，所以现在不冲突 —— 但**抓 dump 时别抓错页面** |
| 8 | **相册网格能不能滚还没验** | dump 里 `galleryViewPager` `scrollable=true`，但内部 `recyclerView` `scrollable=false`，且只列出 5 格（一行） | ⚠️ **未验证**：要发的视频在第几格、要不要先滑一屏，**还没测**。配 `videoSteps` 时要连这一步一起看 |
| 9 | **封面区默认是否选中仍未确认** | 封面区在「选中素材之后」的页面，本轮**只走到选素材页，没往下点** | 已拍板：封面用**得物推荐的**（不点封面区、不上传封面图）。若真机发现默认未选中挡住「下一步」，才需要在 `videoSteps` 里补一步（`uimap.suggest()` 的 `videoNote` 记着这条） |

**配置 `videoSteps` 需要做到哪一步？**（回答「是否必须真发」）

- **不必真发**：第 1~8 条卡点全都能在不发布的前提下解决 —— 只要能进发布页、选中素材、走到「填标题」那一页，就能把除最后一步外的所有坐标配出来。
- **但「提交发布」这一步的坐标只能真发一次才拿得到**（按钮在最后一屏，前面到不了）。
  所以建议：**先走到发布按钮前停住**，把前面的步骤配上；最后一步**再单独真发 1 条最小号**（用最便宜的素材）把坐标补上。

---

## 6. 回归要求（每改一处都要跑）

✅ **测试已全部收进仓库 `tools/`**（不再散在 `/tmp`），一条命令跑完：

```bash
bash tools/run-all.sh        # macOS / Linux
node tools/run-all.js        # Windows（跨平台入口，两个脚本跑的是同一套）
node tools/run-all.js smoke  # 只跑名字里带 smoke 的
```

> ⚠️ **不要** `BLUEV_NO_LOGIN=1 node tools/run-all.js`：`logintest` 断言的就是「这个变量没设」，
> 设了它会 3 条 FAIL 并挂住不退出（`uicheck` 自己会在进程内设好，外面不用管）。

> **Windows + 雷电模拟器的端到端测试手册见 [`WINDOWS-E2E.md`](WINDOWS-E2E.md)**：
> 环境清单、逐环节操作与预期、常见坑、待确认问题清单、问题回传格式。

| 测试 | 覆盖 | 断言数 |
| --- | --- | --- |
| `tools/smoke.js` | 造临时素材跑 `flatten.plan/run → compliance.scan/fix → copy.generate → verify.check → sheet.export → publish.run → mergeResults` | 23 |
| `tools/adbtest.js` | 用**假 adb**（`tools/fakeadb/adb.js`，在 `child_process.execFile` 这一层做替身，跨平台）验证真实发布通道：指令序列、坐标点击、中文广播输入、失败截图；失败恢复动作的校验（不认识的 action 要说清可用值）；**视频条**（推视频 → 查媒体库 → 走 `videoSteps`；没配 `videoSteps` 必失败；媒体库一直看不到也必失败）；**页面不 idle**（关动画兜底并**还原**、兜不住就明确失败、★ 抓不到时**绝不返回上一页的残留结构**） | 46 |
| `tools/pendingtest.js` | 把发布单 `chmod 0444` 模拟「Excel 被占用」→ 断言整批暂存 → 恢复可写后下次补写；设备增删去重 | 9 |
| `tools/compliancetest.js` | 合规边界：合格 JPG 只能有 1 条 ok、`fix()` 绝不把它搬进 `_rejected`；「导出报告」xlsx（汇总+明细）+ csv（带 BOM） | 16 |
| `tools/batchtest.js` | 多批次并行（不同批次同时跑、同批次不重复起）、按 job id 取消 / 按类型全部取消、按批次重导出日志、失败恢复动作保存与校验 | 22 |
| `tools/reporttest.js` | 「AI 内容报告」导入 → 发布 → 回写：列名匹配（列顺序打乱）、行↔叶子配对与数量不等报错、标题文案空则生成、好物带全、**发图文还是发视频按「内容类型」列判定**（没标按目录推断；图+视频都有又没标 → 「校验未通过」）、报告被占用→暂存→补写 | 32 |
| `tools/brandtest.js` | 品牌注册表与权限：改名不丢已分配的授权、重名与保留名被拒、成员借别人的品牌 id 越权被拦、删除品牌**排空授权**且**不动历史记录**；按品牌统计（「未标品牌」与「已删除的品牌」各自成桶、绝不与真实品牌合并）；执行日志落盘且重启后仍在；xlsx 四个工作表；**按品牌文案提示词**（存 / 归一 `\r\n` / 超长截断、拼进 system 时品牌模板在前而输出约束在后、没配提示词的品牌**起任务前就被拦下且不留台账**、直接调 `copywriter.generate` 也拦得住） | 69 |
| `tools/uicheck.js` | 隐藏窗口加载真实渲染层：**自己**在进程内设 `BLUEV_NO_LOGIN=1` 免登录、8 个页签渲染、**零控制台报错**、新按钮挂载、批次面板出现/消失、恢复动作走真实 IPC 存进配置、**点「提示词配置」直接弹出弹窗且点遮罩能关**、**设置页有「应用更新」面板并如实写出当前版本 / 不可用原因（未打包时不许摆点了没用的按钮）**、**更新可用时「更新通道」一行 + 两个按钮都在、当前通道高亮正确** | 32 |
| `tools/logintest.js` | 登录门（**这个变量必须没设**）：未登录时业务通道被主进程拦掉、错口令不泄露账号是否存在、记住登录落盘且重启免密、普通成员看不到账号列表、停用后不能登录、不能停用/删自己、退出回登录门、连错 6 次锁定；**品牌权限**（成员连品牌注册表都改不了、成员看统计的范围被限死、成员不能借别人的品牌 id 越权）；**文案提示词权限**（成员能改自己品牌的、改不了别人的、也不能借这个口子改名；`brand:list` 不回别人品牌的提示词；弹窗编辑视图字段齐全、成员看到的品牌名是只读的）；**自动更新四个通道同样被登录门拦** | 59 |
| `tools/gatetest.js` | 登录小窗 / 主窗几何：登录后窗口完整落在工作区内、离谱几何必被夹回、关闭按钮四边都在卡片边框内、卡片外没有任何**可见**元素 | 17 |
| `tools/updatertest.js` | 自动更新状态机与两条红线（纯 Node + 假 `autoUpdater`，**不联网、不真下载、不碰真 electron-updater**）：未打包 / 便携版都不可用且给出中文原因；`autoDownload === false` 且 `autoInstallOnAppQuit === false`；**`update-downloaded` 之后 `quitAndInstall` 调用次数必须为 0**（绝不自动重启 —— 装了会掐断正在跑的发布任务）；只有用户点「重启并安装」才调且参数 `(false, true)`；`idle→checking→available→downloading→ready` 与 `uptodate` / `error` 的回退；重复点检查不会并发；推给界面的是快照而非活引用；**通道**（默认正式版且落到 updater 上就是 `latest`；非法通道名被拒且不改坏状态；切测试版改读 `beta.yml`；**切通道作废上一次下载结果**、装不上另一条通道的包；**正式→测试不许降级、测试→正式才允许**；成功检查后收回降级放行、失败时保留；切通道不碰任何 url/feed 字段；重启后按配置里的通道走、非法值落回正式版） | 48 |
| `tools/releasetest.js` | 发版工具纯逻辑（不联网、不碰 COS、不读 `dist`）：`latest.yml` 的 `path` 读错 ⇒ 客户端按错名字下载 ⇒ **全员 404 但本机毫无异常**；`pickInstaller` 永不含「便携版」（portable 不支持自动更新，传了就是发个用不了的包）；`versionGate` 在「源上已是同版本号」与「**往回发**（比源上低）」两种情况分别拦下且原因可区分、`--force` 才放行、「源上读不出」不拦（读不出 ≠ 已存在）；`compareVersion`（`1.0.0-beta.2` / `1.0.0-beta.10` / `1.10.0` 这些按**数值**比的用例）；`channelFile`（正式版→`latest.yml`、测试版→`beta.yml`）；`humanSize` 不再把 388 B 显示成 `0.0 MB` | 47 |

合计 **420** 项断言（每次改动后实测：`23 + 46 + 9 + 16 + 22 + 32 + 69 + 32 + 59 + 17 + 48 + 47 = 420`）。`logintest.js` / `uicheck.js` / `gatetest.js` 都把 `userData` 指到临时目录，**不会动你本机的 auth.json / config.json / project.json**。`tools/run-all.sh` 会自己找 node、给本机 Electron 自签（见 §3 的坑），
`uicheck.js` 把 `userData` 指到临时目录，**不会动你本机的 config.json / auth.json / project.json**。

假 adb 已经进仓库，不用再手写：`tools/fakeadb/{adb.js,window.xml,shot.png}`；
`adb.js` 是**可 `require` 的替身模块**（替换 `child_process.execFile`），不再依赖 shell / 可执行位 / PATH ——
原因是 Windows 的 `execFile('adb')` 只认 `adb.exe`，无扩展名的 bash 脚本跑不起来（详见该文件顶部注释）。
脚本用 `$0` 反推目录（`DIR="$(cd "$(dirname "$0")" && pwd)"`），所以整套复制到临时目录也能跑。

---

# 7. 真机演示录屏拆解（他们的现有工具）

> 素材：`afea0e69ff6a2b45099f3f28c6b98fe7_raw.mp4`（15:44，1920×1080，微信收到的录屏，含音频）
> 方法：ffmpeg 按场景切换抽 **118 帧** → tesseract.js（chi_sim+eng）OCR
> 证据：`docs/video-ocr-118frames.txt`（逐帧原文）、`docs/video-scene-times.txt`（帧时间戳）
> ⚠️ OCR 有噪声，**标注「OCR 存疑」处请以真机为准**，不要直接当规格用。

## 7.0 一句话结论

这是**会议共享屏幕**录的他们现有工具（共享者署名「十克管理员」，同屏还有 李佳漫/陆芳琴/刘妍/郑炫晖/施云春/洪海伦/卢绮婵/蔡泽茗/周宇杰）。
工具名 **得物社区素材管理工具**，顶部固定「推荐流程」：

```
素材整理 → 素材合规检查 → AI文案生成 → 好物货号颜色预检 → 自动发布
```

注意措辞：**「好物货号颜色预检」**（不是"校验"）、**「自动发布」**（不是"模拟器发布"）。

## 7.1 素材整理

界面文案：「选择素材根目录」「选择目标输出目录」「**只处理最底层文件夹**」「**复制 原素材完全不动**」
「这一步把多层嵌套的素材目录扁平成一层：找出每个最底层文件夹，把里面的文件原样复制到目标目录，
新文件夹名用 `_` 连接原来的层级路径，原文件保持不变」「查看整理示例与规则」

真实命名样例：

```
8124MT_UWG450159+灰色+达人昵称_1
8124MT_UWG450159+灰色+达人昵称_2
U6CSSSU244 烟灰+紫灰拼接+U6CFCRW07_1
U6CFCRW0784+U6CSWSW200 烟灰 3
U6BACCU52-1 光子灰_4
1011 白色 UWG760094_3
```

**读法**：连接符 `_`，段内保留原始 `+`；批次目录形如 `7月第六批(已安排)_20260812_151245`、`种草0625-7月第一批_20260805_140706`（**带时间戳**）。
扫描概要出现过：`595 个文件夹 / 994 个文件`、`2.13 GB`。

> ⚠️ 关键差异：真机是「原素材完全不动」（只复制），PRD 第 4 版写的是"原目录改名加时间戳"。
> 本实现按**真机**为准：`flatten.touchOriginal` 默认 `false`。

## 7.2 素材合规检查

| 项 | 真机文案 |
| --- | --- |
| 图片格式 | 「**必须为 JPG**」 |
| 尺寸下限 | 「**≥1764（约 42×42）**」→ 面积 ≥1764 像素² |
| 尺寸区间 | 「在 150 ~ 1500 之间」**（OCR 存疑**：原文识别为「在 11150 - 150 之间」，取 150~1500 最合理） |
| 超限处理 | 「**自动等比缩放**」（勾选项） |
| 视频 | 「**必须为 .mp4（按扩展名判断）**」「**<600 秒，超过需手动处理**」 |

其他：「**选择父目录**」→「系统将对**每个子文件夹独立执行合规检查**」；
结果区有「文件夹列表（512 个）」「**导出报告**」「重新选择目录」「打开文件夹」「取消检查」，扫描中显示「正在检查父目录…」。

## 7.3 AI 文案生成

- 「AI 生成设置」：**筛选排序提示词** / **文案生成提示词** / **并发设置**
- **品牌管理**：出现 `skechers`，可新增/编辑/删除
- 「选择素材目录并启动任务」→ **任务列表可同时存在多个批次**：`7月第六批(已安排)-20260812_151245`（处理中）、
  `种草0625-7月第一批-20260805_140706`（处理中），每行「查看详情」「取消任务」「全部取消」
- 结果预览：「共发现 **46 个有效文件夹**」，行如 `UWG460108 本白_1  图 图文 10`、`UWH760085 黑色条纹_1 口 视频 2`

## 7.4 好物货号颜色预检

- 输入 = 上一环产物 **`AI内容报告_2026-08-05T06-26-04.xlsx`**（**上一环节产出的 Excel**，文件名带 ISO 时间戳）
- 带 **「SKU APIKey」** → **调接口**查得物后台，不是本地词表
- 结果**写入 Excel 的「执行结果」列（5 列）**
- 判定文案原文：

| 判定 | 原文 |
| --- | --- |
| 通过 | `颜色匹配` |
| 单色货号没填色 | `单色货号，颜色可空` |
| 多色货号没填色 | `多色货号须指定颜色（共2色：深蓝色条纹/黑色条纹）` |
| 货号查不到 | `货号 22222 未查到颜色信息，请核对` |
| 不匹配 | `颜色不匹配` |

- 汇总口径：「**接口查不到的货号仅告警不阻断**」
- 外部数据源（录屏里打开了后台）：

```
https://dw.shike.tech/sku-color        （Shike BI · 商品颜色提取）
左侧：操作说明书 / 商品颜色提取 / 运营管理
按钮：颜色模板 / 尺码模板 / 导入 / 导出 SKU 颜色校正表 / 导出 SPU 颜色分析表 / 导出 SKU 尺码校正表
表格列：spuID / skuID / 货号 / 原始规格 / 系统提取颜色 / 人工校正颜色 / 系统提取尺码
```

> ⚠️ **`dw.shike.tech` 只是这段录屏里出现的示例后台，不要访问、不要抓取、不要对接它**
> （不是我们的系统，也没有凭据）。上面这些只当**列结构参考**：颜色数据的入口仍走
> 「本地商品池导入 CSV/JSON」或 `verify.mode=api` + SKU APIKey 调自己的接口。

## 7.5 自动发布（最值得抄的一段）

**设备管理 = 账号矩阵**（雷电模拟器，一个设备一个账号）：

```
在线   公共测试设备 - 手机号      emulator-5554   雷电模拟器   [删除]
离线   UR视频号                  emulator-5564   雷电模拟器   [删除]   ← OCR 存疑
离线   UR女人号                  emulator-5568   雷电模拟器   [删除]   ← OCR 存疑
离线   斯凯奇穿搭                emulator-5566   雷电模拟器   [删除]   ← OCR 存疑
```

**新建发布批次**：选 `AI内容报告_2026-08-12T07-27-24.xlsx` + **选设备**（「请选择」）→「**开始批次**」；右侧「**运行中的批次**」。

**运行日志原文**（可直接当产品需求）：

```
[V] 行 2 [图文] 发布完成，已暂存待补写时间 2026-08-12 15:34:41（耗时 65.2s）
    Excel 仍被占用，暂存保留，下次再试（可只读打开但不建议编辑保存）
    批量发布完成，总耗时 86.6s
按 1 分钟间隔，57s 后执行
[X] 行 3 发布失败，已回退转发页（61.9s）
[V] 行 3 已回填，退出码 0
[V] 行 4 [图文] 发布完成，已回填时间 2026-08-12 15:38:28（耗时 79.7s）
共 3 条 / 1 失败
[按钮] 重导出日志   取消批次
```

**四条硬信息**：

1. 间隔是**固定 1 分钟**（不是 60–120 随机），且**有倒计时**「57s 后执行」；
2. **单条耗时 65–80 秒**，写进日志/表格；
3. **Excel 被 WPS 占用时不失败、不覆盖**，而是**暂存结果、下次再试** —— 这就是 PRD"发布过程不占用发布单文件"的真实落地；
4. **失败有恢复动作**：回退到转发页，避免下一条起点被残留界面污染。

**贯穿全流程的中间产物**：`AI内容报告_<ISO时间戳>.xlsx`。发布单可见列：
`期待发布时间 / 实际执行时间 / 执行结果 / 素材来源 / 素材路径 / 标题 / 文案 / 好物1货号 / 好物1颜色 …`

---

# 8. 与本实现的差异总表

| 环节 | 真机 | 本实现 | 状态 |
| --- | --- | --- | --- |
| 扁平命名 | `_` 连接层级路径 | 同 | ✅ |
| 原素材 | 完全不动 | 同（`touchOriginal=false`） | ✅ |
| 合规规则 | JPG / ≥1764px² / 150~1500 / 等比缩放 / .mp4 / <600s | 同 | ✅ |
| 合规父目录模式 | 选父目录，子文件夹独立检查 | 同（`scanParent` + 分组表） | ✅ |
| 合规导出报告 | 「导出报告」按钮 | 有（xlsx 汇总+明细 / csv 带 BOM） | ✅ |
| 文案生成 | 品牌管理 + 两种提示词 + 多批次并行 | 三项都有（批次级并行，产物各写 batches/<批次>/） | ✅ |
| 颜色校验 | 调 SKU 接口 + 判定文案 + 写回 Excel | 同（接口模式已支持） | ✅ |
| 颜色数据源 | 录屏里的 `dw.shike.tech/sku-color`（**仅示例，不要访问**）导出校正表 | 支持导入 CSV/JSON；或 `verify.mode=api` 调自己的接口 | ⚠️ 部分（不外联示例后台） |
| 发布设备 | 多台雷电模拟器 = 多账号 | 同（增删/检测/选用） | ✅ |
| 发布间隔 | 固定 1 分钟 + 倒计时 | 同 | ✅ |
| 单条耗时 | 写日志 | 同 | ✅ |
| Excel 占用 | 暂存，下次再试 | 同（`pending-results.json`） | ✅ |
| 失败恢复 | 回退转发页 / 删除卡片 | 同（返回键 + `uiMap.recover`，**界面可编辑**并校验 action 合法性） | ✅ |
| 重导出日志 | 有按钮 | 有（按批次导 .log + .csv） | ✅ |
| 多批次并行 | 支持同时跑两批 | 支持（任务实例化 + 运行中批次列表 + 逐个/全部取消） | ✅ |

---

# 9. 证据文件与复现方法

| 文件 | 说明 |
| --- | --- |
| `docs/video-ocr-118frames.txt` | 118 帧逐帧 OCR 原文（带时间戳），**证据**，可直接 grep |
| `docs/video-scene-times.txt` | 每帧时间戳 |
| `../_snapshot-20260930-1515.tar.gz` | **最新**代码快照回滚点（含 ①②③④ + 登录自检 + `.gitignore`） |
| `../_snapshot-20260930-1510.tar.gz` | 上一条快照（① ②③④ 完成时） |
| `../_snapshot-20260930-1447.tar.gz` | 这批改动**之前**的状态（含另一个任务的登录门） |
| `tools/run-all.sh` / `tools/run-all.js` | 一键回归（跨平台）：**十二套**测试，共 **420** 项断言（跑时**不要**设 `BLUEV_NO_LOGIN`） |
| `tools/upload-release.js` | 把 exe + 清单文件 + `.blockmap` 传到对象存储的**桶根目录**。清单名按通道定：正式版 `latest.yml`、测试版 `beta.yml`（`channelFile()`）。★ **generic provider 不会替你上传**（electron-updater 官方明确要求自己放），漏了这一步源上还是旧清单 ⇒ 应用**永远显示「已是最新」，而且失败是静默的** |
| `dist/win-unpacked/resources/app-update.yml` | **实测生成（2026-10-01）**：`provider: generic` / `url: https://dewu-bluev-release-1499238579.cos.ap-guangzhou.myqcloud.com/`（**桶根，不带 `/stable`** —— 两条通道共用同一层，靠清单文件名区分）/ `channel: latest`（只是默认值，用户选测试版后运行时会被覆盖成 `beta`）/ `updaterCacheDirName: dewu-bluev-publisher-updater`。由 `package.json` 的 `build.publish` 生成，**编译进包、但在 asar 外**（electron-updater 只能读这个文件，**不许 `setFeedURL`**） |
| `dist/latest.yml` | electron-builder 生成的更新清单（388 B）：`path` 指向 **NSIS 安装版** exe（不是便携版），带 `sha512` 与 `size`。客户端按这里的 `path` 去下载，**对不上就是 404**。★ 两条通道都由它派生：传正式版时它被当作 `latest.yml` 上传，传测试版时被改名成 `beta.yml` |
| `.env`（不进仓库，已在 `.gitignore`） | 发版凭据 `COS_BUCKET` / `COS_REGION` / `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_DOMAIN`；子账号 `dewu-bluev-cos-upload` |
| `docs/WINDOWS-E2E.md` | Windows + 雷电模拟器的端到端测试手册（怎么跑、每步预期、坑、问题回传） |
| `.gitignore` | 已按「不提交 node_modules / dist / 运行时数据 / `.env`」写好并生效 |

复现本次拆解（万一要重看原始录屏）：

```bash
# 1) 取 ffmpeg（macOS arm64，注意必须签名，否则被 SIGKILL）
curl -sL -o ff.gz https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz
gunzip ff.gz && chmod 755 ff && xattr -cr ff && codesign --force --sign - ff

# 2) 按场景切换抽关键帧（避免 OCR 上千张）
./ff -i <video.mp4> -vf "select=gt(scene\,0.28),scale=1400:-1" -vsync vfr -q:v 3 frames/f%05d.png
# 取时间戳
./ff -i <video.mp4> -vf "select=gt(scene\,0.28),showinfo" -f null - 2>&1 | grep -o "pts_time:[0-9.]*"

# 3) 中文 OCR（tesseract.js；语言必须传数组，传 'chi_sim+eng' 会报 traineddata 打不开）
npm i tesseract.js
# createWorker(['chi_sim','eng']) → worker.recognize(png) → data.text
```

> 也可用 macOS 自带 `avconvert`，但本机 Swift 工具链与 SDK 版本不匹配（`failed to build module 'CoreFoundation'`），
> 编译 Vision OCR 会失败，所以走了 ffmpeg + tesseract.js 这条路。

## 其他参考

- PRD：https://c325414b53f748618ec865de0d865c08.app.workbuddy.host/#prd
- 原型：http://127.0.0.1:8010/index.html
- 原始录屏：`/Users/shuo/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_suwsgc0k0fh222_93b5/msg/video/2026-09/afea0e69ff6a2b45099f3f28c6b98fe7_raw.mp4`

---

# 10. 版本控制（git）

## 现状：已推上私有远端 ✅

```
远端      git@gitee.com:abulaitifans/dewu-bluev-publisher.git     （Gitee · 私有）
首次提交  4622e1a「首次提交：得物蓝V素材发布工具」 44 个文件 / 12,962 行
分支      main（已 set upstream 到 origin/main）
忽略规则  .gitignore：node_modules/（522MB）、dist/（169MB 安装包）、运行时数据、快照 tar
```

`.git` 只有 428KB。**安装包不要进 git**（二进制进了历史就删不干净）→ 发给同事走 Releases / 网盘。
仓库是**私有**的：`docs/HANDOFF.md` 里有得物业务流程与真机口径，不能公开。

## ⚠️ 第一个要做的：把仓库里的身份改成真实的

`git config user.name/user.email`（本仓库范围）现在还是占位符字面值 `你的名字 / 你的邮箱`，
**不改的话以后每次提交都会是那个假署名**：

```bash
git config user.name  "张硕"
git config user.email "shawnz2000@outlook.com"   # 换成 Gitee 账号绑定的邮箱，提交才会关联到你的账号
```

（换机器 `git clone` 之后也要先配一次。）

## 日常流程（针对 §2「另一个任务也在同一棵树里改」）

```bash
git pull --rebase             # 开工前先拉
git switch -c feat/xxx        # 一人一分支，别都在 main 上改
git add -A && git commit -m "改了什么"
git push -u origin HEAD       # 合并走 PR，冲突在合并时暴露，而不是互相覆盖后才发现
```

## 边界

- **不要提交**：`node_modules/`（522MB）、`dist/`（169MB，两个 ~88MB 安装包）、运行时数据
  （`auth.json` / `config.json` / `project.json` / `pending-results.json` …）—— `.gitignore` 已覆盖。
- 安装包给同事用走 **Releases / 网盘**：二进制一旦进了 git 历史就删不干净，仓库会一直背着它。
- 可选：加 `.gitattributes`（`* text=auto eol=lf`，`*.bat eol=crlf`），避免 Windows 同事提交 CRLF 造成满屏 diff。
- 账号口令不在仓库里：`auth.json` 在 `%APPDATA%\dewu-bluev-publisher`，只存 scrypt 哈希；
  发版换管理员用 `BLUEV_ADMIN_USER/PASS` 或 `auth.seed.json`（用完即删，见 README）。

## 配 SSH 钥匙时容易卡住的点（首次推之前）

- `Enter file in which to save the key (...)` → 直接回车（默认路径 `~/.ssh/id_ed25519`）；`Enter passphrase` → 直接回车（不设密码）。
- **如果提示 `... already exists. Overwrite (y/n)?` → 输入 `n`，不要覆盖。**
  说明这台机器上已经有一把钥匙（可能之前配过别的平台）。覆盖会让那把公钥在**已经登记过它的平台上全部失效**。
  正确做法是复用它：`pbcopy < ~/.ssh/id_ed25519.pub`，然后把这个公钥加到新平台 ——
  **同一把公钥可以同时登记到 Gitee / GitHub / 公司 GitLab，互不冲突**。
- 私钥文件约 460+ 字节（比 411 字节的"无密码"版更大）说明设了口令，push 时会问一次；想免输入：
  `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`。
- 测连接：`ssh -T git@gitee.com` → 成功回 `Hi 用户名! You've successfully authenticated...`（第一次会问 `yes/no`，输 yes）。
- ⚠️ 永远不要把**没有 `.pub` 结尾**的那个文件（`~/.ssh/id_ed25519`，私钥）发给任何人。

## 以后换平台 / 同时推两个平台（不用动工程目录）

git 的「远端」只是一个地址，随时可换；代码、历史、`.gitignore` 都跟着走，与 Gitee/GitHub 无关。

```bash
# ① 彻底换成新平台（先在平台上建一个空的私有仓库）
git remote set-url origin git@新平台:用户名/仓库.git
git push -u origin main

# ② 两个平台同时保留（origin 保持 Gitee，再加一个 backup）
git remote add backup git@github.com:用户名/仓库.git
git push -u backup main
# 之后：git push origin main && git push backup main
# 也可以给 origin 追加第二个 push 地址，一条命令推两边：
git remote set-url --add --push origin git@github.com:用户名/仓库.git
# （注意：加了第二个 push 地址后，push 会推全部地址；fetch 仍只取第一个）

# ③ 连分支和标签一起搬（整仓迁移）
git push --all origin && git push --tags origin
# 或者镜像搬迁：git clone --mirror <旧地址> && cd <镜像目录> && git push --mirror <新地址>
```

注意：

- 换成**内网 GitLab**：SSH 端口可能不是 22（用 `~/.ssh/config` 配 `Host` / `Port`），也可能要求连 VPN 或改用 HTTPS + 令牌。
- 历史里每条提交的作者（第 4 步配的名字/邮箱）跟着历史走，换平台不会变。
- `.gitignore` 跟代码一起走，换平台照样不会把 `node_modules/`（522MB）、`dist/`（169MB）提交上去。
- **多平台双写时，别在两个平台的网页上各改一次**同一份文件，容易分叉。
- ⚠️ 别把仓库再 clone 一份到别的目录继续开发：应用把绝对路径存在**同一个** `%APPDATA%\dewu-bluev-publisher`，
  两份副本会互相打架（就是 §2 说的「两份分叉的 app」）。开发机上保持一份。
