'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const uimap = require('../src/main/services/uimap');
let count = 0;
function ok(name, condition) { assert(condition, name); count++; console.log('PASS ' + name); }
function fixture({ known = true, mumu = true, densityFailure = false, overrides = false } = {}) {
  const commands = [];
  const adb = {
    uiSize: async () => ({ known, w: 900, h: 1600, initW: 900, initH: 1600 }),
    shell: async (serial, command, options) => {
      commands.push({ serial, command, options });
      return { ok: !(densityFailure && command === 'wm density 280'), stdout: command === 'wm size'
        ? 'Physical size: 900x1600' + (overrides ? '\nOverride size: 720x1280' : '')
        : command === 'wm density' ? 'Physical density: 240' + (overrides ? '\nOverride density: 200' : '') : '' };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/services/displayrecovery.js'), 'utf8'), {
    module, require: name => name === './adb' ? adb : { discover: async () => ({ instances: mumu ? [{ serial: 'LOCAL' }] : [] }) }
  });
  return { service: module.exports, commands };
}
(async () => {
  let f = fixture();
  const verified = { known: true, w: 1080, h: 1920, density: 280 };
  const result = await f.service.repair('LOCAL', { w: 1080, h: 1920 }, { check: async () => verified });
  ok('900×1600 自动恢复定位表尺寸与实测 DPI，只操作当前实例', result === verified
    && f.commands.map(c => c.command).join('|') === 'wm size|wm density|wm size 1080x1920|wm density 280'
    && f.commands.every(c => c.serial === 'LOCAL' && c.options.timeout === 5000));
  f = fixture({ overrides: true });
  await assert.rejects(f.service.repair('LOCAL', verified, { check: async () => ({ ...verified, w: 900 }) }), /已恢复原显示设置/);
  ok('验证不通过则恢复原覆盖设置，不假装修复成功', f.commands.slice(-2).map(c => c.command).join('|') === 'wm size 720x1280|wm density 200');
  f = fixture({ densityFailure: true });
  await assert.rejects(f.service.repair('LOCAL', verified, { check: async () => verified }), /命令失败/);
  ok('部分设置失败也回滚，原来无覆盖值则 reset', f.commands.slice(-2).map(c => c.command).join('|') === 'wm size reset|wm density reset');
  f = fixture({ mumu: false });
  await assert.rejects(f.service.repair('PHONE', verified, { check: async () => verified }), /未确认/);
  ok('真机或非目标 MuMu 不修改显示设置', !f.commands.length);
  f = fixture({ known: false });
  await assert.rejects(f.service.repair('LOCAL', verified, { check: async () => verified }), /自然方向/);
  ok('尺寸未知不猜测、不修改', !f.commands.length);
  f = fixture();
  await assert.rejects(f.service.repair('LOCAL', verified, { cancelled: () => true }), /取消/);
  ok('取消后不执行显示修改', !f.commands.length);
  ok('自定义表采用自带 DPI，未验证的旧表不猜 DPI', f.service.targetOf({ w: 720, h: 1280, density: 220 }).density === 220
    && f.service.targetOf({ w: 720, h: 1280 }) === null && f.service.targetOf({ w: '1080;bad', h: 1920 }) === null);
  ok('尺寸相同但 DPI 不同也能识别', uimap.screenMismatch({ w: 1080, h: 1920, density: 280 }, { ...verified, density: 240 }).mismatch);
  ok('新抓取定位表保留 DPI；旧表缺少 DPI 仍可读取', uimap.screenStamp(verified).density === 280
    && !uimap.screenMismatch({ w: 1080, h: 1920 }, verified).mismatch);
  console.log(`\n${count} PASS, 0 FAIL`);
})().catch(e => { console.error(e); process.exitCode = 1; });
