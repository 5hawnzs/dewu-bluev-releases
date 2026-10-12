'use strict';
// 用户授权的本机分辨率验证：不清相册、不推素材、不提交发布、不写云端任务。
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-screen-'));
const original = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { app: { getPath: () => tmp, getVersion: () => '1.1.1' }, BrowserWindow: { getAllWindows: () => [] } };
  return original.apply(this, arguments);
};
const adb = require('../src/main/services/adb');
const uimap = require('../src/main/services/uimap');
const publisher = require('../src/main/services/publisher');
adb.setBundledAdbDir(path.join(root, 'vendor/adb'));
const source = fs.readFileSync(path.join(root, 'src/main/services/publisher.js'), 'utf8');
const from = source.indexOf('async function stableCoordinates(');
const to = source.indexOf('/** 支持', from);
const stableCoordinates = vm.runInNewContext(source.slice(from, to) + '\nstableCoordinates;', { adb, uimap, Date, setTimeout, Error, Number, Promise });
const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'dewu-bluev-publisher/config.json'), 'utf8'));
const serial = config.publish.device;
const step = config.publish.uiMap.steps.find(s => s.action === 'tapXY' && /底部/.test(s.name || ''));
if (!step) throw Error('找不到已配置的底部导航步骤');
const expected = { w: 1080, h: 1920 };
let tapCount = 0;
const tapSeq = adb.tapSeq;
adb.tapSeq = async (...args) => { tapCount++; return tapSeq(...args); };
(async () => {
  const report = { at: new Date().toISOString(), serial, expected, live: await adb.uiSize(serial), step: { name: step.name, value: step.value } };
  try {
    report.stable = await stableCoordinates(serial, expected, { cancelled: () => false });
    report.guard = '允许';
  } catch (e) { report.guard = '拦截'; report.error = e.message; report.code = e.code; }
  report.bounds = uimap.outOfScreenTapPoints([step], report.live);
  if (process.argv.includes('--tap')) {
    try {
      await publisher.runStep(serial, step, {}, { uiMapScreen: expected, cancelled: () => false, log: () => {} });
      report.stepResult = '执行完成';
    } catch (e) { report.stepResult = '拦截'; report.stepError = e.message; }
  }
  report.tapCommands = tapCount;
  report.focus = await adb.currentFocus(serial);
  fs.writeFileSync(path.join(root, '../investigation-20261012', 'screen-' + report.live.w + 'x' + report.live.h + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
