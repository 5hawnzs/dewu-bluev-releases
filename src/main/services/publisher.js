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
const uimap = require('./uimap');
const verifySvc = require('./verify');
const store = require('../store');
const sheet = require('./sheet');
const wp = require('../util/winpath');

const STEPS = ['上传图片…', '填标题正文', '话题联想点选', '关联好物', '发布确认'];

function cfg() { return store.get('publish') || {}; }

/** 支持「还剩 N 秒」倒计时回调（真机日志：按 1 分钟间隔，57s 后执行） */
function sleep(ms, cancelled, onTick) {
  return new Promise(resolve => {
    const end = Date.now() + ms;
    const t = setInterval(() => {
      if (cancelled && cancelled()) { clearInterval(t); resolve(false); return; }
      if (onTick) onTick(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    }, 1000);
    setTimeout(() => { clearInterval(t); resolve(true); }, ms);
  });
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
  const raw = await adb.devices();
  return raw.map(d => {
    const c = conf.find(x => x.serial === d.serial);
    return {
      serial: d.serial, state: d.state, online: d.state === 'device',
      configured: !!c, id: (c && c.id) || '', name: (c && c.name) || ''
    };
  });
}

function rand(a, b) { return Math.round(a + Math.random() * Math.max(0, b - a)); }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

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
    const avg = isV ? (c.videoIntervalSec || Math.round((c.intervalSec || c.intervalMinSec || 60) * 1.5))
      : (c.intervalSec || c.intervalMinSec || 60);
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
  const ready = !!(p.device && p.tools.uiautomator && p.tools.input && p.appPackage);
  const notes = p.notes.slice();
  if (ready && !(map && map.steps && map.steps.length)) {
    notes.push('还没配 UI 定位表（「设置 → 高级设置」→「抓取页面结构」→ 导入），配好前不会走真实通道'
      + '；抓之前先把模拟器停在得物发布页（首页右上角那个相机图标进去那一页）');
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

async function runStep(serial, step, data, ctx) {
  switch (step.action) {
    case 'tapText': case 'tapId': case 'tapDesc': {
      const d = await adb.dumpEx(serial);
      if (!d.ok) throw new Error(`拿不到界面结构：${d.why}${d.idle ? '（这个页面一直不 idle）' : ''}`);
      if (d.animOff && ctx && ctx.log) {
        ctx.log('页面一直不 idle，已临时关掉系统动画抓到结构（抓完已还原）', 'warn');
      }
      const xml = d.xml;
      const nodes = uimap.parseNodes(xml);
      const cond = step.action === 'tapText' ? { text: step.value }
        : step.action === 'tapId' ? { id: step.value } : { desc: step.value };
      const node = uimap.findNode(nodes, cond) || uimap.findNode(nodes, { contains: step.value });
      if (!node || !node.center) {
        const visible = nodes.filter(n => n.text).slice(0, 10).map(n => n.text).join(' / ');
        throw new Error(`找不到「${step.value}」；当前可见文本：${visible || '（空）'}`);
      }
      const r = await adb.tap(serial, node.center.x, node.center.y);
      if (!r.ok) throw new Error('点击失败：' + (r.stderr || '').trim());
      return;
    }
    case 'input': {
      // ★ 输入通道（中文必须走 ADBKeyboard 广播）由 adb.inputText 自己按**设备真实输入法状态**
      //   判定 —— 以前这里传的是配置项 `publish.adbKeyboard`，而那个键全仓没有任何地方会写它
      //   （界面没有开关、默认配置里也没有）⇒ 恒为假 ⇒ 中文永远走 `input text`（实测打不进中文、
      //   却返回成功）⇒ 帖子会发出去但标题正文是空的，日志还写「发布成功」。
      const r = await adb.inputText(serial, step.value);
      if (!r.ok) throw new Error('输入失败：' + (r.stderr || '').trim());
      return;
    }
    case 'wait':
      await sleep(Math.max(0, Number(step.value) || 1000));
      return;
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
  return Object.assign({}, d, { focus, focusNote, onPublish, viaNote });
}

/** 失败恢复：真机日志里是「已回退转发页」「删除卡片」，避免下一条起点被残留界面污染 */
async function recover(serial, map, ctx) {
  const log = ctx.log || (() => {});
  try {
    await adb.keyevent(serial, 4);              // 返回键，退出当前页
    // 存的时候已经校验过（publish.setRecover），这里再走一遍是为了拦住手改 config.json / 导入旧表的情况：
    // 不认识的步骤宁可报出来，也不要静默跳过 —— 跳过意味着「以为回退了，其实没有」
    const steps = uimap.normalizeRecover((map && map.recover) || []);
    for (const raw of steps) {
      const step = uimap.fill(raw, {});
      if (step.action === 'tapText' || step.action === 'tapId' || step.action === 'tapDesc') {
        const d = await adb.dumpEx(serial);
        if (!d.ok) break;
        const xml = d.xml;
        const nodes = uimap.parseNodes(xml);
        const node = uimap.findNode(nodes, step.action === 'tapText' ? { text: step.value }
          : step.action === 'tapId' ? { id: step.value } : { desc: step.value });
        if (node && node.center) await adb.tap(serial, node.center.x, node.center.y);
        else break;    // 页面上没有就不硬点
      } else if (step.action === 'wait') {
        await sleep(Number(step.value) || 800);
      } else {
        log(`恢复动作里有不认识的一步（${step.action}），已跳过`, 'warn');
      }
    }
    log('已回退上一页，准备下一条', 'info');
  } catch (e) {
    log('回退失败：' + e.message, 'warn');
  }
}

async function runReal(row, item, copyRow, serial, map, ctx) {
  const log = ctx.log || (() => {});
  const cancelled = ctx.cancelled || (() => false);
  const c = cfg();

  // 0) 这条发视频还是图文：报告标了就以报告为准，没标按目录推断；两边都有又没标 → 这里必须拦住
  const kind = rowKind(row, item);
  if (!kind) throw new Error('判不了这条该发图文还是视频：这个叶子里图和视频都有，报告里也没标「内容类型」');
  const isVideo = kind === 'video';
  const mediaWord = isVideo ? '视频' : '图';
  row.kind = kind;

  // 1) 推素材 + 触发媒体扫描（不推，得物相册里根本看不到）
  const media = (item.files || []).filter(f => f.type === (isVideo ? 'video' : 'image'));
  if (!media.length) throw new Error(`这条按「${isVideo ? '视频' : '图文'}」发，但没有可推的${mediaWord}片文件`);
  const remoteDir = '/sdcard/DCIM/Camera';
  const remotes = [];
  for (const f of media) {
    const abs = path.join(item.absDir || item.dir, f.name);
    const remote = `${remoteDir}/${String(f.name).replace(/[^\w.\-+]/g, '_')}`;
    const r = await adb.push(serial, abs, remote);
    if (!r.ok) throw new Error(`推${mediaWord}片失败 ${f.name}：${(r.stderr || '').trim()}`);
    await adb.mediaScan(serial, remote);
    remotes.push(remote);
  }
  log(`${row.dir}：已推 ${media.length} 个${mediaWord}片并触发媒体扫描`, 'info');

  // 视频体积大，媒体库索引比图片慢得多：广播发完相册里往往还没有它 → 必须等到真能看见再往下走。
  // 否则会稳定卡在「相册里选不到这条视频」，而且看起来像点击步骤配错了，很难查。
  if (isVideo) {
    const sec = Number(c.videoIndexTimeoutSec) > 0 ? Number(c.videoIndexTimeoutSec) : 180;
    row.status = '等媒体库索引';
    if (ctx.onRow) ctx.onRow(row);
    const w = await adb.mediaVisible(serial, remotes, {
      timeoutMs: sec * 1000,
      onTick: s => { row.status = `等媒体库索引 ${s}s`; if (ctx.onRow) ctx.onRow(row); }
    });
    if (!w.ok) {
      // ★ 实测（2026-10-01，MuMu 12 / Android 12）：这台设备上媒体扫描广播**不生效**，
      //   所以「把超时调大」是一条必然失败的建议 —— 不要写进提示里，那是给用户假期待。
      throw new Error(`视频已推到设备，但等了 ${w.waited}s 媒体库还没索引到（所以得物相册里选不到它）`
        + (w.error ? `：${w.error}` : '')
        + '；★ 这台模拟器上「媒体扫描广播」是不生效的（MEDIA_MOUNTED 被系统拒、'
        + 'MEDIA_SCANNER_SCAN_FILE 发了也不收录），**只有重启模拟器**系统才会把新文件收进相册。');
    }
    log(`${row.dir}：媒体库已索引到视频（等待 ${w.waited}s）`, 'info');
  }

  // 2) 按 UI 定位表走真实界面。
  //    ★ 2026-10-02 用户实测：**图文和视频的发布位置是一样的**（入口、相册页签、编辑页同一套），
  //      所以 videoSteps 没单独配时**直接复用 steps**，不再拦下。
  //      videoSteps 仍然保留：哪天真机改版、视频那条路跟图文不一样了，单独配一套就能覆盖。
  const vSteps = map.videoSteps || [];
  const reuseForVideo = isVideo && !vSteps.length;
  const steps = isVideo ? (vSteps.length ? vSteps : (map.steps || [])) : (map.steps || []);
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
    videoName: remotes[0] ? path.basename(remotes[0]) : ''
  };
  (copyRow && copyRow.topics || []).forEach((t, i) => { data['topic' + (i + 1)] = t; });

  for (const raw of steps) {
    if (cancelled()) throw new Error('已取消');
    const step = uimap.fill(raw, data);
    row.status = step.name;
    if (ctx.onRow) ctx.onRow(row);
    await runStep(serial, step, data, ctx);
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
  return Math.random() > 0.08;
}

/* ---------------- 主流程 ---------------- */

async function run(state, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const onRow = ctx.onRow || (() => {});
  const c = cfg();
  const mode = (state.publish && state.publish.mode) || 'mock';
  const serial = (state.publish && state.publish.device) || c.device || '127.0.0.1:5555';
  const map = c.uiMap;

  if (mode === 'adb' && !(map && map.steps && map.steps.length)) {
    throw new Error('真实通道需要先配 UI 定位表：把模拟器停在得物发布页（首页右上角相机图标进去那一页），'
      + '在「设置 → 高级设置」点「抓取页面结构」，改好后导入 uiMap.json');
  }

  const rows = (state.publish && state.publish.rows && state.publish.rows.length)
    ? state.publish.rows
    : sheet.buildRows(state, { intervalSec: c.intervalSec || c.intervalMinSec || 60 })
      .map((r, i) => ({ seq: i + 1, id: state.items[i] ? state.items[i].id : String(i + 1), dir: r[1], goods: 1, images: 0, startAt: '', status: '排队', result: '', retries: 0, reason: '' }));
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

  log(`本次归属：品牌「${who.brandName || '未标品牌'}」${actor.username ? ' · 执行人 ' + (actor.displayName || actor.username) : ''}`,
    who.brandId ? 'info' : 'warn');
  if (!who.brandId) log('这条批次没有品牌归属：发布日志里会记成「未标品牌」，统计时单独列出（不会并进任何品牌）', 'warn');

  const todo = rows.filter(r => r.result !== '发布成功');
  // 预估要按图文/视频分开算：视频单条更慢（推得久 + 还要等媒体库索引），混着算会明显偏短
  const itemById = new Map((state.items || []).map(it => [String(it.id), it]));
  const estKinds = todo.reduce((a, r) => {
    if (rowKind(r, itemById.get(String(r.id)) || {}) === 'video') a.video++; else a.image++;
    return a;
  }, { image: 0, video: 0 });
  const est = estimate(todo.length, estKinds);
  const mix = estKinds.video ? `（图文 ${estKinds.image} · 视频 ${estKinds.video}）` : '';
  log(`开始发布（${mode === 'adb' ? '真实设备通道' : '模拟通道'}）：${todo.length} 条${mix}，预计 ${est.minutes} 分钟`, mode === 'adb' ? 'ok' : 'warn');
  if (mode === 'mock') log('模拟通道不接触设备，只演练节奏/重试/回写；要真发请先「连接模拟器」并点「检查能不能发布」通过', 'warn');
  log('发布期间不占用发布单文件，结果先写 publish-log.jsonl', 'info');

  const copyById = new Map((state.copyRows || []).map(r => [r.id, r]));
  let done = 0;
  const results = [];

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
      // 真机是固定间隔（默认 60 秒），带倒计时；视频单条更慢，间隔单独放宽
      const video = rowKind(row, item) === 'video';
      const wait = video ? (c.videoIntervalSec || Math.round((c.intervalSec || c.intervalMinSec || 60) * 1.5))
        : (c.intervalSec || c.intervalMinSec || 60);
      log(`按 ${wait} 秒间隔，${wait}s 后执行`, 'info');
      if (!await sleep(wait * 1000, cancelled, left => {
        progress({ done, total: todo.length, label: `${left}s 后执行`, waitLeft: left });
      })) break;
    }

    let attempt = 0, success = false, reason = '';
    const maxTry = (c.retry || 2) + 1;
    const t0 = Date.now();
    while (attempt < maxTry && !success) {
      attempt++;
      row.startAt = new Date().toTimeString().slice(0, 8);
      row.retries = attempt - 1;
      try {
        if (mode === 'adb') {
          success = await runReal(row, item, copyById.get(row.id), serial, map, ctx);
        } else {
          const r = await runMock(row, ctx);
          if (r === 'cancelled') break;
          success = !!r;
        }
      } catch (e) {
        success = false;
        reason = e.message;
        if (mode === 'adb') {
          await saveShot(serial, `seq${row.seq}_try${attempt}`, ctx);
          await recover(serial, map, ctx).catch(() => {});
        }
      }
      row.status = success ? '发布成功' : '失败';
      row.result = success ? '发布成功' : '失败';
      row.reason = success ? '' : (reason || (mode === 'mock' ? pick(['话题联想未出现候选', '图片上传超时', '好物关联失败', '页面结构变化']) : '未知'));
      if (!success) {
        log(`${row.dir} 第 ${attempt} 次失败：${row.reason}`, 'warn');
        if (attempt < maxTry) await sleep(1500, cancelled);
      }
      onRow(row);
    }

    const tag = rowKind(row, item) === 'video' ? '视频' : '图文';
    row.elapsed = +((Date.now() - t0) / 1000).toFixed(1);
    if (success) log(`行 ${row.seq}[${tag}] 发布完成，已回填时间 ${row.startAt}（耗时 ${row.elapsed}s）`, 'ok');
    else log(`行 ${row.seq}[${tag}] 发布失败：${row.reason}（耗时 ${row.elapsed}s）`, 'warn');

    sheet.appendLog({
      batch, seq: row.seq, id: row.id, dir: row.dir, at: row.startAt, result: row.result, reason: row.reason,
      retries: row.retries, elapsed: row.elapsed, mode, kind: tag,
      // 品牌 + 执行人：统计按品牌聚合、管理员追责，全靠这两个字段。
      // 品牌名存快照，日后改名/删品牌时旧账里的名字不会跟着变
      brandId: who.brandId, brandName: who.brandName,
      userId: actor.userId || '', username: actor.username || '', displayName: actor.displayName || ''
    });
    results.push({
      batch, seq: row.seq, at: row.startAt, result: row.result, reason: row.reason,
      retries: row.retries, elapsed: row.elapsed, kind: tag,
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
  connect, run, estimate, saveShot, recover, dumpForCapture,
  probes: adb.probe, probe: adb.probe, dump: adb.dump, dumpEx: adb.dumpEx,
  currentFocus: adb.currentFocus,
  // 一键装上内置的中文输入法（装 + 启用 + 设为当前输入法）—— 实现与「为什么必须三步」见 adb.js
  installIme: adb.installKeyboard,
  imeComponent: adb.adbKeyboardIme,
  devices, listDevices, scanDevices, addDevice, removeDevice
};
