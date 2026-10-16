'use strict';
// 从 jobs.run 观察任务结果与界面日志；真实发布器执行到设备前置检查，不接触真实设备。
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-publish-job-'));
process.env.BLUEV_LOCAL_AUTH = '1';
process.env.BLUEV_ADMIN_USER = 'testadmin';
process.env.BLUEV_ADMIN_PASS = 'Isolated-test-2026!';
const messages = [];
const window = { isDestroyed: () => false, setProgressBar() {}, webContents: { send(channel, payload) { messages.push({ channel, payload }); } } };
const requests = new Set(); let sequence = 0;
const electron = {
  app: { getPath: () => tmp, getVersion: () => '1.1.2', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [window] }, Notification: { isSupported: () => false },
  powerSaveBlocker: { start() { const id = ++sequence; requests.add(id); return id; }, isStarted: id => requests.has(id), stop: id => requests.delete(id) }
};
const load = Module._load;
Module._load = function(name) { return name === 'electron' ? electron : load.apply(this, arguments); };
// 只替换操作系统进程执行 adapter，保留 jobs、权限、发布器的真实 implementation。
require('child_process').execFile = function(file, args, options, callback) {
  if (typeof options === 'function') callback = options;
  const error = Object.assign(new Error('测试设备离线'), { code: 1 });
  process.nextTick(() => callback(error, '', '测试设备离线'));
  return { kill() {} };
};
const store = require('../src/main/store');
const auth = require('../src/main/auth');
const brands = require('../src/main/brands');
const project = require('../src/main/project');
const jobs = require('../src/main/jobs');
require('../src/main/logbus').attach(window);

(async () => {
  assert.equal((await auth.login('testadmin', process.env.BLUEV_ADMIN_PASS, false)).ok, true);
  const brand = brands.add({ name: '入口测试品牌' }).brand;
  assert.equal(auth.createUser({ username: 'shuo', password: 'Isolated-member-2026!', role: 'user', brands: [brand.id] }).ok, true);
  assert.equal((await auth.login('shuo', 'Isolated-member-2026!', false)).ok, true);
  store.set({ publish: { uiMap: { steps: [{ name: '主页', action: 'tapId', value: 'com.shizhuang.duapp:id/tvGoHomePage' }] } } });
  project.patch({ publish: { mode: 'adb', device: 'TEST-OFFLINE', rows: [{ id: 'test', seq: 1, dir: '测试素材', result: '' }] } });
  const result = await jobs.run('publish.fallbackTest', { brandId: brand.id });
  assert.match(result.error || '', /设备缺少可用的内置中文输入法/, '试发应进入真实发布器并如实报告设备前置失败');
  assert(messages.some(m => m.channel === 'log:entry' && /强制备用入口/.test(m.payload.msg)), '试发应启用强制备用入口');
  assert.equal(jobs.busy('publish.fallbackTest'), false, '失败后释放任务');
  assert.equal(requests.size, 0, '失败后释放防睡眠请求');
  console.log('PASS 备用试发进入共用发布流程并启用备用入口，设备不可用时如实失败并释放任务');
  messages.length = 0;
  // 即使工程里残留试发标记，正式任务也必须自行选择入口。
  project.patch({ publish: { ...project.get().publish, forceAlternateEntry: true } });
  const normal = await jobs.run('publish.run', { brandId: brand.id });
  assert.match(normal.error || '', /设备缺少可用的内置中文输入法/);
  assert(!messages.some(m => m.channel === 'log:entry' && /强制备用入口/.test(m.payload.msg)), '正式发布不能被强制改走备用');
  assert.equal(jobs.busy('publish.run'), false);
  console.log('PASS 正式发布沿用正常入口选择，不受残留试发标记影响');
})().catch(error => { console.error(error); process.exitCode = 1; });
