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
    for (const line of lines) {
      const cells = line.split(sep).map(s => s.trim().replace(/^"|"$/g, ''));
      if (cells.length < 2) continue;
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
