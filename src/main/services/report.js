'use strict';
/**
 * 「AI 内容报告」导入 —— 真机流水线的中间产物（上游文案生成产出，下游颜色预检 / 自动发布消费）
 *
 * 表头按列名匹配（不认列位置），所以他们的报告和我们自己导出的发布单都能吃：
 *   期待发布时间 / 实际执行时间 / 执行结果 / 素材来源 / 素材路径 / 标题 / 文案 / 内容类型
 *   好物1_货号 好物1_颜色 … 好物9_货号 好物9_颜色
 *
 * 规则（与第一步素材整理的口径一致）：
 *   1. 一个「叶子文件夹」= 一条发布（叶子 = 有图片/视频、且子目录里没有媒体的那个目录）
 *   2. 「素材路径」是绝对路径，指向批次目录或扁平后的目录都行；指向父级时按叶子展开
 *   3. 报告行 ↔ 叶子：按顺序一一对应（叶子目录名自然排序，_2 排在 _10 前）；
 *      数量不一致直接报错并列出多/少哪些 —— 绝不猜着配
 *   4. 标题 / 文案：报告里有就用，空的交给 copywriter 生成
 *   5. 好物最多 9 个；颜色可空（单色货号）
 *   6. 含视频的叶子：真实通道目前只推图片 → 明确标成「校验未通过：含视频」并跳过，不静默丢
 *   7. 回写：实际执行时间(B) / 执行结果(C)；被 WPS 占用时整批暂存，下次先补写
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const wp = require('../util/winpath');
const store = require('../store');
const logbus = require('../logbus');

/* ---------------- 表头匹配 ---------------- */

/** 去掉空格/下划线/全角括号之类的干扰，让「好物1_货号」和「好物1货号」都能认出来 */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000_]/g, '')
    .replace(/[（(]/g, '').replace(/[）)]/g, '')
    .replace(/：/g, ':')
    .trim();
}

const FIELDS = {
  expect: ['期待发布时间'],
  at: ['实际执行时间'],
  result: ['执行结果'],
  source: ['素材来源'],
  dir: ['素材路径'],
  title: ['标题'],
  body: ['文案', '正文'],
  contentType: ['内容类型']
};

/** 表头 → 列号映射；同时解析出「好物N_货号 / 好物N_颜色」 */
function mapHeader(row) {
  const map = {};
  const goods = {};
  for (let c = 1; c <= (row.cellCount || 0); c++) {
    const key = norm(cellText(row.getCell(c)));
    if (!key) continue;
    for (const [field, names] of Object.entries(FIELDS)) {
      if (map[field] == null && names.some(n => key === norm(n))) map[field] = c;
    }
    const g = key.match(/^好物(\d+)(货号|颜色|sku|color)$/i);
    if (g) {
      const n = Number(g[1]);
      goods[n] = goods[n] || {};
      if (/货号|sku/i.test(g[2])) goods[n].sku = c; else goods[n].color = c;
    }
  }
  return { map, goods };
}

/** 既能吃 ExcelJS 的单元格对象，也能吃裸值（表头列名列表那里会直接传字符串） */
function cellText(cell) {
  const v = (cell && typeof cell === 'object' && !(cell instanceof Date) && 'value' in cell) ? cell.value : cell;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return String(v.result).trim();
    if (v.richText) return v.richText.map(t => t.text).join('').trim();
    return '';
  }
  return String(v).trim();
}

/* ---------------- 读报告 ---------------- */

/**
 * 读报告 → { sheetName, file, rows, problems }
 * rows: [{ rowNo, seq, expect, result, source, dir, title, body, contentType, goods: [{sku,color}] }]
 * rowNo 是 Excel 真实行号，回写时按它定位（不靠推算）
 */
async function readReport(file) {
  if (!file) throw new Error('没有指定报告文件');
  if (!(await wp.statSafe(file))) throw new Error(`报告文件不存在：${file}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(wp.toLong(file));

  // 优先找名字里有「报告」的表，否则取第一个
  const ws = wb.worksheets.find(w => /报告/.test(w.name)) || wb.worksheets[0];
  if (!ws) throw new Error('这个 xlsx 里没有工作表');

  const { map, goods } = mapHeader(ws.getRow(1));
  if (map.dir == null) {
    const heads = (ws.getRow(1).values || []).slice(1).map(cellText).filter(Boolean);
    throw new Error(`表头里找不到「素材路径」列；读到的是：${heads.slice(0, 12).join(' / ') || '（空表头）'}`);
  }
  if (!Object.keys(goods).length) {
    throw new Error('表头里找不到「好物N_货号」列；按真机口径至少要有好物1_货号');
  }

  const rows = [];
  const problems = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = f => (map[f] == null ? '' : cellText(row.getCell(map[f])));
    const list = [];
    for (const n of Object.keys(goods).map(Number).sort((a, b) => a - b)) {
      const sku = goods[n].sku ? cellText(row.getCell(goods[n].sku)) : '';
      const color = goods[n].color ? cellText(row.getCell(goods[n].color)) : '';
      if (sku) list.push({ no: n, sku, color });
    }
    const dir = get('dir');
    if (!dir && !list.length) continue;              // 整行空，跳过
    // 素材路径可能是空的（真机那份样本 49 行全空）→ 不在这里丢掉，
    // 交给 build()：没有路径时可以用「导入时选的批次目录」补上
    rows.push({
      rowNo: r,
      seq: rows.length + 1,
      expect: get('expect'),
      at: get('at'),
      result: get('result'),
      source: get('source'),
      dir,
      title: get('title'),
      body: get('body'),
      contentType: get('contentType'),
      goods: list
    });
  }
  if (!rows.length) throw new Error('报告里没有可读的数据行：每行至少要有「素材路径」或一个好物货号');
  return { file, sheetName: ws.name, rows, problems, hasDir: rows.some(r => r.dir) };
}

/* ---------------- 素材路径 → 叶子文件夹 ---------------- */

/** 目录名自然排序：_2 排在 _10 之前（字符串排序会把 10 排到 2 前面） */
function naturalCompare(a, b) {
  const sa = String(a).split(/(\d+)/);
  const sb = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i], y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 把报告里的路径还原成绝对路径：绝对路径直接用，相对路径接在素材根目录后面 */
function toAbs(p) {
  const s = wp.toDisplay(String(p).trim());
  if (!s) return '';
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/')) return s;
  const root = store.get('paths.source') || '';
  return root ? path.join(root, s) : s;
}

/**
 * 展开一个路径下的叶子文件夹（复用素材整理的判定：有媒体、且子目录里没有媒体）
 * 返回 [{ absDir, name, files }]，按目录名自然排序
 */
async function leavesOf(absDir) {
  const flatten = require('./flatten');
  const plan = await flatten.plan(absDir, { cancelled: () => false });
  return plan.rows
    .map(r => {
      const files = r.files.map(f => ({ name: f, type: wp.isVideo(f) ? 'video' : (wp.isJunk(f, false) ? 'junk' : 'image') }));
      return {
        absDir: r.from,
        name: path.basename(r.from) || r.name,
        rel: r.name,
        files: files.filter(f => f.type !== 'junk'),
        sku: r.sku,
        color: r.color
      };
    })
    .sort((a, b) => naturalCompare(a.name, b.name));
}

/* ---------------- 报告 + 素材 → 发布所需的三份数据 ---------------- */

/**
 * 组装 items / copyRows / publishRows
 * opts: { generateCopy: async (items) => [{id,title,body,topics}], batch }
 * 返回 { items, copyRows, publishRows, pairs, blocked, notes }
 */
async function build(report, opts = {}) {
  const notes = [];
  const problems = (report.problems || []).slice();
  const pairs = [];
  const needGen = [];

  // 按「素材路径」分组：同一个路径下的叶子只展开一次，避免多行引用同一目录时重复计数。
  // 真机的用法是一份报告的所有数据行都指向同一个批次目录（由第一步整理保证「一条内容 = 一个叶子」）。
  // 报告里没有素材路径时（真机那份样本就是），用 opts.dir —— 也就是「导入时选的这一批素材目录」。
  const groups = new Map();
  for (const row of report.rows) {
    const raw = row.dir || opts.dir || '';
    if (!raw) {
      problems.push({ rowNo: row.rowNo, why: '缺「素材路径」，也没有指定这一批的素材目录' });
      continue;
    }
    const abs = toAbs(raw);
    if (!groups.has(abs)) groups.set(abs, []);
    groups.get(abs).push(row);
  }

  for (const [abs, rows] of groups) {
    const st = await wp.statSafe(abs);
    if (!st || !st.isDirectory()) {
      rows.forEach(r => problems.push({ rowNo: r.rowNo, why: `素材路径不存在或不是文件夹：${abs}` }));
      continue;
    }
    const leaves = await leavesOf(abs);
    if (!leaves.length) {
      rows.forEach(r => problems.push({ rowNo: r.rowNo, why: `这个路径下没有找到含图片/视频的叶子文件夹：${abs}` }));
      continue;
    }
    // 行 ↔ 叶子必须一一对应，数量不等就说清「这个路径下有几个叶子、报告里有几行指向它」，绝不猜着配
    if (leaves.length !== rows.length) {
      const names = leaves.slice(0, 6).map(l => l.name).join('、') + (leaves.length > 6 ? '…' : '');
      throw new Error(
        `「${abs}」下有 ${leaves.length} 个叶子文件夹（${names}），但报告里有 ${rows.length} 行指向它，对不上。` +
        '一条内容 = 一个叶子文件夹：请确认报告行数与素材一一对应（或把「素材路径」直接写到叶子目录）'
      );
    }
    rows.forEach((row, i) => pairs.push({ row, leaf: leaves[i], abs }));
  }

  const items = [];
  const copyRows = [];
  const publishRows = [];
  const blocked = [];

  for (const { row, leaf } of pairs) {
    const images = leaf.files.filter(f => f.type === 'image');
    const videos = leaf.files.filter(f => f.type === 'video');
    const id = leaf.rel || leaf.name;
    const goods = row.goods.map(g => ({ sku: g.sku, color: g.color }));

    items.push({
      id, dir: id, absDir: leaf.absDir,
      sku: (goods[0] && goods[0].sku) || leaf.sku || '',
      color: (goods[0] && goods[0].color) || '',
      goods,
      files: leaf.files.map(f => Object.assign({ size: 0 }, f)),
      fileCount: leaf.files.length,
      bytes: 0,
      reportRow: row.rowNo
    });

    // 标题/文案：有就用，空则排队等生成
    if (row.title && row.body) {
      copyRows.push({ id, title: row.title, body: row.body, topics: [], status: '已导入', from: '报告' });
    } else {
      needGen.push(id);
    }

    // 含视频 / 没有图片：明确标出来，交给发布环节按「校验未通过」跳过并说明原因
    const reasons = [];
    if (videos.length) reasons.push(`含 ${videos.length} 个视频，真实通道目前只推图片`);
    if (!images.length) reasons.push('没有可发布的图片');
    if (reasons.length) {
      blocked.push({ id, note: reasons.join('；') });
      notes.push(`「${id}」暂不发布：${reasons.join('；')}`);
    }

    const first = goods[0] || {};
    publishRows.push({
      seq: publishRows.length + 1,
      id,
      dir: id,
      goods: goods.length || 1,
      goodsList: goods,
      images: images.length,
      videos: videos.length,
      startAt: '',
      status: '排队',
      // C 列已经是「发布成功」的行 → 续跑时跳过（真机也是这么做的）
      result: /^发布成功/.test(row.result || '') ? '发布成功' : '',
      retries: 0,
      reason: reasons.join('；') || '',
      expect: row.expect || '',
      title: row.title || '',
      goods1: first.sku ? first.sku + (first.color ? ' / ' + first.color : '') : '',
      contentType: row.contentType || '',
      source: row.source || '',
      reportRow: row.rowNo
    });
  }

  // 空的标题/文案 → 交给 copywriter（只对需要生成的那些跑）
  if (needGen.length && typeof opts.generateCopy === 'function') {
    const sub = items.filter(i => needGen.includes(i.id));
    const made = await opts.generateCopy(sub) || [];
    for (const r of made) {
      copyRows.push(Object.assign({ topics: [], status: '已生成', from: '本地生成' }, r));
    }
    notes.push(`报告里 ${needGen.length} 条没有标题/文案，已由本地模板生成`);
  }

  return { items, copyRows, publishRows, pairs, blocked, problems, notes };
}

/* ---------------- 回写：实际执行时间 / 执行结果 ---------------- */

function resultText(r) {
  if (r.result === '发布成功') return '发布成功';
  return r.reason ? `${r.result}：${r.reason}` : (r.result || '');
}

/** 把结果写回报告（B=实际执行时间，C=执行结果）；被占用时整批暂存 */
async function mergeResults(file, results, meta = {}) {
  const sheet = require('./sheet');
  const backlog = sheet.takePending('report').filter(e => !e.file || e.file === file);
  // 只有「从报告导进来」的行才知道自己在报告里的行号；别的批次的结果不往报告里写
  const incoming = (results || []).filter(r => r && r.reportRow).map(r => Object.assign({ target: 'report', file }, r));
  const skipped = (results || []).length - incoming.length;
  const all = backlog.concat(incoming);
  if (!file || !all.length) return { updated: 0, pending: all.length, skipped };

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(wp.toLong(file));
    const ws = wb.getWorksheet(meta.sheetName) || wb.worksheets.find(w => /报告/.test(w.name)) || wb.worksheets[0];
    const { map } = mapHeader(ws.getRow(1));
    if (map.dir == null || map.at == null || map.result == null) {
      throw new Error('报告表头缺少「素材路径 / 实际执行时间 / 执行结果」列，无法回写');
    }
    // 按「素材路径 + 货号」对行不靠谱（可能重复），改成按导入时记下的 Excel 行号定位
    let updated = 0;
    for (const r of all) {
      const rowNo = Number(r.reportRow || 0);
      if (!rowNo) continue;
      const row = ws.getRow(rowNo);
      if (map.at) row.getCell(map.at).value = r.at || '';
      if (map.result) row.getCell(map.result).value = resultText(r);
      updated++;
    }
    await wb.xlsx.writeFile(wp.toLong(file));
    sheet.putPending('report', []);
    return { updated, pending: 0, flushed: backlog.length, skipped };
  } catch (e) {
    // 只有「文件被别的程序占着」才谈得上「暂存、下次再试」。
    // 表头缺列 / 文件损坏这类逻辑错误重试一万次也不会好，暂存只会让人一直等一个补不进去的队列，
    // 所以原样报出来，并说清是哪里不对 —— 不能拿「报告仍被占用」糊过去。
    if (!wp.isFileLockError(e)) {
      logbus.error(`回写报告失败（${all.length} 条未写入）：${e.message}`);
      return { updated: 0, pending: 0, busy: false, skipped, error: e.message };
    }
    sheet.putPending('report', all);
    logbus.warn(`报告仍被占用，${all.length} 条结果已暂存，下次再试（可只读打开但不建议编辑保存）`);
    return { updated: 0, pending: all.length, busy: true, skipped, error: e.message };
  }
}

/** 报告回写的待办条数（界面/日志用） */
function pendingCount() {
  const sheet = require('./sheet');
  return sheet.takePending('report').length;
}

module.exports = {
  readReport, build, mergeResults, leavesOf, naturalCompare, toAbs, norm, pendingCount,
  FIELDS
};
