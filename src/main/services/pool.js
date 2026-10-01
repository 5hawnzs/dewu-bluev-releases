'use strict';
/** 得物商品池本地缓存：货号 → 颜色列表（PRD 里「货号颜色校验」的比对基准） */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const wp = require('../util/winpath');

const SAMPLE = {
  '26FW-YB160': ['冠军白', '冠军黑'],
  'UF46FWT75EH1HF6': ['领袖蓝', '智慧黄'],
  '26FWT81': ['勃艮第红', '冠军黑'],
  'CK-Y208': ['流沙金', '燕麦色'],
  'abc': ['黑色', '白色']
};

let cache = null;

function file() { return path.join(app.getPath('userData'), 'pool.json'); }

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(wp.toLong(file()), 'utf8'));
  } catch (e) {
    cache = { source: '示例数据（未同步）', updatedAt: 0, skus: SAMPLE };
  }
  return cache;
}

function get() { return load(); }
function colorsOf(sku) { const c = load().skus || {}; return c[sku] || null; }
function size() { return Object.keys(load().skus || {}).length; }

function save(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file());
  cache = data;
  return data;
}

/** 导入 CSV / TSV / JSON：至少要有「货号」「颜色」两列 */
function importFile(file_) {
  const raw = fs.readFileSync(wp.toLong(file_), 'utf8').replace(/^\uFEFF/, '');
  let pairs = [];
  if (wp.ext(file_) === '.json') {
    const j = JSON.parse(raw);
    const obj = j.skus || j;
    pairs = Object.keys(obj).map(k => [k, Array.isArray(obj[k]) ? obj[k] : String(obj[k]).split(/[、,，/]/).map(s => s.trim()).filter(Boolean)]);
  } else {
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    const sep = (lines[0].match(/\t/) ? '\t' : (lines[0].split(',').length > lines[0].split('\t').length ? ',' : ';'));
    // ★ 表头要跳过。原实现把第一行「货号,颜色」当成一条真数据导进去
    //  ⇒ 池子里永远多一条假货号「货号 → [颜色]」（实测本机 pool.json 就是这样：
    //    界面显示「2 个货号」，其实只有 1 条真数据，另一条是表头）。
    //  判据只用「第一行 + 第一格是这几个词」这一种，宁可漏跳也不误杀真货号。
    const HEADER = /^(货号|款号|商品编码|商品编号|sku|spu|sku[\s_-]?id|spu[\s_-]?id|货号\s*\/\s*sku)$/i;
    for (let li = 0; li < lines.length; li++) {
      const cells = lines[li].split(sep).map(s => s.trim().replace(/^"|"$/g, ''));
      if (cells.length < 2) continue;
      if (li === 0 && HEADER.test(cells[0])) continue;   // 表头行，不是数据
      pairs.push([cells[0], cells.slice(1).join('、').split(/[、,，/]/).map(s => s.trim()).filter(Boolean)]);
    }
  }
  const skus = {};
  for (const [sku, colors] of pairs) {
    if (!sku) continue;
    skus[sku] = Array.from(new Set((skus[sku] || []).concat(colors.filter(Boolean))));
  }
  return save({ source: path.basename(file_), updatedAt: Date.now(), skus });
}

module.exports = { get, load, save, colorsOf, size, importFile };
