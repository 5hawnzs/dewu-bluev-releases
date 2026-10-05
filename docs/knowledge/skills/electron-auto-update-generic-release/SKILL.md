---
name: electron-auto-update-generic-release
description: 给 Electron + electron-builder 应用接上「自动更新 + 自建发布通道」（对象存储 / 自建静态站，即 electron-updater 的 generic provider），并把「绝不自动重启」「源地址编译进包」这两条红线做成可测断言。当出现「应用怎么自动更新」「怎么把包放到自己的 COS/OSS/S3/nginx 上」「electron-updater 配好了但客户端永远说已是最新」「generic 提供者要不要自己上传」「怎么同时有正式版和测试版两条通道」「我的账号登录正式版，为什么当前版本还带 beta」这类需求时使用。含：NSIS 与 portable 的区别、app-update.yml 在哪与为什么不能用 setFeedURL、★★ 正式版/测试版双通道的正确做法（同一个包 + 运行时切 channel，附源码依据，不是发两个包）、★★ 把「测试版通道只给管理员」做成三层权限（界面里连字样都不渲染 / 主进程 guardAdmin / 登录与启动时复核落盘）、★★ allowDowngrade 只在「刚切回正式版」那次放行的副作用（装了 -beta 包后回正式版会一直说「已是最新」且不报错，附版本号规划对策；以及「当前版本」= 包里写死的 app.getVersion()，跟通道/账号都无关）、userData 目录名取 package.json.name 而非中文 productName、发版脚本必须自己传三件套、桶权限 404/403 探针、「验收看文件不看配置」的验收清单，以及「驱动脚本跑 electron 套件会假绿（忘删 ELECTRON_RUN_AS_NODE ⇒ PASS 0 被误读成全绿；同一个变量还会让**已打包的 exe 秒退 0 且什么都不落盘**、报 `bad option` 那种 Node 格式的错，别把它当成"包坏了"）」这个坑。★ 另含「点检查更新报 `ENOENT ... app-update.yml`、当前版本旁边显示『出错』」的根因（`--dir` 目录产物不生成 `app-update.yml`，只有 nsis target 才生成）与判据、以及「把探针注入 exe 读运行态」的排查法（§8）。
agent_created: true
---

# Electron 自建通道自动更新（generic provider）

> ★ 本文讲的是**机制**（通道 / 五处闸门 / 验收 / 目录产物）。
> **发版时的「动作」** —— 并发工作区体检 → `git worktree` 干净快照里打包 → 只暂存自己的文件 →
> `git ls-remote` 才是推送证据 → 换已装副本 asar —— 见技能 **`concurrent-workspace-safe-release`**。

## 何时用

- 要给 Electron 桌面应用加自动更新，且**不用 GitHub Releases / 不用 S3 专用 provider**，而是把产物
  丢到自己的对象存储（腾讯云 COS / 阿里 OSS / MinIO）或 nginx 静态目录。
- 现象类需求：「配好了但客户端永远显示已是最新」「换了个发布的地址要不要发版」。

## 0. 先判可行性：**NSIS 支持自动更新，portable 不支持**

portable 版每次启动自解压到临时目录，**没法就地替换**，所以永远收不到更新。
判据（运行时检测）：环境变量 `PORTABLE_EXECUTABLE_FILE` / `PORTABLE_EXECUTABLE_DIR` 非空即为便携版。

⇒ 界面上必须**如实写「当前版本不支持自动更新」并说明原因**，不要摆一个点了没反应的按钮。
同理 `app.isPackaged === false`（开发模式 `npm start`）也要如实标不可用 —— 别让界面骗人。

## 1. 配置（`package.json` 的 `build.publish`）

```json
"publish": [{ "provider": "generic", "url": "<你的域名>/", "channel": "latest" }]
```

打包后 electron-builder 会在 **`dist/<platform>-unpacked/resources/app-update.yml`** 生成
（★★ **只在 `nsis` / `nsis-*` / 开了 `electronUpdaterAware` 的 `appx` 这些 target 下才写**；
`--dir` 打包的 target 名是 `dir` ⇒ **不写这个文件**。拿这种目录里的 exe 跑，
一点「检查更新」就报 `ENOENT ... app-update.yml`，见 §8）：

```yaml
provider: generic
url: https://<域名>/
channel: latest          # ★ 只是默认值；用户切通道后运行时会被覆盖，见 §2
updaterCacheDirName: <name>-updater
```

★ 这个文件**在 asar 外、编译进包**，所以 `cat` 就能看，不用解包。

## 2. ★★ 两条红线（写进代码文件头，别只写在文档里）

### 红线一：**绝不自动重启**

`autoUpdater.on('update-downloaded')` 里**只改状态**，**绝不调 `quitAndInstall()`**。
这个工具很可能正在跑批量任务，静默重启会把任务掐断且**没有回滚**。

```js
const AUTO_DOWNLOAD = false;              // 88MB 的包不替用户决定带宽
up.autoDownload = AUTO_DOWNLOAD;
up.autoInstallOnAppQuit = false;          // 退出时偷偷装 = 同一条红线的另一面
// 只有用户点了「重启并安装」才：
autoUpdater.quitAndInstall(false /* 不静默 */, true /* 装完立刻重启 */);
```

在 IPC 那层再加一道：**有任务在跑就拒绝安装**并说明原因（「还有 N 个任务在跑，装完会重启把任务掐断」）。

### 红线二：**不在运行时改源地址**（但**通道名可以**改）

electron-updater **只认包里的 `app-update.yml`**，官方明确**不支持也不需要 `setFeedURL`**。
⇒ 源地址是**编译进包**的：**换地址 = 所有已装客户端全部失联，只能重发一次包**。

★★ **但「源地址」和「通道名」是两件事，千万别混** —— 我第一版就把双通道写成了「只能发两个包」，
后来又用源码推翻了自己。通道名只决定**读源上哪个清单文件**，而它有公开的运行时开关。
源码依据（`node_modules/electron-updater/out/`）：

| 位置 | 事实 |
| --- | --- |
| `GenericProvider.get channel()` | `return this.updater.channel \|\| this.configuration.channel` —— **updater 上的值优先** |
| `GenericProvider.getChannelFilename(channel)` | 返回 `` `${channel}.yml` ``，再由 `newUrlFromBase` 拼到 `configuration.url` **之后、同级** |
| `AppUpdater` 的 `set channel(v)` | 注释原话：**「Overrides `channel` in the update configuration.」** —— 公开支持运行时改 |
| `getChannelFilePrefix()` | Windows **没有平台后缀**（`-mac` / `-linux` 才有），所以就是 `latest.yml` / `beta.yml` |

⇒ **「一个安装包 + 设置里切通道」是成立的**：不用出两个包、不用重装、源地址也不用变。
正式版读 `latest.yml`、测试版读 `beta.yml`，两者**放在同一层**，互不干扰。

**实测可用的一种布局**（`url` 就是桶根，**不带** `/stable` 这类子目录）：

```
https://<bucket>.cos.<region>.myqcloud.com/     ← app-update.yml 里的 url
├── latest.yml            ← 正式版读它
├── beta.yml              ← 测试版读它
├── <产品名>-1.0.0-x64-win.exe
└── <产品名>-1.0.0-x64-win.exe.blockmap
```

★ **`set channel` 的副作用必须手动压回**：它会顺手把 `allowDowngrade` 设成 `true`。
不压回的话，源上被人放个旧包，正式版用户会被**悄悄降下去**：

```js
up.channel = CHANNELS[which];                        // 'latest' | 'beta'
up.allowDowngrade = justSwitched;   // 只在「测试版→正式版」那一次放行，其余一律 false
```

降级规则：**测试版 → 正式版**允许（否则切了回不去，正式版版本号本来就更小）；
**正式版 → 测试版**不允许。检查成功后立刻收回放行，失败时保留（网络抖动不该用掉这一次机会）。
发布侧再加一道「不许往回发版本」的闸门兜底，见 §3。

### ★★ 但「只放行一次」有个副作用：装了 `-beta` 包之后，回正式版会**一直说「已是最新」**

真被用户问到过：「我登录正式版，为什么当前版本还带 beta？」——背后是两件事叠在一起：

- 源上实测：`latest.yml` = `1.0.0`、`beta.yml` = `1.0.1-beta.2`；本机装的是 `1.0.1-beta.2`。
- semver **先比 `1.0.1 > 1.0.0`**（跟 `-beta` 后缀无关）⇒ 在正式版通道检查，
  `gt(latest, current)` 为 `false` ⇒ 走到最后一行 `return this.allowDowngrade && isLatestVersionOlder`
  （源码 `electron-updater/out/AppUpdater.js` 的 `isUpdateAvailable()`）。
- `allowDowngrade` 只在**刚切回正式版的那一次检查**为 `true`
  ⇒ **只有切完通道后的第一次检查**（启动 20 秒的自动自检，或你手点的那次）才可能看到 `1.0.0`；
  过了那次就再也等不到，而且**界面只说「已是最新」，不报任何错**。

⇒ 三条对策：

1. **版本号规划**：测试版用 `1.0.1-beta.N`，对应的正式版就发 **`1.0.1`** ——
   `1.0.1 > 1.0.1-beta.2` ⇒ 装了测试包的机器切回正式版后是**正常升级**，不依赖降级窗口。
   （不然要么等很久，要么只能赌那一次机会。）
2. **给用户一条能自救的路**：切回正式版后**立刻**点一次「检查更新」。
   代码里 `justSwitched` 在检查**成功**后才复位、失败时保留 ⇒ 网络抖动不会把这次机会用掉（有意为之）。
3. **「当前版本」这个数字不要指望它跟通道联动** —— 它是 `app.getVersion()`，**打包时写死在包里**。
   切通道、换账号都不改它。界面上必须写清这一点，否则用户 100% 会当成 bug 来问（实测如此）。

> ★ 顺带一条排查用的事实：Electron 的 `userData` 目录名取的是 **`package.json.name`**，
> 不是中文 `productName` —— electron-builder 打包时会**把 `productName` 从 asar 里的 package.json 剥掉**
> （实测 grep 不到）。所以开发模式和安装版**用的是同一个** `%APPDATA%\<name>\`，
> 别去 `%APPDATA%\<中文产品名>\` 里找 `config.json`。

## 3. ★★ generic provider **不会替你上传**

官方文档写得很直白：generic 需要**你自己把文件放上去**。漏了这步的症状极隐蔽 ——
**源上还是旧的 `latest.yml`，应用永远显示「已是最新」，且不报任何错**。

所以要自己写一个发版脚本，传**三样**：

| 文件 | 为什么 |
| --- | --- |
| `<产品名>-<版本>-x64-win.exe`（**只传安装版**） | 客户端实际下载的对象；便携版传上去只会让人下错 |
| `latest.yml` | 更新清单，客户端先读它 |
| `*.exe.blockmap` | 差量更新用（★ 有它**也不保证**真走增量，见 §3.1） |

脚本里必须有的**五处闸门**（都是"传了等于没传"的静默失败）：

1. **`dist` 里的版本号 vs `package.json` 的版本号**必须一致 —— 不一致说明 `dist` 是旧包；
2. **`latest.yml` 里的 `path` vs `dist` 里实际的 exe 文件名**必须一致 ——
   客户端按 `path` 去下载，**对不上就是 404**（中文产物名是常见坑，注意 URL 编码）；
3. **源上已是同一版本号 ⇒ 拒绝覆盖**（要覆盖得显式 `--force`）——
   electron-updater **按版本号比较**，不涨版本号就覆盖 ⇒ 客户端判「没有新版本」，
   而且新旧文件同名，事后完全查不出来。

4. **`dist` 里必须恰好 1 个安装版 exe** —— electron-builder **不清理 `dist/`**：改了版本号重打之后，
   新旧两个包会同时躺在那儿，不拦就会把旧包传上去（实测踩过：发 beta 时 dist 里还留着上一个版本的 exe）。
5. ★★ **做了双通道就必须加这一道，也是最阴的一道：版本后缀要和通道对得上**（双通道见 §2）。

```js
// 预发布版本发到正式通道 ⇒ 拦住。这一种**不报错、也不是「收不到」，而是「推错了人」**：
// latest.yml 里被写上测试版号 ⇒ 所有正式版用户下次检查更新都会看到「有新版本 1.0.1-beta.1」。
const isPre = /^\d+\.\d+\.\d+-/.test(version);   // 只认 `-` 段；`+build` 是构建元数据，不算预发布
if (channel === 'stable' && isPre)  block('pre-to-stable');
if (channel === 'beta'   && !isPre) block('release-to-beta');
```

三个要点缺一个就出事：

- **必须独立于上面第 3 条、不能互相替代**：第 3 条只在「源上已有清单」时才比较，而
  **Beta 首次发布时 `beta.yml` 根本不存在** ⇒ 那条直接放行，这道照样得拦。写成断言守住：
  `versionGate('', '1.0.1-beta.1').block === false` 且 `channelMismatch('stable','1.0.1-beta.1').block === true`。
- **不许误伤**：两条正确姿势（预发布→beta、正式版→stable）**必须放行**，同样写成断言 ——
  否则闸门一装就把日常发版全堵死了。
- **检查要放在 `--dry-run` 之前**：手滑最常发生在「复制了另一条通道的那条命令」的那一刻。

加分项：提供 `--dry-run`，先只打印「要传哪些 / 多大 / 目标地址」。

### 3.1 ★★ 「只下增量」不是有了 blockmap 就自动生效

**先自算理论上限**（不用装应用、不用联网跑客户端，直接拿源上的 blockmap 算）：
`.blockmap` 是 gzip 压的 JSON，形状是 `{version, files:[{name, offset, checksums[], sizes[]}]}`。
gunzip 之后，用 **electron-updater 自己的** `out/differentialDownloader/downloadPlanBuilder.js`
导出的 `computeOperations(oldBm, newBm, noopLogger)` 算出来的就是客户端会走的计划。
实测一例（NSIS，包 88 MB）：

| 从 → 到 | 需下载 | 全量 | 省 |
| --- | --- | --- | --- |
| `1.0.0` → `1.0.1` | **10.9 MB** / 11 段 | 88.0 MB | 87.7% |
| `1.0.0` → `1.0.1-beta.2` | **5.9 MB** | 85.0 MB | 93.0% |

**但这只是上限。** electron-updater 6.8.9 + NSIS + generic 上查到一个可疑点（**源码推断，必须实测**）：
`AppUpdater` 取「旧文件」用的是固定名 `<cacheDir>/installer.exe`
（`CURRENT_APP_INSTALLER_FILE_NAME`），而**下载下来的安装包实际落在
`<cacheDir>/pending/<真实文件名>`**（`getCacheUpdateFileName()` = `path.basename(url)`）——
全仓**只有一处**引用那个固定名、**没有任何地方创建它**。若它真的不存在，
`DifferentialDownloader` 里的 `open(oldFile, "r")` 会抛 ENOENT，被外层 catch 掉后
**静默退回全量下载**。`disableDifferentialDownload` 默认没设 ⇒ 这**不是**配置问题。

⇒ **交付口径**：别说「配了 blockmap 就只下增量」，要说「**blockmap 是必要条件，不是充分条件**」。

**怎么实测**（两条，第二条才是能定论的）：

① 零成本粗判：更新时界面上那行进度读的是 `download-progress` 的 `transferred` ——
显示 ~11 MB 就是增量生效、~88 MB 就是全量。但它只有小数、没法留档。

② ★★ **给应用加一个「可选的文件日志」开关，并且开着时把 `up.logger` 接过来**（推荐做法，见下）。
然后让客户端打印 `download-progress` / `update-downloaded` 的 `transferred` 与 `total`
—— **`total` 才是「这次到底下了多少」的硬数字**：走差分时它只是变化块，静默退回全量时它 ≈ 满包。

```
[downloaded] 新版本 1.0.1 已下载完成：本次共 11534336 字节（11.0 MB）；当前版本 1.0.0
```

**「可选文件日志」怎么落地**（这套模式值得照抄，细节别踩）：

- **默认关**；开着时才 `up.logger = 我们的 logger`、关着时保持 `null`。★ 关键是**这句要按开关走** ——
  写死 `null` 就把 `Cannot download differentially, fallback to full download`（error 级）一起吞了，
  于是「更新慢」这件事**永远查不出原因**。把这个判断做成断言（源码级锚点也行），否则下一个人会「顺手简化」回 `null`。
- 用 **`fs.openSync(path,'a')` + `fs.writeSync`** 而不是流：开/关/写全同步 ⇒ **可单测、可复算**，也不会留下未 flush 的尾巴。
- 落盘位置**由调用方传进 userData**（`<userData>/logs/update.log`）；这个模块本身**不许 require electron**，
  不然纯 Node 回归跑不起来。路径写成**纯函数**（`defaultLogFile(userDataDir)`）便于断言。
- **进度必须抽稀**（每跨 10% 或每 2 秒一条），否则每秒好几条会把日志刷没。
- **必须有上限 + 轮转**（超 N MB 挪成 `.1`），否则长期开着会把磁盘吃满。
- ★★ **打不开时如实报 `enabled:false` + 原因**，并把这个状态显示在界面上；**绝不许假装「记录中」**。
- 日志里**只写版本号 / 通道名 / 字节数**，不写业务数据 —— 这样「数据不出本机」那条承诺不用改口。
- 开关**落盘持久化**（否则下次启动又变回关，用户白开一次）。
- 界面：**关着时也要显示「开了会写到哪」**，并写明「为什么值得开」（差分退回全量只有这里看得见）。
  按钮要**走真 IPC 并让断言检查文件真的被建出来** —— 只验「按钮存在」会把「没接线」放过去。

★ **老版本的 `.blockmap` 必须留在源上**：`Provider.getBlockMapFiles` 是把新文件名里的
新版本号**字符串替换成旧版本号**来拼旧 blockmap 的 URL —— 删掉老 blockmap，连尝试增量的机会都没有。

### 3.2 ★★ 老包会无限堆积：用**保留策略**清，**别用同名覆盖**

产物名带版本号（`${productName}-${version}-${arch}-win.${ext}`）⇒ **每次发版天然新增一个满包**
（实测 4 个 exe = 343 MB）；而 generic provider 的桶上通常**没有生命周期规则**、上传脚本也
**只有上传能力** ⇒ 老包只增不减。

**为什么不该改成「同名覆盖」**（人人都会先想到的方案）：
① **回滚没了** —— 正式通道本来就允许降级（用户从测试版切回正式版靠它、出事回退也靠它），包被覆盖就回不去；
② **审计线索没了** —— 「哪次更新对应哪个包」是事后唯一能对上的凭据；
③ 覆盖同版本号会让客户端按版本号比较后判「没有新版本」（版本闸门拦的就是这个）。

正确做法：**保留策略 + 默认 dry-run + 三条 fail-closed**。
保留名单 = 每条通道各留「**当前 + N 个可回滚的历史版本**」（N 默认 1）+ 两条清单文件**永远保留**。

| ★★ fail-closed 闸门（源上状态不明 ⇒ 宁可什么都不动，这个工具的失败不可逆） | 行为 |
| --- | --- |
| 读不到 `latest.yml` 的版本号 | **一个字节都不删**，并打印原因 |
| 版本比该通道当前版本**还新** | **保留**并写进 notes —— 多半是「包传上去了、清单没传成」，那正是要用来救场的那一份 |
| 认不出版本号的对象（清单 / 0 字节占位 / 别人家的 exe） | **保留** |

★ **版本号解析要刻意做窄**：通杀型 semver 正则会以为 `1.0.1-x64-win.exe` 的版本是 **`1.0.1-x64`**
（`x64` 本身就是合法的 semver 预发布段）⇒ 读错版本 = **删错包**。锚定产物模板：

```js
/-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-(?:x64|ia32|arm64|armv7l)-win\.exe(\.blockmap)?$/i
```

认不出来就保留，**别硬凑**。（删错包不可恢复 ⇒ 这条必须有一条专门的断言 + 一次定点破坏证明它真的会红。）

其它必做：默认 `--dry-run`（真删要显式 `--apply`）；每个对象都打印「**为什么留 / 为什么删**」；
删完**逐个 HEAD 复核**保留名单里的包还在（说删干净了要拿源上的事实说话）。

## 4. ★ 验收：**看文件，不看配置**

地址写错时应用**不会报错**，只会一直说「已是最新」。所以打完包**必须真的看一眼这两个文件**：

```bash
cat dist/<platform>-unpacked/resources/app-update.yml   # url / channel / provider 对不对
cat dist/latest.yml                                     # path 指向安装版 exe、sha512/size 有值
```

再确认依赖真进了包（`electron-updater` 是**运行时依赖**，别放进 devDependencies）：

```bash
node -e "const a=require('@electron/asar');const l=a.listPackage('dist/<platform>-unpacked/resources/app.asar');
console.log(l.filter(p=>p.includes('electron-updater')).slice(0,5), l.length)"
```

★ **别拿一个来路不明的旧 `dist/` 快照当证据**：如果 `dist/` 里那份 asar 不是刚打的包，
里面没有 `electron-updater` **完全不能**说明"依赖没打进包"（实测踩过：那是别人/早先的构建产物）。

### 端到端验收（**必须真机** —— 打包机上根本做不了）

装 1.0.0 安装版 → 源上换成 1.0.1 → 点「检查更新」→「下载更新」→「立即安装并重启」
→ **看「当前版本」这个数字真的变了**。别的都不算证据。

- 打包机上只有 `dist/win-unpacked/` 这个**解包目录**。★ **别把它的表现记错**（我记错过一次）：
  从 `win-unpacked` 里的 exe 启动，实测 `app.isPackaged` 是 **`true`**，更新面板**也不是**「不可用」
  —— **按钮是能点的**！但因为没有 `resources/app-update.yml`（见 §1），一点「检查更新」就报 ENOENT，
  面板上「当前版本」那行旁边挂出红色徽标「**出错**」。
  两种都不是真安装版的行为 ⇒ **拿它验收等于什么都没验**（这条踩过）。
  （真正会显示「不可用」的是开发模式 `electron .`，那才是 `isPackaged === false`。）
  ⇒ 判据：exe 所在目录里有没有 `Uninstall <产品名>.exe`。有 = 安装版；只有光秃秃的 `win-unpacked` = 绿色目录。
- **版本号不涨 = 什么都没发生**：electron-updater 按版本号比较，源上放个同版本号的新包，
  客户端只判「没有新版本」——最容易骗过自己的一种假成功。
- 失败时按顺序查三处：`app-update.yml` 的 `url` → 源上清单里的 `path` → 应用面板给的**具体报错文案**。

★ **发布前先确认源上到底有没有东西**。空桶的症状和「已是最新」长得极像：客户端点检查更新只会拿到 **404**。

★ **桶权限用一个探针就能判**（比翻云控制台靠谱）：对一个**不存在**的对象发匿名请求，
**404 = 公有读（客户端下载得下来）、403 = 私有读（下载全 403，自动更新整条链废掉）**：

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<域名>/latest.yml"   # 404=桶空可读 / 200=已发布 / 403=读取权限没开
```

## 5. 回归怎么写（不联网、不下载、不碰真 electron-updater）

用 `EventEmitter` 造一个**假 `autoUpdater`**，只保留真正用到的那几个成员，逐条断言：

- `autoDownload === false` 且 `autoInstallOnAppQuit === false`（故意给错值，验会被压回来）；
- **`update-downloaded` 之后 `quitAndInstall` 的调用次数必须 === 0**（这是红线一的守门人）；
- 只有点「重启并安装」时才调，且参数是 `(false, true)`；
- 状态机流转：`idle→checking→available→downloading→ready` 与 `uptodate` / `error` 回退；
- **重复点「检查更新」不会并发**起第二次（闸门要能复位，否则界面永远卡在「检查中」）；
- 推到界面的 payload 是**快照**而不是活引用。

★ 把「发版脚本的纯逻辑」（解析 `latest.yml`、挑安装包、版本号闸门）抽成**纯函数**再单测 ——
真实上传要凭据要联网，回归里跑不了，但上面那三处闸门必须被断言守住。

### ★★ 如果你写的驱动脚本里要跑 electron 套件，它自己会骗你两次

（典型场景：写「定点破坏」脚本 —— 拆掉修复 → 跑套件 → 期望变红。这条踩过。）

1. **`ELECTRON_RUN_AS_NODE` 必须从子进程环境里删掉**。这个变量会让 `electron.exe` 退化成
   **纯 Node**：`require('electron').app` 是 `undefined`，套件**第一行就 TypeError**，
   输出里**一条 PASS 都没有**。于是你看到 `PASS 0 / FAIL 0`，
   很容易读成「拆了修复居然还是全绿 ⇒ 断言根本没在查东西」—— **完全错误的结论**。

```js
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;            // 不删 ⇒ 套件根本没启动
const flags = ['--in-process-gpu', '--disable-gpu'];   // 无桌面会话时 GPU 进程 FATAL 会拖死整个 Electron
```

2. ★★ 把「**PASS 0 且 FAIL 0**」**单独判成失败**（语义 =「套件没跑起来」），绝不并入「全绿」：

```js
if (pass === 0 && fail === 0) problems.push(`${name}: 套件未启动（不是绿！）`);
```

> 这条的教训比它本身更值钱：**"全绿"必须先证明"确实跑了"**。断言 0 条通过时，
> 你手里没有任何证据，而不是有一堆证据说"没问题"。

## 6. 坑清单（按踩到概率排）

- 把 `electron-updater` 写进 `devDependencies` ⇒ 打包时不在，运行时报模块找不到。
- 试图 `setFeedURL` 做通道切换 ⇒ 官方不支持；换地址只能重发包。
- generic provider 以为会代传 ⇒ 静默失效，见 §3。
- 便携版也指望自动更新 ⇒ 不可能，见 §0。
- 同版本号覆盖上传 ⇒ 客户端永远收不到，见 §3 第 3 条。
- 版本号写进 `latest.yml` 但没同步 `package.json` ⇒ 同上，闸门 1 拦住。
- **打包机上很可能没装安装版** ⇒ 端到端那一步要在用户机器上做，别在本机"假装验过"，见 §4。
- **以为做双通道就得发两个包 / 两个源地址** ⇒ 见 §2：通道名能运行时改，一个包就够。
- **以为「有版本号闸门就够了」** ⇒ 见 §3 第 5 条：`versionGate` 只比版本号**高低**，
  **完全不看通道与后缀是否匹配**。把 `1.0.1-beta.1` 用正式通道发出去，不报错、客户端也收得到，
  但**推错了人**——所有正式版用户都会看到这个测试版号。
- **改了版本号重打却没清 `dist/`** ⇒ 新旧两个 exe 并存，见 §3 第 4 条。
- **忘了把 `allowDowngrade` 压回 `false`** ⇒ 源上放个旧包会把正式版用户**悄悄降下去**，见 §2。
- **改了发布布局（子目录→桶根、去掉 portable）却没回头 grep 旧词** ⇒ 文档会继续对着用户说反话。
  改完机制至少扫一遍：`grep -rn "stable/\|便携\|88 MB" README.md docs/`。
- 私钥/SecretKey **绝不进仓库**：放 `.env`（写进 `.gitignore`），并确认 `git status` 里看不到它。
- **把「只有管理员能切测试版」只做在界面上** ⇒ 等于没做，见 §7：真正的防线是主进程 `guardAdmin`。
- **开关是落盘的，却只在「点按钮」那一刻校验** ⇒ 换人登录后旧值还在（一直收测试包），见 §7 第 3 层。
- **「免登录 / 无当前账号」时多处权限入口口径不一致** ⇒ 统计能看全部、列表却空，见 §7 末节。
- ★★ **驱动脚本里跑 electron 套件忘了删 `ELECTRON_RUN_AS_NODE`** ⇒ `PASS 0 / FAIL 0` 被误读成"全绿"，见 §5。
- ★★ **启动「已打包的 exe」时同一个变量会换一副面孔** —— exe 退化成**纯 Node**：
  **无参数秒退、exit 0、什么都不落盘**（连 `userData/Cache` 都不建）；带参数报 `xxx.exe: bad option: --x`。
  ★ **`bad option: --xxx` 是 Node 的报错格式**（Chromium 不会这么说）—— 看见它就该想到"被当 Node 跑了"。
  ⇒ 冒烟一律 `env -u ELECTRON_RUN_AS_NODE ./应用.exe`；**别据此断定"这个包坏了"**。
  判"真起来了"要看：进程存活（`timeout` 返 124）+ 主进程写出 `userData/auth.json` + 缓存目录出现。
- ★★ **命令行参数只认 `--name value`、不认 `--name=value`** ⇒ 用户敲 `--channel=beta` 时被**静默**忽略、退回默认 `stable`，
  等于**把测试版包推给所有正式用户**，而且全程不报错（发版脚本最容易中，见 §3）。
  ⇒ 参数解析一律抽成纯函数并单测：两种写法都认；`--x=` 空值给 `''` 而**不落回默认值**。
- ★★ **日志关着时写死 `up.logger = null`** ⇒ `electron-updater` 的
  `Cannot download differentially, fallback to full download`（**error 级**）被一起吞掉，
  「差分静默退回全量」这类问题永远查不出来。正确写法是**按开关挂**：
  `up.logger = (logFd !== null) ? fileLogger : null;`，见 §3.1。
- ★★ **用通杀型 semver 正则从文件名抠版本号** ⇒ `1.0.1-x64-win.exe` 会被读成 `1.0.1-x64`
  （`x64` 本身是合法预发布段）⇒ **版本比错 ⇒ 删错包**。清理工具的版本正则要刻意做窄，见 §3.2。
- ★★ **清理/删除类工具默认就 `--apply`** ⇒ 一条命令下去不可逆。默认必须 **dry-run**，
  且要 **fail-closed**（读不到清单、认不出名字、比当前版本还新的，一律**保留**并说明原因），见 §3.2。
- ★ **定点破坏脚本里的跨行锚点遇 CRLF 匹配 0 次** ⇒ 脚本"成功"了其实什么都没改（假绿）。
  锚点尽量避免带换行；锚点多行时先 `count === 1` 校验，并给脚本加「只跑单条」的入参便于复查。
- ★★ **拿 `--dir` 产物（`win-unpacked` 里的 exe）当发布件** ⇒ 里面没有 `app-update.yml`，
  用户一点「检查更新」就报 `ENOENT`、面板上挂着「出错」徽标，然后来问「为什么当前版本显示出错」，见 §8。
- ★★ **以为「跑 `win-unpacked` 里的 exe」会显示 `isPackaged === false` / 面板「不可用」** ⇒ 实测相反：
  `isPackaged === true`、按钮能点，只是点了必报 ENOENT。别把这条记错，见 §4。

## 7. ★★ 把「测试版通道」当成**权限问题**（不只是技术问题）

双通道技术上接通之后，紧接着来的**不是技术问题**：**谁能切到测试版？**
真实需求原话往往是「**只有管理员能登陆测试版，其他人在正式版里不能看到任何测试版字样**」。
这一条要是只做在界面上，等于没做。

### 三层，缺一层都不算拦住

1. **渲染层要「藏」，不是「禁用」**：非管理员的设置页里，「更新通道」整行 + 测试版说明段**都不渲染**
   —— 不是 `disabled`、不是置灰，是**连「测试版」这三个字都不出现在 DOM 里**。
   断言直接查字符串：`document.querySelector('#pane').textContent.includes('测试版') === false`。
   （置灰的按钮仍然等于告诉用户"有这么个功能"，不满足"看不到任何字样"。）

2. **主进程闸门**：`update:set-channel` 这类通道要从 `guard()` 提级成 **`guardAdmin()`**。
   ★★ 记住：**界面藏起来 ≠ 拦住** —— 渲染层永远可以被绕过，真正的防线在主进程的 IPC 白名单里。

3. ★★ **落盘的状态必须在登录时复核**（最容易漏的一层）。
   通道是**持久化**的（`config.json` 的 `update.channel`）。剧本：
   管理员切到 beta → 退出 → **普通成员登录** → 他读到的还是 `beta`，
   **会一直收测试包，而那个按钮他根本看不见、没法自救**。
   ⇒ 加一个 `enforceChannelPermission(isAdmin)`，在 **`auth:login` 成功之后** 与 **启动时**
   （勾了「记住我」时启动就已经是登录态）各跑一次；不是管理员就把通道**收回默认值并落盘**，
   同时写一条带账号名的日志（「通道已按权限收回：beta → stable（张三不是管理员）」）。
   回归要**直接读 `config.json`** 核对「真落盘了」，不要只看函数返回值。

### ⚠️ 顺手说清楚：这**不是**安全边界

`config.json` / `auth.json` 就在用户本机 `%APPDATA%` 下，能碰这台机器的人**直接改文件**就行。
这层权限的作用是 **① 防误收到没验收过的包；② 让「我这边是正式版」这句话对得上账**，
**不是**防内部恶意越权。真要隔离得上服务端 —— 没有服务端时，别在文档里写成"已经防住了"。

### ★ 同一类坑：**免登录 / 无账号时，多处口径必须一致**

同一份代码里通常有 2~3 处「判断当前账号有没有权限」的入口
（例如 `brands.allowed(user)` / `resolveFor(user)` / `ipc.scopeOf()`）。
它们对 `user === null`（免登录开发模式）**必须给出同一个答案**，否则会出现
「统计页看得到全部品牌，品牌列表却一个都不显示」这种自相矛盾的界面 ——
用户会说"这功能坏了"，而每一处**单独看都没错**。
⇒ **改其中一处时必须回头 grep 另外几处**；这类界面自相矛盾的现象，先怀疑口径不统一，
不要先怀疑 UI。

## 8. ★★ 「当前版本出错 + 检查更新 ENOENT」= 你跑的是**目录产物**，不是安装包

**症状**（用户原话就是这个）：更新面板「当前版本 1.0.1」旁挂红色徽标「出错」，
点检查更新报 `ENOENT: no such file or directory, open '<某路径>\win-unpacked\resources\app-update.yml'`。

**★ 报错里的绝对路径本身就是证据**：它是运行时用 `process.resourcesPath` 拼出来的
⇒ 出现 `\win-unpacked\` 就说明「跑的就是那个解包目录里的 exe」。

**根因（源码级，别猜）**：`app-builder-lib/out/publish/PublishManager.js` 的 afterPack 处理器：

```js
function isSuitableWindowsTarget(target) {
    if (target.name === "appx" && target.options != null && target.options.electronUpdaterAware) return true;
    return target.name === "nsis" || target.name.startsWith("nsis-");
}
// afterPack 里：Windows 平台下 event.targets 里没有 suitable target ⇒ 直接 return，不写那个文件
```

`--dir` 的 target 名是 `dir` ⇒ 被 `return` 跳过 ⇒ 没有 `app-update.yml` ⇒
`checkForUpdates()` 第一步读它就 ENOENT。**这是 electron-builder 的设计行为，不是包坏了。**

**「当前版本显示出错」的真身**：版本号根本没读错（`app.getVersion()` 正常）。
错的是**状态徽标** —— `UPD_KIND.error = ['bad', '出错']`，徽标上那两个字就是「出错」，
紧挨着版本号排在同一行，很容易被用户读成一句「当前版本显示出错」。

**双向自证（增量极小、可复算）**：
- 原样跑目录产物：`yamlExisted:false` → `check:{ok:false, error:ENOENT}` → `status:'error'`
- **只补一个同内容的 `app-update.yml`、其余一字不动**：`check:{ok:true}`
  → `status:'uptodate'`、`latest:'1.0.1'`、`message:'已经是最新版本'`

**怎么读运行态（探针注入法，比截图/猜快得多）**：
1. 复制 `win-unpacked` 到临时目录（**别动原产物**，保留证据）；
2. 用 `@electron/asar` 的 `extractAll` 把 `resources/app.asar` 解包到 `resources/app/`，
   然后**删掉 `app.asar`**（Electron 优先加载 `resources/app/` 目录）；
3. 往 `src/main/index.js` 注入 `app.whenReady().then(() => setTimeout(async () => { ... }, 7000))`，
   把 `process.resourcesPath` / `app.isPackaged` / `app.getVersion()` / `updater.status()` /
   `await updater.check({ manual: true })` 写成 JSON；
4. `Start-Process` 跑 exe，带 `--user-data-dir=<临时目录>`（**必须隔离，别污染真实账号数据**）
   + `--in-process-gpu --disable-gpu`，并先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（见 §5）；
5. 读 JSON。跑完删临时目录与临时 userData。

**正确做法**：要给人用就打**安装包** ——
`electron-builder --win --x64 --publish never -c.directories.output=<目录>`，**不带 `--dir`**（走 nsis target），
产物里自然会有 `app-update.yml`。
`--dir` 只适合「我只想拿一份 `app.asar` 去替换已装副本」这种中间用途 —— **它不是发布件，别给人双击**。

★ 顺带：改完记得**升版本 + 跑发版脚本**（见 §3）。只重打包不升版本 ⇒ 源上清单不变，
装了新包的人也只会看到「已经是最新」，拿不到新功能。

## 参考实现

- `D:\work\dewu-bluev-publisher\src\main\updater.js`（状态机 + 两条红线 + `enforceChannelPermission`）
- `D:\work\dewu-bluev-publisher\src\main\ipc.js`（`guardAdmin` + `syncChannelPermission()`，登录/启动各调一次）
- `D:\work\dewu-bluev-publisher\tools\upload-release.js`（发版上传 + 五处闸门）
- `D:\work\dewu-bluev-publisher\tools\updatertest.js` / `tools\releasetest.js` / `tools\logintest.js`（回归）
- 发版时的**并发/快照/推送取证**流程：技能 `concurrent-workspace-safe-release`
