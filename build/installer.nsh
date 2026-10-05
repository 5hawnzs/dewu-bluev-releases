; 安装界面品牌化：整片底色改成与应用界面一致的品牌浅绿（styles.css --teal-bg #e1f5ee）
;
; 三条机制各管一层（都是实测换来的，别改回去）：
; A. MUI_BGCOLOR —— nsDialogs 页面（欢迎页/完成页）的 SetCtlColors 在页面宏展开时
;    编译期内联。electron-builder 模板顺序是 页面(assistedInstaller) → addLangs →
;    customHeader，所以必须在 include 期（本文件）就 define，才能赶上页面展开；
;    MUI_INTERFACE 的 MUI_DEFAULT 是 !ifndef 守卫，不会覆盖用户值。
;    颜色是 SetCtlColors 的 BBGGRR 格式："EEF5E1" 即 #e1f5ee。
; B. SetClassLongW 换背景画刷 —— 目录页/安装模式页/进度页是老式内层对话框，
;    不引用 MUI_BGCOLOR；NSIS 所有向导页共用同一个主对话框（#32770），在第一页
;    show 时换掉它的类背景画刷（GCLP_HBRBACKGROUND=-10）+ InvalidateRect，
;    一次设置后续页面继承。stub 是 32 位，user32 无 SetClassLongPtrW 导出，
;    必须用 SetClassLongW。
; C. .onGUIInit / MUI_CUSTOMFUNCTION_GUIINIT 都不可用：前者与 MUI2 生成的同名函数
;    重名（编译失败），后者 define 时 MUI_LANGUAGE 已过，编译期来不及。
;
; ❗ electron-builder 两遍编译：第一遍 !define BUILD_UNINSTALLER（只生成卸载器），
;    assistedInstaller 的页面插槽全在 !ifndef BUILD_UNINSTALLER 里 —— 函数若定义在
;    宏外，那一遍就是「未引用函数」警告（warning 6010），而 electron-builder 默认
;    -WX（警告即错误）直接失败。所以函数都定义在各自宏体里。
; ❗ 模板插槽语义：customWelcomePage 不是"回调注入点"，它**就是欢迎页本身**（模板
;    默认没有欢迎页）；customFinishPage 一旦定义会整体替换默认完成页，必须原样
;    复刻 StartApp 逻辑，否则"完成后运行"丢失。
; 本文件需带 UTF-8 BOM（makensis 对无 BOM 文件按 ANSI 读，中文注释会炸）。

!define MUI_BGCOLOR "EEF5E1"

!macro brandApplyBg
  System::Call 'gdi32::CreateSolidBrush(i 0xEEF5E1)p.r0'
  System::Call 'user32::SetClassLongW(p $HWNDPARENT, i -10, p r0)'
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, i 0, i 1)'
  SetCtlColors $HWNDPARENT "" 0xEEF5E1
!macroend

; 欢迎页（第一页）：主对话框画刷在这里换一次，后续所有页面继承；
; nsDialogs 子对话框（右半内容区）由 MUI_BGCOLOR 管。
!macro customWelcomePage
  Function brandShowWelcome
    !insertmacro brandApplyBg
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW brandShowWelcome
  !insertmacro MUI_PAGE_WELCOME
!macroend

; 模板里 customPageAfterChangeDir 的展开位置紧跟 MUI_PAGE_INSTFILES，
; 所以这个 SHOW define 实际挂在「安装进度」页上（兜底，正常情况用不到）。
!macro customPageAfterChangeDir
  Function brandShowInstFiles
    !insertmacro brandApplyBg
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW brandShowInstFiles
!macroend

; 完成页：本宏整体替换模板默认实现 —— StartApp 逻辑照抄 assistedInstaller.nsh，勿删。
!macro customFinishPage
  Function brandShowFinish
    !insertmacro brandApplyBg
  FunctionEnd
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW brandShowFinish
  !insertmacro MUI_PAGE_FINISH
!macroend
