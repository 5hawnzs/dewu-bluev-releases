'use strict';
/**
 * ⑥ 模拟器发布
 * PRD 要点：
 *   - 发布节奏是人为间隔（60–120 秒/条），不是性能问题；2.5 小时里 93% 是在等间隔
 *   - 失败可单独重跑；等重跑的时间不算人工
 *   - 发布过程不占用发布单文件：结果追加写 jsonl，一批结束再合并回写 Excel
 *   - 发布完还要回查审核状态（发完 ≠ 发出去了）
 *
 * 两种通道，区别必须一眼可见：
 *   adb  —— 走真实命令（推图 + 媒体扫描 + uiautomator 定位 + 点击/输入），做的每一步都能在设备上看到；
 *          UI 定位表（uiMap）没配好就直接失败并说明缺什么，**绝不报成功**。
 *   mock —— 没有设备时的流程演练：节奏、重试、回写逻辑与真实一致，但状态明确标为模拟。
 */
const path = require('path');
const fs = require('fs');
const adb = require('./adb');
const emulators = require('./emulators');
const uimap = require('./uimap');
const verifySvc = require('./verify');
const mainimg = require('./mainimg');
const store = require('../store');
const sheet = require('./sheet');
const wp = require('../util/winpath');

const STEPS = ['上传图片…', '填标题正文', '填话题', '关联好物', '发布确认'];

function cfg() { return store.get('publish') || {}; }

/** 支持「还剩 N 秒」倒计时回调（真机日志：按 1 分钟间隔，57s 后执行） */
function sleep(ms, cancelled, onTick) {
  return new Promise(resolve => {
    const end = Date.now() + ms;
    let interval = null, timeout = null, settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };
    interval = setInterval(() => {
      if (cancelled && cancelled()) { finish(false); return; }
      if (onTick) onTick(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    }, 1000);
    timeout = setTimeout(() => finish(true), ms);
  });
}

/**
 * 取第一个「真正配过」的秒数，都没有就用最后一个兜底值。
 * ★★ 为什么不能用 `c.intervalSec || c.intervalMinSec || 60`：
 *    **0 是合法值**（0 = 连续发布，上一条发完直接发下一条），而 `0 || 60` 把它当成「没配」
 *    ⇒ 用户在界面选了「连续发布」却仍然等 60 秒，且界面上查不出原因。
 * ★ 顺带把字符串统一成数字：界面写回来的是字符串（`"0"`/`"60"`），
 *   `"60" * 1000` 侥幸对，但 `a + gap` 那种加法会退化成字符串拼接（预计耗时就算错了）。
 */
function secOr(...vals) {
  for (const v of vals) {
    if (v === '' || v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * 这一条发完、下一条开始之前要等多少秒。
 * - 图文：用界面上的「发布间隔」（0 = 连续发布）。
 * - 视频：`videoIntervalSec` **> 0 才生效**（单独放宽），否则跟随主间隔 ——
 *   0 在视频这一项里的含义是「跟随」，不是「连续」，别混。
 */
function gapSecFor(kind, c) {
  const base = secOr(c.intervalSec, c.intervalMinSec, 60);
  if (kind !== 'video') return base;
  const v = Number(c.videoIntervalSec);
  return Number.isFinite(v) && v > 0 ? v : base;
}

/* ---------------- 设备（一个设备 = 一个账号） ---------------- */

function devices() { return (cfg().devices) || []; }

function addDevice({ name, serial }) {
  const list = devices().slice();
  if (!serial) throw new Error('缺少设备序列号');
  if (list.some(d => d.serial === serial)) throw new Error('该设备已存在');
  // id 不能只用 Date.now()：连续添加两台会撞同一毫秒，删除时会连坐
  const dev = { id: 'dev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || serial, serial };
  list.push(dev);
  store.set({ publish: { devices: list } });
  return dev;
}

function removeDevice(id) {
  const list = devices().filter(d => d.id !== id);
  store.set({ publish: { devices: list } });
  return list;
}

/** 逐个探测在线状态；真机是多台雷电模拟器，一个设备对应一个账号 */
async function listDevices() {
  const list = devices();
  const out = [];
  for (const d of list) {
    const p = await adb.probe(d.serial);
    out.push({
      id: d.id, name: d.name, serial: d.serial,
      online: !!p.device, resolution: p.resolution, app: p.appPackage,
      // 「装了这个 apk」与「它是不是当前输入法」是两件事，两个都回给界面 ——
      // 中文能不能打进得物，只取决于后者。
      adbKeyboard: p.adbKeyboard, adbKeyboardActive: p.adbKeyboardActive,
      adbKeyboardCurrent: p.adbKeyboardCurrent, notes: p.notes
    });
  }
  return out;
}

/**
 * adb 现在认到的**全部**设备（含还没加进列表的）。
 * ★ 为什么必须有这个：以前界面上的「检测在线」只逐个 probe 配置里那几台 —— 配置是空的时候
 *   就永远列出空表，而自检的引导文案又写着「在下面的设备列表里点选用」，等于把用户指到一个
 *   空列表上（2026-10-02 用户实测踩到）。有了它，界面可以把 adb 认到的设备直接列出来，
 *   用户不必知道 emulator-5554 这种名字。
 */
async function scanDevices() {
  const conf = devices();
  const discovery = await emulators.connectDiscovered(adb, await emulators.discover());
  const raw = discovery.raw.slice();
  discovery.instances.forEach(v => {
    if (v.serial && !raw.some(d => d.serial === v.serial)) raw.push({ serial: v.serial, state: v.state });
  });
  // 端口尚未出现的启动实例也返回给界面，不能伪装成“没有设备”。
  const starting = discovery.instances.filter(v => !v.serial).map(v => ({
    serial: '', state: 'starting', online: false, configured: false, name: v.name, detail: v.detail
  }));

  // ★ 2026-10-03 实测：MuMu 12 会把**同一台模拟器**同时暴露在 16384 / 5555 / 7555 三个端口上，
  //   `adb devices` 里就是三行，界面上看着像「我明明只开了一个，怎么有两个序列号」。
  //   判据（同一实例，实测三端口完全一致）：`settings get secure android_id` 相同
  //   （本机 = 927145746ae845d6），`/proc/uptime` 也一致。
  //   ⇒ 这里用 android_id 当身份，把同一身份的多个串合并成一台，只留一个主串。
  //   读不到 android_id 的一律**不合并**（宁可多列，也不瞎合并成一台）。
  const idOf = {};
  await Promise.all(raw.filter(d => d.state === 'device').map(async d => {
    try {
      const r = await adb.shell(d.serial, 'settings get secure android_id', { timeout: 8000 });
      const v = String((r && r.stdout) || '').trim();
      if (/^[0-9a-f]{8,}$/i.test(v)) idOf[d.serial] = v;
    } catch (e) { /* 读不到就当它是独立的一台 */ }
  }));

  const byId = {};
  Object.keys(idOf).forEach(s => { (byId[idOf[s]] = byId[idOf[s]] || []).push(s); });
  const dupOf = {};
  const curSel = String((cfg().device) || '').trim();
  Object.keys(byId).forEach(k => {
    const ss = byId[k];
    if (ss.length < 2) return;
    // 主串优先级：已经加进列表的 > 当前正在用的 > 第一个
    const main = ss.find(s => conf.some(x => x.serial === s))
      || (curSel && ss.find(s => s === curSel))
      || ss[0];
    ss.forEach(s => { if (s !== main) dupOf[s] = main; });
  });

  return raw.map(d => {
    const c = conf.find(x => x.serial === d.serial);
    const main = dupOf[d.serial] || '';
    return {
      serial: d.serial, state: d.state, online: d.state === 'device',
      configured: !!c, id: (c && c.id) || '', name: (c && c.name) || (discovery.instances.find(v => v.serial === d.serial) || {}).name || '',
      detail: (discovery.instances.find(v => v.serial === d.serial) || {}).detail || '',
      dupOf: main,   // 非空 = 这台跟主串是**同一台设备**，界面上不再单列
      aliases: main ? [] : Object.keys(dupOf).filter(s => dupOf[s] === d.serial)
    };
  }).concat(starting, discovery.errors.length ? [{ serial: '', state: 'discovery-error', online: false, configured: false, name: '设备发现异常', detail: discovery.errors.join('；') }] : []);
}

function rand(a, b) { return Math.round(a + Math.random() * Math.max(0, b - a)); }

/**
 * 这条到底发视频还是图文。优先级：
 *   发布行上的 kind（从「AI 内容报告」导入时按「内容类型」列判定好）→ 行上的内容类型原文 → 目录里实际有什么。
 * 两样都有、又没标内容类型 → 返回 ''（判不了），由调用方明确报错 —— 绝不猜着发错内容。
 */
function rowKind(row, item = {}) {
  const declared = (row && row.kind) || wp.contentKind(row && row.contentType);
  if (declared === 'image' || declared === 'video') return declared;
  const files = (item && item.files) || [];
  const nImg = files.filter(f => f.type === 'image').length;
  const nVid = files.filter(f => f.type === 'video').length;
  if (nVid && !nImg) return 'video';
  if (nImg) return 'image';
  return '';
}

/**
 * 预估耗时。
 * 单条技术下限：图文 ≈30 秒（真机实测 65–80s，含固定间隔）；视频 push 抖动大、上传久，
 * 还要多等一段「媒体库索引到相册」，所以按 60 秒算 —— 以前拿图文那一套算视频，预估会明显偏短。
 * kinds 传 { image, video } 可分别计；不传就全按图文算（保持老调用方式）。
 */
function estimate(count, kinds = null) {
  const c = cfg();
  const per = kind => {
    const isV = kind === 'video';
    // ★ 这里原来有一支 `c.mock ? 5 秒` 的「演示节奏」——2026-10-02 按用户要求删掉：
    //   它是个纯演示开关，却会让**真实发布**也用 5 秒间隔。现在只按真实配置算。
    // ★ 2026-10-03：视频间隔【跟随用户在界面上设的那个】，不再自作主张放宽到 90 秒 ——
    //   用户设 60 秒却跑出 90 秒，界面上还查不到原因（设置页根本没有「视频间隔」这一项）。
    //   真需要单独放宽时，显式配置 videoIntervalSec 即可（>0 才生效）。
    // ★ 与真实发布同一个取法（gapSecFor）：0 = 连续发布 ⇒ 预估里也不该加那 60 秒。
    const avg = gapSecFor(isV ? 'video' : 'image', c);
    return avg + (isV ? 60 : 30);
  };
  const nImg = kinds ? (Number(kinds.image) || 0) : count;
  const nVid = kinds ? (Number(kinds.video) || 0) : 0;
  const seconds = nImg * per('image') + nVid * per('video');
  return { minutes: Math.round(seconds / 60), seconds: Math.round(seconds), image: nImg, video: nVid };
}

/* ---------------- 真实通道 ---------------- */

async function connect(device) {
  const c = cfg();
  const list = devices();
  const map = c.uiMap;
  const hasMap = !!(map && map.steps && map.steps.length);
  // ★★ 这里**绝不许**再兜底一个 'emulator-5554'（2026-10-02 删掉）：
  //    没配设备时就该老实说「还没选设备」。原来那句硬编码兜底会拿一台不存在的设备去 probe，
  //    界面报出来却是「你选的设备「emulator-5554」没连上」—— 用户以为程序里写死了一台假设备。
  const serial = device || c.device || (list[0] && list[0].serial) || '';
  if (!serial) {
    return {
      connected: false, mode: 'mock', device: '', probe: null, hasMap,
      note: '还没选设备：到「设备管理」点「扫描设备」，从列出来的设备里点那一行的「加入并使用」—— 不用手填序列号。'
    };
  }
  const p = await adb.probe(serial);
  // ★★ 「能不能发布」**不许**拿「此刻这一屏抓不动」当判据（2026-10-03 修）：
  //    得物发布页是**动画页**，uiautomator 抓不到是常态，程序本来就有 dumpsys 备用通道
  //    （runStep 用的 dumpEx 会自动退过去）。原来这里把 tools.uiautomator 算进 ready ⇒
  //    模拟器正停在发布页（＝要发布前的正常状态）时 ready=false ⇒ mode 被写成 'mock'
  //    ⇒ 用户点「开始发布」一路「模拟成功」，模拟器里毫无动静。这就是「老是有那么多问题」的那个坑。
  //    判据改成：设备在 + 能输入 + 认得出得物 + **两条抓取通道至少通一条**。
  const canSee = !!(p.tools.uiautomator || p.tools.dumpsys);
  const ready = !!(p.device && canSee && p.tools.input && p.appPackage);
  const notes = p.notes.slice();
  if (ready && !(map && map.steps && map.steps.length)) {
    notes.push('还没配 UI 定位表（「设置 → 高级设置」→「抓取页面结构」→ 导入），配好前不会走真实通道'
      + '；抓之前先把模拟器停在得物发布页 —— 推荐走底部「我」→ 右上角「主页」→「发布新动态」（3 跳，入口都带文字，稳）；也可以点动态流右上角那个没文字的相机图标（1 跳）');
  }
  return {
    connected: ready,
    mode: ready ? 'adb' : 'mock',
    device: serial,
    probe: p,
    hasMap,
    note: ready
      ? `设备 ${serial} 在线（${p.resolution || '分辨率未知'}，得物 ${p.appPackage}）` + (map && map.steps ? ' · UI 定位表已就绪' : ' · 待配 UI 定位表')
      : (p.adb ? '设备不满足真实发布条件，已切模拟通道：' + notes.join('；') : '未检测到 adb，已切模拟通道')
  };
}

function failDir() { return path.join(store.get('paths.output'), 'failures'); }

async function saveShot(serial, tag, ctx) {
  try {
    const buf = await adb.screencap(serial);
    if (!buf || !buf.length) return null;
    const dir = failDir();
    await wp.mkdirp(dir);
    const f = path.join(dir, `${tag}_${Date.now()}.png`);
    await fs.promises.writeFile(wp.toLong(f), buf);
    if (ctx && ctx.log) ctx.log(`已存失败截图 ${path.basename(f)}`, 'warn');
    return f;
  } catch (e) { return null; }
}

/**
 * ★★ 屏幕守卫（whenOn / whenNotOn）—— 2026-10-03 加。
 *
 * 与 `when / whenNot` 的区别：那一套判的是**数据**（这一行填没填货号），
 * 这一套判的是**当前这一屏长什么样**。真机上确实有「同一颗按钮落到哪一屏取决于 App 状态」
 * 的情况，最典型的就是入口最后一跳被**草稿箱**接走（见 uimap.DEWU.draft）。
 *
 * 拿不到界面结构时**不许猜**：猜「大概不在草稿箱吧」的后果是漏点一步、然后卡在下一条，
 * 而报错会指向下一条步骤（离真正的原因很远）—— 所以这里当场说清楚是哪一步、缺什么。
 */
async function screenGuard(serial, step, ctx, preferAnimOff) {
  const ids = String(step.whenOn || '').split(',').map(s => s.trim()).filter(Boolean)
    .concat(String(step.whenNotOn || '').split(',').map(s => s.trim()).filter(Boolean));
  // ★★ 2026-10-04 提速实测：守卫的 dump 原来默认 `retries:1`（失败多等一轮），
  //   而相册页这类「永不 idle」的屏每轮要白等 ~11s（实测 11.4s/次）⇒ 一条内容里几个守卫步
  //   叠加起来就是几十秒的纯等待（用户投诉「整体速度为什么那么慢」）。
  //   ⇒ 守卫**不重试**（retries:0），并把「这一屏要不要关动画」交给**按步骤名学习**的缓存：
  //     同一个步骤名（定位表里写死的，不随数据变）第一次撞上就关动画抓、抓完记下来，
  //     后面每一条内容的同一步直接走「关动画」路径（实测关动画后 ~2s 就能抓到）。
  const d = await adb.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: !!preferAnimOff });
  if (!d.ok) {
    // ★★ 2026-10-04：**已经决定要抛错了**，这时候才附带一句「设备在不在线」——
    //   设备掉线时那串「dump 没有任何输出 / 备用通道也跑不起来」会把排查带偏到「页面不 idle」上，
    //   而真因是设备掉了（处置完全不同：重连 / 重启模拟器）。
    //   ★ 只在**这一条报错路径**上调，成功路径一个字节都不变（也免得污染调用序列）。
    const hint = await adb.offlineHint(serial);
    throw new Error(`「${step.name || step.value}」这一步要先看当前这一屏有没有 `
      + `${ids.join(' / ')}，但拿不到界面结构：${d.why}${hint}`);
  }
  if (d.via === 'dumpsys' && ctx && ctx.log) {
    ctx.log('屏幕守卫走的是 dumpsys 备用通道（只有 id / 坐标，没有文字）', 'warn');
  }
  const g = uimap.screenCondOk(step, uimap.parseNodes(d.xml));
  if (!g.ok && ctx && ctx.log) ctx.log(`屏幕守卫拦下这一步：${g.why}`, 'info');
  // ★★ 2026-10-04 提速（用户投诉「选择素材太慢」的直接来源）：
  //   「这一屏不 idle」是**屏幕的性质**，与「守卫条件成不成立」无关 —— 所以**在成功和失败两条
  //   路径上都要把它学下来**。原来只在成功路径记（runStep 里 `if (g.ok)` 之后），而弹窗守卫
  //   （「未完成草稿拦截 · 点放弃」）绝大多数情况下**条件不成立 ⇒ 直接 return skipped**，
  //   于是每一条内容走到这一步都要**重新白等一次 idle 超时**。真机实测：该步每条 **13.5s**，
  //   而这 13.5s 里没有任何有效动作（就是在等一个永远不来的 idle）。
  //   ⇒ 只要 dump 这次是**关着动画**才抓到的（`d.animOff`），当场记进按步骤名共享的缓存。
  if (d.animOff && ctx && ctx.animOffSteps && step.name && !ctx.animOffSteps[step.name]) {
    ctx.animOffSteps[step.name] = true;
    if (ctx.log) {
      ctx.log('页面一直不 idle，已临时关掉系统动画抓到结构（抓完已还原）；'
        + '本批后面再遇到这一步就直接走关动画，不再白等那 ~11 秒', 'warn');
    }
  }
  // ★ 2026-10-03 提速：把刚抓到的那份结构**带回去**给同一步的点击用（见 runStep 的 reusedXml）。
  //   一个守卫步原来要抓两次屏（守卫一次 + tapId 一次，实测 ~2×1-2s），现在只抓一次。
  // ★★ 2026-10-04：把 `animOff`（这一屏抓的时候是不是关着动画）也带回去 ⇒ runStep 把它记进
  //   `animOffSteps[stepKey]`，下一条内容走到同一步就不用再撞一次。
  return Object.assign({}, g, { xml: d.xml, animOff: !!d.animOff });
}

async function runStep(serial, step, data, ctx) {
  // ★ 屏幕守卫先判：不成立就**一个像素都不碰**，如实返回 skipped（交给调用方写日志）。
  //   reusedXml = 守卫刚抓到的那份结构；同一步的点击可以在**第 1 次尝试**直接用它，
  //   省掉第二次抓屏（实测一次 dump ~1-2s）。中间没有任何动作 ⇒ 结构一定新鲜。
  // ★ 2026-10-03 提速：这一步这一屏会不会 idle —— 由批次里共享的缓存决定。
  //   键用**步骤名**（定位表里写死的、不随数据变），所以同一条内容里的同一步、以及
  //   后面每一条内容的同一步，都命中同一个键。缓存只在这一次发布里有效，不落盘。
  const stepKey = (step && (step.name || (step.action + ':' + step.value))) || '';
  const animOffSteps = (ctx && ctx.animOffSteps) || null;
  const wantAnimOff = !!(animOffSteps && stepKey && animOffSteps[stepKey]);
  let reusedXml = null;
  if (step && (step.whenOn || step.whenNotOn)) {
    const g = await screenGuard(serial, step, ctx, wantAnimOff);
    if (!g.ok) return { skipped: true, why: g.why };
    reusedXml = g.xml || null;
    // ★★ 2026-10-04：守卫这一屏是关着动画抓到的 ⇒ 记下这个步骤名，本批后面同一步直接走关动画
    //   （实测相册页那类屏，不关动画每轮白等 ~11s；关掉后 ~2s 就抓到）。
    if (g.animOff && animOffSteps && stepKey && !animOffSteps[stepKey]) animOffSteps[stepKey] = true;
  }
  switch (step.action) {
    case 'tapText': case 'tapId': case 'tapDesc': case 'tapCardText': {
      const cond = (step.action === 'tapText' || step.action === 'tapCardText') ? { text: step.value }
        : step.action === 'tapId' ? { id: step.value } : { desc: step.value };
      // ★★ 找不到节点**不立刻判失败**（2026-10-03 真机实测）：
      //    关联好物搜索页「输完货号 → 结果图墙加载」那一两秒里，uiautomator 常常抓不到 idle ⇒
      //    第一次 dump 要么退到没文字的备用通道、要么干脆空手；一次就判失败的表现是
      //    「页面结构变了」这种假故障，而其实再等半秒就好。重试 3 次再报，并把每次重试写进日志。
      let node = null, nodes = [], lastWhy = '', lastNoText = false;
      // ★ 「点前 N 个匹配」用的：want = 要一次点几个，hit = 这一屏实际找到几个
      let want = 1, hit = [], lastFound = -1;
      for (let attempt = 0; attempt < 3; attempt++) {
        // ★ 必须带包名：发布页是**动画页**，uiautomator 抓不到时只有带上包名才会退到 dumpsys。
        //   （以前这里不传 pkg ⇒ 备用通道永远走不到 ⇒ 真机上按 id 点「关联好物」直接失败；
        //    而「抓取页面结构」那条路一直带着包名，所以这个洞一直没被暴露。）
        //   代价如实说：备用通道**没有文字** ⇒ 那一屏上按文字找的步骤仍然找不到（但按 id 的能过）。
        let d;
        if (attempt === 0 && reusedXml) {
          // ★ 2026-10-03 提速：守卫刚抓过、并且确认过就是这一屏 ⇒ 不再抓第二次。
          d = { ok: true, xml: reusedXml, why: '', via: 'screenGuard' };
          reusedXml = null;   // 只复用一次
        } else {
          // ★ 2026-10-03 提速：这里**不要** dumpEx 内部的「重试 1 次 / 隔 1200ms」——
          //   外层这个 for(attempt<3) 本来就会重试（每次先抓屏再找，间隔 450ms），
          //   两层叠加只会让「页面还没就绪」时白等一轮又一轮。
          // ★ 2026-10-03 提速：这里**不要** dumpEx 内部的「重试 1 次 / 隔 1200ms」——
          //   外层这个 for(attempt<3) 本来就会重试（每次先抓屏再找，间隔 450ms），
          //   两层叠加只会让「页面还没就绪」时白等一轮又一轮。
          //   preferAnimOff：这一屏已知不会 idle ⇒ 直接关动画抓，不再白等那 ~11 秒。
          d = await adb.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: wantAnimOff });
        }
        if (!d.ok) {
          lastWhy = `拿不到界面结构：${d.why}${d.idle ? '（这个页面一直不 idle）' : ''}`;
          if (attempt < 2) { await sleep(450); continue; }
          // ★★ 2026-10-04：要抛错了，这时才附带一句「设备在不在线」（见 adb.offlineHint）。
          throw new Error(lastWhy + (await adb.offlineHint(serial)));
        }
        if (d.animOff) {
          // ★ 把「这一步这一屏不会 idle」记下来（键 = 步骤名）。本批后面再遇到同一步就直接
          //   走关动画，不再先白等一次 idle 超时（真机实测相册页那一下 11.1s，关动画后 2s）。
          //   必须**说出来**（只第一次说）：静默换通道会让人以为「这次怎么变快了」无从解释。
          const learned = !!(animOffSteps && stepKey && !animOffSteps[stepKey]);
          if (learned) animOffSteps[stepKey] = true;
          if (ctx && ctx.log) {
            ctx.log('页面一直不 idle，已临时关掉系统动画抓到结构（抓完已还原）'
              + (learned ? '；本批后面再遇到这一步就直接走关动画，不再白等那 ~11 秒' : ''), 'warn');
          }
        }
        lastNoText = !!d.noText;
        if (d.noText && ctx && ctx.log) {
          ctx.log('这一屏是动画页，已走 dumpsys 备用通道（只有 id / 坐标，没有文字）', 'warn');
        }
        nodes = uimap.parseNodes(d.xml);
        // ★★ 「点前 N 个匹配」：N 来自这一步的 count（缺省 1 = 老行为，只点第一个）。
        //    为什么要有 N：得物相册的缩略图没有文字/描述，只能按 resource-id 点，
        //    而「取第一个匹配」⇒ 一条内容多张图时只选上第 1 张（其余图白推了）。
        //    张数写 ${imageCount}（这个叶子真实的图片数，见下面的 data）。
        want = uimap.countOf(step.count);
        // count 写了但解析不出 ≥1 的数（数据里没有图片清单）⇒ **不许默默按 1 张发**：
        // 发出去才发现少图是最难查的那种错（对不上发布单、也没有任何报错）。当场说清楚。
        if (step.count != null && step.count !== '' && !(Number(step.count) >= 1)) {
          throw new Error(`这一步的「count」解析成了「${step.count}」——它要是 ≥1 的整数。`
            + `写 ${'${imageCount}'} 时，这个值来自「这条素材里有几张图」；这条记录里读不到图片清单`
            + `（报告导入的老行可能没有）⇒ 改成固定数字，或先把素材重新扫一遍。`);
        }
        const exact = uimap.findNodes(nodes, cond).filter(x => x && x.center);
        const rawHit = exact.length ? exact : uimap.findNodes(nodes, { contains: step.value }).filter(x => x && x.center);
        // ★★ tapCardText：颜色文字**不是**选中卡片的开关
        //   （真机实测：点它弹「选择商品规格」）。这里把「颜色文字」
        //   换算成「包住它的那张商品图」，点图心才等于选中整张卡。
        hit = step.action === 'tapCardText'
          ? rawHit.map(h => uimap.cardOf(nodes, h, step.card)).filter(x => x && x.center)
          : rawHit;
        // 找到了文字却没有卡包住它 ⇒ 版式变了 / card 写错了。
        // 不能软退成「点第一张就算了」——点错卡是静默挂错商品，最难查。
        if (step.action === 'tapCardText' && rawHit.length && !hit.length) {
          throw new Error(`找到了「${step.value}」，但没有任何一张「${step.card}」把它包住 —— `
            + `结果页的版式变了，或者 card 写错了。不瞎点（点错卡＝挂错商品）。`);
        }
        // ★★★ 2026-10-04 真机实测（用户指出）：得物贴完文案后会**自动识别视频中的好物**，
        //   识别期间「关联好物」那一行是 `clickable=true` 但 **`enabled=false`** ——
        //   系统不响应任何点击（点左侧文字区、点右侧箭头都一样），
        //   而表现是「点了没反应 → 400ms 后抓屏还是这一屏 → 后面那步报找不到搜索框」，
        //   报错指向的位置离真因很远。
        //   ⇒ 这一步若写了 `waitEnabled:true`：
        //     **有节点但不可用 = 还没到能点的时候**，继续等（不点、不报错）；
        //     等到可用再点。等不到仍如实报「一直处于禁用状态」——不硬点。
        //   ★ 等待次数可配（`waitEnabledTries`，缺省 3）：得物自动识别视频好物实测要十几秒，
        //     默认那 3 次（≈8s）根本不够 ⇒ 好物这一步会「等不到」而失败。
        //   ★★ 这一分支**不能用外层 for 的 attempt<3 限制** —— 那 3 次是给「节点还没渲染出来」用的，
        //     和「节点在、但禁用中」是两件事。这里自己数次数、自己等。
        if (step.waitEnabled) {
          const tries = Number(step.waitEnabledTries) > 0 ? Number(step.waitEnabledTries) : 3;
          let waitedForEnable = 0;
          for (;;) {
            hit = (step.action === 'tapCardText'
              ? rawHit.map(h => uimap.cardOf(nodes, h, step.card)).filter(x => x && x.center)
              : rawHit);
            const usableNow = hit.filter(n => n.enabled !== false);
            if (usableNow.length >= want) { hit = usableNow; break; }   // 可用且够数 ⇒ 出去点
            if (!hit.length && attempt < 2) break;                       // 节点都没出现 ⇒ 交给外层重试
            if (waitedForEnable >= tries) {
              throw new Error(`「${step.value}」等 ${(waitedForEnable * 0.7).toFixed(1)}s 仍是禁用状态`
                + `（enabled=false，得物正在自动识别视频中的好物，识别期间这一行不可点）。`
                + `不硬点。要么识别卡住了，要么得物改版了。`);
            }
            waitedForEnable++;
            if (ctx && ctx.log && (waitedForEnable === 1 || waitedForEnable % 3 === 0)) {
              ctx.log(`「${step.value}」还不可点（得物正在自动识别视频好物）——已等 `
                + `${(waitedForEnable * 0.7).toFixed(1)}s，继续等`, 'info');
            }
            await sleep(700);
            const d2 = await adb.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: wantAnimOff });
            if (d2.ok) { nodes = uimap.parseNodes(d2.xml); rawHit = uimap.findNodes(nodes, cond).filter(x => x && x.center); }
          }
        }
        hit = (step.action === 'tapCardText'
          ? rawHit.map(h => uimap.cardOf(nodes, h, step.card)).filter(x => x && x.center)
          : rawHit);
        if (hit.length >= want) { node = hit[0]; break; }
        lastFound = hit.length;
        if (attempt < 2) {
          if (ctx && ctx.log) ctx.log(`还没看到「${step.value}」，等半秒再抓一次（第 ${attempt + 2} 次）`, 'info');
          await sleep(450);
        }
      }
      if (!node || !node.center) {
        // ★ 走到 dumpsys 备用通道就**拿不到文字**：这时候说「找不到文字」等于没说，
        //   必须点明是通道的问题、并给出唯一可行的改法（改成 tapId 用 resource-id）。
        //   不加这一段的话，报错会退化成「找不到「发布」；当前可见文本：（空）」—— 比原来那句
        //   「拿不到界面结构：…这个页面一直不 idle」还难查。
        if (lastNoText && step.action !== 'tapId') {
          throw new Error(`找不到「${step.value}」：这一屏是动画页，已走 dumpsys 备用通道，`
            + `而那条通道**拿不到文字** —— 按${step.action === 'tapDesc' ? '描述' : '文字'}找的步骤在这屏上用不了。`
            + `把这一步的 action 改成 tapId（value 填 resource-id）就能过。`);
        }
        if (want > 1) {
          throw new Error(`这一步要一次点 ${want} 个「${step.value}」，但这一屏上只找到 `
            + `${Math.max(0, hit.length)} 个（前几次更少：${lastFound}）—— 不静默少点（少发一张图，`
            + `发出去才发现，最难查）。要么把 count 改小，要么确认素材真的都推进相册了。`);
        }
        const visible = nodes.filter(n => n.text).slice(0, 10).map(n => n.text).join(' / ');
        throw new Error(`找不到「${step.value}」；当前可见文本：${visible || '（空）'}`);
      }
      // ★ 要几个就点几个（顺序 = dump 顺序 = 界面上从前往后）。
      //   中间留 250ms：相册点中一格会出现选中角标、右下角按钮文字会变成「下一步 (2)」，
      //   连着点太快有被系统当成同一次手势的风险。
      const pickList = hit.slice(0, want);
      // ★ 2026-10-03 加速：多点一次 shell 发完（设备端 sleep 250ms 间隔），
      //   比「一条一条发 + JS 侧 sleep」少 N-1 次往返（实测 3 击 380ms → 127ms）。
      //   250ms 间隔的原因没变：相册点中一格会出现选中角标、右下角按钮会变成「下一步 (2)」，
      //   连着点太快有被系统当成同一次手势的风险。间隔值可调（见定位表 count 那段注释）。
      const r = await adb.tapSeq(serial,
        pickList.map(n0 => ({ x: n0.center.x, y: n0.center.y })),
        pickList.length > 1 ? 250 : 0);
      if (!r.ok) throw new Error('点击失败：' + (r.stderr || '').trim());
      if (want > 1 && ctx && ctx.log) {
        const pts = pickList.map(n0 => n0.center.x + ',' + n0.center.y).join(' / ');
        ctx.log(`${step.name || step.value}：一次点了 ${want} 个（相册按时间倒序，点的是最前面 ${want} 格；坐标 ${pts}）`, 'info');
      }
      return;
    }
    case 'tapXY': {
      // ★ 按**固定坐标**点，不抓屏（2026-10-03 加速）。
      //   坐标从定位表 value 解析（"x,y"，多个点用 ; 分隔）。
      //   解析不出坐标 → 当场报错，**绝不**默默点 (0,0)（那会点到屏幕左上角，等于乱点）。
      //   为什么快：这台模拟器 `uiautomator dump` 单次 ~1.5s，而 `input tap` 只要 ~0.13s；
      //   版式固定的按钮（底部我 / 主页 / 下一步 / 标题框 / 提交发布…）每次点前抓一次屏，
      //   一条内容就白花十几秒。
      //   ★ 代价：没有「找不到就不点」的保护。定位表里只该给**版式固定、且下一步能立刻
      //     发现异常**的格子用它；要保险就配 whenOn 屏幕守卫。
      const pts = uimap.parsePoints(step.value);
      if (!pts.length) {
        throw new Error(`这一步（tapXY）的坐标解析不出来：「${step.value}」—— `
          + `要写成 "540,1871" 这种 x,y 形式（多个点用分号隔开）。`);
      }
      // ★★★ 2026-10-04 新增：**越界即拦**（坐标空间守卫的最后一道）。
      //   为什么必须在真正发 tap 之前拦：`input tap` 对越界坐标**不报错** ——
      //   实测在 1920x1080 的屏上 `input tap 945 1869` 返回 rc=0、一个字都不说、什么都没点到。
      //   所以「写死的坐标落到了屏幕外」在真机上表现为**每一步都安静地点偏**，日志一条错都没有。
      //   尺寸从 `adb.uiSize()` 取（= `dumpsys window displays` 的 `cur=`，那才是 tap 用的坐标系；
      //   不能拿 `wm size`：它报的是自然方向尺寸，横屏时会给出相反的宽高）。
      //   ★ 读不到尺寸（known=false）时**不拦** —— 拿一个猜的尺寸判越界就是拿幻觉当判据。
      //   尺寸只读一次，缓存在 ctx 里（同一次发布里坐标系不会变）。
      if (!ctx.uiSize) ctx.uiSize = await adb.uiSize(serial);
      const badPts = uimap.outOfScreenTapPoints([step], ctx.uiSize);
      if (badPts.length) {
        const sz = ctx.uiSize;
        throw new Error(`这一步（${step.name || 'tapXY'}）写死的坐标落在屏幕之外：`
          + badPts.map(p => `${p.x},${p.y}`).join(' / ')
          + `；当前坐标系是 ${sz.w}x${sz.h}（${sz.landscape ? '横屏' : '竖屏'}）。`
          + `input tap 对越界坐标**不报错**（实测 rc=0、什么都没点到）⇒ 不拦就是全程静默点偏。`
          + `多半是抓定位表时的分辨率/方向和现在不一样：把模拟器调回去，或停到得物发布页`
          + `重新「抓取页面结构」→ 导入。`);
      }
      const r = await adb.tapSeq(serial, pts, pts.length > 1 ? 250 : 0);
      if (!r.ok) throw new Error('点击失败：' + (r.stderr || '').trim());
      if (pts.length > 1 && ctx && ctx.log) {
        ctx.log(`${step.name || 'tapXY'}：一次点了 ${pts.length} 个坐标（${pts.map(p => p.x + ',' + p.y).join(' / ')}）`, 'info');
      }
      return;
    }
    case 'input': {
      // ★ 输入通道（中文必须走 ADBKeyboard 广播）由 adb.inputText 自己按**设备真实输入法状态**
      //   判定 —— 以前这里传的是配置项 `publish.adbKeyboard`，而那个键全仓没有任何地方会写它
      //   （界面没有开关、默认配置里也没有）⇒ 恒为假 ⇒ 中文永远走 `input text`（实测打不进中文、
      //   却返回成功）⇒ 帖子会发出去但标题正文是空的，日志还写「发布成功」。
      const r = await adb.inputText(serial, step.value);
      if (!r.ok) throw new Error('输入失败：' + (r.stderr || '').trim());
      // ★★★ 2026-10-04 新增：**回读**输入框，确认这串字真的进去了。
      //   为什么非有不可：广播通道**永远返回成功**，而「没进去」与「进去了」在截图/日志上完全一样
      //   （框空着的时候 text 就是占位符「添加标题」）。今晚真机实测有两种静默失败都栽在这上面，
      //   而且都会被记成「发布成功」：
      //     · 空格被改写成**字面 `%s`** 打进标题（已修，见 adb.inputText）；
      //     · 输入法不是 ADBKeyboard 时中文**整串丢失**，广播照样返回成功。
      //   校验对象 = **紧邻的上一步 tapId 点的那个框**（由 runReal 传进来；只认紧邻 ⇒ 话题步不会误报）。
      //   判据：完全一致，或以「期望串的前 12 个字符」开头（得物可能对标题做截断/规整）。
      //   读不到结构时**既不算失败也不算通过**，如实告警（本项目口径：「读不到 ≠ 成功」）。
      const checkId = String((ctx && ctx.inputCheckId) || '');
      if (checkId) {
        const want = String(step.value == null ? '' : step.value);
        const got = await adb.readTextOf(serial, checkId, { pkg: uimap.DEWU.pkg });
        if (!got.ok) {
          if (ctx && ctx.log) ctx.log(`「${step.name || '输入'}」回读不到，无法确认填进去没有（${got.why}）`, 'warn');
        } else {
          // 比对前**先把空白全部去掉**：正文是多行的（`\n`），而 dump 把换行渲染成什么形态
          // 不可控（`&#10;` / 真换行 / 空格）⇒ 拿原文比会**假报不一致**。
          // 这一步要抓的是「整串丢了 / 被改写成 %s」这类**内容级**损坏，空白差异不在判据里。
          const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, '');
          const wn = norm(want);
          const gn = norm(got.text);
          const head = wn.slice(0, Math.min(12, wn.length));
          const same = gn === wn || (!!head && gn.startsWith(head));
          if (!same) {
            throw new Error(`输入回读不一致：「${step.name || checkId}」期望的是 `
              + `${JSON.stringify(want.slice(0, 24))}…（共 ${want.length} 字），`
              + `而框里实际是 ${JSON.stringify(String(got.text).slice(0, 40))}`
              + ' —— 这串字没原样进去（常见原因：空格/emoji 被通道改写、或当前输入法不是 ADBKeyboard）。'
              + ' 不许按「大概填上了」继续往下点，否则会发出一条标题/正文不对的帖子。');
          }
          if (ctx && ctx.log) ctx.log(`「${step.name || '输入'}」已回读确认填进去了（${got.text.length} 字）`, 'info');
        }
      }
      return;
    }
    case 'wait':
      await sleep(Math.max(0, Number(step.value) || 1000));
      return;
    case 'waitId': {
      // ★★ 2026-10-03 真机实测加：等到**某一块出现**再往下走（两屏之间的转场）。
      //   图文干跑实测卡死点：得物「相册 → 图片编辑页」是异步转场，紧接着点「下一步」会白点，
      //   而报错会指向**后面**找 etTitle 那一步（离真正原因很远，最难查的那类）。
      //   这里等不到就硬失败并点名等的是什么 —— 绝不硬点（硬点只会点到别的屏上）。
      const wantId = String(step.value || '').trim();
      if (!wantId) throw new Error('这一步（waitId）没写要等的 resource-id');
      const tmo = Math.max(1000, Number(step.timeout) || 10000);
      const t0 = Date.now();
      for (;;) {
        const d = await adb.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: wantAnimOff });
        if (d.ok && uimap.parseNodes(d.xml).some(n => String(n.id) === wantId)) return;
        const waited = Date.now() - t0;
        if (waited >= tmo) {
          throw new Error(`等了 ${(waited / 1000).toFixed(1)}s 也没等到「${wantId}」出现`
            + (d.ok ? '' : `（连界面结构都抓不到：${d.why}）`)
            + ' —— 要么前一屏那一下没点动，要么得物改版了。不硬点下一步。');
        }
        if (ctx && ctx.log) ctx.log(`等「${wantId}」出现…（已等 ${Math.round(waited / 1000)}s）`, 'info');
        await sleep(400);
      }
    }
    case 'back':
      await adb.keyevent(serial, 4);
      return;
    case 'screenshot':
      await saveShot(serial, step.value || 'shot', ctx);
      return;
    default:
      throw new Error('未知步骤类型：' + step.action);
  }
}

/**
 * 抓界面结构（给「抓取页面结构」按钮用）—— 比 adb.dumpEx 多一层「你现在停在哪一屏」。
 *
 * 为什么必须先看这一屏：dump 抓的**就是当前这一屏**。抓错页面的代价是**一份错坐标的表**，
 * 而错坐标不会当场报错 —— 它会一路点到「发布成功」（本项目已经吃过这个亏，见 HANDOFF ⑪）。
 * 已知的两个坑（真机实测）：① 得物首页自己的 tab 栏里也有一个「视频」（`tvTabTile`），
 * 抓成首页就被它污染；② 发布页首屏是「选素材」，抓它才配得出 `ivCamera → 选图 → 下一步 …` 这一串。
 *
 * 分三档处理（不是一刀切拦住）：
 *   · 读不到 focus（命令失败/正则没匹配）→ **照常抓**：这是"检查没做成"，不是"抓错页面"；
 *   · 读到了但**不是得物** → **拦下来**并给出「怎么进发布页」（那时抓出来的是桌面，表毫无意义）；
 *   · 是得物但**不是发布页** → 照常抓 + 明确告警（「填标题」「搜货号」这些后续屏本来也要抓）。
 */
async function dumpForCapture(serial, opts) {
  const focus = await adb.currentFocus(serial);
  if (focus && !uimap.isDewuFocus(focus)) {
    return {
      ok: false, blocked: true, focus, animOff: false,
      why: `现在屏幕上不是得物 —— 前台是「${focus}」。${uimap.DEWU.entryHow}，停在发布页再点「抓取页面结构」`
    };
  }
  // ★ 抓取要带上包名：uiautomator 对**持续动画的页面**（发布页首屏）永远抓不到，
  //   带上包名后 dumpEx 才能退到 dumpsys 备用通道（见 adb.js 的 dumpViaDumpsys）。
  const pkg = (String(focus || '').match(/^([a-zA-Z0-9_.]+)\//) || [])[1] || uimap.DEWU.pkg;
  const d = await adb.dumpEx(serial, Object.assign({}, opts, { pkg }));
  const onPublish = uimap.isPublishScreen(focus);
  const focusNote = (!focus || onPublish) ? ''
    : `★ 你现在抓的不是发布页首屏，而是「${focus}」—— 候选表是按**这一屏**猜的。`
      + `如果这一步本来就要抓后面某一屏（填标题 / 搜货号），那是对的；`
      + `如果本来想抓发布页首屏：${uimap.DEWU.entryHow}，停在那一屏再抓。`;
  // ★ 如实告知：走了备用通道就得说清楚它少了什么（没有文字），不能让用户以为抓到的一样全
  const viaNote = d.via === 'dumpsys'
    ? '★ 这一屏是**动画页**（uiautomator 等不到 idle，实测连试十几次全败），已自动改用 dumpsys 抓：'
      + '**控件 id / 坐标 / 是否可点**都有，但**没有文字** —— 候选表里按文字找的步骤要手动改或用 id 代替。'
    : '';
  // ★★ 2026-10-04 新增：把**抓取时的坐标系**一起带回去 —— 它会写进生成的定位表（`uimap.suggest` 的
  //   `screen` 戳），运行时靠它判「这张表是不是在另一个坐标系里量的」（见 runReal 的坐标空间守卫）。
  //   ★ 只在**确认前台是得物**时才量：坐标系跟着前台应用的方向走（得物竖屏 1080x1920 /
  //     MuMu 桌面横屏 1920x1080，实测同一台机器两种都有）—— 不是在得物上量的尺寸，不能拿来给这张表背书。
  //     读不到 focus 时量出来的尺寸归属不明 ⇒ 记 null，如实「没戳」，绝不编一个。
  const screen = uimap.isDewuFocus(focus) ? await adb.uiSize(serial) : null;
  return Object.assign({}, d, { focus, focusNote, onPublish, viaNote, screen });
}

/**
 * ★★★ 2026-10-04 新增（用户口径，原话）：「**发出去了才算成功**」。
 *
 * 为什么必须有这一步：点完「提交发布」**不等于**发出去了。真机上「没发出去」有好几种长相，
 * 而且**每一种在界面上都像成功**（脚本已经跑完、没有报错）：
 *   · 得物压根没受理，还停在发布流程里（编辑页/封面页）；
 *   · 得物把它当成**草稿**存下来了（用户原话：「我什么时候跟你说真实发布环境可以存草稿的」）；
 *   · 提交按钮被屏幕守卫跳过（那一屏不对 ⇒ 一个 tap 都没发）。
 * 前两种如果不判，台账就写着「发布成功」，而账号里其实什么都没有（或躺着一条草稿）。
 *
 * 判据（只看前台 Activity，便宜且能区分）：
 *   **必须离开发布流程** —— 既不在 `TotalPublishProcessActivity`，也不在草稿箱 `DraftActivity`。
 *   ★ 为什么不看「有没有发布成功页」：那要抓屏、且得物改版就废；而「有没有离开这一摊」
 *     是从用户诉求直接翻译过来的判据，改版也稳。
 *   ★ 读不到前台（空）时**不算离开** —— 读不到 ≠ 成功（同本项目一贯口径）。
 *
 * @returns {{ok:boolean, waited:number, focus:string, left:string, seen:string[]}}
 *   `seen` = 这段时间里前台的**变化序列**，如实带回去给人看（排查「它到底停在哪一屏」全靠它）。
 */
async function waitLeftPublishFlow(serial, { timeoutMs = 15000, pollMs = 600, cancelled = null } = {}) {
  const t0 = Date.now();
  const seen = [];
  let last = '', left = '';
  for (;;) {
    const f = String((await adb.currentFocus(serial)) || '');
    if (f) {
      last = f;
      if (seen[seen.length - 1] !== f) seen.push(f);
      // ★★ 2026-10-04 新增：一旦落到**草稿箱**（DraftActivity）就**当场收工**，不再傻等满超时。
      //   真机实测：点完「发布」后 1.2s 就已经在草稿箱里了（连拍两张都在 DraftActivity），
      //   而原来的写法会一直等到 15s 超时 —— 白等 14 秒，还把「是不是草稿」这件**很确定**的事
      //   混进了「读不到 / 停在哪都不对」的模糊结论里。判据明确 ⇒ 结论就该明确。
      if (uimap.isDraftScreen(f)) {
        return { ok: false, draft: true, waited: +((Date.now() - t0) / 1000).toFixed(1), focus: f, left: '', seen };
      }
      if (!uimap.isPublishScreen(f) && !uimap.isDraftScreen(f)) { left = f; break; }
    }
    if (Date.now() - t0 >= timeoutMs) break;
    if (typeof cancelled === 'function' && cancelled()) break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { ok: !!left, waited: +((Date.now() - t0) / 1000).toFixed(1), focus: last, left, seen };
}

async function runReal(row, item, copyRow, serial, map, ctx, isLastRunnable = false) {
  const log = ctx.log || (() => {});
  const cancelled = ctx.cancelled || (() => false);
  // 大结论通道（见 logbus.tierOf / jobs.js）：工具里直接干跑没有 conclude 时退回 log，旧行为不变
  const conclude = ctx.conclude || log;
  const c = cfg();

  // 0) 这条发视频还是图文：报告标了就以报告为准，没标按目录推断；两边都有又没标 → 这里必须拦住
  const kind = rowKind(row, item);
  if (!kind) throw new Error('判不了这条该发图文还是视频：这个叶子里图和视频都有，报告里也没标「内容类型」');
  const isVideo = kind === 'video';
  const mediaWord = isVideo ? '视频' : '图';
  row.kind = kind;

  // 1) 推素材 + 把素材**写进媒体库**（不写库，得物相册里根本看不到这条）
  const media = (item.files || []).filter(f => f.type === (isVideo ? 'video' : 'image'));
  if (!media.length) throw new Error(`这条按「${isVideo ? '视频' : '图文'}」发，但没有可推的${mediaWord}片文件`);
  // ★★ 2026-10-03（第三十四轮）：素材推到**本工具专属目录**，并在推之前把它清空。
  //   为什么：得物相册读 MediaStore，而相册页顶部的「所有照片」是个**聚合**视图 —— 设备上
  //   所有目录的素材都混在里面，「点前 N 格」就只是「碰巧对」（上一条的素材、系统截图、
  //   僵尸记录都会把次序顶歪）。推到专属目录之后，得物相册下拉里会多出一个独立相册
  //   （真机实测：新建 DCIM/Camera/bluevtst 推 2 张 ⇒ 下拉里出现「bluevtst 2」，选中后
  //   页面里只有这 2 格），定位表再切到这个相册 ⇒ 这一屏上**只有本条要发的素材**，
  //   于是「全选」就是名副其实的全选。
  //   ★ 只换目录不清空是不够的：目录里会累着上一条的素材，相册里照样混在一起。
  const remoteDir = '/sdcard/DCIM/Camera/bluev';
  const remotes = [];

  // ★★ 2026-10-04（第四十轮）**0b) 「回主线」守卫 —— 必须排在清相册之前**。
  //   为什么非做不可（真机实测）：一条内容发完之后，得物停在哪儿是**不确定的**
  //     （个人主页 / 相册页 / 发布成功页），而下一条的第一步是「底部点『我』」那个**固定坐标**
  //     —— 只有 App 在首页时它底下才是底部导航。停在别处时那个坐标点下去就是乱点。
  //     ⇒ 用户看到的「第二条永远拉不起来」。
  //   ★ 顺序：守卫在**清相册/推素材之前** ⇒ 拦下时连素材都不推（不白跑几十秒）。
  //   ★ 失败就**如实抛错**，绝不"当作没这回事继续往下点"（不知道自己在哪一屏时点固定坐标＝乱点）。
  //   ★★ 2026-10-04（第十四次实测后）这一整段抽成 pullHome()，因为**清相册时可能把得物强停掉**
  //     （它拿着素材的解码句柄，见 adb.clearMediaDir 的 1b 段）⇒ 强停之后要**再走一遍**这个守卫
  //     （App 现在是死的，直接点固定坐标等于点空气）。两处调用，同一条判据。
  const pullHome = async (why) => {
    row.status = '回主线';
    if (ctx.onRow) ctx.onRow(row);
    // ★ 别在这里自己先读一次 currentFocus —— 那会把「转场瞬间读不到」这个现场吃掉，
    //   让守卫误判成「明确知道停在别处」从而瞎启动 App。守卫返回的 `from` 就是它看到的起点。
    const g = await adb.ensureApp(serial, {
      pkg: uimap.DEWU.pkg,
      activity: uimap.DEWU.launchActivity,
      want: uimap.DEWU.homeActivity,
      judge: (f) => uimap.isHomeScreen(f),
      timeoutMs: Number(c.ensureAppTimeoutMs) > 0 ? Number(c.ensureAppTimeoutMs) : 30000
    });
    if (!g.ok) {
      throw new Error((why ? why + '：' : '') + '没能把得物拉回首页：' + (g.why || '未知原因')
        + ' —— 这一步不许跳过：定位表第一步是**固定坐标**点底部导航，停在别的页面上那个坐标底下不是底部导航。');
    }
    if (g.started) {
      log(`${row.dir}：得物不在首页（之前的页面：${g.from || '读不到'}），已重新拉回首页${why ? '（' + why + '）' : ''}`, 'info');
    }
    return g;
  };
  await pullHome('');

  // ★★★ 2026-10-04 新增：**坐标空间守卫**（用户问「为啥你有具体坐标老是会点偏」）。
  //
  // 机制（都是本机 MuMu 12 实测出来的，不是推理）：
  //   · 定位表里的 `tapXY` 是**写死的绝对坐标**，只在「抓表时那个坐标系」里成立；
  //   · 那个坐标系由**当前前台应用的方向 / 模拟器分辨率**决定 —— 同一台机器上实测两种都出现过：
  //       得物（竖屏锁定，发布全程都是它在前台）→ `dumpsys window displays` 的 `cur=1080x1920`，
  //       同时 `screencap` 的 PNG 是 1080x1920、dump 的 bounds 最大 y=1919；
  //       MuMu 桌面（横屏）在前台 → 同一命令变成 `cur=1920x1080`，PNG 与 bounds 全部变 1920x1080。
  //   · **`input tap` 对越界坐标不报错** —— 实测在 1920x1080 的屏上 `input tap 945 1869` 返回 rc=0、
  //     一个字都不说、什么都没点到。所以坐标系一旦不对，表现是「每一步都安静地点偏」，
  //     日志上一条错都没有 —— 这正是「有具体坐标却老点偏」的机制。
  //   ⇒ 两层，各管一半：
  //     ① 表里记的抓取尺寸 vs 当下尺寸对不上（早报；连「坐标仍落在屏内但整体指错元素」也拦得住）；
  //     ② 逐个坐标越界（兜底；也覆盖老表 —— 老表没有 screen 戳）。
  //   ★ 为什么读尺寸**必须在这里**（pullHome 之后、推素材与清相册之前）：
  //     坐标系跟着前台应用走，在得物没到前台时读会读到**桌面**的坐标系，
  //     把一张本来正确的表判成「对不上」—— 假报警与漏报一样是灾难。
  //     放这儿还顺带满足「fail fast」：坐标系不对时，一个像素都不点、一张素材都不推。
  // ★ 挑哪一套步骤的判据抽到了 uimap.stepsFor（纯函数）：视频没单独配 videoSteps 就复用图文那套。
  //   抽出去是为了让回归能**喂输入验语义**，而不是拿正则去匹配这一行长什么样（重构一次就误报一次）。
  const steps = uimap.stepsFor(map, isVideo);
  const fixedPts = uimap.tapPointsOf(steps);
  if (fixedPts.length) {
    if (!ctx.uiSize) ctx.uiSize = await adb.uiSize(serial);
    const liveSize = ctx.uiSize;
    const mm = uimap.screenMismatch(map.screen, liveSize);
    if (mm.mismatch) {
      throw new Error(`UI 定位表的坐标系和这台设备对不上：${mm.why}。`
        + `表里 ${fixedPts.length} 个写死的坐标（tapXY）会**整体点偏**，`
        + `而 input tap 对点偏/越界不报错（实测 rc=0，什么都不点）⇒ 这里必须拦下，不许硬点。`
        + `两条路：① 把模拟器调回抓表时的分辨率与方向（比如得物是竖屏锁定的，让得物在前台量一次即可）；`
        + `② 停到得物发布页重新「抓取页面结构」→ 导入（新表会带上抓取时的坐标系）。`);
    }
  }

  // ★ 清空必须在 push **之前**：push 完再清会把这一条刚推的也一起清掉。
  row.status = '清相册';
  if (ctx.onRow) ctx.onRow(row);
  // ★★ 2026-10-04（第四十轮）用户口径：「删除完所有其他不相关的素材后，不要 bluev 了」
  //   ⇒ 清相册的**范围**从「专属目录」扩到**整个 DCIM/Camera**（得物相册的聚合视图读的就是它）。
  //   两步走：先清相册根（把别处来的、上一条的、系统截图全扫掉），再清专属目录本身。
  // ★★★ 2026-10-04（第十四次实测）**传 forceStopPkg**：
  //   得物停在发布页/相册页时**自己拿着这批 mp4 的硬解码句柄**，此时 rm/find/mv 全报
  //   `Text file busy`，而 `am force-stop com.shizhuang.duapp` 之后同一句立刻成功。
  //   ⇒ 允许 clearMediaDir 在"清不掉"时把得物强停掉再重试（能过就不去造 trash 残骸）。
  const clRoot = await adb.clearMediaDir(serial, '/sdcard/DCIM/Camera', { forceStopPkg: uimap.DEWU.pkg });
  if (!clRoot.ok) {
    throw new Error('没能清干净设备相册目录（/sdcard/DCIM/Camera）：' + (clRoot.error || '未知原因')
      + ' —— 不清干净的话相册里会混着其他素材，选素材那一步会点到别的图。');
  }
  await adb.shell(serial, 'mkdir -p ' + remoteDir);
  const cl = await adb.clearMediaDir(serial, remoteDir, { forceStopPkg: uimap.DEWU.pkg });
  if (!cl.ok) {
    throw new Error(`没能清干净设备上的专属相册（${remoteDir}）：${cl.error || '未知原因'}`
      + ' —— 不清干净的话上一条的素材会留在相册里，选素材那一步会点到上一条的图。'
      + '（这一步不许跳过：跳过的表现是「内容看着发成功了，配图却是上一条的」，最难查。）');
  }
  // ★★★ 2026-10-04（真机实测新增）**清全盘相册** —— 上面两步只清了目录，
  //   而得物相册顶部那个「所有照片」是**全盘聚合视图**：把一条 mp4 放进 /sdcard/Movies
  //   （不在 DCIM/Camera 下），它照样出现在得物相册里、和专属目录里的并排显示（已截图对照）。
  //   ⇒「发布这一条时，调出相册只能看到它的素材」这件事，唯一靠得住的判据是
  //   **MediaStore 里没有别的素材**。清完复查四张表，一条不剩才算过。
  //   （这一步也顺手覆盖了「系统截图 / 别的 App 存的素材混进相册」那类问题。）
  const clAll = await adb.clearAlbum(serial, { forceStopPkg: uimap.DEWU.pkg });
  if (!clAll.ok) {
    throw new Error('没能把设备相册清到一条不剩：' + (clAll.error || '未知原因')
      + ' —— 不清干净的话相册里会混着其他素材（专属目录之外的也算），选素材那一步会点到别的图。');
  }
  if (clAll.removed) {
    log(`${row.dir}：相册里有 ${clAll.removed} 条其他素材（不在 ${remoteDir} 里，普通清目录清不掉），已一并清掉`, 'info');
  }

  // ★★ 强停过得物 ⇒ 它现在是**死的**，必须重新拉起来并确认回到首页（否则后面全是点空气）。
  if (clRoot.forceStopped || cl.forceStopped || clAll.forceStopped) {
    log(`${row.dir}：清相册时得物正占着素材文件（Text file busy），已强制停掉它腾出句柄 —— 现在重新拉回首页`, 'warn');
    await pullHome('清相册时强停过得物');
  }
  // ★★ 2026-10-04（第四十轮）：空目录残骸（stale 句柄锁着、删不掉也不含任何素材）**不阻断发布**，
  //   但要**如实记一笔**让人知道（否则用户看到相册目录里一堆怪名字，不知道是什么）。
  if (clRoot.note || cl.note) {
    log(`${row.dir}：相册目录里有清不掉的空目录残骸（不含任何素材，不影响发布；需要彻底清掉要重启模拟器）：`
      + (clRoot.note || '') + (cl.note ? '；' + cl.note : ''), 'info');
  }
  if (cl.removed) log(`${row.dir}：专属相册已清空，删掉上一条留下的 ${cl.removed} 个素材`, 'info');

  for (const f of media) {
    const abs = path.join(item.absDir || item.dir, f.name);
    const remote = `${remoteDir}/${String(f.name).replace(/[^\w.\-+]/g, '_')}`;
    const r = await adb.push(serial, abs, remote);
    if (!r.ok) throw new Error(`推${mediaWord}片失败 ${f.name}：${(r.stderr || '').trim()}`);
    const sc = await adb.mediaScan(serial, remote);
    if (!sc.ok) log(`${row.dir}：${f.name} 的媒体扫描没做成功（试了 ${sc.how}）——下面用「进库确认」兜底`, 'warn');
    remotes.push(remote);
  }

  // ★★★ 2026-10-05（第四十一轮）**主图排序** —— 这里是「哪张当内容主图」的唯一开关。
  //   得物取**相册第 1 格**作内容主图（用户口径）；而第 1 格 = 设备上文件时间（MediaStore
  //   `date_modified`）**最新的那张** —— 真机三步实验的结论与出处见 adb.makeNewest 的注释。
  //   所以要某张当主图，就得把它在设备上的时间设成这一组里最新的。
  //   ★ 挑哪张：名字以 1 开头（`1_xxx.jpg`）优先，否则按**第 1 张**（最先拍到 / 收到的那张）。
  //     用户真实素材实测 3 个叶子：「第 1 张」3/3 合格；而改前的实际行为（最后一张）有 2/3 是
  //     背面图 —— 用户报的就是这个（「不然老是放一些人物的背面图在主图上」）。挑法见 services/mainimg.js。
  //   ★ 视频不参与：只有图文才拿相册里的图当内容图（用户口径）。
  //   ★★ 排不成 ⇒ **这一条就不发**（抛错，不默默发一条主图放错的帖子）：主图放错是用户明确报过
  //     的损失，而「发不出去」他当场就能看见；含糊过去等于让界面骗人。
  if (!isVideo) {
    const pick = mainimg.pickMainImage(item.files);
    if (pick.main && media.length > 1) {
      const idx = media.findIndex(f => f && f.name === pick.main.name);
      if (idx < 0) {
        throw new Error(`内部不一致：挑出来的主图「${pick.main.name}」不在要推的图片清单里`
          + `（清单：${media.map(f => f.name).join('、')}）—— 先查 services/mainimg.js 的挑法，别猜。`);
      }
      row.status = '排主图';
      if (ctx.onRow) ctx.onRow(row);
      const mr = await adb.makeNewest(serial, remotes[idx], remotes);
      if (!mr.ok) {
        throw new Error(`没能把主图「${pick.main.name}」排到相册第 1 格：${mr.error}`
          + ' —— 相册第 1 格就是得物的内容主图，排不成就只能按「最后拍的那张」当主图'
          + '（实测那就是你说的背面图）。这步靠设备端 touch + 重扫媒体库两步完成。');
      }
      const rescan = await adb.mediaScan(serial, remotes[idx]);
      if (!rescan.ok) {
        throw new Error(`主图「${pick.main.name}」的时间戳改了，但没能重扫进媒体库（试了 ${rescan.how}）`
          + ' —— 得物读的是库里的缓存时间，不重扫的话相册顺序不会变（这条实测过）。');
      }
      const nw = await adb.mediaNewest(serial, remotes);
      if (!nw.ok) {
        throw new Error(`排完主图后回读媒体库没读成：${nw.error}`
          + ' —— 读不到就不算排成（不许按「应该是排上了」往下发）。');
      }
      if (nw.newest !== adb.toMediaPath(remotes[idx])) {
        throw new Error(`排完主图后回读媒体库，最新的仍是「${nw.newest.split('/').pop()}」，`
          + `不是要当主图的「${pick.main.name}」—— 这一条的主图会放错，先不发。`);
      }
      log(`${row.dir}：主图 = ${pick.main.name}（${mainimg.whyText(pick)}），已排到相册第 1 格`, 'info');
      if (pick.why === 'marker-many') {
        conclude(`${row.dir}：这个叶子里有 ${pick.marked.length} 张图的名字都以 1 开头`
          + `（${pick.marked.join('、')}）—— 只取了排在最前的那张当主图，其余的 1 请去掉`, 'warn');
      }
    }
  }

  // ★★ 2026-10-03 真机实测（127.0.0.1:16384 / MuMu 12 / Android 12，全部可复算）：
  //  **得物相册读的就是 MediaStore**。三条证据：
  //   · adb push 一个 mp4 到 /sdcard/DCIM/Camera，它【不在 MediaStore】⇒ 得物相册里【看不到】它
  //     （相册第 1 格仍是旧内容，格子上的时长标记和库里完全对得上）；
  //   · 用 `content call --uri content://media/external/file --method scan_file --arg <全路径>`
  //     把它索引进库（返回 content://media/external_primary/video/media/N）⇒ 冷启动得物打开相册，
  //     它**立刻出现在第 1 格**（实测那条 00:15 就是刚推的）；
  //   · 库里指向「文件已删」的**僵尸记录**，会在相册里显示成一个【黑缩略图的格子】，
  //     点它必弹 Toast「暂不支持的视频格式」—— 得物去解码时文件已不存在。
  //  ⇒ 所以推完必须**确认真的进库了**再往下走。以前那条路（发两条广播）在这台设备上
  //    没有任何接收者，这才是「视频已推到设备，但等了 182.9s 媒体库还没索引到」的真根因。
  //  ★ 图文同样要走这条：图片不进库，得物相册里一样看不到它。
  row.status = '写媒体库';
  if (ctx.onRow) ctx.onRow(row);
  const sec = Number(c.videoIndexTimeoutSec) > 0 ? Number(c.videoIndexTimeoutSec) : 20;
  const w = await adb.mediaVisible(serial, remotes, {
    timeoutMs: sec * 1000,
    onTick: s => { row.status = `写媒体库确认 ${s}s`; if (ctx.onRow) ctx.onRow(row); }
  });
  if (!w.ok) {
    throw new Error(`${mediaWord}片已推到设备，但没能写进媒体库（得物相册里看不到它）：等了 ${w.waited}s`
      + (w.error ? `，${w.error}` : ''));
  }
  log(`${row.dir}：已推 ${media.length} 个${mediaWord}片，并确认写进媒体库（${w.waited}s）`, 'info');

  // 2) 按 UI 定位表走真实界面。
  //    ★ 2026-10-02 用户实测：**图文和视频的发布位置是一样的**（入口、相册页签、编辑页同一套），
  //      所以 videoSteps 没单独配时**直接复用 steps**，不再拦下。
  //      videoSteps 仍然保留：哪天真机改版、视频那条路跟图文不一样了，单独配一套就能覆盖。
  //    ★ 2026-10-04：这一组 steps 在**上面坐标空间守卫**那里就已经算好了（同一个判据，只算一次）——
  //      两处各算一遍迟早不一致（改了一处、另一处还在按老规矩挑表）。
  const reuseForVideo = isVideo && !(map.videoSteps || []).length;
  if (reuseForVideo && steps.length) {
    log(`${row.dir}：这条是视频，UI 定位表没单独配 videoSteps —— 按「图文那套位置」发（图文与视频位置一样，实测）`, 'info');
  }
  if (!steps.length) {
    throw new Error('UI 定位表是空的 —— 到「设置 → 高级设置」点「抓取页面结构」'
      + `（抓之前先把模拟器停在得物发布页：${uimap.DEWU.entryHow}），把生成的候选表核对后导入，再发。`);
  }

  const data = {
    title: (copyRow && copyRow.title) || '',
    body: (copyRow && copyRow.body) || '',
    sku: item.sku || '', color: item.color || '',
    // 相册里按文件名点选时用：要填**推上去之后**的文件名（含中文的名字在推送时会被清洗成下划线），
    // 拿本地原名去匹配是匹配不到的
    videoName: remotes[0] ? path.basename(remotes[0]) : '',
    // ★ 「一条内容发多张图」靠它：这个叶子里**有几张图** ⇒ 定位表写 ${imageCount} 就能一次点前 N 格。
    //   与 copywriter.imagePartsOf 同一判据：只看 type==='image'（视频不算图）。
    //   读不到清单时是 0 ⇒ 用到 ${imageCount} 的那一步会**当场报错**，不会默默按 1 张发。
    imageCount: (item.files || []).filter(f => f && f.type === 'image').length,
    // ★ 定位表里「切到本工具专属相册」那一步用：得物相册下拉里的相册名 = 设备上的目录名。
    albumName: remoteDir.split('/').filter(Boolean).pop(),
    videoCount: (item.files || []).filter(f => f && f.type === 'video').length
  };
  (copyRow && copyRow.topics || []).forEach((t, i) => { data['topic' + (i + 1)] = t; });
  // ★ 好物 1~3 的货号/颜色也进占位符（发布单列名：好物1货号 / 好物1颜色 … 好物3货号 / 好物3颜色，最多 3 组）。
  //   没有 item.goods 的老数据（本地扫出来的条目）按「主货号/主颜色」兜底 —— 与 sheet.buildRows 同一判据，
  //   否则定位表里的好物段会对**每一行**都判成「没有好物」而整段静默跳过（少关联商品，还不报错）。
  const goodsList = (Array.isArray(item.goods) && item.goods.length)
    ? item.goods
    : [{ sku: item.sku, color: item.color }];
  for (let gi = 0; gi < 3; gi++) {
    const g = goodsList[gi] || {};
    data['goods' + (gi + 1) + 'Sku'] = g.sku || '';
    data['goods' + (gi + 1) + 'Color'] = g.color || '';
  }

  // ★★ 2026-10-04 新增：记住「紧邻的上一步点的是哪个输入框」——紧跟其后的 input 步拿它做**回读校验**
  //   （见 runStep 的 input 分支 / adb.readTextOf）。
  //   为什么只认「紧邻」：话题那几步（topic1..5）是往**正文框**里接着追加的，它们的上一步是另一个
  //   input（不是 tapId）⇒ 天然不会拿正文全文去比对某一小段话题，不会误报。
  //   被屏幕守卫跳过（rs.skipped）的步不算「点过」，所以置 ''。
  let lastTapId = '';
  for (const raw of steps) {
    if (cancelled()) throw new Error('已取消');
    const step = uimap.fill(raw, data);
    // ★ 条件步骤（when / whenNot）：发布单里「好物2 / 好物3」常常是空的，而「点关联好物 → 搜货号 → 选商品」
    //   是一整段 ⇒ 空着不跳过会把搜索页打开却不选商品，后面每一步全崩。
    //   跳过必须**说出来**：静默少点一步，真机上表现为「下一条莫名失败」，最难查。
    if (!uimap.condOk(step, data)) {
      // ★★ 必须点名**真正没成立**的那一半（uimap.condWhy），不能「写了 when 就报 when 空」：
      //    实测这条日志写过「占位符 goods1Sku 是空的」，而那一行明明填了货号 ——
      //    真因是 whenNot（颜色有值）。报错点名一个已经满足的条件，等于把人往反方向带。
      const why = uimap.condWhy(step, data) || '条件不成立（when / whenNot）';
      log(`${row.dir}：跳过「${step.name || step.value}」（${why}）`, 'info');
      continue;
    }
    row.status = step.name;
    if (ctx.onRow) ctx.onRow(row);
    // ★ 交给 runStep 的 input 分支做回读校验（只有紧邻的上一步真是 tapId 才非空）
    ctx.inputCheckId = lastTapId;
    // ★★ 2026-10-04 逐步计时（用户问「为什么选择素材花了 8 秒 / 点关联好物花了 5 秒」）：
    //   不靠推理，把每一步的**真实毫秒数**量出来。只有慢到会引起注意的（≥1.5s）才说，
    //   免得日志被一堆 0.1s 淹没。计时不含日志本身的开销（纯 runStep 前后取差值）。
    const tStep = Date.now();
    let rs;
    try {
      rs = await runStep(serial, step, data, ctx);
    } finally {
      const used = Date.now() - tStep;
      if (ctx.stepTiming) ctx.stepTiming.push({ name: step.name || step.value, ms: used, row: row.dir });
      if (used >= 1500) {
        log(`${row.dir}：「${step.name || step.value}」耗时 ${(used / 1000).toFixed(1)}s`, 'info');
      }
    }
    // ★ 记下这一步**实际点成功**的输入框 id（被守卫跳过的不算），供紧随其后的 input 步回读校验
    //   ★★ 注意判据别写反：`runStep` 对 tapId/wait/input 这些分支是 `return;`（**返回 undefined**），
    //      只有屏幕守卫跳过时才返回 `{skipped:true}`。所以「没被跳过」是 `!(rs && rs.skipped)`
    //      —— 写成 `rs && !rs.skipped` 会**永远为假**，回读整段静默失效（这个坑我当场踩过一次）。
    lastTapId = (step.action === 'tapId' && !(rs && rs.skipped)) ? String(step.value || '') : '';
    // ★★ 屏幕守卫（whenOn / whenNotOn）判「这一屏不对」⇒ 这一步**没发任何点击**。
    //   必须说出来：静默少点一步，真机上表现为「下一条莫名失败」，最难查。
    if (rs && rs.skipped) {
      log(`${row.dir}：跳过「${step.name || step.value}」（屏幕守卫：${rs.why}）`, 'info');
    }
  }

  // ★★★ 2026-10-04 用户口径：「**发出去了才算成功**」—— 点完「提交发布」必须**真的离开**发布流程。
  //   不判的话，下面几种情况都会记成「发布成功」，而账号里根本没有这条内容：
  //     · 得物没受理，还停在发布流程里；· 得物把它存成了草稿；· 提交那一步被屏幕守卫跳过。
  //   判据与理由见 waitLeftPublishFlow 的注释。
  //   ★ 超时走**产品真的会读**的那个配置（`postPublishWaitSec`，默认 15s）——
  //     回归里把它调小来验「等不到就失败」，而不是在这里干等 15 秒
  //     （干等的坏处：既慢，又会让「超时逻辑本身」没被测到 —— 改坏读取点照样绿）。
  const waitSec = Number(c.postPublishWaitSec) > 0 ? Number(c.postPublishWaitSec) : 30;
  const vr = await waitLeftPublishFlow(serial, { timeoutMs: waitSec * 1000, cancelled });
  if (!vr.ok) {
    // ★★★ 2026-10-04 修：**先留证、再强停**。
    //   原来外层的失败截图（run() 的 catch 里那个 saveShot）是在**这里 force-stop 之后**才拍的
    //   ⇒ 今晚实测两张「失败截图」拍的全是 MuMu 桌面（得物已经被关掉了），等于没留证，
    //   这也是我今晚一直在瞎猜「点发布那一刻屏幕上是什么」的原因。
    await saveShot(serial, `seq${row.seq}_publish_stuck`, ctx);
    // ★ 不许留草稿：把得物**强制关掉** —— 它侧边那条「未完成的动态」不关掉就会躺在草稿箱里，
    //   下一条发布时还会弹「是否继续编辑」把流程顶偏（用户已经踩过这一次）。
    const fsr = await adb.forceStop(serial, uimap.DEWU.pkg);
    if (vr.draft) {
      throw new Error('点了「提交发布」，但得物把它**存成了草稿**：前台落到了 '
        + '`com.shizhuang.duapp.media.activity.DraftActivity`（草稿箱），'
        + `用时 ${vr.waited}s，前台变化：${vr.seen.join(' → ') || '一直读不到'}`
        + ' —— 按「发出去了才算成功」，这条记**失败**。'
        + '（已经点了「提交发布」这一步，不是被屏幕守卫跳过；标题/正文是否真的填进去了，'
        + '看上面「已回读确认填进去了」那几行。）'
        + (fsr.ok
          ? '已强制关掉得物，把这条草稿清掉（不然它会以草稿形式留在「草稿箱」里）。'
          : '★ 想强制关掉得物清草稿但没停掉（' + (fsr.error || '未知原因') + '）—— 请手动去得物「草稿箱」检查并删掉那条草稿。'));
    }
    throw new Error('点了「提交发布」，但得物**没有离开发布流程**（等了 ' + vr.waited + 's，最后停在「'
      + (vr.focus || '读不到') + '」；这段里前台的变化：' + (vr.seen.join(' → ') || '一直读不到') + '）'
      + ' —— 按你的口径「发出去了才算成功」，这条记**失败**。'
      + '（也可能是上一步「提交发布」被屏幕守卫跳过了，看上面的日志。）'
      + (fsr.ok
        ? '已强制关掉得物，把这条没发出去的草稿清掉（不然它会以草稿形式留在「草稿箱」里）。'
        : '★ 想强制关掉得物清草稿但没停掉（' + (fsr.error || '未知原因') + '）—— 请手动去得物「草稿箱」检查并删掉那条草稿。'));
  }
  log(`${row.dir}：提交发布后已确认离开发布流程（前台 ${vr.seen.join(' → ')}，用时 ${vr.waited}s）`, 'info');
  // ★★ 2026-10-04（用户口径）：得物发布完成后会在主页停留一下（用户原话「大概 5 秒后完成发布，
  //   在主页停留 10 秒左右，你就需要开始准备发布第二条素材」）。这里给一个**可配的**主页停留，
  //   默认 10s —— 目的是让得物把这条内容在服务端落定（上传/审核排队），再把相册清空去发下一条。
  //   ★ 配 0 = 不停留（连续发布档）；读取点只在这里，方便回归里把它调 0 跑快。
  // 最后一条后面没有下一次清相册，跳过这段停留；中间条仍保留服务端落定缓冲。
  const configuredDwell = secOr(c.homeDwellSec, c.postPublishDwellSec, 10);
  const dwell = isLastRunnable ? 0 : configuredDwell;
  if (isLastRunnable && configuredDwell > 0) {
    log(`${row.dir}：本批最后一条，跳过额外主页停留`, 'info');
  }
  if (dwell > 0) {
    log(`${row.dir}：发布完成，按设置在主页停留 ${dwell}s 再准备下一条`, 'info');
    await sleep(dwell * 1000, cancelled);
  }
  return true;
}

/* ---------------- 模拟通道 ---------------- */

async function runMock(row, ctx) {
  const cancelled = ctx.cancelled || (() => false);
  for (const st of STEPS) {
    if (cancelled()) return 'cancelled';
    row.status = st;
    if (ctx.onRow) ctx.onRow(row);
    await sleep(400, cancelled);
  }
  // ★★ 2026-10-03：这里原来是 `return Math.random() > 0.08;` —— 每次 8% 概率**随机失败**。
  //    在没有「失败重试」的年代那点随机失败会被重试吃掉；现在「失败不重试」⇒ 它变成实打实的一条失败。
  //    两个后果都不能接受，且都实测到了：
  //      ① 用户跑一次模拟演示会莫名看到「发布失败」（模拟通道本来只是演练节奏 + 回写）；
  //      ② 回归测试变成**概率性红**（smoke ⑦ 当场踩到：8% × 几十行 ⇒ 几乎必红）。
  //    模拟通道不负责造故障；真故障路径由 adbtest 用真实通道覆盖（页面结构变了 → 必失败）。
  return true;
}

/* ---------------- 主流程 ---------------- */

async function run(state, ctx = {}) {
  const log = ctx.log || (() => {});
  // ★ 2026-10-05 用户口径「给用户只看大结论」：`log`（= ctx.log）现在一律是**过程明细**，
  //   界面不显示；只有 `conclude`（= ctx.conclude）那几句会出现在用户眼前。
  //   这里准备一个兜底：工具/干跑脚本传进来的 ctx 没有 conclude 时，退回 log（老行为，别抛）。
  const conclude = ctx.conclude || log;
  // ★ 2026-10-03 提速：批次内共享「哪一步这一屏不会 idle」的缓存（见 runStep 的 wantAnimOff）。
  //   只在这一次发布里有效，不落盘 —— 下次发布会重新学一遍（设备/App 版本变了也自然失效）。
  if (!ctx.animOffSteps) ctx.animOffSteps = {};
  // ★ 2026-10-04：逐步计时用的收集器（调用方传进来就写进去；不传就是一个丢弃用的数组）。
  //   界面上「本次发布各步耗时」那张表读的就是它。
  if (!ctx.stepTiming) ctx.stepTiming = [];
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const onRow = ctx.onRow || (() => {});
  const c = cfg();
  const mode = (state.publish && state.publish.mode) || 'mock';
  // ★★ 2026-10-03：这里**绝不许**再兜底任何硬编码序列号（此前是 '127.0.0.1:5555'，再前是 'emulator-5554'）。
  //   后果：没选设备也能“跑起来”，实际拿一台**不存在**的设备去发，界面与台账却是绿的。
  const serial = (state.publish && state.publish.device) || c.device || '';
  if (mode === 'adb' && !serial) {
    throw new Error('还没选设备：先点「扫描设备」，把模拟器加入列表并点「选用」，再开始发布。');
  }
  // ★★ 2026-10-03 事故修复（真机实测误发 2 条内容）：这里原来是 `const map = c.uiMap;` —— **只读配置**。
  //   而 tools/pubsim.js（真机干跑）以为自己传进来的 `state.publish.uiMap`（**已剔除「提交发布」那一步**）
  //   会被用上，其实被**静默忽略** ⇒ 干跑「不点提交」的意图完全失效 ⇒ **提交被真点了，内容真的发出去了**
  //   （账号个人主页动态列表里实测出现 2 条「干跑不发布·图文标题」，用户手动删除）。
  //   ⇒ 让这个参数名副其实：调用方给了就用调用方的，没给才退回配置。
  //   （真机发布路径 src/main/jobs.js **不传** state.publish.uiMap ⇒ 行为与以前一字不差。）
  const map = (state.publish && state.publish.uiMap) || c.uiMap;

  if (mode === 'adb' && !(map && map.steps && map.steps.length)) {
    throw new Error('真实通道需要先配 UI 定位表：把模拟器停在得物发布页 —— 推荐走底部「我」→ 右上角「主页」→「发布新动态」（3 跳，入口都带文字，稳）；也可以点动态流右上角那个没文字的相机图标（1 跳），'
      + '在「设置 → 高级设置」点「抓取页面结构」，改好后导入 uiMap.json');
  }
  if (mode === 'adb') {
    const ime = await adb.ensureKeyboard(serial);
    if (!ime.ok) {
      throw new Error(`设备缺少可用的内置中文输入法，已阻止发布：${ime.error}（${ime.step}）。重新连接设备后程序会自动重试。`);
    }
  }

  const rows = (state.publish && state.publish.rows && state.publish.rows.length)
    ? state.publish.rows
    : sheet.buildRows(state, { intervalSec: gapSecFor('image', c) })
      .map((r, i) => ({ seq: i + 1, id: state.items[i] ? state.items[i].id : String(i + 1), dir: r[1], goods: 1, images: 0, startAt: '', status: '排队', result: '', reason: '' }));
  // 批次名跟着日志走：「重导出日志」要能按批次导出（真机日志行里也带批次）
  const batch = (state.publish && state.publish.batch) || `批${wp.stamp()}`;
  // 归属：优先用 ctx 传进来的（jobs 已按账号权限校验过），退回批次上记录的那一个。
  // 两者都没有就是「未标品牌」—— 如实标出来，绝不拿某个品牌顶上（顶上了统计就是错的）
  const who = {
    brandId: (ctx.brand && ctx.brand.brandId) || (state.publish && state.publish.brandId) || '',
    brandName: (ctx.brand && ctx.brand.brandName) || (state.publish && state.publish.brandName) || ''
  };
  const actor = ctx.actor || {};
  const tAll = Date.now();   // 批量总耗时（真机日志：批量发布完成，总耗时 86.6s）

  conclude(`本次归属：品牌「${who.brandName || '未标品牌'}」${actor.username ? ' · 执行人 ' + (actor.displayName || actor.username) : ''}`,
    who.brandId ? 'info' : 'warn');
  if (!who.brandId) conclude('这条批次没有品牌归属：发布日志里会记成「未标品牌」，统计时单独列出（不会并进任何品牌）', 'warn');

  const todo = rows.filter(r => r.result !== '发布成功');
  // 预估要按图文/视频分开算：视频单条更慢（推得久 + 还要等媒体库索引），混着算会明显偏短
  const itemById = new Map((state.items || []).map(it => [String(it.id), it]));
  const estKinds = todo.reduce((a, r) => {
    if (rowKind(r, itemById.get(String(r.id)) || {}) === 'video') a.video++; else a.image++;
    return a;
  }, { image: 0, video: 0 });
  const est = estimate(todo.length, estKinds);
  const mix = estKinds.video ? `（图文 ${estKinds.image} · 视频 ${estKinds.video}）` : '';
  conclude(`开始发布（${mode === 'adb' ? '真实设备通道' : '模拟通道'}）：${todo.length} 条${mix}，预计 ${est.minutes} 分钟`, mode === 'adb' ? 'ok' : 'warn');
  if (mode === 'mock') conclude('模拟通道不接触设备，只演练节奏/回写；要真发请先「连接模拟器」并点「检查能不能发布」通过', 'warn');
  log('发布期间不占用发布单文件，结果先写 publish-log.jsonl', 'info');

  const copyById = new Map((state.copyRows || []).map(r => [r.id, r]));
  let done = 0;
  const results = [];

  // 校验拦截行不进入 runReal；只跳过最后一个实际执行行后的主页停留。
  const lastRunnableRow = [...todo].reverse().find(candidate => {
    const v = (state.verify && state.verify.rows || []).find(x => x.id === candidate.id);
    return !(v && verifySvc.isBlocked(v));
  });
  for (const row of todo) {
    if (cancelled()) break;
    const item = state.items.find(it => it.id === row.id) || {};
    row.images = (item.files || []).filter(f => f.type === 'image').length || 0;
    row.goods = row.goods || 1;

    // ★ 拦不拦看 `verify.isBlocked()`，**不是** `pass === false`：
    //   前者只拦「有据可判的不一致」（颜色不匹配 / 多色漏填 / 主色不符）；
    //   「货号查不到颜色」属于**没有数据**，按真机口径只告警、照常发布 ——
    //   否则商品池没导全时会**整批静默不发布**，而界面只显示「校验未通过」。
    const blocked = (state.verify.rows || []).find(v => v.id === row.id);
    if (blocked && verifySvc.isBlocked(blocked)) {
      row.status = '未发布'; row.result = '校验未通过'; row.reason = blocked.note || blocked.conclusion;
      onRow(row); results.push(row); done++;
      progress({ done, total: todo.length, label: row.dir });
      continue;
    }

    if (done > 0) {
      // 真机是固定间隔（默认 60 秒），带倒计时；视频单条更慢，间隔单独放宽。
      // ★ 2026-10-03 用户要求：加「连续发布」档（间隔 = 0）—— 上一条发完直接开始下一条。
      //   取值走 gapSecFor（**不能**写 `|| 60`，否则 0 会被吃掉、选了「连续」还是等一分钟）。
      const video = rowKind(row, item) === 'video';
      const wait = gapSecFor(video ? 'video' : 'image', c);
      if (wait > 0) {
        log(`按 ${wait} 秒间隔，${wait}s 后执行`, 'info');
        if (!await sleep(wait * 1000, cancelled, left => {
          progress({ done, total: todo.length, label: `${left}s 后执行`, waitLeft: left });
        })) break;
      } else {
        // 连续发布：不 sleep，直接进下一条。进度里明确写出来，免得看起来像"卡住没动"。
        log('连续发布：不等间隔，直接开始下一条', 'info');
        progress({ done, total: todo.length, label: `连续发布（已发 ${done} 条，直接发下一条）`, waitLeft: 0 });
      }
    }

    // ★★ 2026-10-03 用户要求：**发布失败不重试**。原来这里是 `maxTry = (c.retry||2)+1` 的循环，
    //    失败后等 1.5 秒再试 1~3 次。现在只跑一次：失败就如实写「发布失败，原因xxx」交人工处理。
    //    ★ 「重跑」不是重试：那是「模拟器发布」页行尾的一个**新任务**（publish.rerun），用户点它才算，
    //      不会自己发生。⇒「失败重试次数」这个配置项与其读取点、失败恢复动作（recover）都已整块删除。
    let success = false, reason = '';
    const t0 = Date.now();
    row.startAt = new Date().toTimeString().slice(0, 8);
    try {
      if (mode === 'adb') {
        success = await runReal(row, item, copyById.get(row.id), serial, map, ctx, row === lastRunnableRow);
      } else {
        const r = await runMock(row, ctx);
        if (r === 'cancelled') break;   // 取消：不标失败，直接跳出整批
        success = !!r;
      }
    } catch (e) {
      success = false;
      reason = e.message;
      // 失败截图留一张：真机排查「崩在哪一屏」只能靠它。原来按第几次尝试命名，现在只跑一次。
      if (mode === 'adb') await saveShot(serial, `seq${row.seq}_fail`, ctx);
    }
    // ★★ 模拟通道**不许冒充真发布**：走模拟时结果记「模拟成功」。
    //   否则界面 / 台账 / 回写 Excel 全是绿的，而设备上什么都没发生（2026-10-03 实测踩到）。
    //   「模拟成功」不会被统计成真发布（统计只认「发布成功」），也不会写「审核中」。
    row.status = success ? (mode === 'adb' ? '发布成功' : '模拟成功') : '失败';
    row.result = success ? (mode === 'adb' ? '发布成功' : '模拟成功') : '失败';
    // ★ 2026-10-03：模拟通道不再随机失败 ⇒ 这里不需要「编一个失败原因」的分支了（拔掉假原因）。
    row.reason = success ? '' : (reason || '未知');
    if (!success) log(`${row.dir} 发布失败，原因${row.reason}`, 'warn');
    onRow(row);

    const tag = rowKind(row, item) === 'video' ? '视频' : '图文';
    row.elapsed = +((Date.now() - t0) / 1000).toFixed(1);
    if (success) log(`行 ${row.seq}[${tag}] 发布完成，已回填时间 ${row.startAt}（耗时 ${row.elapsed}s）`, 'ok');
    else log(`行 ${row.seq}[${tag}] 发布失败，原因${row.reason}（耗时 ${row.elapsed}s）`, 'warn');

    sheet.appendLog({
      batch, seq: row.seq, id: row.id, dir: row.dir, at: row.startAt, result: row.result, reason: row.reason,
      // ★ 不再写 retries：失败不再重试 ⇒ 它恒为 0。旧台账里那一列照原样读（sheet 导出时仍认它）。
      elapsed: row.elapsed, mode, kind: tag,
      // 品牌 + 执行人：统计按品牌聚合、管理员追责，全靠这两个字段。
      // 品牌名存快照，日后改名/删品牌时旧账里的名字不会跟着变
      brandId: who.brandId, brandName: who.brandName,
      userId: actor.userId || '', username: actor.username || '', displayName: actor.displayName || ''
    });
    results.push({
      batch, seq: row.seq, at: row.startAt, result: row.result, reason: row.reason,
      elapsed: row.elapsed, kind: tag,
      brandId: who.brandId, brandName: who.brandName,
      userId: actor.userId || '', username: actor.username || '',
      audit: row.result === '发布成功' ? '审核中' : '',
      reportRow: row.reportRow || 0   // 从「AI 内容报告」导入的行：回写时需要它在 Excel 里的行号
    });
    done++;
    progress({ done, total: todo.length, label: row.dir, succeeded: rows.filter(r => r.result === '发布成功').length });
  }

  const okCount = rows.filter(r => r.result === '发布成功').length;
  const failCount = rows.filter(r => r.result === '失败').length;
  log(`批量发布完成，总耗时 ${((Date.now() - tAll) / 1000).toFixed(1)}s`, 'info');
  log(`发布结束：共 ${todo.length} 条 / ${failCount} 失败，成功 ${okCount}（${mode === 'adb' ? '真实设备' : '模拟'}）。发完 ≠ 发出去了，还要回查审核状态`, 'ok');
  return { rows, results, okCount, total: todo.length, failCount, batch, mode };
}

module.exports = {
  sleep,
  connect, run, estimate, saveShot, dumpForCapture,
  // ★★ 2026-10-03：把**步骤引擎**也导出来。理由：真机上要逐屏验证某一步（选图 N 张、点颜色格）
  //    时，只有拿这套真代码跑才算数 —— 自己另写一份「差不多的」点在真机上，验的就不是发布器了。
  runStep,
  probes: adb.probe, probe: adb.probe, dump: adb.dump, dumpEx: adb.dumpEx,
  currentFocus: adb.currentFocus,
  imeComponent: adb.adbKeyboardIme,
  devices, listDevices, scanDevices, addDevice, removeDevice,
  // ★ 间隔取值（0 = 连续发布）。导出是为了让测试能直接断言「配 0 就是 0 秒」，
  //   而不是靠"跑一遍看看会不会等"去猜 —— 那种断言在假 adb 上很容易假绿。
  gapSecFor, secOr,
  // ★★ 2026-10-04：把「提交发布后有没有真的离开发布流程」也导出来。
  //   导出理由同 runStep：这一步是**新加的红线**（用户口径「发出去了才算成功」），
  //   要能单独喂假 adb 验正反两面，而不是只能靠跑一整条发布去间接证明。
  waitLeftPublishFlow
};
