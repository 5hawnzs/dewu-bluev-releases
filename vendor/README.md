# vendor/ —— 随安装包一起分发的第三方文件

这里是**要在打包时原样搬进安装包**的东西（`package.json → build.extraResources`）。
它们不经过 asar（asar 是压缩归档，里面的 `.exe` 不能直接执行），装完之后落在这里：

| 仓库里的位置 | 用户机器上装完之后 | 谁在用 |
|---|---|---|
| `vendor/adb/` | `<安装目录>/resources/adb/` | `src/main/index.js` → `adb.setBundledAdbDir()` |
| `vendor/adbkeyboard/` | `<安装目录>/resources/adbkeyboard/` | `src/main/index.js` → `adb.setBundledApkPath()` |
| `vendor/ffmpeg/` | `<安装目录>/resources/ffmpeg/` | `src/main/index.js` → `video.setBundledFfmpegDir()` |
| `vendor/dewu/` | `<安装目录>/resources/dewu/` | `src/main/index.js` → `dewuapk.setBundledDir()` |

**为什么要内置**：以前 adb 要用户自己去模拟器安装目录里翻（`D:\MUMU\MuMuPlayer\nx_main\adb.exe`）
填进设置里 —— 这是新同事的第一道墙。adb 三件套才 8 MB 出头，内置之后「装上就能用」。
中文输入法同理：不装它，中文标题/正文根本打不进得物发布页。
ffmpeg 是为了**把达人给的 `.mov` / `.m4v` / `.avi` / `.webm` / `.mkv` 自动转成 `.mp4`** ——
得物只收 mp4，以前非 mp4 只能标「需手动转 MP4」让运营自己去开转换器，这是发布链路上最烦的一块手工活。
得物 App 安装包是为了兜**MuMu 自带的应用商店里搜不到得物** —— 新模拟器/新同事卡在这一步就没法开始，
设置页「外部依赖」给「下载到本机 / 装进模拟器」两个按钮（见 `src/main/services/dewuapk.js`）。

> ⚠️ 这些二进制**故意进 git**。仓库的 `.gitignore` 一般不许提交二进制（`node_modules`/`dist` 那种几百 MB 的），
> 但这一份是**每次打包都必须有**的，走「构建时下载」会让没网的机器打不出包。
> adb + 输入法约 9.6 MB、ffmpeg 约 79 MB、得物安装包约 127 MB，合计约 216 MB。

---

## 1. `vendor/adb/` —— Android platform-tools（官方 Google 构建）

| 文件 | 字节 | md5 |
|---|---|---|
| `adb.exe` | 8,273,560 | `a800950fb8371b10f124d7be32926574` |
| `AdbWinApi.dll` | 108,184 | `fccdfea383a8d06fd152c2ffbd185dd0` |
| `AdbWinUsbApi.dll` | 73,368 | `ce674ec12db4255ca0fc65138f216eaa` |
| `LICENSE.txt` | 11,498 | Apache License 2.0 全文（从上游 `NOTICE.txt` 摘出，行 1–207） |
| `NOTICE.txt` | 1,154,131 | 上游原样，含各组件署名 |

- **版本**：`Android Debug Bridge version 1.0.41` / `Version 37.0.1-15733141`（`source.properties` 里 `Pkg.Revision=37.0.1`）
- **来源**：`https://dl.google.com/android/repository/platform-tools-latest-windows.zip`（8,044,989 字节）
  解出后只取 `adb.exe` / `AdbWinApi.dll` / `AdbWinUsbApi.dll` / `NOTICE.txt`
- **许可**：Apache License 2.0 —— **明确允许随产品再分发**，要求是附上许可全文并保留署名。
  `LICENSE.txt` + `NOTICE.txt` 就是为这个随包一起发进去的（在 `resources/adb/` 下，用户可查）。
- ★ **不要用模拟器自带的 adb 顶替**：MuMu 12 自带的是 `36.0.0-13206524`（`adb.exe` 6,641,760 字节），
  是另一个构建。功能相当，但版本、体积、来源都不如官方这份清楚。要换版本就按下面第 3 节重做一遍。

## 2. `vendor/adbkeyboard/` —— ADBKeyboard（给脚本用的中文输入法）

| 文件 | 字节 | md5 |
|---|---|---|
| `ADBKeyboard.apk` | 17,374 | `84346f7dbae47105c3241f82c1c58ce2` |

- **来源**：`https://github.com/senzhk/ADBKeyBoard`（`master/ADBKeyboard.apk`）
- **包里**：`com.android.adbkeyboard`，输入法组件 `com.android.adbkeyboard/.AdbIME`
- ★ **装上只是第一步**。要能打中文，`adb shell` 这三条缺一不可（`adb.js#installKeyboard()` 一次做完）：
  ```
  adb install -r ADBKeyboard.apk
  adb shell ime enable com.android.adbkeyboard/.AdbIME
  adb shell ime set    com.android.adbkeyboard/.AdbIME
  ```
  只装不启用 ⇒ `ADB_INPUT_TEXT` 广播没人接；不设成当前输入法 ⇒ 字照样进不了输入框。
- **自动配置**：程序启动并检测到已选择的在线设备后，会自动安装、启用并设为当前输入法；设备检查和每次发布前也会补做检查。
  用户不需要下载、安装或点击额外按钮。设为当前输入法后，模拟器里的手动输入不会弹出系统键盘；发布器会通过 ADBKeyboard 广播写入内容。

## 3. `vendor/ffmpeg/` —— ffmpeg（把非 mp4 视频自动转成 mp4）

| 文件 | 字节 | md5 |
|---|---|---|
| `ffmpeg.exe` | 82,797,568 | `25243548be231a3c928cb7a0b6225ae9` |
| `LICENSE.txt` | 35,147 | `d32239bcb673463ab874e80d47fae504` |
| `README-ffmpeg-static.txt` | 39,494 | `e8dee073472c6e5e368152b57c8e3417` |

- **版本**：`ffmpeg version 6.1.1-essentials_build-www.gyan.dev`（构建方 = gyan.dev，`--enable-gpl --enable-version3 --enable-static`）
- **来源**：`ffmpeg-static` 的 release 资产 `b6.1.1/ffmpeg-win32-x64`
  - 上游：`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64`
  - ★ 本次实际下载走的是**国内镜像**：`https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz`
    （本机 `github.com:443` 超时下不来；镜像上这个文件的字节数与上游 API 报的 `82,797,568` 完全一致）
- **许可**：**GPL v3** —— 上游 README 第 5 行就是 `License: GPL v3`；`LICENSE.txt` 是 GPL-3.0 全文（35,147 B）；
  二进制 `-version` 自己也带着 `--enable-gpl --enable-version3`。
  - ★★ **当前只按「公司/团队内部装机使用」放进来**（内部使用不构成 GPL 意义上的「分发」）。
  - ★★ **一旦要对外分发这个安装包**（给客户、代运营、外部合作方），**必须先解决许可**：
    换成 LGPL 构建（BtbN 的 `ffmpeg-*-lgpl-shared`，动态链接 + 允许用户替换库），或按 GPL 走完整合规（附源码/书面提供）。
  - ★ 顺带注意：`package.json` 里本项目自称 `MIT` —— **MIT 应用 + GPL 二进制的对外分发组合就是冲突点**，
    内部自用无所谓，对外发就是问题。
- **用到的能力**（实测 `-encoders` / `-decoders` / `-formats`）：
  编码 `libx264` / `libx265` / `aac` / `prores_ks`；解码 `h264` / `hevc`；容器 `mov,mp4,m4a` 与 `matroska/webm` / `avi`。
- **怎么用**：见 `src/main/services/video.js` —— **先无损转封装**（`-c copy`：只换容器，秒级、画质零损失），
  容器/编码不兼容时才**转码**（`libx264 -crf 20` + `aac`）。产物还会被复用校验一遍（`ftyp` 品牌 + `moov/mvhd` + 轨道编码）。
- ★ **不要再额外内置 `ffprobe`**（另外 78.8 MB，等于白烧一倍体积）：
  读时长用现有的纯 JS `moov → mvhd` 解析就够了（`imaging.videoDurationSec`），实测 MOV 也能读。

## 4. `vendor/dewu/` —— 得物 App 的安卓安装包（模拟器商店里搜不到得物时的兜底）

### 4.1 ★ 这个目录在仓库里是「**分卷**」存的，和其它 vendor 目录不一样

| 仓库里实际存的文件 | 字节 | md5 |
|---|---|---|
| `dewu_6.0.5.apk.part01` | 67,108,864 | `6a386377ffa3565f8d60b86a880f54e4` |
| `dewu_6.0.5.apk.part02` | 66,206,267 | `3ed15d2cfaf4144986c65d2d6a866ecf` |
| **（拼回来）**`dewu_6.0.5.apk` | **133,315,131** | **`50092bccb263498a16e4fbb57762ae5f`** |

- **为什么要分卷**（2026-10-08 实测，不是预防性设计）：Gitee 与 GitHub 都是
  **「单文件超过 100 MiB 就拒绝整次 push」** —— 是整次，不是只跳过那个文件。
  实测报错：`remote: Find the desired index: …, size: 120.666MB, exceeds quota 100MB`。
  - 顺带否掉了「压一下就行」这条路：`gzip -9` 后 **126,471,554 字节（120.6 MiB）**，**仍然越线**
    （APK 本身就是 zip，再压几乎没收益）。
- **怎么拼回来**：`node tools/dewuapk-assemble.js`
  - 缺了/对不上才拼（幂等：已经是对的就说「未改动」）；`--force` 强制重拼；`--check` 只校验不写盘。
  - 拼完**逐字节自检**（字节数 + md5 都要对上），对不上就把半成品删掉并 `exit 1`，不留个"看起来像成品"的东西。
  - `npm run dist:win` / `dist:win-only` **开头已经自动带上这一步**，正常打包不用手跑。
  - 换新机器 `git clone` 后第一次打包也不需要额外操作 —— 片段在仓库里，拼装是自动的。
- **拼回来的单文件不进 git**（`.gitignore` 里有一条 `/vendor/dewu/dewu_6.0.5.apk` 挡着）：
  一旦误 `git add` 进去，远端会**连整次推送一起拒**。
- ★ 片段之间**没有**额外的校验文件：判据是「片段字节数之和 == `dewuapk.js` 里的 `BYTES`」
  ＋「拼回来之后的 md5 == `MD5`」，两处对不上就拒绝。所以片段数从 2 变成 3 也不需要改代码
  （按文件名排序顺序拼接）。

### 4.2 这个包到底是什么 / 来源 / 合规

| 项 | 值 |
|---|---|
| 拼回来的文件名 | `dewu_6.0.5.apk` |
| 字节 | 133,315,131 |
| md5 | `50092bccb263498a16e4fbb57762ae5f` |

- **包里到底是什么**（★ 这几项是**从包的 `AndroidManifest.xml` 里读出来的**，不是按文件名猜的 ——
  解析脚本见本轮工作记录；读法：APK 里那份 manifest 是二进制 XML，按 AXML 字符串池 + start-element 属性逐条解）：
  - `package` = `com.shizhuang.duapp`
  - `versionName` = `6.0.5` · `versionCode` = `1140`（⇒ 文件名里的 `6.0.5` 对得上）
  - `compileSdkVersion` = `35`
  - `lib/` 里只有 `arm64-v8a` / `armeabi-v7a`，**没有 `x86_64`**
- ★ **ABI 这条要记住**：MuMu 12 是 x86_64 模拟器，这个包只有 arm64 ⇒ 装是靠 MuMu 自带的
  **ARM 兼容层**跑的。`adb install` 本身不看 ABI（照样 Success），所以**"装上了但打不开"**
  的第一嫌疑就是这条，不是包坏了。
- **来源**：**装机师傅本机上已有的一份**（这台机器上同一 md5 的两份副本：
  `C:\Users\Administrator\WorkBuddy\2026-09-18-19-34-22\dewu-kol\dewu_6.0.5.apk` 与
  `E:\WORKBUDDY\2026-09-22-18-26-20\dewu_pcap\dewu.apk`，两边 md5 一模一样 ⇒ 同一份）。
  - ★★ **老实说清楚：这一份没有跟得物官方渠道对过。** 得物官方没有稳定的直链
    （下的是下载页 / 应用商店跳转），所以只能拿本机已有的副本，用**字节数 + md5 固定住**
    （`src/main/services/dewuapk.js` 里的 `BYTES` / `MD5`），保证"发给每个人的是同一份、
    且装之前能判出这份完不完整"。**md5 只能证明"没被换过/没坏"，证明不了"它出自官方"**——
    要更强的保证，只能去得物官方渠道下同一版本、再重算 md5 换掉这两处常量与本表。
- **许可/合规**：得物 App 是**第三方商业应用**，版权在得物，这里是**原样分发、未做任何修改**。
  - ★★ **当前只按「公司/团队内部装机使用」放进来。**
  - ★★ **一旦要对外分发这个安装包**（给客户、代运营、外部合作方），先解决授权问题 ——
    换成「让用户在得物官方渠道自己下」的指引，而不是随包发（同 `vendor/ffmpeg` 那条 GPL 提醒的性质）。
- **怎么用**：设置页「外部依赖」那一行两个按钮 ——
  - 「下载到本机」= 另存为一份到用户选的位置（`dewuapk.saveAs`，存完回读大小，半截文件不许说"存好了"）；
  - 「装进模拟器」= `adb install -r` 装进已选中的设备，**装之前先读设备**：
    已经装了得物就**一条安装命令都不发**（得物里是登录状态和本地草稿），只回报版本；
    覆盖重装必须由用户再点一次「覆盖重装」（那时才加 `-d` 允许降级）。
    装完**回读** `pm list packages` 确认，`adb install` 说 Success 不算数。
- ★ 换新版本（例如 6.1.0）：把新 apk 放进本目录 → **重新分卷**（见下）→ 改 `dewuapk.js` 里的
  `FILE`/`BYTES`/`MD5`/`VERSION`/`VERSION_CODE` → 改 §4.1 与本小节这两张表 → 跑 `node tools/run-all.js`
  （`uicheck` 会核对内置文件的 md5 能不能在本表里对上）。
  ```bash
  # 重新分卷（每片 64 MiB，可放 2 片；只要每片 <100 MiB 都行）
  cd vendor/dewu
  rm -f dewu_<新版本>.apk.part*                     # 先清掉旧片段
  split -b 67108864 -d --numeric-suffixes=1 -a 2 dewu_<新版本>.apk dewu_<新版本>.apk.part
  md5sum dewu_<新版本>.apk.part*                    # 抄进 §4.1 的表
  node ../../tools/dewuapk-assemble.js --force      # 拼回来核 md5，必须等于原件
  ```
  ★ 分卷后**务必**用 `cmp` 或 md5 确认「拼回来的 == 原件」，别只信字节数。

## 5. 怎么更新到新版本

```bash
# ① 下载官方 platform-tools 并解压
curl -L -o pt.zip https://dl.google.com/android/repository/platform-tools-latest-windows.zip
unzip -o pt.zip

# ② 只取这四样覆盖进来（NOTICE.txt 要跟着换）
cp platform-tools/{adb.exe,AdbWinApi.dll,AdbWinUsbApi.dll,NOTICE.txt} vendor/adb/
head -207 vendor/adb/NOTICE.txt > vendor/adb/LICENSE.txt

# ③ 校验 + 对一下版本
cd vendor/adb && md5sum adb.exe AdbWinApi.dll AdbWinUsbApi.dll
./adb.exe version            # 期望 Android Debug Bridge version 1.0.41

# ④ 全量回归（uicheck 会核对这几个文件的哈希与存在性）
node tools/run-all.js
```

换 ffmpeg 版本（当前 `b6.1.1`）：

```bash
M=https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1
cd vendor/ffmpeg
curl -L -o ffmpeg.exe.gz "$M/ffmpeg-win32-x64.gz"   # 28.2 MB；上游是 .github.com/.../ffmpeg-win32-x64（79 MB）
gzip -d ffmpeg.exe.gz
curl -L -o LICENSE.txt "$M/win32-x64.LICENSE"       # 必须跟着换：许可全文变了就是合规问题
curl -L -o README-ffmpeg-static.txt "$M/win32-x64.README"

# 校验：字节数 82,797,568、md5 与上表一致；再确认它真能跑
./ffmpeg.exe -hide_banner -version | head -1
# 期望：ffmpeg version 6.1.1-essentials_build-www.gyan.dev
```

★ 换版本后**必须**重跑 `node tools/run-all.js`：`tools/videotest.js` 会**真的调用一次**内置 ffmpeg 做转换，
不是只检查文件在不在 —— 「文件在、但 exe 跑不起来」会被它红掉。

★ 换 adb 版本前先读一遍 `docs/HANDOFF.md` 里那条实测：
**内置 adb（37.0.1）跟已装的其它 adb 版本（如 MuMu 的 36.0.0）不会互相重启服务** ——
这台机器上测过，所以不必担心「抢方向盘」。换大版本后建议用真机再跑一次
「检查能不能发布」确认。
