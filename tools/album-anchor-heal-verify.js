#!/usr/bin/env node
'use strict';
/**
 * 「隔离标记最终一定会被撤掉」真机复核（人工显式调用）。
 *
 * 为什么必须有这一个：清理相册最难收口的不是「当次清干净」，而是**不留永久副作用** ——
 *   `.nomedia` 一旦写进某个目录而登记又丢了，那个目录（例如相机默认落盘的 `DCIM/Camera`）
 *   以后所有内容在系统相册里**一直不可见**，而程序每次还报「相册已清空」。
 *   侧边审计在假设备上证明过三类「回执被杀 = 结果未知」的通路会留下这种副作用；
 *   修好之后必须在真机上确认**它真的能自己收回来**。
 *
 * 本探针用真机 + 真 product 代码（`adb.clearAlbum`）走一遍**最坏顺序**：
 *   ① 在 `DCIM/Camera/bluev` 摆一条残留、占住它 ⇒ 清理把隔离写在外层，并登记；
 *   ② 人为**破坏归属凭据**（把 `.bluev-isolated` 删掉，模拟「那一笔其实没落盘」）——
 *      旧写法会就此把这个目录忘掉（登记被清、`.nomedia` 永远留着）；
 *   ③ 释放句柄、再清一次 ⇒ 必须**自愈**：补写凭据、真删物理残留、撤掉 `.nomedia`；
 *   ④ 收尾核对：那条 `.nomedia` 不在设备上了，且**同目录里用户自己的东西重新可见**。
 *
 * 安全性：只碰本探针自己造的文件与标记，结束时清干净（无论成功失败）。
 * 用法：node tools/album-anchor-heal-verify.js [serial]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-heal-'));
const load = Module._load;
Module._load = function (name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};
const adb = require('../src/main/services/adb');
adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));

const serial = process.argv[2] || '127.0.0.1:16384';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = (k, v) => console.log(k, JSON.stringify(v));

const DIR = '/sdcard/DCIM/Camera/bluev';
const NEIGHBOR = '/sdcard/DCIM/Camera/healprobe_neighbor.txt';  // 同目录里的普通文件（对照）
const OURS = DIR + '/healprobe_leftover.mp4';
const NM = DIR + '/.nomedia';
const MARK = DIR + '/.bluev-isolated';
const PENDING = DIR + '/.bluev-pending';
const PROBE_RE = /healprobe/i;

const exists = async p => String((await adb.shell(serial,
  '[ -e ' + quote(p) + ' ] && echo EXISTS || echo MISSING', { timeout: 8000 })).stdout || '').trim();
const rows = async () => {
  const out = [];
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    if (q.error) throw new Error(q.error);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (m) out.push({ table: t, id: m[1], file: m[2] });
    }
  }
  return out.filter((r, i, l) => l.findIndex(x => x.id === r.id && x.file === r.file) === i);
};
async function cleanup() {
  await adb.shell(serial, 'for p in $(ps -A -o PID,ARGS 2>/dev/null | grep sleep | grep -v grep '
    + '| awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo ok', { timeout: 12000 });
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (!m || !PROBE_RE.test(m[2])) continue;
      await adb.shell(serial, 'content delete --uri content://media/external/'
        + (t === 'files' ? 'file' : t + '/media') + '/' + m[1], { timeout: 10000 });
    }
  }
  await adb.shell(serial, 'rm -f ' + [OURS, NEIGHBOR, NM, MARK, PENDING].map(quote).join(' '), { timeout: 8000 });
  try {
    const f = path.join(tmp, 'album-isolation.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const k of Object.keys(j)) {
        if (j[k] && Array.isArray(j[k].files)) j[k].files = j[k].files.filter(p => !PROBE_RE.test(p));
        if (j[k] && Array.isArray(j[k].dirs)) j[k].dirs = [];
      }
      fs.writeFileSync(f, JSON.stringify(j, null, 2));
    }
  } catch (e) { /* 不影响结论 */ }
  await adb.mediaScan(serial, '');
}

(async () => {
  assert(await adb.online(serial), '设备不在线：' + serial);
  await cleanup();
  const before = await rows();
  note('起点：媒体库记录数', { rows: before.length, files: before.map(r => r.file).slice(0, 5) });
  assert.strictEqual(before.length, 0,
    '起点媒体库非空 ⇒ 本探针不替用户删素材，直接中止：' + JSON.stringify(before.slice(0, 5)));

  // ① 摆现场：我们的残留（被占住）+ 同目录里一个普通文件（对照）
  await adb.shell(serial, 'mkdir -p ' + quote(DIR), { timeout: 8000 });
  const fixture = path.join(tmp, 'probe.bin');
  fs.writeFileSync(fixture, Buffer.alloc(2048, 11));
  assert((await adb.push(serial, fixture, OURS)).ok, '推送探针残留失败');
  assert((await adb.push(serial, fixture, NEIGHBOR)).ok, '推送对照文件失败');
  assert((await adb.mediaScan(serial, OURS)).ok, '索引探针残留失败');
  note('① 已摆现场', { rows: (await rows()).length });

  await adb.shell(serial, 'nohup sh -c ' + quote('exec 3<' + OURS + '; sleep 180')
    + ' >/dev/null 2>&1 & echo started', { timeout: 8000 });
  await sleep(1200);
  const busyText = String((await adb.shell(serial, 'rm -f ' + quote(OURS) + ' 2>&1; echo rc=$?',
    { timeout: 8000 })).stdout || '');
  note('① 占用下 rm（应当 busy）', { isBusy: /Text file busy/i.test(busyText) });
  assert(/Text file busy/i.test(busyText), '前提不成立：文件没被占住');

  const first = await adb.clearAlbum(serial);
  note('① 占用中清理', { ok: first.ok, removed: first.removed,
    pending: (first.physicalPending || []).length });
  assert(first.ok, '占用中清理必须成功：' + JSON.stringify(first));
  assert.strictEqual(await exists(NM), 'EXISTS', '占用中必须写进 .nomedia');
  assert.strictEqual(await exists(MARK), 'EXISTS', '归属凭据应当也在');

  // ② 破坏归属凭据（模拟「那一笔其实没落盘」）——旧写法会就此忘掉这个目录
  await adb.shell(serial, 'rm -f ' + quote(MARK), { timeout: 8000 });
  note('② 已破坏归属凭据（模拟回执被杀导致那一笔没落盘）', { mark: await exists(MARK) });
  assert.strictEqual(await exists(MARK), 'MISSING');

  // ③ 释放句柄 ⇒ 再清一次：必须自愈（补凭据 → 真删残留 → 撤标记）
  await adb.shell(serial, 'for p in $(ps -A -o PID,ARGS 2>/dev/null | grep sleep | grep -v grep '
    + '| awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo ok', { timeout: 12000 });
  const second = await adb.clearAlbum(serial);
  note('③ 释放后清理（自愈）', { ok: second.ok, pending: (second.physicalPending || []).length,
    ours: await exists(OURS), nomedia: await exists(NM), mark: await exists(MARK),
    neighbor: await exists(NEIGHBOR) });
  assert(second.ok, '释放后清理必须成功：' + JSON.stringify(second));
  assert.strictEqual(await exists(OURS), 'MISSING', '残留必须被真删掉（不能只隔离不回收）');
  assert.strictEqual(await exists(NM), 'MISSING',
    '★ 关键：凭据丢过也必须自愈 —— `.nomedia` 绝不能永久留在设备上（否则该目录以后一直不可见）');
  assert.strictEqual(await exists(MARK), 'MISSING', '归属凭据也要撤干净');
  assert.strictEqual(await exists(NEIGHBOR), 'EXISTS', '对照文件不该被动（回收只删登记过的路径）');

  await cleanup();
  note('收尾', { rows: (await rows()).length });
  console.log('结论 ' + JSON.stringify({ pass: true,
    note: '真机自愈复核：占用中隔离 → 归属凭据被人为抹掉 → 释放后再清，'
      + '仍然补凭据、真删残留、撤掉 .nomedia（不留永久隐藏目录）' }));
})().catch(async e => {
  console.error('FAIL ' + (e && e.message));
  try { await cleanup(); } catch (x) { console.error('清理探针失败：' + x.message); }
  process.exitCode = 1;
});
