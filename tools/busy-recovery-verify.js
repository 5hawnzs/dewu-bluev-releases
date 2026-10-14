#!/usr/bin/env node
'use strict';
/**
 * rich「四连失败」端到端复现与验收（本机模拟器，人工显式调用）。
 *
 * 现场：上一条已发布视频还挂在得物里、进程握着文件句柄 ⇒ `rm -f` 报 `Text file busy`。
 * 旧逻辑：只退避 [500,1500,3000] 三次约 5 秒就判「未清净」⇒ 连续四条失败。
 * 新逻辑：总预算内持续有界退避，句柄一释放就收敛；清不掉仍如实失败、绝不假成功。
 *
 * 用法：
 *   node tools/busy-recovery-verify.js 127.0.0.1:16384 [holdSeconds]
 *
 * ★ 只用**自带探针文件**（bluev_probe_busy_*.tmp），不碰用户素材；用完即删。
 * ★ 这里复用产品真实的 clearAlbum，不另写一套清理逻辑（否则验的不是产品）。
 */
const fs = require('fs');
const path = require('path');
const adb = require('../src/main/services/adb');

const serial = process.argv[2];
const holdSec = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 9;
if (!serial) { console.error('用法：node tools/busy-recovery-verify.js <serial> [holdSeconds]'); process.exit(2); }

adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
// ★ 必须用**真媒体类型**（.mp4）：拿 .tmp 探针时 MediaStore 根本不把它当媒体，
//   clearAlbum 的四表查询看不见它，清理逻辑压根不碰 —— 那样验的是假现场。
const FILE = '/sdcard/DCIM/Camera/bluev_probe_busy.mp4';
const LOCAL = path.join(__dirname, '..', 'cover-test.mp4');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

(async () => {
  const pushed = await adb.push(serial, LOCAL, FILE);
  record('探针文件已推到相册目录', pushed.ok, pushed.stderr || '');
  const scanned = await adb.mediaScan(serial, FILE);
  record('探针文件已进媒体库（相册可见）', scanned.ok, scanned.raw || '');

  // 起一个 9 秒的持句柄进程：真机上是得物在解码上一条视频。
  const held = await adb.shell(serial,
    "nohup sh -c 'exec 9<" + FILE + "; sleep " + holdSec + "' >/dev/null 2>&1 & echo HELD=$!");
  record('已复现「进程持有文件句柄」现场（' + holdSec + 's）', held.ok, String(held.stdout || '').trim());
  await sleep(600);

  const started = Date.now();
  const cleared = await adb.clearAlbum(serial, { deadline: Date.now() + 90000 });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  record('被占用期间 clearAlbum 仍在预算内收敛（旧版约5秒就放弃）', cleared.ok === true,
    'ok=' + cleared.ok + ' 耗时=' + elapsed + 's 恢复=' + cleared.recoveryAttempts + '次 ' + (cleared.error || ''));
  record('收敛发生在句柄释放之后、且确实重试过 busy（不是一次就成）',
    cleared.recoveryAttempts >= 1, '恢复=' + cleared.recoveryAttempts + '次');

  const left = await adb.shell(serial, '[ -e ' + quote(FILE) + ' ] && echo EXISTS || echo GONE');
  record('物理文件确实被清掉（不是只删了库记录）', String(left.stdout).trim() === 'GONE', String(left.stdout).trim());
  const lib = await adb.queryMediaTable(serial, 'video');
  const rows = String(lib.result && lib.result.stdout || '').trim();
  record('媒体库里没有该残留记录（四表复查判据）',
    !rows.includes('bluev_probe_busy.mp4'), rows.split('\n').length + ' 行');
  const orphan = await adb.shell(serial, 'ls /sdcard/DCIM/Camera/bluev_probe_busy.mp4 2>/dev/null || true');
  record('探针文件已清理（不留测试垃圾）', String(orphan.stdout).trim() === '', String(orphan.stdout).trim());

  const failed = results.filter(r => !r.pass);
  console.log('\n合计 ' + (results.length - failed.length) + '/' + results.length + ' 项通过'
    + (failed.length ? '，失败项：' + failed.map(f => f.name).join('；') : ''));
  fs.writeFileSync(path.join(__dirname, '..', 'busy-recovery-verify.json'), JSON.stringify({ serial, holdSec, elapsed, cleared, results }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
