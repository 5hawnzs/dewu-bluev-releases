// 清零、旧设备补传与超过 5000 条的全量分页回归，全部使用隔离目录与网络替身。
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-history-'));
const load = Module._load;
Module._load = function (r) { if (r === 'electron') return { app: { getPath: () => tmp } }; return load.apply(this, arguments); };
const store = require('../src/main/store'); store.load(); store.set({ paths: { output: tmp }, cloud: { enabled: true } });
const history = require('../src/main/services/publishhistory');
const sheet = require('../src/main/services/sheet');
const cs = require('../src/main/services/cloudsync');
const metrics = require('../web/metrics');
let failures = 0;
function ok(label, value) { console.log((value ? 'PASS ' : 'FAIL ') + label); if (!value) failures++; }
function fakeDb(records, cap = 1000, failAfter = -1) {
  let pages = 0;
  return { from() {
    let asc = true, from = 0, to = Infinity, limit = 1000, cols = '';
    const q = { select(v) { cols = v; return q; }, eq() { return q; },
      gt(_, v) { from = v; return q; }, lte(_, v) { to = v; return q; },
      order(_, v) { asc = v.ascending; return q; }, limit(v) { limit = v; return q; },
      then(resolve, reject) {
        if (cols !== 'id' && pages++ === failAfter) return Promise.resolve({ error: Error('中途断网') }).then(resolve, reject);
        const data = records.filter(e => e.id > from && e.id <= to).sort((a, b) => asc ? a.id - b.id : b.id - a.id).slice(0, Math.min(limit, cap));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    }; return q;
  } };
}
(async () => {
  const rows = Array.from({ length: 6151 }, (_, i) => ({ id: i + 1, ts: i, result: i % 2 ? '失败' : '发布成功', user_id: i % 3 ? 'a' : 'b', brand_id: i % 2 ? 'x' : 'y', username: '同名账号', display_name: '同名' }));
  const all = await metrics.readAll(fakeDb(rows), 'bluev', 'publish_log', 'ts,result');
  ok('全量分页超过 5000 条，无截断', !all.error && all.data.length === 6151);
  ok('全量结果按时间倒序，首尾完整', all.data[0].id === 6151 && all.data[6150].id === 1);
  const capped = await metrics.readAll(fakeDb(rows, 123), 'bluev', 'publish_log', 'ts');
  ok('服务端每页限制更小时仍继续取全', capped.data.length === 6151);
  const broken = await metrics.readAll(fakeDb(rows, 1000, 2), 'bluev', 'publish_log', 'ts');
  ok('中途失败不会把部分数据冒充全量', broken.data === null && !!broken.error);
  ok('空库正常返回空数组', (await metrics.readAll(fakeDb([]), 'bluev', 'publish_log', 'ts')).data.length === 0);
  const accounts = metrics.summarize(rows, 'account'), brands = metrics.summarize(rows, 'brand');
  ok('同名账号按账号 ID 区分', accounts.length === 2);
  ok('账号汇总总数与全量一致', accounts.reduce((n, v) => n + v.rows, 0) === 6151);
  ok('品牌汇总总数与全量一致', brands.length === 2 && brands.reduce((n, v) => n + v.ok + v.fail, 0) === 6151);
  const before = Date.now() - 10000;
  const file = sheet.logFile();
  fs.writeFileSync(file, [ { ts: before - 1 }, { ts: before, result: '发布成功' }, { ts: before + 1, result: '失败' } ].map(JSON.stringify).join('\n'));
  const run = path.join(tmp, 'run-log.jsonl'); fs.writeFileSync(run, '排错记录');
  ok('清零前仅删除旧发布台账', history.apply(before, file) && sheet.readLog().length === 2);
  ok('边界时间的新记录保留', sheet.readLog()[0].ts === before);
  ok('不删除排错运行日志', fs.readFileSync(run, 'utf8') === '排错记录');
  ok('重复执行不会清除新记录', !history.apply(before, file) && sheet.readLog().length === 2);
  history.apply(before - 1000, file);
  ok('清零时间不会倒退', history.cutoff() === before);
  fs.appendFileSync(file, '\n' + JSON.stringify({ ts: before - 5 }));
  ok('读台账不会重新显示旧设备恢复的历史', sheet.readLog().length === 2);
  global.fetch = async () => { throw Error('断网'); };
  ok('断网使用缓存时间继续清理旧记录', await history.refresh(file));
  fs.writeFileSync(run, '');
  fs.writeFileSync(cs.stateFile(), JSON.stringify({ offset: 1, uploaded: 0 }));
  const uploaded = [];
  global.fetch = async (url, opts = {}) => {
    if (url.includes('publish_history_control')) return { ok: true, json: async () => [{ before_ts: before }] };
    if (opts.method === 'POST') uploaded.push(...JSON.parse(opts.body));
    return { ok: true, status: 201, text: async () => '' };
  };
  const synced = await cs.syncOnce({ force: true });
  ok('统计先清零后同步也重置游标，不跳过新记录', synced.ok && uploaded.length === 2 && uploaded.every(e => e.ts >= before));
  const own = [{ id: 1, ts: before - 1, result: '发布成功', brand_id: 'brand-a' }, { id: 2, ts: before, result: '发布成功', brand_id: 'brand-a' }, { id: 3, ts: before + 1, result: '失败', brand_id: 'brand-b' }, { id: 4, ts: before + 2, result: '模拟成功', brand_id: 'brand-a' }];
  const requests = [];
  global.fetch = async url => {
    const q = new URL(url).searchParams; requests.push(q);
    const cursor = q.getAll('id').find(v => v.startsWith('gt.'));
    const filtered = own.filter(e => q.getAll('ts').every(v => v.startsWith('gte.') ? e.ts >= Number(v.slice(4)) : e.ts <= Number(v.slice(4)))
      && (!q.has('brand_id') || (q.get('brand_id').startsWith('eq.') ? q.get('brand_id') === 'eq.' + e.brand_id
        : JSON.parse('[' + q.get('brand_id').slice(4,-1) + ']').includes(e.brand_id))));
    return { ok: true, json: async () => cursor ? filtered.filter(e => e.id > Number(cursor.slice(3))).slice(0, 1)
      : (filtered.length ? [{ id: filtered[filtered.length - 1].id }] : []) };
  };
  const allTime = await history.account('my-account', { days:0 });
  ok('跨设备本账号汇总只统计清零后的真实结果', allTime.available && allTime.rows === 2 && allTime.ok === 1 && allTime.fail === 1);
  requests.length = 0;
  const ownResult = await history.account('my-account', { rangeMode:'custom', fromAt:new Date(before).toISOString(), toAt:new Date(before+1).toISOString(), brandId:'brand-b' });
  ok('自定义时间和品牌过滤传到每一页且只统计匹配结果', requests.length === 2 && requests.every(q => q.get('ts') === `gte.${before}` && q.getAll('ts').includes(`lte.${before+1}`)
    && q.get('brand_id') === 'eq.brand-b') && ownResult.rows === 1 && ownResult.fail === 1);
  ok('账号查询每一页均固定本账号 ID', requests.every(q => q.get('user_id') === 'eq.my-account'));
  const scoped = await history.account('my-account', { days:0, scopeIds:['brand-b'] });
  ok('未筛品牌时账号汇总仍只计算获授权品牌', scoped.rows === 1 && scoped.fail === 1);
  requests.length = 0;
  const denied = await history.account('my-account', { scopeIds:['brand-a'], brandId:'brand-b' });
  const otherUser = await history.account('my-account', { userId:'someone-else' });
  ok('无权品牌和不匹配执行人均返回筛选空结果，不借筛选切换身份', denied.available && denied.rows === 0 && otherUser.rows === 0 && !requests.length);
  await history.account('my-account', { days:7 });
  ok('预设最近七天也向云端发送时间范围', requests.length > 0 && requests.every(q => Math.abs(Number(q.get('ts').slice(4)) - (Date.now()-7*86400000)) < 5000));
  global.fetch = async () => { throw Error('断网'); };
  ok('账号云端读取失败显示不可用，绝不显示假零', !(await history.account('my-account')).available);
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create table public.publish_log(id bigint generated always as identity primary key,org text,ts bigint); grant select,insert on public.publish_log to anon; grant usage,select on sequence public.publish_log_id_seq to anon; insert into public.publish_log(org,ts) values ('bluev',1),('other',1);");
    const sql = fs.readFileSync(path.join(__dirname, '../docs/supabase-publish-history-reset.sql'), 'utf8');
    await db.exec(sql);
    const count = async org => Number((await db.query('select count(*) as n from public.publish_log where org=$1',[org])).rows[0].n);
    ok('真实 PostgreSQL 迁移删除 bluev 历史', await count('bluev') === 0);
    ok('清零不触碰其他组织的数据', await count('other') === 1);
    const epoch = Number((await db.query('select before_ts from public.publish_history_control')).rows[0].before_ts);
    await db.exec('set role anon');
    await db.query("insert into public.publish_log(org,ts) values ('bluev',$1),('bluev',$2)",[epoch - 1,epoch]);
    ok('旧客户端匿名补传被静默丢弃，新结果正常入库', await count('bluev') === 1);
    let denied = false;
    try { await db.exec('update public.publish_history_control set before_ts=0'); } catch (_) { denied = true; }
    ok('匿名不能篡改清零时间', denied);
    await db.exec('reset role'); await db.exec(sql);
    ok('SQL 重复执行不再次清除新发布', await count('bluev') === 1);
  } finally { await db.close(); }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
