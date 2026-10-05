# 得物蓝V 素材发布工具 · 数据清理 + 更新自检修复 · 交付报告

> 日期：2026-10-02 上午（11:05–11:30）
> 起因：「目前 app 内都是测试数据及文件，带了很多个举例品牌名，如斯凯奇、UR，全部删除」
> 本轮定的范围：①清理范围＝**全部清**（app 数据 + `D:/卡宾` + `%TEMP%` 残留，下次启动回出厂）
> ②举例品牌名＝**界面 + 出厂默认值 + 文档 + 测试夹具全改**，且回归仍须全绿
> 提交：`bf2650d`（清空测试数据 + 中性化）→ **`6194456`（本轮：更新自检修复 + 收尾记录）**，均已推送

---

## 一句话结论

数据**已全部清除**、示例品牌名**在安装包内 0 处**、本机回到「零残留」；顺带查清了一件悬案（配置为什么删了又回来）并修掉一个**真缺陷**——「自动更新的启动自检从来没执行过」。
**有一件事你需要知道**：删除前的账号不是出厂状态（admin 的口令是被改过的，还有一个 `testbeta` 账号）⇒ 现在回到出厂 `admin` / `BlueV@2026`。详见 **§6**（含「想保留旧账号」的一条命令）。

---

## 一、清掉了什么（每一批都是「先备份 → 逐条列目标 → 删除 → 逐条复核」）

| # | 目标 | 数量 / 体积 | 结果 |
|---|---|---|---|
| 1 | `%APPDATA%\dewu-bluev-publisher` 配置文件（config / auth / project / pool / .updaterId） | 5 个文件 | ✅ 25 项全成功、复核全清 |
| 2 | `D:\卡宾`（测试工作目录，含素材与输出） | 46 个文件 / 12 MB | ✅ 已删（备份在案） |
| 3 | `%TEMP%\bluev-acc9-*` 等测试临时目录 | 18 个 / 108.8 MB | ✅ 已删 |
| 4 | `~\输出\得物`（默认输出目录：`run-log.jsonl` + 自检批次） | 250.9 KB | ✅ 已删（父目录空了一并删） |
| 5 | `%TEMP%\bluev-*` 全量残留 | **818 个目录 / 2143.1 MB** | ✅ 818/818 成功 |
| 6 | updater 缓存 `%LOCALAPPDATA%\dewu-bluev-publisher-updater` | 离线包缓存 | ✅ 已删 |
| 7 | **整个 `%APPDATA%\dewu-bluev-publisher` 目录**（第 2 轮，见 §3） | 51 个文件 | ✅ 已删 |
| 8 | 收尾：`%TEMP%\bluev-*`（本轮测试又产生的） | 11 个 / 34.12 MB | ✅ 11/11 成功 |
| 9 | 收尾：冒烟测试重新生成的 userData | 43 个文件 | ✅ 已删 |

**备份在哪 / 怎么还原**：全部在 **`D:\_清理备份_20261002-103202\`**，里面有 `还原说明.txt`、`删除前-数据摘要.json`、`userData-完整快照-*`、`卡宾\`、`默认输出目录-得物\`、`updater-cache\`、`旧安装目录-app.asar`。按 `还原说明.txt` 原路拷回即可。

**清完之后本机是什么状态**（实测复核）：

```
应用进程                      无
%APPDATA%\dewu-bluev-publisher  已清（下次启动＝全新出厂：admin / BlueV@2026）
%LOCALAPPDATA%\...-updater      已清
D:\卡宾                        已清
~\素材 、~\输出\得物            已清
%TEMP%\bluev-*                 0 个
```

---

## 二、举例品牌名中性化（界面 / 默认值 / 文档 / 测试夹具）

| 位置 | 改法 |
|---|---|
| `src/renderer/app.js`（7 处 placeholder 与提示） | 变成中性：`如 #品牌话题，#品类词`、`账号名，如 主号`、`品牌名`、`D:\你的素材目录\20260901` |
| `src/main/store.js`（出厂默认值） | 项目名 `蓝V 素材发布`；`copy.brand: ''`、`defaultBrandId: ''`、`requiredTopic: ''`；话题池 6 个**纯品类词** |
| `src/main/services/copywriter.js` | 兜底话题池 6 个中性词；注释里的举例改名 |
| `README.md` / `docs/HANDOFF.md` / `docs/WINDOWS-E2E.md` / `docs/video-ocr-118frames.txt` | 示例名换中性文案（设备表改成「账号甲/乙/丙」并注明原文取自参考后台、与本产品无关） |
| `package.json` | `author` 去掉品牌名 |
| `tools/*.js` 共 8 套测试夹具 | `卡宾`→`品牌甲`、`skechers`→`brandx`、`UR`→`品牌丙`、`TW男装`→`品牌甲` …**一致替换、断言同步，语义不变** |

**★★ 出厂不再预设任何品牌**（这是行为变更，不只是文案）：以前出厂自带 1 个品牌，导致 `logintest` 的「多品牌」用例其实**依赖种子数据**，种子一改就假红（实测红 2 条，已改成测试自己造多品牌场景）。

**长期守卫**（防复发）：`uicheck` 新增两条 —— 界面源码**和真实渲染出来的 placeholder** 都不许出现示例品牌名（placeholder 不属于 `textContent`，只查页面文本必然漏）。`brandtest` 增加「出厂不含任何品牌」并显式测「删空后不会被自动塞回来」。

### 关于仓库里剩下的 5 处命中（要说明白）

全仓扫描后，除了 `tools/uicheck.js` 里的**守卫正则本身**（必须留着，它就是拦这个的），只剩 `docs/HANDOFF.md` 里 5 处 —— 性质是**「记录这次删掉了哪些示例名」的变更记录**，不是拿它们当示例用。
**这两处都不进安装包**：构建 `files` 只含 `src/**` 与 `package.json`，实测新包内 31 个源文件里示例品牌名 **0 处**。
如果你希望连这段变更记录也一并改掉，说一声即可（一行命令的事）。

---

## 三、★ 顺带修掉的真缺陷：更新的「启动自检」从来没跑过

### 怎么发现的

把新 asar 换进已安装目录后做**真实启动冒烟**，在 stderr 里抓到：

```
TypeError [ERR_INVALID_ARG_TYPE]: The "callback" argument must be of type function.
Received type number (20000)
    at Object.scheduleStartupCheck (...\app.asar\src\main\updater.js:435:3)
```

### 是什么问题

```js
// 错的（原样）
timer = timer || setTimeout;
timer(STARTUP_DELAY_MS, () => { check({ manual: false }); });   // ← 参数顺序反了
```

`timer` 默认就是**真的 `setTimeout`**，而真签名是 `setTimeout(fn, ms)`。参数写反后，主进程（Node 环境）直接抛未捕获异常 —— 于是：

> 界面显示「自动更新已启用」，实际上**一次都没自检过**。（假成功，最难发现的那类）

正确写法：`timer(() => { check({ manual: false }); }, STARTUP_DELAY_MS)`。全仓排查：`src/` 下 `setTimeout` **只有这一处**写反。

### 为什么回归没抓住（根因）

`tools/updatertest.js` 注入的定时器桩是 **`setTimer: () => {}`** —— 一个**不校验签名的空函数**，`timer(20000, fn)` 它照单全收。**桩把缺陷吃掉了。**
改成会记录 `(fn, ms)` 的 `spyTimer`，并补两条断言：
1. **签名**必须是 `(fn, 毫秒)` 且延迟 `== STARTUP_DELAY_MS`；
2. **真跑一遍那个回调**，确认它确实去检查更新、且来源标成「启动自检」(`manual === false`)。

### 双向验证（可复算，实测数字）

| 源码状态 | `updatertest` 结果 |
|---|---|
| 修好 | **67 PASS / 0 FAIL** |
| **把参数顺序改回错的** | **65 PASS / 2 FAIL** → 报错行打出 `typeof fn=number · ms=() => { check({ manual: false }); }` 与 `checkForUpdates 被调 0 次` |
| 再还原 | **67 PASS / 0 FAIL**，无 `.updbak` 残留 |

### 端到端证据（安装版前后对比）

同一台机器、同一条命令启动已安装的 app：

| | 启动 stderr |
|---|---|
| 换 asar **前** | 有 `ERR_INVALID_ARG_TYPE ... updater.js:435` |
| 换 asar **后** | **该错误消失**（只剩我 shell 环境变量带来的无害噪声） |

### 全量回归

```
✅ smoke 38   ✅ adbtest 72   ✅ pendingtest 9   ✅ compliancetest 16
✅ batchtest 22 ✅ reporttest 32 ✅ brandtest 80  ✅ uicheck 96
✅ logintest 67 ✅ gatetest 17  ✅ updatertest 67 ✅ releasetest 65
✅ prunetest 45 ✅ logtest 45
全部通过，共 671 项断言（14 套）
```

---

## 四、已安装的那份（桌面快捷方式指向的）已同步

桌面快捷方式启动的是 `D:\bluevbeta\dewu-bluev-publisher\`（2026-10-02 00:23 打的 1.0.1，**它不是一个 git 仓库**）。我没有重装它，而是**只替换了 `resources/app.asar` 一个文件**：

| | md5 |
|---|---|
| 原厂 1.0.1 | `e5e832fd323680a5bab566e285e60f15` |
| 第一次替换后 | `7a78df935ed6e726a7ad80bdb582f6d2` |
| **现在（含本次修复）** | **`7c1ce52bc99879e9a7e1208d8250472e`** |

替换后核验（脚本 `D:\work\_e2e\verify-asar2.js`）：

```
① 示例品牌名扫描：目标文件 31 个 · 实际读到 31 个 · ✅ 0 处命中
② updater.js 定时器参数顺序：正确写法 ✅ / 错误写法 不存在 ✅
③ 出厂默认值：brands 空 ✅ · copy.brand 空 ✅ · requiredTopic 空 ✅ · 话题池 6 中性词 ✅ · 设备空 ✅
④ app.asar.unpacked：80 文件 / 3 个原生库（libvips-42.dll 等）✅
⇒ 全部通过
```

原厂 asar 备份在 `D:\_清理备份_20261002-103202\旧安装目录-app.asar`（第一次换的那份也留了 `.bak`）。
其余文件（`app-update.yml`、`resources/elevate.exe`、`app.asar.unpacked`、`Uninstall*.exe`）原样未动。

---

## 五、查清的悬案：`config.json` 为什么删了又回来

删掉之后它**自己回来了**（mtime 11:02:08，内容与删掉的一模一样），而 `auth.json` 仍不存在 —— 这不可能是「app 正常启动自建」，因为那样会同时写出 `auth.json`。

**真相**：有**一个 00:26 启动、一直没关的旧实例**（4 个 `得物蓝V素材发布工具.exe` 进程），把它内存里的旧配置刷回了磁盘。

**为什么一开始没查到**：`tasklist | grep 得物` 因为**中文进程名编码问题匹配不到** —— 差点据此得出「没有实例在跑」的错误结论。改用 PowerShell 按**路径前缀**过滤才查到。

**处理**：结束这些实例 → **整个 userData 目录重新清理**。
⇒ 新增规矩：**动数据前先确认没有实例在跑，且不能用「中文进程名 grep 不到」当依据。**

（另：那个实例的启动时间 00:26 与你用快捷方式打开的时间吻合，所以**这 4 个进程不是我起的**，是那个一直开着的旧版本。）

---

## 六、⚠️ 需要你手动做一次的事（这条必须看）

**没有任何数据需要恢复，也不需要重装。** 但有一件事你要知道：

我把整个 `%APPDATA%\dewu-bluev-publisher` 目录清空了，而**删除前那份 `auth.json` 里并不是出厂状态**（我核对了备份）：

| 项 | 删除前的事实 |
|---|---|
| 账号 | **2 个**：`admin`（管理员）、`testbeta`（成员，只授权给 `brd_mupe1a91f85b18`） |
| 口令 | `usingDefault = False` ⇒ **admin 的口令是被改过的**，不是出厂口令 |
| 登录 | `remember` 有值 ⇒ 当时勾了「记住我」，是自动登录状态 |

⇒ 所以：**app 下次启动会回到出厂账号 `admin` / `BlueV@2026`**（`mustChange: true`，会提示你改口令），
　 **旧的（改过的）口令不再有效**，第二个账号 `testbeta` 也没了，需要重新建。

**如果你希望保留旧账号**（而不是重新建），一条命令就能还回去：

```bash
copy "D:\_清理备份_20261002-103202\appdata\auth.json" "%APPDATA%\dewu-bluev-publisher\auth.json"
```

（`auth.json` 里口令是 salt+hash 存储的，拷回去就等于恢复原来的账号与口令。其余 `project.json` / `pool.json` / `config.json` 同理，都在同一个 `appdata\` 目录里。）

---

## 七、你之后想自己复核，用这几条命令

```bash
# 1) 全量回归（14 套 671 项；跑时不要设 BLUEV_NO_LOGIN）
cd /d/work/dewu-bluev-publisher && node tools/run-all.js

# 2) 核验安装包里没有示例品牌名 / 定时器已修 / 出厂值正确
node D:/work/_e2e/verify-asar2.js "D:/bluevbeta/dewu-bluev-publisher/resources/app.asar"

# 3) 复算「定时器参数写反会不会红」（双向验证）
python D:/work/_e2e/bilateral-updater-timer.py

# 4) 真启动一次已安装的 app（★ 必须先去掉 ELECTRON_RUN_AS_NODE，见下）
cd "D:/bluevbeta/dewu-bluev-publisher" && env -u ELECTRON_RUN_AS_NODE ./得物蓝V素材发布工具.exe
```

**★ 启动冒烟的一个坑（会让人误判「exe 坏了」）**：本机 shell 里带着 `ELECTRON_RUN_AS_NODE=1`，会漏给子进程，让 Electron exe **退化成纯 Node** —— 表现为**无参数时秒退 0、什么都不落盘**，带参数时报 `得物蓝V素材发布工具.exe: bad option: --in-process-gpu`（注意：这是 **Node 的报错格式**，不是 Chromium 的）。
上一轮把它归因为「这个 exe 自身的毛病」，**归因错了**：锅在环境变量，不在 exe。`tools/run-all.js` 里已经会自动清掉它。

---

## 八、还有两件事等你点头（本次刻意没动）

1. **ffmpeg 要不要内置** —— 需要你先回答「实际是哪种视频」：① 有 `.mov` 等非 mp4；② mp4 但得物不认；③ 超过 10 分钟；④ 文件太大。
2. **「当前版本」旁边加一句解释** —— 你上次没点头，我没自行改界面。

---

## 九、诚实声明（我没做到 / 没验证的）

1. **交接文档 `docs/HANDOFF.md` 里仍有 5 处示例品牌名**（属变更记录性质，且不进安装包）。理由与取舍见 §2，要改说一声。
2. **安装版只换了 `app.asar`，没重装、也没跑安装程序**。它的 `.exe` 还是 00:23 那份（同一个版本号 1.0.1），只有应用代码是新的。
3. **没有验证「自动更新真的能收到新版本」**（那要真的往 COS 传一个包）。本次只证明了「自检会被触发」这件事修好了。
4. `D:\work\_dist2` / `D:\work\_dist3` 两个构建目录我**留着没删**（约 340 MB+，属构建产物，可随时删）。`D:\_清理备份_20261002-103202` 约 390 MB，确认不需要还原后再删。
5. 每次跑回归都会在 `%TEMP%` 留下约 34 MB 的 `bluev-*` 目录（测试基座没有自清理）。**这是既知的小毛病，本次只清了残留、没有改测试基座**。
6. 我修改了 `src/main/updater.js` / `tools/updatertest.js` / `docs/HANDOFF.md` **三个文件**并提交推送（`6194456`）。同一时间**另有并行会话在改这个仓库**，我一行都没碰它的文件。
7. **删除前的状态并不等于出厂**：`auth.json` 里有 2 个账号且 admin 口令已被改过；`config.json` 里还留着 `publish.mock: true`、`update.channel: "beta"`、一段 E2E 占位步骤的 `uiMap`。也就是说这次清掉的确实不只是「示例名」，而是**整套测试期状态**——这正是你要的效果，但代价是**旧账号与旧配置一起没了**（备份里都在，见 §6）。
