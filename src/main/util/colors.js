'use strict';
/** 色名词表：用于「图片实取主色 → 中文色名」的反查校验 */

const LEXICON = [
  ['黑', [28, 28, 30]], ['白', [245, 245, 247]], ['灰', [140, 140, 140]], ['浅灰', [200, 200, 202]],
  ['藏青', [24, 42, 82]], ['蓝', [45, 70, 130]], ['领袖蓝', [45, 70, 130]], ['天蓝', [120, 170, 220]],
  ['勃艮第红', [110, 32, 48]], ['红', [180, 40, 45]], ['酒红', [128, 24, 44]], ['粉', [235, 170, 180]],
  ['流沙金', [196, 172, 128]], ['卡其', [176, 156, 110]], ['燕麦色', [214, 198, 170]], ['米', [232, 222, 200]],
  ['棕', [120, 78, 50]], ['咖啡', [90, 60, 40]], ['黄', [230, 195, 60]], ['橙', [230, 130, 50]],
  ['绿', [60, 120, 80]], ['墨绿', [30, 70, 55]], ['军绿', [90, 100, 65]], ['紫', [110, 70, 140]],
  ['银', [200, 205, 210]], ['驼', [170, 140, 105]]
];

function hex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function dist(a, b) {
  // 加权欧氏距离，粗略贴合人眼对红绿更敏感
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

/** rgb → 最近色名 */
function nearest(rgb) {
  let best = null, bestD = Infinity;
  for (const [name, ref] of LEXICON) {
    const d = dist(rgb, ref);
    if (d < bestD) { bestD = d; best = name; }
  }
  return { name: best, distance: Math.round(bestD) };
}

/** 判断两个色名是否属于同一个「基础色系」，用于发现「目录写冠军白但图是黑的」 */
function coarse(rgb) {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max / 255, s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.16) return '黑';
  if (s < 0.10) return v > 0.80 ? '白' : (v > 0.45 ? '灰' : '黑');
  let h = 0;
  if (max === r) h = 60 * (((g - b) / (max - min)) % 6);
  else if (max === g) h = 60 * ((b - r) / (max - min) + 2);
  else h = 60 * ((r - g) / (max - min) + 4);
  if (h < 0) h += 360;
  if (h < 16 || h >= 345) return '红';
  if (h < 45) return '橙';
  if (h < 70) return '黄';
  if (h < 165) return '绿';
  if (h < 200) return '青';
  if (h < 260) return '蓝';
  if (h < 300) return '紫';
  return '红';
}

function coarseOfName(name) {
  const hit = LEXICON.find(([n]) => n === name);
  if (hit) return coarse(hit[1]);
  return null;
}

module.exports = { LEXICON, hex, nearest, coarse, coarseOfName };
