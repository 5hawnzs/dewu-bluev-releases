'use strict';
/**
 * 启动开关：GPU 相关的开关必须在 app ready **之前**定下来，晚了 Electron 不认。
 *
 * 为什么非要这套开关（本机实测，不是猜的）：
 *   远程桌面 / 向日葵这类环境里 GPU 进程会反复退出，Chromium 随后走 `LOG(FATAL)`：
 *   `FATAL:gpu_data_manager_impl_private.cc(449) GPU process isn't usable. Goodbye.`
 *   —— 在 Windows 上 FATAL 就是 `__debugbreak()`（int3），于是弹
 *   「unknown software exception (0x80000003)」并**整个程序退出**：发布跑到一半被它带走。
 *   本仓库更早的 worklog 已记过同一个坑（2026-09-30：「加 --in-process-gpu --disable-gpu 即活」）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const flags = require('../src/main/startupflags');

/** 假 app：按调用顺序记账，避免只验「调过」不验「先关加速再挂开关」 */
function fakeApp(ready = false) {
  const calls = [];
  return {
    calls,
    isReady: () => ready,
    disableHardwareAcceleration() { calls.push('disableHardwareAcceleration'); },
    commandLine: { appendSwitch: name => calls.push('appendSwitch:' + name) }
  };
}

{
  const app = fakeApp();
  const applied = flags.apply({ app, argv: [], env: {} });
  assert.equal(applied.disabled, true);
  assert.deepEqual(app.calls, ['disableHardwareAcceleration', 'appendSwitch:disable-gpu', 'appendSwitch:in-process-gpu']);
  console.log('PASS 默认关掉硬件加速与独立 GPU 进程（GPU 进程崩了不会再带走整个程序）');
}

{
  const app = fakeApp();
  const applied = flags.apply({ app, argv: ['--enable-gpu'], env: {} });
  assert.equal(applied.disabled, false);
  assert.equal(applied.reason, 'explicit');
  assert.deepEqual(app.calls, []);
  console.log('PASS 显式 --enable-gpu 时不改开关（留一个还原硬件加速的口子）');
}

{
  const off = fakeApp();
  assert.equal(flags.apply({ app: off, argv: [], env: { BLUEV_ENABLE_GPU: '1' } }).disabled, false);
  assert.deepEqual(off.calls, []);
  const on = fakeApp();
  assert.equal(flags.apply({ app: on, argv: [], env: { BLUEV_ENABLE_GPU: '0' } }).disabled, true);
  assert.equal(flags.apply({ app: fakeApp(), argv: [], env: { BLUEV_ENABLE_GPU: '' } }).disabled, true);
  console.log('PASS 环境变量只有 1/true 才算放行，空串与 0 照旧关掉');
}

{
  const app = fakeApp(true);
  const notes = [];
  const applied = flags.apply({ app, argv: [], env: {}, log: message => notes.push(message) });
  assert.equal(applied.disabled, false);
  assert.equal(applied.reason, 'late');
  assert.deepEqual(app.calls, []);
  assert.equal(notes.length, 1);
  assert.ok(/ready/.test(notes[0]) && /不生效/.test(notes[0]), '晚挂必须如实说明，不能假装已生效：' + notes[0]);
  console.log('PASS ready 之后才调用时如实说明开关来不及生效');
}

{
  // 没有 app（比如被别的脚本 require）时不许把调用方炸掉：返回说明即可
  const applied = flags.apply({ argv: [], env: {} });
  assert.equal(applied.disabled, false);
  assert.equal(applied.reason, 'no-app');
  console.log('PASS 拿不到 electron app 时如实返回，不抛异常');
}

{
  // 结构断言：开关与崩溃留档都必须在 whenReady 之前挂上（放后面等于没挂）
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  const at = needle => src.indexOf(needle);
  const ready = at('app.whenReady(');
  assert.ok(ready > 0, 'index.js 里找不到 app.whenReady(');
  assert.ok(at('startupflags.apply(') > 0, 'index.js 没有挂启动开关');
  assert.ok(at('startupflags.apply(') < ready, '启动开关必须早于 app.whenReady（晚了不生效）');
  assert.ok(at('crashguard.install(') > 0, 'index.js 没有挂崩溃留档');
  assert.ok(at('crashguard.install(') < ready, '崩溃留档必须早于 app.whenReady（早崩的要留得下）');
  assert.ok(at('startupflags.apply(') < at('requestSingleInstanceLock'), '启动开关要放在单实例判断之前');
  console.log('PASS 启动开关与崩溃留档都在 app ready 之前挂上');
}
