'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const diagnostics = require('../src/main/services/diagnostics');
const moduleBox = { exports: {} };
let commands = 0;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/services/adb.js'), 'utf8'), {
  module: moduleBox, exports: moduleBox.exports, process, Buffer, console, setTimeout, clearTimeout,
  require: name => name === './diagnostics' ? diagnostics : name === 'child_process' ? {
    execFile: (_file, args, _opts, callback) => {
      commands++;
      const failed = String(args.at(-1)).startsWith('find ');
      setTimeout(() => callback(failed ? Object.assign(new Error('超时'), { killed: true, signal: 'SIGTERM', code: null }) : null,
        'PRIVATE_OUTPUT', 'Bearer PRIVATE_TOKEN'), failed ? 20 : 5);
    }
  } : require(name)
});
const adb = moduleBox.exports;
(async () => {
  const first = diagnostics.create({ version: '1.1.1', build: 2026101208 });
  const second = diagnostics.create({ version: '1.1.1', build: 2026101208 });
  await Promise.all([
    diagnostics.run(first, async () => { diagnostics.phase('清理素材文件', 2); await adb.shell('DEVICE_PRIVATE', 'find /private/file -type f', { timeout: 8000 }); }),
    diagnostics.run(second, async () => { diagnostics.phase('执行发布步骤', 1); await adb.shell('OTHER_PRIVATE', 'input text PASSWORD_PRIVATE'); })
  ]);
  assert.equal(first.failures.length, 1); assert.equal(first.commands[0].op, 'find');
  assert.equal(second.failures.length, 0); assert.equal(second.commands[0].op, 'input');
  assert.equal(first.commands[0].row, 2); assert.equal(second.commands[0].row, 1);
  console.log('PASS 并发任务诊断互相隔离，失败不会串到其他设备任务');
  assert.equal(commands, 2); assert.equal(first.commands[0].timeoutMs, 8000); assert(first.commands[0].killed);
  assert.equal(first.commands[0].signal, 'SIGTERM'); assert(first.commands[0].ms >= 0);
  console.log('PASS 记录实际命令限时、终止信号及耗时，不额外执行设备指令');
  const json = JSON.stringify(diagnostics.snapshot(first)) + JSON.stringify(diagnostics.snapshot(second));
  assert(!/PRIVATE|private\/|Bearer/.test(json));
  console.log('PASS 不保存设备串、文件路径、输入内容及原始输出或凭据');
  const formatted = diagnostics.format(diagnostics.snapshot(first));
  assert(formatted.includes('2026101208') && formatted.includes('find:') && formatted.includes('SIGTERM') && formatted.includes('limit=8000'));
  console.log('PASS 诊断摘要包含构建、命令类别和可远程排查的终止信息');
  diagnostics.run(first, () => {
    for (let i = 0; i < 30; i++) diagnostics.record(['shell', 'ls /secret'], { ok: false, code: 1 }, i, 'bundled');
  });
  assert.equal(first.commands.length, 6); assert.equal(first.failures.length, 4); assert.equal(first.count, 31);
  console.log('PASS 每个任务诊断有固定容量，长批次不会无限增长');
  const malicious = diagnostics.format({ version: 'Bearer SECRET', build: 2026101208, phase: 'C:\\private\\SECRET',
    commands: [{ op: 'input PASSWORD_SECRET', stdout: 'SECRET' }], failures: [{ op: 'find', ms: 1, signal: 'SECRET', source: 'C:\\secret' }] });
  assert(!/SECRET|private|C:/.test(malicious));
  console.log('PASS 格式化只接受白名单字段，恶意标签和多余输出不会进入云端');
  const phases = [];
  const staged = diagnostics.create({ version: '1.1.1', build: 2026101302, onPhase: p => phases.push(p) });
  await diagnostics.run(staged, async () => {
    diagnostics.phase('清理素材文件', 1);
    await new Promise(r => setTimeout(r, 25));
    diagnostics.record(['shell', 'find /private'], { ok: true }, 20, 'bundled');
    diagnostics.phase('推送及索引素材', 1);
    await new Promise(r => setTimeout(r, 15));
    diagnostics.phase('条目结束');
  });
  assert.equal(phases.length, 2); assert.equal(phases[0].commandCount, 1);
  assert(phases[0].elapsedSec >= .02 && phases[1].elapsedSec >= .01);
  assert.equal(phases[0].row, 1); assert.equal(phases[1].phase, '推送及索引素材');
  assert(!JSON.stringify(phases).includes('/private'));
  console.log('PASS 阶段实际耗时独立记录，行号、构建和命令数完整，不含命令参数');
  const outcomes=[];
  const failedStage=diagnostics.create({onPhase:p=>outcomes.push(p)});
  diagnostics.run(failedStage,()=>{
    diagnostics.phase('选择视频封面',1);diagnostics.fail();diagnostics.phase('条目结束');
    diagnostics.phase('准备发布',2);diagnostics.phase('条目结束');
  });
  assert.equal(outcomes.length,2);assert.equal(outcomes[0].ok,false);assert.equal(outcomes[1].ok,true);
  console.log('PASS 封面失败阶段如实记失败，下一条正常阶段恢复成功状态');
  for (const [stderr, kind] of [['Permission denied /secret', 'permission'], ['Segmentation fault', 'segfault'], ['device offline', 'offline'], ['', 'timeout']]) {
    const state = diagnostics.create({ version: '1.1.1', build: 2026101302 });
    diagnostics.run(state, () => diagnostics.record(['shell', 'ls /secret'],
      { ok: false, killed: true, signal: 'SIGTERM', stdout: '', stderr, timeoutMs: 8000 }, 8001, 'bundled'));
    const report = diagnostics.format(diagnostics.snapshot(state));
    assert(report.includes('/out=' + kind) && report.includes('/bytes=0:') && !report.includes('/secret'));
  }
  console.log('PASS 云端区分权限、崩溃、离线与无输出超时，保留输出长度而不泄露原文');
  const retained=[];
  const transient=diagnostics.create({version:'1.1.2',build:2026101403,onPhase:p=>retained.push(p)});
  diagnostics.run(transient,()=>{
    diagnostics.phase('清理相册',2);
    diagnostics.record(['shell','rm -f /private/material.mp4'],{ok:false,code:1,stderr:'Text file busy /private/material.mp4'},5,'bundled');
    for(let i=0;i<12;i++)diagnostics.record(['shell','content query --uri secret'],{ok:true,stdout:'No result found'},5,'bundled');
    diagnostics.fail();diagnostics.phase('准备发布',3);
  });
  const retainedText=diagnostics.format(retained[0]);
  assert(retainedText.includes('rm:')&&retainedText.includes('/out=busy')&&!/private|material|secret/.test(retainedText));
  console.log('PASS 清理阶段原始失败经十二次成功查询后仍可在阶段云端摘要定位，且不泄露路径');
})().catch(error => { console.error(error); process.exitCode = 1; });
