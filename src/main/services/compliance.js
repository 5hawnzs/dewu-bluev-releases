'use strict';
/**
 * ② 合规检查
 * PRD 要点：
 *   - 判断与处理分离：先全量只读扫描（秒级出报告），再只对有问题的那批动手
 *   - 图片转 JPG ≤10MB / 视频 ≤600s（超长视频只标红不裁剪，裁剪会改变内容）
 *   - 不合规文件隔离到 _rejected，而不是删除
 *   - 硬链接约束：只能写新文件 + 删旧链接，绝不就地改（就地改会把原图一起改掉）
 */
const path = require('path');
const fs = require('fs');
const wp = require('../util/winpath');
const imaging = require('./imaging');
const video = require('./video');
const store = require('../store');

const MAX_BYTES = () => (store.get('compliance.maxImageMB') || 10) * 1024 * 1024;
const MAX_SEC = () => store.get('compliance.maxVideoSec') || 600;

async function scan(items, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const maxBytes = MAX_BYTES(), maxSec = MAX_SEC();
  const RULES = Object.assign(
    { requireJpg: true, minPixels: 1764, minSide: 150, maxSide: 1500, autoScale: true, videoExtMustBeMp4: true },
    store.get('compliance') || {}
  );
  const rows = [];
  let i = 0;

  for (const item of items) {
    if (cancelled()) break;
    for (const f of item.files) {
      const name = f.name;
      const e = wp.ext(name);
      const abs = path.join(item.absDir || item.dir, name);
      const st = await wp.statSafe(abs);
      const size = st ? st.size : (f.size || 0);

      if (wp.isJunk(name, false)) {
        rows.push({ item: item.id, file: name, type: '其他', issue: '非素材文件', action: '隔离到 _rejected', status: 'isolate', size });
        continue;
      }
      if (wp.isVideo(name)) {
        const dur = await imaging.videoDurationSec(abs);
        const notMp4 = RULES.videoExtMustBeMp4 && e !== '.mp4';
        if (notMp4) {
          // 得物只收 mp4，而这里能**真的转**（内置 ffmpeg：先无损转封装、不兼容再转码）。
          // 顺序上先判时长：已经超上限的，转成 mp4 照样过不了 —— 别让人白等一次转码。
          if (dur != null && dur > maxSec) {
            rows.push({ item: item.id, file: name, type: '视频', issue: `时长 ${dur} 秒，超 ${maxSec} 秒上限（转成 mp4 也过不了）`, action: '只标红不裁剪', status: 'manual', size, duration: dur });
          } else if (video.status().usable) {
            rows.push({ item: item.id, file: name, type: '视频', issue: `${e} 不是 .mp4（得物只收 mp4）`, action: '转 MP4', status: 'todo', size, duration: dur });
          } else {
            rows.push({ item: item.id, file: name, type: '视频', issue: `${e} 不是 .mp4，且程序里没找到 ffmpeg（转不了）`, action: '需手动转 MP4', status: 'manual', size, duration: dur });
          }
        } else if (dur == null) {
          rows.push({ item: item.id, file: name, type: '视频', issue: '时长读取失败（moov 缺失或编码不受支持）', action: '人工确认', status: 'manual', size, duration: null });
        } else if (dur > maxSec) {
          rows.push({ item: item.id, file: name, type: '视频', issue: `时长 ${dur} 秒，超 ${maxSec} 秒上限`, action: '只标红不裁剪', status: 'manual', size, duration: dur });
        } else {
          rows.push({ item: item.id, file: name, type: '视频', issue: '—', action: '—', status: 'ok', size, duration: dur });
        }
        continue;
      }

      // ---- 图片：真机规则 = 必须 JPG → 尺寸门槛 → 体积 ----
      const isJpg = e === '.jpg' || e === '.jpeg';
      if (RULES.requireJpg && !isJpg) {
        if (e === '.heic' || e === '.heif') {
          rows.push({
            item: item.id, file: name, type: '图片', issue: 'HEIC 格式，必须为 JPG',
            action: imaging.hasHeif() ? '转 JPG' : '需 HEIF 解码器（sharp/libheif）',
            status: imaging.hasHeif() ? 'todo' : 'manual', size
          });
        } else {
          rows.push({
            item: item.id, file: name, type: '图片',
            issue: `${e.toUpperCase()} 非 JPG${e === '.png' ? '（带透明通道）' : ''}`,
            action: '转 JPG（白底填充）', status: 'todo', size
          });
        }
        continue;
      }

      const dim = await imaging.sizeOf(abs);
      const px = dim ? dim.width * dim.height : 0;
      if (dim && px < RULES.minPixels) {
        rows.push({ item: item.id, file: name, type: '图片', issue: `${dim.width}×${dim.height}，不足 ${RULES.minPixels} 像素²（约 42×42）`, action: '需更换图片', status: 'manual', size });
        continue;
      }
      const sideOk = !dim || (Math.max(dim.width, dim.height) <= RULES.maxSide && Math.min(dim.width, dim.height) >= RULES.minSide);
      if (!sideOk) {
        rows.push({
          item: item.id, file: name, type: '图片',
          issue: `${dim.width}×${dim.height}，边长需在 ${RULES.minSide}~${RULES.maxSide} 之间`,
          action: RULES.autoScale ? '等比缩放' : '需更换图片',
          status: RULES.autoScale ? 'todo' : 'manual', size
        });
        continue;
      }
      if (size > maxBytes) {
        rows.push({ item: item.id, file: name, type: '图片', issue: `${wp.humanSize(size)}，超 ${store.get('compliance.maxImageMB')}MB`, action: '压缩', status: 'todo', size });
        continue;
      }
      // 走完全部规则还没被拦下的图片就是合格项：到此为止，只能有这一条 ok 行。
      // （以前这里往下又追加了一条「不支持的扩展名 → 隔离」，会把合格 JPG 也当成待隔离，
      //   fix() 照着做就会把好图搬进 _rejected —— tools/compliancetest.js 专门守这个边界）
      rows.push({ item: item.id, file: name, type: '图片', issue: '—', action: '—', status: 'ok', size });
    }
    i++;
    progress({ done: i, total: items.length });
  }

  const stats = {
    ok: rows.filter(r => r.status === 'ok').length,
    todo: rows.filter(r => r.status === 'todo').length,
    manual: rows.filter(r => r.status === 'manual').length,
    isolate: rows.filter(r => r.status === 'isolate').length,
    oversize: rows.filter(r => r.action === '压缩').length,
    scaled: rows.filter(r => r.action === '等比缩放').length,
    tooSmall: rows.filter(r => r.action === '需更换图片').length,
    // 「非 MP4」按**扩展名**数，不按 action 文案：一个 .mov 无论是被标成「转 MP4」、
    // 「需手动转 MP4」还是「时长超限」，它都属于非 mp4 素材。
    notMp4: rows.filter(r => r.type === '视频' && wp.ext(r.file) !== '.mp4').length,
    // 「视频超时」只数**真的超了时长**的。以前是「视频 + manual」全算进来，
    // 加了「没找到 ffmpeg」这条新的 manual 路径之后那样会算错 —— 报表不能撒谎。
    videoLong: rows.filter(r => r.type === '视频' && r.duration != null && r.duration > maxSec).length,
    total: rows.length
  };
  log(`扫描完成：${stats.total} 个文件，${stats.todo} 个待处理，${stats.manual} 个需人工定夺`, stats.manual ? 'warn' : 'ok');
  return { rows, stats };
}

/**
 * 处理后的文件名变了，同步回条目清单，否则下游（取色 / 发布）会拿着旧文件名找不到图。
 *
 * ★ type 必须跟着走：这里以前把 `type` 写死成 `'image'` —— 对图片那几个分支没问题，
 *   但视频转成 mp4 之后若复用它，会把**视频静默改成图片**，发布时按图文走步骤、拿图去发视频。
 *   现在默认按 `row.type` 推断，也允许调用方显式覆盖。
 */
function syncItem(item, row, newName, newSize, type) {
  const list = item.files || [];
  const i = list.findIndex(f => f.name === row.file);
  if (i < 0) return;
  if (newName === null) { list.splice(i, 1); return; }
  const kind = type || (row.type === '视频' ? 'video' : 'image');
  list[i] = Object.assign({}, list[i], { name: newName, size: newSize != null ? newSize : list[i].size, type: kind });
  row.file = newName;
}

/** 只处理有问题的那批；一次到位压到目标体积以下 */
async function fix(items, rows, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const rejectedDir = store.get('paths.rejected');
  const maxBytes = MAX_BYTES();
  const targets = rows.filter(r => r.status === 'todo' || r.status === 'isolate');
  let done = 0, converted = 0, isolated = 0, failed = 0;

  for (const row of targets) {
    if (cancelled()) break;
    const item = items.find(it => it.id === row.item);
    if (!item) continue;
    const baseDir = item.absDir || item.dir;
    const abs = path.join(baseDir, row.file);
    try {
      if (row.status === 'isolate') {
        const dst = path.join(rejectedDir, item.id, row.file);
        await wp.moveFile(abs, dst);
        row.status = 'done'; row.result = '已隔离'; isolated++;
        syncItem(item, row, null);
      } else if (row.action === '等比缩放') {
        const maxSide = store.get('compliance.maxSide') || 1500;
        const tmp = path.join(baseDir, '.__tmp_scale_' + row.file.replace(/\.[^.]+$/, '') + '.jpg');
        const nd = await imaging.fitWithin(abs, tmp, maxSide, 90);
        await wp.retry(() => require('fs').promises.unlink(wp.toLong(abs)));
        await wp.renameDir(tmp, abs);
        row.status = 'done'; row.result = `已等比缩放至 ${nd.width}×${nd.height}`; converted++;
        syncItem(item, row, row.file, (await wp.statSafe(abs) || {}).size);
      } else if (row.action === '压缩') {
        const tmp = path.join(baseDir, '.__tmp_' + row.file.replace(/\.[^.]+$/, '') + '.jpg');
        const r = await imaging.compressUnder(abs, tmp, maxBytes);
        await wp.retry(() => require('fs').promises.unlink(wp.toLong(abs)));
        await wp.renameDir(tmp, abs);
        // 去掉旧链接后重写同名文件：原目录（硬链接源）不受影响
        row.status = 'done'; row.result = `压缩至 ${wp.humanSize(r.size)}（质量 ${r.quality}）`; converted++;
        syncItem(item, row, row.file, r.size);
      } else if (row.action === '转 MP4') {
        // 视频转 mp4：先无损转封装（只换容器，秒级、画质不变），容器/编码不兼容时 video.js 自己转码。
        // 目录里已经有同名 .mp4 时**绝不覆盖**（那是另一份素材），另起一个名字。
        const stem = row.file.replace(/\.[^.]+$/, '');
        let dst = path.join(baseDir, stem + '.mp4');
        if (path.resolve(dst) !== path.resolve(abs) && await wp.exists(dst)) {
          let n = 2;
          while (await wp.exists(path.join(baseDir, `${stem}-${n}.mp4`))) n++;
          dst = path.join(baseDir, `${stem}-${n}.mp4`);
        }
        const tmp = path.join(baseDir, '.__tmp_mp4_' + stem + '.mp4');
        const rv = await video.toMp4(abs, tmp, {
          cancelled: cancelled,
          log: (m, lv) => log(`  ${row.file}：${m}`, lv)
        });
        // 去掉旧链接后重写新文件：原目录（硬链接源）不受影响
        if (path.resolve(dst) !== path.resolve(abs)) {
          await wp.retry(() => require('fs').promises.unlink(wp.toLong(abs)));
        }
        await wp.renameDir(tmp, dst);
        const szv = await wp.statSafe(dst);
        row.status = 'done';
        row.result = rv.mode === 'remux'
          ? `已转 MP4（无损转封装 · ${rv.codec} · ${rv.duration}s）`
          : `已转 MP4（转码 H.264 · ${rv.duration}s）`;
        row.duration = rv.duration;
        converted++;
        syncItem(item, row, path.basename(dst), szv ? szv.size : null, 'video');
      } else {
        const dst = path.join(baseDir, row.file.replace(/\.[^.]+$/, '') + '.jpg');
        const tmp = path.join(baseDir, '.__tmp_' + row.file.replace(/\.[^.]+$/, '') + '.jpg');
        await imaging.convertToJpg(abs, tmp, { quality: 90 });
        if (path.resolve(dst) !== path.resolve(abs)) {
          await wp.retry(() => require('fs').promises.unlink(wp.toLong(abs)));
        }
        await wp.renameDir(tmp, dst);
        const sz = await wp.statSafe(dst);
        row.status = 'done'; row.result = sz ? `已转 JPG ${wp.humanSize(sz.size)}` : '已转 JPG'; converted++;
        syncItem(item, row, path.basename(dst), sz ? sz.size : null);
      }
    } catch (e) {
      failed++;
      row.status = 'manual'; row.result = `处理失败：${e.message}`;
      log(`${row.file} 处理失败：${e.message}`, 'error');
    }
    done++;
    progress({ done, total: targets.length, label: row.file });
  }

  log(`处理完成：转换 ${converted} · 隔离 ${isolated} · 失败 ${failed}`, failed ? 'warn' : 'ok');
  return { rows, converted, isolated, failed };
}

/**
 * 父目录模式（真机做法）：选一个父目录，对里面每个子文件夹独立执行合规检查，
 * 结果按子文件夹分组，便于「这个批次全过、那个批次有问题」地看。
 */
async function scanParent(parentDir, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => false);
  const flatten = require('./flatten');

  const ents = await wp.readdirSafe(parentDir);
  const dirs = ents.filter(e => e.isDirectory() && !wp.isJunk(e.name, true)).map(e => e.name);
  const groups = [];
  let i = 0;

  for (const d of dirs) {
    if (cancelled()) break;
    const dir = path.join(parentDir, d);
    const plan = await flatten.plan(dir, { cancelled });
    if (!plan.total) continue;
    const items = plan.rows.map(r => ({
      id: r.name, dir: r.name, absDir: path.join(dir, r.from.replace(dir, '').replace(/^[/\\]/, '')),
      sku: r.sku, color: r.color, seq: r.seq,
      files: r.files.map(f => ({ name: f, size: 0, type: wp.isVideo(f) ? 'video' : (wp.isJunk(f, false) ? 'junk' : 'image') }))
    }));
    // absDir 直接指向源目录（父目录模式下只检查，不建副本）
    for (const it of items) it.absDir = path.join(dir, it.dir);
    const r = await scan(items, { cancelled, progress: () => {} });
    for (const row of r.rows) row.group = d;
    groups.push({ name: d, stats: r.stats, rows: r.rows });
    i++;
    progress({ done: i, total: dirs.length, label: d });
  }

  const rows = groups.reduce((a, g) => a.concat(g.rows), []);
  const stats = {
    ok: groups.reduce((a, g) => a + g.stats.ok, 0),
    todo: groups.reduce((a, g) => a + g.stats.todo, 0),
    manual: groups.reduce((a, g) => a + g.stats.manual, 0),
    isolate: groups.reduce((a, g) => a + g.stats.isolate, 0),
    oversize: groups.reduce((a, g) => a + (g.stats.oversize || 0), 0),
    scaled: groups.reduce((a, g) => a + (g.stats.scaled || 0), 0),
    tooSmall: groups.reduce((a, g) => a + (g.stats.tooSmall || 0), 0),
    notMp4: groups.reduce((a, g) => a + (g.stats.notMp4 || 0), 0),
    videoLong: groups.reduce((a, g) => a + (g.stats.videoLong || 0), 0),
    total: rows.length
  };
  log(`父目录检查完成：${groups.length} 个子文件夹 · ${stats.total} 个文件 · ${stats.todo} 个可自动处理 · ${stats.manual} 个需人工`, stats.manual ? 'warn' : 'ok');
  return { rows, stats, groups };
}

/**
 * 导出合规报告（真机结果区有「导出报告」按钮）。
 * 入参 report = { groups?: [{ name, stats, rows }], rows: [], stats: {} }
 * 输出到「输出目录」：合规报告_<stamp>.xlsx（汇总 + 明细两个工作表）与同名 .csv（明细，带 BOM 便于 Excel 直接打开）
 * format: 'xlsx' | 'csv' | 'both'（默认 both）
 */
async function exportReport(report, opts = {}) {
  const log = opts.log || (() => {});
  const outDir = opts.dir || store.get('paths.output');
  const rows = (report && report.rows) || [];
  if (!rows.length) throw new Error('没有可导出的报告：先做一次合规检查（或「检查父目录」）');
  if (!outDir) throw new Error('没有配置输出目录：先到「设置 → 路径」里选一个输出目录');

  // 分组名优先用行上自带的（scanParent 会写 r.group）；没写就从 groups 里按归属回填，
  // 免得「检查父目录」导出来全是「（未分组）」
  const groupOf = new Map();
  for (const g of (report.groups || [])) for (const r of (g.rows || [])) if (!groupOf.has(r)) groupOf.set(r, g.name);
  const detail = rows.map(r => ({
    group: r.group || groupOf.get(r) || '（未分组）',
    file: r.file || '',
    type: r.type || '',
    issue: r.issue || '',
    action: r.result || r.action || '',
    state: r.status === 'done' ? '已处理' : (r.status === 'manual' ? '需人工处理' : (r.status === 'isolate' ? '待隔离' : (r.status === 'todo' ? '可自动处理' : '合格'))),
    size: r.size == null ? '' : wp.humanSize(r.size),
    duration: r.duration == null ? '' : String(r.duration)
  }));
  const groups = (report.groups && report.groups.length) ? report.groups : null;
  const summary = groups
    ? groups.map(g => {
      const s = g.stats || {};
      return {
        name: g.name, ok: s.ok || 0, todo: s.todo || 0, manual: s.manual || 0, isolate: s.isolate || 0,
        scaled: s.scaled || 0, tooSmall: s.tooSmall || 0, notMp4: s.notMp4 || 0, videoLong: s.videoLong || 0, total: s.total || 0
      };
    })
    : null;
  const stats = (report && report.stats) || {};

  await wp.mkdirp(outDir);
  const stamp = wp.stamp();
  const fmt = opts.format || 'both';
  const out = { rows: detail.length, groups: summary ? summary.length : 0, stats };

  if (fmt === 'xlsx' || fmt === 'both') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = '得物蓝V 素材发布工具';
    wb.created = new Date();

    const ws1 = wb.addWorksheet('汇总');
    ws1.columns = [
      { header: '子文件夹', key: 'name', width: 40 }, { header: '合格', key: 'ok', width: 10 },
      { header: '可自动处理', key: 'todo', width: 12 }, { header: '需人工定夺', key: 'manual', width: 12 },
      { header: '隔离', key: 'isolate', width: 10 }, { header: '等比缩放', key: 'scaled', width: 10 },
      { header: '尺寸不足', key: 'tooSmall', width: 10 }, { header: '非 MP4', key: 'notMp4', width: 10 },
      { header: '视频超时', key: 'videoLong', width: 10 }, { header: '合计', key: 'total', width: 10 }
    ];
    if (summary) summary.forEach(r => ws1.addRow(r));
    ws1.addRow({ name: '全部', ok: stats.ok || 0, todo: stats.todo || 0, manual: stats.manual || 0, isolate: stats.isolate || 0, scaled: stats.scaled || 0, tooSmall: stats.tooSmall || 0, notMp4: stats.notMp4 || 0, videoLong: stats.videoLong || 0, total: stats.total || 0 }).font = { bold: true };

    const ws2 = wb.addWorksheet('明细', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws2.columns = [
      { header: '子文件夹', key: 'group', width: 30 }, { header: '文件', key: 'file', width: 34 },
      { header: '类型', key: 'type', width: 8 }, { header: '问题', key: 'issue', width: 40 },
      { header: '处置', key: 'action', width: 24 }, { header: '状态', key: 'state', width: 12 },
      { header: '大小', key: 'size', width: 10 }, { header: '时长(秒)', key: 'duration', width: 10 }
    ];
    detail.forEach(r => ws2.addRow(r));
    for (const ws of [ws1, ws2]) {
      const head = ws.getRow(1);
      head.font = { bold: true, size: 11 };
      head.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEBE4' } };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFC9C7BF' } } };
      });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    }
    const file = path.join(outDir, `合规报告_${stamp}.xlsx`);
    await wb.xlsx.writeFile(wp.toLong(file));
    out.file = file;
  }

  if (fmt === 'csv' || fmt === 'both') {
    const head = ['子文件夹', '文件', '类型', '问题', '处置', '状态', '大小', '时长(秒)'];
    const cell = v => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [head.join(',')].concat(detail.map(r => [r.group, r.file, r.type, r.issue, r.action, r.state, r.size, r.duration].map(cell).join(',')));
    // 带 BOM：Windows 上双击直接用 Excel 打开不乱码
    const csvFile = path.join(outDir, `合规报告_${stamp}.csv`);
    await fs.promises.writeFile(wp.toLong(csvFile), '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
    out.csvFile = csvFile;
  }

  log(`合规报告已导出：${detail.length} 行${summary ? ` · ${summary.length} 个子文件夹` : ''} → ${path.basename(out.file || out.csvFile)}`, 'ok');
  return out;
}

module.exports = { scan, scanParent, fix, exportReport };
