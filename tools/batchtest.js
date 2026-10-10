/* 多批次并行任务 + 发布日志「重导出日志」
   真机口径：任务列表里能同时有两个批次「处理中」，每行有「查看详情 / 取消任务」，右上还有「全部取消」。
   这里验证后端把 byType 单例改成任务实例化之后：
     ① 同类型可并行（不同批次），同一个批次不会被起两次；
     ② 每个批次有独立的 id / 进度 / 日志标签，产物各写各的目录；
     ③ 取消能按 job id（取消任务）也能按类型（全部取消）；
     ④ publish-log.jsonl 能按批次导成可读日志，批次不存在时说清现有批次。
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-batch-'));
const fake = {
  app: { getPath: () => TMP, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {},
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  Notification: { isSupported: () => false }, screen: {},
  contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'electron') return fake; return origLoad.apply(this, arguments); };

// 工程根目录 = 本文件上一级
const base = path.resolve(__dirname, '..');
const jpeg = require(path.join(base, 'node_modules', 'jpeg-js'));
const store = require(path.join(base, 'src/main/store.js'));
const logbus = require(path.join(base, 'src/main/logbus.js'));
const jobs = require(path.join(base, 'src/main/jobs.js'));
const sheet = require(path.join(base, 'src/main/services/sheet.js'));
const copywriter = require(path.join(base, 'src/main/services/copywriter.js'));

function jpgBuf(size) {
  const d = Buffer.alloc(size * size * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = 200; d[i + 1] = 200; d[i + 2] = 200; d[i + 3] = 255; }
  return jpeg.encode({ data: d, width: size, height: size }, 90).data;
}

/** 造一个批次目录：若干个叶子目录，各放一张 jpg */
function makeBatch(name, leaves) {
  const root = path.join(TMP, name);
  for (let i = 0; i < leaves; i++) {
    const dir = path.join(root, `26FW-YB16${String(i).padStart(2, '0')}+冠军白+1`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.jpg'), jpgBuf(200));
  }
  return root;
}

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

(async () => {
  // 当前套件测发布/文案行为，显式准备品牌前置；配置仍只写测试临时目录。
  store.set({ brandsSeeded: true, brands: [{ id: 'brd_regression', name: '品牌甲', enabled: true,
    promptWrite: '请根据素材生成真实自然的种草文案。' }],
    paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    copy: { concurrency: 6, requiredTopic: '#品牌甲', extraTopics: 4, llm: { enabled: false } },
    publish: { intervalSec: 5, videoIntervalSec: 5 }   // 「演示节奏」开关已删：直接给 5 秒间隔；★ retry 也已删（失败不重试）
  });

  // 新一批素材不得继承旧批次的合规报告，也不得在整理时偷偷检查时长。
  const project = require(path.join(base, 'src/main/project.js'));
  const compliance = require(path.join(base, 'src/main/services/compliance.js'));
  const oldScan = compliance.scan;
  let scanned = 0;
  compliance.scan = async () => { scanned++; throw new Error('整理不应启动合规扫描'); };
  project.patch({ compliance: { rows: [{ status: 'manual' }], stats: { total: 30, manual: 28 }, scannedAt: 123, groups: [{ name: '旧批次' }] } });
  const imported = await jobs.run('flatten.run', { sourceDir: makeBatch('合规状态隔离', 1) });
  compliance.scan = oldScan;
  const cleared = project.get().compliance;
  ok('导入新素材清除旧的 28 条人工判定、分组和检查时间', imported.ok && cleared.stats === null && cleared.rows.length === 0 && cleared.scannedAt === 0 && !cleared.groups);
  ok('尚未开始检查时不调用合规扫描', scanned === 0);
  project.patch({ compliance: { rows: [{ status: 'manual' }], stats: { total: 30, manual: 28 }, scannedAt: 123 } });
  const selected = await jobs.run('flatten.plan', { sourceDir: makeBatch('仅选择新目录', 1) });
  ok('仅选择新目录、未开始整理时也清除旧合规结果', selected.ok && project.get().compliance.stats === null && project.get().items.length === 0 && !project.get().flatDir);
  // 原目录 A 与处理副本 B 必须贯通到文案报告和发布队列。
  const originalA = makeBatch('原始素材A', 2);
  const prepared = await jobs.run('flatten.run', { sourceDir: originalA });
  const processedB = prepared.result.flatDir;
  for (const it of project.get().items) {
    fs.renameSync(path.join(it.absDir, '1.jpg'), path.join(it.absDir, '1_处理后.jpg'));
  }
  const fromA = await jobs.run('copy.generate', { sourceDir: originalA, batchId: '处理副本回归' });
  ok('选择当前原目录 A 时，报告保存在处理目录 B', fromA.ok && path.dirname(fromA.result.reportFile) === processedB,
    fromA.ok ? fromA.result.reportFile : fromA.error);
  const copySaved = fromA.ok ? JSON.parse(fs.readFileSync(fromA.result.file, 'utf8')) : {};
  ok('文案任务记录的素材目录是 B', copySaved.sourceDir === processedB);
  const repRead = fromA.ok ? await require(path.join(base, 'src/main/services/report.js')).readReport(fromA.result.reportFile) : null;
  ok('生成的 Excel 可以正常读回', !!repRead);
  const importedB = fromA.ok ? await jobs.run('report.import', { file: fromA.result.reportFile }) : { ok: false };
  ok('报告导入后的发布素材全部来自 B，不引用 A', importedB.ok && project.get().items.length === 2 &&
    project.get().items.every(it => path.dirname(it.absDir) === processedB && it.files.some(f => f.name === '1_处理后.jpg')));
  const removedB = processedB + '_暂时移走';
  fs.renameSync(processedB, removedB);
  const missingB = await jobs.run('copy.generate', { sourceDir: originalA, batchId: '处理目录已移走' });
  fs.renameSync(removedB, processedB);
  ok('处理目录 B 不存在时明确报错，不退回 A 生成', !missingB.ok && /处理.*目录.*不存在/.test(missingB.error || ''), missingB.error);
  project.patch({ sourceDir: '', flatDir: '', items: [] });

  // ---- 发布间隔的取消必须清除等待定时器 ----
  const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
  let watchedTimer = null, timeoutCleared = false;
  global.setTimeout = (fn, ms, ...args) => {
    const timer = realSetTimeout(fn, ms, ...args);
    if (ms === 5000) watchedTimer = timer;
    return timer;
  };
  global.clearTimeout = timer => {
    if (timer === watchedTimer) timeoutCleared = true;
    return realClearTimeout(timer);
  };
  let sleepCancelled = false;
  try { sleepCancelled = await require(path.join(base, 'src/main/services/publisher.js')).sleep(5000, () => true) === false; }
  finally { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; }
  ok('发布间隔取消后立即结束并清除结束定时器', sleepCancelled && watchedTimer !== null && timeoutCleared,
    JSON.stringify({ sleepCancelled, timeoutCreated: watchedTimer !== null, timeoutCleared }));
  // ---- ⓪ ★ 2026-10-02：「设置 → 素材根目录」已删 ⇒ 出厂不再预设素材目录 ----
  //   没显式给、工程里也没存过，必须**明确报错**；不许拿一个默认目录静默凑合，
  //   更不许把 undefined 一路传下去（那会冒出一句没人看得懂的 path 类型错）。
  const noDir = await jobs.run('flatten.plan', {});
  ok('⓪ 没选素材目录时明确报错（不再有出厂默认目录兜底）',
    noDir.ok === false && /还没选素材目录/.test(noDir.error), noDir.error);

  // ---- ① 两个批次同时跑 ----
  const dirA = makeBatch('7月第六批', 3);
  const dirB = makeBatch('种草0625-7月第一批', 3);
  const pA = jobs.run('copy.generate', { sourceDir: dirA, batchId: '7月第六批', label: '7月第六批' });
  const afterA = jobs.list();
  const pB = jobs.run('copy.generate', { sourceDir: dirB, batchId: '种草0625-7月第一批', label: '种草0625-7月第一批' });
  const afterB = jobs.list();
  ok('① 第一个批次已实例化', afterA.length === 1 && afterA[0].label === '7月第六批', JSON.stringify(afterA.map(j => j.label)));
  ok('① 两个批次同时运行（真机：任务列表里能同时「处理中」）',
    afterB.length === 2 && afterB.map(j => j.label).sort().join('|') === '7月第六批|种草0625-7月第一批',
    afterB.map(j => j.label + '(' + j.type + ')').join(' + '));
  ok('① 每个实例有独立 id', afterB[0].id !== afterB[1].id, afterB.map(j => j.id).join(' / '));

  const [rA, rB] = await Promise.all([pA, pB]);
  ok('① 两个批次都跑完', rA.ok && rB.ok, `${rA.ok ? 'A ok' : 'A 失败:' + rA.error} / ${rB.ok ? 'B ok' : 'B 失败:' + rB.error}`);
  ok('① 产物各写各的目录（不互相覆盖）',
    rA.result.file !== rB.result.file && fs.existsSync(rA.result.file) && fs.existsSync(rB.result.file),
    path.relative(TMP, rA.result.file) + ' | ' + path.relative(TMP, rB.result.file));
  const savedA = JSON.parse(fs.readFileSync(rA.result.file, 'utf8'));
  ok('① 批次产物内容对得上', savedA.count === 3 && savedA.rows.length === 3 && savedA.batchId === '7月第六批', `count=${savedA.count} batchId=${savedA.batchId}`);
  ok('① 跑完就从「运行中」消失', jobs.list().length === 0 && jobs.busy('copy.generate') === false, JSON.stringify(jobs.list()));

  // ---- ③ / ④ 取消：换个慢速生成器，让任务有时间被取消 ----
  const realGenerate = copywriter.generate;
  copywriter.generate = async (items, ctx = {}) => {
    const log = ctx.log || (() => {});
    const progress = ctx.progress || (() => {});
    let done = 0;
    for (const it of items) {
      if (ctx.cancelled && ctx.cancelled()) { log('已取消，本批次停止', 'warn'); break; }
      await new Promise(r => setTimeout(r, 40));
      done++;
      progress({ done, total: items.length, label: it.id });
    }
    return { rows: items.slice(0, done).map(i => ({ id: i.id, title: 't', body: 'b', topics: [], status: '已生成' })), warning: null, llm: false };
  };

  const slowA = makeBatch('慢批次甲', 60);
  const slowB = makeBatch('慢批次乙', 60);
  const p1 = jobs.run('copy.generate', { sourceDir: slowA, batchId: '慢批次甲', label: '慢批次甲' });

  // ---- ② 运行中：同一个批次不会被起两次 ----
  const dup = await jobs.run('copy.generate', { sourceDir: slowA, batchId: '慢批次甲', label: '慢批次甲' });
  ok('② 同批次重复启动被拒（回可读原因，不抛未捕获异常）', dup.ok === false && /正在处理中/.test(dup.error), dup.error);

  const p2 = jobs.run('copy.generate', { sourceDir: slowB, batchId: '慢批次乙', label: '慢批次乙' });
  const live = jobs.list();
  const id1 = live.find(j => j.label === '慢批次甲').id;
  ok('③ 逐个取消：按 job id 取消 1 个', jobs.cancel(id1) === 1, 'cancel(' + id1 + ') 命中 1 个');
  const r1 = await p1;
  ok('③ 被取消的批次：日志有停止痕迹、结果统一报「任务已取消」',
    logbus.history().some(e => e.meta && e.meta.batch === '慢批次甲' && /已取消/.test(e.msg)) && r1.ok === false && r1.error === '任务已取消',
    r1.error + ' / 日志里出现 慢批次甲 的取消记录');
  ok('③ 取消不影响另一个批次（仍在运行）', jobs.busy('copy.generate') === true && jobs.list().some(j => j.label === '慢批次乙'), JSON.stringify(jobs.list().map(j => j.label)));
  ok('④ 全部取消：按类型一次停掉剩下的', jobs.cancel('copy.generate') === 1, '还剩 1 个（慢批次乙）被停');
  const r2 = await p2;
  ok('④ 另一个批次也按「任务已取消」收尾，没有假装成功', r2.ok === false && r2.error === '任务已取消', r2.error);
  copywriter.generate = realGenerate;

  // ---- ⑤ 发布日志：按批次重导出 ----
  sheet.appendLog({ batch: '发布单_20260812', seq: 1, dir: 'A+白+1', at: '15:34:41', result: '发布成功', reason: '', retries: 0, elapsed: 65.2, mode: 'mock' });
  sheet.appendLog({ batch: '发布单_20260812', seq: 2, dir: 'A+黑+1', at: '15:36:18', result: '失败', reason: '找不到发布按钮', retries: 1, elapsed: 61.9, mode: 'mock' });
  sheet.appendLog({ batch: '发布单_20260813', seq: 1, dir: 'B+白+1', at: '15:40:00', result: '发布成功', reason: '', retries: 0, elapsed: 79.7, mode: 'mock' });

  const one = await sheet.exportPublishLog({ batch: '发布单_20260812' });
  ok('⑤ 按批次导出', one.entries === 2 && one.ok === 1 && one.failed === 1, JSON.stringify({ entries: one.entries, ok: one.ok, failed: one.failed }));
  const txt = fs.readFileSync(one.file, 'utf8');
  ok('⑤ 文本日志可读（带成功/失败标记与耗时）', /批次 发布单_20260812/.test(txt) && /\[V\] 行 1/.test(txt) && /\[X\] 行 2/.test(txt) && /65\.2s/.test(txt), txt.split('\r\n').filter(l => /行 [12]/.test(l)).join(' || '));
  ok('⑤ 只导出指定批次', !/发布单_20260813/.test(txt));
  // ★ 2026-10-03 用户要求：失败那一行写「**发布失败，原因xxx**」（原来是「失败：xxx」）。
  //   ★ 同时钉住**旧台账**里的「（重试 N 次）」照旧渲染 —— 历史是最不该被悄悄改写的东西。
  ok('★ 导出日志里失败行写的是「发布失败，原因xxx」', /\[X\] 行 2 \[图文\] 发布失败，原因找不到发布按钮/.test(txt),
    txt.split('\r\n').filter(l => /\[X\]/.test(l)).join(' || '));
  ok('★ 旧台账里的「（重试 N 次）」照旧渲染（新记录不再重试，但历史不许被抹掉）',
    /（重试 1 次）/.test(txt), txt.split('\r\n').filter(l => /重试/.test(l)).join(' || '));
  ok('⑤ 同时给了 csv 表格', fs.existsSync(one.csvFile) && fs.readFileSync(one.csvFile, 'utf8').includes('找不到发布按钮'));

  const all = await sheet.exportPublishLog({});
  ok('⑤ 不指定批次 → 导出全部并按批次分段', all.entries === 3 && all.batches.length === 2, JSON.stringify(all.batches));

  let miss = '';
  try { await sheet.exportPublishLog({ batch: '没这个批次' }); } catch (e) { miss = e.message; }
  ok('⑤ 批次不存在时说清现有批次', /现有批次/.test(miss) && /发布单_20260813/.test(miss), miss);

  // ---- ⑥ ★ 2026-10-03 用户要求：「失败恢复动作」整块删除 ----
  //   删功能必须配**负向断言**（否则加回来也全绿），而且要**配正向对照**：
  //   不能只说「报错了」—— 必须证明报的是「未知任务」，否则任务名拼错也会「报错」，看着一样。
  // ★ 判据要接住 jobs.run 的**两条**失败通道：它会把派发里抛的异常 catch 成 {ok:false,error}
  //   （不往外抛）。第一版只写了 try/catch ⇒ 拿到空消息，看着像「没报错」（已实测踩到）。
  let sr = null, srThrown = '';
  try { sr = await jobs.run('publish.setRecover', { steps: [] }); } catch (e) { srThrown = e.message; }
  const srMsg = srThrown || ((sr && sr.error) || '');
  ok('★ ⑥ publish.setRecover 任务已删除（再调明确报「未知任务」，不是静默成功）',
    /未知任务/.test(srMsg) && /publish\.setRecover/.test(srMsg), srMsg || ('(居然没报错：' + JSON.stringify(sr) + ')'));
  // ★ 导入定位表时不再把 prev.recover 捞回来合并（老配置里那个键从此是**没人读的死键**）。
  //   ★ 别把断言写歪：store.set 是 mergeDeep、**没有删键能力** ⇒ 「老配置里 recover 键还在」是正常的，
  //     所以只能查**代码里那一处读取点**在不在 —— 这正是「删功能要连读取链一起删」要盯的东西。
  const jobsCode = fs.readFileSync(path.join(base, 'src/main/jobs.js'), 'utf8')
    .split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('★ ⑥ 导入定位表不再合并 prev.recover（jobs.js 代码里没有这处读取点）',
    !/prev\.recover/.test(jobsCode) && !/uiMap\.recover/.test(jobsCode),
    JSON.stringify({ prevRecover: /prev\.recover/.test(jobsCode), uiMapRecover: /uiMap\.recover/.test(jobsCode) }));
  ok('★ ⑥ 出厂配置不再有 publish.retry（发布失败不重试）',
    !('retry' in (store.defaults().publish || {})),
    JSON.stringify(Object.keys(store.defaults().publish || {})));

  // ---- ⑦ ★ 2026-10-03：叶子文件夹名解析（「货号+颜色」，以 + 号分隔） ----
  //   为什么单独测：第一步素材整理会把原来的层级用连接符接成一个名字（`26FW-YB160+冠军白/1`
  //   → `26FW-YB160+冠军白_1`），同一分钟跑两次还会再加 `-2`。
  //   这两个后缀**不是颜色**；不摘掉的话颜色会变成「冠军白_1」，颜色核对 / 商品池比对 /
  //   报告里填空格全都对不上（用户报的就是这类「货号颜色对不上」）。
  {
    const flatten = require(path.join(base, 'src/main/services/flatten.js'));
    const B = String.fromCharCode(92);
    const p = (...seg) => 'D:' + B + seg.join(B);
    const cases = [
      ['叶子=序号（真实结构）', p('素材', 'TW男装', '20260901', '26FW-YB160+冠军白', '1'), '26FW-YB160', '冠军白', 'plus'],
      ['叶子=序号 2', p('素材', 'TW男装', '20260901', '26FW-YB160+冠军白', '2'), '26FW-YB160', '冠军白', 'plus'],
      ['扁平副本名（_序号 不是颜色）', p('素材', 'flat_20261001-0132', '26FW-YB160+冠军白_1'), '26FW-YB160', '冠军白', 'plus'],
      ['扁平副本 + 去重后缀 -2', p('素材', 'flat_20261001-0132', '26FW-YB160+冠军白_2-2'), '26FW-YB160', '冠军白', 'plus'],
      ['多字色名', p('素材', 'TW男装', '20260901', 'UWH760085+黑色条纹', '1'), 'UWH760085', '黑色条纹', 'plus'],
      ['叶子本身就是「货号+颜色」', p('素材', 'TW男装', '20260901', '26FW-YB160+冠军白'), '26FW-YB160', '冠军白', 'plus'],
      ['老式三层（货号/颜色/序号）', p('素材', 'TW男装', '26FW-CB135', '燕麦色', '1'), '26FW-CB135', '燕麦色', 'split'],
      ['随手命名的文件夹 → 不许当成货号', p('素材', '品牌甲', '20260901', 'IMG_5253'), 'IMG_5253', '', 'name'],
      // ★ 2026-10-03 真机实测（E:\bluev_beta\0901_2）：批次目录 / 货号 / 序号 三层、**颜色没填**
      ['批次目录/货号/序号（颜色没填）', p('素材', 'TW男装', '0901_2', '3261163003', '1'), '3261163003', '', 'sku'],
      ['日期目录/货号/序号（颜色没填）', p('素材', '卡宾', '20260901', '26FW-YB160', '1'), '26FW-YB160', '', 'sku'],
      ['扁平副本「货号_序号」→ 后缀要摘', p('素材', 'flat_20261002-2329', '3261163003_1'), '3261163003', '', 'sku'],
      ['扁平副本「货号_序号」（纯字母头）→ 不许摘', p('素材', 'flat_20261002-2329', 'IMG_5253_1'), 'IMG_5253_1', '', 'name']
    ];
    const got = cases.map(([why, dir]) => Object.assign({ why }, flatten.parseName(dir)));
    const wrong = got.filter((g, i) => g.sku !== cases[i][2] || g.color !== cases[i][3] || g.how !== cases[i][4]);
    ok('⑦ 「货号+颜色」按 + 号切、并把扁平副本的 _序号 / -N 摘掉（不许变成「冠军白_1」）',
      wrong.length === 0, wrong.length ? JSON.stringify(wrong) : got.map(g => `${g.sku}/${g.color}/${g.how}`).join(' | '));
    ok('⑦ 老式三层 / 随手命名 / 相机名 都不会被当成「货号+颜色」',
      flatten.parseName(p('素材', 'TW男装', '26FW-CB135', '燕麦色', '1')).how === 'split'
      && flatten.parseName(p('素材', '品牌甲', '20260901', 'IMG_5253')).how === 'name'
      && flatten.parseName(p('素材', '品牌甲', '20260901', 'IMG_5253', '1')).how === 'split'
      && flatten.parseName(p('素材', '品牌甲', '20260901', 'IMG_5253', '1')).how !== 'sku');
    // ★★ 这一条是本轮的核心缺陷：批次目录名被当货号、真货号被当颜色（报告里就是 0901_2 / 3261163003）。
    //    必须钉死：货号只能是真货号，颜色必须留空。
    const swap = flatten.parseName(p('素材', 'TW男装', '0901_2', '3261163003', '1'));
    ok('⑦ ★★ 批次目录/货号/序号：货号=真货号、颜色留空（不许 货号=0901_2 / 颜色=3261163003）',
      swap.sku === '3261163003' && swap.color === '' && swap.how === 'sku',
      JSON.stringify(swap));
    const multi = flatten.parseName(p('素材', 'TW男装', '26FW-YB160+冠军白+UWG760094+雾霾蓝'));
    ok('⑦ 双好物文件夹名按「货号+颜色」成对解析',
      multi.goods.length === 2 && multi.goods[0].sku === '26FW-YB160' && multi.goods[0].color === '冠军白'
      && multi.goods[1].sku === 'UWG760094' && multi.goods[1].color === '雾霾蓝',
      JSON.stringify(multi.goods));
    const multiHealed = flatten.refineItem({
      absDir: p('素材', 'flat_20261008', '26FW-YB160+冠军白+UWG760094+雾霾蓝'),
      sku: '26FW-YB160', color: '冠军白', goods: [{ sku: '26FW-YB160', color: '冠军白' }]
    });
    ok('⑦ 已保存的双好物工程条目会按叶子名补回第二个好物',
      multiHealed.goods.length === 2 && multiHealed.goods[1].sku === 'UWG760094',
      JSON.stringify(multiHealed.goods));
    ok('⑦ 色名里本来就带数字的不会被误伤（米白2 / 黑色条纹）',
      flatten.parseName(p('a', '26FW-YB160+米白2')).color === '米白2'
      && flatten.parseName(p('a', '26FW-YB160+黑色条纹')).color === '黑色条纹');

    // ---- ⑦b ★★ 2026-10-04：**工程状态自愈**（flatten.refineItem）----
    //   为什么单独测：`project.json` 里的 items 是素材整理那一次算好、之后一直沿用的 ——
    //   文案生成 / 出报告 / 发布都只读它。旧版（把批次目录当货号那个版本）存下来的
    //   `sku:'0901_2' / color:'3261163003'` 就**一直躺在工程状态里**，报告的好物列直接取它，
    //   于是一直错，而且**重跑文案生成也修不好**（文案生成不重算这两个字段）。
    //   真机取证：E:\bluev_beta 那份工程的 items[9] 就是这两条错值。
    const stale = flatten.refineItem({
      id: '3261163003+1', dir: '3261163003+1',
      absDir: p('素材', 'flat_20261002-2329', '3261163003_1'), sku: '0901_2', color: '3261163003'
    });
    ok('⑦b ★★ 存量工程状态自愈：sku=0901_2 / color=3261163003 ⇒ 按扁平副本名改成 3261163003 / 空',
      stale.sku === '3261163003' && stale.color === '', JSON.stringify(stale));

    const already = {
      id: '3261132007+煤黑色01+1',
      absDir: p('素材', 'flat_20261002-2329', '3261132007+煤黑色01_1'),
      sku: '3261132007', color: '煤黑色01'
    };
    ok('⑦b 已经对的条目**连接口都不换**（引用不变）—— 否则每跑一次 patch 都白广播一遍',
      flatten.refineItem(already) === already);

    ok('⑦b how=sku（叶子名里根本没颜色）时：人工补过的带汉字颜色保留、纯 ASCII 的「颜色」清掉',
      flatten.refineItem({ absDir: p('素材', 'f', '3261163003_1'), sku: '', color: '煤黑色01' }).color === '煤黑色01'
      && flatten.refineItem({ absDir: p('素材', 'f', '3261163003_1'), sku: '', color: '3261163003' }).color === '');

    const untrusted = { absDir: p('素材', '品牌甲', '20260901', 'IMG_5253', '1'), sku: 'X9', color: 'Y8' };
    ok('⑦b 解析不可信（随手命名 / 相机名）的条目**一个字不改**（宁可留着让人补，也不写假货号）',
      flatten.refineItem(untrusted) === untrusted);

    const onlyId = { id: '3261163003+1', sku: '0901_2', color: '3261163003' };
    ok('⑦b 只有 id、没有路径时原样不动 —— 旧版 id 是「+连接的显示名」，拿它当路径会把 `1` 读成颜色',
      flatten.refineItem(onlyId) === onlyId);
  }

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('BATCH TEST ERROR', e); process.exitCode = 1; });
