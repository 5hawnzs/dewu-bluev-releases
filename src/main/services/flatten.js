'use strict';
/**
 * ① 素材整理
 * PRD 要点：
 *   - 先秒级出「待整理清单」，实体复制（仅跨盘/跨卷时）放后台带进度
 *   - 同卷建硬链接（只改元数据，1692 个链接 < 2 秒），跨卷才真复制
 *   - 原目录只改名加时间戳、不改内容；扁平副本另存，随时可回溯
 *   - Windows 长路径加 \\?\ 前缀；改名被占用要重试并说明是哪一层被锁
 *   - 硬链接的副作用：下游只允许「写新文件」，绝不就地改
 */
const path = require('path');
const wp = require('../util/winpath');
const store = require('../store');

const NUMERIC = /^\d+$/;
/** 颜色名一定带汉字（冠军白 / 煤黑色01 / 酒红色74）；货号/批次目录/日期目录都是纯 ASCII。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function hasCJK(s) { return CJK.test(String(s == null ? '' : s)); }
/** 相机 / 截图文件名：长得像货号但不是货号，不许当真（IMG_5253 / DSCF4233 / Screenshot_1） */
const CAMERA = /^(IMG|DSC|DSCF|DSCN|PANO|PXL|MVIMG|Screenshot|WechatIMG|微信图片|截屏|屏幕截图)[_-]?\d+$/i;

/**
 * 摘掉「扁平副本」留下的尾巴。
 * ★ 为什么必须有（2026-10-03 真机命名实测）：第一步素材整理把原来的层级用连接符接成了一个名字
 *   （`26FW-YB160+冠军白/1` → `26FW-YB160+冠军白_1`），同一分钟跑两次还会再加 `-2`。
 *   不摘掉的话颜色会被读成「冠军白_1」—— 那不是一个色名，颜色核对、商品池比对、
 *   发布时选哪个颜色（多色货号）全都对不上。
 * ★ 只摘「分隔符 + 纯数字」的结尾，所以「冠军白」「黑色条纹」「米白2」都不会被误伤。
 */
function stripTail(name) {
  let head = String(name == null ? '' : name).trim();
  let seq = '';
  for (let i = 0; i < 2; i++) {                  // 最多两层：先 `-2`（去重），再 `_1`（序号）
    const m = head.match(/^(.*?)[_-](\d+)$/);
    if (!m || !m[1]) break;
    head = m[1];
    if (!seq) seq = m[2];
  }
  return { head, seq };
}

/**
 * 从目录名/路径反推 货号 + 颜色 + 序号。
 * ★ 多返回一个 `how`，说明这两个值**是怎么来的**：
 *   'plus'  —— 名字里确实是「货号+颜色」（+ 号分隔）。**只有这一种可以拿去填报告的货号/颜色**。
 *   'split' —— 老式「货号/颜色/序号」三层、**且父目录确实是个颜色名**。颜色可信，货号来自再上一层。
 *   'sku'   —— 「批次目录 / 货号 / 序号」三层，**颜色根本没填**。实测
 *              `…/0901_2/3261163003/1/`：0901_2 是批次目录、3261163003 才是货号。
 *              **只有货号可信，颜色必须留空**（老逻辑会把这两个值换位）。
 *   'guess' / 'name' —— 随手命名的文件夹，解析出来的多半是垃圾（实测
 *              `…/品牌甲/20260904/IMG_5253/1/` → 货号=20260904 / 颜色=IMG_5253），**不许当真**。
 * 调用方（report.fillGoodsFromLeaf）按 how 决定用不用。
 */
function parseName(dir) {
  const segs = dir.split(/[\\/]+/).filter(Boolean);
  const leaf = segs[segs.length - 1] || '';
  const parent = segs[segs.length - 2] || '';
  const grand = segs[segs.length - 3] || '';

  if (leaf.includes('+')) {
    const parts = leaf.split('+').map(s => s.trim()).filter(Boolean);
    let color = parts[1] || '';
    let seq = parts[2] || '1';
    // 只有「货号+颜色」两段时，颜色那段末尾可能挂着扁平副本的序号（`冠军白_1`）——那边不是颜色
    if (parts.length <= 2 && color) {
      const st = stripTail(color);
      if (st.seq) { color = st.head; seq = st.seq; }
    }
    return { sku: parts[0] || '', color, seq, how: 'plus' };
  }
  if (NUMERIC.test(leaf)) {
    // …/26FW-YB160+冠军白/1/ —— 上一层就是「货号+颜色」，同样算 'plus'
    if (parent.includes('+')) {
      const parts = parent.split('+').map(s => s.trim()).filter(Boolean);
      return { sku: parts[0] || '', color: parts[1] || '', seq: leaf, how: 'plus' };
    }
    // ★★ 「批次目录 / 货号 / 序号」三层、颜色**没填**：…/0901_2/3261163003/1/
    //   真机实测（2026-10-03，E:\bluev_beta\0901_2）：老逻辑走的是下面那行 'split'，
    //   把**批次目录名**当货号、把**真货号**当颜色，写出「货号=0901_2 / 颜色=3261163003」，
    //   真货号还被当成颜色送进了「色名核对」。
    //   判据：**颜色名一定带汉字**（冠军白 / 煤黑色01 / 酒红色74 …），
    //   所以「父目录里没有汉字」就不可能是颜色 ⇒ 父目录是货号，颜色留空，交给界面点名。
    //   ★ 但相机/截图文件名（IMG_5253 / DSCF4233）不是货号，排除掉，仍按 'split' 当「不可信」。
    if (!hasCJK(parent) && !CAMERA.test(parent)) {
      return { sku: parent || grand, color: '', seq: leaf, how: 'sku' };
    }
    // …/26FW-YB160/冠军白/1/ —— 老式三层（父目录是颜色名），颜色可信、货号来自再上一层
    return { sku: grand || parent, color: parent || '', seq: leaf, how: 'split' };
  }
  // …/CK-Y208+流沙金/ 或 …/UF46FWT75EH1HF6/领袖蓝/1/
  if (parent && !NUMERIC.test(parent) && parent !== path.basename(path.dirname(dir))) {
    return { sku: parent.includes('+') ? parent.split('+')[0] : parent, color: leaf, seq: '1', how: 'guess' };
  }
  // ★ 扁平副本的去重后缀（`flat_20261002-2329/3261163003_1`）要摘掉，
  //   否则货号会带着「_1」进报告（2026-10-03 实测）。
  //   ★ 只在「摘完还剩下数字、且不是相机名」时摘 —— `IMG_5253` 摘成 `IMG` 信息更少、更像是真的 ⇒ 不摘。
  const st = stripTail(leaf);
  if (st.seq && /\d/.test(st.head) && !hasCJK(st.head) && !CAMERA.test(st.head)) {
    return { sku: st.head, color: '', seq: st.seq, how: 'sku' };
  }
  // 随手命名的文件夹（`IMG_5253` / `DSCF4233`）：原样当货号，**不做后缀摘除**。
  // how='name' 已经说了「别当真」。
  return { sku: leaf, color: '', seq: '1', how: 'name' };
}

/** 目标目录已存在（同分钟重跑）时自动加序号，绝不覆盖 */
async function uniqueDir(parent, name) {
  let target = path.join(parent, name);
  let i = 2;
  while (await wp.exists(target)) {
    target = path.join(parent, `${name}-${i++}`);
    if (i > 50) break;
  }
  return target;
}

async function walk(dir, out, ctx, depth = 0) {
  if (ctx.cancelled()) return { hasMedia: false };
  if (depth > 12) return { hasMedia: false };
  const ents = await wp.readdirSafe(dir);
  const allFiles = ents.filter(e => e.isFile()).map(e => e.name);
  const media = allFiles.filter(f => !wp.isJunk(f, false) && (wp.isMedia(f) || wp.isVideo(f)));
  const dirs = ents.filter(e => e.isDirectory() && !wp.isJunk(e.name, true)).map(e => e.name);

  let childHas = false;
  for (const d of dirs) {
    const r = await walk(path.join(dir, d), out, ctx, depth + 1);
    if (r && r.hasMedia) childHas = true;
  }
  const has = media.length > 0;
  // 垃圾文件（.DS_Store 等）一并带进扁平副本，交给合规检查隔离，而不是就地丢掉
  if (has && !childHas) out.push({ dir, files: allFiles, mediaCount: media.length });
  return { hasMedia: has || childHas };
}

/** 秒级出清单：只读元数据，不动任何字节 */
async function plan(sourceDir, ctx = {}) {
  const cancelled = ctx.cancelled || (() => false);
  ctx.cancelled = cancelled;
  const leaves = [];
  await walk(sourceDir, leaves, ctx);

  const connector = (store.get('flatten') || {}).connector || '_';
  const seen = new Map();
  const rows = leaves.map((l, i) => {
    const p = parseName(l.dir);
    const seq = p.seq || String(i + 1);
    // 真机命名：用连接符把原来的层级路径接起来（8124MT_UWG450159+灰色+达人昵称_1）
    const rel = path.relative(sourceDir, l.dir);
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    let name = segs.length ? segs.join(connector) : (p.color ? `${p.sku}+${p.color}+${seq}` : `${p.sku}+${seq}`);
    name = name.replace(/[<>:"|?*]/g, '_');     // Windows 非法文件名字符
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      name = `${name}-${n}`;
    } else seen.set(name, 1);
    return { from: l.dir, name, sku: p.sku, color: p.color, seq, how: p.how, files: l.files, fileCount: l.mediaCount };
  });

  const longRisk = rows.filter(r => wp.pathRisk(path.join(sourceDir, r.name)) === 'long').length;
  return { rows, total: rows.length, fileTotal: rows.reduce((a, r) => a + r.fileCount, 0), longRisk };
}

/** 执行整理：建扁平副本 + 原目录改名加时间戳 */
async function run(sourceDir, opts, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => false);
  // touchOriginal=false（默认，真机做法）：原素材完全不动，只建扁平副本
  const cfg = Object.assign({ touchOriginal: false, withStamp: true, mode: 'auto' }, opts || {});
  const stamp = wp.stamp();

  const p = await plan(sourceDir, { cancelled });
  if (!p.total) return { ok: false, message: '没有找到任何素材叶子目录' };

  const parent = path.dirname(sourceDir);
  // 同一分钟内重跑会撞名，自动加 -2 / -3 后缀，不覆盖上一批结果
  const flatDir = await uniqueDir(parent, `flat_${stamp}`);
  await wp.mkdirp(flatDir);
  log(`扁平副本目录：${wp.toDisplay(flatDir)}`, 'info');

  let links = 0, copies = 0, done = 0, bytes = 0;
  const items = [];

  for (const row of p.rows) {
    if (cancelled()) break;
    const target = path.join(flatDir, row.name);
    await wp.mkdirp(target);
    const files = [];
    for (const f of row.files) {
      const src = path.join(row.from, f);
      const dst = path.join(target, f);
      let mode = 'copy';
      if (cfg.mode !== 'copy') mode = await wp.linkOrCopy(src, dst);
      if (mode === 'link') links++; else copies++;
      const st = await wp.statSafe(dst);
      if (st) bytes += st.size;
      files.push({ name: f, size: st ? st.size : 0, type: wp.isVideo(f) ? 'video' : (wp.isJunk(f, false) ? 'junk' : 'image') });
    }
    done++;
    items.push({
      id: row.name, dir: row.name, absDir: target, sku: row.sku, color: row.color, seq: row.seq,
      files, fileCount: files.length, bytes
    });
    progress({ done, total: p.total, label: row.name, links, copies });
  }

  progress({ done, total: p.total, links, copies, bytes });

  // 默认不动原目录；只有显式开启 touchOriginal 才改名加时间戳
  let renamed = null, warn = null;
  if (!cfg.touchOriginal) {
    log(`原素材完全不动：${path.basename(sourceDir)} 保持原样，只建扁平副本`, 'ok');
  } else {
    const base = path.basename(sourceDir);
    const to = await uniqueDir(parent, `${base}_${stamp}`);
    try {
      await wp.renameDir(sourceDir, to, (err, n) => {
        warn = `原目录被占用（${err.code}），第 ${n} 次重试… 若网盘同步或看图软件开着，关掉后会自动继续`;
        log(warn, 'warn');
      });
      renamed = to;
      log(`原目录已保留为：${base}_${stamp}`, 'ok');
    } catch (e) {
      warn = `原目录改名失败：${e.code || e.message}。扁平副本已生成，可手动改名为 ${base}_${stamp}`;
      log(warn, 'warn');
    }
  }

  if (links > 0) {
    log(`已建硬链接 ${links} 个：下游只写新文件、绝不就地改，否则会把原图一起改掉`, 'info');
  }
  if (p.longRisk) log(`有 ${p.longRisk} 个目标路径偏长，已自动启用 \\\\?\\ 长路径前缀`, 'warn');

  return {
    ok: true, flatDir, renamed, links, copies, bytes,
    fileTotal: links + copies, items,
    summary: `${p.total} 个叶子目录 · 链接 ${links} · 复制 ${copies} · ${wp.humanSize(bytes)}`
  };
}

module.exports = { plan, run, parseName, stripTail };
