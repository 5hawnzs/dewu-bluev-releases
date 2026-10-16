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
const topicinput = require('./topicinput');
const mediapermission = require('./mediapermission');
const entrydialogs = require('./entrydialogs');
const verifySvc = require('./verify');
const albumready = require('./albumready');
const store = require('../store');
const sheet = require('./sheet');
const wp = require('../util/winpath');

const STEPS = ['上传图片…', '填标题正文', '填话题', '关联好物', '发布确认'];

function cfg() { return store.get('publish') || {}; }

// 得物拉起后会经历桌面横屏到应用竖屏的转场；连续读到相同尺寸才允许固定坐标点击。
async function stableCoordinates(serial, screen, ctx = {}) {
  const end = Date.now() + 6000;
  let last = null, stable = 0;
  while (Date.now() < end) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    const live = await adb.uiSize(serial);
    if (live.known) {
      stable = last && last.w === live.w && last.h === live.h ? stable + 1 : 1;
      last = live;
      const mm = uimap.screenMismatch(screen, live);
      if (stable >= 2 && !mm.mismatch) return live;
      // 分辨率确实不同，且方向与表相同：等待旋转也无法修复，不再反复尝试。
      if (stable >= 2 && mm.mismatch && screen && ((Number(screen.w) > Number(screen.h)) === live.landscape)) {
        const error = new Error(`设备分辨率 ${live.w}×${live.h} 与定位表 ${screen.w}×${screen.h} 不匹配。请将 MuMu 调为定位表分辨率并核对 DPI，重启模拟器后重试，或重新制作本设备的定位表。`);
        error.code = 'UI_COORDINATES';
        throw error;
      }
    } else { stable = 0; last = null; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const error = new Error(last
    ? `屏幕方向尚未稳定或与定位表不一致（当前 ${last.w}×${last.h}）。请关闭自动旋转，将得物保持在定位表方向后重试。`
    : '无法读取设备屏幕尺寸，已停止发布。请重新连接模拟器后重试。');
  error.code = 'UI_COORDINATES';
  throw error;
}

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
  const d = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: !!preferAnimOff }, ctx);
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

// 商家主页可能没有 tvGoHomePage；使用首页动态流的相机入口，不依赖账号主页布局。
async function tapReadyCamera(serial, ctx) {
  const started = performance.now();
  let stable = 0, lastBounds = '', why = '尚未读取页面';
  const dismissed = new Set();
  while (performance.now() - started < 30000) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    const page = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0 }, ctx);
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    // 无文字的备用抓取不能证明发布提示已消失，不能当成可点击。
    if (!page.ok || page.via === 'dumpsys') {
      stable = 0;
      why = '无法完整核实当前页面及发布提示';
    } else {
      const nodes = uimap.parseNodes(page.xml);
      const dialog = entrydialogs.inspect(nodes);
      if (dialog && dialog.waiting) {
        stable = 0;
        lastBounds = '';
        why = dialog.name;
        if (ctx.log) ctx.log('备用入口：' + why + '（继续等待，未点击相机）', 'info');
        await sleep(400, ctx.cancelled);
        continue;
      }
      if (dialog) {
        stable = 0;
        lastBounds = '';
        const dialogKey = [dialog.title, dialog.button.id, dialog.button.bounds].join('|');
        if (!dismissed.has(dialogKey)) {
          const result = await adb.tap(serial, dialog.button.center.x, dialog.button.center.y);
          if (!result.ok) {
            const error = new Error('未能关闭入口弹窗：' + dialog.name + '；未点击相机。');
            error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
            throw error;
          }
          dismissed.add(dialogKey);
          if (ctx.log) ctx.log('备用入口：已点击' + dialog.name + '的「' + (dialog.button.text || dialog.button.desc) + '」，等待确认关闭', 'info');
        }
        // 只有匹配到实际弹窗才走这一段；仍存在时不重复点，等回读确认。
        await sleep(400, ctx.cancelled);
        continue;
      }
      const camera = nodes.find(n => n.id === uimap.DEWU.entryId && n.enabled && n.center);
      const hint = nodes.find(n => /^(?:正在(?:发布|上传)|(?:发布|上传)(?:中|成功|完成))(?:$|[\s！!。，,.…]|\d)/.test((n.text || n.desc).trim())
        || /ProgressBar$/.test(n.cls));
      if (hint || !camera) {
        stable = 0;
        why = hint ? '发布提示或进度仍显示，等待结束' : '相机入口尚未出现或尚不可用';
      } else {
        stable = camera.bounds === lastBounds ? stable + 1 : 1;
        lastBounds = camera.bounds;
        // 连续两次完整页面均无发布提示，且入口位置稳定，才使用本次坐标。
        if (stable >= 2) {
          const result = await adb.tap(serial, camera.center.x, camera.center.y);
          if (!result.ok) throw new Error('相机点击命令失败，未确认进入发布流程');
          return;
        }
        why = '等待相机入口及页面稳定';
      }
    }
    if (ctx.log) ctx.log('备用入口：' + why + '（未点击相机）', 'info');
    await sleep(400, ctx.cancelled);
  }
  const error = new Error('等待 30 秒仍未确认发布提示结束且相机可操作：' + why + '；未点击相机，本批停止。');
  error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
  throw error;
}

// 备用入口进「动态」前先清掉上一轮中断留下的「是否继续编辑」半成品弹窗。
// 主入口定位表里有 resumeDialog 守卫，但备用入口写死 tab_trends，缺这一层。
// ★★ 2026-10-17 提速：这一次读屏**顺便**当「点动态」那一步的页面结构用（返回值里的 xml），
//   否则为了这一层守卫要在同**一屏**上多抓一次（实测一次 dump ~1-2s）——用户口径里的
//   「减少重复观测」正是指这种同屏重复。中间没有任何动作 ⇒ 那份结构交给下一步点时一定新鲜。
async function dismissResumeDialog(serial, ctx = {}) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    const page = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0 }, ctx);
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    // 无文字或拿不到完整结构时不瞎点；只处理已确认的「是否继续编辑」弹窗。
    if (!page.ok || page.via === 'dumpsys') return null;
    const dialog = entrydialogs.inspect(uimap.parseNodes(page.xml));
    if (dialog && dialog.resume && dialog.button) {
      if (ctx.log) ctx.log('备用入口：先点「放弃」清掉上一轮未完成内容，再进入动态', 'info');
      const result = await adb.tap(serial, dialog.button.center.x, dialog.button.center.y);
      if (!result.ok) {
        const error = new Error('未能点击「放弃」关闭未完成内容提示；未继续进入发布入口。');
        error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
        throw error;
      }
      await sleep(400, ctx.cancelled);
      continue;
    }
    return { xml: page.xml };
  }
  return null;
}

async function openPublishEntry(serial, ctx = {}) {
  const home = await adb.ensureApp(serial, {
    pkg: uimap.DEWU.pkg, activity: uimap.DEWU.launchActivity, want: uimap.DEWU.homeActivity,
    judge: f => uimap.isHomeScreen(f), timeoutMs: 30000, allowForceStop: false,
    onNote: m => { if (ctx.log) ctx.log(m, 'warn'); }
  });
  if (!home.ok) throw new Error('无法返回得物首页：' + (home.why || '未知原因'));
  // 上一轮中断留下的「是否继续编辑」会挡在动态页签前；先点「放弃」再进。
  // 这一次读屏的结果**直接当下一跳的页面结构用**（presetXml）⇒ 同一屏不重复抓。
  const resumePage = await dismissResumeDialog(serial, ctx);
  // 点「动态」后必须确认当前前台就是动态流 HomeActivity，否则中间可能仍有弹窗/慢转场。
  // 以前只 sleep 400ms 后找相机，弹窗或转场稍慢就会把错误丢给后面的 tab_trends/etTitle。
  await runStep(serial, { action: 'tapId', value: 'com.shizhuang.duapp:id/tab_trends', name: '备用发布入口 · 动态' },
    {}, ctx, resumePage && resumePage.xml);
  const trendStarted = performance.now();
  let trendConfirmed = false;
  while (performance.now() - trendStarted < 30000) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    const focus = await adb.currentFocus(serial, { timeout: 3000 });
    if (focus && uimap.isHomeScreen(focus)) { trendConfirmed = true; break; }
    const page = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0 }, ctx);
    if (!page.ok || page.via === 'dumpsys') {
      await sleep(400, ctx.cancelled);
      continue;
    }
    const dialog = entrydialogs.inspect(uimap.parseNodes(page.xml));
    if (dialog) {
      if (ctx.log) ctx.log('备用入口：点击动态后遇到入口弹窗，先处理再确认动态流：' + (dialog.name || '未知弹窗'), 'info');
      if (dialog.resume && dialog.button) {
        const r = await adb.tap(serial, dialog.button.center.x, dialog.button.center.y);
        if (!r.ok) {
          const error = new Error('点击动态后未能关闭未完成内容提示；未继续进入发布入口。');
          error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
          throw error;
        }
      } else if (dialog.button) {
        const r = await adb.tap(serial, dialog.button.center.x, dialog.button.center.y);
        if (!r.ok) {
          const error = new Error('点击动态后未能关闭入口弹窗；未继续进入发布入口。');
          error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
          throw error;
        }
      }
      await sleep(400, ctx.cancelled);
      continue;
    }
    await sleep(400, ctx.cancelled);
  }
  if (!trendConfirmed) {
    const focus = await adb.currentFocus(serial, { timeout: 3000 });
    const error = new Error(`点击「动态」后等待 30 秒仍未确认回到动态流；当前页面${focus || '读不到'}。未点击相机、未进入发布流程，本批停止。`);
    error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
    throw error;
  }
  await tapReadyCamera(serial, ctx);
  // 只点击一次，慢设备允许继续转场；命令回执不代表页面已进入。
  const started = performance.now(), timeoutMs = 30000;
  let focus = '', lastKnownFocus = '', warned = false;
  while (performance.now() - started < timeoutMs) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    const remaining = Math.max(1, timeoutMs - (performance.now() - started));
    focus = await adb.currentFocus(serial, { timeout: Math.min(3000, Math.ceil(remaining)) });
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    if (focus) lastKnownFocus = focus;
    if (uimap.isPublishScreen(focus) || uimap.isDraftScreen(focus)) {
      ctx.publishEntryReady = true;
      ctx.publishEntryRoute = 'camera';
      if (ctx.log) ctx.log('已通过动态流相机进入发布流程，跳过账号主页入口', 'info');
      return { ok: true, focus };
    }
    if (!warned && performance.now() - started >= 8000) {
      warned = true;
      if (ctx.log) ctx.log('备用入口跳转较慢，继续等待页面确认（最多 30 秒，不重复点击相机）', 'info');
    }
    await sleep(Math.min(300, Math.max(0, timeoutMs - (performance.now() - started))), ctx.cancelled);
  }
  const observed = !focus ? '当前前台页面读不到' : uimap.isHomeScreen(focus)
    ? '当前仍在得物首页，无法区分点击未生效还是跳转卡顿'
    : `当前停在其他页面「${focus}」，可能被弹窗或其他应用阻挡`;
  const error = new Error(`已点击动态流相机，等待 30 秒仍未确认进入相册或草稿箱；${observed}`
    + (!focus && lastKnownFocus ? `；此前最后读到「${lastKnownFocus}」，不作为当前页面` : '')
    + '。未选图、未提交，不重复点击；本批停止，请查看设备页面或失败截图。');
  error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
  throw error;
}

function isAccountEntryStep(step) {
  return step.action === 'tapId' && /:(?:id)\/(?:tab_user|tvGoHomePage|rlPublish)$/.test(step.value || '')
    || step.action === 'tapXY' && /^底部.*我/.test(step.name || '') && step.whenNotOn === 'com.shizhuang.duapp:id/rlPublish';
}

// 主入口和草稿箱出口同样必须等目标页，点击命令成功不等于转场完成。
async function confirmAlbumEntry(serial, step, ctx) {
  const allowDraft = step.value !== uimap.DEWU.draft.exitId;
  const started = Date.now();
  let focus = '';
  while (Date.now() - started < 30000) {
    if (ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消');
    focus = await adb.currentFocus(serial, { timeout: 3000 });
    if (uimap.isPublishScreen(focus) || allowDraft && uimap.isDraftScreen(focus)) {
      if (ctx.log) ctx.log(`${step.name || step.value}：已确认进入${uimap.isDraftScreen(focus) ? '草稿箱' : '发布流程'}`, 'info');
      return;
    }
    await sleep(300, ctx.cancelled);
  }
  const error = new Error(`${step.name || step.value}：点击后等待 30 秒仍未确认进入相册${allowDraft ? '或草稿箱' : ''}；当前页面${focus || '读不到'}。未选材、未填写、未提交，停止本批次。`);
  error.code = 'PUBLISH_ENTRY_UNCONFIRMED';
  throw error;
}

/**
 * @param presetXml 可选：调用方**刚刚**读到的这一屏结构（中间没有任何动作）。用它当第 1 次
 *   尝试的页面结构，省掉同一屏的第二次抓屏（实测一次 dump ~1-2s）。只为「读出这一屏之后
 *   紧接着就要点它」的调用方准备（见 openPublishEntry 的备用入口那一段）。
 */
async function runStep(serial, step, data, ctx, presetXml) {
  const checkCancelled = () => { if (ctx && ctx.cancelled && ctx.cancelled()) throw new Error('发布已取消'); };
  checkCancelled();
  if (ctx.publishEntryReady && isAccountEntryStep(step)) return { skipped: true, why: '已由备用入口进入发布流程' };
  // 离开话题输入段前先结束最后一个话题，必须早于点击关联好物或提交发布。
  if (!step.topicInput) await topicinput.finish(serial, ctx);
  checkCancelled();
  // ★ 屏幕守卫先判：不成立就**一个像素都不碰**，如实返回 skipped（交给调用方写日志）。
  //   reusedXml = 守卫刚抓到的那份结构；同一步的点击可以在**第 1 次尝试**直接用它，
  //   省掉第二次抓屏（实测一次 dump ~1-2s）。中间没有任何动作 ⇒ 结构一定新鲜。
  // ★ 2026-10-03 提速：这一步这一屏会不会 idle —— 由批次里共享的缓存决定。
  //   键用**步骤名**（定位表里写死的、不随数据变），所以同一条内容里的同一步、以及
  //   后面每一条内容的同一步，都命中同一个键。缓存只在这一次发布里有效，不落盘。
  const stepKey = (step && (step.name || (step.action + ':' + step.value))) || '';
  const animOffSteps = (ctx && ctx.animOffSteps) || null;
  const wantAnimOff = !!(animOffSteps && stepKey && animOffSteps[stepKey]);
  // ★★ 「选图之后的转场」现在是**一等步骤**（action=transition，见 services/transition.js）。
  //   这里仍然认一种**老表**的写法：`whenOn=edit_panel` 的守卫点击步（2026-10-16 之前发出去的
  //   表就是那样写的）。把它**就地转成**转场语义 ⇒ 老用户不重新导入定位表也能拿到这个修复。
  //   ★ 判据是「形状」，不是步骤名：名字是给用户看的，改名不该改变行为。
  if (step.action === 'transition'
    || (/^tap/.test(String(step.action || '')) && step.whenOn === 'com.shizhuang.duapp:id/edit_panel')) {
    const spec = step.action === 'transition' ? step : {
      name: '选图后的转场 · 等到标题填写页（旧表兼容）',
      until: ['com.shizhuang.duapp:id/etTitle'],
      from: ['com.shizhuang.duapp:id/flThumbSelect', 'com.shizhuang.duapp:id/edit_panel'],
      maxClicks: 2,
      timeout: 30000,
    };
    return require('./transition').run(serial, spec, ctx);
  }
  let reusedXml = (typeof presetXml === 'string' && presetXml) ? presetXml : null;
  if (step && (step.whenOn || step.whenNotOn)) {
    const g = await screenGuard(serial, step, ctx, wantAnimOff);
    if (!g.ok) return { skipped: true, why: g.why };
    reusedXml = g.xml || null;
    // ★★ 2026-10-04：守卫这一屏是关着动画抓到的 ⇒ 记下这个步骤名，本批后面同一步直接走关动画
    //   （实测相册页那类屏，不关动画每轮白等 ~11s；关掉后 ~2s 就抓到）。
    if (g.animOff && animOffSteps && stepKey && !animOffSteps[stepKey]) animOffSteps[stepKey] = true;
  }
  checkCancelled();
  switch (step.action) {
    case 'videoCover':
      return require('./videocover').select(serial, ctx);
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
        checkCancelled();
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
          d = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: wantAnimOff }, ctx);
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
        // ★★ 2026-10-16：`ctx.forceAlternateEntry`（只由「备用入口试发」模块传入）在这里
        //   **假装账号没有「主页」按钮** —— 哪怕它真的在屏幕上，也当成没找到。
        //   为什么是"假装找不到"而不是"另走一条路"：后面那段回退代码就是**线上无主页账号
        //   真正走的那条路**（回首页 → 点动态 → 等提示结束 → 点相机）。让试发从同一个入口
        //   进去，才谈得上"测的就是线上那条路"；自己另写一条，两条迟早各走各的。
        if ((!exact.length || ctx.forceAlternateEntry) && step.action === 'tapId' && step.value === 'com.shizhuang.duapp:id/tvGoHomePage') {
          // 浏览导航可能与素材推送重叠；备用入口必须留到相册就绪之后。
          if (ctx.deferPublishEntry) return { deferred: true };
          if (ctx.log) ctx.log('当前账号页面没有「主页」按钮，切换动态流相机入口', 'info');
          await openPublishEntry(serial, ctx);
          return { alternateEntry: true };
        }
        let rawHit = exact.length ? exact : uimap.findNodes(nodes, { contains: step.value }).filter(x => x && x.center);
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
            const d2 = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: wantAnimOff }, ctx);
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
      checkCancelled();
      const r = await adb.tapSeq(serial,
        pickList.map(n0 => ({ x: n0.center.x, y: n0.center.y })),
        pickList.length > 1 ? 250 : 0);
      if (!r.ok) throw new Error('点击失败：' + (r.stderr || '').trim());
      if (step.action === 'tapId' && ['com.shizhuang.duapp:id/rlPublish', uimap.DEWU.draft.exitId].includes(step.value)) {
        await confirmAlbumEntry(serial, step, ctx);
      }
      // 把选材检查交给下一次转场观测，正常路径不额外抓屏。
      if (step.action === 'tapId' && step.value === 'com.shizhuang.duapp:id/flThumbSelect') {
        const nextWasEnabled = nodes.some(n => /:id\/(?:tvNextStep|flNextStep)$/.test(n.id) && n.enabled);
        let repairs = 0, unknownObservations = 0;
        ctx.confirmSelection = async d => {
          const nodes = uimap.parseNodes(d.xml || '');
          if (!nodes.some(n => n.id === step.value)) return true;
          const counts = nodes.filter(n => /:id\/(?:tvNextStep|flNextStep)$/.test(n.id))
            .map(n => (n.text + ' ' + n.desc).match(/下一步\s*[（(]\s*(\d+)\s*[）)]/)).filter(Boolean).map(m => Number(m[1]));
          if (ctx.log) ctx.log('选材观测：预期 '+want+'；数量标记 '+(counts.length?counts.join('/'):'无')+'；图片格 '+nodes.filter(n=>n.id===step.value).length+'；可勾选 '+nodes.filter(n=>n.id===step.value&&n.checkable).length, 'info');
          const actual = counts.length && counts.every(n => n === counts[0]) ? counts[0] : null;
          if (actual === want) { ctx.confirmSelection = null; return true; }
          const cells = nodes.filter(n => n.id === step.value);
          // 相册只有一份素材时，从不可用变为可用的下一步可证明已选一份；无需依赖数字文案。
          if (want === 1 && cells.length === 1 && !nextWasEnabled
            && nodes.some(n => /:id\/(?:tvNextStep|flNextStep)$/.test(n.id) && n.enabled)) {
            ctx.confirmSelection = null; return true;
          }
          const targets = pickList.map(old => cells.find(n => n.bounds === old.bounds));
          // 只接受明确的可勾选状态；普通节点默认 checked=false 不能证明漏选。
          const known = targets.every(n => n && n.checkable && typeof n.checked === 'boolean');
          const missing = known ? targets.filter(n => !n.checked) : [];
          if (known && !missing.length && actual === null) { ctx.confirmSelection = null; return true; }
          if (known && missing.length && repairs < 2) {
            checkCancelled(); repairs++;
            const r = await adb.tapSeq(serial, missing.map(n => n.center), missing.length > 1 ? 250 : 0);
            if (!r.ok && ctx.log) ctx.log('漏选补点回执未确认，将按下一次页面观测核实', 'warn');
            if (ctx.log) ctx.log(`选材自动恢复：仅补选 ${missing.length} 张（第 ${repairs}/2 次）`, 'info');
            return false;
          }
          // 结构尚未就绪时先让转场循环继续观测，不能首次读不到就终止。
          if (!known && actual === null && unknownObservations++ < 2) return false;
          const error = new Error(`选材自动恢复未完成：预期 ${want} 张，实际 ${actual === null ? '读不到' : actual}；${known ? '补选后仍未确认' : '缺少可定位的勾选状态'}，保留现场`);
          error.code = 'PUBLISH_CONTENT_UNCONFIRMED'; throw error;
        };
      }
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
      //   读不到尺寸时停止，避免在旋转或断连时继续点击；每个固定坐标步骤重新读取。
      ctx.uiSize = await stableCoordinates(serial, ctx.uiMapScreen, ctx);
      const badPts = uimap.outOfScreenTapPoints([step], ctx.uiSize);
      if (badPts.length) {
        const sz = ctx.uiSize;
        const error = new Error(`这一步（${step.name || 'tapXY'}）写死的坐标落在屏幕之外：`
          + badPts.map(p => `${p.x},${p.y}`).join(' / ')
          + `；当前坐标系是 ${sz.w}x${sz.h}（${sz.landscape ? '横屏' : '竖屏'}）。`
          + `input tap 对越界坐标**不报错**（实测 rc=0、什么都没点到）⇒ 不拦就是全程静默点偏。`
          + `多半是抓定位表时的分辨率/方向和现在不一样：把模拟器调回去，或停到得物发布页`
          + `重新「抓取页面结构」→ 导入。`);
        error.code = 'UI_COORDINATES';
        throw error;
      }
      checkCancelled();
      const r = await adb.tapSeq(serial, pts, pts.length > 1 ? 250 : 0);
      if (!r.ok) throw new Error('点击失败：' + (r.stderr || '').trim());
      if (pts.length > 1 && ctx && ctx.log) {
        ctx.log(`${step.name || 'tapXY'}：一次点了 ${pts.length} 个坐标（${pts.map(p => p.x + ',' + p.y).join(' / ')}）`, 'info');
      }
      return;
    }
    case 'input': {
      if (step.topicInput) {
        await topicinput.write(serial, step.value, ctx);
        return;
      }
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
      //   读不到结构时有限重读；仍未知就停止批次，不让未知内容继续提交。
      const checkId = String((ctx && ctx.inputCheckId) || '');
      if (checkId) {
        const want = String(step.value == null ? '' : step.value);
        let got;
        for (let read = 0; read < 3; read++) {
          checkCancelled();
          got = await adb.readTextOf(serial, checkId, { pkg: uimap.DEWU.pkg });
          if (got.ok && String(got.text || '').trim() === '' && want && read === 0) {
            // 已明确确认空框，重新定位并补输一次；非空内容不追加，避免串字。
            if (ctx && ctx.log) ctx.log(`「${step.name || '输入'}」自动恢复：空框重新定位并补输一次`, 'info');
            await runStep(serial, { action: 'tapId', value: checkId, name: '输入自动恢复定位' }, {}, ctx);
            const retry = await adb.inputText(serial, want);
            if (!retry.ok && ctx && ctx.log) ctx.log('补输回执未确认，继续按实际内容核验', 'warn');
            continue;
          }
          if (got.ok) break;
          if (read < 2) await sleep(300, ctx && ctx.cancelled);
        }
        if (!got.ok) {
          const error = new Error(`「${step.name || '输入'}」有限重读后仍无法确认内容（${got.why}），停止批次并保留现场`);
          error.code = 'PUBLISH_CONTENT_UNCONFIRMED'; throw error;
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
      await sleep(Math.max(0, Number(step.value) || 1000), ctx && ctx.cancelled);
      checkCancelled();
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
        checkCancelled();
        const d = await mediapermission.dump(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: wantAnimOff }, ctx);
        if (d.ok && uimap.parseNodes(d.xml).some(n => String(n.id) === wantId)) return;
        const waited = Date.now() - t0;
        if (waited >= tmo) {
        const visible = d.ok
          ? uimap.parseNodes(d.xml).filter(n => n.text).slice(0, 10).map(n => n.text).join(' / ')
          : '';
          throw new Error(`等了 ${(waited / 1000).toFixed(1)}s 也没等到「${wantId}」出现`
            + (d.ok ? '' : `（连界面结构都抓不到：${d.why}）`)
          + (visible ? `；当前可见文本：${visible || '（空）'}` : '')
            + ' —— 要么前一屏那一下没点动，要么得物改版了。不硬点下一步。');
        }
        if (ctx && ctx.log) ctx.log(`等「${wantId}」出现…（已等 ${Math.round(waited / 1000)}s）`, 'info');
        await sleep(400, ctx && ctx.cancelled);
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
 * 提交后等待退出编辑流程，避免下一条清理或强停中断当前上传。
 * 本机实测：从草稿发布成功后会正常返回 DraftActivity，因此草稿箱只是返回页，不能判为存草稿失败。
 * 此函数仅判断能否安全开始下一条，不代替账号侧发布和审核结果核验。
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
      const inDewu=f.split('/')[0]===uimap.DEWU.pkg;
      if (inDewu && uimap.isDraftScreen(f)) {
        return { ok: true, draft: true, waited: +((Date.now() - t0) / 1000).toFixed(1), focus: f, left: f, seen };
      }
      // 只接受已核实的正常返回页；其他得物Activity可能仍是剪辑、上传或加载。
      if (inDewu && (uimap.isHomeScreen(f)
        || /(?:modules\.personal\.ui\.home\.PersonalActivity|modules\.user\.ui\.MyActivity)$/.test(f))) { left = f; break; }
    }
    if (Date.now() - t0 >= timeoutMs) break;
    if (typeof cancelled === 'function' && cancelled()) break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { ok: !!left, waited: +((Date.now() - t0) / 1000).toFixed(1), focus: last, left, seen };
}

async function runReal(row, item, copyRow, serial, map, ctx) {
  require('./diagnostics').phase('准备发布', row.seq);
  ctx.publishEntryReady = false;
  ctx.submissionPending = '';
  ctx.uiMapScreen = map.screen;
  ctx.uiSize = null;
  // 每条素材独立，上一条中断时遗留的输入状态不能带到新页面。
  ctx.topicNeedsEnd = false;
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

  // ★★ 2026-10-04（第四十轮）**0b) 「回主线」守卫 —— 必须排在清相册之前**。
  //   为什么非做不可（真机实测）：一条内容发完之后，得物停在哪儿是**不确定的**
  //     （个人主页 / 相册页 / 发布成功页），而下一条的第一步是「底部点『我』」那个**固定坐标**
  //     —— 只有 App 在首页时它底下才是底部导航。停在别处时那个坐标点下去就是乱点。
  //     ⇒ 用户看到的「第二条永远拉不起来」。
  //   ★ 顺序：守卫在**清相册/推素材之前** ⇒ 拦下时连素材都不推（不白跑几十秒）。
  //   ★ 失败就**如实抛错**，绝不"当作没这回事继续往下点"（不知道自己在哪一屏时点固定坐标＝乱点）。
  //   2026-10-14：历史强停恢复已禁止。草稿箱也是有效入口，连续发布直接沿用已有返回页。
  // 在真实执行入口加固，覆盖内置表、导入旧表和调用方传入表。
  ctx.confirmSelection = null; // 每条素材重新建立选材观测，不沿用上一条状态。
  const shape = require('./uimapshape');
  let selectedSteps = uimap.stepsFor(map, isVideo).slice();
  if (isVideo && !(map.videoSteps || []).length) {
    selectedSteps = selectedSteps.map(step => {
      // 复用图文的位置，不能复用图文的目标屏和图片数量。
      if (step.action === 'transition' && step.until === shape.IMAGE_TARGET) return shape.videoTransition();
      if (step.action === 'tapId' && step.value === 'com.shizhuang.duapp:id/flThumbSelect' && step.count === '${imageCount}') {
        return { ...step, count: '${videoCount}' };
      }
      return step;
    });
  }
  const stepKey = isVideo ? 'videoSteps' : 'steps';
  const steps = shape.harden({ [stepKey]: selectedSteps }).map[stepKey] || selectedSteps;
  if (isVideo && !steps.some(step => step.action === 'videoCover'
    || step.action === 'tapId' && /:id\/tv_skip$/.test(step.value || '')
    || step.action === 'tapXY' && String(step.value).replace(/\s/g, '') === '820,1857')) {
    const transitionIndex = steps.findIndex(step => step.action === 'transition' && step.until === shape.VIDEO_TARGET);
    if (transitionIndex >= 0) steps.splice(transitionIndex + 1, 0, { name: '选择并核验视频封面', action: 'videoCover' });
  }
  // 草稿箱本身有发布新动态入口。复用已有返回页信息和定位步骤，下一条无需回首页。
  const draftEntry = steps.findIndex(step => step.action === 'tapId' && step.value === uimap.DEWU.draft.exitId
    && step.whenOn === uimap.DEWU.draft.titleId);
  let entryFocus = '';
  const pullHome = async () => {
    row.status = '回主线';
    if (ctx.onRow) ctx.onRow(row);
    // ★ 别在这里自己先读一次 currentFocus —— 那会把「转场瞬间读不到」这个现场吃掉，
    //   让守卫误判成「明确知道停在别处」从而瞎启动 App。守卫返回的 `from` 就是它看到的起点。
    const knownReturn = ctx.publishReturnFocus;
    ctx.publishReturnFocus = '';
    const g = knownReturn && (uimap.isHomeScreen(knownReturn) || (draftEntry >= 0 && uimap.isDraftScreen(knownReturn)))
      ? { ok: true, focus: knownReturn, started: false }
      : await adb.ensureApp(serial, {
      pkg: uimap.DEWU.pkg,
      activity: uimap.DEWU.launchActivity,
      want: uimap.DEWU.homeActivity,
      judge: (f) => uimap.isHomeScreen(f) || (draftEntry >= 0 && uimap.isDraftScreen(f)),
      allowForceStop: false,
      // 收掉上一次中断留下的发布页时要让用户看见（内容进了草稿，不是被丢掉）。
      onNote: m => log(m, 'warn'),
      timeoutMs: Number(c.ensureAppTimeoutMs) > 0 ? Number(c.ensureAppTimeoutMs) : 30000
    });
    entryFocus = g.focus || '';
    if (!g.ok) {
      throw new Error('没能准备得物首页或草稿箱发布入口：' + (g.why || '未知原因')
        + ' —— 这一步不许跳过：定位表第一步是**固定坐标**点底部导航，停在别的页面上那个坐标底下不是底部导航。');
    }
    if (g.started) {
      log(`${row.dir}：之前不在首页，已准备发布入口（之前的页面：${g.from || '读不到'}）`, 'info');
    }
    return g;
  };
  await pullHome();

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
  const fixedPts = uimap.tapPointsOf(steps);
  if (fixedPts.length) {
    ctx.uiSize = await stableCoordinates(serial, map.screen, ctx);
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

  // 只并行已知的浏览导航。自定义步骤、发布入口、草稿处置、输入均不跨越清理屏障。
  const preparedSteps=new Set(), navSteps=[], absentDialogs=[];
  // ★★ 2026-10-16：强制备用入口（「备用入口试发」模块）时这段**照常收集、照常点「我」**。
  //   为什么不跳过：线上无主页按钮的账号，正是先点「我」、停在个人页、在**那里**才发现没有主页按钮，
  //   然后由 openPublishEntry 按返回键回首页再点「动态」。跳过「我」就等于把线上独有的一整截
  //   （个人页 → 返回首页）从测试里删掉 —— 那样测出来的结论不能用。
  //   强制只体现在**一个地方**：runStep 里把「主页」那一步当成找不到（见那段注释）。
  if (uimap.isHomeScreen(entryFocus)) {
    for(const step of steps) {
      if(step.action==='tapId'&&step.value==='com.shizhuang.duapp:id/tvCancel'&&step.whenOn===step.value) {
        absentDialogs.push(step); continue;
      }
      const browseId=step.action==='tapId'&&['com.shizhuang.duapp:id/tab_user','com.shizhuang.duapp:id/tvGoHomePage'].includes(step.value);
      const browsePoint=step.action==='tapXY'&&/^底部.*我/.test(step.name||'')&&step.whenNotOn==='com.shizhuang.duapp:id/rlPublish';
      if(!browseId&&!browsePoint)break;
      if(/\$\{|\bwhen\b/.test(step.value||'')||step.when||step.whenNot)break;
      navSteps.push(step);
    }
  }
  let canOverlap=navSteps.length>0 && ctx.publishEntryRoute !== 'camera';
  if(canOverlap&&absentDialogs.length) {
    const page=await adb.dumpEx(serial,{pkg:uimap.DEWU.pkg,retries:0,allowAnimOff:false});
    canOverlap=page.ok&&!/tvCancel|是否继续编辑|保存草稿|放弃编辑/.test(page.xml||'');
  }
  let preparation;
  if(canOverlap) {
    let aborted=false, navigationError=null;
    // ★★★ 2026-10-14（rich 四连失败后收紧）：导航**不在清理期间并行**。
    //   旧写法在 clearAlbum 还在 rm 的时候就点「我/主页」，而上一条已发布视频可能正在
    //   个人主页自动播放、握着解码句柄 —— 清理期间一碰界面，句柄就被继续拉住，
    //   rm 永远 busy（现场：0.3~0.7s 就报 busy，四连失败）。
    //   现在：清理收敛后才启动导航，与推送/索引重叠，进发布入口前统一等待。
    //   省时效果不变（导航 6~11s 覆盖在推送索引里），但清理阶段绝不发界面动作。
    const branchCancelled=()=>cancelled()||aborted||!!navigationError;
    let navigation=null;
    const startNavigation=()=>{
      if(navigation)return navigation;
      navigation=require('./diagnostics').isolatedPhase('准备个人主页',row.seq,async()=>{
        for(const step of navSteps) {
          if(branchCancelled())throw new Error('发布已取消');
          const result = await runStep(serial,step,{}, {...ctx,cancelled:branchCancelled,deferPublishEntry:true});
          // 延后的步骤不能标成已完成，主流程会在素材就绪后使用原 ctx 执行。
          if (result && result.deferred) break;
          preparedSteps.add(step);
        }
        for(const step of absentDialogs)preparedSteps.add(step);
      }).catch(error=>{navigationError=error;});
      return navigation;
    };
    const awaitNavigation=async()=>{ if(navigation)await navigation; if(navigationError)throw navigationError; };
    try {
      preparation=await albumready.prepare(serial,item,row,{...ctx,publishConfig:c,cancelled:branchCancelled,
        startNavigation,awaitNavigation});
    } catch(error) {
      const primaryNavigationError=navigationError;
      aborted=true;if(navigation)await navigation;
      throw primaryNavigationError&&!cancelled()?primaryNavigationError:error;
    }
    log(`${row.dir}：相册清理完成，个人主页导航已收敛，之后才进入发布入口`, 'info');
  } else preparation=await albumready.prepare(serial,item,row,{...ctx,publishConfig:c});
  const { remotes, remoteDir } = preparation;
  // ★★ 2026-10-16：「备用入口试发」**没有**单独的开入口段 —— 上面那个
  //   `(!exact.length || ctx.forceAlternateEntry)` 已经让「主页」那一步必走备用分支，
  //   由 runStep → openPublishEntry 自己接管（与线上无主页账号同一个调用点、同一段代码）。
  //   原来这里有一段「素材就绪后直接 openPublishEntry」，那会让试发变成一条**线上不存在的**捷径：
  //   线上是"点了我 → 在个人页发现没有主页按钮 → 回首页 → 点动态 → 点相机"，
  //   试发却是"素材好了 → 直接点相机"，中间那一截线上独有的路（个人页→回首页）根本没测到。
  //   两段一对比就知道该删哪一段：测的是线上那条，就不能给测试留一条更短的路。
  // 只复用本批已实际走通的入口；返回草稿箱时沿用它的出口，不绕回首页。
  if (ctx.publishEntryRoute === 'camera' && !uimap.isDraftScreen(entryFocus)) {
    require('./diagnostics').phase('备用发布入口', row.seq);
    log('本批已确认备用入口可用，直接使用动态流相机入口', 'info');
    await openPublishEntry(serial, ctx);
  }

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

  const preparedCopy = topicinput.prepare(copyRow || {});
  const data = {
    title: (copyRow && copyRow.title) || '',
    body: preparedCopy.body,
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
  preparedCopy.topics.forEach((t, i) => { data['topic' + (i + 1)] = t; });
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
  const entrySteps = uimap.isDraftScreen(entryFocus) && draftEntry >= 0 ? steps.slice(draftEntry) : steps;
  if (entrySteps !== steps) log(`${row.dir}：沿用草稿箱的「发布新动态」入口，不退出得物、不绕回首页`, 'info');
  for (const raw of entrySteps) {
    if(preparedSteps.has(raw))continue;
    if (cancelled()) throw new Error('已取消');
    if (ctx.publishEntryReady && isAccountEntryStep(raw)) {
      log(`${row.dir}：跳过「${raw.name || raw.value}」（已由备用入口进入发布流程）`, 'info');
      continue;
    }
    let step = topicinput.mark(raw, uimap.fill(raw, data));
    // 老用户定位表同样升级，不能只改出厂表让已安装的机器继续跳过封面。
    if (isVideo && ((step.action === 'tapXY' && String(step.value).replace(/\s/g, '') === '820,1857')
      || (step.action === 'tapId' && /:id\/tv_skip$/.test(step.value || '')))) {
      step = { name: '选择并核验视频封面', action: 'videoCover' };
    }
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
    // 守卫步骤先检查页面；步骤名不能让用户误以为已经点击或放弃了草稿。
    const stepLabel = step.whenOn === uimap.DEWU.draft.titleId && step.value === uimap.DEWU.draft.exitId
      ? '检查草稿箱（出现时进入相册）'
      : step.whenOn === uimap.DEWU.resumeDialog.dismissId && step.value === uimap.DEWU.resumeDialog.dismissId
        ? '检查继续编辑提示（出现时放弃旧内容）' : step.name;
    row.status = stepLabel;
    if (ctx.onRow) ctx.onRow(row);
    // ★ 交给 runStep 的 input 分支做回读校验（只有紧邻的上一步真是 tapId 才非空）
    ctx.inputCheckId = lastTapId;
    // ★★ 2026-10-04 逐步计时（用户问「为什么选择素材花了 8 秒 / 点关联好物花了 5 秒」）：
    //   不靠推理，把每一步的**真实毫秒数**量出来。只有慢到会引起注意的（≥1.5s）才说，
    //   免得日志被一堆 0.1s 淹没。计时不含日志本身的开销（纯 runStep 前后取差值）。
    const tStep = Date.now();
    require('./diagnostics').phase('界面步骤 ' + String(stepLabel || step.action).replace(/[^\u4e00-\u9fffA-Za-z0-9 ·_-]/g, '').slice(0, 45), row.seq);
    let rs;
    try {
      const submittingVideo = isVideo && (/^提交发布/.test(step.name || '') || step.submit === true
        || (raw === steps[steps.length - 1] && step.action === 'tapText' && step.value === '发布'));
      if (submittingVideo) await require('./videocover').verify(serial, ctx);
      rs = await runStep(serial, step, data, ctx);
      const pickedGoods = step.action === 'tapCardText'
        || step.action === 'tapId' && step.value === 'com.shizhuang.duapp:id/ivProduct';
      if (!(rs && rs.skipped) && pickedGoods) {
        try {
          // 选完好物后不能只等编辑页回来：得物可能点空、搜索为空、或识别结果把页面拉回。
          // 先确认容器里重新出现 ivDelete（用户口径：没挂上就是没选上），再确认编辑页返回。
          // 以前只有名字命中「好物N · 选结果第1格」才校验；旧表/改名后同样的点选会漏检，
          // 表现还是卡到后面找不到 etTitle，必须对每一种已点选的好物步骤统一收紧。
          await runStep(serial, { name: '选择好物后校验确实挂上', action: 'waitId', value: 'com.shizhuang.duapp:id/ivDelete', timeout: 8000 }, {}, ctx);
          await runStep(serial, { name: '选择好物后返回文案编辑页', action: 'waitId', value: 'com.shizhuang.duapp:id/etTitle', timeout: 30000 }, {}, ctx);
        } catch (error) {
          error.code = 'PUBLISH_TRANSITION_UNCONFIRMED';
          throw error;
        }
      }
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
    // 2026-10-12 用户确认：实际点击提交发布即记成功，不再按 Activity 判断结果。
    const submit = /^提交发布/.test(step.name || '') || step.submit === true
      || (raw === steps[steps.length - 1] && step.action === 'tapText' && step.value === '发布');
    if (submit && /^tap(?:Id|Text|Desc|XY)$/.test(step.action)) {
      if (rs && rs.skipped) throw new Error('「提交发布」被屏幕守卫跳过，未点击发布按钮。');
      log(`${row.dir}：已实际点击提交发布，等待退出编辑流程后再开始下一条`, 'info');
      require('./diagnostics').phase('等待提交退出', row.seq);
      const settle = await waitLeftPublishFlow(serial, {
        timeoutMs: Math.min(60000, Math.max(1000, Number(c.submissionWaitMs) || 30000)), cancelled
      });
      ctx.publishReturnFocus = settle.ok ? settle.focus : '';
      if (!settle.ok) {
        ctx.submissionPending = `已点击提交，但等待 ${settle.waited}s 后尚未确认退出编辑流程；停止后续条目，避免清理或重启打断上传，不自动重复提交。`;
        log(ctx.submissionPending, 'warn');
      } else {
        log(`${row.dir}：已退出编辑流程${settle.draft ? '（返回草稿箱属于正常返回路径）' : ''}，可继续下一条`, 'ok');
      }
      return true;
    }

    // ★★ 屏幕守卫（whenOn / whenNotOn）判「这一屏不对」⇒ 这一步**没发任何点击**。
    //   必须说出来：静默少点一步，真机上表现为「下一条莫名失败」，最难查。
    if (rs && rs.skipped) {
      log(`${row.dir}：跳过「${step.name || step.value}」（屏幕守卫：${rs.why}）`, 'info');
    }
  }

  throw new Error('定位表未实际点击「提交发布」按钮，请检查定位表；本条未记为成功。');
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

const activeDevices = new Map();
let deviceRunSequence = 0;
async function run(state, ctx = {}) {
  const publish = state.publish || {};
  const serial = publish.mode === 'adb' ? (publish.device || cfg().device || '') : '';
  if (serial && activeDevices.has(serial)) throw new Error('这台设备已有发布任务，等待当前任务完成后再发布，避免清理打断另一批素材');
  const token = { order: ++deviceRunSequence };
  if (serial) activeDevices.set(serial, token);
  try {
    // MuMu 会把同一实例暴露为多个端口。仅在另有批次运行时核对身份，
    // 普通单批次不增加设备命令；后来的任务不能通过更换端口接管同一相册。
    const earlier = serial ? [...activeDevices.entries()].filter(([s, t]) => s !== serial && t.order < token.order) : [];
    if (earlier.length) {
      const identity = async device => {
        const r = await adb.shell(device, 'settings get secure android_id', { timeout: 3000 });
        const value = String(r && r.stdout || '').trim().toLowerCase();
        return r && r.ok && /^[0-9a-f]{8,}$/.test(value) ? value : '';
      };
      const ids = await Promise.all([serial, ...earlier.map(([s]) => s)].map(identity));
      if (!ids[0] || earlier.some(([s, t], i) => activeDevices.get(s) === t && !ids[i + 1])) {
        throw new Error('另有发布任务运行，暂时无法确认两个端口是否属于独立设备；等待当前任务结束后再发布，避免相册互相清理');
      }
      if (ids[0] && earlier.some(([s, t], i) => activeDevices.get(s) === t && ids[i + 1] === ids[0])) {
        throw new Error('这台设备已有发布任务，另一个ADB端口属于同一模拟器，等待当前任务完成后再发布');
      }
    }
    return await runBatch(state, ctx);
  }
  finally { if (serial) activeDevices.delete(serial); }
}

async function runBatch(state, ctx = {}) {
  // 返回页只属于当前批次；调用者复用 ctx 或换设备时必须重新观察入口。
  ctx.publishReturnFocus = '';
  ctx.publishEntryRoute = '';
  // ★★ 2026-10-16：**强制走备用入口**（动态流相机）。
  //   为什么要有它：本机账号有「主页」按钮 ⇒ 主入口永远能走通，备用入口在本机**没有真实触发条件**。
  //   只让发布器「先找主页、找不到才退备用」的话，本机永远测不到备用那一段 —— 而远端
  //   （无主页按钮的账号）走的正是那一段。所以给一个显式开关，从调用方传进来，
  //   **不改默认行为**：不传就是原来的两条路线自动挑。
  //   ★ 它只影响「走哪个入口」，不影响后面任何一步：依然是真实 publisher.run、真实设备、真实点击，
  //     所以用它测出来的结果可以直接用于判断备用入口本身有没有问题。
  ctx.forceAlternateEntry = !!(state.publish && state.publish.forceAlternateEntry) || !!ctx.forceAlternateEntry;
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
  // 正式安装版不能在设备未就绪时退回模拟发布。
  if (require('electron').app.isPackaged && mode !== 'adb') {
    throw new Error('设备尚未准备好，不能发布。请连接模拟器并通过「检查能不能发布」后重试。');
  }
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

  // 强制备用入口时先校验定位表里确实有备用入口要用到的步骤，缺了就当场说清楚，
  // 不要跑到一半才发现没有那一跳。
  if (mode === 'adb' && ctx.forceAlternateEntry) {
    const hasTrends = (map.steps || []).some(s => s.action === 'tapId' && s.value === 'com.shizhuang.duapp:id/tab_trends');
    if (map.steps && map.steps.length && !hasTrends) {
      // 备用入口自己会点「动态」tab，定位表里那一步不是必需的 —— 这里只作提示，不拦。
      log('强制备用入口：定位表里没有「动态」页签步骤，仍按内置的动态流相机入口走', 'info');
    }
  }

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
  // 批次共有的设备配置在循环前检查，一次不匹配就保持所有条目待处理。
  if (mode === 'adb' && todo.length && [false, true].some(video => uimap.tapPointsOf(uimap.stepsFor(map, video)).length)) {
    const home = await adb.ensureApp(serial, {
      pkg: uimap.DEWU.pkg, activity: uimap.DEWU.launchActivity, want: uimap.DEWU.homeActivity,
      judge: focus => uimap.isHomeScreen(focus) || uimap.isDraftScreen(focus), allowForceStop: false,
      onNote: m => log(m, 'warn'),
      timeoutMs: Number(c.ensureAppTimeoutMs) > 0 ? Number(c.ensureAppTimeoutMs) : 30000
    });
    if (!home.ok) throw new Error('发布前未能将得物拉回首页：' + (home.why || '未知原因'));
    ctx.uiMapScreen = map.screen;
    try {
      ctx.uiSize = await stableCoordinates(serial, map.screen, ctx);
    } catch (error) {
      if (error.code !== 'UI_COORDINATES') throw error;
      // 仅在整批开始、尚未清相册或推素材时修复一次；发布途中不改屏幕布局。
      try {
        ctx.uiSize = await require('./displayrecovery').repair(serial, map.screen, {
          cancelled: ctx.cancelled, log,
          check: target => stableCoordinates(serial, target, ctx)
        });
      } catch (recoveryError) {
        error.message += '；自动恢复未通过：' + recoveryError.message;
        throw error;
      }
    }
    const invalid = [false, true].flatMap(video => uimap.outOfScreenTapPoints(uimap.stepsFor(map, video), ctx.uiSize));
    if (invalid.length) {
      const error = new Error(`定位表坐标超出当前 ${ctx.uiSize.w}×${ctx.uiSize.h} 屏幕，请调整分辨率或重新导入定位表。尚未清理相册或推送素材。`);
      error.code = 'UI_COORDINATES';
      throw error;
    }
  }
  // ★★ 2026-10-13 用户口径：「预估耗时都不准（图文 30 秒那套），直接删了吧」。
  //   为什么删而不是调参数：单条耗时由设备、网络、素材体积、好物识别等待共同决定 ——
  //   真机实测同一批图文 65–99s、视频 66–85s 全属正常范围 ⇒ 任何固定系数都会骗人。
  //   与其给一个会被当成承诺的数字，不如只报「几条待发」，把真实耗时交给逐条实耗。
  const itemById = new Map((state.items || []).map(it => [String(it.id), it]));
  const kindCount = todo.reduce((a, r) => {
    if (rowKind(r, itemById.get(String(r.id)) || {}) === 'video') a.video++; else a.image++;
    return a;
  }, { image: 0, video: 0 });
  const mix = kindCount.video ? `（图文 ${kindCount.image} · 视频 ${kindCount.video}）` : '';
  conclude(`开始发布（${mode === 'adb' ? '真实设备通道' : '模拟通道'}）：${todo.length} 条${mix}`, mode === 'adb' ? 'ok' : 'warn');
  if (mode === 'mock') conclude('模拟通道不接触设备，只演练节奏/回写；要真发请先「连接模拟器」并点「检查能不能发布」通过', 'warn');
  log('发布期间不占用发布单文件，结果先写 publish-log.jsonl', 'info');

  const copyById = new Map((state.copyRows || []).map(r => [r.id, r]));
  let done = 0;
  const results = [];
  const settledRows = new Set();
  let stoppedReason = '';
  let stoppedForAlbum = false;
  let stoppedForSubmission = false;
  let stoppedForEntry = false;

  for (const row of todo) {
    if (cancelled()) break;
    const item = state.items.find(it => it.id === row.id) || {};
    row.images = (item.files || []).filter(f => f.type === 'image').length || 0;
    row.goods = row.goods || 1;

    // ★ 拦不拦看 `verify.isBlocked()`，**不是** `pass === false`：
    //   前者只拦「有据可判的不一致」（颜色不匹配 / 多色漏填 / 主色不符）；
    //   「货号查不到颜色」属于**没有数据**，按真机口径只告警、照常发布 ——
    //   否则商品资料没导全时会**整批静默不发布**，而界面只显示「校验未通过」。
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
        // 有间隔时用户可能操作设备，不能沿用上一条返回页；连续发布直接复用。
        ctx.publishReturnFocus = '';
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
    row.startedAtMs = t0;
    row.elapsed = 0;
    row.result = '';
    row.reason = '';
    row.status = '准备发布';
    onRow(row);
    try {
      if (mode === 'adb') {
        success = await runReal(row, item, copyById.get(row.id), serial, map, ctx);
      } else {
        const r = await runMock(row, ctx);
        success = r === 'cancelled' ? false : !!r;
        if (r === 'cancelled') reason = '任务已取消';
      }
    } catch (e) {
      success = false;
      require('./diagnostics').fail();
      reason = cancelled() ? '任务已取消' : e.message;
      stoppedForAlbum = e.code === 'ALBUM_IO_INTERRUPTED' || e.code === 'ALBUM_BUSY';
      if (e.code === 'ALBUM_BUSY') stoppedReason = '相册文件持续占用，自动恢复未解除；请处理设备占用后重新启动任务';
      if (e.code === 'UI_COORDINATES') stoppedReason = reason;
      if (e.code === 'PUBLISH_ENTRY_UNCONFIRMED' || e.code === 'PUBLISH_TRANSITION_UNCONFIRMED' || e.code === 'PUBLISH_CONTENT_UNCONFIRMED') { stoppedReason = reason; stoppedForEntry = true; }
      // 持续文件占用是设备级故障，停止本批次，后续素材保留未执行。
      if (e.code === 'ALBUM_IO_INTERRUPTED') log(`行 ${row.seq} 相册清理中断，跳过本条；下一条将重新清理并验证后再发布`, 'warn');
      // 失败截图留一张：真机排查「崩在哪一屏」只能靠它。原来按第几次尝试命名，现在只跑一次。
      if (mode === 'adb' && !stoppedForAlbum && !cancelled()) await saveShot(serial, `seq${row.seq}_fail`, ctx);
    }
    if (success && ctx.submissionPending) { stoppedReason = ctx.submissionPending; stoppedForSubmission = true; }
    require('./diagnostics').phase('条目结束');
    // ★★ 模拟通道**不许冒充真发布**：走模拟时结果记「模拟成功」。
    //   否则界面 / 台账 / 回写 Excel 全是绿的，而设备上什么都没发生（2026-10-03 实测踩到）。
    //   「模拟成功」不会被统计成真发布（统计只认「发布成功」），也不会写「审核中」。
    row.status = success ? (mode === 'adb' ? '发布成功' : '模拟成功') : '失败';
    row.result = success ? (mode === 'adb' ? '发布成功' : '模拟成功') : '失败';
    if (!success && cancelled()) { row.status = '已取消'; row.result = '已取消'; }
    const rowCancelled = row.result === '已取消';
    settledRows.add(row);
    // ★ 2026-10-03：模拟通道不再随机失败 ⇒ 这里不需要「编一个失败原因」的分支了（拔掉假原因）。
    row.reason = success ? '' : (reason || '未知');
    if (!success) log(rowCancelled ? `${row.dir}：任务已取消，未继续发布` : `${row.dir} 发布失败，原因${row.reason}`, rowCancelled ? 'info' : 'warn');
    const tag = rowKind(row, item) === 'video' ? '视频' : '图文';
    row.elapsed = +((Date.now() - t0) / 1000).toFixed(1);
    onRow(row);
    if (success) log(`行 ${row.seq}[${tag}] 发布完成，已回填时间 ${row.startAt}（耗时 ${row.elapsed}s）`, 'ok');
    else log(rowCancelled ? `行 ${row.seq}[${tag}] 已取消（耗时 ${row.elapsed}s）` : `行 ${row.seq}[${tag}] 发布失败，原因${row.reason}（耗时 ${row.elapsed}s）`, rowCancelled ? 'info' : 'warn');

    sheet.appendLog({
      batch, seq: row.seq, id: row.id, dir: row.dir, at: row.startAt, result: row.result, reason: row.reason,
      title: String((copyById.get(row.id) || {}).title || ''),
      body: topicinput.prepare(copyById.get(row.id) || {}).body,
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
    progress({ done, total: todo.length, label: row.dir, succeeded: results.filter(r => r.result === '发布成功').length });
    if (stoppedReason) {
      conclude((stoppedForEntry ? '发布流程自动恢复后仍未确认' : stoppedForSubmission ? '本条提交尚未稳定' : stoppedForAlbum ? '相册持续占用' : '设备屏幕配置变化') + '，本批次已停止；其余素材未执行：' + stoppedReason, 'warn');
      break;
    }
  }

  if (cancelled() || stoppedReason) {
    for (const row of todo) {
      if (settledRows.has(row) || row.result === '校验未通过') continue;
      row.status = '未执行'; row.result = '未执行'; row.reason = '本批次已停止，尚未执行' + (stoppedReason ? '：' + stoppedReason : '');
      row.startAt = ''; row.startedAtMs = null; row.elapsed = null;
      onRow(row);
    }
  }
  // 批次汇总只统计本次实际执行的结果；队列里此前已提交的条目不再计入。
  const okCount = results.filter(r => r.result === '发布成功').length;
  const failCount = results.filter(r => r.result === '失败').length;
  log(`批量发布完成，总耗时 ${((Date.now() - tAll) / 1000).toFixed(1)}s`, 'info');
  log(cancelled() || stoppedReason ? `批次已停止：成功 ${okCount} 条，失败 ${failCount} 条，其余已取消或未执行`
    : `发布结束：共 ${todo.length} 条 / ${failCount} 失败，成功 ${okCount}（${mode === 'adb' ? '真实设备' : '模拟'}）。内容展示与审核结果请在得物查看`, cancelled() ? 'info' : stoppedReason ? 'warn' : 'ok');
  return { rows, results, okCount, total: todo.length, failCount, batch, mode, stoppedReason, cancelled: !!cancelled() };
}

module.exports = {
  sleep,
  connect, run, saveShot, dumpForCapture,
  // ★★ 2026-10-03：把**步骤引擎**也导出来。理由：真机上要逐屏验证某一步（选图 N 张、点颜色格）
  //    时，只有拿这套真代码跑才算数 —— 自己另写一份「差不多的」点在真机上，验的就不是发布器了。
  runStep,
  openPublishEntry,
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
