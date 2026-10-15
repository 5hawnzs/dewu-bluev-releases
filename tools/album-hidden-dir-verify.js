#!/usr/bin/env node
'use strict';
/**
 * 「第二手段」真机原语复核：`.nomedia` 写不进去时，把**整个目录改名成点开头**，
 * 媒体扫描器是否就不再索引它 —— 真机上可复算的证据。
 *
 * 为什么必须验这一条（它是清理相册**唯一的硬停**）：
 *   `clearAlbum` 在 `rm` 失败时会写 `.nomedia` 隔离；`.nomedia` **写不进去**（设备 I/O 异常）时，
 *   现在的代码只能如实停批（`ALBUM_ISOLATION_FAILED`）—— 因为库记录删掉后会被下一次全盘扫描
 *   原样扫回来。清理相册就卡在这一条上。第二手段是：把整个目录改名成 `.开头`（媒体扫描器
 *   天然跳过点开头目录），记录随后的全盘复核清掉。
 *
 * 本探针验的是**原语**（不看产品代码，只看设备行为），三步都要真机回读：
 *   ① 目录正常时：索引进库 ⇒ 记录在；
 *   ② 目录改名成点开头后：`scan_volume` ⇒ 记录**消失**，再扫一次**仍不复活**；
 *   ③ 反证：把目录名改回来 ⇒ `scan_volume` ⇒ 记录**回来**（证明开关确实是那个点）。
 *
 * 安全性：只碰自己造的探针目录与文件，结束时删干净（无论成功失败）。
 * 用法：node tools/album-hidden-dir-verify.js [serial]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-hid-'));
const load = Module._load;
Module._load = function (name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};
const adb = require('../src/main/services/adb');
adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));

const serial = process.argv[2] || '127.0.0.1:16384';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const note = (k, v) => console.log(k, JSON.stringify(v));

// 与 rich 的老残留同一层：父目录不是点开头，只有我们这一层改名。
const PARENT = '/sdcard/DCIM/Camera';
const DIR = PARENT + '/hidprobe_dir';
const HIDDEN = PARENT + '/.hidprobe_dir';
const FILE = DIR + '/hidprobe_media.mp4';
const FILE_HIDDEN = HIDDEN + '/hidprobe_media.mp4';
const PROBE_RE = /hidprobe_/i;

async function rows() {
  const out = [];
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    assert(!q.error, q.error);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (m) out.push({ table: t, id: m[1], file: m[2] });
    }
  }
  return out.filter((r, i, list) => list.findIndex(x => x.id === r.id && x.file === r.file) === i);
}
const probeRows = async () => (await rows()).filter(r => PROBE_RE.test(r.file));
const scanVolume = async () => {
  const r = await adb.shell(serial, 'content call --uri content://media --method scan_volume '
    + '--arg external_primary', { timeout: 60000 });
  return r.ok;
};
async function cleanup() {
  await adb.shell(serial, 'rm -rf ' + quote(DIR) + ' ' + quote(HIDDEN), { timeout: 12000 });
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (!m || !PROBE_RE.test(m[2])) continue;
      await adb.shell(serial, 'content delete --uri content://media/external/'
        + (t === 'files' ? 'file' : t + '/media') + '/' + m[1], { timeout: 10000 });
    }
  }
  await scanVolume();
}

(async () => {
  assert(await adb.online(serial), '设备不在线：' + serial);
  await cleanup();

  // ---- ① 正常目录：文件索引进库 ----
  await adb.shell(serial, 'mkdir -p ' + quote(DIR), { timeout: 8000 });
  const fixture = path.join(tmp, 'probe.mp4');
  fs.writeFileSync(fixture, Buffer.alloc(2048, 3));
  assert((await adb.push(serial, fixture, FILE)).ok, '推送探针文件失败');
  await adb.mediaScan(serial, FILE);
  const indexed = await probeRows();
  note('① 正常目录已索引', { rows: indexed.length, file: indexed[0] && indexed[0].file });
  assert(indexed.length >= 1, '前提不成立：文件没进库');

  // ---- ② 整个目录改名成点开头 ⇒ 再全盘扫描 ----
  const mv = await adb.shell(serial, 'mv ' + quote(DIR) + ' ' + quote(HIDDEN) + ' 2>&1; echo rc=$?',
    { timeout: 10000 });
  note('② 目录改名成点开头', { out: String(mv.stdout || '').trim().slice(0, 120), mvOk: mv.ok });
  assert(mv.ok && !/rc=[1-9]/.test(String(mv.stdout || '')), '改名失败，第二手段的前提不成立');
  await scanVolume();
  const afterHide = await probeRows();
  await scanVolume();
  const afterHide2 = await probeRows();
  note('② 改名后重扫两次', { afterFirst: afterHide.length, afterSecond: afterHide2.length,
    files: afterHide2.map(r => r.file) });
  assert.strictEqual(afterHide.length, 0, '点开头目录里的文件仍被扫进库（第二手段无效）：'
    + JSON.stringify(afterHide.map(r => r.file)));
  assert.strictEqual(afterHide2.length, 0, '第二次全盘扫描又把它扫回来了（第二手段无效）');
  const onDisk = String((await adb.shell(serial, 'if [ -f ' + quote(FILE_HIDDEN)
    + ' ]; then echo EXISTS; else echo MISSING; fi', { timeout: 8000 })).stdout || '').trim();
  note('② 物理文件仍在隐藏目录里', { state: onDisk });
  assert.strictEqual(onDisk, 'EXISTS', '文件不该消失（第二手段只隐藏、不删物理文件）');

  // ---- ③ 反证：名字改回来 ⇒ 记录回来（证明开关就是那个点） ----
  await adb.shell(serial, 'mv ' + quote(HIDDEN) + ' ' + quote(DIR), { timeout: 10000 });
  await scanVolume();
  const back = await probeRows();
  note('③ 反证：名字改回来后记录是否回来', { rows: back.length, file: back[0] && back[0].file });
  assert(back.length >= 1, '反证失败：改回来也没记录，说明开关不是「点开头」—— 那第二手段就没有根据');

  await cleanup();
  const end = await probeRows();
  assert.strictEqual(end.length, 0, '收尾没清干净：' + JSON.stringify(end.map(r => r.file)));
  console.log('结论 ' + JSON.stringify({ pass: true,
    note: '第二手段真机原语成立：目录改名成点开头 ⇒ 全盘扫描不再索引它、重复扫也不复活；'
      + '名字改回来 ⇒ 记录立刻回来（开关确认就是那个点）' }));
})().catch(async e => {
  console.error('FAIL ' + (e && e.message));
  try { await cleanup(); } catch (x) { console.error('清理探针失败：' + x.message); }
  process.exitCode = 1;
});
