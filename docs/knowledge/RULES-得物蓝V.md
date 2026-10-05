# REFERENCE · 得物蓝V 素材发布工具（细节存档）

> 只放「不遵守就出事」那些规则的**理由 / 实测数字 / 命令原文**。
> 自动注入的 `MEMORY.md` 只保留短祈使句 + 指向本文件，因为**注入超限会被静默截断**。
> 最后更新：2026-10-02

---

## A. 清理本机数据（2026-10-02）

### A1. ★★ 动手之前先确认「没有实例在跑」

**踩过的坑**：删掉 `%APPDATA%\dewu-bluev-publisher\config.json` 后它**自己回来了**（mtime 11:02:08，内容与删掉的一模一样，品牌 id 都一样），
而 `auth.json` 仍不存在 —— 这排除了「app 正常启动自建」（那样会同时写 `auth.json`）。
真相：**有一个 00:26 启动、一直没关的旧实例**，把内存里的旧配置刷回了磁盘。

**为什么一开始没查到**：`tasklist | grep 得物` **匹配不到**（中文进程名在这个 shell 里编码不一致）。
差一点就据此得出「没有实例在跑」的错误结论。

**正确查法**（用 PowerShell 工具，别在 bash 里调 powershell，会被安全策略拦）：

```powershell
Get-Process | Where-Object { $_.Path -like 'D:\bluevbeta\*' } |
  Select-Object Id, ProcessName, Path, StartTime
```

实测查到 4 个 `得物蓝V素材发布工具.exe` + 1 个它自带的 `adb.exe`。
⇒ **规矩：动数据前先查实例；「grep 不到」不能当作「没在跑」的证据。**

（另注：`adb` 是**共享服务**，与 MuMu 模拟器共用，**清理时不要杀它**。）

### A2. 清理范围与结果（实测）

| 目标 | 数量 / 体积 |
|---|---|
| `%APPDATA%\dewu-bluev-publisher`（config/auth/project/pool/.updaterId） | 5 个文件 |
| `D:\卡宾`（测试工作目录） | 46 个文件 / 12 MB |
| `%TEMP%\bluev-acc9-*` 等 | 18 个 / 108.8 MB |
| `~\输出\得物`（默认输出目录） | 250.9 KB |
| `%TEMP%\bluev-*` 全量 | **818 个目录 / 2143.1 MB** |
| `%LOCALAPPDATA%\dewu-bluev-publisher-updater` | 离线包缓存 |
| 整个 userData 目录（第 2 轮） | 51 个文件 |
| 收尾 `%TEMP%\bluev-*` + 冒烟后 userData | 11 个 / 34.12 MB + 43 个文件 |

**备份根目录**：`D:\_清理备份_20261002-103202\`
内含：`还原说明.txt`、`删除前-数据摘要.json`、`userdata-完整快照-*`、`appdata\`（原始 5 个配置文件）、
`卡宾\`、`默认输出目录-得物\`、`updater-cache\`、`旧安装目录-app.asar`、`installed-asar-第1次换过的那份-*.bak`。

### A3. ★ 删除前的状态并不等于出厂（重要，别以为「清了脏数据而已」）

`appdata\auth.json`（1199 B）里：**2 个账号** —— `admin`（管理员）、`testbeta`（成员，只授权 `brd_mupe1a91f85b18`）；
`usingDefault = False` ⇒ **admin 的口令是被改过的**，不是出厂口令；`remember` 有值 ⇒ 当时是自动登录。
`config.json` 里还有 `publish.mock: true`、`update.channel: "beta"`、一段 E2E 占位步骤的 `uiMap`。
⇒ 清理后回到出厂 `admin / BlueV@2026`，**旧口令作废**；要还原就拷 `appdata\auth.json` 回 userData。

### A4. ★ 每次跑回归都会在 `%TEMP%` 留约 34 MB

`bluev-smoke-* / bluev-uicheck-* / bluev-login-* / …` 这些目录**测试基座没有自清理**（既知小毛病，尚未修）。
只清残留、没改测试基座。

---

## B. ★★ `ELECTRON_RUN_AS_NODE` —— 会把 Electron exe 退化成纯 Node

**现象（会让人误判「exe 坏了」）**：
- **无参数启动 ⇒ 秒退、exit code 0，什么都不落盘**（连 Chromium 的 `Cache`/`Preferences` 都不建）。
- 带参数 ⇒ `得物蓝V素材发布工具.exe: bad option: --in-process-gpu`。
  ★ 注意 **`bad option: --xxx` 是 Node.js 的报错格式**，不是 Chromium 的 —— 看到它就该想到「它被当 Node 跑了」。

**原因**：本机 shell 里带着 `ELECTRON_RUN_AS_NODE=1`，会**漏给子进程**。无参数时纯 Node 读 stdin 直接退出 0。

**正确做法**：`env -u ELECTRON_RUN_AS_NODE ./得物蓝V素材发布工具.exe`
（`tools/run-all.js` 里已经会自动清 `CHILD_ENV`；本机还带 `NODE_OPTIONS`，一并 `-u` 掉更干净。）

**去掉之后**：进程持续运行（`timeout` 报 124 = 一直在跑）、`auth.json` 被主进程写出、Chromium 缓存目录正常生成。
⇒ 这才是「启动冒烟通过」的判据。

**上一轮的归因错误**：曾用「对照实验证明是该 exe 自身的毛病」解释同样的报错 —— **锅在环境变量，不在 exe**。

---

## C. ★★ 校验 `app.asar` 的两个坑

### C1. `listPackage` 的路径格式

`@electron/asar` 的 `listPackage()` 返回的是**带前导反斜杠**的路径（`\src\main\updater.js`），
而且**同时包含目录条目**（`\src\renderer`）。
`extractFile()` 要的是**去掉前导斜杠**的串（`src\main\updater.js`）。

**坑**：我第一版脚本把路径归一化成 `src/main/updater.js` 再喂给 `extractFile` ⇒ **全部抛异常、被 `catch` 跳过**，
于是打出「示例品牌名 **0 处**」的**假通过**（空 == 空）。
⇒ **规矩：必须统计「真读到几个文件」，`read === 0` 时这条断言一律判失败。**

### C2. 换已安装副本的 asar

- 已装副本：`D:\bluevbeta\dewu-bluev-publisher\`（**不是 git 仓库**；快捷方式指向它）。
  ★ `elevate.exe` 在 **`resources\`** 下，不在顶层。
- 只换 `resources\app.asar` 一个文件即可（`app-update.yml` / `elevate.exe` / `app.asar.unpacked` / `Uninstall*.exe` 都别动）。
- ★ **别在仓库根目录用 `asar extract-file`** —— 它会把文件解到当前工作目录，**曾把仓库的 `package.json` 覆盖掉**。
- md5 轨迹：原厂 1.0.1 `e5e832fd…` → 第 1 次换 `7a78df93…` → 现含修复 `7c1ce52b…`。
- 打包命令（只出 `win-unpacked`，别打回 `dist/`）：
  ```
  node node_modules/electron-builder/cli.js --win --x64 --dir --publish never -c.directories.output=D:/work/_dist3
  ```
- 校验脚本：`node D:\work\_e2e\verify-asar2.js "<app.asar 路径>"`（扫示例品牌名 / 定时器签名 / 出厂默认值 / unpacked 原生库）。

---

## D. ★★ 「更新的启动自检从来没跑过」—— 空桩吃掉缺陷

**缺陷**（`src/main/updater.js`）：`timer(STARTUP_DELAY_MS, fn)` —— 与真 `setTimeout(fn, ms)` **参数顺序相反**。
`timer` 默认就是真 `setTimeout` ⇒ 主进程抛 `ERR_INVALID_ARG_TYPE: Received type number (20000)` 的**未捕获拒绝**
⇒ 界面显示「自动更新已启用」，**实际一次都没自检过**。

**为什么回归漏了**：`tools/updatertest.js` 注入的桩是 **`setTimer: () => {}`**（不校验签名的空函数），
`timer(20000, fn)` 它照单全收 ⇒ **桩把缺陷销毁了**。
⇒ **规矩：定时器/回调类依赖的测试桩必须「记录签名」而不是「接受任何参数」**，并断言参数类型与延迟值。

**修法与断言**：改成 `spyTimer`，补两条 —— ① 签名是 `(fn, 毫秒)` 且延迟 `== STARTUP_DELAY_MS`；
② **真跑一遍那个回调**，确认它确实去检查更新且 `manual === false`。

**双向验证实测**：改回错的 ⇒ `updatertest` **65 PASS / 2 FAIL**（报错行打出 `typeof fn=number` 与 `checkForUpdates 被调 0 次`）；
还原 ⇒ **67 PASS / 0 FAIL**；全仓 `setTimeout` 只有这一处写反。
**端到端**：换 asar 前启动 stderr 有这条 `ERR_INVALID_ARG_TYPE`，换后**消失**。

---

## E. 出厂状态（本轮变更）

- ★★ **出厂不预设任何品牌**：`brands: []`、`brandsSeeded: false`、`copy.brand: ''`、`copy.defaultBrandId: ''`。
  旧版升级靠 `copy.brand` 作**一次性迁移种子**；删空后**不会被塞回来**（靠 `brandsSeeded` 标记，不是「数组空就补」）。
- 出厂 `copy.requiredTopic: ''`；话题池 6 个**纯品类词**（`#男生穿搭 #OOTD #秋冬新款 #质感生活 #日常搭配 #好物分享`）。
  ★ 必须 6 个：算法要 `池子 = 额外话题(4) + 2` 才凑得出 5 种互不相同的组合。
- 界面/默认值/文档里**不许出现示例品牌名**；`uicheck` 有长期守卫（**连真实渲染出的 placeholder 都查** ——
  placeholder 不属于 `textContent`，只查页面文本必然漏）。`brandtest` 有「出厂不含任何品牌」。
- ★ 这些名字**只允许**出现在 `tools/uicheck.js` 的守卫正则和 `docs/HANDOFF.md` 的变更记录里；
  **`docs/` 与 `tools/` 都不进安装包**（`files` 只含 `src/**` + `package.json`）。
- 「多品牌」场景**必须由测试自己造**（原来靠出厂那 1 个品牌凑数 ⇒ 断言依赖种子数据，种子一改就假红）。

---

## F. 并发会话（本仓库）

- 本轮期间**另一条会话**在改同一仓库（运行日志页），工作区一度只剩我的 3 个文件是 `M`。
- 提交要**只列自己的文件**、用临时索引隔离：
  ```
  IDX="D:/work/_e2e/.tmp-git-index-$$"      # ★ 必须 Windows 路径；mktemp 给的 /tmp/... git 写不了
  GIT_INDEX_FILE="$IDX" git read-tree HEAD
  GIT_INDEX_FILE="$IDX" git add <只列我的文件>
  GIT_INDEX_FILE="$IDX" git commit -F <消息文件>
  git reset -q --mixed HEAD                 # 刷新真实索引，别省
  git diff --name-only HEAD -- <我的文件>    # 应为空
  ```
- **「已推送」必须有远端证据**：`git ls-remote origin refs/heads/main` = 本地 `git rev-parse HEAD`。
  远端是 **Gitee**（`git@gitee.com:abulaitifans/dewu-bluev-publisher.git`）。
- `git checkout -- <file>` 只有在 `git status` 确认该文件**无他人改动**时才可用（本轮 HANDOFF 就是这么回滚的）。

---

## G. MEMORY.md 完整版存档（2026-10-02 搬迁，逐字保留）

> 起因：MEMORY.md 被自动注入且有 **3000 字符/session** 上限，超限会**静默截断**。
> 这一节是搬迁前的全文；MEMORY.md 只剩短祈使句 + 指向本文件。

```text
# 工作区长期记忆（只留祈使句；细节看 `REFERENCE-得物蓝V.md` 与当日日志）

## 主项目：得物蓝V 素材发布工具
- 仓库 **`D:\work\dewu-bluev-publisher`**（**不要改名/移动**）；台账=本地 `jsonl`。
- ★ **`app.js`/`store.js` 只局部替换，禁整文件重写**；**不许造假成功**（失败说清缺什么）。
- ★ **换 logo 必重跑 `tools/make-icon.js`**，否则 `uicheck` 红。
- ★★ **内置二进制放 `vendor/`（故意进 git）**：走 `extraResources`，**绝不进 asar**；md5 与 `vendor/README.md` 互校。
- ★ **adb 三段解析**：手填（存在就用）> 内置 > 系统 PATH。
- ★★ **从不转码视频**（无 ffmpeg）：非 `.mp4` 只标 `manual`，`fix()` 只碰 `todo`/`isolate`。
- ★★ 出厂**不预设任何品牌**（`brands: []`、`copy.brand: ''`）；示例品牌名禁进界面/默认值/文档（`uicheck` 连 placeholder 都查）。

## 中文输入（ADBKeyboard）
- ★★ **中文只有 `ADB_INPUT_TEXT` 广播一条**：`input text` 打不进中文却 **exit 0** ⇒ 判据只看「是不是设备**当前输入法**」。内置 apk ≠ 已装：`installKeyboard()` 三步跑一次。

## 货号颜色校验 / 发布阻断
- ★★ **拦不拦只看 `verify.isBlocked(row)`**：「货号查不到」= 没数据 ≠ 有错 ⇒ **只告警、照常发布**。
- ★ `publisher.run`/`sheet.buildRows` 共用它；旧数据无 `block` 按 `conclusion` 回推。

## 话题 / 日志导出
- ★★ **必带话题是多值**（空格/中英文逗号/顿号/分号/竖线分隔，自动补 `#`）；发布单**只有话题1~话题5** ⇒ 超限**告警少给**，绝不静默丢。
- ★★ 品牌统计源=**本机输出目录**两个 jsonl（**无跨机拉取**）；日志**写失败不报错** ⇒ 用「检测输出目录」防静默少数据；导出走 `allLogs`（别退回 100 条）。

## 自动更新 + 发版
- ★★ 红线：①**绝不自动重启**；②**不在运行时改源地址**；`autoDownload`/`autoInstallOnAppQuit` 恒 `false`。
- ★★ **generic provider 不代传**：漏跑 `upload-release.js` ⇒ 应用永远说「已是最新」。
- ★★ **测试版通道=管理员专属**：真防线=`update:set-channel` 的 `guardAdmin`；通道落盘 ⇒ 登录+启动必须 `syncChannelPermission()` 收回。
- ★★ 「当前版本」包内写死 ⇒ **别当 bug 修**。
- ★ **打包别打回 `dist/`**（旧目录删不掉 ⇒ 中断）：用 `-c.directories.output=<新目录>` 再搬回。
- ★★ **更新日志默认关，开着才接管 `up.logger`**（关着必须 `null`）—— 「差分退回全量」只有它能报；下载那行的 `total` 字节 = 差分是否生效的**唯一硬证据**。
- ★★ **`prune-release.js` 默认 dry-run**（`--apply` 才删）；**三条 fail-closed**（读不到 `latest.yml`／比当前新／认不出名字）⇒ 全留；凭据在 `.env`，**密钥不进记忆**。
- ★★ 命令行解析**必须同时认 `--x v` 与 `--x=v`**：只认前者会**静默退回默认值**（`--channel=beta` 曾发成 stable）。
- ★★ **回调/定时器的测试桩别用 `() => {}`**：空桩会吃掉「参数写反」的缺陷（曾致「启动自检从没跑过」）；桩要**记签名**、断言类型与延迟。

## 品牌权限 / 按品牌统计
- `brands:[{id,name,enabled}]` + `user.brands:[id]`（**记 id ⇒ 改名不丢授权**）。
- ★★ 「未标品牌」「已删除的品牌」**各自成桶**、绝不并进也绝不丢；★ 本机权限只当「防误操作+对账」。
- ★★ **免登录三处口径须统一**：`brands.allowed(null)`/`resolveFor`/`ipc.scopeOf()` 都按**不设限**。
- ★★ 提示词按品牌存：system **品牌模板在前、程序约束在后**；**没配就在实例化前拦下**。
- ★ 「选择」只改本次**不落盘**、「默认选择」才写 `copy.defaultBrandId`；设置项 `data-cfg` **每页都绑**。

## 跑回归
- `node tools/run-all.js` → **十七套**（2026-10-04 实测 **1310 项**）；**断言数每次实测重取，别抄**。
- ★ **不要设 `BLUEV_NO_LOGIN`**（`logintest` 断言它没设；设了 3 FAIL 且挂 7~12 分钟）。
- ★ 动窗口几何必先过 `window.js#fitToWorkArea()`；登录页**别在卡片外挂浮层**，`.gate` 里控件**必须 `no-drag`**。

## 改完要自证（定点破坏）
- ★★ **成本模型：一轮 = (N+2) 次整套运行**（基线 + N 条破坏 + 还原复跑）⇒ 先估时间再动手。
  实测单次（2026-10-04 工作树）：`adbtest` **34.2 s** / 268 断言、`uicheck`（Electron）**20.9 s** / 194、`copytest` **2.6 s** / 201。
  ⇒ 25 条 ≈ 27 次 ≈ **15 分钟起**；只跑「能抓住这条缺陷的那一套」，别跑全量。
- ★★ **「撤 UI 入口」≠「删功能」**（2026-10-04）：设置页「路径」块（输出目录 / 隔离目录）已对所有人隐藏，
  但 `store.get('paths.output'|'paths.rejected')` 的读取链（ipc / jobs / compliance / sheet / stats / runlog）
  与 store 出厂默认值**必须留着** —— 删了导出报告与日志会报「没有配置输出目录」。
  uicheck 用**四条**一起钉：页面看不见（管理员 + 普通成员**各一条**）+ 副标题不提案块名 + 读取链仍在（源码级）。
- ★★ **破坏脚本造的坏版必须先过语法自检**（`node --check`）：坏版语法崩了 ⇒ 一堆无关断言红、
  PASS 骤降，看起来像「断言没抓住」（2026-10-04 实测：PASS 199→13）。
- ★★ **每条破坏从干净源码开始**；先校验**锚点唯一**；`try/finally` 兜还原；跑完扫残留备份。
- ★★ **跨行锚点遇 CRLF 匹配 0 次** ⇒ 锚点别带换行。
- ★★ **一处缺陷常有多条防线**：只拆一条仍全绿 ⇒ 先怀疑还有另一条。
- ★★ **跑 electron 套件 / 已打包 exe 前必删 `ELECTRON_RUN_AS_NODE`**（否则退化成纯 Node：套件**静默假绿**、**exe 秒退 0 且什么都不落盘**、报 `bad option`＝**Node 的报错格式**），并带 `--in-process-gpu --disable-gpu`。
- ★★ **校验 asar 别用归一化路径**（`listPackage` 带前导反斜杠 + 含目录）⇒ 必须统计「**真读到几个**」，否则**空==空假通过**。

## 清理 / 已装副本
- ★★ 动数据前**先确认没有实例在跑**：中文进程名在 bash `tasklist|grep` **匹配不到** ⇒ 用 PowerShell 按**路径前缀**过滤（曾因此误判，配置被旧实例回写）。备份根 `D:\_清理备份_20261002-103202\`。
- ★ 已装副本 `D:\bluevbeta\dewu-bluev-publisher`（**非 git**）：改完代码要重打包、**只换 `resources/app.asar`**（`elevate.exe` 在 `resources\` 下）。

## 真机（MuMu 12）
- adb 在 `/d/MUMU/MuMuPlayer/nx_main/`；端口每次变；设备 **900×1600**；**只有重启模拟器**能让新素材进相册。
- ★★ 内置 adb(37.0.1) 与 MuMu(36.0.0) 同用**不重启 adb 服务**。
- ★★ dump 抓不到**先看 `mCurrentFocus`**；抓失败**不写文件** ⇒ 复用前先 `rm -f`。

## 并发会话（同机可能另一条会话在同一 worktree）
- ★★ **先判「谁在改什么」**：看项目 jsonl 哪个在长 + 采样 mtime；**别把别人的改动当自己的成果**。
- ★★ 共用文件按 hunk 只暂存自己的；`git checkout -- <file>` **仅当 `git status` 确认该文件无他人改动**时才可。
- ★★ 共用 worktree ⇒ **`push` 隔离不了，只有 `commit` 给快照**；**「已推送」必须有远端证据**（`git ls-remote origin`）；临时索引必须用 **Windows 路径**。
- ★ 记忆**锚点追加**；改文档先看 mtime。
```


---

## H. 非 mp4 视频自动转 mp4（内置 ffmpeg，2026-10-02）

### H1. 为什么推翻旧结论
以前记的是「本程序从不转码视频（无 ffmpeg），非 `.mp4` 只标 `manual`」——
前提是**只收 mp4**。用户明确说会传 `.mov` / `.m4v`，前提变了，结论必须重算。
得物**只收 mp4**，所以非 mp4 必须转。

### H2. vendor/ffmpeg（故意进 git，与 adb 同一套约定）
- `ffmpeg.exe` **82,797,568 B**，md5 `25243548be231a3c928cb7a0b6225ae9`
- 版本 `ffmpeg version 6.1.1-essentials_build-www.gyan.dev`（构建方 gyan.dev，
  `--enable-gpl --enable-version3 --enable-static`）⇒ **GPL-3.0**，`LICENSE.txt`（35,147 B）随包
- 来源 = `ffmpeg-static` 的 release 资产 `b6.1.1/ffmpeg-win32-x64`
- ★ **上游 `github.com` 在本机连不上**（`curl` 直接 timeout；但 `objects.githubusercontent.com`、
  `raw.githubusercontent.com`、`api.github.com` 都通）⇒ 实际走国内镜像
  `https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz`（28.2 MB，字节数与 GitHub 一致）
- ★ **GPL 的分发边界**：只在自己公司内部装机使用没问题；**对外分发**（给客户/外部方）有传染风险，
  要么换 LGPL 共享构建（BtbN `ffmpeg-*-lgpl-shared`），要么按 GPL 走完整合规。做法写在 `vendor/README.md` §3。
- 体积账：安装包 87.96 MB → 约 116 MB（adb + 输入法 9.6 MB + ffmpeg 79 MB）

### H3. 转换策略（`src/main/services/video.js`）
- 三段解析 `resolveFfmpegChoice({configured, bundled, exists})`（纯函数，与 adb 同款）：
  `configured` / `bundled` / `path` / `configured-missing`；`status().usable` 在 `configured-missing` 时为 false
- ① 无损转封装 `-c copy -f mp4`（H.264/HEVC）：秒级、画质零损失
- ② 转码兜底 `-c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac`（ProRes 等 mp4 放不下的）
- `verifyMp4()` **解析产物**：`ftyp` 品牌 ∈ mp4 家族（**`qt` 故意不在里面**）＋ `moov` 可读
  ＋ 视频轨编码 ∈ `{avc1,avc3,hvc1,hev1,hvc2,mp4v}`
- 任何失败**先 `rmQuiet(dst)` 再抛错**；`cancelled` 每 500ms 轮询 + **入口检查**（已取消就不启动、不落文件）
  + 转换完成后**再查一次**（抢在轮询前跑完的也不交产物）

### H4. compliance.js 的两处口径
- 非 mp4 → `status:'todo'` / `action:'转 MP4'`；`video.status().usable === false` 才维持 `manual`
- **先判时长再决定转不转**（超 `maxVideoSec` 的转成 mp4 也过不了，不白转一次）
- `notMp4` 按**扩展名**数（`wp.ext(r.file) !== '.mp4'`）；`videoLong` 只数**真的超时长**的
  —— 加了「没找到 ffmpeg」这条新 manual 路径后，原来的「视频+manual」会算错

### H5. ★★ 顺手修掉的真隐患（会被这次改动引爆）
`compliance.js#syncItem()` 里 `type` **写死成 `'image'`**。图片分支无所谓，但视频转 mp4 若复用，
会把**视频静默改成图片** → 发布时按图文走步骤、拿图去发视频。
改成 `const kind = type || (row.type === '视频' ? 'video' : 'image');`。
（`flatten.js` 造 items 时本来就按 `wp.isVideo(f)` 给了 `type: 'video'`，两边现在自洽。）

### H6. 转换发生在哪（别搞错，会误以为动了原素材）
`absDir` = `path.dirname(sourceDir)/flat_<stamp>/<条目名>`（`flatten.js` 造的**扁平副本目录**，同卷硬链接）。
⇒ 转 mp4 是「在副本里写新文件 + 删旧链接 + 改名」，**原素材目录完全不动**（与图片合规处理同一套规矩）。

### H7. 实测（可复算）
- `tools/videotest.js` **31 项**全 PASS：样本全部用内置 ffmpeg **现造**（testsrc + 正弦音），每件都真读产物
  · `mp4→mp4` remux；`.mov`(H.264) 源 `ftyp=qt` → remux 后 `brand=isom`；`.mov`(ProRes) → **transcode** `avc1`；
  · 坏文件/只有音频/已取消 → 都如实抛错且**不留半成品**；对未转的 `.mov` 校验**判不通过**（鉴别力自证）
- `compliancetest` 16 → **26**（+⑤ 集成段：非 mp4→todo、fix 真转出 mp4、`type` 仍是 `video`、同名 mp4 不覆盖）
- `uicheck` 96 → **99**（内置文件 md5 互校含 ffmpeg / GPL 许可全文随包 / `extraResources` 含 `vendor/ffmpeg` /
  设置页如实显示 + 给了路径入口 / 内置那份**真能跑**）
- 全量回归 **715 项 / 15 套 / EXIT=0**（`38+72+9+26+31+22+32+80+99+67+17+67+65+45+45`）
- 双向验证：`type` 写死回 `'image'` ⇒ 26→**25 PASS/1 FAIL**；非 mp4 退回旧口径 ⇒ 26→**20 PASS/5 FAIL**；
  拆掉入口取消检查 ⇒ 31→**29 PASS/2 FAIL**；三次都逐字节还原（md5 一致）
- 打包：`-c.directories.output=D:/work/_dist4`；★ 已装副本**原本没有 `resources/ffmpeg/`** ⇒
  除了换 `app.asar` 还必须**把 `resources/ffmpeg/` 整个补上**。实测两处 `ffmpeg.exe` md5 与 `vendor/` 源一致、都真的转换成功。
  旧 asar 备份在 `D:\_清理备份_20261002-103202\旧安装目录-app.asar.20261002-122929`

### H8. ★ 造锚点踩到的两个新坑（已进 MEMORY.md）
1. **纯子串锚点不唯一**：`  if (` 是 `    if (` 的**子串** ⇒ 3 处命中。⇒ 用**行首锚定** `^` + 精确缩进。
2. **正则里别用 `$` 收尾**：文件是 CRLF，`$`（在 `\n` 前匹配）与 `;` 之间还夹着 `\r` ⇒ **0 次命中**。

### H9. 没验到的（诚实清单）
- 本机**没有真实 iPhone 的 `.mov` 样本**（只有 `.mp4`）⇒ `.mov` 那条路只用**合成的 `qt` 品牌 MOV** 验了代码路径
- `.avi` / `.webm` / `.mkv` 只确认了内置 ffmpeg **支持这些容器**，没造样本跑全链路
- 长视频转码慢（转码超时上限 30 分钟），没做分段进度
- 取帧 / 裁图 / 传封面**依然不做**（封面继续用「得物推荐的」）；这次只加了「转格式」

---

## I. ★★ 「当前版本出错 + 检查更新 ENOENT」—— 目录产物 vs 安装包（2026-10-02）

**现象**：双击 `D:\work\_dist3\win-unpacked\得物蓝V素材发布工具.exe` 后，
更新面板「当前版本 1.0.1」旁挂红色徽标「出错」，点检查更新报
`ENOENT: no such file or directory, open 'D:\work\_dist3\win-unpacked\resources\app-update.yml'`。

**根因（源码级）**：`app-builder-lib/out/publish/PublishManager.js` 的 afterPack 处理器里
`isSuitableWindowsTarget(target)` **只认 `nsis` / `nsis-*` / 开了 `electronUpdaterAware` 的 `appx`**
⇒ 其它 target（尤其 `--dir` 打的 `dir`）直接 `return`，**不写** `resources/app-update.yml`。
electron-updater 的 `checkForUpdates()` 第一步就读这个文件 ⇒ 必然 ENOENT。

**报错路径本身就是证据**：它是运行时 `process.resourcesPath` 拼出来的
⇒ 报错里出现 `_dist3\win-unpacked` 就说明「跑的就是那个目录里的 exe」。

**判据**：exe 所在目录有没有 `Uninstall 得物蓝V素材发布工具.exe`。
有 = 安装版（正常）；只有光秃秃的 `win-unpacked` = 绿色目录（必报这个错）。
`_dist2` / `_dist3` / `_dist4` 是「只换 app.asar」用的中间件，**不是发布件**。

**双向实测（探针注入 exe 内部读真实状态）**：
- `_dist3` 产物原样跑：`yamlExisted:false` → `check:{ok:false,error:ENOENT}` → `updAfter.status='error'`
- **只补一个 `app-update.yml`**（其余一字不动）：`yamlExisted:true` → `check:{ok:true}`
  → `updAfter = {status:'uptodate', latest:'1.0.1', message:'已经是最新版本'}`

**「当前版本显示出错」的真身**：不是版本号读错（实测 `current='1.0.1'` 正常）。
是 `src/renderer/app.js` 的 `UPD_KIND.error = ['bad','出错']` —— 红色徽标上就写着「出错」二字，
紧挨版本号，容易被读成一句话。

**正确做法**：要给人用就 `electron-builder --win --x64 --publish never -c.directories.output=<目录>`
（**不带 `--dir`**，走 nsis target）。实测 `D:\work\_dist5`（22 秒）产物含
`app-update.yml` + `resources/ffmpeg`，安装包 113,978,433 B。

**★ 发版提醒**：只重打包、不升 `version` 也不跑 `upload-release.js` ⇒ COS 上的 `latest.yml` 不变，
装了只会说「已经是最新版本」，拿不到新功能。要推新版必须：升版本号 → 重打包 → `npm run release:stable`。

**探针方法（可复用）**：复制 `win-unpacked` → 用 `@electron/asar` 的 `extractAll` 解包
`app.asar` 到 `resources/app/` 并**删掉 `app.asar`** → 往 `src/main/index.js` 注入
`app.whenReady().then(() => setTimeout(...,7000))` 把状态写 JSON →
`Start-Process` 跑 exe（`--user-data-dir=<临时目录>` 隔离、`--in-process-gpu --disable-gpu`，
并先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`）→ 读 JSON。
（探针只改临时副本，仓库 `git status` 保持干净。）

## J. 界面瘦身：真删三项 + 其余收进「高级设置」（2026-10-02 下午）

**起因**：用户被自检引导「在下面的设备列表里点它的『选用』」指到一个**空列表**上
（他的 `publish.devices` 是 0 台），并质疑日常页面上摆了一堆「实际不会点」的入口。

### J1 最终布局
- 日常页只留每天点的：素材整理 / 合规检查 / 文案生成 / 货号颜色校验 / 发布单 / 模拟器发布 /
  运行日志 / 设置 / 品牌统计 / 品牌与权限。
- 新增**第 11 个页签「高级设置」**：`index.html` 里 `data-admin="1"`，
  `app.js#syncAdminNav()` 按 `canAdmin()` 决定 `el.hidden`，非管理员若停在 11 会被拉回 1。
  页内 **UI 定位表**（常开，`pub:dump` / `pub:map` + 已配步数）、**失败恢复动作**（常开，
  `recoverHtml()` + `pub:recoverEdit`）、以及**文案模型 / 货号颜色查询方式 / 外部依赖路径**
  三块 `<details>`（`advBox()` 生成，**默认收起**）。
- 发布页对「定位表未配」保留 `go:advanced` 直达按钮；设置页「货号颜色」只留只读回显 + 同一个按钮。
- ★★ 页签「仅管理员」必须**两处同标**：`index.html` 的 `data-admin="1"`（按钮 `hidden`）＋ `app.js` 的 `TABS[n].admin`（`syncAdminNav()` 里 `if (!ok && TABS[state.tab].admin) state.tab = 1` 把当前页兜回首页）。
  **少 `TABS[n].admin` 那条**：按钮虽然还是隐藏的，但按 `Ctrl+n`、或老配置里存过 `tab=n` 时，仍会停在那个页签上（不崩、也不兜回 ⇒ 页签白藏）。

### J2 「真删」必须连读取链一起删
删掉「演示节奏（mock）」勾选框时如果**只删控件**：出厂 `mock:true` 仍生效，而 `cfg.mock` 是
**真实发布**的节奏开关（`publisher.run` 里 `c.mock ? 5 秒 : 真实间隔`）⇒ 真实发布会用 5 秒间隔。
所以一并删掉：`store.js` 的默认值、`jobs.js` 的 `sheet.export` 间隔、`publisher.estimate/runMock/run`、
`app.js` 的「预计」口径。**保留** `mode === 'mock'`（那是「设备不就绪时的模拟通道」，另一回事）。
原先靠它提速的测试（smoke / reporttest / batchtest / pendingtest / adbtest）改成直接给 `intervalSec:1`。

### J3 用户踩到的真 bug（设备列表）
- 老实现 `publisher.listDevices()` 只遍历**配置里已添加**的设备 ⇒ 配置空则永远空表。
- 新实现：`publisher.scanDevices()`（`adb.devices()` 全量 + `configured` 标记）；
  任务 `publish.devices` 同时回 `devices`（已添加，逐台 probe 详情）与 `found`（全量）；
  界面「**扫描设备**」`pub:devScan` 渲染 `found` 里未添加的那些，一键 `pub:useFound`
  （= `addDevice` + 写 `publish.device` + `publish.connect`）；手动填序列号收进 `<details>`。
- `adb.js` 三处引导文案同步改写；`uicheck` 断言「引导里承诺的按钮名在界面上真的存在」。

### J4 被新断言逼出来的三处真缺陷
1. **`.nav{display:flex}` 盖掉 UA 的 `[hidden]{display:none}`** ⇒ `el.hidden = true` 只设了属性，
   按钮照样显示（点一下被 `syncAdminNav` 弹回，看着像坏了）。修：`styles.css` 加 `.nav[hidden]{display:none}`。
   ★ 判据要**同时**看 `el.hidden === true` **和** `getComputedStyle(el).display === 'none'`。
2. **`app:info` 从来没回传过 `ffmpeg`** ⇒ 设置页「外部依赖」表里那行永远「状态取不到 / 未知」，
   界面在骗人（上一轮的 `uicheck` 只断言了行标题，漏掉了）。修：`app:info` 加 `ffmpeg: video.status()`。
3. **手填的 ffmpeg 路径不存在时静默退回内置、界面不说**（adb 那边会 `say('warn', ...)`）。
   修：`ffDesc/ffBadge` 加 `configuredMissing` 分支；并在 `saveCfgFromDom` 里对
   `publish.adbPath` / `publish.ffmpegPath` 改完**重取 `app:info`**（`state.tab===7||11` 时重画），
   否则表里还是旧状态、用户会以为没生效。
   ★ `video.status()` 的契约：`source` 是**生效来源**（退回内置后是 `'bundled'`），
   `configuredMissing` 才表示「你填的那个不存在」；只有**没有**内置可用时 `source` 才是 `'configured-missing'`。

### J5 回归与自证（实测数字）
- 全量 `node tools/run-all.js`：**732 项 / 15 套全绿**（`38+72+9+26+31+22+32+80+113+70+17+67+65+45+45`）。
- `uicheck` 99 → **113**、`logintest` 67 → **70**（含真负向：普通成员看不到按钮、硬点被弹回）。
- **7 条定点破坏**双向验证（每条按预期报红，之后逐字节还原、md5 一致）：
  B1 配置里加回 `mock:true`（uicheck 红）；B2 去掉 `data-admin="1"`（logintest 红）；
  B3 去掉 `.nav[hidden]{display:none}`（logintest 红）；B4 `app:info` 不回传 ffmpeg（uicheck 红）；
  B5a `config:set` 里不调 `setFfmpegPath`（uicheck 红）；B5b 删掉 `require('./services/video')`
  ⇒ uicheck **大面积报红**（`app:info` 也用它，启动即挂）；B6 把「检测在线」老引导放回去（uicheck 红）。
- ★ mock 那条断言的判据要**先剥注释与 `'mock'` 字面量**再搜 `mock` —— 否则会把模拟通道的
  `mode === 'mock'` 误报成「没删干净」。

### J6 产物
- `D:/work/_dist6/得物蓝V素材发布工具-1.0.1-x64-win.exe`（113,981,288 B），
  含 `app-update.yml` 与 `resources/ffmpeg/`；已装副本换 `resources/app.asar`。
- 版本号**仍是 1.0.1**（本轮没升版）⇒ 想过自动更新推给别人，必须先升 `version` + `npm run release:stable`。

### J7 追加：把「并发路数」也挪进「高级设置」（2026-10-02 傍晚）

用户看完「并发路数 / 轮换策略为什么要出现在 app 里」的解释后拍板：**并发路数一并挪走**。
- **为什么是它**：它是**运行参数**（同时发几路模型请求 ⇒ 撞接口限流的旋钮），
  和「必带话题 / 额外话题」那种**改产出**的业务内容不是一回事；留在文案生成页会让人
  以为它也会影响文案内容。
- **动了两处**：`TABS[3]`（文案生成）摘掉 `<select data-cfg="copy.concurrency">` 与那行
  「按并发路数均分」提示（**提示跟着设置走**）；`TABS[11]`（高级设置）新增**第 4 个** `<details>`
  「文案生成并发」（`advBox()`），里面用它当场算「当前 N 篇 → 6 路 × K 篇」。
  顺手删掉**只服务那条提示**的死变量 `const total`（删功能要连**读取链**一起删）。
- **刻意没动**：`copy.rotateStrategy`（轮换策略）留在文案生成页 —— 它决定每篇拿到的标题格式
  F01~F10 与叙事视角，是**改产出**的；藏起来会让人找不到「为什么这篇是 F03」。
- **回归**：`uicheck` 113 → **116**（★ `advUi.collapsed` 的 3 也要跟着改成 4），合计 **735** 项。
- **双向验证 2 条**：B1 把下拉搬回文案生成页 ⇒ 只由「文案生成页不再摆并发路数」报红；
  B2 删掉高级设置那个折叠块 ⇒ 由「收齐入口」「折叠块计数」「能改且存进配置」三条报红。
  逐字节还原、md5 一致。
- ★★ **两个都不是产品缺陷的坑**（会重复踩）：
  ① 在「高级设置」页存**任何**一项，`saveCfgFromDom()` 都会把这一页的 `publish.adbPath` /
     `publish.ffmpegPath` **一起收进 patch** ⇒ **必然命中它末尾那段 `renderAll`** ⇒ 测试手里的
     `el` **已脱离文档**，而它读的是**活的 DOM** ⇒ 往旧节点写值＝**空操作**（所以「还原配置」
     之前必须**重新取一次元素**；否则断言会假红在「还原失败」上，看着像产品坏了）。
  ② **JS 模板字符串里的注释禁写反引号** —— 会把模板串当场截断，`node --check` 报
     `missing ) after argument list`（我就在这上面卡了一次）。
- 产物：`D:/work/_dist7/得物蓝V素材发布工具-1.0.1-x64-win.exe`（113,981,879 B，含
  `app-update.yml` 与 `resources/ffmpeg/`；asar 里 `data-cfg="copy.concurrency"` **只出现 1 次**）；
  提交 **`0c5e228`** 已推 Gitee（`git ls-remote` 与本地 HEAD 一致）。

### K 三个路径的真实用途（对照，别再凭印象答）
- `paths.source`：**基本不生效**。只 4 处读 —— `project.js:14` 预填、`jobs.js:82/88/101` 兜底、
  `ipc.js:307` 弹框起点、`report.js:165` 给**相对路径**拼根。**素材整理不读它**
  （`app.js:1899` 每次现场弹框选，存 `project.sourceDir`）。
- `paths.output`：**真在用，12 处**（批次产物 / dumps / run-log / **publish-log＝品牌统计唯一
  数据源** / pending-results / failures / 合规报告 / 发布单 / 统计与日志导出）。**跨机汇总的挂载点**
  （`app.js:1118-1120`）。但**不参与素材整理**。
- `paths.rejected`：只 1 处（`compliance.js:158/170`），★ **是 moveFile`搬走`不是复制**。
- ★ 扁平副本 `flat_<stamp>` 落点＝`path.dirname(sourceDir)`（`flatten.js:114-117`），**不是输出目录**。
- ★ 三个是**独立字段**：改素材根目录**不带动**隔离目录（默认隔离目录还在素材根目录里面）。
- ★ **启动不建**这三个目录 ⇒ 出厂「素材根目录」可能指向不存在的路径。

### L 任务栏图标不显示 · 自查顺序（2026-10-02）
- ★ **先做字节级验证再谈**：把 `build/icon.ico` 各尺寸的 PNG 数据拿去 exe 里 `indexOf` 搜；
  7/7 命中就说明**打包没丢图标**。★ PE 资源目录里 **RVA 不等于文件偏移**，`.rsrc` 的
  raw 偏移要走段表（本例 RVA 183881728 / raw 179761152，照 RVA 读会「越过 EOF」误判成没资源）。
- ★ `_dist6` == `_dist7` == 已装副本（md5 `8cee43b606ba`）⇒ 图标层这几轮**没变**，
  别把它当本轮改动的锅。
- `window.js` **不传 `icon`** 是 Electron 官方建议写法（Windows 留空＝用 exe 图标），**别当 bug 修**。
- ★ **分流判据**：资源管理器里图标是否正常渲染 → 不正常＝图标缓存 / ico 本身；
  正常但任务栏空白＝任务栏固定项缓存；一上来就是 Electron 原子图标＝在跑 `npm start`。
- ★ 本机实测：`%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_16/32/48.db` **都正好 1 MB**
  （撞上限）且 mtime **早于安装时刻** → 新装应用图标没进缓存，是这类症状的第一嫌疑。
- ★ `tools/make-icon.js` 的 `buildIco()` 把 **7 个尺寸全写成 PNG**（Windows 支持，但传统写法
  ≤48 应为 BMP/DIB）。真怀疑到这一层，再改成「小尺寸 BMP + 256 PNG」并重打包。
- ★★ **本沙箱跑不起 GUI**：`electron.exe <script>` 直接 `exit=1` 且零输出
  （`--in-process-gpu --disable-gpu --no-sandbox` 也一样），`desktopCapturer` 抓屏、`start` 拉起 exe
  都不行 ⇒ **要 GUI 实证得让用户自己截图**，别在沙箱里反复试。

## M. 真删「素材根目录」(`paths.source`)（2026-10-02 傍晚）

**删之前的事实**（逐处读过代码，不是印象）：三个路径里只有它「基本不生效」——
素材整理每次都现场弹框选（存 `project.sourceDir`），它只被当 ① 选择框的默认起点
② `report.toAbs` 拼相对路径的根。而 `defaultPaths()` 给的 `~/素材` 出厂**根本不存在**
（`index.js` 从不 mkdir，实测机器上没有这个目录）。

**删除清单（16 个文件）**：

| 位置 | 改法 |
|---|---|
| `store.js` 出厂配置 | `paths: { source, output, rejected }` → 去掉 source |
| `winpath.js#defaultPaths()` | 同步去掉 `source` 键 |
| `project.js#blank()` | `sourceDir: store.get('paths.source')` → `''`（不预填） |
| `jobs.js` 三处兜底 | 去掉最后那层默认值，改用新增的 `needSourceDir()` |
| `ipc.js` `dialog:dir` | `defaultPath` 不再拿它兜底（`\|\| undefined`） |
| `report.js#toAbs` | 相对路径**返回空串**；`build` 改用 `toAbs(row.dir) \|\| toAbs(opts.dir)` |
| `report.js` | 顺带删掉已无人用的 `store` require |
| `app.js` | 删设置页那一行控件；4 处引用改用 `project.sourceDir` / 该字段自身 |
| 6 个测试套件 | 配置里的 `paths.source` 键删掉 |
| `HANDOFF.md` / `WINDOWS-E2E.md` | 5 处措辞 + 硬约束那条里的 `paths.source` |

**两条要记住的判据**：

- ★ `needSourceDir()`：没选目录就 `throw`，**不许拿默认目录兜底**。否则 `undefined` 一路传到
  `readdirSafe` → `fs.readdir`，冒出来的是 `The "path" argument must be of type string`。
  （`toLong(undefined)` 在 Windows 上 `!p` 即真 ⇒ 直接返回 `undefined`，不抛 ENOENT，
  所以 `readdirSafe` 那层 `catch` **吞不掉**，会一路 rethrow。）
- ★ 报告里的**相对路径**不再有参照系 ⇒ `toAbs` 返回 `''`，由 `build` 退回「导入时选的那一批目录」。
  这是**行为改变**（旧版会拿 `~/素材` 当根拼），所以测试里必须补断言，不能默默改。

**回归数字**：735 → **740**（batchtest 22→23、reporttest 32→34、uicheck 116→118）。

**定点破坏 5 条**（全部只由目标断言报红、逐字节还原 md5 一致）：
B1 把控件加回设置页 / B2 出厂配置加回 `source` / B3 `needSourceDir` 退回默认目录 /
B4 `toAbs` 相对路径原样返回 / B5 `build` 里给相对路径兜一个绝对根。

★ **踩到的坑**：`git commit -m "...含反引号..."` 在 bash 双引号里**反引号会触发命令替换** ——
我那条 message 里的 `` `|| store.get('paths.source')` `` 被吃成空字符串（提交照样成功、exit 0）。
⇒ 含反引号的 commit message **一律 `git commit -F <文件>`**，改完 `git log -1 --format=%B` 回读核对。
（与「`python -c` 里写反引号被吃掉」是同一类坑，见用户级 REFERENCE-通用.md。）
★ **同轮踩到的第二个坑**：改记忆文件时「在内存里改完、打印了长度、却**忘了落盘那一行**」——
脚本报「2983 → 2988」看着像成功，实际 `MEMORY.md` 的 mtime 一动没动、内容还是旧的。
⇒ **改任何文件之后必须读回校验**（重读、比长度、查关键串），别拿内存变量自证成功。
本轮就是靠「核对时打印 mtime + 重读」才发现，否则这条规则会**静默丢失**还没人知道。
## N. 登录页去黑框 + 删出厂账号提示 / 颜色不再拦发布 / 商品池去掉示例数据 ⇒ 发 `1.0.2`（2026-10-02 深夜）

**用户四件事**：①校验池说有 5 个示例记录、实际没有；②「没校验 / 货号对但对颜色错 ⇒ 按货号搜出来的第一件商品发」
放进「模拟器发布」页的提示词；③登录页还有黑边框、下面那行 admin 也去掉；④打包推正式版。

### N1 「登录页黑边框」的根因是深色系统（不是边框）

- 实测本机 `AppsUseLightTheme=0` / `SystemUsesLightTheme=0` ⇒ Windows 是深色模式。
  整块底色由 `html.dark` 那套变量决定 ⇒ 近黑底 + 白卡片，看着就是「黑框」；下面那行是 `loginTip` 的出厂账号提示。
- **两处必须一起改**（只改一处会「先闪一块近黑」）：
  - `styles.css`：在 `.gate` 子树里**重新声明整套浅色变量** ⇒ 登录页固定浅色，主界面继续跟随系统主题。
  - `window.js`：`BrowserWindow.backgroundColor` 是 **JS 取色、不随 CSS 走** ⇒ 新增 `GATE_BG='#f2f1ed'` 与
    `bgColor()`（dark → `#111113`）；建窗 `locked ? GATE_BG : bg`；`nativeTheme.on('updated')` 里非登录门才改；
    `setLoginMode` 开 / 关各设一次。
- 出厂账号提示**整条删掉**（不是设 `hidden`）：`index.html` 的 `#lgTip`、`app.js#showGate()` 那段渲染、
  `auth.js#status()` 的 `defaultHint` 字段 —— **连读取链一起删**。

### N2 颜色校验不再是发布流程的必需项（最终口径）

- `verify.js`：「颜色不匹配」「主色不符」两处 `block=true` → `false`；`isBlocked()` 旧数据回推收紧。
- **全库只剩 1 处 `block = true;`**（多色漏填）；`uicheck` 直接盯这个数。
- 界面上两处写清：货号颜色校验页「只提示、不拦发布」；模拟器发布页写明完整规则 + 要让机器真按这条做，
  需要在 UI 定位表里「搜索货号」后面补一步「点第一件商品」（`uimap.suggest()` 目前**没有**这一步）。

### N3 商品池去掉出厂示例数据

- `pool.js` 删掉硬编码 5 条 `SAMPLE`（`26FW-YB160` / `UF46FWT75EH1HF6` / `26FWT81` / `CK-Y208` / `abc`），
  `load()` 兜底改**空池** `{ source: '还没有导入商品池', updatedAt: 0, skus: {} }`。
- 用户看到「有 5 个示例记录」却查不到 —— 就是这 5 条。

### N4 回归与双向验证（实测数字）

- 全量 **747** 项全绿：`39+72+9+26+31+23+34+80+123+71+17+67+65+45+45`（smoke 38→39、uicheck 116→123）。
- 定点破坏 **7** 条，脚本 `D:\work\_e2e\breakverify-v102.py`（支持 `... 1,3` 只复跑几条）。
- ★ 两条踩坑：① B1 锚点第一版是**纯子串**（`  --bg:#f2f1ed; ...`）⇒ 在 `:root{` 与 `.gate{` **各出现一次**
  （`count==2`），必须把 `.gate{` 一起带上才唯一；② B3 实测被 smoke **4 条**断言一起抓到
  （统计 `blocked` 1→0、两行发布单从「待发布」变「校验未通过」），期望值按**实测**补到 4 条而不是猜的 2 条。

### N5 发 `1.0.2`（第一个含 GPL ffmpeg 的正式版）

- 产物 `113,981,179 B`（88.0 → **108.7 MB**，+20.7 MB），体积涨的**全是 ffmpeg**。
- `1.0.1` 发布时只内置 4 个文件（adb×3 + `ADBKeyboard.apk`）；`vendor/ffmpeg/ffmpeg.exe`（82,797,568 B，GPL-3.0 静态版）
  是**当天 12:12 才进的仓库**（`505be4f`）⇒ 发之前必须把 GPL 边界摆给用户拍板（用户选**照推**，口径 = 只在自己公司/团队内部装机）。
- 公网核对：`latest.yml = 1.0.2`、安装包 `HTTP 200 / Content-Length 113,981,179`（与本地同）、
  `beta.yml` 一个字节没动（仍 `1.0.1-beta.2`）。
- ★ 与 §I 那条「`dist/win-unpacked/` 已存在会让打包中断」**不一致**：本轮 `npm run dist:win` **直接打回 `dist/` 成功**（44 s），
  没出现 `Access is denied` ⇒ 那条沙箱限制**不是每次都触发**；真遇到再走独立输出目录 + 搬三样。
- ★ 已装副本 `D:\bluevbeta\dewu-bluev-publisher` 只换了 `resources/app.asar`（先备份 `app.asar.bak-1.0.1`）；
  `app.asar.unpacked` 与产物**逐文件一致**（`diff -rq` 无输出）⇒ 不用动。

### N6 asar 读文件路径（对 §A 那条的实测更正）

- ★ **`@electron/asar` 的 `extractFile()` 只认「反斜杠分隔」的路径**：`'src\\renderer\\styles.css'` 可以，
  `'src/renderer/styles.css'` 直接 `Error: "..." was not found in this archive` —— **正斜杠一律 not found**；
  顶层 `'package.json'`（无分隔符）两种都行。
- `listPackage()` 的条目是**前导反斜杠 + 反斜杠分隔**（`\src\main\index.js`）⇒ 判断「某目录有没有进包」
  要用 `/^[\\/]+vendor[\\/]/` 这类**锚定**正则，别用 `/vendor/i` 裸搜（`node_modules` 里可能撞上）。

## O. 账号权限改成「行内按钮 + 弹窗」（2026-10-02 傍晚第二轮）

用户原话：「删除品牌管理那里的文案按钮，在用户管理右侧增加一个按钮，配置权限，以弹窗的形式呈现，
现在配置权限的路径是：筛选。不好用，改掉」
★ 那个「筛选」**全仓没有对应入口** —— 追问时先把现状摆出来（品牌管理表每行是 `文案/改名/停用/删除`；
「给某账号配品牌权限」其实是表格**下面另外一条工具栏**：`品牌权限 [下拉选账号] □品牌 [保存品牌权限]`），
用户确认指的就是那条下拉工具栏。同一次还确认了两件事：文案提示词那一**列**保留（只删按钮）；
**重置密码也一起改成弹窗**（它跟品牌权限同一个毛病 —— 要先去下拉里选人）。

### O1 改法（三个文件）
- `src/renderer/app.js`
  - `brandsHtml()`：行内操作删掉 `data-act="bm:open"` 那个「文案」按钮（`<th>文案提示词</th>` 那列保留）。
    提示词的入口回到「文案生成 → 提示词配置」（`copy:prompt` → `openBrandModal('list')`）。
  - `adminUsersHtml()`：每行右侧变成 `配置权限 / 重置密码 / 停用·启用 / 删除`；
    **整条删掉**下面两条工具栏（品牌权限 `#pbUser` + 勾选框 + 「保存品牌权限」；重置密码 `#rsUser` / `#rsPwd`）。
  - 新增 `upPermHtml()` / `upPwdHtml()` / `renderUserModal()` / `openUserModal()` / `closeUserModal()`；
    动作 `up:perm` / `up:pwd` / `up:close` / `up:permSave` / `up:pwdSave`。
- `src/renderer/index.html`：新增 `#umodal` / `#umBox`（与 `#bmodal` 并列，挂在 `.app` 外面 —— 塞进 `.body` 会被 overflow 裁掉）。
- `src/renderer/styles.css`：`.mbox-sm{width:min(520px,100%)}`。

### O2 四条「删干净」清单（少一条就等于行为没变）
- 控件：`#pbUser`、`#rsUser`、`#rsPwd`。
- 动作：`auth:brands`（旧「保存品牌权限」）、`auth:reset`（旧「重置密码」）。
- 状态：`state.permUserId` —— 连它在 `doLogout()` 的清理与 `bindSettings()` 里那段 `onchange` 一起删。
- 断言：旧路「先在下拉里选人」不许再留可达路径。

### O3 两个只有做过才知道的细节
- ★ 弹窗里那个密码输入框的**回车提交**只能在 `renderUserModal()` 里绑：CSP 不许内联 `onkeydown`，
  而 `bind()` 只跑一次（那时弹窗还没建出来）。
- ★ 管理员那一行**不给勾选框**（他的权限本来就是「全部品牌」，含以后新增的）；
  所以 `up:permSave` 拿到 0 个复选框时要先分辨「这个人是管理员」还是「一个品牌都还没建」，
  否则会把管理员的正常情况报成「还没有品牌」。

### O4 验证（全量 `747 → 768` 项）
- `uicheck` **+7**（源码级，`codeOnly()` 剥注释后判）；`logintest` **+14**（行为级，真点真存）。
- ★ 重置密码那条要**真登一次**才算数：弹窗看着「点了有反应」，完全可能只在界面上把框关掉、口令一个字节没动。
  用一次性账号 `pwdprobe` 验「`Probe@9999` 能登 / 初始 `Probe@1234` 被拒」，验完切回管理员。
  ★ 但 `auth.login()` 里 `disabled` 的判断在 `check(password)` **之前** ⇒ 拿**已停用**的账号验口令是**验不出来**的
  （两种情况都只回「账号已停用」），必须用启用状态的账号。
- ★ 这条顺手补上了「管理员重置别人口令」——**它此前一条断言都没有**。
- 定点破坏 7 条（脚本 `D:\work\_e2e\breakverify-20261002b.py`，跑法 `python … 1,3` 可只复跑某几条）：
  C1 塞回「文案」按钮 / C2 删掉行内「配置权限」按钮 / C3 塞回 `#pbUser` / C4 保存不写 IPC /
  C5 保存后不关弹窗 / C6 拆掉 Esc 关闭路径 / C7 重置密码只关弹窗不真重置。
  ★ C2 实测被 `logintest` **3 条**一起抓到（按钮没了 → 弹窗打不开 → 权限也就没写成），期望值按实测补到 3。

### O5 本轮**没有**打包推送
版本仍是 `1.0.2`（源上正式版就是它）。要发给同事就在下一轮打包 + `upload-release.js --channel stable`。

---

## P. ★★ 对照「拓新系统」（dewu-kol）——为什么「网页能调 MuMu」是错觉（2026-10-02）

用户问：「我之前做的拓新系统，不是可以调用 MuMu 吗？」**答案：调 MuMu 的从来不是网页，是那台电脑上的本机进程。**

- 拓新系统 = **另一个工作空间**：`C:\Users\Administrator\WorkBuddy\2026-09-18-19-34-22\dewu-kol`
  （代码在 `dewu-kol/` 下，**是 git 仓库**）。记忆两套：`dewu-kol/.workbuddy/memory/`（项目级）
  + 工作区根 `.workbuddy/memory/`（**自动注入源**），**改一份必须同时改另一份**。
- **真实链路**（读代码实证，不是印象）：
  - **网页（Supabase 后台）只做两件事**：往 `run_requests` 插一条 `pending`；读状态。
    ★★ **网页端连 `update` 权限都没有**（`migration_12` 只给 select/insert/delete）
    ⇒ 在**权限层**就已经堵死「网页直接驱动模拟器」这条路。
  - 本机 `watch_requests.py`（Python，**每 10 秒轮询** `run_requests`）领任务 → 调 `app_scan.py`
    → `ADB = D:\MUMU\MuMuPlayer\nx_main\adb.exe` 驱动 MuMu。
  - ⇒ 用户看到「网页点一下、十几秒后模拟器就动了」，于是记成「网页能调 MuMu」。
    **调 adb 的始终是本机 Python 进程。**
- **拓新有两条通道**：① **主通道** = `agent-browser` 打**得物社区网页版**（`www.dewu.com/community`），
  **根本不用模拟器**；② **支路** = 「App 扫描」才用 MuMu+adb（`doctor.js` 里 MuMu/adb/得物App 那几项
  「**只影响 App 扫描，不影响网页扫描**」）。
- ★★ **决定性判据**：**看那个动作在得物有没有网页版入口**。
  有（浏览社区）⇒ 浏览器自动化能顶；**没有（发布穿搭精选只在 App 内）⇒ 必须模拟器+adb**。
  这是拓新与蓝V 的**根本差异**：拓新 = **读 / 采集**，蓝V = **写 / 发布**。
- ★★ **拓新 = 混合架构的现成范例**，而且它用的模式比 WebSocket **更简单更安全**：
  **云端任务队列 + 本机轮询领取 + 网页只写状态、不读状态**。蓝V 要抄就抄这套。
- ★ **有一条别抄**：拓新的监听器**靠 agent 会话守候**（平台**禁止真常驻进程** ——
  `CREATE_BREAKAWAY_FROM_JOB` / `Register-ScheduledTask` / WMI `Win32_Process.Create` /
  `explorer.exe` 代启 **四条路全堵**，详见其 `REFERENCE-dewu-kol.md §20`；一次 `--budget=9`
  连跑 6 遍 ≈ 54 分钟接力）⇒ **不稳**。**蓝V 有真常驻 exe，不走这条路**。
- 对照表（帮下次别再重问）：

| 维度 | 拓新系统（dewu-kol） | 得物蓝V |
|---|---|---|
| 任务性质 | **采集 / 读**（扫得物社区） | **发布 / 写**（发穿搭精选） |
| 得物有网页入口吗 | **有** ⇒ 主通道走浏览器自动化 | **没有**（发布在 App 内）⇒ 必须模拟器+adb |
| 协作层 | **Supabase 任务队列** `run_requests` + 设备授权 + 看板 | **无**（本地 jsonl，跨机只能共享盘） |
| 谁在调 MuMu | 本机 **Python**（`app_scan.py`） | 本机 **Electron** 主进程 |
| 常驻能力 | 靠 agent 会话守候（一次 ≈54 min 接力）⇒ **不稳** | 真常驻 exe ⇒ **更稳** |
| 网页权限 | anon：只能 select/insert/delete，**无 update** | — |
| 主力机密钥 | `secrets.json` 里 `service_role`（**勿外传**） | 本机 `auth.json` |

## Q. 登录页「窗口＝卡片」+ 视频复用图文 + 假序列号兜底（2026-10-02 第三轮）

★ 与本节配套的**「换本机已装副本 asar」实操**见 **§BL**（★ userData 与已装副本**共用同一个目录**
⇒ 旧实例退出时会把**旧 uiMap 写回 config.json**，抹掉 `fixuimap.js` 打的补丁）。

### Q1 登录页两个「只能看」的问题（真窗口实测，不是推测）
- **白底白字**：真窗口读计算色 —— `.gname`（「得物蓝V 素材发布工具」）`color=rgb(234,234,231)`
  压在 `bg=rgb(255,255,255)` 的白卡片上。根因**不是**没重声明变量，而是 **CSS 自定义属性的求值时机**：
  `body{color:var(--tx)}` 是**在 body 上按 `html.dark` 求过值**的（`#eaeae7`），后代继承到的是
  那个**算完的具体颜色**，不是 `var()` 表达式 ⇒ 在 `.gate` 里重声明变量**管不到它**。
  ★ 修法：`.gate{ … color:var(--tx); }`（**显式**写这一行）。
  这也解释了为什么「重声明变量」看着生效：`.gsub` / `.gfld span` 这些**自己写了 `color:var(--tx3)`**
  的元素本来就没事，只有**没写 `color`** 的元素才中招。
- **卡片外那圈色块** = 登录小窗本来就比卡片大：窗口 `380×339` / 卡片 `{x:20,y:18,w:340,h:302}`
  ⇒ 四周露出一圈 `#f2f1ed`。（上一轮只把颜色从「近黑」换成「浅米色」，**那圈东西还在** ——
  这正是用户说「说了三次都没解决」的原因：我在改**颜色**，他要的是**把它去掉**。）
  ★ 修法：`GATE_WIDTH 380→340`、`GATE_PAD_Y 18→0`、`gate` 背景与 `GATE_BG` 都改**纯白**（与卡片同色）。
  ★ 验收（真窗口实测）：窗口 `340×301`、卡片 `{x:0,y:0,w:340,h:300}`、`gate 背景 = 卡片背景 = rgb(255,255,255)`。
- 取证工具 `tools/gateshot.js`（**不参与回归**）：
  `env -u ELECTRON_RUN_AS_NODE npx electron tools/gateshot.js [out.png]`
  → 逐元素打印登录卡内每个可见文字元素的**实际** color / background / 字号，并存 PNG。
  行为断言在 `tools/gatetest.js`：**窗口宽 = 卡片宽**、**卡片里没有「前景≈背景」的文字**（WCAG 对比度 < 3 即红）。

### Q2 视频复用图文定位表（用户实测：图文与视频的发布位置一样）
- `publisher.run` 原来 `videoSteps` 为空就抛错（怕拿图文步骤硬套）⇒ 改成**空则复用 `steps`**，
  并打一条「按「图文那套位置」发」；`videoSteps` 保留为**可选覆盖**。
- 界面 chip「视频未配」→「视频复用图文」；`jobs` 两处日志同步；`adbtest` ⑦ 段口径改成「照常发布、且真的按 steps 点下去」。
- ⇒ 用户**只需抓一次图文发布页**。`uimap.suggest()` 仍生成两套候选（留着覆盖用）。
- **UI 定位表怎么做**（操作路径）：模拟器开着、得物停在**发布页** → 「设置 → 高级设置」→「抓取页面结构」
  → 输出目录生成 `ui-dump-<ts>.xml` + `uiMap-<ts>.json`（**候选表，按关键词猜的**）
  → 打开 json 核对/改正 `steps`（带 `⚠` 或 `unverified:true` 的重点看）→ 回界面点「导入 UI 定位表」。
  action 只认 7 种：`tapText / tapId / tapDesc / input / wait / back / screenshot`；
  占位符 `${title}` `${body}` `${topic1..5}` `${sku}` `${videoName}`。
  ★ 真机注意（2026-10-01 实测）：发布入口 `ivCamera` **没有文字**（得用 `tapId`）；相册格子**没有文字**（只能按坐标/id）；
  全 App `content-desc` 为空（`tapDesc` 一步都用不了）。
- 「颜色错就选第一件商品」要**手工**在 `steps` 的「搜索货号」后面补一步「点第一件商品」（`suggest()` 不生成这步）。

### Q3 「检查能不能发布」里的 `emulator-5554` 不是硬编码
- 实测：内置 adb 与 MuMu adb 都看到 `emulator-5554  device`；而 `config.json` 里 `publish.device=""` / `devices=[]`
  ⇒ 走 `adb.probe('')` 的「还没选设备」分支，文案把**刚扫到的真实设备名**列了出来。
- 但确实有一处该删的硬编码：`publisher.connect()` 的 `|| 'emulator-5554'` 兜底 —— 没配设备时它拿这台
  不存在的设备去 probe，界面报「你选的设备「emulator-5554」没连上」。**已删**，改成直接返回「还没选设备」。
- ★★ **判「该不该删」时别只看源码**：先跑一次 `adb devices`，否则会把用户自己的设备名当成硬编码。
- 界面文案：「序列号，如 emulator-5554」全部改掉（`placeholder` / toast / `addDevice` 报错）。

### Q4 回归与双向验证（实测数字）
- `768 → 776` 项全绿（`adbtest` 72 / `uicheck` 136 / `gatetest` 19 / `logintest` 85，其余同前）。
- 定点破坏 8 条（脚本 `D:\work\_e2e\breakverify-20261002c.py`）：D1 去掉 `.gate` 的显式 color /
  D2 背景改回深色变量 / D3a 呼吸位加回 18 / D3b 窗口宽改回 380 / D4 兜底假序列号 /
  D5 提示「如 emulator-5554」/ D6 视频改回抛错 / D7 chip 写回「视频未配」。
- ★ **期望值按实测补**：D3a 被 `gatetest` **2** 条一起抓到、D3b 被 **3** 条（同一缺陷多条防线）。
- ★ 又踩一次「**同一文件的多个 `Edit` 并行发 ⇒ 互相覆盖、只剩最后一个生效**」：D3a 的修改被 D3b 覆盖，
  复跑才发现该条仍报 1/1 ⇒ 同文件的多处改动**必须串行**。

## R. 云端协作阶段 1：发布结果上云 + 只读网页看板（2026-10-02 第四轮，commit `86d095d`）

### R1 架构口径（别再纠结「转不转网页」）
- ★★ **发布核心只能在本机**：发穿搭精选在得物**没有网页版入口** ⇒ 必须有本机程序操作模拟器 ⇒
  **App 就是那一层，继续做、是主力**。网页只做协作（派活/看进度/统计），**不碰发布**。
- ★ 判断捷径：**看那个动作在得物有没有网页版入口** —— 有（浏览社区/看达人）→ 浏览器自动化可顶；
  没有（发穿搭精选）→ 必须模拟器 + adb。
- ★ 「App 比网页慢」是**误判**：发布节奏是人为间隔 60s/条，`publisher.js` 文件头注释写着
  「2.5 小时里 93% 是在等间隔」⇒ 瓶颈在**并行设备数**，换网页一秒都少不了。
- ★ 「App 收不到别人的日志」也是误判：那是**数据层**（本机 jsonl）的锅，不是形态的锅。
  **`HANDOFF.md:407-408`** 写着「跨机汇总只能靠把各台指到同一个共享位置」。

### R2 阶段 1 做了什么（本机轮询式上行，照抄拓新）
- `src/main/services/cloudsync.js`（新）：按游标增量推 `publish-log.jsonl` 到 Supabase REST。
  ★ 为什么**不用** WebSocket/配对本机：不开端口、无暴露面、天然多机并发（各推各的，按 `machine_id` 区分）。
- 配置 `cloud.*`：**默认关、url/anonKey 默认空**；`store.js` / `ipc.js`（`cloud:status|sync|test`，
  一律 `guardAdmin`）/ `preload` / `index.js`（`cloudsync.start()`）/ `renderer`（高级设置折叠块）。
- `docs/supabase-setup.sql`（新）：建表 + `(machine_id,ts,seq)` 唯一索引 + RLS
  ★★ **anon 只给 insert + select，绝不给 update/delete**（能改 ⇒ 看板上的成败不值钱）。
- `web/board.html`（新，单文件只读看板）：款进度（目标 150 可调）/ 按机器与人汇总 / 明细；
  凭据只存 localStorage。**不进 App 包**（`build.files` 只含 `src/**`）。

### R3 四条红线（都写成了断言，见 `tools/cloudtest.js` 26 项）
- ① 关着**一次都不联网**；② 失败**绝不阻断发布**（只记状态 + 退避）；
- ③ **只上行结构化结果**：18 个字段白名单，`dir` 只取 `path.basename`（绝不带绝对路径），
  `reason` 截断 200（异常堆栈常带路径）；**不上行日志原文**（带路径且行数会爆）；
- ④ **幂等**：`Prefer: resolution=ignore-duplicates` + 唯一索引（重试不长重行）。
- ★★ 任何客户端都**不许**内置 `service_role`（能绕过 RLS）。负向断言要先 `codeOnly()`
  （我自己写的注释里就有这个词，会把断言打红）。

### R4 只有做过才知道的两个坑
- ★ **游标自愈**：台账被「数据清理」清空后，游标指到行数之外 ⇒ **从此一行都推不上去**，
  而界面还显示「已连接 · 待上行 0」（最坏的假正常）。修法：`if (st.offset > all.length)` 重置并把这件事
  写进 `status.reset` 让人看得见。
- ★★ **破坏脚本把坏版留在源码里**（`D:\work\_e2e\breakverify-cloud.py`）：备份只建一次、
  `restore()` 里又 `os.remove(BAK)` ⇒ 第 1 条还原后备份就没了 ⇒ 第 2~4 条破坏**全都没得还原**，
  最后一条 `st.offset += 0` 永久留盘，脚本却打印「已还原：True」。症状：**单独跑全绿、进回归红 6 条**。
  ⇒ 还原改成「写回内存干净副本 + 读回逐字校验」。详见 `REFERENCE-通用.md` ⑪。

### R5 实测数字
- 回归 **776 → 806 项全绿**（16 套；`cloudtest` 26 / `uicheck` 137 / `adbtest` 75 / `brandtest` 80 …）。
- 反向验证 4/4：拆掉「幂等头 / 游标重置 / dir 脱敏 / 游标推进」⇒ 分别红 **1 / 2 / 1 / 3** 条。
- **未联调**：真实 Supabase 项目（没凭据）与真机 adb —— 联调结果**没测到就不许说已验证**。
- 提交 `86d095d`（本地，**未推送**；`package.json` 的 `1.0.3→1.0.4` 是工作区里已有的未提交改动，不是本轮改的）。


## S. 「还没选设备」文案里的设备名 + 并发会话下的发版（2026-10-02 第四轮）

### S1 真根因：不是兜底没删，是我**自己在文案里又写了两遍**（用户第四次提）

- 第三轮我删掉了 `publisher.connect()` 的 `|| 'emulator-5554'` 兜底，还说「删干净了」。
  但同一次改动里，我在 `adb.js` 的「还没选设备」提示正文中**又**加了两处设备名：
  - 字面量示例：`'★ 这个名字是**你的模拟器自己的名字**（雷电 / MuMu 默认就叫 emulator-5554），'`
  - 动态真名：`` `刚问了一句 adb，它说现在在线的是「${usable[0].serial}」。` ``
  用户截图回问「你跟我说你删干净了」。
- ★★ 教训：这类文案**不许出现设备名**，连「解释它是真名」都不行 —— 用户看到的是一串英文数字，
  根本分不清那是模拟器真名还是程序写死的；**解释性的「这不是写死的」本身就在制造怀疑**。

### S2 现在的规矩（`adb.js#probe()`）

- `serial` 为空时，`say('bad', …)` 的正文**整段不含任何设备名**：
  「检测到有模拟器在线，但它还没被加进本程序的设备列表。点『设备管理』里的『扫描设备』，
  列表里会出现它，点那一行的『加入并使用』就选上了 —— 不用抄设备名，也不用知道它叫什么。」
- `notes`（技术详情）也改成「还没选设备。adb 现在认到 N 台设备（其中在线可用 M 台）—— 点『扫描设备』…」。
- ★ 只有「**已经选了、但它掉线了**」才把真名说出来（那时用户需要知道掉的是哪一台）。

### S3 两条新断言（`uicheck` +1、`adbtest` +3；回归 776 → 780）

- `uicheck`（源码级，**判严了第三轮那条**）：全 `src/` 扫 `.js`/`.html`/`.css`，
  `emulator-5554` **只允许出现在注释行**（`//`、`*`、`/*` 开头），非注释行出现即红并打印 `文件:行号`。
  ★ 第三轮那条只查 `app.js` 的「如 emulator-5554」⇒ 我写在 `adb.js` 里的那两句整段溜过去了。
  另加一条：那段 `say()` 正文里不许出现 `${`（连动态拼的也不许）。
- `adbtest`（**行为级**，不是扫源码）：`await probe('')` 跑一遍，断言 `fix` + `notes` 全文
  都不含假 adb 那台 `127.0.0.1:5555`、也不含 `emulator-5554`；同时断言「在线可用 N 台」这个量还在
  （不然用户不知道扫描有没有用）、引导仍是「扫描设备 → 加入并使用」。
  ★ 假 adb 的 `devices` 输出里天然有一台 `127.0.0.1:5555` ⇒ 提示里只要点了名就会被抓到。

### S4 定点破坏（脚本 `D:\work\_break4.py`，3 条，逐字节还原 + md5 一致）

- B1 把真名动态拼回正文 ⇒ `adbtest` 1 条 + `uicheck` 1 条红。
- B2 塞回字面量示例 ⇒ `uicheck` 1 条红（报 `src\main\services\adb.js:489`）。
- B3 技术详情 note 点名 ⇒ `adbtest` **2 条**红。

### S5 ★★ 并发会话下的发版（本轮新坑，代价最大的一条）

- **实测**：我提交 `75f3489`（修文案）时，`git status` 里还有 5 个我没动过的文件
  （`index.js` / `ipc.js` / `store.js` / `preload/index.js` / `app.js`）和一个新文件
  `src/main/services/cloudsync.js`；我提交完，那一路随即把「云端协作（阶段1）：发布结果增量上云 + 只读网页看板」
  （`86d095d`）也提交到了 main。
- **判据**：`~/.workbuddy/projects/<工作区>/*.jsonl` 里**两个文件同时长**就是信号（按 mtime 排序看）。
  对应地，`<工作区>/.workbuddy/memory/` 下的 `MEMORY.md` / `REFERENCE-*.md` / 当日日志**也是共享的**，
  两边都在写 ⇒ 只能**追加**，不能整文件重写（我就是靠「先读一遍发现 §R 是别人写的」才发现的）。
- **只暂存自己的 hunk**：`git add <自己改过的那几个文件>`，**绝不用 `git commit -a`**。
- ★★ **打包走 `git worktree` 干净快照**，别在主工作区直接打：
  ```
  git worktree add --detach D:\work\_rel104 <commit>
  # 建联接必须用 PowerShell——`cmd //c mklink` 在 Git Bash 里会被吃掉，只剩一个交互式 cmd：
  New-Item -ItemType Junction -Path 'D:\work\_rel104\node_modules' -Target 'D:\work\dewu-bluev-publisher\node_modules'
  # 跳过会写共享 node_modules 的 addon:win：
  node node_modules/electron-builder/cli.js --win --x64 --publish never
  ```
  ★ 拆的时候**先删联接再删工作树**：`[System.IO.Directory]::Delete('…\node_modules')`（只删链接、
  不碰目标），再 `git worktree remove --force`；否则有连带删掉主仓 `node_modules` 的风险。
- ★ `upload-release.js` 的凭据来自**仓库根 `.env`**（gitignored，含 `COS_*` 五项）⇒ worktree 里要
  **拷一份** `.env` 再跑，用完**删掉**别留在快照里。
- ★★ **发版范围必须让用户当场拍板**：`1.0.4` 从 `86d095d` 打包 ⇒ 会带上别人那一路刚提交的
  「云端协作（阶段1）」。两种范围（只带自己的修复 / main 全量）摆给用户选，用户选了 **main 全量**。
- **实测数字**：产物 `113985951 B`（比 `1.0.3` 多 `3301 B` ⇒ 无新增内置二进制），打包 `22 s`；
  公网 `latest.yml = 1.0.4`、安装包 `HTTP 200 / Content-Length 113985951`、`beta.yml` 未动。

## T. 云端协作第三轮：凭据内置进包 + 配置下发 + 组织标识（2026-10-02 第五轮，commit `188a0e3` + `e34fb46`）

> 用户原话：「挂靠其他项目的 supabase 吗？每台机器都要自己跑？不能统一设置好吗」
> ⇒ 三个问答定案：**挂靠拓新那个项目** + **凭据内置进包** + **看板也预填**。

### T1 内置凭据这件事，和「出厂不预置任何东西」不冲突（★ 别误删）
- MEMORY.md 那条「出厂不预置业务数据」指的是**品牌 / 商品池 / 出厂账号 / 示例名**。
  **云端凭据是例外，必须内置**：`src/main/clouddefaults.js` 里放 `url` / `anonKey` / `org` 三项。
- ★★ **只许 anon / publishable key**（`sb_publishable_...`）。它本来就是**设计成公开**的
  （拓新系统自己的前端里也明文放着），权限完全由数据库 RLS 决定，所以「内置」不降低安全性。
  **`service_role` / `secret` 绝不许进包、进仓库、进客户端**——它绕过所有策略。
- **同一份凭据有两个落点，改一处必须同时改另一处**：
  ① `src/main/clouddefaults.js`（App）；② `web/board.html` 的 `BUILTIN` 常量（看板）。
  ★ 有断言焊住（`cloudtest` H 段）：只改一处会红，否则会变成「App 在推 A 项目、看板在看 B 项目」，
  两边都显示「已连接」，谁都没错——这种错最难查。
- 要换项目**不用重打包**：高级设置 → 云端协作 → **导入配置**（或直接改那两个框，界面上填的优先）。

### T2 applyCloudDefaults 必须 load() 和 set() 都调用（★★ 防「界面骗人」）
- `cloudsync.cfgOf()` 对空值本来就会兜底到内置地址 ⇒ 若只有 `load()` 归一，
  管理员把地址框**清空**、看到的是**空白**，而数据**照样往内置地址推**。
- 所以 `store.set()` 也要调 `applyCloudDefaults(cache)`：**存下来的，永远等于真正在用的**。
  真要停上云用那一页的**开关**，不是清空地址（界面文案也是这么写的）。
- ★ 守卫断言：「清空地址后 `store.get('cloud.url')` 也必须等于内置值」+「显式填的不被顶回去」。

### T3 `toRow` 的 `org` 必须兜底（漏传＝整批被 RLS 拒收）
- insert 策略是 `with check (org = 'bluev')` ⇒ 调用方漏传 `org` 不是「少一列」，
  而是**每一行都被拒收**，而界面只显示四个字「同步失败」，排查成本极高。写法：`(machine && machine.org) || CD.org`。

### T4 表没建时要说人话（每个人第一次必然走的路）
- 凭据内置后，用户第一次点「测试连接」时**表还不存在**（建表 SQL 只能由人在控制台跑一次）。
  PostgREST 返 `404 + PGRST205` ⇒ 必须翻译成「**与你项目连通，但表还没建：去跑 docs/supabase-setup.sql**」，
  并**附上返回原文**（别藏原始错误）。判据：`/PGRST205|Could not find the table|does not exist/i.test(detail)`。

### T5 改写过的一条断言（留档：免得将来又被「修」回去）
- 原是「**代码里不许出现 `service_role` 四个字**」。加了「导入配置拦下 service_role」后它**必然误报**——
  代码里必须出现它，那正是**主动拦下它**的那行判断（**看着像漏洞，其实是防线**）。
- 已拆成两条：① 正面 `if (/service_role|secret/i.test(key))` 必须存在（防止拦截被删、只在注释里说已拦下）；
  ② 负面：全文件不许有**凭据字面量**（`eyJ…` 长串 / `sb_secret_` 开头）。
- ★ 一般规律：**「某关键词不许出现」这类断言，一旦该关键词成为「防御的对象」，断言就必须改成查语义。**

### T6 实测数字（可复算）
- 回归 **826 项全绿**（阶段 1 交付时 806 ⇒ 本轮 +20）；`cloudtest` 26 → **43 项**；`uicheck` **140 项**
  （含**真窗口**点开/关掉新弹窗 2 条）。
- **定点破坏 14 条，14 条确认能红**（脚本 `D:\work\_e2e\breakverify-cloud2.py`，多文件版、逐字还原校验）。
- 新增 `uicheck` 断言两条有用的手法：
  ① **结构**：用行号比对证明弹窗在 `.app` **外面**（`.app` 的 `</div>` 之后才出现 `#cmodal`），
     比 match 一段 HTML 稳；
  ② **行为**：真 `btn.click()` 开弹窗 → 查 `!mask.closest('#pane')` → 派发 `Escape` → 查 `mask.hidden`。

### T7 ★ 没验证的部分（说清楚，别当已验证）
1. **没在真库上跑过一次真实 insert**（没有建表权限，表还不存在）。
2. **建表 SQL 没在真库执行过**：`with check (org = 'bluev')` 这条策略**一次都没被真实数据库跑过**。
3. `org` 只防「不知道组织标识的人」，**防不住拿到包的人**（包和 key 都在他手上）。
4. **没上真机 adb 发过**（本轮没碰发布链路）。

### T8 发版注意
- 本轮**没有动 `package.json` 的版本号**（`1.0.4` 看起来已发过正式版，静默改版本号危险）
  ⇒ 下次发版前手动改成 `1.0.5`，再按 §S5 的 worktree 流程打包。

### T9 ★★ 云端配置：**留空＝跟随内置**，绝不许写回配置（2026-10-02 第六轮已落地，`fb6e20c`）

**问题**：用户问「为什么 A 变更了项目，别的机器要重新导出导入？」——查出来是**一存即固化**。

**实测**（`D:\work\_e2e\_freeze-probe.js`，桩掉 electron，userData 指到临时目录，
用一个**不同的** clouddefaults（NEW）去加载 config.json）：
| 场景 | config.json 里的 cloud | store 读到的 url | 结论 |
|---|---|---|---|
| 新装机器 | 没有 cloud 这个键 | `https://NEW.supabase.co` | **跟随内置**（新包生效） |
| 已存过盘 | `url = https://OLD.supabase.co` | `https://OLD.supabase.co` | **内置顶不动** |

**旧链条**（三行代码，缺一不可，已改掉）：
`defaults()` 里 `cloud.url = CD.url`（内置值进缓存）→ `saveCfgFromDom()` 把 `#pane [data-cfg]`
**全部控件**的值整体 `configSet` + `scheduleSave()` 把**整个 cache** 写盘（⇒ 在高级设置页改**任何**一项
都会把 cloud 整块固化进 config.json）→ `applyCloudDefaults()` 只在**为空**时补（⇒ 固化后顶不动）。
★ 实证：只调一次 `store.set({ui:{theme:'dark'}})`（与云无关），config.json 就多出整块 `cloud`。

**现在的规矩（★★ 违反就退回老毛病）**：
1. `store.defaults()` 的 `cloud.url/anonKey/org` **必须留空**；**不许**在这层写内置值；
2. **`applyCloudDefaults` 已整块删除，别加回来**；`store` **不许** `require('./clouddefaults')`
   （不认识内置值 ⇒ 没人能顺手把它写回去）。两条都有负向断言 + 定点破坏守着；
3. `cloudsync.cfgOf()` 读时兜底内置、`explicitOf()` 给「本机显式填的」；**兜底值绝不写回 store**；
4. ★★ 守「界面骗人」的担子全在 `#cloudEff`：它**无条件**显示「当前实际在用哪个地址 + 来源
   （跟随内置／本机指定）」。删掉「把值写回配置」之后，这是唯一让「框里空着＝仍在推内置地址」
   这件事**看得见**的地方。uicheck 有断言焊死：**界面显示的地址必须 == `status().url`**。
5. 于是换项目的通道：**发新包 → 各台升级自动跟随**（因为配置里是空的）；
   导出/导入只留给「升不了级」的机器 —— ★ 反过来说：对方是「跟随内置」时**不要**发配置，
   粘了反而把那台写死。看板是独立的本地文件，换项目要手动改（否则「少人」且不报错）。

**为什么当初不做「从云端读配置」**：那等于允许远端改本机的数据去向
（拿到 anon key 就能把全体数据引到自己库），与「更新源地址编译进包、不许运行时改」同族 ⇒ 主动不做。

**断言踩坑（留档）**：第 4 条那条 uicheck 断言第一版写成「整段文本里出现『跟随内置』」——
而整段里**本来就同时有**「跟随内置」和「本机指定」两个词（徽章 + 说明），所以**说反了照样绿**。
改成只认 **`来源：` 后面那一段**，并且**不许出现反面的词**。★ 一般规律：**文案里出现两个互斥词时，
「包含」型断言必然假通过** ⇒ 要么截片段，要么加「不许出现反义词」。


---

## T. 得物发布页「两条入口路线」与「动画页备用通道」（2026-10-02 深夜 · 第五轮）

### T1 两条入口路线（真机逐跳实测，MuMu 12 / 得物 900×1600）
两条都到 `media.publish.activity.TotalPublishProcessActivity`：

| | 路线① 动态流右上角相机 | 路线②「我」→「主页」→「发布新动态」 |
| --- | --- | --- |
| 跳数 | 1 跳 | 3 跳 |
| 入口 | `com.shizhuang.duapp:id/ivCamera` | `com.shizhuang.duapp:id/rlPublish`（可点容器）+ 文字「发布新动态」 |
| 文字 | **无**（text / content-desc 皆空） | **有**（id + 文字双保险） |
| 起点 | 只在「动态」tab 上出现 | 固定底部导航 `tab_user`，不依赖内容流 |
| 结论 | 备用 | ★ **推荐**（用户 2026-10-02 提供） |

实测链路：`HomeActivity`（我 tab）→ 点 `tvGoHomePage`「主页」(838,149) → `PersonalActivity` →
点 `rlPublish`「发布新动态」(121,925) → `TotalPublishProcessActivity`。
`uimap.DEWU.route` 记这三步；`suggest()` 改为**优先用②**（有文字），①的 id 写进 hint 备用；
★ `videoSteps` 的首步**也一起改**（否则「视频复用图文」只在 steps 那一侧成立、videoSteps 还指着老路）。

### T2 发布页首屏**抓不下来**（本轮最要紧的发现）
首屏是**持续动画**页（相册预览轮播）⇒ `uiautomator dump` 永远等不到 idle：
2026-10-02 连试十几次、`--compressed`、关系统动画、静置 15s —— **全报 `could not get idle state.`**

→ 新写 `adb.dumpViaDumpsys()` + `adb.vhToXml()`：

- 按**包名**过滤 `TASK` 段（`want = ln.includes(pkg)`；`TASK` 行是段的分界）
- 按缩进还原层次，坐标**逐级累加**（`stack` 存 `[indent, 绝对x, 绝对y]`；`indent >= 栈顶` 就弹栈）
- 滤掉 `flags[0] !== 'V'` 的节点（真机里这类 bounds 是 `0,0-0,0`）；`x2<=x1 || y2<=y1` 也丢
- `#7f... app:id/x` → `com.shizhuang.duapp:id/x`
- `clickable = flags[6] === 'C'`（View.toString 的固定位次）
- ★ **text / content-desc 必须全空** —— 这条通道拿不到文字，**不许编**

`dumpEx` 的降级链：uiautomator 重试 → 关动画重试（**无论成败必须还原**）→ **只有 `pkg` 非空**才退 dumpsys。
`publisher.dumpForCapture()` 从 focus 正则里取包名；走备用通道时 `viaNote` 必须说清「有 id/坐标/可点，但没有文字」。

### T3 交叉验证（两套独立实现）
同一屏用 **Node 版 `vhToXml`** 与 **Python 版**各解析一遍：**110 个节点**、
43 个同名控件坐标逐一对上（±2px）、clickable 一致 ⇒ 备用通道的成果可靠，不是「看起来对」。

### T4 测试与自证
- `adbtest` ⑱ 段 **+21 条**（83 → 104）；全量 16 套 834 → **864**。
- 8 条定点破坏报红 **3 / 1 / 1 / 2 / 1 / 2 / 1 / 1**，逐字节还原。
- ★ **D5（`if (pkg)` → `if (true)`）第一次报红 0 条**：原断言只看 `ok` / `via`，而破坏后**这两个值恰好不变**
  （`dumpViaDumpsys('')` 自己也拒绝 ⇒ 最后还是落到 `via:'uiautomator'`）。
  加固成「`calls.log` 里不许出现 `dumpsys activity top`」+「报错里不许出现备用通道字样」后才红。
  ⇒ 教训：**降级链的断言要查「有没有真调那条命令」，不能只看返回值形状。**
- 夹具 `tools/fakeadb/activity-top.txt` = 真机数据（110 个可见节点）；前面**故意**垫两段别的 App，
  用来证明过滤是按包名做的；现场开关 `NO_DEWU_TOP` 测「备用通道也没抓到」这条。

---

> 编号说明：本仓 REFERENCE 里有**两个** `## T.` 章（历史遗留，未获授权不改），前一个 T 章的 `T5` / `T6` 已被占用 ⇒ 下面两节挂在 §T2 名下，编号取 `T2b` / `T2c`。MEMORY.md 里指向这两条的指针写的是 `§T2`。
### T2b ★★「关联好物」搜索页 = **同一个 Activity 的第二个窗口** ⇒ 备用通道看不到（2026-10-03 11:5x · 第二十四轮）

**现象**：用户在「货号搜索（关联好物）」页点「抓取页面结构」，出来的 `ui-dump-*.xml` 是**发布页**的骨架
（`publishPageLayout / etTitle / etTrendContent / tvRelevantProduct / tvPublish`），
而且 **65 个节点非空 text = 0、非空 content-desc = 0**；生成的 `uiMap-*.json` 13 步全 `unverified`。
用户当时**确实**停在搜索页（有截图：搜索框里就是货号、下面一屏商品卡）。

**两个原因，缺一不可**：

1. 那一屏 `uiautomator dump` 报了 `ERROR: could not get idle state.`（**失败时不写文件**，`ls` 验证过）
   ⇒ `dumpEx` 按设计降到 `dumpsys activity top`。
   ★★ **同类页面不是必然失败，是偶发** —— 同一屏隔几分钟用 `adb.dumpEx(serial,{pkg})` 连试 2 次
   （2294ms / 2283ms）**都直接成功**（`via=uiautomator`、`animOff=false`、54945 字节、17 条文字）。
   ⇒ 遇到坏结果**先重试一次**，再谈改代码。
   ★ 另验：把三项动画缩放缓到 0 后，原始 `uiautomator dump` 一次成功（55063 字节 / 17 条文字）；
   实验做完**必须还原成 1**（已还原）。
2. ★★ **「关联好物」搜索页是同一个 `TotalPublishProcessActivity` 的第 2 个窗口**（`dumpsys window` 里两条
   `Window{...TotalPublishProcessActivity}`），而 `dumpsys activity top` 给 duapp 这条 task **只有一段
   `View Hierarchy:`**，里面 `grep etSearch` = 0、`grep tvTitle` = 0 —— **搜索页在备用通道里根本不在场**。
   （唯一那处「关联好物」命中是发布页 Fragment 的 `mArguments=Bundle[{... title=关联好物}]`，别被它骗了。）
   ⇒ **只要降级到 dumpsys，抓到的就是「底下那一屏 + 没有文字」，而且会安静地生成一张不能用的表。**

**代码层可收紧点（已报告、未改）**：
- `dumpEx` 里「临时关动画再重试」那一档的门槛是 `if (last.idle && allowAnimOff)`，而 `last.idle` 只在输出里
  出现 `idle state` 字样时才 true ⇒ 那次若是**超时/空输出**，这一档被**跳过**直接掉 dumpsys。
  可放宽成「任何失败都试一次关动画重试」。（**复现不出用户那一次的原始输出**，故只算审查结论。）
- 走备用通道时只有**日志**说了「没有文字」，生成的 `uiMap-*.json` 里**没有标记** ⇒ 事后认不出来。

### T2c 「货号搜索页」真机结构（2026-10-03 11:55 好 dump：103 节点 / 17 条文字）

| 元素 | resource-id | bounds | 可点 |
| --- | --- | --- | --- |
| 返回 | `ivLeft` | `[0,36][90,126]` | ✓ |
| 标题「关联好物」 | `tvTitle` | `[90,36][810,126]` | ✗ |
| **搜索框** | **`etSearch`** | `[30,163][870,215]` | ✓ |
| 清空 × | `ivClear` | `[816,163][870,217]` | ✓ |
| 提示 | `tag_tips` | `[32,126][326,151]` | ✓ |
| 顶部页签「已购/想要」 | `tv_tab_title` | `[0,222][204,288]` | 父容器 ✓ |
| ★ **商品卡片根** | **无 id、无文字** `ViewGroup` | `[30,238][295,567]` | **✓** |
| 商品大图（卡片第 1 个子节点） | `ivProduct` | `[30,238][295,503]` | ✗ |
| 颜色/库存标签（如「米白色12」） | `tvCSpuInfo` | `[201,467][295,503]` | ✓ |
| 展开 | `tvCollapseStatus` | `[30,514][295,567]` | ✓ |

★★ **卡片根既无 id 也无 text/desc ⇒ `tapText/tapId/tapDesc` 三种找法都点不到它**（`STEP_ACTIONS` 只有 7 个动作，
也没有「按坐标点」）。绕法：点它第 1 个子节点 `ivProduct` 的**图心**（约 `162,370`）——落在卡片范围内，
Android 会把点击交给可点的卡片根；`tapId` 取第一个匹配 ⇒ **永远是第 1 个搜索结果**。
⚠ 这一页**没有任何 确定/完成/添加 按钮** ⇒ 「点一下即关联并关闭」只是**推断**，未实测。
⚠ `input` 动作**不点输入框**（只往当前有焦点的框发广播）⇒ 搜索框前**必须**单独插一步 `tapId etSearch`。

**产出**：`uiMap-实测-20261003-v2.json`（图文 16 步 / 视频 18 步），已用程序自己的
`uimap.normalizeSteps` 校验通过。

## U. ★★ 云端上行的「幂等头」是假的 —— 会让同步**永久卡死**（2026-10-02 深夜 · 第八轮 · **已修，未提交**）

### U1 现象与根因

App 上行（`cloudsync.js` 的 `postRows`）带的头是
`Prefer: return=minimal,resolution=ignore-duplicates`，建表脚本第 47~48 行的注释说它的用途是
「网络重试 / 重复同步不会产生重复行」。**实测：单独给这个头，一点作用都没有。**

| 试验（全部是对**已存在**的行重复插入，不会多出行） | 结果 |
|---|---|
| `POST /rest/v1/publish_log` + 那个头（**现 App 的发法**） | **409** + `23505`，响应里**没有** `preference-applied` ⇒ 偏好没被应用 |
| `POST /rest/v1/publish_log?on_conflict=machine_id,ts,seq` + 同样的头 | **201** ✅ `preference-applied=resolution=ignore-duplicates, return=minimal` |
| 同上但要正文（`return=representation`） | **201** ✅ |
| 无 `on_conflict` + `return=representation` | **409**（排除「是不是 `return=minimal` 的锅」） |
| `?on_conflict=id` | **409**（冲突目标必须与唯一索引的列一致） |

⇒ **PostgREST 的 `ignore-duplicates` 必须配 `on_conflict=<唯一索引的列>` 才生效。**

### U2 为什么这是「卡死」而不只是「一次失败」

`syncOnce` 的 catch（`cloudsync.js:258-266`）**不动 `st.offset`** ⇒
下一轮从**同一个 offset** 重发**同一批** ⇒ 又是 409 ⇒ **永远失败**（退避最多 5 分钟一轮）。
界面上只有「同步失败」四个字 + 一行 PostgREST 报错。

**会踩中的场景**（不需要刁钻条件）：
1. **插入成功但响应丢了**（超时）⇒ 重试同一批 ⇒ 行已在库里 ⇒ 409。
   ★ 本机实测该出口**间歇性**（同一请求一次 200、下一次超时）⇒ 这条很现实；
2. 同步游标文件被删 / 配置被重置 ⇒ 从第 0 行重发 ⇒ 老行已在库里 ⇒ 409；
3. 同一台机器两个实例共用一个 `machine_id`。

### U3 修法（**23:5x 已改完**，等与新功能一起发；只动了 `cloudsync.js` + `cloudtest.js`）

两处，**缺一不可**：

```diff
- await fetch(url + '/rest/v1/publish_log', {
+ await fetch(url + '/rest/v1/publish_log?on_conflict=machine_id,ts,seq', {   // ① 补冲突目标
```
② `postRows` 加**逐行兜底**：整批 409 时不再直接判失败，而是一行一行重发（已存在的跳过、新的补上）。
★ 判据**只认 `409 + 23505`** —— 409 但 code 是 `42P10`（没有匹配的唯一约束）照旧判失败，
否则会把真错误当「已存在」吞掉、**静默丢数据**。

★★ **反直觉但实测确凿**：只去掉 `on_conflict` 而保留兜底 ⇒ 端到端**全绿**（整批 409 → 逐行也 409
→ 全被当「已存在」跳过 → 4 行都算成功）。**缺的那一半是「兜底」，不是 `on_conflict`**；
v1.0.5 卡死是因为两半都没有。⇒ 断言也要分两条：一条焊**请求形状**（URL 含 on_conflict），
一条焊**行为**（409 时兜底、游标前进）。

**实测数字**（2026-10-02 23:5x）：cloudtest **49 → 57 项**全绿；全量十六套 **872 项全绿**；
定点破坏 3 条分别红 **2 / 7 / 3** 条、md5 还原一致；真库端到端首推 4 行 ⇒ 表 **1 → 4**（只多 3 行）、
删游标整批重推 4 行 ⇒ 表 **4 → 4**、`offset=4`；还原成 v1.0.5 发法 ⇒ 端到端 **6 条红**（`offset=0` 不动）。
脚本：`D:\work\_e2e\_breakverify-cloud2.py`、`_supa-e2e-cloudsync.js`、`_e2e-vs-v105.py`。

### U4 「只用 anon key 验 RLS / 唯一索引」的正确姿势（本轮方法，可复用）

1. **insert 策略必须正反向都打**：只做负向是**假通过** —— 「被拒」既可能是策略在卡 org，
   也可能是**谁都插不进去**（缺 grant / 压根没策略），两者给同一个错误码。正向成功才证明策略**按 org 区分**。
2. **测 update / delete 之前，先确保表里有一行与过滤条件匹配的记录**，
   否则「改了 0 行」是**空==空**，什么都证明不了。（本轮是先插 1 行探针，再打 PATCH / DELETE。）
3. **唯一索引的真凭据**：裸重复插入 → `409 + 23505 + duplicate key value violates unique constraint "publish_log_dedup"`
   —— 数据库**自己把索引名报出来**（索引不暴露在 REST 层）。
4. **旁证**：被 RLS 拒的插入**会消耗 identity 序列**（探针行 `id=2` 而不是 1）
   ⇒ 说明它走到了 `with check` 才被拒，不是卡在权限层。
5. 探针行要**自带标识**（`machine_id='__probe__conn__'`、`machine_name='⚠ 连通性探针（可删）'`、`ts=0`），
   验完交一句 `delete` 给用户 —— anon 没有 delete 权限，自己删不掉，**而这本身就是要验的结论**。

**本轮实测数字**：错 org → `401 + 42501` 且行数不变；正 org → `201`；PATCH / DELETE 各返 `200 []`
且复核数据未变；裸重复 → `409 + 23505`。脚本：`D:\work\_e2e\_supa-probe.js`（写 1 行探针）、
`D:\work\_e2e\_supa-idem.js`（零新增行）。

---

## V. 看板（`web/board.html`）：零 CDN 依赖 + 部署地址（2026-10-03 第十轮）

### V1 为什么必须内置 SDK
原实现是 `await import('https://esm.sh/@supabase/supabase-js@2')` —— **打开看板的人的网络必须能连 esm.sh**，
连不上整页只剩「加载 SDK 失败」。本机能连 ≠ 同事能连。既然要发给别人 / 部署到网上，这一环必须自己带。

### V2 做法（两份文件，改一处就得同步另一处）
| 位置 | 内容 |
|---|---|
| `web/vendor/supabase.js` | `@supabase/supabase-js` **2.117.2** 的 UMD 构建，217945 字节，文件头 `var supabase` |
| `web/board.html` | `<script src="./vendor/supabase.js">`（普通 script，解析期执行）→ `window.supabase.createClient(...)` |

- 下载源：`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js`
- sha256：`59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd`
- ★ **版本号别靠 grep 猜**：bundle 里同时出现 `2.0.0` / `2.97.0` / `2.117.2`，
  真版本是 **2.117.2** —— 以运行时日志 `GoTrueClient@... (2.117.2)` 报出来的为准（我第一次就写错成 2.97.0）。
- 必须留守卫：SDK 不在就抛明确文案，否则报出来的是 `Cannot read properties of undefined`，没法查。

### V3 部署
- 产物目录 `E:/WORKBUDDY/2026-09-30-17-35-35/board-site/`：
  `index.html` ← `web/board.html`、`vendor/supabase.js` ← `web/vendor/supabase.js`（逐字节 `cp`，部署后 md5 与源一致）。
- 当前网址 **https://dcf9a696225c47818c3b56816ae8b19e.app.workbuddy.host**（CloudStudio 沙箱静态站）。
- ★ **它不是长期托管** —— 沙箱生命周期不归我控，别向用户承诺「永久有效」。
  要长期/自定义域名得另找静态托管；但产物目录是纯静态两文件，可以直接搬走。

### V4 断网闸门（自证「零第三方依赖」，可复用到任何前端）
用 `session.webRequest.onBeforeRequest` 把除 `file://` 与 `*.supabase.co` 外的一切请求 `cancel`，再看能不能渲染。
三条断言缺一不可，且**必须做反向验证**（换回 CDN 写法 ⇒ 必须红）。完整做法与实测见技能
`headless-ui-selftest` 的「线上部署校验 → 断网闸门」段。

### V5 首包慢十倍（会伪装成「代码坏了」）
跨网络到 supabase 的**第一个请求实测 8643ms**，之后 748 / 756 / 379ms。
等待窗口开 20 秒 ⇒ 基线卡在「读取中…」假红。窗口开到 60 秒 + 每 5 秒主动补点一次刷新。

### V6 安全边界（讲清楚，别让人以为「只有自己能看」）
- 拿到 URL 的人**都能读**：anon key 本就是公开设计（App 内置、看板预填），RLS 只放 select。
- 想要真访问控制 ⇒ 得上 Supabase Auth（登录后读）或服务端代理；**静态页 + 前端口令挡不住人**。

### V7 交付物与脚本
- 交付：`board-site/`（部署产物）、`D:\work\_e2e\_board-live.png`（线上截图）
- 脚本：`_board-offline.js`（断网闸门渲染检查）、`_board-offline-break.py`（反向自证 2 条破坏）、
  `_board-live.js`（线上真浏览器渲染 + 截图）

## W. 文案「看图写」+ 带时间戳的 AI 内容报告（2026-10-03 第十一轮）

用户原话：「点击文案生成后，你应该在该文件夹生成一个全新的带时间戳的 ai 报告，以便后续校验文案、货号、颜色是否一致」、
「你现在都是根据货号和颜色生成的标题，一看就是 ai 做的，不真实」。

### W1 ★★ 本仓换行符是混用的（实测，别再靠印象）

| 换行符 | 文件 |
| --- | --- |
| **LF** | `src/main/services/copywriter.js`、`src/main/store.js`、`tools/copytest.js`、`tools/brandtest.js` |
| **CRLF** | `src/main/jobs.js`、`src/renderer/app.js`、`tools/run-all.js`、`tools/uicheck.js`、`README.md`、`docs/HANDOFF.md` |

- 判换行符只能用 Python：`io.open(p, newline='').read()` 后数 `s.count('\r\n')` 与 `s.count('\n')`。
- ★★ **`grep -c $'\r' <file>` 会谎报**：`$'\r'` 在层层引用里会被吃成**空模式** ⇒ 匹配全部行，
  看上去「CR 数 == 行数」就像个 CRLF 文件。本轮因此把 LF 的 `copywriter.js` 当成 CRLF 查了半天。
- 补丁一律写成 `.py`，并**自动探测目标文件的换行符**后再拼锚点：
  `nl = '\r\n' if s.count('\r\n') > (s.count('\n') - s.count('\r\n')) else '\n'`，然后 `old.replace('\n', nl)`。
- ★ 补丁脚本必须**先全校验、最后才写盘**（本轮两次 assert 失败都因此**没污染源码**）。
- ★ 多行**字面量锚点不可靠**（经过编辑器/工具链被动过就匹配不上）⇒ 改成**按行索引定位**。
- ★ `Write` 工具会把 `\uXXXX` 当**字面量**保留（不解码），而写真实中文就是真实中文 ——
  两种都能跑，别因为 `grep` 查不到就以为文件没写对。

### W2 文案生成的硬约束（改这一块前必读）

- ★★ **标题必须来自图里真看到的东西**：`imagePartsOf()` 把实拍图缩到 `imageMaxSide` 内、JPEG base64、
  **不落盘**发给模型（最多 `imageCount` 张）。没图时**必须改口**，不许编造图里才看得见的款式细节。
- ★★ **模型连不上 = 禁回退本地模板**：`preflight()` 不通过就**报错停下、一条都不发**；
  要用模板就把开关明确改成「本地模板（离线）」，那时报告里**逐行**写 `genSource: '本地模板'`。
  （旧行为：抛异常 → catch → **静默**填模板 → 界面显示「已生成」。这就是用户投诉的根源。）
- ★★ 接口地址 / 模型名**留空 = 跟随内置**（`src/main/llmdefaults.js`：只有地址与 id、**无凭据**），
  读时兜底、**绝不写回 `config.json`**（写回 = 固化，以后换服务商顶不动）。
- 模型名要**按 `/models` 清单解析**（id 精确 → 显示名归一化 → 内置兜底 id），并从 `input_modalities`
  **读回收不收图**。实测：用户填的 `deepseek v4.1 flash` 直接 **HTTP 400**；
  真认的是 `deepseek-flash`（`input_modalities` 含 `image`）与 `deepseek-v4-pro`（只有 `text`）。
- ★ **模型会把换行写成字面的 `\n`**（真机 3 条里 1 条中招），发到得物是**死文本**
  ⇒ `unescapeNewlines()` 统一还原；且**全角标点与 emoji 一个都不许动**。
- ★ `extractJson` 必须**先按原样 `JSON.parse`**，失败才退到宽容替换 ——
  旧版**无条件**把 `，`→`,`、`：`→`:`，会把模型写的中文标点全改成半角。
- ★ 正文尾巴上的 `#话题` 要摘掉（得物那边话题是**独立格子**，重复那串点不动）；
  话题 token 必须「**遇标点就停**」，否则 `#小故事，讲给你听。` 会被整段删掉。

### W3 报告与一致性核对

- 落点：**本批素材文件夹**（`args.sourceDir`）；写不进去才退到 `输出目录/batches/<批次>/` 并**如实告警**。
- 文件名 `<品牌>_AI内容报告_<YYYY-MM-DDTHH-mm-ss>.xlsx`（秒级；`uniqueFile()` 同秒加 `-2`，**绝不覆盖**）。
- 前 8 列与上游《KIDS_AI内容报告》**逐字对齐** ⇒ 能被 `report.readReport` **反向导入**（写完自己读一遍自证）。
  附加列 `生成来源 / 文案核对 / 图片主色 / 批次 / 生成时间` 读取器直接忽略；第 2 张表叫 `列说明`（不叫「报告」，不干扰导入）。
- 核对在 `src/main/services/copycheck.js`，分 `bad`（客观错）/ `warn`（要人看）/ `ok`：
  ① 货号混进文案 → bad；② 模板套话 → bad；③ 标题字数/emoji；④ 正文长度；
  ⑤ **标题里的颜色** ↔ 货号声明颜色；⑥ 图里实取主色 ↔ 声明颜色。
- ★★ **⑤ 只能扫标题，不能扫正文**：正文里出现别的颜色是**正常的**（「黑色小熊刺绣」「搭一条浅蓝牛仔裤」），
  实测按正文全扫会把一条完全正常的文案误判成「颜色不一致」。
- ★ 色名要支持**电商叫法**（词表里没有「冠军白」，退一步认它含的基础色词 → 白系），否则那一列全推给人工。
- ★★ **「图片主色」是整张图取的，浅色背景会压过主体**：实测「雾霾蓝」羽绒服（背景百叶窗 + 白墙）测出「银」，
  于是报 `warn 需人工确认`。这是 **warn 不是判决** —— 不拦发布、也不改文案。
  **改法至少两种、且没有数据说哪种更好 ⇒ 没改**，留待下轮拿真机样本量过再定。**别当 bug 重修。**

### W4 自证口径（本轮实际数字）

- `node tools/run-all.js`：**17 套 947 项全绿**（2026-10-03 复测已到 **970 项**，见 §X5）；新增 `tools/copytest.js` **69 项**。
- copytest 的核心断言是**图真的发出去了** —— 起**假模型服务**收请求 → 解 base64 → `jpeg.decode` 出 160×160，
  不是「源码里有 `image_url` 这几个字」；第 ⑫ 段是**行为级**：让假模型真回一段带字面 `\n` 的正文，看**落盘的 `copy.json`**。
- 定点破坏 **14/14**（`D:\tmp\ai\break.py`，逐字节还原）。B13「不还原字面 `\n`」→ 红 1；B14「换行归一漏一半」→ 红 2。
  破坏前源码 md5 `c792b6064b68f03d0b35da14c750b89b`（`copywriter.js`）。
- 真机实测（真照片 + 真 key + 真模型，走**界面同款** `jobs.run('copy.generate')`）：
  `蓝灰横向绗缝立领羽绒，左胸刺绣🐻` / `卡其立领夹克 斜拉链口袋带刺绣🧥` / `燕麦色圆领毛衣配浅蓝直筒牛仔🧶`。
- 本机配置（用户拍板「内置默认地址 + 本机也填上」）：`endpoint` → `https://api.deepseek.com/v1`、
  `model` → `deepseek-flash`；备份 `/d/tmp/ai/cfg/config.before.json`，`diff` 确认**只动 `copy.llm` 一块**。

## X. 货号/颜色按叶子文件夹名补齐 + 主题默认浅色 / 切换按钮搬到顶栏（2026-10-03 第十二轮）

> 用户原话：「你把素材来源、生成的文案导入到这份文件中后，需要对叶子文件夹的名字对文件中的货号、颜色进行填充（以+号为分隔）。你全都填充完后，运营检查（也可导入到货号颜色检查，这一步可选做）→没问题，从模拟器发布的入口导入，选择发布间隔时间，点击开始发布。这才是正确的流程。」
> 「app颜色默认为浅色，并把设置中调整颜色的地方放到app最上面，项目左边，点击即可切换浅色、深色。」

### X1 ★ 用户定义的「正确流程」四步（界面的入口按这个摆，别自己发明）

| 步 | 谁做 | 做什么 | 界面对应 |
| - | ---- | ------ | -------- |
| ① | 工具 | 素材整理 → 文案生成 → **落一份带时间戳的 AI 内容报告**（在素材文件夹里） | 「AI 文案」页 |
| ② | 工具 | 导入报告时，用**叶子文件夹名 `货号+颜色`** 把报告里空着的「好物1_货号 / 好物1_颜色」补上，并**写回 xlsx** | 「模拟器发布」页 →「导入 AI 内容报告」 |
| ③ | 运营 | 人工检查（**可选**：再导入「货号颜色校验」核一遍） | 「货号颜色校验」页 |
| ④ | 工具 | **从「模拟器发布」的入口**导入报告 → 选发布间隔 → 点开始发布 | 「模拟器发布」页 |

★ ③ 是**可选**的，不是必经；④ 的入口必须挂在「模拟器发布」页
（`TABS[6].actions` 顶部、**在「连接模拟器」之前**），不能只挂在别的页面上。

### X2 ★★ `flatten.parseName` 的 `how` —— 「这个文件夹名到底可不可信」的唯一判据

老实现在扁平副本上会**把去重后缀当成颜色**。实测
`…\flat_20261001-0132\26FW-YB160+冠军白_1` ⇒ `{"color":"冠军白_1"}`（同分钟重跑还会接出 `-2`）。

新增 `stripTail(name)`：**只摘「分隔符 + 纯数字」结尾、最多两层**（先 `-2` 再 `_1`）：

```js
const m = head.match(/^(.*?)[_-](\d+)$/);
```

⇒ `冠军白` / `黑色条纹` 不误伤；`米白2`（数字是颜色名的一部分）**不摘**（实测确认）。

`parseName` 每个分支都返回 `how`：

| `how` | 长这样 | 能否填报告 |
| ----- | ------ | ---------- |
| `'plus'` | `26FW-YB160+冠军白` / `…+冠军白/1/` | ★ **只有它** |
| `'split'` | 老式三层 `货号\颜色\1` | 否 |
| `'guess'` | `品牌甲\20260904\IMG_5253\1` → 货号=20260904 / 颜色=IMG_5253 | 否 |
| `'name'` | 单层名字 | 否 |

★ 最后一档**故意不摘后缀**：`IMG_5253` 摘成 `IMG` 反而**更像真的货号**。

### X3 ★★ `report.fillGoodsFromLeaf` 的三条线（报告是运营的账本）

1. **只认 `how === 'plus'`** —— 不 `plus` 一律不填 sku/color（宁缺勿错）；
   `items` 的叶子兜底同样限 `how === 'plus'`。
2. **只填空格子、不覆盖**：已经填了的值**一个都不动**。
3. **对不上就不补、只点名**：报告货号 ≠ 叶子名货号时，两边都不改，
   记进 `filled.mismatch` 并在日志里写清「第 X 行：报告 A / 文件夹 B」。
4. 补出来的值**写回 xlsx**：`report.fillGoods(file, fills, meta)` 写
   `好物1_货号` / `好物1_颜色`，**每格再判一次 `!cellText(...)`**；
   被 WPS 占用 → `{ busy: true }` + **如实告警**（本次发布仍用补出来的值）。
   ★ 写回**不占用**「实际执行时间 / 执行结果」那条暂存队列。

`copycheck.check()` 最前面另加第 ⓪ 条：有货号没颜色 → `warn`；连货号都没有 → `bad`。

### X4 ★★ 主题：只有两档；应用时机比写法更要紧

- `window.normTheme(v) { return v === 'dark' ? 'dark' : 'light' }` ——
  老配置里的 `'system'` **按浅色算**（反过来写会让 `system` 落进缝里、又变回跟随系统）。
- 出厂 `ui: { theme: 'light' }`（`store.js`，原为 `'system'`）。
- ★ **必须在建窗口之前应用**：`index.js` 的 `store.load()` → **`winmod.applyStoredTheme()`** → `project.load()`。
  窗口底色 `bgColor()` 就是按它算的，晚了会在深色系统上先闪一块近黑。
- ★★ **`theme:get` 必须再做一次幂等归一**：只报 `themeSource` 不够 ——
  `nativeTheme` 还是 `'system'` 时 `shouldUseDarkColors` 会跟着 Windows 走，
  于是「`themeSource=light`」与「界面是深色」**同时成立**（**真窗口自检抓到的**，不是推理）。
- **图标不换 `innerHTML`**：两个 SVG 都在 DOM 里，`styles.css` 按 `html.dark` 决定显哪个。
- 位置：`index.html` 的 `.chips` 里、`#chipProj` **之前**，`data-act="theme:toggle"`；
  设置页「外观」整块删掉，只留一句「切换按钮在最上面标题栏、「项目」左边」。

### X5 实测数字与自证

- 全量回归：**17 套 970 项全绿**（2026-10-03 01:45 复测）。
- 定点破坏 `D:/tmp/ai/break2.py`：**25 条（B1~B25）全被抓到**，逐字节还原 + md5 核对通过；
  日志留档 `D:/tmp/ai/break-log2.txt`。
- 新增断言：`reporttest` ⑫ 段 8 条、`batchtest` ⑦ 段 3 条、`copytest` ① 段 2 条、`uicheck` 10 条。
- ★ 本轮三个「假绿」坑（断言抛异常 / `ELECTRON_RUN_AS_NODE=""` / 「CRLF 数不变」）见技能
  `win-sandbox-scripting` §17。


## Y. 标题改成「产品词 + 热门词」词包（2026-10-03 第十三轮）

> 用户原话：「你这个标题就是纯描述产品是什么，我要的是产品+热门词:羽绒服+简约百搭、羽绒服+韩系氛围感、
> 羽绒服+灰色慵懒风、羽绒服+美式学院风、蓝调穿搭+羽绒服、冬日神器+羽绒服。类似这种，你这个太单调了。
> 我不是已经内置了文案提示词吗」

### Y1 ★★ 根因：**不在模型，在我们的提示词**（两条叠加）

| # | 因 | 证据 |
| - | -- | ---- |
| ① | 上一轮把标题钉成「品类 + 看得见的款式特征 + 颜色 + 风格词」，模型**照做** ⇒ 必然是商品描述 | `copywriter.buildSystem` 的 `see`；真机实测 `蓝灰横向绗缝立领羽绒，左胸刺绣🐻` |
| ② | 品牌提示词写着「格式参考以下 **10 种多样化格式**创作」，**后面清单是空的** | `config.json` 的 `brands[0].promptWrite` 以「……禁止单一格式重复：」**冒号结尾就没了**（原文这段是张图） |

⇒ 模型既没有可挑的**词**、也没有可套的**形状**。

### Y2 内置热词库 + 10 种词包格式（`src/main/services/hotwords.js`，新文件）

- 7 类角色分组（40+ 词）：`风格` / `氛围` / `色感`（`{色}` 占位，用本行颜色套） / `场景` / `人群` / `季节` / `情绪`。
- 10 种格式 `T01~T10`，每行**轮换**（`styleOf(i)`），由 `buildPlan` 分配、随 user 消息（`本行标题格式`）发给模型：
  `T01 单品+风格` / `T02 单品+氛围` / `T03 单品+色感风格` / `T04 单品+风格(另一路)` / `T05 色感词+单品` /
  `T06 季节热词+单品` / `T07 场景热词+单品` / `T08 人群感+单品` / `T09 情绪热词+单品` / `T10 三段词包`。
  ★ T01~T06 与用户给的 6 个样例**一一对应**。
- ★★ **三条边界**：① 热词只许风格/氛围/场景/人群/季节/情绪类，
  **材质与参数（鹅绒 / 充绒量 / 加厚 / 防风防水 / 羊毛含量）一律不许进词库**（图里看不出来 = 教模型造假）；
  ② **格式示例里不许写死值** —— 实测 T03 示例写 `羽绒服+灰色慵懒风`，真机跑一条**酒红**的货，
  模型把「灰」照抄进标题（`羽绒服+灰调高级感`）；改成 `{色}` 占位符 + 「示例里的颜色也要换成本行的颜色」才对；
  ③ `F01~F10`（本地离线模板）与 `T01~T10`（给模型的标题形状）**是两套东西**，别混。

### Y3 文案核对的口径（不误杀新标题）

- ★★ 新增 `declaredColorsIn()`：只有「颜色词**紧挨着单品词**」才算在声明这件衣服的颜色 ——
  「燕麦色圆领毛衣」算；「蓝调穿搭」**不算**（氛围写法）。颜色词后面紧跟「调 / 系 / 感」也一律不算。
- ★★ **删掉**「标题里没提到颜色 ⇒ warn」：`羽绒服+简约百搭`、`冬日神器+羽绒服` 这种好标题本来就不带颜色，
  留着它会把一整列标黄，而这一列的意义是「一眼看出哪几条要回头看」⇒ **全黄 = 没人看**。
  **颜色不是必须出现在标题里**；真正要防的是**写错颜色**（这条仍在查）。
- ★ **新增**：标题堆了 **3 个以上款式特征词**（`DESCRIPTORS`：绗缝/立领/刺绣/拉链/口袋/圆领/左胸/袖口…）
  ⇒ `warn 像商品描述`。为什么不去查「有没有热词」—— 模型会自己造词（「松弛感」「少年感」），
  拿内置词库比对**必然误杀**；数款式特征词是客观可复算的。被打回的原句正好命中 5 个。

### Y4 实测数字与自证

- 全量回归：**17 套 989 项全绿**（copytest 71 → 90）。
- 定点破坏 `D:/tmp/ai/break-title.py`：**10 条（N1~N10）全被抓到**（日志 `D:/tmp/ai/break-title-log2.txt`），
  逐字节还原 + md5 核对通过。
  ★ 第一轮只抓到 **6/10**，3 条 MISS **全是断言本身不够硬**（详见技能 `win-sandbox-scripting` §17.2 / `bilateral-fix-verification`）：
  - N2「标题约束退回描述」—— 破坏只改了首句，后文里还留着「产品词/热门词」字样；
  - N6「颜色声明退回旧判据」—— 断言只测了工具函数，**没测 `check()` 的行为**，换掉调用点抓不到；
  - N9「词库混进材质词」—— **根本没有这条断言**。
- ★ 断言里的宽松正则坑：`/T\d\d/` 会**误匹配货号 `26FWT75` 里的 `T75`** ⇒ 必须锚在 JSON 键上
  （`/"本行标题格式":"(T\d\d)/`）。见技能 `win-sandbox-scripting` §17.4。
- 真机实测（真图 + 真 key + 真模型，10 条覆盖 10 种格式）：
  `羽绒服+极简通勤❄️` / `蓝羽绒服+清冷感🌫️` / `羽绒服+酒红调慵懒风🍷` / `黑色羽绒服+clean fit 🧥` /
  `军绿调穿搭+夹克 🧥` / `换季刚需+卡其夹克🧥` / `通勤穿搭+卡其夹克 🧥` / `少年感+灰针织毛衣 🧶` /
  `温柔暴击+燕麦色针织衫 ☁️` / `驼色毛衣+老钱风+冬日神器🐻`。

### Y5 未做

- 热词库**只有内置的**，没有界面可编辑。要按品牌维护自己的词表，需要再加字段 + 弹窗。
- 没发版（`1.0.7` 未打）、没提交。

---

## Z. ★★ 标题＝「句式骨架」（`+` 只是示意，不许写进标题）+ 一个潜伏判错（2026-10-03 第十四轮）

> ★ **§Y 的「词包（A+B）」写法已被本节取代** —— 用户第九次打回：`+` 不能真的写进标题，且词包直贴有病句。
> 词库/文件位置不变，仍见 §Y；只把「怎么写标题」换掉。

### Z1 根因（两条，都在我们这边）

- **`+` 被当成了字面量**：用户样例 `羽绒服+简约百搭` 里的 `+` 只是「**哪类词跟哪类词合并**」的示意；
  我把它当成了标题的字 ⇒ `STYLES` 的 `sample` 全带 `+`，模型照抄，标题里就真出现 `+`。
- **词包直贴 = 标签串**：`少年感` 直接贴 `灰针织毛衣`，没有收尾 ⇒ 读着有语病。
  用户给的正例都补了「成句的迹象」：`少年感灰针织毛衣太帅了`（收尾）、`军绿调穿搭夹克 松弛感拉满`（空格断句）。

### Z2 改法

- `hotwords.STYLES` 从「词包公式」改成「**句式骨架**」（T01~T10 数量不变，每条自带连接字或收尾）；
  新增「**收尾**」词组（12 词，含用户要的 `太帅了`）。⇒ 这是**结构上的防病句**。
- 示例两条铁律：**不许有 `+`**、**不许写死颜色**（颜色位一律 `{色}`）。
  写死了模型会照抄 —— 实测示例写「灰」、跑一条酒红的货，输出「羽绒服+灰调高级感」。
- 提示词**两处**（`buildSystem.see` + `hotwords.promptBlock()`）写明「标题里一个字都不许出现 `+`」+ 给病句反例/正例；
  每行 user 的 `本行标题格式` 也带一句「不许出现 + 号」。
  ★ 同一缺陷有多个来源时，定点破坏要**把两处一起拆**（只拆一处断言仍绿）。
- `copycheck` 新增两条告警：⑧ 拼接符号（`+ ＋ ﹢ & | ｜ · •`）；⑨ 标签串（启发式，见 Z3）。

### Z3 ⑨ 标签串判据与边界（容易改坏的四个常量）

- 三条**同时**成立才报：① 以「前缀热词」（风格/氛围/色感/人群/情绪/季节/场景 组）开头；
  ② 以 `GARMENTS` 单品词结尾；③ 全文没有 `LINKERS`（连接字）也没有 `PASTE_SEP`（标点/空格），且 `textLen ≥ PASTE_MIN_LEN(6)`。
- `LINKERS` 故意**不收「搭」**（「简约百搭」「穿搭」里都有它，收了会大量漏判）；**判不出来的宁可不报**。
- **已知过报（属预期）**：`简约百搭羽绒服` 这种名词短语也会被提醒补收尾 —— 是提醒不是判决，不拦发布。
- 反向对照必测：用户给的两个正例必须**不**被点名（只测「病句被报」＝只验负向＝假通过）。

### Z4 顺手修掉一个潜伏判错（不是本轮引入）

- `hasEmoji` 用**带 `g`** 的 `EMOJI_RE` 做 `.test()`；带 `g` 的正则 `.test()` **会推进 `lastIndex`** ⇒ 连判两次一真一假。
  实测证据：10 条真机标题全带 emoji，连着判一遍报出「4 条没有 emoji」；单条连判 4 次得 `true false true false`。
- 产品里恰好没露头（`check()` 里 `hasEmoji` 前面刚调 `textLen()`，而 `replace(带 g 的正则)` 会把 `lastIndex` 归零）
  ＝**定时炸弹**：任何新调用点连判两次就判错。
- 修：判「有没有」改用**不带 `g` 的副本** `EMOJI_TEST_RE`；`stripEmoji` 继续用带 `g` 的做替换。
  断言要**正反两条**（带 emoji 连判 4 次都 true；真没 emoji 连判 4 次都 false）—— 否则可能修成「恒 true」。

### Z5 数字（实测）

- 全量回归 `node tools/run-all.js`：**17 套 1006 项全绿**（copytest 90 → 107，+17）。
- 定点破坏 `D:/tmp/ai/break-sentence.py`：**17/17 全被抓到**，逐字节还原 + md5 核对通过。
  ★ 上一轮的 N1~N10 **锚点因本轮改动全部失效**，已重锚并**一起重跑**（不是只跑新增的 7 条）。
- 真机 10 条（真图+真 key+真模型）：**带 `+` 的 0 条 / 判标签串的 0 条 / 没 emoji 的 0 条 / 超 15 字的 0 条**。
  样例：`少年感雾蓝羽绒服太帅了 🧊` / `蓝调羽绒服 清冷感拉满 ❄️` / `通勤就穿军绿夹克🧥` /
  `换季刚需卡其夹克，通勤很能打🧥` / `燕麦色针织衫才是入冬的答案🧶`。
- 报告里 7 行 `warn` 仍**全部**是已知「图片主色」误报 + 那批数据**故意**同图配不同色（与判据无关）。

### Z6 未做

- 没发版（`1.0.7` 未打）、没提交。
- 词库 / 句式表**只有内置的**，无界面可编辑。
- ⑨ 是启发式：只求抓住用户实测那类，**判不出来的不报**（宁可不报也不误杀）。

### Z7 溯源：这 10 种是怎么来的 + 要加第 11 种得动哪些地方（2026-10-05 查明）

- **10 不是「跑数据统计」出来的，是两段拼的**：
  ① **数字 10 来自用户原文** —— 品牌提示词里那句「格式参考以下 **10 种**多样化格式创作」，
     但那 10 条的清单**本身是张图**，纯文本没带过来（这就是第一代根因 ②）；
  ② **内容里 T01~T06 ＝ 用户第七次给的 6 个样例**（`羽绒服+简约百搭 / +韩系氛围感 / +灰色慵懒风 /
     +美式学院风 / 蓝调穿搭+羽绒服 / 冬日神器+羽绒服` —— 那 6 个本身就是 6 种「角色 × 语序」组合），
     T07~T10 是按 7 类角色（风格/氛围/色感/场景/人群/季节/情绪）**枚举补齐**的。
  ⇒ ★ **第八次重排后，「6 个样例 ↔ T01~T06 一一对应」已不成立**：样例现在散在 T01~T08、顺序也变了
    （第一代 T01「单品+风格」对应用户的「羽绒服+简约百搭」；现在 T01「人群感+单品+夸一句」对应的是
     用户第八次给的正例「少年感…太帅了」）。`hotwords.js` 文件头那句「T01~T06 与用户给的 6 个样例一一对应」
     **是第七次那一版的事实**（分段按时间写在讲历史），但**读起来像在说现状** —— 改注释时别被它带偏。
- ★★ **真正的瓶颈不是骨架数量，是「一批几行」**：`buildPlan` 用 `styleOf(i)` ＝ `i % STYLES.length`
  （默认 `F01-F10 轮换`；`copy.rotateStrategy='随机'` 才随机挑）⇒ 一批 N 行最多只出 `min(N, STYLES.length)` 种形状。
  **一批 6 行时，加到 12 种和现在的 10 种完全一样**（都只出 T01~T06，T07 起永远轮不到）。
  加骨架只提高**大批次（≥ 骨架数）**的多样性上限。
- ★★ **实测（2026-10-05，台账 `C:\Users\Administrator\输出\得物\run-log.jsonl`，24 个 `copy.generate` 任务）**：
  一批篇数分布 ＝ **1 篇×2 / 3 篇×8 / 10 篇×6 / 30 篇×8**（平均 13.6，最大 30）。
  ⇒ **30 篇的批 → 14 种全都会出现**（30＝2×14＋2 ⇒ 每条出现 2~3 次，数量略不均；10 种时正好每条 3 次）；
  **10 篇的批 → 行号只到 9，正好停在 T10，新加的一条都看不到**。
  ⇒ 结论：**日常若就是 10 篇一批，「加」等于白加，该做的是「换」** ——
  用新形状**替换**现有 10 条里较弱的几条，10 篇的批立刻就能用上。
- ★★ **「加骨架」的闸门实测值（2026-10-05）**：`TITLE_MAX = 15 字`（`copycheck.js:45`）。骨架 `sample` 本身**不受 TITLE_MAX 断言约束**
  （断言只查 `+` 与写死颜色），但**照超长 sample 写出来的产出会被 warn** ⇒ sample 超 15 字等于埋坑。
  现有 `copycheck` **没有**「标题必须含单品」的判据 ⇒ **无单品的骨架不会被 warn**（属口径变化，需用户拍板）。
- 加一条骨架要**连着改 6 处**（少一处就红，或者界面/文档骗人）：
  ① `hotwords.js` 的 `STYLES` 数组；② 同文件 `promptBlock()` 里硬写的 `【10 种标题句式】`；
  ③ `renderer/app.js:1429` 与 `:1445` 界面上硬写的「10 种」（**两处**）；
  ④ `tools/copytest.js:484/485/487`（`STYLES.length === 10`、`styleOf(9).code === 'T10'`、`styleOf(10).code === 'T01'`）；
  ⑤ `tools/copytest.js:858`（⑬ 又钉一次 `length === 10`）；⑥ `docs/visual/build.js:64` 文案 ＋ README/HANDOFF 的「10 种」描述。
  `tools/uicheck.js:271/284` 只查 `/T01/ && /T10/` 在不在页面上 —— **不动 T01/T10 的 code 就不会红**。
- ★★ 每条新骨架要过 **5 条闸门**（`copytest` ③b 那一组）：示例**不许有 `+`**；示例**不许写死颜色/单品**
  （`HARD_COLOR` ＝ `灰|蓝|黑|白|红|绿|黄|驼|燕麦|卡其|藏青|棕|粉|紫`，这 14 个字一个都不许出现，颜色位一律 `{色}`）；
  示例必须**自带连接字或收尾**（白名单正则 `的才是穿配带入在和与很超太真能要有会让给把自也都可好，, ` ＋ 空格）；
  **行为级**：`{色}` 代入真颜色后不许被 `copycheck.looksLikeWordPaste()` 判成标签串（这条才是「不是凑巧写了连接字」的真证明）；`code` 唯一。
- ★★ **最容易漏的一处**：新骨架若用了**新的连接字**，必须同步加进 `copycheck.js:173` 的 `LINKERS`
  —— 否则 ⑨ 标签串判据会把**正常产出**判成病句（假 warn）。`prefixWords()` 是从 `currentGroups()` 现取的，
  加骨架**不用动**它；但**新增角色组**要同步 `PREFIX_GROUPS`（`copycheck.js:180`）。
- 用户侧**永远加不了**骨架：骨架**不落盘**（`sanitizeLibrary` 只存 7 个可编辑组），界面只读展示
  ⇒ 只能改代码 ＋ 发版。这是刻意的红线（词＝素材、骨架＝语法）。
- 未实测、不写结论：骨架变多会不会**稀释模型注意力**（system 变长）—— 没测过。

### Z8 现状＝**T01~T15**（2026-10-05 一天里加了 5 条）+ 三个新踩的坑

- **现状**：`STYLES` ＝ T01~T15。当天分两批加：① 用户给的 4 条实发标题 → T11~T14（其中 **T11/T13/T14 故意不带单品**，
  口径从「必须说清这是什么衣服」松到「可以只写穿搭感」）；② 用户再补 1 条得物笔记标题 `韩系叠穿💙💙蓝色好有少年感` → **T15**。
- ★★ **改动面已从 6 处变成 10 处 / 7 个文件**（§Z7 里那份 6 处清单已过期）：
  `hotwords.js`（`STYLES` ＋ `promptBlock` 硬写的「N 种」＋ 不带单品名单 ＋ 注释 ×3）、
  `copywriter.js`（**emoji 指令那两句** ＋ 不带单品举例 ＋ 注释）、
  `renderer/app.js` ×3（两处「N 种句式骨架（T01~TN）」＋ 注释）、
  `tools/copytest.js`（3 处计数 ＋ 4 处文案 ＋ 新断言）、`tools/uicheck.js`（`/T14/`→`/T15/` 与文案）、
  `docs/visual/build.js` ＋ `README.md`。**另外 `store.js:65` 注释里的 `T01~T10` 仍是旧的**（属另一路会话在改的文件，没动）。
- ★★★ **坑 1（真会打架）**：`copywriter.js` 两句写着「**结尾 1 个**贴合的 emoji」（看图分支 `:482` ＋ 无图分支 `:497`）。
  T15 是「**两个 emoji 夹在句中**」⇒ 不同步改这两句，模型会收到**互相矛盾**的指令（实测这轮就是靠通读发现的，不是跑出来的）。
  以后凡加「带 emoji 的骨架」，先 grep `copywriter` 的「emoji」。
- ★★★ **坑 2（会产出病句）**：`{色}` 是**模型自由代入**的，**不是程序替换**（`copywriter.js:544` 把形状示例整条丢给模型）。
  而本行颜色名**本身可能带「色」字**（实测数据里就有 `冠军白 / 樱花粉 / 光子灰 / 花灰色（加绒）`，见 `colors.js` 的电商叫法兜底）
  ⇒ **示例里禁写 `{色}色`**（会产出「燕麦色色」）。T15 因此写成 `{色}系`。
- ★★ **坑 3（数 emoji 会数重）**：`copycheck.EMOJI_RE` 的字符类**包含 `\u{FE0F}`**，所以 `❤️` 会被算成 **2 个**
  （心 ＋ 变体选择符）。`copytest` 里要判「一个骨架有几个 emoji」必须用**不含 FE0F** 的字符类。
- ★★ **T15 的颜色 → emoji 覆盖率（实测 `colors.LEXICON`，26 条色名）**：**24 个有、只有 `灰` / `浅灰` 没有**
  （爱心 ❤️🧡💛💚💙💜🖤🤍🤎 与圆圈 🔴🟠🟡🟢🔵🟣⚫⚪🟤 **都没有灰色**；`🩶` 是 Unicode 15 / 2022 才加的，
  老机型显示成豆腐块）⇒ 口径：**本行颜色是灰 / 浅灰时别用 T15，退回 T13**（提示词里写死）。
  ★ **2026-10-05 16:22 用户已拍板认下这个口径**（不用 ⚪/⚫ 硬凑、也不接受 🩶 豆腐块）⇒ 后续别再来回改。
  ★ `colors.coarse()` 会把 `棕/卡其/驼/米/燕麦色/流沙金` 都判成「橙」（hue<45）⇒ 映射表里为暖棕系写了**例外**（→🤎/🟤）。
- ★★★ **反向自证的新发现**：`length === N` ＋ `code 唯一` **抓不到「改号」** —— 把 `T15` 改成 `TXX`，
  长度还是 15、code 也不重复，两条例行断言**全绿**（定点破坏 G 组实测暴露）⇒ 已补一条「**code 必须连续 T01…TN**」。
- **断言数**：改前 `copytest` PASS 205（14 种）→ 改后 **PASS 213 / FAIL 0**（＋8 条）；`uicheck` 222 不动；
  全量 17 套 1610 项（唯一红的 `adbtest` 是**另一路会话在制品的中途快照**，单独重跑 392 项 0 红）。
- ★ 用户侧仍**永远加不了**骨架（不落盘、只读展示）⇒ 只能改代码 ＋ 发版（口径不变）。
- ★★ **2026-10-05 16:45 起已补上程序判据（⑩）**：`copycheck` 核对「标题里的彩色 emoji ↔ 文字色词」，
  对不上 ⇒ **warn**（只标黄、不拦发布）。五条设计取舍，全是实测出来的：
  ① 只认 **18 个无歧义的颜色符号**（9 爱心 + 9 圆圈）；`🍂🍁🔥🐻🧥✨🌿☕` 一律**不认** —— 认了「燕麦色毛衣🍂」会被误杀；
  ② 比对的色词取**标题里所有色词**（`colorWordsIn`），**不是** `declaredColorsIn` ——
     后者会把 `{色}系`（T14/T15 的写法）当氛围词跳过，而那正是要判的位置（定点破坏 B4 实测：换回声明色 ⇒ 判据静默失效）；
  ③ **灰 / 浅灰 → 允许集为空** ⇒ 灰那件出现任何彩色 emoji 都算对不上（这就是 T15 灰色例外的兜底）；
  ④ **橙 ↔ 棕 互认**：卡其/驼/米/燕麦色/流沙金 的 `colors.coarse` 都是「橙」（hue<45），
    不互认就会把**自己的合规写法**（🤎/🟤）判成错；⑤ 色词一个都认不出色系 ⇒ **不判**。
- ★ 判据**只在事后核对时标黄**，**拦不住**模型照不照做（`copywriter` 那边仍只有提示词约束）；
  报告里出现这条 warn 才算发现，别再写成「已覆盖」。

## AA. ★★ 正文＝「4~5 行短句」+ 话题来源统一 + 重复口径放宽（2026-10-03 第十五轮）

> 用户一次提四条：①热词库要不要做成可编辑（**只判断、没动界面**）②话题两条写法冲突（定口径）
> ③正文改成 4~5 行短句（附 5 张品牌官号实发笔记截图）④重复口径放宽到「只看相邻两条」。
> 涉及文件：`copywriter.js`（提示词 + 话题池）、`copycheck.js`（正文判据 + 批级重复）、
> `aireport.js`（批级结论进报告）、`app.js`（文案生成页三段 hint）、`tools/copytest.js`。

### AA1 正文格式：判据是「行数」，不是「字数」

- 格式：**4~5 行**、一行一句短句 **8~16 字**、行与行**真的换行**、全篇 **1~3 个 emoji 放行尾**。
- 常量化（`copycheck.js`）：`BODY_LINES_MIN=4` / `BODY_LINES_MAX=5` / **`BODY_LINES_SOFT_MAX=6`** /
  `BODY_LINE_MAX=26` / `BODY_EMOJI_MAX=4`；**`BODY_MIN` 从 60 下调到 30**。
- ★★ **为什么必须下调 `BODY_MIN`**：4~5 行 × 8~16 字 ⇒ 全文只有 **35~70 字**。旧的 60 字下限会把
  **完全符合新格式**的正文全判成「太短」⇒ 整列变黄。**改了格式必须同步改判据的度量口径**。
- ★★ **容忍值比死卡更重要**：只允许 4~5 行 ⇒ 模型写 6 行就标黄。这一列的意义是「一眼看出哪几条要回头看」，
  **全黄 = 没人看**。所以 4~5 行是要求，**6 行容忍**；真正要抓的是**又写成一整段**（1~3 行），
  那条**不受容忍值影响**（判据写成 `< 4 || > 6`，1~3 行照样命中）。
- ★★ **同一套格式规则的判据不能只对模型侧生效**：`localFill()`（本地模板，关模型时用的）**也必须 4~5 行**，
  否则「关掉模型」的产物会被自己的核对判成「没分行」（自相矛盾）。
- 单行 `> 26 字` ⇒ warn（＝又写成一整段）；全篇 emoji 为 0 ⇒ warn；`> 4` 个 ⇒ 提醒。
- ★ 数 emoji 必须 `new RegExp(EMOJI_RE.source, 'gu')` 自己起一份：`EMOJI_RE` 带 `g`，
  `.test()` 会推进 `lastIndex`，共用会和 `EMOJI_TEST_RE` 互相踩。

### AA2 话题：**以程序为准** —— 正文不带 `#`，话题进「话题1~5」格子

- 口径：**必带话题**留在「文案生成 → 批次设置」的 `copy.requiredTopic`（固定占话题 1~N）；
  **额外话题**从**品牌提示词的「话题列表」里抓 `#话题`**（`topicsFromPrompt()`，`/#[^\s#，。！？…]+/g` 按顺序去重）；
  两者合并写进发布单「话题1~5」；**正文一个 `#` 都不带**。
- ★★ **为什么以程序为准**：得物这边**只有格子里的话题才点得动**，写在正文里是死文本；
  而**格子里的话题在得物上本来就显示在正文后面** ⇒ 用户要的「正文最后带话题」**效果仍在**，只是由格子实现。
  ⇒ 「正文带 #」和「正文不带 #」这两条**不冲突**，前者可以整个删掉。
- ★★ **池子来源的优先级**：提示词里写够了（`fromBrand.length >= 本次要的额外个数`）就**只用它写的**，
  **不掺**设置页那排通用词。实测反例：第一版直接把两者拼起来，10 条里**后 3 条**滑进
  `#男生穿搭 / #OOTD / #秋冬新款`（用户根本没要）。
- ★★ **`wantExtra` 必须在读池子之前算**：`topicPool(brand, min)` 的第二个参数就是「这次要几个额外话题」，
  池子得先知道需求才好判「提示词写的够不够」。
- ★★ **`buildPlan` 必须在拿到 `brand` 之后调用**（`generate()` 里原来顺序反了）——
  否则池子读不到品牌提示词，会静默退回设置页通用词（现象＝「提示词里的话题根本没生效」）。

### AA3 重复：只看**相邻两条**，且**换 emoji 即算不同**

- 用户口径：同一品牌下只要 **emoji 不同**，文字完全相同也不要紧；只有**连续 2 条**一字不差才算重复；
  **跨品牌完全一致没问题**。
- 实现 `copycheck.checkBatch(rows)`（**批级** —— 单条函数看不到「上一条」）：只跟 `i-1` 比、
  **比原文（含 emoji）** ⇒ 换 emoji 就算不同；`i === 0` 不报。
- ★★ **批级判据不能只做成工具函数**：必须在 `aireport.write()` 里**真调一次**，把结论并进「文案核对」列
  （追加的 issue 一律 `warn`）。断言也必须**行为级**：让假模型回**一模一样**的标题/正文，看**落盘报告**里真出没出那句话。
- ★ 判断「与上一条一致」用**原文**，**不要归一化掉 emoji**（归一化 = 把用户放宽的口径又改回严的）。

### AA4 热词库可编辑（**只有判断，没动界面** → ★ 2026-10-03 已实现，见段末）

- 结论：**该单开一个模块**（别并进「文案生成」）。理由：它是**低频维护**、生成是**高频动作**；
  混一屏既容易误触生成，跑生成时又被词表挡路。
- ★★ **句式骨架（`hotwords.js` 的 T01~T10）禁做成可编辑**：词是**素材**、骨架是**语法**，
  骨架带「连接字在第几位、收尾在末尾」这类结构信息，用户改坏会**直接产出病句/标签串**，
  而判据只能**事后告警**，拦不住。⇒ 模块里只放 **8 组词**（风格/氛围/色感/场景/人群/季节/情绪/**收尾**）；
  **收尾词组算「词」**（可编可加），但**它填进哪条骨架的哪个位置由代码定**。
- 模块必带三条红线提示：① 材质/参数词（鹅绒/充绒量/加厚/防风防水）**不许进库**；
  ② 极限词、别的品牌名不许进；③ `{色}` 是占位符，保留它才会跟着本行颜色走。
- ★★ **「让模型读小红书/得物/抖音热词」不是「现抓」**，形态必须是
  「离线抓取脚本（定时）→ 落 `hotwords-<日期>.json` → 界面显示**来源与日期** + 逐词勾选/删除 →
  用户点『并入词库』才生效」，**默认不自动并入**。三条理由：① 无公开热词接口，爬就会被风控挂，
  挂了必须能**如实退回本地词库**（不许报错、更不许让文案没了）；② 直接塞提示词 = **不可控**
  （可能夹进营销词/极限词/别的品牌名，而它们恰恰是判据要 warn 的）；③ 它是**离线批处理**，
  不该跟「生成文案」这条链耦合。
- ★ 外网抓的词**没法验证真假** ⇒ **永远只能当风格/氛围/场景词**，不能当材质参数词 —— 与内置词库同一条红线。

- ★★ **2026-10-03 11:00 用户拍板：外网热词「先不做」** ⇒ 本期范围＝**只做「可编辑 + 恢复内置」**（§AA4 里那段
  「离线抓→审核→并入」**不进本期**，留档备用）。
- ★ **收尾组「在不在库里」与「算不算前缀热词」是两件事**（易混）：收尾组**在库内**（第 8 组，12 词，
  也喂给模型），但**不进 `copycheck` 的 `PREFIX_WORDS`**（它是抓「热词贴单品」标签串的名单，
  收尾天生在句尾，算进去只会误判）。实测：**全库 64 词 ＝ 45 前缀热词 ＋ 7 色感 `{色}` 模板 ＋ 12 收尾**。
- ★★ **「能不能转函数」＝能，成本极低**（全仓实测调用点）：`ALL_WORDS` 在 `src/` 里 **0 个**调用点
  （只定义＋导出，仅 `tools/copytest.js` 2 处用）；`PREFIX_WORDS` 在 `src/` 里 **1 个**真调用点
  （`copycheck.looksLikeWordPaste`），导出处全仓无人用。
  ⇒ 转函数只动 1~2 处；★ 但 **`PREFIX_WORDS` 的 `.sort(按词长倒序)` 必须保留**（漏了会让长词匹配不到）；
  `copycheck` 的 `PREFIX_GROUPS`（7 个组名）是硬编码，**不用动**（模块不允许新增组）。
- ★★ **「改了词库会不会被读到」＝看读取链有没有改成读 store**（2026-10-03 查清）：
  现状 `hotwords.js` 是 `const GROUPS` / `const STYLES`，`require` 后缓存、**无任何持久化读取点**
  ⇒ 在界面上编辑**不会**生效。要生效必须**同时**改动 **3 个读取点**，漏一个就静默不一致：
  ① `copywriter.js` 的 `hotwords.promptBlock()` —— 模型看到的词表，**标题实际用词的唯一来源**；
  ② `copywriter.js` 的 `hotwords.STYLES.length` / `styleOf(i)` —— 骨架轮换（骨架不可编辑，与 ① 读同一份）；
  ③ ★ **`copycheck.js` 的 `PREFIX_WORDS`**（由 `hotwords.GROUPS` 派生）—— **最容易漏**：
     生成用了用户新加的词、核对还在用内置旧表 ⇒ **误报「标签串」或漏报**。
- ★★ `ALL_WORDS`（`hotwords.js`）与 `PREFIX_WORDS`（`copycheck.js`）都是**「`require` 期」算好的常量**
  ⇒ 即便改成读 store，也必须转成**函数 / 取数器**，否则**不重启不生效**（界面改完是绿的、标题还是旧的）。
- ★ **「关掉模型 / 离线」走的是本地模板 `FORMATS`（F01~F10），完全不读词库** ⇒ 改词库对本地模板标题零影响；
  **验收必须开着模型测**，否则会得出「改了没反应」的错误结论。
- ★ 用户版词库落 `store`（`config.json`，键如 `copy.hotwords`），**内置 `GROUPS` 只当「出厂基线」**；
  「恢复内置」= 清掉用户版回落基线 ⇒ `tools/copytest.js` 盯内置基线的那批断言**继续有效**。



- ★ **2026-10-03 已实现（AA4 收束）** —— 落地为**新页签「热词库」**（`data-tab="12"`，编号取**下一个未占用**、不动既有 1~11）。
  + 7 个可编辑组（风格/氛围/色感/场景/人群/季节/情绪）＝**每词一个 `×` 删除 + 组尾一个输入框回车即加**；
  + **收尾组这一版锁定**（只读展示、**零控件**、`locked:true`，仍参与生成）；+ T01~T10 骨架表只读；
  + 右上「恢复内置」＝清 `copy.hotwords` 回基线；+ 页内写明三条红线。
  + 权限：**读 `hotwords:get` 走 `guard`（人人可看）**，**写/恢复走 `guardAdmin`**（改的是全员生成口径）。
  + 数据落 `store` 的 `copy.hotwords`（`{groups,updatedAt}`），**出厂 `null`**（不预置业务数据）。
- ★★ 新坑①：**红线必须「放过自己的基线」**。`FORBIDDEN_AD_RE` 最初图省事写成 `/第一/` ⇒ 内置季节词
  **「入冬第一件」被判极限词**（基线 64 → 63 词、预检报假警）。⇒ 收窄为**正负向并存**（只拦
  `第一名|全网第一|销量第一|第一品牌` 这类），并加 **`baselineViolations()` 常驻自检**：
  回归里断言「出厂基线踩自己的红线数 == 0」。**将来加词/改红线都必须先过这一条。**
- ★★ 新坑②：**`sanitizeLibrary` 的「缺失组」＝沿用基线，不是清空**。初版按提交内容整体覆盖 ⇒
  渲染层**少传一个组就静默丢光那组词**。⇒ 只有**显式 `words: []`** 才算清空（并给 warn）。
- ★★ **红线 2 的残留误杀面（2026-10-03 实测，未决定是否放宽）**：`FORBIDDEN_AD_RE` 里的 **`最` 是单字拦** ⇒ 实测 `最后一件` / `最开始` / `最初的款` / `最新款` / `最多人买` **5/5 全被拒**（后两个方向属真误杀；「最新款」广告法口径本身有争议，**不替监管下结论**）。而 **`入冬第一件` 不被拦** —— `第一` 早已从 `/第一/` 收窄为 `第一名|全网第一|销量第一|第一品牌`。实测口径：全库 64 词里含 `第一|最` 的**只有「入冬第一件」一个**、被拒 **0**；`baselineViolations()` → `[]`。⇒ **要不要把 `最` 改成列举式或给「最后/最初」开白名单，等用户拍板，别擅自放宽。**
- ★ 读取链收口：3 个读取点全改成**函数取数**（`allWords()` / `prefixWords()` / `currentGroups()`），
  **界面改完立刻生效、不用重启**；`STYLES` 保持常量（骨架不可编辑）。

### AA5 自证与实测（数字）

- 全量回归：`node tools/run-all.js` → **17 套共 1036 项全绿**（copytest **107 → 137**，+30）。
- 定点破坏 `D:/tmp/ai/break-body.py`：**15 条（N1~N15）全被抓到**，逐字节还原 + md5 核对
  （`copywriter 4babf783` / `copycheck 10cceeac` / `aireport f64b0100`）。
  - ★★ 第一轮 **11/14**，三条 MISS **全是断言自己的问题**（不是代码没坏）：
    ①「品牌提示词的话题真进了组合」那条其实只验了**必带**（来自设置页 `copy.requiredTopic`）——
    **池子来源改坏它照样绿**；修法＝拆成「必带顺序」+「**每一行**的额外位都在抽取结果里」。
    ② 一条断言查 `plan.titleStyle ? A : B` 的 **B 分支**，而 `buildPlan` 每行都给格式 ⇒ B **永远走不到**；
    修法＝改成**源码级**并如实标注强度。
  - ★★ **滑动窗口掩盖池子被污染**：`pick(arr, k, start)` 采样行数**少于池子长度**时永远绕不回开头。
    ⇒ 断言样本必须**多过池子能给的个数**（**8 行 > 7 个**）才暴露「设置页词混进来」。补的破坏＝**N15**。
- 真机（真图 + 真 key + 真模型，`jobs.run('copy.generate')`，**不打印 apiKey**）：10 条
  **正文全 5 行 / 0 条单行 > 26 字 / 0 条缺 emoji / 0 条相邻重复 / 0 个 `+`**；
  必带 `#TW男装` **恒在话题 1**；额外位全在提示词抽出的 10 个池子里、**10 行 10 种组合**、**不掺** `#男生穿搭`。
  ★ 报告里 6 行 `warn` 逐条核过：**全是已知两类**（故意同图配不同色 / 浅背景压过主体的「图片主色」误报），
  **无一条**是本轮新判据的误杀。
- ★ **会话流水号有历史错位**：`README.md` 把「句式骨架」那轮记作「第八次」，`docs/HANDOFF.md` 记作
  「第九次会话」⇒ 两边差一位。**以 HANDOFF §4 的会话编号为准**（本节＝**第十次会话**；REFERENCE 记 **第十五轮**）。

## AB. v1.0.6 发版：并发工作树 + 换行符假红 + 本机副本未换（2026-10-03 第十次会话收尾）

> 用户原话：「检查是否有bug，然后可以提交并发版」。范围由用户当场拍板 = **main 全量** + 看板一起重部署。

### AB1 这次并发发版的形态
- 工作树里两路会话的改动**都在且都未提交**：本会话 `72151a2f`（10-02 01:05 起，26 小时超长会话）
  + 并行会话 `f5978de6`（10-02 18:53~00:52，已停 2.5 h）。**10 个文件两边都碰过**。
- ★ **抽「另一路碰过哪些文件」的可靠办法**：读它那条 `jsonl` 的 `arguments.file_path`
  （脚本 `D:/tmp/ai/who-changed.py`，139 次操作）。**比看 mtime 准** —— mtime 只能给时间窗。
- 重叠文件无法按 hunk 拆（拆错会漏代码），且两边都完整、回归全绿 ⇒ 一条提交全带走。

### AB2 ★★ 换行符把「asar md5 对齐」搞成假红（本轮最大的取证坑）
- 现象：`asar.extractFile(A, 'src\\main\\services\\copywriter.js')` 出来的 md5 与工作区**对不上**
  （`copywriter` / `copycheck` / `aireport` / `hotwords` / `cloudsync` 五个），但字节数只差几字节。
- 真因：`core.autocrlf=true` + 本仓换行符混用 ⇒ `git worktree add` checkout 时把仓库里的 LF
  **转成 CRLF**；而工作区这 5 个文件是**我用 Python 写的 LF**（没经过 checkout）。
  `git show HEAD:<file>` == 工作区 ⇒ **仓库里存的就是 LF，是快照被转了一次**。
- ⇒ **别再拿「asar md5 == 工作区 md5」当取证** —— 本仓天然做不到。**改用「在打包快照上跑全量回归」**：
  跑的就是包里的字节，`D:/work/_rel106` 里 17 套 **1036 项全绿**（这比 md5 对齐更硬）。
- 根治（本轮未做）：加 `.gitattributes` 的 `*.js text eol=lf`，checkout 不再转换。

### AB3 本机已装副本这次**没有**换 asar
- `D:\bluevbeta\dewu-bluev-publisher`（注册表登记 1.0.5）当时有 **4 个实例在跑**
  （PID 42680 / 45144 / 46856 / 47068，另有 `adb`）⇒ 按 §Q「动数据/换 asar 前确认无实例在跑」停在原地。
- ★ **假阴性教训**：我早先那次「查有没有在跑」用了 `Get-Process | Where $_.Path -like 'D:\*dewu*'`，
  返回空 ⇒ 误以为没在跑。真实原因是**本会话 PowerShell 的 stdout 多被吞掉**（多条命令输出为空）。
  **可靠替代**：`tasklist /FI "IMAGENAME eq 得物蓝V素材发布工具.exe"`（中文名直接写，别靠通配）。
- 交付口径：`autoDownload` / `autoInstallOnAppQuit` 恒 `false` ⇒ 不会自己偷偷装；
  用户重启后点「检查更新」即可升到 1.0.6。

### AB4 本轮实测数字（可复算）
| 项 | 值 |
|---|---|
| 提交 | `6aa17f3`（31 文件，+3790 / −132）；文档补档 `c6cf3b8`（纯文档） |
| 安装包 | `114025736 B`（比 1.0.5 多 `35913 B` ⇒ 无新增内置二进制） |
| 公网核对 | `latest.yml = 1.0.6`、安装包 `HTTP 200 / Content-Length 114025736`、`beta.yml` 未动（`1.0.1-beta.2`） |
| 远端取证 | `git ls-remote origin refs/heads/main` == `git rev-parse HEAD` |
| 看板 | 同一沙箱 `dcf9a696225c47818c3b56816ae8b19e`；`sdkLocal=present`、`已连接 · 4 条`、`rendered=true`；请求 host 只有部署域 + `rywurhpkovyjpjyvfjdz.supabase.co` |
| 打包快照回归 | 17 套 **1036 项全绿** |

## AC. 三项删除：「前司」字样 / 设置页重复块 / 「更新日志」整链（2026-10-03 · 第十一次会话）

- ★ 用户原话：「怎么app内有前司的字样，全部删除；设置里的内容与校验（对齐真机）功能重复，删除；更新日志删除」。
- ★★ **改一处用户可见文案时别只在 `app.js` 里搜**：`前司` 在 `src/` 有 **3 处** —— `app.js` 发布单 `desc`（唯一用户可见的）
  + `sheet.js` / `verify.js` 的文件头 PRD 注释；另外 `dist/win-unpacked/resources/app.asar` 里也命中，**那是上一个包的产物**，重打包即消失。
  文档（`README.md` / `docs/`）里没有 —— 打包 `files` 只含 `src/**/*` + `package.json`。
- ★★ **设置页「内容与校验（对齐真机）」是一块纯指路**（文案提示词 → 弹窗；货号颜色 → 高级设置），功能在「品牌与权限」「高级设置」两页都有 ⇒ 整块删。
  但 `copy:prompt` / `go:advanced` 两个**动作一个都没删**（分别挂在「文案生成」页与「模拟器发布」页）⇒ 删路牌 ≠ 删功能，两个都要查。
- ★★ **「更新日志」是整条链删，不是只删界面**：`app.js`（`updLogHtml()` + 调用点 + `upd:log:on/off/open`）→ `preload` 桥 → `ipc.js`
  （`update:set-log`、`updateLogFile()` 及其导出、`update:status` 里的 `log` 字段）→ `index.js`（传给 `init()` 的 `logFile`/`logEnabled`）
  → `updater.js`（整个落盘块 + `normalize()` 里按开关挂 logger + `patch()` 的 `logLine('state')` + 抽稀计数 + 三处 `logLine` + `_reset` + exports
  + 因此没人用的 `require('fs')` / `require('path')`）→ `store.js` 的 `update.log` 默认值 → 断言 → 文档。
- ★★ **代价（已当面告知用户）**：删掉后「差分下载有没有生效」**没有落盘证据**了（原先只认日志里 `[downloaded] … 字节数 + MB` 那一行）；
  下载中的进度条还能看到 `transferred / total`，**下完就没了**。要恢复从该提交回退即可。
- ★★ **删功能必须补负向断言**，而且**要读真 DOM、别 grep 源码**（注释里会正当地提到被删掉的名字，一刀切会误报）。
  本轮补 2 条，都读真渲染层的 `#pane`：① 页内 `/内容与校验/` 为 false + 没有 `copy.prompt.*` 裸输入框 + 设置页没有 `copy:prompt` 按钮；
  ② 页内 `/更新日志/` 为 false 且没有 `upd:log:*` 动作。把任一块加回去 ⇒ 立刻红。
- 残留扫描（`src/` + `tools/`，15 个关键词）**全 0**：`前司`／`更新日志`／`updLogHtml`／`upd:log`／`updateSetLog`／`update:set-log`／
  `updateLogFile`／`logStatus`／`setLogEnabled`／`LOG_MAX_BYTES`／`logFd`／`defaultLogFile`／`logEnabled`／`update.log`；
  `内容与校验` 只剩 3 处，**全在新加的负向断言里**。
- 回归 **17 套 1005 项全绿**（`uicheck` 157→**143**、`updatertest` 67→**50**，合计 −31）。
- ★ 只改源码，**未提交、未发版**（`1.0.7` 仍未打）。

## AD. 文案模型「接口地址 vs 模型名」—— 实测清单 + 本机配置修正（2026-10-03）

### AD1 ★★ 地址跟「调哪个型号」无关
- 接口地址恒为 `https://api.deepseek.com/v1`（`src/main/llmdefaults.js:26`）。界面**留空＝跟随内置**；填了以填的为准；**读时兜底、绝不写回 config.json**（§T9 同一套规矩）。
- 地址写不写 `/chat/completions` 都能用：`copywriter.urlsOf()` 两种都算得出（`…/v1` → `…/v1/chat/completions`；已带后缀则换成 `/models`）。
- ⇒ 用户「我要调 V4.1，地址咋填」这个问法**本身就是错位的**：型号由「模型」那一格决定，不关地址的事。

### AD2 实测（2026-10-03 04:00，用本机真 key 真调）
| 请求 | 结果 |
| --- | --- |
| `GET https://api.deepseek.com/v1/models` | **HTTP 200**，清单**只有 2 个** |
| `POST /v1/chat/completions`，`model="deepseek v4.1 flash"` | **HTTP 400**：`The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek v4.1 flash.` |
| 同上，`model="deepseek-flash"` | **HTTP 200**，回复「收到」 |
| 同上，`model="deepseek-v4-pro"` | **HTTP 200** |

清单原文（`id` / 显示名 / 输入能力）：
- `deepseek-flash` / `DeepSeek-V4.1-Flash` / `["text","image"]` ← **V4.1 就是它**
- `deepseek-v4-pro` / `DeepSeek-V4-Pro` / `["text"]`

### AD3 ★ 本项目必须选 `deepseek-flash`
- 只有它带 `image` 输入能力 ⇒ 只有它能「看图写文案」（§W2）。
- 选 `deepseek-v4-pro` 时 `preflight` 判 `image === false` ⇒ 自动退成纯文字，标题掉回「货号+颜色」那种像 AI 批量做的写法（日志有 warn 明说）。
- 兜底 id 也是 `deepseek-flash`（`llmdefaults.model`）。
- ★ 显示名其实也能用：`preflight` 按归一化把 `deepseek v4.1 flash` ↔ `DeepSeek-V4.1-Flash` 对上（`normModel` 去空格/点/横线），只是日志会写「按显示名匹配」；**填 id 最稳**。

### AD4 本机配置改动（2026-10-03 04:05）
- `%APPDATA%\dewu-bluev-publisher\config.json` 的 `copy.llm.endpoint`：`""` → `https://api.deepseek.com/v1`（`model` 原本已是 `deepseek-flash`）。
- 备份：`D:/tmp/ai/cfg/config.before-2026-10-03T0405.json`（另有 00:40 的 `config.before.json`）。
- 用户要自己改的话，界面位置：**设置 → 高级设置 → 文案模型**（三格：接口地址 / 模型 / API Key），改完点「接口自检」（`jobs.js` 的 `llm.check`，一次往返就报「地址通不通 / 模型名认不认 / 收不收图」）。

### AD5 ★ 时序异常：config.json 被**另一路**同时写过（不是我）
- 03:57 读到 `model="deepseek v4.1 flash"`；04:00 再读变成 `model="deepseek-flash"` —— **我只写了 `endpoint`**。
- ⇒ 这段时间有第三方在写同一份 config（用户界面 / 另一会话）。**应用若正开着，关闭时会把外部写入覆盖掉** ⇒ 改 config 前先确认没有实例在跑（§A1），改完**立刻回读**，别信「写成功了」。

### AD6 复用脚本（工作区根）
- `_probe-models.js`：读本机 config 的 key，`GET /v1/models` 打清单（**不打印 key**）。
- `_probe-chat.js`：同一个地址逐个试 model id，真调一次看 200/400。
- `_patch-llm-cfg.js`：只改 `copy.llm.endpoint` / `model`，2 空格缩进原样写回。

## AE. v1.0.7 发版：「包内核对」升级为**遍历整个 asar** + 两个把我带偏的坑（2026-10-03 第十一次会话收尾）

**结论先写**：`v1.0.7` 已上正式通道（`latest.yml` = 1.0.7 / 114023445 B），提交 `5937b96` + 文档补档 `82d1b32`；
本机已装副本因**4 个实例在跑**没换 asar（用户重启后点「检查更新」升级）。

### AE1. ★★ 包内核对别「挑几个文件」，要**遍历整个 asar**

- 上一版脚本挑 11 个文件比对 md5 ⇒ 只能证明「**我挑的这 11 个**对」，证明不了「**包里没有**我不想要的东西」。
- 这次改成：`asar.listPackage(A)` 取全部条目 → 扣掉 node_modules → 逐个 `extractFile` → 拼成一个大字符串扫关键词。
  实测 **2516 条目 / 真读到 1781 个文件 / 49 MB 文本**（electron-builder 会把 `dependencies` 里的运行时依赖也打进 asar，所以量比想象大）。
- ★ **必须同时断言「真读到几个」**：`readCount >= 15 && bytes > 300000`。否则「一个都没读到」和「读到的都干净」都是 0 命中 ⇒ 空==空假通过。
- ★ **`listPackage` 返回的是 `\src\renderer\app.js`**（前导反斜杠 + 反斜杠分隔），不是 `/src/...`。我第一次按 `/` 处理 ⇒ 全部 `extractFile` 抛错 ⇒ `readCount = 0`，脚本却还在往下跑。**要先打印前几个路径**再写归一化。

### AE2. ★★ 「既要证明没有，也要证明还在」—— 一次扫描抓两个方向

- 只扫「不该有的」会**删过头**：这次一并断言 `logLineHtml`（执行日志渲染，与删掉的「更新日志」无关）、
  `copy:prompt`（文案生成页的入口）、`update:check` / `update:download` / `update:set-channel` **仍在**。
- ★ 关键词表**开太宽会自己给自己报警**：我第一版把 `logLine` 和 `copy:prompt` 都列进「必须 0」，
  结果 `logLineHtml`（子串命中）和文案生成页那个按钮各报一次假红。**判「该不该删」先看它是不是另一个功能的子串/同名动作**。

### AE3. ★★ `tasklist` 的中文输出是 GBK —— 用 UTF-8 grep 数中文**恒为 0**

- 现象：`tasklist /FI "IMAGENAME eq 得物蓝V素材发布工具.exe" | grep -c "得物蓝V"` ⇒ **0**，但屏幕上明明列着 4 行。
  根因：Windows 输出 GBK，bash 的 `grep` 按 UTF-8 匹配 ⇒ 一个都不中。
- 危险在于**结论方向是「安全」**：它会把「4 个实例在跑」算成「实例数 = 0 ⇒ 可以换 asar」，正好踩中 §Q 红线。
- 正确做法（任选）：`tasklist /FI ... /FO CSV /NH | grep -c "\.exe"`（数行，不匹配中文）；
  或直接用默认表格输出**肉眼看行数**；或 PowerShell 读 `$_.Path` 后**写文件再 Read**（stdout 会被吞）。
- ★ 同族教训：**凡「中文匹配」出现在 Windows 命令输出上，先假设编码不一致**。

### AE4. ★★ 提交信息也是记录，写错要更正 —— 但不能改写已推送的历史

- `5937b96` 的信息里写了「ipc.js 删掉 copy:prompt 通道与处理函数；preload 删掉对应桥接」，**与 diff 不符**。
  证据：`git log -S"copy:prompt" -- src/main/ipc.js src/preload/index.js` **输出为空** ⇒ 它从来只在渲染层。
- 处理方式：**不动已推送的 `main`**（`--amend` + 强推会改写公共历史），改用
  ① 下一个提交（`82d1b32`）里**显式写一段「更正」**；② HANDOFF 的发布段里同样留一条。
- ★ 教训：**写提交信息前，先 `git show --stat` 复核「我到底改了哪几个文件的哪几行」**，别凭记忆写归属。

### AE5. 发版 SOP 的这一步不能省：**在打包用的同一份字节上跑回归**

- 因为 `core.autocrlf=true`，`git worktree` 检出的字节和主工作区**不一样**（LF → CRLF），md5 对不上是常态。
- ⇒ 最硬的证据不是 md5 对齐，而是**在快照目录里跑 `tools/run-all.js`**：本轮实测 **17 套 1005 项全绿**。

## AF. ★★ 「点发布没反应」＝静默走模拟通道 + 报告落点跟错目录（2026-10-03 · 第十六轮）

### AF1. 症状：点「开始发布」，模拟器毫无动静，界面却一路绿
- 根因链：`report.import` 用**整块替换**写 `project.publish` ⇒ `mode`/`device`/`probe` 一起消失
  ⇒ `publisher.run` 里 `const mode = state.publish.mode || 'mock'` 读成 `undefined` ⇒ **默认走模拟通道**（不碰设备）。
- 铁证：`输出/得物/run-log.jsonl` 写着「开始发布（模拟通道）：30 条…模拟通道不接触设备」；
  同时 `project.json` 的 `publish` 键里**没有 mode / device**（连接设备时写过，被导入报告冲掉）。
- 更糟：模拟跑完 `row.result = '发布成功'`，与真发一模一样 ⇒ 界面全绿、Excel 回写也是「发布成功」。

### AF2. 改法（三处，缺一都会复发）
1. `report.import`：`Object.assign({}, st().publish, {...})` 保住 mode/device/probe；不再顺手 `connected:false`。
2. 模拟通道结果记 **`模拟成功`**；不给 `audit:'审核中'`；统计只认 `发布成功` ⇒ 模拟不算真发布。
3. 渲染层 `pub:run`：`mode !== 'adb'` 时先 `window.confirm` 讲清「不会真的发到得物」，不再默默跑。
- ★ 界面 `STATUS_KIND` 必须**显式**列出 `'模拟成功': 'warn'`：`kindOf` 兜底规则含 `/成功/`，不列会被判成绿。

### AF3. 报告落点：跟着 **items** 走，不跟 `sourceDir` 走
- `copy.generate` 原来 `dir: s0.sourceDir` ⇒ 落回**还没处理的原始素材目录**；
  而这一批条目其实全在 `flat_<时间戳>/` 里（合规检查就是在它上面跑的）。
- 新增 `jobs.itemsDir(items, fallback)`：取 `items[0].absDir` 的父目录；拿不到才回退。
- 落点公式：`itemsDir(s0.items) || s0.flatDir || s0.sourceDir`。

### AF4. ★★ 真机发布流程实测（MuMu 12 / 得物 900×1600），纠正三条旧结论
- **入口三跳**（逐跳实测）：底部「我」`tab_user` → 右上角「主页」`tvGoHomePage`
  （★ clickable=**false**，但按坐标点**实测有效**）→ 「发布新动态」`rlPublish` ⇒ 进 `TotalPublishProcessActivity`。
- **发布页首屏**（选素材相册）：页签「全部/照片/视频」**三个都没有 resource-id**，只能按文字点；
  缩略图 `flThumbSelect` **无文字无描述**，`tapId` 取第一个＝第 1 格。
- ★ **「下一步」在没选素材时不存在**；选中后才出现，且文字是 **「下一步 (1)」带计数** ⇒ 用 `flNextStep`。
- ★★ **视频比图文多两屏**：剪辑页（音乐/滤镜/贴纸/文字/剪辑 + `flNextStep`）→ 封面页（`tv_skip`「跳过」）。
  ⇒ 旧结论「图文视频位置一样、`videoSteps` 空则复用」**只在相册首屏成立**，必须单独配。
- **编辑页**：`etTitle`（添加标题）[0,381][900,418] / `etTrendContent`（添加作品描述）[0,432][900,741]
  / `topicBtn`（话题）/ `tvRelevantProduct`（关联好物）[0,832][840,898] / `tvPublish`（发布）[174,1510][870,1576]。
- ★ **中文输入前必须先点输入框**：ADBKeyboard 是广播，只认**当前有焦点**的输入框 —— 旧表直接 `input ${title}` 少了聚焦那一步。
- ★★ **话题不做联想点选**（2026-10-03 用户拍板：「我给你多少个你就放多少个，我不会让你去挂其他话题」）
  ⇒ 候选表里话题就是**纯输入**（`话题 N（直接输入）` / `action: 'input'` / `${topicN}`），
  **不许**再生成「输入→等联想→点选」那种步骤或说明；已补断言盯「步骤名不含 联想/点选、action 必须 input」（§AF6）。
  ⚠ 仍未验证：纯文本写进去，得物认不认它是「话题」（可点链接）—— 下次真机看一眼。
- ★★ **图文不过剪辑/封面屏**（2026-10-03 用户确认）：那两屏**只属于视频**；图文过 `flNextStep` 直接进编辑页。
  图文**第一张图默认即主图（封面）**；「主图怎么处理」（换图/裁剪/指定别的图）用户说**后面再说** ⇒ 定位表先按「点第 1 格」配。
- **还没走进去的**（不许当已确认）：关联好物的「搜货号→选商品」两屏、「最新素材一定在相册第 1 格」。

### AF5. 抓发布页的正确姿势（为什么之前一直抓到空表）
- 得物发布页首屏是**持续动画页**，`uiautomator dump` 要等 idle ⇒ 报 `could not get idle state`。
- **把三个开关都置 0**（`window_animation_scale` / `transition_animation_scale` / `animator_duration_scale`）
  之后**一次就抓到**（实测 73 节点）。程序里已有「临时关、抓完还原」机制（`adb.dumpEx` 的 `animOff` 分支）。
- 之前两次失败的真相：① 停在**模拟器桌面**（dump 里全是「游戏中心/浏览器/图库/设置」）；
  ② uiautomator 失败后走了 `dumpsys` 备用通道 ⇒ 98 节点 **0 文字**，那张表只能靠猜。
- ★ 判别口径：一份 dump 里 **非空 text 数 == 0** ⇒ 它来自 **dumpsys 通道**，**不能**拿它生成定位表。
- ★ `adb shell input tap` 偶发丢失（页面刚渲染时点了没反应）⇒ 关键跳转后**必须回读 `mCurrentFocus` 确认**再往下走。

### AF6. 自证口径（本轮）
- 回归：**17 套 1013 项全绿**（1009 + 本轮 1 条；另 3 条来自并发会话的 `tools/uicheck.js`，非本方改动）。
- 反向验证：① 把 `report.import` 退回整块替换 ⇒ `⑦ 导入报告不会抹掉设备通道状态` 红（`mode=undefined device=undefined`）；
  ② 让 `itemsDir` 直接回退 ⇒ `⑬ 报告落点` 红（落点退回「原始素材」）；两条还原后都回绿。
- 反向验证 C（话题断言）：把 `uimap.js` 话题步骤名改回「输入→等联想→点选」⇒ `adbtest` **红 1 条**
  且点名 `候选定位表：图文+视频的话题都是纯输入、不含联想点选`；还原后 **105 PASS / 0 FAIL**。
- ★ 新断言**必须自己清理状态**：把 `publish.mode` 设成 `'adb'` 之后不还原，会让同一套件后面那条
  端到端 `publish.run` 走真实通道（无设备 ⇒ 抛错），**4 条无关断言被一起带红**。
- ★ **并发会话**：`tools/uicheck.js` 在 04:28:26（早于本方本轮 04:34:59）被**另一路会话**加了 3 条断言
  ⇒ `git diff --stat` 的 9 文件里有 1 个不是本方的。发版前按 §S5 处理。

---

## AG. 撤掉设置页「外观」块 + 文案「送图成本」实测（2026-10-03 · 第十七轮）

### AG1 撤「外观」块（用户：与顶栏主题按钮重复）
- 用户原话：「目前设置里的外观要直接隐藏掉，与最顶上的功能重复了」。
- 该块内容：主题 chip + 「为什么撤掉下拉」的说明段 + **运行环境** chip。三段里只有「运行环境」有信息量。
- 做法（`_patch-hide-appearance.py`）：整块删掉、**原地留一条注释**说明去向；
  **「运行环境」不丢**，挪进下面的「外部依赖」box。⇒ `app.js` 2945 → 2939 行。
- ★ 这是**第二次**在设置页撤「重复块」（§AC 那次是品牌管理 / 账号与安全）——
  设置页定位是「这台机器怎么跑」，凡是**别处已有一等入口**的东西（主题 / 品牌 / 账号 / 提示词）
  都不该在这里再复述一遍。

### AG2 自证
- `uicheck` **146 项全绿**（原 143 + 3）。新增三条都**读真 DOM**（切到设置页读 `#pane h3`）：
  ① 正向对照「确实渲染出来了（有路径 / 外部依赖）」；② 负向「不再有『外观』」；③ 「运行环境没丢」。
- ★ **正向对照是必须的**：只写「不含外观」，页面万一没渲染就是「空 == 空」的假绿。
- 定点破坏（`_breakverify-appearance.py`）：把「外观」块**塞回**设置页 ⇒
  **只红第 ② 条**（145 PASS / 1 FAIL）—— 三条各司其职；md5 还原一致。

### AG3 ★★ 送图成本实测（可复算）
真调本机配置的接口（`api.deepseek.com/v1` · `deepseek-flash`），读 `usage.prompt_tokens`。
system 各次相同且短 ⇒ **绝对值偏小，差值才是图片成本**。固定 768px：

| 送图张数 | 0 | 1 | 2 | 4 |
|---|---|---|---|---|
| prompt_tokens | 56 | 343 | 631 | 1207 |
| 每张增量 | — | 287 | 288 | 288 |

⇒ **每张 768px 的图 ≈ 288 tokens，严格线性**；**4 张比 2 张多 576 tokens/条**，图片占了 prompt 的 95%。

「单边缩到 xxpx」（固定送 2 张）：

| 单边 | 512 | 768 | 1024 | 1568 |
|---|---|---|---|---|
| 单张体积 | 11 KB | 26 KB | 57 KB | 209 KB |
| prompt_tokens | 451 | 631 | 1061 | 2077 |

⇒ **与像素总面积近似成正比**（512→1568 涨 4.6 倍）。默认 768 是「看得清 + 不太贵」的折中。
脚本：`_probe-vision-tokens.js` / `_probe-vision-side.js`；结果落 `_vision-tokens-result.json` / `_vision-side-result.json`。

### AG4 ★ 「视频如何送」= **根本不送**（界面上没写）
- `imagePartsOf()` 只取 `f.type === 'image'` 再 `slice(0, imageCount)` ⇒ **视频永远不进模型**。
- 代码本身是**诚实**的：提示词逐条写 `看图: 本次给了 N 张实拍图` / `本次没有图`；
  收尾还有 `有 N 条没找到可用图片 ⇒ 那几条标题只能按货号/颜色写`（warn）+ 返回值 `noImage`。
- ★ **缺的只是界面标注**（用户原话「这里没有标注」）——建议在「高级设置 → 文案模型」补一句：
  「视频不参与看图；只有视频、没有图的素材，标题只能按货号 / 颜色写」。**未做，等用户拍板。**
- 另一个「看着像骗人」的点：开头那句 `看图写：每条送前 N 张实拍图` 是**按配置**说的，
  与每条**实际**张数无关（实际张数只在提示词里逐条体现）。容易被读成「每条都送了 N 张」。

---

## AH. ★★ 「视频为什么不送」＝接口层就收不了 + 送图 4→2（2026-10-03 · 第十八轮）

### AH1 三层证据（都在真接口/真代码上跑出来的，不是推断）
| 层 | 证据 | 结果 |
|---|---|---|
| 代码 | 全仓 `grep -n "video" src/main/services/copywriter.js` | **0 命中**（不是「过滤掉」，是**从没实现**） |
| 代码 | `imagePartsOf()` 抠出来跑（6 图+2 视频，视频刻意排最前） | 送出 **2** 块、**全是 JPEG(FFD8)**；素材只有视频时送出 **0** 块 |
| 接口 | 真调当前 endpoint（`deepseek-flash`） | `image_url`+JPEG → **200**；`video_url`+MP4 → **422**；MP4 塞 `image_url` → **400** |

- ★ 422 原文点破了根因：`unknown variant 'video_url', expected one of 'text', 'image_url', 'file'`
  ⇒ **接口的 content 块只认 text / image_url / file**，`video_url` 这个类型压根不存在。
- ★ 400 原文：`unsupported image ... webp, png, jpeg, and gif` ⇒ 图片位只收这四种格式。
- ★ 探到接口还认 `file` variant（第一次遇到），但试 `{type:'file',file:{filename,file_data}}` 被
  `file must have a file_id or file_data` 拒（JPEG/纯文本对照同样被拒）⇒ **正确形状没验出来，别写成结论**；
  想走这条路要先单独验（可能要预上传换 `file_id`）。
- ⇒ 所以「视频不进模型」是**接口能力边界**，不是产品偷懒。要真让视频参与，现实路径是
  **用内置 ffmpeg（`vendor/ffmpeg/ffmpeg.exe`，项目里已有、`video.js` 在用）抽 1~3 帧当图片送**。
- 脚本：`_probe-video-input.js`（A/B/C 三组对照）、`_probe-video-file.js`（D/E/F）、`_verify-imageparts.js`。

### AH2 ★ 配置里的「旋钮」是**字符串**（界面 `<select>` 存的），比较时别写 `!==`
- 实测：`config.json` 里 `copy.llm.imageCount = "4"`、`imageMaxSide = "768"` —— **typeof 是 string**。
- 踩过：改配置的脚本写 `if (cur !== 4)` ⇒ **值明明是 4 也判失败**（`"4" !== 4`）。
  它恰好当了一次「类型校验」把我拦下，但同一写法放到别处就是假失败。
- 正确姿势：比较用 `Number(x)`/`String(x)`；改这类值时**保持类型不变**（原本是字符串就写成字符串），
  免得把一个「界面存法」悄悄变成数字（产品侧靠 `num()` 归一化才没炸）。

### AH3 送图张数 4 → 2（本机配置，用户拍板）
- 省 **576 tokens/条**（按 7500 条算 ≈ 432 万 tokens）。**只改本机 `config.json`，源码未动、未发版。**
- 改法（`_set-imagecount.js`）：只替换那个字面量、**不重新序列化整个 JSON**（保持原格式）；
  写前备份 `<userData>/config.json.bak-<时间戳>`；校验「解析值=2 且类型不变 + **除 imageCount 外逐字段一致**」。
- 生效证明：S1 场景直接读**本机配置**跑真代码 ⇒ 送 2 块（不是断言里写死 2）。
- ★ 若 App 正在跑，退出时会用内存里的配置**覆盖**文件 ⇒ 改配置前必须先确认没有实例在跑。

### AH4 ★ 手法：「内存破坏 + 抠函数跑」——并发工作区里做反向验证的安全姿势
另一路会话正在改 `copywriter.js` 时，**不能**用「改源码→跑→还原」那套（还原会覆盖他的改动）。
做法：把函数体从源码文本里**抠出来 `new Function` 跑**，破坏只替换**内存里的字符串副本**，
末尾再断言 `after === src`（仓库文件一个字节没动）。
- 灵敏度自检同样有效：拆张数限制 ⇒ S1 由 2 变 **6**；类型过滤反过来 ⇒ 变 **0**（都红了）。
- 抠函数用**大括号配平**找结尾（比按行正则稳）；跑前先验锚点 `count==1`。
- 本次：`11 PASS / 0 FAIL`（含 D1/D2 两条破坏 + 「仓库文件未动」）。

---

## AI. ★★ COS「免费 6 个月」到底免什么 —— **只免存储容量，流量从来不免**（2026-10-03 · 第十九轮）

### AI1 官方政策原文（决定性）
- 面向「**首次开通** COS 的新用户」：**50 GB 标准存储容量** × **6 个月（180 天）**。
- ★★ **只能抵扣「标准存储容量」这一个计费项**。官方明确列出**不可抵扣**：
  - 请求费用（请求数）
  - **流量费用：外网下行流量 / CDN 回源流量 / 跨地域复制流量 / 全球加速流量**
  - 标准存储(**多 AZ**)容量、低频 / 归档 / 深度归档容量
  - 管理功能费（清单 / 检索 / 批量处理 / 对象标签）
- 地域：仅**公有云**地域（广州在内），金融云地域不算。
- ⇒ **免费额度跟「别人下载你的包」这件事完全无关**。放进去不花钱，**下载才花钱**。

### AI2 我们这个桶的真实账（可复算）
- 桶：`dewu-bluev-release-1499238579.cos.ap-guangzhou.myqcloud.com`（`generic` provider）。
- 包大小：**109 MB**（1.0.7 实测；当初按 88 MB 估，实际更大）。
- 外网下行流量单价：**0.5 元/GB 起**（阶梯递减）。
- 每次发版：10 台 × 109 MB ≈ **1.09 GB** ≈ **0.53 元**。
- 存储：3 个版本 ≈ 330 MB，**在 50 GB 免费额度内 ⇒ 存储费 = 0**。
- ⇒ **自动更新的账单几乎全部来自流量**，且「几毛钱/次发版」是**正常且可预期**的量级。

### AI3 「已经开始扣费了」的三种可能 + 诊断路径
诊断（腾讯云控制台）：
1. **看扣的是哪一项**：右上角「费用」→ **费用中心** → 左侧「费用账单」→「账单查看」→
   **「明细账单」** 标签 → 按产品名筛 **COS 对象存储**（勾「不显示 0 元费用」）。
2. **看免费额度用了多少**：COS 控制台 → 左侧「**资源包管理**」→「**免费额度资源包**」→ 查看明细（可看每日用量 / 可导出）。
3. 结算顺序：**免费额度资源包 > 自购资源包 > 按量计费**。

| 可能 | 特征 | 判断 |
|---|---|---|
| **① 外网下行流量**（最可能） | 明细里是「外网下行流量」 | **正常**，多少台下载就是多少 |
| ② 账号**以前开通过** COS | 「免费额度资源包」里**没有**这个包 | 没有 50 GB；存储约 0.099 元/GB/月，我们几 GB ⇒ 约 0.5 元/月 |
| ③ 桶是**多 AZ** | 明细里是「标准存储(多 AZ)容量」 | 免费额度**不抵多 AZ** ⇒ 存储照收（多 AZ 开了不能关，只能重建桶） |

★ 腾讯云按量计费存在**预估冻结**（老文档口径：账单金额的 120%）。「余额变少」未必等于已真实出账
—— **这条我没实测，只作参考**。

### AI4 什么情况才算异常（要去堵）
- 若账单**远超** `0.5 元 × 发版次数`（例：几十元/月）⇒ 先怀疑**被刷流量**：
  桶是**匿名可下载 + 默认域名 + 强制下载**（2024-01-01 后新建桶的特性），URL 一旦泄漏（被转发/被收录），任何人都能刷。
- 止损手段（代价从低到高）：
  1. 把随机路径**换掉/加长**（旧 URL 直接作废）；
  2. 开 Referer 防盗链 —— ★ 对 electron-updater **无效**（它不带 Referer），慎用；
  3. 换**私有读 + 固定 token**（`requestHeaders`），代价是客户端要改；
  4. CDN + 流量封顶（CDN 侧才有封顶，但 CDN 自身也计费）。
- ★ 真正的省法：**减少下载量** —— 少发版、非必要不推送、包别越打越大（现在 109 MB）。

### AI5 交代口径（别再让用户以为「被骗了」）
「6 个月免费」**只对存储成立**。当初的指引就写了「说实话，不是免费」，并列了流量单价与估算
（`得物蓝V-COS开通操作指引.md` 第 48~52 行 / 第 370~396 行）。**不是遗漏，是流量从来不在免费范围里。**

---

## AJ. ★★ 「更新源能不能改 / 自动更新能不能关」—— 可行性实测（2026-10-03 · 第二十轮）

用户问这两件事，**当下不想做决策**。结论：**两条路都还在，且都不动数据**；现在不决策是安全的。

### AJ1 源地址是**编译进包**的 ⇒ 「改源」= 重发包（不是配置项）
- `package.json` → `build.publish.url = https://dewu-bluev-release-1499238579.cos.ap-guangzhou.myqcloud.com/`
  → 打包时写进 **`resources/app-update.yml`（在 asar 外面）**。实测已装副本（`dist/win-unpacked/resources/app-update.yml`）
  原样四行：`provider: generic` / `url: …/` / `channel: latest` / `updaterCacheDirName: dewu-bluev-publisher-updater`。
- ⇒ **每个已装客户端各自带一份源地址**，运行时改不了（electron-updater 官方不建议 `setFeedURL`；
  改了 = 把客户端指到别处甚至直接失联）。`src/main/updater.js` 文件头铁律 2 就是这条。
- ⇒ **改源 = 打新包 + 让同事装上它**。两条分发路径：
  - ① 把新包放到**旧源**上 → 同事从旧源更新到新版 → 新版里带着新地址（**平滑过渡**，最省事）；
  - ② 直接手动发安装包（微信 / U 盘）**覆盖安装**。
- ★ **覆盖安装不动数据**：配置 / 账号在 `%APPDATA%\dewu-bluev-publisher\`（config.json、auth.json），
  台账在 `paths.output`，**都不在安装目录** ⇒ 路径、账号、发布历史全保留、不用重配。

### AJ2 「关掉自动更新」的三种代价（按贵贱排）
| 做法 | 改动 | 生效范围 |
|---|---|---|
| **现在就这样**（推荐） | 无 | 已经是「自动**检查** + **手动**下载 + **手动**安装」：`AUTO_DOWNLOAD=false`、`autoInstallOnAppQuit=false` ⇒ 不会静默升级、不会把发布任务拦腰截断 |
| 加一个「关闭自动检查」开关 | 纯 App 侧：`index.js:92` 那处 `scheduleStartupCheck()` 加条件 + 界面勾选框 + store 键 | 只对**装了新版**的机器生效；旧版仍会 20 秒后检查一次（但不下载、不安装） |
| **零代码立即停更** | 把源上 `latest.yml` 改名 / 挪走 | **所有**已装客户端立刻检查失败；不下载、**不花流量**；放回即恢复 |

- ★ **现在没有**「关闭自动检查」的开关：grep `autoCheck|checkOnStart|update.*enabled` 全空，
  只有 `src/main/index.js:92` 一处**无条件**调用 `updater.scheduleStartupCheck()`（启动后 `STARTUP_DELAY_MS=20s` 一次）。
- ★ 界面（设置 → 应用更新，`updateHtml()`）只有：通道切换（正式/测试，**管理员专属**）、检查更新、下载更新、
  立即安装并重启 —— **没有**"不再检查"这类开关。

### AJ3 唯一"不可逆"的只有一件事
**已经发出去的版本没法被远程改行为** —— 任何行为改动都得靠新包。但这不是"锁死"：
要付的代价只是**多打一次包**；数据面（配置 / 账号 / 台账）从不受影响。
⇒ 所以「现在不做决策」不会给将来挖坑。

### AJ4 ★★ 实测：源上现在有什么 + **「不点下载就不花钱」**（2026-10-03 10:5x，匿名 GET）
- `latest.yml` → **200，353 字节**：`version: 1.0.8`，包 `得物蓝V素材发布工具-1.0.8-x64-win.exe`，
  `size: 114024197`（**108.7 MB**），`releaseDate 2026-10-03T02:46:51Z`
- `beta.yml` → **200，373 字节**：`version: 1.0.1-beta.2`，包 **89.2 MB**
- ★★ **`AUTO_DOWNLOAD=false` ⇒ 发现新版本只提示、绝不自动下载**；且**检查只读 353 字节的 yml**
  ⇒ **流量费只发生在「有人点『下载更新』」那一刻**（108.7 MB × 0.64 元/GB ≈ **0.068 元/次**）。
  ⇒ **「不发新版 + 不点下载」= 流量费恒为 0** —— 既**不用挪 yml、也不用改 App**。
- ★ 挪走 yml 反而更糟：客户端每次启动都报「检查更新失败」，界面难看（同事以为坏了）。

### AJ5 单价（官方文档口径 —— **修正 §AI 的 0.5 元/GB**）
| 计费项 | 单价 |
|---|---|
| 外网流出流量 | **0.64 元/GB**（标准存储·中国大陆；§AI 写的 0.5 是低频/CDN 口径） |
| 存储容量 | **0.13 元/GB/月** |
| 请求（读/写） | **0.01 元/万次**，★**不足 1 万次也按 1 万次计** |
| 冻结 | ★ 结算后按**账单金额的 120%** 冻结下月预估 ⇒ 「余额变少」≠ 已真实出账 |
- 反推「两毛钱」：0.2 ÷ 0.64 ≈ 0.31 GB ≈ **3 次 108.7 MB 下载**（或含 beta 89 MB 的混合）。
- 纯存储量级：桶里 ~0.2~0.4 GB ⇒ **约 0.03~0.05 元/月**（可忽略）。

### AJ6 「彻底归零」的动作（**不需要改 App**）
1. 删桶里**两个 exe + 两个 blockmap** ⇒ 没有可下载的东西：存储费≈0，手滑也下不了。
2. `latest.yml` / `beta.yml` 二选一：
   - **留着**（推荐）：客户端检查 → 「发现新版本」停在可下载态，**界面不报错** —— **不用改 App**；
   - **删掉**：客户端报「检查更新失败」；要界面干净就得改 App ⇒ **又多一次发包**。
3. ★ 只有想连「启动自检那 1 次请求」也归零（`index.js:92`），才需要改 App ⇒ **最贵**。

### AJ7 停更后手动发版（唯一路径）
- 发**安装版** `…-x64-win.exe`；**覆盖安装保留数据**（`%APPDATA%` 配置 + 输出目录台账）。
- ★ **108.7 MB 超过个人微信 100 MB 上限** ⇒ 必须走**企业微信**（内部会话上限 10 GB）或微盘/网盘。
- ★ 停更后同事版本**冻住**，有 bug 只能挨个发。
- ★ `package.json` 的 `build.publish` 若留着，以后按惯性跑 `tools/upload-release.js` **会又把包传上去** ⇒ 要交代防手滑。

---

## AK. ★★ 从网页分发安装包 —— 覆盖安装机制 / 「多个 exe」/ 谁付流量（2026-10-03 · 第二十二轮）

### AK1 覆盖安装：程序只会有一份（**NSIS 模板源码级证据**）
- `installSection.nsh:52` → 装新版**前**先 `!insertmacro uninstallOldVersion`；实现在
  `include/installUtil.nsh:142`：读注册表 `UninstallString` → **静默跑旧版卸载器** → 再装新版。
- 安装目录**被记住**：装完 `include/installer.nsh:104` 写
  `HKCU\Software\<APP_GUID>\InstallLocation = $INSTDIR`；下次安装 `assistedInstaller.nsh:112/117`
  把它读回来当默认 ⇒ **装回同一处**。
- `deleteAppDataOnUninstall: false` ⇒ **卸载不删数据**。
- ★ 本机（开发机）注册表里**查不到安装记录** ⇒ 以上是**模板源码级证据**（★ 安装位置更正见 §AL5），不是"本机装两遍"的端到端实测。
- 出包**只有 nsis 一个 target**（无便携版）：`win.target=[{target:'nsis',arch:['x64']}]`；
  `oneClick:false`（有向导）/ `perMachine:false`（按用户装）/ `allowToChangeInstallationDirectory:true`。

### AK2 ★ 「一个电脑里多个 exe」= **下载目录里的安装包**，不是多份程序
- `artifactName` 带版本号 ⇒ `…-1.0.8-x64-win.exe`、`…-1.0.9-…exe` 每版一个文件，
  **浏览器不会覆盖**（只有完全同名才加 `(1)`）。
- ★ **网页无权删本机文件**（浏览器沙箱）⇒ 做不到"下载时自动覆盖旧安装包"。
- 只能缓解：分发页只挂**最新版一个链接** + 写明「装完请删掉安装包」；
  或让用户浏览器设「每次询问保存位置」并**固定选同一路径**（Windows 才会问"要替换吗"）。

### AK3 「放到网页上分发」谁付流量
- 通用：**从网页下载必然产生流量**，区别只在**谁付**：自建（COS/服务器）= 自己付（0.64 元/GB）；
  平台托管 = 平台承担（通常不收你的钱，但有**寿命 / 额度**风险）。
- 量级参考：10 台 × 108.7 MB = **1.09 GB/次发版** ⇒ 走 COS 约 **0.7 元**。
- ★ WorkBuddy 的部署沙箱（`*.app.workbuddy.host`）**能活多久不保证** ⇒ 不适合当长期分发渠道。
- ★ 用户口中的「插件中心页面」在本机**找不到对应物**（★ 第二十三轮已找到，见 §AL1）（搜 `插件中心`、`Claw`、各工作区 html 均无）
  ⇒ **已向用户问清是哪个页面/项目**，未编造结论。

## AL. ★★ 「插件中心」网页分发 —— 拿到页面后的实测（2026-10-03 · 第二十三轮）

### AL1 插件中心是什么（已确认，上一轮的悬案结案）
- 地址 `https://3e2624b10cac4379a377add002cbd2a5.app.workbuddy.host/`；
  响应头 `server: CloudStudio Gateway` ⇒ **CloudStudio 沙箱静态站**（与 `board-site/` 同一机制）。
- 内容＝Chrome 扩展分发页（得物采集助手 / 天猫 / 京东 / 小红书 / WPS 工具箱 / 在线工具箱）。
- 分发文件就在**同域**：`dl/dewu-collector.zip`（实测 456077 B）、`dl/wps-toolbox-0.1.4.zip`（41455 B）、
  `/assets/favicon.ico`（27288 B）⇒ **它一直在免费分发文件**，没人向用户收过那类费用。
- ★ **源码不在本机**：桌面 `dewu-collector.zip` 是 9-15 旧版（433224 B），线上是 9-24 新版（456077 B）
  ⇒ 改这个页面**得先找到它的源项目**（本机搜不到，只在桌面找到扩展包本体）。

### AL2 ★★ 页面自带「version.json 自动同步」＝现成的分发机制（可直接复用）
- `syncVersion(p)`（页面内联脚本）：拉 `p.versionUrl`（得物采集助手配的是相对同域的 `version.json`）
  → 取 `latest` / `released` / `file` / `changelog` → **用 `base + '/' + v.file` 重拼下载地址**
  → 覆盖版本号/日期/日志后重绘当前面板；**失败就什么都不做**（先用手写兜底数据渲染，不会白屏）。
- 实测 `version.json` **线上存在**（HTTP 200 / `application/json`）：
  `{"latest":"1.5.7","released":"2026-09-24","file":"dl/dewu-collector.zip", ...}`。
- ⇒ 要把 **App 安装包**接进去：**只需在分发目录放 `version.json` + 包本身**，
  页面会自动显示新版本号与新下载地址（**不用改页面的下拉数据**）。
- 下载按钮是 `<a href="dl/xxx" download>`；`download` 属性 ⇒ 同域**强制下载**而不是在浏览器里打开。

### AL3 ★ 页面作者留的坑：站走 CDN，**部署后缓存不主动失效**
- 页面注释原文：`CDN 会把 /dashboard/index.html 缓存住（部署不会主动失效），带上变化的参数才能每次穿透缓存拿到最新版看板`
  ⇒ 所以它取看板时**手动带时间戳**。
- ★ 我**测不出来**：`version.json` / `dl/*.zip` / `index.html` 的 `cache-control`、`age`、`x-cache`、`via`
  **全被网关抹掉**（只有 html 有 `age: 0`）⇒ **不写「有/没有 CDN 缓存」这种结论**。
- ⇒ 若把 electron-updater 的源指到这里，**必须先专门验 `latest.yml` 会不会被缓存成旧版**
  （updater 取清单时**不带**任何防缓存参数，这是它与页面 JS 的关键差别）。

### AL4 ★★ 「避免一个电脑里有多个 exe」的正解＝**走 App 内更新**（本机实测）
- `%LOCALAPPDATA%\dewu-bluev-publisher-updater\`（= `updaterCacheDirName`）实测内容：
  - `installer.exe` **108.74 MB** ← **固定文件名 ⇒ 每版覆盖写，不堆积**
  - `current.blockmap` 0.11 MB
  - `pending\得物蓝V素材发布工具-1.0.6-x64-win.exe` 108.74 MB + `pending\update-info.json`
    （含 `sha512` / `isAdminRightsRequired:false`）
- ⇒ **App 内点「下载更新」的包落在这里，不进「下载」文件夹**。
- ⇒ 对照：本机「下载」文件夹有 **10 个**历史安装包（190 MB~566 MB）⇒ **从网页下载必然堆 exe**。

### AL5 本机安装位置实测（更正 AK1 的最后一条）
- 桌面 `.lnk` 目标（latin1 段可读）：`D:\bluevbeta\dewu-bluev-publisher\得物蓝V素材发布工具.exe`；
  该目录含 `Uninstall 得物蓝V素材发布工具.exe`（220 MB，Oct 3 03:25）⇒ **本机确实装了**，且在**自定义目录**。
  ⇒ 上一轮「注册表查不到安装记录」**是工具问题，不是事实**。
- ★★ 环境坑：**本会话的 PowerShell 工具返回空 stdout**（连 `$PSVersionTable.PSVersion` 都没输出，
  不是权限、不是报错）⇒ 查注册表 / COM / 快捷方式这类活**改用 Node 或 Bash**。
- ★ 读 `.lnk` 目标路径：目标串可能只存在于 **ANSI 段**，`utf16le` 读出来是空的 ⇒ 要 **两种编码都试**。

### AL6 「换成插件中心会不会收费」的诚实口径
- **确定**：不走 COS 那种「外网下行 × 0.64 元/GB」计费（它现在就在免费分发 zip，实测可下）。
- **不确定**：WorkBuddy 沙箱托管本身的额度/计费 —— **官方文档站没有部署计费说明**
  （已读 `codebuddy.cn/docs/workbuddy/Overview`，只有功能与界面说明）。
  第三方帖口径（**未官方证实**，别当结论用）：一键部署免费起步、底层占 CloudStudio 资源超量才计费、
  免费版可开 10 个云应用 / 每应用每月 5000 资源点 / 5 GB 存储；**工作空间闲置超 30 天会回收**。
- ★ **未实测**：**109 MB 单文件能不能成功传上沙箱**（该站现存最大文件才 456 KB）。
- ⇒ 结论口径：「**不花 COS 那笔钱**是确定的；沙箱这条路**长久不长久不保证**，当临时分发可以，当长期分发渠道要先验。」


## AM. ★★ 覆盖同版本号发版（2026-10-03 11:2x · 热词库 v1.0.8b）—— 实操与后果

- **用户口径（当场选定）**：红线「最」保持**单字拦**（选 A，不改）；发版方式＝**覆盖 1.0.8、不涨版本号**；
  本机已装副本**不动**（当时 4 个实例在跑）。
- ★★ **覆盖同版本号的真后果**（已如实告知并写进提交信息）：`electron-updater` **按版本号比较**
  ⇒ 源上 `latest.yml` 仍是 1.0.8 时，**已装的客户端判「没有新版本」，静默收不到**，只能手动重下安装包；
  而应用内「当前版本」是**包内写死**的 ⇒ 界面同样显示 1.0.8，**用户自己分不清装的是哪一版**。
  只有**新下载的人**拿到新版。⇒ 「不给已装用户弹更新」是它的用途；想让老用户也收到，**必须涨号重发一次**。
- ★ `tools/upload-release.js` 自带 `versionGate`：同版本号**默认拦下**并打印原因，**必须 `--force`** 才过
  （这就是第二道提醒；我们这次是明确要覆盖才加的）。
- ★★ 覆盖时**唯一能区分新旧**的字段＝`latest.yml` 的 `sha512` + exe **字节数**（`version` 一样、文件名一样）。
  实测：新包 **114,027,790 B** / md5 `2a3908eecd5e17282af1af33192ea620`；
  旧包 **114,024,197 B** / md5 `9d630c475672dc8fa03de8b9945de73b`（差 3,593 B）。
- **实操顺序**（本次全程走通）：提交（只加自己改的）→ `git worktree` 干净快照 → **在快照上跑全套回归**
  （＝包里的字节）→ 打包 → 包内核对 → `--dry-run` → `--force` 真传 → **公网核对**（含**整包下回算 sha512**）
  → 归档旧 `dist/` 产物 → 摘联接/删快照/删临时 `.env` → `git ls-remote == rev-parse` 取证。
- ★★ **包内核对的断言方向要跟着功能翻转**：v1.0.8 时查的是「包里**没有**任何词库界面」，
  这次必须查「词库界面**确实在**」；顺手加了三条防「只加函数没删常量」的负向
  （`const ALL_WORDS` / `const PREFIX_WORDS` 必须 **0**）。本次 **39 项全过 / 0 失败**。
- ★ 本次三个新坑：
  ① 核对脚本里 `require('@electron/asar')` 是按**脚本文件所在目录**向上解析 ⇒ 放 `_patchtmp` 里跑会
     `MODULE_NOT_FOUND`，要把脚本**复制进快照**再跑（技能里写的「在 _rel 下跑」指的是这个）。
  ② 抠包内源码真跑时，`hotwords.js` 有 `require('../store')`，而 `store.js` 会 `require('electron')`
     ⇒ 纯 node 下必崩。用 `Module._load` **拦 `'../store'` 返回 stub**（`{get:()=>null,set(){},load(){}}`）。
  ③ **Git Bash 的 `/tmp` 与 Windows Python 的路径不通用**（`curl -o /tmp/x` 之后 python 读 `/tmp/x` 报
     FileNotFoundError，而 bash 的 `ls` 也看不见）⇒ 落盘证据一律用显式 `D:/...` 路径。
- 本次数字：快照回归 **17 套 1054 项全绿**；包内核对 **39/39**；asar 全扫 `read=2153 / 50623484 B`
  （`listPackage` 条目 2516、抛错 363 个是目录）；公网**整包 sha512 == 清单 sha512 → True**；
  `beta.yml` 停在 1.0.1-beta.2（**没被动过**）；提交 `5ea1d66`，`ls-remote == rev-parse` ✔。


### AM1 ★★ 记忆「上限」是**字符**，不是字节（2026-10-03 实测，我踩过并已更正）

- 症状：拿 `wc -c` / 文件大小判「本工作区 `MEMORY.md` 有没有超 3000 上限」⇒ **虚高近 3 倍**
  （中文 UTF-8 占 3 字节），于是把「**还剩 25 字符**」误报成「已 5586、超限被截断」——
  给用户报了一个**假结论**（下一轮实测后当场更正）。
- 实测数字：本工作区 `MEMORY.md` = **字节 5594 / 字符 2975**（上限 3000，剩 **25**）；
  用户级 `~/.workbuddy/MEMORY.md` = **字节 8002 / 字符 3950**（上限 4000，剩 **50**）。
- ⇒ 判据一律 `len(open(p, encoding='utf-8').read())`；**禁用** `wc -c` / `os.path.getsize` / `ls -l` 判超限。
- ⇒ 「顶格」≠「已截断」，要盯的是**剩余量**：两份当前分别只剩 50 / 25 字符 ⇒ **再加一条就会从尾部静默截断**。

---

## AN. ★★ 产出类任务的「品牌归属」漏一处 ⇒ 明明选了品牌却报「请先选择品牌」（2026-10-03 11:4x）

### AN1 现象与根因（用户实报）
「模拟器发布」页点「导入内容报告」→ 弹「请先选择品牌（可选：…）」，而标题栏**明明选着**品牌。
- 渲染层 `BRAND_SCOPED_TYPES = ['copy.generate','report.import','sheet.export','publish.run','publish.rerun']`；
  主进程 `jobs.run` 第一句就是 `brands.resolveFor(actor, args.brandId, { required: BRAND_SCOPED.has(type) })`。
- 渲染层原来只有 `runJob()` 会补 `state.brandId`；**`sheet:importReport` 是全仓唯一绕过 runJob 直接调
  `appApi.run` 的产出类调用点** ⇒ 主进程收到空 brandId。
- 品牌数 ≥2 时 `resolveFor` **绝不替用户挑**（只有 `length===1` 才 auto）。实测用户本机 brands=2、`copy.defaultBrandId=''`。

### AN2 修法与守卫（★ 判据写法有两个坑，都踩过）
- 抽出 `brandArgs(type, args)`（补 brandId 的**唯一**一处），`runJob` 与 importReport 都走它。
- `uicheck` 加长期守卫：源码里**不许**出现裸调 `appApi.run('<产出类任务>'`。判据必须写 `',(?!\s*brandArgs\()'`：
  1. 只查 `appApi.run('x'` 这个**子串**，会把 `appApi.run('x', brandArgs('x',…))` **误判成漏点**（已修好的行照样红）；
  2. `\s*(?!X)` 里的 `\s*` **能匹配 0 个字符** ⇒ 前瞻退到空位上做检查、**恒真** ⇒ 好版也红。
     ⇒ **负向前瞻前不许放可匹配空的量词**，要「紧跟逗号」写。
- 自证：好版 156 绿 → 把修复拆掉**真红且点名 `report.import`** → 逐字节还原 → 再绿；全量 17 套 / 1056 项。

### AN3 未换包时的临时绕法
把其余品牌**停用**，只剩 1 个 ⇒ `allowed()` 的 `enabledList()` 只剩 1 个 ⇒ `resolveFor` 走 `length===1 → auto`，不再报错。

---

## AO. ★★ UI 定位表：**生效的是「猜的」那份，实测那份还没导入**（2026-10-03 11:4x）

- 读本机 `config.json` 实测：`publish.uiMap.generatedAt = 2026-10-02 23:24`、图文 13 / 视频 14 步、
  **每步都是 `unverified`**、第 1 步 `tapText "发布"`（＝`suggest()` 的兜底猜测）。
  来源正是 **dumpsys 通道**（`ui-dump-20261002-2324.xml`：98 节点、**非空 text 数 = 0**）⇒ 属于「不许拿来生成定位表」的那类 dump。
- 凌晨那轮（会话 B）产出的 `uiMap-实测-20261003.json`（13 / 15 步、逐步 `verified`）**躺在交付目录，没有导入**。
- 离线对账（把真机 dump 当靶子，跑程序自己的 `uimap.findNode`）：**图文 10 命中 / 0 落空，视频 12 命中 / 0 落空**
  ⇒ 那份实测表可直接导入使用。证据 `_定位表对账-实测表×真机dump.txt`。
- ★★ 两个**机制缺口**（不是 bug，是动作类型没覆盖）：
  1. **多图发不出去**：`tapId flThumbSelect` 取**第一个**匹配节点 ⇒ 永远点相册第 1 格；格子无文字/无描述，
     且 `STEP_ACTIONS` 里**没有「按坐标/按序号点」** ⇒ 一条内容有多张图时只能发第 1 张。
  2. **话题只配了 1 步**：发布单有 `话题1`~`话题5` 五列，表里只有 `input ${topic1}` ⇒ 其余 4 个**静默不写**；
     且该步之前焦点还在**正文框**（上一步刚打完正文）⇒ `#话题` 会**粘在正文末尾**（是否被得物认成话题链接 **未验**）。
- ★ `runStep` 的 `tapText/tapId` 走的是 `adb.dumpEx(serial)`（**没传 pkg**）⇒ 不会退 dumpsys 备用通道；
  但 `dumpEx` 自带「临时关动画重试」⇒ 实测发布页首屏关动画后能抓到，实际够用（**别把这条当成"备用通道永远用不上"的理由**）。
- 两份「可点但 clickable=false」的实测节点（`tvGoHomePage`「主页」、页签「照片/视频」）：`runStep` 是**按坐标 tap**、
  不看 clickable ⇒ 实测有效，不必改表。

---

## AP. ★★ 插件中心网页分发：得物蓝V 已接入 + 修掉一个原有 404（2026-10-03 12:0x · 第二十四轮）

### AP1 事实：线上地址与部署目录
- **新地址**：`https://6e5b9dc28eaf4ec4ad57303bc0f16039.app.workbuddy.host`
- **要部署的目录**（以后只改这里）：`E:\WORKBUDDY\2026-09-30-17-35-35\pluginhub-site\`
- 工作副本 `D:\work\_pluginhub\site\`；原页面备份 `site\index.html.bak-7c4eb081`（md5 `7c4eb081…`）。
- 源码来源：用户通过飞书发来的 `E:/飞书/飞书文件/plugin-hub-src.zip`，里面**只有 `deploy/` 产物**
  （`index.html` + `version.json` + `dashboard/` + `dl/` + 图标）—— 这个单文件 `index.html` **就是源码**
  （页头注释：「改文案 / 加插件：只动 PLUGINS 数组」）。与线上 `3e2624b1…` 的 index.html **sha256 逐字节一致**。
- ★ **原站点（`3e2624b1…`）不在本机**：它的工作区 `WorkBuddy/2026-09-29-10-12-49/` 在本机**不存在**
  （`C:/Users/Administrator/WorkBuddy/` 下没有），所以**没法往那个地址上更新**。两个地址现在并存。

### AP2 ★★ 同目录重部署 = 同一个地址（实测两次）
连续两次部署 `pluginhub-site/`，返回的 sandboxId **都是** `6e5b9dc28eaf4ec4ad57303bc0f16039`。
⇒ 更新流程 = 改目录里的文件 → 重新部署 → **链接不变**。
（上一次部署的看板 `board-site/` 是 `dcf9a696…`，另一个目录另一个地址 ⇒ 映射是按**目录**的。）

### AP3 ★★ 109 MB 单文件能托管（原本是最大的未知）
`dl/dewu-bluev-publisher-1.0.8-x64-win.exe` = **114 027 790 B**，14.5 万倍于原来站上最大的文件（456 KB）。
- 整包 GET：**200，114 027 790 B，sha256 与本地逐字节一致**（`afe27d78…`）。
- 速度：首次 6.9 s（≈15.8 MB/s），复测 10.1 s（≈11 MB/s）。**没有大小限制的迹象。**
- exe 的 sha512 前缀 `uZtmTviFmdYlhzpCACPougA8` 与 `dist/latest.yml` 记录一致 ⇒ 就是正式版那个产物。

### AP4 ★★ 网关特性：**不支持 Range**、抹掉 `content-length`
带 `Range: bytes=0-99` 请求 → 返回 **HTTP 200 + 整包（114 027 790 B）**，没有 `content-range`/`accept-ranges`；
`transfer-encoding: chunked`（**没有 `content-length`**）。响应头里能看到
`server: CloudStudio Gateway`、`eo-cache-status`（腾讯 EdgeOne CDN）。
- ⇒ **浏览器下载没问题**（实测下得回来、字节数对）。
- ⇒ ★★ **不要把 App 的自动更新源指到这个站**：electron-updater 的差量下载（blockmap）要靠 Range。
  **这一条我没有验证过，不许当成"可以"。**
- 注意：小文件的 `cache-control` 也被网关抹掉（之前看板那轮就量到过）。

### AP5 修掉原页面的一个真 404（影响「得物采集助手」，不是新加的）
- 症状：线上「得物采集助手」的「下载最新版」href = `version.json/dl/dewu-collector.zip`
  → 实测 **HTTP 200 但正文是首页 HTML**（走的是「路径不存在 ⇒ 回落 index」规则，所以看不出错）。
- 根因：`var base = p.versionUrl.replace(/\/[^\/]*$/, '');`
  对 **`version.json` 这种不带斜杠**的 `versionUrl` **不匹配** ⇒ 整个文件名被留下 ⇒ 拼出 `version.json/dl/…`。
  （`dl/bluev-version.json` 有斜杠，所以新加的那个不受影响。）
- 修法：`replace(/[^\/]*$/, '')`（只去掉文件名、留目录），并改成 `base + String(v.file).replace(/^\/+/,'')`。
- 前后对照（同一个审计脚本、同一台机器）：
  | tab | 修前 | 修后 |
  |---|---|---|
  | 得物采集助手 | `version.json/dl/dewu-collector.zip` → **HTML** | `dl/dewu-collector.zip` → **ZIP ✓** |
  | WPS | 正常 | 正常 |
  | 蓝V发布（新） | — | `dl/dewu-bluev-publisher-1.0.8-x64-win.exe` → **EXE(MZ) ✓** |

### AP6 新加的东西（改的都是 `index.html` 一个文件）
- `ICONS.bluev`（纸飞机）+ `PLUGINS` 第 7 个条目（**排在最后**，`DEFAULT_ID` 仍是 `dewu`）。
- 渲染层加两个可选字段：`p.saveAs`（`download="…"` 让同事存下来是中文名，URL 里仍是 ASCII）、
  `p.howTitle`/`p.howNote`（「怎么装」标题/副标题可以按插件改）。
- `syncVersion` 支持 `v.saveAs`；版本文件放 `dl/bluev-version.json`（base 推导出 `dl/`）。
- 页面上的更新日志（1.0.6/1.0.7/1.0.8）**全部抄自 git 发版提交**，没有编造。
- ★ 补丁脚本 `D:\work\_pluginhub\patch-hub.py`：7 条改动**先全校验锚点 count==1 再落盘**，回读校验 8 条
  （含「PLUGINS 条目数变成 7」「行尾仍是 LF」「旧文案消失」）。

### AP7 以后怎么发布里加新版本
1. 换 `pluginhub-site\dl\` 里的 exe（ASCII 名，如 `dewu-bluev-publisher-1.0.9-x64-win.exe`）
2. 改 `dl/bluev-version.json` 的 `latest`/`released`/`file`/`saveAs`/`size`/`sha256`/`changelog`
   （`index.html` 里写死的兜底值也可以顺手改，不改也行——线上拉到 JSON 就用 JSON 的）
3. 重新部署 `pluginhub-site/` → **链接不变**

★ 别忘了 `index.html` 里那个兜底 `downloadUrl` 指向的是**具体版本号的文件名**；
   若只改 JSON 不改它，断网时兜底会指向旧包（影响很小，但要知道）。

### AP8 脚本
- 逐 tab 审计（本地/线上都能跑，会真发请求验证下载地址不是 404 回落的 HTML）：
  `D:\work\_pluginhub\_hub-audit.js`（用**环境变量** `HUB_URL`/`HUB_WAIT` 传参
  —— ★ Electron 自己的开关会混进 `process.argv`，用位置参数拿不到）
- 线上内容/安装包核对：`D:\work\_pluginhub\_hub-verify-online.js`
- 截图：`D:\work\_pluginhub\_hub-shot.js`
- 跑法都要 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` + `--in-process-gpu --disable-gpu`

### AP9 ★★ 「给了源码也换不掉别人的地址」——同一份源码 ≠ 同一个地址（2026-10-03 20:5x 实测）
用户问：「我给了你插件中心的源码，但是你没法配置，为什么」。逐条实测后的答案：

1. **他给的 zip 是「另一台机器的工作区导出」，不是源工程**：`plugin-hub-src.zip`（644 170 B）共 **16 个条目**，
   顶层就是 `WorkBuddy/2026-09-29-10-12-49/deploy/`（`index.html` 70 868 B / `version.json` / `dashboard*` / `dl/*.zip` / `assets/`）。
   ⇒ **没有构建脚本、没有插件清单源文件、没有服务端** ⇒「配置」只能手改这几个静态文件。
2. ★ 决定性证据：那份 `deploy/index.html` 的 md5 = `7c4eb08198e26a01ca1d64fd2a6d5f0f`
   = **线上原站 `3e2624b1…` 首页的 md5（我当场 curl 下来算的，逐字节一致）**；
   而同一份东西在**我这边**的目录部署出来是 `6e5b9dc2…`。
   ⇒ **地址不跟源码走，跟「谁在哪台机器的哪个目录部署」走**（配 AP2：同目录两次 = 同址；换目录 = 换址）。
   ⇒ 所以「更新同事已经在用的那个旧地址」这件事，**拿到源码也做不到** —— 只能新地址发出去，或把旧工作区搬回本机同路径（未验证）。
3. 现场状态（20:5x 实测）：原站 `3e2624b1…` **仍 200 活着，页面里 `bluev` 出现 0 次**，挂的还是
   `dl/dewu-collector.zip` + `dl/wps-toolbox-0.1.4.zip`；我那个站有 bluev 条目但**版本仍 1.0.8**。
4. ★★ **200 ≠ 文件存在**：这个网关「路径不存在 ⇒ 回落首页 HTML」。实测 `…1.0.9…exe` 取头两字节 = `3c21`（`<!`）= 回落；
   `…1.0.8…exe` = `4d5a`（`MZ`）= 真包。**判存在必须看文件头字节（或整包 sha256），别信状态码、也别信 `-r 0-0`**（网关不支持 Range）。
5. 想让 hub 显示 1.0.9 = ① 把 `dist/` 里那个 1.0.9 exe（107 047 201 B）放进 `pluginhub-site\dl\` → ② 改 `dl/bluev-version.json`
   → ③ 重新部署（链接不变，见 AP7）。**这三步都在我能力范围内，只是等用户放话。**

## AQ. ★★ 「关联好物」：货号+颜色成对 / 最多 3 个好物 / 条件步骤 when·whenNot（2026-10-03 12:3x · 第二十五轮）

用户给的三个新事实（原话）：
> 「一般文件都有货号+颜色，刚刚我抓取的页面只放了货号，没带颜色」
> 「如果有多个好物需要关联，需要点击两次关联好物」
> 「我刚刚点击了第一个商卡，已经抓了」

### AQ1 12:10 那份 dump 的核查 —— 悬案从「推断」变「实测」
`rvRelevantProduct` 下有 **1 张已关联卡**（`tvName` = 卡宾 T 恤 + 可点的 `ivDelete`）
⇒ ★ **点一下商卡 = 立刻关联并退回发布页**。上一轮「不敢代点」的问题，由用户自己点出了答案。

### AQ2 结果页 = 「颜色格子墙」（三条实测）
- 商品卡片**根节点无 id、无文字**（`grep 卡宾` = 0 处：商品名自绘、dump 抓不到）。
- 唯一可匹配的文字是 `tvCSpuInfo`（颜色，实测 `clickable=true`）。
- **同色会重名**：一页里「米白色12」出现 3 次（不同款）⇒ `tapText` 只取第一个，分不出是哪款。

### AQ3 两个零残留探针的结论（各只开搜索页看一眼再返回；草稿关联数 1 进 1 出）
- **搜索框每次打开都是空的**（占位文字「搜索好物」）。
- ★ **`ivClear` 只在搜索框非空时存在** ⇒ 不能无条件点「清空」（会硬失败）。

### AQ4 新机制：好物 1~3 占位符
发布单 6 列「好物1货号 / 好物1颜色 … 好物3货号 / 好物3颜色」→ 占位符
`${goods1Sku} ${goods1Color} … ${goods3Sku} ${goods3Color}`。
`publisher.js` 里 `goodsList = item.goods?.length ? item.goods : [{sku:item.sku,color:item.color}]` 兜底。

### AQ5 ★ 条件步骤 `when` / `whenNot`（只接受占位符名）
- `when` = 列出的占位符**全部非空**才执行；`whenNot` = 列出的**全部为空**才执行。
- **支持逗号分隔多键**；两字段可同时写（例：`when:'goods2Sku'` + `whenNot:'goods2Color'`）。
  单键表达不了「有货号但没颜色」这种脏行 ⇒ 所以必须多键。
- 非法值（写了非占位符名）**导入时就报错**（`normalizeCond` 抛错，`COND_KEYS=['when','whenNot']`）。
- ★ **跳过会写进运行日志**：`跳过「<步骤名>」（占位符 xxx 是空的）` —— 不许静默跳过。
- `normalizeSteps` 三处 return 都要合并 cond；导出追加 `normalizeCond, condOk, COND_KEYS`。

### AQ6 两处真机必崩的健壮性缺口（已修 + 加断言）
1. 抓结构**不带包名** ⇒ 动画页等不到 idle 时拿不到备用通道 ⇒ 统一 `adb.dumpEx(serial, { pkg: uimap.DEWU.pkg })`。
2. 找不到节点**不重试** ⇒ 改为**重试 3 次**、日志写「再抓一次」，失败仍点名缺什么。
3. ★ 备用通道**无文字**时的专门报错（别再报「找不到」这种会被当成定位表写错的错）：
   `找不到「X」：这一屏是动画页，已走 dumpsys 备用通道，而那条通道拿不到文字 —— 把这一步的 action 改成 tapId 就能过。`

### AQ7 自证（可复算）
- 全量回归 **17 套 / 1078 项全绿**（`adbtest` 105 → 127）；产物 `_全量回归-17套1078项-好物与条件步骤.txt`。
- **10 条定点破坏全部真红且点名，0 假绿**；三次还原**字节一致**（`_定点破坏-好物与条件步骤-10条.txt`）。
- v4 表用**程序自己的** `normalizeSteps / fill / condOk` 校验 + **干跑三种典型行**（`_定位表v4-校验与干跑.txt`）。
- 条件真值表 **14 组**（含多键归一化、非法 when 报错）。

### AQ8 两条硬事实（关于窗口与输入框）
- ★★ 「关联好物」搜索页 = 同一个 `TotalPublishProcessActivity` 的**第 2 个窗口**
  ⇒ `dumpsys activity top` 备用通道**看不到它**（永远抓到下面的发布页）。
- ★ **`input` 动作不会自己点输入框** ⇒ 搜货号前必须先 `tapId etSearch`。

### AQ9 v4 定位表
`uiMap-实测-20261003-v4.json`：图文 **37 步** / 视频 **39 步**；好物 1~3 各 6 步（点关联好物 → wait → 点 `etSearch`
→ input `${goodsNSku}` → wait → 按颜色 `tapText ${goodsNColor}`(`when:goodsNSku,goodsNColor`) / 退路 `tapId ivProduct`
(`when:goodsNSku`+`whenNot:goodsNColor`)）；话题 1~5 加 `when`。
★ `note` 写死：**旧版本 App 不要导本表**（老版本会忽略 `when`）。
`pending` 5 条：按颜色点格待真机验一次 / 同色多款无法区分 / 一条多图只能发第 1 张 / 发布前数好物个数（建议加）/ 图文主图后面再说。

### AQ10 踩过的坑（写给以后的自己）
- **断言别抄实现细节**：货号是**纯 ASCII** ⇒ `adb.inputText` 走 `input text` 而不是中文广播
  ⇒ 断言只查「内容出现」+「顺序」，别断言通道名。
- `adbtest.js` 里新块用的变量名要**先 grep 重名**（`pubSrc` 撞车报 `Identifier already declared`）。
- 补丁锚点一律先 `crlf()` 再匹配（本仓换行符混用）。

## §AR 2026-10-03（第十一次）：视频抽帧 / `store.set` 无删键 / 逐文件换行符

### AR1 视频素材的「看图写」——`src/main/services/frame.js`（本轮新增）
问题（用户原话）：「目前导入视频无法根据视频中的产品生成对应的文案」。
根因：`copywriter.imagePartsOf()` 只挑 `f.type === 'image'` ⇒ 视频叶子**一张图都送不出去**，
模型只拿到货号+颜色 ⇒ 标题又变成套话壳（与 2026-10-02「一看就是 ai 做的」同一个病）。

做法（用户拍板口径：「抽帧送模型，但是在尽可能少消耗模型费用的前提下做」）：
- **默认只抽 1 帧**（`copy.llm.videoFrames`，出厂 1，可 0~3）。**0 = 不抽**（只有视频的素材按货号/颜色写）。
  ★ 空串要当「没填」—— `Number('')` 是 0，会被读成「不抽」，和 vision 那个字符串 `'false'` 是同一类坑。
- 时间点 = `planTimes()`：count=1 → 片子中间（50%）；2 → 33/67；3 → 25/50/75。
  时长读不到（null）→ 全 0（抢首帧），**绝不编时长**。
- 时长优先 `imaging.videoDurationSec()`（纯 JS 读 moov/mvhd，**不启 ffmpeg**）；
  读不到（mkv/webm 这类非 ISO-BMFF）才用 ffmpeg `-i` 探一次（`probeDuration`）。实测 mkv → `durationHow='ffmpeg'`。
- `-ss` 放在 `-i` **前面**（fast seek）；抽出来直接 `scale=<imageMaxSide>:…:force_original_aspect_ratio=decrease`
  + `-q:v 5`，写**系统临时目录**（`fs.mkdtemp(os.tmpdir()/bluev-frame-)`），用完 `fs.rm(recursive)`
  ⇒ 素材目录里不留帧图（实测 before=0 after=0）。
- **空帧不送**：`looksBlank()`（采样亮度极差 < 12 ＝ 纯色/黑场）⇒ 退到 0.2s 再抢一次；两次都空 ⇒ **一帧都不送**
  （送黑图只会让模型瞎编，还白花钱）。实测整段 black 视频 → `images.length===0`、`errs` 里明写「空帧」。
- **有实拍图就不抽帧**（`if (!images.length && vid && …)`）：实拍图本来就是这件货最好的那几帧。
  ★ 测试里专门造了一个「图 + 视频都有」的叶子来钉这条 —— 只造「纯视频 / 纯图片」两个叶子的话，
    抽帧根本没接线它也会绿（典型假通过；定点破坏 D7 实测抓出 2 条）。
- 抽帧失败**不抛、不阻断整批**：`framesOf()` 返回 `{ok:false,err}`，copywriter 记原因、那一条如实标
  「视频没抽出帧」，批次照常跑完（定点破坏 D6 实测：改成 throw ⇒ 「批次照样跑完」立刻红）。
- 逐行如实标来源：`AI 看图（model）` / `AI 看图（model，视频抽帧）` /
  `AI 文字（model，视频没抽出帧）` / `AI 文字（model，视频没抽帧）` / `AI 文字（model，这条没图）`。
  ★ 「没抽出帧」与「没抽帧」是两件事，**不许混成一句**（定点破坏 D8 专门钉这个）。
- ffmpeg 通道：`video.js` 的 `runFfmpeg`/`explain` **已导出**给 frame.js 复用 ——
  「手填 > 内置 > 系统 PATH」三段解析只能有一个入口，在别处另起 execFile 迟早不一致。
- 已知未做：视频行报告里的「图片主色」仍是空的（`imageColorOf` 只看 `type==='image'`）。
  **不许**把抽出来的帧混进主色逻辑（语义不同），要做得单独设计。

### AR2 `store.set` 是 mergeDeep —— **没有删键能力**
`store.set(patch)` = `mergeDeep(cache, patch)`。删掉某个功能之后，老机器 `config.json` 里那个键
**会一直留着**（只是没人读）。⇒ 删功能的验证**只能查「读取点还在不在」**，不能断言「配置里那个键没了」。
（2026-10-03 就在 batchtest ⑥ 上栽过：断言「导入后 `uiMap.recover` 被清掉」，mergeDeep 根本不清 ⇒ 假红，
再回头才发现前提就写错了。）要真删键得另写 `store.unset`／白名单重建 —— **本轮没做**。

### AR3 换行符是**逐文件**的，不是一个仓库一种
实测（**Python 数的**；`grep -c $'\r$'` 在这台 Git Bash 里会**误报**成「全 CRLF」，不可信）：
- 纯 CRLF：`app.js` / `index.html` / `styles.css` / `jobs.js` / `video.js` / `imaging.js` / `flatten.js` /
  `report.js` / `sheet.js` / `publisher.js` / `verify.js` / `compliance.js` / `adb.js` / `pool.js` /
  `uicheck.js` / `adbtest.js` / `batchtest.js` / `logintest.js` / `smoke.js` / `reporttest.js` / `run-all.js` …
- 纯 LF：`copywriter.js` / `aireport.js` / `store.js` / `llmdefaults.js` / `copycheck.js` / `hotwords.js` /
  `cloudsync.js` / `stats.js` / `brands.js` / `updater.js` / `runlog.js` / `copytest.js` / `videotest.js` /
  `cloudtest.js` / `brandtest.js` / `logtest.js` / `upload-release.js` …
- **混合**：`src/main/services/uimap.js`（全仓唯一一个）⇒ **别整体重写它**，只能按位置定点替换。

⇒ 补丁脚本必须：读原文件 → 判它**自己的**主导风格 → 按那个风格写回；断言也要分叉
（CRLF 文件查「无裸 LF」、LF 文件查「无 CR」）。
★ 反面教材：断言写死成「不许有裸 LF」，在 `llmdefaults.js`（纯 LF）上第一次跑就假红 ——
  好在是**先校验后落盘**（assert 在写盘之前），文件没被改坏。

### AR4 抠函数跑「不许抛异常」的断言必须 `try/catch`
坏版的实现如果是**抛异常**，断言会直接被异常顶到套件外层 ⇒ 变成 `XXXTEST ERROR`、
**一条 `FAIL` 都不打**（上层只看 FAIL 行的工具就等于「没抓到」），后面的断言也不再执行。
⇒ 抠真实代码块跑时必须 `try{...}catch(e){err=e.message}` + 断言「**没有抛异常** 且 返回值符合预期」。
实测（定点破坏 D5）：改前＝`退出码 2 / FAIL=0`（假通过的味道）；补上 try/catch 后＝
`FAIL  J11) …→ 抛异常了：boom`，一眼就指名道姓。

### AS1 ★★ `publisher.connect()` 的自检**禁**拿「当场这次的 dump 成没成功」当能力

- 症状（用户实报）：点「开始发布」→ 界面一路绿、日志写「模拟成功」→ **设备毫无动静**。
- 根因：旧 `ready` 里算了 `p.tools.uiautomator`，而那是**当场这一次** `uiautomator dump` 的成败；
  而「模拟器正停在得物发布页」= 发布前的**正常状态**，恰恰就是动画页（`could not get idle state`）⇒
  `ready=false` ⇒ 通道被静默降级成 `'mock'`。
  ★ 这是把**偶然现象**当成了**稳定能力** —— 结构性错误，不是抖动。
- 修法：`ready = !!(p.device && (p.tools.uiautomator || p.tools.dumpsys) && p.tools.input && p.appPackage)`
  —— 两条抓取通道**至少通一条**就算能发布。配套：`adb.probe()` 在 `uiautomator` 失败时**单独再验一次**
  备用通道（`dumpViaDumpsys(serial, appPackage)`）并把结论写进 `tools.dumpsys`；
  「抓不到界面」的 bad 提示改成**只在两条都不通时**才报。
- 反向自证 3 条（全部真红且点名、还原后 md5 一致）：D1 `ready` 又算上 `uiautomator`（⇒ 通道变 `mock`）；
  D2 备用通道恒判可用（⇒ 负向对照红）；D3 根本不验备用通道。
- 实测证据：真机探针 `uiautomator: false`，而那一屏正是 `TotalPublishProcessActivity`。

### AS2 ★★ 一条内容要发多张图 = 定位表选图步写 `count`

- 相册缩略图 `com.shizhuang.duapp:id/flThumbSelect` **无文字、无描述**，只能按 id 点；老 `tapId` 取
  **第一个**匹配 ⇒ 一条内容只发第 1 张。这不是通道问题，是**动作层缺能力**。
- 新能力（`uimap.js`）：tap 系步骤支持 `count`（1~20 整数 / 占位符 / 不写=1）。
  `findNodes`（**保序**返回全部匹配）+ `countOf(v)`（缺省/空/0/负数/非数字 ⇒ 1，超上限夹住）；
  `normalizeSteps` **导入即校验**（一眼错的写法当场抛错）；`fill()` 连 `count` 一起替换占位符，
  且解析成空时**原样留着**（不能变成 `''` 被下游当「没写」）。
- 端到端（`publisher.runStep`）：dump 后取全部匹配 → 点击阶段**依次点前 N 个**（中间 `sleep(250)`），
  日志写「一次点了 N 个…坐标」；**张数不够就报错**（`want>1` 时报「要一次点 N 个…但这一屏只有 M 个」），
  **绝不静默少点**。
- 报告侧：`runReal` 的 `data` 带 `imageCount` / `videoCount`（都只看 `type==='image'`）⇒ 选图步直接写
  `"count": "${imageCount}"`。右下角按钮文字是「下一步 (1)」（带计数）⇒ 相册本来就能多选。

### AS3 ★ 待真机验证的两件事（**未验证**，别当结论用）

- 缩略图的**排列顺序**与「封面」是哪一张：`findNodes` 的保序是 dump 里的节点顺序（实测中心 x = 190/530/870），
  但「相册第 1 格就是最终封面」「发布后顺序 = 勾选顺序」**本轮没验**。
- 一条内容最多几张图（得物侧上限）**未知**；`count` 上限 20 只是我们自己的保护值。

---

## §AT 2026-10-03（第二十七轮）：`publish.device` 可能是**假名** —— 真机发布前必须核

- 症状：`publish.mode` 已是 `'adb'`、v5 定位表也导了，点「开始发布」照样发不出去。
  根因：配置里 `publish.device = "emulator-5554"`，而 **`adb devices` 里根本没有这台**。
- 实测（2026-10-03 15:35，MuMu 12）：
  ```
  adb devices →
    127.0.0.1:16384   device
    127.0.0.1:5555    device
    127.0.0.1:7555    device
  adb -s emulator-5554 shell echo ok → device 'emulator-5554' not found
  ```
- ★★ **那三个端口是同一台模拟器，不是三台**。判据（两样一起看，只看 `wm size` 会误判 —— 同一镜像当然一样）：
  ```
  getprop ro.product.model   → 三处都是 NTH-AN00
  cat /proc/uptime           → 569.03 / 569.13 / 569.23（差 0.1~0.2 秒 = 同一台）
  ```
  上线时**只用 `127.0.0.1:16384`**（MuMu 12 的规范宿主端口）。
- 设备名**一律以 `adb devices` 的输出为准**；`emulator-5554` 是 Android 官方模拟器的名字，
  **MuMu 不产出这个名字**。写死在配置里的很可能就是别人（或上一次会话）按经验猜的。
- 复核命令（一次跑完，别再逐条猜）：
  ```bash
  ADB=/d/MUMU/MuMuPlayer/nx_main/adb.exe
  $ADB start-server >/dev/null 2>&1; $ADB devices -l
  for s in $(...); do echo "--- $s"; $ADB -s "$s" shell \
    "getprop ro.product.model; cat /proc/uptime; pm list packages | grep shizhuang"; done
  ```
- ★ 配套：应用里有设备列表（`publish.devices`），用户也能在界面里自己选一台；
  但**不能指望他会想到这一步** —— 装了正式通道却因为设备名空转，现场看就是「点了没反应」。


---

## §AU 真机驱动验证 · 硬编码设备串 · 关联好物选卡（2026-10-03）

> 场景：MuMu 12 / 得物 / **1080×1920**（不是老文档里的 900×1600）/ 账号 TWM 尺码助手。
> 方法：不另写点击脚本 —— 用**发布器自己的代码**跑（`adb.js` + `uimap.js` + `publisher.runStep`，
> 因此把 `runStep` 也导出了）。驱动脚手架：假 `electron` 模块 + `app.setPath('userData', 临时目录)`
> + `adb.setBundledAdbDir(REPO/vendor/adb)`。

### A. `emulator-5554` / `127.0.0.1:5555` 这族「假设备串」有两个来源，缺一不可

1. **用户数据里存着**：`<userData>/config.json` 的 `publish.device` + `publish.devices[].name/serial`，
   以及 `project.json` 的 `publish.device` + `publish.probe.serial` + `probe.device.serial`。
   注意 `store.js` 的出厂默认是 `device: ''` / `devices: []` —— **假串不是程序预置的，是运行时被写进去的**。
2. ★★ **代码里的兜底**（真正的元凶）：`publisher.run()` 里曾是
   `const serial = … || c.device || '127.0.0.1:5555';`。
   `connect()` 的 `|| 'emulator-5554'` 早就删了，但**同族的这一条还在** ——
   表现完全一样：没选设备也能「跑起来」，实际拿一台不存在的设备去发，界面/台账全绿。
   现在 `run()` 改成 `|| ''` + 一条显式报错：「还没选设备：先点「扫描设备」…」。

> 复盘教训：**同族缺陷要一次性铲干净**。删了 `emulator-5554` 不等于删了「硬编码序列号兜底」这件事，
> 换个字面量（`127.0.0.1:5555`）就能复活。断言也要盯**模式**（`|| '127\.0\.0\.1:\d+'`），不是盯字面量。

### B. 「关联好物」结果页：点颜色文字 **不会** 选中卡片（原来那三步是错的）

实测（UWG460108 货号页 + 「卡宾」关键词页，两页都验过）：

| 动作 | 真实结果 |
|---|---|
| 点颜色标签（`tvCSpuInfo`） | 弹出 **「选择商品规格」** 弹层（`tvTitle` / `ivCspu` / `tvName` / `ivClose`） |
| 在弹层里点某个 `tvName` | 只是把**那张卡**的配色换掉，弹层关闭，仍停在搜索页 |
| 点**商品图** `ivProduct` | ★ 选中整张卡 → 返回编辑页，商品挂上（缩略图就是刚选的配色） |

几何关系（真机 dump 实测，这就是正确做法的依据）：

```
ivProduct    [35,278][354,597]    ← 319×319；能选中整卡的是它
tvCSpuInfo   [278,554][354,597]   ← 颜色文字，完全落在上面那张图里面
```

⇒ 新增动作 **`tapCardText`**：`{action:'tapCardText', value:'${goodsNColor}', card:'com.shizhuang.duapp:id/ivProduct'}`
＝ 找文字等于颜色的节点 → 取**把它包住的那张商品图** → 点那张图的**中心**（实测卡心离颜色标签 259px，不会误触规格弹层）。

**两个必须写进代码的坑**：

1. **同一屏的树里有两套互相重叠的卡片列表**（「已购」「想要」两个 viewPager 同时在树里，
   坐标错开 220px）⇒ 一个点会被两张卡同时「包住」（实测「本白」center (316,576) 同时落在
   `[35,278][354,597]` 和 `[35,498][354,597+220]` 里）。归属判据用「颜色标签贴在卡片**右下角**」：
   取 `|y2差| + |x2差|` 最小的那张。**不能取「第一张包住的」**（文档顺序不保证）。
2. **同色多款是真的**：一页里「本白」出现 3 次，各自属于不同的卡 ⇒ 要第 N 个就给这一步写 `count`。

失败策略：找到了颜色文字但**没有任何卡包住**它 ⇒ **硬失败**并说清原因，绝不退化成「点第一张」——
点错卡＝挂错商品，而且表象是「发出去了」。

### C. uiautomator「一个字都不打印」≠「报 idle 错误」，但病因相同

`dumpOnce()` 原来把 `idle` 判成 `/idle state/i.test(out)`。真机实测：得物发布页首屏（选素材相册）
有时 **`uiautomator dump` 一个字符都不输出**（不是 `could not get idle state`）⇒ `idle=false`
⇒ **「临时关掉系统动画重试」那条路根本不会走**，直接掉到 `dumpsys` 备用通道（而那条**拿不到文字**）。

实测数字：关掉三个系统动画开关（`window_animation_scale` / `transition_animation_scale` /
`animator_duration_scale` 置 0）后，**同一个相册首屏一次就抓到**（85 个节点）。
⇒ 判据改成 `idle: /idle state/i.test(out) || !out`。**用完必须还原**（`animRestore`，别把设 0 留下）。

> 用户口径（2026-10-03）：**不要备用通道**，发布入口只有「我 → 主页 → 发布新动态」这一条。
> 所以「无输出也要先关动画重试」这条修的是**主通道**，不是在给备用通道打补丁。

### D. 真机走通的（可复算）

- 底部「我」(`tab_user`) → 右上角「主页」(`tvGoHomePage`，clickable=**false** 但按坐标点有效)
  → 「发布新动态」(`rlPublish`) ⇒ 三跳全过，进 `TotalPublishProcessActivity`。
- 相册切「照片」→ 点 **3 个** `flThumbSelect`（`count: ${imageCount}`）⇒ 出现 ①②③ 角标，
  按钮变 **「下一步 (3)」** ⇒ 点 `flNextStep` 进编辑页。
- 标题/正文：`etTitle` → `input` → `etTrendContent` → `input`，**中文真的进去了**
  （ADBKeyboard 广播；`adbKeyboardActive` 必须先是 true，装完要 `ime set`）。

### E. 新踩到、**还没解决**的

1. ★★ **有草稿时，「发布新动态」会先落到一屏「草稿箱」（`DraftActivity`）**，
   要点它底部的「发布新动态」(`fl_publish`) 才进相册。定位表里**没有**这一步 ⇒
   **只要草稿箱里有东西，整条真机流水线就会卡在这里**。删草稿：`ic_delete` → 确认框「确认」。
2. **启动 App 时可能弹「是否继续编辑 / 你有未编辑完的…是否继续？」**（`tvCancel`=放弃 / `tvConfirm`=继续），
   也会挡住三跳里的第一步。同样没有对应步骤。
3. 「下一步」容器 `flNextStep` 的 `clickable=false`（文字节点 `tvNextStep` 才是 true）；
   实测点过一次没反应（怀疑是选中素材后布局动画未稳时点偏），后来同一点手动点就过了。
4. `screencap` 抓到的相册缩略图是**白块**（不影响按坐标点，但截图证据看不到缩略图内容）。
5. 商品**名字抓不到**（自绘，dump 里没有文字）⇒ 「同色多款」目前只能靠 `count` 序号区分。

### F. 反面素材（写回归时照着这个来）

- `tools/fakeadb/adb.js` 新增现场 **`DUMP_SILENT`**：动画还开着时 `uiautomator dump` 返回**空字符串**
  （复现真机这种症状）；关掉动画就成功。用来验「无输出也要走关动画重试，且**不许碰** dumpsys」。
- `tools/adbtest.js` ⑲⑳ 两组断言（+12 条）：其中「把**背后那套列表排在文档前面**」那一条是
  专门用来抓「归属判据」的 —— 去掉 tie-break 必须变红，否则等于没测。
- 反向验证：5 条定点破坏（旧 idle 判据 / 去 tie-break / 去硬失败 / 不换算卡片 / 不强制 card）
  **5 条全红**，还原后复跑 0 FAIL。回归：十七套全绿，**1156 → 1168** 项。

---

## §AV 草稿箱拦截 · 屏幕守卫 whenOn/whenNotOn（2026-10-03 第二十九轮）

### A. 断点（真机实测：MuMu 12 / 得物 / **1080×1920** / 真串 `127.0.0.1:16384`）

草稿箱**非空**时，「我 → 主页 → 发布新动态」这最后一跳落到的**不是**发布页：

```
mCurrentFocus = com.shizhuang.duapp/com.shizhuang.duapp.media.activity.DraftActivity
```

那一屏（`uiautomator dump`，7 567 字节）的关键节点：

| 节点 | 值 |
|---|---|
| `iv_draft_title` | `text="草稿箱"` |
| `tv_draft_title` | 草稿标题（本次是用户自己的 `#我在的得物当博主 `） |
| `fl_publish` | `clickable=true`，居中 **(540,1871)**，子节点文字「发布新动态」 |

- **后果**：定位表没有这一步 ⇒ 下一条「切到照片页签」当场 `找不到「照片」`（可见文本只有草稿箱那一屏的字）。
- **出口**：点 `fl_publish` → `TotalPublishProcessActivity`（相册：全部/照片/视频 + `flThumbSelect`×N）。
- **判据干净**：相册页的 dump 里 `iv_draft_title` **0 次**、`fl_publish` **0 次**。
- ★ `fl_publish` 这个 id **只在草稿箱出现**，相册页没有 ⇒ 拿它当"点哪"是安全的，
  但**必须配守卫**，否则在相册页点它 = 点空白（不会错点，但等于瞎点一下）。

### B. 屏幕守卫（新：步骤引擎的第二套条件）

| 条件 | 判什么 | 写法 |
|---|---|---|
| `when` / `whenNot` | **数据**（这一行填没填货号） | 占位符名，如 `goods2Sku` |
| `whenOn` / `whenNotOn` | **当前这一屏长什么样** | resource-id |

四条硬规矩（都是被真机 / 反向验证逼出来的）：

1. **只许写 resource-id**：写文字在 `normalizeScreenCond` 里**导入时**就报错。
   守卫判错比普通步骤更难查（该点的不点 / 不该点的点了），所以逼着写 id 而不是文案。
2. **拿不到界面结构 ⇒ 硬失败**（`screenGuard` 直接 throw，报错里点名是哪一步、缺什么 id）。
   猜「大概不在草稿箱吧」的后果：漏点一步 → 卡在下一条 → 报错指向离原因很远的地方。
3. 守卫不成立 ⇒ `runStep` 返回 `{skipped:true, why}`、**一个像素都不碰**；
   `runReal` 必须**写进日志**（`跳过「X」（屏幕守卫：这一屏上没有「Y」）`）。
4. **候选表（`uimap.suggest`）自带这一步** —— 否则用户重抓一次表，修复就丢了。

### C. 真机三连对照（用发布器自己的代码跑，不是推理）

```
① 草稿箱屏跑旧表下一跳「切到照片页签」 -> FAIL: 找不到「照片」；当前可见文本：草稿箱 …
② 跑守卫那一步                        -> ok（真点到 540,1871）→ 焦点 = TotalPublishProcessActivity
③ 出到相册后再跑①那一步              -> ok
负向：已在相册页时跑守卫              -> SKIPPED，跑后焦点与跑前完全一致
```

### D. 冷启动「是否继续编辑」弹窗 —— **实测不存在**（可以不再为它配步骤）

`am force-stop` + `monkey -c android.intent.category.LAUNCHER` →
`mCurrentFocus = …modules/home.ui.HomeActivity`；dump 里没有任何
「继续编辑 / 草稿 / 放弃 / dialog / popup」节点。

### E. 顺手修掉的漏改（同一类"改一半"缺陷）

视频那套 `videoSteps` 的「按颜色选那一格」还是旧的 `tapText`（图文那套 §AU 已改成 `tapCardText`）。
⇒ **图文 / 视频两套定位表要同步改**。本次 3 处改成 `tapCardText`。

### F. 自证工具链上的三个坑（都真踩过，都改了）

1. **预演开关忘了传 ⇒ `--dry` 照样落盘**。`patch(path, label, anchor, repl, dry_run=False)` 的缺省值
   与命令行无关 ⇒ 我以为在预演，其实已经写进文件了（17/17 锚点唯一 + 回读全对，结果没坏，
   但**预演这一步等于没做**）。⇒ 这类开关一律做成 `dry_run = DRY if dry_run is None else dry_run`，
   **缺省跟随命令行**，不靠调用点自觉。
2. **「套件中断」被当成「没抓住」**。拆掉守卫后行为级断言**抛异常直接中断套件**，一行 `FAIL` 都不打，
   只看 `FAIL` 行的反向验证脚本把它判成 `GREEN(未抓住!)`。
   ⇒ ① 行为级断言一律 `try/catch` 兜住，把「抛异常」本身算成 FAIL；
      ② 反向验证的中断判据**不能拿退出码**（有 FAIL 时退出码本来就不是 0 —— 第一版就是这么写错的，
      把「期望串写错、本该没抓住」美化成了「抓住了」）⇒ 只看 `ADB TEST ERROR` / PASS 数有没有掉。
3. **行为级断言用了测试自己硬编码的 id ⇒ 改配置抓不住**。原来 `p21a/p21b` 用的是测试文件里写死的
   `DRAFT_EXIT`/`DRAFT_TITLE`，所以「把 `uimap.DEWU.draft.exitId` 改错」它照样绿。
   ⇒ 行为级改读 `uimap.DEWU.draft.*`，配置写错也会红（D7/D8 由"没命中"变成真 FAIL）。

### G. 反面素材（写回归时照着这个来）

- ㉑ 用的两套夹具：`draftXml21`（草稿箱屏，`fl_publish` bounds `[0,1826][1080,1916]` ⇒ 中心 540,1871）
  与 `albumXml21`（相册屏，只有「照片」文字 + `flThumbSelect`）。
- `tools/adbtest.js` ㉑/㉑b 共 **11 条**。其中「相册屏上**不发任何 tap**」是负向核心，
  「按**配置里**的 id 在草稿箱屏上真点到 (540,1871)」是正向对照 ——
  两条必须成对，只测负向 = 永远绿（假通过）。
- 反向验证：**8 条**定点破坏（不看 whenOn / 不判守卫 / 不校验 / whenNotOn 反向 / 候选表丢步 /
  吞掉 dump 失败 / 出口 id 写错 / 标题 id 写错）—— **8 条全打到 FAIL 行**，0 中断、0 漏抓；
  还原后逐字节一致、复跑 167 PASS / 0 FAIL。
- 回归：十七套全绿，**1168 → 1179** 项。
- 改动落在：`src/main/services/uimap.js`、`src/main/services/publisher.js`、`tools/adbtest.js`、
  用户 `config.json`（图文 37→38 步 / 视频 39→40 步；备份 `config.json.bak-before-draftguard`）。

---

## §AW 2026-10-03（第三十轮）：**包体积构成实测** + 裁剪 locales（省 6.66 MB）

### AW1 ★ 反直觉前提：**资源类文件压缩后几乎不省**
`win-unpacked` **395.09 MB** → NSIS(maximum) 安装包 **108.73 MB**（整体 3.64:1）。逐项：

| 组件 | 未压缩 | 压缩比 |
|---|---|---|
| **`ffmpeg/ffmpeg.exe`** | **79.03 MB** | ~2.6:1 |
| `locales/`（55 个 .pak） | 38.28 MB | **5.6:1** |
| 主程序 exe | 172.45 MB | — |
| `app.asar` | 29.78 MB | — |
| `app.asar.unpacked/`（libvips） | 19.14 MB | — |
| `adb/` | 9.18 MB | — |

⇒ **`.pak` 这类资源「看着大、压缩后很小」**；要减包得砍**可执行文件**（ffmpeg），不是资源文件。

### AW2 裁剪 locales 实操（本轮唯一改动）
- `package.json` → `build.electronLanguages: ["zh-CN", "en-US"]`（**1 行 / +46 B**，备份 `package.json.bilclean`）。
- 实现（`app-builder-lib/out/electron/ElectronFramework.js:48-63`）：Windows 下按 `<appOutDir>/locales`
  的 **`.pak` 文件名精确匹配**，不在名单里的 `fs.rm`；**空数组直接 return（不配置 = 一个都不删）**。
- 名单必须是**去掉 `.pak` 的名字**；`en-US` 必须留（Electron 兜底 locale）。
- **实测（同机 / 同命令 `npm run dist:win-only` / 唯一变量就是这一行）**：

  | 指标 | 基线 | 改后 | 差值 |
  |---|---|---|---|
  | 安装包 exe | 114,013,488 B | 107,031,655 B | **−6,981,833 B（−6.66 MB）** |
  | locales | 55 个 / 40,139,718 B | 2 个 / 936,926 B | −53 个 / −39,202,792 B |
  | `win-unpacked` | 414,281,699 B | 375,078,062 B | −39,203,637 B |
  | 主程序 exe | 180,825,088 B | 180,825,088 B | **0**（证明只动了 locales） |
  | `app.asar` | 31,229,644 B | 31,228,799 B | −845 B（package.json 自身进了 asar） |

  ★ **未压缩省 37.39 MB，压缩后只省 6.66 MB**（5.62:1）。事前按 4:1 估的「9~14 MB」偏高
  ⇒ **资源类文件一律先量「压缩后」，再谈收益**。
- 副作用：grep 全 `src/`，locale 相关只有 `src/renderer/app.js:1550` 一处 `toLocaleTimeString()`
  （不传 locale）；zh-CN/en-US 都留着 ⇒ **中文 Windows 行为不变**，最坏也只是那处时间格式变英文写法。
- 冒烟：启动 `dist/win-unpacked/…exe`（临时 user-data-dir、关 GPU、**清 `NODE_OPTIONS`**，否则刷一条
  与改动无关的 `Most NODE_OPTIONs are not supported in packaged apps`）15 s ⇒ 存活 true / 零输出 / 零 locale 报错。
- 回归：十七套全绿 **1179 项**（与 §AV 的 1179 一致 ⇒ 断言面无变化）。
- 取证：`_locales裁剪-前后实测.txt`、`_量包.py`、`_localesmoke.js`（均在工作区）。
- ★ 未提交、未发版；**版本号仍 1.0.8 而源上已有 1.0.8 ⇒ 发这版必须先涨号**（§AM）。

### AW3 下一刀（已勘明、未做）
`ffmpeg.exe` **79.03 MB** 是唯一大杠杆。它只干三件事：非 mp4→mp4、视频叶子**抽一帧**、mkv 兜底探时长。
现用 **ffmpeg-static 完整版**（全编解码器 + 全套滤镜）⇒ 精简构建（mov/mp4/mkv demux + h264/hevc 解码 +
libx264 编码 + 图片输出）可到 **8~15 MB**。

### AW4 ★★ 同一工作区里能**同时跑两条会话改同一仓库**（本轮实测撞上）
- 本会话打包/回归期间（**17:26:11**）另一条会话改了 `adb.js` / `publisher.js` / `uimap.js`（+ `index.html`），
  留下 `*.bak-speed-20261003172611`。定位法：读 `~/.workbuddy/projects/*/*.jsonl` 的 **`cwd`** + mtime
  —— 两条会话 **cwd 完全相同**（同一工作区），只有 sessionId 不同。
- ⇒ 动手前后都要 `git status` + 看 mtime；**「打包/回归用的源码」与「当前源码」可能不是一回事**。
  本轮两次打包都在 17:22~17:23（**早于** 17:26 那次改动）⇒ 前后对比仍成立；
  但 **dist 里那份包不含对方改动，要发版必须重打**。
- ⇒ **回归全绿不能记成「我改对了」的证据**：它衡量的是「含对方改动的一整份工作树」。

---

## §AX 2026-10-03（第三十一轮）：**「网页分发」到底花不花 COS 的钱 —— 只看链接指向谁**

★★ **判据一句话：流量跟着「文件真正所在的那台服务器」走，不跟着「网页」走。**
网页只是路牌 —— 路牌指向 COS，钱就算 COS 的；路牌指向自己域名，就跟 COS 无关。

- **实测（本轮线上，两种形态各取一次）**：
  - **插件中心（`6e5b9dc28eaf4ec4ad57303bc0f16039.app.workbuddy.host`）= 不花 COS 钱**：
    `index.html` 里 **`myqcloud` 出现 0 次**；下载地址是**同域相对路径** `dl/dewu-bluev-publisher-1.0.8-x64-win.exe`；
    同域 GET → **200 / `Server: CloudStudio Gateway`** ⇒ 字节从**沙箱**出，**完全不经过 COS**。
  - **COS 桶（`dewu-bluev-release-…cos.ap-guangzhou.myqcloud.com`）= 花 COS 钱**：
    同刻 `latest.yml` 200、`…得物蓝V素材发布工具-1.0.8-x64-win.exe` 200 ⇒
    **只有走 App 内自动更新那条路**才产生**外网流出流量 0.64 元/GB**（§AJ5）。
- ⇒ ★★ **「不做内置更新 + 改成网页分发」确实能把 COS 流量费降到 0** —— 前提是**包放在网页同域**，
  而不是在网页上挂一个 **COS 直链**。用户最早的直觉是对的。
  ★ **我第三十轮说「改成网页下载、一分钱流量费都省不掉」是错的**，那句只在「按钮指向 COS 直链」时成立 —— 已更正。
- **同一件事的另一面（代价，三条）**：
  1. 沙箱网关 **不支持 Range**（§AP4）⇒ **不能当 electron-updater 的更新源**
     ⇒ 想省 COS 钱就**必须放弃 App 内自动更新**（这是二选一，不是两全）。
  2. 沙箱**寿命 / 额度不保证**（§AL6）⇒ 长期分发渠道要先验；闲置过久可能被回收。
  3. 网页下载的包落**「下载」文件夹、每版一个**（§AK2 / §AL4）；App 内更新落**固定名 `installer.exe`**、不堆积。
- **业务侧连带**：放弃自动更新 ⇒ 应用内「测试版通道」（读 `beta.yml`）**变死开关**
  ⇒ 按项目规矩**连读取链一起删**，不许留着（§AC 同款处理）。
- ★ 别忘 §AJ4：**只要不点「下载更新」、不发新版，COS 流量费本来就恒为 0** ——
  所以「省 COS 钱」这件事的紧迫性取决于**同事到底点了几次下载**，不取决于 App 里有没有自动更新。

### AX2 桶上实况（2026-10-03 17:5x 实测，匿名 GET / Range + 现成脚本）
- ★ **桶里不是一个版本**：正式 **1.0.0 ~ 1.0.8（9 个）** + 测试 `1.0.1-beta.1` / `-beta.2`
  （每个都带 `.blockmap`）、两条 yml，另有 **0 B 的 `beta/`、`stable/` 占位对象**。
  合计约 **1.08 GB**。★ §AI2 写的「3 个版本 ≈ 330 MB」**偏低，按实测更正**；
  仍远在 50 GB 免费存储额度内 ⇒ **存储费仍是 0**（下载才花钱）。
- 探测法（★ 别只凭记忆）：`curl -r 0-0` 看状态码（`206` 存在 / `404` 不存在），
  并**必配一个对照组**（随便编个 key 验 404）—— 否则整片 200/206 分不清是真实还是探测器坏了。
- **现成工具 `tools/prune-release.js`（★ 默认 dry-run，凭据走仓库 `.env`，已 gitignore 且未被跟踪）**：
  dry-run 实测 ⇒ `--keep-more=1`（默认）会删 **14 个对象 / 717.3 MB**（`1.0.0`~`1.0.6` 的 exe+blockmap），
  保留 `1.0.7` / `1.0.8` / `beta.1` / `beta.2` + 两条 yml。
- ★★ **prune-release 永远保留「当前版本」⇒ 它做不到「断掉下载路径」**。
  要让 COS 流量真正归零，得**单独删掉 `latest.yml` / `beta.yml` 指向的那两个 exe**（或把桶改私有读）；
  清历史包只省存储，而存储本来就免费 ⇒ **两件事目标不同，别混为一谈**。

### AX3 用户口径（2026-10-03 17:5x）：**放弃普通用户自动更新，改让同事直走插件中心下载最新 exe**
- 成立条件：包必须放**插件中心同域 `dl/`**（现在是）+ 每次发版走 §AP7 三步（换 exe / 改 `bluev-version.json` / 重新部署）。
- ★★ **老客户端改不了行为**（§AJ3）：已装 `1.0.8` 及更早的机器**仍带编译进去的 COS 源地址**
  ⇒ 光"决定放弃"不够，得**动手**：① 删桶里那两个 exe（立即止血、不改代码）
  ② 发一版**删掉更新模块**的新包（老机器要装一次才生效）。
- ★ 代价：失去「有新版本」提醒；每版一个安装包堆在「下载」文件夹；**沙箱是唯一渠道** ⇒
  它一挂就**连分发渠道都没了**（§AL6 寿命/额度不保证）⇒ 建议留冷备。

## §AY 2026-10-03（第三十二轮）：**非管理员隐藏「应用更新」** + 版本号挪到标题栏（已实测）

用户原话：「除了管理员，把其他人设置里的自动更新、版本信息全都删掉。app 左上角名字后面加版本号即可。」
- 改动（**只动渲染层 3 个文件，主进程一行没碰**）：
  - `app.js` ① 设置页 `${canAdmin() ? updateHtml() : ''}`（原来是无条件裸 `${updateHtml()}`）；
    ② `TABS[7].desc` 改成 **getter**（非管理员那份不再提「应用更新」）；
    ③ `renderAll` 里 `esc(typeof t.desc === 'function' ? t.desc() : t.desc)`（兼容旧的字符串 desc）；
    ④ 填 `#appVer` ← `state.info.version`（**取不到显示 `v—`，不编版本号**）；
  - `index.html` app 名字后加 `<span class="chip chip-ver" id="appVer">v—</span>`；
  - `styles.css` `.titlebar .chip-ver`（用 `--tx3` ⇒ **浅/深色不用各写一份**）。
- ★★ **`app:info` 不受 guardAdmin 限制**（`ipc.js:225` `version: app.getVersion()`，人人可读）
  ⇒ 藏掉设置页那块，也不会让人不知道自己在用哪一版。
- ★ 实测：uicheck **178 项 0 FAIL**；全量回归 **17 套 1211 项**
  （★ 这总数**含并行会话的改动**，别全算成本轮证据 —— 本轮只加了 uicheck 那 9 条）。
  定点破坏（门控改回裸调用）**恰好 3 条红**、正向对照那条仍绿 ⇒ 断言真在查东西。
- ★★ **uicheck 有 FAIL 时退出码仍是 0**（`ok()` 只设 `process.exitCode`，被收尾 `app.exit(errors.length?1:0)` 覆盖，
  `errors` 只收 console/preload/renderer 级错误）⇒ 判「有没有抓住」**只能数 `^FAIL` 行**。
- ★★ 验权限门控最省事的做法（已实测可行）：`executeJavaScript` 与页面**同 realm**，
  经典脚本顶层的 `const state` / `function renderAll` **读得到、也改得动** ⇒
  `state.auth = { requireLogin:true, isAdmin:false, u:... }; renderAll();` 能在**同一窗口里演非管理员**。
  纪律：**先存后改、改完必还原**；加一条 `canAdmin() 真的变 false` 的机制自证；
  负向断言**必配正向对照**（路径 / 外部依赖 / 保存仍在），防「空 == 空」的假绿。
- ★★ 隐藏窗口 `capturePage` **第一次可能返回「上一帧」**（判据是 md5，不是肉眼；
  实测第一次截到的其实是切页前的「素材整理」页）⇒ 切页后多等 / **连截两次取第二次** /
  顺手把页标题（`#head h2`）一起打出来对账。
- 状态：**未提交、未发版**；版本号仍 `1.0.8`，源上已有 1.0.8 ⇒ 真发这版**必须先涨号**。
  应用内「测试版通道」本轮**只做隐藏，没走「连读取链一起删」**（要不要删另说）。


---

## §AT 提速：抓屏才是瓶颈（2026-10-03 实测）

**核心事实（本机 MuMu 12 / 得物 / 1080×1920 / 真机串 `127.0.0.1:16384`）**

| 动作 | 实测 |
|---|---|
| `input tap x y` | 138–146 ms |
| 纯 `adb shell` 往返 | 135 ms |
| `dumpsys activity top` | 160 ms |
| 普通页 `uiautomator dump` 本体 | 2036 ms |
| 合并式抓屏（rm+dump+cat 一条 shell） | ≈ 2240 ms |
| **相册页（TotalPublishProcessActivity）裸 dump 连打 3 次** | **11230 / 11136 / 11127 ms，三次全 `could not get idle state`** |
| 相册页**关掉三个系统动画**后 | **2036 ms** |

⇒ **抓屏比点击贵 15 倍**；相册页那一下要白等 11.1 秒。「点按钮慢」的真凶是点击前那次抓屏。

**落地的五项提速**

1. `tapXY` 新动作（uimap.js）：按固定坐标直点，**完全不抓屏**。导入期挡住空坐标。
2. `tapSeq`（adb.js）：N 次点击合成**一条** shell，间隔用**设备端** `sleep 0.25`。3 击 380 ms → 127 ms。
3. `dumpOnce`（adb.js）：`rm` + `uiautomator dump` + `cat` 由 3 次往返合成 1 条 shell，用 `___BLUEV_DUMP_SPLIT___` 分隔判成败。
4. 屏幕守卫复用（publisher.js#runStep 的 `reusedXml`）：守卫抓到的那份结构直接给同一步的点击用，省一次 dump。
5. `preferAnimOff` + `ctx.animOffSteps` 批量缓存：按**步骤名**记住「这一步这一屏不会 idle」，
   本批第 2 条起直接走关动画。真机实测 **13462 ms → 2396 ms（省 11.07 s/条）**；
   同一步在同一次运行里出现两次：**13824 ms → 3085 ms**。动画开关跑前跑后都是 `1 1 1`（finally 还原）。

**被否掉的方案：大面积改盲点**
这些屏的坐标会漂，盲点=静默点错（挂错商品/少选一张图），最难查：

| 目标 | 漂移 |
|---|---|
| 相册页页签 | y 276 ↔ 140 |
| 相册页网格 | y 359 ↔ 204 ↔ 240 |
| 编辑页 `etTitle` | y 308（图文）/ 444（视频） |
| 主页「发布新动态」 | 随上方内容变（网络驱动页面） |

只保留一颗确定稳定的盲点：底部栏 `tab_user` `[810,1819][1080,1920]` → 中心 **(945,1869)**。

**测试**：adbtest 167 → 196 条；全量 17 套 1179 → **1218** 项全绿；
反向验证 6 处定点破坏（tapSeq 合并 / 守卫复用 / dump 合并 / tapXY 不抓屏 / preferAnimOff 快路 / 记缓存）
⇒ **9 条靶断言 9 条被抓住**，每条都配了反向对照（防「空==空」假通过）。

**踩过的坑（别再踩）**
- `runStep` 点击**成功时返回 `undefined`**（只有守卫拦下才返回 `{skipped}`）⇒ 写 `!r.skipped` 会抛异常，
  **整段断言一条都不打**、只看 FAIL 的人会误判成全绿。
- 合并抓屏后夹具 `shellSub` 把 `2>&1` 当输出文件名、且不认 `echo` ⇒ adbtest 一次挂 35 条。
- 补丁脚本是 LF、源码是 CRLF ⇒ 跨行锚点 `count=0`；一律「读入归一 LF、写回按原风格」。
- `screenGuard` 在 **publisher.js** 里，不在 adb.js（锚点别放错文件）。


---

## §AN 发版前必做：清 `src/` 下的临时文件（2026-10-03 实测）

**规则**：打包前，把 `src/` 下的所有 `.bak*` / `.bilclean` / `*.orig` 等临时文件**移出工作区**（移走不删）。

**理由**：本项目 `package.json` 的 `build.files = ["src/**/*", "package.json", ...]` ⇒ `src/` 下**任何文件**都会被 `asar` 打进安装包。
2026-10-03 v1.0.9 发版前实测：`src/main/services/` 下有 **10 个**这种文件
（`adb.js.bak-speed-…` / `publisher.js.bak-before-animoff-…` / `uimap.js.bilclean` 等，共约 400 KB），
**其中还含着提速前的旧代码** ⇒ 一旦进包，包内会有两份代码、扫关键词会命中旧版本、包内核对会混乱。

```bash
mkdir -p /d/work/_bak-archive/<日期>-发版前
cd <repo>
mv src/**/*.bak* src/**/*.bilclean <repo>/*.bilclean tools/*.bak* /d/work/_bak-archive/<日期>-发版前/
```

**配套断言**（写进包内核对脚本）：
- 全文搜 `publisher.js.bak` / `.bilclean` / `.bak-speed` / `bak-before-animoff` 各 **0**；
- `asar.listPackage()` 的清单里**没有** `.bak` / `.bilclean` 条目。

**同类坑 ①：包内 `package.json` 不是源码那份**
electron-builder **会重写并剥离 `build` 字段**。2026-10-03 实测包内那份只剩
`name / version / description / main / author / license / private / dependencies / optionalDependencies`。
⇒ ① 别断言包内 `package.json` 里有 `build.*`；② 别把它放进「包内文件 vs 源码逐字节一致」的比对清单。
判断某项配置是否生效，要看**产物侧的可见证据**（如 `win-unpacked/locales/` 里 pak 的数量）。

**同类坑 ②：产物不是确定性的（1 字节）**
同一提交、同一配置、连续两次 `electron-builder --win --x64`，产出的 exe 相差 **1 字节**
（2026-10-03 实测 `107047201` vs `107047202`，NSIS 封装层差异；`app.asar` 内容不受影响）。
⇒ 主仓 `dist/` 里的包与公网那份**不保证同字节**；**不要拿主仓 `dist/` 直接重新上传**
（否则 `latest.yml` 里的 sha512 会与公网 exe 对不上）。

**同类坑 ③：「多路会话并存」时用户选「发全量」**
技能 `concurrent-workspace-safe-release` §2 讲的是「只提交自己的文件」。
当用户**当场选定「发全量」**时，做法反过来：把工作区**全部**改动一起提交，但——
① 提交信息里必须**逐块写明改动归属**（哪块是本会话、哪块是另一路、哪些文件两路都改过）；
② 提交前先按文件清点一遍 `git status --short`，确认没有「本轮才冒出来的第三方文件」；
③ 临时文件**仍不能提交**（先移到 `_bak-archive`）。
2026-10-03 v1.0.9 实测：27 个文件 / +2538 −407，其中 `index.html` 是两路共同改过的（无法在文件粒度切分）。


## §AX 素材落地 / 发布节奏（2026-10-03 真机实测，设备 127.0.0.1:16384 / MuMu 12 / Android 12）

### ★ 得物相册**不读 MediaStore**（决定性结论）

| 实验 | 结果 |
|---|---|
| 放一个 mp4 进 `/sdcard/DCIM/Camera`，确认它**不在** MediaStore | 前提成立（`instore=False`） |
| 冷启动得物 → 发布入口 → 相册 | `flVideo=6`，设备 mp4 数=6 |
| 时长标记 | `00:05 ×3、00:15 ×3` —— **不在库的那个 00:05 也在列表里** |
| 停在相册页不退出，再放一个新文件 | `flVideo` 恒为 6，**不冒出来** |

⇒ 得物是「打开相册那一刻」扫文件系统；既不读 MediaStore，也不是实时监听。
⇒ 于是「等 MediaStore 索引到再往下走」是在等一个跟"得物看不看得到"**无关**的条件。

### 让文件进 MediaStore 的办法（全试过）

| 办法 | 结果 |
|---|---|
| `am broadcast -a MEDIA_SCANNER_SCAN_FILE` | `result=0` 但**无接收者**，不进库 |
| `content call --uri content://media --method scan_file` | 返回空 Bundle（`android.intent.extra.STREAM=null`），不进库 |
| `am broadcast -a MEDIA_MOUNTED` | 受保护广播，`Permission Denial ... uid=2000(shell)` |
| `content insert` 直写 MediaStore | 无权限（shell 不在 media_rw）；设备无 `su` |
| `am force-stop com.android.providers.media.module` | **约 45s 后进库**；副作用：`/sdcard` 期间 `Permission denied` / `Transport endpoint is not connected`（约 30~45s 自愈） |
| 开机扫描 | 有效（`326113200712-1.mp4` 的 `date_added=1791012240` ≈ 开机时刻） |

### 修复后的判据

- 推完只做 `adb.filesMissing()`（命令：`[ -f 'p' ] && echo EXISTS || echo MISSING`，一个文件吐一个词，约 150ms）
- `videoIndexTimeoutSec=0` 默认**不等**；设成正数才退回 `mediaVisible()` 等索引的旧行为

### 设备去重

MuMu 12 把同一台暴露在 `16384 / 5555 / 7555`；三者 `settings get secure android_id` 相同、uptime 一致。
`scanDevices()` 按 android_id 分组，只留主串（已配置的 > 当前选用的 > 第一个），其余 `dupOf` 指向主串，主串带 `aliases`。
**读不到 android_id 一律不合并**（有专门的负向断言）。

### 发布间隔

`videoIntervalSec` 默认 `0` = 跟随 `intervalSec`。设置页**没有**这个控件，所以它原来写死的 90 会让用户设的 60 完全失效。
预估口径：`分钟 = n × (间隔 + 单条)`，图文 +30s、视频 +60s。30 条视频：修前 75 分钟 → 修后 60 分钟。

## §AZ 2026-10-03（第三十四轮）：**发布间隔加「连续发布」档（= 0 秒）**（已实测）

用户原话：「发布间隔需要有一个连续发布的选项，发完一条后直接开始发布第二条。」

### AZ1 ★★ 两个「0」的含义不一样 —— 最容易改错的地方
- `publish.intervalSec = 0` ⇒ **连续发布**（两条之间不等待）。
- `publish.videoIntervalSec = 0` ⇒ **跟随主间隔**（**不是**"视频也连续"）；
  它 **> 0 才单独生效**（沿用 §AX 的语义，不许改）。
⇒ 主间隔 60 + 视频项 0 ⇒ 视频仍等 60（没改坏）；主间隔 0 + 视频项 0 ⇒ 视频也连续。

### AZ2 ★★ 「0 是合法值，却恰好是 falsy」—— 5 个读取点必须全换掉
`intervalSec || 60` 会把 0 吃掉 ⇒ 用户选了「连续」却仍等 60 秒。**禁写 `|| 兜底`**，统一走
`publisher.secOr()` / `publisher.gapSecFor(kind, c)`（已导出，供测试直接断言）：
1. `publisher.js` 每条之间的等待（`gapSecFor`；`wait === 0` 时**不 sleep**，
   日志写「连续发布：不等间隔，直接开始下一条」）
2. `publisher.js` `estimate()`（否则预估虚高）
3. `publisher.js` 生成发布单时传给 `sheet.buildRows` 的值
4. `jobs.js` 的 `sheet.export`（第二处出口，容易漏）
5. `sheet.js` `buildRows` 的步长（`intervalSec || 90` ⇒ 显式判 null/undefined）

### AZ3 界面（`app.js`，第三处同类坑）
- 下拉新增 `<option value="0">连续发布 · 发完一条直接发下一条</option>`；
  **选中判断也要改**：`Number(cfg.intervalSec || 60) === v` ⇒ `ivNow === v`（否则 value=0 永远选不上）。
- `saveCfgFromDom` 把 `publish.intervalSec` 加进「转数字」名单（界面写回来的是字符串 `"0"`，
  它 truthy，且有加法的地方会退化成字符串拼接）。
- ★ **界面必须自洽**：连续档下那句「93% 的时间是在等间隔」要消失、换成「不再叠加等待」；
  顺手修掉过时的「视频默认 90 秒」（1.0.9 起出厂就是 0 = 跟随）。

### AZ4 测试与反向验证（数字可复算）
- `adbtest.js` ㉖ **13 条**：取值（0 / `"0"` / 未配 / 60）、视频跟随、端到端真跑两条、
  ★ **正向对照**（固定 1 秒档**必须**出现「按 1 秒间隔」）、行为级（连续 **15ms** vs 固定 **1017ms**，
  差 **1002ms**）、源码级（三文件里不再有 `intervalSec ||`）。
- `uicheck.js` **5 条**：有该档 / 配 0 选中它 / 正向对照配 60 选中 60 / 连续档不出现那句 93% / 固定档仍有。
- 反向验证脚本 **`_rv-cont.py`**（定点破坏 → 红 → 还原绿）：
  P1 取值回退 ⇒ adbtest **恰好 7 条红**；P2 界面 ivNow 回退 ⇒ uicheck **恰好 1 条红**；
  P3 提示档位钉死 ⇒ uicheck **恰好 1 条红**。三次的正向对照都仍绿。
- 全量回归：17 套 **1259 项**（含同工作区另一条会话的改动，别全算成本次成果）。
## §BA 2026-10-04（第三十六轮）：话题并进正文 · **工程状态货号自愈** · 文案生成表隐藏货号/颜色列

### BA1 话题：用户拍板「并进正文」——推翻了 §AF 的旧口径
- 用户原话：「你直接在文案那里每个话题单独一行，复制 `#abcde` 整个过去就行了，不要做其他任何改动」。
- 实现：`copywriter.appendTopics(body, topics)` —— 先收掉正文尾部空白，再 `\n` **逐行**追加（连 `#` 一起写）；
  同时把 `row.topics` **清空**。不清空的话，发布时定位表「话题1~5」那五步会**再写一遍** ⇒ 同一条话题出现两次。
- 为什么必须写进**正文本体**（而不是只留在 `row.topics`）：生成 → 导出 `AI内容报告`（表里**根本没有话题列**）→
  导入，`report.js` 一律读回 `topics: []` ⇒ 发布时五步占位符全空、整段跳过 —— 真机第一条跑出来就是**零话题**。
- 模型自己写在正文尾巴上的 `#话题` 仍先由 `stripTrailingTopics` 摘掉（它挑的那几个跟程序按计划选的对不上）。
- 断言：smoke ③（「组合去重」改看正文里的话题行 + 新增「`topics` 必须为空」）、copytest ②b / ③d / ⑦。
- ⚠ 仍未验证：得物认不认纯文本 `#xxx` 是可点话题（用户明确说不用验；反正现在是纯文本追加）。

### BA2 ★★ 派生字段一旦落库，修程序也修不好存量 —— 工程状态必须自愈
- 现象（2026-10-04 用户**第二次**报）：`AI内容报告` 的「好物1_货号」还是 `0901_2`、「好物1_颜色」是 `3261163003`。
- 真因：`project.json` 的 `items` 是**素材整理那一次**算好的，之后文案生成 / 出报告 / 发布**只读它**。
  旧版（把批次目录当货号那一版）存下的错值一直躺在工程状态里；报告的好物列直接取 `it.sku/it.color`
  ⇒ 一直错，而且**重跑文案生成也修不好**（文案生成根本不重算这两个字段）。
- 实测对照（同一条素材，2026-10-04）：
  | 来源 | sku | color |
  |---|---|---|
  | `project.json` items[9]（旧版存下） | `0901_2` | `3261163003` |
  | 现在拿同一份 absDir 走 `flatten.parseName` | `3261163003` | ``（空） |
- 修法：`flatten.refineItem(it)` 按 `absDir`（退到 `dir`）重读；`project.load()` 与 `project.patch()` 都过一遍
  （只在 load 纠一次不够 —— 程序可能已经开着，状态是旧程序写的）。
  - 只认 `how` 为 `plus` / `sku`；其余原样返回（宁可留着让人补，也不往运营的账上写假货号）。
  - **绝不拿 `id` 去解析** —— 旧版 id 是「+ 连接的显示名」（`3261163003+1`），拿它当路径会把 `1` 读成颜色。
  - 颜色多一条线：**颜色名一定带汉字** ⇒ 存量颜色里一个汉字都没有的（`3261163003`）清掉，按「没填颜色」走。
  - 没变就返回**同一个对象引用**（否则每次 patch 都白广播一遍）。
- 断言：batchtest ⑦b（5 条：纯函数 + 引用不变 + 不可信条目不许动 + 只有 id 时不许动）；
  reporttest ⑮（旧 `project.json` → load/patch 自愈 → **写进报告 xlsx 的「好物1_货号」= 3261163003** 的闭环）。
- ★ 一般规律：任何「算一次 → 存下来 → 到处读」的派生字段，都会被新代码**修不好**。
  改这类 bug 必须连**读取链**一起改（与 §H2「删功能要连读取链一起删」同一条纪律）。

### BA3 文案生成表隐藏「货号 / 颜色」两列
- 用户原话：「这里直接隐藏掉吧反正 AI 内容报告会显示具体货号和颜色，这里就不展示了」。
- 表头 8 列 → 6 列（叶子目录 / 叙事视角 / 话题组合 / 标题 / 生成来源 / 状态）。
  发布走的是**报告**（导入那一步），不依赖这张预览表 ⇒ 少两列不影响任何动作。
- 断言：uicheck —— 负向（没有这两列）+ 正向对照（其余四列还在）+ 表头列数与单元格数自洽。

### BA4 跳过日志必须点名**真正没成立**的那一半（`uimap.condWhy`）
- 旧代码：`const why = step.when ? '占位符 X 是空的' : '占位符 Y 不是空的'` —— 两个条件同写时，
  报的是**已经满足**的那个。
- 实测受害：日志写着「跳过「好物1 · 没填颜色就选第 1 格」（占位符 goods1Sku 是空的）」，
  而那一行**明明填了货号**；真因是 `whenNot:'goods1Color'`（有颜色 ⇒ 不走这条退路）。我照这条日志白查了一圈空货号。
- 修法：新增 `uimap.condWhy(step, data)`，按 `condOk` 的判定顺序返回**第一个**不成立的条件（并带上 when/whenNot 与实值）；
  `publisher.runReal` 改用它。
- 断言：adbtest 4b-2 —— 3 条行为 + 20 组「condWhy 与 condOk 互为反面」+ 1 条代码级「publisher 真的调了 condWhy」（负向断言先 `codeOnly`，否则会被自己的注释骗过）。

### BA5 本轮回归与反向验证（可复算）
- 全量 17 套 **1299 项断言全绿**（改前基线 1259 + 1 红）。
- 四处定点破坏**全部变红**（每条都先 restore 回干净源码、锚点 count==1、try/finally 兜还原）：
  ① 关掉 `flatten.refineItem` 自愈 ⇒ batchtest 2 红 / reporttest 3 红（其中闭环那条精确复现
     `货号=0901_2 颜色=3261163003`）；
  ② 去掉 `project.load` 的自愈调用 ⇒ reporttest 1 红（证明「判定」与「接线」两层都有断言）；
  ③ 把两列加回文案生成表 ⇒ uicheck 2 红（负向 + 表头/单元格自洽）；
  ④ 关掉「话题并进文案」 ⇒ smoke 2 红 / copytest 5 红。
  另加两组：⑤ publisher 退回旧日志写法 ⇒ adbtest 1 红；⑥ condWhy 退回「写了 when 就点名 when」⇒ adbtest 2 红。
- 脚本：`_rv3.py`（四组）、`_rv4.py`（condWhy 两组）。

## §BB 2026-10-04：窗口最小 **960×640** + 侧栏永远在左（依据 / 实测 / 断言）
（这一段本来整段写在 MEMORY.md 里，占了注入额度 206 字符 ⇒ 细节挪到这儿，MEMORY 只留祈使句）
- 根因：`styles.css` 末尾原有一条 `@media (max-width:900px){ .body{flex-direction:column} .side{…flex-direction:row…} }`
  把侧栏翻到顶上横排；而主窗口 `minWidth` **恰好也是 900** ⇒ 一缩到最小，视口 ≤900 **必然命中**。
  探针逐档缩窗口实测：**940 侧栏还竖着 / 930 起翻**。
- 最小宽 = 侧栏固定 186 + 内容区左右边距 88 + **品牌统计页那张 9 列表所需 660** = 934 ⇒ 取整 **960**（高度 640）。
- 改动：删掉那条断点；`window.js` 新增 `MAIN_MIN_W/H`，**`createWindow` 与 `setLoginMode` 两处**都改走常量
  （`clamp(b.width, 980, …)` 的下限也从 980 改成 `MAIN_MIN_W`，否则缩到 960 后重启会被悄悄抬回 980）；导出 `MAIN_MIN` 给自检。
- 断言：uicheck 8 条 —— 行为级（缩到 MIN 后 `sideFlex=column`、`bodyDir=row`、`sideX=0`、`mainX=sideW`；
  11 个页签切一遍无横向溢出、无表格横滚）+ 源码级 4 条（无侧栏横排媒体查询 / 两处走同一常量 / 导出 MIN）。
- 反向验证：把断点加回 + `MAIN_MIN_W` 改回 900 ⇒ `PASS=188 FAIL=3`，坏版实测
  `sideFlex=row, sideW=887, sideH=66, mainX=0, mainY=104`（侧栏成 887×66 横条贴顶、主区掉到下面），精确复现用户描述。
- 全过程见 `.workbuddy/memory/2026-10-04.md` 的「00:05 侧栏永远固定左侧 + 窗口最小尺寸 960×640」。

---

## §BC 2026-10-04（第三十五轮 · P0）：**发布前把专属相册清到一条不剩**

> 用户指令：「显示在页面中的照片、视频只有那一个叶子文件夹里的东西……**这个功能为 p0 重要级，
> 有其他任务加进来后，也必须优先做这个**」；追问时原话：「**我跟你说全部删掉，你还考虑误杀什么？
> 你能不能不要多加想法？我指令已经非常非常明确了**」。
> ⇒ **全删，不做任何保留判断**。这条用户已经说死了，**不要再问第二次**。

提交 `ed9d381`（4 文件 +357 −8）。HANDOFF §5 顶部已写成 P0。

### BC1. ★★ `clearMediaDir` 的最终正确写法（四个真问题，逐个都有实测证据）

| # | 真问题 | 实测证据 | 正确做法 |
|---|---|---|---|
| 1 | 磁盘残留清不掉，却**假装清干净了** | `ls -laR` 里有 10-02 23:28 的 mp4（**38,919,318 B**），而 `content query` 按 `_data` 前缀**匹配不到它** ⇒ 老代码 `removed=0` + `ok:true` | **不能只依赖 MediaStore 记录**，必须直接对**磁盘目录**动刀；表名 2 张 → 4 张（video/images/audio/files）、路径认两种写法 |
| 2 | 删目录本体在占用时必失败 | `rm -rf <dir>` → `rm: <dir>: Text file busy`；紧接着的 `mkdir -p` 又「成功」得毫无意义 | **只删内容**：`find <dir> -mindepth 1 -delete`，**绝不碰目录本体** |
| 3 | `Text file busy` 死等无效 | `am force-stop com.shizhuang.duapp` 后**照样失败**；报错提到的子目录**早已不存在**；等 3s/60s 全无效 ⇒ 是**文件系统 stale 句柄**，不是得物持有 | **`mv` 换名法**（同一时刻 `rm -rf` rc=1、`mv` rc=0）：改名为 `<dir>_trash_<时间戳>`，再 `mkdir` 新的。**改名不删 inode ⇒ 不受句柄影响** |
| 4 | 两处「读不到 = 空的」 | ① 目录不存在时 `ls -A` 非零+空输出 ⇒ 被当成"目录是空的、已干净"；② `ls` 因权限失败也被 `left=''` 放过 | 判据统一：**命令 `ok` 且 `stdout` 非空才算有残留**；目录不存在 = 干净（并建出来）；**其余读失败一律如实报错** |

★ 第 4 条的**顺序**也不能反：**先 `ls -A` 定状态、再 `mkdir`**。
写成「先 mkdir 再 ls」⇒ `missing` 分支变**死代码**，反向验证时**一条都不红**（我第一次就是这么写的）。

### BC2. ★★★ `shell()` 的引号坑（第三次踩，这次踩透）

`adb.js#shell()` 走 `execFile` **数组传参** ⇒ 设备端最终执行 `sh -c '<我们拼的整串>'`，
**里面的引号会被再解析一次**。实测：`rm -rf '<dir>'/*` 到设备端引号已被剥掉，
`ls -A` 的结果变成**设备根目录 `/`**（`acct / apex / bin / data …` 全列出来）。

⇒ **不要往设备端塞任何引号 / glob**。用 `find <dir> -mindepth 1 -delete` ——
路径 `DCIM/Camera/bluev` 全是安全字符，**压根不需要引号**。

### BC3. ★★ 假 adb 只认 `rm -f` ⇒ 清相册在回归里是**空操作**（典型假绿）

补齐的真实语义：`ls -A`（存在 / 不存在 / 读不出 **三态**）、`mkdir -p`、`find -delete`、`rm -rf`、
`mv`（**永远成功** —— 这正是换名法成立的根据）、
`content delete`（删记录时**物理文件一起没**）；
`content query` 投影改成真机格式 `Row: N _id=K, _data=路径`
（旧夹具**漏 `_id`** ⇒ `clearMediaDir` 的正则全漏 ⇒ 假绿）。

新增现场开关：`DIR_STALE`、`DIR_UNREADABLE`。
状态挂 `fakeExec.__bluevDir`（`{exists, files, renames}`）供断言**直接读目录内容** ——
比解析 `calls.log` 强：后者只能证明"发过命令"，证明不了"目录真干净了"。

### BC4. ★★ 反向验证（三组定点破坏全部变红）

| 破坏 | 红了几条 | 关键红的 |
|---|---|---|
| 去掉 `mv` 换名法 | 3 | 清相册 ③ / ③反向对照 / ⑥ |
| 去掉「目录不存在=干净」 | **48** | 清相册 ② + **整条发布链全崩**（推图·点击·好物·多图·视频·㉖ 全红） |
| 读不到时判「干净」 | 1 | 清相册 ④b |

★ 「破坏②红 48 条」印证了用户的现象：**清不干净会连锁毁掉整条发布流程**。

★ 反向验证的**两个新坑**：
① 过滤 `^FAIL` 行时**切片写错** ⇒ 明明红了却打印空数组（要用**整行**，别 slice 掉关键信息）；
② 该文件是 **CRLF** ⇒ 锚点用 `\n` 拼必然匹配 **0 次**（跨行锚点要按该文件的换行符写）。

### BC5. 真机端到端（127.0.0.1:16384 / MuMu 12 / Android 12）

清前：库里 1 条记录（`content://media/external_primary/video/media/206`）+ 磁盘 2 个文件
⇒ 清后：`removed=1`、磁盘空、`video`/`images` 库**各 0 条**、**目录仍在**（得物相册能识别）。

回归：17 套 **1310** 项全绿（改动前 1299 ⇒ 新增 11 条）。

### BC6. ★ 尚未做完（同样按 P0 对待）：**发布完自动回到主线**

发完第 2 条起，App 可能停在**个人主页 / 相册页 / 动态详情页**，定位表第 1 步点不到 ⇒ 缺「回主线」守卫。

### BC7. 设备脏数据（非产品问题）

测试时在 `/sdcard/DCIM/Camera/` 下造了一批垃圾目录（`bluev_trash_*` / `_z_*`），
被 stale 句柄锁住，**`rm` / `mv` 都清不掉**（里面只有空目录、无素材）⇒ **要重启模拟器才能清**。
真实发布不会产生这种目录。


## §BD 2026-10-04（第三十七轮）：**「掉线 ⇒ 整页白屏」的根因与兜底**

### BD1. ★★★ 根因：`guard()` 拒绝时**返回对象、不抛异常**

`src/main/ipc.js`：

```
function guard(fn) {
  return async (e, ...args) => {
    if (!auth.enabled()) return fn(e, ...args);
    if (!auth.current()) return { ok: false, error: '未登录或登录已过期，请重新登录' };  // ★ 不抛
    return fn(e, ...args);
  };
}
```

`config:get` / `project:get` **都走这个 guard**。渲染层有 12 处裸赋值：
`state.config = await appApi.configGet()` ⇒ 把**拒绝对象当成配置**存进 state。
而各页渲染直接读深路径（`project.compliance.stats` / `config.copy.rotateStrategy` /
`config.publish.intervalSec`）⇒ 读一层就抛 ⇒ **整页白屏、一句话都不给**。

**实测（`tools/_rv-projectnull.js`；11 个页签逐个 `renderAll()`；`config` 与 `project` 变量必须隔离）**：

| 形状 | 崩页数 / 11 | 崩在哪几页 |
|---|---|---|
| 真值（控制组） | **0** | — |
| `project = null` | 6 | 1 · 2 · 3 · 4 · 6 · 11 |
| `config = null` | 5 | 1 · 2 · 3 · 6 · 11 |
| `project = {ok:false}` | 2 | 2 合规检查 · 3 文案生成 |
| `config = {ok:false}` | 2 | 3 文案生成 · 6 模拟器发布 |

★ 第一版把 `project` 与 `config` 混在一起测 ⇒ **分不清是哪一个把页面打白的**，白跑一轮。隔离变量是前提。

### BD2. ★★ 可达性分层（别把「工具造出来的形状」说成「线上会发生」）

- `null`：**正常安装不会出现**。`project.get()` 永远返回 `blank()` 的完整对象；
  所有 `renderAll()` 都在 `enterApp()` 之后。**只有绕过 `enterApp` 直接驱动渲染层的脚本会造出来。**
- `{ok:false}`：**会**。会话失效 / 账号被停用后，点「模拟器发布 → 连接/使用设备」
  （`app.js` 第 2792、2826 行 `state.project = await appApi.projectGet()`）⇒ 随后切到
  「合规检查」或「文案生成」就是白屏。**窄路径 + 最差表现**（用户既不知道「没数据」也不知道「掉线了」）。

### BD3. 修法（最小改动，只在渲染入口）

`renderAll()` 前加 `stateGate()`，两档：

- `kind:'denied'`（`{ok:false}`）＝**会话没了**，不是「这页没数据」⇒ `showGate(原因)` 回登录页；
- `kind:'missing'`（null / 缺 `PROJ_KEYS`/`CFG_KEYS`）⇒ **只画一句人话**（把原因写出来），不渲染各页。
- 真值时**一个字不改**，照原路径渲染。

**不补假默认值**（那是造假）、**不逐个 catch**（那只会把白屏换成半个页面，仍然没人知道为什么）。
判定放在**唯一入口** ⇒ 12 处裸赋值 + 将来任何新渲染点都被同一道闸门挡住。

`PROJ_KEYS = items/compliance/verify/sheet/publish`（`project.blank()` 保证）；
`CFG_KEYS = paths/flatten/compliance/copy/verify/publish`（`store.defaults()` 保证）。
⇒ 真值永远不会误判成 `missing`（实测控制组 11 页全绿）。

### BD4. 断言与反向验证（数字可复算）

新增 10 条：`uicheck` 5 条（199 → **204 / 0**）、`logintest` 5 条（95 → **100 / 1**）。
5 条的分工：**正向对照**（真值下 11 页每页真渲染 / 会话在时不许误弹登录门）· **不许抛** ·
**每页都要有交代** · **要写出原因** · **自证还原**。

`_rv-badrender.py`（锚点 `count==1`、逐字节校验落盘、`try/finally` 兜还原，干净源码 md5 `110afd33…`）：

| 破坏 | uicheck | logintest |
|---|---|---|
| B1 `const g = stateGate();` → `null`（入口摘掉） | **201/3**（新断言红 3/5） | **97/4**（红 3/5） |
| B2 `if (dp or dc) {` → `if (false) {`（拒绝不再识别） | **203/1**（红 1/5） | **98/3**（红 2/5） |

★★ **B2 我猜错了**（脚本里预填「期望全绿」，实测多红 1 条）：原以为「壳 or 登录页」两个都算有交代 ⇒
uicheck 会漏过；实际 `壳里把原因写出来` 那条**也能区分「拒绝」与「缺字段」**。
⇒ **反向验证真正的价值：它会告诉你每条断言到底在守什么，而这跟你事先想的不一定一样。**
（如实记下来 —— 猜错不丢人，把猜的当成实测才丢人。）

### BD5. ★ 那条既有 FAIL：测试读了**本机真实台账**

`logintest` 的 `统计里「未标品牌」是独立的一桶` 断言 `untagged.rows === 0`，但它断言的数据来自
`paths.output` 下的真实台账 —— `logintest` **没有**把 `paths.output` 指到临时目录 ⇒
读的是 `C:/Users/Administrator/输出/得物/publish-log.jsonl`
（实测 39 行，其中 **18 行无 brandId**，分布 `{brd_muqfsocjcff307:21, '':18}`；文件 mtime 12:02，
**另一路会话正在跑发布**，本轮内从 12 长到 21）。
⇒ **测试依赖本机数据**，与任何代码改动无关（拿 HEAD 版复跑同一条照样红）。
要稳定：把 `paths.output` 指到临时目录 + 自造「一条无品牌 + 一条有品牌」的记录（语义反而更强）。

### BD6. ★ 截图工具的正确写法（`tools/_shot-settings.js`，三次踩坑）

三次踩坑全在文件头注释里，值得复用：

1. **不能直接 `renderAll()`**：`state.project` 是 null ⇒「素材整理」页抛 ⇒ 异常在 `executeJavaScript`
   里成了**未捕获 rejection** ⇒ **Electron 不退进程**，表现是「脚本挂住 6 分钟、一个文件都没产出」。
2. **不能只点 nav**：nav 的 `onclick` 是在 `bindOnce()` 里绑的，而 `bindOnce()` 只在 `enterApp()` 里调
   ⇒ 绕过后**等于没接线**，点了什么都不会发生 ⇒ 截出来是空页面。
3. **`process.argv` 里夹着 electron 自己的开关和脚本路径** ⇒ 参数要
   `slice(2).filter(a => !a.startsWith('-') && !a.endsWith('.js'))`；否则把图写进一个叫 `--disable-gpu` 的文件。
4. **注入主进程真值时必须直接嵌 JSON 字面量**：`REAL_CFG` 本身已是 JSON 文本，
   再 `JSON.stringify()` 一次就成了「字符串」⇒ 等价于没有配置（我是这么踩的，**顺手证明了 BD3 的兜底真在工作**）。

正确顺序：`store.get()` / `project.get()` → `state.config/state.project` → `state.auth`(角色)
→ `document.body.classList.remove('locked')` → **`bindOnce()`** → `renderAll()` → 截图。

### BD7. 这轮改动落点（未提交）

`src/renderer/app.js`（`stateGate` + `renderAll` 入口）· `tools/uicheck.js`（+5 断言）·
`tools/logintest.js`（+5 断言）· 新增 `tools/_rv-projectnull.js`（诊断）· `_rv-badrender.py`（反向验证）·
`tools/_shot-settings.js`（截图）。
★ 工作树里 `adb.js / publisher.js / uimap.js / adbtest.js / fakeadb/adb.js` 的 M **不是我的**（另一路会话）。

---

## §BE 2026-10-04（第三十八轮）：**「跳过封面页」= 盲点坐标；盲点会连「天然等待」一起省掉**

用户原话：
> 视频在选择素材后，连点两下即可跳过封面页 图文就点一下 你搞吧

### BE1. 真机实测坐标（MuMu 12 / 1080×1920 / `TotalPublishProcessActivity`）

| 屏 | 元素 | bounds | 中心 |
|---|---|---|---|
| 相册页 | `flNextStep` | `[891,1794][1080,1892]` | **(985,1843)** |
| 剪辑页 | `flNextStep` | `[891,1794][1080,1892]` | **(985,1843)**（与相册那颗 **bounds 完全相同**） |
| 封面页 | `tv_skip`「跳过」 | `[761,1829][880,1885]` | **(820,1857)** ← **要点这颗** |
| 封面页 | `tvNextStep`「下一步」 | `[926,1829][1045,1885]` | (985,1857) ← **不能点** |
| 「编辑封面」屏 | `tvNextStep` | `[926,1815][1045,1871]` | (985,1843) |

封面页整屏文字：`设置封面 / 拖动或双指缩放可调整封面 / 支持相册导入封面或拖动选择封面 / 相册导入 / 跳过 / 下一步`。

### BE2. ★★★ 封面页必须点左边那颗「跳过」

- 实测点右边「**下一步**」**不到编辑页** ⇒ 进 **又一屏「编辑封面」**（文字：`编辑封面 / 封面模板 / 文字 / 下一步`），
  再点一下才到编辑页 ⇒ **多花一屏**。
- 点左边「**跳过**」⇒ 一步到编辑页。
- ⇒ 用户说的「连点两下」= **剪辑页「下一步」(985,1843) + 封面页「跳过」(820,1857)**，
  **不是「同一坐标连点两下」**（我第一版就这么写错，跑出 0/2）。

### BE3. ★★★ `tapId` → `tapXY` 会**连那份天然等待一起省掉**

- `tapId` 每步先 `uiautomator dump`（**2085ms**）再点 ⇒ 点击之间**天然隔着 ~2.1s**，顺带把屏间转场等掉了。
- `tapXY` 是**立即点**。实测后果（0/2）：
  - seq1：连点两下后**还停在剪辑页**（两下都被当成「转场中的空点 / 一次双击」）；
  - seq2：只过一屏，停在封面页。
  - 报错位置离真因很远：表现为后面「点标题输入框」**找不到 `etTitle`**。
- ⇒ 改盲点后，**后一步是新屏就必须补固定等待**。本轮的补法（纯配置、未改 src）：
  `{ action:'wait', value:1200 }` 插在「相册下一步」之后、「剪辑页 · 下一步」之后（**只有视频需要**）。
- 图文**不用补**：它那步带 `whenOn: edit_panel` 屏幕守卫，**守卫的 dump 本身就是等待**。

### BE4. 改动落点（全在 `tools/fixuimap.js`，幂等；**没动 src/**）

- 规则 **⑦**：`剪辑页` → `tapXY 985,1843`；`封面页` → `tapXY **820,1857**`（并改名「封面页 · 跳过（不设置封面，直接下一步）」）；
  `图片编辑页` → `tapXY 985,1843`，**保留 `whenOn: edit_panel` 守卫**
  （不能删：单选图没有这一屏，盲点无条件点下去会落到编辑页底部的「发布」上 ⇒ **误发**）。
- 规则 **⑦-b**：视频在「相册下一步」「剪辑页下一步」之后各插一个 `wait 1200`（先按名字删旧再按位置插，幂等）。
- `fixuimap.js` 新增 `BLUEV_CFG_DIR` 环境变量覆盖配置目录（回归测试用临时目录跑，**不动真实配置**）。

### BE5. ★ 顺带踩到的真现象（**非本轮改动引入**，如实记）

- 我把设备停在**封面页**没退出 ⇒ 得物侧留下「未编辑完的视频动态」⇒ **冷启动一进首页就弹**
  `是否继续编辑 / 你有未编辑完的视频动态，是否继续？ / 放弃 / 继续` ⇒ **把整个入口挡住**。
- `videoSteps[0]`「底部「我」」是**盲点、不校验** ⇒ 点在弹窗遮罩上也算"成功"，下一步「右上角主页」
  白等 7s 后报 `找不到 tvGoHomePage；当前可见文本：是否继续编辑…`（报错位置离真因很远）。
- 现有「未完成草稿拦截 · 点「放弃」」守卫步在 **step5**（草稿箱拦截之后），而弹窗在 **step0/1 就挡路** ⇒ **拦不到**。
  触发条件：上一轮中断 / 被杀 / 干跑停在编辑页。**正常连续发布不会遇到**。
- **清法**（唯一可行）：`am force-stop` → 重启 → **首页弹窗**里点「放弃」
  （按文字定位 `text="放弃"`，bounds `[339,1173][531,1247]` → 点 (435,1210)）。
  ★ 编辑页内按返回弹出的那个窗只有 `返回编辑 / 保存并退出 / 取消`，**没有「放弃」**，别在那儿找。
- **待办（用户没要求，未做）**：把该守卫步**前移到入口之前**。代价：每次发布 +1 次抓屏（~2.2s）。

### BE6. 结果与自证

- 真机连发 2 条视频：**2/2 成功，124.8s**（上一轮 137.5s）。
  「选中要发的视频 / 下一步（离开相册）/ 剪辑页 · 下一步 / 封面页 · 跳过」**全部掉出耗时表（<300ms）**；
  新增「等下一屏」`1200ms × 4`。
- `adbtest` **302 PASS / 0 FAIL**（㉗ 块从 5 条扩到 8 条：新增 2 条 wait 位置断言 + 1 条「图文不该有 wait」）；
  `run-all` **17 套 / 1380 项全绿**（adbtest 302）。
- **反向自证**：删掉 `fixuimap.js` 的 ⑦ 块 ⇒ **正好 3 条 ㉗ 变红**（剪辑页 / 封面页 / 图片编辑页），
  而「whenOn 守卫必须保留」「幂等」两条**仍绿**（证明各测各的，不是恒真）；还原后 0 FAIL。
  ★ 破坏脚本用**临时目录备份 + `cp` 还原**，全程**不用 `git checkout`**。



---

## §BF 2026-10-04：**跑回归 / 改完要自证 —— 13 条硬规则**
（原文从工作区 `MEMORY.md` 移入：那份是**被自动注入的上下文**，有 3000 字符/session 上限，超了会**静默截断**。）

- ★★ `node tools/run-all.js` → 十七套；断言数每次重取；别设 `BLUEV_NO_LOGIN`。
- ★★ 每条破坏从干净源码起（先 `restore`）；锚点 `count==1`；`try/finally` 兜还原。
- ★★ 反向验证：**套件中断 ≠ 没抓住**（禁拿退出码判）；**破坏后 PASS 必须 >0**；跨行锚点按该文件行尾写（§AX/§BC4）。
- ★★ 比较型断言查「是否**真调**那条命令」；asar `extractFile` 只认**反斜杠**；跑 electron 前必删 `ELECTRON_RUN_AS_NODE` + `--in-process-gpu --disable-gpu`（§AV）。
- ★★ 补丁写成 `.py` 再跑；换行符**逐文件不同**，按该文件风格写回（§AR3）。
- ★★ 假 adb 夹具**必须补齐被测命令的真实语义**，否则整条链路是空操作（假绿）（§BC3）。
- ★★★ **假夹具禁写"我推断出来的症状"**（只准复现真机亲眼看过的）；判据只能来自**逐条真机实验** —— 否则
  「现象/夹具判据/修法/断言」四者互为出处＝**可靠性 0**（我据此"修"出不存在的 bug，§BC3）。
- ★★ 守卫步**条件不成立时也要学「这屏不 idle」**（原只学成功路径 ⇒ 每条内容都白等；实测 13.5s→3.0s）。
- ★★ 回归脚本里任何 `unlinkSync`/`rm` 都要幂等：抛 ENOENT 会让**整份回归静默中断**，外部只看 PASS 数发现不了。
- ★★ 反向验证**会告诉你每条断言到底在守什么**：实测与事先预测不符时**如实记**（本轮 B2 比我猜的多红 1 条）（§BD4）。
- ★ `logintest`「未标品牌」断言读**本机真实台账** ⇒ 会随真实发布变红，**不是代码缺陷**（§BD5）。
- ★ 截渲染层真图 = `tools/_shot-settings.js <目录> both`（灌真值 + **必补 `bindOnce()`**，否则点 nav 等于没接线）（§BD6）。
- ★★ 发版走技能 `concurrent-workspace-safe-release`（§S5）。


---

## §BG 2026-10-04：**自动更新 / 发版 —— 硬规则汇编**
（原文从工作区 `MEMORY.md` 移入：那份是**被自动注入的上下文**，3000 字符/session 上限，超了会**静默截断**。）

- ★★ 绝不自动重启、运行时禁改源地址；两个 auto* 恒 `false`；漏跑 `upload-release.js` ⇒ 永远「已是最新」（§AI~§AL）。
- ★★ `upload-release.js` 要 `dist/` 恰好 1 个 exe；**同号覆盖被拦** ⇒ 已装用户静默收不到（§AM）。
- ★★ 打包前清 `src/` 下 `.bak*`；`dist/` 勿重传（§AN）。

- ★★★ **发包 ≠ 生效 —— 先确认这次的修复落在「哪一层」**（v1.0.11 实测踩到）：
  盲点坐标（`tapXY` `166,359` / `985,1843` / `820,1857`）写在**用户配置** `config.json` 的
  `publish.uiMap.steps / videoSteps` 里，由 `tools/fixuimap.js` **就地打补丁**。
  而 `package.json` 的 `build.files` 只收 `src/**/*` + `package.json` ⇒ **`tools/` 不进包**；
  `store.js` / `clouddefaults.js` 里**也没有默认 uiMap** ⇒ **升级包不会让别的机器自动变快**。
  要在另一台机器用上，得在那台机器跑 `tools/fixuimap.js`，或导入一份改好的 `uiMap.json`。
- ★ v1.0.11 发布取证（可复算数字）：快照 `D:/work/_rel1011`（HEAD `57e91c5`）上跑回归
  **17 套 / 1380 项全绿**；asar 全扫 **2517 条目 / 真读到 2154 / 50801710 字节**（门槛 PASS）；
  包内版本 1.0.11；公网 `latest.yml` = 1.0.11、新 exe `Content-Length: 107063069`（与本地同值）、
  `beta.yml` 仍是 `1.0.1-beta.2`（没动）。
- ★★ **换已装副本前必须拿到确凿的进程清单**：`Get-Process | ? { $_.Path -like 'D:\bluevbeta\*' }`
  实测命中 **4 个**（PID 38200 / 41476 / 45648 / 61056）⇒ 停手不换。
  ★ PowerShell 的 stdout 这次**被吞成空**，是**把结果写成文件再读**才拿到清单的 —— **空 stdout ≠ 没有**。
- ★ 别被「条目数变了」吓到：主仓 `node_modules` PowerShell 数 **313**、bash `ls` 数 **311**，
  差的是 `.bin` / `.package-lock.json`（PowerShell 数点文件、`ls` 不数）；
  `ls -a` = **315** = 311 + 4 ⇒ **没有发生目录联接被穿透删除**。关键依赖 + `electron.exe`（180849624 B）
  + `tools/smoke.js` 全部复核通过。

## §BH 2026-10-04：得物**解不开 10-bit HEVC** ⇒ 判「能不能解」必看**视频轨位深**，不看扩展名
- 现象（用户 P0）：素材是 `.mp4`、合规检查判「格式没问题」，真机发出去却是**全黑封面**、
  得物相册里**一直转圈**。
- 真机硬证据（同一批两条，唯一差别是位深）：
  · `82-326313100701-变装展示-7月份.mp4` = **HEVC Main 10** / `hvc1` / `yuv420p10le` / 1080x1920 / 39.9MB ⇒ **黑**；
  · `79-326313100774-变装-7月.mp4` = **H.264 8-bit** ⇒ 正常。
  ⇒ `hvc1` 在编码白名单里也**不能**放行 —— 得物解的是 **8-bit**，10-bit 的 hvc1 照样黑。
- 判据（**纯字节解析，不调 ffmpeg**）：
  · `stsdVideoCodecs`：在 `moov` 里找 `stsd`，取 **+16** 起的 4 字节 = 编码四字码；
  · HEVC：`hvcC` 内容 `[1] & 0x1f` = `profile_idc`（**Main 10 = 2**）；
    `[17] & 0x07` = `bitDepthLumaMinus8`（Main 10 ⇒ 2）；
  · H.264：`avcC` 内容 `[1]` = `profile_idc`（**≥110 = High 10 及以上**：110/122/244）。
- 落点：`video.js` 的 `videoTrackInfo / decoderCompat / codecLabel / probeDecodable`。
  ★ `decoderCompat`：**认不出编码 fail-closed**（拦）、**读不到位深则放行**（不误杀）。
  `verifyMp4` 升级成位深判据 ⇒ 10-bit 源走 `toMp4` 时「转封装不合格 ⇒ **自动落转码**」。
- `compliance`：合格分支再探一次位深，命中就出
  `issue='视频轨是 …，得物解不开（相册里会是黑格 + 一直转圈，发出去就是黑封面）'`、
  `codecBad:true`（与 `notMp4` **互斥、绝不合并**）、`action='转码 H.264（8-bit）'`；stats 加 `codecBad`。
- 回归：`videotest` K 组（手搓 `stsdOnly/hvcC/avcC` 喂纯函数走全分支 + 真造 10-bit/8-bit 用 ffmpeg 原话对照）；
  `compliancetest` ⑥ 段走集成路径。★ 必须留 **K3「hvc1 但 8-bit 必须放行」** 这条**反向对照**，
  否则「一律拦 hvc1」也能全绿。

## §BI 2026-10-04：清相册删不掉 = **两种锁**，现象一样、解法不同
- 前提：「`find <dir> -mindepth 1 -delete` **rc=0 却静默不删**」⇒ 判断清没清**一律回读目录**，不信退出码。
- ① 锁在**得物进程**里（App 停在发布页/相册页，拿着 mp4 的硬解码句柄）：
  `rm` / `find -delete` / `rmdir` / `mv` 全失败（`Text file busy` / `Operation not permitted`）；
  **`am force-stop com.shizhuang.duapp` 后同一句立刻成功**。
- ② MuMu sdcardfs 的**真 stale 句柄**：强停也解不开，只能 `mv` 换名（会造 `X_trash_<ts>` 残骸）。
  ⇒ 两手都留。
- `clearMediaDir(serial, dir, { forceStopPkg })`：1b 段「**先强停 + sleep 500ms + 重试删**，成功就不换名」，
  过不了才落原换名分支；返回体新增 `forceStopped`（**5 个 return 点都要带**）。
- `publisher`：两处 `clearMediaDir` 都传 `{ forceStopPkg: uimap.DEWU.pkg }`；
  `clRoot.forceStopped || cl.forceStopped` ⇒ `log(..., 'warn')` + `pullHome('清相册时强停过得物')`
  —— 强停会把 App 打回桌面，**不重新回主线后面全错位**。
- 回归 `adbtest` D7 组：新现场开关 `DIR_LOCKED_BY_APP` + 记录 `appStops`（`am force-stop` 才置位）；
  ⑮「没占着 ⇒ **一次都不许强停**」、⑯ 源码级 `codeOnly()` 后 `iLock < iMvTry`。

## §BJ 2026-10-04：发布前必须拦「要回写的 Excel 正被占着」（用户口径：**禁止发布**）
- 为什么必须**开跑前**拦：发布结果要回写「AI 内容报告（B/C 列）+ 发布单」；被 Excel 占着时只能
  `putPending` **暂存**，用户看到的是「失败了、日志还写不进去」，而**整批已经白跑**
  （实测一次 3 条 / 87.4s，一条都没落进报告）。
- 判据 `wp.probeWritable(file)`：`fs.promises.open(p,'r+')` → `close`；
  `ENOENT` ⇒ `exists:false`；抛 EBUSY/EPERM/EACCES ⇒ `busy:true`。**一个字节都不写**（这是运营的账）。
- ★ **不能拿 `~$xxx.xlsx` 当判据**：那是 Office **崩溃残留**，实测有 `~$` 但文件并没被占用 ⇒ 会**误拦**。
- `jobs.assertExcelClosed([...])` 挂在 `publish.run` **和** `publish.rerun` **各一次**
  （两处 = **两条独立防线**，少一处就有一条路径溜过去）；`exists:false` 不算占用、空路径跳过。
- 回归 `pendingtest` ⑥/⑦/⑦b/⑦c：⑥ 探三态（不存在 / 正常 / 只读）；
  ⑦ 用 **`publisher.run` 调用计数**当「一条都没发」的证据（mock 通道下没有 adb 命令可数）；
  **⑦c 是反向对照**（文件可写时**不许拦**）—— 只测负向 = 假通过（一个「永远拦住」的实现也能全绿）。
- ★★ **用例之间会互相污染**：⑦ 一旦放行，发布器返回的 `rows: []` 会被 `project.patch` 写回工程 ⇒ 队列被清空
  ⇒ 紧跟的 ⑦b 变成「找不到该行」而红。**这是用例耦合、不是缺陷**，但它会掩盖「破坏 A 只该让 ⑦ 红、
  ⑦b 应保持绿」这个关键结论 ⇒ 每个子用例都要 `arm()` 重置（队列 + 占用开关 + 计数）。

## §BK 2026-10-04：「**发出去了才算成功**」+ 草稿弹窗步要在**最前面也插一份**
- 用户口径（原话）：「发出去了才算成功」。⇒ 点完「提交发布」**必须轮询前台**：
  只有 `!isPublishScreen && !isDraftScreen` 才算成功（`publisher.waitLeftPublishFlow`，
  返回 `{ok, waited, focus, left, seen}`）；否则**记失败** + `am force-stop` 把那条没发出去的草稿清掉；
  ★ **读不到前台 ⇒ 不算成功**（不许把「读不到」当成功）。
- 等待时长 `publish.postPublishWaitSec`，默认 **15s**。
- 草稿弹窗（「是否继续编辑」）那步原来排在**草稿箱拦截之后** ⇒ 拦不住起手那一次。
  `tools/fixuimap.js` 改成**插两份**：起手 `arr.unshift(...)` + 原位 `arr.splice(iIns+1,0,...)`，
  两份都带 `whenOn = com.shizhuang.duapp:id/tvCancel`；步数 37→38 / videoSteps 40→41。
  ★ 改完**连跑 3 次验幂等**（步数不变）。
- 回归 `adbtest` F 组：新现场开关 `TAP_FOCUS`（`publish`/`draft`/`leave`）摆三种现场，
  `store.set({publish:{uiMap, intervalSec:0, postPublishWaitSec:1}})`；
  ⑤ 行为级超时对照（实测 **1218ms / 3026ms**）；④ `isDraftScreen` 三态自证。
  ★ `TAP_FOCUS` 必须写在**已有的** `if (/^input (tap|keyevent|text) /)` 分支**内** ——
  另起一个分支写在它后面就是**死代码**（已踩过）。

## §BL 2026-10-04：**换本机已装副本 asar** 的完整实操（含一个会抹掉配置的坑）
- 触发：用户口径「我电脑上的 app 应该还没更新你改的 bug，你提交后，我覆盖 app，然后你操作」。
- 提交：`5efde21`（13 文件 / +933 −44）；**未 bump 版本号**（1.0.11）—— 本机覆盖验证用，
  等真机验过、要发给别人时再 bump 1.0.12 发版（发版范围要单独问用户）。
- ★ **「已装 app 含不含某次修复」用 asar 字节查，别靠版本号**：
  `grep -a -c <新符号> <安装目录>/resources/app.asar`
  （asar 里的源码是**明文**存放的，直接 grep 二进制即可）
  · 实测已装副本（`D:/bluevbeta/dewu-bluev-publisher`）：`probeDecodable / probeWritable /
    assertExcelClosed / forceStop / waitLeftPublishFlow` **全 0 处** ⇒ 确实不含本轮修复；
  · 对照符号 `animOffSteps` = **9 处** ⇒ 证明「grep 这条路本身有命中」，0 处不是空转。
- ★★ **只产 `app.asar` 的最快做法**：`electron-builder --win --x64 --dir`（**8s**）
  ⇒ 出 `dist/win-unpacked/resources/app.asar`，**不打 107MB 安装包、不覆盖 dist/ 里已有的
  `-1.0.11-x64-win.exe`、不上传**（实测打完原 exe / latest.yml / blockmap 原样还在）。
- ★★ **换之前先证明「只需要换这一个文件」**（否则换完可能启动不了）：
  · `app.asar.unpacked`（85 个文件，sharp 的原生库）**两边清单逐条一致**；
  · 框架文件 `ffmpeg.dll / icudtl.dat / resources.pak / libGLESv2.dll` **大小逐项一致**
    ⇒ 同一个 electron `31.7.7` ⇒ **只换 `resources/app.asar` 即可**。
- ★★★ **坑：userData 与已装副本共用同一个目录。** `package.json` 的 `name` 是
  `dewu-bluev-publisher` ⇒ 已装版与开发版都读写
  `C:\Users\Administrator\AppData\Roaming\dewu-bluev-publisher\config.json`。
  那 4 个**旧实例**内存里是**旧 uiMap（37 步）**，任何一个 `store.set` / 退出写盘都会把
  **我 `tools/fixuimap.js` 打的 38 步（起手「点放弃」）覆盖回 37 步**。
  ⇒ **换完 asar 必须重跑一次 `node tools/fixuimap.js`（幂等，连跑 3 次步数不变）再启动**。
- ★ 覆盖前必须**关掉全部实例**：实测 `Get-Process | ? { $_.Path -like 'D:\bluevbeta\*' }`
  命中 5 个 = **4 个真实例**（PID 38200 / 41476 / 45648 / 61056）+ 1 个它自带的 `adb.exe`。
  ★ PowerShell 的 stdout 这次**又被吞成空** ⇒ 一律**写文件再读**（`$env:TEMP\bluev-procs.txt`）。
- ★ 想省掉「覆盖」这一步也行：直接跑 `dist/win-unpacked/得物蓝V素材发布工具.exe`
  （免安装副本，同样能落地本轮修复；userData 还是同一份 config）。

## BM. 相册是「全盘聚合视图」+ 清全盘相册 `clearAlbum`（2026-10-04 真机实测）

- ★★★ **得物相册里那个「所有照片」是**全盘聚合**的**（真机对照实验，可复算）：
  把一条 mp4 放进 `/sdcard/Movies`（**不在** `DCIM/Camera` 下）⇒ 它照样出现在得物相册里、
  和专属目录里的**并排显示**（已截图）。⇒ **光清 `DCIM/Camera` 不能保证「发布这条时相册里只有他的素材」**。
  唯一靠得住的判据 = **MediaStore 里没有别的素材**：`adb.clearAlbum` 复查四张表为空才算过。
  （用户口径原话：「你只要保证发布某条素材时，调出相册只能看到他的图片或者视频」。）
- ★★ **得物只有「点选素材、进编辑页、开始解码」时才持句柄**：此时 `rm -f` → `Text file busy`（rc=1）；
  **`am force-stop com.shizhuang.duapp` 之后同一句立刻成功**（真机实测两次对照）。
  只**停在相册页/发布页**时**不**持句柄（实测能删）—— 所以复现用户那条报错必须走到编辑页。
- ★★★ `content delete --uri content://media/external/<表>/media/<id>` 删的是**记录**：
  **App 持着句柄时也照样删得掉**（相册里立刻看不到），但**物理文件会留下**；
  文件不删的话下一次 `scan_volume` 会把它**重新索引回来** ⇒ 两步都要做（先 `rm -f`、再删记录）。
  按 `_id` 删**不需要引号**（引号会被 `adb shell` 再解析一次吃掉）。
- ★★ **不假装清干净**：`clearAlbum` 的 `ok` 只由「复查时四张表为空」决定，不看"删成功了几条"。
  ★ 反向自证实测：把清理范围退回「只清 DCIM/Camera」时，**`ok` 仍然是 `true`**（因为复查被同一个
  bug 带偏了）⇒ 断言必须用**独立于被测逻辑的查询**复查（`libCount()` 直接数库），否则漏判。
- ★★ 清不掉的**空目录**（MuMu stale 句柄）**不影响发布**：不含文件、不进 MediaStore、相册里不显示格。
  ⇒ 判据看「还有没有文件」，不是「目录 listing 空不空」（§BC / §BI 同口径）。
- ★★ ffmpeg **起不来**（ENOENT / 被杀软隔离）时 `execFile` 的 **stderr 是空的** ⇒ 界面只会显示
  「ffmpeg 转码失败：未知原因」（用户没法排查）。已修：把 `err.message` 一并带上 +
  `explain()` 认「启动不了 ffmpeg」并指向「设置 → 外部依赖」。
- ★★ `.mov` + 10-bit HEVC（用户第一条素材的形态）走的是**「转 MP4」**分支，**不是** `codecBad` 分支；
  正确性靠 `video.verifyMp4` 的位深判据把「转封装产物」判掉 ⇒ 自动落转码。真机实测
  `converted=1`，产物 `avc1 / High / 8-bit`（得物可解）。

---

## §BN 2026-10-04：`input tap` 老是「点偏」的两层根因 —— **坐标空间** + 肉眼估坐标

### 现象
- 界面里明明写着具体坐标，点下去却「没反应 / 点到别处」，**日志零报错**（用户原话：「为啥你有具体坐标老是会点偏？偏了就浪费时间」）。

### 根因 A：坐标空间（坐标系）随**前台应用方向**变
- `input tap` 吃的是**当前前台应用方向下的设备像素**。
- 实测同一台机两种坐标系并存：
  - 得物（竖屏锁定）：`dumpsys window displays` → `init=1080x1920 … cur=1080x1920`
  - MuMu 桌面（横屏）：`cur=1920x1080`；同刻 `screencap` PNG 与 dump `bounds` **同步变 1920x1080**。
- ★★★ `wm size` 报的是**自然方向**（`Physical size: 1080x1920`），**不随旋转变** ⇒ 拿它校验坐标会**判反**。
  正确来源 = `dumpsys window displays` 的 **`cur=`**。
- ★★★ `input tap` 对**越界坐标不报错**：实测 `input tap 945 1869` 在 1920x1080 上 **rc=0、什么都不点**
  ⇒ 坐标系不对 = **全程静默点偏**，所以必须**主动校验**，不能等报错。
- ★ 追加实测：`settings put user_rotation 0` 之后 `cur=` 仍是 1920x1080 ⇒ 坐标系跟**前台应用**走，
  **不是**设备级旋转开关。

### 根因 B：取坐标的流程（肉眼估 + 猜缩放倍数）
- ★★★ dump 的 `bounds` **本来就是设备像素**，`input tap` 也吃设备像素 ⇒ **中间不需要任何换算**。
- 我的旧错法：截屏肉眼估 + 猜一个 1.8 倍缩放 ⇒ 把 y 算成 235（**真值 423**）。
- 修法 = `tools/where.js`（只读助手），一条命令把「元素 → 设备像素中心」做成**确定的事**：
  `node tools/where.js [serial] [查询词] [--all]`
  打印当前坐标系 / 前台 / 边界自洽性 + 命中节点的**设备像素中心**与可点·越界标记 +
  可直接粘贴的 `{"action":"tapXY","value":"x,y"}`。
- 真机验证：按 `where.js` 给的 `945,1870` 点底部「我」→ 页面切到个人页（出现「关注/粉丝」）。

### 两层守卫（代码位置）
1. **表级**：抓页面结构时把当时坐标系戳进定位表（`uimap.screenStamp` / `suggest(…, {screen})` ⇒ 表里存
   `screen`）；发布时 `runReal()` 读当下 `adb.uiSize()`，`uimap.screenMismatch(map.screen, live)`
   命中即 **throw**（「坐标系和这台设备对不上」）。
2. **逐点**（最后一道）：`runStep` 的 `case 'tapXY'` 里 `uimap.outOfScreenTapPoints([step], ctx.uiSize)`
   命中即 throw（「落在屏幕之外」）；`uiSize` 读不到（`known:false`）时**返回 `[]`（不拦）**，不猜。
- 断言：`adbtest` 新增 **㉘ 组**（坐标空间守卫），含「越界时 **0 个 tap**」的**行为级**断言 + 反向对照。
- ★ 两条防线**相互独立**：定点破坏「只拆 `runStep` 调用点」时，**仅 1 条行为级断言红、纯函数几条仍绿**
  ⇒ 证明外层拦掉时内层仍有效、反之亦然。

---

## §BN2 2026-10-04：**能出声的音频轨白名单**（remux 只保视频轨 ⇒ 会静默丢声）

- 背景：`ffmpeg -c copy` 转封装**只保证视频轨**，音频轨**原样搬进 mp4 且报成功**。
- 实测 `-c copy` 产物音轨（容器认，但**安卓不保证放得出声**）：
  `ac3→ac-3`、`eac3→ec-3`、`opus→Opus`、`pcm→ipcm`、`flac→fLaC`。
- ★★ 唯一「安卓一定放得出声」的 mp4 音轨 = **`mp4a`**（AAC / mp3-in-mp4）⇒ 白名单 `MP4_SAFE_AUDIO = {mp4a}`。
- ★★ **视频轨好、音轨不安全 ⇒ 不能整片转码**（白白牺牲画质/时间）⇒ `toMp4` 加第三条支路：
  `-c:v copy -c:a aac -b:a 128k`，`mode:'remux-audio'`（带 `audioFrom`）。
- `verifyMp4` 新增 `audio / audioSafe / audioWhy`，但**不因音轨判不合格**（视频轨好就不该落整体转码）。
- 合规扫描：新增 `audioBad`（`issue: '音频轨是 X，得物（安卓）不保证放得出声'`），
  与 `codecBad` / `notMp4` **三者互斥**；导出报告汇总列加「音频不可解」。
- 断言：`videotest` **N 组**（音频轨 14 条）+ `compliancetest` **⑦ 组**（AC-3 集成路径）。
- 跨扩展名复核结论（`videotest` **M 组**）：**位深漏斗对所有扩展名都闭合** ——
  10-bit HEVC / 10-bit H.264 装进 `.mp4/.mov/.m4v/.mkv/.webm` 全部 → 整体转码 → 8-bit H.264；
  VP9 / ProRes 必转码；8-bit HEVC 走 remux（**不误杀**）。**m4v 是被堵住的**；
  `M0` 锁 `winpath.VIDEO_EXT` 清单，防新格式绕过验证。

---

### §BO 「发出去没有」的唯一判据（2026-10-04 实测，血的教训）
- **禁只看「跳了什么屏」或一屏 dump 就下结论**。得物点「发布」后落到
  `com.shizhuang.duapp.media.activity.DraftActivity` **既不等于**「存成草稿」，**也不等于**「发布失败」。
- **唯一可靠判据 = 数「动态」与「草稿箱」的条数差**：`PersonalActivity` 里
  `动态` tab 的「全部 N」与「草稿箱」的「有 M 篇动态待发布」，**发布前后各数一次**：
  动态 +1 且草稿 0 ⇒ 真发布；动态 0 且草稿 +1 ⇒ 存了草稿。
- `动态` tab 的瀑布流**不带时间戳**（网格里只有标题 + 「TWM尺码助手」），
  ⇒ **不能**用「列表里看到某标题」证明「某次运行发成功了」。
- 现场数字（2026-10-04）：台账 `C:\Users\Administrator\输出\得物\publish-log.jsonl` 共 106 条
  = 成功 40 / 失败 66；10-04 全天 = 成功 37 / 失败 52；**22:00 后 12 次 = 成功 1 / 失败 11**。
  草稿箱实测 **只有 1 篇**（「少年感煤黑卫衣太帅了🖤」22:41）⇒ 上一轮「3 条里 2 条被存成草稿」**不成立**。
- 同轮查出待修真 bug：`adb.inputText` 把空格换成 `%s` 后走**广播**通道，`%s` **没被还原**
  ⇒ 标题里的空格**原样变成 `%s`** 打进得物（只有带空格的标题中招）。内置 ADBKeyboard 支持
  `ADB_INPUT_B64`（精确字节通道）可根治。违的是 §BC3「文案原样进框、禁加转义层」。
- 定位表隐患：`tvPublish` **跨两屏同 id** —— 发布页 = 「发布」按钮；个人主页 = 「草稿箱」文字。

## §BP 输入通道与「连续发布」实测（2026-10-04）

### 输入通道（真机实测）
- ★★★ **非 ASCII（中文/emoji/含空格/引号）一律走 `ADB_INPUT_B64`**：
  `am broadcast -a ADB_INPUT_B64 --es msg <base64>`，传**原始 UTF-8 字节**的 base64。
  字母表只有 `A-Za-z0-9+/=` ⇒ 设备端 sh 再解析引号也不可能坏；空格/emoji/换行全原样。
  依据：内置 `vendor/adbkeyboard/ADBKeyboard.apk`（与设备上装的**字节数一致**）解压 `classes.dex`
  含 `ADB_INPUT_B64` / `IME_MESSAGE_B64` / `android.util.Base64.decode`。
  ⇒ **`input text` 只留给纯 ASCII**（且空格仍要换成 `%s`，那条通道认）。
- ★★★ 为什么不能沿用 `ADB_INPUT_TEXT`：这条广播**不认 `%s`** —— 旧代码对两条通道都做
  「空格→`%s`」，于是带空格的标题被打成字面 `%s`（现场：`…T恤%s氛围感拉满🍷`）。违 §BC3。

### 判据（防静默失败）
- ★★★ **广播通道永远返回成功** ⇒ input 之后**必须回读**：`adb.readTextOf(serial, id)` dump 回读
  「紧邻上一步 tapId 点的那个框」。读不到 ≠ 成功（只 warn）；不一致 ⇒ **抛错**、不许往下点。
  ★ 空框的 `text` 属性就是**占位符**（「添加标题」/「添加作品描述」）⇒ 截图与日志都分辨不出空框。
  ★ emoji 在 dump 里是 XML 实体（`&#127863;`）⇒ 回读要 `adb.unxml` 还原。
- ★★★ 点完「发布」落 `DraftActivity` ⇒ **立刻**判失败（`{ok:false,draft:true}`），别傻等满超时
  （真机 0.8~1.2s 就落定）。
- ★★★ 失败**先 `saveShot` 再 `force-stop`**（放反了拍到的是模拟器桌面，等于没留证）。
- ★★ `ensureApp` 深错屏硬恢复：得物**活着但停在自己另一个页面**（实测草稿箱 `DraftActivity`）时
  `am start -n <pkg>/<launch>` **无效**（那个 Activity 已在栈里）⇒ 等一个窗口后仍不对，就先
  `am force-stop` 再启动一次（只做一次）。
- ★★ 回归断言写「设备收到的字 == 源文」时，**源文必须含一个空格**（否则抓不到 `%s` bug —— 实测盲区）。

### 「5 轮 × 3 条」实测结论（2026-10-04）
- run1~4：各 3/3 成功、Δ动态 +3、Δ草稿 0；**run5：1/3**。
- 两个卡点：① `waitId etSearch` 等不到（点「关联好物」后没进搜索页；截图显示该行**已自动挂着
  一条商品**、内容其实已就绪 ⇒ **误拦**，定位表 #19/#20）；② 提交后被**存成草稿**。
- ★ 队列**只有 3 行** ⇒ 5 轮用的是同一批内容（每轮内 3 条不同）。卡点②是否与「同内容重复发布」
  有关**未证实**（要换一批内容再测）。
- Δ动态 +2 与「1 条成功」**不符**（差 1）：存疑、未解释。
- 工具：`tools/stress5x3.js`（多轮 × 连发 N 条，`--offset` 换批次），报告落
  `<userData>/输出/得物/5x3/`。

## §BQ 「一次发布 100s」的构成（2026-10-05 真机实测时间轴，不是推算）
方法：`tools/stress5x3.js` 已给每行日志打 `[+N.Ns]` 相对时间戳，并落盘 `ctx.stepTiming`。
单条实测 **99.7s**：

| 段 | 起止 | 耗时 |
|---|---|---|
| ① 拉回首页（第 1 次） | +0.0→+13.7s | **13.7s** |
| ② 清相册（DCIM/Camera + bluev + MediaStore，含强停得物） | +13.7→+36.5s | **22.8s** |
| ③ 强停后重新拉回首页 | +36.5→+40.9s | 4.4s |
| ④ 推素材 + 确认进媒体库 | +40.9→+45.0s | 4.1s |
| ⑤ 屏幕守卫起手（清弹窗） | +45.0→+47.1s | 2.1s |
| ⑥ 24 个具名步骤 | +47.1→+97.6s | **52.6s** |
| ⑦ 判成败 + 留证 + 清草稿 | +97.6→+99.7s | 2.1s |

⇒ **起手 45.0s（45%）· 发布交互 52.6s（53%）· 收尾 2.1s。要点：真正"点发布"只占一半。**

- **清相册 22.8s 与素材无关**：`DCIM/Camera` 里有 **9 个 255 字符长的 `*_gone_<ts>` 残骸目录**（0 个文件）、
  被 MuMu sdcardfs 失效句柄锁死 ⇒ 每轮跑「原地删→强停→重删→逐项循环 ≤4 轮」，每项 5~6 次 shell 往返。
  ★ **一次 adb shell 往返 = 93ms**（本机实测，20 次均值）⇒ 150+ 次往返 ≈ 14~23s。
  ★ 相册**空着**单测 `clearMediaDir` 也要 **14.4s**。解法（代码注释记的）= 重启模拟器，**尚未实测**。
- **拉回首页 13.7s**：得物停在自己另一页时 `am start -n pkg/launchActivity` **拉不动**（Activity 已在栈里）
  ⇒ 必须等满 `hardAfterMs=min(8000,max(3000,timeout/3))=8s` 才 `force-stop`+冷启动（冷启动实测 4.7s）。
  **其中 8s 是白等** ⇒ 杠杆：认出"前台是本 App 但非首页"就**立刻**强停重启。
- **发布交互 52.6s / 24 步 ≈ 2.2s/步**：**每步一次 `uiautomator dump`**（实测 2047/2083/2463ms）。
  已有 4 步是**盲点 `tapXY`**（剪辑页下一步 / 封面跳过 / 离开相册 / 选中视频）⇒ **各 0.1s** ⇒ 差距全在"要不要抓屏"。
  ⇒ 杠杆：把已知稳定的格子也改 `tapXY`（每处都要真机验不点偏）。
- ★ `hardAfterMs` / `postPublishWaitSec`(默认 30) / `homeDwellSec`(默认 10) 都是**可配的**。
- ★★ **同一条内容会间歇性「提交发布→0.8s 落 DraftActivity」**（煤黑卫衣前 4 轮成功、第 5 次失败）⇒ 非个案、未解释。
- ★★ **两个读数异常（未解释，别当已解决）**：① Δ动态 +1 而判「失败」（run5 也出现过 +2/1 条）；
  ② 失败后日志说"已把这条草稿清掉"，但回读 **草稿 1→2** ⇒ **那句话没兑现**。
  ⇒ 「跳屏判失败」与「条数差」这次互相矛盾 ⇒ 查清前**不许**对外说"清掉了/发出去了"。


## §BR 「关联好物」段：真机结构 + 三条硬规则（2026-10-05，用户口径「货号不能不挂，不接受任何得物自动挂的」）

### 真机结构（发布页 TotalPublishProcessActivity；有 dump + 截图为证）
容器 `relevantProductContainer` 的子节点：
| id | 文字 | bounds（1080×1920） | 说明 |
|---|---|---|---|
| `tvRelevantProduct` | **永远**是「关联好物」 | [0,1054][760,1131] clk=true | 整行入口（点它 → 搜索页） |
| `tvRelevantProductRecognitionCount` | 「识别到更多可关联好物」 | [760,1054][1080,1131] | 得物自动识别入口，**不要用** |
| `rvRelevantProduct` | — | [0,1131][1080,1208] | **已挂商品卡这一行，只在挂着的时候存在** |
| `tvName` | 商品名 | [116,1144][333,1196] | 已挂商品名 |
| `ivDelete` | — | [333,1131][382,1208] clk=true | 右侧那颗 × |

★★★ **判「有没有挂商品」绝不能看「关联好物」那行文字** —— 没挂/已挂都写着「关联好物」。
唯一可靠判据 = **容器里有没有 `ivDelete`**。
实测点 `ivDelete` ⇒ `rvRelevantProduct`/`tvName`/`ivDelete` 一起消失（容器 [0,1054][1080,1236] → [0,1054][1080,1131]）；
且**没挂时 `ivDelete` 根本不在结构里**（整屏只有一个含 delete 的 id）⇒ `whenOn=ivDelete` 是安全守卫。

其他实测：
- **点整行 → 搜索页**在「没挂」和「已挂」两种状态下**都会成功**（etSearch + ivProduct 出现）；
  所以 run5 seq2 的「等不到 etSearch」**不是**「已挂商品挡路」。
- 搜索页：`智能识别`（得物识图结果的卡，最多 4 张，命名带品牌前缀如「Cabbeen卡宾 …」）＋ `已购/想要` 网格
  ⇒ `ivProduct` 在**没输入之前就已经有 10 个**（都是推荐位，不是搜索结果）。
- 输「货号+颜色」后 **600ms 结果就已就位**（实测 600ms 与 3.1s 的卡片文字**完全一致**），
  **第 1 格就是我们的商品**（卡上颜色标签「煤黑色01」= 我们的颜色）；后面跟着一串无关的鞋（PUMA/Adidas/Nike）。
- 我们的商品卡名 ≈「卡宾 云感长绒棉…男款」；得物自动挂的那条 ≈「Cabbeen卡宾 云感长绒棉…」——**名字前缀不同**，是两条不同目录项。

### 三条规则（落在 `tools/fixuimap.js` ⑧，幂等；改完 steps 38→48 / videoSteps 41→51）
1. **8a**「好物1」之前：`tapId ivDelete` + `whenOn: ivDelete`（先摘掉得物自动挂的）。
   ★ **只做一次、只挂在好物1** —— 好物2/3 时容器里躺的是**我们自己挂的**，再摘就把自己摘掉（有断言守着）。
2. **8b** 点完整行后：`wait 1500` +「没进搜索页就补点一次」(`tapId tvRelevantProduct`, `whenNotOn: etSearch`)
   + 硬等 `waitId etSearch`。
   ⇒ 正面修复 run5 seq2：得物识别结果到达时会**重建** `tvRelevantProduct`（生产日志反复出现
   「还没看到 tvRelevantProduct，等半秒再抓一次」），点空一次就再没第二次机会。
3. **8c** 每选完一格：`waitId ivDelete`（8s）= **挂上了才算过**。搜索为空/点空 ⇒ ivDelete 不出现 ⇒ 当场报错。
   ★ 绝不带着「一条都没挂」或「得物自动挂的那条」去点发布。

### 真机验证（2026-10-05 01:0x，跑 1 条）
8a 2.0s **正确跳过**（那一屏没有 ivDelete＝得物这次没自动挂）｜8b 2.1s **正确跳过**（已有 etSearch＝不重复点）
｜8c 2.2s 等到 ivDelete＝我们那条挂上了｜好物2/3 全部正确跳过并点名原因。
回归 `adbtest` **363 PASS / 0 FAIL**（新增 ㉚ 组 14 条，含「好物2/3 绝不许有 8a」与幂等）；
线上 config.json 连跑两次 fixuimap **md5 一致**。

### 发布页底部条（同一轮实测，顺手记）
`tvSaveExit`「存草稿」[14,1799][103,1915] ｜ `tvPreview`「预览」[103,1799][184,1915]
｜ **`tvPublish`「发布」[205,1815][1045,1892]**（唯一，提交发布那一步点的是它 ⇒ 没点错按钮）。

### ★★ 仍未解决：「点发布 → 0.8s 落 DraftActivity」是真的存草稿
- 截图实证：`media.activity.DraftActivity` **就是草稿箱**（标题「草稿箱」，里面躺着 23:51 那条草稿）。
  ⇒ 先前我猜的「DraftActivity 只是转场、判据误判」**已被推翻**。
- 但它**不是每次都发生**：run1~run4 共 12 条全成功（Δ草稿 0）；之后 run5 seq3 / 时间轴那条 / 两次探针 = **连续 4 次**都落草稿。
- 数字：每次这类尝试 **动态 +1 且 草稿 +1**（99/1→100/2、101/5→102/6）。
  ⇒ 「动态(全部 N) 把草稿也算进去了」与「确实发出去了但另留一份草稿」**两种解释都与数字相符**，
  **没有定论，不许猜**。要定论得单独做一次实验（涉及进草稿箱，需用户点头）。
- 个人主页读数（截图）：`动态/视频/收藏/赞过/私密` tab + 「全部 N」chip + 网格第 1 格是
  **独立的「草稿箱 / 有M篇动态待发布」卡片** ⇒ 草稿是**另算**的一格。
- 失败原因候选（**均未证实**）：得物侧风控 / 重复内容 / 发布频次 / 素材本身。用户已排除「大文件」（同素材在别的账号能发）。

### ★★ 两个「别当成漏配去修」的点（2026-10-05 复核，理由写死免得将来被改坏）

**(1) 8b 的「没进搜索页就补点一次」步 **故意不写** `whenOn: tvRelevantProduct`。**
不是漏配 —— 是因为 `publisher.js` 的 `tapId` 分支**自带 `for(attempt<3)` 重试**（每次重新抓屏、间隔 450ms，
≈1.4s 容差，见 `publisher.js:347-371`），短抖动它能自己救回来。若给这一步加 `whenOn`，
守卫会先拦一次：**只要有那么一瞬间那一行不在结构里，这一步就被整步跳过**，
反而把这个容差掐掉了 ⇒ **并不严格更优**，还会让「补点」形同虚设。
★ 残留风险（如实记）：若那一行**连续 >1.4s** 不在结构里，`tapId` 3 次后**抛错 ⇒ 整条中止**。
要根治得让引擎支持「这一步失败不算失败」或表内循环 —— 引擎**没有**这类开关
（`grep optional|tolerant|allowFail|ignoreFail|softFail` 在 publisher.js 里 0 命中）；
在没有那次真机证据之前**不许为了"看起来更稳"去加守卫**。

**(2) `tools/fixuimap.js` 的 ⑧ 规则**只落在本机 `%APPDATA%\dewu-bluev-publisher\config.json`**，
`src/main/services/uimap.js` 的「抓取页面结构」生成器**仍然只吐老的三步**（`关联好物` tapText →
`搜索货号` input → `提交发布`）。**
⇒ **隐患**：① 本机若再走一次「抓取页面结构 → 导入」，⑧ 三条规则**静默消失**（回到「只输货号」）；
② 换一台机器/新装 exe：定位表本来就「未配」，导入候选表后同样**没有** ⑧。
⇒ 现状＝**「跑一次 `node tools/fixuimap.js`」是定位表的唯一目标态出口**（这本来就是它存在的理由）。
若要让「抓出来的候选表」本身就带 ⑧（幂等对齐、杜绝回退），必须改 `uimap.js` 生成器 ⇒ **要重打 exe**；
这件事**待用户拍板**，别自己动打包链路。

## §BS 2026-10-05：合规检查的**计数口径**（文件≠任务）+「检查父目录」的静默空结果 + 强停得物的调用点地图

### §BS1 「一个文件夹 = 一个任务」是用户口径，代码现在是「按文件计」
- 现状：`compliance.js` 的 `stats` 全部按**文件行**统计（`ok/todo/manual/...` 都是 `rows.filter(...).length`），
  界面顶部那排数字（`app.js:480-489`）直接把文件数当大数字显示。
- 用户口径（2026-10-05 原话）：「**一个文件夹=一个任务，成功就1个成功，失败就1个失败，哪来的3个**」
  ⇒ 顶部应是**任务数**；一个任务内 4 张图 = 4 条明细，不参与顶部计数。
- ★ 踩过的坑：用户看到「合格 3」以为是自己那个 4 图文件夹的结果，其实是**上一批 3 个 .mp4 的旧结果**
  （`project.json.compliance.scannedAt` + 日志末行都能对出来）。**结果区不标「这批是什么/什么时候扫的」是祸根**。

### §BS2 「检查父目录」只认子文件夹 ⇒ 选中「图直接躺在里面」的目录会**静默返回 0**
- `compliance.js:315 scanParent`：`dirs = ents.filter(e => e.isDirectory() && !isJunk(e.name, true))`
  ⇒ **父目录里直接躺着的素材文件一张都不看**；没有子文件夹就返回 `0 个子文件夹 · 0 个文件`。
- 实测：用户选 `Desktop\S26393005+咖色`（4 张 jpg 直接在里面）⇒ 日志 `父目录检查完成: 0 个子文件夹 · 0 个文件`。
- ★ 更坑的是它**不报错、也不清空结果区** ⇒ 旧结果继续显示，看起来像"这次扫出来的"。
- 修法（未做）：① 无子文件夹但本目录直接有素材 ⇒ 把**本目录本身当一条任务**；② 有子文件夹时若还有散落素材，
  日志明说「另有 N 个散落文件未纳入」；③ 结果区永远标「本次扫描的目录 + 时间 + 文件数」。

### §BS3 结果区**只在有非 ok 行时**才渲染明细表
- `app.js:477` `rows.filter(r => r.status !== 'ok').slice(0, 60)`；`497-503` 只有 rows 非空才画表，
  否则只写一句「全部 N 个文件都合规」⇒ **全合格时用户看不到任何文件名**（用户原话：「压根没显示哪张图片需要修复」）。

### §BS4 「强停得物」的**全部**调用点（穷举 `grep -rn "forceStop(" src/`）
| 位置 | 触发条件 | 目的 |
|---|---|---|
| `publisher.js:994` | **只在判失败**：点完「提交发布」却没离开发布流程（含落在 `DraftActivity` 草稿箱） | 清掉得物侧边「未完成的动态」，否则它躺在草稿箱、下一条会弹「是否继续编辑」顶偏流程（用户已踩过）★ 先 `saveShot` 留证、再强停 |
| `adb.clearMediaDir` / `clearAlbum` 的 `forceStopPkg` | 清相册**删不掉**时（得物停在发布/相册页、攥着 mp4 的硬解码句柄 ⇒ `rm -rf` 报 `Text file busy`） | 腾出文件句柄；`am force-stop` 后同一句 rm 立刻成功（真机同秒对照） |
- ★ 强停后**必须 `pullHome` 重新拉起并确认回首页**（`publisher.js:836-840`），否则后面全是点空气。
- ★★ **发布成功路径不会强停得物**（成功只做 `homeDwellSec` 主页停留 10s，`publisher.js:1019-1023`）。
  用户观感里的「发完就大退得物」= **下一条起手的清相册**。
  ★ `1a6d27a`（1.0.13）已收窄：`find <dir> -type f` 数出来 0 个文件 ⇒ **直接放行、不强停**（只剩空目录残骸时）。

## §BT 2026-10-05：图片合规的两道「尺寸/体积」关卡 + 探针必须隔离用户 config

### §BT1 尺寸：**只卡下限**（用户口径，已落地 `528bb81`）
- 用户原话：「超尺寸的图片没必要做等比缩放，只要不要低于下限就不用处理尺寸问题，除非后面我提示」。
- 代码：`compliance.js` 图片分支拆两段 —— 下限 `minSide`(150) 仍是硬拦（判「需更换图片」manual）；
  上限归 `RULES.enforceMaxSide`（**默认 false** ⇒ 不判）⇒ 不再产生「等比缩放」行。
  `store.js` 默认键 `enforceMaxSide: false`；置 true 即恢复老行为（`maxSide` / `autoScale` /
  `fix()` 的缩放分支都还在，没删）。
- ★ 旧口径错误（已修）：边长**低于下限**以前与超上限共用同一分支、被标成「等比缩放」，
  可 `imaging.fitWithin` **只缩不放** ⇒ 假话。现低于下限一律「需更换图片」。
- 界面：`app.js` 规格文案与「等比缩放」统计格都按开关渲染（关掉时那格恒 0 ⇒ 藏起来）。
- 自证：`compliancetest` 新增 ①b 组 4 条（含**反向对照**：打开开关必须变回「等比缩放/todo」）；
  `smoke` ② 两条；`run-all` 十七套 **1528 项全绿**。
  ★ 反向验证实测：破坏「下限判据」⇒ ct 红 3 / smoke 红 0（smoke 对这条不敏感，别当它能守）；
  破坏「下限分支的 action」⇒ ct 红 3 / smoke 红 2。

### §BT2 体积：`maxImageMB`（默认 10MB）是**下一道**关卡，**设置页里没有这个旋钮**
- 真机对照（用户那 4 张 3213×4284 / 2538×4511 / 2876×5113，只读扫描）：
  · 老行为 ⇒ `todo` ×4「边长超 1500 → 等比缩放」
  · 新行为 ⇒ `todo` ×4「**12.3 / 11.8 / 10.2 / 12.6 MB，超 10MB → 压缩**」
- 用户说「这组素材我没处理，但实际能发布」⇒ 得物收得下 >10MB 的原图。
- ★ 2026-10-05 04:0x **用户拍板「一起放开」** ⇒ 已落地（提交 `6b77a77`）：判据 `RULES.enforceMaxMB && size > maxBytes`，
  `enforceMaxMB` 默认 false（与 `enforceMaxSide` 对称）。`maxImageMB` 与压缩分支都留着，置 true 即恢复。
  界面「超 XMB 压缩」格与规则文案按开关渲染（数字改读 `cfg0.maxImageMB`，不再写死 10）。
  实测（隔离只读扫描用户那 4 张）：老行为 `todo×4` → 现在 **`ok=4 / todo=0`**。
  双向断言在 `compliancetest` ①b（把 maxImageMB 压到 524 字节仍判合格 + 打开开关必须变回「压缩/todo」）。

### §BT3 ★ 探针**绝不许**直接指向用户真实 userData 里的 config
- `store.set()` 内部 `scheduleSave()` ⇒ **250ms 后把整个内存 cache（= 全部 defaults + 文件内容）
  写回 `config.json`**。探针里一旦 `store.set`，就可能把一堆默认键固化进用户配置。
- 正确姿势：**把用户 `config.json` 复制到临时目录**，fake electron 的 `app.getPath('userData')`
  指向那个临时目录 ⇒ 只读语义成立、零风险（跑完 `fs.rmSync` 删掉）。
- 首版探针靠「脚本活得比 250ms 短」侥幸没写 —— **不许再赌**；每次都要复核用户 config 的 mtime 未变。

## §BU 2026-10-05：发版包内核验工具 `tools/verifypack.js` + 「好物规则被 App 回写覆盖」的正确做法

### §BU1 包内核验一律走 `node tools/verifypack.js`（别再临时写脚本）
```bash
node tools/verifypack.js --version 1.0.14 \
  --res <win-unpacked/resources> \
  --need "src/main/services/compliance.js=enforceMaxMB" \
  --absent "src/renderer/app.js=超 10MB 压缩"
```
- 固定检查：asar **解包**非空（文件数/体积）、版本**三处一致**（源码 / asar 内 / 产物文件名）、
  6 个关键源码文件存在、三个内置二进制（adb / ffmpeg / adbkeyboard）随包。有 FAIL ⇒ 退出码 1。
- ★★ 三条坑（都是实测踩出来的，写进脚本文件头了）：
  1. `@electron/asar` 的 `listPackage` 路径**带前导反斜杠**（`\package.json`）；
     `extractFile` / `statFile` 传「原始串」或「正斜杠串」**都可能 not found**（实测两种都失败）
     ⇒ 一律 **`extractAll` 到临时目录**再当普通目录读。
  2. 内置二进制由 `build.extraResources` 放在 **asar 外面**的 `resources/<name>/` ⇒ 查 asar 内部会**误报「没随包」**。
  3. 版本号必须三处一致；只查 asar 内那份会漏掉「源码忘了 bump」或「dist 里还是旧 exe」
     （实测：`dist/win-unpacked/resources/app.asar` 里还是 1.0.13 ⇒ 核验脚本差点把旧包当新包验过）。

### §BU2 ★★ 好物三条规则会**被运行中的 App 回写覆盖** —— 打补丁必须在 App 关闭状态做
- 实测（2026-10-05）：`tools/fixuimap.js` 修好并验证过的 `publish.uiMap` **steps 48 / videoSteps 51**，
  后来在 `config.json` 里变回 **38 / 41**；同一文件的 `compliance` 键未变（排除是我的探针写的），
  mtime 落在用户开着 App 的时间窗内 ⇒ **App 内存里的旧 uimap 被某次保存写回**。
- 规则：**`fixuimap.js` 只能在「App 全部关掉」时跑**；跑完立刻复核 `steps/videoSteps` 数字。
  装新版/换 asar 也要在 App 关闭状态下做（同 §Q 的「动数据前确认无实例在跑」）。
- 根治（待办 #50，未做）：把 ⑧ 做成 **App 启动时自愈**（借 `store.load` 的 migrate 机制，缺这三步就补），
  这样补丁在 App 自己进程里做、**不会被自己覆盖**，且随包分发、换机器也在。

---

## §BV 功能全景可视化文档（`docs/visual/`）—— 数字必须"读出来的"，口径才写"写死的"

**是什么**：`D:\work\dewu-bluev-publisher\docs\visual\build.js`，零依赖纯 Node。
`node docs/visual/build.js` → `index.html`（单文件、离线可看）+ `data.json`（机器可读快照）。
`--snapshot <run-all 输出.txt>` 复用已实测的回归数字（不重跑）；`--save-record` 落 `regression.json`；
`--out <dir>` 改输出目录。

### 两层数据，别混
- **自动读（不许手写）**：版本号、页签（`index.html` 导航）、IPC 通道与门禁档位（`ipc.js`）、
  源码文件数/行数、`tools/*test.js` 套件清单、git 版本线、`vendor/` 二进制体积。
- **人工维护（写在 build.js 顶部的常量里）**：六段流水线、每页功能要点、红线约束、发布通道对照表。
  ⇒ 这些要与 README/AGENTS.md 同步；`checkDrift()` 会在源码与口径对不上时往 stderr 打 `⚠️` 警告。

### ★★ 版本线：**只认 `package.json` 的 `version` 变更史**，死也不要按提交说明猜
```bash
git log -p --format=$'\x01%h\t%ad\t%s' --date=short -- package.json
# 取每个 hunk 里  ^\+\s*"version":\s*"([^"]+)"   的新值
```
谁把版本号改成它，**那一次提交**就是该版本的落地点。
- 实测（2026-10-05）"按提交说明开头形状打分"的老办法：**漏 4 个、错 1 个** ——
  `1.0.12`（说明是 `fix(发布): …`，通篇没版本号）、`1.0.2`（版本号在**句尾括号**里）、
  `1.0.0` / `1.0.1-beta.1` / `-beta.2`（说明里根本没版本号）；`v1.0.4` 挂到了错误的提交
  （真身 `86d095d`，不是标题写着"发 v1.0.4"的 `94ed453`）。
- 反向也错：`docs: 同步 v1.0.2 口径…` 这种**补档**会被当成"发布"。
⇒ 结论：**"提交说明里出现过版本号"既不充分也不必要**。凡是能从**产物自身**读的，就别从"人写的说明"里猜。
- 排序用 semver 比较（正式版 > 预览版；`1.0.1-beta.2` 要排在 `1.0.1` 前面），
  别用 `split('.').map(Number)`（`beta` → `NaN`，比较失效）。
- 兜底：浅克隆读不到 diff 时退回老办法，并把 `timelineSrc` 标成 `subject-heuristic`，
  文档上明写"⚠ 本次退回启发式，可能不准"——**宁可标出来，不许假装准**。

### ★ 三个已踩的坑
1. **IPC 计数少 2 条**：`/ipcMain\.(handle|on)\(\s*'([^']+)'\s*,\s*([\s\S]{0,40})/g`
   的 `[\s\S]{0,40}` 会**跨过逗号吃到下一条通道**，导致结果被"吃掉"。实测真值 **53**（不是 51）。
   校验法：另跑一条 `/ipcMain\.(handle|on)\(\s*'([^']+)'/g` 做**简单匹配**，两套结果必须等长。
2. **`dirty` 自指**：`git status --porcelain` 会把"刚生成的 `docs/visual/*` 相对 HEAD 已修改"算进去
   ⇒ 永远显示"工作区有 1 个未提交改动"，而那 1 个就是文档自己。
   **按 `docs/visual/` 过滤**，并把过滤掉的条数单独说明。
3. **`HEAD` 永远早一代**：提交文档本身会改哈希，无限回归 ⇒ 无解，只能**标明"生成时"**，
   别让读者把快照当实时值。

### 排版（1240px 容器）
- KPI 用 `grid-template-columns:repeat(auto-fit,minmax(172px,1fr))`：
  **`190px` 时 1240px 容器只能排 5 张**，6 张会单独换行掉一颗，很难看。
- 版本线列宽 `.tli{grid-template-columns:124px 92px 1fr}`：`96px` 会把 `v1.0.1-beta.2` 从词中间折断。

### 验收（别只看源码）
无头 Chrome：`--headless=new --dump-dom` 查 8 个区块 id 齐不齐 + **stderr 必须 0 字节**（无 JS 报错）。
想量整页高度/分段截图：往 `</body>` 前注入 `document.documentElement.scrollHeight` 到 `data-page-h`，
再给 `body` 加负 `margin-top` 分段截（headless 不能滚动）。

## §BW 2026-10-05：运行日志「两级」（界面只看大结论）

**需求**：自己代码里可以细，给用户只给大结论（`文案生成成功【目标x条，成功x条，失败x条】`、`发布成功【目标x条，成功x条，失败x条】`）；左侧日志模块不显示条数。

**机制**（`src/main/logbus.js` / `src/main/jobs.js`）：

| 通道 | 落点 | 默认归属 |
|---|---|---|
| `logbus.push(level,msg,meta,opts)` | 内存 `history` + 事件 + 窗口 | **大结论**（`opts.tier!=='detail'`）——老调用点零改动即保持可见 |
| `logbus.tierOf(level,opts)`（纯函数） | 判定这一条进不进界面 | **明细**——`ctx.log` 是流水通道，漏标症状是刷屏 |

两条例外**必须**留给用户：`level === 'error'`（真出错不许藏）、`opts.ui === true`。
⇒ `jobs.js`：`ctx.log` = 一律沉底；新增 **`ctx.conclude`** = 唯一会出现在用户眼前的任务日志通道。
★ 两个默认值**刻意相反**：漏标 `push` 的症状是「多显示一条」，漏标 `ctx.log` 的症状是「刷屏」。改默认值前先想清是哪一种。

**明细三重保留**（不是丢掉）：① `state.logs`（任务行「查看详情」按 batch 回看）；② `run-log.jsonl` 台账；③ 导出文件头 `过程明细：另有 N 条`（`logexport.formatText`，`meta.bufferDetail>0` 时才加）。

**大结论清单**：`flatten.run` 素材整理完成【…】／`compliance.scan|scanParent|fix` 合规检查/处理完成【…】／`verify.check` 货号颜色校验完成【…会被拦下不发 c】／`copy.generate` 文案生成成功【目标 N 条，成功 K 条，失败 F 条】／`publish.run|rerun` 发布成功/结束（有失败）/重跑成功。
★ **模拟通道不许冒充真发布**：写「模拟发布完成【目标 N 条，模拟成功 K 条，失败 0 条】」+ 明说「不算真发布」。
★ `publisher.js`/`copywriter.js` 顶部 `const conclude = ctx.conclude || log;` ⇒ 工具干跑（无 conclude）时退回老行为、不抛。

**界面**：`renderer/app.js` 加 `isDetailLog(e)`/`uiLogs()`；底部日志栏、角标、`logExportPayload`、`TABS[10].actions`、`'log:clear'` 全走 `uiLogs()`。
★★ **`batchDetailHtml()` 刻意不过滤明细** —— 任务行「查看详情」要看的正是过程明细；顺手过滤掉会把它废掉。
★ 侧栏「运行日志」按钮的角标 `<span class="st" data-st="10">` 已删（按用户要求不显示条数），`index.html` 里留注释「不要加回来」。

**验证**：`tools/logtest.js` I/J/K 段 + `tools/uicheck.js` 三条断言；7 条定点破坏逐条红 + 逐文件 md5 还原；**全量回归 17 套 1558 项全绿**。
坑：① uicheck 的源码锚点会被别人加的注释推超窗口 ⇒ 判据改成**剥整行注释（`codeOnly`）+ 放大窗口**（判「有没有调用同一函数」，不是「隔多少字符」）；② CRLF 工作区里跨行锚点必须先 `\r\n` 转换，否则匹配 0 次；③ 需要 `await` 的测试段包 async IIFE（CommonJS 顶层 await = `ERR_AMBIGUOUS_MODULE_SYNTAX`）。

## §BX 2026-10-05：**得物相册格子顺序 = MediaStore `date_modified` 倒序**（主图问题的定论）

**用户原问**：图片倒序上传，得物以第一张作内容主图；「我命名什么能排到文件夹最后一位，让你上传时排到第一张？」（明确：视频不参与）

**定论：改名字没用。** 相册格子顺序只认**库里缓存的 `date_modified`**，**倒序**（最新 → 第 1 格）；**文件名无关、推送/入库顺序（`date_added`）无关**。

**判定实验（可复用，MuMu 12 / 1080×1920 / `127.0.0.1:16384`）**：造 4 张纯色图，让三个键**互相矛盾**——文件名 `a_red<b_green<c_blue<d_yellow`；推送顺序 `d→c→b→a`（`date_added` 递增）；文件时间 `b 最新 > c > a > d`。

| 实验 | 实测相册顺序 | 结论 |
|---|---|---|
| 推 → `touch` → `scan_file` | **绿 → 蓝 → 红 → 黄** | 与 **mtime 倒序**一致，与文件名/推送顺序都不符 |
| **只改 mtime、不重扫** | 绿→蓝→红→黄（**不变**） | App **不实时读文件系统**，读库缓存 |
| 改成 `黄12:40>红12:35>绿12:30>蓝12:05` 后**重扫** | **黄 → 红 → 绿 → 蓝** | 闭环：顺序跟着 `date_modified` 变（`date_added` 全程未变） |

**两条硬约束（反了就不生效）**：
1. **`touch` 必须在 `scan_file` 之前**（先入库再改时间 = 界面无反应）。
2. **别改本地文件/副本的 mtime**：同盘建副本走**硬链接**（`winpath.linkOrCopy`；实测真机叶子链接数 **4**），改它会连**原图**一起改（同一 inode）⇒ 必须在**设备端** `touch`。

**顺带实测**：`adb push` **保留源文件 mtime**（本地 `2020-01-02 03:04:05` 推上去一模一样）；`date_modified` **秒级** ⇒ 相邻时间档至少隔 1 秒。

**现状链（逐环节可指）**：`flatten.js:155 readdirSafe 原样` → `flatten.run` `files[].name` 无排序 → `publisher.js:718 media=item.files.filter(image)` → `:849 for..of media adb.push` → `:851` 远端名 `replace(/[^\w.\-+]/g,'_')`（**中文全变下划线**：`微信图片_2026-10-05_031044_123.jpg` → `_____2026-10-05_031044_123.jpg`，实测）→ `:854 mediaScan`。
定位表 `steps[8]` `tapId flThumbSelect, count=${imageCount}` = 点**最前面 N 格** ⇒ **当前主图 = mtime 最新 = 最后导出那张**（与用户「倒序」观察吻合）。

**方案（推荐 A）**：叶内图片按**自然序**（`naturalCompare`，数字按数值比）排序，App 把**第 1 张的设备端时间设成最新**（往后每档递减 ≥1s；基准取「现在 − i 秒」，保证比任何残留素材新）⇒ 相册第 1 格 = 文件名第一个 = 主图；**换主图 = 把名字改成排最前**。
落地位置：`publisher.js` push 循环之后、`mediaScan` 之前加一步按目标顺序 touch 时间。
备选 B：名字带 `主图`/`封面`/`cover`/`0-` 的那张设最新（封面可与内容顺序解耦）；备选 C：不改（主图 = 最新导出那张）。

**未复验（必须如实标）**：① 「第一格 = 内容主图」是**用户口径** + 定位表 hint，复验要真发一条帖；② 「点前 N 格能选满」未验 —— 相册是 **5 列**网格，叶子图片数超过首屏格数时 `count=${imageCount}` 可能**静默少选**（建议加「下一步按钮上的 (N) == imageCount」校验）；③ 相册那一屏 **`uiautomator dump` 常失败**（本轮连续 4 次没出来），选图步用 `tapId` 有风险，视频那套已用盲点坐标 `(166,359)` 绕开。

**交付**：`主图顺序-方案-20261005.md`（含截图 `_ordertest/album*.png`）；技能 `android-album-media-store` 增「格子排序由什么决定」整节。

★★ **用户对方案的直接回应（2026-10-05，必须记）**：「**我自己咋可能改图片的时间？**」
⇒ ① 用户**不接受任何需要他手工改文件时间**的方案 —— 方案里「改时间」必须**由程序做**（推送后、`mediaScan` 前那一步设备端 `touch`），
对用户只暴露「**命名**」这一个入口（命名 = 输入，翻译成时间 = 代码的活）；方案文字里**不许出现让用户自己动手调整时间**的表述。
② 用户同轮只要求「提交你的代码」⇒ 主图这一项**仍是待办**（等他定命名约定 / 选 A·B·C 哪条再改代码）。

★★ **第二次回应（同日晚些）**：「我有 1000 张图片，怎么可能让你挑出哪些去当主图？**放几个我这边能操作的方案**，
不然老是放一些人物的**背面图**在主图上。」
⇒ ① 用户**明确排除**「逐张人工指定」；要的是「**批量规则 + 少量操作**」形态的选项菜单。
② **逐张看图取证**（`Read` 直接看 `C:/Users/Administrator/Desktop/1005` 的真实素材）：
`S26408002+黑色`(4 张) 第1张=正面全身露脸 / 最后=**背面侧转**；`D26187013+蓝色`(6 张) 第1张=正面侧身 / 最后=**纯背面**；
`S26393005+咖色`(4 张) 第1张=侧脸正面坐姿 / 最后=侧面站姿（将就）。
⇒ **复现用户抱怨**（相册取「最后拍的那张」，而用户拍法 = 正面先·背面后）；反过来「取第 1 张」这批 **3/3 合格**。
③ 文件名即拍摄时间（`微信图片_2026-10-05_031044_123.jpg` = 03:10:44），与 mtime 同序、与叶子内顺序一致。
④ ★ **用实测数字否掉一个方案**：按「文件大小/分辨率/竖构图」自动挑 —— 正背面体积几乎一样
（5.1 vs 6.0MB、12.9 vs 13.2MB），**区分不出来**；项目也**没有人脸检测**。
⑤ 四类**可用**策略（顺序 = 用户要花的力气）：位置规则（第 1 张，零操作）→ 命名覆盖（只给出问题的叶子改 1 张）
→ 模型挑（零操作、按叶子数计费、须先检测图片输入能力）→ 发布前肉眼核验（看一眼）。
⑥ 交付 `主图怎么定-4个方案-20261005.md`；证据图 `_mainimg/主图对照-第1张vs最后一张.png`（ffmpeg xstack 2×3，绿框=第1张／红框=最后一张）。
⑦ 落地位置仍是 `publisher.js` push 循环之后、`mediaScan` 之前；**代码未动**，等用户回答「正面是否基本在最前」+「主图标记词」。

★★★ **已落地（2026-10-05，提交 `5a4aea0`）** —— 用户拍板：「**标记用数字1吧**」（并说明「发的时候都是主图是正面」）。

- 新模块 `src/main/services/mainimg.js`（纯逻辑、不碰设备，可直接喂输入单测）：
  · `MAIN_MARK = /^1(?![0-9])/` ⇒ **名字以 `1` 开头**即主图标记；`10/12/100`（数字编号）**不算**；**只认开头**（`微信图片_1.jpg` 不算）。
  · 没标记 ⇒ 取**图片清单第 1 张**（= 目录里排最前那张；素材名带拍摄时间 ⇒ 最早拍的那张）。依据：真实素材 3 个叶子实测「第 1 张」3/3 合格，而改前行为（最后一张）2/3 是背面图。
  · 多张都带标记 ⇒ 取最前那张 + `why='marker-many'`（要提醒用户，但不因此不发）。
  · ★ 兼容性实测：写 `01_…` **不会被认成标记**，但它名字本来就排最前 ⇒ 默认规则同样选中它，**结果一致**（用户素材前缀是 `微信图片_…`）。
- `adb.makeNewest(serial, target, others)`：`stat -c %Y` 读**全组**时间 → `touch -d @<组内最大+2>` → **回读文件系统**确认；读不全/回读不符 ⇒ `ok:false`（**不假装**）。用「组内最大 +2s」而非 `now`：不依赖主机与设备时钟一致，且天然满足「秒级、至少隔 1 秒」。
- `adb.mediaNewest(serial, remotes)`：`content query … --projection _data:date_modified` 回读，判哪个最新；查不到 ⇒ `ok:false`。**这是独立于 `touch` 那条代码路径的一次复查**（得物读的就是库里的值）。
- `publisher.js`（push 全部完成后、进相册之前）：挑主图 → `makeNewest` → `mediaScan`（**重扫那一张**）→ `mediaNewest` 复查；**回读最新 ≠ 要当主图的那张 ⇒ 这一条不发**（抛错）。**视频不参与**。
- 界面：模拟器发布页加一段说明（默认第 1 张 / 名字以 `1` 开头 ⇒ 排到相册第 1 格 / 排不成不发）—— 这是用户唯一能控制主图的入口，界面上找不到就等于功能没做。

**自证（可复算）**：`tools/fakeadb/adb.js` 把「设备上的文件时间」与「进库那一刻抄下的 `date_modified`」**分成两套**（真机就是两套；不分则整条因果链在回归里等于没测 = 典型假绿）+ 新增 `stat`/`touch` 两条原语；`tools/adbtest.js` +168 行（㉜ 共 18 条，判据是**设备上的事实**而非"发过 touch 命令"）；`tools/uicheck.js` +16 行（读真 DOM 的 `innerText`）；定点破坏 D1~D7 逐条红；全量回归 **17 套 1598 项全绿**（提交版单独跑同样全绿）。

**两条自己踩的坑（已写进技能 `bilateral-fix-verification` §3.4b）**：
① **破坏脚本的期望会写宽** ⇒ D7 把「排不成⇒失败」也算"该红"，实测不红 —— 它由「推图后的**进库确认**」那条独立防线满足（`SCAN_FAIL` 让所有 scan 都失效，主图闸门轮不到），查的不是主图；
② **只做「夹具放水」而不改产品 ⇒ 红 0 条**，设计本身就错 ⇒ 重做成**反向对照**：同一跑同时打「产品改坏（不重扫）」+「夹具只有一套时间」⇒ 三条事实类断言**全绿**；而夹具没放水时（D4）其中两条是红的 ⇒ 证明这几条断言的分辨力**正是**来自夹具把两套时间分开。

## §BY 2026-10-05：**货号颜色校验（页签 4）对非管理员隐藏**

**用户要求**：货号颜色检验功能对除了管理员的用户隐藏。

**结论：复用既有机制（`syncAdminNav()`），不另造一套。两条线必须一起标，少一条就漏。**

| 位置 | 改动 | 少一条会怎样 |
|---|---|---|
| `src/renderer/index.html` | 页签 4 的按钮加 `data-admin="1"` | `syncAdminNav()` 查的是 `.nav[data-admin]` ⇒ 按钮照样露在左侧 |
| `src/renderer/app.js` | `TABS[4]` 加 `admin: true` | 按钮收起了，但 `Ctrl+4` / 老配置里存过的 `tab=4` **照样能进** |

两条线在 `renderAll()` 开头的 `syncAdminNav()` 收口：① `el.hidden = true`；
② 当前 `state.tab` 若落在自己看不到的页签上 → 兜回第 1 页。
键盘那条路（`Ctrl+4`）**不用单独写** —— `keydown` 改完 `state.tab` 就走 `renderAll()`。
★ `canAdmin()` 的口径是 `!auth.requireLogin || auth.isAdmin` ⇒ **免登录 / 开发模式算有权限**，
所以 uicheck（跑在 `BLUEV_NO_LOGIN=1` 下）看不到「非管理员」那一支 ——
必须在渲染层把 `state.auth` 换成普通成员再 `renderAll()`（探针已实测可行）。

**只隐藏入口，不动功能**：`services/verify.js`、商品池、发布端取色口径**一个字节都没动**，
判定口径仍是「只有『多色漏填』会拦住发布」。
★ **边界（不许让界面骗人）**：这次是**界面隐藏**，主进程 `job:run` 仍是 `guard`（需登录）而**不是** `guardAdmin`；
校验只读比对、不写别人的数据，本轮按用户要求只做隐藏 —— 要硬拦得另加 `guardAdmin`（**尚未做**）。

**配套改的文字**（界面文字得跟界面上真有的东西对得上）：
- `TABS[4].desc` 末尾加「（仅管理员可见）」；
- `TABS[6]`（模拟器发布）里那句「要精确到某个颜色，就到『货号颜色校验』页把颜色核对准」，
  对非管理员改口成「请联系管理员核对颜色校验（这一页只对管理员开放）」—— 用 `canAdmin()` 分两支。

**自证（可复算）**

| 项 | 实测值 |
|---|---|
| 全量回归 | `node tools/run-all.js` ⇒ **17 套 1571 项全绿**（`uicheck` 218 · `logintest` 104） |
| 新增断言 | `uicheck` **+10**（非管理员 3 条 + 管理员对照 1 + 还原 1 + 「高级设置同刻也收起」1 + 源码级 2 + 机制自证 1 + 非管理员 `canAdmin()` 1）；`logintest` **+3**（把原「高级设置只给管理员」扩成 **`for (const t of ['11','4'])` 同一个循环**，顺带防「只补了 HTML、忘了 `TABS[n].admin`」） |
| 定点破坏 | 工具 `_rv-隐藏页签4.js`（放 workspace 根，**不进仓库**）。**三组全部与事先预测一致**：B1 拆 HTML 的 `data-admin` ⇒ uicheck 红 3 / logintest 红 1；B2 拆 `TABS[4].admin` ⇒ uicheck 红 3 / logintest 红 1；B3 两条一起拆（＝改动前）⇒ uicheck 红 6 / logintest 红 2 |
| 还原 | `Buffer.equals` **逐字节**一致 · `*.prebreak` 无残留 · 全程**没碰 `git checkout`** |

★ **两条要记住的判据**：
1. **B1 只红它自己那一条、B2 只红它自己那一条** ⇒ 恰好证明「两条防线互相独立」：
   只拆 DOM 那条，「兜回第 1 页 / `Ctrl+4`」仍是绿的（因为 `TABS[4].admin` 还在拦）；
   只拆 `TABS` 那条，「按钮 hidden」仍是绿的（因为 HTML 的 `data-admin` 还在）。
   **只验一条 = 分不清是哪一条在起作用。**
2. `logintest` 里「硬点第 4 个页签」这条**只在 B2 / B3 才红** —— B1 时点了会被兜回（标题＝素材整理），
   断言照样绿。⇒ 测「硬点进不去」必须**同时**测「按钮可见性」，否则两种坏法互相掩护。

★★ **本轮撞上的两个真风险（留档）**：
1. `git status` 里 `src/main/{jobs,logbus,logexport}.js`、`src/main/services/{copywriter,publisher}.js`、
   `tools/logtest.js`、以及 `index.html` 的「运行日志角标撤除」**都不是本轮的改动**（另一路/上一轮的活）。
   ⇒ 定点破坏的 `restore` **绝不能用 `git checkout -- <file>`**（会把未提交的在制品整片抹回 HEAD，且无备份可救）；
   本轮全程「跑前备份**字节** + `fs.writeFileSync` 原样写回 + `Buffer.equals` 核对」。
2. 破坏脚本把 `const base` 声明在 `try` 里、`finally` 里又读它 ⇒ `ReferenceError` 崩在**收尾汇总**那一步
   （那次伤不到源码，但整张汇总表没打出来，证据文件缺最关键的一段）
   ⇒ **汇总要用的变量必须声明在 `try` 外面**；`finally` 里只许做「还原 + 打印已有结果」。


## §BZ 2026-10-05：**线上定位表被 App 回写** ＋「抓取 → 导入」整条路是断的（**已修 `ccc6b9f`**）

### 一、线上定位表对齐（**已执行**，用户当场拍板「全量补」）
- 现象：`config.json` 好物段被**运行中 App 回写** ⇒ `steps` 38（应 48）/ `videoSteps` 41（应 51）；
  `ivDelete`（＝好物「挂上了」的**唯一**判据）**四个位置全缺** ⇒ 用户最不接受的「没挂上却记成功」在线上真会发生。
- ★★ 手法（**值得复用**）：**先探针、后动真配置**
  1. 复制 config 到临时目录、`BLUEV_CFG_DIR` 指过去跑 `tools/fixuimap.js`；
  2. 自写脚本做**按步骤名的 LCS 结构化对比**。
     ★ 按**索引** diff 会报 **216 处假改动**（插入导致后面整体后移）；按名字 LCS 才看出「**纯新增 20 行、零删除、零字段改写**」。
  3. 探针还确认了 `uiMap` 之外**零改动**、**幂等**（连跑两次逐字节一致）⇒ 才敢对真配置执行。
- 执行：确认**无 electron 进程**后（好物补丁只能在 App 关闭时打，否则内存旧值回写）跑 `node tools/fixuimap.js`
  ⇒ `38→48`、`41→51`、改动 14 处；独立备份 `config.json.bak-before-uimap-20261005-150541`（md5 `29cfdf09e69fceaf07c517e4227e7cfc`）。
- 复核：步数/判据全对；结构化 diff 确认就那 20 行；设备上的探针文件与临时目录已清（脚本留工作区 `_uimap-probe/`）。

### 二、成本实测（回答用户「为什么 20 步 / 多花多少时间」）
- 20 步 = **两张表各 10 行**（`steps` + `videoSteps`，同一套规则写两遍）；每表 10 行 = 3 货号 × 3 步 ＋ 1 步（摘掉得物自动挂的）。
- ★★ **一条内容只跑「挂了货号」那几步**：`when: goodsNSku` 是**数据守卫**，在抓屏**之前**判
  （`publisher.js:990` 的 `uimap.condOk`，`continue` 掉，**一次 dump 都不发**）⇒ 没填货号 **0 秒**。
  ⇒ 「表长了 20 行」≠「每条多跑 20 步」。
- 实测（都是量的，不是估的）：

  | 项 | 值 | 来源 |
  |---|---|---|
  | 一次抓屏 | **2.16s** | 真得物屏打 4 次：2121 / 2195 / 2184 / 2129 ms（70KB，全成功） |
  | 一次点击 | 0.13s | `adb shell` 往返实测 134 / 129 / 139 ms |
  | 一条视频整条 | **62.9s** | 台账 jobId `jmuto0wja2o8x`（10/4 18:15） |
  | 其中好物段 | 10.8s | 同上：点关联好物 2.7 + 等搜索页 2.9 + 点搜索框 2.1 + 选结果 3.1 |

- ⇒ 挂 3 货号 **净增 ≈ +18s/条**（63→81s，+29%）；1 货号 ≈ +8s；0 货号 +0。
  其中 6.6s 是「点空补点」的**兜底保险**（顺利时纯白抓一次屏）；砍掉它（连同转场）⇒ +9s/条。
- ★ `run-log.jsonl` 里**本来就有逐步实测耗时**（`publisher.js` 的 `ctx.stepTiming`，≥1.5s 才写一行）
  ⇒ 以后问「某步到底多慢」**直接查台账**，不用估。脚本：`_uimap-probe/timings.js`。

### 三、★★★ **独立的线上缺陷**：「抓取页面结构 → 导入」整条路是断的（**已修，提交 `ccc6b9f`**）
- 判据：`uimap.normalizeScreenCond` 的正则 `/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/` **不允许 `:`**：

  | 值 | 正则结果 | 说明 |
  |---|---|---|
  | `com.shizhuang.duapp:id/tvCancel` | **拒绝** | 这是 dump 里的**真格式**（`parseNodes` 取的 `resource-id`） |
  | `com.shizhuang.duapp/tvCancel` | **通过** | 根本不是 resource-id |
  | `tvCancel` | 拒绝 | 裸 id |
  | `草稿箱` | 拒绝 | 文字（这条是**有意**拦的，`adbtest` ㉑ 测的就是它） |

- 运行时判据是 `screenCondOk` 的 `n.id === id`，而 `n.id` 就是 `resource-id` ⇒ **合法值 100% 被拒**。
- 端到端复刻（真机 dump → `uimap.suggest()` → `normalizeSteps`，等同 `publish.importMap` 的第一步）：
  **21 份 dump → 可导入 0 份 / 失败 21 份**（`suggest()` 在 **317/318**（草稿箱）、**330/331**（点「放弃」）、
  **364~367**（视频侧）**无条件**挂两条守卫步）。
- 为什么一直没暴露：
  1. 测试只覆盖「写**文字**要报错」；**没有一条**覆盖「合法 resource-id 必须能导入」⇒ **单向断言**。
  2. 用户现存候选表 `uiMap-2026100{2,3}-*.json` 都是**加守卫之前**抓的（守卫 0 条）⇒ 当时确实能导入。
#### 修法（**已落地 `ccc6b9f`**，2 文件 ＋59/−2）
- `src/main/services/uimap.js`：正则改为 `^[A-Za-z0-9_.]+:[A-Za-z0-9_.]+/[A-Za-z0-9_.]+$`（要求真格式 `pkg:type/name`），
  报错文案补「必须带 `:id/` —— 少了冒号就不是 resource-id，运行时永远匹配不上」。
- `tools/adbtest.js`：**新增 ㉑c 三条**（原缺陷正是缺正向）——
  ① **正向**：合法 resource-id 必须能导入 ② **负向**：裸 id / 少 `:id/` 的假格式 / 文字 三种仍要当场报错
  ③ **端到端**：`suggest()` 产出的候选表必须能过导入校验（这才是用户点的那条路）。
- **行为级前后对照（非复刻）**：同一份脚本 `_import-21dump.js`，只换源码 —— 改前 **0/21**、改后 **21/21**。
- **调用面核查**：`normalizeSteps` 只有两个真实调用点（`jobs.js` 的 `publish.importMap`、`adbtest`）；
  `publisher.js` 只**读** `whenOn/whenNotOn` 判据、不构造 ⇒ 改严不误伤。
  线上 `config.json` 现存 **7 种**守卫值**全部**符合新格式 ⇒ 不会「导出→再导入」自拦，整份配置也能过校验（改前不能）。
- **定点破坏**：D1 正则改回旧写法 ⇒ 正向/端到端/负向**全红**（旧负向绿）；D2 正则放宽收裸 id ⇒ 负向红、
  正向/端到端仍绿。两条**都与预测完全一致**。全量回归 **17 套 1613 项全绿**（`adbtest` 392/0）。
  报告：工作区 `_定点破坏-导入校验正则-20261005.md`。

#### ★★ 本轮新踩的两个坑（已并入 §BF 纪律）
1. **破坏脚本跑期间，工作区源码不可当判据**。它本来就把源码临时改成坏版 —— 中途 `git diff` 看 uimap.js
   会看到**坏版正则**，差点误读成「我的修复没生效」⇒ **判据一律读字节备份**（`_break-uimap.js.prebreak`）。
2. **破坏跑的套件必须带硬超时**。实测同一份 LOOSE 坏版，一次 run 只需 **289s**，另一次跑了 **19 分钟仍未返回**
   （CPU 时间不涨 / 内存不变 ⇒ **阻塞**而非在跑）；确切原因**未查明（不编造）**。
   处置：停进程 → **按字节备份还原**（md5 复核）→ 给 `runSuite()` 加 **12 分钟硬超时** → 单独重跑该轮（正常收敛）。
   ⇒ 破坏脚本里的 `execFileSync` 一律写 `timeout`，别裸跑。
3. **破坏脚本"自己的期望"也会写错**：D1 的 `负向` 我原预测 GREEN、实测 RED。查清后确认 **RED 才对**——
   旧正则不只「拒合法值」，还**放行假格式**（同一个坏版具备两个方向的缺陷）⇒ 负向用例里**必须**保留
   「少 `:id/` 的假格式」这一条。判据是「**我指定的那条**红没红」，不是「红了几条」。


## §CA 2026-10-05：**v1.0.15 发版（「全量」口径）** ＋ 两条「自己写错断言」＋ 本机 asar 不换的依据

### 一、发版范围：★ **由用户当场选定「全量」**（沿用 v1.0.6 / v1.0.9 先例）

工作区里压着**另一路会话**的 19 个未提交文件（句式骨架 T01~T15 / 彩色 emoji→色系判据 /
货号颜色校验页签仅管理员 / `promptFilter`→`promptWrite` 改名 / README+HANDOFF+docs.visual + 四个测试套件）。
提交前我做了三件事才敢带上它（**这一条可复用**）：

1. **证它停了**：最后一笔写盘 16:47、jsonl 停在 16:50:35 ⇒ 隔 1 分钟复采两次都没再前进。
2. **证它成体系**：产品侧与测试侧同步改（copytest +104 / uicheck +127 / logintest +25 / brandtest +5），不是半截。
3. ★★ **证它全绿**：**先拿工作树（含这 19 个文件）跑 `node tools/run-all.js` ⇒ 17 套 1622 项全绿**，绿了才提交。
   （顺序不能反：先提交再发现不绿，就得再补救一个提交。）

`AskUserQuestion` 一次问清两件事：**范围（全量 / 只发已提交 / 先不发）× 版本号（1.0.15 / 沿用 1.0.14）**。

### 二、版本号为什么是 1.0.15（不是 1.0.14）

| 事实 | 值 |
|---|---|
| 公网正式通道 | `1.0.11` |
| 本机已装副本 | `1.0.13` |
| `package.json` | `1.0.14`（commit `f40fa13`） |
| `dist/` 里的 exe | **13:47 打的 1.0.14 老包**（在「主图排序」「导入校验修复」两个提交**之前**打的，**从未上传**） |

⇒ 沿用 1.0.14 会出现**两个内容不同的 1.0.14**（本地老包 vs 新包），日志里说不清 ⇒ **升 1.0.15**，
老包归档到 `D:\work\_dist-archive\1.0.14-by-me-20261005-1347\`（按惯例只归档 exe + blockmap 两件）。

### 三、这次的提交拆分（4 条，顺序有讲究）

| 提交 | 内容 | 为什么单独一条 |
|---|---|---|
| `fdfd83d` | 另一路 19 文件（+593 −175） | 语义是「另一路的特性整批」，提交信息里写明**发版范围由用户当场选定全量** |
| `62340ea` | `chore(发版): 1.0.15` | 版本号单独一条（沿用 `chore(发版): X` 惯例） |
| `30dfcd8` | `docs(visual)` 刷新 | ★ **必须排在版本号之后**：生成器读 `package.json` 的版本写进文档 |
| `276a4db` | `docs(HANDOFF)` 发版记录 | ★ **排在打包之后**（记录里要写公网核对数字）；`docs/` **不在包里**（`build.files` 只收 `src/**` + `package.json`），所以它不进包、也不影响包的自洽 |

★ `docs/visual/index.html` 是**生成物**，别手改：`node docs/visual/build.js --snapshot <run-all 输出> --save-record`
（给 `--snapshot` 就不必再等 11 分钟重跑；`--run` 会真跑一次）。生成时 `git status` 越干净，文档里那个
「工作区有未提交改动 N 个文件」越接近 0 ⇒ **把刷新排在提交之后**。

### 四、实测数字（v1.0.15）

| 项 | 值 |
|---|---|
| 产物 | `得物蓝V素材发布工具-1.0.15-x64-win.exe` = **107095416 B**（1.0.14 = 107091467 B，+3949 B） |
| locales | `en-US.pak` / `zh-CN.pak` **恰好 2 个**（瘦身未回退） |
| `tools/verifypack.js` | **24/24** |
| 整包扫描 | 真读到 **2155 文件 / 48.6 MB**；临时文件 0；`src/` 硬编码设备串 0 |
| 快照回归 | **17 套 1622 项全绿**（与提交前工作树那次**数字一致**） |
| 公网 | `latest.yml`=1.0.15 / `Content-Length: 107095416` / `beta.yml` 未动（`1.0.1-beta.2`） |
| 远端 | `git ls-remote origin refs/heads/main` == `git rev-parse HEAD` == `30dfcd8…`（打包时）；补文档后为 `276a4db…` |

### 五、★★ 「本机已装副本换不换 asar」有明文依据，别凭习惯

`发版流程SOP.md` 写着：**「必须是你自己点下载和安装 —— 这两步没有任何自动化路径」**。
⇒ **不换**本机 `D:\bluevbeta\dewu-bluev-publisher` 的 `app.asar`（本次它仍是 1.0.13），
让用户走「检查更新」或自己下安装包。历史记录里几次「没换」写的理由是「有实例在跑」；
这次的理由不同 —— **SOP 就是这么定的**。真要在无实例时换，先拿到「确凿的进程清单」
（★ 查进程那条命令的 stdout 可能被整片吞成空，要落文件再读 —— 空 stdout ≠ 没有）。

### 六、★★ 两条「自己写错断言」（同一类，见到 FAIL 先怀疑自己）

1. **`verifypack.js` 的 `--need "file=sub"` 按最后一个 `=` 切**：
   我写 `--need 'src/renderer/index.html=data-admin="1"'` ⇒ 被切成 file=`…html=data-admin`、sub=`"1"`
   ⇒ 报「文件读不到 / FAIL」。**包没问题，是断言的锅**。⇒ 子串里带 `=` 时必须换一个**不含 `=`** 的子串。
2. **源码里正则的 `/` 是转义的 `\/`**：断言「`uimap.js` 含 `[A-Za-z0-9_.]+:[A-Za-z0-9_.]+/`」⇒ **假红**。
   真身是 `/^[A-Za-z0-9_.]+:[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/`。⇒ 断言串要**照抄转义后**的写法。

⇒ 与技能 `bilateral-fix-verification` §3.4b「破坏脚本自己的期望也会写错」是同一类：
**判据出红时，先证明「断言串本身对」，再怀疑产品**；否则会去「修」一个不存在的问题。

### 七、发现的遗留（**未修**，无害，下一版清）

`src/renderer/app.js:2643` 还留着 `const promptFilter = val('#bmFilter');`，并在 `brandAdd(...)` 里继续传。
`#bmFilter` 输入框**已从品牌弹窗删掉** ⇒ `val()` 恒返回 `''`；主进程 `brands.add` 显式挑字段 ⇒ 不会存进品牌对象
（`brandtest` ⑨ 实测通过）。属「删功能没连读取链一起删」的残留。**当时没动它**：动它要重打包 + 重跑回归，
会让**已经验完的包作废** —— 「已经验完的产物」与「顺手清洁一行」冲突时，选前者，把清洁留到下一版。

---

## §CB 交接给外部编码代理（Codex / Claude CLI 等）：知识库已收进仓库

**2026-10-05 建立**，commit `5c96db8` 已推 gitee（`5c96db8` 与 `git ls-remote` 一致、工作树干净、tracked 252）。

### 一、交接前先分类：git 里有什么 / 缺什么

| 类别 | 内容 | 结论 |
| --- | --- | --- |
| **git 里全都有** | 源码、17 套回归、`AGENTS.md`（Codex 自动读）、`docs/HANDOFF.md`、**新增 `docs/knowledge/`**（150 文件 / 3.7 MB：规则全文 + 28 技能 + 90 份文档 + 6 份日志 + 站点源码） | clone 完就能开工 |
| **git 外但本机已就位** | 发版凭据 `仓库根\.env`（518 B，已 gitignore）、MuMu 12（`D:\MUMU\MuMuPlayer\nx_main`）、真机得物 App、推 gitee 的 SSH key、`node_modules` | **同机运行 = 不用转移**；换机才要另给 |
| **git 外，二进制/原件** | `dist\`、`D:\work\_dist-archive\`、插件中心 `dl\`（109 MB）、411 个取证件与截图 | 按需索取，**故意不进 git** |

⇒ 一句话：让 Codex 在**这台机器上、这个仓库里**干活，它缺的只有 `node_modules`（`npm install`）。

### 二、★★ 知识库是「快照」，会过期

WorkBuddy 侧活文档（本文件 / 工作区 `MEMORY.md` / `~/.workbuddy/skills/`）**还在继续长**；
`docs/knowledge/` 是 2026-10-05 的导出快照。**那边更新后必须重新导出**，否则 Codex 拿旧规则干活。
导出脚本：`E:\WORKBUDDY\2026-09-30-17-35-35\_build-knowledge-pack.sh`（幂等，可重跑；跑完 `git add docs/knowledge` 再提交）。

### 三、★★ 把内部文档塞进仓库前的三道检查（缺一条都可能出事）

1. **确认它不进安装包**：读 `package.json` 的 `build.files` —— 本案是 `["src/**/*","package.json",…]`
   ⇒ `docs/**` 不进包。若换成通配 `**/*`，内部规则会随 exe 外发。
2. **扫凭据字面量**：`eyJ[A-Za-z0-9_-]{30,}` / `AKID[A-Za-z0-9]{12,}` / `sb_secret_` / `sk-[A-Za-z0-9]{24,}` /
   `postgres://user:pass@` / `-----BEGIN … PRIVATE KEY`。
   本案实测命中 3 处，逐条判死：COS 指引里的 `AKIDxxxxxxxx…` 是**待用户填的占位符**；
   `pluginhub-site/dashboard*.html` 里的 Supabase key **解 JWT 载荷得 `{"role":"anon"}`**
   ⇒ 随公开看板发布过的公开端凭据，**非 `service_role`**（红线是 service_role/secret 进前端，没破）。
3. **剔垃圾**：`__pycache__` / `*.pyc` / `*.bak*`。
   ★ 坑：`find -type d -name X -prune -exec rm -rf {} +` **没删掉**（顺序不对）；改用直接 `rm -rf <path>` 才干净。

### 四、踩坑记录

- ★ **`git commit -F` 的路径必须给 Windows 形式**（`E:/WORKBUDDY/…`）。
  Git Bash 的 `/e/WORKBUDDY/…` 会让 git 报 `could not read log file … No such file or directory`（git 是 Windows 程序，不认 MSYS 路径）。
- ★ `git add` 前先 `git config core.quotepath false`，否则中文文件名在 `--name-only` 里显示成八进制转义、看不清都加了什么。
- ★ 入库时 git 会刷一屏 `LF will be replaced by CRLF` 警告（本仓库 `core.autocrlf=true`）—— **属正常**，
  用 `git show HEAD:<path> | wc -l` 对行数自证即可（实测 `RULES-得物蓝V.md` 库内 4159 行 == 源文件 4159 行）。

### 五、当前交接状态（2026-10-05 18:0x）

远端 `git@gitee.com:abulaitifans/dewu-bluev-publisher.git` · 分支 `main` · HEAD `5c96db8` · 提交 96+1=97 条 ·
版本 1.0.15 · 回归 17 套 **1622 项**全绿 · 公网通道 1.0.15 · 本机已装副本仍 1.0.13（按 SOP 不换 asar）·
`README.md` 套件表数字停在 **1005（10-03）已过时** ⇒ 每次实测重取。
入口：`docs/HANDOFF-CODEX.md`（一页纸）+ `docs/knowledge/README.md`（索引）。

---

## §CB-2 换机方案（跨机器交接）—— 2026-10-05 实测

**同机 vs 换机，差别只有一句**：同机 = 只缺一次 `npm install`；
**换机 = 多出一件「搬钥匙」的活，而钥匙不能走 git**。完整 runbook：`docs/HANDOFF-NEW-MACHINE.md`（commit `955754c`）。

### 一、通道分类（换机时照这张表走）

| 东西 | 通道 |
| --- | --- |
| 源码 / 17 套回归 / `docs/` / `docs/knowledge/` / `AGENTS.md` | `git clone` |
| `vendor/adb/*` `vendor/ffmpeg/*` `vendor/adbkeyboard/ADBKeyboard.apk` | **`git clone`（二进制本来就在 git 里，不用另拷）** |
| `config.json`（**含真实模型密钥 + 真机 UI 定位表**）、`auth.json`（账号口令哈希）、`.env`（COS SecretKey）、`~/.ssh` 私钥 | **只能单独搬**（加密/U盘），**绝不许走 git** |
| 模拟器 + 得物 App + 登录态 | 新机自装 |
| `dist\`、`_dist-archive\`、插件中心 `dl\`、411 个取证件 | 按需，二进制，故意不进 git |

### 二、★★ 本机实测：换机必须知道的六件事

1. **`config.json`（`%APPDATA%\dewu-bluev-publisher\`）里有真密钥**：`copy.llm.apiKey` = **35 字符**（模型密钥）；
   `publish.uiMap.*` = **真机实测的 UI 定位表**，**`src/` 里没有内置默认值** ⇒ 不搬就要重抓（最贵的一步）。
   它同时含 `paths.*` / `publish.device` / 主题。⇒ 搬 `config.json` **等于搬密钥**，按密钥保护。
2. **★★ 没有「整份配置导出」这个功能**：界面上的「导出配置 / 导入配置」**只针对云端协作**
   （`cloudsync.exportConfig()` 只返回 `url` / `anonKey` / `org`），**不含模型密钥、不含 UI 定位表**。
   ⇒ 所以 `config.json` 只能「搬文件」或「新机重填」，没有第三条路。
3. **★★ `cloud.machineId` 是「有就复用、没有才生成」**（`cloudsync.machineOf()`：
   `let id = String(cfg.machineId||''); if(!id){ id='m_'+randomUUID().slice(0,8); store.set(...) }`）。
   原机是 `m_fb6e1a86` ⇒ **照搬 config.json 会让两台机器共用一个 machineId**，云端看板把两台当一台。
   ⇒ 新机把 `cloud.machineId` 置 `""`，App 下次启动自生成。（`machineName` 留空时取 `os.hostname()`。）
4. **`paths.*` 是绝对路径**（原机 `C:\Users\Administrator\素材` / `...\输出\得物` / `...\素材\_rejected`），
   换用户名/盘符全失效且**不会报错**。
   ★ 且**原机 `paths.source` 指向的目录现在已经不存在**（`C:\Users\Administrator\素材` 已没有）
   ⇒ 「沿用原值」本来也没意义，新机务必重选。
5. **台账在 `paths.output`，不在 userData**：`publish-log.jsonl`（88 KB，发布台账）、
   `run-log.jsonl`（717 KB，界面「运行日志」读它）、`pending-results.json`（被占用时暂存、恢复后补写）、
   `发布单_*.xlsx`、`batches/` `dumps/` `failures/`。⇒ 要留历史就整个带 `输出\得物`。
6. **`auth.json` 是 `{version, users, remember, usingDefault, updatedAt}`**；
   原机 users = `admin`（管理员，★ `mustChange: true` ⇒ 还是出厂口令没改）+ `testbeta`（普通成员）。
   口令是 salt+hash（128 字符），**解不出明文但可直接登录** ⇒ 按密钥保护。

### 三、其它前提

- **要跑发布链路，目标机必须是 Windows x64**：`vendor/adb/adb.exe`、`vendor/ffmpeg/ffmpeg.exe` 都是 Windows 二进制；
  产品只打 `--win --x64` NSIS。**只改代码**才可在 mac/Linux 跑，但要换 vendor 两个平台件 + `@img/sharp-*`
  （注意 `npm run addon:win` 是**强制取 Windows 版**，在 mac 上会把 mac 版顶掉）。
- 工程建议放**同一个绝对路径** `D:\work\dewu-bluev-publisher`（省掉一整类「扫不到素材」的怪问题）。
- ★ 照搬 `config.json` 后**务必检查 `publish.mock`**：原机当前是 **`true`**（干跑）——
  不注意会以为在真发。
- 推送：gitee SSH key 可拷（敏感）或新机 `ssh-keygen` 新生成并把公钥加进 gitee；设好 `git config user.name/email`。

## §CC 2026-10-05：**`config.json` 怎么搬** —— 新工具 `tools/config-portable.js`

**问题（先有依据再动手）**：`config.json` 是**三类东西混在一个文件里**：
① 可搬运的业务配置（`publish.uiMap`＝真机定位表 38+41 步、`brands[]`、`copy.pool/hotwords`、各阈值）；
② 机器专属（`paths.*` 绝对路径、`publish.adbPath/ffmpegPath`、`cloud.machineId/machineName`、`window.*`）；
③ 明文密钥（`copy.llm.apiKey` 35 字符、`verify.api.apiKey`）。
整份照拷必踩两坑：路径**静默失效**、两机共用一个 `machineId`。
★ 界面那个「导出配置 / 导入配置」**只管云端协作三个字段**（`cloud.url/anonKey/org`，见
`src/main/services/cloudsync.js`）——**不含**密钥、品牌、话题池，**更不含 `uiMap`**。⇒ 必须自己有工具。

**工具**：`tools/config-portable.js`，四个子命令
`inspect`（只读看现状）/ `export`（默认抹密钥，`--with-secrets` `--with-project` 可加）/
`import`（**默认只预演**，`--yes` 才真写且先备份 `config.json.bak-before-portable-<时间戳>`）/ `selftest`（33 条往返自测，临时目录，不碰真配置）。
★ **故意不进 `run-all.js` 的 `SUITES`**（那张表是硬编码数组）⇒ 17 套 1622 项的基线不动；与 `fixuimap/verifypack/upload-release` 同类，属维护工具。
★ 导入侧**不会**把本机已有的密钥抹空（包里标为 redacted 的路径，本机有值就保留本机值）。
★ `cloud.anonKey` **不算**密钥（公开设计，靠 RLS 收口）⇒ 密钥正则不许写裸 `key`。

**实测数字（真机）**：源 `config.json` 43 KB → 搬运包 45 KB；`apiKey`（35 字符）在包**全文搜不到**；
`cloud.machineId` = `""`、`paths` 三项 = `""`、`window.bounds` = `null`；`uiMap` **38 图文 / 41 视频**原样；
逐键比对 **71 键一致 / 4 条差异**（那 4 条全是 `window.bounds.{x,y,width,height}` 随父置 null 消失，属预期的 9 项置空之一）；
**预演导入前后 `config.json` md5 一致**（真没写盘）。

**首跑就红了一条（这是断言在查东西的正据，别删）**：`parentOf(o, p)` 对**顶层键**（`sourceDir`/`flatDir`）
返回 `undefined` ⇒ 被当成「父不存在」整条跳过 ⇒ 这两个键**没被置空**。
修法：`ks.length === 1` 时直接返回根对象本身。**教训**：路径工具函数一定要有「顶层键」的用例。

**另有四份文件不该照搬**：`cloud-sync.json`（**上行游标** `offset/uploaded`，照搬会漏推一截 ⇒ 删掉让它重建）、
`.updaterId`（更新器设备标识，新机自生成）、`pool.json`（商品池缓存，原机根本没有）、`auth.json`（见下）。

**`auth.json` 两种带法**：① 要保留账号与品牌权限 ⇒ 搬文件（含 scrypt 哈希，解不出明文**但能直接登录**）；
② 只想保住管理员口令 ⇒ 新机放 `auth.seed.json`（`{username,password}`，**首次启动读走后立即删除**，
见 `src/main/auth.js` 的 `seedFrom()`；环境变量 `BLUEV_ADMIN_USER/PASS` 优先级更高）。
两者都没有 ⇒ 建出厂账号 `admin / BlueV@2026` 并提示改口令。

