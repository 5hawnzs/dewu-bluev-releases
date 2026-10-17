'use strict';
/**
 * ★★ 转场 module（发布步骤引擎的**深模块**）：把「点一下 → 确认到了哪一屏」收进一处。
 *
 * 为什么必须独立成一个 module（这是被真机反复打出来的结论）：
 *   · 得物的屏间转场是**异步的**：`input tap` 返回 rc=0 只代表命令发出去了，
 *     不代表页面已经换过去。盲点坐标（tapXY）后面必须有人确认新屏是否真的出现。
 *   · 这条知识原来是**散着**的：图文那条写死在 publisher.runStep 里（认 `edit_panel` 一个 id），
 *     视频那条只有「固定 wait 1200ms + 盲点」—— 同一类转场，两套做法，
 *     于是修好图文之后视频还在同一个坑里（2026-10-16 的架构审查结论）。
 *   · 转场失败的**报错位置离真因很远**：真实症状是「后面某一步找不到控件」，
 *     而真因是「上一步的点击落在了还没渲染完的屏上」。所以失败必须在这里、
 *     用明确的错误码（PUBLISH_TRANSITION_UNCONFIRMED）当场说清楚。
 *
 * interface（很小，调用方只需要知道这些）：
 *   run(serial, spec, ctx, deps) → { clicks, waitedMs, polls }
 *   spec = {
 *     until:     必填。字符串或数组 = 目标屏的判据（resource-id，或屏上精确文字）。
 *     from:      可选。只能从这些屏出发（防在陌生屏上乱点）；不写则不限制。
 *     button:    可选。只认这颗 resource-id 的下一步按钮；不写就按「唯一的一颗」找。
 *     timeout:   可选，毫秒；默认 30000。
 *     maxClicks: 可选，最多点几次；默认 4（相册→图片编辑页→标题页这种要两下）。
 *   }
 *
 * 判据（每一轮都先抓屏，全部要能复算）：
 *   ① `until` 已在屏上 ⇒ **立刻返回，一个像素都不点** —— 覆盖「上一步已经把我送到目标屏」
 *      （多图时相册那颗「下一步」直接进标题页）和「上一轮已经点到位」两种情况；
 *   ② 还在路上、且这一屏上**恰好一颗**可点的「下一步」⇒ 点它，并记一次；
 *   ③ 点了 `maxClicks` 次仍未确认、或这一屏上没有唯一的下一步 ⇒ 一直等到超时，
 *      然后抛带 `PUBLISH_TRANSITION_UNCONFIRMED` 的错误，点名卡在哪一屏、当前可见文本是什么。
 *
 * ★★ 2026-10-17 用户口径纠正（上一版把「1 / 5」误读成「一张图点一次下一步」）：
 *   图片编辑页的「1 / 5」只是**当前图片序号**，正常路径仍是「相册点一次 → 编辑页点一次 → 标题页」。
 *   另一台设备的真实现场是：编辑页那颗「下一步」**点了一次没有反应**（页面还在处理图片，
 *   或触摸落在系统底部手势区），旧逻辑「同一屏不点第二下」就一直等到超时，
 *   报出来的却是 `找不到「etTitle」；当前可见文本：1 / 5 / 下一步`。
 *   所以现在的边界是：**同一屏最多点 3 次、两次之间至少隔 2.4s，而且每次点之前都重新抓屏，
 *   确认这一屏上仍然恰好只有一颗「下一步」**。仍然绝不盲点陌生屏；达到 3 次仍没换屏就交给
 *   行级失败处理（收回现场、继续下一条），不会无限连点。
 *   这样既能救回被吞掉的一次点击，也不会把「下一步」的坐标拿去点到标题页的「发布」上。
 *
 * ★ 为什么**先抓屏再点**、不用固定坐标抢时间（这是被真机打出来的教训）：
 *   · 盲点坐标只保证「命令发出去了」，不保证「点在了哪一屏上」。两张屏的同一坐标
 *     常常是不一样的按钮（编辑页底部那颗是「发布」）⇒ 点错就是**误发**；
 *   · 所以先确认「还没到目标屏」，再点。多花一次抓屏（本机实测约 3.2s），
 *     换来的是「点错」和「静默跳过」这两类最难查的故障都不再可能发生。
 *
 * ★ 「恰好一颗」是安全边界，不能放宽：同一颗按钮在 dump 里通常有两个节点
 *   （容器 flNextStep + 文字 tvNextStep），按**中心点去重**后必须恰好剩一颗；
 *   多于一颗说明版式变了（或出现了第二颗同名按钮），这时宁可不点、如实报错。
 *
 * ★ 依赖是**注入**的（deps）：产品路径用真 adb，回归用假设备。
 *   这样这套判据能在**不接设备**的情况下验完，而不是只能靠真机跑一遍。
 */
const adb = require('./adb');
const mediapermission = require('./mediapermission');
const uimap = require('./uimap');

// 真机实测（2026-10-04 / MuMu 12 / 1080x1920）：同一颗「下一步」在 dump 里由两层节点组成 ——
//   flNextStep（FrameLayout，clickable=true，真身）
//   tvNextStep（TextView，clickable=false，只是文字）
// 两者中心点相同 ⇒ 按中心去重后应恰好剩一颗。
const NEXT_ID = 'com.shizhuang.duapp:id/';
const NEXT_BUTTON_IDS = [NEXT_ID + 'tvNextStep', NEXT_ID + 'flNextStep'];
const NEXT_BUTTON_TEXT = '下一步';

const DEFAULT_TIMEOUT = 30000;
// 不同屏之间最多走几段（相册→编辑页→标题页＝2；视频多一屏剪辑/封面＝3）。
// 它**不是**「同一屏点几次」的上限，被吞掉的点击由下面的 MAX_TAPS_PER_SCREEN 单独兜。
const DEFAULT_MAX_CLICKS = 4;
const POLL_MS = 400;
// 同一屏签名不变时：最多点 3 次，两次点击之间至少隔 6 轮轮询（≈2.4s）。
// 为什么不是「绝不点第二下」：被吞掉的点击必须能重试一次，否则就是另一台设备那种
// 「点了没反应 → 一直等到超时 → 报找不到 etTitle」的假失败。
const MAX_TAPS_PER_SCREEN = 3;
const RETRY_POLLS = 6;
const RETRY_GAP_MS = 2400;
// ★★ 2026-10-17 另一台设备发来的卡点截图里，图片编辑页上盖着一层
//   「正在导出图片 90% / 请不要退出得物」，「下一步」就在遮罩下面。
//
//   注意：这只是**同一句报错的一种可能成因**，不能据此认定真因。另一种很常见的情况是
//   点击回执 rc=0 但事件被吞（页面还在渲染/合成），需要同一屏再点一次；两者报出来的
//   都是「找不到 etTitle；当前可见文本：1 / 5 / 下一步」。所以两条路都要兜：
//     · 遮罩在 ⇒ 一次都不点，等它消失（下面的 isBusy）；
//     · 没遮罩但点了没换屏 ⇒ 同一屏重试，最多 3 次（MAX_TAPS_PER_SCREEN）。
//   处理方式只影响「点不点」，不额外增加固定等待：每轮判断都复用当轮抓屏结果。
const BUSY_TEXT = /正在导出图片|请不要退出得物|正在处理图片|正在保存图片|图片导出中/;

/** 归一化成数组：`'a'` → `['a']`；空/未写 → `[]` */
function list(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
}

/**
 * 这一屏有没有 marker。
 * 判据：带 `/` 的当 **resource-id** 精确匹配（与屏幕守卫同一套写法）；
 *       不带 `/` 的当**文字**精确匹配（例如封面页那颗「设置封面」标题）。
 * 为什么不用「包含」：包含匹配会把「下一步」三个字匹配到「下一步…」的别的控件上，
 *   也会让「设置封面」匹配到「支持相册导入封面」这类说明文字 —— 那是拿幻觉当判据。
 */
function hit(nodes, marker) {
  const m = String(marker || '').trim();
  if (!m) return false;
  if (m.includes('/')) return nodes.some(n => String(n.id || '') === m);
  return nodes.some(n => String(n.text || '').trim() === m);
}

function hitAny(nodes, markers) {
  return markers.some(m => hit(nodes, m));
}

/**
 * 这一屏上**唯一**的那颗「下一步」。多于一颗或一颗都没有 ⇒ 返回 null（宁可不点）。
 * button 是调用方指定的 resource-id 时，只认那一颗。
 */
function nextButton(nodes, button) {
  const ids = button ? [button] : NEXT_BUTTON_IDS;
  const cand = nodes.filter(n => n && n.enabled && n.center
    && (ids.includes(String(n.id || '')) || (!button && String(n.text || '').trim() === NEXT_BUTTON_TEXT)));
  const uniq = [...new Map(cand.map(n => [n.center.x + ',' + n.center.y, n])).values()];
  return uniq.length === 1 ? uniq[0] : null;
}

/** 这一屏有没有「下一步」这颗按钮（不管 enabled）——只用于把「按钮在处理中」说清楚 */
function hasNextButton(nodes, button) {
  const ids = button ? [button] : NEXT_BUTTON_IDS;
  return nodes.some(n => n && n.center
    && (ids.includes(String(n.id || '')) || (!button && String(n.text || '').trim() === NEXT_BUTTON_TEXT)));
}

/**
 * 点击点：取按钮 `bounds` 的几何中心。
 *
 * 2026-10-17 复盘：曾一度改成「按钮高度 35% 处」以避开系统手势区，但那是**没有实测证据**的
 * 推测，已按「不留无依据改动」的口径改回中心点。本机 1080×1920 实测中心 (986,1843) 点击有效；
 * 另一台设备截图里这颗按钮的位置与本机**相近（不是完全一致）**，不足以推出「手势区」结论。
 * 点击被吞的情况由 MAX_TAPS_PER_SCREEN 的同屏重试兜住，不靠挪点击点。
 */
function tapPointOf(n) { return n && n.center; }

/** 这一屏是不是盖着「导出/处理图片」遮罩（遮罩期间点「下一步」会被吃掉） */
function isBusy(nodes) {
  return (nodes || []).some(n => BUSY_TEXT.test(String((n && (n.text || n.desc)) || '')));
}

/** 这一屏的结构签名：id + bounds；用来判断「点击之后这一屏有没有变」 */
function signature(nodes) {
  return (nodes || []).filter(n => n && n.center)
    .map(n => String(n.id || '') + '@' + String(n.bounds || '')).sort().join('|');
}

/**
 * ★★ 2026-10-17 「分段编辑屏」往前推一步（转场自愈）。
 *
 * 为什么需要它：得物选完图会先落到**图片编辑页**，屏上是「1 / 5」+「下一步」。
 * 老定位表/导入表里这一段常常只写了一条「等（或点）etTitle」——于是停在编辑页，
 * 报的却是 `找不到「etTitle」；当前可见文本：1 / 5 / 下一步`（另一台设备的真实现场）。
 * 报错的位置（找不到 etTitle）离真因（少点了编辑页那一下）很远。
 *
 * 判据刻意收窄，绝不变成「见按钮就点」：
 *   · 屏上必须有 `i / N` 这种**分段计数**文字（陌生屏没有它 ⇒ 一步都不点）；
 *   · 必须有**恰好一颗**可点的「下一步」（多颗说明版式变了 ⇒ 不点）。
 * 同一屏最多点 3 次、间隔 ≥2.4s（同一份 ctx 跨调用计数）；点完由调用方重新抓屏再判。
 *
 * @returns {Promise<boolean>} 真的点了一下 ⇒ true
 */
const STAGED_COUNTER = /^\s*\d+\s*\/\s*\d+\s*$/;

/**
 * 这一屏是不是「分段编辑屏」：有 `i / N` 计数文字 **且** 有恰好一颗可点的「下一步」。
 * 为什么它可以直接算「允许点击的来源屏」：这种屏上唯一能做的就是往前走一段，
 * 点「下一步」不可能点到「发布」（发布按钮在最后一段之后的编辑页上，且不在这种屏上出现）。
 */
function isStagedScreen(nodes, button) {
  const list = nodes || [];
  if (!list.some(n => STAGED_COUNTER.test(String(n.text || '').trim()))) return false;
  return !!nextButton(list, button);
}

async function advanceStage(serial, nodes, ctx = {}, deps = {}) {
  const list = nodes || [];
  const counter = list.find(n => STAGED_COUNTER.test(String(n.text || '').trim()));
  if (!counter) return false;
  // 导出遮罩期间不点：等调用方下一轮重新抓屏，遮罩消失后再点。
  if (isBusy(list)) return false;
  const b = nextButton(list, deps.button);
  if (!b) return false;
  const now = (deps.now || Date.now)();
  const sig = signature(list);
  const st = ctx._stagedTap || (ctx._stagedTap = { sig: '', count: 0, at: 0 });
  if (st.sig === sig) {
    if (st.count >= MAX_TAPS_PER_SCREEN) return false;
    if (now - st.at < RETRY_GAP_MS) return false;
    st.count++;
  } else {
    st.sig = sig;
    st.count = 1;
  }
  st.at = now;
  const tap = deps.tap || ((s, x, y) => adb.tap(s, x, y));
  const p = tapPointOf(b);
  const r = await tap(serial, p.x, p.y);
  if (!r || !r.ok) return false;
  if (ctx.log) {
    ctx.log(st.count > 1
      ? `分段编辑屏（${String(counter.text).trim()}）：上一次点「下一步」后页面没变，第 ${st.count}/${MAX_TAPS_PER_SCREEN} 次重试（${p.x},${p.y}）`
      : `分段编辑屏（${String(counter.text).trim()}）：目标控件还没出现，先点「下一步」往下走一段（${p.x},${p.y}）`, 'info');
  }
  return true;
}

/** 报错时给人看的现场：前 10 段文字，读不到就如实说读不到 */
function visible(nodes, why) {
  if (!nodes.length) return why ? `（读不到界面结构：${why}）` : '（空）';
  return nodes.filter(n => n.text).slice(0, 10).map(n => String(n.text).trim()).join(' / ') || '（空）';
}

function specOf(raw) {
  const s = raw || {};
  const until = list(s.until);
  if (!until.length) throw new Error('转场步骤缺少 "until"：必须写明「出现哪一屏才算到了」（resource-id 或屏上文字）');
  const timeout = Number(s.timeout);
  const maxClicks = Number(s.maxClicks);
  // maxClicks 只表示**要经过几屏**（相册→编辑页→标题页＝2），不表示同一屏点几次。
  // 旧表写 2 是对的；被吞掉的点击由 MAX_TAPS_PER_SCREEN 单独重试，不能用抬高 maxClicks 来兜。
  const asked = Number.isInteger(maxClicks) && maxClicks >= 1 && maxClicks <= DEFAULT_MAX_CLICKS ? maxClicks : DEFAULT_MAX_CLICKS;
  return {
    from: list(s.from),
    until,
    button: s.button ? String(s.button) : '',
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT,
    maxClicks: asked,
    label: String(s.name || s.label || '转场')
  };
}

async function run(serial, rawSpec, ctx = {}, deps = {}) {
  const spec = specOf(rawSpec);
  const checkCancelled = () => { if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消'); };
  const dump = deps.dump || ((s, o, c) => mediapermission.dump(s, o, c));
  const tap = deps.tap || ((s, x, y) => adb.tap(s, x, y));
  const parse = deps.parse || (xml => uimap.parseNodes(xml));
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));

  const started = Date.now();
  let clicks = 0, where = '', polls = 0;
  // 点过「下一步」的**不同屏**签名：maxClicks 限制的是这个数量，不是点击命令的次数
  // （同一屏被吞掉后的重试不算多走一屏，否则重试一次就没额度进下一屏了）。
  const clickedScreens = new Set();
  // 点击记账：同一屏签名下最多点 MAX_TAPS_PER_SCREEN 次；两次之间至少隔 RETRY_POLLS 轮。
  // 每次点之前都已经重新抓过屏，确认这一屏仍然只有一颗「下一步」 ⇒ 不会拿旧坐标点到「发布」。
  let clickedSig = '', tapsOnSig = 0, lastTapPoll = -RETRY_POLLS;
  let disabledLogged = '';
  for (;;) {
    checkCancelled();
    const d = await dump(serial, { pkg: uimap.DEWU.pkg, retries: 0 }, ctx);
    checkCancelled();
    polls++;
    const nodes = d && d.ok ? parse(d.xml) : [];
    where = visible(nodes, d && d.why);

    // 复用转场观测做选材确认；补选后留到下次正常轮询确认，不用旧页面继续点下一步。
    if (d && d.ok && ctx.confirmSelection && hitAny(nodes, ['com.shizhuang.duapp:id/flThumbSelect'])) {
      if (!await ctx.confirmSelection(d)) { await sleep(POLL_MS); continue; }
    }

    // ① 已到目标屏（或从未离开过）⇒ 不点，直接过
    if (d && d.ok && hitAny(nodes, spec.until)) {
      // ★ 必须说出来「到了哪一屏、点没点过」：真机排查时最怕的是「这一步悄悄过了」——
      //   分不清是「本来就在目标屏」（没点）还是「点到位了」（点了），后面一步失败就无从下手。
      if (ctx.log) ctx.log(`${spec.label}：已确认进入目标屏（${spec.until.join(' 或 ')}）`
        + (clicks ? `，其间点击「下一步」${clicks} 次` : '，未点击「下一步」'), 'info');
      return { clicks, waitedMs: Date.now() - started, polls };
    }

    // ② 只在确认自己在允许的屏幕组里时才点；否则说明我们跑到别的屏了，
    //    这时点任何坐标都可能落在「发布」上 ⇒ 不点，交给超时如实报错。
    // ★★ 2026-10-17：分段编辑屏（「1 / 5」+ 唯一「下一步」）也算合法来源屏。
    //   编辑页只有「1 / N」+「下一步」，既没有 flThumbSelect 也不一定有 edit_panel ——
    //   以前判「不在允许的屏幕」⇒ 拒绝点击 ⇒ 永远等不到标题页（另一台设备的卡点）。
    const onSource = !spec.from.length || hitAny(nodes, spec.from) || isStagedScreen(nodes, spec.button);
    const sig = signature(nodes);
    // ★★ 导出/处理图片遮罩：等它自己消失，绝不在遮罩上点「下一步」（点了也不会生效）。
    const busy = d && d.ok && isBusy(nodes);
    if (busy && disabledLogged !== 'busy:' + sig) {
      disabledLogged = 'busy:' + sig;
      if (ctx.log) {
        const why = nodes.map(n => String(n.text || '').trim()).filter(Boolean).join(' / ');
        ctx.log(`${spec.label}：页面正在导出/处理图片（${why}），等它结束后再点「下一步」，不打断也不盲点`, 'info');
      }
    }
    const firstOnScreen = sig !== clickedSig;
    const retryDue = !firstOnScreen && tapsOnSig < MAX_TAPS_PER_SCREEN && polls - lastTapPoll >= RETRY_POLLS;
    const b = d && d.ok ? nextButton(nodes, spec.button) : null;
    // 新的一屏要有 maxClicks 额度；同一屏的重试不占额度（否则走到编辑页后就再也重试不了）。
    const mayTap = clicks < spec.maxClicks * MAX_TAPS_PER_SCREEN
      && (firstOnScreen ? clickedScreens.size < spec.maxClicks : retryDue);
    if (!busy && mayTap && onSource && d && d.ok && b) {
      const p = tapPointOf(b);
      const r = await tap(serial, p.x, p.y);
      if (!r.ok) {
        const error = new Error(`${spec.label}：下一步按钮点击回执未确认：${(r.stderr || r.stdout || '').trim()}。本条按失败处理（收回现场后继续下一条）。`);
        error.code = 'PUBLISH_TRANSITION_UNCONFIRMED';
        throw error;
      }
      clicks++;
      tapsOnSig = firstOnScreen ? 1 : tapsOnSig + 1;
      clickedSig = sig;
      clickedScreens.add(sig);
      lastTapPoll = polls;
      if (ctx.log) {
        ctx.log(`${spec.label}：${tapsOnSig > 1
          ? `上一次点击后页面没有变化，第 ${tapsOnSig}/${MAX_TAPS_PER_SCREEN} 次重试「下一步」`
          : `第 ${clickedScreens.size}/${spec.maxClicks} 屏：点击下一步`}（${p.x},${p.y}），继续确认目标屏`, 'info');
      }
    } else if (d && d.ok && onSource && !b && hasNextButton(nodes, spec.button)) {
      // 按钮在屏上但 enabled=false：页面还在处理，等它变可用；不算失败、不点。
      if (disabledLogged !== sig && ctx.log) {
        disabledLogged = sig;
        ctx.log(`${spec.label}：这一屏的「下一步」暂不可用（页面还在处理），继续等待，不点击`, 'info');
      }
    }

    if (Date.now() - started >= spec.timeout) {
      const want = spec.until.join(' 或 ');
      const error = new Error(`${spec.label}未确认：等 ${((Date.now() - started) / 1000).toFixed(1)}s 仍未出现「${want}」`
        + (busy ? '（整段等待都显示「正在导出/处理图片」，遮罩一直没消失，没有点击）'
          : clicks ? `（已点击下一步 ${clicks} 次，但没有换到目标屏）`
          : onSource ? '（这一屏上没有唯一可点的「下一步」按钮，不盲点）'
            : `（当前已不在允许的屏幕「${spec.from.join(' 或 ')}」上，不盲点）`)
        + `；当前可见内容：${where}。未填写、未提交，本条按失败处理（收回现场后继续下一条）。`);
      error.code = 'PUBLISH_TRANSITION_UNCONFIRMED';
      throw error;
    }
    await sleep(POLL_MS);
  }
}

module.exports = { run, specOf, hit, hitAny, nextButton, advanceStage, isBusy, list, DEFAULT_TIMEOUT, DEFAULT_MAX_CLICKS, NEXT_BUTTON_IDS, NEXT_BUTTON_TEXT };
