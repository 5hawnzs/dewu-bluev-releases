'use strict';
/**
 * ⑦ AI 内容报告（带时间戳）—— 「文案生成」跑完**立刻**落一份 xlsx
 *
 * ★ 为什么要有它（用户 2026-10-02 明确要求）：
 *   「点击文案生成后，你应该在该文件夹生成一个全新的带时间戳的 ai 报告，
 *     以便后续校验文案、货号、颜色是否一致」。
 *   文案是模型看图写的、一次几十条，没人能逐条盯；要有一份**能直接打开的表格**，
 *   把「这一条文案 ↔ 它对应的货号/颜色 ↔ 自动核对结论 ↔ 图里实取的主色」并排放在一起。
 *
 * ★ 列名对齐上游那份 `KIDS_AI内容报告_2026-08-26T10-41-02.xlsx`（前 8 列 + 好物N_货号/颜色），
 *   所以 —— **这份报告能被本程序自己的 report.readReport 直接反向导入**当发布单用：
 *     生成 → 核对（改报告）→ 导入 → 发布 → 结果回写（B/C 列）。
 *   多出来的「生成来源 / 文案核对 / 图片主色 / 批次 / 生成时间」是**附加列**；
 *   readReport 按列名取值、不认识就忽略，所以加了也不影响反向导入（有断言守着）。
 */
const path = require('path');
const ExcelJS = require('exceljs');
const wp = require('../util/winpath');
const logbus = require('../logbus');
const imaging = require('./imaging');
const copycheck = require('./copycheck');

const MAX_GOODS = 9;

/** 前 8 列与上游报告逐字对齐（列名错一个字，回写报告时就会「表头缺列」） */
const BASE_COLUMNS = ['期待发布时间', '实际执行时间', '执行结果', '素材来源', '素材路径', '标题', '文案', '内容类型'];
const GOODS_COLUMNS = [];
for (let i = 1; i <= MAX_GOODS; i++) GOODS_COLUMNS.push(`好物${i}_货号`, `好物${i}_颜色`);
/** 本程序加的附加列：给「核对」用的，不参与反向导入 */
const EXTRA_COLUMNS = ['生成来源', '文案核对', '图片主色', '批次', '生成时间'];
const COLUMNS = BASE_COLUMNS.concat(GOODS_COLUMNS, EXTRA_COLUMNS);

const SHEET = 'AI 内容报告';

const COLUMN_NOTE = {
  期待发布时间: '你想什么时候发（留空 = 不指定）。这一列归你填',
  实际执行时间: '发布完成后由程序回写',
  执行结果: '发布完成后由程序回写（如「发布成功」/「发布失败，原因找不到发布按钮」）',
  素材来源: '这一批素材是从哪个目录整理出来的',
  素材路径: '这一条对应的叶子文件夹（绝对路径）。★ 反向导入时按它一条条对回去，别改',
  标题: '模型看图写的标题。想改就直接改这一格，改完导入就按你改的用',
  文案: '正文（话题不在正文里，在发布单的「话题1~5」）',
  内容类型: '图文 / 视频',
  好物1_货号: '关联到得物的商品货号（最多 9 个）',
  好物1_颜色: '该货号的颜色。只填货号不填颜色也算行，但多色货号会被拦下',
  生成来源: '这一条是谁写的：AI 看图 / AI 看图（…，视频抽帧）/ AI 文字（没看图）/ 本地模板 / 未生成',
  文案核对: '程序自动核对的结论：「一致」或具体哪里要人看一眼。★ 这是**提示**不是判决，拿不准的会写「需人工确认」',
  图片主色: '从这一条的首张图实取的主色（用来反查颜色填得对不对）',
  批次: '哪一次「文案生成」跑出来的',
  生成时间: '这份报告是什么时候生成的'
};

/** 给界面/日志用的一句话（不含文件名细节） */
function fileNameOf(brandName, when) {
  const brand = String(brandName || '').trim() || '未标品牌';
  // 品牌名里可能有 Windows 非法字符（真机品牌名带过 `/`），先洗一遍，别写不出去
  const safe = brand.replace(/[<>:"|?*\\/]/g, '_');
  return `${safe}_AI内容报告_${wp.stampISO(when || new Date())}.xlsx`;
}

/** 这一条发图文还是视频 */
function kindOf(item, publishRow) {
  if (publishRow && publishRow.kind) return publishRow.kind === 'video' ? '视频' : '图文';
  const files = (item && item.files) || [];
  const imgs = files.filter(f => f && f.type === 'image').length;
  const vids = files.filter(f => f && f.type === 'video').length;
  if (vids && !imgs) return '视频';
  if (imgs) return '图文';
  return '';
}

/**
 * 组装数据行（纯函数，好测）。顺序 = items 的顺序（真机一条内容 = 一个叶子目录）。
 * ★ 以 **items** 为准遍历、再去 copyRows 里找：这样「哪一条没生成出来」也会留下一行，
 *   而不是从表里凭空消失（静默丢行是这类报告最要命的毛病）。
 */
function buildData(opts = {}) {
  const items = opts.items || [];
  const copyById = new Map((opts.rows || []).map(r => [String(r.id), r]));
  const pubById = new Map(((opts.publish && opts.publish.rows) || []).map(r => [String(r.id), r]));
  const goodsById = new Map();
  for (const it of items) {
    const gl = (it.goods || []).filter(g => g && (g.sku || g.color));
    goodsById.set(String(it.id), gl.length ? gl : [{ sku: it.sku || '', color: it.color || '' }]);
  }
  return items.map(it => {
    const id = String(it.id);
    const row = copyById.get(id) || {};
    const pub = pubById.get(id) || {};
    const goods = (goodsById.get(id) || []).slice(0, MAX_GOODS);
    return {
      id,
      expect: pub.expect || '',
      at: '', result: '',
      source: opts.sourceDir ? wp.toDisplay(opts.sourceDir) : '',
      dir: it.absDir || it.dir || '',
      title: row.title || '',
      body: row.body || '',
      kind: kindOf(it, pub),
      goods,
      // 逐行如实标来源：「报告导入 / AI 看图 / AI 文字 / 本地模板 / 未生成」
      genSource: row.genSource || (row.from === '报告' ? '报告导入' : (row.from || '未生成'))
    };
  });
}

/** 一条 → Excel 行（顺序必须与 COLUMNS 一一对应） */
function toRow(rec, meta = {}) {
  const out = [
    rec.expect || '', rec.at || '', rec.result || '',
    rec.source || '', rec.dir || '',
    rec.title || '', rec.body || '', rec.kind || ''
  ];
  for (let i = 0; i < MAX_GOODS; i++) {
    const g = rec.goods[i] || {};
    out.push(g.sku || '', g.color || '');
  }
  const chk = rec.check || { text: '' };
  out.push(
    rec.genSource || '',
    chk.text || '',
    rec.imageColor || '',
    meta.batch || '',
    meta.generatedAt || ''
  );
  return out;
}

/** 取这一条的首张图实取主色（取不到就空，绝不瞎写一个颜色） */
async function imageColorOf(item) {
  const dir = (item && (item.absDir || item.dir)) || '';
  const files = (item && item.files) || [];
  if (!dir) return '';
  for (const f of files.filter(x => x && x.type === 'image' && x.name).slice(0, 2)) {
    try {
      const c = await imaging.dominantColor(path.join(dir, f.name));
      if (c && c.name) return c.name;
    } catch (e) { /* 单张失败继续下一张 */ }
  }
  return '';
}

/**
 * 目标文件已被占用时自动加 -2 / -3 后缀。
 * ★ 为什么必须要：时间戳只到**秒**，同一秒内跑两个批次完全可能（脚本化调用、重跑），
 *   直接写同名文件会把上一份**悄悄覆盖掉** —— 而报告正是「事后核对」的唯一凭据。
 *   同一套做法见 flatten.uniqueDir（同一分钟重跑加后缀）。
 */
async function uniqueFile(file) {
  if (!(await wp.exists(file))) return file;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  for (let i = 2; i <= 50; i++) {
    const t = path.join(dir, `${stem}-${i}${ext}`);
    if (!(await wp.exists(t))) return t;
  }
  return file;
}

/**
 * 写报告。
 * opts: { dir, fallbackDir, batch, brandName, sourceDir, items, rows, publish, gen, now }
 * ★ 落点：`dir`（本批素材文件夹 —— 用户 2026-10-02 拍板），写不进去才退到 fallbackDir，
 *   并**如实把这件事报出来**（不静默换地方，否则用户会以为没生成）。
 */
async function write(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const wanted0 = opts.dir || opts.fallbackDir || '';
  if (!wanted0) throw new Error('不知道报告该写到哪个文件夹（既没给素材目录，也没有输出目录）');
  let dir = wanted0, file = path.join(dir, fileNameOf(opts.brandName, now));
  const items = opts.items || [];

  // 1) 先把数据连同「自动核对结论」一起算好
  const data = buildData(opts);
  for (const rec of data) {
    const item = items.find(x => String(x.id) === rec.id) || {};
    rec.imageColor = await imageColorOf(item);
    const chk = copycheck.check({ title: rec.title, body: rec.body }, {
      goods: rec.goods, imageColor: rec.imageColor
    });
    if (!rec.title && !rec.body) {
      rec.check = { level: 'bad', text: '这一条没有文案（生成失败或没轮到），别直接发', issues: [] };
    } else {
      rec.check = chk;
    }
  }

  // 1b) **批级**核对：相邻两条是不是完完全全一样。
  //   ★ 单条核对（copycheck.check）看不到「上一条」，所以只能在这里补第二趟。
  //   ★★ 口径来自用户 2026-10-03 拍板：只看**相邻两条**、**换了 emoji 就算不同**、跨品牌复用没关系
  //      —— 见 copycheck.checkBatch 的注释。别把这条又做成「整批不许重复」。
  const dupNotes = copycheck.checkBatch(data.map(r => ({ title: r.title, body: r.body })));
  data.forEach((rec, i) => {
    const extra = dupNotes[i] || [];
    if (!extra.length) return;
    const base = (rec.check && Array.isArray(rec.check.issues)) ? rec.check.issues : [];
    const issues = base.concat(extra.map(t => ({ level: 'warn', text: t })));
    rec.check = {
      level: issues.some(x => x.level === 'bad') ? 'bad' : 'warn',
      text: issues.map(x => x.text).join('；'),
      issues
    };
  });

  const meta = {
    batch: opts.batch || '',
    generatedAt: wp.stampISO(now),
    brandName: opts.brandName || '',
    gen: opts.gen || null
  };

  // 2) 落盘
  const wb = new ExcelJS.Workbook();
  wb.creator = '得物蓝V 发布工具';
  const ws = wb.addWorksheet(SHEET);
  ws.columns = COLUMNS.map((h, i) => ({
    header: h,
    key: 'c' + i,
    width: (h === '标题' || h === '文案') ? 34 : (h === '素材路径' || h === '文案核对' ? 30 : (h === '生成来源' ? 24 : 14))
  }));
  const head = ws.getRow(1);
  head.font = { bold: true, size: 11 };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEBE4' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFC9C7BF' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  for (const rec of data) {
    const row = ws.addRow(toRow(rec, meta));
    row.getCell(COLUMNS.indexOf('文案') + 1).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(COLUMNS.indexOf('文案核对') + 1).alignment = { wrapText: true, vertical: 'top' };
    if (rec.check && rec.check.level === 'bad') {
      row.getCell(COLUMNS.indexOf('文案核对') + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCEBEB' } };
    } else if (rec.check && rec.check.level === 'warn') {
      row.getCell(COLUMNS.indexOf('文案核对') + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } };
    }
  }
  // 第二张表：列说明（不叫「报告」两个字，反向导入时不会被当成数据表）
  const ws2 = wb.addWorksheet('列说明');
  ws2.columns = [{ header: '列', key: 'c', width: 22 }, { header: '这一列是什么', key: 'n', width: 90 }];
  ws2.getRow(1).font = { bold: true };
  for (const h of COLUMNS) ws2.addRow([h, COLUMN_NOTE[h] || (h.startsWith('好物')
    ? '关联到得物的商品货号 / 颜色（最多 9 个一组）' : '')]);
  ws2.addRow(['怎么反向导入', '「模拟器发布 → 导入 AI 内容报告」选这份文件即可（列名与上游报告对齐，程序按列名取值）']);
  if (meta.gen) {
    ws2.addRow(['本次生成', `模型 ${meta.gen.modelId || '—'} · ${meta.gen.genSource || '—'} · 接口 ${meta.gen.endpoint || '—'}（${meta.gen.endpointSource || '—'}）`]);
  }

  let fellBack = false, note = '', out = '';
  try {
    await wp.mkdirp(dir);
    out = await uniqueFile(file);
    await wb.xlsx.writeFile(wp.toLong(out));
  } catch (e) {
    if (!opts.fallbackDir || path.resolve(opts.fallbackDir) === path.resolve(dir)) throw e;
    fellBack = true;
    note = `素材文件夹写不进去（${e.code || e.message}），报告已改写到：${wp.toDisplay(opts.fallbackDir)}`;
    dir = opts.fallbackDir;
    await wp.mkdirp(dir);
    out = await uniqueFile(path.join(dir, path.basename(file)));
    await wb.xlsx.writeFile(wp.toLong(out));
  }

  // 3) **自己读一眼**：文件真落盘、行数对得上、且真能被反向导入
  const st = await wp.statSafe(out);
  if (!st || !st.size) throw new Error(`报告写完了却读不到文件：${wp.toDisplay(out)}`);
  const verify = await verifyReimport(out);
  const flagged = data.filter(r => r.check && r.check.level !== 'ok').length;
  if (fellBack) logbus.warn(note);
  if (!verify.ok) logbus.warn(`报告已生成，但自检没通过（${verify.why}）—— 反向导入可能会对不上，先别拿它当发布单`);
  return {
    file: out, rows: data.length, bytes: st.size, flagged,
    byLevel: {
      bad: data.filter(r => r.check && r.check.level === 'bad').length,
      warn: data.filter(r => r.check && r.check.level === 'warn').length
    },
    verify, fellBack, note, sheet: SHEET, brandName: opts.brandName || ''
  };
}

/**
 * 自证：把刚写出来的报告用**下游真正会用的那个读取器**读一遍。
 * ★ 只信「文件存在 + 字节数」是不够的 —— 列名写歪一个字，文件照样在，
 *   但导入时会是「表头缺列」或者**静默少配**。所以这里真读、真读出行数。
 */
async function verifyReimport(file) {
  try {
    const report = require('./report');
    const rep = await report.readReport(file);
    if (!rep.rows.length) return { ok: false, why: '读回来一行都没有' };
    return { ok: true, rows: rep.rows.length, sheet: rep.sheetName, hasDir: !!rep.hasDir };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

module.exports = { write, buildData, toRow, fileNameOf, verifyReimport, uniqueFile, COLUMNS, BASE_COLUMNS, EXTRA_COLUMNS, SHEET, MAX_GOODS };
