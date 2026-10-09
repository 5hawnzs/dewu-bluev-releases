/* 专项验证：Excel 被占用 → 整批暂存 → 下次运行先补写（真机做法）+ 设备矩阵
   + 发布前拦停（用户 2026-10-04 口径：「电脑上开着那个 excel ⇒ 禁止发布，提示先关掉」）：
     ⑥ wp.probeWritable 三态（没有 / 正常 / 被占）—— assertExcelClosed 全靠这一个判据
     ⑦ 报告真被占着 → jobs.run('publish.run') 开跑前就拦、一条都不发；'publish.rerun' 同样拦
     ⑦c 反向对照：文件可写时不许拦（否则用户关着 Excel 也发不出去）
   ★ 判据为什么是「publisher.run 被调用了几次」：拦住的定义就是「根本没进发布器」，
     在 mock 通道下没有 adb 命令可数，所以用调用计数当证据（比数 input tap 更贴语义）。 */
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
const project = require(path.join(base, 'src/main/project.js'));
const jobs = require(path.join(base, 'src/main/jobs.js'));
const wp = require(path.join(base, 'src/main/util/winpath.js'));

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
  // 当前套件测发布/文案行为，显式准备品牌前置；配置仍只写测试临时目录。
  store.set({ brandsSeeded: true, brands: [{ id: 'brd_regression', name: '品牌甲', enabled: true,
    promptWrite: '请根据素材生成真实自然的种草文案。' }], paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
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

  // ---- ⑥ 发布前的「这个 Excel 现在能不能写」探测（wp.probeWritable） ----
  // ★ 为什么单独测它：assertExcelClosed 的拦/不拦 100% 由这一个返回值决定。
  //   它要是恒 busy（误拦）或恒不 busy（漏拦），那条防线就是摆设，而界面上看不出区别。
  const probeGone = await wp.probeWritable(path.join(TMP, '根本没有这份报告.xlsx'));
  ok('⑥ 文件不存在 ⇒ exists:false 且不算「被占用」（不误拦）',
    probeGone.exists === false && probeGone.busy === false, JSON.stringify(probeGone));

  const freeFile = path.join(TMP, '没人占用的报告.xlsx');
  fs.writeFileSync(freeFile, 'x');
  const probeFree = await wp.probeWritable(freeFile);
  ok('⑥ 正常文件 ⇒ 可写、不算占用',
    probeFree.exists === true && probeFree.writable === true && probeFree.busy === false, JSON.stringify(probeFree));

  const lockFile = path.join(TMP, '正被占用的报告.xlsx');
  fs.writeFileSync(lockFile, 'x');
  fs.chmodSync(lockFile, 0o444);             // 只读 = 别人不让写（与 ② 造占用同一种造法）
  const probeLocked = await wp.probeWritable(lockFile);
  ok('⑥ 被占着 ⇒ busy:true（这就是发布前拦停的判据）',
    probeLocked.exists === true && probeLocked.busy === true, JSON.stringify(probeLocked));
  fs.chmodSync(lockFile, 0o644);

  const probeEmpty = await wp.probeWritable('');
  ok('⑥ 没给路径 ⇒ 什么都不拦', probeEmpty.exists === false && probeEmpty.busy === false, JSON.stringify(probeEmpty));

  // ---- ⑦ 端到端：报告真被占着 ⇒ 发布必须在「开跑前」被拦，一条都不发 ----
  // 造一份「等着被发」的队列（jobs 会先看 rows 有没有，再查 Excel 占用与否）
  const busyReport = path.join(TMP, 'AI内容报告_正被打开着.xlsx');
  fs.writeFileSync(busyReport, 'x');

  const origRun = publisher.run;
  let runCalls = 0;
  publisher.run = async () => { runCalls++; return { rows: [], results: [], okCount: 0, total: 0, failCount: 0, batch: 'stub' }; };
  /**
   * ★ 每个子用例都重新摆一次现场（队列 + 占用开关 + 计数）。
   *
   * 为什么非重置不可（反向自证实测踩到）：⑦ 一旦放行，发布器返回的 `rows: []` 会被
   * `project.patch` 写回工程 ⇒ 队列被清空 ⇒ 紧跟着的 ⑦b 变成「找不到该行」而变红。
   * 那是**用例之间互相污染**，不是代码缺陷 —— 它会掩盖「破坏 A 只该让 ⑦ 红、⑦b 应保持绿」
   * 这个关键结论（两处各有一条独立防线）。
   */
  const arm = (locked) => {
    runCalls = 0;
    project.patch({
      publish: Object.assign({}, project.get().publish, {
        rows: [{ seq: 1, id: 'A+白+1', dir: 'A+白+1', status: '排队' }],
        reportFile: busyReport, reportSheet: 'AI 内容报告', batch: '发布前拦停用例'
      }),
      sheet: { file: '', rowCount: 1, colCount: 26, locked: false, exportedAt: 0 }
    });
    try { fs.chmodSync(busyReport, locked ? 0o444 : 0o644); } catch (e) { /* 占用开关造不出来就见下面的断言 */ }
  };

  try {
    arm(true);
    const blocked = await jobs.run('publish.run', {});
    ok('⑦ 报告被占着 ⇒ 发布被拦住（ok:false）', blocked.ok === false, JSON.stringify(blocked));
    ok('⑦ 拦住的原因说清「先关掉 Excel」并点名是哪个文件',
      /关掉 Excel/.test(String(blocked.error || '')) && /AI内容报告_正被打开着/.test(String(blocked.error || '')),
      blocked.error);
    ok('⑦ 一条都没发：根本没进发布器（publisher.run 调用 0 次）', runCalls === 0, 'runCalls=' + runCalls);

    // ⑦b 重跑同样要拦：重跑的结果也一样写不回报告，放过去就是又白跑一条
    arm(true);
    const rr = await jobs.run('publish.rerun', { seq: 1 });
    ok('⑦b 重跑也被拦住 + 没进发布器',
      rr.ok === false && /关掉 Excel/.test(String(rr.error || '')) && runCalls === 0,
      `ok=${rr.ok} runCalls=${runCalls} ${rr.error || ''}`);

    // ⑦c 反向对照：关掉 Excel（文件可写）⇒ **不许拦**
    //   没有这一条，一个「永远拦住」的实现也能让前面全绿（只测负向 = 假通过）。
    arm(false);
    const freed = await jobs.run('publish.run', {});
    ok('⑦c 反向对照：文件可写时不许拦（真进了发布器）', runCalls === 1, 'runCalls=' + runCalls);
    ok('⑦c 放行的那次没有被 Excel 这道关挡下来',
      !/关掉 Excel/.test(String((freed && freed.error) || '')), String((freed && freed.error) || '(无错)'));
  } finally {
    publisher.run = origRun;                       // 一定还原：后面的用例用的还是真发布器
    try { fs.chmodSync(busyReport, 0o644); } catch (e) { /* 清场失败不影响断言 */ }
  }


  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('ERROR', e); process.exitCode = 1; });
