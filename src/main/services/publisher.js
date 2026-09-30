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
  if (!serial) throw new Error('缺少设备序列号（如 emulator-5554）');
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
      adbKeyboard: p.adbKeyboard, notes: p.notes
    });
  }
  return out;
}

function rand(a, b) { return Math.round(a + Math.random() * Math.max(0, b - a)); }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function estimate(count) {
  const c = cfg();
  const avg = c.mock ? (c.mockIntervalSec || 5) : (c.intervalSec || c.intervalMinSec || 60);
  const perItem = avg + 30;   // 单条技术下限 ≈30 秒
  return { minutes: Math.round(count * perItem / 60), seconds: Math.round(count * perItem) };
}

/* ---------------- 真实通道 ---------------- */

async function connect(device) {
  const c = cfg();
  const list = devices();
  const serial = device || c.device || (list[0] && list[0].serial) || 'emulator-5554';
  const p = await adb.probe(serial);
  const ready = !!(p.device && p.tools.uiautomator && p.tools.input && p.appPackage);
  const map = c.uiMap;
  const notes = p.notes.slice();
  if (ready && !(map && map.steps && map.steps.length)) {
    notes.push('还没配 UI 定位表（发布页 →「抓取页面结构」→ 导入），配好前不会走真实通道');
  }
  return {
    connected: ready,
    mode: ready ? 'adb' : 'mock',
    device: serial,
    probe: p,
    hasMap: !!(map && map.steps && map.steps.length),
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

async function runStep(serial, step, data, ctx, adbKeyboard) {
  switch (step.action) {
    case 'tapText': case 'tapId': case 'tapDesc': {
      const xml = await adb.dump(serial);
      if (!xml) throw new Error('拿不到界面结构（uiautomator dump 失败）');
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
      const r = await adb.inputText(serial, step.value, { adbKeyboard });
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
        const xml = await adb.dump(serial);
        if (!xml) break;
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
  const adbKeyboard = !!(store.get('publish') || {}).adbKeyboard;

  // 1) 推图 + 触发媒体扫描（不推图，得物相册里根本看不到）
  const images = (item.files || []).filter(f => f.type === 'image');
  if (!images.length) throw new Error('该条没有图片可推');
  const remoteDir = '/sdcard/DCIM/Camera';
  for (const f of images) {
    const abs = path.join(item.absDir || item.dir, f.name);
    const remote = `${remoteDir}/${String(f.name).replace(/[^\w.\-+]/g, '_')}`;
    const r = await adb.push(serial, abs, remote);
    if (!r.ok) throw new Error(`推图失败 ${f.name}：${(r.stderr || '').trim()}`);
    await adb.mediaScan(serial, remote);
  }
  log(`${row.dir}：已推 ${images.length} 张图并触发媒体扫描`, 'info');

  // 2) 按 UI 定位表走真实界面
  const data = {
    title: (copyRow && copyRow.title) || '',
    body: (copyRow && copyRow.body) || '',
    sku: item.sku || '', color: item.color || ''
  };
  (copyRow && copyRow.topics || []).forEach((t, i) => { data['topic' + (i + 1)] = t; });

  for (const raw of map.steps) {
    if (cancelled()) throw new Error('已取消');
    const step = uimap.fill(raw, data);
    row.status = step.name;
    if (ctx.onRow) ctx.onRow(row);
    await runStep(serial, step, data, ctx, adbKeyboard);
  }
  return true;
}

/* ---------------- 模拟通道 ---------------- */

async function runMock(row, ctx) {
  const c = cfg();
  const cancelled = ctx.cancelled || (() => false);
  for (const st of STEPS) {
    if (cancelled()) return 'cancelled';
    row.status = st;
    if (ctx.onRow) ctx.onRow(row);
    await sleep(c.mock ? 400 : 2500, cancelled);
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
    throw new Error('真实通道需要先配 UI 定位表：在「模拟器发布」点「抓取页面结构」，改好后导入 uiMap.json');
  }

  const rows = (state.publish && state.publish.rows && state.publish.rows.length)
    ? state.publish.rows
    : sheet.buildRows(state, { intervalSec: c.mock ? (c.mockIntervalSec || 5) : (c.intervalMinSec || 60) })
      .map((r, i) => ({ seq: i + 1, id: state.items[i] ? state.items[i].id : String(i + 1), dir: r[1], goods: 1, images: 0, startAt: '', status: '排队', result: '', retries: 0, reason: '' }));
  // 批次名跟着日志走：「重导出日志」要能按批次导出（真机日志行里也带批次）
  const batch = (state.publish && state.publish.batch) || `批${wp.stamp()}`;
  const tAll = Date.now();   // 批量总耗时（真机日志：批量发布完成，总耗时 86.6s）

  const todo = rows.filter(r => r.result !== '发布成功');
  const est = estimate(todo.length);
  log(`开始发布（${mode === 'adb' ? '真实设备通道' : '模拟通道'}）：${todo.length} 条，预计 ${est.minutes} 分钟`, mode === 'adb' ? 'ok' : 'warn');
  if (mode === 'mock') log('模拟通道不接触设备，只演练节奏/重试/回写；要真发请先「连接模拟器」并通过驱动自检', 'warn');
  log('发布期间不占用发布单文件，结果先写 publish-log.jsonl', 'info');

  const copyById = new Map((state.copyRows || []).map(r => [r.id, r]));
  let done = 0;
  const results = [];

  for (const row of todo) {
    if (cancelled()) break;
    const item = state.items.find(it => it.id === row.id) || {};
    row.images = (item.files || []).filter(f => f.type === 'image').length || 0;
    row.goods = row.goods || 1;

    const blocked = (state.verify.rows || []).find(v => v.id === row.id);
    if (blocked && blocked.pass === false) {
      row.status = '未发布'; row.result = '校验未通过'; row.reason = blocked.note || blocked.conclusion;
      onRow(row); results.push(row); done++;
      progress({ done, total: todo.length, label: row.dir });
      continue;
    }

    if (done > 0) {
      // 真机是固定间隔（默认 60 秒），带倒计时
      const wait = c.mock ? (c.mockIntervalSec || 5) : (c.intervalSec || c.intervalMinSec || 60);
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

    row.elapsed = +((Date.now() - t0) / 1000).toFixed(1);
    if (success) log(`行 ${row.seq}[图文] 发布完成，已回填时间 ${row.startAt}（耗时 ${row.elapsed}s）`, 'ok');
    else log(`行 ${row.seq} 发布失败：${row.reason}（耗时 ${row.elapsed}s）`, 'warn');

    sheet.appendLog({ batch, seq: row.seq, id: row.id, dir: row.dir, at: row.startAt, result: row.result, reason: row.reason, retries: row.retries, elapsed: row.elapsed, mode });
    results.push({ batch, seq: row.seq, at: row.startAt, result: row.result, reason: row.reason, retries: row.retries, elapsed: row.elapsed, audit: row.result === '发布成功' ? '审核中' : '' });
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
  connect, run, estimate, saveShot, recover,
  probes: adb.probe, probe: adb.probe, dump: adb.dump,
  devices, listDevices, addDevice, removeDevice
};
