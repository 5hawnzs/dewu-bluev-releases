'use strict';
// 在进程边界复现新设备返回的原始记录，验证真实查询和发布前确认函数。
const fs = require('fs'), path = require('path'), vm = require('vm');
let failed = 0;
function ok(label, value) {
  console.log((value ? 'PASS ' : 'FAIL ') + label);
  if (!value) failed++;
}
function driver(reply, delayMs = 0) {
  const calls = [];
  const executions = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/services/adb.js'), 'utf8'), {
    module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout,
    require: name => name === 'child_process' ? { execFile: (_bin, args, _opts, callback) => {
      const command = args[args.length - 1];
      calls.push(command);
      executions.push({ command, timeout: _opts.timeout });
      const result = reply(command);
      const finish = () => callback(result.code || result.killed ? Object.assign(new Error('设备命令返回非零'), { code: result.code, killed: result.killed, signal: result.signal }) : null,
        result.stdout || (command.startsWith('content query ') && !result.code && !result.stderr ? 'No result found.\n' : ''), result.stderr || '');
      if (delayMs) setTimeout(finish, delayMs); else finish();
    } } : name === './diagnostics' ? require('../src/main/services/diagnostics') : require(name)
  });
  return { adb: module.exports, calls, executions };
}
const main = '/storage/emulated/0/DCIM/Camera/bluev/_____2026-10-05_031009_152.jpg';
const other = '/storage/emulated/0/DCIM/Camera/bluev/_____2026-10-05_031019_741.jpg';
const cloudRows = `Row: 0 _data=${main}, date_modified=1791608509\nRow: 1 _data=${other}, date_modified=1791608507\n`;
(async () => {
  for (const [name, response] of [
    ['零退出但输出为空', { ok: true, stdout: '', stderr: '', code: 0 }],
    ['零退出但返回异常文本', { ok: true, stdout: 'provider failed', stderr: '', code: 0 }],
    ['零退出但记录截断', { ok: true, stdout: 'Row: 0 _id=1, _data=', stderr: '', code: 0 }],
    ['超时后遗留完整记录', { ok: false, stdout: 'Row: 0 _id=1, _data=/sdcard/x.jpg\n', code: 139, killed: true }]
  ]) {
    const q = await driver(() => ({})).adb.queryMediaTable('FAKE', 'images', async () => response);
    ok(name + '必须拒绝当成空相册或完整查询', !!q.error);
  }
  const uri = driver(() => ({ stdout: 'No result found.\n' }));
  await uri.adb.queryMediaTable('FAKE', 'files');
  ok('Files 使用真实 file 地址并只查询图片、音频、视频，不删文档目录', uri.calls[0].includes('/external/file --projection')
    && uri.calls[0].includes("--where 'media_type=1 OR media_type=2 OR media_type=3'"));
  const bounded = driver(() => ({}));
  const timedOut = await bounded.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera', { deadline: Date.now() - 1 });
  ok('总预算耗尽后不再发出任何清理命令', !timedOut.ok && timedOut.code === 'ALBUM_IO_INTERRUPTED' && !bounded.calls.length);
  const mismatch = driver(() => ({ stdout: 'Row: 0 _data=/sdcard/DCIM/Camera/current.jpg\nRow: 1 _data=/sdcard/Movies/old.mp4\n' }));
  const wrong = await mismatch.adb.albumMatches('FAKE', ['/sdcard/DCIM/Camera/current.jpg']);
  ok('选图前发现额外旧素材立即阻止，不能仅确认本条素材存在', !wrong.ok && wrong.extra.length === 1 && !wrong.missing.length);
  let queryCount = 0;
  const resurrected = driver(cmd => ({ stdout: cmd.startsWith('content query ') && ++queryCount > 4
    ? 'Row: 0 _id=17, _data=/sdcard/Movies/resurrected.mp4\n' : 'No result found.\n' }));
  const back = await resurrected.adb.clearAlbum('FAKE');
  ok('第一次查询为空、第二次记录重新出现时不能放行', !back.ok && back.left === 1);
  const emptyDirectories = driver(cmd => ({ stdout: cmd.startsWith('ls -A ') ? 'old_empty_directory\n'
    : cmd.startsWith('content query ') ? 'No result found.\n' : '' }));
  const emptyResult = await emptyDirectories.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera', { forceStopPkg: 'com.shizhuang.duapp' });
  ok('确认只剩空目录时不执行任何删除、改名或强停命令', emptyResult.ok
    && !emptyDirectories.calls.some(c => /^(rm |mv |am force-stop )/.test(c) || /-delete/.test(c)));
  const unreadableFiles = driver(cmd => cmd.startsWith('ls -A ') ? { stdout: 'unknown\n' }
    : cmd.startsWith('find ') ? { code: 1, stderr: 'Permission denied' } : { stdout: 'No result found.\n' });
  const unreadableResult = await unreadableFiles.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera');
  ok('递归文件读取被拒绝时停止，不把空输出当成无文件', !unreadableResult.ok
    && /Permission denied/.test(unreadableResult.error) && !unreadableFiles.calls.some(c => /-delete|^rm |^mv /.test(c)));
  const interrupted = driver(cmd => cmd.startsWith('ls -A ') ? { stdout: 'orphan.jpg\n' }
    : /^find .* -type f$/.test(cmd) ? { stdout: '/sdcard/DCIM/Camera/orphan.jpg\n' }
    : /-delete/.test(cmd) ? { killed: true, signal: 'SIGTERM' }
    : { stdout: 'No result found.\n' });
  const interruptedResult = await interrupted.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera');
  ok('按文件删除超时后立即停止，不换名或强停', !interruptedResult.ok && /10000ms/.test(interruptedResult.error)
    && /SIGTERM/.test(interruptedResult.error) && !interrupted.calls.some(c => /^(mv |rm -rf |am force-stop )/.test(c)));
  ok('超时只执行一次文件删除，不叠加后续命令', interrupted.calls.filter(c => /-delete/.test(c)).length === 1);
  for (const [label, failure, allowed] of [
    ['目标目录不存在', { code: 1, stderr: 'ls: /storage/emulated/0/DCIM/Camera/: No such file or directory' }, true],
    ['设备未找到', { code: 1, stderr: "adb: device 'FAKE' not found" }, false],
    ['ls 命令不存在', { code: 127, stderr: '/system/bin/sh: ls: not found' }, false],
    ['其他路径不存在', { code: 1, stderr: 'ls: /another/path: No such file or directory' }, false],
    ['空输出超时', { killed: true, signal: 'SIGTERM' }, false]
  ]) {
    const d = driver(cmd => cmd.startsWith('ls -A ') ? failure : { stdout: cmd.startsWith('content query ') ? 'No result found.\n' : '' });
    const result = await d.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera');
    ok(label + '：仅目标目录明确不存在时允许继续并建目录', result.ok === allowed
      && d.calls.some(c => c.startsWith('mkdir -p ')) === allowed);
    if (failure.killed) ok('空输出超时八秒内停止并保留终止信号，不能被当成清理成功', /8000ms/.test(result.error) && /SIGTERM/.test(result.error));
  }
  for (const code of [0, 139]) {
    const d = driver(() => ({ code, stdout: cloudRows }));
    const result = await d.adb.mediaNewest('FAKE', [main, other]);
    ok(`云端日志原始主图记录退出 ${code} 时正确识别最新主图`, result.ok && result.newest === main && result.times[main] === 1791608509);
  }
  for (const [label, reply] of [
    ['缺少另一张素材', { code: 139, stdout: cloudRows.split('\n')[0] + '\n' }],
    ['最后一条记录被截断', { code: 139, stdout: cloudRows.replace('1791608507', '') }],
    ['带权限拒绝', { code: 139, stdout: cloudRows, stderr: 'Permission Denial' }],
    ['其他未知退出码', { code: 1, stdout: cloudRows }],
    ['主图时间并列', { code: 139, stdout: cloudRows.replace('1791608507', '1791608509') }]
  ]) {
    const result = await driver(() => reply).adb.mediaNewest('FAKE', [main, other]);
    ok(`${label}时拒绝确认主图`, !result.ok && !!result.error);
  }
  const visible = driver(cmd => cmd.includes('/video/')
    ? { code: 139, stdout: 'No result found.\n' }
    : { code: 139, stdout: `Row: 0 _data=${main}\nRow: 1 _data=${other}\n` });
  const good = await visible.adb.mediaVisible('FAKE', [main, other], { timeoutMs: 0 });
  ok('视频空表及图片表完整记录均退出139时仍确认图片入库', good.ok);
  ok('两张媒体表分别查询，不受首条命令退出139影响', visible.calls.some(c => c.includes('/video/')) && visible.calls.some(c => c.includes('/images/')));
  const prefix = await driver(() => ({ code: 0, stdout: `Row: 0 _data=${main}.bak\n` }))
    .adb.mediaVisible('FAKE', [main], { timeoutMs: 0 });
  ok('文件名仅前缀相同不能冒充目标素材已入库', !prefix.ok);
  const denied = await driver(cmd => cmd.includes('/video/')
    ? { code: 139, stdout: 'No result found.\n', stderr: 'Permission Denial' }
    : { code: 0, stdout: `Row: 0 _data=${main}\n` })
    .adb.mediaVisible('FAKE', [main], { timeoutMs: 0 });
  ok('其中一张表权限失败不能被另一张表成功掩盖', !denied.ok && /Permission Denial/.test(denied.error));
  let deleted = false;
  const recheck = driver(cmd => {
    if (cmd.startsWith('content delete ')) { deleted = true; return {}; }
    if (cmd.startsWith('content query ')) return deleted
      ? { code: 1, stderr: 'Permission Denial' }
      : { stdout: `Row: 0 _id=17, _data=${main}\n` };
    return {};
  });
  const notVerified = await recheck.adb.clearAlbum('FAKE');
  ok('清相册后复查失败不能伪装成已清空', !notVerified.ok && /Permission Denial/.test(notVerified.error));
  deleted = false;
  const unsafeName = driver(cmd => {
    if (cmd.startsWith('content delete ')) { deleted = true; return {}; }
    if (cmd.startsWith('content query ')) return { stdout: deleted ? '' : 'Row: 0 _id=18, _data=/sdcard/DCIM/evil;touch.jpg\n' };
    return {};
  });
  const cleaned = await unsafeName.adb.clearAlbum('FAKE');
  ok('带 shell 控制符的文件名只按媒体 ID 清理，不拼成设备指令',cleaned.ok
    && unsafeName.calls.some(c=>c.startsWith('content delete ')) && !unsafeName.calls.some(c=>c.startsWith('rm -f ')));
  const camera = '/storage/emulated/0/DCIM/Camera/test.jpg';
  let attempts = 0, gone = false;
  const retry = driver(cmd => {
    if (cmd.startsWith('content query ')) return { stdout: gone ? 'No result found.\n' : `Row: 0 _id=1000000140, _data=${camera}\n` };
    if (cmd.startsWith('content delete ')) {
      attempts++;
      if (attempts === 1) return { code: 139 };
      gone = true; return { stdout: 'Deleted 1 rows\n' };
    }
    return {};
  });
  const retried = await retry.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera');
  ok('首次删除退出139时重试成功，第三条无需直接中止', retried.ok && attempts === 2);
  ok('跨图片与文件表的同一媒体记录仅执行一组删除', retried.removed === 1 && attempts === 2);
  for (const mode of ['已删但进程异常', '记录仍残留', '复查权限失败']) {
    let deletion = false, count = 0;
    const d = driver(cmd => {
      if (cmd.startsWith('content delete ')) { deletion = true; count++; return { code: 139 }; }
      if (cmd.startsWith('content query ')) {
        if (deletion && mode === '复查权限失败') return { code: 1, stderr: 'Permission Denial' };
        return { stdout: deletion && mode === '已删但进程异常' ? 'No result found.\n' : `Row: 0 _id=1000000140, _data=${camera}\n` };
      }
      return {};
    });
    const result = await d.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera');
    ok(`${mode}：最多三次删除，依据真实媒体复查结果放行或拦截`, count === 3
      && (mode === '已删但进程异常' ? result.ok && /复查/.test(result.note) : !result.ok && !!result.error));
  }
  let albumGone = false, albumDeletes = 0;
  const albumDedup = driver(cmd => {
    if (cmd.startsWith('content delete ')) { albumGone = true; albumDeletes++; return {}; }
    if (cmd.startsWith('content query ')) return { stdout: albumGone ? 'No result found.\n' : `Row: 0 _id=9, _data=${camera}\n` };
    return {};
  });
  const albumResult = await albumDedup.adb.clearAlbum('FAKE');
  ok('全盘相册清理也合并四张表的重复媒体记录', albumResult.ok && albumDeletes === 1);
  let deletes = 0;
  const rows = Array.from({ length: 12 }, (_, i) => `Row: ${i} _id=${i + 1}, _data=/storage/emulated/0/DCIM/Camera/${i}.jpg`).join('\n');
  const timing = driver(cmd => {
    if (cmd.startsWith('content query ')) return { stdout: deletes < 12 && /\/images\/media|\/external\/file /.test(cmd) ? rows : 'No result found.\n' };
    if (cmd.startsWith('content delete ')) deletes++;
    return {};
  }, 20);
  const started = Date.now();
  const timed = await timing.adb.clearMediaDir('FAKE', '/sdcard/DCIM/Camera');
  ok('12张素材跨两表只删除12次，正常路径必须完成媒体库复查', timed.ok && deletes === 12
    && timing.calls.filter(c => c.startsWith('content query ')).length === 8);
  console.log('清理指令对比：12张素材跨两表，旧逻辑24次删除，新逻辑' + deletes + '次；模拟每条设备命令20ms，新清理耗时' + (Date.now() - started) + 'ms（不是实机发布时间）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
