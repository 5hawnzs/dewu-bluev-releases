'use strict';
/**
 * 崩溃留档：把用户只看到「unknown software exception」的那种崩溃，变成运行日志里的一行。
 *
 * 触发场景都是真的：GPU/渲染进程被杀、主进程里没接住的异常、没接住的 Promise 拒绝。
 * 判据：① 原因必须照实说（不许把 crashed 说成正常）；② 记日志本身出问题不许把程序带崩；
 *      ③ 主进程异常只记录、不退出（发布跑一半时最怕的就是「弹个框然后整个没了」）。
 */
const assert = require('assert');
const crashguard = require('../src/main/crashguard');

function fakes({ ready = false } = {}) {
  const logs = [], paths = {}, started = [], events = {};
  const app = {
    isReady: () => ready,
    setPath: (name, value) => { paths[name] = value; },
    on: (name, handler) => { (events[name] = events[name] || []).push(handler); }
  };
  return {
    app, paths, logs, started, events,
    deps: {
      app,
      crashReporter: { start: options => { started.push(options); } },
      logbus: {
        info: m => logs.push(['info', m]),
        warn: m => logs.push(['warn', m]),
        error: m => logs.push(['error', m])
      },
      userData: 'C:/tmp/userdata',
      build: 2026101613,
      fs: { mkdirSync: () => {} },
      path: require('path')
    }
  };
}

{
  const { deps, paths, started } = fakes();
  const state = crashguard.install(deps);
  assert.equal(paths.crashDumps, require('path').join('C:/tmp/userdata', 'crashdumps'));
  assert.equal(state.dumps, paths.crashDumps);
  assert.equal(started.length, 1);
  assert.equal(started[0].uploadToServer, false, '本机留档即可，不许往网上传');
  assert.equal(String(started[0].extra.build), '2026101613');
  console.log('PASS 留档目录与构建号登记到位，且不上传服务器');
}

{
  const f = fakes();
  crashguard.install(f.deps);
  const [onGone] = f.events['child-process-gone'];
  const [onRenderGone] = f.events['render-process-gone'];
  assert.ok(onGone && onRenderGone, '必须同时监听子进程与渲染进程结束');
  onGone({}, { type: 'GPU', reason: 'crashed', exitCode: 2147483651 });
  onRenderGone({}, {}, { reason: 'oom', exitCode: 5 });
  const text = f.logs.map(l => l[1]).join('\n');
  assert.ok(/GPU/.test(text) && /异常退出/.test(text), 'GPU 进程崩溃要写清进程与原因：' + text);
  assert.ok(/2147483651/.test(text), '退出码要照抄，便于对账');
  assert.ok(/内存不足/.test(text), 'oom 必须译成用户能看懂的原因：' + text);
  console.log('PASS 进程被杀 / 内存不足都能如实落到日志（含退出码）');
}

{
  const f = fakes();
  crashguard.install(f.deps);
  f.events['child-process-gone'][0]({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
  const last = f.logs[f.logs.length - 1];
  assert.equal(last[0], 'info', '正常退出不该报成告警（否则天天狼来了）');
  assert.ok(/正常退出/.test(last[1]));
  console.log('PASS 正常退出只说一句，不当崩溃告警');
}

{
  const f = fakes();
  crashguard.install(f.deps);
  f.events['child-process-gone'][0]({}, { type: 'GPU', reason: '啥都不是', exitCode: 7 });
  const text = f.logs.map(l => l[1]).join('\n');
  assert.ok(/啥都不是/.test(text), '认不出的原因要原样带出来，不许吞掉：' + text);
  console.log('PASS 认不出的原因原样带出，不冒充已知原因');
}

{
  const f = fakes();
  const before = process.listenerCount('uncaughtException');
  const beforeRejection = process.listenerCount('unhandledRejection');
  crashguard.install(f.deps);
  assert.ok(process.listenerCount('uncaughtException') > before, '必须接住未捕获异常');
  assert.ok(process.listenerCount('unhandledRejection') > beforeRejection, '必须接住未处理的 Promise 拒绝');
  process.emit('uncaughtException', new Error('炸了'));
  const text = f.logs.map(l => l[1]).join('\n');
  assert.ok(/炸了/.test(text), '异常信息要落到日志：' + text);
  assert.ok(/不退出|继续/.test(text), '要说清「已记录、程序不退出」，否则用户以为它没事');
  console.log('PASS 主进程未捕获异常只记录不退出（发布不被带走）');
}

{
  const f = fakes();
  crashguard.install(f.deps);
  process.emit('unhandledRejection', new Error('异步炸了'));
  const text = f.logs.map(l => l[1]).join('\n');
  assert.ok(/异步炸了/.test(text), '未处理的 Promise 拒绝要落到日志：' + text);
  console.log('PASS 未处理的 Promise 拒绝不会静默带走进程');
}

{
  // 记日志自己炸了（比如日志目录不可写）不许反过来把程序带崩
  const f = fakes();
  f.deps.logbus.warn = () => { throw new Error('日志通道坏了'); };
  f.deps.logbus.error = () => { throw new Error('日志通道坏了'); };
  f.deps.crashReporter.start = () => { throw new Error('crashpad 起不来'); };
  assert.doesNotThrow(() => crashguard.install(f.deps));
  assert.doesNotThrow(() => f.events['child-process-gone'][0]({}, { type: 'GPU', reason: 'crashed' }));
  assert.doesNotThrow(() => process.emit('unhandledRejection', new Error('照旧')));
  console.log('PASS 留档通道自身故障时不影响程序运行');
}
