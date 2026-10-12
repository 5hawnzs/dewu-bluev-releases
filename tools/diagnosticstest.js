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
})().catch(error => { console.error(error); process.exitCode = 1; });
