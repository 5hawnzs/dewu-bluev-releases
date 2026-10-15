#!/usr/bin/env node
'use strict';
/**
 * 真机复核：**进程重启**之后还能不能把上一次运行隔离的目录收回来。
 *
 * 为什么必须真机跑这一条：两份登记表（隔离目录、待回收文件）落在 `userData` 下，
 *   而「设备上到底还剩什么」只有真机能回答（`.nomedia` 在不在、旧素材还在不在磁盘上）。
 *   夹具能证明逻辑，真机能证明现场 —— 这台设备（MuMu 12 / Android 12）的 `scan_volume`
 *   与 MediaProvider 行为是历史故障点，必须实跑。
 *
 * 用法：node tools/album-restart-verify.js [serial]   （默认 127.0.0.1:16384）
 * ★ 只动本探针自己推上去的那一个素材（路径里带 restart-reclaim-probe），跑完会删干净；
 *   不碰用户相册里的其它任何文件。
 */
const fs = require('fs'), path = require('path');
const adb = require('../src/main/services/adb');
adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
const serial = process.argv[2] || '127.0.0.1:16384';
const DIR = '/sdcard/DCIM/Camera/bluev';
const FILE = DIR + '/restart-reclaim-probe.mp4';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const rowsInAlbum = async () => {
  const out = await adb.shell(serial, 'content query --uri content://media/external/video/media'
    + ' --projection _id:_data', { timeout: 15000 });
  return String(out.stdout || '').split(/\r?\n/).filter(l => /Row:/.test(l)).length;
};
const exists = async (client, p) => String((await client.shell(serial,
  '[ -f ' + quote(p) + ' ] && echo EXISTS', { timeout: 8000 })).stdout || '').trim() === 'EXISTS';
const steps = [];
const step = (name, data) => { steps.push({ step: name, ...data }); console.log(name, JSON.stringify(data)); };
(async () => {
  if (!await adb.online(serial)) throw new Error('设备不在线：' + serial);
  // ★ 把登记表的落点指到临时文件：本探针没有 Electron 的 userData，产品在真机上写的是
  //   userData 下同一份文件。这样**落盘这一步走的正是产品自己的代码**，不是手工造一份。
  const stateDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bluev-restart-'));
  const stateFile = path.join(stateDir, 'album-isolation.json');
  adb.setAlbumStateFile(stateFile);
  await adb.shell(serial, 'mkdir -p ' + quote(DIR), { timeout: 8000 });
  await adb.shell(serial, 'cp /system/etc/hosts ' + quote(FILE) + ' 2>/dev/null ||'
    + ' printf probe > ' + quote(FILE), { timeout: 8000 });
  await adb.mediaScan(serial, FILE);
  step('起点：探针素材已入库', { rows: await rowsInAlbum(), file: FILE });

  // ① 造「句柄占用」现场：设备上开一个进程持着该文件并睡住（与 rich 上得物持解码句柄同形态）。
  await adb.shell(serial, 'nohup sh -c "exec 3< ' + quote(FILE) + '; sleep 300" >/dev/null 2>&1 & echo started',
    { timeout: 8000 });
  const busy = await adb.shell(serial, 'rm -f ' + quote(FILE), { timeout: 8000 });
  step('占用下 rm（应当 busy）', { text: (busy.stderr || busy.stdout || '').trim(), isBusy: !busy.ok });

  // ② 第一次 clearAlbum：隔离 + 删记录，物理文件留待回收。**它把登记表落盘了。**
  const first = await adb.clearAlbum(serial, { deadline: Date.now() + 90000 });
  step('clearAlbum（占用中）', { ok: first.ok, left: first.left, physicalPending: first.physicalPending.length,
    isolatedDirs: first.isolatedDirs, error: first.error });
  if (!first.ok || first.physicalPending.length !== 1) throw new Error('占用中没能隔离+删记录：' + first.error);

  // ③ 落盘那份登记表必须**由产品自己**写出来（这是本次修复的核心，不能手工造）。
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  step('产品自己落盘的登记表', { stateFile, persisted });
  if (!persisted[serial] || !(persisted[serial].files || []).length) {
    throw new Error('产品没有把登记表落盘 —— 重启后就没人回收了（这正是要堵的洞）');
  }

  // 释放句柄
  await adb.shell(serial, 'pkill -f "sleep 300" || true', { timeout: 8000 });
  await new Promise(r => setTimeout(r, 900));
  const afterRelease = await adb.shell(serial, 'rm -f ' + quote(FILE), { timeout: 8000 });
  step('句柄已释放（rm 直接成功）', { ok: afterRelease.ok });

  // ④ 重启后的第一次清理：必须靠落盘那份登记表把目录收回来。
  for (const k of Object.keys(require.cache)) if (/services[\\/]adb\.js$/.test(k)) delete require.cache[k];
  const fresh = require('../src/main/services/adb');
  fresh.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
  fresh.setAlbumStateFile(stateFile);
  const second = await fresh.clearAlbum(serial, { deadline: Date.now() + 90000 });
  step('重启后的第一次 clearAlbum', { ok: second.ok, physicalPending: second.physicalPending.length,
    error: second.error });
  const nomedia = await exists(fresh, DIR + '/.nomedia');
  const physical = await exists(fresh, FILE);
  step('重启后回收结果', { nomedia: nomedia ? 'EXISTS' : 'MISSING', physical: physical ? 'EXISTS' : 'MISSING' });
  const pass = second.ok && !nomedia && !physical;
  step('结论', { pass, note: pass
    ? '进程重启后仍靠落盘登记表收回了上一次隔离的目录（真删物理文件 + 撤掉 .nomedia）'
    : '★没收回：重启后登记表没接回来（这正是要修的洞）' });
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (!pass) process.exitCode = 1;
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });
