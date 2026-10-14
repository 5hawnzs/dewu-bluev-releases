'use strict';
// 使用真实发布入口；仅在设备进程这一外部 seam 注入取消，复现推送途中停止。
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-albumready-'));
const load = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};
const dir = path.join(tmp, 'fakeadb'); fs.mkdirSync(dir);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(dir, file));
fs.writeFileSync(path.join(dir, 'IME_ACTIVE'), '1');
fs.writeFileSync(path.join(dir, 'FOCUS'), 'com.shizhuang.duapp/.modules.home.ui.HomeActivity');
const fakeAdb = require('./fakeadb/adb').makeFakeAdb(dir);
let cancelled = false, cancelOnPush = false;
require('child_process').execFile = function(bin, args, options, callback) {
  return fakeAdb(bin, args, options, (error, stdout, stderr) => {
    if (cancelOnPush && args.includes('push')) cancelled = true;
    callback(error, stdout, stderr);
  });
};
const store = require('../src/main/store'), publisher = require('../src/main/services/publisher');
const itemDir = path.join(tmp, '素材'); fs.mkdirSync(itemDir);
for (const name of ['1.jpg', '2.jpg']) fs.writeFileSync(path.join(itemDir, name), '测试文件');
store.set({ paths: { output: path.join(tmp, '输出') }, publish: { intervalSec: 0, device: 'FAKE', submissionWaitMs: 1000,
  uiMap: { package: 'com.shizhuang.duapp', steps: [{ name: '提交发布', action: 'tapText', value: '发布' }] } } });
const state = () => ({ items: [{ id: 'A', dir: itemDir, absDir: itemDir, files: ['1.jpg','2.jpg'].map(name => ({name, type:'image'})) }],
  copyRows: [{id:'A',title:'测试',body:'测试',topics:[]}], verify:{rows:[]},
  publish:{mode:'adb',device:'FAKE',rows:[{seq:1,id:'A',dir:'A',goods:1,result:''}]} });
const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
const ok = (label, value) => { assert(value, label); console.log('PASS ' + label); };
(async () => {
  const start = performance.now();
  const normal = await publisher.run(state());
  const trace = calls();
  ok('两张图就绪后只提交一条，继续复用相机目录', normal.okCount === 1 && normal.failCount === 0
    && trace.filter(c => /\bpush /.test(c)).length === 2
    && !trace.some(c => /ls -A |find .* -type f|DCIM\/Camera\/bluev/.test(c)));
  const beforePush = trace.slice(0, trace.findIndex(c => /\bpush /.test(c)));
  ok('正常每条只执行一次全盘重扫清理，并在推送之前完成',
    beforePush.filter(c => /--method scan_volume/.test(c)).length === 1
    && trace.filter(c => /--method scan_volume/.test(c)).length === 1);
  console.log('METRIC ' + JSON.stringify({ commands: trace.length, elapsedMs: Math.round(performance.now() - start) }));
  const before = trace.length;
  cancelOnPush = true;
  const stopped = await publisher.run(state(), { cancelled: () => cancelled });
  const tail = calls().slice(before);
  const afterPush = tail.slice(tail.findIndex(c => /\bpush /.test(c)) + 1);
  ok('第一张推送期间取消后不再推第二张、不索引、不提交', stopped.cancelled
    && tail.filter(c => /\bpush /.test(c)).length === 1
    && !afterPush.some(c => /content call |input tap /.test(c)));
  cancelled = false; cancelOnPush = false;
  const nextStart = calls().length;
  const atProgress = await publisher.run(state(), { cancelled: () => cancelled,
    onRow: row => { if (row.status === '推送素材 1/2') cancelled = true; } });
  ok('进度回调中取消后，第一张也不能继续推送', atProgress.cancelled
    && !calls().slice(nextStart).some(c => /\bpush /.test(c)));
})().catch(e => { console.error(e); process.exitCode = 1; });
