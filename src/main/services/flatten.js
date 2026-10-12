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
const fs = require('fs').promises;
const crypto = require('crypto');

// 按原目录、文件元数据和整理选项记录完成结果，重启后也避免重复建目录。
async function sourceKey(sourceDir, plan, cfg) {
  const files = [];
  for (const row of plan.rows) for (const name of row.files) {
    const file = path.join(row.from, name);
    const stat = await wp.statSafe(file);
    if (!stat) throw new Error('素材已变化或无法读取，请重新生成清单');
    files.push([path.relative(sourceDir, file), stat.size, stat.mtimeMs]);
  }
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify([path.resolve(sourceDir).toLowerCase(), files, cfg, (store.get('flatten') || {}).connector])).digest('hex');
}

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
    // 旧式三段名仍把第 3 段当序号；多好物名按「货号+颜色」成对读取。
    let seq = parts.length === 3 ? (parts[2] || '1') : '1';
    const goods = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      goods.push({ sku: parts[i], color: parts[i + 1] });
    }
    if (parts.length <= 2 && color) {
      const st = stripTail(color);
      if (st.seq) {
        color = st.head;
        seq = st.seq;
        if (goods[0]) goods[0].color = color;
      }
    }
    return { sku: parts[0] || '', color, goods, seq, how: 'plus' };
  }
  if (NUMERIC.test(leaf)) {
    // …/26FW-YB160+冠军白/1/ —— 上一层就是「货号+颜色」，同样算 'plus'
    if (parent.includes('+')) {
      const parts = parent.split('+').map(s => s.trim()).filter(Boolean);
      const goods = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        goods.push({ sku: parts[i], color: parts[i + 1] });
      }
      return { sku: parts[0] || '', color: parts[1] || '', goods, seq: leaf, how: 'plus' };
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

/**
 * 用**叶子文件夹名**把一条工程条目的 货号/颜色 重新识别一遍（自愈；**不改** parseName 的语义）。
 *
 * ★ 为什么必须有（2026-10-04 用户第二次报「货号里还是批次目录名 0901_2」）：
 *   `project.json` 里的 items 是**素材整理那一次**算好、之后一直沿用的 —— 文案生成 / 出报告 /
 *   发布都只读它，**不会再回文件夹看第二眼**。实测该工程里两条存着
 *   `sku:'0901_2' / color:'3261163003'`（旧版把批次目录当货号、真货号当颜色），
 *   而同一份 `absDir`（扁平副本 `…\flat_20261002-2329\3261163003_1`）用现在的 parseName
 *   读出来是 `sku:'3261163003' / color:''`。报告的好物列直接取 `it.sku/it.color`
 *   ⇒ 一直错，而且**重跑文案生成也照样错**（文案生成不重算这两个字段）。
 *   按文件夹名重读一次就对了，不必重跑素材整理。
 *
 * ★ 取名字的顺序：`absDir`（扁平副本的绝对路径，最权威）→ `dir`。
 *   **绝不拿 `id` 去解析** —— 旧版 items 的 id 是「+连接的显示名」（`3261163003+1`），
 *   拿它当路径解析会把 `1` 读成颜色。
 * ★ 只认 'plus' / 'sku' 两种 how（其余解析出来是垃圾，见 parseName）；别的 how 原样返回、一个字不改。
 * ★ 颜色额外一条线：**颜色名一定带汉字**（煤黑色01 / 酒红色74）。解析出来的颜色里一个汉字都没有
 *   （`1` / `3261163003`）就不可能是色名 ⇒ 当空，按「没填颜色」走（宁缺勿错，不静默瞎猜）。
 *   how='sku' 时原本就填着带汉字的颜色（人工补过）⇒ 保留不动，不自作主张抹掉。
 */
function refineItem(it) {
  if (!it || typeof it !== 'object') return it;
  const src = String(it.absDir || it.dir || '').trim();
  if (!src) return it;
  const p = parseName(src);
  if (p.how !== 'plus' && p.how !== 'sku') return it;
  const sku = String(p.sku || '').trim();
  const color = p.how === 'plus'
    ? (hasCJK(p.color) ? String(p.color).trim() : '')
    : (hasCJK(it.color) ? String(it.color).trim() : '');
  const goods = p.how === 'plus' && (p.goods.length > 1 || Array.isArray(it.goods))
    ? p.goods.map(g => ({
      sku: String(g.sku || '').trim(),
      color: hasCJK(g.color) ? String(g.color).trim() : ''
    }))
    : (Array.isArray(it.goods) ? it.goods : null);
  const sameGoods = goods == null
    ? !Array.isArray(it.goods)
    : Array.isArray(it.goods) && it.goods.length === goods.length
      && goods.every((g, i) => it.goods[i] && it.goods[i].sku === g.sku && it.goods[i].color === g.color);
  if (String(it.sku == null ? '' : it.sku).trim() === sku
    && String(it.color == null ? '' : it.color).trim() === color
    && sameGoods) return it;
  const patch = { sku, color };
  if (goods != null) patch.goods = goods;
  return Object.assign({}, it, patch);
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
    return {
      from: l.dir, name, sku: p.sku, color: p.color,
      goods: p.goods || (p.sku ? [{ sku: p.sku, color: p.color }] : []),
      seq, how: p.how, files: l.files, fileCount: l.mediaCount
    };
  });

  const longRisk = rows.filter(r => wp.pathRisk(path.join(sourceDir, r.name)) === 'long').length;
  return { rows, total: rows.length, fileTotal: rows.reduce((a, r) => a + r.fileCount, 0), longRisk };
}

/** 执行整理：建扁平副本 + 原目录改名加时间戳 */
async function runOnce(sourceDir, opts, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => false);
  // touchOriginal=false（默认，真机做法）：原素材完全不动，只建扁平副本
  const cfg = Object.assign({ touchOriginal: false, withStamp: true, mode: 'auto' }, opts || {});
  const stamp = wp.stamp();

  const p = await plan(sourceDir, { cancelled });
  if (!p.total) return { ok: false, message: '没有找到任何素材叶子目录' };

  const cacheFile = path.join(require('electron').app.getPath('userData'), 'flatten-completed.json');
  const key = await sourceKey(sourceDir, p, cfg);
  let completed = {};
  try { completed = JSON.parse(await fs.readFile(cacheFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('无法读取整理记录，请先修复记录文件：' + e.message); }
  const previous = completed[key];
  if (previous && await wp.exists(previous.flatDir)) {
    log('这份素材已整理，使用已有目录：' + previous.flatDir, 'ok');
    return Object.assign({}, previous, { reused: true, summary: '素材未变化，已保留上次整理结果，未创建新文件夹' });
  }

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
      id: row.name, dir: row.name, absDir: target, sku: row.sku, color: row.color,
      goods: row.goods || (row.sku ? [{ sku: row.sku, color: row.color }] : []), seq: row.seq,
      files, fileCount: files.length, bytes
    });
    progress({ done, total: p.total, label: row.name, links, copies });
  }

  progress({ done, total: p.total, links, copies, bytes });
  if (cancelled()) throw new Error('整理已取消，未登记为完成；部分副本保留在：' + flatDir);

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

  const result = {
    ok: true, flatDir, renamed, links, copies, bytes,
    fileTotal: links + copies, items,
    summary: `${p.total} 个叶子目录 · 链接 ${links} · 复制 ${copies} · ${wp.humanSize(bytes)}`
  };
  completed[key] = result;
  if (renamed) completed[await sourceKey(renamed, await plan(renamed, { cancelled }), cfg)] = result;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile + '.tmp', JSON.stringify(completed), 'utf8');
  await fs.rename(cacheFile + '.tmp', cacheFile);
  return result;
}

let organizing = false;
async function run(sourceDir, opts, ctx = {}) {
  if (organizing) throw new Error('素材正在整理，请等待当前整理完成');
  organizing = true;
  try { return await runOnce(sourceDir, opts, ctx); }
  finally { organizing = false; }
}
module.exports = { plan, run, parseName, stripTail, refineItem };
