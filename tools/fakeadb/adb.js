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
 *
 * 现场开关（在 dir 里放文件即可，测完删掉）：
 *   MEDIA_LAG      —— content query 假装还没索引到（测「等媒体库索引」）
 *   DUMP_NOT_IDLE  —— uiautomator dump 报 ERROR: could not get idle state.
 *                     文件内容含 'always' → 关动画也救不了（只能失败）；
 *                     否则 → 只在系统动画开着（animator_duration_scale != 0）时失败，
 *                     关掉动画就能成功 —— 对齐真机实测到的行为。
 */
const fs = require('fs');
const path = require('path');

/** @param {string} dir 现场目录（至少要含 window.xml 与 shot.png 两个夹具） */
function makeFakeAdb(dir) {
  const CALLS = path.join(dir, 'calls.log');
  const WINDOW_XML = path.join(dir, 'window.xml');
  const SHOT_PNG = path.join(dir, 'shot.png');
  const NOT_IDLE_FLAG = path.join(dir, 'DUMP_NOT_IDLE');

  const read = (p, fallback) => { try { return fs.readFileSync(p); } catch (e) { return fallback; } };

  // 「设备上已经推送过去的文件」：真实 push 到哪个远端路径就记哪个，
  // 供 content query（媒体库）回包用 —— 这样「等媒体库索引」那段逻辑才是真的被测到。
  const pushed = [];

  // 设备上的「文件」：只需模拟 dump 用到的那个路径。
  // 关键语义（真机实测）：uiautomator dump **成功才写文件**；失败时目标文件一字不动。
  // 所以失败时若不清掉旧文件，cat 出来的就是**上一个页面**的结构。
  const devFiles = new Map();

  // 系统动画开关的初值（真机默认都是 1）
  const anim = { window_animation_scale: '1', transition_animation_scale: '1', animator_duration_scale: '1' };

  const okOut = out => ({ out: out == null ? '' : out, code: 0 });
  const fail = msg => ({ out: msg + '\n', code: 1 });

  /** 处理**一条** shell 子命令（adb shell 里用 ';' 串起来的多条会逐个进来） */
  function shellSub(sub) {
    const cmd = sub.trim();
    if (!cmd) return okOut('');
    if (cmd === 'wm size') return okOut('Physical size: 1080x2400\n');
    if (cmd === 'input') return okOut('usage: input [<source>] <command>\n');
    if (/^input (tap|keyevent|text) /.test(cmd)) return okOut('');
    if (/^am broadcast /.test(cmd)) return okOut('Broadcast completed: result=0\n');
    if (/^rm -f /.test(cmd)) {
      cmd.split(/\s+/).slice(2).forEach(p => devFiles.delete(p));
      return okOut('');
    }
    if (/^uiautomator dump /.test(cmd)) {
      const target = cmd.split(/\s+/).pop();
      const mode = fs.existsSync(NOT_IDLE_FLAG)
        ? (read(NOT_IDLE_FLAG, Buffer.from('')).toString('utf8').includes('always') ? 'always' : 'anim')
        : '';
      const blocked = mode === 'always' || (mode === 'anim' && anim.animator_duration_scale !== '0');
      if (blocked) return okOut('ERROR: could not get idle state.\n');   // 真机：报错但**不写文件**
      devFiles.set(target, read(WINDOW_XML, Buffer.from('<hierarchy/>')).toString('utf8'));
      return okOut(`UI hierchary dumped to: ${target}\n`);
    }
    if (/^cat /.test(cmd)) {
      const target = cmd.split(/\s+/).pop();
      if (!devFiles.has(target)) return fail(`cat: ${target}: No such file or directory`);
      return okOut(devFiles.get(target));
    }
    if (/^settings (get|put|delete) global /.test(cmd)) {
      const m = cmd.match(/^settings (get|put|delete) global (\S+)(?:\s+(\S+))?$/);
      if (!m) return fail('settings: bad args');
      const [, verb, key, val] = m;
      if (verb === 'get') return okOut((key in anim ? anim[key] : 'null') + '\n');
      if (verb === 'put') { anim[key] = val; return okOut(''); }
      delete anim[key];
      return okOut('');
    }
    if (/^content query /.test(cmd)) {
      // 媒体库索引：默认索引得到「已推送」的文件；
      // 想模拟「广播发了但还没索引到」，就在现场目录建一个 MEDIA_LAG 文件
      const lag = fs.existsSync(path.join(dir, 'MEDIA_LAG'));
      const list = lag ? [] : pushed;
      return okOut(list.map((p, i) => `Row: ${i} _data=${String(p).replace(/^\/sdcard\//, '/storage/emulated/0/')}`).join('\n') + (list.length ? '\n' : ''));
    }
    if (cmd === 'pm list packages') return okOut('package:com.shizhuang.duapp\npackage:com.android.adbkeyboard\npackage:com.android.shell\n');
    return okOut('');
  }

  /** 返回这条命令的结果 { out, code } */
  function respond(argv) {
    const args = argv.slice();
    if (args[0] === 'version') return okOut('Android Debug Bridge version 1.0.41\n');
    if (args[0] === 'devices') return okOut('List of devices attached\n127.0.0.1:5555\tdevice\n');
    if (args[0] === '-s') args.splice(0, 2);

    if (args[0] === 'exec-out') return okOut(read(SHOT_PNG, Buffer.alloc(0)));   // screencap -p，二进制
    if (args[0] === 'push') {
      const remote = args[args.length - 1];
      if (remote && !pushed.includes(remote)) pushed.push(remote);
      return okOut('1 file pushed. 0.4 MB/s\n');
    }

    if (args[0] === 'shell') {
      // adb shell 会把整串交给设备上的 sh，所以 ';' 串起来的多条要逐条执行、按序拼接输出
      const parts = args.slice(1).join(' ').split(';');
      if (parts.length === 1) return shellSub(parts[0]);
      let out = '';
      for (const p of parts) {
        const r = shellSub(p);
        out += r.out;
        if (r.code) return { out, code: r.code };
      }
      return okOut(out);
    }
    return okOut('');
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
    const res = respond(argv);
    const code = res.code || 0;
    const isBuffer = opts.encoding === 'buffer';
    const stdout = Buffer.isBuffer(res.out) ? res.out : (isBuffer ? Buffer.from(res.out) : String(res.out));
    process.nextTick(() => {
      if (!callback) return;
      if (code) {
        // 真 adb 失败时是「非 0 退出码 + 消息在 stdout」，这里保持一致
        const err = new Error(`Command failed with exit code ${code}`);
        err.code = code;
        return callback(err, stdout, '');
      }
      callback(null, stdout, '');
    });
  };
}

module.exports = { makeFakeAdb };
