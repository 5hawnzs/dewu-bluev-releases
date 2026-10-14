'use strict';
// 百条序列在假设备执行真实清理、推送与发布代码，不向线上发100条帖子。
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-sequence-'));
const load = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};
const dir = path.join(tmp, 'fakeadb'); fs.mkdirSync(dir);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(dir, file));
fs.writeFileSync(path.join(dir, 'IME_ACTIVE'), '1');
fs.writeFileSync(path.join(dir, 'FOCUS'), 'com.shizhuang.duapp/.modules.home.ui.HomeActivity');
require('child_process').execFile = require('./fakeadb/adb').makeFakeAdb(dir);
const store = require('../src/main/store');
const adb = require('../src/main/services/adb');
const publisher = require('../src/main/services/publisher');
const itemDir = path.join(tmp, '素材'); fs.mkdirSync(itemDir); fs.writeFileSync(path.join(itemDir, '1.jpg'), '测试文件');
store.set({ paths: { output: path.join(tmp, '输出') }, publish: { intervalSec: 0, device: 'FAKE', submissionWaitMs: 1000,
  uiMap: { package: 'com.shizhuang.duapp', steps: [{ name: '提交发布', action: 'tapText', value: '发布' }] } } });
const state = { items: [{ id: 'A', dir: itemDir, absDir: itemDir, files: [{ name: '1.jpg', type: 'image' }] }],
  copyRows: [{ id: 'A', title: '测试', body: '测试', topics: [] }], verify: { rows: [] },
  publish: { mode: 'adb', device: 'FAKE', rows: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, id: 'A', dir: 'A', goods: 1, result: '' })) } };
const clear = adb.clearAlbum;
let clears = 0;
adb.clearAlbum = async (...args) => { clears++; return clears === 50
  ? { ok: false, code: 'ALBUM_IO_INTERRUPTED', error: '测试清理中断' } : clear(...args); };
const ok = (label, value) => { assert(value, label); console.log('PASS ' + label); };
(async () => {
  const r = await publisher.run(state);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  ok('百条序列第50条清理中断，只该条失败，第51条清理后继续', clears === 100 && r.okCount === 99 && r.failCount === 1
    && r.rows[49].result === '失败' && r.rows[50].result === '发布成功' && r.rows[99].result === '发布成功');
  const pushes = calls.split('\n').filter(c => /\bpush /.test(c));
  ok('失败条目从未推素材，99条成功各推一次', pushes.length === 99);
  ok('百条复用相机目录，不创建逐条目录，不读取ls或递归find',
    pushes.every(c => c.includes('/sdcard/DCIM/Camera/1.jpg')) && !/ls -A |find .* -type f|DCIM\/Camera\/bluev/.test(calls));
  const indexed = await adb.albumMatches('FAKE', ['/sdcard/DCIM/Camera/1.jpg']);
  ok('百条结束后相册仅剩最后一条素材，不累积前99条', indexed.ok);
})().catch(e => { console.error(e); process.exitCode = 1; });
