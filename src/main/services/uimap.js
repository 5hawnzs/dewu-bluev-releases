'use strict';
/**
 * UI 定位表：得物 App 的页面结构不能靠猜，靠「抓一次 dump 配一次」。
 * 这里负责：dump → 节点解析 / 按文本或 resource-id 找节点 / 自动生成候选步骤。
 */
function parseNodes(xml) {
  const nodes = [];
  const re = /<node\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = {};
    const ar = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attr[a[1]] = a[2];
    const b = (attr.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const box = b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null;
    nodes.push({
      text: attr.text || '',
      desc: attr['content-desc'] || '',
      id: attr['resource-id'] || '',
      cls: attr.class || '',
      pkg: attr.package || '',
      clickable: attr.clickable === 'true',
      // ★★ 2026-10-04：必须保留 enabled —— 得物「关联好物」那一行在**自动识别视频好物**期间
      //   是 `clickable=true` 但 **`enabled=false`**（真机实测 t0/t1 两屏都是）。
      //   少了这个字段就没法判「它现在到底能不能点」⇒ 点了没反应，而报错会指向后面那一步
      //   （离真因很远）。见 publisher 的 waitEnabled。
      enabled: attr.enabled !== 'false',   // 属性缺省时 uiautomator 的语义就是可用
      bounds: attr.bounds || '',
      box,
      center: box ? { x: Math.round((box.x1 + box.x2) / 2), y: Math.round((box.y1 + box.y2) / 2) } : null
    });
  }
  return nodes;
}

function findNodes(nodes, cond) {
  const { text, id, desc, contains } = cond || {};
  return nodes.filter(n => {
    if (id && n.id === id) return true;
    if (desc && n.desc === desc) return true;
    if (text && n.text === text) return true;
    if (contains && (n.text.includes(contains) || n.desc.includes(contains))) return true;
    return false;
  });
}

/** 取第一个匹配 —— 老行为，绝大多数步骤就是「找到那一个、点它」 */
function findNode(nodes, cond) {
  return findNodes(nodes, cond)[0] || null;
}

/**
 * ★★ 「点前 N 个匹配」—— 2026-10-03 加，用户当天追问「什么叫做只能发第一张图片？？」。
 *
 * 为什么必须有：得物相册里选素材就是**点缩略图**，而缩略图**没有文字也没有描述**，
 * 只能按 resource-id 点；而原来的 tapId 取的是**第一个**匹配节点 ⇒
 * 一条内容有多张图时**只会选上第 1 张**（其余图早就推上设备了，只是没被点中）。
 * ★ 这**不是通道问题**（真机通道一模一样），是动作层缺了这个能力 ——
 *   所以不能靠「改用真实通道」绕过去，只能把能力补上。
 *
 * 张数从哪来：占位符 ${imageCount}（= 这个叶子文件夹里有几张图，见 publisher 里的 data）。
 * 为什么要卡上限：写错一个数（比如 999）会把相册从上往下一直点到别的界面去，
 *   而「点跑了」不会当场报错 —— 上限只挡离谱值，正常量级（1~18 张）不受影响。
 */
const MAX_TAP_COUNT = 20;
function countOf(v) {
  if (v == null || v === '') return 1;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_TAP_COUNT);
}

/**
 * ★ tapXY 的坐标解析（2026-10-03）：'540,1871' 或 '540,1871;300,200'（分号分隔多个点）。
 *
 * 解析不出任何点就返回 **空数组** —— 调用方（normalizeSteps / runStep）拿到空数组必须当场报错。
 * 为什么不能「解析不出就当 (0,0)」：那会点到屏幕左上角，在得物上等于乱点，
 * 而且不报错 ⇒ 用户只看到「发了篇奇怪的东西」，最难查。
 */
function parsePoints(value) {
  const out = [];
  String(value == null ? '' : value).split(/[;；\n]+/).forEach(seg => {
    const m = /^\s*(-?\d+)\s*[,，]\s*(-?\d+)\s*$/.exec(seg);
    if (m) out.push({ x: Number(m[1]), y: Number(m[2]) });
  });
  return out;
}

/**
 * ★★★ 2026-10-04 新增：`tapXY` 的**坐标空间守卫**（纯函数，喂输入就能测全分支）。
 *
 * 为什么非要有：定位表里的 `tapXY` 是**写死的绝对坐标**，它只在「抓表时那个坐标系」里成立。
 * 而坐标系由**当前前台应用的方向 / 模拟器分辨率**决定，会变：
 *   · 同一台 MuMu 12，得物（竖屏锁定）在前台时 `dumpsys window displays` 是 `cur=1080x1920`；
 *     MuMu 桌面（横屏）在前台时是 `cur=1920x1080`，`screencap` 的 PNG 与 dump 的 bounds 全部跟着变成 1920x1080。
 *   · 更阴的一半：坐标系**变了但坐标仍落在屏内**（例如从 900x1600 的旧表 换到 1080x1920 的设备）
 *     ⇒ 越界校验抓不住，可每一个固定坐标都指到**别的元素**上。
 * 而 `input tap` 对越界坐标**不报错**（实测 rc=0、什么都没点到）⇒ 全程静默、日志一条错都没有。
 *
 * 所以分两层，各管一半：
 *   ① `outOfScreenTapPoints` —— 坐标落在当前屏幕之外（硬错，立刻报）；
 *   ② `screenMismatch`       —— 表里记的抓取尺寸 vs 当下尺寸对不上（另一种硬错，早报）。
 */

/** 一组步骤里**所有写死的坐标**（带出处），供越界校验与报错点名。只认 tapXY：
 *  tapId/tapText 的坐标是**当场从 dump 读**的，天然在当前坐标系里，不需要这层守卫。 */
function tapPointsOf(steps) {
  const out = [];
  for (const s of (steps || [])) {
    if (!s || s.action !== 'tapXY') continue;
    for (const p of parsePoints(s.value)) {
      out.push({ name: s.name || ('tapXY ' + s.value), value: String(s.value), x: p.x, y: p.y });
    }
  }
  return out;
}

/**
 * 写死的坐标里，哪些**落在当前屏幕之外**。
 * @param size = `adb.uiSize()` 的返回值（即 `dumpsys window displays` 的 `cur=`）。
 *   ★ `size.known !== true` ⇒ **返回空数组**（当「不知道」处理）。
 *   不拿猜出来的尺寸判「越界」—— 那是拿幻觉当判据，会误杀正常坐标。
 */
function outOfScreenTapPoints(steps, size) {
  if (!size || size.known !== true) return [];
  return tapPointsOf(steps).filter(p => !(p.x >= 0 && p.y >= 0 && p.x <= size.w - 1 && p.y <= size.h - 1));
}

/**
 * 这一条内容要走的步骤列表（**纯函数**）。
 *
 * 判据只有一条：**视频没单独配 videoSteps 就复用图文那一套** ——
 * 用户 2026-10-02 实测：「图文和视频的发布位置是一样的」，所以不该因为没配 videoSteps 就拦下不发。
 *
 * ★ 为什么把它单独抽出来（2026-10-04）：这段选择逻辑原来写在 publisher 里，
 *   而回归里只能用**正则去匹配那一行源码**（`const steps = isVideo ? …`）。
 *   结果我在别处重构时把那行的写法改动了一点，语义一字没变，测试却红了 ——
 *   这类「锁死写法」的断言既挡不住真问题，又每次重构都误报（正是「浪费时间」的来源之一）。
 *   抽成纯函数之后，测试可以直接喂三种输入验**语义**，不再依赖那行长什么样。
 */
function stepsFor(map, isVideo) {
  const m = map || {};
  const s = Array.isArray(m.steps) ? m.steps : [];
  const v = Array.isArray(m.videoSteps) ? m.videoSteps : [];
  return isVideo ? (v.length ? v : s) : s;
}

/**
 * 定位表**抓取时**的坐标系 vs **当下**的坐标系，是否对不上。
 * @param mapScreen  抓取时记下的 `{w,h}`（老表没有这个键 ⇒ judgeable=false，不拦，交给逐点越界那条）
 * @returns {{judgeable:boolean, mismatch:boolean, swapped:boolean, why:string}}
 */
function screenMismatch(mapScreen, live) {
  if (!mapScreen || !live || live.known !== true) return { judgeable: false, mismatch: false, swapped: false, why: '' };
  const mw = Number(mapScreen.w) || 0, mh = Number(mapScreen.h) || 0;
  if (!mw || !mh) return { judgeable: false, mismatch: false, swapped: false, why: '' };
  if (mw === live.w && mh === live.h) return { judgeable: true, mismatch: false, swapped: false, why: '' };
  const swapped = (mw === live.h && mh === live.w);
  return {
    judgeable: true, mismatch: true, swapped,
    why: `定位表是在 ${mw}x${mh}（${mw > mh ? '横屏' : '竖屏'}）下抓的，`
      + `现在这台设备是 ${live.w}x${live.h}（${live.landscape ? '横屏' : '竖屏'}）`
      + (swapped ? '—— 正好差了 90°（宽高互换）' : '—— 分辨率或方向变了')
  };
}

/**
 * 给定位表打一个**抓取时的坐标系**戳（`publish.dump` 生成时写进去，导入时保留）。
 * 有它，运行时才判得出「这张表是不是在另一个坐标系里量的」。
 */
function screenStamp(size) {
  if (!size || size.known !== true) return null;
  return { w: size.w, h: size.h, landscape: !!size.landscape, at: Date.now() };
}

/**
 * ★★ 「得物发布页」到底是哪一屏、怎么去 —— 真机实测（2026-10-01 / 2026-10-02，MuMu 12 / 得物 900×1600）：
 *   · 发布页 = `media.publish.activity.TotalPublishProcessActivity`，
 *     首屏是**选素材的相册**（顶部 全部 / 照片 / 视频 三个页签）。
 *   · 有**两条**入口路线，2026-10-02 实机逐跳验证：**都通向同一个发布页**。
 *     ① 动态流右上角相机 `ivCamera`：1 跳；★ 图标**无文字**（text/content-desc 皆空），
 *       只能按 id 点，而且它只在「动态」tab 上出现。
 *     ② 「我」→「主页」→「发布新动态」：3 跳；入口 `rlPublish`（可点容器）
 *       + 文字「发布新动态」**双保险**，起点是固定的底部导航 `tab_user`，不依赖内容流。
 *       ⇒ **推荐这条**（用户 2026-10-02 提供）。
 *   · ★★ 两条路线的终点是**同一屏**，而那一屏 `uiautomator dump` **抓不下来**
 *     （持续动画，永远等不到 idle）⇒ 程序已内置 dumpsys 备用通道（见 adb.js 的 dumpViaDumpsys）。
 */
const DEWU = {
  pkg: 'com.shizhuang.duapp',
  publishActivity: 'media.publish.activity.TotalPublishProcessActivity',
  // ★★ 2026-10-04 真机实测：「回主线」守卫用它把 App 拉回首页。
  //   本机实测两个事实：
  //     ① 得物的启动入口是 `.modules.home.ui.SplashActivity`（`cmd package resolve-activity --brief`
  //        查到的是它；`am start -n` 它即可，它自己会转 `HomeActivity`）；
  //     ② **`MainActivity` 不存在** —— 实测报 `Error type 3: Activity class does not exist`
  //        （差点就把它写进来了：写错了的表现是「每条都拉不起 App」，而报错看着像得物坏了）。
  //   ⇒ 只认这一个实测过的真名；守卫拿不到它时退回 `monkey`（绝不硬编码第二处）。
  launchActivity: '.modules.home.ui.SplashActivity',
  // 首页判据：定位表第一步是「底部点『我』」那个**固定坐标** —— 只有 App 在首页时，
  // 那个坐标底下才是底部导航。停在别的页时同一坐标底下是别的东西 ⇒ 必须先把 App 拉回首页。
  homeActivity: 'modules.home.ui.HomeActivity',
  // 路线①（老路径，保留下来作备用）
  entryId: 'com.shizhuang.duapp:id/ivCamera',
  // 路线②（推荐）：底部「我」→ 右上角「主页」→ 个人主页里的「发布新动态」
  route: [
    { id: 'com.shizhuang.duapp:id/tab_user', text: '我', how: '底部导航点「我」' },
    { id: 'com.shizhuang.duapp:id/tvGoHomePage', text: '主页', how: '点右上角「主页」，进个人主页' },
    { id: 'com.shizhuang.duapp:id/rlPublish', text: '发布新动态', how: '点「发布新动态」（在「全部」那一行的下面）' }
  ],
  // ★★ 2026-10-03 真机实测：**草稿箱不是终点，是一个拦截页**。
  //   草稿箱里还有没发完的草稿时，「我 → 主页 → 发布新动态」这最后一跳打开的
  //   不是发布页，而是 `media.activity.DraftActivity`：
  //     · 标题   iv_draft_title  text="草稿箱"
  //     · 出口   fl_publish      clickable=true，居中 (540,1871)，子节点文字「发布新动态」
  //   定位表原来没有这一步 ⇒ 下一条「切到照片页签」当场找不到节点，整条卡死。
  //   实测出口有效：点 fl_publish → TotalPublishProcessActivity（相册：全部/照片/视频 + flThumbSelect×N）。
  //   判据用 titleId（草稿箱独有）：实测它在相册页的 dump 里出现 **0 次**。
  draft: {
    activity: 'media.activity.DraftActivity',
    titleId: 'com.shizhuang.duapp:id/iv_draft_title',
    exitId: 'com.shizhuang.duapp:id/fl_publish'
  },
  // ★★ 2026-10-04 真机实测（新增）：**「是否继续编辑」拦截弹窗**。
  //   上一轮因为某种原因**没走完就中断**（比如中途报错、app 被杀、干跑到编辑页就停），
  //   得物会留下一条"未编辑完的视频动态"。之后再点「发布新动态」时它先弹这个窗：
  //     · 标题 tv_title   text="是否继续编辑"
  //     · 正文 tvContent  text="你有未编辑完的视频动态，是否继续？"（还带一张 imgDraftCover 封面）
  //     · 左   tvCancel   text="放弃"  (339,1173)-(531,1247)
  //     · 右   tvConfirm  text="继续"  (549,1173)-(741,1247)
  //   ⇒ 不处理的后果：整个脚本卡在这一屏、后面每一步都找不到节点，
  //     最后报「找不到 tvGoHomePage；当前可见文本：是否继续编辑 / …」（报错位置离真因很远）。
  //   为什么选「放弃」：我们要发的是**新内容**（队列里那一条），
  //     而"继续"是把那条**中断的旧半成品**接着编 —— 那不是本次要发的东西，
  //     接着编会发出一条没标题没正文的残次品（比卡住更糟）。
  //   ★ 判据用 tvContent 的**独有文字**（比 id 稳：tv_title/tvContent/tvCancel 在别的弹窗里也常见）。
  resumeDialog: {
    titleText: '是否继续编辑',
    hintText: '你有未编辑完的视频动态',
    dismissId: 'com.shizhuang.duapp:id/tvCancel',
    dismissText: '放弃'
  },
  entryHow: '两条路都到同一个发布页：① 动态流右上角相机图标（1 跳，但图标没文字）；'
    + '② 底部「我」→ 右上角「主页」→「发布新动态」（3 跳，推荐）。'
    + '到了发布页（首屏是选素材的相册，顶部有 全部/照片/视频 三个页签）再点「抓取页面结构」。'
    + '★ 注意：草稿箱里还有没发完的草稿时，第 3 跳打开的是**草稿箱**（DraftActivity）而不是发布页'
    + '（2026-10-03 真机实测）—— 定位表里那一步「草稿箱拦截」就是为它准备的'
};
/** 当前前台是不是得物（入参是 `dumpsys window` 里 mCurrentFocus 的原文） */
function isDewuFocus(focus) { return /shizhuang|duapp/i.test(String(focus || '')); }
/** 当前前台是不是**得物发布页**（而不是首页 / 别的页） */
function isPublishScreen(focus) { return /TotalPublishProcessActivity/.test(String(focus || '')); }
/**
 * 当前前台是不是**得物首页**（「回主线」守卫的判据）。
 * ★ 为什么必须限定「首页」而不是「在得物里就行」：定位表第一步是**固定坐标**点的底部「我」，
 *   而那个坐标只在首页上才是底部导航 —— 停在个人主页/相册页时同一坐标底下是别的东西。
 * ★ 只看 Activity 名，不去解析页面结构：这里要的是「可不可以开始点」这个**便宜**的判断，
 *   真每屏都抓一次结构就白花 1~2 秒（一屏抓一次的成本见 publisher 里 tapXY 那段实测）。
 */
function isHomeScreen(focus) {
  const s = String(focus || '');
  return isDewuFocus(s) && s.indexOf(DEWU.homeActivity) >= 0;
}
/**
 * ★★ 2026-10-04 新增：当前前台是不是**得物草稿箱**（`media.activity.DraftActivity`）。
 *
 * 为什么要单独有这么一条（用户口径：「发出去了才算成功」「真实发布环境不许存草稿」）：
 *   点「提交发布」之后如果能停在**草稿箱**，那不是"发完了"，而是**草稿被留下来了** ——
 *   用户的诉求是「不许存草稿」。判据只看 Activity 名（便宜），
 *   页面结构级的判据（`iv_draft_title`）留给需要更准的地方（那要多付一次抓屏）。
 */
function isDraftScreen(focus) {
  const s = String(focus || '');
  return isDewuFocus(s) && s.indexOf(DEWU.draft.activity) >= 0;
}

/** 按关键词在 dump 里猜一套候选步骤，用户改改就能用 */
function suggest(nodes, pkg, opts = {}) {
  const hit = (...keys) => nodes.filter(n => keys.some(k => n.text === k || n.desc === k || (n.text || '').includes(k)));
  const steps = [];
  const pushStep = (name, action, value, hint, extra) =>
    steps.push(Object.assign({ name, action, value, hint, unverified: true }, extra || {}));

  // ★★ 得物有**两条**入口路线，2026-10-02 实机逐跳验证：都通向同一个发布页。
  //    ① 动态流右上角相机 `ivCamera`：1 跳，但**图标无文字**，只能按 id 点；
  //    ② 「我」→ 右上角「主页」→「发布新动态」：3 跳，入口 **id + 文字双保险**，起点是固定底部导航。
  //    ⇒ 候选表按②生成（更稳），① 写进 hint 备用。
  const camId = (nodes.find(n => /(^|[:/])ivCamera$/.test(n.id)) || {}).id;
  const pubId = (nodes.find(n => /(^|[:/])rlPublish$/.test(n.id)) || {}).id;
  const pubTxt = nodes.find(n => (n.text || '') === '发布新动态');
  if (pubTxt || pubId) {
    pushStep('打开发布入口（「我」→「主页」→「发布新动态」，推荐）', 'tapText', '发布新动态',
      (pubId ? '也可以按 id 点：' + pubId + '（同一格，双保险）；' : '')
      + '这条入口有文字，比首页右上角那个没文字的相机图标稳'
      + (camId ? '（备用 id：' + camId + '）' : ''));
  } else if (camId) {
    pushStep('打开发布入口（得物动态流右上角相机图标，无文字）', 'tapId', camId,
      '那个相机图标 text/content-desc 都是空的，只能按 resource-id 点');
  } else {
    const pub = hit('发布', '发笔记', '创作')[0];
    if (pub) pushStep('打开发布入口', 'tapText', pub.text || pub.desc, '取自 dump 的匹配节点');
    else pushStep('打开发布入口', 'tapText', '发布', '⚠ dump 里没找到，需手动确认');
  }

  // ★★ 2026-10-03 真机实测：入口最后一跳**可能被草稿箱接走**。
  //   草稿箱非空时「我 → 主页 → 发布新动态」打开的是 `media.activity.DraftActivity`
  //   （标题「草稿箱」iv_draft_title，底部另有一颗同名按钮 fl_publish）。
  //   定位表少了这一步 ⇒ 下一步「切照片页签」当场找不到节点 ⇒ 整条卡死。
  //   ⇒ 无条件挂一步「带屏幕守卫的出口」：只有这一屏真是草稿箱才点，别的屏**一个像素都不碰**。
  //   实测出口有效：点它 → TotalPublishProcessActivity（相册，全部/照片/视频 三页签）。
  const DRAFT_HINT = '★ 带屏幕守卫（whenOn=' + DEWU.draft.titleId + '）：'
    + '只有当前这一屏出现草稿箱标题时才点；正常进发布页时**整步跳过、不发任何点击**。'
    + '为什么要有它：草稿箱非空时「我→主页→发布新动态」落的是草稿箱而不是相册（2026-10-03 真机实测）。'
    + '判据用标题 id 而不是文字 —— 实测它在相册页的 dump 里出现 0 次。';

  pushStep('草稿箱拦截 · 点底部「发布新动态」出到相册（只有真落到草稿箱时才点）', 'tapId',
    DEWU.draft.exitId, DRAFT_HINT, { whenOn: DEWU.draft.titleId });
  // ★★ 2026-10-04 真机实测新增：「是否继续编辑」拦截弹窗（见 DEWU.resumeDialog）。
  //   上一轮中断（报错/被杀/干跑停在编辑页）会留下"未编辑完的视频动态"，
  //   下次点「发布新动态」先弹它。不处理 ⇒ 整条卡住，报错还指不到这里。
  //   ★ 选「放弃」：本次要发的是**队列里那一条新内容**，「继续」会接着编旧半成品
  //     （发出一条没标题没正文的残次品，比卡住更糟）。
  //   ★ 带屏幕守卫（whenOn=tvContent 不成立就整步跳过、**一个像素都不碰**）。
  const RESUME_HINT = '★ 带屏幕守卫（whenOn=' + DEWU.resumeDialog.dismissId + ' 所在的这一屏）：'
    + '只有当前这一屏真出现「' + DEWU.resumeDialog.hintText + '」才点「' + DEWU.resumeDialog.dismissText + '」；'
    + '正常发布（没这个弹窗）时**整步跳过**。'
    + '为什么要点「放弃」：本次要发的是**队列里那一条新内容**；点「继续」会接着编上一轮中断留下的旧半成品，'
    + '发出一条没标题没正文的残次品（比卡住更糟）。';
  pushStep('未完成草稿拦截 · 点「放弃」（只有真弹出「是否继续编辑」时才点）', 'tapId',
    DEWU.resumeDialog.dismissId, RESUME_HINT, { whenOn: DEWU.resumeDialog.dismissId });
  pushStep('从相册选图', 'tapText', '相册', '选图入口，按实际页面改');
  pushStep('确认选图', 'tapText', '下一步', '部分版本叫 完成/确定');
  pushStep('填标题', 'input', '${title}', '占位符在运行时替换为生成好的标题');
  pushStep('填正文', 'input', '${body}', '占位符替换为正文');
  for (let i = 1; i <= 5; i++) {
    pushStep(`话题 ${i}（直接输入）`, 'input', '${topic' + i + '}', '2026-10-03 用户拍板：话题**不做联想点选** —— 给几个就写几个，不许挂到别的话题上');
  }
  pushStep('关联好物', 'tapText', '关联好物', '');
  pushStep('搜索货号', 'input', '${sku}', '');
  pushStep('提交发布', 'tapText', '发布', '最后一步的发布按钮');

  // ★ 2026-10-02 用户实测：**图文和视频的发布位置是一样的** ⇒ 平时**不用配这一套**，
  //   发布时 videoSteps 为空会自动复用 steps（见 publisher.run）。
  //   这里仍然生成一套候选，只是为了「万一哪天视频那条路和图文不一样」时能单独覆盖：
  //   真要用，就去得物「发布视频」页抓一次 dump，改这一套，别改 steps。
  const videoSteps = [];
  const vpush = (name, action, value, hint, extra) =>
    videoSteps.push(Object.assign({ name, action, value, hint, unverified: true }, extra || {}));
  // ★ 图文和视频走的是**同一个发布页**（2026-10-02 用户实测）⇒ 入口也必须是同一条，
  //   否则「视频复用图文」这件事只在 steps 那一侧成立、videoSteps 这一侧还指着老路。
  if (pubTxt || pubId) {
    vpush('打开发布入口（视频）', 'tapText', '发布新动态',
      '★ 图文和视频是**同一个发布页** ⇒ 入口同一条（「我」→「主页」→「发布新动态」），'
      + '进去之后再切「视频」页签' + (camId ? '；备用 id：' + camId : ''));
  } else if (camId) {
    vpush('打开发布入口（视频）', 'tapId', camId, '同上：动态流右上角相机图标，进去之后再切「视频」页签');
  } else {
    const ventry = hit('上传视频', '发视频', '视频号')[0];
    if (ventry) vpush('打开发布入口（视频）', 'tapText', ventry.text || ventry.desc, '取自 dump 的匹配节点');
    else vpush('打开发布入口（视频）', 'tapText', '上传视频', '⚠ dump 里没找到，需手动确认');
  }
  // ★ 视频走的是**同一条入口** ⇒ 同样会被草稿箱接走，这一步必须也带上。
  vpush('草稿箱拦截 · 点底部「发布新动态」出到相册（只有真落到草稿箱时才点）', 'tapId',
    DEWU.draft.exitId, DRAFT_HINT, { whenOn: DEWU.draft.titleId });
  vpush('未完成草稿拦截 · 点「放弃」（只有真弹出「是否继续编辑」时才点）', 'tapId',
    DEWU.resumeDialog.dismissId, RESUME_HINT, { whenOn: DEWU.resumeDialog.dismissId });
  vpush('切到视频页签', 'tapText', '视频', '相册页顶部的「视频」页签，部分版本叫 短片/全部，按实际页面改');
  vpush('选中要发的视频', 'tapText', '${videoName}', '${videoName} 是**推上去之后**的文件名（含中文的名字会被清洗成下划线）；相册里只有缩略图没有文字时，改成 tapId/tapDesc 或按实际页面改');
  vpush('确认选视频', 'tapText', '下一步', '部分版本叫 完成/确定');
  vpush('填标题', 'input', '${title}', '占位符在运行时替换为生成好的标题');
  vpush('填正文', 'input', '${body}', '占位符替换为正文');
  for (let i = 1; i <= 5; i++) {
    vpush(`话题 ${i}（直接输入）`, 'input', '${topic' + i + '}', '同图文：不联想，直接写');
  }
  vpush('关联好物', 'tapText', '关联好物', '');
  vpush('搜索货号', 'input', '${sku}', '');
  vpush('提交发布', 'tapText', '发布', '最后一步的发布按钮');

  return {
    package: pkg || (nodes[0] && nodes[0].pkg) || '',
    generatedAt: Date.now(),
    // ★★★ 2026-10-04 新增：**抓取时的坐标系**（`dumpsys window displays` 的 `cur=`）。
    //   为什么必须记：`tapXY` 是写死的绝对坐标，只在**这一个坐标系**里成立。
    //   不记的话，换了分辨率/方向之后运行时**判不出来**「这张表量错了空格子」——
    //   而 `input tap` 对越界坐标不报错（实测 rc=0），表现就是全程静默点偏。
    //   运行时 publisher 拿它和当下的 `adb.uiSize()` 比（见 uimap.screenMismatch）。
    //   拿不到尺寸（老 dumpsys 格式）时写 null —— 不编一个假尺寸。
    screen: screenStamp(opts.screen),
    // 封面口径（已拍板）：用得物推荐的 —— 不点封面区、不上传封面图。
    // 但若真机版本封面区默认未选中、不点一下会卡住「下一步」，就得在 videoSteps 里补一步点它。
    videoNote: '视频封面用得物推荐的：不点封面区、不上传封面图。若真机版本封面区默认未选中挡住了「下一步」，'
      + '在 videoSteps 里补一步（value 填封面区上真实看到的文字），例如 '
      + '{"name":"选第一个封面候选","action":"tapText","value":"<封面区上真实文字>"} —— 这一条不能靠猜，必须真机看一眼。',
    // ★ 一条内容发**多张图**（2026-10-03 加）：相册缩略图没有文字也没有描述，只能按 resource-id 点；
    //   写 count 就能一次点**前 N 个**匹配（不写 = 1 = 老行为，只点第一个）。
    //   想「这个叶子有几张图就点几张」⇒ count 写 ${imageCount}。
    //   ⚠ 相册按**时间倒序** ⇒ 点的是最前面 N 格；封面是不是你想要的那张，要看推送顺序。
    note: '一条内容发多张图：把「选图」那一步写成 '
      + '{"action":"tapId","value":"<缩略图的 resource-id>","count":"${imageCount}"} —— '
      + '${imageCount} = 这个叶子文件夹里有几张图；不写 count 就只点第一个匹配。相册按时间倒序，点的是最前面 N 格。',
    steps,
    videoSteps
  };
}

/** 把 ${title} / ${topic3} 之类占位符替换成本条的真实内容 */
function fill(step, data) {
  const rep = v => String(v == null ? '' : v).replace(/\$\{(\w+)\}/g, (_, k) => (data[k] != null ? data[k] : ''));
  const t = rep(step.value);
  // ★ count 也要替换：定位表里写 ${imageCount} 时，这里解析成「这条素材真实的图片张数」。
  //   解析成空（数据里没有图片清单）就**原样留着**（别变成 '' 被下游当成「没写」而默默按 1 张发）——
  //   留给 publisher 当场报错，报错里还能看见是哪个占位符。
  const out = Object.assign({}, step, { value: t });
  if (step.count != null && step.count !== '') {
    const rc = rep(step.count);
    out.count = rc === '' ? step.count : rc;
  }
  return out;
}

/**
 * 发布步骤（uiMap.steps / uiMap.videoSteps）的校验。
 * 不认识的 action 直接报错并列出可用值（normalizeCond 也同一思路）。
 * 为什么要在**导入时**拦住：写错的步骤要跑到 publisher.runStep 才抛「未知步骤类型」，
 * 那时第一条已经推完素材、点了一半界面；导入时就报出来，能省掉一次半途失败。
 */
// ★ 2026-10-03 新增 tapXY：**按固定坐标点**，不抓屏。
//   为什么要它：实测这台模拟器 `uiautomator dump` 单次要 ~1.5s，而一次 `input tap` 只要 ~0.13s。
//   定位表里「底部我 / 主页 / 发布新动态 / 下一步 / 标题框 / 提交发布」这类**版式固定的按钮**
//   坐标是死的，每次点击前先花 1.5s 抓屏纯属浪费 ⇒ 直点坐标，一条内容能省十几秒。
//   ★ 代价如实说：直点坐标**没有「找不到就不点」这层保护** —— 屏幕不对就会点在错误位置。
//     所以它只适合版式固定、且下一步能立刻发现异常的格子；动态结果（相册格子 / 颜色卡片 /
//     商品结果图）**必须**继续用 tapId / tapCardText。要保险就给这一步配 whenOn 屏幕守卫
//     （守卫本身要抓一次屏，但一屏抓一次，仍比每步都抓便宜）。
const STEP_ACTIONS = ['tapText', 'tapId', 'tapDesc', 'tapCardText', 'tapXY', 'input', 'wait', 'waitId', 'back', 'screenshot'];

/**
 * ★ 条件步骤（when / whenNot）—— 2026-10-03 加。
 *
 * 为什么必须有：发布单里「好物1~3 货号/颜色」是三组（26 列），而多数行只填 1 个。可
 * 「点关联好物 → 搜货号 → 选商品」是**一整段**流程 —— 空着的那几段如果不跳过，会把
 * 关联好物搜索页打开却不选商品，**后面每一步全崩**，而且崩在「界面已经点了一半」的状态上，
 * 比不发还难查（这一条正是 2026-10-02 那次「点了一半、日志说成功」的同类坑）。
 *
 * 写法：when / whenNot 写**占位符名**（不带 ${}），例如 "goods2Sku"：
 *   when    —— 该占位符解析出**非空**值才执行这一步（用在「有第 2 个好物才去点关联好物」）
 *   whenNot —— 该占位符解析出**空**值才执行这一步（用在「没填颜色就退化成选第 1 格」）
 * 两者是互补的，成对写就能表达 if/else：例如
 *   {action:'tapText', value:'${goods1Color}', when:'goods1Color'}
 *   {action:'tapId',   value:'…/ivProduct',    whenNot:'goods1Color'}
 *
 * ★ 也可以写**多个**（逗号分隔），全部成立才执行：
 *   when:"goods2Sku,goods2Color"    = 两个都非空才执行
 *   whenNot:"goods2Sku,goods2Color" = 两个都空才执行
 *   为什么需要：好物2/3 的「按颜色选」要同时满足「有第 2 个好物」**且**「填了颜色」；
 *   它的退路步要「有第 2 个好物」**且**「没填颜色」。单个 when 表达不了，硬凑的话
 *   遇到「货号空、颜色有值」这种脏行就会点到别的屏幕上（静默跑偏，最难查）。
 *   两个字段也可以同时写：when:'goods2Sku' + whenNot:'goods2Color' = 「有货号且没颜色」。
 *
 * ★ 只允许写占位符名 —— 写别的（整段表达式 / 带 ${} 的）一律在**导入时**报错。
 *   放行的话会在真机跑到一半才发现「条件永远不成立」，整条静默少点一步。
 * ★ 跳过的步骤会写进运行日志（不静默）—— 见 publisher.runReal。
 */
const COND_KEYS = ['when', 'whenNot'];

function normalizeCond(step, at) {
  const out = {};
  for (const k of COND_KEYS) {
    const raw = step[k];
    if (raw == null || String(raw).trim() === '') continue;
    const keys = String(raw).split(',').map(x => x.trim().replace(/^\$\{/, '').replace(/\}$/, '').trim()).filter(Boolean);
    for (const key of keys) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) {
        throw new Error(`${at}的 ${k} 只能写占位符名（例如 goods2Sku），多个用逗号分隔，不能写「${raw}」`);
      }
    }
    if (keys.length) out[k] = keys.join(',');
  }
  return out;
}

/**
 * 条件是否成立。data 就是 uimap.fill 用的那份占位符数据（同一个对象，不要另算一遍）。
 * 单独抽出来是为了让它**可被单测直接喂真值表**，而不是埋在 publisher 的循环里：
 * 「该跳的没跳」的后果是点错屏，「不该跳的跳了」的后果是少关联一个商品，两个都要能测。
 */
function condOk(step, data) {
  const d = data || {};
  const val = k => String(d[k] == null ? '' : d[k]).trim();
  const keys = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  // when：列出的占位符**全部非空**才执行（一个都没有 = 没写条件 = 放行）
  const whenKeys = keys(step && step.when);
  if (whenKeys.length && !whenKeys.every(k => val(k))) return false;
  // whenNot：列出的占位符**全部为空**才执行
  const notKeys = keys(step && step.whenNot);
  if (notKeys.length && !notKeys.every(k => !val(k))) return false;
  return true;
}

/**
 * 条件**为什么**没成立（只给运行日志用，返回 '' = 条件其实成立）。
 *
 * ★★ 为什么不能图省事写成「写了 when 就报 when 空」：2026-10-04 真机日志里出现过
 *    `跳过「好物1 · 没填颜色就选第 1 格」（占位符 goods1Sku 是空的）` —— 而那一行**明明填了货号**，
 *    真正的原因是被 `whenNot:'goods1Color'` 拦下的（有颜色 ⇒ 不走「退化成选第 1 格」这条退路）。
 *    报错点名一个**已经满足**的条件，等于把人往反方向带（我就是照这条日志去查了一圈空货号）。
 *    ⇒ 必须点名**真正没成立**的那一半，并写清是哪一种条件（when / whenNot）。
 * ★ 两个字段同时写时，按 condOk 的判定顺序取**第一个**不成立的 —— 与 condOk 必须一致，
 *   否则会出现「condOk 判不成立、condWhy 说不出为什么」的自相矛盾（那种情况返回兜底文案）。
 */
function condWhy(step, data) {
  const d = data || {};
  const val = k => String(d[k] == null ? '' : d[k]).trim();
  const keys = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const k of keys(step && step.when)) {
    if (!val(k)) return `when：占位符 ${k} 是空的`;
  }
  for (const k of keys(step && step.whenNot)) {
    if (val(k)) return `whenNot：占位符 ${k} 不是空的（值为「${val(k)}」）`;
  }
  return '';
}

/**
 * ★★ 屏幕守卫（whenOn / whenNotOn）—— 2026-10-03 真机实测的产物。
 *
 * 为什么要有第二套条件：`when / whenNot` 判的是**数据**（这一行填没填货号），而真机上还有
 * 一类「同一颗按钮点下去落到**哪一屏**，取决于 App 当时的状态」：
 *   典型 = 入口最后一跳。「我 → 主页 → 发布新动态」在**草稿箱非空**时落到的不是发布页，
 *   而是草稿箱 `media.activity.DraftActivity`（标题「草稿箱」，底部另有一颗同名「发布新动态」）。
 *   定位表没有那一步 ⇒ 下一条「切照片页签」当场找不到 ⇒ 整条卡死。
 * 判据只能来自**当前这一屏**，所以这一套是「屏幕守卫」而不是「数据条件」。
 *
 * 写法（与 when/whenNot 同一套「全部成立」语义，别记两套）：
 *   whenOn    —— 列出的 resource-id **全部**出现在这一屏，才执行这一步
 *   whenNotOn —— 列出的 resource-id **全部不出现**，才执行这一步
 * 多个用逗号分隔。★ 只允许写 resource-id（写文字一律在**导入时**报错）：
 *   守卫判错了的后果是「该点的不点 / 不该点的点了」，两头都比普通步骤更难查，
 *   所以宁可逼着写 id（id 不受文案改版影响），也不放行文字匹配。
 */
const SCREEN_KEYS = ['whenOn', 'whenNotOn'];

function normalizeScreenCond(step, at) {
  const out = {};
  for (const k of SCREEN_KEYS) {
    const raw = step[k];
    if (raw == null) continue;
    const keys = String(raw).split(',').map(x => x.trim()).filter(Boolean);
    for (const key of keys) {
      // ★★★ 2026-10-05 修复：这里的值就是 **Android 的 resource-id**，格式是 `包名:type/name`
      //   （例如 com.shizhuang.duapp:id/tvCancel）—— **必须带 `:type/`**。
      //   旧正则是 `^[A-Za-z0-9_.]+/[A-Za-z0-9_.]+$`，**不允许 `:`**，于是两类都判反了：
      //     · **拒绝** com.shizhuang.duapp:id/tvCancel（dump 里的真格式）
      //     · **放行** com.shizhuang.duapp/tvCancel（根本不是 resource-id，运行时永远匹配不上）
      //   而运行时的判据是 screenCondOk 里的 `n.id === id`，n.id 就是 dump 的 resource-id
      //   （见 parseNodes 的 `id: attr['resource-id']`）⇒ **合法值 100% 被拒**。
      //   实测后果（端到端复刻 publish.importMap）：把真机 dump 喂给 suggest() 生成的候选表
      //   **21 份全部导入失败**（suggest 无条件挂两条守卫步，见 DEWU.draft / DEWU.resumeDialog）
      //   ⇒ 「抓取页面结构 → 改 → 导入」这条路整个走不通，而报错还指着一个合法值说「不是 resource-id」。
      //   为什么一直没暴露：这里原先**只有负向断言**（写了文字要报错），**没有一条正向**（合法 id 必须能导入）。
      if (!/^[A-Za-z0-9_.]+:[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/.test(key)) {
        throw new Error(`${at}的 ${k} 只能写 resource-id（形如 com.xx.yy:id/zz，`
          + `必须带 :id/ —— 少了冒号就不是 resource-id，运行时永远匹配不上），`
          + `多个用逗号分隔，不能写「${raw}」`);
      }
    }
    out[k] = keys.join(',');
  }
  return out;
}

/**
 * 屏幕守卫是否放行。nodes 是 uimap.parseNodes() 的结果（**当前这一屏**的）。
 * 单独抽出来是为了能直接喂节点做真值表，不用起 adb：
 * 「该跳的没跳」的后果是卡住，「不该跳的跳了」的后果是点到别的屏上，两个都要能测。
 */
function screenCondOk(step, nodes) {
  const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const has = id => (nodes || []).some(n => n && n.id === id);
  const want = list(step && step.whenOn);
  const missing = want.filter(id => !has(id));
  if (missing.length) return { ok: false, why: `这一屏上没有「${missing.join(' / ')}」` };
  const notWant = list(step && step.whenNotOn);
  const present = notWant.filter(id => has(id));
  if (present.length) return { ok: false, why: `这一屏上出现了「${present.join(' / ')}」` };
  return { ok: true, why: '' };
}

function normalizeSteps(input, label = 'steps') {
  if (!Array.isArray(input) || !input.length) {
    throw new Error(`${label} 必须是非空数组，例如 [{"action":"tapText","value":"发布"}]`);
  }
  return input.map((raw, i) => {
    const step = raw && typeof raw === 'object' ? raw : {};
    const action = String(step.action || '').trim();
    const at = `${label} 第 ${i + 1} 步`;
    if (!STEP_ACTIONS.includes(action)) {
      throw new Error(`${at}的 action 不认识「${action || '（空）'}」；可用：${STEP_ACTIONS.join(' / ')}`);
    }
    const cond = normalizeCond(step, at);
    // ★ 屏幕守卫跟条件步骤一起解析、一起落到返回的步骤对象上（见 runStep 顶部）。
    const scr = normalizeScreenCond(step, at);
    if (action === 'wait') {
      const ms = Number(step.value);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`${at}（wait）的 value 要写毫秒数，例如 1500`);
      return Object.assign({}, step, { value: ms }, cond, scr);
    }
    // ★★ waitId（2026-10-03 真机实测加）：等到**某一块（resource-id）出现**再往下走。
    //   专门用在「两屏之间的转场」上（得物「相册 → 图片编辑页」是异步转场）：
    //   · 只靠 wait（写死毫秒）⇒ 少了会白点下一步（干跑实测卡死在这里），多了白等；
    //   · 只靠 whenOn 守卫 ⇒ 它判的是「抓的那一刻」，转场没完时这一步会被整步跳过。
    //   ⇒ 这一步**等到真的出现**才继续；等不到就硬失败并点名等的是什么，绝不硬点。
    if (action === 'waitId') {
      const value = String(step.value == null ? '' : step.value).trim();
      if (!value) {
        throw new Error(`${at}（waitId）的 value 要写要等的 resource-id，`
          + `例如 com.shizhuang.duapp:id/edit_panel`);
      }
      const tmo = (step.timeout == null || step.timeout === '') ? 10000 : Number(step.timeout);
      if (!Number.isFinite(tmo) || tmo <= 0) {
        throw new Error(`${at}（waitId）的 timeout 要写毫秒数（> 0），不写默认 10000`);
      }
      return Object.assign({}, step, { value, timeout: tmo }, cond, scr);
    }
    // ★ tapXY：value 必须是 'x,y'（多个点用 ; 分隔）。在**导入时**就挡住空坐标 ——
    //   跑到真机上才发现坐标是空的，等于白点一轮（还可能点到别的界面去）。
    if (action === 'tapXY') {
      const value = String(step.value == null ? '' : step.value);
      const pts = parsePoints(value);
      if (!pts.length) {
        throw new Error(`${at}（tapXY）的 value 要写坐标，形如 "540,1871"；`
          + `多个点用分号隔开，如 "540,1871;300,900"。现在写的是「${value}」，解析不出任何坐标。`);
      }
      return Object.assign({}, step, { value }, cond, scr, { points: pts });
    }
    if (action === 'tapText' || action === 'tapId' || action === 'tapDesc' || action === 'tapCardText') {
      const value = String(step.value == null ? '' : step.value);
      if (!value.trim()) throw new Error(`${at}（${action}）的 value 不能为空：要点的文字 / resource-id / 描述`);
      // ★★ tapCardText 多要一个 card：商品图的 resource-id。
      //   它的语义是「按颜色文字找到那张卡，点卡上的商品图」——
      //   为什么不能直接 tapText：真机实测发现点颜色文字弹的是「选择商品规格」弹层，
      //   **不会选中卡片**。
      if (action === 'tapCardText' && !String(step.card == null ? '' : step.card).trim()) {
        throw new Error(`${at}（tapCardText）还要写 card = 商品图的 resource-id`
          + `（颜色文字落在它里面，点它才等于选中整张卡）`);
      }
      // ★ count（可选）= 一次点**前 N 个**匹配节点（用在「一条内容选多张图」）。
      //   字面量必须是 1~${MAX_TAP_COUNT} 的整数；写 ${imageCount} 这类占位符则运行时再解析，
      //   所以这里只挡住「一眼就错」的写法 —— 别让它跑到真机上点了一半才炸。
      const rawCount = step.count;
      let count;
      if (rawCount == null || rawCount === '') {
        count = 1;
      } else if (/\$\{\w+\}/.test(String(rawCount))) {
        count = String(rawCount);
      } else {
        const n = Number(rawCount);
        if (!Number.isInteger(n) || n < 1 || n > MAX_TAP_COUNT) {
          throw new Error(`${at}（${action}）的 count 要么写 1~${MAX_TAP_COUNT} 的整数，`
            + `要么写占位符（例如 ${'${imageCount}'}），不能写「${rawCount}」`);
        }
        count = n;
      }
      return Object.assign({}, step, { value }, cond, scr, { count });
    }
    // input：value 里的占位符（${title} 等）是运行时才替换的，这里看不出来，别误判成空
    // screenshot：value 只是截图文件名前缀，可以空；back 不需要 value
    return Object.assign({}, step, cond, scr);
  });
}

/*
 * ★ 2026-10-03 用户要求：**失败恢复动作（uiMap.recover）整块删除**，所以这里不再有
 *   normalizeRecover / RECOVER_ACTIONS。发布失败后不再按返回键、也不再执行任何「恢复步骤」——
 *   失败就如实写「发布失败，原因xxx」交给人工（重跑是「模拟器发布」页上的一个新任务）。
 */



/**
 * ★★ 2026-10-03 真机实测（MuMu / 得物，UWG460108 货号搜索）：
 *   「关联好物」结果页里每一格 = 商品图 ivProduct（319×319）+ 颜色文字 tvCSpuInfo，
 *   而**颜色文字落在它所属那张商品图的 bounds 之内**（实测：tvCSpuInfo [278,554][354,597]
 *   完全包在 ivProduct [35,278][354,597] 里）。
 *   所以「这个颜色在哪一格」可以用几何算出来，不靠贴标。
 *
 * 为什么非得这么绕：同一页上「本白」实测出现 3 次（同色多款），
 *   而点颜色文字只会弹出“选择商品规格”弹层 —— 既点不中卡片，也认不准是哪一款。
 * @param {Array}  nodes  parseNodes() 的结果
 * @param {Object} hit    已匹配到的颜色文字节点
 * @param {string} cardId 商品图的 resource-id
 * @returns {Object|null} 要点的那张卡（商品图节点），找不到就 null
 */
function cardOf(nodes, hit, cardId) {
  if (!hit || !hit.center || !cardId) return null;
  const { x, y } = hit.center;
  const cards = (nodes || []).filter(n => n && n.id === cardId && n.box && n.center);
  const inside = cards.filter(n => x >= n.box.x1 && x <= n.box.x2 && y >= n.box.y1 && y <= n.box.y2);
  // ★★ 2026-10-03 真机 dump 暴露的第二个坑：同一屏的树里其实有**两套互相重叠**
  //   的卡片列表（「已购」「想要」两个 viewPager 同时在树里，坐标错开 220px）
  //   ⇒ 一个点会被两张卡同时“包住”（实测：本白 (316,576) 同时落在
  //   [35,278][354,597] 和 [35,498][354,817] 里）。直接取第一张会点到背后那列去。
  //   归属判据（几何上很干净）：颜色标签是贴在卡片的**右下角**，
  //   取「底边 + 右边和标签最贴近」的那张。
  if (inside.length > 1) {
    return inside.slice().sort((a, b) =>
      (Math.abs(a.box.y2 - hit.box.y2) + Math.abs(a.box.x2 - hit.box.x2))
      - (Math.abs(b.box.y2 - hit.box.y2) + Math.abs(b.box.x2 - hit.box.x2)))[0];
  }
  if (inside.length) return inside[0];
  // 文字不在任何一张卡里 ⇒ 只放行「布局差几个像素」这种情况：
  //   允许的纵向缝隙必须很小（8px），且水平范围真的交叠。
  //   缝隙放宽就等于允许「点一张完全不相干的卡」——那正是最难查的静默错。
  const above = cards.filter(n => n.box.y2 <= y && (y - n.box.y2) <= 8 && x >= n.box.x1 && x <= n.box.x2);
  if (!above.length) return null;
  return above[above.length - 1];
}

module.exports = {
  parseNodes, findNode, findNodes, cardOf, countOf, parsePoints, MAX_TAP_COUNT, suggest, fill,
  normalizeSteps, STEP_ACTIONS, normalizeCond, condOk, condWhy, COND_KEYS,
  SCREEN_KEYS, normalizeScreenCond, screenCondOk,
  // ★ 2026-10-04 新增：tapXY 的坐标空间守卫（纯函数，喂输入即可测全分支）
  tapPointsOf, outOfScreenTapPoints, screenMismatch, screenStamp, stepsFor,
  DEWU, isDewuFocus, isPublishScreen, isHomeScreen, isDraftScreen
};
