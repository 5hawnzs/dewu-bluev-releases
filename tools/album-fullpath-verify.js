#!/usr/bin/env node
'use strict';
/**
 * 相册清理**全链路真机复核**（人工显式调用）。
 *
 * 为什么要单独有这一个（这是前面所有真机探针都没覆盖的那一段）：
 *   · `album-isolation-verify.js` 打的是 `adb.clearAlbum` —— **只覆盖判据那一环**；
 *   · `album-readytest` / `publishcontinuationtest` 打的是完整 `publisher.run`，
 *     但跑在**假设备**（fakeadb）上；
 *   ⇒ 于是「`managedalbum.retire` → `albumready.prepare` → `clearAlbum` → `managedalbum.create`」
 *     这一整条**生产顺序**，从来没有在任何一台真机上跑过。它恰恰是 rich 每天走的那条路：
 *     rich 的故障就出在这条路的**第一步**（`ls -1A` 目录命令被宿主超时掐掉 ⇒ 旧代码 throw ⇒
 *     整批停住）。假设备上「夹具说 ls 失败」和「真机上 adb 被 ExecFile 超时杀掉」不是一回事。
 *
 * 本探针**用真机 + 真 product 代码**连跑**两条**（就是 rich 每天做的事）：
 *   ① 先摆一个「上一条」残留：素材落在 rich 的老路径 `DCIM/Camera/bluev`
 *      （1404 及更早版本的残留位置），且**被真实句柄占住**（`rm` 报 Text file busy）；
 *   ② `albumready.prepare()` 第 1 条 —— 清理老路径残留（隔离 + 删记录）→ 建新批目录
 *      → 推素材 → 索引 → `albumMatches` 复核（只该有本条）；
 *   ③ `albumready.prepare()` 第 2 条 —— 紧接着走**跨条**这条路：`managedalbum.retire()`
 *      必须把第 1 条那个批次目录回收掉（真删文件、撤标记），再清相册、再推第 2 条。
 *      这一步在真机上从没跑过，而它正是 rich「第一条发完、第二条就卡住」的位置。
 *   ④ 断言判据：四表复查为空且重扫不复活；批次目录真被回收；
 *      日志里**同时**出现「相册已清空」与「另有 N 个物理文件未删除、待回收」两句
 *      （不许拿相册干净冒充磁盘干净）；释放句柄后物理文件真被删掉、`.nomedia` 真被撤掉。
 *
 * 安全性（只碰自己造的东西）：
 *   · **起点媒体库非空就直接中止**（绝不替用户删他自己的素材）；
 *   · 只创建/删除**本探针自己**的探针文件、它自己那两个 batch 目录与标记；
 *   · **不推送**任何新素材、**不点界面**、**不强停得物**；
 *   · 结束时把媒体库里由本探针引入的记录一并清掉（无论成功失败）。
 *
 * 用法：
 *   node tools/album-fullpath-verify.js [serial]     # 默认 127.0.0.1:16384
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// albumready 依赖 mainimg / store，store 又要 electron —— 与其它真机探针同法注入最小 stub。
const Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-fullpath-'));
const load = Module._load;
Module._load = function (name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};

const adb = require('../src/main/services/adb');
adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
const managedalbum = require('../src/main/services/managedalbum');
const store = require('../src/main/store');
const albumready = require('../src/main/services/albumready');

const serial = process.argv[2] || '127.0.0.1:16384';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
// 设备路径有两种写法：`/sdcard/...`（shell 用）与 `/storage/emulated/0/...`（媒体库 `_data` 用），
// 比前缀之前必须归一，否则探针会拿两种写法互比 ⇒ 自己假红。
const norm = p => String(p).replace(/^\/sdcard\//, '/storage/emulated/0/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const steps = [];
const note = (k, v) => { steps.push({ step: k, ...v }); console.log(k, JSON.stringify(v)); };

// rich 的老残留路径（1404 及更早版本推素材的位置）——本探针故意用同一个目录，
// 因为「旧路径能不能隔离」正是 rich 验收要回答的问题。
const OLD_DIR = '/sdcard/DCIM/Camera/bluev';
// ★ 探针文件一律用**纯 ASCII** 名字：`albumready.prepare` 第 64 行会把文件名消毒
//   （`[^\w.\-+]` → `_`），中文名到了设备上会变成 `_____-__.mp4`，
//   于是「按名字反查/删除」全部落空 ⇒ 探针自己假红、还会往设备上留垃圾。
//   用 ASCII 名字就完全绕开这条消毒规则，判据与清场都按同一个名字走。
const PROBE = OLD_DIR + '/fullpath-probe-old.mp4';
const CHILD = 'fullpath-probe-child.mp4';
const NM = OLD_DIR + '/.nomedia';
const MARK = OLD_DIR + '/.bluev-isolated';
const PENDING = OLD_DIR + '/.bluev-pending';
const PROBE_RE = /fullpath-probe-/i;
const createdDirs = [];

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
  return rows.filter((r, i, list) => list.findIndex(x => x.id === r.id && x.file === r.file) === i);
}
/**
 * 只清「本探针自己引入」的记录与文件，绝不遍历删别的素材。
 * ★ 判据用**探针文件名前缀**（`fullpath-probe-`）与**上一轮自己记下来的批次目录**两条，够了；
 *   上一轮若在「推完素材、还没登记目录」之间被打断，那条素材也还叫 `fullpath-probe-child.mp4`
 *   ⇒ 用它的媒体库路径反查所属 batch 目录，一并清掉。
 */
async function cleanupProbe() {
  await adb.shell(serial, 'for p in $(ps -A -o PID,ARGS 2>/dev/null | grep -E "sleep|fullpath-probe" '
    + '| grep -v grep | awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo ok', { timeout: 12000 });
  // 先按媒体库记录删（探针文件名可辨识），再删自己的标记与文件。
  const orphanDirs = new Set();
  for (const t of ['video', 'images', 'audio', 'files']) {
    const q = await adb.queryMediaTable(serial, t);
    for (const line of String(q.result.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
      if (!m || !PROBE_RE.test(m[2])) continue;
      await adb.shell(serial, 'content delete --uri content://media/external/'
        + (t === 'files' ? 'file' : t + '/media') + '/' + m[1], { timeout: 10000 });
      // 本条素材落在批次目录里 ⇒ 把那个目录也记下来一起清（只清探针自己推的文件）。
      const dir = String(m[2]).replace(/^\/storage\/emulated\/0\//, '/sdcard/').replace(/\/[^/]+$/, '');
      if (/\/Movies\/BlueV\/\.?batch_/.test(dir)) orphanDirs.add(dir);
    }
  }
  for (const d of orphanDirs) createdDirs.push(d);
  await adb.shell(serial, 'rm -f ' + [PROBE, NM, MARK, PENDING].map(quote).join(' '), { timeout: 8000 });
  // 本探针建过的批次目录：连同里面**探针自己推的**文件一起删掉，再撤标记、删目录。
  for (const d of new Set(createdDirs)) {
    await adb.shell(serial, 'rm -f ' + quote(d + '/' + CHILD) + ' ' + quote(d + '/.nomedia') + ' '
      + quote(d + '/.bluev-managed-v1') + ' 2>/dev/null; rmdir ' + quote(d) + ' 2>/dev/null; echo ok', { timeout: 8000 });
  }
  createdDirs.splice(0);
  // 顺带清掉本条可能残留的待回收登记（只针对本探针那条路径）。
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
  } catch (e) { /* 登记表清理失败不影响结论 */ }
  await adb.mediaScan(serial, '');
}

/** 组装一次 prepare 需要的 item/row（video，本地素材用探针自己那个文件）。
 *  ★ 新批素材的名字也带探针前缀：这样「清理后相册里只该有本条自己的素材」这条断言
 *    才判得准（否则按标记筛出来的集合会漏掉刚推上去的那条 ⇒ 探针自己假红）。 */
const item = { dir: tmp, absDir: tmp, files: [{ name: CHILD, type: 'video' }] };
const mkRow = seq => ({ seq, id: 'PROBE' + seq, dir: 'fullpath-probe-' + seq, kind: 'video',
  status: '', result: '', reason: '' });

(async () => {
  const online = await adb.online(serial);
  assert(online, '设备不在线：' + serial);

  await cleanupProbe();
  const before = await mediaRows();
  note('起点：媒体库记录数', { rows: before.length, files: before.map(r => r.file).slice(0, 5) });
  assert.strictEqual(before.length, 0,
    '起点媒体库非空 ⇒ 本探针不替用户删他的素材，直接中止：' + JSON.stringify(before.slice(0, 5)));

  // ---- ① 造现场：上一批的旧素材落在老路径，且**被真实句柄占住**（rich 的原样） ----
  await adb.shell(serial, 'mkdir -p ' + quote(OLD_DIR), { timeout: 8000 });
  const png = path.join(tmp, 'probe.mp4');
  fs.writeFileSync(png, Buffer.alloc(2048, 7));               // 内容不重要，只要能 push + 索引
  fs.writeFileSync(path.join(tmp, CHILD), Buffer.alloc(4096, 9));  // 新批要推的「素材」
  const pushed = await adb.push(serial, png, PROBE);
  assert(pushed.ok, '推送探针文件失败：' + pushed.stderr);
  const scanned = await adb.mediaScan(serial, PROBE);
  assert(scanned.ok, '索引探针文件失败');
  const indexRows = (await mediaRows()).filter(r => PROBE_RE.test(r.file));
  note('探针素材已索引', { rows: indexRows.length, file: indexRows[0] && indexRows[0].file });
  assert(indexRows.length >= 1, '媒体库里应当有这条探针素材');

  // 句柄要活到第 ⑥ 步之后（整轮含两次 prepare，实测 30s 上下）⇒ 留足余量。
  const holder = await adb.shell(serial, 'nohup sh -c ' + quote('exec 3<' + PROBE + '; sleep 180')
    + ' >/dev/null 2>&1 & echo started', { timeout: 8000 });
  note('已起持句柄进程', { out: String(holder.stdout || '').trim() });
  await sleep(1200);
  const busy = await adb.shell(serial, 'rm -f ' + quote(PROBE) + ' 2>&1; echo rc=$?', { timeout: 8000 });
  const busyText = String(busy.stdout || '') + String(busy.stderr || '');
  note('占用下 rm（应当 busy）', { isBusy: /Text file busy/i.test(busyText) });

  // ---- ② retire 对**老路径**必须一条都不动（它只认自己名下带归属标记的批次目录） ----
  const retireOld = await managedalbum.retire(serial, { cancelled: () => false });
  note('retire（老路径不该被它动）', retireOld);
  assert(retireOld && typeof retireOld.isolated === 'number', 'retire 必须返回结构化结果，不许 throw');
  assert(retireOld.isolated === 0, 'retire 不该动老路径（那里的素材不属于它管的批次目录）');

  // ---- ③ 第 1 条：走**真实 albumready.prepare**（清理 → 建批目录 → 推送 → 索引 → 复核） ----
  store.set({ publish: { ...(store.get('publish') || {}), device: serial } });
  const runPrepare = async (seq, kindLabel) => {
    const row = mkRow(seq);
    const logs = [];
    const r = await albumready.prepare(serial, item, row, {
      publishConfig: store.get('publish') || {},
      log: (m, lv) => { logs.push((lv || 'info') + ': ' + m); console.log('  [product] ' + m); },
      conclude: () => {},
      cancelled: () => false,
      onRow: () => {},
    });
    if (r && r.remoteDir && !createdDirs.includes(r.remoteDir)) createdDirs.push(r.remoteDir);
    note(kindLabel + '：albumready.prepare 完成', { remoteDir: r && r.remoteDir, remotes: r && r.remotes });
    return { r, logs };
  };
  const first = await runPrepare(1, '第1条');
  const logs = first.logs;

  // ---- ③ 判据：四表为空 + 重扫不复活 ----
  const held = (await mediaRows()).filter(r => PROBE_RE.test(r.file));
  await adb.mediaScan(serial, '');
  const afterRescan = (await mediaRows()).filter(r => PROBE_RE.test(r.file));
  const nmState = await adb.shell(serial, '[ -f ' + quote(NM) + ' ] && echo EXISTS || echo MISSING');
  note('清理后复查', { rowsAfterClear: held.length, rowsAfterRescan: afterRescan.length,
    nomedia: String(nmState.stdout || '').trim() });
  // ★ 清理后相册里**只能有本条刚推上去的素材**：被占住的那条必须已经不在索引里。
  const leftover = afterRescan.filter(r => /fullpath-probe-old/i.test(r.file));
  note('清理后相册内容', { rowsAfterRescan: afterRescan.length, leftoverOld: leftover.length,
    files: afterRescan.map(r => r.file) });
  assert.strictEqual(leftover.length, 0, '被占住的上一条素材：删记录 + 隔离后绝不能再出现在相册里');
  assert(afterRescan.length >= 1 && afterRescan.every(r => PROBE_RE.test(r.file)),
    '清理后相册里只该有本探针推上去的素材，实际：' + JSON.stringify(afterRescan.map(r => r.file)));
  assert.strictEqual(String(nmState.stdout || '').trim(), 'EXISTS',
    '占用中必须靠 .nomedia 隔离（否则重扫会复活）');

  // ---- ④ 日志原文：两句必须**同时**出现（不许拿相册干净冒充磁盘干净） ----
  const all = logs.join('\n');
  const saidClean = /相册已清空（回收 \d+ 条记录，耗时 [\d.]+s）/.test(all);
  const saidPending = /另有 \d+ 个物理文件未删除、待回收（已用 \.nomedia 隔离/.test(all);
  note('用户可见日志', { saidClean, saidPending });
  assert(saidClean, '日志里必须说「相册已清空（回收 N 条记录…）」');
  assert(saidPending, '物理文件没删掉时必须如实说「另有 N 个物理文件未删除、待回收…」');

  // ---- ⑤ 第 2 条：紧接着走**跨条**这条路（rich「第一条发完第二条就卡住」的位置） ----
  //   第 1 条的批次目录不该被占住（占住的是老路径那条），所以 retire 必须把它
  //   **真回收掉**：删掉里面的文件、撤标记、连目录一起清。此前这一步只在假设备上跑过。
  const firstDir = first.r.remoteDir;
  const second = await runPrepare(2, '第2条');
  const dirAfter = await adb.shell(serial, 'if [ -d ' + quote(firstDir) + ' ]; then echo EXISTS; else echo MISSING; fi');
  note('第2条：上一批目录是否已被回收', { dir: firstDir, state: String(dirAfter.stdout || '').trim(),
    remotes: second.r.remotes });
  assert.strictEqual(String(dirAfter.stdout || '').trim(), 'MISSING',
    '跨条回收必须把上一个批次目录真的清掉（否则设备上会一直堆积、目录也永远隐藏）');
  assert(second.r.remotes.every(p => p.startsWith(second.r.remoteDir + '/')),
    '第 2 条必须落在它自己的新批次目录里');
  const secondRows = (await mediaRows()).filter(r => PROBE_RE.test(r.file));
  assert(secondRows.every(r => norm(r.file).startsWith(norm(second.r.remoteDir) + '/')),
    '第 2 条清完相册后，相册里只该有第 2 条自己的素材，实际：' + JSON.stringify(secondRows.map(r => r.file)));
  // 第 2 条的日志同样要如实（老路径那条物理文件这时**仍然**没删掉）。
  const secondAll = second.logs.join('\n');
  assert(/相册已清空（回收 \d+ 条记录，耗时 [\d.]+s）/.test(secondAll),
    '第 2 条也必须报「相册已清空（回收 N 条记录…）」');

  // ---- ⑥ 释放句柄 ⇒ 延后回收必须真删文件、真撤标记 ----
  await adb.shell(serial, 'for p in $(ps -A -o PID,ARGS 2>/dev/null | grep sleep | grep -v grep'
    + ' | awk "{print \\$1}"); do kill -9 $p 2>/dev/null; done; sleep 1; echo killed', { timeout: 12000 });
  await adb.clearAlbum(serial);
  const rmAfter = await adb.shell(serial, 'if [ -e ' + quote(PROBE) + ' ]; then echo EXISTS; else echo MISSING; fi');
  const nmAfter = await adb.shell(serial, '[ -f ' + quote(NM) + ' ] && echo EXISTS || echo MISSING');
  note('句柄释放后回收', { physical: String(rmAfter.stdout || '').trim(), nomedia: String(nmAfter.stdout || '').trim() });
  assert.strictEqual(String(rmAfter.stdout || '').trim(), 'MISSING', '句柄释放后物理文件必须真被删掉');
  assert.strictEqual(String(nmAfter.stdout || '').trim(), 'MISSING', '文件删光后 .nomedia 必须被撤掉');

  await cleanupProbe();
  console.log('结论 ' + JSON.stringify({ pass: true,
    note: '真机全链路：第1条（占用残留清理+推素材）→ 第2条（跨条回收上一批+清相册）→ '
      + '判据（四表为0且重扫不复活）→ 日志原文（相册已清空 + 另有N个待回收）→ 释放后真删+撤标记，全部通过' }));
})().catch(async e => {
  console.error('FAIL ' + (e && e.message));
  try { await cleanupProbe(); } catch (x) { console.error('清理探针失败：' + x.message); }
  process.exitCode = 1;
});
