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
  // 当前套件测发布/文案行为，显式准备品牌前置；配置仍只写测试临时目录。
  store.set({ brandsSeeded: true, brands: [{ id: 'brd_regression', name: '品牌甲', enabled: true,
    promptWrite: '请根据素材生成真实自然的种草文案。' }],
    paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    copy: { concurrency: 4, requiredTopic: '#品牌甲', extraTopics: 4 },
    publish: { intervalSec: 1, videoIntervalSec: 1 }   // 「演示节奏」开关已删：直接给 1 秒间隔；★ retry 也已删
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
  // ★★ 2026-10-03 事故回归：先「连接过设备」（mode=adb），再导入报告 —— 导入**不许**把它抹掉。
  //   抹掉的后果不是报错，而是 publisher.run 读不到 mode ⇒ **默认走模拟通道**（根本不碰设备），
  //   而界面/台账/回写全是绿的「发布成功」。用户实测就是「点了开始发布，模拟器里毫无动静」。
  project.patch({ publish: Object.assign({}, project.get().publish, { mode: 'adb', device: 'emulator-5554' }) });
  const imported = await jobs.run('report.import', { file: repFile });
  ok('⑦ 导入成功并生成发布队列', imported.ok === true && imported.result.total === 4, imported.error || JSON.stringify(imported.result && imported.result.total));
  const st = project.get();
  ok('⑦ 工程状态已替换为这份报告（items / copyRows / verify / publish）',
    st.items.length === 4 && st.copyRows.length === 4 && st.verify.rows.length === 1 && st.publish.rows.length === 4 && st.publish.reportFile === repFile,
    `items ${st.items.length} · copy ${st.copyRows.length} · verify ${st.verify.rows.length} · rows ${st.publish.rows.length}`);
  ok('⑦ 导入报告不会抹掉设备通道状态（mode / device 还在）',
    st.publish.mode === 'adb' && st.publish.device === 'emulator-5554',
    `mode=${st.publish.mode} device=${st.publish.device}`);
  // ★ 断言完必须把通道状态放回去：publish.run 读的就是它。留着 'adb' 会让下面那条端到端发布
  //   走真实通道（本套件没有设备 ⇒ 直接抛「需要先配 UI 定位表」），把 4 条无关断言一起带红。
  project.patch({ publish: Object.assign({}, project.get().publish, { mode: '', device: '' }) });
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
    !!videoPub['实际执行时间'] && /成功|失败/.test(videoPub['执行结果']),
    `${videoPub['实际执行时间']} / ${videoPub['执行结果']}`);
  ok('⑦ 真正发布的那行 B/C 都落字了', !!genRow['实际执行时间'] && /成功|失败/.test(genRow['执行结果']),
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

  // ---- ⑪ ★ 2026-10-02「设置 → 素材根目录」已删：相对路径不再有参照系 ----
  //   ① 报告里写相对路径 ⇒ 不再拿某个默认目录硬拼，改用「这次导入选的批次目录」；
  //   ② 只写相对路径、又没选目录 ⇒ 明确报错（绝不拼出一条指向别处的路径）。
  const relReport = await writeReport(path.join(TMP, '相对路径.xlsx'), COLS, [
    { 素材路径: '20260901', 好物1_货号: 'UWG460108', 好物1_颜色: '本白' },
    { 素材路径: '20260901', 好物1_货号: 'UWG460110', 好物1_颜色: '本白' },
    { 素材路径: '20260901', 好物1_货号: 'UWG460111' },
    { 素材路径: '20260901', 好物1_货号: 'UWH760085', 好物1_颜色: '黑色条纹' }
  ]);
  const relOk = await jobs.run('report.import', { file: relReport, dir: batchDir });
  ok('⑪ 报告写相对路径 ⇒ 不再拼「素材根目录」，改用这次选的批次目录',
    relOk.ok === true && relOk.result.total === 4, relOk.error || JSON.stringify(relOk.result && relOk.result.total));
  const relNoDir = await jobs.run('report.import', { file: relReport });
  ok('⑪ 相对路径 + 没选目录 ⇒ 明确报错（不拿默认目录硬拼一条指向别处的路径）',
    relNoDir.ok === false && /缺「素材路径」/.test(relNoDir.error), relNoDir.error);

  // ---- ⑫ ★ 2026-10-03 用户口径：报告里空着的货号/颜色 → 用叶子文件夹名（「货号+颜色」，以 + 号分隔）填 ----
  //   ① 只补空格子，报告里已填的一个都不动；
  //   ② 报告写的货号与叶子名里的对不上 ⇒ 不补（宁缺勿错），点名让人去看；
  //   ③ 文件夹名不是「货号+颜色」（随手命名 / 老式三层）⇒ 不猜，点名。
  const plusDir = makeBatch(path.join(TMP, '品牌甲', '20260902'), {
    '26FW-YB160+冠军白_1': ['1.jpg'],
    'UWH760085+黑色条纹_1': ['1.jpg']
  });
  const plusFile = await writeReport(path.join(TMP, '待补货号颜色.xlsx'), COLS, [
    { 素材路径: plusDir, 标题: 't1', 文案: 'b1' },
    { 素材路径: plusDir, 标题: 't2', 文案: 'b2' }
  ]);
  const plusBuilt = await report.build(await report.readReport(plusFile), {});
  ok('⑫ 报告里货号/颜色空着 ⇒ 按叶子文件夹名「货号+颜色」补上',
    plusBuilt.fills.length === 2 && plusBuilt.filled.sku === 2 && plusBuilt.filled.color === 2
    && (plusBuilt.publishRows[0].goodsList[0] || {}).sku === '26FW-YB160'
    && (plusBuilt.publishRows[0].goodsList[0] || {}).color === '冠军白'
    && (plusBuilt.publishRows[1].goodsList[0] || {}).color === '黑色条纹',
    JSON.stringify(plusBuilt.publishRows.map(r => r.goodsList)));
  ok('⑫ 叶子名末尾的「_序号」不会被当成颜色（冠军白_1 ⇒ 冠军白）',
    (plusBuilt.items[0].goods[0] || {}).color === '冠军白' && !/_\d+$/.test((plusBuilt.items[0].goods[0] || {}).color),
    plusBuilt.items.map(i => i.sku + '/' + i.color).join(' | '));
  ok('⑫ 补了几条会写进说明（不静默补）',
    /按叶子文件夹名（货号\+颜色）补上了 2 条/.test(plusBuilt.notes.join('')), plusBuilt.notes.join(' | '));

  const multiDir = makeBatch(path.join(TMP, '品牌甲', '20261009'), {
    '26FW-YB160+冠军白+UWG760094+雾霾蓝': ['1.jpg']
  });
  const multiFile = await writeReport(path.join(TMP, '双好物自动补齐.xlsx'), COLS.concat(['好物2_颜色']), [
    { 素材路径: multiDir, 标题: '双好物', 文案: '两款关联' }
  ]);
  const multiReport = await report.readReport(multiFile);
  const multiBuilt = await report.build(multiReport, {});
  ok('⑫ 双好物目录按成对货号/颜色补入两个好物位',
    multiBuilt.fills.length === 2
    && multiBuilt.publishRows[0].goodsList.length === 2
    && multiBuilt.publishRows[0].goodsList[0].sku === '26FW-YB160'
    && multiBuilt.publishRows[0].goodsList[1].sku === 'UWG760094'
    && multiBuilt.publishRows[0].goodsList[1].color === '雾霾蓝',
    JSON.stringify(multiBuilt.publishRows[0].goodsList));
  const multiWrite = await report.fillGoods(multiFile, multiBuilt.fills, { sheetName: multiReport.sheetName });
  const multiBack = await readBack(multiFile);
  ok('⑫ 双好物自动补齐会分别写回好物1和好物2列',
    multiWrite.updated === 1 && multiBack[0]['好物1_货号'] === '26FW-YB160'
    && multiBack[0]['好物2_货号'] === 'UWG760094' && multiBack[0]['好物2_颜色'] === '雾霾蓝',
    JSON.stringify({ write: multiWrite, row: multiBack[0] }));

  // ⑫d ★★ 2026-10-03 真机实测（E:\bluev_beta\0901_2）：「批次目录 / 货号 / 序号」三层、**颜色没填**。
  //     老逻辑把批次目录名当货号、真货号当颜色。正确行为：只补货号、颜色留空，并点名。
  const skuOnlyDir = makeBatch(path.join(TMP, '品牌乙'), {
    '0901_2/3261163003/1': ['1.jpg'],
    '0901_2/3261163003/2': ['2.jpg']
  });
  const skuOnlyFile = await writeReport(path.join(TMP, '只填货号.xlsx'), COLS, [
    { 素材路径: skuOnlyDir, 标题: 't1', 文案: 'b1' },
    { 素材路径: skuOnlyDir, 标题: 't2', 文案: 'b2' }
  ]);
  const skuOnlyBuilt = await report.build(await report.readReport(skuOnlyFile), {});
  ok('⑫d ★★ 「批次目录/货号/序号」三层：货号取真货号、颜色留空（不许写成 0901_2 / 3261163003）',
    skuOnlyBuilt.items.length === 2
    && skuOnlyBuilt.items.every(i => i.sku === '3261163003' && i.color === '')
    && skuOnlyBuilt.publishRows.every(r => (r.goodsList[0] || {}).sku === '3261163003' && !(r.goodsList[0] || {}).color),
    JSON.stringify(skuOnlyBuilt.items.map(i => i.sku + '/' + i.color)));
  ok('⑫d 只有货号、没颜色的行会被点名（不静默补，也不瞎猜颜色）',
    skuOnlyBuilt.filled.noColor.length === 2 && /没写颜色/.test(skuOnlyBuilt.notes.join('')),
    JSON.stringify({ noColor: skuOnlyBuilt.filled.noColor, notes: skuOnlyBuilt.notes }));
  ok('⑫d 这批的颜色统计必须是 0（不许把货号算成颜色）',
    skuOnlyBuilt.filled.color === 0 && skuOnlyBuilt.filled.sku === 2,
    JSON.stringify({ sku: skuOnlyBuilt.filled.sku, color: skuOnlyBuilt.filled.color }));

  const plusImport = await jobs.run('report.import', { file: plusFile });
  ok('⑫ 导入时把补出来的值真写回报告文件（只填空格）',
    plusImport.ok === true && (plusImport.result.fillWrite || {}).updated === 2,
    plusImport.error || JSON.stringify(plusImport.result && plusImport.result.fillWrite));
  const plusBack = await readBack(plusFile);
  ok('⑫ 写回后报告里「好物1_货号 / 好物1_颜色」真的有值了',
    plusBack[0]['好物1_货号'] === '26FW-YB160' && plusBack[0]['好物1_颜色'] === '冠军白'
    && plusBack[1]['好物1_货号'] === 'UWH760085' && plusBack[1]['好物1_颜色'] === '黑色条纹',
    JSON.stringify(plusBack.map(r => [r['好物1_货号'], r['好物1_颜色']])));

  const keepDir = makeBatch(path.join(TMP, '品牌甲', '20260903'), { '26FW-YB160+冠军白_1': ['1.jpg'] });
  const keepFile = await writeReport(path.join(TMP, '不能覆盖.xlsx'), COLS, [
    { 素材路径: keepDir, 好物1_货号: 'X9-KEEP', 好物1_颜色: '深灰' }
  ]);
  const keepBuilt = await report.build(await report.readReport(keepFile), {});
  ok('⑫ 报告里已填的货号/颜色一个都不动（只补空格子）',
    keepBuilt.fills.length === 0
    && (keepBuilt.publishRows[0].goodsList[0] || {}).sku === 'X9-KEEP'
    && (keepBuilt.publishRows[0].goodsList[0] || {}).color === '深灰',
    JSON.stringify(keepBuilt.publishRows[0].goodsList));

  const mixFile = await writeReport(path.join(TMP, '货号对不上.xlsx'), COLS, [
    { 素材路径: keepDir, 好物1_货号: 'UWG999999' }
  ]);
  const mixBuilt = await report.build(await report.readReport(mixFile), {});
  ok('⑫ 报告货号与叶子名对不上 ⇒ 颜色留空不补，并说清哪一行对不上',
    mixBuilt.fills.length === 0 && mixBuilt.filled.mismatch.length === 1
    && (mixBuilt.publishRows[0].goodsList[0] || {}).color === '' && /对不上/.test(mixBuilt.notes.join('')),
    JSON.stringify({ fills: mixBuilt.fills.length, mismatch: mixBuilt.filled.mismatch }));

  const plainDir = makeBatch(path.join(TMP, '品牌甲', '20260904'), { 'IMG_5253': ['1.jpg'] });
  const plainFile = await writeReport(path.join(TMP, '名字里没加号.xlsx'), COLS, [{ 素材路径: plainDir }]);
  const plainBuilt = await report.build(await report.readReport(plainFile), {});
  ok('⑫ 文件夹名不是「货号+颜色」⇒ 不猜，明确点名（不往报告里写假货号）',
    plainBuilt.fills.length === 0 && plainBuilt.filled.noParse.length === 1
    && plainBuilt.publishRows[0].goodsList.length === 0
    && /不是「货号\+颜色」/.test(plainBuilt.notes.join('')),
    JSON.stringify({ fills: plainBuilt.fills.length, noParse: plainBuilt.filled.noParse, notes: plainBuilt.notes }));

  // ---- ⑬ 报告落点：跟着 items 走，不跟着「每次现场选的源目录」走 ----
  //   ★ 为什么单列一条：落点错了**不会报错**，文件会安安静静掉进另一个文件夹，
  //     人在整理后的带时间戳目录里干活，报告却回到还没处理的原始目录（2026-10-03 用户实测）。
  const flatDir = path.join(TMP, 'flat_20261003-0000');
  const srcDir = path.join(TMP, '原始素材');
  ok('⑬ 报告落点 = items 实际所在的父目录（不是原始素材目录）',
    jobs.itemsDir([{ absDir: path.join(flatDir, 'A+白_1') }], srcDir) === flatDir,
    jobs.itemsDir([{ absDir: path.join(flatDir, 'A+白_1') }], srcDir));
  ok('⑬ 一条 items 都没有时才退回调用方给的兜底值',
    jobs.itemsDir([], srcDir) === srcDir, jobs.itemsDir([], srcDir));
  ok('⑬ items 只有相对名字（dir）时按它的父目录算',
    jobs.itemsDir([{ dir: 'flat_x/A+白_1' }], srcDir) === 'flat_x',
    jobs.itemsDir([{ dir: 'flat_x/A+白_1' }], srcDir));

  // ⑭ 2026-10-03 ★ copyRows 必须带上 sku / color
  //    文案生成页的「货号 / 颜色」两列读的就是 copyRows（app.js：`rows.length ? rows : …`）。
  //    以前构造 copyRows 时只给了 { id, title, body, topics, status, from }，
  //    没带 sku/color ⇒ 那两列恒为空，看着像「这条没解析出货号」，其实 items 里早就有值。
  {
    const noSku = built.copyRows.filter(r => !r.sku);
    ok('⑭ copyRows 每条都要带 sku（文案生成页的「货号」列读的就是它）',
      built.copyRows.length > 0 && noSku.length === 0,
      built.copyRows.map(r => r.id + '→sku=' + (r.sku || '空')).join(' | '));
    ok('⑭ 「货号+颜色」命名的那些，颜色也要一起带过来',
      built.copyRows.some(r => r.color),
      built.copyRows.map(r => r.id + '→color=' + (r.color || '空')).join(' | '));
    // 交叉核对：同一条在 items 与 copyRows 里的货号/颜色必须对得上（不许一边有一边空）
    const byId = new Map(built.items.map(i => [i.id, i]));
    const diff = built.copyRows.filter(r => {
      const it = byId.get(r.id);
      return it && (String(it.sku || '') !== String(r.sku || '')
        || String(it.color || '') !== String(r.color || ''));
    });
    ok('⑭ copyRows 与 items 的货号/颜色必须一致（不许一边有一边空）',
      diff.length === 0, diff.map(r => r.id).join(' | ') || '（全部一致）');
  }

  // ---- ⑮ ★★ 工程状态自愈：旧工程里存下的「批次目录名当货号」必须被纠正 ----
  //   为什么单独测（2026-10-04 用户**第二次**报「货号里还是批次目录名 0901_2」）：
  //   `project.json` 的 items 是素材整理那一次算好的，之后一直沿用 —— 文案生成 / 出报告 / 发布
  //   都只读它，谁都不会回文件夹看第二眼。旧版存下的 `sku:'0901_2' / color:'3261163003'`
  //   就一直躺在工程状态里，报告的好物列直接取它 ⇒ 一直错，**重跑文案生成也修不好**。
  //   真机取证：E:\bluev_beta 那份工程的 items[9]/items[13] 就是这两条错值。
  {
    const flat = path.join(TMP, 'bluev_beta', 'flat_20261002-2329');
    const stale = {
      projectName: '还原真机现场', sourceDir: path.join(TMP, 'bluev_beta', '0901_2'), flatDir: flat,
      updatedAt: 0,
      items: [
        // 真机 project.json 里就是这样两条：id 是「+连接的显示名」，sku/color 是旧版算出来的错值
        { id: '3261163003+1', dir: '3261163003+1', absDir: path.join(flat, '3261163003_1'), sku: '0901_2', color: '3261163003' },
        { id: '3261132007+煤黑色01+1', dir: '3261132007+煤黑色01+1', absDir: path.join(flat, '3261132007+煤黑色01_1'), sku: '3261132007', color: '煤黑色01' },
        { id: 'IMG_5253', dir: 'IMG_5253', absDir: path.join(TMP, '品牌甲', '20260901', 'IMG_5253'), sku: '20260901', color: 'IMG_5253' }
      ],
      publish: { rows: [] }
    };
    fs.writeFileSync(path.join(TMP, 'project.json'), JSON.stringify(stale), 'utf8');
    project.load();
    const g = project.get().items;
    ok('⑮ ★★ 旧工程一打开就自愈：sku=0901_2 / color=3261163003 ⇒ 3261163003 / 空（不必重跑素材整理）',
      g[0].sku === '3261163003' && g[0].color === '', JSON.stringify(g[0]));
    ok('⑮ 已经对的条目原样保留（货号 + 颜色 一起带过来，不许被弄掉）',
      g[1].sku === '3261132007' && g[1].color === '煤黑色01', JSON.stringify(g[1]));
    ok('⑮ 解析不可信的条目一个字不改（宁可留着让人补，也不把假货号写进运营的账）',
      g[2].sku === '20260901' && g[2].color === 'IMG_5253', JSON.stringify(g[2]));

    // 「程序已经开着、工程状态却是旧的」这一路：patch 也得过一遍自愈。
    project.patch({ items: [{ id: '3261163003+1', absDir: path.join(flat, '3261163003_1'), sku: '0901_2', color: '3261163003' }] });
    ok('⑮ 运行中写进来的旧状态也会被 patch 这一步纠正（不是只在开场 load 修一次）',
      project.get().items[0].sku === '3261163003' && project.get().items[0].color === '',
      JSON.stringify(project.get().items[0]));

    // ★ 闭环：自愈后的工程状态**真的**写进了 AI 内容报告的好物列（用户看的就是这一列）
    const aireport = require(path.join(base, 'src/main/services/aireport.js'));
    const rp = await aireport.write({
      dir: TMP, fallbackDir: TMP, batch: '自愈回归', brandName: 'TW男装',
      sourceDir: path.join(TMP, 'bluev_beta', '0901_2'),
      items: project.get().items, rows: []
    });
    const wbx = new ExcelJS.Workbook();
    await wbx.xlsx.readFile(rp.file);
    const wsx = wbx.getWorksheet('AI 内容报告');
    const hx = (wsx.getRow(1).values || []).slice(1).map(String);
    const iSku = hx.indexOf('好物1_货号') + 1, iCol = hx.indexOf('好物1_颜色') + 1;
    const rowSku = String((wsx.getRow(2).values || [])[iSku] == null ? '' : (wsx.getRow(2).values || [])[iSku]);
    const rowCol = String((wsx.getRow(2).values || [])[iCol] == null ? '' : (wsx.getRow(2).values || [])[iCol]);
    ok('⑮ ★★ 闭环：报告「好物1_货号」不再是 0901_2（批次目录名），而是真货号 3261163003',
      rowSku === '3261163003' && !/0901_2/.test(rowSku), `货号=${rowSku} 颜色=${rowCol}`);
  }

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('REPORT TEST ERROR', e); process.exitCode = 1; });
