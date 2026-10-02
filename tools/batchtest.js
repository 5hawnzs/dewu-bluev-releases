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
  store.set({
    paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    copy: { concurrency: 6, requiredTopic: '#品牌甲', extraTopics: 4 },
    publish: { intervalSec: 5, videoIntervalSec: 5, retry: 1 }   // 「演示节奏」开关已删：现在直接给 5 秒间隔
  });

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
  ok('⑤ 同时给了 csv 表格', fs.existsSync(one.csvFile) && fs.readFileSync(one.csvFile, 'utf8').includes('找不到发布按钮'));

  const all = await sheet.exportPublishLog({});
  ok('⑤ 不指定批次 → 导出全部并按批次分段', all.entries === 3 && all.batches.length === 2, JSON.stringify(all.batches));

  let miss = '';
  try { await sheet.exportPublishLog({ batch: '没这个批次' }); } catch (e) { miss = e.message; }
  ok('⑤ 批次不存在时说清现有批次', /现有批次/.test(miss) && /发布单_20260813/.test(miss), miss);

  // ---- ⑥ 失败恢复动作可编辑（保存 → 回读 → 不认识的动作被挡下，不静默吞） ----
  const saved = await jobs.run('publish.setRecover', { steps: [{ name: '删除卡片', action: 'tapText', value: '删除' }, { action: 'wait', value: 600 }] });
  ok('⑥ 恢复动作保存成功并回读一致', saved.ok && (store.get('publish.uiMap.recover') || []).length === 2, JSON.stringify(store.get('publish.uiMap.recover')));
  const bad = await jobs.run('publish.setRecover', { steps: [{ action: 'tapText', value: '删除' }, { action: 'swipe' }] });
  ok('⑥ 不认识的 action 被挡下，且原配置没被改坏',
    bad.ok === false && /不认识/.test(bad.error) && (store.get('publish.uiMap.recover') || []).length === 2, bad.error);
  const cleared = await jobs.run('publish.setRecover', { steps: [] });
  ok('⑥ 清空恢复动作（失败后只按返回键）', cleared.ok && (store.get('publish.uiMap.recover') || []).length === 0, JSON.stringify(cleared.result));

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('BATCH TEST ERROR', e); process.exitCode = 1; });
