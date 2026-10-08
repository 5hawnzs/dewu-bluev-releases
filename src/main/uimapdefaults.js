'use strict';
/**
 * ★★ 出厂内置的 **UI 定位表**（publish.uiMap）—— 打进安装包，装上即用。
 *   ★ 本文件由 `node tools/build-uimapdefaults.js` 生成，**别手改** —— 改完重跑会被覆盖。
 *
 * 规矩（与 clouddefaults / llmdefaults 同一套）：
 *   `store.get('publish.uiMap')` 只在**本机没有这个键**（undefined）时兜底成这里的表，
 *   **绝不写回 config.json** ⇒ 以后换新表、重发包，各台升级后自动跟随（不会被焊死在旧表上）。
 *   ★ 显式写成 null 是另一回事：「我就是要没有表」—— 那时**不许**被内置值顶掉。
 *   ★ 用户自己抓/导入的表**优先于**这里。兜底实现在 store.withBuiltinMap()。
 *
 * ★ screen 是**抓取时的坐标系戳**：运行时（uimap.screenMismatch）拿它和当下设备尺寸比，
 *   对不上就**当场拦下**，而不是让写死的坐标静默点偏（input tap 对越界坐标 rc=0、什么都不点）。
 *   源表没带 screen 时由 build 工具按 --screen 推断，且必须过「唯一性」自检才会写进来。
 */
module.exports = {
  "package": "com.shizhuang.duapp",
  "generatedAt": 1791011572378,
  "screen": {
    "w": 1080,
    "h": 1920,
    "landscape": false,
    "at": 1791011572378
  },
  "note": "★ 2026-10-03 真机实测（MuMu 12 / 得物 900x1600）· v4。\n相对 v2 的变化：\n  ① 「关联好物」那一段**按 3 个好物各配一遍**（发布单列：好物1~3 货号 / 好物1~3 颜色），\n     用条件步骤 when / whenNot 守卫 ⇒ 空着的那几个好物整段跳过，不会把搜索页打开却不选商品。\n  ② 话题 1~5 也加了 when 守卫 ⇒ 空的几列真的不写（老版本是配几步写几步，多出来的那几列静默不写）。\n  ③ 选商品改为「按颜色选那一格」，没填颜色时才退化成「选第 1 格」。\n\n⚠ 需要 App 支持条件步骤（when / whenNot）与 ${goods1Sku}/${goods1Color} 占位符 ——\n   这两项是 2026-10-03 随本表一起加进源码的，**旧版本 App 导入本表不会报错，但条件会被忽略**\n   （那时 3 个好物段会全部执行 ⇒ 空货号段把搜索页打开却不选 ⇒ 整条崩）。所以：\n   **旧版本 App 请不要导入本表**，先升级；或者把好物2 / 好物3 两段整段删掉再用。\n\n每个步骤的 verified 含义：true = 真在某一屏的 dump 里**亲眼看到过那个 id / 那段文字**；\nfalse = 结构对得上但**没有真机走过这一步**。\n★ 2026-10-03（下午）加：图文的「选图」那一步带 count＝${imageCount} ⇒ 一条内容能发多张图（这个叶子有几张就点几张）。 ／ 2026-10-03 真机修正：① 好物颜色那三步从 tapText 改成 tapCardText（点颜色文字只会弹「选择商品规格」，点商品图才等于选中整卡）；② 相册「选 N 张」已真机走通（点 N 个 flThumbSelect → 「下一步 (N)」→ 编辑页）；③ 标题/正文中文经 ADBKeyboard 广播实测打得进去。\n\n★ 2026-10-03（第二十九轮）加：入口那一跳后面多了一步「草稿箱拦截」（action=tapId，value=fl_publish，**whenOn=iv_draft_title**）。原因：草稿箱非空时「我→主页→发布新动态」落的是草稿箱 DraftActivity 而不是相册，没有这一步就会卡死在下一跳（真机实测：点 fl_publish 能出到相册）。\n这一步需要 App 支持 **whenOn / whenNotOn**（屏幕守卫）。旧版本 App 不认识这两个键 ⇒ 会**无条件点 fl_publish**；那颗按钮只在草稿箱出现，正常流程里点了等于「在相册页点空白」，不会错点，但**仍建议先升级 App 再导入本表**。\n同时修掉图文/视频不一致：视频那套的「按颜色选那一格」原来还是 tapText（点颜色文字只弹「选择商品规格」，不选卡）—— 已与图文一致改成 tapCardText。\n\n★ 2026-10-03（第二轮提速）改了两处：\n① 把 4~5 颗**坐标实测稳定**的按钮从 tapId 改成 **tapXY**（直点坐标、不再抓屏）。实测这台模拟器 `uiautomator dump` 一次 ~700-1500ms，而 `input tap` 只要 ~120ms；一条内容 21 个点击步，抓屏是绝对大头。\n★ 为什么只改这几颗：实测**编辑页坐标会随素材类型移动** —— 图片模式 etTitle 在 y=308、视频模式在 y=444（差 136px）。硬写坐标猜错＝点空，标题正文没填进去却**不报错**，帖子照发出去是空白的（静默失败）。所以 etTitle / etTrendContent / tvRelevantProduct 保留抓屏。\n② 把「等搜索页加载 / 等结果出来」两条固定等待从 1200/2000ms 压到 400/600ms：后面的点击步本来就有 3 次重试（每次重试先抓屏再找），固定 sleep 等于白等。\n★ 想回到最保险的老行为：把 tapXY 换回 tapId（value 填同样的 resource-id），并把 value 里的等待毫秒数改回去即可。备份见 config.json.bak-before-speed。\n\n★ 2026-10-03（第三轮）：入口那 3 颗（我 / 主页 / 发布新动态）保持 tapXY，但**每颗后面补了显式等待**（1200/1800/600ms）。实测：不加等待时连点太快，第 3 下会点到还没渲染好的页面上（3 次里 1 次落到了 CloudPixActivity）；加等待后 3 次冷启动全部稳定落到相册。\ntvPublish（提交发布）与 flNextStep（下一步）**退回 tapId**（抓屏）—— 盲点失败是静默的：tvPublish 点空＝帖子没发出去但工具记成功，不能接受。\n\n★ 2026-10-03（第四轮 · 收口）：盲点坐标只保留了第 1 步「底部我」（App 全局底栏，冷启动实测 3/3 都在，且点不到会在下一步**直接报错**）。第 2、3 步（右上角主页 / 发布新动态）**退回 tapId** —— 实测「发布新动态」在主页里的位置会随上方内容变（3 次成功后仍有 1 次没点中，停在个人页），而盲点失败是静默的（界面看着正常、这一步其实没做成）。\n引擎侧另做了三件不依赖坐标提速的事：① 抓屏 rm/dump/cat 合成一条 shell；② 屏幕守卫步复用刚抓到的结构（原来一个守卫步抓两次屏）；③ 点击步的重试不再叠 dumpEx 内部的 1200ms 重试。\n\n★ 2026-10-03（第三十四轮）· 素材隔离到专属相册：\n① 素材不再推到 /sdcard/DCIM/Camera（那是个聚合目录，设备上所有素材混在一起），\n   改推到 /sdcard/DCIM/Camera/bluev；每条推之前 App 会把这个目录清空\n   （清 MediaStore 记录 = 连物理文件一起删，实测）。\n② 定位表：「切到照片页签」「切到视频页签」两步**删掉**，换成「点开相册选择器 → 选 ${albumName}」两步。\n   为什么页签不用切：专属相册里只有本条素材，而一条内容要么全是图要么全是视频 ⇒\n   默认的「全部」页签第一屏就是它（实测：往 bluev 推一个 3 秒视频，切进去第一格就是它）。\n③ 收益：这一屏上只有本条素材 ⇒ 「点前 N 格」= 真·全选，不再怕上一条的素材/僵尸记录把次序顶歪；\n   同时省掉一次页签点击（每步 tapText 要抓一次屏，~1.5s）。\n★ 需要 App 支持 ${albumName} 占位符与 adb.clearMediaDir —— 旧版本 App 导入本表后\n  ${albumName} 会被替换成**空串** ⇒ 「选相册」那一步会变成点空白处（不会乱发，但会卡住）。所以先升级 App 再导入本表。",
  "videoNote": "视频比图文多两屏：① 剪辑页（右下角「下一步」= flNextStep）；② 封面页（「跳过」= tv_skip）。\n按已拍板的口径用得物自带封面 ⇒ 点「跳过」。「关联好物」那一段图文/视频完全一样。",
  "steps": [
    {
      "name": "未完成草稿拦截 · 点「放弃」（★ 起手先清掉上一轮留下的弹窗）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvCancel",
      "whenOn": "com.shizhuang.duapp:id/tvCancel",
      "hint": "★ 带屏幕守卫（whenOn=tvCancel）：只有这一屏真出现「你有未编辑完的视频动态」才点「放弃」；正常发布（没这个弹窗）时**整步跳过、一个像素都不碰**。为什么点「放弃」：本次要发的是队列里那一条新内容；点「继续」会接着编上一轮中断留下的旧半成品，发出一条没标题没正文的残次品（比卡住更糟）。为什么有两份：这一份负责「起手时弹窗就已经在屏幕上」（上一轮中断留下的），草稿箱拦截之后那份负责「点了发布新动态之后才弹出来」。"
    },
    {
      "name": "底部「我」（进个人页）",
      "action": "tapXY",
      "value": "945,1869",
      "hint": "★ tapXY：直点实测坐标 945,1869，**不抓屏**（原来按 id 抓一次屏 ~1s）。App 全局底部导航（第 5 格「我」）。冷启动首页实测中心；底栏不随页面滚动。",
      "verified": true,
      "fast": true,
      "whenNotOn": "com.shizhuang.duapp:id/rlPublish"
    },
    {
      "name": "右上角「主页」（已在主页 tab 则跳过）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvGoHomePage",
      "hint": "★ 2026-10-03 实测退回 tapId（抓屏）：主页是网络驱动的页面，「发布新动态」的位置会随上方内容变 —— 同一套等待 3 次成功后仍有 1 次没点中（停在个人页）。盲点失败是**静默**的，不能接受。",
      "verified": true,
      "fast": false,
      "whenNotOn": "com.shizhuang.duapp:id/rlPublish"
    },
    {
      "name": "右上角「主页」· 补点（上一步没跳走才点，幂等）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvGoHomePage",
      "whenOn": "com.shizhuang.duapp:id/tvGoHomePage"
    },
    {
      "name": "「发布新动态」",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/rlPublish",
      "hint": "★ 2026-10-03 实测退回 tapId（抓屏）：主页是网络驱动的页面，「发布新动态」的位置会随上方内容变 —— 同一套等待 3 次成功后仍有 1 次没点中（停在个人页）。盲点失败是**静默**的，不能接受。",
      "verified": true,
      "fast": false
    },
    {
      "name": "草稿箱拦截 · 点底部「发布新动态」出到相册（只有真落到草稿箱时才点）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/fl_publish",
      "hint": "★★ 2026-10-03 真机实测（MuMu 12 / 1080×1920）：草稿箱非空时，「我→主页→发布新动态」这最后一跳打开的是**草稿箱**（media.activity.DraftActivity），不是相册。定位表原来没有这一步 ⇒ 下一条「切到照片页签」当场找不到节点，整条卡死。\n出口：点底部那颗 fl_publish（实测居中 (540,1871)、clickable=true），真机验证过它会进 TotalPublishProcessActivity（相册：全部/照片/视频 三页签 + flThumbSelect×N）。\n判据用 whenOn = iv_draft_title（草稿箱标题 id）：实测它在相册页的 dump 里出现 **0 次** ⇒ 正常进发布页时这一步**整步跳过、一个像素都不碰**。",
      "verified": true,
      "whenOn": "com.shizhuang.duapp:id/iv_draft_title"
    },
    {
      "name": "未完成草稿拦截 · 点「放弃」（只有真弹出「是否继续编辑」时才点）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvCancel",
      "whenOn": "com.shizhuang.duapp:id/tvCancel",
      "hint": "★ 带屏幕守卫（whenOn=tvCancel）：只有这一屏真出现「你有未编辑完的视频动态」才点「放弃」；正常发布（没这个弹窗）时**整步跳过、一个像素都不碰**。为什么点「放弃」：本次要发的是队列里那一条新内容；点「继续」会接着编上一轮中断留下的旧半成品，发出一条没标题没正文的残次品（比卡住更糟）。为什么有两份：这一份负责「起手时弹窗就已经在屏幕上」（上一轮中断留下的），草稿箱拦截之后那份负责「点了发布新动态之后才弹出来」。"
    },
    {
      "name": "选中要发的图（前 N 张，N＝这个叶子的图片数）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/flThumbSelect",
      "count": "${imageCount}",
      "hint": "★ 缩略图没有文字也没有描述，只能按 id 点。\n★ 2026-10-03 加：count 写 ${imageCount} ⇒ **这个叶子有几张图就点前几格**（一次点前 N 个匹配）。\n  不写 count 就是老行为：只点第 1 张（其余图早就推上设备了，但没被选中）。\n⚠ 相册按**时间倒序** ⇒ 点的是最前面 N 格；封面是不是你想要的那张，取决于推送顺序（未真机验证）。\n⚠「刚推上去的最新素材一定在第 1 格」仍未真机验证：这台 MuMu 的媒体扫描广播不生效（实测等 180.6s 仍未索引到），要重启模拟器才会收录。",
      "verified": true
    },
    {
      "name": "下一步",
      "action": "tapXY",
      "value": "985,1843",
      "hint": "★★ 2026-10-04 真机实测改成**盲点固定坐标**：flNextStep（选中素材之后才出现）bounds=[891,1794][1080,1892] → 中心 (985,1843)。★ 失败不静默：选素材没成功时这颗不存在，盲点无效 ⇒ 后面「剪辑页 · 下一步」(tapId) 会如实报错。",
      "verified": true,
      "fast": true
    },
    {
      "name": "图片编辑页 · 下一步（选多张图才会出现这一屏）",
      "action": "tapXY",
      "value": "985,1843",
      "whenOn": "com.shizhuang.duapp:id/edit_panel",
      "hint": "★★ 2026-10-04 真机实测改成**盲点固定坐标**：这一屏 tvNextStep 与相册/剪辑页那颗同一位置 → 中心 (985,1843)（用户说「图文就点一下」）。★ 守卫 whenOn=edit_panel **不能删**：单选图没有这一屏，盲点无条件点下去会落到编辑页底部的「发布」上 ⇒ 误发。",
      "verified": true,
      "fast": true
    },
    {
      "name": "点标题输入框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etTitle",
      "hint": "★ 中文走 ADBKeyboard 广播，广播只发给**当前有焦点**的输入框 ⇒ 不先点一下，字打不进去。",
      "verified": true
    },
    {
      "name": "填标题",
      "action": "input",
      "value": "${title}",
      "hint": "占位符运行时替换。",
      "verified": true
    },
    {
      "name": "点正文输入框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etTrendContent",
      "hint": "同「点标题」：必须先聚焦。实测 bounds [0,432][900,741]。",
      "verified": true
    },
    {
      "name": "填正文",
      "action": "input",
      "value": "${body}",
      "hint": "正文里不要带 #（话题单独走话题列）。",
      "verified": true
    },
    {
      "name": "话题 1",
      "action": "input",
      "value": "${topic1}",
      "when": "topic1",
      "hint": "★ 2026-10-03 用户拍板：话题**不做联想点选**，给几个写几个。话题是往**正文框**里继续打的（焦点还在 etTrendContent）⇒ 前面不需要再点输入框。\n★ when 守卫：这一列空着就跳过（老版本是配几步写几步）。",
      "verified": true
    },
    {
      "name": "话题 2",
      "action": "input",
      "value": "${topic2}",
      "when": "topic2",
      "hint": "同上。",
      "verified": true
    },
    {
      "name": "话题 3",
      "action": "input",
      "value": "${topic3}",
      "when": "topic3",
      "hint": "同上。",
      "verified": true
    },
    {
      "name": "话题 4",
      "action": "input",
      "value": "${topic4}",
      "when": "topic4",
      "hint": "同上。",
      "verified": true
    },
    {
      "name": "话题 5",
      "action": "input",
      "value": "${topic5}",
      "when": "topic5",
      "hint": "同上。",
      "verified": true
    },
    {
      "name": "好物1 · 点「关联好物」这一行",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvRelevantProduct",
      "when": "goods1Sku",
      "hint": "★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。",
      "verified": true,
      "waitEnabled": true,
      "waitEnabledTries": 25
    },
    {
      "name": "好物1 · 等搜索页加载",
      "action": "waitId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods1Sku",
      "hint": "★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。",
      "timeout": 10000
    },
    {
      "name": "好物1 · 点搜索框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods1Sku",
      "hint": "★ 必须单独一步：input 动作只是「往当前有焦点的框发广播」，它**不点输入框** —— 刚打开这一页焦点不在搜索框上，直接 input 打不进去（而且不报错）。\n实测 bounds [30,163][870,215]。",
      "verified": true
    },
    {
      "name": "好物1 · 输「货号+颜色」",
      "action": "input",
      "value": "${goods1Sku}${goods1Color}",
      "when": "goods1Sku",
      "hint": "★ 实测（2026-10-03 12:16 探针）：**每次打开这个搜索页，搜索框都是空的**（空的时候显示占位文字「搜索好物」）\n⇒ **不需要**先点 × 清空。而且搜索框为空时右侧那个 ivClear **根本不存在** ⇒ 无条件点它会硬失败，千万别写进去。",
      "verified": true
    },
    {
      "name": "好物1 · 等结果出来",
      "action": "wait",
      "value": 600,
      "when": "goods1Sku",
      "hint": "★ 2026-10-03 提速：2000→600 ms —— 后面的点击步有 3 次重试兜底，固定 sleep 是白等。"
    },
    {
      "name": "好物1 · 选结果第 1 格",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/ivProduct",
      "when": "goods1Sku",
      "hint": "★ 单色货号（颜色列可以是空的）走这条退路。\n为什么点 ivProduct：卡片根是**无 id 无文字的可点 ViewGroup**，现有三种找法（tapText/tapId/tapDesc）都点不到它；\n但它第 1 个子节点是商品大图 ivProduct ⇒ 点图心会落进卡片范围，Android 把点击交给可点的卡片根。\ntapId 取第一个匹配 ⇒ 永远是**第 1 个搜索结果**。",
      "verified": false
    },
    {
      "name": "好物2 · 点「关联好物」这一行",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvRelevantProduct",
      "when": "goods2Sku",
      "hint": "★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。",
      "verified": false,
      "waitEnabled": true,
      "waitEnabledTries": 25
    },
    {
      "name": "好物2 · 等搜索页加载",
      "action": "waitId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods2Sku",
      "hint": "★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。",
      "timeout": 10000
    },
    {
      "name": "好物2 · 点搜索框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods2Sku",
      "hint": "同上。",
      "verified": false
    },
    {
      "name": "好物2 · 输「货号+颜色」",
      "action": "input",
      "value": "${goods2Sku}${goods2Color}",
      "when": "goods2Sku",
      "hint": "同好物1：搜索框每次打开都是空的。",
      "verified": false
    },
    {
      "name": "好物2 · 等结果出来",
      "action": "wait",
      "value": 600,
      "when": "goods2Sku",
      "hint": "★ 2026-10-03 提速：2000→600 ms —— 后面的点击步有 3 次重试兜底，固定 sleep 是白等。"
    },
    {
      "name": "好物2 · 选结果第 1 格",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/ivProduct",
      "when": "goods2Sku"
    },
    {
      "name": "好物3 · 点「关联好物」这一行",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvRelevantProduct",
      "when": "goods3Sku",
      "hint": "★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。",
      "verified": false,
      "waitEnabled": true,
      "waitEnabledTries": 25
    },
    {
      "name": "好物3 · 等搜索页加载",
      "action": "waitId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods3Sku",
      "hint": "★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。",
      "timeout": 10000
    },
    {
      "name": "好物3 · 点搜索框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods3Sku"
    },
    {
      "name": "好物3 · 输「货号+颜色」",
      "action": "input",
      "value": "${goods3Sku}${goods3Color}",
      "when": "goods3Sku"
    },
    {
      "name": "好物3 · 等结果出来",
      "action": "wait",
      "value": 600,
      "when": "goods3Sku",
      "hint": "★ 2026-10-03 提速：2000→600 ms —— 后面的点击步有 3 次重试兜底，固定 sleep 是白等。"
    },
    {
      "name": "好物3 · 选结果第 1 格",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/ivProduct",
      "when": "goods3Sku"
    },
    {
      "name": "提交发布",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvPublish",
      "hint": "★ tapXY 退回 tapId（2026-10-03 实测）：盲点的失败模式是**静默的** —— 点空之后界面看着还行，但这一步该做的事没做（tvPublish 点空＝帖子没发出去却记成功）。所以这两颗保留抓屏。",
      "verified": true,
      "fast": false
    }
  ],
  "videoSteps": [
    {
      "name": "未完成草稿拦截 · 点「放弃」（★ 起手先清掉上一轮留下的弹窗）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvCancel",
      "whenOn": "com.shizhuang.duapp:id/tvCancel",
      "hint": "★ 带屏幕守卫（whenOn=tvCancel）：只有这一屏真出现「你有未编辑完的视频动态」才点「放弃」；正常发布（没这个弹窗）时**整步跳过、一个像素都不碰**。为什么点「放弃」：本次要发的是队列里那一条新内容；点「继续」会接着编上一轮中断留下的旧半成品，发出一条没标题没正文的残次品（比卡住更糟）。为什么有两份：这一份负责「起手时弹窗就已经在屏幕上」（上一轮中断留下的），草稿箱拦截之后那份负责「点了发布新动态之后才弹出来」。"
    },
    {
      "name": "底部「我」（进个人页）",
      "action": "tapXY",
      "value": "945,1869",
      "verified": true,
      "fast": true,
      "hint": "★ tapXY：直点实测坐标 945,1869，**不抓屏**（原来按 id 抓一次屏 ~1s）。App 全局底部导航（第 5 格「我」）。冷启动首页实测中心；底栏不随页面滚动。",
      "whenNotOn": "com.shizhuang.duapp:id/rlPublish"
    },
    {
      "name": "右上角「主页」（已在主页 tab 则跳过）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvGoHomePage",
      "verified": true,
      "fast": false,
      "hint": "★ 2026-10-03 实测退回 tapId（抓屏）：主页是网络驱动的页面，「发布新动态」的位置会随上方内容变 —— 同一套等待 3 次成功后仍有 1 次没点中（停在个人页）。盲点失败是**静默**的，不能接受。",
      "whenNotOn": "com.shizhuang.duapp:id/rlPublish"
    },
    {
      "name": "右上角「主页」· 补点（上一步没跳走才点，幂等）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvGoHomePage",
      "whenOn": "com.shizhuang.duapp:id/tvGoHomePage"
    },
    {
      "name": "「发布新动态」",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/rlPublish",
      "verified": true,
      "fast": false,
      "hint": "★ 2026-10-03 实测退回 tapId（抓屏）：主页是网络驱动的页面，「发布新动态」的位置会随上方内容变 —— 同一套等待 3 次成功后仍有 1 次没点中（停在个人页）。盲点失败是**静默**的，不能接受。"
    },
    {
      "name": "草稿箱拦截 · 点底部「发布新动态」出到相册（只有真落到草稿箱时才点）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/fl_publish",
      "verified": true,
      "whenOn": "com.shizhuang.duapp:id/iv_draft_title",
      "hint": "★★ 2026-10-03 真机实测（MuMu 12 / 1080×1920）：草稿箱非空时，「我→主页→发布新动态」这最后一跳打开的是**草稿箱**（media.activity.DraftActivity），不是相册。定位表原来没有这一步 ⇒ 下一条「切到照片页签」当场找不到节点，整条卡死。\n出口：点底部那颗 fl_publish（实测居中 (540,1871)、clickable=true），真机验证过它会进 TotalPublishProcessActivity（相册：全部/照片/视频 三页签 + flThumbSelect×N）。\n判据用 whenOn = iv_draft_title（草稿箱标题 id）：实测它在相册页的 dump 里出现 **0 次** ⇒ 正常进发布页时这一步**整步跳过、一个像素都不碰**。"
    },
    {
      "name": "未完成草稿拦截 · 点「放弃」（只有真弹出「是否继续编辑」时才点）",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvCancel",
      "whenOn": "com.shizhuang.duapp:id/tvCancel",
      "hint": "★ 带屏幕守卫（whenOn=tvCancel）：只有这一屏真出现「你有未编辑完的视频动态」才点「放弃」；正常发布（没这个弹窗）时**整步跳过、一个像素都不碰**。为什么点「放弃」：本次要发的是队列里那一条新内容；点「继续」会接着编上一轮中断留下的旧半成品，发出一条没标题没正文的残次品（比卡住更糟）。为什么有两份：这一份负责「起手时弹窗就已经在屏幕上」（上一轮中断留下的），草稿箱拦截之后那份负责「点了发布新动态之后才弹出来」。"
    },
    {
      "name": "选中要发的视频（相册第 1 格）",
      "action": "tapXY",
      "value": "166,359",
      "hint": "★★ 2026-10-04 真机实测改成**盲点固定坐标**（用户指出：选择图标路径很明显，直接点）：这一屏 uiautomator dump 要 **2085ms**，input tap 只要 **125ms**（16×）。选择圆点 flThumbSelect（第 1 格）bounds=[122,315][210,403] → 中心 (166,359)；点后屏上出现「下一步 (1)」、ivThumbSelect selected=true。★ 第 1 格位置恒定（网格固定 + 清相册后这一屏只有本条素材）。",
      "verified": true,
      "fast": true
    },
    {
      "name": "下一步（离开相册）",
      "action": "tapXY",
      "value": "985,1843",
      "verified": true,
      "fast": true,
      "hint": "★★ 2026-10-04 真机实测改成**盲点固定坐标**：flNextStep（选中素材之后才出现）bounds=[891,1794][1080,1892] → 中心 (985,1843)。★ 失败不静默：选素材没成功时这颗不存在，盲点无效 ⇒ 后面「剪辑页 · 下一步」(tapId) 会如实报错。"
    },
    {
      "name": "等下一屏（转场，盲点没有抓屏 ⇒ 只能固定等）",
      "action": "wait",
      "value": 1200
    },
    {
      "name": "剪辑页 · 下一步",
      "action": "tapXY",
      "value": "985,1843",
      "hint": "★★ 2026-10-04 真机实测改成**盲点固定坐标**：剪辑页 flNextStep bounds=[891,1794][1080,1892] → 中心 (985,1843)（与相册页那颗 bounds 完全相同）。配合下一步「封面页」= 同一坐标 ⇒ 就是用户说的「选完素材连点两下」。",
      "verified": true,
      "fast": true
    },
    {
      "name": "等下一屏（转场，盲点没有抓屏 ⇒ 只能固定等）",
      "action": "wait",
      "value": 1200
    },
    {
      "name": "封面页 · 跳过（不设置封面，直接下一步）",
      "action": "tapXY",
      "value": "820,1857",
      "hint": "★★ 2026-10-04 真机实测：封面页有**两个出口** —— 右边「下一步」tvNextStep[926,1829][1045,1885] 会进**又一屏「编辑封面」**（还得再点一下才到编辑页，实测多花一屏）；左边「跳过」tv_skip[761,1829][880,1885] 直接到编辑页。⇒ 盲点必须打在**跳过那颗**的中心 820,1857，不是右边那颗。这就是用户说的「连点两下即可跳过封面页」：上一步点剪辑页的「下一步」，这一步点封面页的「跳过」。",
      "verified": true,
      "fast": true
    },
    {
      "name": "点标题输入框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etTitle",
      "verified": true
    },
    {
      "name": "填标题",
      "action": "input",
      "value": "${title}",
      "verified": true
    },
    {
      "name": "点正文输入框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etTrendContent",
      "verified": true
    },
    {
      "name": "填正文",
      "action": "input",
      "value": "${body}",
      "verified": true
    },
    {
      "name": "话题 1",
      "action": "input",
      "value": "${topic1}",
      "when": "topic1",
      "verified": true
    },
    {
      "name": "话题 2",
      "action": "input",
      "value": "${topic2}",
      "when": "topic2",
      "verified": true
    },
    {
      "name": "话题 3",
      "action": "input",
      "value": "${topic3}",
      "when": "topic3",
      "verified": true
    },
    {
      "name": "话题 4",
      "action": "input",
      "value": "${topic4}",
      "when": "topic4",
      "verified": true
    },
    {
      "name": "话题 5",
      "action": "input",
      "value": "${topic5}",
      "when": "topic5",
      "verified": true
    },
    {
      "name": "好物1 · 点「关联好物」这一行",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvRelevantProduct",
      "when": "goods1Sku",
      "hint": "★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。",
      "verified": true,
      "waitEnabled": true,
      "waitEnabledTries": 25
    },
    {
      "name": "好物1 · 等搜索页加载",
      "action": "waitId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods1Sku",
      "hint": "★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。",
      "timeout": 10000
    },
    {
      "name": "好物1 · 点搜索框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods1Sku",
      "verified": true
    },
    {
      "name": "好物1 · 输「货号+颜色」",
      "action": "input",
      "value": "${goods1Sku}${goods1Color}",
      "when": "goods1Sku",
      "verified": true
    },
    {
      "name": "好物1 · 等结果出来",
      "action": "wait",
      "value": 600,
      "when": "goods1Sku",
      "hint": "★ 2026-10-03 提速：2000→600 ms —— 后面的点击步有 3 次重试兜底，固定 sleep 是白等。"
    },
    {
      "name": "好物1 · 选结果第 1 格",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/ivProduct",
      "when": "goods1Sku",
      "verified": false
    },
    {
      "name": "好物2 · 点「关联好物」这一行",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvRelevantProduct",
      "when": "goods2Sku",
      "verified": false,
      "waitEnabled": true,
      "hint": "★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。",
      "waitEnabledTries": 25
    },
    {
      "name": "好物2 · 等搜索页加载",
      "action": "waitId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods2Sku",
      "hint": "★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。",
      "timeout": 10000
    },
    {
      "name": "好物2 · 点搜索框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods2Sku"
    },
    {
      "name": "好物2 · 输「货号+颜色」",
      "action": "input",
      "value": "${goods2Sku}${goods2Color}",
      "when": "goods2Sku"
    },
    {
      "name": "好物2 · 等结果出来",
      "action": "wait",
      "value": 600,
      "when": "goods2Sku",
      "hint": "★ 2026-10-03 提速：2000→600 ms —— 后面的点击步有 3 次重试兜底，固定 sleep 是白等。"
    },
    {
      "name": "好物2 · 选结果第 1 格",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/ivProduct",
      "when": "goods2Sku"
    },
    {
      "name": "好物3 · 点「关联好物」这一行",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvRelevantProduct",
      "when": "goods3Sku",
      "verified": false,
      "waitEnabled": true,
      "hint": "★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。",
      "waitEnabledTries": 25
    },
    {
      "name": "好物3 · 等搜索页加载",
      "action": "waitId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods3Sku",
      "hint": "★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。",
      "timeout": 10000
    },
    {
      "name": "好物3 · 点搜索框",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/etSearch",
      "when": "goods3Sku"
    },
    {
      "name": "好物3 · 输「货号+颜色」",
      "action": "input",
      "value": "${goods3Sku}${goods3Color}",
      "when": "goods3Sku"
    },
    {
      "name": "好物3 · 等结果出来",
      "action": "wait",
      "value": 600,
      "when": "goods3Sku",
      "hint": "★ 2026-10-03 提速：2000→600 ms —— 后面的点击步有 3 次重试兜底，固定 sleep 是白等。"
    },
    {
      "name": "好物3 · 选结果第 1 格",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/ivProduct",
      "when": "goods3Sku"
    },
    {
      "name": "提交发布",
      "action": "tapId",
      "value": "com.shizhuang.duapp:id/tvPublish",
      "hint": "★ tapXY 退回 tapId（2026-10-03 实测）：盲点的失败模式是**静默的** —— 点空之后界面看着还行，但这一步该做的事没做（tvPublish 点空＝帖子没发出去却记成功）。所以这两颗保留抓屏。",
      "verified": true,
      "fast": false
    }
  ]
};
