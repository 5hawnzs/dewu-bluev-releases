'use strict';
/**
 * 假 adb（跨平台）：在 child_process.execFile 这一层做替身，模拟一台在线设备，
 * 并把每次调用按「整条 argv 用空格连接」记进 <dir>/calls.log，用来验证驱动的指令序列。
 *
 * 为什么不沿用「往 PATH 里塞一个假 adb 可执行文件」的老做法（原 tools/fakeadb/adb 是 bash 脚本）：
 *   ① Windows 的 PATH 分隔符是 ';'（path.delimiter），写死 ':' 拼出来的目录根本进不了 PATH；
 *   ② Windows 的 execFile('adb') 只认 adb.exe —— CreateProcess 对无扩展名的名字只会补 .exe，
 *      认不出无扩展名的 bash 脚本（实测 .cmd/.bat 同样 ENOENT）。
 *      而造一个真的 adb.exe 需要编译器 + 把二进制提进仓库，代价与可维护性都不划算。
 * 所以改成在 Node 这一层替换函数：两端行为完全一致，也不再依赖 shell、可执行位或 PATH。
 * 注意：adb.js 在**加载时**就解构了 execFile，因此必须在 require 被测模块之前完成替换。
 */
const fs = require('fs');
const path = require('path');

/** @param {string} dir 现场目录（至少要含 window.xml 与 shot.png 两个夹具） */
function makeFakeAdb(dir) {
  const CALLS = path.join(dir, 'calls.log');
  const WINDOW_XML = path.join(dir, 'window.xml');
  const SHOT_PNG = path.join(dir, 'shot.png');

  const read = (p, fallback) => { try { return fs.readFileSync(p); } catch (e) { return fallback; } };

  /** 返回这条命令的 stdout（对齐原 bash 假 adb 的输出） */
  function respond(argv) {
    const args = argv.slice();
    if (args[0] === 'version') return 'Android Debug Bridge version 1.0.41\n';
    if (args[0] === 'devices') return 'List of devices attached\n127.0.0.1:5555\tdevice\n';
    if (args[0] === '-s') args.splice(0, 2);

    if (args[0] === 'exec-out') return read(SHOT_PNG, Buffer.alloc(0));   // screencap -p，二进制
    if (args[0] === 'push') return '1 file pushed. 0.4 MB/s\n';

    if (args[0] === 'shell') {
      const cmd = args.slice(1).join(' ');
      if (cmd === 'wm size') return 'Physical size: 1080x2400\n';
      if (cmd === 'input') return 'usage: input [<source>] <command>\n';
      if (/^input (tap|keyevent|text) /.test(cmd)) return '';
      if (/^am broadcast /.test(cmd)) return 'Broadcast completed: result=0\n';
      if (/^uiautomator dump /.test(cmd)) return 'UI hierchary dumped to: /sdcard/bluev_window.xml\n';
      if (cmd === 'cat /sdcard/bluev_window.xml') return read(WINDOW_XML, Buffer.from('<hierarchy/>')).toString('utf8');
      if (cmd === 'pm list packages') return 'package:com.shizhuang.duapp\npackage:com.android.adbkeyboard\npackage:com.android.shell\n';
      return '';
    }
    return '';
  }

  /** 可直接覆盖到 require('child_process').execFile 上 */
  return function execFile(file, args, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const argv = Array.isArray(args) ? args : [];
    const opts = options || {};
    // 现场留痕（先写日志再回包，顺序与原 bash 假 adb 一致）
    try { fs.appendFileSync(CALLS, argv.join(' ') + '\n'); } catch (e) { /* 日志写不进去不该影响被测逻辑 */ }
    if (file !== 'adb') {
      // 真被调到了别的可执行文件：明确报错，不要假装成功
      const err = new Error(`假 adb 只替身 'adb'，却被要求执行 '${file}'`);
      err.code = 'ENOENT';
      return process.nextTick(() => callback && callback(err, '', ''));
    }
    const out = respond(argv);
    const isBuffer = opts.encoding === 'buffer';
    const stdout = Buffer.isBuffer(out) ? out : (isBuffer ? Buffer.from(out) : String(out));
    process.nextTick(() => callback && callback(null, stdout, ''));
  };
}

module.exports = { makeFakeAdb };
