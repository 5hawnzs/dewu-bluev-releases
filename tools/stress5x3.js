'use strict';
/* 连续发布压力实测：**多轮 × 每轮连续发 N 条**（走生产代码 publisher.run）—— 目的只有一个：
   把「连续发布」到底卡在哪、卡几次，用可复算的数字量出来。2026-10-04 用它跑出「5 轮 × 3 条」
   的实测（13/15 成功，2 个卡点：好物搜索页没出来 / 提交被存成草稿）。

   与 tools/reallive.js 的区别（为什么单开一个）：
     ① 它**重复多轮**，每轮开始前把这几行的结果重置（否则 run() 会跳过「发布成功」的行）；
     ② 每轮**前后各量一次**「个人主页 动态=全部N / 草稿箱=有M篇动态待发布」——
        这是定下来的**唯一可靠判据**（跳屏不可信：点完发布落 DraftActivity 既可能是
        「存成草稿」也可能是「发布成功后的落点」，只有条数差说得清）。
     ③ 顺手把每一条的失败原因、以及那一轮里发布后前台的变化序列，按轮次记下来。

   用法：
     node tools/stress5x3.js --rounds=5 --rows=3                 # 5 轮，每轮连发队列前 3 条
     node tools/stress5x3.js --rounds=1 --offset=3 --rows=3      # 改用第 4~6 条（换一批内容）
     node tools/stress5x3.js --rounds=1 --rows=1                 # 冒烟（只发第一条）
     ★ 报告落 <用户数据目录>/输出/得物/5x3/stress_<tag>.json（不进仓库）。
   前置：模拟器在线、得物已登录停在首页、ADBKeyboard 是当前输入法。
*/
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const argNum = (k, d) => {
  const a = process.argv.find(x => x.startsWith('--' + k + '='));
  const n = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};
const ROUNDS = argNum('rounds', 5);
const ROWS = argNum('rows', 3);
// ★ 从队列的第几条开始取（默认 0 = 前 N 条）。换一批内容再测时用它，别改脚本。
const OFFSET = (() => {
  const a = process.argv.find(x => x.startsWith('--offset='));
  const n = a ? Number(a.split('=')[1]) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();
// ★ 用户口径是「**分 5 次**，每次连发 3 条」⇒ 建议 5 次独立调用（--rounds=1 各跑一次），
//   用 --tag=runN 把报告分开落盘，互不覆盖。
const TAG = (process.argv.find(a => a.startsWith('--tag=')) || '').slice(6) || 'run';
const USERDATA = 'C:/Users/Administrator/AppData/Roaming/dewu-bluev-publisher';
// ★ 报告落**用户数据目录**（不进仓库）：<userData>/输出/得物/5x3/stress_<tag>.json
const OUT_DIR = path.join(USERDATA, '输出', '得物', '5x3');
const REPORT_FILE = path.join(OUT_DIR, `stress_${TAG}.json`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return '__electron_stub__';
  return origResolve.call(this, request, ...rest);
};
const stub = {
  app: {
    getPath: () => USERDATA, getAppPath: () => ROOT, isPackaged: false,
    setAppUserModelId: () => {}, requestSingleInstanceLock: () => true,
    on: () => {}, whenReady: () => Promise.resolve(), quit: () => {},
  },
  BrowserWindow: function () { return { webContents: { send: () => {}, on: () => {} }, on: () => {}, loadFile: () => {}, isMinimized: () => false, restore: () => {}, focus: () => {}, flashFrame: () => {}, show: () => {}, hide: () => {} }; },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openExternal: () => {}, openPath: () => {} },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {} }; },
  Notification: function () { return { show: () => {} }; },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) },
};
require.cache['__electron_stub__'] = { id: '__electron_stub__', filename: '__electron_stub__', loaded: true, exports: stub };

const store = require(path.join(ROOT, 'src/main/store'));
const project = require(path.join(ROOT, 'src/main/project'));
const publisher = require(path.join(ROOT, 'src/main/services/publisher'));
const adb = require(path.join(ROOT, 'src/main/services/adb'));
const uimap = require(path.join(ROOT, 'src/main/services/uimap'));

// ★ 必须与生产用同一个 adb（原因见 reallive.js 顶部那段，踩过一次）
adb.setBundledAdbDir(path.join(ROOT, 'vendor', 'adb'));
store.load();
project.load();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const st = () => project.get();
const c = store.get('publish') || {};
const serial = (process.argv.find(a => a.startsWith('--serial=')) || '').slice(9)
  || store.get('publish.device') || c.device || '127.0.0.1:16384';

/* ---------------- 判据：数条数差 ---------------- */
/**
 * 读「个人主页」上的两个数：动态总数（`全部 N`）与草稿箱待发布数（`有 M 篇动态待发布`）。
 * 路径（真机实测）：底部「我」(945,1869) → 右上「主页」(1007,174) → dump。
 * ★ 读不到就如实 ok:false + why，**绝不拿 0 顶替**（未知 ≠ 0）。
 */
async function readCounts(tag) {
  const r = { tag, ok: false, dyn: null, draft: null, focus: '', why: '' };
  try {
    const g = await adb.ensureApp(serial, {
      pkg: uimap.DEWU.pkg, activity: uimap.DEWU.launchActivity,
      want: uimap.DEWU.homeActivity, judge: f => uimap.isHomeScreen(f), timeoutMs: 30000
    });
    if (!g.ok) { r.why = '回不到得物首页：' + (g.why || ''); return r; }
    await adb.tap(serial, 945, 1869); await sleep(2600);
    let f = String(await adb.currentFocus(serial) || '');
    if (!/PersonalActivity/.test(f)) { await adb.tap(serial, 945, 1869); await sleep(2600); }
    await adb.tap(serial, 1007, 174); await sleep(3600);
    f = String(await adb.currentFocus(serial) || '');
    r.focus = f;
    const xml0 = await adb.dump(serial, { pkg: uimap.DEWU.pkg });
    if (!xml0) { r.why = '个人主页 dump 不到结构'; return r; }
    const xml = adb.unxml(xml0);
    const d = /全部\s*(\d+)/.exec(xml);
    const m = /有\s*(\d+)\s*篇动态待发布/.exec(xml);
    if (!d) { r.why = '这一屏没读到「全部 N」' + (/PersonalActivity/.test(f) ? '' : `（当前前台 ${f || '读不到'}）`); return r; }
    r.dyn = Number(d[1]);
    r.draft = m ? Number(m[1]) : 0;
    r.ok = true;
  } catch (e) { r.why = (e && e.message) || String(e); }
  return r;
}

const fmt = r => r.ok
  ? `动态=${r.dyn} 草稿=${r.draft}`
  : `读不到（${r.why}）`;

(async () => {
  console.log(`adb = ${adb.getActiveAdb().path}（来源 ${adb.getActiveAdb().source}）`);
  console.log(`serial=${serial} | mode=${c.mode} | intervalSec=${c.intervalSec} | videoIntervalSec=${c.videoIntervalSec}`);

  const allRows = (st().publish && st().publish.rows) || [];
  if (!allRows.length) { console.error('★ 发布队列是空的：先导入 AI 内容报告'); process.exit(1); }
  const useRows = allRows.slice(OFFSET, OFFSET + ROWS);
  console.log(`=== 将连发 ${useRows.length} 条 × ${ROUNDS} 轮 ===`);
  useRows.forEach(r => console.log(`  seq${r.seq} ${r.id} | ${r.title || ''}`));

  await publisher.connect(serial);

  const report = { serial, rounds: [], startedAt: new Date().toISOString() };

  for (let rd = 1; rd <= ROUNDS; rd++) {
    console.log(`\n================= 第 ${rd}/${ROUNDS} 轮 ================`);
    // 每轮开始前重置这 3 行（否则 run() 会跳过上一轮「发布成功」的行，就不是「连续发 3 条」了）
    useRows.forEach(r => { r.status = '排队'; r.result = ''; r.reason = ''; r.startAt = ''; r.elapsed = 0; });

    const before = await readCounts(`R${rd}-before`);
    console.log(`第${rd}轮 发布前：${fmt(before)}`);

    // ★ 2026-10-05：给每行日志打上「距本轮开始的相对时间」——
    //   这样才能把「一次 100s 花在哪」做出一条**真时间轴**（原来只有 end-to-end 的 elapsed，
    //   分不清是起手清相册慢、还是逐步抓屏慢）。`--timestamps` 只为可读性加前缀，数据一直记。
    const t0row = Date.now();
    const logs = [];
    const log = (m, lv) => {
      const dt = ((Date.now() - t0row) / 1000).toFixed(1);
      const line = `[+${String(dt).padStart(6)}s][${lv || 'info'}] ${m}`;
      console.log(line);
      logs.push(line);
    };
    // ★ 分步计时本来是 publisher 采好的（ctx.stepTiming），但驱动一直没落盘 ⇒ 顺手存下来。
    const stepTiming = [];
    const runState = {
      items: (st().items || []).filter(it => useRows.some(r => r.id === it.id)),
      copyRows: (st().copyRows || []).filter(cr => useRows.some(r => r.id === cr.id)),
      verify: { rows: [] },
      publish: Object.assign({}, st().publish, {
        device: serial, mode: 'adb',
        // ★ 必须显式给 config 里的定位表：project.publish.uiMap 是空的（0 步），
        //   而 run() 的取值是 `state.publish.uiMap || c.uiMap` ⇒ 空的也会被当成「有」。
        uiMap: c.uiMap,
        rows: useRows,
        batch: `5x3实测-R${rd}-${Date.now().toString(36)}`,
      }),
    };

    const t0 = Date.now();
    let res = null;
    try {
      res = await publisher.run(runState, {
        log, stepTiming,
        progress: () => {},
        onRow: (r) => { if (r.result) console.log(`  → seq${r.seq} ${r.dir} : ${r.result} ${r.reason ? '(' + String(r.reason).slice(0, 100) + ')' : ''}`); },
        cancelled: () => false,
        actor: { username: 'admin', displayName: '5x3实测' },
        brand: { brandId: (st().publish && st().publish.brandId) || 'test', brandName: (st().publish && st().publish.brandName) || '5x3实测' },
      });
    } catch (e) {
      console.error('★ 整批抛异常:', (e && e.message) || e);
      logs.push('★ 整批抛异常: ' + ((e && e.message) || e));
    }
    const secs = +((Date.now() - t0) / 1000).toFixed(1);

    const after = await readCounts(`R${rd}-after`);
    await sleep(1500);
    console.log(`第${rd}轮 发布后：${fmt(after)}（本轮耗时 ${secs}s）`);

    const dd = (after.ok && before.ok) ? (after.dyn - before.dyn) : null;
    const dm = (after.ok && before.ok) ? (after.draft - before.draft) : null;
    console.log(`第${rd}轮 Δ：动态 ${dd === null ? '读不到' : (dd >= 0 ? '+' : '') + dd}`
      + ` / 草稿 ${dm === null ? '读不到' : (dm >= 0 ? '+' : '') + dm}`);

    report.rounds.push({
      round: rd, secs, before, after, deltaDyn: dd, deltaDraft: dm,
      rows: useRows.map(r => ({ seq: r.seq, id: r.id, title: r.title, result: r.result, reason: r.reason, elapsed: r.elapsed })),
      okCount: res ? res.okCount : null,
      stepTiming, logs,
    });

    try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) { /* 已存在即可 */ }
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`（本轮结果已写入 ${path.basename(REPORT_FILE)}）`);
  }

  // ---- 汇总 ----
  console.log('\n================= 汇总 =================');
  let totOk = 0, totFail = 0;
  for (const R of report.rounds) {
    const ok = R.rows.filter(r => r.result === '发布成功').length;
    const bad = R.rows.filter(r => r.result && r.result !== '发布成功').length;
    totOk += ok; totFail += bad;
    console.log(`第${R.round}轮：成功 ${ok} / 失败 ${bad} / 共 ${R.rows.length}`
      + ` | Δ动态 ${R.deltaDyn === null ? '?' : R.deltaDyn} / Δ草稿 ${R.deltaDraft === null ? '?' : R.deltaDraft}`
      + ` | ${R.secs}s`);
    R.rows.forEach(r => console.log(`    seq${r.seq} ${r.result || '(未跑)'} ${String(r.reason || '').slice(0, 90)}`));
  }
  console.log(`\n合计：发布成功 ${totOk} 条 / 失败 ${totFail} 条`);
  console.log('报告已落：' + REPORT_FILE);
  process.exit(0);
})().catch(e => { console.error('★ 失败:', (e && e.stack) || e); process.exit(1); });
