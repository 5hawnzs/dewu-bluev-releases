---
name: concurrent-workspace-safe-release
description: 在「同一仓库/同一工作区可能有另一路会话（另一个人、另一个 AI 会话）在同时改代码」的情况下，安全地打一个可交付的包并发版——保证**别人的半成品不进包、自己的改动不漏提交、凭据不外带、旧产物不误传**，且每步都有可复算证据。当出现「发版前要不要先看看谁在改」「我刚提交完怎么多出一堆我没动过的文件」「怎么只提交我改的那几个文件」「打出来的包会不会带上别人没写完的功能」「发完版怎么证明真的推出去了」这类需求时使用。含：①发版前的并发体检三条命令与判据（`git status` / 关键文件 mtime / 其它会话 jsonl 的 mtime；★一次采样只能说明「刚动过」，判「还在跑」要隔 1 分钟复采）②★★ 只 `git add <自己的文件>`，**永不用 `git commit -a`**，且要能立刻列出「我这轮碰过哪些文件」③★★ 在 `git worktree add --detach` 干净快照里打包（用目录联接共享 node_modules；★给 Windows 程序传路径一律 `D:/x/y`，传 `/d/x/y` 会被拼成 `D:\d\x\y`）+ **收尾顺序不能反**：先摘联接再 `worktree remove`（那条联接指向主仓 node_modules，递归删除会不会穿透不赌）④产物核对到 asar 级（`extractFile` **只认反斜杠路径**、md5 对齐仓库源码、包内 grep 关键文案）⑤★★「已推送」的唯一硬证据是 `git ls-remote origin refs/heads/main` 与 `git rev-parse HEAD` 比对——`git status` 干净 + `git log` 有提交**都证明不了**（实测反例：本地领先远端 3 个提交、`git status` 空空如也，而安装包早已上线）⑥换已装副本 asar 的流程与 md5 自证 ⑦发版范围（要不要连带别人的功能出去）**必须先问用户**，给「只推我的修复／推 main 全量／先不推」三个选项 ⑧★ 纯提交（不打包）时的两道自查：`--numstat` 前后对比排掉换行符噪音、提交信息里的标识符/归属 grep 源码复核；信息写错**未推送才 `--amend`**，已推送改用下一个提交写「更正」；②★ 「改动量看着不合理」先排 EOL 噪音，别把 CRLF 差异当代码改动报给用户。⑨★★ **发版前先确认修复落在「哪一层」**（包内 `src/**` / 用户配置 `config.json` / 云端）——关键字 grep 不到 `src/` 就是**包外改动，发包等于没发**（实测：盲点坐标在用户配置、`tools/` 不进包）；⑩★★ 判「有没有实例在跑」别信 **PowerShell 的 stdout**（会被吞成空）⇒ 结果**写文件再读**并带「总进程数」哨兵（实测命中 4 个、靠这个才没误换 asar）。★ 另含 §1.1「**干活中途**发现对方在改**同一个文件**」的三个硬信号（同一轮里两次读到的内容不一样 / `node --check` 结果自己翻转 / 文件 mtime 在你写入之后又前进）与四条「不抢写」的应对（改动做窄+回读、整份备份到仓库外、两路改动都 grep 验、FAIL 先归因到谁的文件）。
agent_created: true
---

# 并发工作区下的安全发版

## 何时用

- 这个仓库/工作区**可能同时有另一路会话在改**（团队同事、或另一个 AI 会话共享同一棵工作树）。
- 你要产出一个**可交付的包 / 版本**，且交付物必须是「只有我这次的改动」。
- 或者你已经踩到了：提交完发现 `git status` 里有一堆**自己没动过**的文件。

★ 判断依据不是"感觉有可能"，而是**真的在同一棵树里见过别人的改动**。见 §1。

## 0. 一句话原则

> **包里只能有"我这轮改的 + 已经提交过的"两样东西。**
> 凡是「别人还没写完」的，宁可这次不带它出去，也不要让它跟着包上线 —— 包一旦发出去就收不回来。

这条原则落在三个动作上：**只暂存自己的文件**（§2）、**在干净快照里打包**（§3）、**发版范围先问用户**（§5）。

## 0.1 ★★ 先确认：这次的修复落在「哪一层」？

发版前先回答一个问题：**这次的改动，是进包的，还是不进包的？**

| 层 | 存在哪 | 发包能带上吗 |
| --- | --- | --- |
| **包内** | `src/**`（即 `build.files` 收的路径） | ✅ 升级即生效 |
| **用户配置** | `%APPDATA%\<app>\config.json`（定位表 uiMap、坐标、开关…） | ❌ **不进包** |
| **运行时数据** | 素材目录、本地台账 jsonl、云端表 | ❌ 不进包 |

★★ **落在包外的修复，发版等于没发。** 本项目实测（v1.0.11）：盲点坐标写在用户
`config.json` 的 `publish.uiMap` 里、由 `tools/fixuimap.js` **就地打补丁**；而 `build.files`
只收 `src/**/*` + `package.json` ⇒ **`tools/` 根本不在包里**，`store.js` / `clouddefaults.js`
里也没有默认 uiMap ⇒ **别的机器升级后一点没变快**。

```bash
node -e "const p=require('./package.json');console.log(p.build&&p.build.files)"  # 先看打包范围
grep -rn "<你那处改动的关键字>" src tools     # 它到底在 src 还是在 tools/ 配置里
```

判据：**改动的关键字 grep 不到 `src/`** ⇒ 它不在包里 ⇒ 别指望升级包交付它。
出路三条：① 挪进 `src/` 做成默认值 ② 跟一份「导入文件」一起分发 ③ 在目标机器上跑迁移工具。
**选哪条要先问用户**（这跟 §5 一样是产品决策，不是技术决策）。

## 1. 第一步：发版前的并发体检（三件套，别跳）

```bash
cd <repo>
git status --short                                  # ① 有没有「我没动过」的改动？
ls -la --time-style=+%H:%M:%S <我这轮碰过的文件>       # ② 它们的 mtime 对不对得上我这轮的时间窗
date +%H:%M:%S
ls -lt --time-style=+%m-%d\ %H:%M ~/.workbuddy/projects/*/*.jsonl | head -6   # ③ 其它会话是否活跃
```

判据：

| 现象 | 结论 | 动作 |
| --- | --- | --- |
| `git status` 里出现**我没碰过**的 `M` / `??` | ★ 有人在同时改 | 记下文件名，**绝不**把它们一起提交；打包走 §3 |
| ② 的 mtime 与我约定的时间窗不符 | 可能是别人刚改过同一份 | 先 `git diff <那个文件>` 看清改了什么再决定 |
| ③ 有 jsonl 的 mtime 就在**几十秒内** | 另一路会话很可能**正在跑** | 隔 1 分钟**再采一次**；两次都前进 = 真在跑 |

★★ **一次采样只能说明「刚动过」，不能说明「还在跑」。** 判"还在跑"必须隔 ≥1 分钟复采，
两次 mtime 都往前进才算。别按文件大小排序（大小与活跃度无关），按 **mtime 倒序**排。

实测一例（本项目）：`git status --short` 里出现 5 个我没动过的文件 + 一个新文件
（`cloudsync.js` / `ipc.js` / `store.js` / `preload/index.js` / `renderer/app.js` / `clouddefaults.js`），
而我这轮只碰过 `adb.js` / `adbtest.js` / `uicheck.js` / `README.md` / `HANDOFF.md`。
⇒ 两路会话在同一棵 `main` 上并行改。这就是必须走 §2+§3 的信号。

★ **想知道「另一路到底碰了哪些文件」，别只看 mtime** —— 读它那条 jsonl 里每次工具调用的
`arguments.file_path`、去重，就是准确清单。mtime 只给「时间窗」，给不了「归属」；
而**归属**决定你该不该把它一起提交。

实测一例（v1.0.6）：`git status` 里 31 个文件，从另一路 jsonl 抽出它碰过的只有 13 个，
其中**未提交**的只有 4 个（`services/cloudsync.js` / `tools/cloudtest.js` / `web/board.html` / `web/vendor/`）
⇒ 一眼分清「它的半成品」与「它早已提交的历史部分」，也才知道重叠文件有哪 10 个。

### 1.1 ★★ 干活**中途**就发现对方在改「同一个文件」——比 mtime 更硬的三个信号

上面整套是**发版前**的体检。更糟的情况是：你正在**实现**功能，做到一半发现另一路会话
在改**你手上这个文件**。这时最硬的判据不是 mtime，而是：

1. **同一轮里、同一个文件、两次读到的不一样**（最硬）。实测：我读 `jobs.js` 看到的是旧分支，
   几十秒后再读，里面多了一段**我从没写过**的分支（对方删按钮连带删的 job 分支）。
   ⇒ 判据：**内容变了 ≠ 我改的** ⇒ 立刻 `git status` + `git diff <文件>` 定性。
2. **`node --check` 的结果自己翻转**。实测：我加完新 case 后 `node --check` 报
   `SyntaxError: Unexpected token 'case'`（前一个 case 的 `}` 暂时不在），几分钟后再跑就 **valid**
   —— 中间我没再碰它 ⇒ 有人在写入。**语法检查莫名其妙红/绿一遍，先怀疑并发，别急着改自己的代码。**
3. **文件 mtime 在你自己的写入之后又前进**。`ls -la --time-style=full-iso <文件>` 连采两次即可。

★★ **发现之后不要停手，也不要"抢写"**，按这四条做（实测有效，两路改动可共存）：

| 动作 | 为什么 |
| --- | --- |
| **改动做窄**：锚点只框住自己要改的那一两行，改完**立刻回读**该文件确认自己的改动还在 | 大块重写式 Edit 会被对方的整块重写覆盖（你的 Edit 会"成功"，但下一分钟没了） |
| **把自己的改动整份备份到仓库外**（如 `<工作区>/_rv/<任务>-backup/`），改动后与提交前各备一次 | 工作树里被覆盖就真没了；备份是**不碰 git** 的保险，不算"破坏性操作" |
| 跑测试前**两项都验**：grep 对方那轮的独有标记 + grep 自己的新符号，确认**两路都在** | 只验自己 ⇒ 把对方的半成品状态当成自己的失败；只验对方 ⇒ 自己的改动可能已被吃掉 |
| 全量回归有 FAIL 时**先归因到"谁的文件"**：失败所在套件若正好覆盖对方正在改的文件（例：对方改 `cloudsync.js`、红的正是 `cloudtest`），先别认领 | 否则你会去修一个不属于你这轮的错，还可能顺手把对方的半成品改坏 |

★ 提交时仍按 §2.4 逐 **hunk** 拆（同一个文件里混着两路改动是常态，别整文件 `git add`）。

## 2. ★★ 只提交自己的文件：**永不用 `git commit -a`**

```bash
git diff --stat                       # 先看全貌
git add src/main/services/adb.js tools/adbtest.js tools/uicheck.js README.md docs/HANDOFF.md
git diff --cached --stat              # ★ 复核：暂存区里**只**应该有你那几份
git commit -F - <<'EOF'
<提交信息>
EOF
```

- **`git commit -a` 是绝对禁止项**：它会把别人正在写的半成品一起塞进 `main`。
- 提交前先能**背出「我这轮碰过哪些文件」**；说不出来就别提交。
- 中途发现暂存区多了东西：`git restore --staged <文件>` 撤出来，不要 `reset --hard`。

### 2.1 ★ 改动量看着不合理？先排「换行符噪音」

```bash
git diff --numstat                      # 全貌
git diff --ignore-cr-at-eol --numstat   # ★ 两行输出**一模一样** ⇒ 是真实内容改动
```

`core.autocrlf=true` 的仓库里，一个文件报出 +426 行，很可能是「几百行换行符差异 + 少量真改动」
混在一起。**加了 `--ignore-cr-at-eol` 后数字变小 ⇒ 有一部分只是 CRLF/LF 差异，别把它当代码改动报给用户。**
（★ 本项目实测：两行数字完全一致 ⇒ 426 行是真改动，可以放心提交。）

> 换行符差异在别处还有第二个坑：拿它去比 asar md5 永远对不上，见 §4「例外」。

### 2.2 ★ 提交信息里的事实，写之前 grep 一遍

- **标识符别凭记忆**。本项目实测：把「覆盖配置目录的环境变量」写成 `DEWU_CFG_DIR`，
  真名是 `BLUEV_CFG_DIR`（`fixuimap.js:62` / `adbtest.js:2298`）。提交前 `grep -n "<名字>" <文件>` 一次即可。
- **改动归属**同样别凭记忆（把 A 的删除写成 B 文件的改动）—— 见 §10 最后一条。

### 2.3 修提交信息用 `--amend` 的前提：**还没推送**

```bash
git branch -vv                        # 有 ahead N 或先按 §7 比对 ls-remote
```

- **未推送** ⇒ `--amend -F <msg>` 是干净的（本项目实测 `a497b49` → `3acd4d1`，工作区不受影响）。
- **已推送** ⇒ 别改写公共历史，改用**下一个提交**写「更正」（§10）。
  ★ 注意 `ahead N` 是**本地自述**，判「到底推没推」的硬证据是 §7 的 `ls-remote` 比对。

### 2.4 ★★★ 同一个文件里混着两路改动：按 **hunk** 拆，别整文件 `git add`

「我这轮改的」和「别人正在写的」落在**同一份文件**里时（本项目实测：`app.js` / `index.html` / `uicheck.js`
三个文件都是混的），整文件 `git add` 就等于把对方未完成的东西一起提交 —— 而 `git restore --staged`
又会把你自己的也撤掉。正确做法：**把「对方那些 hunk」摘成一个 patch，反向应用[到索引]**。

```bash
# ① 逐 hunk 分类并打印报告（真实做法：按标记词判定，人工逐条复核分类结果，别盲信）
#    标记词就用对方那轮的独有字符串：admin: true / 筛选排序提示词 / promptFilter / data-admin="1" …
# ② 先整文件暂存
git add src/renderer/app.js src/renderer/index.html tools/uicheck.js
# ③ 把对方的 hunk **反向**应用**到索引**（★ 工作区一个字节都不动）
git apply --cached -R --check theirs-app.patch && git apply --cached -R theirs-app.patch
# ④ 硬校验：暂存 hunk 数 + 残留 hunk 数 == 工作区相对 HEAD 的 hunk 总数，且两个集合不相交
```

- `--cached` 只写索引、**不碰工作区** ⇒ 对方还在写着也不会冲突，它的改动也**一点没丢**；
  `git diff --cached` 只剩你的，`git diff` 只剩它的，这才是「两不相交」。
- ★★ **判据必须差分式**：只在 diff 的 `+` / `-` 行里找标记词。**别用「整文件里有没有这个词」** ——
  实测这么判会出 **7 条假红**：`admin: true` 在页签 11 上本来就有、`data-admin` 在 `index.html` 里本来就有 2 处
  （一条注释 + 页签 11）、`data-st="10"` 还出现在我自己新写的注释里。假红会让人去「修」一个根本不存在的泄漏。
- 收工核对：3 个混合文件的 md5 与**操作前备份**逐字节一致（证明全程没碰工作区）。
- ★★★ **提交后必须在独立 `git worktree` 里再跑一遍全量回归**：**「两路共存时全绿」≠「我这条提交自己绿」**
  —— 对方的改动可能正好补上了你依赖的前提。本项目实测：共存时 1558 项绿，我这条提交单独跑**同样是 1558 项绿**
  （uicheck 208 / logtest 69，不含对方的 +13 条），两边的数字要对得上、也要说得清差在哪。
- 拆联接的收尾顺序见 §3（★ 先摘 `node_modules` 联接再删工作树，否则会连带删掉主仓依赖；
  删完立刻复查主仓 `node_modules/electron/dist/electron.exe` 还在、条目数没变）。

### 2.4b ★★ 反过来拆（我的 hunk 更少时）：只抽「我的 hunk」**正向**应用；同一 hunk 内还能拆到**行**

§2.4 是「摘对方的 hunk、反向撤掉」——适合**对方改动少**。反过来更顺手的场合：**对方 13 个 hunk、我只有 2 个**
（实测 `app.js`），逐个摘对方反而容易漏。此时**只抽我的、正向应用**：

```bash
# ① 别手抄：脚本从 git diff -U0 里按「我的特征串」抽 hunk 拼成 patch（手抄 22 行删除必抄错）
# ② dry-run 再实做；★ -U0 是零上下文 patch，必须加 --unidiff-zero（见下）
git apply --cached --recount --unidiff-zero --check mine.patch
git apply --cached --recount --unidiff-zero mine.patch
```

- ★★★ **零上下文（`-U0`）patch 不加 `--unidiff-zero` 一定失败**：实测 4 个 patch 里含 `-` 行的 3 个全报
  `error: patch does not apply`，只有纯插入那个（`-0 +N`）通过；加上开关就 4/4 全过。
  **报错信息完全不提这个原因** ⇒ 极易误判成「内容对不上」而跑去改 patch 内容。加 `--unidiff-zero` 前，
  也先确认你的 patch 确实没有上下文行。
- ★★ **同一个 hunk 内也能拆到「行」**：我的删除和对方的新增挨得近（< 6 行）时，`-U3` 会并成**一个** hunk
  ⇒ 按 hunk 拆拆不开。但 `-U0` 下能看清那个 hunk 的构成：**`-` 行是我的、整段 `+` 行是对方的**，
  **只丢 `+` 行**就得到「纯删除」的 patch。实测 `jobs.js`：一个 hunk `-22`（我）/`+32`（对方），丢 32 个 `+` 后正确。
- `--recount`：丢了 `+` 行后 hunk 头的计数就对不上了，它让 git 自己重算 ⇒ **不用手改 `@@ -a,b +c,d @@`**。
- ★★ **校验用「对方特征串零命中」**：`git diff --cached | grep -c <对方独有串>` 必须**全 0**
  （实测查 `copy.llmmodels` / `modelModal` / `listModels` 全 0），且**我的特征串必须 > 0**
  （防「抽了个空 patch 还以为成功」）。
  ★ 别拿「HEAD 里本来就有的串」当判据：`文案模型` 在 HEAD 里命中 4 处（原有 UI 文案 + HELP），
  它算 **HEAD 既有**，不证明夹带 —— **只查对方那轮「新增」的串**。
- ★★ **三个硬开关一次到位**：`--cached`（只写索引、不碰工作区）+ `--recount`（重算计数）+ `--unidiff-zero`（零点 patch）。
- ★★ **收尾三证**：① `--name-only` 确认只改了该改的文件；② 提交里对方串全 0；
  ③ **提交后 `git diff HEAD --stat -- <混的文件>` 剩下的必须全是对方的**
  （实测 jobs `+39/-2`、app `+222/-34`、uicheck `+119/-14`）⇒ 证明**对方的在制品一个字节没动**。
- 整文件都是我的（无对方改动）就**直接 `git add`**，不必走 patch（实测 `build.js`：1 个 hunk、纯我的）。
- 提交后另找干净 `git worktree` 跑回归那句（§2.4 末）同样适用：**「两路共存时绿」≠「我这条提交自己绿」**。

## 3. ★★ 在干净快照里打包（`git worktree`）

**为什么**：主工作区里躺着别人的未提交改动。直接从主工作区打包 = 把它们的半成品打进安装包，
而且**打完之后你自己也分不清包里是哪份代码**。

```bash
# ① 建快照（HEAD = 你想发的那条提交）
cd <repo>
git worktree add --detach D:/work/_rel<版本> HEAD
git worktree list                     # 复核它落在哪

# ② 版本号在**主仓**改好，再复制进快照（快照是只读用途，别在里面提交）
cp package.json D:/work/_rel<版本>/package.json

# ③ 共享依赖：用目录联接指向主仓的 node_modules（别复制 522 MB）
```

创建联接**优先用 PowerShell**（Git Bash 里调 `cmd //c mklink /J` 容易被路径转换和反斜杠转义坑）：

```powershell
New-Item -ItemType Junction -Path 'D:\work\_rel<版本>\node_modules' -Target 'D:\work\<repo>\node_modules' |
  Select-Object -ExpandProperty FullName
Test-Path 'D:\work\_rel<版本>\node_modules\electron\dist\electron.exe'   # True 才算就位
```

★★ **给 Windows 程序传路径一律写 `D:/work/x`（正斜杠+盘符），不要写 `/d/work/x`。**
实测：`git worktree add --detach /d/work/_rel104 HEAD` 把工作树建到了 **`D:\d\work\_rel104`**
（Git Bash 风格的路径被当成字面相对路径、又拼上了当前盘符）。
症状很好认：`git worktree list` 里的路径多出一层。修法是 `git worktree remove --force 'D:/d/work/_rel104'` 后重来。

```bash
# ④ 打包（一定要删掉 ELECTRON_RUN_AS_NODE，否则 electron 退化成纯 Node）
cd D:/work/_rel<版本>
env -u ELECTRON_RUN_AS_NODE <node> node_modules/electron-builder/cli.js --win --x64 --publish never
```

- 用 `cli.js` 直接调，不经 `npm run`（npm 会再套一层环境）。
- `--publish never`：**上传由发版脚本单独做**（generic provider 不会替你上传）。
- 长任务放后台跑，跑完收到通知再进 §4。

### ★★ 收尾顺序绝对不能反：**先摘联接，再删工作树**

```powershell
# 只删这个联接本身（reparse point，不递归进目标目录）
[System.IO.Directory]::Delete('D:\work\_rel<版本>\node_modules')
Test-Path 'D:\work\_rel<版本>\node_modules'                        # 期望 False
Test-Path 'D:\work\<repo>\node_modules\electron\dist\electron.exe'  # ★ 期望 True：共享依赖完好
```

```bash
cd D:/work/<repo> && git worktree remove --force 'D:/work/_rel<版本>'
git worktree list
```

**原因**：`git worktree remove` 会**整目录递归删除**，而那里面有一个 `node_modules` 是**指向主仓的目录联接**。
递归删除到底会不会穿透联接（依次删掉主仓那 522 MB 依赖），取决于删除实现的细节 ——
**这件事我没有实测过，所以不去赌**：先摘联接是零成本的，赌输了是不可逆的。
`[System.IO.Directory]::Delete()` 只摘 reparse point、不递归，用它。

### 凭据只在快照里临时放一下

上传要桶凭据（`<repo>/.env`，已被 `.gitignore` 覆盖）。复制进快照、用完**立刻删**：

```bash
cp <repo>/.env D:/work/_rel<版本>/.env
# ... 上传完 ...
rm -f D:/work/_rel<版本>/.env          # 凭据不留第二份
```

## 4. 产物核对：核到 **asar 内部**，不信「打包成功」

★ `@electron/asar` 的 `extractFile` **只认反斜杠分隔的相对路径**（顶层 `package.json` 例外）：

```js
const asar = require('@electron/asar'), c = require('crypto'), fs = require('fs');
const md5 = b => c.createHash('md5').update(b).digest('hex');
const inAsar = asar.extractFile('D:/work/_rel<版本>/dist/win-unpacked/resources/app.asar',
                                'src\\main\\services\\adb.js');   // ★ 必须用 \\
console.log('仓库源码 md5 =', md5(fs.readFileSync('src/main/services/adb.js')));
console.log('包内文件 md5 =', md5(inAsar));
const pj = asar.extractFile('D:/work/_rel<版本>/dist/win-unpacked/resources/app.asar', 'package.json');
console.log('包内版本 =', JSON.parse(pj).version);
```

四件事一起看：

1. **包内版本号**（`package.json`）与 `dist/` 里 exe 文件名、`latest.yml` 里的版本号**三者一致**。
2. **md5 对齐**（能做就做）：包内文件与「通过了回归的仓库源码」逐字节一致 ⇒ 后面的行为级测试结论对这个包成立。
   ★ 在 `core.autocrlf=true` 的仓库里这条**永远对不上** —— 见下面的「例外」；那就跳过它，靠第 4 条取证。
3. **★★ 扫「整个 asar」，不是挑几个文件**（挑几个只能证明「我挑的那几个对」，证明不了「包里没有我不想要的东西」）：
   ```js
   const all = asar.listPackage(A).map(p => p.replace(/^\\/, ''));  // ★ 返回 '\\src\\renderer\\app.js' 形式
   const bag = {}; let read = 0, bytes = 0;
   for (const p of all) {
     try { const b = asar.extractFile(A, p); if (b && b.length) { bag[p] = b.toString('utf8'); read++; bytes += b.length; } } catch (e) {}
   }
   console.log(read, bytes);   // 本项目 v1.0.7 实测：1781 个文件 / 49045001 字节
   ```
   ★★ **必须同时断言「真读到几个」**：`read >= 15 && bytes > 300000`。
   否则「一个都没读到」和「读到的都干净」**都是 0 命中** ⇒ 空==空假通过。
   ★ `listPackage()` 返回的是**前导反斜杠 + 反斜杠分隔**（反斜杠开头的 `src\\renderer\\app.js`），**不是**正斜杠开头。
   按正斜杠处理 ⇒ `extractFile` 全抛错、`read = 0`，而脚本还会一路往下跑（本项目实测踩到）。
   ★ 量比想象大：electron-builder 会把 `dependencies` 里的**运行时依赖**也打进 asar（本项目 2516 条目 / 49 MB 文本）。
4. **★★ 双向断言：既证明「没有了」，也要证明「还在」**：
   - 该删的逐词为 **0**：本例 `前司` / `内容与校验` / `更新日志` / `打开「文案提示词」` / `updLogHtml` / `upd:log` /
     `update:set-log` / `updateSetLog` / `updateLogFile` / `defaultLogFile` / `LOG_MAX_BYTES` / `setLogEnabled` /
     `logStatus` / `logLine(` / `update.log`；
   - 同时**反向**查该留的（防删过头，也防关键词表开太宽自己报假红）：`logLineHtml`（★ 它是**「执行日志」的渲染函数**，
     恰好是 `logLine` 的子串，跟被删的「更新日志」不是一回事）、`copy:prompt`（文案生成页的入口）、
     `update:check` / `update:download` / `update:set-channel`。
   ★ 教训：把 `logLine`、`copy:prompt` 直接列进「必须 0」⇒ **自己给自己报一次假红**。
     判「该不该删」先看它是不是**另一个功能的子串 / 同名动作**。
   ★★ 第二种假红（本项目 v1.0.8 实测）：拿「**全文搜字符串**」判「XX 有没有混进去」——
     被查的文件里**注释正写着那张「禁词表」**。例：查「词库有没有混进材质参数词（鹅绒/充绒量/加厚）」，
     `hotwords.js` 第 25 行注释就是「材质与参数类（鹅绒、充绒量、加厚、防风防水、羊毛含量……）不进来」⇒ 必然命中、报假红。
     ⇒ 这类判据**不能搜文本**，要**把包里那份抠出来真跑**（`extractFile` 落临时文件 → `require` → 看 `ALL_WORDS`）。
     一句话：**注释里写着的「不该有」，和真的「有了」是两回事**；判据要落在可执行的数据上，不落在源码文本上。

★★ **例外：`core.autocrlf=true` + 换行符混用的仓库，「包内 md5 == 仓库源码 md5」永远对不上。**
真因不是代码不同 —— 是 `git worktree add` checkout 时把仓库里存的 LF **转成了 CRLF**，
而工作区里那些文件可能是**用 Python 写的 LF**（没经过 checkout）。
自查三连：`git show HEAD:<file> | md5sum`（仓库里存的）、`md5sum <file>`（工作区）、
`md5sum <快照>/<file>`（打包用的）—— 若**去掉 `\r` 后逐字节相同**，就是纯换行差异、**没有内容风险**
（JS 源码里 CRLF 与 LF 等价）。
⇒ **别在这里纠结**，把取证换成更硬的一条：**在打包用的那份快照上跑全套回归**（跑的就是包里的字节；
本项目 v1.0.6 实测 17 套 1036 项全绿，比 md5 对齐更有说服力）。
根治：仓库根加 `.gitattributes` 写 `*.js text eol=lf`（注意这会让全仓换行统一、`git status` 一次性显示几十个文件"被改"，**单独一轮做**）。

## 5. 发版范围：**先问用户，再上传**

包打好了 ≠ 该发。若体检（§1）发现有别人的改动已经提交在 `main` 上，你面临的是**产品决策**，不是技术决策：

| 选项 | 含义 | 适合 |
| --- | --- | --- |
| **只推我这条修复**（推荐） | 从我那条提交单独打包，语义干净 | 这是一次热修 |
| 推 `main` 全量 | 包里连带别人已提交的功能 | 发布物要与 `main` 完全一致 |
| 先不推 | 只换本机已装副本，公网停在上一版 | 那个功能还没验收完 |

用 `AskUserQuestion` 一次问清，**别自己替用户决定**。问完把答案写进提交信息（「发版范围由用户当场选定 X」），
否则下一个人看到包里多了个功能会以为被投毒。

★ 注意「已提交」和「已推送到远端」是两回事 —— 别人的提交可能**只在你本地**（见 §7）。

### 5.1 ★★★ 用户选了「全量」＝要发**别人还没提交的在制品** ⇒ 提交前三道门

「全量」在这种仓库里通常意味着把**另一路会话工作区里那些未提交文件**也一起提上去
（本项目 v1.0.6 / v1.0.9 / v1.0.15 都是这么发的）。但**别拿到就 `git add`**，先过三道门，
每道都留可复算证据：

| 门 | 要证什么 | 怎么证（实测做法） |
| --- | --- | --- |
| ① **它停了** | 对面不会在你提交/打包过程中继续写 | `ls -lt` 那些文件的 mtime ＋ 它那条 `projects/*/<sessionId>.jsonl` 的 mtime，**隔 ≥1 分钟复采**，两次都**不前进**才算停（只动过一次只能说明"刚动过"） |
| ② **它成体系** | 不是半截（改了产品忘了改测试，或删了功能留着调用方） | 产品侧文件与**测试侧文件同步**都在改动清单里；再抽查几个关键一致性（例：字段改名后，`grep -c <旧名>` 在**除了已知残留**之外应为 0） |
| ③ **它全绿** | 带上它不会把包打坏 | ★★ **先拿"含这些文件的工作树"跑一次全套回归，绿了才提交**（不是先提交再跑） |

③ 的顺序**不能反**：先提交再发现不绿，你就多出一条"补救提交"，而且**已经推出去的提交收不回来**
（本项目 v1.0.15 实测：先在工作树跑 `run-all` ⇒ 17 套 1622 项全绿，才 `git add` 那些文件）。

提交信息里照 §5 的老规矩写明**「发版范围由用户当场选定全量」**，并逐块列出带上了什么 ——
否则下一个人看到包里多了个功能会以为被投毒。

★ **另一半：带上别人的东西，不等于替别人做产品决定。** 若在审查中发现它的**未完工痕迹**
（例：删了功能却留着读取链），**先报告、别顺手改** —— 动它就要重打包 + 重跑回归，
会把**已经验完的产物作废**。选"保住已验完的产物"，把清洁留到下一版（写进交接文档即可）。

## 6. 上传 & 公网核对

**先 `--dry-run`，再真传**（脚本硬编码读 `dist/`，且要求 `dist/` 里**恰好 1 个**安装版 exe）：

```bash
cd D:/work/_rel<版本>
env -u ELECTRON_RUN_AS_NODE <node> tools/upload-release.js --channel stable --dry-run
env -u ELECTRON_RUN_AS_NODE <node> tools/upload-release.js --channel stable
```

传完**从公网侧核对**（不看本地文件、不信脚本回显）。中文产物名记得 URL 编码：

```bash
B="https://<bucket>.<region>.myqcloud.com"
curl -s  "$B/latest.yml"                                     # 版本号应是新的
curl -sI "$B/%E5%BE%97...-%E5%85%B7-<版本>-x64-win.exe" | grep -i "http/\|content-length"
curl -s  "$B/beta.yml" | head -5                             # ★ 没动过的那条通道要确认没动
```

★ **上传用的是桶凭据，跟 `git push` 是两条完全独立的路**：包已经上线、源码却一个提交都没推，
是很常见的组合（本项目实测发生过，见 §7）。两件事要分别取证。

> 上传脚本本身的门槛（五处闸门、版本/通道匹配、差量、保留策略、`--dir` 产物不能当发布件、
> 桶权限探针 404/403）见技能 `electron-auto-update-generic-release` §3/§4/§8，这里不重复。

## 7. ★★「已推送」的唯一硬证据

```bash
git ls-remote origin refs/heads/main     # 远端真实 SHA
git rev-parse HEAD                       # 本地 SHA
git branch -vv                           # 只作参考：`ahead N` 是本地自述
git log --oneline <远端SHA>..HEAD         # 到底差哪几条
```

- **`git status` 干净 ≠ 已推送。** 干净只说明「没有未提交的改动」。
- **`git log --oneline` 有一串好看的提交也 ≠ 已推送。** 本地提交本来就长这样。
- 只有 **`git ls-remote` 返回的 SHA == `rev-parse HEAD`** 才算推上去了。
- 远端领先/落后都要看；`ahead N` 里可能混着**别的会话**的提交。

实测反例（本项目）：`git status --short` 空空如也、`git log` 有 4 条像模像样的提交、
安装包已经在公网可下载 —— 但

```
git ls-remote origin refs/heads/main → 36d5c9b…      （远端）
git rev-parse HEAD                   → 94ed453…      （本地）
git branch -vv                       → main 94ed453 [origin/main: ahead 3]
```

**3 个提交一次都没推**。如果只看 `status` 和 `log`，会得出「都推完了」的完全错误结论。

## 8. 归档旧产物 + 给已装副本换 asar

★★ **先查这个项目自己的 SOP 怎么说「谁安装」** —— 别把"换 asar"当默认动作。
本项目实测（v1.0.15）：`发版流程SOP.md` 明写**「必须是你自己点下载和安装 —— 这两步没有任何自动化路径」**
⇒ 于是**不换**本机已装副本的 `app.asar`，让用户走「检查更新」或自己下安装包。
★ 判断依据要写清 **是"有实例在跑"还是"规矩就是不让换"** —— 历史上同一项目几次"没换"写的理由是前者，
理由不同、下一个人会误以为"没实例时就可以换"。

**归档**（发版脚本要求 `dist/` 里恰好 1 个安装版 exe，旧的先挪走而不是删）：

```bash
mkdir -p /d/work/_dist-archive/<旧版本>
mv dist/<产品名>-<旧版本>-x64-win.exe dist/<产品名>-<旧版本>-x64-win.exe.blockmap /d/work/_dist-archive/<旧版本>/
mv D:/work/_rel<版本>/dist/*.exe D:/work/_rel<版本>/dist/*.blockmap D:/work/_rel<版本>/dist/latest.yml dist/
```

**换已装副本**（让用户当场看到新行为，不用等重装）：

```powershell
# ① 先确认没有实例在跑（按**路径前缀**过滤，别按中文进程名猜）
Get-Process | Where-Object { $_.Path -like 'D:\<安装目录>\*' } | Select-Object Id, ProcessName, Path
```

★★ **PowerShell 的 stdout 可能被整个吞掉（返回空字符串）** —— 本项目 v1.0.11 实测踩到：
上面这条命令 stdout 是空的，差点被当成「没有实例在跑」。**改成把结果写文件、再用 Read 读**，
并带一条「总数哨兵」让「命令真跑了」与「真的没有」可区分：

```powershell
$all = @(Get-Process)
$hit = @($all | Where-Object { $_.Path -like 'D:\<安装目录>\*' })
(@("总进程数=$($all.Count)", "命中数=$($hit.Count)") +
 ($hit | ForEach-Object { "$($_.Id) $($_.ProcessName) $($_.Path)" })) |
  Set-Content -Path '<工作区>\.workbuddy\tmp\proc-check.txt' -Encoding UTF8
```

判据：**「命中数=0 且 总进程数=278」才算「没有实例在跑」**；纯空白输出什么都不算。
本项目实测：「总进程数=278 / 命中数=**4**」（PID 38200 / 41476 / 45648 / 61056）⇒ 当场停手没换。

```bash
cd D:/<安装目录>/resources
cp -p app.asar "app.asar.bak-<旧版本>"      # 有备份才敢覆盖（★ 名字带上旧版本号，便于回退辨认）
cp D:/work/_rel<版本>/dist/win-unpacked/resources/app.asar app.asar
# 自证：两边 md5 必须一致
```

## 9. 可复制的完整清单

```
□ 0  ★★ 先确认「这次修复落在哪一层」（包内 / 用户配置 / 云端）—— 关键字 grep 不到 `src/` ⇒ 不在包里，
     发包等于没发（见 §0.1，出路三条要先问用户）
□ 1  git status --short                                  → 列出「我没碰过的文件」
□ 2  其它会话活跃度（jsonl mtime，隔 1min 复采）；★ 并从它那条 jsonl 抽 `arguments.file_path` 得「它碰过哪些文件」
□ 3  确认「我这轮碰过的文件清单」
□ 4  git add <只加自己的> + git diff --cached --stat 复核   （禁 -a）
□ 5  提交（修复 / 发版分开两条，发版范围写进提交信息）
     ★ 提交前两道自查：`git diff --numstat` vs `--ignore-cr-at-eol --numstat`（数字变小=有换行符噪音）
       ＋ 信息里的标识符/归属 `grep`/`git show` 复核一遍（别凭记忆）
     ★ 信息写错：未推送才 `--amend`，已推送用下一个提交写「更正」
□ 6  git worktree add --detach D:/work/_rel<ver> HEAD
□ 7  cp package.json → 快照；New-Item -ItemType Junction 接依赖
□ 8  env -u ELECTRON_RUN_AS_NODE node node_modules/electron-builder/cli.js --win --x64 --publish never
□ 9  ★ 在**打包用的那份快照**上跑全套回归（＝包里的字节，比 md5 对齐更硬）＋ 包内版本号三者一致
     ＋ ★ **遍历整个 asar 扫关键词**（`listPackage`→逐个 `extractFile`→拼大字符串），并断言「真读到 N 个」
       （`read>=15 && bytes>300000`，否则空==空假通过）＋ **反向查该留的还在**（防删过头 / 关键词开太宽自报假红）
□ 10 问用户：发版范围（只推我的 / 推 main 全量 / 先不推）
□ 11 upload-release.js --dry-run → 真传
□ 12 公网核对 latest.yml / Content-Length / 另一条通道没动
□ 13 归档旧产物；dist/ 里恰好 1 个 exe
□ 14 ★ 先 `tasklist /FI "IMAGENAME eq <中文名>.exe" /FO CSV /NH | grep -c "\.exe"` 确认无实例在跑
       （★ **别用 `grep -c "<中文名>"`** —— Windows 输出是 GBK，必然数成 0）→ 备份旧 asar → 覆盖 → md5 自证
□ 15 ★ 摘 junction（[System.IO.Directory]::Delete）→ 复核主仓 node_modules 完好 → worktree remove
□ 16 rm 快照里的 .env
□ 17 ★ git ls-remote origin refs/heads/main == git rev-parse HEAD   ← 「已推送」的唯一证据
```

## 10. 坑清单

- ★★ **`git commit -a`** ⇒ 把别人半成品提交进 `main`，然后被你的包带上公网。**永不用**。
- ★★ **直接从主工作区打包** ⇒ 包里混进别人未提交的改动，事后无法自证包里是什么。
- ★★ **先 `worktree remove` 再摘联接（顺序反了）** ⇒ 递归删除可能穿透目录联接、删掉主仓 node_modules。
  先摘联接是零成本的，别赌。
- ★★ **`git worktree add --detach /d/work/x`**（Git Bash 风格路径）⇒ 建到 `D:\d\work\x`。
  给 Windows 程序传路径一律 `D:/work/x`。
- ★★ **`git status` 干净就以为推完了** ⇒ §7。`ls-remote` 和 `rev-parse` 比对才算证据。
- ★★ **上传一次成功就以为源码也推了** ⇒ 桶凭据与 git 是两条独立的路，各自取证。
- ★ **`asar.extractFile` 用正斜杠路径** ⇒ 读不到（顶层 `package.json` 例外）。必须 `src\\main\\x.js`。
- ★ **忘了删 `ELECTRON_RUN_AS_NODE`** ⇒ electron 退化成纯 Node，产物/套件假绿或秒退 0。
- ★ **`dist/` 里留着旧版本 exe** ⇒ 发版脚本会把旧包传上去；先归档再归位，且**恰好 1 个**。
- ★ **把 `.env` 复制进快照后忘了删** ⇒ 凭据多留一份在临时目录里。
- ★ **同一文件的多个 `Edit` 并行发** ⇒ 互相覆盖、只剩最后一个生效，**但仍返回成功**。
  同文件多处改动**必须串行**，改完立刻读回/跑测试验证。
- ★ **拿「一次 mtime 采样」断言别的会话还在跑** ⇒ 只能说明"刚动过"；判"在跑"要隔 1 分钟复采。
- ★ **回退时用 `git reset --hard`** ⇒ 会把别人的未提交改动一起抹掉。只用 `git restore --staged <文件>`。
- ★★ **`core.autocrlf=true` 的仓库里拿「asar md5 == 工作区 md5」当取证** ⇒ 见 §4。两边永远差一个 `\r`；
  **去掉 `\r` 后逐字节相同**才是真相。改用「在打包快照上跑全套回归」证明包里那份字节没问题。
- ★★ **用 PowerShell 查「有没有实例在跑」，输出为空就以为没在跑** ⇒ 空 stdout 可能是**被吞了**，
  不是真没有。改用 `tasklist /FI "IMAGENAME eq <中文名>.exe"`（中文名直接写、别用通配）。
  换 asar / 换数据前必须拿到**确凿**的进程清单 —— 本项目实测：差点在 **4 个实例正在运行**时换 asar。
  ★★ **同族的第二种假信号**：`tasklist ... | grep -c "<中文名>"` 会**恒为 0**（Windows 输出 GBK、bash 的 grep 按 UTF-8 匹配），
  于是「有 4 个实例」被算成「0 个 ⇒ 可以换 asar」——**错误方向偏偏是「安全」**。
  改成 `... /FO CSV /NH | grep -c "\.exe"`（数行不数中文），或肉眼看默认表格输出。
- ★★ **包内核对只挑几个文件比对 md5** ⇒ 只能证明「我挑的那几个对」，证明不了「包里没有我不想要的东西」。要 `listPackage()` 全扫（见 §4 第 3 条）。
- ★ `asar.listPackage()` 返回的是**反斜杠开头**的相对路径（如 `\\src\\renderer\\app.js`），不是正斜杠 ——
  按正斜杠处理会让 `extractFile` 全部抛错，而脚本还在往下跑（本项目实测踩到）。
  ★★ **实测症状不是 `read = 0`，而是 `read = 1 / bytes = 505`** —— 顶层 `package.json` 是文档里点名的**例外**，它照样读得到。
  于是「读不到任何文件」伪装成「读到了一个」，脚本还会一路 `PASS 包内版本号`。
  ⇒ **门槛不能写成 `read > 0`**，要 `read >= 15 && bytes > 300000`（本项目 v1.0.8 实测：修正后 `read = 2153 / bytes = 50599465`，
  其余 363 个条目是目录、`extractFile` 对它们抛错属正常）。
- ★★ **提交信息凭记忆写「改动归属」或「标识符名」** ⇒ 会把 A 功能的删除写成 B 文件的改动（本项目实测：把「更新日志」链在 ipc/preload 里的删除，
  写成了 `copy:prompt` 通道），或把环境变量写成 `DEWU_CFG_DIR`（真名 `BLUEV_CFG_DIR`）。
  提交前先 `git show --stat`/`git show <sha> -- <file>` 复核改了哪几个文件的哪几行，并 `grep` 一遍写进信息里的名字（见 §2.2）。
  已推出去才发现写错 ⇒ **不要 `--amend` + 强推（改写公共历史）**：改用**下一个提交显式写「更正」**，并在 docs 里留一条同样的话。
  ★ 反过来，**没推送**的提交用 `--amend` 改信息是干净且推荐的（见 §2.3）。

## 参考实现

- `D:\work\dewu-bluev-publisher` —— 本项目走的就是这套（`git worktree` 快照 + junction + `upload-release.js` + 换已装副本 asar）。
- 发版脚本与自动更新机制：技能 `electron-auto-update-generic-release`（§3 五处闸门 / §4 验收 / §8 目录产物）。
- 定点破坏与双向自证：技能 `bilateral-fix-verification`。
- 记忆上限与写在哪一份：技能 `agent-memory-hygiene`。
