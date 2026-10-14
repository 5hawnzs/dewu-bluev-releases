# AGENTS.md —— 给 AI 编码代理（Codex / Claude / 其它）的入口须知

> **这是入口，不是全部文档。** 开工顺序：本文件 → `README.md` → `docs/HANDOFF.md` §2/§3/§6。
> 项目：**得物蓝V 素材发布工具**（Electron，Windows 桌面版）。仓库**私有**，内容不要外传、不要贴到公开渠道。
> 运行环境是 **Windows + MuMu 模拟器 + 真机得物 App**，不是 Linux 容器。

---

## 一、绝不许破的硬约束（每条都有过血的教训）

1. **项目目录不许改名 / 移动**（当前 `D:\work\dewu-bluev-publisher`）。
   应用配置与构建产物里存的是**绝对路径**（`config.json` 的 `paths.*`、`project.json` 的 `sourceDir/sheet.file`）。
   改名 ⇒ 素材扫不到、隔离目录不存在、发布单回写落到别处。
2. **`src/renderer/app.js` 与 `src/main/store.js` 禁止整文件重写**，只许**局部替换** ——
   这两个文件可能同时有别的会话在改，整文件重写会覆盖别人的在制品。
3. **每改一处必须跑回归**：入口 `node tools/run-all.js`。
   ★★ **绝不要设 `BLUEV_NO_LOGIN`** —— `logintest` 断言的正是"这个变量没设"；
   设了会 3 条 FAIL 并**挂住不退出**（`uicheck` 自己会在进程内设好，外面不用管）。
   ★ 断言数**每次实测重取**，别照抄文档里的数字（同一天内就变过好几轮）。
4. **注释与界面文案一律用中文。**
5. **不许造假成功**：取不到就写"取不到"/ `—`，**未知 ≠ 0**；失败必须说清"缺什么"。
   宁可报失败也不要让界面骗人、更不要让结论骗人。
6. **发布前必须把设备相册清空**：得物相册是**全盘聚合视图**，判据是 **MediaStore 清空**，不是"某个目录为空"。
7. **自动更新两条红线**（`src/main/updater.js`，改前先读文件头）：
   a. **绝不自动重启安装**（`autoInstallOnAppQuit` 必须为 `false`）—— 会掐断正在跑的发布任务且无法回滚；
   b. **不在运行时改"源地址"**（`setFeedURL`）—— 地址编译进包里，改了等于让已装客户端失联。
   　 ★ 但**通道名（latest/beta）是官方支持的运行时切换**，不是靠两个源地址实现的。
8. **凭据绝不入库**：`.env`（COS 对象存储密钥）已在 `.gitignore`；
   `service_role` / secret key **绝不许**写进任何前端文件（绕过所有行级策略，等于整张表裸奔）。
9. **安装包不进 git**（`dist/`、`dist-new/` 已忽略）。二进制一旦进历史就删不干净 ⇒ 发给同事走 Releases / 网盘。
10. **发布过程中及两条之间禁止强停、退出或重启得物**（2026-10-14 用户明确要求）。
    正常提交返回首页或草稿箱都应连续处理；草稿箱直接使用「发布新动态」入口，不为了回首页重启。
    不以草稿箱是否可见判定新增草稿，不自动删除已有草稿；相册校验也不得借强停解锁。
11. **媒体命令回执与媒体实际状态分开判断；历史修复必须覆盖当前生产入口。**
    rich设备长期出现content命令139；删除139空回显不等于成功或未执行，必须继续核实扫描后媒体库和物理状态，权限/超时/未知不能当清空。
    发布链当前使用publisher.run → albumready → clearAlbum；只测旧clearMediaDir不能当发布验收。现场故障必须在真实publisher.run/jobs.run入口复现正反状态。
    本机通过不等于rich已恢复，远端P0只能由对应设备的实际任务日志与结果验收关闭。

---

## 二、改完怎么自证（这是验收标准，不是建议）

- 跑 `node tools/run-all.js`，**全绿 ≠ 通过**。你还必须能回答：
  "我改掉了哪条判断？哪条断言会因此变红？"——答不上来就等于没验证。
- 说"修好了"必须给出**前后可复算的实测数字**，不能只有推理。
- 关键修复要做**行为级验证**（把真实代码块抠出来跑），"源码里出现过这行字"不算证据。
- 造"坏版本"来反证时：**必须先备份再破坏**，且**禁用 `git checkout -- <file>` 还原**
  （它会把未提交的在制品整片抹回 HEAD，实测丢过整轮修复）。
- 改测试前先读 `docs/HANDOFF.md` §6 的套件表，别改错套件；用例之间必须互相隔离。

---

## 三、环境（本机既有，别重复安装）

| 依赖 | 位置 / 说明 |
| --- | --- |
| Node | `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe` |
| adb | **内置** `vendor/adb/adb.exe`（也可在 App「高级设置」页手填；手填优先，失效时退回内置并说出来） |
| ffmpeg | **内置** `vendor/ffmpeg/ffmpeg.exe` |
| 中文输入法 | `vendor/adbkeyboard/ADBKeyboard.apk`（App 内「一键装」三步：`install -r` → `ime enable` → `ime set`） |
| 得物 App 安装包 | **内置** `vendor/dewu/dewu_6.0.5.apk`（**133,315,131 B ≈ 127 MiB**，md5 `50092bcc…`，`com.shizhuang.duapp` 6.0.5）—— MuMu 自带的应用商店里**搜不到得物**时的兜底：设置页「外部依赖」表里给「下载到本机 / 装进模拟器」两个按钮。**已经装过就不动它**（见 `src/main/services/dewuapk.js`）。★ 它在 git 里是**分两片**存的（`.part01` / `.part02`，各 64 MiB —— GitHub 单文件 100 MiB 硬限），打包前由 `node tools/dewuapk-assemble.js` 拼回；`npm run dist:win` 已自动带上 |
| 模拟器 | MuMu 12；设备串以 `adb devices` **真名**为准（同一设备报多个端口 ⇒ 按 `android_id` 去重） |
| 真机 App | 得物（发布链路只能在真机上验证） |

装依赖：`npm install` 后跑一次 `npm run addon:win`（强制取 Windows 版 sharp；交叉打包带上别的平台会让 `require('sharp')` 直接失败 ⇒ 整个原生引擎降级）。

---

## 四、做不到的事 —— 不许假装能做到

- **发布链路必须真机**：需要本机 adb + 模拟器 + 真机得物 App + 有时还要"Excel 被占用"这种现场条件。
  没有设备/素材时，你只能改代码、跑不依赖设备的回归。**绝不许声称"已验证发布成功"。**
- **自动化跑不了"看屏幕判断"**：抓屏 dump 失败时要先看 `mCurrentFocus`；抓不到就说抓不到，
  **绝不返回上一屏的残留结构**（会被当成当前页）。
- **相机 / 账号 / 发布提交**这类外部动作：不确定就不要替用户点下去。

---

## 五、文档索引（单一事实来源）

| 文件 | 内容 |
| --- | --- |
| `docs/HANDOFF.md` | **全部交接内容**：硬约束、已完成（不要重做）、待办、真机口径、发版 SOP、回归套件表 |
| `docs/WINDOWS-E2E.md` | Windows + 模拟器端到端测试手册（环境清单 / 逐环节操作与预期 / 常见坑） |
| `README.md` | 模块实现说明、测试套件表（最新数字看这里）、发版步骤 |
| `docs/supabase-setup.sql` | 云端协作侧建表与策略 |

> ✅ **2026-10-04：`docs/HANDOFF.md` 的路径口径已改成 Windows 实测值**（工程 = `D:\work\dewu-bluev-publisher`，
> workspace 根 = `D:\work`）。文里仍会看到 `/Users/shuo/...`，但**每一处都标了「macOS 历史」**
> （回滚快照 tar、录屏源文件、node 20.18.0 那几行）—— 那是**出处记录**，不是操作指令，别照着敲。
> Windows 侧一律以本文件 + `docs/WINDOWS-E2E.md` 为准。

---

## 六、知识库与交接单（2026-10-05 新增 · 2026-10-08 刷新快照）

| 文件 | 内容 |
| --- | --- |
| `docs/HANDOFF-CODEX.md` | **一页纸交接单**：git 里已有什么、git 外还缺什么（环境 / 凭据 / 设备）、当前状态快照、验收标准、已知遗留。**接手前先看这一份** |
| `docs/HANDOFF-NEW-MACHINE.md` | **换机方案**：目标机系统前提、通道总表（什么走 git、什么只能单独搬）、三份敏感文件（`config.json` / `auth.json` / `.env`）、新机必做的两处重置（`cloud.machineId` 与绝对路径）、设备侧、验收清单。**换机器跑就照这份走** |
| `docs/knowledge/` | **知识库（172 份）**。原本全在仓库之外（WorkBuddy 私有目录），clone 拿不到 ⇒ 已收进仓库：`RULES-得物蓝V.md` 项目规则全文（`§A`~`§CO`，**4962 行** + 实测数字）、`MEMORY-INDEX.md` 索引、`RULES-通用.md` 跨项目规范、`skills/` **34 个**技能、`docs/` **105 份**历史文档、`archive/worklog/` **7 份**工作日志、`deployed-sites/` 站点源码。**索引见 `docs/knowledge/README.md`，按需查、别整读** |

> ★ 换机搬配置**不要整份拷 `config.json`**：用 `node tools/config-portable.js`
> （`inspect` / `export` / `import` / `selftest`）—— 它会把绝对路径与 `cloud.machineId` **显式置空**、
> 默认抹掉密钥、导入前先备份、默认只预演。用法与理由见 `docs/HANDOFF-NEW-MACHINE.md` §3.1~§3.3。
> ★ `docs/` **不在** `build.files` 白名单里（只有 `src/**` + `package.json` 进包）⇒ 知识库不会被打进安装包、终端用户看不到。
> ★ 知识库是**快照**（截至 **2026-10-08 19:5x** 刷新），里面的断言数 / 体积 / 耗时**每次都要实测重取**。
> ★ 快照由工作区脚本 `_build-knowledge-pack.sh` 导出（幂等、可重跑）；跑完必须确认末尾「垃圾残留 = **0**」。
> ★ 规则全文里唯一算是"凭据"的，是一个 Supabase **`anon`** key（已确认 `role: anon`，随公开看板发布过）；
> 红线是 **`service_role` / secret key 绝不许进任何前端文件**——这条没被破。
