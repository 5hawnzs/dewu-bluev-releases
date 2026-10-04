'use strict';
/**
 * ★ 幂等的「定位表一键修正」脚本（可反复重跑，结果一致）。
 *
 * 用法：node tools/fixuimap.js
 *   （App 未运行时执行最稳；若 App 在跑，改完请立刻重启 App，否则可能被内存旧值回写覆盖。）
 *
 * 为什么需要它：config.json 会被运行中的 App / 脚本用内存里的旧值**回写覆盖**
 *   （store.set → 250ms 防抖整份写回），历史上多次把已改好的 uiMap 又刷回旧版
 *   （实测：删掉的「切 bluev 相册」两步会复活、好物会退回「只输货号」）。
 *   ⇒ 不再依赖「历史叠加改了多少次」，而是把**目标态规则**写死在这里：跑一次即得到正确配置。
 *
 * 目标态（与用户指令一一对应）：
 *   ① 入口三步幂等可重入（我 / 主页 带 whenNotOn:rlPublish 守卫；主页后加一步幂等补点）
 *      —— 修 seq12「上一条发完停在个人主页 ⇒ 下一条入口点空」。
 *   ② **不切 bluev 相册**：删掉「点开相册选择器」+「选中本工具专属相册」两步
 *      —— 用户原话「删除完所有其他不相关的素材后，不要 bluev 了」。
 *   ③ 好物搜索**输「货号+颜色」（无空格）**，然后**选结果第 1 格**
 *      —— 用户原话「好物搜索框，需要输入货号+颜色」「货号颜色，不要有空格」。
 *   ④ ★★ 好物「点关联好物」的靶点 = **整行的 tvRelevantProduct**（uiautomator 里唯一查得到的那行），
 *      并配 `waitEnabled` + `waitEnabledTries`；「等搜索页加载」= `waitId`(etSearch)
 *      —— 2026-10-04 用户指出 + 真机实测：贴完文案后得物会**自动识别视频中的好物**，
 *         识别期间该行 `clickable=true` 但 **`enabled=false`**（点哪都不响应）。
 *         ★ 靶点为什么是 tvRelevantProduct（三次实测纠错）：
 *           · `ivRelevantProductArrow`（视觉上的「>」箭头）**在 uiautomator 树里根本不存在**
 *             —— `_gd.xml` 实测只有 tvRelevantProduct / tvRelevantProductRecognitionCount，
 *             箭头那格没有 resource-id（dumpsys 里有 `1010,21-1045,56`，是 vhToXml 丢的）；
 *             用它当靶点 ⇒ `tapId` 找不到 ⇒ 3 次重试后抛错 ⇒ **整条中止**
 *             （实测后果：用户看到「输完文案就退出来了，没点好物也没点发布」）。
 *           · `tvRelevantProductRecognitionCount`（右侧，760~1080，已覆盖箭头那片区域）
 *             是「识别到更多可关联好物」= 得物自动识别入口，**用户明确不要用**。
 *           · ⇒ 只有 **tvRelevantProduct** 既是真实入口、又不会被自动识别抢走。
 *         ★ waitEnabledTries=25（≈17.5s）：识别实测要十几秒，旧版受 `attempt<3`（≈8s）限制等不到。
 *         且「关联好物 → 搜索页可读」实测要 ~1.2s（异步转场），固定 wait 400ms 会抓到
 *         上一屏的空壳 ⇒ 报「找不到搜索框」，错误位置离真因很远。
 *         ⇒ waitId：等 etSearch 出现就走（通常 1s 内，最多 10s）；等不到点名报错、不硬点。
 *   ⑤ 「是否继续编辑」拦截弹窗 → 插一步 tvCancel（whenOn 守卫，没弹窗就整步跳过）。
 *   ⑥ ★★ 相册页「选素材 / 下一步」→ **盲点固定坐标 tapXY**（166,359 与 985,1843）
 *      —— 用户原话「选择的图标路径不是很明显吗，你直接点击选择图标、然后下一步」。
 *         实测该屏 uiautomator dump 2085ms、input tap 125ms（16×）。
 *   ⑦ ★★ 2026-10-04（用户原话「视频在选择素材后，连点两下即可跳过封面页；图文就点一下」）：
 *      真机实测（MuMu 12 / 1080×1920，TotalPublishProcessActivity）—— 三屏的按钮坐标：
 *        · 相册页 flNextStep   bounds=[891,1794][1080,1892] → 中心 (985,1843)
 *        · 剪辑页 flNextStep   bounds=[891,1794][1080,1892] → 中心 (985,1843)（**与相册那颗 bounds 完全相同**）
 *        · 封面页 tv_skip      bounds=[761,1829][880,1885]  → 中心 **(820,1857)** ← **要点这颗**
 *        · 封面页 tvNextStep   bounds=[926,1829][1045,1885] → 中心 (985,1857)
 *      ★★ 封面页**必须点左边那颗「跳过」**：实测点右边「下一步」**不到编辑页**，而是进**又一屏「编辑封面」**
 *         （文字：编辑封面 / 封面模板 / 文字 / 下一步），还要点第三下才到编辑页。
 *      ⇒ 视频：剪辑页点「下一步」(985,1843) + 封面页点「跳过」(820,1857) = 用户说的「连点两下」；
 *        图文：点「下一步」(985,1843) 一下（多图才有的图片编辑页）。
 *        这几屏原先是 tapId（每屏要先抓屏 2085ms），改成盲点（125ms）。
 *      ★ 图文那步保留 `whenOn: edit_panel` 守卫：单选图没有这一屏，盲点无条件点下去会落到
 *        编辑页底部的「发布」上 ⇒ 误发（这条不能省）。
 *      ★★ 盲点**没有抓屏 ⇒ 也就没有天然的屏间等待**（tapId 那 2085ms 的 dump 顺带把转场等掉了）。
 *         实测后果：视频连点两下后 seq1 还停在剪辑页、seq2 只过一屏 —— 点在了转场中的屏幕上。
 *         ⇒ 见 ⑦-b：视频那两步之间插固定 `wait` 补回等待（图文有守卫、自带 dump，不用补）。
 */
const fs = require('fs');
const path = require('path');

// ★ 可用环境变量指到别的目录（回归测试用临时目录跑，避免动真实配置）
const APP = process.env.BLUEV_CFG_DIR || 'C:\\Users\\Administrator\\AppData\\Roaming\\dewu-bluev-publisher';
const CFG = path.join(APP, 'config.json');
const DEWU = 'com.shizhuang.duapp';
const RLP = DEWU + ':id/rlPublish';
const GO = DEWU + ':id/tvGoHomePage';

const j = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const um = j.publish && j.publish.uiMap;
if (!um) { console.error('没有 uiMap'); process.exit(1); }

const bak = CFG + '.bak-before-fixall-' + Date.now();
fs.copyFileSync(CFG, bak);
console.log('备份:', path.basename(bak));

// ① 删掉「切 bluev 相册」两步（按名字，不依赖位置）
const DROP = /点开相册选择器|选中本工具专属相册/;
// ③ 好物：输「货号+颜色」
const GOODS_INPUT = /^好物(\d) · 输「货号/;
// ③ 好物：删掉「按颜色选那一格」（颜色已进搜索框）
const GOODS_BYCOLOR = /^好物\d · (选「\$\{goods\dColor\}」那一格|按「颜色」选对那一格)/;
// ③ 好物：退路步改名 + 去 whenNot → 「选结果第 1 格」

let log = [];
for (const key of ['steps', 'videoSteps']) {
  const before = (um[key] || []).length;
  const out = [];
  for (const s of (um[key] || [])) {
    const n = String(s.name || '');
    if (DROP.test(n)) { log.push(`删「${n}」`); continue; }
    if (GOODS_BYCOLOR.test(n)) { log.push(`删「${n}」`); continue; }
    const m = GOODS_INPUT.exec(n);
    if (m) {
      s.name = `好物${m[1]} · 输「货号+颜色」`;
      s.value = `\${goods${m[1]}Sku}\${goods${m[1]}Color}`;
      s.when = `goods${m[1]}Sku`;
      delete s.whenNot;
      out.push(s); continue;
    }
    const g2 = /^好物(\d) · 没填颜色就选第 1 格$/.exec(n);
    if (g2) {
      s.name = `好物${g2[1]} · 选结果第 1 格`;
      delete s.whenNot;
      out.push(s); continue;
    }
    out.push(s);
  }
  um[key] = out;

  // ④ ★★ 2026-10-04（用户指出）：好物那一段有两处硬伤，按名字幂等修正
  //    · 「点关联好物」→ 靶点必须是 **tvRelevantProduct**（整行入口，uiautomator 里唯一查得到的那行）：
  //      `ivRelevantProductArrow`（视觉箭头）在 uiautomator 树里**不存在** ⇒ tapId 必失败 ⇒ 整条中止；
  //      `tvRelevantProductRecognitionCount` 是得物自动识别入口，用户明确不要用。
  //      且识别期间该行 `enabled=false`（点哪都不响应）⇒ 配 `waitEnabled` 等它可用再点，
  //      waitEnabledTries=25（≈17.5s，识别实测十几秒，旧的 attempt<3≈8s 等不到）。
  //    · 「等搜索页加载」→ 必须 `waitId`（等 etSearch 真出现）：异步转场实测 ~1.2s，
  //      固定 wait 会抓到上一屏的空壳 ⇒ 表现为「找不到搜索框」，报错离真因很远。
  const arr = um[key];
  for (const s of arr) {
    const n = String(s.name || '');
    if (/点「关联好物」这一行/.test(n)) {
      const want = DEWU + ':id/tvRelevantProduct';
      if (s.value !== want) { log.push(`好物靶点 → tvRelevantProduct（${n}）`); s.value = want; }
      if (!s.waitEnabled) s.waitEnabled = true;
      if (!(Number(s.waitEnabledTries) > 0)) s.waitEnabledTries = 25;
      s.hint = '★★ 贴完文案后得物会**自动识别视频中的好物**，识别期间这一行 enabled=false（点哪都不响应）。'
        + '① 靶点 = **tvRelevantProduct**（整行入口）。不要写 ivRelevantProductArrow —— 它在 uiautomator 树里不存在，'
        + '必失败并让整条中止；也不要写 tvRelevantProductRecognitionCount —— 那是得物自动识别入口，不要用。'
        + '② waitEnabled + waitEnabledTries=25：识别中不点，等可用再点（约 17.5s 上限）；等不到如实报错，不硬点。';
      continue;
    }
    if (/等搜索页加载/.test(n)) {
      if (s.action !== 'waitId') { log.push(`等搜索页 → waitId（${n}）`); s.action = 'waitId'; }
      s.value = DEWU + ':id/etSearch';
      s.timeout = 10000;
      s.hint = '★ 这一屏是异步转场，固定 wait 会抓到上一屏空壳 ⇒ 等 etSearch 真出现就走（通常 1s 内，最多 10s）。';
      continue;
    }
  }
  // 移除已有的补点步（防止重跑时叠加）
  for (let i = arr.length - 1; i >= 0; i--) {
    if (/右上角「主页」· 补点/.test(arr[i].name || '')) arr.splice(i, 1);
  }
  const iMe = arr.findIndex(s => /底部「我」/.test(s.name || ''));
  const iGo = arr.findIndex(s => /右上角「主页」/.test(s.name || ''));
  if (iMe >= 0) arr[iMe].whenNotOn = RLP;
  if (iGo >= 0) {
    arr[iGo].whenNotOn = RLP;
    arr[iGo].name = '右上角「主页」（已在主页 tab 则跳过）';
    arr.splice(iGo + 1, 0, {
      name: '右上角「主页」· 补点（上一步没跳走才点，幂等）',
      action: 'tapId',
      value: GO,
      whenOn: GO
    });
  }

  // ⑤ ★★ 2026-10-04（真机实测新增）：**「是否继续编辑」拦截弹窗**必须处理。
  //   上一轮中断（报错/被杀/干跑停在编辑页）会在得物侧留下"未编辑完的视频动态"，
  //   下次点「发布新动态」先弹这个窗 ⇒ 不处理就整条卡住，
  //   而且报错指向后面某一步（「找不到 tvGoHomePage；当前可见文本：是否继续编辑 / …」），离真因很远。
  //   实测结构（2026-10-04 真机 dump）：
  //     tv_title="是否继续编辑" / tvContent="你有未编辑完的视频动态，是否继续？"
  //     / tvCancel="放弃"(339,1173) / tvConfirm="继续"(549,1173) / imgDraftCover 封面
  //   ★ 点「放弃」（不是「继续」）：本次要发的是**队列里那一条新内容**；
  //     「继续」会接着编旧半成品 ⇒ 发出一条没标题没正文的残次品，比卡住更糟。
  //   ★ 幂等：按名字先删掉已有的那一步（前后两份都删），再按位置插（固定顺序）。
  //   ★★★ 2026-10-04（用户口径，原话）：「**挪到最前面先点掉**」。
  //     为什么必须**最前面也有一份**（而不是只有「草稿箱拦截之后」那一份）：
  //       上一轮中断留下的弹窗，在**下一条刚起手时就已经在屏幕上了** —— 那时脚本还没点到
  //       「发布新动态」，所以原来那份（排在草稿箱拦截之后）根本轮不到执行；
  //       而越靠前的两步是**固定坐标**（底部「我」945,1869 / 相册第 1 格 166,359），
  //       弹窗盖在上面时它们点下去全是点空/点到弹窗 ⇒ 之后每一步都在错屏上找节点，报错位置离真因很远。
  //     ⇒ 起手第一件事就是把它点掉（「放弃」）；后面那份**保留**，因为正常发布时这个弹窗
  //       是在点了「发布新动态」之后才弹的（两份都是 whenOn 守卫，没弹窗就整步跳过、一个像素不碰）。
  const RESUME_NAME = /未完成草稿拦截 · 点「放弃」/;
  for (let i = arr.length - 1; i >= 0; i--) if (RESUME_NAME.test(arr[i].name || '')) arr.splice(i, 1);
  const mkResume = (front) => ({
    name: front
      ? '未完成草稿拦截 · 点「放弃」（★ 起手先清掉上一轮留下的弹窗）'
      : '未完成草稿拦截 · 点「放弃」（只有真弹出「是否继续编辑」时才点）',
    action: 'tapId',
    value: DEWU + ':id/tvCancel',
    whenOn: DEWU + ':id/tvCancel',
    hint: '★ 带屏幕守卫（whenOn=tvCancel）：只有这一屏真出现「你有未编辑完的视频动态」才点「放弃」；'
      + '正常发布（没这个弹窗）时**整步跳过、一个像素都不碰**。'
      + '为什么点「放弃」：本次要发的是队列里那一条新内容；点「继续」会接着编上一轮中断留下的旧半成品，'
      + '发出一条没标题没正文的残次品（比卡住更糟）。'
      + '为什么有两份：这一份负责「起手时弹窗就已经在屏幕上」（上一轮中断留下的），'
      + '草稿箱拦截之后那份负责「点了发布新动态之后才弹出来」。'
  });
  const iDraft = arr.findIndex(s => /草稿箱拦截/.test(s.name || ''));
  let iIns;
  if (iDraft >= 0) iIns = iDraft + 1;
  else {
    // 没有草稿箱拦截步（老配置）⇒ 插在「发布新动态」之后
    const iP = arr.findIndex(s => /「发布新动态」$/.test(s.name || ''));
    iIns = iP >= 0 ? iP + 1 : arr.length;
  }
  arr.unshift(mkResume(true));           // 最前面：起手先点掉（unshift 之后所有下标 +1）
  arr.splice(iIns + 1, 0, mkResume(false));

  // ⑥ ★★ 2026-10-04（用户指出「点进所有照片之后，选择的图标路径不是很明显吗，
  //    你直接点击选择图标、然后下一步不就行了吗？」）：
  //    相册页「选素材 / 下一步」两步改成 **盲点固定坐标（tapXY）**。
  //    真机实测（MuMu 12 / 1080×1920，TotalPublishProcessActivity；开/关动画耗时一样）：
  //      · `uiautomator dump` 这一屏 **2085ms** ←「慢」的全部来源；`input tap` 只要 **125ms**（16×）。
  //      · 选择圆点 `flThumbSelect`（第 1 格）bounds=[122,315][210,403] → 中心 **166,359**；
  //        点它之后 `ivThumbSelect` selected=true、屏上出现「下一步 (1)」。
  //      · 「下一步」`flNextStep`（**选中之后才出现**）bounds=[891,1794][1080,1892] → 中心 **985,1843**。
  //    为什么这样是安全的：相册网格版式固定（永远从左上开始），且发布前清空了整个 DCIM/Camera
  //      ⇒ 这一屏只有本条素材 ⇒ 第 1 格位置恒定。
  //    为什么不担心「静默点空」：选素材没成功 ⇒ 相册页根本没有「下一步」这颗 ⇒ 紧接着的
  //      「剪辑页 · 下一步」(tapId flNextStep) 会找不到节点并**如实报错**（不会假装成功）。
  //    ★ 只改**视频**那条选素材步（名字写死「相册第 1 格」）；图文那条带 `count:${imageCount}`
  //      要连点前 N 格，坐标随张数变 ⇒ 本轮不动它（仍走 tapId）。
  const ALBUM_SEL_CO = '166,359';
  const ALBUM_NEXT_CO = '985,1843';
  for (const s of arr) {
    const n = String(s.name || '');
    if (n === '选中要发的视频（相册第 1 格）') {
      if (s.action !== 'tapXY' || s.value !== ALBUM_SEL_CO) log.push(`相册选素材 → tapXY ${ALBUM_SEL_CO}（${n}）`);
      s.action = 'tapXY';
      s.value = ALBUM_SEL_CO;
      delete s.count;
      s.fast = true;
      s.hint = '★★ 2026-10-04 真机实测改成**盲点固定坐标**（用户指出：选择图标路径很明显，直接点）：'
        + '这一屏 uiautomator dump 要 **2085ms**，input tap 只要 **125ms**（16×）。'
        + '选择圆点 flThumbSelect（第 1 格）bounds=[122,315][210,403] → 中心 (166,359)；'
        + '点后屏上出现「下一步 (1)」、ivThumbSelect selected=true。'
        + '★ 第 1 格位置恒定（网格固定 + 清相册后这一屏只有本条素材）。';
      continue;
    }
    // 只匹配相册页那颗；「剪辑页 · 下一步」「图片编辑页 · 下一步」名字不同，不会误伤。
    if (n === '下一步（离开相册）' || n === '下一步') {
      if (s.action !== 'tapXY' || s.value !== ALBUM_NEXT_CO) log.push(`相册下一步 → tapXY ${ALBUM_NEXT_CO}（${n}）`);
      s.action = 'tapXY';
      s.value = ALBUM_NEXT_CO;
      s.fast = true;
      s.hint = '★★ 2026-10-04 真机实测改成**盲点固定坐标**：flNextStep（选中素材之后才出现）'
        + 'bounds=[891,1794][1080,1892] → 中心 (985,1843)。'
        + '★ 失败不静默：选素材没成功时这颗不存在，盲点无效 ⇒ 后面「剪辑页 · 下一步」(tapId) 会如实报错。';
      continue;
    }
  }

  // ⑦ ★★ 2026-10-04（用户原话「视频在选择素材后，连点两下即可跳过封面页；图文就点一下」）：
  //    「跳过封面页」不再去 tree 里找 tv_skip / flNextStep（每屏要抓屏 2085ms），
  //    而是**在同一个坐标连点**。真机实测三屏的「下一步」都在 (985,1843)：
  //      相册 flNextStep=[891,1794][1080,1892] / 剪辑页 flNextStep=**同一 bounds** /
  //      封面页 tvNextStep=[926,1829][1045,1885]（1843 在其中）——所以同一个点贯穿三屏。
  //    ⇒ 视频：剪辑页 + 封面页 = 同一坐标**两下**；图文：图片编辑页 = 同坐标**一下**。
  //    ★ 图文那步**必须保留 `whenOn: edit_panel`**：单选图时相册「下一步」直接进编辑页，
  //      那一屏没有这颗按钮，盲点会落在编辑页底部的「发布」上 ⇒ **误发**。
  const NEXT_CO = '985,1843';   // 相册页 / 剪辑页 / 图片编辑页的「下一步」都落在这个点
  const SKIP_CO = '820,1857';   // 封面页那颗「跳过」（**不是**右边那颗「下一步」）
  for (const s of arr) {
    const n = String(s.name || '');
    // 视频：剪辑页（多出来的第一屏，右下角那颗）
    if (/^剪辑页/.test(n)) {
      if (s.action !== 'tapXY' || s.value !== NEXT_CO) log.push(`剪辑页「下一步」→ tapXY ${NEXT_CO}`);
      s.action = 'tapXY';
      s.value = NEXT_CO;
      s.fast = true;
      s.hint = `★★ 2026-10-04 真机实测改成**盲点固定坐标**：剪辑页 flNextStep bounds=[891,1794][1080,1892] `
        + `→ 中心 (985,1843)（与相册页那颗 bounds 完全相同）。`
        + `配合下一步「封面页」= 同一坐标 ⇒ 就是用户说的「选完素材连点两下」。`;
      continue;
    }
    // 视频：封面页 —— ★ 必须点**左边那颗「跳过」(tv_skip)**，不是右边的「下一步」！
    //   2026-10-04 真机实测：这一屏点「下一步」**不到编辑页**，而是进**又一屏「编辑封面」**
    //   （文字：编辑封面 / 封面模板 / 文字 / 下一步），还要点第三下才到编辑页。
    //   点「跳过」= 不设置封面、直接用默认 ⇒ 一步到编辑页。这才对得上用户说的「连点两下跳过封面页」。
    if (/^封面页/.test(n)) {
      if (s.action !== 'tapXY' || s.value !== SKIP_CO) log.push(`封面页「跳过」→ tapXY ${SKIP_CO}`);
      s.name = '封面页 · 跳过（不设置封面，直接下一步）';
      s.action = 'tapXY';
      s.value = SKIP_CO;
      s.fast = true;
      s.hint = `★★ 2026-10-04 真机实测：封面页有**两个出口** —— 右边「下一步」tvNextStep[926,1829][1045,1885] `
        + `会进**又一屏「编辑封面」**（还得再点一下才到编辑页，实测多花一屏）；`
        + `左边「跳过」tv_skip[761,1829][880,1885] 直接到编辑页。`
        + `⇒ 盲点必须打在**跳过那颗**的中心 ${SKIP_CO}，不是右边那颗。`
        + `这就是用户说的「连点两下即可跳过封面页」：上一步点剪辑页的「下一步」，这一步点封面页的「跳过」。`;
      continue;
    }
    // 图文：图片编辑页（**多图才有**）。保留 whenOn 守卫，否则单图会点到编辑页的「发布」上。
    if (/^图片编辑页/.test(n)) {
      if (s.action !== 'tapXY' || s.value !== NEXT_CO) log.push(`图片编辑页「下一步」→ tapXY ${NEXT_CO}`);
      s.action = 'tapXY';
      s.value = NEXT_CO;
      s.fast = true;
      s.hint = `★★ 2026-10-04 真机实测改成**盲点固定坐标**：这一屏 tvNextStep 与相册/剪辑页那颗同一位置 `
        + `→ 中心 (985,1843)（用户说「图文就点一下」）。`
        + `★ 守卫 whenOn=edit_panel **不能删**：单选图没有这一屏，盲点无条件点下去会落到编辑页底部的「发布」上 ⇒ 误发。`;
      continue;
    }
  }

  // ⑦-b ★★ 2026-10-04 真机实测补的「屏间等待」——**只有视频需要**。
  //   把「剪辑页/封面页」两步从 tapId 改成 tapXY 后，**丢了原来那份天然等待**：
  //   tapId 每步都要先 `uiautomator dump`（~2.1s）才点 ⇒ 点击之间自然隔着 ~2.1s，
  //   而 tapXY 是**立即点**。实测后果（2/2 失败）：
  //     · seq1 连点两下后**还停在剪辑页**（两下都被当成转场中的空点/一次双击）；
  //     · seq2 只过了一屏，停在封面页。
  //   ⇒ 在视频那两步之间插一个固定 `wait`（纯配置、不改 src）：等下一屏渲染完再点。
  //   图文不需要：它那步带 `whenOn` 屏幕守卫，守卫本身就要 dump 一次（= 天然等待）。
  //   ★ 幂等：先按名字删掉旧的，再按位置插（否则每跑一次 fixuimap 都会多插一个）。
  const WAIT_NAME = '等下一屏（转场，盲点没有抓屏 ⇒ 只能固定等）';
  const WAIT_MS = 1200;
  const arrW = um[key];
  for (let i = arrW.length - 1; i >= 0; i--) {
    if (String(arrW[i].name || '') === WAIT_NAME) arrW.splice(i, 1);
  }
  if (key === 'videoSteps') {
    const mk = () => ({ name: WAIT_NAME, action: 'wait', value: WAIT_MS });
    const iAlbum = arrW.findIndex(s => /^下一步（离开相册）/.test(String(s.name || '')));
    if (iAlbum >= 0) arrW.splice(iAlbum + 1, 0, mk());
    const iClip = arrW.findIndex(s => /^剪辑页/.test(String(s.name || '')));
    if (iClip >= 0) arrW.splice(iClip + 1, 0, mk());
  }

  console.log(`${key}: ${before} → ${arr.length} 步`);
}

fs.writeFileSync(CFG, JSON.stringify(j, null, 2), 'utf8');
console.log('改动', log.length, '处；已写回 config.json');
log.slice(0, 12).forEach(x => console.log('  -', x));
