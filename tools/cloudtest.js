'use strict';
/*
 * 云端同步（src/main/services/cloudsync.js）纯逻辑回归 —— 纯 Node，不联网、不开窗口。
 *
 * ★ 为什么这套必须存在：这条线一上线就跨机器了，出问题是**别人**的看板不对，
 *   而本机看上去一切正常（发布照发、本地台账照写）。下面钉死的是那几类「本机看不出来」的错：
 *     1. 关着的时候**一次都不许联网**（说「数据不出本机」就得真不出）；
 *     2. **增量**：第二次同步只推新增那几行，不许整本台账重推；
 *     3. **幂等头**必须在（撞唯一键就跳过）—— 网络重试长出重行，看板数字会翻倍；
 *     4. **脱敏**：上行的行里不许出现本机绝对路径，列名只许是白名单里那 19 个；
 *     5. **失败不推进游标**：推失败的行下次还得再推（否则云上永久缺几条，本机却显示「已同步」）；
 *     6. **台账被清空后游标要重置** —— 不重置的话它会永远指到行数之外，从此一行的推不上去；
 *     7. **失败不抛**：上行挂掉绝不能把发布拖下水；
 *     8. **内置的只能是 anon / publishable key**（service_role / secret 绝不许进包或进客户端）；
 *     9. **导出 / 导入配置要先校验**：地址不合法、或粘进 service_role，都必须拦下；
 *    10. **留空 ⇒ 跟随内置，且绝不写回配置**（写回＝固化进 config.json，而它卸载都不删
 *        ⇒ 以后重打包换了内置值，老机器仍连旧地址、界面上还看不出来。实测：D:\work\_e2e\_freeze-probe.js）。
 *
 * 用法：node tools/cloudtest.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const cs = require(path.join(ROOT, 'src/main/services/cloudsync.js'));
const store = require(path.join(ROOT, 'src/main/store.js'));
const CD = require(path.join(ROOT, 'src/main/clouddefaults.js'));

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
let mode = 'ok';        // ok | http500 | throw | tableMissing | dupAll | dupMixed | other409
let postSeq = 0;        // 当前 mode 下第几次**写**请求（用来演「整批先 409、逐行时新的那几行能进」）
let lastBody = null;
// PostgREST 的真实回包原文（照抄实测回来的，别自己编）
const NO_TABLE_BODY = '{"code":"PGRST205","details":null,"hint":"Perhaps you meant the table \'public.app_users\'","message":"Could not find the table \'public.publish_log\' in the schema cache"}';
// 「撞唯一索引 publish_log_dedup」的真实回包 —— 2026-10-02 对真库重复插入实测所得（HTTP 409）
const DUP_BODY = '{"code":"23505","details":null,"hint":null,"message":"duplicate key value violates unique constraint \\"publish_log_dedup\\""}';
// on_conflict 指名的列上没有对应唯一约束时的真实回包（用来验「非唯一冲突不许被当成已存在吞掉」）
const NO_CONSTRAINT_BODY = '{"code":"42P10","details":null,"hint":null,"message":"there is no unique or exclusion constraint matching the ON CONFLICT specification"}';
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (mode === 'throw') throw new Error('ECONNREFUSED 连不上');
  if (mode === 'http500') return { ok: false, status: 500, text: async () => 'upstream error' };
  if (mode === 'tableMissing') return { ok: false, status: 404, text: async () => NO_TABLE_BODY };
  // 服务端**没**按 on_conflict 去重：整批与逐行都撞唯一键
  if (mode === 'dupAll') { postSeq++; return { ok: false, status: 409, text: async () => DUP_BODY }; }
  // 409 但**不是**唯一冲突（on_conflict 指的列没有唯一约束）—— 绝不许被当「已存在」放过
  if (mode === 'other409') { postSeq++; return { ok: false, status: 409, text: async () => NO_CONSTRAINT_BODY }; }
  // 真实兜底场景：整批 409；逐行时第 1 行确实已在云上（也 409），其余是新行（能进）
  if (mode === 'dupMixed') {
    postSeq++;
    return postSeq <= 2
      ? { ok: false, status: 409, text: async () => DUP_BODY }
      : { ok: true, status: 201, text: async () => '' };
  }
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

  // 留空 ⇒ 读时落回内置的组织默认值 —— 这就是「各台机器不用手填」的实现
  setCfg({ url: '', anonKey: '' });
  const st0 = cs.status();
  ok('★ 地址/key 留空 ⇒ 读时落回内置的组织值（装上就能连）',
    st0.configured === true && st0.url === CD.url, st0.url);
  ok('★ 留空时如实标着「跟随内置」（界面靠它说清实际在用的是哪个地址）',
    st0.urlSource === 'builtin' && st0.builtinUrl === CD.url,
    JSON.stringify({ src: st0.urlSource, builtin: st0.builtinUrl }));
  // ★★ 第六轮：这里原先守的是「清空后『存下来的』也必须等于内置值」（靠 applyCloudDefaults 把值写回）。
  //    那条断言现在**反过来**了：写回＝固化进 config.json，而 config.json 卸载都不删 ⇒
  //    以后重打包换了内置值，老机器仍连旧地址，界面上还看不出区别。
  //    现在守的是「**别写回**」：留空就一直留空，跟随内置由**读取时**兜底。
  ok('★★ 留空不会被写回配置（写回就固化了，新包再也顶不动它）',
    store.get('cloud.url') === '' && cs.explicitOf().url === '', JSON.stringify(store.get('cloud.url')));
  setCfg({ url: 'https://mine.supabase.co' });
  ok('★ 本机显式填的地址不许被内置值顶回去，且如实标成「本机指定」',
    store.get('cloud.url') === 'https://mine.supabase.co' && cs.status().urlSource === 'custom',
    JSON.stringify({ stored: store.get('cloud.url'), src: cs.status().urlSource }));
  setCfg({ url: '' });
  ok('★ 把框清空 ⇒ 回到跟随内置（撤回得掉，不会卡在「本机指定」）',
    store.get('cloud.url') === '' && cs.status().url === CD.url && cs.status().urlSource === 'builtin',
    JSON.stringify({ stored: store.get('cloud.url'), url: cs.status().url }));
  setCfg({});

  console.log('\nB. 增量 + 幂等头 + 分批\n');
  setCfg({});
  seed(0, 3);
  calls = [];
  r = await cs.syncOnce();
  ok('首次同步推 3 条', r.ok && r.uploaded === 3, JSON.stringify(r));
  ok('★ 幂等头必须在（撞唯一键跳过，重试才不会长出重行）',
    /resolution=ignore-duplicates/.test(calls[0].opts.headers.Prefer || ''), calls[0].opts.headers.Prefer);
  // ★★ 这行断言在 2026-10-02 改过，理由要留档：原来只查到 /rest/v1/publish_log 为止，
  //    于是「URL 上忘了写 ?on_conflict=」这个致命疏漏**断不出来** —— Prefer 头那半还写着
  //    resolution=ignore-duplicates，看上去完全正常。实测：只写 Prefer 而不写 on_conflict，
  //    服务端根本不去重 ⇒ 重复行整批 409 + 23505（真库实证见 _supa-idem.js 的 A/B/C/D 对照）。
  //    所以这里把冲突目标一起焊进 URL 断言里。
  ok('★ 走的是 PostgREST 的插入接口，且冲突目标列写全了（?on_conflict=machine_id,ts,seq）',
    calls[0].url === 'https://demo.supabase.co/rest/v1/publish_log?on_conflict=machine_id,ts,seq' && calls[0].opts.method === 'POST',
    calls[0].url);

  seed(3, 2);                       // 又发了 2 条
  calls = [];
  r = await cs.syncOnce();
  ok('★ 第二次只推新增的 2 条（不是整本重推 5 条）', r.ok && r.uploaded === 2 && lastBody.length === 2, JSON.stringify(r));
  ok('推完 pending 归零', r.pending === 0, r.pending);

  seed(5, 210);                     // 一次积压 210 条
  calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★ 超过 200 条会分批（210 = 200 + 10）', calls.length === 2 && r.uploaded === 210, `批数 ${calls.length} / 推了 ${r.uploaded}`);

  console.log('\nB2. 幂等：重复批不许把同步卡死（v1.0.5 实测故障的回归）\n');
  // ★★ 故障复盘：v1.0.5 的发法是「只带 Prefer: resolution=ignore-duplicates、URL 上不写 ?on_conflict=」
  //    ⇒ 服务端不去重 ⇒ 重复行整批 409 + 23505 ⇒ postRows 抛错 ⇒ syncOnce 的 catch **不推进游标**
  //    ⇒ 每一轮都在同一批上重撞 ⇒ 同步永久卡死，而界面只显示「同步失败」四个字。
  //    修法两处：① URL 补上 on_conflict（上面那条断言焊住）；② 真撞上唯一冲突时**逐行兜底**。
  //    下面守的是 ② —— 纯结构性断言（「代码里有 on_conflict 这几个字」）证明不了它，必须喂真回包看行为。
  fs.rmSync(cs.stateFile(), { force: true });
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  seed(0, 4);
  mode = 'dupAll'; postSeq = 0; calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★★ 整批唯一冲突不许被判成失败（判失败 ⇒ 游标不动 ⇒ 下一轮同一批再撞 ⇒ 永久卡死）',
    r.ok === true && r.uploaded === 4, JSON.stringify(r));
  ok('★ 兜底是逐行重发：1 次整批 + 4 次单行（不是整批一丢了事）',
    calls.length === 5, `请求 ${calls.length} 次`);
  ok('★ 每一行都真的单独发过（整批跳过＝丢新行，那正是不能接受的那半）',
    calls.slice(1).length === 4 && calls.slice(1).every(c => JSON.parse(c.opts.body).length === 1),
    JSON.stringify(calls.slice(1).map(c => JSON.parse(c.opts.body).length)));
  const offDup = cs.status().offset;
  mode = 'ok'; postSeq = 0; calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★★ 兜底之后游标真的前进了：再同步一次不联网、不重推（「没卡死」的可测判据）',
    offDup === 4 && calls.length === 0 && r.ok === true && r.uploaded === 0,
    `游标 ${offDup} / 再同步联网 ${calls.length} 次 / 重推 ${r.uploaded} 条`);

  // 真实兜底场景：整批里混着「已在云上」与「真正的新行」—— 新的那几行必须补得上去
  fs.rmSync(cs.stateFile(), { force: true });
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  seed(0, 4);
  mode = 'dupMixed'; postSeq = 0; calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★★ 整批 409 里混着新行：逐行补发后新行进得去（整批放弃就会丢这几行）',
    r.ok === true && r.uploaded === 4 && calls.length === 5,
    JSON.stringify(r) + ` / 请求 ${calls.length} 次`);
  ok('★ 混场景下游标照样覆盖整批（已存在的算已上行，新的算已补发）', cs.status().offset === 4, cs.status().offset);

  // 反向：409 但**不是**唯一冲突 —— 绝不许被当成「已存在」吞掉（那会静默丢数据）
  fs.rmSync(cs.stateFile(), { force: true });
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  seed(0, 4);
  mode = 'other409'; postSeq = 0; calls = [];
  r = await cs.syncOnce({ force: true });
  ok('★★ 409 但 code 不是 23505（如 42P10「没有匹配的唯一约束」）⇒ 照旧判失败、游标不动、如实报错',
    r.ok === false && cs.status().offset === 0 && /42P10|HTTP 409/.test(r.error || ''), JSON.stringify(r));
  ok('★ 而且它没被逐行兜底偷偷放过去（请求只有整批那一次）', calls.length === 1, `请求 ${calls.length} 次`);
  mode = 'ok'; postSeq = 0;

  console.log('\nC. 脱敏：不许把本机绝对路径带出去\n');
  const row = cs.toRow({ ts: 1, seq: 7, dir: path.join(dir, '款A', 'p7'), reason: 'x'.repeat(400), result: '失败' }, { id: 'm_test', name: '测试机' });
  ok('★ dir 只留最后一段（款名），绝对路径一个字都不许出现',
    row.dir_name === 'p7' && !JSON.stringify(row).includes(dir.replace(/\\/g, '/')) && !JSON.stringify(row).includes(dir), row.dir_name);
  ok('★ reason 截断到 200（异常堆栈里常带路径）', row.reason.length === 200, row.reason.length);
  // ★ 白名单式断言：**逐个列名对**，不是只数个数 —— 偷偷加一列「素材路径」也会被这里抓住
  const want = ['org', 'ts', 'machine_id', 'machine_name', 'batch_no', 'seq', 'item_id', 'dir_name', 'kind', 'result', 'reason',
    'elapsed', 'retries', 'mode', 'brand_id', 'brand_name', 'user_id', 'username', 'display_name'];
  const got = Object.keys(row);
  ok('★ 字段就这 19 个（19 = 18 + 组织标识 org），多一个都可能是把素材/路径带出去了',
    got.length === want.length && want.every(k => got.includes(k)), got.join(','));
  // ★ 上面这个 row 的 machine 是**故意不带 org 的**（模拟「调用方忘了传」）——
  //   正好把兜底也一起验了：漏了 org 不是「少一列」，而是整批被 RLS 拒收，而界面只说「同步失败」。
  ok('★ 上行里带上了 org（insert 策略要按它校验，走错组织的行进不来）',
    row.org === 'bluev', String(row.org));
  ok('★ 调用方漏传 org 也不许变成 undefined（否则整批喂给 RLS 被拒收，界面只显示同步失败）',
    cs.toRow({ ts: 1, dir: 'X' }, { id: 'm_x', name: 'n' }).org === 'bluev',
    String(cs.toRow({ ts: 1, dir: 'X' }, { id: 'm_x', name: 'n' }).org));
  ok('★ machine 里显式给了 org 就用它（兜底不能盖掉显式值）',
    cs.toRow({ ts: 1, dir: 'X' }, { id: 'm_x', name: 'n', org: 'other-org' }).org === 'other-org',
    String(cs.toRow({ ts: 1, dir: 'X' }, { id: 'm_x', name: 'n', org: 'other-org' }).org));

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

  console.log('\nF. 凭据：内置的是 anon，绝不许是 service_role\n');
  const d = store.defaults().cloud;
  ok('★ 出厂**绝不把云地址写进配置**（url/key/org 留空＝跟随内置；写了就会固化，见 store.js 长注释）',
    d.url === '' && d.anonKey === '' && d.org === '' && d.enabled === true,
    JSON.stringify({ url: d.url, key: d.anonKey, org: d.org, enabled: d.enabled }));
  // ★★ 「固化」最容易发生的入口不是有人手填，而是**在高级设置页改任何一个选项**：
  //    saveCfgFromDom 会把那一页所有 [data-cfg] 控件的值整体提交；scheduleSave 又把整个 cache 写盘。
  //    所以必须证明「改无关设置」也不会把云地址带进配置（先清空成「跟随内置」的常态，再改无关项）。
  setCfg({ url: '', anonKey: '', org: '' });
  store.set({ ui: { theme: 'dark' }, publish: { retry: 1 } });
  ok('★★ 改无关设置（主题 / 重试次数）也不会把云地址固化进配置',
    store.get('cloud.url') === '' && store.get('cloud.anonKey') === '' && store.get('cloud.org') === '',
    JSON.stringify({ url: store.get('cloud.url'), key: store.get('cloud.anonKey'), org: store.get('cloud.org') }));
  ok('★★ 而且它仍然连得上：留空后 status 如实报出内置地址与「跟随内置」',
    cs.status().url === CD.url && cs.status().urlSource === 'builtin' && cs.status().configured === true,
    JSON.stringify({ url: cs.status().url, src: cs.status().urlSource }));
  // ★ 负向断言只看**代码行**：注释里出现 service_role 是好事（那是警告），不该把断言打红
  const codeOnly = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // ★★ 结构性负向断言：**配置层不许认识内置凭据**。
  //    它一旦 require 进来，就一定会有人「顺手把默认值补进去」⇒ 固化 ⇒ 新包顶不动老机器。
  const storeSrc = codeOnly(fs.readFileSync(path.join(ROOT, 'src/main/store.js'), 'utf8'));
  ok('★ store 不再 require clouddefaults（不认识内置值 ⇒ 没人能把它写回配置）',
    !/require\(['"]\.\/clouddefaults['"]\)/.test(storeSrc));
  ok('★ applyCloudDefaults 已整块删除（它在时会把内置值写回配置，于是新包顶不动老机器）',
    !/applyCloudDefaults\s*\(/.test(storeSrc));
  const src = codeOnly(fs.readFileSync(path.join(ROOT, 'src/main/services/cloudsync.js'), 'utf8'));
  // ★★ 这条断言本身在 2026-10-02 被改过一次，理由要留档：
  //   原写法是「代码里不许出现 service_role 四个字」。加了「导入配置」后它**必然误报** ——
  //   代码里必须出现它，那正是**主动把它拦下来**的那行判断（看起来像漏洞，其实是防线）。
  //   所以改成查语义，两条一起看：
  //     ① 正面：真存在那条拦截（防止将来有人把拦截删了，只在注释里说「已拦下」）；
  //     ② 负面：全文件不许出现任何**凭据字面量**（JWT 本体 / sb_secret_ 开头的 key）。
  ok('★ 代码里真有「粘进 service_role 就拦下」的实质判断（不是只在注释里说说而已）',
    /if \(\/service_role\|secret\/i\.test\(key\)\)/.test(src));
  ok('★ 且全文件找不到任何凭据字面量（JWT 本体 / sb_secret_ 开头的 key 都不许有）',
    !/eyJ[A-Za-z0-9_-]{20,}/.test(src) && !/sb_secret_/.test(src));
  const cdSrc = codeOnly(fs.readFileSync(path.join(ROOT, 'src/main/clouddefaults.js'), 'utf8'));
  ok('★ 内置文件只有 url / anonKey / org 三个键（多一个都可能是把别的凭据塞进包里）',
    Object.keys(CD).sort().join(',') === 'anonKey,org,url', Object.keys(CD).sort().join(','));
  ok('★ 内置的文件里不许出现 service_role / secret', !/service_role|secret/i.test(cdSrc));
  ok('status() 里不含 key（密钥不往渲染层传）', !JSON.stringify(cs.status()).includes('anon-test-key'));

  const t = await cs.test();
  ok('test() 只查不改（GET + limit=1）', /select=machine_id&limit=1/.test(calls[calls.length - 1].url) && calls[calls.length - 1].opts.method === 'GET', calls[calls.length - 1].url);
  ok('test() 返回 ok', t.ok === true, JSON.stringify(t));
  // ★★ 每个人第一次用必然走这条路：凭据已内置、项目能连通，但**表还没建**。
  //    这时候必须把「去控制台跑一次建表 SQL」说清楚 —— 甩一段 PGRST205 的英文 JSON 等于没说。
  mode = 'tableMissing';
  const t404 = await cs.test();
  ok('★★ 表还没建 ⇒ 直说要跑 supabase-setup.sql（不是甩一串 PostgREST JSON）',
    t404.ok === false && /还没建/.test(t404.error || '') && /supabase-setup\.sql/.test(t404.error || ''),
    t404.error);
  mode = 'ok';

  console.log('\nG. 下发配置：导出 / 导入都要先校验\n');
  const exp = cs.exportConfig();
  ok('导出的是 anon，不是别的（含 url/anonKey/org 三项）',
    exp.ok && !!exp.url && !!exp.anonKey && !!exp.org, JSON.stringify({ url: exp.url, org: exp.org }));

  const impBad1 = await cs.importConfig({ url: 'ftp://随便一个地址', anonKey: 'x' });
  ok('★ 地址不合法 ⇒ 拦下（粘错地址会让所有机器一起失联）', impBad1.ok === false && /地址看着不对/.test(impBad1.error), impBad1.error);

  const impBad2 = await cs.importConfig({ url: 'https://demo.supabase.co', anonKey: 'xxxxx_service_role_xxxxx' });
  ok('★★ 粘进 service_role ⇒ 拦下（那个 key 绕过 RLS，绝不能进客户端）',
    impBad2.ok === false && /service_role|secret/i.test(impBad2.error), impBad2.error);

  const beforeUrl = store.get('cloud.url');
  const impOk = await cs.importConfig({ url: 'https://other.supabase.co', anonKey: 'anon-other-key', org: 'bluev' });
  ok('合法配置 ⇒ 保存并连上', impOk.ok === true && store.get('cloud.url') === 'https://other.supabase.co',
    `${beforeUrl} → ${store.get('cloud.url')}`);
  ok('★ 导入后立刻生效（不用重启）', /other\.supabase\.co/.test(calls[calls.length - 1].url), calls[calls.length - 1].url);
  setCfg({});   // 还原，免得影响后面的套件

  console.log('\nH. 看板与 App 的内置值必须是同一份\n');
  // ★ 「统一设置」这件事有两个落点：App 的 clouddefaults.js 与看板的 BUILTIN 常量。
  //   两处各写一份 ⇒ 迟早只改一处，然后就变成「App 在推 A 项目、看板在看 B 项目」，
  //   界面上两边都显示「已连接」，谁都没错 —— 这种错最难查。所以用一条断言把它焊住。
  const boardSrc = fs.readFileSync(path.join(ROOT, 'web', 'board.html'), 'utf8');
  const pick = re => { const m = boardSrc.match(re); return m ? m[1] : ''; };
  const bUrl = pick(/url:\s*'([^']+)'/), bKey = pick(/key:\s*'([^']+)'/), bOrg = pick(/org:\s*'([^']+)'/);
  ok('★★ 看板预填的 url / key / org 与 App 内置的完全一致（改一处必须同时改另一处）',
    bUrl === CD.url && bKey === CD.anonKey && bOrg === CD.org,
    JSON.stringify({ board: { url: bUrl, keyHead: bKey.slice(0, 14), org: bOrg }, app: { url: CD.url, keyHead: CD.anonKey.slice(0, 14), org: CD.org } }));
  ok('★ 看板是只读的：只 select、按 org 过滤（它不该有任何写操作）',
    /\.select\('ts,/.test(boardSrc) && /\.eq\('org', ORG\)/.test(boardSrc)
      && !/\.insert\(|\.update\(|\.delete\(/.test(boardSrc));
  ok('★★ 看板里不许有任何真凭据（sb_secret_ / JWT 字面量），注释里提 service_role 不算',
    !/sb_secret_/.test(boardSrc) && !/eyJ[A-Za-z0-9_-]{20,}/.test(boardSrc));

  console.log('\nI. 收尾\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e3) { /* 临时目录 */ }
  try { fs.rmSync(cs.stateFile(), { force: true }); } catch (e4) { /* 临时文件 */ }
  console.log('\n' + (bad ? `FAILED：${bad} 条不通过` : '全部通过'));
  process.exit(bad ? 1 : 0);
})();
