'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-github-update-'));
const load = Module._load;
let activeJobs = [], installs = 0, spawnedArgs;
const updates = [];
Module._load = function(name, parent) {
  if (name === 'electron') return { app: { getPath: () => tmp, getVersion: () => '1.1.1', quit: () => { installs++; } }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_name, value) => updates.push(value) } }] } };
  if (name === './jobs' && /githubupdates/.test(parent?.filename || '')) return { list: () => activeJobs };
  if (name === 'child_process' && /githubupdates/.test(parent?.filename || '')) return { spawn: (_file, args, options) => {
    spawnedArgs = args; assert.equal(options.windowsHide, true);
    const child = new (require('events').EventEmitter)(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  } };
  return load.apply(this, arguments);
};
const updater = require('../src/main/githubupdates'), profiles = require('../src/main/promptprofiles'), store = require('../src/main/store'), security = require('../src/main/security');
const payload = Buffer.alloc(1000000, 65);
const manifest = { version: '1.1.1', build: updater.BUILD + 1, bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex'), url: `https://github.com/${updater.REPO}/releases/download/test/test.exe` };
let failNetwork = false, badPayload = false, feedReads = 0;
global.fetch = async url => {
  if (failNetwork) throw Error('ECONNRESET');
  if (String(url).includes('latest.json')) { feedReads++; return new Response(JSON.stringify(manifest)); }
  return new Response(badPayload ? Buffer.alloc(payload.length, 66) : payload);
};
(async () => {
  const timers = [], timeout = global.setTimeout, interval = global.setInterval;
  try {
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms, kind: 'timeout' }); return { unref() {} }; };
    global.setInterval = (fn, ms) => { timers.push({ fn, ms, kind: 'interval' }); return { unref() {} }; };
    updater.start(); updater.start();
  } finally { global.setTimeout = timeout; global.setInterval = interval; }
  assert.equal(timers.length, 2, '重复启动不能重复设置自动检查');
  assert.equal(timers[0].ms, 20000); assert.equal(timers[1].ms, 3600000);
  await timers[0].fn(); assert.equal(updater.status().status, 'available');
  failNetwork = true; await timers[1].fn(); assert.equal(updater.status().status, 'error');
  failNetwork = false; await timers[1].fn(); assert.equal(updater.status().status, 'available');
  assert.throws(() => updater.validate({ ...manifest, url: 'https://example.com/test.exe' }));
  assert.throws(() => updater.validate({ ...manifest, sha256: 'bad' }));
  assert.equal((await updater.check()).status, 'available');
  assert.equal((await updater.download()).status, 'downloaded');
  const reads = feedReads; await timers[1].fn();
  assert.equal(feedReads, reads); assert.equal(updater.status().status, 'downloaded', '定时检查不能覆盖重启按钮');
  assert.equal(installs, 0, '下载后不得自动安装');
  activeJobs = [{}]; assert.equal((await updater.install()).ok, false); activeJobs = [];
  const installed = await updater.install(); assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installs, 1); assert(spawnedArgs.includes('/S') && spawnedArgs.includes('--updated') && spawnedArgs.includes('--force-run'));
  assert(updates.some(s => s.status === 'verifying' && s.percent === 0));
  assert(updates.some(s => s.status === 'verifying' && s.percent > 0));
  assert(updates.some(s => s.status === 'installing' && /自动打开/.test(s.message)));
  assert(spawnedArgs.some(a => a.startsWith('/D=')));
  badPayload = true; assert.equal((await updater.download()).status, 'error'); badPayload = false;
  failNetwork = true; assert.equal((await updater.check()).status, 'error'); failNetwork = false;
  manifest.build = updater.BUILD; assert.equal((await updater.check()).status, 'current');
  const p = profiles.save('', { name: '我的自定义品牌', promptWrite: '这是本机提示词' });
  assert.equal(p.ok, true); assert.equal(profiles.list().length, 1);
  assert.equal((store.get('brands') || []).some(b => b.id === p.brand.id), false, '不能混入云端权限品牌');
  security.validateConfigPatch({ copy: { promptProfileId: p.brand.id } }, false);
  store.set({ copy: { promptProfileId: p.brand.id } }); assert.equal(profiles.selected().promptWrite, '这是本机提示词');
  assert.equal(profiles.save(p.brand.id, { name: '改名', promptWrite: '修改' }).ok, true);
  assert.equal(profiles.list().length, 1); assert.equal(profiles.selected().name, '改名');
  assert.equal(profiles.save('', { name: '' }).ok, false);
  store.flush();
  console.log('PASS GitHub 更新与本机提示词行为断言（同版构建更新、下载校验、断网、任务拦截、成员自定义）');
  console.log('PASS 每小时自动检查、断网后下次恢复、保留重启按钮、流式校验进度与安装启动反馈');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
