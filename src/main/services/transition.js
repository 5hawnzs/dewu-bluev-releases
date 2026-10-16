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
 *     maxClicks: 可选，最多点几次；默认 2（相册→图片编辑页→标题页这种要两下）。
 *   }
 *
 * 判据（每一轮都先抓屏，全部要能复算）：
 *   ① `until` 已在屏上 ⇒ **立刻返回，一个像素都不点** —— 覆盖「上一步已经把我送到目标屏」
 *      （多图时相册那颗「下一步」直接进标题页）和「上一轮已经点到位」两种情况；
 *   ② 还在路上、且这一屏上**恰好一颗**可点的「下一步」⇒ 点它，并记一次；
 *   ③ 点了 `maxClicks` 次仍未确认、或这一屏上没有唯一的下一步 ⇒ 一直等到超时，
 *      然后抛带 `PUBLISH_TRANSITION_UNCONFIRMED` 的错误，点名卡在哪一屏、当前可见文本是什么。
 *
 * ★★ 「同一屏只点一次」是**安全边界**，2026-10-16 补上（真机语义 + 回归反证）：
 *   点完立刻再抓一屏，若这一屏的结构**一模一样**（还没换屏）就**绝不点第二下** ——
 *   转场期间同一坐标底下已经换成**新屏的别的按钮**（编辑页右下角是「下一步」，标题页右下角是「发布」），
 *   连点两下等于拿「下一步」的坐标去点「发布」＝误发。第二下只在
 *   「这一屏确实变过、又重新确认是本屏」时才允许（对应相册→编辑页→标题页这种真的要两下的场景）。
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
const DEFAULT_MAX_CLICKS = 2;
const POLL_MS = 400;

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
  return {
    from: list(s.from),
    until,
    button: s.button ? String(s.button) : '',
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT,
    maxClicks: Number.isInteger(maxClicks) && maxClicks >= 1 && maxClicks <= 4 ? maxClicks : DEFAULT_MAX_CLICKS,
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
  // 上一次点击时那一屏的结构签名；与当前屏相同 ⇒ 点击之后还没换屏，不能再点第二下（见文件头）。
  let clickedSig = '';
  const signature = ns => ns.filter(n => n && n.center)
    .map(n => String(n.id || '') + '@' + String(n.bounds || '')).sort().join('|');
  for (;;) {
    checkCancelled();
    const d = await dump(serial, { pkg: uimap.DEWU.pkg, retries: 0 }, ctx);
    checkCancelled();
    polls++;
    const nodes = d && d.ok ? parse(d.xml) : [];
    where = visible(nodes, d && d.why);

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
    const onSource = !spec.from.length || hitAny(nodes, spec.from);
    const sig = signature(nodes);
    if (clicks < spec.maxClicks && onSource && d && d.ok && sig !== clickedSig) {
      const b = nextButton(nodes, spec.button);
      if (b) {
        const r = await tap(serial, b.center.x, b.center.y);
        if (!r.ok) {
          const error = new Error(`${spec.label}：下一步按钮点击回执未确认：${(r.stderr || r.stdout || '').trim()}。不重复点击，本批后续条目未执行。`);
          error.code = 'PUBLISH_TRANSITION_UNCONFIRMED';
          throw error;
        }
        clicks++;
        clickedSig = sig;
        if (ctx.log) ctx.log(`${spec.label}：第 ${clicks}/${spec.maxClicks} 次点击下一步（${b.center.x},${b.center.y}），继续确认目标屏`, 'info');
      }
    }

    if (Date.now() - started >= spec.timeout) {
      const want = spec.until.join(' 或 ');
      const error = new Error(`${spec.label}未确认：等 ${((Date.now() - started) / 1000).toFixed(1)}s 仍未出现「${want}」`
        + (clicks ? `（已点击下一步 ${clicks} 次，但没有换到目标屏）`
          : onSource ? '（这一屏上没有唯一可点的「下一步」按钮，不盲点）'
            : `（当前已不在允许的屏幕「${spec.from.join(' 或 ')}」上，不盲点）`)
        + `；当前可见内容：${where}。未填写、未提交，本批后续条目未执行。`);
      error.code = 'PUBLISH_TRANSITION_UNCONFIRMED';
      throw error;
    }
    await sleep(POLL_MS);
  }
}

module.exports = { run, specOf, hit, hitAny, nextButton, list, DEFAULT_TIMEOUT, DEFAULT_MAX_CLICKS, NEXT_BUTTON_IDS, NEXT_BUTTON_TEXT };
