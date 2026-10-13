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
 *    11. **失败信息必须带出底层原因**：`fetch` 在网络层失败时 message 只有 `fetch failed` 六个字，
 *        真因在 `cause` 里（ENOTFOUND / ECONNRESET / ETIMEDOUT…）。丢掉 cause ＝ 事后无法定性
 *        （2026-10-08 排查「时不时云端同步失败」正是卡在这里）。
 *    12. **失败要落盘**：`logbus` 只进内存、成功后 `lastError` 又被清空 ⇒ 不落盘就零证据。
 *    13. **「无待上行」那一轮要把上一次的失败标记清掉**（否则台账一被清理，offset 归零、slice 恒为空，
 *        从此永远走不到成功分支 ⇒ 界面上「同步失败」永不消失，而云上其实是齐的）。
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
let usageReply = null;
// PostgREST 的真实回包原文（照抄实测回来的，别自己编）
const NO_TABLE_BODY = '{"code":"PGRST205","details":null,"hint":"Perhaps you meant the table \'public.app_users\'","message":"Could not find the table \'public.publish_log\' in the schema cache"}';
// 「撞唯一索引 publish_log_dedup」的真实回包 —— 2026-10-02 对真库重复插入实测所得（HTTP 409）
const DUP_BODY = '{"code":"23505","details":null,"hint":null,"message":"duplicate key value violates unique constraint \\"publish_log_dedup\\""}';
// on_conflict 指名的列上没有对应唯一约束时的真实回包（用来验「非唯一冲突不许被当成已存在吞掉」）
const NO_CONSTRAINT_BODY = '{"code":"42P10","details":null,"hint":null,"message":"there is no unique or exclusion constraint matching the ON CONFLICT specification"}';
globalThis.fetch = async (url, opts) => {
  // 本套件统计上传请求；清零策略查询由 historytest 专项覆盖。
  if (/\/publish_(?:account_)?history_control\?/.test(String(url))) return { ok: true, json: async () => [] };
  calls.push({ url, opts });
  if (opts.method === 'GET' && String(url).includes('/run_log?') && usageReply) {
    const u = new URL(String(url));
    let data = usageReply.slice();
    if (u.searchParams.get('select') === 'id') {
      data.sort((a,b) => Number(b.id)-Number(a.id));
      data = data.slice(0,1).map(x => ({ id:x.id }));
    } else {
      const and = decodeURIComponent(u.searchParams.get('and') || '');
      const gt = Number((/id\.gt\.(\d+)/.exec(and) || [])[1] || 0);
      const lte = Number((/id\.lte\.(\d+)/.exec(and) || [])[1] || Number.MAX_SAFE_INTEGER);
      data = data.filter(x => Number(x.id)>gt && Number(x.id)<=lte).sort((a,b) => Number(a.id)-Number(b.id)).slice(0,1);
    }
    return { ok: true, status: 200, json: async () => data };
  }
  if (mode === 'tableMissingRun' && String(url).includes('/run_log?')) return {
    ok: false, status: 404, text: async () => '{"code":"PGRST205","message":"Could not find the table public.run_log in the schema cache"}'
  };
  if (mode === 'throw') throw new Error('ECONNREFUSED 连不上');
  // 真实形状：Node 的 fetch 在网络层失败时抛的是 TypeError('fetch failed')，真因挂在 cause 上
  // （照抄 2026-10-08 实测回包：DNS 失败 ⇒ cause.code = ENOTFOUND）
  if (mode === 'throwCause') {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND rywurhpkovyjpjyvfjdz.supabase.co'), { code: 'ENOTFOUND' });
    throw e;
  }
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
  fs.writeFileSync(path.join(dir, 'run-log.jsonl'), JSON.stringify({
    eventId: 'historic-event', ts: 1750000000000, kind: 'end', ok: false, error: '旧版历史任务'
  }) + '\n', 'utf8');
  seed(0, 3);
  calls = [];
  r = await cs.syncOnce();
  ok('首次同步推 3 条发布结果，旧运行日志不回填', r.ok && r.uploaded === 3 && r.runUploaded === 0 && r.pendingRun === 0, JSON.stringify(r));
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

  // 只同步新写入的任务起止事件，不上传过程明细；错误摘要必须过滤路径与凭据。
  const appendRun = e => fs.appendFileSync(path.join(dir, 'run-log.jsonl'), JSON.stringify(e) + '\n', 'utf8');
  appendRun({ eventId: 'task-start-1', ts: 1760000000100, kind: 'start', jobId: 'j1', type: 'publish.run', label: '批次甲', batch: 'B1',
    brandId: 'brd_1', brandName: '示例品牌', userId: 'u1', username: 'zhangsan', displayName: '张三' });
  appendRun({ eventId: 'task-detail-1', ts: 1760000000200, kind: 'log', msg: '内部路径 C:\\Users\\Alice\\private\\content.txt' });
  appendRun({ eventId: 'task-end-1', ts: 1760000000300, kind: 'end', ok: false, jobId: 'j1', type: 'publish.run', label: '批次甲', batch: 'B1',
    brandId: 'brd_1', brandName: '示例品牌', userId: 'u1', username: 'zhangsan', displayName: '张三', elapsedSec: 18.4,
    error: '打不开 C:\\Users\\Alice\\private\\content.txt Bearer abc.def.secret',
    diagnostic: { version: '1.1.1', build: 2026101208, phase: '清理素材文件', row: 2,
      failures: [{ op: 'find', ms: 8001, timeoutMs: 8000, killed: true, signal: 'SIGTERM', source: 'bundled' }], commands: [] } });
  appendRun({ eventId: 'copy-end-1', ts: 1760000000310, kind: 'end', ok: true, jobId: 'jcopy', type: 'copy.generate',
    apiUsage: { version: 1, requests: 1, inputTokens: 100, outputTokens: 50, cachedInputTokens: 10,
      estimatedCostCny: 0.0002, costKnown: true, models: ['deepseek-flash'],
      byMedia: { image: { requests: 1, inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, estimatedCostCny: 0.0002, costKnown: true } },
      prompt: 'must not upload', apiKey: 'must-not-upload' },
    brandId: 'brd_1', brandName: '示例品牌', userId: 'u1', username: 'zhangsan', displayName: '张三' });
  appendRun({ eventId: 'phase-end-1', ts: 1760000000320, kind: 'end', ok: true, jobId: 'j1', type: 'publish.phase',
    label: '第1条 · 推送及索引素材', elapsedSec: 2.3, brandId: 'brd_1', brandName: '示例品牌',
    diagnostic: { version: '1.1.1', build: 2026101302, phase: '推送及索引素材', row: 1, commands: [], failures: [] } });
  calls = [];
  r = await cs.syncOnce();
  const runCall = calls.find(c => /\/run_log\?/.test(c.url));
  const uploadedTasks = runCall ? JSON.parse(runCall.opts.body) : [];
  ok('发布结果无新增时仍会独立同步任务日志', r.ok && r.uploaded === 0 && r.runUploaded === 4 && r.pendingRun === 0, JSON.stringify(r));
  ok('运行日志走独立表与幂等键', !!runCall && runCall.url.endsWith('/run_log?on_conflict=machine_id,event_id')
    && /resolution=ignore-duplicates/.test(runCall.opts.headers.Prefer || ''), runCall && runCall.url);
  ok('只上传 start/end，不上传逐步过程 log', uploadedTasks.length === 4
    && uploadedTasks.every(x => x.event_kind === 'start' || x.event_kind === 'end'), JSON.stringify(uploadedTasks.map(x => x.event_kind)));
  ok('错误摘要已过滤绝对路径与 bearer 凭据并保留定位信息',
    uploadedTasks[1].error_summary.includes('[本机路径]') && uploadedTasks[1].error_summary.includes('Bearer [已隐藏]')
      && !uploadedTasks[1].error_summary.includes('C:\\Users\\Alice') && uploadedTasks[1].username === 'zhangsan'
      && uploadedTasks[1].machine_name === '测试机', uploadedTasks[1].error_summary);
  const phase = uploadedTasks.find(x => x.task_type === 'publish.phase');
  ok('成功阶段也上传真实耗时、构建、行号和阶段，不再只有失败诊断',
    phase && phase.elapsed_sec === 2.3 && /2026101302/.test(phase.error_summary)
    && /推送及索引素材/.test(phase.error_summary));
  const spacedPathError = cs.safeRunText("打开失败 'C:\\Users\\Alice Smith\\private file.txt'");
  ok('含空格且被引号包住的 Windows 路径也会整体脱敏',
    spacedPathError.includes('[本机路径]') && !spacedPathError.includes('Alice Smith'), spacedPathError);
  ok('任务上行字段只含已授权白名单',
    Object.keys(uploadedTasks[0]).join(',') === 'org,event_id,ts,machine_id,machine_name,task_id,event_kind,task_type,task_label,batch_no,brand_id,brand_name,user_id,username,display_name,ok,cancelled,elapsed_sec,error_summary,api_usage',
    Object.keys(uploadedTasks[0]).join(','));
  ok('失败诊断自动进入现有云端错误摘要，不新增数据库字段',
    uploadedTasks[1].error_summary.startsWith('[诊断 1.1.1/2026101208')
      && uploadedTasks[1].error_summary.includes('find:8001ms') && uploadedTasks[1].error_summary.includes('SIGTERM')
      && uploadedTasks[1].error_summary.includes('limit=8000'), uploadedTasks[1].error_summary);
  const uploadedUsage = uploadedTasks.find(x => x.task_type === 'copy.generate').api_usage;
  ok('AI 用量只上传模型/token/估算字段，过滤任何额外内容', uploadedUsage.inputTokens === 100
    && uploadedUsage.byMedia.image.requests === 1 && !JSON.stringify(uploadedUsage).includes('must not upload')
    && !JSON.stringify(uploadedUsage).includes('must-not-upload'), JSON.stringify(uploadedUsage));

  usageReply = [{ id:1, ts: 1760000000300, brand_id: 'brd_1', brand_name: '示例品牌', user_id: 'u1', username: 'zhangsan',
    display_name: '张三', api_usage: uploadedUsage }];
  const costQuery = await cs.queryApiUsage({ fromTs: 1760000000000, toTs: 1760000000400, userId: 'u1', scopeIds: ['brd_1'] });
  ok('费用查询按账号、品牌和日期过滤并汇总 token 与金额', costQuery.ok && costQuery.rows.length === 1
    && costQuery.rows[0].userId === 'u1' && costQuery.rows[0].brandId === 'brd_1'
    && costQuery.total.inputTokens === 100 && costQuery.total.estimatedCostCny === 0.0002,
    JSON.stringify(costQuery));
  ok('费用查询 URL 带日期和账号筛选', calls.some(c => c.opts.method === 'GET' && /user_id=eq\.u1/.test(c.url)
    && /ts\.gte\.1760000000000/.test(decodeURIComponent(c.url)) && /ts\.lte\.1760000000400/.test(decodeURIComponent(c.url))),
    calls.filter(c => c.opts.method === 'GET').map(c => c.url).join('\n'));
  calls = [];
  usageReply = [
    { id:1, ts:1760000000300, brand_id:'brd_1', brand_name:'示例品牌', user_id:'u1', username:'zhangsan', display_name:'张三', api_usage:uploadedUsage },
    { id:2, ts:1760000000350, brand_id:'brd_2', brand_name:'另一品牌', user_id:'u2', username:'lisi', display_name:'李四', api_usage:Object.assign({}, uploadedUsage,
      { inputTokens:200, outputTokens:80, estimatedCostCny:0.0003 }) }
  ];
  const pagedCost = await cs.queryApiUsage({ fromTs:1760000000000, toTs:1760000000400 });
  const usageReads = calls.filter(c => c.opts.method === 'GET' && /\/run_log\?/.test(c.url));
  ok('费用汇总用主键游标分页；服务器每页只返 1 条也能取全量',pagedCost.ok && pagedCost.rows.length===2
    && pagedCost.total.inputTokens===300 && pagedCost.total.outputTokens===130 && pagedCost.total.estimatedCostCny===0.0005
    && usageReads.length===3 && usageReads.slice(1).every(c=>/and=/.test(c.url) && !c.opts.headers?.Range),
    JSON.stringify({ rows:pagedCost.rows.length, input:pagedCost.total.inputTokens, reads:usageReads.length }));
  usageReply = null;

  mode = 'throw';
  const unavailableUsage = await cs.queryApiUsage({});
  ok('费用查询断网时返回不可用，不抛异常拖垮整页品牌统计', !unavailableUsage.ok && /ECONNREFUSED/.test(unavailableUsage.error || ''));
  mode = 'ok';

  fs.rmSync(cs.stateFile(), { force: true });
  fs.writeFileSync(path.join(dir, 'publish-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'run-log.jsonl'), '', 'utf8');
  fs.writeFileSync(cs.stateFile(), JSON.stringify({ offset: 0, uploaded: 0, runOffset: 0, runUploaded: 0,
    lastSyncAt: 0, lastError: '', fail: 0, nextTryAt: 0 }), 'utf8');
  seed(0, 1);
  const pendingTask = { eventId: 'needs-migration', ts: 1760000000400, kind: 'end', ok: false, error: '任务失败', jobId: 'j2' };
  fs.appendFileSync(path.join(dir, 'run-log.jsonl'), JSON.stringify(pendingTask) + '\n', 'utf8');
  setCfg({});
  calls = []; mode = 'tableMissingRun';
  r = await cs.syncOnce({ force: true });
  ok('run_log 表缺失时报出同步失败，但已成功的发布结果游标仍前进',
    !r.ok && /PGRST205|run_log/.test(r.error || '') && cs.status().offset === 1,
    JSON.stringify({error:r.error, offset:cs.status().offset, runOffset:cs.status().runOffset}));
  ok('run_log 表缺失时保留运行日志游标，迁移完成后可补传',
    cs.status().runOffset === 0 && cs.status().pendingRun === 1, JSON.stringify(cs.status()));
  mode = 'ok';
  fs.writeFileSync(path.join(dir, 'run-log.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'publish-log.jsonl'), '', 'utf8');
  fs.rmSync(cs.stateFile(), { force: true });

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

  console.log('\nD2. 失败要「说得清」：cause 不许丢、失败要落盘、无待上行要清旧标记\n');
  // ---- 纯函数：describeErr 必须把 cause 串起来 ----
  // 正向：真实的 fetch 网络错（TypeError('fetch failed') + cause）
  const de1 = cs.describeErr(Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' })
  }));
  ok('★★ describeErr 把 cause 串进失败信息里（只写 message 就只剩 `fetch failed` 六个字）',
    /fetch failed/.test(de1) && /ENOTFOUND/.test(de1), de1);
  // 正向：多层 cause（undici 的 SocketError 会再嵌一层）
  const de2 = cs.describeErr(Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET', cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
  }));
  ok('★ 多层 cause 也扒得出来（undici: TypeError → SocketError → Error）',
    /UND_ERR_SOCKET/.test(de2) && /ECONNRESET/.test(de2), de2);
  // 反向对照：没有 cause 时不许编一个出来，且原始的 HTTP 文案要原样保留
  const de3 = cs.describeErr(Object.assign(new Error('HTTP 500 · upstream error'), { status: 500 }));
  ok('对照：没有 cause 就不许编，HTTP 文案原样保留且状态码不写两遍',
    de3 === 'HTTP 500 · upstream error', de3);
  // 绝不抛：喂各种垃圾
  ok('★ describeErr 喂垃圾也不抛（它跑在 catch 里，抛了就把真错误吞了）',
    (() => { let t = ''; for (const v of [null, undefined, '', 0, {}, 'str', { cause: {} }]) { try { cs.describeErr(v); } catch (e) { t += String(e.message) + ';'; } } return t === ''; })());

  // ---- 失败要落盘 ----
  setCfg({});
  fs.rmSync(cs.stateFile(), { force: true });
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  try { fs.rmSync(cs.errorLogFile(), { force: true }); } catch (e5) { /* 本来就没有 */ }
  seed(0, 3);
  calls = [];
  mode = 'throwCause';
  r = await cs.syncOnce({ force: true });
  ok('★★ 网络层失败的原因能带出来（不再只有 `fetch failed`）',
    r.ok === false && /ENOTFOUND/.test(r.error || ''), r.error);
  const errLog = (() => { try { return fs.readFileSync(cs.errorLogFile(), 'utf8'); } catch (e6) { return ''; } })();
  ok('★★ 失败同时落盘（logbus 只进内存，不落盘就永远无法复盘）',
    /fail=1/.test(errLog) && /ENOTFOUND/.test(errLog), errLog.split('\n')[0].slice(0, 160));
  // ★★ 落盘里的 pending 必须是这一轮的**真值**（3 条待上行），不许取 pending() 的 3 秒缓存旧值
  //    （缓存那一份是给界面轮询用的；把旧值写进证据文件＝写了个假数字）
  ok('★★ 落盘里的 pending 是本次真值（3 条待上行），不许写成缓存的旧值 0',
    /pending=3/.test(errLog), errLog.split('\n')[0].slice(0, 160));

  // ★ 反向对照：**还有待上行**时，退避期内绝不许把 lastError 清掉
  calls = [];
  r = await cs.syncOnce();
  ok('对照：还有待上行 + 退避中 ⇒ 上一次的失败信息必须还在（清理只许发生在「无待上行」那一刻）',
    cs.status().lastError !== '' && /退避/.test(r.skipped || ''),
    JSON.stringify({ lastError: cs.status().lastError, skipped: r.skipped }));

  // ---- 无待上行 ⇒ 清掉旧标记 ----
  // 复现真实场景：失败之后台账被「数据清理」清空 ⇒ offset 归零、slice 恒为空，
  // 从此每次同步都走这条分支（既回不到 catch，也进不了成功分支）
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  calls = [];
  r = await cs.syncOnce({ force: true });
  const s2 = cs.status();
  // 直接读状态文件（status() 不含 fail，而且这里要证的正是「落盘的那份也被清了」）
  const raw2 = (() => { try { return JSON.parse(fs.readFileSync(cs.stateFile(), 'utf8')); } catch (e8) { return {}; } })();
  ok('★★「无待上行」那一轮必须清掉上一次的失败标记（否则界面上「同步失败」永远挂着）',
    r.ok === true && s2.lastError === '' && raw2.fail === 0 && raw2.nextTryAt === 0 && raw2.lastError === '',
    JSON.stringify({ ok: r.ok, lastError: s2.lastError, fail: raw2.fail, nextTryAt: raw2.nextTryAt }));
  ok('清标记这件事不联网（本地就没有可推的，不该为它打一次云端）', calls.length === 0, `联网 ${calls.length} 次`);

  // 落盘绝不抛：输出目录指到一个不存在的位置也得安静地失败
  ok('★ 落盘写不进去也绝不抛（证据少一条，好过把发布拖下水）',
    (() => {
      const keep = store.get('paths.output');
      let t = '';
      try { store.set({ paths: { output: path.join(dir, 'no-such-dir', 'a\0b') } }); cs.appendErrorLog('探针'); }
      catch (e7) { t = String(e7.message); }
      store.set({ paths: { output: keep } });
      return t === '';
    })());

  // ★ 把状态摆回 D 段结束时的样子（4 条已上行、游标 4），否则下面 E 段的「旧游标 4」前提就没了
  mode = 'ok';
  fs.rmSync(cs.stateFile(), { force: true });
  fs.rmSync(path.join(dir, 'publish-log.jsonl'), { force: true });
  seed(0, 4);
  calls = [];
  r = await cs.syncOnce({ force: true });
  ok('D2 收尾：状态摆回「4 条已上行、游标 4」供 E 段复用',
    r.ok && r.uploaded === 4 && cs.status().offset === 4,
    JSON.stringify({ up: r.uploaded, off: cs.status().offset }));

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
  // ★ 2026-10-03：原来这里拿「重试次数」当无关设置，但那一项已随「失败不重试」删掉 ⇒ 换成间隔。
  store.set({ ui: { theme: 'dark' }, publish: { intervalSec: 45 } });
  ok('★★ 改无关设置（主题 / 发布间隔）也不会把云地址固化进配置',
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
  ok('test() 对两张表都只查不改（GET + limit=1）',
    calls.filter(c => /\/(publish_log|run_log)\?select=/.test(c.url)).length === 2
      && calls.filter(c => /\/(publish_log|run_log)\?select=/.test(c.url)).every(c => c.opts.method === 'GET' && /limit=1/.test(c.url)),
    calls.filter(c => /\/(publish_log|run_log)\?select=/.test(c.url)).map(c => c.url).join('\n'));
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
    (() => { const reader = fs.readFileSync(path.join(ROOT, 'web/metrics.js'), 'utf8');
      return /BoardMetrics\.readAll\(sb, ORG/.test(boardSrc) && /\.eq\('org', org\)/.test(reader)
        && /\.select\(/.test(reader) && !/\.insert\(|\.update\(|\.delete\(/.test(boardSrc + reader);
    })());
  ok('★★ 看板里不许有任何真凭据（sb_secret_ / JWT 字面量），注释里提 service_role 不算',
    !/sb_secret_/.test(boardSrc) && !/eyJ[A-Za-z0-9_-]{20,}/.test(boardSrc));

  // ---- 「打开即看」：看板不许再要求使用者先点一次「保存并连接」 ----
  // ★ 为什么焊住这条（2026-10-08 实测反馈）：原来引导尾部写的是
  //   `if(cfg.url && cfg.key) connect(); else { 显示设置卡片 }`，
  //   而**新访客的 localStorage 本来就是空的** ⇒ 第一次打开只看到一张空的「连接设置」卡片，
  //   不是看板。一个零配置的只读看板不该有这么一道门槛。
  ok('★★ 看板必须**无条件**自动连（不许再拿「本机存过配置」当前提）',
    /(^|\n)\s*connect\(false\)\s*;/.test(boardSrc) && !/\$\(['"]#main['"]\)\.hidden\s*=\s*true;\s*conn\(/.test(boardSrc));
  ok('★★ 首屏不许出现「连接设置」卡片与入口按钮（默认就是 hidden）',
    /id="setupCard"\s+hidden/.test(boardSrc) && /id="btnSetup"\s+hidden/.test(boardSrc));
  ok('★ 自动连**不写** localStorage（只有手点保存才写 persist）',
    /if\s*\(\s*persist\s*\)\s*localStorage\.setItem/.test(boardSrc)
      && /connect\(true\)/.test(boardSrc)
      && !/^\s*localStorage\.setItem\(LS,\s*JSON\.stringify\(\{url,\s*key\}\)\);/m.test(boardSrc));
  ok('★ 连不上 / 读不到时才把设置露出来（有出口，不是死路）',
    // ★ `\s*\(` 不能省：只写 /function\s+showSetup/ 的话，把它改名成 showSetupX 照样命中
    //   —— 上一轮反向验证实测就是这条假绿（改名破坏没被抓到）。断言必须区分「定义」与「前缀相同的别的名字」。
    /function\s+showSetup\s*\(/.test(boardSrc)
      && /showSetup\('看板自带的 Supabase SDK/.test(boardSrc)
      && /\$\('#btnSetup'\)\.hidden\s*=\s*false;/.test(boardSrc));

  console.log('\nI. 看板口径：折叠重复行 / 排除模拟与探针 / 机器按名归一\n');
  // ★★ 为什么这一组必须存在（2026-10-08 真库实测的账）：
  //   同一台电脑换过 machine_id（配置被搬运/清空）后，整本台账会以新 id **重推一遍**，
  //   而唯一键是 (machine_id, ts, seq) ⇒ 云上留两份、去重键拦不住。
  //   实测：189 项真实工作占了 367 行 ⇒ 旧看板把「款进度」从 19% 报成 59%，成功率从 44% 报成 33%。
  //   下面这组**不查「源码里有没有那行字」，而是把那段纯函数抠出来真跑一遍**（行为级）。
  const boardHelper = boardSrc.slice(boardSrc.indexOf('const REAL = new Set'), boardSrc.indexOf('function conn('));
  const vm = require('vm');
  const ctxB = {}; vm.createContext(ctxB);
  new vm.Script(boardHelper + '\n__h = { REAL, isReal, isNonReal, kindOf, dedupe, mkey };').runInContext(ctxB);
  const B = ctxB.__h || {};
  ok('★ 抠得出看板的口径函数（抠不出＝那段被改名/删了，下面的断言会一起失效）',
    !!(B.REAL && B.isReal && B.dedupe && B.mkey));

  // 夹具：同一台机器（同名）两个 id 重复推同一批 + 一条模拟 + 一条探针
  const mkRow = o => Object.assign({ ts: 1, seq: 1, batch_no: 'B', dir_name: '款A', result: '发布成功',
    machine_id: 'm_1', machine_name: 'PC1', mode: 'adb' }, o);
  const fixture = [
    mkRow({}),                                                            // 真的
    mkRow({ machine_id: 'm_2' }),                                         // 同一台机、另一个 id、同 ts/seq/款 ⇒ 必须折叠
    mkRow({ ts: 2, result: '失败' }),                                     // 真的，另一条
    mkRow({ ts: 3, result: '模拟成功', mode: 'mock' }),                    // 模拟 ⇒ 不算发布
    mkRow({ ts: 4, result: '探针（非真实发布）', machine_id: '__probe__conn__' })  // 探针 ⇒ 不算发布
  ];
  const folded = B.dedupe(fixture);
  ok('★ 同一台机器换 id 后重推的重复行被折叠（5 行 → 4 行）', folded.length === 4, '折叠后 ' + folded.length + ' 行');
  ok('★★ 模拟 / 探针不算真实发布（isReal 只认「发布成功 / 失败」）',
    B.isReal({ result: '发布成功' }) && B.isReal({ result: '失败' })
      && !B.isReal({ result: '模拟成功' }) && !B.isReal({ result: '探针（非真实发布）' })
      && !B.isReal({ result: '' }));
  const realOnly = folded.filter(B.isReal);
  ok('★★ 统计只剩 2 条真实结果（模拟 + 探针被排除，但仍留在明细里）',
    realOnly.length === 2 && folded.length - realOnly.length === 2,
    '真实 ' + realOnly.length + ' 条 · 未计入 ' + (folded.length - realOnly.length) + ' 条');
  ok('★ 机器按「机器名」归一（两个 id 同名 ⇒ 只算一台）',
    new Set(folded.map(B.mkey)).size === 1, [...new Set(folded.map(B.mkey))].join(' , '));
  ok('★ 机器名缺失时退回 machine_id；不同机器名不许被误并',
    B.mkey({ machine_id: 'm_x' }) === 'm_x'
      && new Set([mkRow({}), mkRow({ machine_name: 'PC2' })].map(B.mkey)).size === 2);
  ok('★ 探针行被单独归类（kindOf = 探针），模拟行归类为 模拟',
    B.kindOf({ result: '探针（非真实发布）', machine_id: '__probe__conn__' }) === '探针'
      && B.kindOf({ result: '模拟成功', mode: 'mock' }) === '模拟');
  // ★★ 这条是**真实浏览器渲染验收**才逼出来的：建库的 4 条探针里有 3 条 result 写的就是「发布成功」，
  //    只看 result 的判据会把它们当真实发布 ⇒ 真库实测「机器数」被从 1 撑成 2。
  ok('★★ 探针行即使 result 写成「发布成功」也不算真实发布（真库里确有 3 条这样）',
    !B.isReal({ result: '发布成功', machine_id: '__probe__conn__', machine_name: '⚠ 连通性探针（可删）' })
      && !B.isReal({ result: '发布成功', machine_id: 'm_9', machine_name: '⚠ 连通性探针（可删）' })
      && B.isReal({ result: '发布成功', machine_id: 'm_9', machine_name: '真实机器' }));

  // 口径的正面 + 反面：只写正面会「改了公式也照样绿」
  ok('★★ 成功率的分母是「真实完成条数 done」，**不许**再拿含模拟/探针的总行数当分母',
    /Math\.round\(ok\s*\/\s*done\s*\*\s*100\)/.test(boardSrc)
      && !/Math\.round\(ok\s*\/\s*list\.length\s*\*\s*100\)/.test(boardSrc));
  ok('★ 机器数按名字算（不许再拿 machine_id 算）',
    /new Set\(list\.map\(mkey\)\)\.size/.test(boardSrc) && !/new Set\(list\.map\(r\s*=>\s*r\.machine_id\)\)/.test(boardSrc));
  ok('★★ 看板取数后必须先去重（rows = dedupe(raw)），否则重复行会直接进统计',
    /rows\s*=\s*dedupe\(raw\)/.test(boardSrc));

  // 正式部署看板是知识库归档的 board-site/index.html，不是上方兼容旧版的 web/board.html。
  const deployedBoard = fs.readFileSync(path.join(ROOT, 'docs', 'knowledge', 'deployed-sites', 'board-site', 'index.html'), 'utf8');
  const deployedModule = deployedBoard.match(/<script\s+type="module">([\s\S]*?)<\/script>/i);
  let deployedSyntaxError = '';
  try { if (!deployedModule) throw new Error('缺少 module 脚本'); new Function(deployedModule[1]); }
  catch (e) { deployedSyntaxError = String(e.message || e); }
  ok('正式部署看板模块脚本可解析', !deployedSyntaxError, deployedSyntaxError);
  ok('正式部署看板会查询任务日志并与设备/账号/品牌/时间筛选联动',
    /\.from\('run_log'\)/.test(deployedBoard) && /function\s+filteredTasks\s*\(/.test(deployedBoard)
      && /id="tTasks"/.test(deployedBoard) && /id="runLogNotice"/.test(deployedBoard));

  // ---- App 侧：机器标识不许再随机漂移 ----
  ok('★★ App：没有 machineId 时由机器指纹派生 ⇒ 同一台机永远得到同一个 id',
    cs.idFromFingerprint('guid-aaa') === cs.idFromFingerprint('guid-aaa')
      && cs.idFromFingerprint('guid-aaa') !== cs.idFromFingerprint('guid-bbb')
      && /^m_[0-9a-f]{8}$/.test(cs.idFromFingerprint('guid-aaa')),
    cs.idFromFingerprint('guid-aaa'));
  ok('★ 指纹读不到 ⇒ 回空串（交随机兜底），绝不抛',
    cs.idFromFingerprint('') === '' && cs.idFromFingerprint(null) === '');
  ok('★★ 已有 machineId 的机器**不迁移**（迁移＝整本台账以新 id 重推＝看板再翻一倍）',
    (() => { setCfg({ machineId: 'm_keepme1' }); const g = cs.status().machineId; setCfg({}); return g === 'm_keepme1'; })(),
    '期望 m_keepme1');

  console.log('\nJ. 收尾\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e3) { /* 临时目录 */ }
  try { fs.rmSync(cs.stateFile(), { force: true }); } catch (e4) { /* 临时文件 */ }
  console.log('\n' + (bad ? `FAILED：${bad} 条不通过` : '全部通过'));
  process.exit(bad ? 1 : 0);
})();
