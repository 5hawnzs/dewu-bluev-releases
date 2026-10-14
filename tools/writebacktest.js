'use strict';
// 通过真实任务入口和临时 Excel 验证；仅替换桌面宿主，不替换内部发布与回写模块。
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-writeback-'));
let afterPublished = () => {};
let rejectQuery = false;
const load = Module._load;
Module._load = function(name) {
  if (name === 'electron') return {
    app: { getPath: () => tmp, getVersion: () => '1.1.2', isPackaged: false },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, setProgressBar() {},
      webContents: { send(channel, row) { if (channel === 'publish:row' && ['模拟成功', '发布成功', '失败', '已取消'].includes(row.result)) afterPublished(); } } }] },
    Notification: { isSupported: () => false }
  };
  return load.apply(this, arguments);
};
const deviceDir = path.join(tmp, 'fakeadb'); fs.mkdirSync(deviceDir);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(deviceDir, file));
fs.writeFileSync(path.join(deviceDir, 'IME_ACTIVE'), '1');
fs.writeFileSync(path.join(deviceDir, 'FOCUS'), 'com.shizhuang.duapp/.modules.home.ui.HomeActivity');
const fakeAdb = require('./fakeadb/adb').makeFakeAdb(deviceDir);
require('child_process').execFile = (bin, args, options, callback) => {
  if (rejectQuery && args.some(arg => String(arg).startsWith('content query '))) {
    const error = new Error('Permission denied'); error.code = 1;
    return callback(error, '', 'Permission denied');
  }
  return fakeAdb(bin, args, options, callback);
};
const ExcelJS = require('exceljs');
const store = require('../src/main/store'), project = require('../src/main/project');
const jobs = require('../src/main/jobs'), logs = require('../src/main/logbus');
const sheet = require('../src/main/services/sheet');
const report = require('../src/main/services/report');
store.set({ brandsSeeded: true, brands: [{ id: 'test', name: '回写测试', enabled: true }],
  paths: { output: path.join(tmp, 'output'), rejected: path.join(tmp, 'rejected') }, publish: { intervalSec: 0, device: 'FAKE', submissionWaitMs: 1000,
    uiMap: { package: 'com.shizhuang.duapp', steps: [{ name: '提交发布', action: 'tapText', value: '发布' }] } } });
const ok = (name, value) => { assert(value, name); console.log('PASS ' + name); };
async function runCase(type, fault, mode = 'mock') {
  const callsFile = path.join(deviceDir, 'calls.log');
  const beforeCalls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').length : 0;
  const reportFile = path.join(tmp, type.replace('.', '-') + '-' + fault + '.xlsx');
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('AI 内容报告');
  ws.addRow(['素材路径', '实际执行时间', '执行结果']); ws.addRow(['A', '', '']);
  await wb.xlsx.writeFile(reportFile);
  const item = { id: 'A', dir: 'A', absDir: tmp, files: [{ name: '1.jpg', type: 'image' }] };
  const sh = await sheet.exportSheet({ items: [item], copyRows: [], verify: { rows: [] } });
  project.patch({ items: [item], copyRows: [], verify: { rows: [] }, sheet: { file: sh.file },
    publish: { mode, device: 'FAKE', batch: type + fault, reportFile, reportSheet: 'AI 内容报告',
      rows: [{ seq: 1, id: 'A', dir: 'A', reportRow: 2, result: '' }] } });
  let published = 0;
  afterPublished = () => {
    published++;
    if (fault === 'corrupt') fs.writeFileSync(sh.file, '损坏的工作簿');
    if (fault === 'locked') { fs.chmodSync(sh.file, 0o444); fs.chmodSync(reportFile, 0o444); }
    if (fault === 'report-corrupt') fs.writeFileSync(reportFile, '损坏的报告');
  };
  const start = logs.history().length;
  let result;
  try { result = await jobs.run(type, { seq: 1 }); }
  finally { afterPublished = () => {}; fs.chmodSync(sh.file, 0o644); fs.chmodSync(reportFile, 0o644); }
  const commands = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').slice(beforeCalls) : '';
  return { result, entries: logs.history().slice(start), published, reportFile, sheetFile: sh.file, commands };
}
(async () => {
  const r = await runCase('publish.rerun', 'corrupt');
  ok('重跑发布后发布单损坏，必须给出可见回写错误', r.entries.some(e => e.tier !== 'detail' && /回写发布单失败/.test(e.msg)));
  ok('回写失败不能只显示无条件的重跑成功', r.entries.some(e => /模拟重跑完成.*回写待处理/.test(e.msg))
    && !r.entries.some(e => /^\[.*\] 重跑成功【/.test(e.msg)));
  ok('模拟重跑遇到回写失败也必须保留模拟限定', r.entries.some(e => /模拟重跑完成.*回写待处理/.test(e.msg)));
  for (const type of ['publish.run', 'publish.rerun']) {
    const broken = await runCase(type, 'corrupt');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(broken.reportFile);
    ok(type + ' 发布单失败不阻断另一份报告回写且不重复发布',
      broken.published === 1 && broken.result.result.failCount === 0
      && broken.result.result.writeback.ok === false && /模拟成功/.test(wb.worksheets[0].getRow(2).getCell(3).text));
    const normal = await runCase(type, 'normal');
    await wb.xlsx.readFile(normal.sheetFile);
    ok(type + ' 正常发布单回写保留模拟结果，不能冒充真发布', normal.result.result.writeback.ok
      && wb.worksheets[0].getRow(2).getCell(21).text === '模拟成功'
      && !normal.entries.some(e => /重跑成功【/.test(e.msg)));
    if (type === 'publish.rerun') ok('模拟重跑按实际模拟行数显示一条成功',
      normal.entries.some(e => /模拟重跑完成【目标 1 条，模拟成功 1 条，失败 0 条】/.test(e.msg)));
    const locked = await runCase(type, 'locked');
    ok(type + ' 发布后才占用时两份结果均暂存并明确提示', locked.published === 1
      && !locked.result.result.writeback.ok && sheet.pendingCount() === 2 && report.pendingCount() === 1
      && locked.entries.some(e => /已暂存/.test(e.msg)));
    const sheetFlush = await sheet.mergeResults(locked.sheetFile, []);
    const reportFlush = await report.mergeResults(locked.reportFile, [], { sheetName: 'AI 内容报告' });
    ok(type + ' 解除占用后两份结果可补写，不需重发', sheetFlush.flushed === 1 && reportFlush.flushed === 1
      && sheet.pendingCount() === 0 && report.pendingCount() === 0);
    const badReport = await runCase(type, 'report-corrupt');
    ok(type + ' 损坏报告明确报错，不能伪装占用或等待补写', !badReport.result.result.writeback.ok
      && report.pendingCount() === 0 && badReport.entries.some(e => /回写报告失败/.test(e.msg)));
  }
  // 不同报告同一行号不能互相消费；补写 A 后仍须保留 B。
  const reportA = path.join(tmp, '隔离报告A.xlsx'), reportB = path.join(tmp, '隔离报告B.xlsx');
  for (const file of [reportA, reportB]) {
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('AI 内容报告');
    ws.addRow(['素材路径', '实际执行时间', '执行结果']); ws.addRow(['A', '', '']);
    await wb.xlsx.writeFile(file);
  }
  sheet.putPending('report', [
    { target: 'report', file: reportA, reportRow: 2, result: '发布成功' },
    { target: 'report', file: reportB, reportRow: 2, result: '失败', reason: 'B 独有' }
  ]);
  await report.mergeResults(reportA, []);
  ok('补写报告 A 只消费 A，报告 B 暂存不丢失', sheet.takePending('report').length === 1
    && sheet.takePending('report')[0].file === reportB);
  await report.mergeResults(reportB, []);
  const sheetA = await sheet.exportSheet({ items: [{ id: 'A', dir: 'A' }], copyRows: [], verify: { rows: [] } });
  const sheetB = path.join(tmp, '隔离发布单B.xlsx'); fs.copyFileSync(sheetA.file, sheetB);
  sheet.putPending('sheet', [{ target: 'sheet', file: sheetB, seq: 1, result: '失败', reason: 'B 独有' }]);
  const onlyA = await sheet.mergeResults(sheetA.file, []);
  const checkA = new ExcelJS.Workbook(); await checkA.xlsx.readFile(sheetA.file);
  ok('发布单 A 不补写同序号的 B 结果，也不消费 B 暂存', onlyA.updated === 0
    && checkA.worksheets[0].getRow(2).getCell(21).text === '待发布'
    && sheet.takePending('sheet').length === 1);
  await sheet.mergeResults(sheetB, []);
  // 旧版发布单暂存没有 file，不能用相同行号猜测目标；保留待人工核对。
  const legacy = { seq: 1, result: '发布成功', at: '历史时间' };
  sheet.putPending('sheet', [legacy]);
  sheet.putPending('report', [{ reportRow: 2, result: '失败', reason: '历史报告', target: 'report' }]);
  const legacySheet = await sheet.mergeResults(sheetA.file, []);
  const legacyReport = await report.mergeResults(reportA, []);
  ok('无目标文件的历史暂存不写入当前工作簿，也不静默丢弃', legacySheet.updated === 0
    && legacyReport.updated === 0 && sheet.pendingCount() === 2);
  sheet.putPending('sheet', []); sheet.putPending('report', []);
  // A 再次被占用时仅替换 A 的积压，B 的结果必须原样留下。
  sheet.putPending('report', [{ target: 'report', file: reportB, reportRow: 2, result: '失败', reason: 'B 独有' }]);
  fs.chmodSync(reportA, 0o444);
  let busyA;
  try { busyA = await report.mergeResults(reportA, [{ reportRow: 2, result: '发布成功' }]); }
  finally { fs.chmodSync(reportA, 0o644); }
  ok('报告 A 被占用暂存时保留报告 B 的积压', busyA.busy && sheet.takePending('report').length === 2
    && sheet.takePending('report').some(r => r.file === reportB && r.reason === 'B 独有'));
  await report.mergeResults(reportA, []); await report.mergeResults(reportB, []);
  const submitted = await runCase('publish.rerun', 'corrupt', 'adb');
  ok('真实发布流程配假设备：已提交与回写失败独立，不自动重发', submitted.published === 1
    && submitted.result.result.okCount === 1 && submitted.result.result.failCount === 0
    && (submitted.commands.match(/input tap /g) || []).length === 1
    && !submitted.result.result.writeback.ok
    && submitted.entries.some(e => /重跑已完成（回写待处理）/.test(e.msg)));
  rejectQuery = true;
  const failed = await runCase('publish.rerun', 'corrupt', 'adb');
  rejectQuery = false;
  ok('清理失败同时回写失败，必须保留发布失败结论', failed.result.result.okCount === 0
    && failed.result.result.failCount === 1 && !failed.result.result.writeback.ok
    && !/input tap /.test(failed.commands)
    && failed.entries.some(e => /重跑结束（失败）/.test(e.msg))
    && !failed.entries.some(e => /重跑已完成/.test(e.msg)));
})().catch(e => { console.error(e); process.exitCode = 1; });
