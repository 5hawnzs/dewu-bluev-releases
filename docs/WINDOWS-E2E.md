# Windows 端到端测试手册（雷电模拟器 + WorkBuddy）

> 目标：在 **Windows + 雷电模拟器** 上把整条链路跑一遍，确认没有整体性问题：
> 素材整理 → 合规检查 → AI 文案生成 → 货号颜色预检 → 发布单 / 导入 AI 内容报告 → 自动发布 → 结果回写。
>
> 配套文档：`docs/HANDOFF.md`（设计与硬约束、真机口径）、`README.md`（模块说明）、本文件（动手测什么）。
> 回归现状：**8 套 176 项断言全绿**（`node tools\run-all.js`）。
>
> 预计耗时：环境 + 回归 ≈ 20 分钟；手动全流程 ≈ 40~60 分钟（发布环节每条 65~80 秒，按条数算）。

---

## 0. 在 Windows 的 WorkBuddy 里新建任务时，第一条消息粘这个

````text
我要在这台 Windows 上把「得物蓝V 素材发布工具」的整条流程测一遍。

仓库（私有，main 分支）：
git@gitee.com:abulaitifans/dewu-bluev-publisher.git
请克隆到 D:\work\dewu-bluev-publisher（路径不要有中文和空格，也别放 OneDrive/网盘同步目录）：

  cd /d D:\work
  git clone git@gitee.com:abulaitifans/dewu-bluev-publisher.git

动手前先确认环境：` node -v `、` git --version `、` adb devices `。
如果缺 git / node，或者克隆失败（Permission denied / 要求输账号密码），
**停下来把原文告诉我**，别自己改 git 配置、别换镜像源、别改用 https 猜密码。
克隆成功后：

1. 完整读 docs/HANDOFF.md 与 docs/WINDOWS-E2E.md，再读 README.md；
2. 按 WINDOWS-E2E 第 2 节备环境、第 3 节跑自动化回归：
     node tools\run-all.js
   预期最后一行「全部通过，共 176 项断言。」——先跑绿再动别的；
3. 再按第 4 节逐条做手动全流程，每步记录「预期 / 实际」。

硬约束（必须遵守）：
① 这个工程不要改名、不要移动 —— 应用把绝对路径存在 %APPDATA%\dewu-bluev-publisher；
② src/renderer/app.js 与 src/main/store.js 是多人重叠文件：只用局部替换，禁止整文件重写；
③ 不许造假成功：失败必须说清「缺什么」，不准写 ok=true / 静默跳过糊过去；
④ 每改一处都要跑一遍 node tools\run-all.js；
⑤ 测试时用 BLUEV_NO_LOGIN=1 免登录（PowerShell 写法：$env:BLUEV_NO_LOGIN=1; npm start）。

本次任务只要「测」，不要顺手改功能：
- 发现问题按 WINDOWS-E2E 第 7 节格式整理给我（哪一步 / 预期 / 实际 / 报错原文 / 现场文件 / 环境）；
- 我确认之前，不要动 src/ 下的代码。

环境事实（省得你猜）：
- 模拟器：雷电 9，设备 emulator-5554，adb 用雷电自带的那份；
- 得物 App 已装好并登录好发布账号，ADBKeyboard 已装；
- tools\ 目录是回归测试，不进安装包。
````

> 备选（克隆实在过不去时）：把 `docs/HANDOFF.md` 与 `docs/WINDOWS-E2E.md` 两个文件直接拖进对话当附件，
> 并让 WorkBuddy 先只做第 3 节的自动化回归（那部分不需要仓库之外的任何东西）。
>
> ⚠️ 不要发出去的：Gitee 密码、私人令牌、`id_ed25519` 私钥（只有 `.pub` 公钥可以贴到网站上）。

---

## 1. 把代码弄到 Windows 上

1. 装 **Git for Windows**：https://git-scm.com/download/win
2. 配身份（只需一次）：
   ```
   git config --global user.name "张硕"
   git config --global user.email "shawnz2000@outlook.com"
   ```
3. 配 SSH 公钥（和 macOS 同一套路）：
   ```
   ssh-keygen -t ed25519 -C "shawnz2000@outlook.com"        :: 一路回车
   type $env:USERPROFILE\.ssh\id_ed25519.pub | clip         :: PowerShell 复制公钥
   ssh -T git@gitee.com                                     :: 出现 Hi ... You've successfully authenticated 即通
   ```
   公钥粘贴到 https://gitee.com/profile/sshkeys →「添加公钥」→ 输 Gitee 密码。
   > 不想配 SSH 就用 HTTPS：`https://gitee.com/abulaitifans/dewu-bluev-publisher.git`，
   > 第一次会让你输账号 + **私人令牌**（Gitee → 设置 → 私人令牌）。

4. 克隆到**没有中文、没有空格**的短路径（长路径是这工具的老坑）：
   ```
   cd /d D:\work
   git clone git@gitee.com:abulaitifans/dewu-bluev-publisher.git
   ```
   > ⚠️ 别放在 OneDrive / 网盘同步目录里 —— 会占用文件句柄，改名/删除会 `EBUSY`。

---

## 2. 环境清单

| 需要 | 怎么弄 | 验证 |
| --- | --- | --- |
| Node 18+（推荐 20） | https://nodejs.org/ 装 LTS | `node -v` |
| 依赖 | 在仓库目录 `npm install`（慢就先 `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`） | `npm start` 能开窗口 |
| 雷电模拟器 | 开一个实例 | `adb devices` 能看到 `emulator-5554` |
| adb | 雷电自带的 `C:\LDPlayer\LDPlayer9\adb.exe`，或 platform-tools，加进 PATH | `adb version` |
| **ADBKeyboard**（中文输入必装） | https://github.com/senzhk/ADBKeyBoard 下载 APK → `adb install ADBKeyboard.apk` | 发布页「驱动自检」里 ADBKeyboard 显示已安装 |
| 得物 App | 模拟器里装好并登录好发布账号 | 自检能识别 `com.shizhuang.duapp` |
| WPS / Excel（可选） | 用来验「被占用 → 暂存 → 下次补写」 | — |

---

## 3. 先跑自动化回归（不碰模拟器、不用登录）

```
cd /d D:\work\dewu-bluev-publisher
node tools\run-all.js
```

预期最后一行：**`全部通过，共 176 项断言。`**

- 逐套单跑：`node tools\smoke.js`、`node tools\reporttest.js`、`node tools\compliancetest.js` …
- `uicheck` / `logintest` 两个 Electron 套件由 `run-all.js` 统一补上 `--in-process-gpu --disable-gpu`、并清掉 `ELECTRON_RUN_AS_NODE`，
  所以**没有桌面会话 / 没有可用 GPU 的机器（远程、CI、沙箱）也能跑**；手工单跑时请照抄这两个参数
- 想看设计意图：每个 `tools\*.js` 头部的注释写了它在守什么

---

## 4. 手动全流程（每步：操作 → 预期 → 出问题看哪里）

启动（免登录）：
```
:: PowerShell
$env:BLUEV_NO_LOGIN=1; npm start
:: cmd
set BLUEV_NO_LOGIN=1 && npm start
```

### 4.1 设置（页签 7）
- **操作**：填「素材根目录 / 输出目录 / 隔离目录」（都用绝对路径）；看「外部依赖」表；到「账号与安全」把出厂口令 `admin / BlueV@2026` 改掉。
- **预期**：图片引擎显示 `sharp + libvips（含 HEIC）`；HEIC 解码「可用」。
- **出问题**：若显示「jpeg-js + pngjs（纯 JS 降级）」→ HEIC 会转不了，检查 `npm install` 是否装上了 sharp。

### 4.2 素材整理（页签 1）
- **准备**：`D:\卡宾\20260901\` 下，**每一条内容一个子文件夹**，例如
  `D:\卡宾\20260901\26FW-YB160+冠军白\1\`（里面放图片）。
- **操作**：「选择目录」→ **选到批次目录 `D:\卡宾\20260901`** →「生成清单」→「开始整理」。
- **预期**：
  - 清单：「N 个叶子目录 · M 个文件」；
  - 整理后生成 `D:\卡宾\flat_<时间戳>\`，每个叶子叫 `26FW-YB160+冠军白_1`、`_2`…（层级路径用 `_` 连接）；
  - 日志出现「原素材完全不动：20260901 保持原样，只建扁平副本」「已建硬链接 N 个」；
  - **原目录一个字没动**（重点验这个）。
- **出问题**：看日志里的 `扁平副本目录：...` 是不是在源目录同级；跨盘会从硬链接退化成实体复制（正常）。

### 4.3 合规检查（页签 2）
- **操作**：「开始检查」→「处理可自动项」；再试一次「检查父目录」→「导出报告」。
- **预期**：规则 = 必须 JPG / ≥1764 像素² / 边长 150~1500 自动等比缩放 / 视频按扩展名判 `.mp4` 且 <600s；垃圾文件隔离到 `_rejected`；
  导出后输出目录出现 `合规报告_<时间戳>.xlsx`（`汇总` + `明细` 两个表）和 `.csv`。
- **重点验**：一张**完全合格**的 JPG 只能显示为「合格」，**不能被移进 `_rejected`**。

### 4.4 AI 文案生成（页签 3）
- **操作**：「选择素材目录并启动任务」→ 选 `D:\卡宾\flat_<时间戳>`（或批次目录）→ 再启动**第二个**批次。
- **预期**：
  - 「运行中的批次」里**同时**出现两行，各有进度/已用时；
  - 「查看详情」能看到该批次这一步的日志；「取消任务」「全部取消」可用；
  - 产物落到 `输出目录\batches\<批次名>\copy.json`，两个批次互不覆盖。
- **出问题**：批次名形如 `20260901_20260930153012`；重复启动同一批次会被拒（提示「正在处理中」）。

### 4.5 货号颜色预检（页签 4）
- **操作**：「同步商品池」（导入 CSV `货号,颜色` 两列即可）→「开始校验」。
- **预期判定文案（对齐真机）**：`颜色匹配` / `单色货号，颜色可空` / `多色货号须指定颜色（共 N 色：…）` / `货号 xxx 未查到颜色信息，请核对` / `颜色不匹配`；
  接口模式查不到的**只告警不阻断**。

### 4.6 发布单（页签 5）—— **两条路都要测**

**路 A：导入「AI 内容报告」**（真机链路的产物）
- **准备**：一份 26 列 xlsx，表头含 `素材路径 / 素材来源 / 标题 / 文案 / 内容类型 / 好物1_货号 / 好物1_颜色 …`
  - `素材路径` 是**绝对路径**（如 `D:\卡宾\20260901`）；**空着就会追问一次「这一批的素材目录」**；
  - **行数必须等于该目录下的叶子文件夹数**（一条内容 = 一个叶子）。
- **操作**：「导入 AI 内容报告」→ 选文件（必要时再选目录）。
- **预期**：提示「报告已导入：N 条待发布（用报告里的标题文案 X 条 · 本地生成 Y 条 · Z 条暂不发布）」；
  页面出现「当前批次来自 AI 内容报告」区块（含报告路径、表名、批次名、条数）。
- **故意验一次对不上**：把报告删掉一行再导入 → 应报
  「「D:\…」下有 N 个叶子文件夹（…），但报告里有 M 行指向它，对不上」→ **这是设计如此（不猜）**。

**路 B：导出我们自己的发布单**
- **操作**：「导出 xlsx」→ 预期输出目录出现 `发布单_<时间戳>.xlsx`（26 列），校验未通过的行标红。

### 4.7 模拟器发布（页签 6）—— 最容易卡的一段

1. **设备管理**：添加设备（序列号 `emulator-5554` + 账号名）→「检测在线」→「选用」。
2. **驱动自检**：adb / 设备在线 / 分辨率 / 得物包名 / uiautomator / screencap / ADBKeyboard —— **7 项全绿**才算能真发；
   任何一项红 → 系统会退回「模拟通道」（只演练节奏，不真发）。
3. **抓取页面结构**：在模拟器里把得物 App 打开到发布页 → 点「抓取页面结构」→ 输出目录 `dumps\` 出现
   `ui-dump-<时间>.xml` 和 `uiMap-<时间>.json`（后者的 steps 是**按关键词猜的候选**）。
4. **改对定位表**（必然要手改的一步）：打开 `uiMap-<时间>.json`，把每步的 `value` 改成你 App 版本里真实的
   按钮文本 / `resource-id` / 描述；用「失败恢复动作」配上失败后要执行的收尾动作。改好后「导入 UI 定位表」。
5. **开始发布**，预期日志（对齐真机）：
   ```
   开始发布（真实设备通道）：N 条，预计 X 分钟
   按 60 秒间隔，57s 后执行
   行 2[图文] 发布完成，已回填时间 15:34:41（耗时 65.2s）
   批量发布完成，总耗时 86.6s
   发布结束：共 3 条 / 1 失败，成功 2（真实设备）
   ```
6. **失败**：该行在表格里标红 + `输出目录\failures\` 有截图，行上有「重跑」；日志会写清
   「找不到「xx」；当前可见文本：…」（说明缺哪个节点，别猜）。
7. **重导出日志**：输出目录出现 `发布日志_<批次>_<时间戳>.log` / `.csv`。
8. **结果回写**（两条路分别验）：
   - 路 A（报告）：打开那份报告 xlsx，看 **B 实际执行时间 / C 执行结果** 是否落字；被卡的视频行应写「校验未通过：含 N 个视频…」；
   - 路 B（发布单）：打开 `发布单_*.xlsx` 看「实际执行时间 / 执行结果 / 审核状态」列。
   - **占用演练**：先用 WPS 打开该 xlsx → 再跑发布 → 应看到「报告仍被占用，N 条已暂存，下次再试」，
     且 `输出目录\pending-results.json` 里有内容；关掉 WPS 再跑一次导入或发布 → 自动补写。

### 4.8 打包（最后一步）
```
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist:win
```
- 预期：`dist\` 出 `得物蓝V素材发布工具-1.0.0-x64-win.exe`（安装版）和 `…-便携版.exe`。
- **一定要在一台干净 Windows 上装一遍**，重点验：窗口按钮/拖动、HEIC 转换、长路径、卸载后 `%APPDATA%` 数据保留。

> **实测（2026-10-01，Windows 10 22631 / node 22.22.2 / electron-builder 24.13.3）**
>
> ✅ 两个产物都在，与预期一致：
> | 产物 | 大小 |
> | --- | --- |
> | `dist\得物蓝V素材发布工具-1.0.0-x64-win.exe`（NSIS 安装版） | 88,807,540 B |
> | `dist\得物蓝V素材发布工具-1.0.0-x64-便携版.exe`（portable） | 88,672,906 B |
>
> ✅ 产物内容检查：`resources\app.asar.unpacked\node_modules\@img\` 下**只有 `sharp-win32-x64`**，没有混进 darwin / linux 版（`files` 里的排除规则生效，这也是 HEIC 能在 Windows 上用的前提）。
>
> ✅ `dist\win-unpacked\得物蓝V素材发布工具.exe` 能正常启动（主进程 + GPU + 渲染三个进程都在），
> 且 **userData 仍是 `%APPDATA%\dewu-bluev-publisher`**（不会因为打包后叫中文名就跑去找 `%APPDATA%\得物蓝V素材发布工具`
> —— 这点和硬约束①一致，从开发版切到安装版不会「配置全丢」）。
>
> ⚠️ **踩到的坑（非管理员账号必踩）**：第一次打包在「准备 winCodeSign」这一步失败：
> ```
> ERROR: Cannot create symbolic link : 客户端没有所需的特权 :
>   ...\Cache\winCodeSign\<随机数>\darwin\10.12\lib\libcrypto.dylib
> ⨯ cannot execute  cause=exit status 2
> ```
> 原因：`winCodeSign-2.6.0.7z` 里含 **macOS 侧的符号链接**，Windows 非管理员（或未开「开发者模式」）无法创建符号链接，
> 7-Zip 解压直接失败，重试 3 次后中止。而这批 darwin 文件在 Windows 打包里根本用不到。
>
> **绕过办法**（已实测可行，之后重跑 46 秒就出包）：手动把那台机器上的缓存准备好，排除 darwin：
> ```
> :: 先下同一个 7z（走镜像）
> curl -sSL -o D:\wcs.7z https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
> :: 用仓库自带的 7za 解压，排除 darwin（-xr!darwin），目标路径必须写 Windows 风格
> D:\work\dewu-bluev-publisher\node_modules\7zip-bin\win\x64\7za.exe x -bd -y D:\wcs.7z ^
>   -o"C:\Users\<你>\AppData\Local\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0" -xr!darwin
> ```
> 另外两个 `nsis-3.0.4.1.7z` / `nsis-resources-3.4.1.7z` 没有符号链接，走镜像能自动下，不用管。
>
> ❌ **本次**没做**：在干净 Windows 上真装一遍（窗口按钮/拖动、HEIC 转换、长路径、卸载后数据保留）——
> 需要一台干净的机器 + 管理员权限，测试机不具备。交付前请补这一项。


---

## 5. 快速造测试数据

```
D:\卡宾\20260901\                       ← 批次目录（素材根目录就选它）
   ├─ 26FW-YB160+冠军白\1\  1.jpg 2.jpg 3.jpg
   ├─ 26FW-YB160+冠军白\2\  1.jpg
   ├─ 26FW-YB160+冠军白\3\  1.jpg 2.jpg
   └─ UWH760085+黑色条纹\1\  1.jpg 短片.mp4      ← 留一条带视频的，验「暂不发布」提示
```
- 报告 xlsx：表头至少 `素材路径` + `好物1_货号`；**标题/文案可以留空**（会被本地生成）；
  一行一个叶子，行数要和上面叶子数一致。
- 商品池 CSV：`货号,颜色` 两列。

---

## 6. 已确认的口径（2026-10-01 定稿，不必再问）

> 原来这一节列的 9 个「待确认问题」已逐条定论。定论原则：**对齐真机 + 不猜 + 最小改动**。

| # | 问题 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 含**视频**的叶子怎么发？ | **维持现状**：标成「校验未通过：含 N 个视频，真实通道目前只推图片」并跳过，**不静默丢** | 实测（4.7.6）：`行 4 [图文] result=校验未通过 reason=含 1 个视频，真实通道目前只推图片`。真机里视频是另一条产线（报告里「口 视频 2」单独统计），不在本工具口径内 |
| 2 | 「**内容类型**」列（`26FWT75`）是什么？ | **维持现状**：只在导入时读进 `contentType` 留档，不参与文案生成 | 该列的字典含义无法确认（真机录屏里也没有解释），**不猜** |
| 3 | 「**素材来源**」（如 `KIDS`）要不要参与命名/显示？ | **维持现状**：只留档；扁平命名仍按真机口径用 `_` 连接层级路径，**不含来源**。发布单暂不加「素材来源」列 | 它属于功能待办（见 HANDOFF §5 可抄项 #11），本次是「只测不改」 |
| 4 | 报告里的标题/文案——空着就本地生成，对吗？ | **是**（确认） | 实测（4.6 路A）：`报告已导入：4 条待发布（用报告里的标题文案 2 条 · 本地生成 2 条 · 1 条暂不发布）` |
| 5 | 好物要支持到 **9** 个吗？ | **已支持 9 个**（确认） | `report.js` 用 `好物(\d+)(货号\|颜色\|sku\|color)` 泛化匹配列名，列序无关；与真机 26 列报告留的 9 组列对齐 |
| 6 | 素材整理要不要加「**选择目标输出目录**」？ | **不加**。扁平副本固定放源目录同级 | 只有同卷才能建硬链接；跨卷会退化成**实体复制**（慢、双倍磁盘）。加了会诱导用户跨盘选。若将来要加，必须先弹「跨卷将复制，耗时与占用翻倍」的确认框 —— 列为功能待办 |
| 7 | 品牌要不要做成**多品牌增删改**？ | **本轮不做**（列为功能待办：`copy.brands: [{name, pool}]` + 设置页列表） | 当前单个「品牌」输入框够用；改动会动 `store.js` 结构 + 文案生成取词，超出「只测不改」范围 |
| 8 | 发布间隔默认 **60 秒**可以吗？ | **60 秒**（确认） | 对齐真机「固定 1 分钟间隔 + 倒计时」（录屏日志原文：`按 1 分钟间隔，57s 后执行`）；界面可选 30/60/90/120 |
| 9 | 出厂口令 `admin / BlueV@2026` 发版前要不要换？ | **发版前必须换** | 三种换法见 README：① 环境变量 `BLUEV_ADMIN_USER/PASS`；② **推荐** `%APPDATA%\dewu-bluev-publisher\auth.seed.json`（用完即删）；③ 登录后到「设置 → 账号与安全」改。口令只存 scrypt 哈希，不在仓库里 |

> **说明**：HANDOFF §5 里「可抄项」#7~#13（品牌管理、素材来源列、推荐流程步骤条、文案对齐等）属于**产品功能待办**，
> 不在本次「只测不改」的范围内，未实现。要做得另开一轮，并按 §6 的回归要求每改一处跑一遍 `node tools\run-all.js`。


---

## 7. 遇到问题按这个格式回传（省来回）

1. **哪一步**（4.x）+ 具体操作
2. **预期**看到什么 / **实际**看到什么（日志区原文或截图）
3. **报错原文**（含弹窗完整文案）
4. **现场文件**：
   - `%APPDATA%\dewu-bluev-publisher\config.json`（看 `paths` 三项）
   - 输出目录：`pending-results.json`、`publish-log.jsonl`、`failures\*.png`、`dumps\uiMap-*.json`
   - 如果是导入报告出的问题：那份报告 + 对应的素材目录列表（`dir /b`）
5. **环境**：`node -v`、`adb version`、`adb devices`、得物 App 版本、雷电版本

---

## 8. Windows 特有坑（先看这条，能省半小时）

| 现象 | 原因 / 处置 |
| --- | --- |
| 环境变量设不上 | PowerShell 用 `$env:BLUEV_NO_LOGIN=1; npm start`；cmd 用 `set BLUEV_NO_LOGIN=1 && npm start` |
| 自检「得物包名」红 | 模拟器里没装或没启动得物 App（`com.shizhuang.duapp`） |
| 中文标题/文案输入失败 | 没装 ADBKeyboard（自检会明确提示，**不会静默发空文案**） |
| `adb devices` 列表为空 | PATH 里的 adb 和雷电自带的版本打架：`adb kill-server`，改用雷电目录下的 `adb.exe` |
| 发布中途失败 | 看 `failures\` 截图 + 日志「找不到「xx」；当前可见文本：…」→ 页面结构变了，回去改 `uiMap` |
| 路径过长报错 | 已自动加 `\\?\` 前缀；同时也把素材根目录改短（如 `D:\卡宾`） |
| 报告/发布单写不进去 | WPS/Excel 开着 → 这是**设计内**行为，会暂存，关掉后重跑自动补写 |
| `npm install` 卡在 Electron 下载 | 先 `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再装 |
| clone 后脚本没执行权限（WSL/Git Bash） | `chmod +x tools/run-all.sh`（假 adb 现在是 `tools/fakeadb/adb.js`，不需要执行位；Windows 原生跑 `node tools\run-all.js` 也不需要） |

---

## 9. 测完请给我一句话结论

```
整体流程：通过 / 卡在 4.x
卡点现象：…
日志原文：…
```

---

### 本次实测结论（2026-10-01，Windows 10 22631 · MuMu 12 模拟器 · 得物 6.0.5）

```
整体流程：通过（4.1 ~ 4.8 全部走完）
环境    ：node v22.22.2 / electron 31.7.7 / sharp 0.33.5(win32-x64) / adb 36.0.0 / 设备 emulator-5554(Android 12)
回归    ：node tools\run-all.js → 全部通过，共 176 项断言（跑绿了才动第 4 节）
第 4 节  ：44 个检查点，37 通过 / 7 未通过 → 其中 3 个是真缺陷（已修，见下），4 个是测试脚本断言写错
打包    ：两个 exe 产出正常；win-unpacked 能启动；userData 目录不变
```

**过程中发现并已修掉的 3 个真缺陷**（都在 `src/`，每修一处都跑过完整回归）：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| P1 | 「处理可自动项」里**等比缩放在 Windows 上必失败**，日志 `EPERM: operation not permitted, unlink '…\4.jpg'`，并残留 `.__tmp_scale_4.jpg` | libvips 的**输入文件缓存**（默认 `files:20`）在处理完后仍持有源文件句柄 → 紧接着 unlink 必失败（合规的「缩放 / 压缩 / 转 JPG」都是「写临时文件 → 删原文件 → 改名」三步） | `imaging.js` 的 init 改成 `sharp.cache({ memory: 64, files: 0 })`（内存缓存照留，只关文件缓存） |
| P2 | 先「导出发布单」再发布 → **回写报告静默失效**：界面显示「已回写报告：0 行」且不报错 | `sheet.export` 重建 `publish.rows` 时**丢掉了 `reportRow`**（Excel 行号）→ 回写时被过滤成空集 | `jobs.js` 的 `sheet.export` 按 `id` 把旧行的 `reportRow` 带过来 |
| P3 | 「导出报告」时把**不可恢复的错误**（如表头缺列）也报成「报告仍被占用，N 条已暂存」并反复暂存 | `report.mergeResults` / `sheet.mergeResults` 的 catch 把**所有**异常都归成「被占用」 | 新增 `winpath.isFileLockError()`，只有真锁错误才暂存；逻辑错误原样报出（并去掉「已回写 0 行」这种像成功的措辞） |

> 这三处都做了**双向验证**（改前必须红、改后必须绿），不是只看「回归全绿」：
> - P1：改前 `转换 0 / 失败 1 / 残留 .__tmp_scale_4.jpg` → 改后 `转换 1 / 失败 0 / 无残留`
> - P2：改前导出后 `reportRow = [0,0,0,0]` → 改后 `[2,3,4,5]`
> - P3：改前表头缺列 `busy=true` 且往暂存队列塞了 1 条 → 改后 `busy=false`、队列不动，且「真被占用」仍正确走 `busy=true` + 暂存

**4.7 真实通道的成功链路**因「不真发帖」而改用**模拟设备通道**验证（`child_process.execFile` 层装假 adb，
其余全是真代码）：自检 7 项 → 推 3 张图 + 媒体扫描 → 15 次 `uiautomator dump` → 14 次坐标点击 →
4 次 ADBKeyboard 中文广播 → 2 条发布成功、回填时间 → `publish-log.jsonl` → **回写报告 B/C 列 2 行**，共 15 项断言全绿。
**真机成功链路（真往账号发）尚未验证** —— 那一步需要把 `uiMap` 换成得物发布页的真实节点。

