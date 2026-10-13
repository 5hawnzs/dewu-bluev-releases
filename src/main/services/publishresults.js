'use strict';
// 发布结果与 Excel 回写分别记录；回写失败绝不能触发内容重发。
const path = require('path');
const sheet = require('./sheet');
const report = require('./report');
const logbus = require('../logbus');

async function finish(state, results) {
  const targets = [];
  if (state.sheet.file) targets.push({ name: '发布单', file: state.sheet.file,
    write: () => sheet.mergeResults(state.sheet.file, results) });
  if (state.publish.reportFile) targets.push({ name: '报告', file: state.publish.reportFile,
    write: () => report.mergeResults(state.publish.reportFile, results, { sheetName: state.publish.reportSheet }) });
  const outcomes = [];
  for (const target of targets) {
    let value;
    try { value = await target.write(); }
    catch (error) { value = { error: error.message }; }
    outcomes.push({ target: target.name, ...value });
    if (value.busy) {
      logbus.warn(`${target.name}仍被占用，${value.pending} 条结果已暂存，下次再试；已执行内容不会自动重发`);
    } else if (value.error) {
      logbus.error(`回写${target.name}失败：${value.error}；已执行内容不会自动重发`);
    } else if (value.updated) {
      logbus.ok(`已回写${target.name}：${value.updated} 行${value.flushed ? `（含补写上次的 ${value.flushed} 条）` : ''} → ${path.basename(target.file)}`);
    } else if (value.skipped) {
      logbus.info(`本次结果没有可回写的报告行（${value.skipped} 条不是从这份报告导进来的），跳过回写`);
    }
  }
  return { ok: outcomes.every(value => !value.busy && !value.error), targets: outcomes };
}
module.exports = { finish };
