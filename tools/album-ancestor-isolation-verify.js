#!/usr/bin/env node
'use strict';
/**
 * 「隔离写在**上层**目录时，标记最终一定会被撤掉」真机复核（人工显式调用）。
 *
 * 为什么必须有这一个：`.nomedia` 写在**文件自己那一层**写不进时，产品会往**上一层**去写。
 *   真机实测（本机 MuMu，7 次实验 6 次有效）：**祖先目录的 `.nomedia` 同样能让子孙不再进相册**。
 *   这条通路一旦成了，被隔离的可能是 `DCIM/Camera` 这种**相机默认落盘处** ——
 *   如果回收那一步收不回来，用户以后拍的照片在系统相册里会一直看不见，而程序每次都报「相册已清空」。
 *   这一条此前只在**假设备**（回归夹具里的 `NOMEDIA_DENIED` 只禁一层）上验过，真机没验过。
 *
 * ★ 怎么在真机上造出「自己那层写不进」的现场（踩过的坑，别重走）：
 *   最初想用 `chmod 555` 把残留自己那两层设成只读 —— **在 `/sdcard` 上无效**：
 *   实测 `chmod` 返回 `rc=0`，紧接着在同一层 `touch` 照样成功（`rc=0`）。
 *   原因：`/sdcard` 是 FUSE 视图（MediaProvider），不核 POSIX 目录写权限；`/data` 那类真实
 *   文件系统才核。所以真机上没法用权限开关来「只禁一层」。
 *   本探针改成**直接构造**那个现场：用产品自己的写法把 `.nomedia` + `.bluev-isolated` + 清单
 *   摆在**上层**（就是 `isolateFile` 退层成功时会留下的三个文件，内容一字不差），
 *   登记表也走**产品自己的落盘文件**。此后**只调产品代码**，不自己删任何东西。
 *
 * 验的是两件最要紧的事（判据全部来自设备上的事实，不看代码推断）：
 *   ① **隔离真的生效**：上层 `.nomedia` 在位时，深层残留**不会被扫进相册**（四表 0 条）；
 *   ② **隔离真的会撤**：句柄释放后再清一次 ⇒ 物理残留真删、上层三个标记文件**全都不在设备上**，
 *      且**登记表里也不再留着那一层**（否则下次运行还会以为它被隔离着）。
 *
 * 安全性：只碰本探针自己造的目录/文件与标记，结束时清干净（无论成功失败）。
 * 用法：node tools/album-ancestor-isolation-verify.js [serial]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-ances-'));
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

// 上层 = DCIM/Camera（rich 的相机关联路径）；残留摆在它下面两层的目录里
const ANCESTOR = '/sdcard/DCIM/Camera';
const DEEP = ANCESTOR + '/bluev/deep';
const OURS = DEEP + '/ancesprobe_leftover.mp4';
const NEIGHBOR = ANCESTOR + '/bluev/ancesprobe_neighbor.txt';   // 同目录里的普通文件（对照）
const NM_ANC = ANCESTOR + '/.nomedia';
const MARK_ANC = ANCESTOR + '/.bluev-isolated';
const PENDING_ANC = ANCESTOR + '/.bluev-pending';
// 产品源码里的字面量（构造现场时要一字不差）
const ISOLATE_MARK_TEXT = 'BLUEV_ISOLATED_V1';
const PROBE_RE = /ancesprobe/i;

const sh = (cmd, t) => adb.shell(serial, cmd, { timeout: t || 8000 });
const exists = async p => String((await sh('[ -e ' + quote(p) + ' ] && echo EXISTS || echo MISSING')).stdout || '').trim();
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
const stateFile = () => path.join(tmp, 'album-isolation.json');
async function cleanup() {
  await sh('for p in $(ps -A -o PID,ARGS 2>/dev/null | grep sleep | grep -v grep '
    + '| awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo ok', 12000);
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (!m || !PROBE_RE.test(m[2])) continue;
      await sh('content delete --uri content://media/external/'
        + (t === 'files' ? 'file' : t + '/media') + '/' + m[1], 10000);
    }
  }
  await sh('rm -f ' + [OURS, NEIGHBOR, NM_ANC, MARK_ANC, PENDING_ANC].map(quote).join(' '));
  await sh('rm -rf ' + quote(DEEP) + ' 2>/dev/null; echo ok');   // 只删探针自己造的深层目录
  try { fs.rmSync(stateFile(), { force: true }); } catch (e) { /* 不影响结论 */ }
  await adb.mediaScan(serial, '');
}

(async () => {
  assert(await adb.online(serial), '设备不在线：' + serial);
  await cleanup();
  const before = await rows();
  note('起点：媒体库记录数', { rows: before.length, files: before.map(r => r.file).slice(0, 5) });
  assert.strictEqual(before.length, 0,
    '起点媒体库非空 ⇒ 本探针不替用户删素材，直接中止：' + JSON.stringify(before.slice(0, 5)));

  // ① 摆现场：深层的残留（被句柄占住）+ 同目录里一个普通文件（对照）
  await sh('mkdir -p ' + quote(DEEP));
  const fixture = path.join(tmp, 'probe.bin');
  fs.writeFileSync(fixture, Buffer.alloc(2048, 22));
  assert((await adb.push(serial, fixture, OURS)).ok, '推送探针残留失败');
  assert((await adb.push(serial, fixture, NEIGHBOR)).ok, '推送对照文件失败');
  assert((await adb.mediaScan(serial, OURS)).ok, '索引探针残留失败');
  note('① 已摆现场', { rows: (await rows()).length, deep: DEEP });

  await sh('nohup sh -c ' + quote('exec 3<' + OURS + '; sleep 180') + ' >/dev/null 2>&1 & echo started');
  await sleep(1200);
  const busyText = String((await sh('rm -f ' + quote(OURS) + ' 2>&1; echo rc=$?')).stdout || '');
  note('② 占用下 rm（应当 busy）', { isBusy: /Text file busy/i.test(busyText) });
  assert(/Text file busy/i.test(busyText), '前提不成立：文件没被占住');

  // ③ 构造「隔离已经退到上层」的现场 —— 三个文件的内容与产品写法一字不差
  await sh('printf %s ' + quote(ISOLATE_MARK_TEXT) + ' > ' + quote(MARK_ANC)
    + '; touch ' + quote(NM_ANC)
    + "; printf '%s\\n' " + quote(OURS) + ' >> ' + quote(PENDING_ANC));
  note('③ 已构造上层隔离现场', {
    nm: await exists(NM_ANC), mark: await exists(MARK_ANC), pending: await exists(PENDING_ANC),
    内容: String((await sh('cat ' + quote(MARK_ANC))).stdout || '').trim()
  });
  assert.strictEqual(await exists(NM_ANC), 'EXISTS', '构造失败：上层 .nomedia 没写进去');

  // ④ 只调产品代码：让登记表接回这一层（产品自己读盘上的登记文件）
  //    先把「登记表」按产品的落盘格式写好，再调 clearAlbum —— 这样走的是**产品的回收循环**
  fs.writeFileSync(stateFile(), JSON.stringify({
    [serial]: { dirs: ['/storage/emulated/0/DCIM/Camera'], files: ['/storage/emulated/0/DCIM/Camera/bluev/deep/ancesprobe_leftover.mp4'] }
  }, null, 2));
  const first = await adb.clearAlbum(serial);
  note('④ 占用中清理（这一条必须成功：相册里看不到它）', {
    ok: first.ok, removed: first.removed, pending: (first.physicalPending || []).length,
    nm: await exists(NM_ANC), mark: await exists(MARK_ANC)
  });
  assert(first.ok, '上层隔离在位时，相册判据必须通过：' + JSON.stringify(first));
  // ★★★ 2026-10-15 真机复算更正：**不要**断言「上层 .nomedia 一定还在」。
  //   本机 MuMu 实测（两台设备、纯 adb 可复算）：`/sdcard/DCIM/Camera` 与 `/sdcard/Movies`
  //   这两层是**预置标准媒体目录**，系统 `scan_volume` 会把写在那里的 `.nomedia` 清掉
  //   （`/sdcard/DCIM/zzz`、`/sdcard/Movies/BlueV` 这种**我们自己新建的子目录**则留得住）。
  //   所以「标记还在不在」不是本探针该盯的东西 —— 它对用户没有意义，而且会随设备/系统版本变。
  //   真正要盯的是**用户看得见的事实**：相册四表里有没有这条残留（下面那条断言）。
  //   ★ 这也不会造成「假成功」：清干净与否的判据是**收尾那次全盘重扫**（四表为空且不复活）；
  //     若某层的标记被扫描吃掉，记录会在**同一次**重扫里回来 ⇒ 那条清理如实判失败，不会硬放行。
  const stillVisible = (await rows()).filter(r => PROBE_RE.test(r.file));
  assert.strictEqual(stillVisible.length, 0,
    '上层 .nomedia 在位时应让深层残留不再进相册，实测还有 ' + stillVisible.length + ' 条');

  // ⑤ 释放句柄 ⇒ 再清一次：必须真删残留 + 撤掉上层三个文件 + 登记里不再留着它
  await sh('for p in $(ps -A -o PID,ARGS 2>/dev/null | grep sleep | grep -v grep '
    + '| awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo ok', 12000);
  const second = await adb.clearAlbum(serial);
  const st = {
    ok: second.ok, pending: (second.physicalPending || []).length,
    ours: await exists(OURS), nm: await exists(NM_ANC), mark: await exists(MARK_ANC),
    pendingFile: await exists(PENDING_ANC), neighbor: await exists(NEIGHBOR)
  };
  note('⑤ 释放后清理（收口）', st);
  assert(second.ok, '释放后清理必须成功：' + JSON.stringify(second));
  assert.strictEqual(st.ours, 'MISSING', '残留必须被真删掉（不能只隔离不回收）');
  assert.strictEqual(st.nm, 'MISSING',
    '★ 关键：上层那个 `.nomedia` 必须被撤掉 —— 否则 DCIM/Camera 以后拍的照片在相册里一直看不见');
  assert.strictEqual(st.mark, 'MISSING', '上层归属凭据也要撤干净');
  assert.strictEqual(st.pendingFile, 'MISSING', '上层待回收清单也要撤掉');
  assert.strictEqual(st.neighbor, 'EXISTS', '对照文件不该被动');
  // 登记表里不能再留着那一层（否则下次运行还以为它被隔离着）
  let reg = '';
  try { reg = fs.readFileSync(stateFile(), 'utf8'); } catch (e) { reg = ''; }
  assert(!/DCIM\/Camera(?!\/bluev)/.test(reg.replace(/\\+/g, '/')) || !reg.includes('DCIM/Camera"'),
    '登记表里不该再留着被撤过标记的那一层：' + reg.slice(0, 300));

  await cleanup();
  note('收尾', { rows: (await rows()).length, nm: await exists(NM_ANC) });
  console.log('结论 ' + JSON.stringify({ pass: true,
    note: '真机上层的隔离闭环：上层 .nomedia 在位 ⇒ 深层残留不进相册（四表 0 条）；'
      + '句柄释放后再清，物理残留真删、上层 .nomedia/凭据/清单三个文件全撤、登记也不再留着它' }));
})().catch(async e => {
  console.error('FAIL ' + (e && e.message));
  try { await cleanup(); } catch (x) { console.error('清理探针失败：' + x.message); }
  process.exitCode = 1;
});
