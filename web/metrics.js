/* 全量分页与维度汇总：网页和回归共用同一份行为。 */
(function (root) {
  async function readAll(sb, org, table, columns) {
    try {
      const top = await sb.from(table).select('id').eq('org', org).order('id', { ascending: false }).limit(1);
      if (top.error) throw top.error;
      const max = top.data && top.data[0] ? Number(top.data[0].id) : 0;
      if (!max) return { data: [], error: null };
      const data = []; let cursor = 0;
      for (;;) {
        const page = await sb.from(table).select('id,' + columns).eq('org', org)
          .gt('id', cursor).lte('id', max).order('id', { ascending: true }).limit(1000);
        if (page.error) throw page.error;
        if (!Array.isArray(page.data)) throw Error('数据格式错误');
        if (!page.data.length) break;
        const next = Number(page.data[page.data.length - 1].id);
        if (!(next > cursor)) throw Error('分页游标无效');
        data.push(...page.data); cursor = next;
        if (cursor >= max) break;
      }
      data.sort((a, b) => Number(b.ts) - Number(a.ts) || Number(b.id) - Number(a.id));
      return { data, error: null };
    } catch (error) { return { data: null, error }; }
  }
  function summarize(rows, dimension) {
    const map = new Map();
    for (const r of rows) {
      const account = dimension === 'account';
      const key = account ? (r.user_id || r.username || '') : (r.brand_id || r.brand_name || '');
      const label = account ? (r.display_name || r.username || '未记录账号') : (r.brand_name || '未记录品牌');
      const v = map.get(key) || { key, label, username: r.username || '', rows: 0, ok: 0, fail: 0 };
      v.rows++; if (r.result === '发布成功') v.ok++; else if (r.result === '失败') v.fail++;
      map.set(key, v);
    }
    return [...map.values()].sort((a, b) => b.rows - a.rows);
  }
  const api = { readAll, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoardMetrics = api;
})(globalThis);
