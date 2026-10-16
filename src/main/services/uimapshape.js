'use strict';
/**
 * ★★ 加固步骤的**单一形状来源**（架构审查候选 3）。
 *
 * 要解决的问题（真机反复打出来的）：
 *   同一份「UI 定位表」有三条路进来 —— ① 出厂内置表（`uimapdefaults.js`）、
 *   ② 界面上「抓取页面结构」生成的候选表（`uimap.suggest`）、③ 用户导入的 uiMap.json。
 *   过去这三条路各写各的步骤：修好一条，另外两条还是老样子。
 *   典型后果：把「选图后必须确认换屏」这条修复加进内置表之后，
 *   **同事在界面上重抓一次表再导入，修复就没了** —— 表退化成旧行为，还没人发现。
 *
 * 所以把「加固步骤长什么样」收进这一个 module：
 *   · 只声明**形状**（action / 判据 / 上限），不碰坐标；
 *   · 三条路都调用 `harden()`，拿到的加固步骤逐字节一致；
 *   · 回归可以直接断言「三条路的产出一致」，而不是去数某一行源码里有没有某个字符串。
 *
 * `harden()` 是一条**纯函数**：喂一份表进去，回一份补好的表 + 补了什么。
 *   · 没有副作用的纯计算 ⇒ 离线就能验；
 *   · 幂等：对已经加固过的表再跑一次，产出与输入逐字节相同。
 */
const D = 'com.shizhuang.duapp:id/';

// 真机实证（2026-10-04 / MuMu 12 / 1080x1920）：
//   · 相册页选素材那格 = flThumbSelect（选中后右下角才出现 flNextStep/tvNextStep）；
//   · 图文「选图 → 下一步」之后**可能**先落在图片编辑页（多图），也可能直接进标题页（单选）；
//   · 视频「选视频 → 下一步」之后落在剪辑页（cover-edit.xml 实证：
//     editVideoView + ivClip/ivMusic/ivSticker/ivText + flNextStep/tvNextStep），
//     再点一次才到「设置封面」页（videocover 从那一屏接手）。
const IMAGE_TARGET = D + 'etTitle';                 // 标题输入框 = 图文编辑页已就绪
const IMAGE_FROMS = [D + 'flThumbSelect', D + 'edit_panel'];
const VIDEO_TARGET = '设置封面';                     // 封面页标题文字（videocover 的入口判据同款）
const VIDEO_FROMS = [D + 'flThumbSelect', D + 'editVideoView'];

/** 图文：选图之后的转场 —— 最多点两次「下一步」，认到标题页为止 */
function imageTransition() {
  return {
    name: '选图后的转场 · 等到标题填写页',
    action: 'transition',
    until: IMAGE_TARGET,
    from: IMAGE_FROMS.slice(),
    maxClicks: 2,
    timeout: 30000,
    hint: '★ 这一步取代了原来的「下一步 + 图片编辑页 · 下一步」两条盲点坐标。'
      + '得物的屏间转场是异步的：`input tap` 返回成功只代表命令发出去了，不代表页面已经换过去。'
      + '所以这一步**先抓屏确认**有没有到标题页，没到才点那颗唯一的「下一步」，最多点两次；'
      + '点完仍没到就如实报「转场未确认」并停下本批，绝不盲点第二下'
      + '（盲点会落在新屏的别的位置上，编辑页底部那颗是「发布」⇒ 误发）。'
  };
}

/** 视频：选视频之后的转场 —— 相册 → 剪辑页 → 设置封面页 */
function videoTransition() {
  return {
    name: '选视频后的转场 · 等到设置封面页',
    action: 'transition',
    until: VIDEO_TARGET,
    from: VIDEO_FROMS.slice(),
    maxClicks: 2,
    timeout: 30000,
    hint: '★ 这一步取代了原来的「下一步 + 固定 wait 1200 + 剪辑页下一步 + 固定 wait 1200」四步。'
      + '固定等待在慢设备上必然不够（真机实测这段转场 5.9–6.8s，而表里只等 1.2s），'
      + '等不够就点到还没渲染完的屏上，报错还会指到后面某一步找不到控件。'
      + '现在改成「确认到了封面页就停，没到就点唯一的下一步」，不再靠猜时间。'
  };
}

/** 选图那一步（一条内容可能有 N 张图）—— 与候选表/内置表共用同一个形状 */
function selectImages() {
  return {
    name: '选中要发的图（前 N 张，N＝这个叶子的图片数）',
    action: 'tapId',
    value: D + 'flThumbSelect',
    count: '${imageCount}',
    hint: '★ 相册缩略图没有文字/描述，只能按 resource-id 点；'
      + 'count 写 ${imageCount} = 这条素材有几张图就点几张（不写只点第 1 张）。'
      + '相册按时间倒序，点的是最前面 N 格；少点一张**不静默**，这一步会当场报错。',
  };
}

/**
 * 这一步是不是「旧式的盲点下一步」（要被转场步骤取代的那种）。
 * ★ 只认**形状**，不认名字：
 *   · `tapXY` 且带 `whenOn=edit_panel` ⇒ 图文那屏的守卫步（2026-10-16 之前的内置表写法）；
 *   · `tapXY` 且坐标与已知的那两颗「下一步」重合 ⇒ 相册/剪辑页的盲点（真机实测两颗同为 985,1843）。
 * 为什么不按名字匹配：名字是给用户看的，改个名字不该改变行为（这正是候选 2 要治的病）。
 */
const BLIND_NEXT_POINTS = ['985,1843'];
const BLIND_NEXT_ANCHORS = [D + 'edit_panel', D + 'editVideoView'];
function isBlindNext(step) {
  if (!step) return false;
  if (step.action === 'tapText' && step.value === '下一步') return true;
  if (step.action === 'tapId' && [D + 'tvNextStep', D + 'flNextStep'].includes(step.value)) return true;
  if (step.action !== 'tapXY') return false;
  if (BLIND_NEXT_ANCHORS.includes(String(step.whenOn || ''))) return true;
  return BLIND_NEXT_POINTS.includes(String(step.value || '').replace(/\s/g, ''));
}

/** 这一步是不是「选素材」那一步（转场必须紧跟在它后面） */
const SELECT_NAME = /选中要发的|选图/;
function isSelectStep(step) {
  if (!step || !/^tap/.test(String(step.action || '')) || isBlindNext(step)) return false;
  // 打开相册不是选中素材，不能仅因步骤名含「选图」就提前推进。
  if (step.action === 'tapText' && step.value === '相册') return false;
  if (SELECT_NAME.test(String(step.name || ''))) return true;
  return String(step.action || '') === 'tapId' && String(step.value || '').endsWith('/flThumbSelect');
}

/** 盲点转场后面跟着的那个「补等待」（盲点省掉了抓屏，才需要它） */
function isTransitionFiller(step) {
  if (!step || step.action !== 'wait') return false;
  return /等下一屏|转场/.test(String(step.name || ''));
}

/**
 * 把一份定位表补成加固后的表。
 * @returns {{ map: object, added: string[], removed: string[] }}
 *   · 已经加固过 ⇒ added/removed 都是空数组，map 与输入**逐字节等价**（幂等）；
 *   · 表里没有可用的锚点（找不到第一条 input）⇒ 一个字都不动，只在 added 里说明跳过了。
 */
function harden(map) {
  const src = map && typeof map === 'object' ? map : {};
  const out = Object.assign({}, src);
  const added = [], removed = [];

  for (const [key, want] of [['steps', imageTransition], ['videoSteps', videoTransition]]) {
    const list = Array.isArray(src[key]) ? src[key].slice() : [];
    if (!list.length) continue;                                      // 视频单独没配 ⇒ 复用图文那套，不用补
    // ★ 插入点：**选素材那一步之后**。为什么不是「第一条 input 之前」：
    //   那样会把转场排在「点标题输入框」**后面** —— 框还没出现就去点它，等于白点一轮。
    //   转场的语义就是「选完素材 → 等到目标屏」，位置只能是紧跟着选素材。
    const firstInput = list.findIndex(s => s && s.action === 'input');
    if (firstInput < 0) continue;                                     // 表里没有输入步 ⇒ 不是一份能用的表，不动
    let anchor = -1;
    for (let i = 0; i < firstInput; i++) if (isSelectStep(list[i])) anchor = i;
    if (anchor < 0) continue;                                         // 找不到选素材那一步 ⇒ 一个字都不动
    // 只有选材后的转场才表示这段已加固，其他位置的自定义转场不能遮住它。
    if (list.slice(anchor + 1, firstInput).some(s => s && s.action === 'transition')) continue;
    // 摘掉选素材之后、第一次输入之前的所有「旧式盲点转场」与它们后面那条「补等待」。
    // ★ 「补等待」的判据必须看**原始序列里紧邻的前一步**是不是盲点：
    //   盲点先被摘掉，再看已保留列表的尾巴就会漏删这一条（见 tools/transitiontest.js 的反证用例）。
    const kept = list.slice(0, anchor + 1);
    let prevWasBlind = false;
    for (let i = anchor + 1; i < list.length; i++) {
      const st = list[i];
      const inWindow = i < firstInput;
      const blind = inWindow && isBlindNext(st);
      const filler = inWindow && prevWasBlind && isTransitionFiller(st);
      if (blind || filler) {
        removed.push(String(st.name || st.value || st.action));
        prevWasBlind = blind;
        continue;
      }
      kept.push(st);
      prevWasBlind = false;
    }
    const step = want();
    kept.splice(anchor + 1, 0, step);
    added.push(step.name);
    out[key] = kept;
  }
  return { map: out, added, removed };
}

module.exports = {
  harden,
  imageTransition,
  videoTransition,
  selectImages,
  isBlindNext,
  isTransitionFiller,
  IMAGE_TARGET,
  VIDEO_TARGET,
  IMAGE_FROMS,
  VIDEO_FROMS,
};
