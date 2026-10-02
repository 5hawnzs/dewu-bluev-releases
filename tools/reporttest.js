/* 「AI 内容报告」导入 + 回写（真机流水线的中间产物）
   验证：
     ① 表头按「列名」识别（列顺序打乱也能读），素材路径 = 绝对路径
     ② 报告行 ↔ 叶子文件夹一一对应（叶子名自然排序：_2 排在 _10 前）；数量不等直接报错并列出多/少哪些
     ③ 标题/文案：报告里有就用，空的本地生成
     ④ 好物 1..9 都带上，颜色可空
     ⑤ 发图文还是发视频以报告的「内容类型」列为准；没标按目录推断；图和视频都有又没标 → 标「校验未通过」不静默丢
     ⑥ 执行结果已是「发布成功」的行 → 续跑时跳过
     ⑦ 发布结果回写报告的 B（实际执行时间）/ C（执行结果）；报告被占用 → 整批暂存 → 下次先补写
     ⑧ 端到端：report.import → publish.run(mock) → 报告落字
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-report-'));
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

const base = path.resolve(__dirname, '..');
const ExcelJS = require(path.join(base, 'node_modules', 'exceljs'));
const jpeg = require(path.join(base, 'node_modules', 'jpeg-js'));
const store = require(path.join(base, 'src/main/store.js'));
const project = require(path.join(base, 'src/main/project.js'));
const jobs = require(path.join(base, 'src/main/jobs.js'));
const report = require(path.join(base, 'src/main/services/report.js'));

function jpgBuf(size = 160) {
  const d = Buffer.alloc(size * size * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = 235; d[i + 1] = 235; d[i + 2] = 238; d[i + 3] = 255; }
  return jpeg.encode({ data: d, width: size, height: size }, 90).data;
}
const shot = jpgBuf();

/** 造一个批次目录：每个叶子目录里放几张图（或一个视频） */
function makeBatch(root, leaves) {
  for (const [name, files] of Object.entries(leaves)) {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    files.forEach((f, i) => {
      if (/\.mp4$/i.test(f)) fs.writeFileSync(path.join(d, f), Buffer.from('fake video bytes'));
      else fs.writeFileSync(path.join(d, f), shot);
    });
  }
  return root;
}

/** 写一份「AI 内容报告」：cols 是列名数组（故意乱序），rows 按列名取值 */
async function writeReport(file, cols, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('AI 内容报告');
  ws.addRow(cols);
  rows.forEach(r => ws.addRow(cols.map(c => (r[c] == null ? '' : r[c]))));
  await wb.xlsx.writeFile(file);
  return file;
}

async function readBack(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('AI 内容报告') || wb.worksheets[0];
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const out = {};
    for (let c = 1; c <= ws.columnCount; c++) {
      const h = ws.getRow(1).getCell(c).value;
      out[String(h)] = row.getCell(c).value == null ? '' : String(row.getCell(c).value);
    }
    rows.push(out);
  }
  return rows;
}

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

const COLS = ['好物1_颜色', '素材路径', '标题', '好物2_货号', '内容类型', '文案', '好物1_货号', '实际执行时间', '执行结果', '素材来源', '好物3_货号'];

(async () => {
  store.set({
    paths: { source: TMP, output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    copy: { concurrency: 4, requiredTopic: '#品牌甲', extraTopics: 4 },
    publish: { mock: true, mockIntervalSec: 1, retry: 1 }
  });

  // 批次目录：4 个叶子（第 2 个图+视频都有、报告又没标；第 3 个只有视频、报告标「视频」）
  const batchDir = makeBatch(path.join(TMP, '品牌甲', '20260901'), {
    'UWG460108+本白_1': ['1.jpg', '2.jpg'],
    'UWG460108+本白_2': ['1.jpg', '短片.mp4'],
    'UWG460110+白色_1': ['短片.mp4'],
    'UWH760085+黑色条纹_1': ['1.jpg']
  });

  // ---- ① 读报告：列顺序打乱，靠列名认 ----
  const repFile = path.join(TMP, 'KIDS_AI内容报告_2026-09-01T10-00-00.xlsx');
  await writeReport(repFile, COLS, [
    { 素材路径: batchDir, 标题: '白色的鞋谁懂', 文案: '这双本白真的百搭', 好物1_货号: 'UWG460108', 好物1_颜色: '本白', 好物2_货号: 'UWG460109', 内容类型: '26FWT75', 素材来源: 'KIDS' },
    { 素材路径: batchDir, 好物1_货号: 'UWG460110', 好物1_颜色: '本白', 好物3_货号: 'UWH760085' },
    { 素材路径: batchDir, 好物1_货号: 'UWG460111', 内容类型: '视频' },
    { 素材路径: batchDir, 好物1_货号: 'UWH760085', 好物1_颜色: '黑色条纹', 执行结果: '发布成功', 实际执行时间: '2026-09-01 10:00:00' }
  ]);
  const rep = await report.readReport(repFile);
  ok('① 列顺序打乱也能按列名识别', rep.rows.length === 4 && rep.rows[0].dir === batchDir, `${rep.rows.length} 行 · 表「${rep.sheetName}」`);
  ok('① 好物 1/2/3 与颜色都取到（颜色可为空）',
    rep.rows[0].goods.length === 2 && rep.rows[0].goods[0].sku === 'UWG460108' && rep.rows[0].goods[0].color === '本白' && rep.rows[0].goods[1].color === '' && rep.rows[1].goods[1].sku === 'UWH760085',
    JSON.stringify(rep.rows.map(r => r.goods)));
  ok('① 素材来源 / 内容类型 也读出来了', rep.rows[0].source === 'KIDS' && rep.rows[0].contentType === '26FWT75');

  // ---- ② 行 ↔ 叶子一一对应 ----
  let mismatch = '';
  try {
    await report.build(await report.readReport(await writeReport(path.join(TMP, '少一行.xlsx'), COLS, [
      { 素材路径: batchDir, 好物1_货号: 'A1' },
      { 素材路径: batchDir, 好物1_货号: 'A2' }
    ])), {});
  } catch (e) { mismatch = e.message; }
  ok('② 行数与叶子数不等 → 直接报错并列出这个路径下有几个叶子',
    /4 个叶子文件夹/.test(mismatch) && /报告里有 2 行指向它/.test(mismatch) && /UWG460108\+本白_1/.test(mismatch),
    mismatch.split('，但').pop() || mismatch);

  const built = await report.build(rep, { generateCopy: async sub => sub.map(i => ({ id: i.id, title: '【本地】' + i.sku, body: '本地正文' + i.color })) });
  ok('② 4 行 ↔ 4 个叶子，按叶子名自然排序配对',
    built.items.length === 4 && built.items[0].id === 'UWG460108+本白_1' && built.items[3].id === 'UWH760085+黑色条纹_1',
    built.items.map(i => i.id).join(' | '));
  ok('② 叶子里的图片/视频被分清', built.publishRows[0].images === 2 && built.publishRows[1].videos === 1, JSON.stringify(built.publishRows.map(r => ({ i: r.images, v: r.videos }))));

  // ---- ③ 标题/文案：有则用、空则生成 ----
  ok('③ 报告里有标题/文案的用报告的，空的三个本地生成',
    built.copyRows.length === 4
    && built.copyRows.find(r => r.id === 'UWG460108+本白_1').from === '报告'
    && built.copyRows.find(r => r.id === 'UWG460108+本白_1').title === '白色的鞋谁懂'
    && built.copyRows.filter(r => r.from === '本地生成').length === 3,
    built.copyRows.map(r => `${r.id}:${r.from}`).join(' | '));
  ok('③ 本地生成时拿到了对应货号', /UWG460110/.test(built.copyRows.find(r => r.id === 'UWG460108+本白_2').title));

  // ---- ④ / ⑤ 好物带全 + 视频行标出来 ----
  ok('④ 发布行带上全部好物（好物2 颜色空也保留）',
    built.publishRows[0].goods === 2 && built.publishRows[0].goodsList[1].sku === 'UWG460109' && built.publishRows[0].goodsList[1].color === '',
    JSON.stringify(built.publishRows[0].goodsList));
  ok('⑤ 图和视频都有、报告又没标内容类型 → 标「校验未通过」并说清判不了（不静默丢）',
    built.blocked.length === 1 && built.blocked[0].id === 'UWG460108+本白_2'
    && /内容类型/.test(built.blocked[0].note) && /暂不发布/.test(built.notes.join('')),
    built.blocked.map(b => b.id + '：' + b.note).join(' | '));
  ok('⑤ 报告标了「视频」且叶子里有视频 → 判为视频，不再被一票否决',
    built.publishRows.find(r => r.id === 'UWG460110+白色_1').kind === 'video',
    JSON.stringify(built.publishRows.map(r => ({ id: r.id, kind: r.kind }))));
  ok('⑤ 报告没标时按目录内容推断（只有图 → 图文），并把推断写进说明',
    built.publishRows.find(r => r.id === 'UWG460108+本白_1').kind === 'image'
    && /判定为「图文」/.test(built.notes.join('')),
    built.notes.join(' | '));

  // ---- ⑥ 已是「发布成功」的行 → 续跑跳过 ----
  ok('⑥ 报告里已「发布成功」的行带上了状态（发布时跳过）',
    built.publishRows[3].result === '发布成功', built.publishRows.map(r => r.result || '（待发）').join(' | '));

  // ---- ⑦ 端到端：导入 → 发布（mock）→ 回写报告 ----
  const imported = await jobs.run('report.import', { file: repFile });
  ok('⑦ 导入成功并生成发布队列', imported.ok === true && imported.result.total === 4, imported.error || JSON.stringify(imported.result && imported.result.total));
  const st = project.get();
  ok('⑦ 工程状态已替换为这份报告（items / copyRows / verify / publish）',
    st.items.length === 4 && st.copyRows.length === 4 && st.verify.rows.length === 1 && st.publish.rows.length === 4 && st.publish.reportFile === repFile,
    `items ${st.items.length} · copy ${st.copyRows.length} · verify ${st.verify.rows.length} · rows ${st.publish.rows.length}`);
  ok('⑦ 发布队列里带上了每条的发文类型（图文/视频）',
    st.publish.rows.filter(r => r.kind === 'video').length === 1 && st.publish.rows.filter(r => r.kind === 'image').length === 2
    && st.publish.rows.find(r => r.id === 'UWG460108+本白_2').kind === '',
    JSON.stringify(st.publish.rows.map(r => r.id + ':' + r.kind)));
  ok('⑦ 报告的暂存队列是干净的（没有误用发布单的队列）',
    report.pendingCount() === 0 && require(path.join(base, 'src/main/services/sheet.js')).takePending('sheet').length === 0);

  const pub = await jobs.run('publish.run', {});
  ok('⑦ 发布跑完（只有判不了那条按「校验未通过」跳过）', pub.ok === true && pub.result.total === 3, pub.error || JSON.stringify(pub.result));

  const after = await readBack(repFile);
  const undecided = after.find(r => r['好物1_货号'] === 'UWG460110');
  const videoPub = after.find(r => r['好物1_货号'] === 'UWG460111');
  const doneRow = after.find(r => r['好物1_货号'] === 'UWH760085');
  const genRow = after.find(r => r['好物1_货号'] === 'UWG460108');
  ok('⑦ 判不了那行的 C 列写明原因（B 列留空，因为没执行）',
    /校验未通过/.test(undecided['执行结果']) && /内容类型/.test(undecided['执行结果']) && undecided['实际执行时间'] === '',
    undecided['执行结果']);
  ok('⑦ 标了「视频」那条真跑了，B/C 都落字（不再被一票否决）',
    !!videoPub['实际执行时间'] && /发布成功|失败/.test(videoPub['执行结果']),
    `${videoPub['实际执行时间']} / ${videoPub['执行结果']}`);
  ok('⑦ 真正发布的那行 B/C 都落字了', !!genRow['实际执行时间'] && /发布成功|失败/.test(genRow['执行结果']),
    `${genRow['实际执行时间']} / ${genRow['执行结果']}`);
  ok('⑦ 报告里本来就「发布成功」的行没被覆盖', doneRow['执行结果'] === '发布成功' && doneRow['实际执行时间'] === '2026-09-01 10:00:00',
    `${doneRow['实际执行时间']} / ${doneRow['执行结果']}`);

  // ---- ⑧ 报告被占用 → 整批暂存 → 恢复可写后下次先补写 ----
  fs.chmodSync(repFile, 0o444);
  const busy = await report.mergeResults(repFile, [{ reportRow: 4, at: '11:11:11', result: '发布成功', reason: '' }]);
  ok('⑧ 报告被占用时整批暂存（不静默丢）', busy.busy === true && busy.pending === 1, JSON.stringify({ busy: busy.busy, pending: busy.pending }));
  ok('⑧ 暂存进了报告自己的队列', report.pendingCount() === 1, 'report pending=' + report.pendingCount());
  fs.chmodSync(repFile, 0o644);
  const flushed = await report.mergeResults(repFile, []);
  ok('⑧ 恢复可写后下次先补写', flushed.flushed === 1 && flushed.updated === 1 && report.pendingCount() === 0, JSON.stringify(flushed));
  const flushedRows = await readBack(repFile);
  // reportRow 4 = Excel 第 4 行 = 第 3 条数据（readBack 只返回数据行，下标从 0 起）
  ok('⑧ 补写落在正确的行上（按导入时记的 Excel 行号）', flushedRows[2]['实际执行时间'] === '11:11:11', JSON.stringify(flushedRows[2]));

  // ---- ⑨ 表头缺列 / 路径不存在：说清缺什么 ----
  let noDir = '';
  try { await report.readReport(await writeReport(path.join(TMP, '缺列.xlsx'), ['标题', '好物1_货号'], [{ 标题: 'x', 好物1_货号: 'A' }])); } catch (e) { noDir = e.message; }
  ok('⑨ 表头没有「素材路径」时列出读到的表头', /找不到「素材路径」/.test(noDir) && /标题/.test(noDir), noDir);
  const bad = await report.build(await report.readReport(await writeReport(path.join(TMP, '路径不存在.xlsx'), COLS, [
    { 素材路径: path.join(TMP, '没有这个目录'), 好物1_货号: 'X1' }
  ])), {});
  ok('⑨ 素材路径不存在 → 记成 problem（说清哪一行、哪个路径）',
    bad.pairs.length === 0 && bad.problems.length === 1 && /不存在/.test(bad.problems[0].why), JSON.stringify(bad.problems));
  let all = '';
  try { await jobs.run('report.import', { file: path.join(TMP, '路径不存在.xlsx') }); } catch (e) { all = e.message; }
  ok('⑨ 一条都用不了时不假装成功', all === '' || /没有一条能用/.test(all), all || '（返回 ok:false）');

  // ---- ⑩ 报告里「素材路径」是空的（真机那份样本就是）→ 用导入时选的批次目录 ----
  const noPath = await writeReport(path.join(TMP, '没写路径.xlsx'), COLS, [
    { 好物1_货号: 'UWG460108', 好物1_颜色: '本白' },
    { 好物1_货号: 'UWG460110', 好物1_颜色: '本白' },
    { 好物1_货号: 'UWG460111' },
    { 好物1_货号: 'UWH760085', 好物1_颜色: '黑色条纹' }
  ]);
  const withDir = await jobs.run('report.import', { file: noPath, dir: batchDir });
  ok('⑩ 报告没写素材路径时，用选择的批次目录照样配成 4 条',
    withDir.ok === true && withDir.result.total === 4, withDir.error || JSON.stringify(withDir.result && withDir.result.total));
  ok('⑩ 选的素材目录被记进工程状态（界面能看到用的是哪个目录）',
    project.get().publish.reportDir === batchDir, project.get().publish.reportDir);
  const noDirGiven = await jobs.run('report.import', { file: noPath });
  ok('⑩ 既不写路径也不选目录 → 明确报错并提示去选目录',
    noDirGiven.ok === false && /素材路径/.test(noDirGiven.error) && /选一下这一批的素材目录/.test(noDirGiven.error), noDirGiven.error);

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('REPORT TEST ERROR', e); process.exitCode = 1; });
