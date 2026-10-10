'use strict';
// 云端统一清零时间；只清发布台账，保留账号、素材及排错运行日志。
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../store');
const CD = require('../clouddefaults');
function stateFile() {
  let dir = path.join(os.tmpdir(), 'dewu-bluev-publisher-test');
  try { dir = require('electron').app.getPath('userData'); } catch (_) {}
  return path.join(dir, 'publish-history.json');
}
function cutoff() {
  try { return Number(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).before) || 0; } catch (_) { return 0; }
}
function keep(e) { return !cutoff() || Number(e.ts) >= cutoff(); }
function apply(before, file) {
  before = Math.max(cutoff(), Number(before) || 0);
  if (!before) return false;
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ before }));
  if (!file || !fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const retained = lines.filter(line => { try { return Number(JSON.parse(line).ts) >= before; } catch (_) { return false; } });
  if (retained.length === lines.length) return false;
  // 同步中没有 await；原子替换不会跨过发布结果的追加写入。
  fs.writeFileSync(file + '.reset.tmp', retained.length ? retained.join('\n') + '\n' : '');
  fs.renameSync(file + '.reset.tmp', file);
  return true;
}
function cfg() {
  return { url: String(store.get('cloud.url') || CD.url).trim().replace(/\/+$/, ''), key: String(store.get('cloud.anonKey') || CD.anonKey).trim(), org: CD.org };
}
async function request(route) {
  const c = cfg();
  const r = await fetch(c.url + '/rest/v1/' + route, {
    headers: { apikey: c.key, Authorization: 'Bearer ' + c.key }, signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw Error('云端读取失败 HTTP ' + r.status);
  return r.json();
}
async function refresh(file) {
  try {
    const data = await request('publish_history_control?select=before_ts&org=eq.' + encodeURIComponent(cfg().org));
    return apply(Array.isArray(data) && data[0] ? data[0].before_ts : cutoff(), file);
  } catch (_) {
    // 迁移尚未执行或断网时使用上次清零时间，不阻断发布。
    return apply(cutoff(), file);
  }
}
async function account(userId, filters = {}) {
  if (!userId) return { available: false, error: '当前账号未登录' };
  try {
    const result = { available: true, rows: 0, ok: 0, fail: 0, other: 0 };
    const scope = Array.isArray(filters.scopeIds) ? filters.scopeIds.map(String) : null;
    const wantBrand = String(filters.brandId || '');
    if ((filters.userId && String(filters.userId) !== String(userId))
      || (scope && (!scope.length || (wantBrand && !scope.includes(wantBrand))))) return result;
    const before = cutoff();
    const seen = new Set();
    // 按不可变主键翻页，避免同步新增记录造成 offset 跳页重复。
    let cursor = 0;
    const clauses = ['org=eq.' + encodeURIComponent(cfg().org)];
    if (userId) clauses.push('user_id=eq.' + encodeURIComponent(userId));
    const customRange = filters.rangeMode === 'custom';
    const days = filters.days == null ? 30 : (Number(filters.days) || 0);
    const fromTs = customRange ? new Date(String(filters.fromAt || '')).getTime()
      : (days > 0 ? Date.now() - days * 86400000 : 0);
    const toTs = customRange ? new Date(String(filters.toAt || '')).getTime() : Date.now();
    if (customRange && (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs < fromTs)) {
      throw Error('统计时间范围无效');
    }
    if (fromTs) clauses.push('ts=gte.' + Math.floor(fromTs));
    if (customRange) clauses.push('ts=lte.' + Math.floor(toTs));
    const brandId = String(filters.brandId || '');
    if (brandId === '__none__') clauses.push('or=' + encodeURIComponent('(brand_id.is.null,brand_id.eq."")'));
    else if (brandId) clauses.push('brand_id=eq.' + encodeURIComponent(brandId));
    else if (scope) clauses.push('brand_id=in.' + encodeURIComponent('(' + scope.map(id => JSON.stringify(id)).join(',') + ')'));
    const filterQuery = clauses.join('&');
    const top = await request('publish_log?select=id&' + filterQuery
      + '&order=id.desc&limit=1');
    if (!Array.isArray(top)) throw Error('云端返回格式错误');
    const max = top[0] ? Number(top[0].id) : 0;
    if (!max) return result;
    for (;;) {
      const page = await request('publish_log?select=id,result,ts,machine_id,machine_name,seq,batch_no,dir_name,brand_id&' + filterQuery
        + '&id=gt.' + cursor + '&id=lte.' + max + '&order=id.asc&limit=1000');
      if (!Array.isArray(page)) throw Error('云端返回格式错误');
      if (!page.length) break;
      for (const e of page) {
        if ((before && Number(e.ts) < before) || (scope && !scope.includes(String(e.brand_id || '')))
          || !['发布成功', '失败'].includes(e.result)
          || e.machine_id === '__probe__conn__' || /探针/.test(e.machine_name || '')) continue;
        const key = JSON.stringify([e.machine_name || e.machine_id || '', e.ts, e.seq, e.batch_no || '', e.dir_name || '', e.result, e.brand_id || '']);
        if (seen.has(key)) continue;
        seen.add(key);
        result.rows++; if (e.result === '发布成功') result.ok++; else result.fail++;
      }
      const next = Number(page[page.length - 1].id);
      if (!(next > cursor)) throw Error('云端分页游标无效');
      cursor = next;
      if (cursor >= max) break;
    }
    return result;
  } catch (e) { return { available: false, error: e.message }; }
}
module.exports = { cutoff, keep, apply, refresh, account, stateFile };
