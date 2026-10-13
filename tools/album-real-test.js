'use strict';
// 仅人工显式调用；会清空指定测试模拟器的相册，不加入自动回归。
const fs = require('fs'), path = require('path'), assert = require('assert');
const adb = require('../src/main/services/adb');
const { PNG } = require('pngjs');
async function main() {
  const serial = process.argv[2];
  if (!serial || !process.argv.includes('--clear-test-device')) throw Error('需指定测试设备并显式传入 --clear-test-device');
  adb.setBundledAdbDir(path.resolve('vendor/adb'));
  const out = path.resolve('.local-album-1302'); fs.mkdirSync(out, { recursive: true });
  const image = new PNG({ width: 60, height: 60 }); image.data.fill(180);
  fs.writeFileSync(path.join(out, 'fixture.png'), PNG.sync.write(image));
  const fixture = path.join(out, 'fixture.png');
  const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
  const summary = [];
  const fixtures = ['/sdcard/DCIM/Camera/bluev-audit.png', '/sdcard/Movies/中文 空格.png',
    "/sdcard/Pictures/bluev-audit'quote.png"];
  // 这两个设备副本已与本地保留原件逐字节核对 SHA-256；遇到任何其他文件立即停止。
  const allowed = new Set([...fixtures, '/sdcard/DCIM/Camera/bluev-cover-test.mp4',
    '/sdcard/DCIM/Camera/bluev/326113200701-1.mp4', '/sdcard/DCIM/Camera/0_326113200701-1.mp4',
    '/sdcard/DCIM/Camera/326113200701-1.mp4'].map(adb.toMediaPath));
  async function ensureOnlyFixtures() {
    const disk = await adb.shell(serial, 'find /sdcard/DCIM/Camera -type f'); assert(disk.ok);
    for (const file of String(disk.stdout).trim().split(/\r?\n/).filter(Boolean)) assert(allowed.has(adb.toMediaPath(file)), '发现非测试文件，停止清理：' + file);
    for (const table of ['images', 'video', 'audio', 'files']) {
      const q = await adb.queryMediaTable(serial, table); assert(!q.error, q.error);
      for (const m of String(q.result.stdout).matchAll(/_data=(.*?)\r?$/gm)) assert(allowed.has(adb.toMediaPath(m[1])), '发现非测试媒体，停止清理');
    }
  }
  await ensureOnlyFixtures();
  await adb.forceStop(serial, 'com.shizhuang.duapp');
  for (let round = 1; round <= 4; round++) {
    const files = fixtures;
    for (const file of files) {
      assert((await adb.shell(serial, 'mkdir -p ' + quote(path.posix.dirname(file)))).ok);
      assert((await adb.push(serial, fixture, file)).ok);
    }
    const indexed = round % 2 === 0;
    if (indexed) assert((await adb.mediaScan(serial, '')).ok);
    await ensureOnlyFixtures();
    const before = [];
    for (const table of ['images', 'video', 'audio', 'files']) {
      const q = await adb.queryMediaTable(serial, table); assert(!q.error, q.error); before.push(q.result.stdout);
    }
    if (indexed) assert(files.every(file => before.join('\n').includes(adb.toMediaPath(file))));
    const started = Date.now();
    const opts = { forceStopPkg: 'com.shizhuang.duapp', deadline: Date.now() + 90000 };
    const all = await adb.clearAlbum(serial, opts); assert(all.ok, all.error);
    const populatedMs = Date.now() - started;
    for (const file of files) {
      const r = await adb.shell(serial, '[ ! -f ' + quote(file) + ' ]'); assert(r.ok, '物理文件仍存在：' + file);
    }
    assert((await adb.mediaScan(serial, '')).ok);
    await ensureOnlyFixtures();
    const rescanned = await adb.clearAlbum(serial, opts); assert(rescanned.ok && rescanned.removed === 0, '扫描后素材复活');
    const emptyStart = Date.now();
    const empty = await adb.clearAlbum(serial, opts); assert(empty.ok && empty.removed === 0, empty.error);
    const result = { round, indexed, populatedMs, emptyMs: Date.now() - emptyStart, removed: all.removed,
      physicalMissing: true, rescanRevived: false, emptyOk: true };
    summary.push(result); console.log(JSON.stringify(result));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 2));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
