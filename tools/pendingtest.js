/* 专项验证：Excel 被占用 → 整批暂存 → 下次运行先补写（真机做法）+ 设备矩阵 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-pend-'));
const fake = {
  app: { getPath: () => TMP, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {},
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  Notification: { isSupported: () => false }, screen: {},
  contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'electron') return fake; return origLoad.apply(this, arguments); };

// 工程根目录 = 本文件上一级；不写死绝对路径，换机器/换目录也能跑
const base = path.resolve(__dirname, '..');
const store = require(path.join(base, 'src/main/store.js'));
const sheet = require(path.join(base, 'src/main/services/sheet.js'));
const publisher = require(path.join(base, 'src/main/services/publisher.js'));

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

const state = {
  items: [
    { id: 'A+白+1', dir: 'A+白+1', sku: 'A', color: '白', files: [{ name: '1.jpg', type: 'image' }] },
    { id: 'B+黑+1', dir: 'B+黑+1', sku: 'B', color: '黑', files: [{ name: '1.jpg', type: 'image' }] }
  ],
  copyRows: [{ id: 'A+白+1', title: '白色的鞋谁懂', body: '正文', topics: ['#品牌甲'] }, { id: 'B+黑+1', title: '黑色百搭', body: '正文', topics: ['#品牌甲'] }],
  verify: { rows: [{ id: 'A+白+1', pass: true, conclusion: '颜色匹配' }, { id: 'B+黑+1', pass: true, conclusion: '颜色匹配' }] }
};

(async () => {
  store.set({ paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    publish: { devices: [], device: '', intervalSec: 60 } });

  // ① 正常导出 + 回写
  const sh = await sheet.exportSheet(state, { intervalSec: 60 });
  const r1 = await sheet.mergeResults(sh.file, [
    { seq: 1, at: '15:34:41', result: '发布成功', reason: '', retries: 0 },
    { seq: 2, at: '15:36:18', result: '失败', reason: '找不到发布按钮', retries: 1 }
  ]);
  ok('① 正常回写', r1.updated === 2 && !r1.busy, JSON.stringify(r1));

  // ② 模拟被 WPS 打开占用：文件设为只读，写入会失败 → 整批暂存
  fs.chmodSync(sh.file, 0o444);
  const r2 = await sheet.mergeResults(sh.file, [{ seq: 1, at: '15:40:00', result: '发布成功', reason: '', retries: 0 }]);
  ok('② Excel 被占用时整批暂存', r2.busy === true && r2.pending === 1, JSON.stringify(r2));
  ok('② 暂存文件已落盘', sheet.pendingCount() === 1, 'pending=' + sheet.pendingCount());

  // ③ 恢复可写后，下次运行先补写上次的
  fs.chmodSync(sh.file, 0o644);
  const r3 = await sheet.mergeResults(sh.file, []);
  ok('③ 下次运行补写暂存结果', r3.flushed === 1 && r3.updated >= 1 && r3.pending === 0, JSON.stringify(r3));
  ok('③ 暂存队列已清空', sheet.pendingCount() === 0);

  // ④ 设备矩阵（一个设备 = 一个账号）
  const d1 = publisher.addDevice({ name: '账号甲', serial: 'emulator-5554' });
  publisher.addDevice({ name: '账号乙', serial: 'emulator-5556' });
  ok('④ 添加设备', publisher.devices().length === 2, JSON.stringify(publisher.devices()));
  let dup = '';
  try { publisher.addDevice({ name: '重复', serial: 'emulator-5554' }); } catch (e) { dup = e.message; }
  ok('④ 重复设备被拒', /已存在/.test(dup), dup);
  const left = publisher.removeDevice(d1.id);
  ok('④ 删除设备', left.length === 1 && left[0].serial === 'emulator-5556', JSON.stringify(left));

  // ⑤ 固定间隔与预估（真实节奏：60s 间隔 + 单条 ≈30s）
  store.set({ publish: { intervalSec: 60 } });
  const est = publisher.estimate(100);
  ok('⑤ 固定 60s 间隔预估（100 条 = 150 分钟）', est.minutes === 150, est.minutes + ' 分钟');

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('ERROR', e); process.exitCode = 1; });
