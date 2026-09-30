'use strict';
/**
 * ⑤ 发布单
 * PRD 要点：
 *   - 26 列，与前司发布文件结构一致
 *   - 发布过程不占用发布单文件：任务读进内存后立即释放 → 结果追加写 publish-log.jsonl
 *     → 一批结束再一次性合并回写 Excel
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const wp = require('../util/winpath');
const store = require('../store');

const COLUMNS = [
  '序号', '素材路径', '货号', '颜色', '标题', '正文',
  '话题1', '话题2', '话题3', '话题4', '话题5',
  '好物1货号', '好物1颜色', '好物2货号', '好物2颜色', '好物3货号', '好物3颜色',
  '期待发布时间', '实际执行时间', '发布间隔(秒)', '执行结果', '失败原因', '重试次数',
  '审核状态', '笔记链接', '备注'
];

function pad2(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function buildRows(state, { startAt, intervalSec }) {
  const copyById = new Map((state.copyRows || []).map(r => [r.id, r]));
  const verifyById = new Map((state.verify.rows || []).map(r => [r.id, r]));
  const base = startAt ? new Date(startAt) : new Date(Date.now() + 60 * 1000);
  const step = (intervalSec || 90) * 1000;

  return state.items.map((item, i) => {
    const copy = copyById.get(item.id) || {};
    const v = verifyById.get(item.id) || {};
    const topics = copy.topics || [];
    const goods = item.goods || [{ sku: item.sku, color: item.color }];
    const t = new Date(base.getTime() + i * step);
    const blocked = v.pass === false;
    return [
      i + 1,
      item.dir,
      item.sku,
      item.color,
      copy.title || '',
      copy.body || '',
      topics[0] || '', topics[1] || '', topics[2] || '', topics[3] || '', topics[4] || '',
      goods[0] ? goods[0].sku : '', goods[0] ? goods[0].color : '',
      goods[1] ? goods[1].sku : '', goods[1] ? goods[1].color : '',
      goods[2] ? goods[2].sku : '', goods[2] ? goods[2].color : '',
      fmt(t), '', Math.round(step / 1000),
      blocked ? '校验未通过' : '待发布',
      blocked ? (v.note || v.conclusion) : (v.conclusion || ''),
      0, '未提交', '', blocked ? '需人工确认后再交发布' : ''
    ];
  });
}

async function writeWorkbook(file, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '得物蓝V 素材发布工具';
  wb.created = new Date();
  const ws = wb.addWorksheet('发布单', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((h, i) => ({ header: h, key: 'c' + i, width: i === 4 ? 34 : (i === 5 ? 46 : 16) }));
  const head = ws.getRow(1);
  head.font = { bold: true, size: 11 };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEBE4' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFC9C7BF' } } };
  });
  for (const r of rows) {
    const row = ws.addRow(r);
    if (r[20] === '校验未通过') {
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCEBEB' } }; });
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  await wb.xlsx.writeFile(wp.toLong(file));
}

async function exportSheet(state, opts = {}) {
  const outDir = store.get('paths.output');
  await wp.mkdirp(outDir);
  const file = path.join(outDir, `发布单_${wp.stamp()}.xlsx`);
  const rows = buildRows(state, opts);
  await writeWorkbook(file, rows);
  return { file, rowCount: rows.length, colCount: COLUMNS.length, rows };
}

function logFile() { return path.join(store.get('paths.output'), 'publish-log.jsonl'); }

/** 结果追加写 jsonl：发布过程中 Excel 保持未占用 */
function appendLog(entry) {
  try {
    fs.mkdirSync(wp.toLong(path.dirname(logFile())), { recursive: true });
    fs.appendFileSync(wp.toLong(logFile()), JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n', 'utf8');
  } catch (e) { /* 写日志失败不阻断发布 */ }
}

function readLog() {
  try {
    return fs.readFileSync(wp.toLong(logFile()), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function batchOf(e) { return e.batch || '未标批次'; }

/**
 * 「重导出日志」（真机发布页右下角有这颗按钮）：
 * 把 publish-log.jsonl 按批次导出成可读文件 —— .log 文本（对齐真机日志行）+ .csv 表格。
 * opts.batch 指定批次；不传则导出全部（按批次分段）。
 */
async function exportPublishLog(opts = {}) {
  const all = readLog();
  if (!all.length) throw new Error('还没有发布日志：先跑一次发布（结果会写到 publish-log.jsonl）');
  const want = opts.batch || '';
  const batches = [...new Set(all.map(batchOf))];
  if (want && !batches.includes(want)) {
    throw new Error(`日志里没有批次「${want}」；现有批次：${batches.join('、')}`);
  }
  const list = want ? all.filter(e => batchOf(e) === want) : all;
  const outDir = opts.dir || store.get('paths.output');
  if (!outDir) throw new Error('没有配置输出目录：先到「设置 → 路径」里选一个输出目录');
  await wp.mkdirp(outDir);

  const groups = new Map();
  for (const e of list) {
    const k = batchOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const when = d => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const lines = [`# 得物蓝V 发布日志 · 导出时间 ${fmt(new Date())}`];
  const head = ['批次', '序号', '素材目录', '执行结果', '实际执行时间', '耗时(秒)', '重试', '失败原因', '通道', '记录时间'];
  const csv = [head];

  for (const [name, es] of groups) {
    const okN = es.filter(e => e.result === '发布成功').length;
    const failN = es.filter(e => e.result === '失败').length;
    const totalSec = +es.reduce((a, e) => a + (Number(e.elapsed) || 0), 0).toFixed(1);
    lines.push('');
    lines.push(`=== 批次 ${name} · 共 ${es.length} 条 / ${failN} 失败 / ${es.length - okN - failN} 其他 · 总耗时 ${totalSec}s ===`);
    for (const e of es) {
      const mark = e.result === '发布成功' ? 'V' : (e.result === '失败' ? 'X' : '-');
      const time = e.at ? `，已回填时间 ${e.at}` : '';
      const detail = e.result === '发布成功'
        ? `[${mark}] 行 ${e.seq} [图文] 发布完成${time}（耗时 ${e.elapsed == null ? '—' : e.elapsed + 's'}）`
        : `[${mark}] 行 ${e.seq} ${e.result}${e.reason ? '：' + e.reason : ''}（耗时 ${e.elapsed == null ? '—' : e.elapsed + 's'}）`;
      lines.push(detail + (e.retries ? `（重试 ${e.retries} 次）` : ''));
      csv.push([name, e.seq, e.dir || '', e.result || '', e.at || '', e.elapsed == null ? '' : e.elapsed, e.retries || 0, e.reason || '', e.mode || '', e.ts ? when(new Date(e.ts)) : '']);
    }
    lines.push(`（${okN} 成功 / ${failN} 失败）`);
  }

  const cell = v => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const tag = wp.stamp();
  const name = want ? `发布日志_${want}_${tag}` : `发布日志_全部_${tag}`;
  const file = path.join(outDir, name + '.log');
  const csvFile = path.join(outDir, name + '.csv');
  await fs.promises.writeFile(wp.toLong(file), lines.join('\r\n') + '\r\n', 'utf8');
  await fs.promises.writeFile(wp.toLong(csvFile), '\uFEFF' + csv.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');

  return {
    file, csvFile, entries: list.length, batches,
    batch: want || '',
    ok: list.filter(e => e.result === '发布成功').length,
    failed: list.filter(e => e.result === '失败').length
  };
}

/* ---------- 结果暂存队列：真机上 Excel 常被 WPS 打开占用，写不进去就暂存、下次再试 ---------- */
function pendingFile() { return path.join(store.get('paths.output'), 'pending-results.json'); }

function loadPending() {
  try { return JSON.parse(fs.readFileSync(wp.toLong(pendingFile()), 'utf8')); } catch (e) { return []; }
}
function savePending(list) {
  try {
    fs.mkdirSync(wp.toLong(path.dirname(pendingFile())), { recursive: true });
    fs.writeFileSync(wp.toLong(pendingFile()), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}
function pendingCount() { return loadPending().length; }

/** 一批结束后一次性合并回写 Excel；写不进去（被占用）就整批暂存，下次先补写 */
async function mergeResults(file, results) {
  const backlog = loadPending();
  const all = backlog.concat(results || []);
  if (!file || !all.length) return { updated: 0, pending: all.length };

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(wp.toLong(file));
    const ws = wb.getWorksheet('发布单') || wb.worksheets[0];
    const bySeq = new Map(all.map(r => [Number(r.seq), r]));
    let updated = 0;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const r = bySeq.get(Number(row.getCell(1).value));
      if (!r) return;
      row.getCell(19).value = r.at || '';
      row.getCell(21).value = r.result || '';
      row.getCell(22).value = r.reason || '';
      row.getCell(23).value = r.retries || 0;
      row.getCell(24).value = r.result === '发布成功' ? (r.audit || '审核中') : (r.audit || '待回查');
      updated++;
    });
    await wb.xlsx.writeFile(wp.toLong(file));
    savePending([]);
    return { updated, pending: 0, flushed: backlog.length };
  } catch (e) {
    // 真机日志原话：Excel 仍被占用，暂存保留，下次再试（可只读打开但不建议编辑保存）
    savePending(all);
    return { updated: 0, pending: all.length, busy: true, error: e.message };
  }
}

module.exports = {
  COLUMNS, buildRows, exportSheet, appendLog, readLog, mergeResults, fmt, logFile,
  exportPublishLog, pendingCount, loadPending
};
