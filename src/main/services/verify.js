'use strict';
/**
 * ④ 货号颜色校验
 * PRD 要点：
 *   - 比对得物商品资料；多颜色货号必须填对应颜色
 *   - 多一道保险：用图片实际提出的主色反查目录里填的色名
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

    // ★★ `level`（严重度，给界面染色）和 `block`（要不要拦住不发布）**是两回事**，别再用一个字段表达。
    //  2026-10-02 之前只有 `level`，发布侧拿 `pass === false` 一把抓 ⇒
    //  「查不到货号」（**没有数据**，不是有错）和「颜色不匹配 / 主色不符」（**确实有错**）
    //  被当成同一件事一起拦住。后果：商品资料只导了一部分时，凡是池里没有的货号全被判 warn
    //  ⇒ 整批一条都发不出去，而界面只显示「校验未通过」。这与本文件与真机的口径
    //  「接口查不到的货号**仅告警不阻断**」直接矛盾。
    //  ⇒ 所以：**无数据只告警（block=false），有据可判的不一致才阻断（block=true）**。
    //  ★★ 2026-10-02 再收紧一次（用户拍板「货号颜色校验为发布流程中非必需项目」）：
    //     「颜色不匹配」「主色不符」也改成**只告警**（block=false）—— 真机「关联好物」是
    //     按**货号**搜出结果后选第一件，颜色填错最多是选错规格，不该让整条发不出去。
    //     现在唯一还会拦的是**多色货号根本没填颜色**（发布端连拿什么去对都没有）。
    let conclusion = '通过', note = '', level = 'ok', block = false;
    if (!poolColors) {
      conclusion = `货号 ${item.sku} 未查到颜色信息，请核对`;
      note = apiMode ? '接口查不到该货号，仅告警不阻断' : '本地资料查不到该货号，请核对';
      level = 'warn';                 // 只告警：查不到 ≠ 错，照常发布，但这行会一直提醒你核对
    } else if (!declared) {
      if (poolColors.length > 1) {
        conclusion = '多色货号须指定颜色';
        note = `共 ${poolColors.length} 色：${poolColors.join(' / ')}`;
        level = 'bad'; block = true;  // 多色不填色 ⇒ 发出去就是错的，必须拦
      } else {
        conclusion = '单色货号，颜色可空'; note = `参考颜色仅 ${poolColors[0]}`; level = 'ok';
      }
    } else if (!poolColors.includes(declared)) {
      // 颜色对不上**不拦发布**（2026-10-02 用户拍板）：仍标 warn 让人看得见，但照发。
      conclusion = '颜色不匹配';
      note = `参考颜色：${poolColors.join(' / ')} → 发布时按货号搜出来的第一件商品发`;
      level = 'warn'; block = false;
    } else if (imageColor) {
      const declaredCoarse = colors.coarseOfName(declared);
      if (declaredCoarse && declaredCoarse !== imageColor.coarse) {
        // 同上：主色不符也只告警，不再拦发布（发布端按货号搜第一件）。
        conclusion = '主色不符';
        note = `目录写「${declared}」（${declaredCoarse}系），图片实取主色为 ${imageColor.name}（${imageColor.coarse}系）`
          + ' → 颜色不拦发布，这一条会按货号搜出来的第一件商品发';
        level = 'warn'; block = false;
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
      conclusion, note, level, block, pass: level === 'ok'
    });
    i++;
    progress({ done: i, total: items.length, label: item.sku });
  }

  const stats = {
    pass: rows.filter(r => r.level === 'ok').length,
    manual: rows.filter(r => r.level === 'warn').length,
    missing: rows.filter(r => /未查到颜色信息/.test(r.conclusion)).length,
    noColor: rows.filter(r => r.conclusion === '多色货号须指定颜色').length,
    // 真正会被「发布」跳过的条数。★ 和上面的 manual 不是一个数：manual 里绝大多数是
    // 「查不到 / 颜色对不上」（只告警、照发），只有 block=true（多色漏填）才会被拦。
    blocked: rows.filter(r => isBlocked(r)).length
  };
  log(`校验完成：通过 ${stats.pass} · 需人工 ${stats.manual} · 未查到 ${stats.missing} · 缺色 ${stats.noColor}`
    + ` · 会被拦下不发 ${stats.blocked}${apiMode ? '（接口模式）' : ''}`,
    (stats.manual || stats.missing || stats.noColor) ? 'warn' : 'ok');
  return { rows, stats, poolSize: pool.size(), poolSource: pool.get().source, mode: apiMode ? 'api' : 'local' };
}

/**
 * 这一条**要不要拦住不发布**（发布侧唯一该看的判据）。
 *
 * ★ 现在唯一还会拦的：**多色货号根本没填颜色**（`block` 由 check() 写的 true）。
 *   「货号查不到」「颜色不匹配」「主色不符」一律只告警、照常发布。
 *
 * ★ 旧数据（没有 `block` 字段的 `verify.rows`，存在 `project.json` 里）按**结论原文**回推，
 *   不退回 `pass === false`：老口径会把「查不到 / 颜色对不上」也拦下，升级后还照着老账拦就白改了。
 *   **重新点一次「开始校验」就会写上新字段。**
 */
function isBlocked(row) {
  if (!row) return false;
  if (typeof row.block === 'boolean') return row.block;
  return /多色货号须指定颜色/.test(String(row.conclusion || ''));
}

module.exports = { check, isBlocked };
