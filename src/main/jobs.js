'use strict';
/** 任务编排：统一进度 / 日志 / 取消 / 任务栏进度 / 完成通知 */
const { BrowserWindow, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const logbus = require('./logbus');
const project = require('./project');
const store = require('./store');
const flatten = require('./services/flatten');
const compliance = require('./services/compliance');
const copywriter = require('./services/copywriter');
const verify = require('./services/verify');
const sheet = require('./services/sheet');
const publisher = require('./services/publisher');
const pool = require('./services/pool');
const wp = require('./util/winpath');

/**
 * 任务实例化：每个 job 有自己的 id / token(取消) / 进度 / 日志标签，
 * 「运行中的批次」可以同时存在多个（真机：7月第六批 与 种草0625 同时「处理中」）。
 *
 * running: id -> job{ id, type, label, batch, token, progress, startedAt }
 * byType:  type -> Set<id>   （同一时间能不能再起一个由 PARALLEL_TYPES 决定）
 */
const running = new Map();
const byType = new Map();

/** 可并行的任务：批次级（一个批次一个实例，互不覆盖） */
const PARALLEL_TYPES = new Set(['copy.generate']);

/** 任务类型 → 界面上给人的名字 */
const TYPE_LABEL = {
  'flatten.plan': '素材整理 · 生成清单', 'flatten.run': '素材整理',
  'compliance.scan': '合规检查', 'compliance.scanParent': '合规检查 · 父目录',
  'compliance.fix': '合规处理', 'compliance.exportReport': '导出合规报告',
  'copy.generate': 'AI 文案生成',
  'verify.check': '好物货号颜色预检',
  'sheet.export': '导出发布单', 'publish.run': '自动发布', 'publish.rerun': '发布重跑',
  'publish.exportLog': '重导出日志', 'publish.setRecover': '编辑失败恢复动作', 'pool.import': '导入商品池'
};

/** 批次级产物目录：每个批次一个文件夹，互不覆盖 */
function batchDir(batchId) { return path.join(store.get('paths.output'), 'batches', String(batchId).replace(/[<>:"|?*\\/]/g, '_')); }

function typeIds(type) { return byType.get(type) || new Set(); }

function send(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    w.webContents.send(channel, payload);
  }
}

function taskbar(v) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setProgressBar(v);
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) { /* 通知不可用不影响主流程 */ }
}

async function dispatch(type, args, ctx) {
  const st = () => project.get();
  switch (type) {
    case 'flatten.plan': {
      const dir = args.sourceDir || st().sourceDir || store.get('paths.source');
      const plan = await flatten.plan(dir, ctx);
      logbus.info(`待整理清单：${plan.total} 个叶子目录 · ${plan.fileTotal} 个文件`);
      return plan;
    }
    case 'flatten.run': {
      const dir = args.sourceDir || st().sourceDir || store.get('paths.source');
      const res = await flatten.run(dir, store.get('flatten'), ctx);
      if (!res.ok) throw new Error(res.message);
      project.patch({ sourceDir: dir, flatDir: res.flatDir, items: res.items, verify: { rows: [], checkedAt: 0 }, copyRows: [], sheet: { file: '', rowCount: res.items.length, colCount: 26, locked: false, exportedAt: 0 } });
      return res;
    }
    case 'compliance.scan': {
      if (!st().items.length) throw new Error('请先做素材整理');
      const { rows, stats } = await compliance.scan(st().items, ctx);
      project.patch({ compliance: { rows, stats, scannedAt: Date.now() } });
      return { rows, stats };
    }
    case 'compliance.scanParent': {
      const dir = args.dir || st().sourceDir || store.get('paths.source');
      const r = await compliance.scanParent(dir, ctx);
      project.patch({ compliance: { rows: r.rows, stats: r.stats, groups: r.groups, scannedAt: Date.now() } });
      return { groups: r.groups.map(g => ({ name: g.name, stats: g.stats })), stats: r.stats };
    }
    case 'compliance.fix': {
      const s = st();
      const r = await compliance.fix(s.items, s.compliance.rows, ctx);
      project.patch({ compliance: { rows: r.rows, stats: s.compliance.stats, scannedAt: s.compliance.scannedAt } });
      return r;
    }
    case 'copy.generate': {
      // 批次级：真机是「选择素材目录并启动任务」，多个批次可以同时「处理中」。
      // 每个批次自带素材清单，产物写进「输出目录/batches/<批次>/copy.json」，
      // 不去动当前项目的单例状态（否则两个批次会互相覆盖）。
      if (args.sourceDir) {
        const dir = args.sourceDir;
        const batchId = args.batchId || (path.basename(dir) + '_' + wp.stamp());
        const plan = await flatten.plan(dir, ctx);
        if (ctx.cancelled()) throw new Error(`批次「${batchId}」已被取消`);
        if (!plan.total) throw new Error(`这个目录里没有找到素材叶子目录：${dir}`);
        const items = plan.rows.map(r => ({
          id: r.name, dir: r.name, absDir: r.from, sku: r.sku, color: r.color, seq: r.seq,
          files: r.files.map(f => ({ name: f, size: 0, type: wp.isVideo(f) ? 'video' : (wp.isJunk(f, false) ? 'junk' : 'image') }))
        }));
        logbus.info(`[${batchId}] 批次素材：${items.length} 个叶子目录（${dir}）`, { batch: batchId });
        const r = await copywriter.generate(items, ctx);
        const out = batchDir(batchId);
        await wp.mkdirp(out);
        const file = path.join(out, 'copy.json');
        await fs.promises.writeFile(wp.toLong(file), JSON.stringify({
          batchId, sourceDir: dir, createdAt: Date.now(), count: r.rows.length,
          warning: r.warning || '', llm: r.llm || null,
          items: items.map(i => ({ id: i.id, dir: i.dir, sku: i.sku, color: i.color, files: i.files.length })),
          rows: r.rows
        }, null, 2), 'utf8');
        logbus.ok(`[${batchId}] 批次完成：${r.rows.length} 篇 → ${wp.toDisplay(file)}`, { batch: batchId });
        return { batchId, count: r.rows.length, file, warning: r.warning, llm: r.llm };
      }
      if (!st().items.length) throw new Error('请先做素材整理');
      const r = await copywriter.generate(st().items, ctx);
      project.patch({ copyRows: r.rows });
      return { count: r.rows.length, warning: r.warning, llm: r.llm };
    }
    case 'compliance.exportReport': {
      const c = st().compliance || {};
      if (!(c.rows || []).length) throw new Error('没有合规报告：先做一次「开始检查」或「检查父目录」');
      return await compliance.exportReport(
        { rows: c.rows, stats: c.stats, groups: c.groups },
        { log: ctx.log, dir: args.dir || store.get('paths.output'), format: args.format }
      );
    }
    case 'verify.check': {
      if (!st().items.length) throw new Error('请先做素材整理');
      const r = await verify.check(st().items, ctx);
      project.patch({ verify: { rows: r.rows, stats: r.stats, checkedAt: Date.now() } });
      return r;
    }
    case 'sheet.export': {
      const s = st();
      if (!s.items.length) throw new Error('没有可导出的素材');
      const pc = store.get('publish') || {};
      const intervalSec = pc.mock ? (pc.mockIntervalSec || 5) : (pc.intervalMinSec || 60);
      const r = await sheet.exportSheet(s, Object.assign({ intervalSec }, args || {}));
      const pubRows = r.rows.map((row, i) => ({
        seq: i + 1, id: s.items[i] ? s.items[i].id : String(i + 1), dir: row[1],
        goods: row[11] ? (row[13] ? 2 : 1) : 1,
        images: 0, startAt: '', status: '排队',
        expect: row[17], title: row[4], goods1: row[11] ? (row[11] + (row[12] ? ' / ' + row[12] : '')) : '',
        result: row[20] === '校验未通过' ? '校验未通过' : '',
        retries: 0, reason: row[21] || ''
      }));
      project.patch({ sheet: { file: r.file, rowCount: r.rowCount, colCount: r.colCount, locked: false, exportedAt: Date.now() }, publish: Object.assign({}, s.publish, { rows: pubRows, batch: path.basename(r.file, '.xlsx') }) });
      return r;
    }
    case 'publish.connect': {
      const r = await publisher.connect(args.device);
      project.patch({
        publish: Object.assign({}, st().publish, {
          connected: r.connected, mode: r.mode, device: r.device, probe: r.probe, hasMap: r.hasMap
        })
      });
      logbus.info(r.note);
      return r;
    }
    case 'publish.devices': {
      return { devices: await publisher.listDevices(), selected: store.get('publish.device') || '' };
    }
    case 'publish.addDevice': {
      const d = publisher.addDevice({ name: args.name, serial: args.serial });
      logbus.ok(`已添加设备：${d.name}（${d.serial}）`);
      return d;
    }
    case 'publish.removeDevice': {
      const list = publisher.removeDevice(args.id);
      logbus.info('已删除设备，剩余 ' + list.length + ' 台');
      return { devices: list };
    }
    case 'publish.probe': {
      const r = await publisher.probe(args.device || (st().publish && st().publish.device) || store.get('publish.device'));
      return r;
    }
    case 'publish.dump': {
      const serial = args.device || (st().publish && st().publish.device) || store.get('publish.device');
      const xml = await publisher.dump(serial);
      if (!xml) throw new Error('uiautomator dump 失败：确认设备在线且没锁屏');
      const nodes = require('./services/uimap').parseNodes(xml);
      const map = require('./services/uimap').suggest(nodes);
      const outDir = path.join(store.get('paths.output'), 'dumps');
      await wp.mkdirp(outDir);
      const tag = wp.stamp();
      const xmlFile = path.join(outDir, `ui-dump-${tag}.xml`);
      const mapFile = path.join(outDir, `uiMap-${tag}.json`);
      await fs.promises.writeFile(wp.toLong(xmlFile), xml, 'utf8');
      await fs.promises.writeFile(wp.toLong(mapFile), JSON.stringify(map, null, 2), 'utf8');
      logbus.ok(`已抓取 ${nodes.length} 个节点 → ${path.basename(xmlFile)}`);
      logbus.warn(`已生成候选定位表 ${path.basename(mapFile)}：它是按关键词猜的，改对后再导入`);
      return { xmlFile, mapFile, nodeCount: nodes.length, preview: nodes.filter(n => n.text).slice(0, 12).map(n => n.text) };
    }
    case 'publish.importMap': {
      const raw = await fs.promises.readFile(wp.toLong(args.file), 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!j.steps || !j.steps.length) throw new Error('文件里没有 steps 数组');
      store.set({ publish: { uiMap: j } });
      logbus.ok(`UI 定位表已导入：${j.steps.length} 步（来自 ${path.basename(args.file)}）`);
      return { steps: j.steps.length, file: args.file };
    }
    case 'publish.setRecover': {
      // 失败恢复动作可编辑（真机每个账号/版本不同：「回退转发页」「删除卡片」…）
      const um = require('./services/uimap');
      const steps = um.normalizeRecover(args.steps);   // 不认识的动作直接报错，不静默吞掉
      const cur = store.get('publish.uiMap') || {};
      store.set({ publish: { uiMap: Object.assign({}, cur, { recover: steps }) } });
      logbus.ok(steps.length
        ? `失败恢复动作已保存：${steps.length} 步（${steps.map(s => s.action).join(' → ')}）`
        : '失败恢复动作已清空：失败后只按返回键回退');
      return { recover: steps };
    }
    case 'publish.run': {
      const s = st();
      if (!s.publish.rows || !s.publish.rows.length) throw new Error('请先导出发布单');
      // 批次名默认取发布单文件名（真机：选 AI内容报告_xxx.xlsx → 开始批次）
      const batch = args.batchId || s.publish.batch || (s.sheet.file ? path.basename(s.sheet.file, path.extname(s.sheet.file)) : '') || ('批' + wp.stamp());
      const r = await publisher.run(Object.assign({}, s, { publish: Object.assign({}, s.publish, { batch }) }), Object.assign({}, ctx, {
        onRow: row => send('publish:row', row)
      }));
      project.patch({ publish: Object.assign({}, s.publish, { rows: r.rows, batch: r.batch, running: false }) });
      if (s.sheet.file) {
        const m = await sheet.mergeResults(s.sheet.file, r.results);
        if (m.busy) {
          logbus.warn(`Excel 仍被占用，${m.pending} 条结果已暂存，下次再试（可只读打开但不建议编辑保存）`);
        } else {
          logbus.ok(`已合并回写发布单：${m.updated} 行${m.flushed ? `（含补写上次的 ${m.flushed} 条）` : ''}`);
        }
      }
      notify('发布批次结束', `成功 ${r.okCount} / ${r.total} 条，记得回查审核状态`);
      return { okCount: r.okCount, total: r.total, failCount: r.failCount, batch: r.batch };
    }
    case 'publish.exportLog': {
      // 「重导出日志」：按批次把 publish-log.jsonl 导成可读的 .log + .csv
      return await sheet.exportPublishLog({ batch: args.batch, dir: args.dir });
    }
    case 'publish.rerun': {
      const s = st();
      const row = (s.publish.rows || []).find(r => String(r.seq) === String(args.seq));
      if (!row) throw new Error('找不到该行');
      row.result = ''; row.retries = 0; row.reason = '';
      const subset = Object.assign({}, s, { publish: Object.assign({}, s.publish, { rows: [row] }) });
      const r = await publisher.run(subset, Object.assign({}, ctx, { onRow: rw => send('publish:row', rw) }));
      project.patch({ publish: Object.assign({}, s.publish, { rows: s.publish.rows }) });
      if (s.sheet.file) await sheet.mergeResults(s.sheet.file, r.results);
      return { okCount: r.okCount, total: 1 };
    }
    case 'pool.import': {
      const r = pool.importFile(args.file);
      logbus.ok(`商品池已导入：${Object.keys(r.skus).length} 个货号（来源 ${r.source}）`);
      return { count: Object.keys(r.skus).length, source: r.source };
    }
    case 'project.reset': {
      project.reset();
      return { ok: true };
    }
    default:
      throw new Error('未知任务：' + type);
  }
}

async function run(type, args = {}) {
  const parallel = PARALLEL_TYPES.has(type);
  const ids = typeIds(type);
  // 起不来就直接回 {ok:false}（不抛异常）：渲染层拿得到原因能弹提示，不会变成未捕获的 Promise 报错
  if (parallel) {
    // 批次级任务：同一个批次不允许重复起，不同批次可以同时跑
    const dup = args.batchId && [...ids].some(id => running.get(id) && running.get(id).batch === args.batchId);
    if (dup) return { ok: false, error: `批次「${args.batchId}」正在处理中，先等它跑完或取消掉` };
  } else if (ids.size) {
    return { ok: false, error: '该任务正在运行中' };
  }

  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const label = args.label || args.batchId || TYPE_LABEL[type] || type;
  const job = { id, type, label, batch: args.batchId || '', token: { cancel: false }, progress: null, startedAt: Date.now() };
  running.set(id, job);
  if (!byType.has(type)) byType.set(type, new Set());
  byType.get(type).add(id);

  const ctx = {
    jobId: id,
    batch: job.batch,
    cancelled: () => job.token.cancel,
    log: (msg, level) => {
      const fn = { ok: logbus.ok, warn: logbus.warn, error: logbus.error }[level] || logbus.info;
      // 日志带上批次，界面「查看详情」能按批次把这一步的日志筛出来
      fn(`[${label}] ${msg}`, { jobId: id, batch: job.batch, label, type });
    },
    progress: p => {
      job.progress = Object.assign({ done: 0, total: 0 }, p);
      send('job:progress', Object.assign({ id, type, label, batch: job.batch }, p));
      if (p && p.total) taskbar(Math.min(1, (p.done || 0) / p.total));
    }
  };

  send('job:started', { id, type, label, batch: job.batch, startedAt: job.startedAt });
  try {
    const res = await dispatch(type, args, ctx);
    send('job:done', { id, type, label, batch: job.batch, ok: true, busy: false, elapsedSec: +((Date.now() - job.startedAt) / 1000).toFixed(1) });
    if (!running.size) taskbar(-1);
    return { ok: true, result: res, jobId: id, batch: job.batch };
  } catch (e) {
    // 被取消的任务统一报「任务已取消」：否则各步骤自己的报错（如「没找到叶子目录」）会误导人
    const msg = job.token.cancel ? '任务已取消' : e.message;
    if (job.token.cancel) logbus.warn(`[${label}] 任务已取消`, { jobId: id, batch: job.batch, label, type });
    else logbus.error(`[${label}] ${type} 失败：${e.message}`, { jobId: id, batch: job.batch, label, type });
    send('job:done', { id, type, label, batch: job.batch, ok: false, cancelled: job.token.cancel, error: msg, elapsedSec: +((Date.now() - job.startedAt) / 1000).toFixed(1) });
    if (!running.size) taskbar(-1);
    return { ok: false, error: msg, cancelled: job.token.cancel, jobId: id, batch: job.batch };
  } finally {
    running.delete(id);
    const s = byType.get(type);
    if (s) { s.delete(id); if (!s.size) byType.delete(type); }
    if (!running.size) taskbar(-1);
  }
}

/** 取消：传 job id 停单个（界面「取消任务」），传任务类型停该类型全部（界面「全部取消」） */
function cancel(ref) {
  if (!ref) return 0;
  const hit = [];
  if (running.has(ref)) hit.push(running.get(ref));
  else for (const id of typeIds(ref)) { const j = running.get(id); if (j) hit.push(j); }
  for (const j of hit) {
    j.token.cancel = true;
    // 带 meta：界面「查看详情」按批次筛日志时，这条停止记录也在
    logbus.warn(`[${j.label}] 已请求停止（在当前步骤后停下）`, { jobId: j.id, batch: j.batch, label: j.label, type: j.type });
  }
  return hit.length;
}

/** busy(type) → 该类型是否在跑；busy() 不传参 → 运行中的任务清单（界面启动时对齐状态用） */
function busy(type) {
  if (type) return typeIds(type).size > 0;
  return list();
}

/** 运行中的任务清单（「运行中的批次」） */
function list() {
  const now = Date.now();
  return [...running.values()].map(j => ({
    id: j.id, type: j.type, label: j.label, batch: j.batch,
    startedAt: j.startedAt, elapsedSec: +((now - j.startedAt) / 1000).toFixed(1),
    progress: j.progress
  }));
}

module.exports = { run, cancel, busy, list, TYPE_LABEL };
