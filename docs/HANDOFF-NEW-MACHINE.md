# 换机方案：把项目搬到另一台机器跑（Codex / 别人接手）

> 2026-10-05 编制 · 版本 **1.0.15**（对应仓库 `main` 的最新提交，别照抄旧哈希：见 `git log -1`）
>
> 与「同机交接」的区别只有一句话：
> **同机 = 只缺一次 `npm install`；换机 = 多出一件「搬钥匙」的活，而钥匙不能走 git。**

---

## 0. 前提：目标机是什么系统

| | 结论 |
| --- | --- |
| **要跑发布链路（连模拟器/真机得物）** | **必须是 Windows x64**。`vendor/adb/adb.exe`、`vendor/ffmpeg/ffmpeg.exe` 都是 Windows 二进制；产品本身也只打 `--win --x64` 的 NSIS 包 |
| **只改代码、不连设备** | macOS/Linux 也能跑，但要**另换两处平台件**：`vendor/` 里的 adb 与 ffmpeg 换成对应平台的、`@img/sharp-*` 换成对应平台（现有 `npm run addon:win` 是**强制取 Windows 版**，在 mac 上会把 mac 版顶掉） |
| **推荐** | Windows 10/11 x64，且**工程放在同一个绝对路径** `D:\work\dewu-bluev-publisher` |

★ 为什么要同路径：配置与构建产物里存的是**绝对路径**（见 §4.2）。同路径能省掉一整类「扫不到素材」的怪问题。

---

## 1. 通道总表（先看这张，再决定带什么）

| 东西 | 走什么通道 | 敏感度 |
| --- | --- | --- |
| 源码 / 18 套回归 / `docs/` / `docs/knowledge/` / `AGENTS.md` | **`git clone`** | ⚠️ **2026-10-08 起不再是「公开级」**：源码里现在含**内置模型 key**（`src/main/llmdefaults.js`）⇒ **这个仓库不许公开、不许推公网**（见 §3.0 第 3 条） |
| `vendor/adb/*` `vendor/ffmpeg/*` `vendor/adbkeyboard/ADBKeyboard.apk` | **`git clone`**（★ 这些二进制**已经在 git 里**，不用另外拷） | 公开级 |
| **`config.json`** | ★ **别整份拷** —— 用 `node tools/config-portable.js` 导出/导入（见 §3.1），再走加密包 / U 盘 / 内网共享。**绝不许走 git、不许贴聊天** | ★★（默认导出已抹密钥；加了 `--with-secrets` 就是 ★★） |
| **`auth.json`** | 同上（或改用种子文件，见 §3.3） | ★★ 含账号口令哈希 |
| **`.env`** | 同上（只有要发版的机器才需要） | ★★★ COS 对象存储 SecretKey |
| **`~/.ssh` 私钥** | 同上，或在新机重新生成一把 | ★★★ |
| 模拟器 + 得物 App + 登录态 | 新机自己装 | — |
| 素材目录、输出目录与台账 | 按需（见 §4.3） | 业务数据 |
| `dist\` 安装包、`_dist-archive\`、插件中心 `dl\`、411 个取证件 | 按需，二进制，**故意不进 git** | 公开级 |
| 按平台换的 adb / ffmpeg / sharp | 见 §0 | — |

> **一句话**：走 git 的只有代码与文档；**「钥匙」和「设备」都得另外搬。**

---

## 2. 第一步：clone 与装依赖

```bat
git clone git@gitee.com:abulaitifans/dewu-bluev-publisher.git D:\work\dewu-bluev-publisher
cd /d D:\work\dewu-bluev-publisher
npm install
npm run addon:win
```

- `npm run addon:win` = `npm install --no-save --force --os=win32 --cpu=x64 @img/sharp-win32-x64@0.33.5 @img/sharp-libvips-win32-x64@1.0.4`
  ★ **必须跑**：交叉打包时若带上 macOS 版 sharp，HEIC 解码会失效。
- 版本基线：Electron `^31.7.7`、electron-builder `^24.13.3`、electron-updater `^6.8.9`（`package.json` 没写 `engines`，Node 20/22 都能跑；本机用的是 Node 22.22.2）。

---

## 3. ★★ 第二步（换机的核心）：搬三份敏感文件

它们都在**仓库之外**，且都含密钥；**只能离开 git、单独传**。

| # | 文件 | 原机位置 | 里面有什么 |
| --- | --- | --- | --- |
| 1 | `config.json` | `%APPDATA%\dewu-bluev-publisher\` | `copy.llm.apiKey`（**真实模型密钥，35 字符**）、`publish.uiMap.*`（**真机实测的 UI 定位表**）、`paths.*`、`publish.device`、主题与各页配置 —— ★ 前两项 2026-10-08 起**已随包内置**（见 §3.0），换机通常不必再搬 |
| 2 | `auth.json` | 同上 | 账号 + 口令哈希（`admin` / `testbeta`）。哈希解不出明文，**但可直接登录** ⇒ 同样按密钥对待 |
| 3 | `.env` | **仓库根**（`D:\work\dewu-bluev-publisher\.env`，已 gitignore） | `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION` —— 只有**发版**时才读 |

**再说一遍口径**：这三份加起来 ≈ 这个项目的全部「钥匙」。**一旦提交进 git，即使之后删掉也留在历史里，只能去轮换密钥。**

### 3.0 ★★ 2026-10-08 起：**定位表与模型 key 已经内置进包**（给同事发包 / 换机都受益）

用户口径：「**装上即用** —— 同事拿到包就该能直接发，不该再装这装那，也不该自己导表」。
于是这两样最贵的资产从「每台机器各配一份」改成**随包内置**，规矩和 `cloud.url` / `llm.endpoint` 完全一样：
**留空＝跟随内置**（读时兜底、**绝不写回 config.json**）。

| 资产 | 内置在哪 | 新机器上的效果 |
| --- | --- | --- |
| **UI 定位表**（38 步图文 + 41 步视频） | `src/main/uimapdefaults.js`（★ 从原机 `config.json` **逐字节原样搬**，只补了一个 `screen` 坐标系戳） | 装完界面直接显示「定位表 38 步」，**不用抓、不用导** |
| **模型地址 / 模型 id / API Key** | `src/main/llmdefaults.js` | 「文案生成」开箱就是 AI 文案（**不再静默降级成本地模板**） |

⇒ **§3.1 的搬运工具仍然要留着**，但它现在只需要搬**这几样**：`brands[]`（品牌与权限）、
`copy.pool` / `copy.hotwords`（话术池与热词库）、`verify.*`、主题与各页阈值，以及 §3.3 的 `auth.json`。
`publish.uiMap.*` 与 `copy.llm.apiKey` **不用再搬** —— 搬了反而把它们焊死在那一台上，以后换包顶不动。

★ 三条口径（都带理由，别凭感觉改）：
1. **不要**把内置表写进 `store.defaults()` / `config.json`：那会随每次保存**固化**，
   以后换新表、换 key 再发包也顶不动老机器，而界面看不出来（§T9 实测踩过）。
   内置表的唯一读点是 `store.withBuiltinMap()` —— 只在**本机没有这个键**（`undefined`）时兜底。
2. 本机**显式 `null`**＝「我就是要没有表」，**不被内置值顶掉**（`tools/adbtest.js` 靠它验「未配必须报错」）；
   本机自己抓 / 导入的表**优先于**内置表。
3. 内置 key 属**半公开凭据**（谁拿到包谁就能刷额度）⇒ 别推公网仓库、额度设上限、出事直接换。
   ★★ **2026-10-08 起这条连仓库一起管**：key 已经**提交进 git**（`src/main/llmdefaults.js`），
   所以这个仓库（含 gitee 那个远端）**必须是私有的** —— 一旦公开推送，等于把 key 公开，
   只能去服务商把这对 key **轮换掉**（删文件、改文件都救不回来，历史里还在）。
   换 key 后**重发包即生效**；同事若自己填过 key，让他把那个框清空就回到跟随内置。
   ★ 另：`tools/copytest.js` 里那条判据是**从模块读 key**（不写死），换 key 只需改 `llmdefaults.js` 一处。

### 3.1 ★ `config.json` 怎么搬：用 `tools/config-portable.js`（2026-10-05 新增）

**先讲清问题**：`config.json` 是**三类东西混在一个文件里**，整份照拷必踩两个坑
（`paths.*` **静默失效**、两台机器共用一个 `machineId`）。而界面上那个
「导出配置 / 导入配置」按钮**只管云端协作的三个字段**（`cloud.url` / `cloud.anonKey` / `cloud.org`，
见 `src/main/services/cloudsync.js`）——**不含**品牌、话题池、热词库。
（★ 2026-10-08 更正：模型密钥与 `publish.uiMap` 现在都**随包内置**了，不再需要靠搬配置拿到，见 §3.0。）

⇒ 本项目自带搬运工具，把三类东西分开处理：

| 类别 | 字段 | 工具怎么处理 |
| --- | --- | --- |
| **可搬运** | `publish.uiMap.*`、`brands[]`、`copy.pool`、`copy.hotwords`、`compliance.*`、`verify.*`、`publish.devices[]`、主题 / 更新通道 / 各类阈值 | 原样带走（★ `publish.uiMap` 自 2026-10-08 起已内置，通常不必再搬） |
| **必须重置**（机器专属） | `paths.output/rejected/source`、`publish.adbPath`、`publish.ffmpegPath`、`cloud.machineId`、`cloud.machineName`、`window.bounds`、`window.maximized` | **显式置空**（理由见 §4.1 / §4.2） |
| **密钥** | `copy.llm.apiKey`、`verify.api.apiKey`（按**叶子键名**认；`cloud.anonKey` **不算** —— 那是公开设计） | **默认剔除**（新机重填）；要一起搬就加 `--with-secrets`（★ `copy.llm.apiKey` 自 2026-10-08 起已内置，通常不必搬） |

用法（**旧机导出 → 新机导入**）：

```bat
REM 旧机：先看现状（只读），再导出（默认抹掉密钥）
node tools/config-portable.js inspect
node tools/config-portable.js export --out D:\config-portable.json
REM       想连密钥一起搬就加 --with-secrets（那时这个文件属敏感件）
REM       想连项目状态一起搬就再加 --with-project（会置空其中的绝对路径）

REM 新机（先 clone + npm install）：先预演，看它打算写什么
node tools/config-portable.js import D:\config-portable.json
REM 确认无误再真写 —— 会先把原 config.json 备份成 config.json.bak-before-portable-<时间戳>
node tools/config-portable.js import D:\config-portable.json --yes
```

★ **导入前把 App 关掉** —— `config.json` 是 App 启动时读进内存、之后整份写回的
（`src/main/store.js` 的 `scheduleSave`，250ms 防抖）⇒ App 开着导进去，很可能被内存里的旧值刷掉。
★ 工具自带**往返自测**（用临时目录，**不碰真配置**）：`node tools/config-portable.js selftest`（33 条断言）。
★ 导入侧**不会**把本机已有的密钥抹空：包里被标为「已剔除」的密钥，本机若已有值则保留本机值。
★ 工具**不含**下面 §3.2 那四份文件 —— 它们各有各的处理方式。

### 3.2 另外四份**不要**照搬的文件

| 文件 | 为什么 |
| --- | --- |
| `cloud-sync.json` | **上行游标**（`offset` / `uploaded`）。照搬 ⇒ 新机接着老机器的位置推，可能漏推一截。**删掉让它自己重建** |
| `.updaterId` | 更新器的设备标识，新机应当自己生成 |
| `pool.json` | 商品池缓存（原机**没有**这个文件）。需要就在新机重新导入商品池 |
| `auth.json` | 账号库。两种带法见 §3.3 |

### 3.3 `auth.json` 的两种带法

1. **要保留账户与品牌权限 ⇒ 搬文件**（含 scrypt 哈希，解不出明文**但能直接登录** ⇒ 按密钥对待）。
   适合还要保留 `testbeta` 测试账号、以及各账号的品牌权限分配。
   ★★ 再多看一眼：`auth.json` 里那个 **`remember` 字段**（「记住登录」的会话）**也会被一起搬过去**
   —— 照搬等于把「已登录态」带过去，这是它比「一串哈希」更该按密钥对待的原因。
   ★ 实测事实（原机）：`admin` 账号的 `mustChange` 仍是 `true`，而源码 `src/main/auth.js` 里
   **只有改过口令才会把它置 `false`** ⇒ **这台机器的管理员口令至今还是出厂值 `BlueV@2026`**。
   两个含义：① 换机其实**不搬 `auth.json` 也能用默认账号登进去**；
   ② 这是一条该修的风险 —— 出厂口令谁都知道，建议在「品牌与权限 → 账号与安全」改掉。
2. **只想保住管理员口令 ⇒ 放种子文件**（更安全，明文不留盘）。
   在新机 `%APPDATA%\dewu-bluev-publisher\` 放一个 `auth.seed.json`：

   ```json
   { "username": "admin", "password": "你的口令" }
   ```

   App **首次启动**读走后**立即删除**（`src/main/auth.js` 的 `seedFrom()`）。
   也可改用环境变量 `BLUEV_ADMIN_USER` / `BLUEV_ADMIN_PASS`（优先级更高）。
   ★ 既不设种子、也不搬 `auth.json` ⇒ 新机建的是**出厂账号 `admin` / `BlueV@2026`**，并会提示改口令。

### 3.4 不搬 `config.json` 也可以（★ 2026-10-08 后只剩「路径」一项真代价）

1. ~~**模型密钥要重填**~~ → **已随包内置**（`src/main/llmdefaults.js`）。不填也能出 AI 文案。
   只有「这台机器要换用别的 key」时才需要填（填了以填的为准）。
2. ~~**UI 定位表要重抓**~~ → **已随包内置**（`src/main/uimapdefaults.js`，38 步图文 + 41 步视频）。
   不用抓、不用导。**但**得物改版后内置表一样会失效 ⇒ 那时才需要重抓 **并重发包**（这是内置的必然代价）。
3. **路径要重选**（`paths.output` / `rejected`）—— 这一条没变。

⇒ **要跑发布链路就搬 §3.1 里剩下的那几样（品牌 / 话术池 / 热词库 / 账号）；单纯改代码就什么都不搬。**

---

## 4. ★★ 第三步：新机上必须「重置」的三处（整份照搬 `config.json` 会踩）

> §3.1 的工具已经**自动**把 4.1 / 4.2 这两处置空了；这里写清楚**为什么**，用来判断工具是否按预期工作。

### 4.1 `cloud.machineId` 必须清空

源码 `src/main/services/cloudsync.js` 的 `machineOf()` 逻辑是**有就复用、没有才生成**：

```js
let id = String(cfg.machineId || '');
if (!id) { id = 'm_' + crypto.randomUUID().slice(0, 8); store.set({ cloud: { machineId: id } }); }
```

原机是 `cloud.machineId = m_fb6e1a86`。**照搬 config.json ⇒ 两台机器共用一个 machineId**，
云端看板会把它们当成同一台（机器数是错的、上报也混在一起）。

⇒ 做法：到新机后把 `cloud.machineId` 置为 `""`，App 下次启动会自己生成一个新的 `m_xxxxxxxx`。
（`cloud.machineName` 留空时会用 `os.hostname()`，换机后正好是新的主机名。）

### 4.2 路径是绝对路径，必须重选

原机配置：

```
paths.source    = C:\Users\Administrator\素材
paths.output    = C:\Users\Administrator\输出\得物
paths.rejected  = C:\Users\Administrator\素材\_rejected
```

新机用户名/盘符一变，这三条全失效（素材扫不到、隔离目录不存在、发布单回写落到别处 —— 而且**不会报错**）。

★ 顺带一个事实：**原机这条 `paths.source` 现在就指向一个不存在的目录**（`C:\Users\Administrator\素材` 已经没有了）。
⇒ 所以「沿用原值」本来也没意义，**新机务必重选一次**。

### 4.3 输出目录里才是台账，别只搬配置

`paths.output` 底下这些是业务记录（原机共 ~860 KB + 若干批次目录）：

| 文件 | 是什么 |
| --- | --- |
| `publish-log.jsonl`（88 KB） | **发布台账** |
| `run-log.jsonl`（717 KB） | 运行日志（界面「运行日志」页读的就是它） |
| `pending-results.json` | 「发布单被占着」时暂存、恢复后补写 |
| `发布单_*.xlsx` / `发布日志_*.log` / `运行日志_*.jsonl` | 导出物 |
| `batches/` `dumps/` `failures/` | 批次、抓屏、失败隔离 |

⇒ 要保留历史台账就把 `输出\得物` 整个带过去；不需要就在新机重来（不影响功能）。

---

## 5. 第四步：设备侧（只有跑发布链路才需要）

| 项 | 说明 |
| --- | --- |
| 模拟器 | 原机是 **MuMu 12**（`D:\MUMU\MuMuPlayer\nx_main`），**没有雷电**。新机装什么都行，但要按实际改名 |
| 设备串 | 以 `adb devices` **真名**为准。原机配的是 `emulator-5554`；新机可能报 `127.0.0.1:16384`；同一台机报多个端口时要按 `android_id` 去重 |
| adb | **内置**在 `vendor/adb/adb.exe`（随包进 `resources/`）。App「高级设置」页可手填，**手填优先**；手填的路径不存在但内置可用 ⇒ 退回内置并**在结果里说出来** |
| 得物 App | 装进模拟器/真机并**登录**。发布链路只能在真机上验证 |
| 中文输入法 | `vendor/adbkeyboard/ADBKeyboard.apk` 已在 git 里。App「高级设置」页「一键装」三步：`install -r` → `ime enable` → `ime set` |
| ★ 没有设备时 | **只能改代码、跑不依赖设备的回归**。`adbtest` 用假 adb 替身（`tools/fakeadb/`），**不接真机也能跑**；但**绝不许声称「已验证发布成功」** |

---

## 6. 第五步：新机验收（照做，全绿才算交接成功）

```bat
cd /d D:\work\dewu-bluev-publisher
git rev-parse HEAD
git ls-remote origin refs/heads/main    REM ★ 两条必须一致，才算「代码到位」
npm install
npm run addon:win
node tools/config-portable.js selftest  REM ★ 33 PASS / 0 FAIL
node tools/run-all.js                   REM ★ 18 套应全绿
```

★ **跑回归时绝不要设 `BLUEV_NO_LOGIN`** —— `logintest` 断言的正是「这个变量没设」；
设了会 3 条 FAIL 并**挂住不退出**。（那个变量只用于手动起 App 免登录进主界面。）
★ 断言数**以实测为准**：`README.md` 里那张套件表早就停了，实际已经是 **18 套 1660 项**
（2026-10-08 实测：`42+392+19+46+96+34+226+57+83+238+104+19+50+65+45+69+57+18 = 1660`）。
★ 跑之前清掉 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`（沙箱里可能被设上）：
`env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE node tools/run-all.js` ——
不清的话 `uicheck` / `logintest` / `gatetest` 这三个 Electron 套件会起不来。

逐项确认：

- [ ] `npx electron .` 能起界面、能进主界面、版本号显示 **1.0.15**
- [ ] `node tools/config-portable.js inspect` 里 `uiMap` 显示 **38 步图文 / 41 步视频**（说明定位表搬到了；
      ★ 2026-10-08 起即使没搬也该有 —— 内置表会兜底，见 §3.0）
- [ ] 「运行日志」页有内容（说明 `paths.output` 设对了）
- [ ] 「文案生成」页**密钥框空着也正常**（2026-10-08 起跟随内置 key，见 §3.0）；真要换 key 才填
- [ ] `cloud.machineId` 已是**新生成的** `m_xxxxxxxx`（不是 `m_fb6e1a86`）
- [ ] `adb devices` 能列出设备，App 里「扫描设备 → 加入并使用」成功
- [ ] 中文输入法「一键装」跑通（真机输入用得上）
- [ ] 要发版的话：`仓库根\.env` 在、`node tools/upload-release.js --channel stable` 能读到凭据（**别真发**，看它打印目标域名即可）
- [ ] ★ 判「真发还是演练」**不看配置里的 `publish.mock`** —— 那是个**死键**（全仓已无人读它，`tools/uicheck.js` 有断言守着；
      原机 `config.json` 里那个 `true` 是 2026-10-02 之前的残留，搬过来也无害）。
      真正的判据是**发布状态里的 `mode`**：只有在设备页点过「连接模拟器 / 检查能不能发布」并通过，它才会是 `adb`；
      否则是 `mock`（演练、不碰设备）。发布前看一眼「模拟器发布」页顶部的模式提示即可

---

## 7. 第六步：推送能力（要提交代码才需要）

- 原机用 gitee 的 SSH key（`~/.ssh`）。新机二选一：
  1. 拷原机私钥过去（**也是敏感文件**，同样不许走 git）；或
  2. **推荐**：在新机 `ssh-keygen -t ed25519` 生成新钥匙，把公钥加到 gitee 仓库的部署公钥（或账号公钥）。
- 设好提交身份（原机是 `张硕 <shawnz2000@outlook.com>`）：
  ```bat
  git config user.name "你的名字"
  git config user.email "你的邮箱"
  ```
- ★ 推送取证只认 `git ls-remote origin refs/heads/main` == `git rev-parse HEAD`。
  `git status` 干净 + `git log` 有提交 **都证明不了**「推上去了」。
- ★ `git commit -F <消息文件>` 的路径要给 **Windows 形式**（`E:/x/y.txt`）；Git Bash 的 `/e/…` 会被 git 报 `could not find file`。

---

## 8. 要发版才需要的额外两样

1. **`.env`**（§3 那张表里的第 3 份）—— 打在打包机上，读环境变量或仓库根 `.env`。
2. **不需要**把原机的 `dist\` 带过去：`npm run dist:win` 能在新机重打；
   而且 **1.0.15 已经在公网通道上**，新机直接「检查更新」就能装到最新。
   要回滚点才需要 `D:\work\_dist-archive\`（里面是历史版本的安装包）。

发版三条最容易出事的（详见 `docs/knowledge/docs/发版流程SOP.md`）：
① 版本号单独一条提交；`docs/visual` 刷新要排在版本号之后；
② 从**干净快照**打包（`git worktree add --detach`，`node_modules` 用目录联接，先摘后删）；
③ **发包 ≠ 生效** —— 核公网 `latest.yml`、安装包 `Content-Length`、`--version`、`beta.yml` 未被动过。

---

## 9. 收尾：交接后必做

- [ ] 旧机上**撤销不再需要的访问**：gitee 里把不再用的部署公钥/账号撤掉。
- [ ] 如果这次是通过聊天/U 盘传过密钥：传完**清理中转文件**（压缩包别留在下载目录/网盘）。
- [ ] ★ 若两台机器**同时**开着云端上报且 `machineId` 撞了 ⇒ 看板上机器数不对，按 §4.1 修正。
- [ ] 提醒接手方：`docs/knowledge/` 是**快照（2026-10-05）**，里面的断言数/体积/耗时**每次实测重取**。
