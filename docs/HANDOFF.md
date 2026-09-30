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
③ 测试用 BLUEV_NO_LOGIN=1 绕过登录门；每改一处必须跑回归（契约见文档 §6）；
④ 注释与界面文案用中文，失败要说清「缺什么」，不允许造假成功。
真机口径已固化在文档 §7/§8，不要重跑 OCR。
```

> 想更"重"一点也行：把 §1 的完整会话直接粘贴。**但优先推荐上面这种**——文档改了提示词不用改，单一事实来源。

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
   （本机登录门：`auth:*` 通道，`guard()` 拦截未登录的 `job:run` 等调用）。默认管理员 `admin / BlueV@2026`；
   测试时用 `BLUEV_NO_LOGIN=1` 免登录。
   登录门本身已有回归：`tools/logintest.js`（32 项，见 §6）—— 覆盖未登录拦截、口令只存哈希、记住登录、
   权限、防爆破、退出；**改这几块之前先跑它**。
4. 回滚点（都在工程外，不打进安装包）：
   - `_snapshot-20260930-1510.tar.gz` —— **含 ①②③④ 的改动**（src + package.json + README + docs + tools）
   - `_snapshot-20260930-1447.tar.gz` —— 这批改动**之前**的状态（含另一个任务的登录门）

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

### 本次顺手修掉的隐患（不属于待办，但会出错）

- `compliance.scan`：合格 JPG 走完规则后又被追加了一条「不支持的扩展名 → 隔离」，
  `fix()` 照着做会把**好图搬进 `_rejected`**。已删掉那条，并加 `tools/compliancetest.js` 守住这个边界。
- `jobs.run` 起不来时改成回 `{ok:false, error}`（原来直接抛异常，渲染层不 catch 会变成未捕获的 Promise 报错 → 控制台飘红、还不给提示）。
- 取消任务时不再让各步骤自己的报错冒充失败原因（原来会显示「这个目录里没有找到素材叶子目录」），统一报「任务已取消」并带批次 meta。

## 6. 回归要求（每改一处都要跑）

✅ **测试已全部收进仓库 `tools/`**（不再散在 `/tmp`），一条命令跑完：

```bash
bash tools/run-all.sh        # 五套主进程测试 + 隐藏窗口界面自检，逐套打印 PASS/FAIL 数与退出码
```

| 测试 | 覆盖 | 断言数 |
| --- | --- | --- |
| `tools/smoke.js` | 造临时素材跑 `flatten.plan/run → compliance.scan/fix → copy.generate → verify.check → sheet.export → publish.run → mergeResults` | 23 |
| `tools/adbtest.js` | 用**假 adb**（`tools/fakeadb/`，运行时复制到临时目录）验证真实发布通道：指令序列、坐标点击、中文广播输入、失败截图；失败恢复动作的校验（不认识的 action 要说清可用值） | 27 |
| `tools/pendingtest.js` | 把发布单 `chmod 0444` 模拟「Excel 被占用」→ 断言整批暂存 → 恢复可写后下次补写；设备增删去重 | 9 |
| `tools/compliancetest.js` | 合规边界：合格 JPG 只能有 1 条 ok、`fix()` 绝不把它搬进 `_rejected`；「导出报告」xlsx（汇总+明细）+ csv（带 BOM） | 16 |
| `tools/batchtest.js` | 多批次并行（不同批次同时跑、同批次不重复起）、按 job id 取消 / 按类型全部取消、按批次重导出日志、失败恢复动作保存与校验 | 22 |
| `tools/uicheck.js` | 隐藏窗口加载真实渲染层：`BLUEV_NO_LOGIN=1` 免登录、7 个页签渲染、**零控制台报错**、新按钮挂载、批次面板出现/消失、恢复动作走真实 IPC 存进配置 | 18 |
| `tools/logintest.js` | 登录门（**不开**免登录）：未登录时业务通道被主进程拦掉、错口令不泄露账号是否存在、记住登录落盘且重启免密、普通成员看不到账号列表、停用后不能登录、不能停用/删自己、退出回登录门、连错 6 次锁定 | 32 |

合计 **147** 项断言。`logintest.js` / `uicheck.js` 都把 `userData` 指到临时目录，**不会动你本机的 auth.json / config.json / project.json**。`tools/run-all.sh` 会自己找 node、给本机 Electron 自签（见 §3 的坑），
`uicheck.js` 把 `userData` 指到临时目录，**不会动你本机的 config.json / auth.json / project.json**。

假 adb 已经进仓库，不用再手写：`tools/fakeadb/{adb,window.xml,shot.png}`；
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
| `tools/run-all.sh` | 一键回归：六套测试 + 隐藏窗口界面自检，共 147 项断言 |
| `.gitignore` | 已按「不提交 node_modules / dist / 运行时数据」写好并生效 |

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
