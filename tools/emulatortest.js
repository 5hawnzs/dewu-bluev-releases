'use strict';
const assert = require('node:assert/strict');
const { parseInfo, connectDiscovered } = require('../src/main/services/emulators');
let passed = 0;
function check(label, fn) { fn(); passed++; console.log('PASS ' + label); }
const info = parseInfo(JSON.stringify({
  0: { name: '未启动', is_process_started: false, adb_port: 16384 },
  1: { name: 'MuMu自定义名称', index: 1, is_process_started: true, adb_host_ip: '127.0.0.1', adb_port: 21347 },
  2: { name: '启动中', index: 2, is_process_started: true },
  3: { name: '异常地址', index: 3, is_process_started: true, adb_host_ip: '192.168.1.8', adb_port: 5555 }
}));
check('只发现运行实例，忽略已关闭实例', () => assert.equal(info.length, 3));
check('读取实际端口和实例名，不按固定步长推算', () => assert.deepEqual([info[0].serial, info[0].name], ['127.0.0.1:21347', 'MuMu自定义名称']));
check('端口未就绪保留启动中状态', () => assert.equal(info[1].serial, ''));
check('拒绝连接外部地址', () => assert.equal(info[2].serial, ''));
check('非法数据明确失败', () => assert.throws(() => parseInfo('broken')));

(async () => {
  let online = false, attempts = 0;
  const calls = [];
  const adb = {
    devices: async () => online ? [{ serial: info[0].serial, state: 'device' }] : [],
    execAdb: async args => { calls.push(args); if (args[0] === 'connect' && ++attempts === 2) online = true; return { ok: true, stdout: 'connected' }; }
  };
  const r = await connectDiscovered(adb, { instances: info, errors: [] }, async () => {});
  check('首次失败后自动重试并验证真实在线状态', () => assert.equal(r.instances[0].state, 'device'));
  check('自动连接读取到的实际端口', () => assert.deepEqual(calls[0], ['connect', '127.0.0.1:21347']));
  check('重试有上限，端口未就绪不发送连接', () => assert.equal(calls.length, 2));
  calls.length = 0;
  await connectDiscovered(adb, { instances: [info[0]], errors: [] }, async () => {});
  check('已在线设备不重复连接', () => assert.equal(calls.length, 0));
  online = false;
  adb.execAdb = async args => { calls.push(args); return { ok: true, stdout: 'connected to fake' }; };
  const bad = await connectDiscovered(adb, { instances: [info[0]], errors: [] }, async () => {});
  check('connect 文本成功但 devices 未在线，仍报连接失败', () => assert.equal(bad.instances[0].state, 'connect-failed'));
  check('连接失败最多尝试两次', () => assert.equal(calls.length, 2));
  calls.length = 0;
  adb.devices = async () => [{ serial: info[0].serial, state: 'offline' }];
  const off = await connectDiscovered(adb, { instances: [info[0]], errors: [] }, async () => {});
  check('离线设备使用单设备 reconnect', () => assert.deepEqual(calls[0], ['-s', info[0].serial, 'reconnect']));
  check('恢复失败如实显示离线', () => assert.equal(off.instances[0].state, 'offline'));
  check('恢复不重启全局 ADB、不关闭其他设备', () => assert.ok(calls.every(args => !args.includes('kill-server') && !args.includes('disconnect'))));
  adb.devices = async () => { throw new Error('服务不可用'); };
  await assert.rejects(connectDiscovered(adb, { instances: [], errors: [] }), /服务不可用/);
  console.log('PASS 服务失败不伪装成空设备列表'); passed++;
  console.log(`完成 ${passed} 项断言`);
})().catch(e => { console.error('FAIL', e); process.exitCode = 1; });
