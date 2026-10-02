'use strict';
/*
 * 云端同步（src/main/services/cloudsync.js）纯逻辑回归 —— 纯 Node，不联网、不开窗口。
 *
 * ★ 为什么这套必须存在：这条线一上线就跨机器了，出问题是**别人**的看板不对，
 *   而本机看上去一切正常（发布照发、本地台账照写）。下面钉死的是那几类「本机看不出来」的错：
 *     1. 关着的时候**一次都不许联网**（说「数据不出本机」就得真不出）；
 *     2. **增量**：第二次同步只推新增那几行，不许整本台账重推；
 *     3. **幂等头**必须在（撞唯一键就跳过）—— 网络重试长出重行，看板数字会翻倍；
 *     4. **脱敏**：上行的行里不许出现本机绝对路径，字段只许是那 17 个；
 *     5. **失败不推进游标**：推失败的行下次还得再推（否则云上永久缺几条，本机却显示「已同步」）；
 *     6. **台账被清空后游标要重置** —— 不重置的话它会永远指到行数之外，从此一行的推不上去；
 *     7. **失败不抛**：上行挂掉绝不能把发布拖下水；
 *     8. **源码不预置任何密钥**（默认值必须是空的）。
 *
 * 用法：node tools/cloudtest.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const cs = require(path.join(ROOT, 'src/main/services/cloudsync.js'));
const store = require(path.join(ROOT, 'src/main/store.js'));

let bad = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) bad++;
};

// ---- 临时台账目录（真写文件、真读文件，不用任何内存桩替代 IO）----
const dir = path.join(os.tmpdir(), 'bluev-cloudtest-' + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
try { fs.rmSync(cs.stateFile(), { force: true }); } catch (e) { /* 没有就算了 */ }

/** 造 n 条台账行。dir 故意带上本机绝对路径 —— 用来验证「上行时会被裁掉」 */
function seed(from, n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      ts: 1760000000000 + from + i,
      batch: 'B1', seq: from + i, id: 'SKU' + (from + i), dir: path.join(dir, '款A', 'p' + (from + i)),
      result: i % 3 === 0 ? '失败' : '发布成功', reason: i % 3 === 0 ? '找不到发布按钮' : '',
      retries: 0, elapsed: 12.3, mode: 'adb', kind: '图文',
      brandId: 'brd_1', brandName: '示例品牌', userId: 'u1', username: 'zhangsan', displayName: '张三'
    }));
  }
  fs.appendFileSync(path.join(dir, 'publish-log.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function setCfg(patch) {
  store.set({ paths: { output: dir }, cloud: Object.assign({ enabled: true, url: 'https://demo.supabase.co', anonKey: 'anon-test-key', machineId: 'm_test', machineName: '测试机', intervalSec: 30 }, patch) });
}

// ---- fetch 桩：记录每一次请求，**不允许真的发出去** ----
let calls = [];
let mode = 'ok';        // ok | http500 | throw
let lastBody = null;
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (mode === 'throw') throw new Error('ECONNREFUSED 连不上');
  if (mode === 'http500') return { ok: false, status: 500, text: async () => 'upstream error' };
  lastBody = opts.body ? JSON.parse(opts.body) : null;   // GET（test 连接）没有 body
  return { ok: true, status: 201, text: async () => '' };
};

console.log('A. 关着的时候不许联网，没配置也不许联网\n');
setCfg({ enabled: false });
calls = [];
let r = null;
(async () => {
  r = await cs.syncOnce();
  ok('★ 未启用 ⇒ 一次都不联网（「数据不出本机」不能只是句文案）', calls.length === 0 && r.skipped === '未启用', `联网 ${calls.length} 次 / ${r.skipped}`);
  ok('未启用时 status.enabled 如实为 false（界面不会显示成已连接）', cs.status().enabled === false, JSON.stringify({ enabled: cs.status().enabled }));

  setCfg({ url: '', anonKey: '' });
  calls = [];
  r = await cs.syncOnce();
  ok('★ 没填地址/key ⇒ 不联网，且如实报「还没填」（不许报成功）', calls.length === 0 && /还没填/.test(r.error || ''), r.error);

  console.log('\nB. 增量 + 幂等头 + 分批\n');
  setCfg({});
  seed(0, 3);
  calls = [];
  r = await cs.syncOnce();
  ok('首次同步推 3 条', r.ok && r.uploaded === 3, JSON.stringify(r));
  ok('★ 幂等头必须在（撞唯一键跳过，重试才不会长出重行）',
    /resolution=ignore-duplicates/.test(calls[0].opts.headers.Prefer || ''), calls[0].opts.headers.Prefer);
  ok('走的是 PostgREST 的插入接口', calls[0].url === 'https://demo.supabase.co/rest/v1/publish_log' && calls[0].opts.method === 'POST', calls[0].url);

  seed(3, 2);                       // 又发了 2 条
  calls = [];
  r = await cs.syncOnce();
  ok('★ 第二次只推新增的 2 条（不是整本重推 5 条）', r.ok && r.uploaded === 2 && lastBody.length === 2, JSON.stringify(r));
  ok('推完 pending 归零', r.pending === 0, r.pending);

  seed(5, 210);                     // 一次积压 210 条
  calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★ 超过 200 条会分批（210 = 200 + 10）', calls.length === 2 && r.uploaded === 210, `批数 ${calls.length} / 推了 ${r.uploaded}`);

  console.log('\nC. 脱敏：不许把本机绝对路径带出去\n');
  const row = cs.toRow({ ts: 1, seq: 7, dir: path.join(dir, '款A', 'p7'), reason: 'x'.repeat(400), result: '失败' }, { id: 'm_test', name: '测试机' });
  ok('★ dir 只留最后一段（款名），绝对路径一个字都不许出现',
    row.dir_name === 'p7' && !JSON.stringify(row).includes(dir.replace(/\\/g, '/')) && !JSON.stringify(row).includes(dir), row.dir_name);
  ok('★ reason 截断到 200（异常堆栈里常带路径）', row.reason.length === 200, row.reason.length);
  const want = ['ts', 'machine_id', 'machine_name', 'batch_no', 'seq', 'item_id', 'dir_name', 'kind', 'result', 'reason',
    'elapsed', 'retries', 'mode', 'brand_id', 'brand_name', 'user_id', 'username', 'display_name'];
  const got = Object.keys(row);
  ok('★ 字段就这 18 个，多一个都可能是把素材/路径带出去了',
    got.length === want.length && want.every(k => got.includes(k)), got.join(','));

  console.log('\nD. 失败：不抛、不推进游标、要退避\n');
  setCfg({});
  fs.rmSync(cs.stateFile(), { force: true });
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  seed(0, 4);
  mode = 'http500';
  calls = [];
  let threw = '';
  r = null;
  try { r = await cs.syncOnce({ force: true }); } catch (e2) { threw = e2.message; }
  ok('★ 上行失败**不抛**（绝不能把发布拖下水）', threw === '' && r && r.ok === false, threw || JSON.stringify(r));
  ok('失败原因如实带回来', /HTTP 500/.test(r.error || ''), r.error);
  ok('★ 失败后游标不前进（那 4 条下一轮还得再推，不许永久丢）', cs.status().offset === 0, cs.status().offset);

  mode = 'throw';
  calls = [];
  r = await cs.syncOnce({ force: true });
  ok('网络异常也是失败不抛', r.ok === false && /ECONNREFUSED/.test(r.error || ''), r.error);
  ok('★ 失败后排了退避（不会每秒重试把云端刷爆）', cs.status().nextTryAt > Date.now(), new Date(cs.status().nextTryAt).toISOString());
  calls = [];
  r = await cs.syncOnce();           // 不 force：应当被退避挡住
  ok('退避期内自动同步被跳过', calls.length === 0 && /退避/.test(r.skipped || ''), r.skipped || JSON.stringify(r));

  mode = 'ok';
  r = await cs.syncOnce({ force: true });
  ok('恢复后一次补齐 4 条（失败没吃掉数据）', r.ok && r.uploaded === 4, JSON.stringify(r));

  console.log('\nE. 台账被清空后游标要能自己回来\n');
  const before = cs.status().offset;
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  seed(0, 2);                        // 清理后只剩 2 条，游标却还停在 4
  calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★ 行数少于游标 ⇒ 重置后再推（否则从此一行都推不上去）',
    before === 4 && r.ok && r.uploaded === 2, `旧游标 ${before} → 推了 ${r.uploaded}`);
  ok('重置这件事被记进状态（界面上能看见，不是悄悄发生）', /重置/.test(cs.status().reset || ''), cs.status().reset);

  console.log('\nF. 密钥：不许预置、不许往外传\n');
  const d = store.defaults().cloud;
  ok('★ 出厂配置里地址与 key 都是空的（不许预置任何一个凭据）',
    d.url === '' && d.anonKey === '' && d.enabled === false, JSON.stringify(d));
  // ★ 负向断言只看**代码行**：注释里出现 service_role 是好事（那是警告），不该把断言打红
  const codeOnly = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const src = codeOnly(fs.readFileSync(path.join(ROOT, 'src/main/services/cloudsync.js'), 'utf8'));
  ok('★ 代码里不许出现 service_role（那个 key 能绕过 RLS 读写整表）', !/service_role/.test(src));
  ok('status() 里不含 key（密钥不往渲染层传）', !JSON.stringify(cs.status()).includes('anon-test-key'));

  const t = await cs.test();
  ok('test() 只查不改（GET + limit=1）', /select=machine_id&limit=1/.test(calls[calls.length - 1].url) && calls[calls.length - 1].opts.method === 'GET', calls[calls.length - 1].url);
  ok('test() 返回 ok', t.ok === true, JSON.stringify(t));

  console.log('\nG. 收尾\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e3) { /* 临时目录 */ }
  try { fs.rmSync(cs.stateFile(), { force: true }); } catch (e4) { /* 临时文件 */ }
  console.log('\n' + (bad ? `FAILED：${bad} 条不通过` : '全部通过'));
  process.exit(bad ? 1 : 0);
})();
