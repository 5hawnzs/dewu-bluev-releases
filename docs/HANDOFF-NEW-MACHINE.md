# 换机方案：把项目搬到另一台机器跑（Codex / 别人接手）

> 2026-10-05 编制 · 对应仓库 HEAD `5c96db8` · 版本 **1.0.15**
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
| 源码 / 17 套回归 / `docs/` / `docs/knowledge/` / `AGENTS.md` | **`git clone`** | 公开级 |
| `vendor/adb/*` `vendor/ffmpeg/*` `vendor/adbkeyboard/ADBKeyboard.apk` | **`git clone`**（★ 这些二进制**已经在 git 里**，不用另外拷） | 公开级 |
| **`config.json`** | 加密包 / U 盘 / 内网共享 —— **绝不许走 git、不许贴聊天** | ★★ 含真实模型密钥 |
| **`auth.json`** | 同上 | ★★ 含账号口令哈希 |
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
| 1 | `config.json` | `%APPDATA%\dewu-bluev-publisher\` | `copy.llm.apiKey`（**真实模型密钥，35 字符**）、`publish.uiMap.*`（**真机实测的 UI 定位表**）、`paths.*`、`publish.device`、主题与各页配置 |
| 2 | `auth.json` | 同上 | 账号 + 口令哈希（`admin` / `testbeta`）。哈希解不出明文，**但可直接登录** ⇒ 同样按密钥对待 |
| 3 | `.env` | **仓库根**（`D:\work\dewu-bluev-publisher\.env`，已 gitignore） | `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET` / `COS_REGION` —— 只有**发版**时才读 |

**再说一遍口径**：这三份加起来 ≈ 这个项目的全部「钥匙」。**一旦提交进 git，即使之后删掉也留在历史里，只能去轮换密钥。**

### 3.1 ★ 可以不搬 `config.json` —— 但要接受三个代价

系统里**没有「整份配置导出」**这个功能：界面上那个「导出配置 / 导入配置」只针对**云端协作**（`cloud.url` + `anonKey`），**不含模型密钥、不含 UI 定位表**。（源码：`src/main/services/cloudsync.js` 的 `exportConfig()` 只返回这三个字段。）

所以「不搬、在新机重建」完全可以，代价是：

1. **模型密钥要重填**：「文案生成」页填 endpoint + apiKey。不填 ⇒ 文案只会走本地模板（工具不报错，是静默降级）。
2. **UI 定位表要重抓**：得物发布页那套 `publish.uiMap.steps / videoSteps` 只在 `config.json` 里（`src/` 里没有内置默认值）。
   ⇒ 要连上设备，在「模拟器发布」页**抓取页面结构 → 导入**。**这是最贵的一步**，而且得物改版后本来也要重抓。
3. **路径要重选**：素材目录 / 输出目录 / 隔离目录。

⇒ **结论**：要跑发布链路就把 `config.json` 带过去；单纯改代码就重填（更省事也更安全）。

---

## 4. ★★ 第三步：新机上必须「重置」的三处（直接照搬 `config.json` 会踩）

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
node tools/run-all.js                   REM ★ 17 套应全绿
```

★ **跑回归时绝不要设 `BLUEV_NO_LOGIN`** —— `logintest` 断言的正是「这个变量没设」；
设了会 3 条 FAIL 并**挂住不退出**。（那个变量只用于手动起 App 免登录进主界面。）
★ 断言数**以实测为准**：`README.md` 里那张套件表停在 **1005 项（2026-10-03）**，实际已经是 **17 套 1622 项**。

逐项确认：

- [ ] `npx electron .` 能起界面、能进主界面、版本号显示 **1.0.15**
- [ ] 「运行日志」页有内容（说明 `paths.output` 设对了）
- [ ] 若搬了 `config.json`：**「文案生成」页能看到密钥**、「模拟器发布」页**UI 定位表在**
- [ ] `cloud.machineId` 已是**新生成的** `m_xxxxxxxx`（不是 `m_fb6e1a86`）
- [ ] `adb devices` 能列出设备，App 里「扫描设备 → 加入并使用」成功
- [ ] 中文输入法「一键装」跑通（真机输入用得上）
- [ ] 要发版的话：`仓库根\.env` 在、`node tools/upload-release.js --channel stable` 能读到凭据（**别真发**，看它打印目标域名即可）
- [ ] ★ 检查 `publish.mock` —— 原机当前是 **`true`**（干跑）。照搬后如果没注意，会以为在真发。发布前务必确认这个开关

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
