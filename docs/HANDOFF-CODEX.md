# 交接给 Codex（或任何 CLI 编码代理）

> 最后更新：**2026-10-05 18:4x** · 版本 **1.0.15**
>
> ★ 本文件**不再钉死 HEAD 哈希**（钉了就必然过期）：要用就现查 `git log -1 --format=%H`。
>
> 这份是**入口**。完整内容在 `docs/HANDOFF.md`（2400+ 行）；规则全文在 `docs/knowledge/`。

---

## 0. 结论先说：git 里已有什么、还缺什么

| | 内容 | 状态 |
| --- | --- | --- |
| ✅ **git 里全都有** | 源码、17 套回归测试、给 AI 的入口文档（`AGENTS.md`）、全部交接文档、**以及新增的知识库 `docs/knowledge/`**（规则全文 / 跨项目规范 / 29 个技能 / 90 份历史文档 / 6 份工作日志 / 已部署站点源码） | clone 完就能开工 |
| ⬜ **git 外，但本机已经就位** | 发版凭据 `D:\work\dewu-bluev-publisher\.env`（已 gitignore）、模拟器 MuMu 12、真机得物 App、推 gitee 的 SSH key、`node_modules`（重装即可） | **在同机运行 = 不用转移**；换机才需另给 |
| ⬜ **git 外，二进制/原件** | 已发出的安装包 `dist\`、归档 `D:\work\_dist-archive\`、插件中心的 109 MB 安装包、411 个取证原件与截图 | 按需索取，**故意不进 git** |

> **一句话**：让 Codex 在**这台机器上**、**这个仓库里**干活，它缺的只有 `node_modules`（跑一次 `npm install`）。
>
> ★★ **换到另一台机器跑？那是另一回事** —— 除了环境，还要搬三份**不能走 git 的敏感文件**
> （`config.json` 含真实模型密钥与真机 UI 定位表、`auth.json` 含账号口令、`.env` 含 COS 密钥），
> 并在新机重置两处（`cloud.machineId` / 绝对路径）。
> ★ `config.json` **别整份拷**：用 **`node tools/config-portable.js`**（`inspect` / `export` / `import` / `selftest`）
> —— 它会把绝对路径与 `machineId` 显式置空、默认抹掉密钥、导入前先备份、默认只预演。
> **完整步骤见 [`HANDOFF-NEW-MACHINE.md`](HANDOFF-NEW-MACHINE.md)（§3.1 = 配置怎么搬）。**

---

## 1. 粘给 Codex 的第一条消息

```text
接手 D:\work\dewu-bluev-publisher（Electron / Windows 素材发布工具，当前 v1.0.15）。

第一步按顺序读：AGENTS.md → docs/HANDOFF.md §0/§2/§3/§6 → docs/HANDOFF-CODEX.md。
知识库在 docs/knowledge/（规则全文 RULES-得物蓝V.md 4300+ 行、跨项目规范 RULES-通用.md、
29 个技能、90 份历史文档、6 份工作日志）—— 按 docs/knowledge/README.md 的索引查，别整读。

四条硬约束：
① 项目目录不许改名/移动（配置与构建产物里存的是绝对路径）；
② src/renderer/app.js 与 src/main/store.js 只许局部替换，禁止整文件重写；
③ 每改一处跑 node tools/run-all.js；★★ 绝不要设 BLUEV_NO_LOGIN（logintest 断言的正是"它没设"，设了会 FAIL 并挂住不退）；
④ 中文注释/界面文案；取不到就写"取不到"，未知≠0，绝不许造假成功。

断言数每次实测重取（README 里的套件表已过时）。改完必须能回答：
"我改掉了哪条判断？哪条断言会因此变红？"——答不上来就等于没验证。
```

---

## 2. git 里已有的东西（`git clone` 即得）

| 路径 | 内容 | 文件数 |
| --- | --- | --- |
| `AGENTS.md` | **给 AI 代理的入口须知**（Codex 会自动读这个文件）：9 条硬约束、验收标准、环境表、做不到的事、文档索引 | 1 |
| `docs/HANDOFF.md` | 全部交接内容：硬约束 / 已完成（**不要重做**）/ 待办 / 真机口径 / 发版 SOP / 回归套件表 | 1 |
| `docs/HANDOFF-CODEX.md` | 本文件（一页纸入口） | 1 |
| `docs/HANDOFF-NEW-MACHINE.md` | **换机方案**（含 §3.1 配置搬运工具用法） | 1 |
| `docs/WINDOWS-E2E.md` | Windows + 模拟器端到端测试手册 | 1 |
| `docs/knowledge/` | **知识库**（见 `docs/knowledge/README.md`） | 151 |
| `docs/visual/` | 功能全景可视化文档（`build.js` 是生成器，数字从产物读） | 3 |
| `docs/supabase-setup.sql` | 云端协作侧建表与策略 | 1 |
| `src/` | 主进程 / 渲染层 / 服务（39 个文件） | 39 |
| `tools/` | 17 套回归 + 假 adb 替身 + 发版与维护工具（`upload-release.js` / `prune-release.js` / `verifypack.js` / `config-portable.js`） | 34 |
| `vendor/` | **随包内置**：adb、ffmpeg、ADBKeyboard.apk、以及 `README.md`（逐文件 md5 对账） | 10 |
| `web/` `build/` | 发布看板 + 图标源 | 4 |
| `README.md` `package.json` `.gitignore` | 模块说明与测试套件表 / 构建与发布配置 / **忽略规则（含"凭据绝不入库"）** | 3 |

**远端**：`https://github.com/wfjdyhmtr2-glitch/dewu-bluev-publisher.git`（★ **私有**），分支 `main`。
> ★★ 2026-10-08 **换过远端**：原 `git@gitee.com:abulaitifans/dewu-bluev-publisher.git` 已弃用。
> 原因：Gitee 免费版把「单文件 / 单仓库容量」卡死了 —— 内置的得物安装包 127.1 MiB 进不去（实测
> `size: 120.666MB, exceeds quota 100MB`），且总仓库容量已逼近 500 MB 上限。
> **GitHub 单文件同样是 100 MiB 硬限**（这点没变好），但**仓库总量与私有仓库协作人数没有硬锁**。
> 因此得物安装包在仓库里是**分卷**存的（`vendor/dewu/dewu_6.0.5.apk.part01/.part02`，
> 打包前用 `node tools/dewuapk-assemble.js` 拼回，`npm run dist:win` 已自动带上）—— 见 `vendor/README.md` §4.1。
> 推送凭据 = **HTTPS + Personal Access Token**（在 `~/.git-credentials`；原机**没有**把 SSH 公钥登记到 GitHub）。
**提交身份**：`张硕 <shawnz2000@outlook.com>`（若换机 clone，先把它设成你自己的 —— 见 `docs/HANDOFF.md` §10）。

---

## 3. git 之外，必须「在这台机器上存在」的东西

逐条可核。**前两项是真正会挡住开工的**。

| # | 项 | 位置 / 怎么核 | 挡不挡开工 |
| --- | --- | --- | --- |
| 1 | **依赖** | `D:\work\dewu-bluev-publisher` 下跑 `npm install`，再跑一次 `npm run addon:win`（强制取 Windows 版 sharp；交叉打包带上 macOS 版会让 HEIC 失效） | ★ 挡 |
| 2 | **发版凭据** | 仓库根 `.env`（已存在，518 B，已 gitignore）：`COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION`。**只在打包机上，绝不许进 git、绝不许贴出来** | 只在发版时挡 |
| 3 | **推代码的凭据** | ★ 2026-10-08 起走 **HTTPS + Personal Access Token**：`~/.git-credentials` 里一条 `https://<用户名>:<token>@github.com`（token 要 `repo` 权限）。原机那把 `~/.ssh/id_ed25519` **没有登记到 GitHub**，别指望 `git@github.com:` 能推（实测 `Permission denied (publickey)`）。取证：`git ls-remote origin` 返回即通 | 只在推送时挡 |
| 4 | **模拟器** | MuMu 12，装机路径 `D:\MUMU\MuMuPlayer\nx_main`（**本机没有雷电**）。设备串以 `adb devices` **真名**为准 —— 同一台机可能同时报 `127.0.0.1:16384` 与 `emulator-5554`，按 `android_id` 去重 | 跑发布链路时挡 |
| 5 | **真机得物 App** | 发布链路**只能在真机上验证**；没有设备就只能改代码、跑不依赖设备的回归 | 跑发布链路时挡 |
| 6 | **素材** | 图片/视频/Excel 发布单（`报告*.xlsx`）；有些用例还要「Excel 被 WPS 占用」这种现场条件 | 跑发布链路时挡 |
| 7 | **内置依赖** | `vendor/adb`、`vendor/ffmpeg`、`vendor/adbkeyboard/ADBKeyboard.apk` —— **这些在 git 里**，不用另外给 | 不挡 |
| 8 | **运行时配置** | `%APPDATA%\dewu-bluev-publisher\config.json`（含模型密钥 + **真机 UI 定位表 38+41 步**）与 `auth.json`。**同机已就位**；换机用 `node tools/config-portable.js` 搬（**别整份拷**），并重置 `cloud.machineId` 与 `paths.*` | 跑发布链路时挡 |

> ★ 内置的 adb / ffmpeg **不进 asar**（asar 里的 exe 不能执行），走 `build.extraResources` 搬到 `resources/`。
> 用户手填路径优先于内置；手填的路径不存在但内置可用 ⇒ 退回内置并**在结果里说出来**。

---

## 4. 当前状态快照（2026-10-05 18:4x）

| 项 | 实测值 |
| --- | --- |
| 远端 / 分支 | `https://github.com/wfjdyhmtr2-glitch/dewu-bluev-publisher.git` / `main`（★ 2026-10-08 从 Gitee 迁来） |
| HEAD | **现查** `git log -1 --format=%H`（本文件不钉哈希，钉了就必然过期） |
| 提交总数 | 编制时 `git rev-list --count HEAD` = **102** |
| 工作树 | 干净（`git status --short` 无输出） |
| 版本号 | `package.json` = **1.0.15** |
| 回归 | **17 套 1622 项全绿**（2026-10-05 18:3x 实测；`adbtest` 单套就要 3 分钟以上，别用 90s 超时去卡它） |
| 公网通道 | **1.0.15 已上线**，`latest.yml` = 1.0.15；`beta.yml` 未动 |
| 更新源 | `package.json` `build.publish` = generic provider → `https://dewu-bluev-release-1499238579.cos.ap-guangzhou.myqcloud.com/`，`channel: latest`（**源地址编译进包，运行时不改**；通道名 `latest`/`beta` 只是读哪个 yml） |
| 产物 | `dist\得物蓝V素材发布工具-1.0.15-x64-win.exe` = **107,095,416 B**（`dist\` 里恰好 1 个 exe） |
| 归档 | `D:\work\_dist-archive\1.0.14-by-me-20261005-1347\` |
| 本机已装副本 | 仍是 **1.0.13** —— 按 `发版流程SOP.md` 明文「下载与安装必须由用户自己点，没有任何自动化路径」⇒ **故意不换 asar**，升级走界面的「检查更新」 |

> ⚠️ `README.md` 里那张套件表的数字停在 **1005 项（2026-10-03）**，已过时。
> **每次实测重取**，别照抄文档里的数字。

---

## 5. 验收标准（这是标准，不是建议）

摘自 `AGENTS.md` §二，Codex 必须能回答：

- **全绿 ≠ 通过**。必须能回答「我改掉了哪条判断？哪条断言会因此变红？」答不上来 = 没验证。
- 说「修好了」要给**前后可复算的实测数字**，不能只有推理。
- 关键修复做**行为级验证**（把真实代码块抠出来跑）；「源码里出现过这行字」不算证据。
- 造坏版反证时：**先备份再破坏**，**禁用 `git checkout -- <file>` 还原**（会把未提交的在制品整片抹回 HEAD，实测丢过整轮修复）⇒ 备份到临时目录、跑完 `cp` 还原。
- 负向断言先剥注释（`codeOnly()`）再查；定点破坏先过「锚点唯一（`count==1`）」。
- 改测试前先读 `docs/HANDOFF.md` §6 的套件表，别改错套件；用例之间必须互相隔离。
- ★ 自己新写的工具也要有**能立刻抓到错的用例**：本案 `tools/config-portable.js` 首跑就真红了一条
  （路径函数对**顶层键**返回 `undefined` ⇒ 那两个键没被置空）。**首跑全绿反而要怀疑断言在放水。**

---

## 6. 已知遗留（明知未修，别当新发现）

| # | 位置 | 说明 | 处置 |
| --- | --- | --- | --- |
| 1 | `src/renderer/app.js:2643` | 残留一行读 `promptFilter`（字段已改名 `promptWrite`，读取链没删干净）。**当前无害**（不报错、不影响功能） | 下一版顺手删；本轮为「不打破已验完的包」**故意不动** |
| 2 | `README.md` 套件表数字 | 停在 1005（10-03） | 下次跑完 `run-all` 顺手更新 |
| 3 | 本机已装副本 1.0.13 | 按 SOP 不自动换 | 用户在界面点「检查更新」 |

---

## 7. 要发版时

读 **`docs/knowledge/docs/发版流程SOP.md`** 与 `docs/HANDOFF.md` §10 的「发版 SOP」。
三条最容易出事的：

1. **版本号单独一条提交**（`chore(发版): X`）；`docs/visual` 刷新必须**排在版本号之后**（生成器读 `package.json`）。
2. **从干净快照打包** —— 仓库里可能同时有别的会话在改；用 `git worktree add --detach` 取 HEAD 快照，`node_modules` 用目录联接（先摘后删）。
3. **发包 ≠ 生效** —— 打完包要核：公网 `latest.yml` 版本号、安装包 `Content-Length`、`--version`、`beta.yml` 未被动过。
