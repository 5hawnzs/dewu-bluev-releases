'use strict';

// 自检的日志接收端可能随终端/父进程结束而断开。此时按失败退出，不能弹窗或假报通过。
module.exports = function installTestRuntime({ app, timeoutMs = 180000 } = {}) {
  function exitFailed() {
    if (app) app.exit(1);
    else process.exit(1);
  }
  function onOutputError(error) {
    if (error && error.code === 'EPIPE') {
      // 不再向已经断开的 stdout/stderr 写错误日志，避免递归报错。
      exitFailed();
      return;
    }
    throw error;
  }
  for (const stream of [process.stdout, process.stderr]) {
    if (stream) stream.on('error', onOutputError);
  }
  // Electron 的 console 写管道也可能同步抛错，仅拦截输出断管，其他异常仍交给测试报告。
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const write = console[method].bind(console);
    console[method] = (...args) => {
      try { return write(...args); }
      catch (error) { return onOutputError(error); }
    };
  }
  if (app) {
    // 即使隐藏窗口或异步等待卡住，自检也不能无限残留。
    const timer = setTimeout(() => {
      try { process.stderr.write('ERROR 自检超过时限，按失败退出\n'); }
      finally { exitFailed(); }
    }, timeoutMs);
    timer.unref();
  }
};
