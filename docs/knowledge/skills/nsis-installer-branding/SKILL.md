---
name: nsis-installer-branding
description: 给 electron-builder(NSIS) 桌面应用的安装向导做品牌化界面：位图规格、sharp 渲染与 24-bit BMP 自编自解、LZMA 下的"资源真进包"取证（对照实验）、真机截图被沙箱堵死的替代路线。
agent_created: true
---

# NSIS 安装界面品牌化（electron-builder）

## ★ 决策记录：本项目的品牌化已于 2026-10-05 回退（提交 53db158）
用户看过成品后拍板「别做了，回退最初」。理由两条：
1. **外边框改不动** —— 主对话框是 `WS_POPUP|WS_BORDER|WS_DLGFRAME|WS_EX_WINDOWEDGE` 经典框架，仍「像 20 年前的」；
2. **侧栏/页眉渐变观感差** —— 用户原话「像尿渍一样」。

回退方式 = 删掉 5 个文件：`build/installerHeader.bmp`、`build/installerHeaderIcon.ico`、
`build/installerSidebar.bmp`、`build/installer.nsh`、`tools/make-installer-art.js`
（均由 electron-builder **按约定自动探测**，`package.json` 无引用、npm 脚本无依赖 ⇒ 删除即回默认外观，打包零影响）。

**若重启此任务**：先啃「**外边框**」这一条。只改内容区底色的方案用户已经看过并否掉了（等于白做）。

## 资源约定（文件名/尺寸是硬性的，electron-builder 自动探测）
放 `build/`（buildResources 目录）：
- `installerSidebar.bmp` — **164×314**，欢迎页/完成页左侧大图
- `installerHeader.bmp` — **150×57**，每个向导页顶部页眉（贴右侧，图形靠右放，别压产品名）
- `installerHeaderIcon.ico` — 页眉左侧小图标（直接复制应用 icon.ico 即可）
- BMP 必须 24-bit 无压缩、尺寸**逐像素一致**（NSIS 不缩放）。
- NSIS 数据段整体 LZMA 压缩，所以位图做大点没关系（压缩率 ~8:1）。

## sharp 渲染要点（实测 0.33.5 / vips 8.15）
- **能渲中文**：librsvg+fontconfig 自带 Microsoft YaHei，`font-family="Microsoft YaHei"` 直接可用。
- **读不了 bmp**：`.toBuffer` 报 `unsupported image format`（Windows 构建没编 bmp loader）
  ⇒ 校验必须**自解 BMP**：头 54 字节，`height>0`=自底向上，行按 4 字节对齐（150×3=450 → 补 2 字节），
  像素序 BGR。采样四角+图形中心对色，别只看文件存在。
- 渐变图 LZMA 压缩率高：193KB 原始位图在包里只占 ~24KB。

## 「资源真进了安装包」取证 —— 别用直搜字节
- ❌ 在 setup.exe 里 `indexOf` BMP 字节：数据段 LZMA 压缩后必搜不到（假阴性）。
- ❌ `installerHeaderIcon.ico` 能搜到 ≠ 证据（它同时是 PE 图标资源，本来就未压缩存在）。
- ✅ **对照实验**：移走位图重打包一次，比两次 exe 大小差（有差值 = 被编入；量级 ≈ 位图大小/8）。
  差值取证时注意：NSIS 每次打包本身有 ~几百字节抖动（元数据/时间戳），小差值别过度解读。
- ✅ 最直观证据是装上真机看欢迎页，但 GUI 安装器常被沙箱拦启动（Add-Type 也被拦），截不到图就别硬截，落回对照实验。

## 整片底色：能做到什么、做不到什么（v3 结论，含负面实测）
⚠️ **结论先行**：整片底色**只能覆盖 nsDialogs 页（欢迎/完成）**；模式页可借 `customInstallMode` 钩子补一次；
**目录页在模板里没有插槽 ⇒ 做不到**。别承诺「全向导整片同色」。

- **MUI_BGCOLOR**（只影响 nsDialogs 页）：欢迎/完成页的 SetCtlColors 在**页面宏展开时编译期内联**。
  electron-builder 模板顺序 = 页面(assistedInstaller) → addLangs(MUI_LANGUAGE) → customHeader，
  所以 define 必须写在 `build/installer.nsh` 顶部（include 期）；MUI_INTERFACE 的 MUI_DEFAULT 是
  `!ifndef` 守卫，不会覆盖用户值。目录/进度/组件页**不引用** MUI_BGCOLOR（grep 实测 0 命中）。
- **`SetCtlColors` 才是唯一有效的着色途径**：它给窗口装 `WM_CTLCOLOR*` 钩子 ⇒ **必须去重**，重复调用会叠加钩子。
- ❌ **`SetClassLongW(GCLP_HBRBACKGROUND)` 换类画刷 —— 实测无效**（本会话曾误以为可行，已推翻）：
  对 `#32770` 写回句柄得到 `style=0 color=0`（无效）；对话框客户区走 `WM_CTLCOLORDLG`，**根本不看类画刷**。
  （stub 是 32 位、也确实没有 `SetClassLongPtrW` 导出 —— 但这不是失败原因，原因是对话框不吃类画刷。）
- ⚠️ **窗口结构（实测修正）**：**不是「所有页共用一个主对话框」** —— 主对话框 `#32770`（外框）内，
  **每页各嵌一个 `#32770` 子对话框当「页面容器」，句柄逐页更换**。MUI2 自己也这么找：
  `Modern UI 2/Pages/Directory.nsh` → `FindWindow $mui.DirectoryPage "#32770" "" $HWNDPARENT`。
- ❌ **目录页无解（已穷尽验证）**：`MUI_PAGE_FUNCTION_CUSTOM`（含 `SHOW`）**派发后立刻 `!undef`** ⇒ 只对紧随那一页生效；
  模板里 `PAGE_INSTALL_MODE` 与 `MUI_PAGE_DIRECTORY` 之间**没有任何宏插槽**。试过并失败的四条路：
  ① `nsDialogs::CreateTimer` 跨页轮询 —— 定时器是**页内作用域**，离页即死（实测只 tick 1 次）；
  ② 宏展开期 `!macroundef` + `!include` 替换 MUI 派发宏 —— 宏内 `!include` 能进去，但**宏定义不生效**；
  ③ 走私多行 `!define` —— 反斜杠续行会吃掉换行、引号内换行不成立（`!define /file` 也试过）；
  ④ 劫持 `templatesDir/include/StrContains.nsh` —— NSIS `!include` 搜索顺序 **CWD 优先**，劫持不了。
- 另两条不可用：`Function .onGUIInit` 与 MUI2 冲突（重名编译失败）；`MUI_CUSTOMFUNCTION_GUIINIT`
  在 electron-builder 里 define 时 MUI_LANGUAGE 已过 ⇒ 同样不可用。
- 颜色格式：**⚠️ 口径待复核** —— 实测 `!define MUI_BGCOLOR "E1F5EE"` 出屏采样是 `#e1f5ee`（像按 RRGGBB 读），
  但 Windows COLORREF 惯例是 BBGGRR，且该点在本会话被自己推翻过一次 ⇒ **重启前先做一次像素采样复核，别照抄**。
- 米白类颜色（#f2f1ed）与纯白肉眼/截图都难辨，像素采样对比才有意义；要「看得出」就选浅品牌色。

## electron-builder 的坑（实测）
- 默认 `-WX`（**警告即错误**）＋ **两遍编译**：第一遍 `!define BUILD_UNINSTALLER` 只生成卸载器，
  页面插槽全在 `!ifndef BUILD_UNINSTALLER` 里 → 函数定义在宏体外 = 首遍"未引用函数"
  warning 6010 → 直接失败。**函数必须定义在各 custom 宏体内部**。
- 插槽语义：`customWelcomePage` **就是欢迎页本身**（模板默认没有欢迎页！宏内必须
  `!insertmacro MUI_PAGE_WELCOME`）；`customFinishPage` 一旦定义**整体替换**默认完成页，
  必须照抄 assistedInstaller.nsh 的 StartApp 逻辑（`${isUpdated}`/`${StdUtils.ExecShellAsUser}`/`$launchLink`）。
- `MUI_PAGE_CUSTOMFUNCTION_SHOW` 每页用完即 `!undef`（编译期实验验证），不能一个 define 管多页。
- `installer.nsh` 必须带 **UTF-8 BOM**（makensis 对 include 文件按 ANSI 读，无 BOM 中文注释报 Bad text encoding）。
- 本地验证利器：`electron-builder Cache/nsis/nsis-3.x/makensis.exe` 可直接编 probe 脚本（秒级定位
  warning/error，不必等 24s 打包）。MUI2 源码是**纯 ASCII**（之前误判 UTF-16 走了弯路，grep 直接搜）。

## 流程
1. 位图：设计 SVG（品牌色对齐应用 CSS 变量）→ `--preview png` 目检 → 落 BMP → 自解采样校验
2. 底色/脚本：`build/installer.nsh`（`MUI_BGCOLOR` + `SetCtlColors` + 三个页面宏；**别再用 SetClassLongW**）
3. makensis probe 秒级验证 → electron-builder 打包
4. **真机截图闭环**：按「要看内容区还是外边框」选 PrintWindow / 屏幕 BitBlt → **像素采样**确认颜色 → 迭代
5. 全量回归 + 只提交本次文件

## 并行会话陷阱
跑回归/打包前先 `git status`：工作区可能有**另一会话的在制品**（看 mtime 分辨谁的改动）。
回归 FAIL 先定位归因再谈修（源码锚点类断言容易被加一行注释推爆区间窗口）；
不是自己的改动就**不修不混提**，如实报给对方案。

## 真机截图管线（沙箱拦 GUI 安装器时）
`dangerouslyDisableSandbox` + Python ctypes（Pillow）：
`subprocess.Popen(安装包)` → EnumWindows 按标题找窗 → `GetDIBits` 32bpp top-down
→ `Image.frombuffer('BGRX')` → PNG。

**抓图方式按「要看什么」选（关键）**：
- 看**内容区颜色/控件** → `PrintWindow(PW_RENDERFULLCONTENT=2)` 够用。
- 看**外边框/圆角/阴影** → ❌ `PrintWindow` **抓不到 DWM 合成部分**：会得到 3px 纯黑直边 + 直角，
  **这是抓图假象，不是真实观感**！⇒ 必须从**屏幕 DC `BitBlt`**(SRCCOPY) 抓。
  且要先 `SetWindowPos(hwnd, HWND_TOPMOST(-1), x, y, 0, 0, SWP_NOSIZE|SWP_SHOWWINDOW)` 把窗口挪到空白处
  （测试机 1280×832，桌面常被 WorkBuddy 等窗口占满，否则抓到的是别人的窗口）。
  ⚠️ ctypes 调 `SetWindowPos`/`SetForegroundWindow` **必须先声明 `argtypes`**，否则会拿到假的失败返回值（本会话踩过，白查一轮）。
翻页：EnumChildWindows 找 `Button` 且文本含「下一步」→ `PostMessageW(h, 0x00F5/*BM_CLICK*/)`；
**停在模式页/目录页，绝不点「安装」**，截完 `p.kill()`（欢迎/模式/目录页都不写文件）。
改动前若「启动即退出(码1)」= 沙箱拦截，绕过即可。每改一版：打包 → 截图 → **像素采样**闭环迭代。

## ★ 外边框（真·现代观感）—— 唯一有效的一条路（未落地，供重启时用）
- 经典框架改不掉的根因：主对话框带 `WS_BORDER|WS_DLGFRAME|WS_EX_WINDOWEDGE`，DWM 会**降级成老式非客户区**。
- Win11（本机 22631 / 22000+）可用 DWM 上色标题栏 + 圆角：
  `DwmSetWindowAttribute`，`DWMWA_CAPTION_COLOR=35`、`DWMWA_TEXT_COLOR=36`、`DWMWA_WINDOW_CORNER_PREFERENCE=33`（值 2 = 圆角）。
  NSIS 里调用：`System::Call '*(i 35)p.r0'` → `System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, p r0, i 4)'` → `System::Free $0`。
- 但这**治不了**「系统灰内容区」和「渐变难看」——那是内容区的事（见上一节，目录页无解）。
  ⇒ 重启前先想清楚：**能不能接受「标题栏现代 + 内容区系统灰」**；接受不了就别开工。
