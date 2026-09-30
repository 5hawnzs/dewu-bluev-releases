'use strict';
/**
 * ④ 货号颜色校验
 * PRD 要点：
 *   - 比对得物商品池；多颜色货号必须填对应颜色
 *   - 加一道前司没有的保险：用图片实际提出的主色反查目录里填的色名
 *   - 词表外色名只标「需人工确认」，机器不替人决定
 */
const path = require('path');
const imaging = require('./imaging');
const pool = require('./pool');
const colors = require('../util/colors');
const store = require('../store');

async function check(items, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const useImage = store.get('verify.useImageColor') !== false;
  const vc = store.get('verify') || {};
  const apiMode = vc.mode === 'api' && !!(vc.api || {}).endpoint;
  const cache = new Map();
  const rows = [];
  let i = 0;

  // 真机是调接口查得物后台（SKU APIKey）；查不到仅告警不阻断
  async function colorsFromApi(sku) {
    if (cache.has(sku)) return cache.get(sku);
    let out = null;
    try {
      const url = vc.api.endpoint + (vc.api.endpoint.includes('?') ? '&' : '?') + 'sku=' + encodeURIComponent(sku);
      const res = await fetch(url, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${vc.api.apiKey || ''}` },
        signal: AbortSignal.timeout(12000)
      });
      if (res.ok) {
        const j = await res.json();
        const arr = Array.isArray(j) ? j : (j.colors || j.data || j.list || null);
        if (Array.isArray(arr)) out = arr.map(x => (typeof x === 'string' ? x : (x.color || x.颜色 || x.name))).filter(Boolean);
      }
    } catch (e) { out = null; }
    cache.set(sku, out);
    return out;
  }

  for (const item of items) {
    if (cancelled()) break;
    const declared = item.color || '';
    const poolColors = apiMode ? await colorsFromApi(item.sku) : pool.colorsOf(item.sku);
    let imageColor = null;
    if (useImage) {
      // 逐张试：单张解码失败（HEIC 缺解码器等）不该让整条拿不到主色
      const imgs = (item.files || []).filter(f => f.type === 'image');
      for (const f of imgs.slice(0, 3)) {
        try {
          imageColor = await imaging.dominantColor(path.join(item.absDir || item.dir, f.name));
          if (imageColor) break;
        } catch (e) { /* 单张失败继续下一张 */ }
      }
    }

    let conclusion = '通过', note = '', level = 'ok';
    // 判定文案对齐真机工具；接口查不到的货号「仅告警不阻断」
    if (!poolColors) {
      conclusion = `货号 ${item.sku} 未查到颜色信息，请核对`;
      note = apiMode ? '接口查不到该货号，仅告警不阻断' : '商品池里查不到该货号，请核对';
      level = 'warn';
    } else if (!declared) {
      if (poolColors.length > 1) {
        conclusion = '多色货号须指定颜色';
        note = `共 ${poolColors.length} 色：${poolColors.join(' / ')}`;
        level = 'bad';
      } else {
        conclusion = '单色货号，颜色可空'; note = `商品池仅 ${poolColors[0]}`; level = 'ok';
      }
    } else if (!poolColors.includes(declared)) {
      conclusion = '颜色不匹配'; note = `商品池：${poolColors.join(' / ')}`; level = 'warn';
    } else if (imageColor) {
      const declaredCoarse = colors.coarseOfName(declared);
      if (declaredCoarse && declaredCoarse !== imageColor.coarse) {
        conclusion = '主色不符，需人工确认';
        note = `目录写「${declared}」（${declaredCoarse}系），图片实取主色为 ${imageColor.name}（${imageColor.coarse}系）`;
        level = 'warn';
      } else {
        note = `图片主色 ${imageColor.name}，与目录一致`;
      }
    }

    rows.push({
      id: item.id,
      sku: item.sku,
      declared,
      swatch: imageColor ? imageColor.hex : null,
      poolColors: poolColors || [],
      imageColor: imageColor ? imageColor.name : '—',
      conclusion, note, level, pass: level === 'ok'
    });
    i++;
    progress({ done: i, total: items.length, label: item.sku });
  }

  const stats = {
    pass: rows.filter(r => r.level === 'ok').length,
    manual: rows.filter(r => r.level === 'warn').length,
    missing: rows.filter(r => /未查到颜色信息/.test(r.conclusion)).length,
    noColor: rows.filter(r => r.conclusion === '多色货号须指定颜色').length
  };
  log(`校验完成：通过 ${stats.pass} · 需人工 ${stats.manual} · 未查到 ${stats.missing} · 缺色 ${stats.noColor}${apiMode ? '（接口模式）' : ''}`,
    (stats.manual || stats.missing || stats.noColor) ? 'warn' : 'ok');
  return { rows, stats, poolSize: pool.size(), poolSource: pool.get().source, mode: apiMode ? 'api' : 'local' };
}

module.exports = { check };
