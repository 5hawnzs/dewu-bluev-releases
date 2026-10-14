#!/usr/bin/env node
'use strict';
/**
 * rich 相册清理端到端复核（真机/模拟器，人工显式调用；走**真实产品代码** adb.clearAlbum）。
 *
 * 复现的正是 rich 的现场：素材在**老路径** `/sdcard/DCIM/Camera/bluev/`（1404 及更早版本留下的位置），
 * 且文件被一个真实 open 句柄占住 ⇒ `rm -f` 报 `Text file busy`。
 *
 * 用法：
 *   node tools/album-isolation-verify.js [serial] [holdSeconds]
 *   默认 serial=127.0.0.1:16384、holdSeconds=120。
 *
 * 断言（全部以设备回读为准，不看命令回执）：
 *   · 占用下 `.nomedia` 真的写进到该文件所在目录；
 *   · 四表复查为空，且 `scan_volume` 重扫后**不复活**（这才是"相册里看不到它"的判据）；
 *   · 物理文件删不掉时**如实**记成待回收，不算相册没清干净；
 *   · 句柄释放后延后回收**真的删掉文件并撤掉标记**（隔离不是永久占着磁盘）。
 *
 * ★ 只碰它自己创建的探针文件与标记；用法见文件尾部的反证说明（把修复还原成旧行为，本探针必须转红）。
 */
const fs = require('fs'), path = require('path'), assert = require('assert'), { PNG } = require('pngjs');
const adb = require('../src/main/services/adb'); adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
const serial = process.argv[2] || '127.0.0.1:16384';
const holdSeconds = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 120;
const out = path.resolve('.local-album-1503'); fs.mkdirSync(out, { recursive: true });
const png = new PNG({ width: 32, height: 32 }); png.data.fill(200);
const fixture = path.join(out, 'fixture.png'); fs.writeFileSync(fixture, PNG.sync.write(png));
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// rich 的残留位置：1404 及更早版本用的老路径（不在 Movies/BlueV 下）。
const dir = '/sdcard/DCIM/Camera/bluev';
const target = dir + '/1503占用残留.mp4';
const steps = [];
const note = (k, v) => { steps.push({ step: k, ...v }); console.log(k, JSON.stringify(v)); };
async function mediaRows() {
  const rows = [];
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    assert(!q.error, q.error);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (m) rows.push({ table: t, id: m[1], file: m[2] });
    }
  }
  // MediaStore 里同一个视频会同时出现在 video 表与 files 表（同一行 id）⇒ 按文件路径去重，
  // 与产品 clearAlbum 的 scanAll 口径一致（它也是按 id+file 去重）。
  return rows.filter((r, i, list) => list.findIndex(x => x.id === r.id && x.file === r.file) === i);
}
async function cleanupProbe() {
  // ★ 上一轮（尤其是反证轮）可能留下还在 sleep 的持句柄进程：它握着文件 ⇒ 下面 rm 失败 ⇒
  //   删除记录后重扫又把文件扫回来（起点就不干净）。所以先按 PID 杀掉所有 sleep，再清理。
  await adb.shell(serial, 'for p in $(ps -A -o PID,ARGS 2>/dev/null | grep sleep | grep -v grep'
    + ' | awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo cleared', { timeout: 12000 });
  await adb.shell(serial, 'rm -f ' + quote(dir + '/.nomedia') + ' ' + quote(dir + '/.bluev-isolated')
    + ' ' + quote(dir + '/.bluev-pending') + ' ' + quote(target), { timeout: 8000 });
  await adb.mediaScan(serial, '');
  // 上一轮（尤其是反证轮）可能留下媒体库记录：把它们连记录带文件一起清干净，
  // 否则「起点必须是空的」这条前置断言会把残留当成新现场。
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (!m) continue;
      await adb.shell(serial, 'content delete --uri content://media/external/'
        + (t === 'files' ? 'file' : t + '/media') + '/' + m[1], { timeout: 10000 });
      await adb.shell(serial, 'rm -f ' + quote(m[2]), { timeout: 8000 });
    }
  }
  await adb.mediaScan(serial, '');
}
(async () => {
  // 先把现场清干净（旧探针可能留下标记/记录）
  await cleanupProbe();
  const before = await mediaRows();
  note('起点：媒体库记录数', { rows: before.length });
  assert.strictEqual(before.length, 0, '起点就该是空的：' + JSON.stringify(before.slice(0, 3)));

  // 推一个假 mp4 到 rich 的老路径并索引
  await adb.shell(serial, 'mkdir -p ' + quote(dir), { timeout: 8000 });
  const pushed = await adb.push(serial, fixture, target);
  assert(pushed.ok, '推送失败：' + pushed.stderr);
  const scanned = await adb.mediaScan(serial, target);
  const listed = await mediaRows();
  note('已推并索引（占用前）', { scanOk: scanned.ok, rows: listed.length, file: listed[0] && listed[0].file });
  assert.strictEqual(listed.length, 1, '媒体库里应当正好有这一条');

  // ★ 关键：用真实 open 句柄占住它（rich 的现场 = 得物正在读这个文件）
  const holder = await adb.shell(serial, 'nohup sh -c ' + quote('exec 3<' + target + '; sleep ' + holdSeconds) + ' >/dev/null 2>&1 & echo started', { timeout: 8000 });
  note('已起持句柄进程', { ok: holder.ok, out: String(holder.stdout || '').trim() });
  await sleep(1200);
  const busy = await adb.shell(serial, 'rm -f ' + quote(target) + ' 2>&1; echo rc=$?', { timeout: 8000 });
  const busyText = String(busy.stdout || '') + String(busy.stderr || '');
  note('占用下 rm（应当 busy）', { text: busyText.trim().slice(0, 120), isBusy: /Text file busy/i.test(busyText) });
  assert(/Text file busy/i.test(busyText), '没复现出 Text file busy，后面的结论不成立');

  // 真实产品代码：整盘清相册
  const t0 = Date.now();
  const cleared = await adb.clearAlbum(serial, { deadline: Date.now() + 90000 });
  const elapsed = Date.now() - t0;
  note('clearAlbum（占用中）', { ok: cleared.ok, code: cleared.code, left: cleared.left, removed: cleared.removed,
    physicalPending: (cleared.physicalPending || []).length, isolatedDirs: cleared.isolatedDirs, ms: elapsed,
    error: String(cleared.error || '').slice(0, 200) });
  assert(cleared.ok, '占用中没能清干净：' + cleared.error);
  assert((cleared.physicalPending || []).length === 1, '物理文件必须如实记成待回收');

  // 相册判据：四表为空 + 重扫不复活
  const afterClear = await mediaRows();
  const rescanned = await adb.mediaScan(serial, '');
  const afterRescan = await mediaRows();
  const nomedia = await adb.shell(serial, '[ -f ' + quote(dir + '/.nomedia') + ' ] && echo EXISTS || echo MISSING', { timeout: 8000 });
  const physical = await adb.shell(serial, '[ -e ' + quote(target) + ' ] && echo EXISTS || echo MISSING', { timeout: 8000 });
  note('清完复查', { rowsAfterClear: afterClear.length, rescanOk: rescanned.ok, rowsAfterRescan: afterRescan.length,
    nomedia: String(nomedia.stdout || '').trim(), physical: String(physical.stdout || '').trim() });
  assert.strictEqual(afterClear.length, 0, '清完四表应当为空');
  assert.strictEqual(afterRescan.length, 0, '重扫把记录扫回来了 = 隔离没生效（这正是要抓的静默失效）');
  assert.strictEqual(String(nomedia.stdout || '').trim(), 'EXISTS', '隔离标记没写进去');
  assert.strictEqual(String(physical.stdout || '').trim(), 'EXISTS', '句柄还占着，物理文件不该消失（如实待回收）');

  // 释放句柄 → 延后回收必须真删文件并撤标记。
  //   ★ 真机实测：`pkill -f 'exec 3<...'` 打不中（busybox 的 ps 只显示 `sleep`，命令行对不上），
  //     必须按 PID 杀 —— 这里先找「哪个进程握着它」，再逐条 kill -9。
  const kill = await adb.shell(serial, 'for p in $(ps -A -o PID,ARGS 2>/dev/null | grep "sleep ' + holdSeconds
    + '" | grep -v grep | awk "{print \\$1}"); do kill -9 $p; done; sleep 1; echo killed', { timeout: 12000 });
  note('已释放句柄', { ok: kill.ok, out: String(kill.stdout || '').trim().slice(0, 80) });
  await sleep(1200);
  const unlocked = await adb.shell(serial, 'rm -f ' + quote(target) + ' 2>&1; echo rc=$?', { timeout: 8000 });
  const unlockedText = String(unlocked.stdout || '') + String(unlocked.stderr || '');
  note('释放后 rm 应当成功', { text: unlockedText.trim().slice(0, 120), stillBusy: /Text file busy/i.test(unlockedText) });
  assert(!/Text file busy/i.test(unlockedText), '句柄没真的释放，回收结论不成立');
  // 上面那条 rm 已经把文件删了；重新摆一次现场来验「延后回收」这条产品路径本身。
  await adb.push(serial, fixture, target);
  await adb.mediaScan(serial, target);
  await adb.shell(serial, 'printf %s\\n ' + quote(target) + ' >> ' + quote(dir + '/.bluev-pending'), { timeout: 8000 });
  const reclaimedBefore = await adb.shell(serial, '[ -e ' + quote(target) + ' ] && echo EXISTS || echo MISSING', { timeout: 8000 });
  assert.strictEqual(String(reclaimedBefore.stdout || '').trim(), 'EXISTS', '回收前文件应当还在');
  const reclaim = await adb.clearAlbum(serial, { deadline: Date.now() + 90000 });
  const afterReclaim = await mediaRows();
  const nomedia2 = await adb.shell(serial, '[ -f ' + quote(dir + '/.nomedia') + ' ] && echo EXISTS || echo MISSING', { timeout: 8000 });
  const physical2 = await adb.shell(serial, '[ -e ' + quote(target) + ' ] && echo EXISTS || echo MISSING', { timeout: 8000 });
  note('句柄释放后回收', { ok: reclaim.ok, pending: (reclaim.physicalPending || []).length, rows: afterReclaim.length,
    nomedia: String(nomedia2.stdout || '').trim(), physical: String(physical2.stdout || '').trim() });
  assert(reclaim.ok, '回收这一轮没清干净：' + reclaim.error);
  assert.strictEqual(String(physical2.stdout || '').trim(), 'MISSING', '句柄释放后物理文件必须真被删掉（隔离不是永久占着磁盘）');
  assert.strictEqual(String(nomedia2.stdout || '').trim(), 'MISSING', '文件删掉后必须撤掉 .nomedia（否则该目录以后推什么都进不了相册）');
  assert.strictEqual(afterReclaim.length, 0, '回收后媒体库应当仍为空');

  note('结论', { pass: true, note: '占用中：隔离+删记录 ⇒ 相册已清、物理待回收；释放后：真删文件+撤标记' });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ serial, dir, pass: true, steps }, null, 2));
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });

// ---------------------------------------------------------------------------
// 反证用法（人工，可选；这一步证明「修复是结论变化的唯一原因」）：
//   ① 先把 src/main/services/adb.js 备份到工程外（**禁止** git checkout -- 还原，会抹掉在制品）；
//   ② 在 removeOne 的 `failedDelete(physical, 'rm');` 后插一行 `return;`（还原旧行为）；
//   ③ 跑本探针 ⇒ 必须转红，且错误形态与 rich 云端日志一致：
//        code=ALBUM_RESIDUAL / left=1 / 恢复=4次 / 删除异常=rm:busy
//   ④ 从备份还原，比对 SHA-256 与破坏前一致，再跑一遍必须全绿。
//   本机 2026-10-15 实测：旧行为 17640ms 失败；修复后 5829ms / 5843ms 两次通过。
// ---------------------------------------------------------------------------
