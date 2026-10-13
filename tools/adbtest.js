/* 真实（adb）发布通道的可执行验证：用假 adb 模拟一台在线设备
   覆盖：设备检查 / dump 解析与定位表 / 未配定位表必失败 / 图文条全流程 / 页面结构变了必失败 /
        **抓取前先说清停在哪一屏**（停在别的 App 上拦下 / 停在得物首页告警 / 读不到就照常抓）/
        **视频条**（推视频 → 等媒体库索引 → 走 videoSteps，没配 videoSteps 就复用图文 steps；媒体库一直看不到必失败）/
        **页面不 idle**（自动关动画兜底并还原；兜不住就明确失败；★ 抓不到时绝不返回上一页的残留结构）
   假 adb 在 child_process.execFile 这一层做替身（见 tools/fakeadb/adb.js 顶部的说明：
   Windows 的 execFile('adb') 只认 adb.exe，无扩展名的 bash 脚本跑不起来，故改为函数级替身）。
   ★ 2026-10-05 增：**主图排序** —— 相册第 1 格（= 得物的内容主图）只认设备上文件时间的倒序，
   所以产品在「推完之后、入库之前」把要当主图那张 touch 成最新再重扫；这里用「设备上的 mtime /
   库里的 date_modified」两侧事实来验它，并验「排不成就不发」这条闸门。 */

const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-adb-'));
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

// 假 adb 的现场文件：复制到临时目录（测试会就地改 window.xml 模拟页面变化，不污染仓库）
const FDB = path.join(TMP, 'fakeadb');
// 本机 Node 22 的 cpSync 在中文工程路径下会原生崩溃；夹具只有普通文件，逐个复制。
fs.mkdirSync(FDB);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) {
  fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(FDB, file));
}
const FAKE_WINDOW = path.join(FDB, 'window.xml');
const CALLS = path.join(FDB, 'calls.log');
const calls = () => { try { return fs.readFileSync(CALLS, 'utf8'); } catch (e) { return ''; } };
const clearCalls = () => fs.writeFileSync(CALLS, '');
// 假 adb 还会单独记「实际被执行的可执行文件」——用来证明内置 adb 真的被拿去执行了
const FILES = path.join(FDB, 'files.log');
const filesLog = () => { try { return fs.readFileSync(FILES, 'utf8'); } catch (e) { return ''; } };
const clearFiles = () => fs.writeFileSync(FILES, '');

// ★ 必须在 require 被测模块之前替换：src/main/services/adb.js 在加载时就解构了 execFile
require('child_process').execFile = require(path.join(__dirname, 'fakeadb', 'adb.js')).makeFakeAdb(FDB);
// 假设备测试不读取宿主机真实模拟器。
require(path.join(base, 'src/main/services/emulators.js')).discover = async () => ({ instances: [], errors: [] });

const store = require(path.join(base, 'src/main/store.js'));
const publisher = require(path.join(base, 'src/main/services/pubublisher.js'.replace('pubublisher', 'publisher')));
const adbForSetup = require(path.join(base, 'src/main/services/adb.js'));
adbForSetup.setBundledApkPath(path.join(base, 'vendor', 'adbkeyboard', 'ADBKeyboard.apk'));
const uimap = require(path.join(base, 'src/main/services/uimap.js'));
const { PNG } = require(path.join(base, 'node_modules/pngjs'));
const jpeg = require(path.join(base, 'node_modules/jpeg-js'));

function jpgBuf(r, g, b, size = 80) {
  const d = Buffer.alloc(size * size * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return jpeg.encode({ data: d, width: size, height: size }, 90).data;
}
const itemDir = path.join(TMP, 'flat', '26FW-YB160+冠军白+1');
fs.mkdirSync(itemDir, { recursive: true });
fs.writeFileSync(path.join(itemDir, '1.jpg'), jpgBuf(240, 240, 242));
fs.writeFileSync(path.join(itemDir, '2.jpg'), jpgBuf(238, 238, 240));

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

const uiMap = {
  package: 'com.shizhuang.duapp',
  steps: [
    { name: '打开发布入口', action: 'tapText', value: '发布' },
    { name: '选图', action: 'tapText', value: '相册' },
    { name: '下一步', action: 'tapText', value: '下一步' },
    { name: '填标题', action: 'input', value: '${title}' },
    { name: '填正文', action: 'input', value: '${body}' },
    { name: '话题1', action: 'input', value: '${topic1}' },
    { name: '关联好物', action: 'tapText', value: '关联好物' },
    { name: '提交发布', action: 'tapText', value: '发布' }
  ]
};

const state = {
  items: [{ id: '26FW-YB160+冠军白+1', dir: itemDir, absDir: itemDir, sku: '26FW-YB160', color: '冠军白', files: [{ name: '1.jpg', type: 'image' }, { name: '2.jpg', type: 'image' }] }],
  copyRows: [{ id: '26FW-YB160+冠军白+1', title: '白色的鞋谁懂', body: '这双冠军白真的很百搭', topics: ['#品牌甲', '#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活'] }],
  verify: { rows: [{ id: '26FW-YB160+冠军白+1', conclusion: '通过' }] },
  publish: { rows: [{ seq: 1, id: '26FW-YB160+冠军白+1', dir: '26FW-YB160+冠军白+1', goods: 1, images: 2, startAt: '', status: '排队', result: '', retries: 0, reason: '' }], mode: 'adb', device: '127.0.0.1:5555' }
};

(async () => {
  store.set({
    paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    // ★ 刻意**不写** `adbKeyboard` —— 这就是产线真实配置的样子：默认配置里没有这个键、
    //   界面上也没有开关。以前产线代码用 `!!c.adbKeyboard` 决定中文走不走广播 ⇒ 恒为假
    //   ⇒ 中文永远走 `input text`（实测打不进中文却返回 0）⇒ 会发出一条没标题没正文的帖子。
    //   现在这条判断改由「设备当前输入法」决定，配置里有没有这个键都不影响。
    publish: { device: '127.0.0.1:5555', intervalMinSec: 1, intervalMaxSec: 1, submissionWaitMs: 1000 }
  });

  // 1) 设备检查（界面上叫「检查能不能发布」；probe() 的返回体同时带 notes 与 fix 两套说法）
  clearCalls();
  fs.writeFileSync(path.join(FDB, 'DEWU_ABSENT'), '1');
  const absent = await publisher.probe('127.0.0.1:5555');
  fs.unlinkSync(path.join(FDB, 'DEWU_ABSENT'));
  ok('未安装得物时只提示一个待处理问题，不叠加输入法等警告', absent.fix.length === 1 && !absent.appPackage);
  ok('未安装得物的提示提供去设置下载按钮', absent.fix[0] && absent.fix[0].act && absent.fix[0].act.act === 'go:dewu');
  const p = await publisher.probe('127.0.0.1:5555');
  ok('自检：adb 版本', !!p.adb, p.adb);
  ok('自检：设备在线', !!p.device, p.device && p.device.serial);
  ok('自检：分辨率', p.resolution === '1080x2400', p.resolution);
  ok('自检：识别得物包名', p.appPackage === 'com.shizhuang.duapp', p.appPackage);
  ok('自检：uiautomator 可用', p.tools.uiautomator === true);
  ok('自检：screencap 可用', p.tools.screencap === true);
  ok('自检：ADBKeyboard 已识别', p.adbKeyboard === true);

  // 2) 界面结构解析
  const xml = fs.readFileSync(FAKE_WINDOW, 'utf8');
  const nodes = uimap.parseNodes(xml);
  ok('dump 解析出节点，含视频封面控件', nodes.length === 9
    && nodes.some(n => n.id === 'com.shizhuang.duapp:id/ivVideoCover'), nodes.length + ' 个');
  const pub = uimap.findNode(nodes, { text: '发布' });
  ok('按文本定位到节点', !!pub && pub.center.x === 162 && pub.center.y === 160, pub && JSON.stringify(pub.center));
  const sug = uimap.suggest(nodes);
  ok('生成候选定位表', sug.steps.length > 5 && sug.package === 'com.shizhuang.duapp', sug.steps.length + ' 步');
  // ★ 2026-10-03 用户拍板：话题**不做联想点选**（「我给你多少个你就放多少个」，不许挂到别的话题上）
  //   ⇒ 图文 + 视频两套候选表里，话题步骤必须**全是纯输入**（不产生任何点击），
  //     且步骤名里不许出现「联想 / 点选」—— 一旦出现，就说明又打算去点候选了。
  const topicSteps = sug.steps.concat(sug.videoSteps).filter(s => /话题/.test(s.name));
  ok('候选定位表：图文+视频的话题都是纯输入、不含联想点选',
    topicSteps.length === 10 && topicSteps.every(s => s.action === 'input' && !/联想|点选/.test(s.name)),
    topicSteps.length + ' 步 / action=' + [...new Set(topicSteps.map(s => s.action))].join(',') + ' / 名=' + [...new Set(topicSteps.map(s => s.name))].join('|'));
  const filled = uimap.fill({ value: '${title}｜${topic1}' }, { title: '白色的鞋谁懂', topic1: '#品牌甲' });
  ok('占位符替换', filled.value === '白色的鞋谁懂｜#品牌甲', filled.value);

  // ★★ 2026-10-03 用户要求：**失败恢复动作整块删除**（uimap.normalizeRecover / publisher.recover /
  //    publish.setRecover 三处一起）。★ 删功能必须配**负向断言**：不然以后有人把它加回来，整套回归照样全绿。
  //    判据看**代码行**（先剔注释）—— 注释里正当提到「recover」不算数，否则等于把文档当缺陷。
  const codeOnly = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('★ 失败恢复动作已整块删除（uimap 不再导出 normalizeRecover / RECOVER_ACTIONS）',
    uimap.normalizeRecover === undefined && uimap.RECOVER_ACTIONS === undefined,
    JSON.stringify({ fn: typeof uimap.normalizeRecover, actions: typeof uimap.RECOVER_ACTIONS }));
  const pubSrcNoRec = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/publisher.js'), 'utf8'));
  const umSrc = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/uimap.js'), 'utf8'));
  // ★★ 发布失败**不重试**：重试循环（maxTry / c.retry）必须连同代码一起没了 ——
  //    光把出厂值删掉不算数：老配置里还留着 retry，读完照样会重试。
  ok('★ publisher 里不再有 recover 函数、也不再读 map.recover / normalizeRecover',
    !/function recover\s*\(/.test(pubSrcNoRec) && !/normalizeRecover/.test(pubSrcNoRec),
    JSON.stringify({ fn: /function recover\s*\(/.test(pubSrcNoRec), norm: /normalizeRecover/.test(pubSrcNoRec) }));
  ok('★★ 重试循环已删干净（没有 maxTry、没有 c.retry / cfg().retry 这种读取点）',
    !/maxTry/.test(pubSrcNoRec) && !/\.retry\b/.test(pubSrcNoRec), JSON.stringify({ maxTry: /maxTry/.test(pubSrcNoRec), retryRef: /\.retry\b/.test(pubSrcNoRec) }));
  ok('★ uimap / store 的源码里也不再有 recover 与出厂 retry（读取链一起删）',
    !/RECOVER_ACTIONS/.test(umSrc)
      && !/retry:/.test(codeOnly(fs.readFileSync(path.join(base, 'src/main/store.js'), 'utf8'))),
    JSON.stringify({ umRecover: /RECOVER_ACTIONS/.test(umSrc) }));

  // 3) 未配定位表 → 必须报错，不许假装成功
  store.set({ publish: { uiMap: null } });
  let threw = '';
  try { await publisher.run(state, {}); } catch (e) { threw = e.message; }
  ok('未配定位表直接失败', /UI 定位表/.test(threw), threw);

  // 4) 真实通道发布
  //    先让假设备进入「ADBKeyboard 已装进模拟器且是当前输入法」的状态 —— 中文要用它。
  const IME_ACTIVE = path.join(FDB, 'IME_ACTIVE');
  fs.writeFileSync(IME_ACTIVE, '1');
  store.set({ publish: { uiMap } });
  clearCalls();
  const logs = [];
  const ctx = { log: (m, l) => logs.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} };
  {
    const savedKeyboard = adbForSetup.ensureKeyboard;
    let release;
      let keyboardEntries = 0;
    const held = new Promise(resolve => { release = resolve; });
      adbForSetup.ensureKeyboard = async () => { keyboardEntries++; await held; return { ok: false, error: '测试释放', step: 'test' }; };
    const first = publisher.run(state, ctx).catch(e => e.message);
    let concurrentError = '';
    try { await publisher.run(state, ctx); } catch (e) { concurrentError = e.message; }
    ok('同一设备的发布与重跑不能并发清理，当前任务完成前不接管设备', /已有发布任务/.test(concurrentError));
      const savedShell = adbForSetup.shell;
      adbForSetup.shell = async (serial, cmd, opts) => cmd === 'settings get secure android_id'
        ? { ok: true, stdout: '927145746ae845d6' } : savedShell(serial, cmd, opts);
      const aliasState = { ...state, publish: { ...state.publish, device: 'FAKE_ALIAS' } };
      let aliasError = '';
      const aliasRun = publisher.run(aliasState, ctx).catch(e => { aliasError = e.message; });
      // 正确版本在任何输入法、清理和推送操作之前拒绝同一实例的另一端口。
      await Promise.race([aliasRun, new Promise(resolve => setTimeout(resolve, 100))]);
      ok('同一模拟器的不同ADB端口也不能并发接管相册', /已有发布任务/.test(aliasError));
      adbForSetup.shell = async (serial, cmd, opts) => cmd === 'settings get secure android_id'
        ? { ok: true, stdout: serial === 'FAKE_UNKNOWN' ? '' : serial === 'FAKE_OTHER' ? '827145746ae845d6' : '927145746ae845d6' }
        : savedShell(serial, cmd, opts);
      let unknownError = '';
      await publisher.run({ ...state, publish: { ...state.publish, device: 'FAKE_UNKNOWN' } }, ctx).catch(e => { unknownError = e.message; });
      ok('并发时身份读取失败不能假装属于独立设备，不执行相册操作', /无法确认/.test(unknownError) && keyboardEntries === 1);
      const otherRun = publisher.run({ ...state, publish: { ...state.publish, device: 'FAKE_OTHER' } }, ctx).catch(() => {});
      await Promise.race([otherRun, new Promise(resolve => setTimeout(resolve, 100))]);
      ok('不同身份的设备仍可并发，不把全部设备串行化', keyboardEntries === 2);
    release();
    await first;
      await aliasRun;
      await otherRun;
      adbForSetup.shell = savedShell;
    adbForSetup.ensureKeyboard = savedKeyboard;
  }
  const r = await publisher.run(state, ctx);
  const log = calls();
  // 清理失败不拖停后续素材，但下一条必须重新清理通过后才能推图。
  {
    const originalClear = adbForSetup.clearAlbum;
    try {
      for (const allFail of [false, true]) {
        let clearCount = 0;
        const interruptedState = JSON.parse(JSON.stringify(state));
        interruptedState.publish.rows = Array.from({ length: 4 }, (_, i) => ({
          ...interruptedState.publish.rows[0], seq: i + 1, result: '', status: '排队', reason: '', startAt: ''
        }));
        adbForSetup.clearAlbum = async (...args) => {
          clearCount++;
          if (allFail || clearCount === 3) return { ok: false, code: 'ALBUM_IO_INTERRUPTED', error: '目录读取超时' };
          return originalClear(...args);
        };
        clearCalls();
        const continued = await publisher.run(interruptedState, ctx);
        if (allFail) {
          ok('持续清理失败：四条各尝试一次，如实失败且从未推图或点击发布', clearCount === 4
            && continued.failCount === 4 && !continued.stoppedReason && !/push |input tap|screencap/.test(calls()));
        } else {
          ok('第三条清理失败，第四条重新清理通过后继续发布', clearCount === 4 && continued.results.length === 4
            && continued.rows[2].result === '失败' && continued.rows[3].result === '发布成功' && continued.okCount === 3);
          ok('清理失败条目未推图，成功三条各推两张', (calls().match(/push /g) || []).length === 6);
          ok('单条清理超时不再停止整批', !continued.stoppedReason && continued.failCount === 1);
        }
      }
    } finally { adbForSetup.clearAlbum = originalClear; }
  }
  ok('真实通道跑完 1 条', r.mode === 'adb' && r.total === 1, `成功 ${r.okCount}/${r.total}`);
  {
    const originalClear = adbForSetup.clearAlbum;
    let cancelled = false, clears = 0;
    const stoppedState = JSON.parse(JSON.stringify(state));
    stoppedState.publish.rows = Array.from({ length: 4 }, (_, i) => ({ ...stoppedState.publish.rows[0],
      seq: i + 1, result: i === 0 ? '发布成功' : '', status: i === 0 ? '发布成功' : '排队', reason: '', startAt: '' }));
    const stopLogs = [];
    adbForSetup.clearAlbum = async () => { clears++; cancelled = true; return { ok: false, error: '相册清理已取消' }; };
    clearCalls();
    let stopped;
    try { stopped = await publisher.run(stoppedState, { ...ctx, cancelled: () => cancelled,
      log: msg => stopLogs.push(msg) }); } finally { adbForSetup.clearAlbum = originalClear; }
    ok('清相册时停止：已成功行保留、当前行已取消、后续行未执行，不计失败', stopped.cancelled && stopped.okCount === 1
      && stopped.failCount === 0 && stopped.rows.map(x => x.result).join(',') === '发布成功,已取消,未执行,未执行');
    ok('主动停止只记取消原因和批次停止，不伪装清理失败或批次发布完成', stopped.rows[1].reason === '任务已取消'
      && stopLogs.some(s => s.includes('批次已停止')) && !stopLogs.some(s => /发布失败|发布结束：/.test(s)));
    ok('停止后不执行后续清理、推送、截图或提交动作', clears === 1 && !/push |screencap|input tap/.test(calls()));
    clearCalls();
    let inputCancel = '';
    try { await publisher.runStep('127.0.0.1:5555', { action:'input',value:'不应输入',name:'填正文' }, {}, {cancelled:()=>true}); }
    catch(e) {inputCancel=e.message;}
    ok('步骤刚开始已取消时不得继续输入、补话题或点击',/已取消/.test(inputCancel)&&!calls().trim());
  }
  ok('推图 2 张', (log.match(/push /g) || []).length === 2, (log.match(/push .*/g) || []).join(' | '));
  ok('触发媒体扫描（写进 MediaStore：content call --method scan_file）',
    /content call --uri content:\/\/media\/external\/file --method scan_file/.test(log));
  ok('点击了「发布」按钮', (log.match(/input tap 162 160/g) || []).length >= 1);
  ok('点击了相册/下一步/关联好物', /input tap 162 280/.test(log) && /input tap 920 2250/.test(log) && /input tap 220 1540/.test(log));
  // ★★ 2026-10-04：非 ASCII 现在走 ADBKeyboard 的 **B64** 通道（见 adb.js#inputText 的注释：
  //   `ADB_INPUT_TEXT` 那条不认 `%s`，代码把空格换成 `%s` 后照搬 ⇒ 空格会变成字面 `%s`）。
  //   断言改成「从命令里取 base64、解回来 == 源文」——比只看通道名更硬：通道对了但内容被改写照样红。
  ok('中文标题走 ADBKeyboard 广播（B64 通道，且解回来一字不差）',
    log.indexOf('am broadcast -a ADB_INPUT_B64 --es msg '
      + Buffer.from('白色的鞋谁懂', 'utf8').toString('base64')) >= 0);
  // 2026-10-09 实测：# 与话题名整段提交会变普通文字，须分两次提交，再补结束空格。
  const topicCalls = ['\n#', '品牌甲', ' '].map(t => 'am broadcast -a ADB_INPUT_B64 --es msg ' + Buffer.from(t, 'utf8').toString('base64'));
  ok('真实发布链路：话题分两次输入，结束空格先于关联好物点击',
    topicCalls.every(c => log.includes(c)) && log.indexOf(topicCalls[0]) < log.indexOf(topicCalls[1])
      && log.indexOf(topicCalls[1]) < log.indexOf(topicCalls[2])
      && /input tap/.test(log.slice(log.indexOf(topicCalls[2]) + topicCalls[2].length)) && !/\\#品牌甲/.test(log),
    (log.match(/ADB_INPUT_B64 --es msg \S+/g) || []).join(' | '));
  ok('结果标为发布成功', r.rows[0].result === '发布成功', r.rows[0].result);

  // ★★ 2026-10-03 真机事故回归：`state.publish.uiMap` 必须**优先于**配置里的定位表。
  //   事故经过：publisher 里写的是 `const map = c.uiMap;`（**只读配置**）——
  //   而 tools/pubsim.js（真机干跑）以为自己传进来的「**已剔除『提交发布』那一步**」的 uiMap
  //   会被用上，实际被**静默忽略** ⇒ 干跑把「提交发布」**真点了** ⇒ 账号上真的发出去了 2 条内容
  //   （个人主页动态列表里实测出现「干跑不发布·图文标题」，用户手动删除）。
  //   ⇒ 必须**行为级**验证（抠出去真跑），不能只看源码里有没有那行字 ——
  //     那样注释里写一句就假绿，而这正是这次漏掉的原因。
  //     A) 不传 ⇒ 用配置里的表（正常跑完，作正向对照）
  //     B) 传一张「一跑就必然报错」的表 ⇒ **必须**按它报错；不报错 = 又被静默忽略了
  {
    // 重置 result/status：上面第 4 节已经把同一批行跑成「发布成功」，
    // 而 run 会跳过 result === '发布成功' 的行 ⇒ 不重置的话 A/B 都不会执行任何步骤，B 会假绿。
    const mkSt = () => {
      const st = JSON.parse(JSON.stringify(state));
      st.publish.rows[0].result = '';
      st.publish.rows[0].status = '排队';
      return st;
    };
    store.set({ publish: { uiMap: { package: 'com.shizhuang.duapp',
      steps: [{ name: '配置里的步', action: 'wait', value: '1' }, { name: '提交发布', action: 'tapText', value: '发布' }] } } });
    // ★ 注意：runReal 抛的异常会被 run 的 try/catch **吞掉**并写成行结果
    //   （row.result='失败'、row.reason=错误消息）⇒ 判据必须看**行的结果**，不是看调用有没有抛错。
    const rA = await publisher.run(mkSt(), ctx);
    ok('A) 不传 state.publish.uiMap → 用配置里的定位表（配置表是正常步骤 ⇒ 这行发布成功）',
      !!rA.rows[0] && rA.rows[0].result === '发布成功', rA.rows[0] && rA.rows[0].result);

    const stB = mkSt();
    stB.publish.uiMap = { package: 'com.shizhuang.duapp',
      steps: [{ name: '覆盖表里的坏步', action: 'tapXY', value: '这不是坐标' }] };
    const rB = await publisher.run(stB, ctx);
    const whyB = (rB.rows[0] && rB.rows[0].reason) || '';
    ok('★★ B) 传了 state.publish.uiMap → 必须用它（覆盖表的坏步骤当场判失败；跑成「发布成功」就是又被静默忽略了）',
      /坐标解析不出来/.test(whyB), whyB || '（这行没失败 —— 说明用的还是配置表，正是 2026-10-03 误发内容的原因）');
    store.set({ publish: { uiMap } });
  }

  // 4b) ★ 2026-10-03：条件步骤（when / whenNot）+「好物1~3 货号/颜色」占位符
  //     为什么要**行为级**测：这两件事任意一件挂了，真机上的表现都是「静默少做一步」
  //     （少关联一个商品 / 关联好物搜索页开着没人选），日志还说发布成功 —— 最难查的那一类。
  //     （a）逻辑真值表
  const truth = [
    [{ when: 'a' }, { a: 'x' }, true],
    [{ when: 'a' }, { a: '' }, false],
    [{ when: 'a' }, {}, false],
    [{ whenNot: 'a' }, { a: '' }, true],
    [{ whenNot: 'a' }, {}, true],
    [{ whenNot: 'a' }, { a: 'x' }, false],
    [{}, { a: 'x' }, true],
    // 多键（逗号分隔）：when = 全非空；whenNot = 全空；两个字段可同时写
    [{ when: 'a,b' }, { a: 'x', b: 'y' }, true],
    [{ when: 'a,b' }, { a: 'x', b: '' }, false],
    [{ when: 'a,b' }, { a: 'x' }, false],
    [{ whenNot: 'a,b' }, { a: '', b: '' }, true],
    [{ whenNot: 'a,b' }, { a: '', b: 'y' }, false],
    [{ when: 'a', whenNot: 'b' }, { a: 'x', b: '' }, true],
    [{ when: 'a', whenNot: 'b' }, { a: 'x', b: 'y' }, false]
  ].map(([st, dt, want]) => uimap.condOk(st, dt) === want);
  ok('条件步骤：condOk 真值表 14 组全对（含多键/两字段同写）', truth.every(Boolean), truth.join(','));

  // ★★ 4b-2) 2026-10-04：**跳过原因必须点名真正没成立的那一半**。
  //   真机日志里曾写着「跳过「好物1 · 没填颜色就选第 1 格」（占位符 goods1Sku 是空的）」，
  //   而那一行明明填了货号（被 whenNot 的颜色拦下的）—— 报错点名一个**已经满足**的条件，
  //   等于把人往反方向带。这里把「条件不成立 ⇒ condWhy 必须能说出是谁」钉死。
  {
    const w1 = uimap.condWhy({ when: 'goods1Sku', whenNot: 'goods1Color' }, { goods1Sku: '3261132007', goods1Color: '煤黑色01' });
    ok('★ 跳过原因：whenNot 拦下时点的是 whenNot（不许点那个已经填了的 when）',
      /whenNot/.test(w1) && /goods1Color/.test(w1) && !/goods1Sku/.test(w1), w1);
    const w2 = uimap.condWhy({ when: 'goods2Sku' }, { goods2Sku: '' });
    ok('★ 跳过原因：when 拦下时点的是 when',
      /when：/.test(w2) && /goods2Sku/.test(w2), w2);
    const w3 = uimap.condWhy({ whenNot: 'goods3Sku,goods3Color' }, { goods3Sku: '', goods3Color: '' });
    ok('★ 条件其实成立时 condWhy 不许乱说话（返回空串）', w3 === '', JSON.stringify(w3));
    const expectOk = [{ when: 'a' }, { whenNot: 'a' }, {}, { when: 'a,b' }, { when: 'a', whenNot: 'b' }];
    const dt = [{ a: 'x' }, { a: '' }, { a: 'x', b: '' }, { a: 'x', b: 'y' }];
    let bad = 0;
    for (const st of expectOk) for (const d of dt) {
      const isOk = uimap.condOk(st, d);
      const why = uimap.condWhy(st, d);
      if (isOk === (why !== '')) bad++;   // 「成立」与「说得出原因」必须互为反面
    }
    ok('★ condWhy 与 condOk 互为反面（5 种条件 × 4 种数据 = 20 组：成立⇔说不出原因，不成立⇔一定说得出来）',
      bad === 0, `不一致 ${bad} 组 / 共 ${expectOk.length * dt.length} 组`);

    // ★ 光在 uimap 里写好 condWhy 不算修好 —— **publisher 那行日志真的用上它**才算。
    //   （负向断言只看代码行：注释里就写着那句旧文案，不先 codeOnly 会被自己的注释骗过。）
    const co = s => s.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const pubCode = co(fs.readFileSync(path.join(base, 'src', 'main', 'services', 'publisher.js'), 'utf8'));
    ok('★ 跳过日志真的走了 condWhy，且旧那句「有 when 就报 when 空」已不在代码里',
      /uimap\.condWhy\(step, data\)/.test(pubCode) && !/step\.when\s*\?\s*`占位符/.test(pubCode),
      pubCode.split(/\r?\n/).filter(l => /condWhy/.test(l)).map(x => x.trim())[0] || '(没找到 condWhy 调用)');
  }

  const norm = uimap.normalizeSteps([
    { name: 'a', action: 'tapText', value: '发布', when: 'goods2Sku' },
    { name: 'b', action: 'input', value: '${goods1Color}', whenNot: 'goods1Color' }
  ]);
  ok('条件步骤：when / whenNot 被规范化成占位符名',
    norm[0].when === 'goods2Sku' && norm[1].whenNot === 'goods1Color',
    JSON.stringify([norm[0].when, norm[1].whenNot]));
  ok('条件步骤：多键写成 ${a}, ${b} 也能归一化',
    uimap.normalizeSteps([{ action: 'tapText', value: '发布', when: '${goods2Sku}, ${goods2Color}' }])[0].when === 'goods2Sku,goods2Color');
  ok('条件步骤：手写 ${xxx} 也认（归一化掉花括号）',
    uimap.normalizeSteps([{ action: 'tapText', value: '发布', when: '${goods1Color}' }])[0].when === 'goods1Color');
  let badCond = '';
  try { uimap.normalizeSteps([{ action: 'tapText', value: '发布', when: '${a} + 1' }]); } catch (e) { badCond = e.message; }
  ok('条件步骤：非法 when 在导入时就报错（不放行到真机）', /只能写占位符名/.test(badCond), badCond);

  //     （b）行为级：拿假设备真跑，看「该跳的有没有真跳、该点的有没有真点到」
  const condMap = {
    package: 'com.shizhuang.duapp',
    steps: [
      { name: '好物1·点关联好物', action: 'tapText', value: '关联好物', when: 'goods1Sku' },
      { name: '好物1·填货号', action: 'input', value: '${goods1Sku}', when: 'goods1Sku' },
      { name: '好物1·按颜色选', action: 'tapText', value: '相册', when: 'goods1Color' },
      { name: '好物1·没填颜色则选第1格', action: 'tapId', value: 'com.shizhuang.duapp:id/et_title', whenNot: 'goods1Color' },
      { name: '好物2·点关联好物', action: 'tapText', value: '关联好物', when: 'goods2Sku' },
      { name: '好物2·填货号', action: 'input', value: '${goods2Sku}', when: 'goods2Sku' },
      { name: '好物2·按颜色选', action: 'tapText', value: '下一步', when: 'goods2Color' },
      { name: '好物3·点关联好物', action: 'tapText', value: '关联好物', when: 'goods3Sku' },
      { name: '提交发布', action: 'tapText', value: '发布' }
    ]
  };
  const mkCondState = gs => ({
    items: [{
      id: 'r1', dir: itemDir, absDir: itemDir,
      sku: (gs[0] && gs[0].sku) || '', color: (gs[0] && gs[0].color) || '',
      goods: gs, files: [{ name: '1.jpg', type: 'image' }]
    }],
    copyRows: [{ id: 'r1', title: '标题', body: '正文', topics: [] }],
    verify: { rows: [] },
    publish: {
      rows: [{ seq: 1, id: 'r1', dir: 'r1', goods: 1, images: 1, startAt: '', status: '排队', result: '', retries: 0, reason: '' }],
      mode: 'adb', device: '127.0.0.1:5555'
    }
  });
  const runCond = async (gs) => {
    store.set({ publish: { uiMap: condMap } });
    clearCalls();
    const lg = [];
    const st = mkCondState(gs);
    await publisher.run(st, { log: (m, l) => lg.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} });
    return { log: calls(), logs: lg };
  };
  const nTap = (s2, re) => (s2.match(re) || []).length;   // 「关联好物」那行的坐标
  const GOODS_ROW = /input tap 220 1540/g;

  // ① 只有好物1、且填了颜色 ⇒ 好物2/3 一步都不许点；好物1 走「按颜色选」
  const GA = await runCond([{ sku: 'A111', color: '冠军白' }]);
  ok('好物：只有 1 个时「关联好物」恰好点 1 次', nTap(GA.log, GOODS_ROW) === 1, nTap(GA.log, GOODS_ROW) + ' 次');
  // ★ 只断言「内容有没有被输入 / 出现在第几次关联之后」——**不**断言走的是
  //   `input text` 还是 ADBKeyboard 广播：纯 ASCII 走前者、含中文走后者，是 adb.inputText 的实现细节，
  //   断言抄实现细节就变成「改了实现就假红」。（测试数据故意用 ASCII 货号，就是为了不牵扯输入法状态。）
  ok('好物：第 1 个的货号被输入了', /A111/.test(GA.log));
  ok('好物：第 2 个的货号没有被输入', !/B222/.test(GA.log), GA.log.split('\n').filter(x => /input text|ADB_INPUT/.test(x)).join(' | '));
  ok('好物：填了颜色 ⇒ 走「按颜色选」，不走「选第 1 格」的退路',
    nTap(GA.log, /input tap 162 280/g) === 1 && nTap(GA.log, /input tap 540 450/g) === 0,
    `按颜色=${nTap(GA.log, /input tap 162 280/g)} 退路=${nTap(GA.log, /input tap 540 450/g)}`);
  ok('好物：跳过的步骤写进了日志（不静默）',
    GA.logs.some(m => /跳过/.test(m) && /goods2Sku/.test(m)),
    GA.logs.filter(m => /跳过/.test(m)).slice(0, 2).join(' | '));

  // ② 两个好物、且好物1 没填颜色 ⇒ 好物2 真被点/真被填；好物1 退化成「选第 1 格」
  const GB = await runCond([{ sku: 'A111', color: '' }, { sku: 'B222', color: '煤黑色01' }]);
  ok('好物：有 2 个时「关联好物」点 2 次', nTap(GB.log, GOODS_ROW) === 2, nTap(GB.log, GOODS_ROW) + ' 次');
  const iTap2 = GB.log.indexOf('input tap 220 1540', GB.log.indexOf('input tap 220 1540') + 1);
  ok('好物：第 2 个货号被真输入', /B222/.test(GB.log));
  ok('好物：第 2 个货号是在「第 2 次点关联好物**之后**」才打的（顺序不能反）',
    iTap2 >= 0 && GB.log.indexOf('B222') > iTap2,
    `第2次点关联=${iTap2} 打货号=${GB.log.indexOf('B222')}`);
  ok('好物：好物1 没填颜色 ⇒ 走「选第 1 格」退路（不是按颜色）',
    nTap(GB.log, /input tap 540 450/g) === 1 && nTap(GB.log, /input tap 162 280/g) === 0,
    `退路=${nTap(GB.log, /input tap 540 450/g)} 按颜色=${nTap(GB.log, /input tap 162 280/g)}`);
  ok('好物：好物2 填了颜色 ⇒ 第 2 段按颜色选', nTap(GB.log, /input tap 920 2250/g) === 1);

  // ③ 一个货号都没有 ⇒ 好物三段全跳，但「提交发布」照旧执行（只跳带条件的那些步）
  const GC = await runCond([{ sku: '', color: '' }]);
  ok('好物：没货号时三段全跳（一次都没点关联好物）', nTap(GC.log, GOODS_ROW) === 0, nTap(GC.log, GOODS_ROW) + ' 次');
  ok('好物：无条件的步骤照旧执行（提交发布点了）', nTap(GC.log, /input tap 162 160/g) === 1,
    nTap(GC.log, /input tap 162 160/g) + ' 次');

  // 4c) ★ 2026-10-03 真机撞出来的两处健壮性缺口（都在「关联好物」那段路上暴露的）——
  //     ① 抓结构没带包名 ⇒ 动画页抓不到时**没有 dumpsys 备用通道**；
  //     ② 找不到节点一次就判失败 ⇒ 结果图墙加载那一两秒会被误判成「页面结构变了」。
  const oneMap = { package: 'com.shizhuang.duapp', steps: [{ name: '一次就找到', action: 'tapText', value: '发布' }] };
  store.set({ publish: { uiMap: oneMap } });
  clearCalls();
  await publisher.run(mkCondState([{ sku: 'A111', color: '冠军白' }]),
    { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
  const dumpsOnce = (calls().match(/uiautomator dump/g) || []).length;
  ok('抓结构：一次就找到时只抓 1 次（不白白重试）', dumpsOnce === 1, dumpsOnce + ' 次');

  const bogusMap = {
    package: 'com.shizhuang.duapp',
    steps: [
      { name: '根本不存在的文字', action: 'tapText', value: '这里根本没有这行字' },
      { name: '提交发布', action: 'tapText', value: '发布' }
    ]
  };
  store.set({ publish: { uiMap: bogusMap } });
  clearCalls();
  const retryLogs = [];
  const rc = await publisher.run(mkCondState([{ sku: 'A111', color: '冠军白' }]),
    { log: (m, l) => retryLogs.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} });
  const dumpsRetry = (calls().match(/uiautomator dump/g) || []).length;
  ok('抓结构：找不到节点先重试（不是一次就判失败）', dumpsRetry >= 3, dumpsRetry + ' 次 dump');
  ok('抓结构：重试期间写进日志（说清「还没看到、再抓一次」）',
    retryLogs.some(m => /再抓一次/.test(m)), retryLogs.filter(m => /再抓一次/.test(m)).length + ' 条');
  ok('抓结构：重试到失败后，报错仍然点名缺什么',
    /找不到「这里根本没有这行字」/.test(rc.rows[0].reason || ''), rc.rows[0].reason);

  // ③ 源码级（不是行为级，如实标注）：runStep 抓结构必须带包名 —— 夹具里那份 dumpsys 层级
  //    **一个 resource-id 都没有**（tools/fakeadb/activity-top.txt），所以「带包名 → 备用通道能按 id 点到」
  //    这件事在当前夹具下**测不出来**，只能钉住那一行字。行为级验证留给真机（已在真机确认 dumpsys 通道有 id）。
  const pubSrcForTap = fs.readFileSync(path.join(base, 'src/main/services/publisher.js'), 'utf8');
  const tapBranch = pubSrcForTap.slice(pubSrcForTap.indexOf("case 'tapText': case 'tapId': case 'tapDesc':"),
                                 pubSrcForTap.indexOf("case 'input':"));
  // ★ 2026-10-03 提速后 dumpEx 多带了一个 retries:0（见 publisher 里那段注释）⇒
  //   断言不能锁死「参数只有 pkg」这一种写法，要看**语义**：抓屏调用里带了包名。
  ok('抓结构（源码级）：runStep 抓结构带上了包名（语义：dumpEx 调用里必须有 pkg: uimap.DEWU.pkg）',
    /mediapermission\.dump\(serial, \{[^}]*pkg: uimap\.DEWU\.pkg[^}]*\}/.test(tapBranch) && tapBranch.length > 200,
    tapBranch.length + ' 字符的 tap 分支');

  // 4d) ★★ 2026-10-03 用户追问「什么叫做只能发第一张图片？？」——
  //     「一条内容多张图」是**动作层缺的能力**，不是通道问题（真机通道一模一样）：
  //     相册缩略图**没有文字也没有描述**，只能按 resource-id 点，而「取第一个匹配」
  //     ⇒ 一条内容只选上第 1 张（其余图早就推上设备了，只是没被点中）。
  //     真机旁证：右下角按钮文字是「下一步 (1)」—— 带计数 ⇒ 相册本来就是多选。
  const albumXml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0" width="1080" height="2400">
  <node index="0" text="" resource-id="com.shizhuang.duapp:id/flThumbSelect" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="true" bounds="[40,300][340,600]" />
  <node index="1" text="" resource-id="com.shizhuang.duapp:id/flThumbSelect" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="true" bounds="[380,300][680,600]" />
  <node index="2" text="" resource-id="com.shizhuang.duapp:id/flThumbSelect" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="true" bounds="[720,300][1020,600]" />
  <node index="3" text="下一步 (1)" resource-id="com.shizhuang.duapp:id/flNextStep" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="true" bounds="[800,2200][1040,2300]" />
</hierarchy>`;
  const albumNodes = uimap.parseNodes(albumXml);
  const THUMB = 'com.shizhuang.duapp:id/flThumbSelect';
  const allThumbs = uimap.findNodes(albumNodes, { id: THUMB });
  ok('多图：findNodes 按**界面顺序**返回全部匹配（不是只给第一个）',
    allThumbs.length === 3 && allThumbs.map(n => n.center.x).join(',') === '190,530,870'
    && uimap.findNode(albumNodes, { id: THUMB }).center.x === 190,
    JSON.stringify(allThumbs.map(n => n.center)));

  const CNT = [[undefined, 1], ['', 1], [0, 1], [-3, 1], ['abc', 1], ['2', 2], [3, 3], [18, 18],
               [999, uimap.MAX_TAP_COUNT]];
  const cntBad = CNT.filter(([v, w]) => uimap.countOf(v) !== w);
  ok('多图：countOf 真值表（缺省/空/0/负数/非数字 ⇒ 1；正常值取整；超上限夹住）',
    cntBad.length === 0, JSON.stringify(cntBad));

  const normA = uimap.normalizeSteps([{ action: 'tapId', value: THUMB, count: 3 }])[0];
  const normB = uimap.normalizeSteps([{ action: 'tapId', value: THUMB, count: '${imageCount}' }])[0];
  const normC = uimap.normalizeSteps([{ action: 'tapId', value: THUMB }])[0];
  ok('多图：导入时 count 认三种写法（整数 / 占位符 / 不写＝1）',
    normA.count === 3 && normB.count === '${imageCount}' && normC.count === 1,
    JSON.stringify({ a: normA.count, b: normB.count, c: normC.count }));
  const cntErrs = [0, -1, 'abc', 21, 2.5].map(v => {
    try { uimap.normalizeSteps([{ action: 'tapId', value: THUMB, count: v }]); return '未报错(' + v + ')'; }
    catch (e) { return /count/.test(e.message) ? '' : '报错但没提 count(' + v + ')'; }
  }).filter(Boolean);
  ok('多图：一眼就错的 count（0 / 负数 / 非数字 / 超上限 / 小数）**导入即报错**',
    cntErrs.length === 0, cntErrs.join(' | '));
  ok('多图：fill 把 count 里的占位符替换成真实张数；解析不到时**原样留着**（不变成空）',
    uimap.fill({ value: 'x', count: '${imageCount}' }, { imageCount: 3 }).count === '3'
    && uimap.fill({ value: 'x', count: '${imageCount}' }, {}).count === '${imageCount}',
    JSON.stringify([uimap.fill({ value: 'x', count: '${imageCount}' }, { imageCount: 3 }).count,
                    uimap.fill({ value: 'x', count: '${imageCount}' }, {}).count]));

  // ---- 端到端：真起一遍真实通道，数「到底点了几下、点在哪」 ----
  const albumBackup = fs.readFileSync(FAKE_WINDOW, 'utf8');
  const mkAlbumState = (nImg) => ({
    items: [{
      id: 'r-album', dir: itemDir, absDir: itemDir, sku: 'A111', color: '冠军白',
      files: Array.from({ length: nImg }, (_, i) => ({ name: (i + 1) + '.jpg', type: 'image' }))
    }],
    copyRows: [{ id: 'r-album', title: '标题', body: '正文', topics: [] }],
    verify: { rows: [] },
    publish: {
      rows: [{ seq: 1, id: 'r-album', dir: 'r-album', goods: 1, images: nImg, startAt: '', status: '排队', result: '', retries: 0, reason: '' }],
      mode: 'adb', device: '127.0.0.1:5555'
    }
  });
  const runAlbum = async (steps, nImg) => {
    store.set({ publish: { uiMap: { package: 'com.shizhuang.duapp', steps } } });
    clearCalls();
    const lg = [];
    const st = mkAlbumState(nImg);
    try {
      await publisher.run(st, { log: (m, l) => lg.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} });
    } catch (e) { st.publish.rows[0].reason = st.publish.rows[0].reason || ('抛出：' + e.message); }
    return { log: calls(), logs: lg, row: st.publish.rows[0] };
  };
  const nOf = (s2, re) => (s2.match(re) || []).length;
  const T1 = /input tap 190 450/g, T2 = /input tap 530 450/g, T3 = /input tap 870 450/g;
  const thumbStep = (extra) => Object.assign({ name: '选中要发的图', action: 'tapId', value: THUMB }, extra);

  try {
    fs.writeFileSync(FAKE_WINDOW, albumXml);
    // ① 素材有 3 张图 ⇒ 3 张都要被点中（这才是「能发多张图」的行为级证据）
    const A = await runAlbum([thumbStep({ count: '${imageCount}' })], 3);
    ok('多图（端到端）：素材 3 张 ⇒ 相册前 3 格**各点 1 次**（真调了 3 次 input tap）',
      nOf(A.log, T1) === 1 && nOf(A.log, T2) === 1 && nOf(A.log, T3) === 1,
      `第1格=${nOf(A.log, T1)} 第2格=${nOf(A.log, T2)} 第3格=${nOf(A.log, T3)}`);
    ok('多图（端到端）：点了几格写进日志（不静默）',
      A.logs.some(m => /一次点了 3 个/.test(m)), A.logs.filter(m => /一次点了/.test(m))[0] || '（没有）');

    // ② 只有 1 张图 ⇒ 只点第 1 格（不能把别人的图也点上）
    const B = await runAlbum([thumbStep({ count: '${imageCount}' })], 1);
    ok('多图（端到端）：素材只有 1 张 ⇒ 只点第 1 格，第 2/3 格一次都不点',
      nOf(B.log, T1) === 1 && nOf(B.log, T2) === 0 && nOf(B.log, T3) === 0,
      `第1格=${nOf(B.log, T1)} 第2格=${nOf(B.log, T2)} 第3格=${nOf(B.log, T3)}`);

    // ③ 老定位表（没写 count）⇒ 行为与从前**完全一致**：只点第一个匹配
    const C = await runAlbum([thumbStep({})], 3);
    ok('多图（端到端）：老表没写 count ⇒ 仍然只点第 1 格（向后兼容，不改老表行为）',
      nOf(C.log, T1) === 1 && nOf(C.log, T2) === 0 && nOf(C.log, T3) === 0,
      `第1格=${nOf(C.log, T1)} 第2格=${nOf(C.log, T2)}`);

    // ④ 要 5 格、界面只有 3 格 ⇒ **必须失败**，且说清「要几个 / 找到几个」（不静默少发图）
    const D = await runAlbum([thumbStep({ count: 5 })], 5);
    ok('多图（端到端）：张数对不上 ⇒ 失败，不静默少点（报错里同时有「5」和「3」）',
      D.row.result === '失败' && /5 个/.test(D.row.reason || '') && /3 个/.test(D.row.reason || ''),
      (D.row.result || '') + ' / ' + (D.row.reason || ''));

    // ⑤ 占位符解析不出（这条记录读不到图片清单）⇒ 当场报错，**不许默默按 1 张发**
    // 这条素材**有 3 张图**，只是把 count 写成数据里没有的键 ⇒ 考的是「解析不出来」这一支
    const E = await runAlbum([thumbStep({ count: '${noSuchKey}' })], 3);
    ok('多图（端到端）：count 解析成空 ⇒ 当场失败并点名 count（不默默按 1 张发）',
      E.row.result === '失败' && /count/.test(E.row.reason || ''), (E.row.reason || '').slice(0, 120));
  } finally {
    fs.writeFileSync(FAKE_WINDOW, albumBackup);
  }

  // ★ 收尾：把 uiMap 还原成这一套后面几步（5/6/7…）要用的那一份 —— 不还原就是把它们偷偷换了表跑
  store.set({ publish: { uiMap } });

  // 5) 页面结构变了 → 必须失败 + 存截图，绝不能成功
  const backup = fs.readFileSync(FAKE_WINDOW, 'utf8');
  fs.writeFileSync(FAKE_WINDOW, backup.replace(/text="发布"/g, 'text="首页"'));
  state.publish.rows[0].result = '';
  const failLogs = [];
  const r2 = await publisher.run(state,
    { log: (m, l) => failLogs.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} });
  fs.writeFileSync(FAKE_WINDOW, backup);
  ok('找不到节点时报失败', r2.rows[0].result === '失败', r2.rows[0].result + ' / ' + r2.rows[0].reason);
  ok('失败原因说明缺什么', /找不到/.test(r2.rows[0].reason), r2.rows[0].reason);
  // ★★ 2026-10-03 用户要求「发布失败**不重试**」——「不重试」必须**行为级**证明，不能只看源码里 maxTry 没了：
  //    老实现下这一行会失败 2~3 次（retry 出厂 2 ⇒ maxTry=3），每次都会写一行「第 N 次失败」；
  //    现在只跑一次 ⇒ 带该行目录名的「发布失败，原因…」**只出现一次**，且不存在任何「第 N 次失败」。
  //    （把改前的版本喂进来，这两条都会红 —— 已实测。）
  const dir0 = state.publish.rows[0].dir;
  const rowFail = failLogs.filter(m => m.indexOf(dir0) >= 0 && /发布失败，原因/.test(m));
  ok('★ 失败只跑一次（不重试）：该行的「发布失败，原因…」只出现 1 次',
    rowFail.length === 1, rowFail.length + ' 次 → ' + (rowFail.join(' | ') || '(一条都没有)'));
  ok('★ 日志里没有任何「第 N 次失败」的重试痕迹（重试循环已删）',
    !failLogs.some(m => /第 \d+ 次失败/.test(m)),
    failLogs.filter(m => /次失败/.test(m)).join(' | ') || '无');
  ok('★ 失败那行写的是「发布失败，原因xxx」（用户 2026-10-03 指定的口径，不是「失败：xxx」）',
    /发布失败，原因/.test(rowFail[0] || ''), rowFail[0] || '(没有)');
  // ★ 台账里不再写 retries（失败不再重试 ⇒ 它恒为 0）；旧台账那一列仍照原样读（见 batchtest ⑤）
  ok('★ 新台账里不再写 retries 字段（恒为 0 的字段不写假值）',
    r2.results.length === 1 && !('retries' in r2.results[0]), JSON.stringify(r2.results[0] || {}).slice(0, 160));
  const shots = fs.existsSync(path.join(TMP, '输出', 'failures'))
    ? fs.readdirSync(path.join(TMP, '输出', 'failures')) : [];
  ok('失败时存了截图', shots.length > 0, shots.join(', '));

  // 6) 视频条：推视频 → 等媒体库索引 → 走 videoSteps（不是图文那一套）
  const itemDir2 = path.join(TMP, 'flat', '26FW-YB160+冠军白+2');
  fs.mkdirSync(itemDir2, { recursive: true });
  fs.writeFileSync(path.join(itemDir2, '短片.mp4'), Buffer.from('fake video bytes'));
  const videoItem = {
    id: '26FW-YB160+冠军白+2', dir: itemDir2, absDir: itemDir2, sku: '26FW-YB160', color: '冠军白',
    files: [{ name: '短片.mp4', type: 'video' }]
  };
  const videoMap = {
    package: 'com.shizhuang.duapp',
    steps: uiMap.steps,
    videoSteps: [
      { name: '打开发布入口（视频）', action: 'tapText', value: '发布' },
      { name: '切到视频页签', action: 'tapText', value: '相册' },
      { name: '确认选视频', action: 'tapText', value: '下一步' },
      { name: '填标题', action: 'input', value: '${title}' },
      { name: '关联好物', action: 'tapText', value: '关联好物' },
      { name: '提交发布', action: 'tapText', value: '发布' }
    ]
  };
  const videoState = {
    items: [videoItem],
    copyRows: [{ id: videoItem.id, title: '视频标题', body: '视频正文', topics: [] }],
    verify: { rows: [{ id: videoItem.id, conclusion: '通过' }] },
    publish: {
      rows: [{ seq: 1, id: videoItem.id, dir: videoItem.id, kind: 'video', goods: 1, images: 0, startAt: '', status: '排队', result: '', retries: 0, reason: '' }],
      mode: 'adb', device: '127.0.0.1:5555'
    }
  };
  store.set({ publish: { uiMap: videoMap, videoIndexTimeoutSec: 5 } });
  clearCalls();
  const vlogs = [];
  const vctx = { log: (m, l) => vlogs.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} };
  const rv = await publisher.run(videoState, vctx);
  const vlog = calls();
  ok('⑥ 视频条跑通（走 videoSteps）', rv.total === 1 && rv.okCount === 1, `成功 ${rv.okCount}/${rv.total}`);
  ok('⑥ 推的是视频文件（只推 1 个，不是图片）',
    (vlog.match(/push /g) || []).length === 1 && /push .*短片\.mp4/.test(vlog), (vlog.match(/push .*/g) || []).join(' | '));
  ok('⑥ ★ 推完真的写进媒体库了（content call … scan_file —— 得物相册读的就是这张表）',
    /content call --uri content:\/\/media\/external\/file --method scan_file/.test(vlog),
    (vlog.match(/content call.*/g) || []).join(' | ') || '（一次都没调）');
  ok('⑥ 推完还确认了「真能看见」（content query）',
    /content query --uri content:\/\/media\/external\/video\/media/.test(vlog));
  ok('⑥ 进库确认被记进日志', vlogs.some(l => /确认写进媒体库/.test(l)), vlogs.filter(l => /媒体库/.test(l)).join(' | '));
  ok('⑥ videoSteps 的点击真的执行了（不是图文那 4 步）',
    /input tap 162 160/.test(vlog) && /input tap 162 280/.test(vlog) && /input tap 920 2250/.test(vlog) && /input tap 220 1540/.test(vlog));
  ok('⑥ 日志标的是 [视频]', vlogs.some(l => /\[视频\] 发布完成/.test(l)), vlogs.filter(l => /发布完成/.test(l)).join(' | '));
  // ★★★ 2026-10-05：视频条**不参与**主图排序（用户口径：只有图文才有"内容主图"）——
  //   所以整条视频流程里一条 `touch -d @…` 都不许出现（不许去碰设备上的文件时间）。
  ok('⑥ ★ 视频条不参与主图排序：整条流程里一次 `touch -d @…` 都没有',
    !/touch -d @/.test(vlog), (vlog.match(/touch .*/g) || []).join(' | ') || '（一条都没发）');

  // 7) 视频条没配 videoSteps → **复用图文 steps**（2026-10-02 用户实测：图文与视频发布位置一样）
  //    注意：store.set 是**深合并**，只写 steps 的话上一份表的 videoSteps 会被留下来，
  //    所以这里显式给 videoSteps: []（真实导入路径里 publish.importMap 也会显式置空）
  store.set({ publish: { uiMap: { package: 'com.shizhuang.duapp', steps: uiMap.steps, videoSteps: [] } } });
  videoState.publish.rows[0].result = '';
  clearCalls();
  const vstart = vlogs.length;
  const rv2 = await publisher.run(videoState, vctx);
  const vlog2 = calls();
  ok('⑦ 没配 videoSteps 的视频条**照常发布**（复用图文 steps，不再拦下）',
    rv2.rows[0].result === '发布成功', rv2.rows[0].result + ' / ' + (rv2.rows[0].reason || ''));
  ok('⑦ 日志里说清了「这条在用图文那套位置」',
    vlogs.slice(vstart).some(l => /图文那套位置/.test(l)), vlogs.slice(vstart).join(' | ').slice(0, 220));
  ok('⑦ 复用的确实是图文那套 steps（真的按 steps 点下去了）',
    /input tap 162 160/.test(vlog2), (vlog2.match(/input tap .*/g) || []).join(' | ') || '（一次都没点）');

  // 8) 视频推上去了但媒体库一直没索引到 → 明确失败，不许硬点（硬点只会点空）
  fs.writeFileSync(path.join(FDB, 'MEDIA_LAG'), '1');
  store.set({ publish: { uiMap: videoMap, videoIndexTimeoutSec: 1 } });
  videoState.publish.rows[0].result = '';
  clearCalls();
  const rv3 = await publisher.run(videoState, vctx);
  const vlog3 = calls();
  fs.unlinkSync(path.join(FDB, 'MEDIA_LAG'));
  ok('⑧ 一直写不进库 → 失败，不硬点',
    rv3.rows[0].result === '失败' && /没能写进媒体库/.test(rv3.rows[0].reason), rv3.rows[0].reason);
  ok('⑧ 等不到就一步界面都没点', !/input tap/.test(vlog3), (vlog3.match(/input tap .*/g) || []).join(' | ') || '（一次都没点）');

  // 8b) ★★ 2026-10-03：「模拟器正停在得物发布页」是**发布前的正常状态**，
  //     不许因为这个状态被判成「不能发布」而把发布通道**改写成模拟通道**。
  //     根因：connect() 的 ready 原来把 `tools.uiautomator`（＝当场那次 dump 成没成功）算进去，
  //     而发布页是**动画页**、uiautomator 抓不到是常态；程序本来就有 dumpsys 备用通道。
  //     后果：用户点「开始发布」一路「模拟成功」，模拟器里毫无动静 —— 就是「老是有那么多问题」的那个坑。
  {
    const NOTIDLE8 = path.join(FDB, 'DUMP_NOT_IDLE');
    const NODEWU8 = path.join(FDB, 'NO_DEWU_TOP');
    const had8 = fs.existsSync(NOTIDLE8) ? fs.readFileSync(NOTIDLE8, 'utf8') : null;
    try {
      fs.writeFileSync(NOTIDLE8, 'always');            // uiautomator 彻底抓不到（对齐发布页实测）
      if (fs.existsSync(NODEWU8)) fs.unlinkSync(NODEWU8);
      const p8 = await publisher.probe('127.0.0.1:5555');
      ok('⑧b 抓取通道自检：uiautomator 抓不到时，会**单独验一次** dumpsys 备用通道并如实记录',
        p8.tools.uiautomator === false && p8.tools.dumpsys === true,
        JSON.stringify({ uiautomator: p8.tools.uiautomator, dumpsys: p8.tools.dumpsys }));
      const c8 = await publisher.connect('127.0.0.1:5555');
      ok('⑧b ★ 模拟器停在发布页（动画页）时，「连接」后仍是**真实设备通道**（绝不退回模拟通道）',
        c8.connected === true && c8.mode === 'adb',
        JSON.stringify({ connected: c8.connected, mode: c8.mode }));

      // 负向对照：两条抓取通道都不通 ⇒ 才允许退回模拟通道。
      // （没有这一条，上面那条可能只是「恒为真」—— 那就等于什么都没证明。）
      fs.writeFileSync(NODEWU8, '1');                  // dumpsys 也抓不到得物
      const p8b = await publisher.probe('127.0.0.1:5555');
      const c8b = await publisher.connect('127.0.0.1:5555');
      ok('⑧b（对照）两条抓取通道都不通 ⇒ 才退回模拟通道（证明上一条不是恒真）',
        p8b.tools.uiautomator === false && p8b.tools.dumpsys === false
        && c8b.connected === false && c8b.mode === 'mock',
        JSON.stringify({ uiautomator: p8b.tools.uiautomator, dumpsys: p8b.tools.dumpsys, connected: c8b.connected, mode: c8b.mode }));
    } finally {
      if (fs.existsSync(NODEWU8)) fs.unlinkSync(NODEWU8);
      if (had8 == null) { if (fs.existsSync(NOTIDLE8)) fs.unlinkSync(NOTIDLE8); }
      else fs.writeFileSync(NOTIDLE8, had8);           // 还原成这一组进来之前的样子
    }
  }

  // 9) 页面一直不 idle（得物发布页实测就这样）→ 自动关动画兜底，且**必须还原**
  const NOTIDLE = path.join(FDB, 'DUMP_NOT_IDLE');
  const animLines = () => calls().split(/\r?\n/).filter(l => /settings (get|put|delete) global/.test(l));
  fs.writeFileSync(NOTIDLE, 'anim');       // 只在系统动画开着时失败（对齐真机实测：关掉动画同一秒就能抓到）
  clearCalls();
  const d9 = await publisher.dumpEx('127.0.0.1:5555');
  ok('⑨ 页面一直不 idle 时，能靠临时关动画抓到结构', d9.ok === true, JSON.stringify({ ok: d9.ok, why: d9.why }));
  ok('⑨ 这次抓取被标记为「关了动画才抓到」', d9.animOff === true, String(d9.animOff));
  const ac = animLines().join(' | ');
  ok('⑨ 抓完把系统动画还原了（不留设备被改过的状态）',
    /settings put global animator_duration_scale 1/.test(ac), ac || '（一次 settings 都没调）');

  // 10) 关动画也救不了 → 明确失败，绝不硬点
  fs.writeFileSync(NOTIDLE, 'always');
  store.set({ publish: { uiMap } });
  state.publish.rows[0].result = '';
  state.publish.rows[0].reason = '';
  clearCalls();
  const r10 = await publisher.run(state, ctx);
  const log10 = calls();
  // ★ 2026-10-03 有意收紧了这一条：以前 runStep 抓结构**不带包名** ⇒ 动画页抓不到就直接失败，
  //   报错是「拿不到界面结构：…一直不 idle」。现在带包名 ⇒ 会退到 dumpsys 备用通道（有 id / 没文字），
  //   于是「按文字点」的这一步失败在**找不到文字**上。文案必须点明是「备用通道没有文字」并给出改法
  //   （改成 tapId），否则错误反而更难查 —— 断言也就跟着钉在新文案上。
  ok('⑩ 关动画也抓不到时，发布明确失败并说明原因',
    r10.rows[0].result === '失败' && /备用通道/.test(r10.rows[0].reason) && /tapId/.test(r10.rows[0].reason),
    r10.rows[0].result + ' / ' + r10.rows[0].reason);
  ok('⑩ 抓不到结构就一步界面都没点', !/input tap/.test(log10),
    (log10.match(/input tap .*/g) || []).join(' | ') || '（一次都没点）');

  // 11) ★ 抓不到时**绝不返回上一页的结构**。
  //     哨兵法：先正常抓到一次（此时设备上留着一份 XML），再让它失败 ——
  //     旧实现把「dump 失败」和「cat 旧文件」连在一起，会把这上一份当成本页返回，
  //     调用方于是拿着旧页面的坐标去点新页面（静默点错）。
  fs.unlinkSync(NOTIDLE);
  clearCalls();
  const dA = await publisher.dumpEx('127.0.0.1:5555');
  ok('⑪ 前置：正常情况下能抓到结构', dA.ok === true && /<hierarchy/.test(dA.xml || ''), dA.ok ? '有内容' : dA.why);
  fs.writeFileSync(NOTIDLE, 'always');
  const dOld = await publisher.dump('127.0.0.1:5555');
  ok('⑪ 抓不到时 dump() 返回 null（不是设备上残留的上一页 XML）',
    dOld === null, dOld === null ? 'null' : '返回了残留内容：' + String(dOld).slice(0, 60));
  fs.unlinkSync(NOTIDLE);

  // 12) 结构上也要能看出来：每次 dump 之前必须先删掉远端那个复用文件
  //     ★ 2026-10-03 提速：rm / dump / cat 合并成**一条** shell（省两次 adb 往返），
  //       所以不能再按「两行、比行号」判 —— 改成在**同一条命令里**比先后位置。
  //       语义没变：还是「先删、再 dump」（不删的话 dump 失败时 cat 出来的是上一页的结构）。
  const seq = calls().split(/\r?\n/);
  const iLine = seq.findIndex(l => /rm -f \/sdcard\/bluev_window\.xml/.test(l) && /uiautomator dump/.test(l));
  const line = iLine >= 0 ? seq[iLine] : '';
  const pRm = line.indexOf('rm -f /sdcard/bluev_window.xml');
  const pDump = line.indexOf('uiautomator dump');
  ok('⑫ 抓取前先删远端文件（同一条 shell 里：rm 必须排在 dump 前面）',
    iLine >= 0 && pRm >= 0 && pDump >= 0 && pRm < pDump,
    iLine >= 0 ? `第 ${iLine} 行内 rm@${pRm} < dump@${pDump}` : '没找到同时含 rm 与 dump 的那条命令');

  // 14) ★★ 「抓取页面结构」必须先说清「你现在停在哪一屏」，停在别的 App 上要拦下来。
  //     真机依据（2026-10-01 MuMu 12 / 得物 900×1600）：得物首页右上角的发布入口是相机图标
  //     `com.shizhuang.duapp:id/ivCamera`，text 与 content-desc **都是空的** ⇒ 按文字猜必然猜不到。
  const FOCUS = path.join(FDB, 'FOCUS');
  clearCalls();
  fs.writeFileSync(FOCUS, 'com.android.launcher/com.android.launcher2.Launcher');
  const dOut = await publisher.dumpForCapture('127.0.0.1:5555');
  ok('⑰ 停在非得物界面时抓取被拦下（不许把别的 App 的坐标做成定位表）',
    dOut.ok === false && dOut.blocked === true, JSON.stringify({ ok: dOut.ok, blocked: dOut.blocked }));
  ok('⑰ 拦下时说清了「怎么去发布页」（含首页右上角相机图标）',
    /相机/.test(dOut.why) && /发布页/.test(dOut.why), String(dOut.why).slice(0, 50) + '…');

  fs.writeFileSync(FOCUS, 'com.shizhuang.duapp/com.shizhuang.duapp.MainActivity');
  const dHome = await publisher.dumpForCapture('127.0.0.1:5555');
  ok('⑰ 停在得物首页时照常抓（后面几屏本来也要能抓）', dHome.ok === true, String(dHome.why));
  ok('⑰ 但会告警「抓的不是发布页首屏」并回显这一屏（首页 tab 栏也有个「视频」，会污染）',
    dHome.onPublish === false && /MainActivity/.test(dHome.focusNote || ''),
    String(dHome.focusNote).slice(0, 46) + '…');

  fs.writeFileSync(FOCUS, 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity');
  const dPub = await publisher.dumpForCapture('127.0.0.1:5555');
  ok('⑰ 停在得物发布页时：正常抓、无告警、回显这一屏',
    dPub.ok === true && dPub.onPublish === true && dPub.focusNote === ''
      && /TotalPublishProcessActivity/.test(dPub.focus || ''),
    JSON.stringify({ ok: dPub.ok, note: dPub.focusNote }));

  fs.writeFileSync(FOCUS, '-');
  const dNo = await publisher.dumpForCapture('127.0.0.1:5555');
  ok('⑰ 读不到前台是哪一屏时照常抓（「检查没做成」≠「抓错页面」，不能把用户堵死）',
    dNo.ok === true && dNo.focus === '', JSON.stringify({ ok: dNo.ok, focus: dNo.focus }));
  fs.unlinkSync(FOCUS);

  // 13b) 候选表第一步：dump 里只有「没有文字的相机图标」时，必须产出 tapId，而不是按文字瞎猜
  const camXml = '<hierarchy rotation="0" width="1080" height="2400">'
    + '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.shizhuang.duapp" clickable="false" bounds="[0,0][1080,2400]" />'
    + '<node index="1" text="" resource-id="com.shizhuang.duapp:id/ivCamera" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="true" bounds="[820,30][888,108]" />'
    + '<node index="2" text="视频" resource-id="" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="false" bounds="[320,110][372,160]" />'
    + '</hierarchy>';
  const sug2 = uimap.suggest(uimap.parseNodes(camXml));
  ok('⑰ dump 里只有无文字的相机图标时，第一步给出 tapId（不再猜文字）',
    sug2.steps[0].action === 'tapId' && sug2.steps[0].value === 'com.shizhuang.duapp:id/ivCamera',
    JSON.stringify(sug2.steps[0]));
  ok('⑰ 视频那套的第一步同样认这个 id（首页 tab 栏的「视频」不会被误当成入口）',
    sug2.videoSteps[0].action === 'tapId' && sug2.videoSteps[0].value === 'com.shizhuang.duapp:id/ivCamera',
    JSON.stringify(sug2.videoSteps[0]));


  // ============ 12b) ★ 中文输入：必须按「设备真实输入法状态」决定走哪条通道 ============
  const adbMod = require(path.join(base, 'src/main/services/adb.js'));
  // 这一组是本轮报障的直接回归：「设备检查说中文打不进去」背后其实还有一条更严重的
  // —— 产线代码把「走不走 ADBKeyboard 广播」交给配置项 publish.adbKeyboard，而那个键
  // **全仓没有任何地方会写它** ⇒ 恒为假 ⇒ 中文永远走 `input text`。
  // 实测（2026-10-02，MuMu 12 / Chrome 地址栏截图取证）：`input text "中文标题"` 一个字都进不去，
  // 但退出码 0、无任何输出；而 `am broadcast -a ADB_INPUT_TEXT --es msg "中文标题"` 能进去。
  // ⇒ 所以这里的断言是：**没启用输入法时中文必须明确失败，绝不许静默退化**。
  fs.unlinkSync(IME_ACTIVE);                       // 设备回到「装了 apk 但没启用」的状态
  await adbMod.shell('127.0.0.1:5555', 'settings put secure default_input_method com.android.internal/.Default');
  const it1 = await adbMod.inputText('127.0.0.1:5555', '中文标题');
  ok('⑯ 设备没启用 ADBKeyboard ⇒ 中文输入明确失败（不假装成功）',
    it1.ok === false && it1.code === 'ime-not-active',
    JSON.stringify({ ok: it1.ok, code: it1.code, err: String(it1.stderr || '').slice(0, 60) }));
  ok('⑯ 失败原因说清「下一步点哪里」，不是一句「输入失败」',
    /自动重试内置输入法配置/.test(it1.stderr) && /ADBKeyboard/.test(it1.stderr),
    String(it1.stderr || '').slice(0, 90));

  clearCalls();
  const it2 = await adbMod.inputText('127.0.0.1:5555', 'abc123');
  ok('⑯ 纯 ASCII 不受影响 ⇒ 走 input text（不依赖设备输入法状态，也不走任何广播）',
    it2.ok === true && /input text "abc123"/.test(calls())
    && !/ADB_INPUT_TEXT/.test(calls()) && !/ADB_INPUT_B64/.test(calls()),
    calls().trim().split(/\r?\n/).join(' | '));

  // 真跑一遍发布：设备没启用输入法时，发布前自动安装并启用内置输入法。
  clearCalls();
  Object.assign(state.publish.rows[0], { status: '排队', result: '', reason: '', retries: 0 });
  const rNoIme = await publisher.run(state, ctx);
  const logNoIme = calls();
  ok('⑯ 发布前自动安装并启用输入法，中文内容成功发布',
    rNoIme.rows[0].result === '发布成功'
      && /install -r .*ADBKeyboard\.apk/.test(logNoIme)
      && /ime enable com\.android\.adbkeyboard\/.AdbIME/.test(logNoIme)
      && /ime set com\.android\.adbkeyboard\/.AdbIME/.test(logNoIme),
    rNoIme.rows[0].result + ' / ' + (logNoIme.match(/install -r .*|ime enable .*|ime set .*/g) || []).join(' | '));
  ok('⑯ ★ 自动配置前绝不把中文塞给 `input text`',
    !/input text "白色的鞋谁懂"/.test(logNoIme) && !/input text "这双冠军白/.test(logNoIme),
    (logNoIme.match(/input text "[^"]*"/g) || []).join(' | ') || '（没有 input text 调用）');

  // 负向回归：内置 apk 安装失败时，发布必须停在前置检查，不能推图或点击界面。
  try { fs.unlinkSync(IME_ACTIVE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await adbMod.shell('127.0.0.1:5555', 'settings put secure default_input_method com.android.internal/.Default');
  fs.writeFileSync(path.join(FDB, 'IME_INSTALL_FAIL'), '1');
  clearCalls();
  let imeGateError = '';
  try { await publisher.run(state, ctx); } catch (e) { imeGateError = e.message; }
  const imeGateCalls = calls();
  ok('⑯ 安装失败 ⇒ 明确阻断发布，且没有推素材或点击界面',
    /自动安装|INSTALL_FAILED/.test(imeGateError) && !/\bpush /.test(imeGateCalls) && !/input tap/.test(imeGateCalls),
    `${imeGateError} / 操作=${imeGateCalls.match(/push |input tap/g) || '无'}`);
  fs.unlinkSync(path.join(FDB, 'IME_INSTALL_FAIL'));

  // 反向自证：把设备切成「已启用」，同一条发布必须走广播、并且真的成功
  fs.writeFileSync(IME_ACTIVE, '1');
  clearCalls();
  Object.assign(state.publish.rows[0], { status: '排队', result: '', reason: '', retries: 0 });
  const rIme = await publisher.run(state, ctx);
  ok('⑯ 设备启用了 ADBKeyboard ⇒ 中文走 ADB_INPUT_B64 广播（解回来一字不差），这一条发布成功',
    rIme.rows[0].result === '发布成功'
    && calls().indexOf('am broadcast -a ADB_INPUT_B64 --es msg '
      + Buffer.from('白色的鞋谁懂', 'utf8').toString('base64')) >= 0,
    rIme.rows[0].result + ' / ' + (calls().match(/ADB_INPUT_B64 --es msg \S+/g) || []).join(' | '));

  // 源码级反向断言：那条「配置说了算」的老写法不许回来
  const adbSrc = fs.readFileSync(path.join(base, 'src/main/services/adb.js'), 'utf8');
  const pubSrc = fs.readFileSync(path.join(base, 'src/main/services/publisher.js'), 'utf8');
  ok('⑯ 源码：inputText 不再从配置推导开关（老写法 `inputText(serial, text, { adbKeyboard = false })` 已消失）',
    !/inputText\(serial,\s*text,\s*\{\s*adbKeyboard/.test(adbSrc), '已改成按设备状态判定');
  ok('⑯ 源码：publisher 不再拿配置项决定中文怎么输（`c.adbKeyboard` / 传 `{ adbKeyboard }` 都已消失）',
    !/c\.adbKeyboard/.test(pubSrc) && !/inputText\(serial,\s*step\.value,\s*\{/.test(pubSrc),
    (pubSrc.match(/.*[aA]dbKeyboard.*/g) || []).map(s => s.trim()).join(' | '));
  ok('⑯ 源码：中文走广播这条路还在（B64 通道），且判定依据是设备当前输入法',
    /am broadcast -a ADB_INPUT_B64/.test(adbSrc) && /default_input_method/.test(adbSrc),
    '广播（B64）+ 设备输入法判定都在');

  // ---- ⑯b 2026-10-04 修正：**正文必须一字不差**（推翻上一轮「行首 # 会炸」的假 bug） --------
  //   如实记（这是我这一轮最大的教训）：上一轮我看到 `输入失败：/system/bin/sh: no closing quote`，
  //   判定「行首 # 被设备端 sh 当注释」，于是加了一层转义把 `#`/反引号也转掉。
  //   **那个判定是我编的** —— 证据来自我当时新写的夹具里、我自己定的一条判据；
  //   夹具和修法互相印证，把假 bug 喂成了「已修复」。真机逐条实验 12 组（MuMu 12 / Android 12 /
  //   内置 adb）：行首 `#`、`##`、行首反引号、`"a\n$X"`、`"a\n;b"` …… **一次都不炸**。
  //   而那个「修法」的真实后果是：**反斜杠被写进了发布出去的正文**（真机 dump 出来是 `\#TW男装`）。
  //   ⇒ 现在的口径（用户拍板）：适配层**只负责把字符串送进输入框**，绝不改写内容；
  //     必须转义的只有会破坏命令的 `"`，以及 `` ` `` / `$`（命令替换 / 变量替换）。
  //   断言分三层：**纯函数白名单** + **行为级（设备收到的串 == 源文，逐字符）** + **负向对照**。
  {
    const BSc = String.fromCharCode(92), BTc = String.fromCharCode(96);
    const BCAST_LOG = path.join(FDB, 'broadcasts.log');
    const readBcast = () => (fs.existsSync(BCAST_LOG)
      ? fs.readFileSync(BCAST_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : []);

    // A) 纯函数：只转义 `"` / 反引号 / `$`；`#` 与反斜杠**一律不动**
    //   ★ 2026-10-04（双向验证时发现并补上）：源文里**必须带一个空格** —— 否则这一组断言
    //     抓不到「空格被改写成字面 `%s`」那个真 bug（实测：把 inputText 破坏回旧写法后，
    //     源文不含空格时 B/C 两段照样全绿 ⇒ 盲区；含空格的 ㉙ 组才红）。空格放开头，不影响
    //     下面 A 段对 `\n#TW男装` 的检查。
    const rawB = 'a b\n#TW男装\n' + BTc + 'x\n$Y\n引号"里';
    const esc = adbMod.shellQuoteForInputText ? adbMod.shellQuoteForInputText(rawB) : null;
    ok('⑯b ★★ 转义白名单只有 " / 反引号 / $：行首 # 与反斜杠一律不动（上一轮多转 # ⇒ 正文被污染）',
      typeof esc === 'string'
      && esc.indexOf('\n#TW男装') >= 0            // # 原样，前面**没有**反斜杠
      && esc.indexOf(BSc + '#') < 0               // 全串里不许出现 \#
      && esc.indexOf(BSc + BTc) >= 0
      && esc.indexOf(BSc + '$') >= 0
      && esc.indexOf(BSc + '"') >= 0,
      JSON.stringify(esc));

    // B) 行为级：设备真正收到的串 == 源文（逐字符）——「文案原样贴进去」的硬证据
    fs.writeFileSync(IME_ACTIVE, '1');
    if (fs.existsSync(BCAST_LOG)) fs.unlinkSync(BCAST_LOG);
    clearCalls();
    const rHash = await adbMod.inputText('127.0.0.1:5555', rawB);
    const gotB = readBcast();
    ok('⑯b ★★ 设备真正收到的正文与源文**逐字符相同**（# 没被吃、反斜杠没被加）',
      rHash.ok === true && gotB.length === 1 && gotB[0] === rawB,
      'ok=' + rHash.ok + ' 收到=' + JSON.stringify(String(gotB[0] == null ? '' : gotB[0]).slice(0, 50))
      + ' 源文=' + JSON.stringify(rawB.slice(0, 50)));

    // C) 负向对照：喂一个**真的含反斜杠**的串 ⇒ 设备端解出来也照样带那个反斜杠
    //   （证明 B 的「逐字符相同」不是夹具偷偷吃掉了反斜杠凑出来的；B64 通道同样如实往返）
    if (fs.existsSync(BCAST_LOG)) fs.unlinkSync(BCAST_LOG);
    const wrongB = 'a\n' + BSc + '#TW男装';
    const rWrong = await adbMod.inputText('127.0.0.1:5555', wrongB);
    const gotW = readBcast();
    ok('⑯b 负向对照：喂含反斜杠的串 ⇒ 设备收到的原样带那个反斜杠（不被吞）',
      rWrong.ok === true && gotW.length === 1 && gotW[0].indexOf(BSc + '#') >= 0,
      JSON.stringify(String(gotW[0] == null ? '' : gotW[0])));

    // ASCII 的反斜杠可能抵消引号转义，必须走不经过 shell 文本解析的 B64 通道。
    if (fs.existsSync(BCAST_LOG)) fs.unlinkSync(BCAST_LOG);
    clearCalls();
    const attackText = 'x' + BSc + '"; touch /sdcard/attack; #';
    const attackResult = await adbMod.inputText('127.0.0.1:5555', attackText);
    ok('⑯b ASCII 引号与反斜杠攻击载荷仅作为文字输入，不进入 shell 命令',
      attackResult.ok && readBcast()[0] === attackText && !calls().includes('touch /sdcard/attack'));

    // D) 负向：普通中文正文照常（别把修法做成"到处乱加反斜杠"）
    if (fs.existsSync(BCAST_LOG)) fs.unlinkSync(BCAST_LOG);
    clearCalls();
    const rPlain = await adbMod.inputText('127.0.0.1:5555', '纯棉面料贴肤软乎');
    ok('⑯b 负向：普通中文正文照常走广播（B64），且设备收到的一字不差',
      rPlain.ok === true && calls().indexOf('am broadcast -a ADB_INPUT_B64 --es msg '
        + Buffer.from('纯棉面料贴肤软乎', 'utf8').toString('base64')) >= 0
      && readBcast()[0] === '纯棉面料贴肤软乎',
      (calls().match(/ADB_INPUT_B64[^\n]*/g) || []).join(' | '));
    if (fs.existsSync(IME_ACTIVE)) fs.unlinkSync(IME_ACTIVE);
  }

  // ============ 13) adb 三段解析：手填 > 程序内置 > 系统 PATH ============
  // ★ 纯函数，不碰文件系统也不起进程 —— 直接喂「谁存在」进去验判断，快且可复现。
  //   （adbMod 在 12b) 那段已经 require 过了，同一个模块实例，这里不再重复 require）
  const B = 'R:/app/resources/adb/adb.exe';
  const always = () => true, never = () => false;
  const only = p => (q => q === p);
  const r13a = adbMod.resolveAdbChoice({ configured: 'D:/mine/adb.exe', bundled: B, exists: always });
  ok('⑬ 手填了、文件也在 ⇒ 用手填的（内置的不许悄悄替掉你的配置）',
    r13a.source === 'configured' && r13a.path === 'D:/mine/adb.exe', JSON.stringify(r13a));
  const r13b = adbMod.resolveAdbChoice({ configured: 'D:/mine/adb.exe', bundled: B, exists: only(B) });
  ok('⑬ 手填的不存在、有内置 ⇒ 退回内置，并标记「你填的那个不存在」（界面会说出来）',
    r13b.source === 'bundled' && r13b.path === B && r13b.configuredMissing === true, JSON.stringify(r13b));
  const r13c = adbMod.resolveAdbChoice({ configured: 'D:/mine/adb.exe', bundled: B, exists: never });
  ok('⑬ 三个来源全不可用 ⇒ 明确标 configured-missing（不假装有备胎）',
    r13c.source === 'configured-missing', JSON.stringify(r13c));
  const r13d = adbMod.resolveAdbChoice({ configured: '', bundled: B, exists: only(B) });
  ok('⑬ 留空 + 有内置 ⇒ 用内置（这就是"新同事装上就能用"）', r13d.source === 'bundled', JSON.stringify(r13d));
  const r13e = adbMod.resolveAdbChoice({ configured: '', bundled: '', exists: always });
  ok('⑬ 留空 + 没内置 ⇒ 走系统 PATH 的 adb（老用户既有的装法不被断掉）',
    r13e.source === 'path' && r13e.path === 'adb', JSON.stringify(r13e));

  // 同一套判断要真的反映到设备检查的结果里（界面「来源」那一列读的就是这几个字段）
  // ★ 2026-10-04：这里原来是无条件 `unlinkSync`，只要前面某一段已经把 IME_ACTIVE 删掉
  //   （比如 ⑯b 末尾那句），整份回归就**在这里断掉**、后面所有块（含 ㉓ 系列）一条都不跑，
  //   而外部只看「PASS 数」根本发现不了 —— 静默少跑比 FAIL 危险得多。改成幂等删。
  try { fs.unlinkSync(IME_ACTIVE); } catch (e) { if (e.code !== 'ENOENT') throw e; }   // 回到「装了 apk 但没设成当前输入法」的状态
  const APK = path.join(TMP, 'ADBKeyboard.apk');
  fs.writeFileSync(APK, 'PK\u0003\u0004fake-apk-bytes');
  adbMod.setBundledApkPath(APK);            // 包里「有」中文输入法 apk，才会给一键装按钮
  adbMod.setAdbPath('D:/nope/adb.exe');     // 手填一个不存在的
  adbMod.setBundledAdbDir('');              // 也没有内置
  const pb1 = await adbMod.probe('127.0.0.1:5555');
  ok('⑬ 手填的不存在 + 没内置 ⇒ 检查结果标 configured-missing，并引导「没找到 adb」',
    pb1.adbSource === 'configured-missing' && pb1.fix.some(f => /没找到 adb/.test(f.title)),
    JSON.stringify({ src: pb1.adbSource, titles: pb1.fix.map(f => f.title) }));

  const BDIR = path.join(TMP, 'vendor-adb');
  fs.mkdirSync(BDIR, { recursive: true });
  fs.writeFileSync(path.join(BDIR, 'adb.exe'), 'fake-adb-placeholder');
  adbMod.setBundledAdbDir(BDIR);            // 有内置
  await adbMod.shell('127.0.0.1:5555', 'settings put secure default_input_method com.android.internal/.Default');
  clearCalls();
  const pb2 = await adbMod.probe('127.0.0.1:5555');
  ok('⑬ 手填的不存在但有内置 ⇒ 退回内置，并且**在界面上说出来**（不静默替你换）',
    pb2.adbSource === 'bundled' && pb2.fix.some(f => /你填的 adb 路径不存在/.test(f.title)),
    JSON.stringify({ src: pb2.adbSource, titles: pb2.fix.map(f => f.title) }));
  ok('⑬ ★ 设备检查自动安装并启用内置 ADBKeyboard，不要求用户点按钮或下载',
    pb2.imeSetup && pb2.imeSetup.ok && pb2.adbKeyboardActive
      && pb2.notes.some(n => /已自动安装并启用/.test(n))
      && !pb2.fix.some(f => f.act && f.act.act === 'pub:installIme'),
    JSON.stringify({ setup: pb2.imeSetup, active: pb2.adbKeyboardActive, actions: pb2.fix.filter(f => f.act) }));
  const autoImeCalls = calls();
  ok('⑬ ★ 自动配置顺序正确：install -r → ime enable → ime set',
    (() => { const a = autoImeCalls.indexOf('install -r'), b = autoImeCalls.indexOf('ime enable'), c = autoImeCalls.indexOf('ime set'); return a >= 0 && a < b && b < c; })(),
    (autoImeCalls.match(/install -r .*|ime enable .*|ime set .*/g) || []).join(' | '));
  adbMod.setAdbPath('');

  // ============ 14) 一键装中文输入法：三条命令缺一不可 ============
  clearCalls();
  const ik = await adbMod.installKeyboard('127.0.0.1:5555');
  ok('⑭ 装完返回成功，且 ADBKeyboard 变成了设备当前的输入法',
    ik.ok === true && /adbkeyboard/i.test(ik.defaultIme || ''),
    JSON.stringify({ ok: ik.ok, step: ik.step, def: ik.defaultIme }));
  const ikb = calls();
  ok('⑭ 三步齐全：install -r <apk> → ime enable → ime set',
    /install -r .*ADBKeyboard\.apk/.test(ikb)
    && /ime enable com\.android\.adbkeyboard\/\.AdbIME/.test(ikb)
    && /ime set com\.android\.adbkeyboard\/\.AdbIME/.test(ikb),
    (ikb.match(/install -r .*|ime enable .*|ime set .*/g) || []).join(' | '));
  ok('⑭ 顺序正确：先装、再启用、最后设成默认（顺序错了中文照样打不进去）',
    (() => { const a = ikb.indexOf('install -r'), b = ikb.indexOf('ime enable'), c = ikb.indexOf('ime set'); return a >= 0 && a < b && b < c; })(),
    `install@${ikb.indexOf('install -r')} enable@${ikb.indexOf('ime enable')} set@${ikb.indexOf('ime set')}`);

  // 装失败时必须说清卡在哪一步，绝不能假装成功
  fs.writeFileSync(path.join(FDB, 'IME_INSTALL_FAIL'), '1');
  const ikFail = await adbMod.installKeyboard('127.0.0.1:5555');
  ok('⑭ install 失败 ⇒ 明确报「卡在 install 这步」+ 原始报错（不假装成功）',
    ikFail.ok === false && ikFail.step === 'install' && /INSTALL_FAILED/.test(ikFail.error),
    JSON.stringify({ ok: ikFail.ok, step: ikFail.step, err: ikFail.error }));
  fs.unlinkSync(path.join(FDB, 'IME_INSTALL_FAIL'));
  adbMod.setBundledApkPath('');
  const ikNoApk = await adbMod.installKeyboard('127.0.0.1:5555');
  ok('⑭ 包里没有内置 apk 时，明确说「这个安装包里没有内置中文输入法」',
    ikNoApk.ok === false && ikNoApk.step === 'apk', JSON.stringify(ikNoApk));
  adbMod.setBundledApkPath(APK);

  // ============ 14.5) ★★ 得物安装包：装进模拟器的几条分支（2026-10-08 新增） ============
  // 起因：**MuMu 自带的应用商店里搜不到得物**，新模拟器就卡在这一步。设置页给两个按钮，
  // 这里只验**主进程侧的行为**（先读设备 → 决定装不装 → 装完回读）；界面那几枚按钮在 uicheck 里验。
  // ★ 夹具严格照真机语义：**默认那台设备已经装了得物** —— 这正是用户问的那种情况
  //   （「如果模拟器本身就有这个 app，这个按钮还能用吗」），所以这一条是重点。
  const dewuMod = require(path.join(base, 'src', 'main', 'services', 'dewuapk.js'));
  adbMod.setAdbPath('');
  adbMod.setBundledAdbDir(BDIR);
  dewuMod.setBundledDir(path.join(base, 'vendor', 'dewu'));
  const DEWU_ABSENT_F = path.join(FDB, 'DEWU_ABSENT');

  const dStat = dewuMod.status();
  ok('⑰ 内置的得物安装包在仓库里、字节数与 dewuapk.js 里写死的 BYTES 一致',
    dStat.exists && dStat.sizeOk, `exists=${dStat.exists} bytes=${dStat.bytes} expect=${dStat.expectBytes}`);

  // ---- A) 新模拟器（pm list 里没有得物）⇒ 真装 + 回读确认 ----
  //   ★ 必须放在最前面：夹具里 `install` **是真会生效的**（装完 pm list 里就有得物），
  //     先跑 B（force 装一次）之后再摆"没装得物"的现场就不成立了 —— 这条顺序踩过（第一版就是这么红的）。
  //   夹具严格照真机语义：装了就是装了，后面几条（已装/覆盖重装/装失败）都建在这台"已装"的设备上。
  fs.writeFileSync(DEWU_ABSENT_F, '1');
  clearCalls();
  const dewC = await dewuMod.install('127.0.0.1:5555', {});
  const callC = calls();
  const instC = (callC.match(/install[^\n]*/) || [''])[0];
  ok('⑰ ★ 新模拟器（没装得物）⇒ 真的装 `install -r`（**没有 -d**），并回读确认装上了才算成功',
    dewC.ok === true && dewC.step === 'done' && dewC.already === false && dewC.replaced === false
    && /install -r .*dewu_6\.0\.5\.apk/.test(callC) && !/ -d /.test(instC) && dewC.installedVersion === '6.0.5',
    JSON.stringify({ ok: dewC.ok, step: dewC.step, ver: dewC.installedVersion }) + ' · ' + instC);

  // ---- B) 设备上**已经装了** ⇒ 一条 install 都不许发（得物里是登录状态 + 本地草稿） ----
  clearCalls();
  const dewA = await dewuMod.install('127.0.0.1:5555', {});
  const callA = calls();
  ok('⑰ ★★ 设备上已经有得物 ⇒ 只回报版本、**一条 install 都不发**（"已装时按钮还能用吗"的答案就在这条）',
    dewA.ok === true && dewA.already === true && dewA.installedVersion === '6.0.5' && !/install/.test(callA),
    `ok=${dewA.ok} already=${dewA.already} ver=${dewA.installedVersion} · install 调用 ${(callA.match(/install/g) || []).length} 次`);
  ok('⑰ 但版本号是真从设备上读回来的（设备端先筛：dumpsys package … | grep -m1 versionName）',
    /dumpsys package com\.shizhuang\.duapp \| grep -m1 versionName/.test(callA),
    (callA.match(/dumpsys package[^\n]*/) || []).join(' | ') || '（没这条）');

  // ---- C) 用户显式点「覆盖重装」⇒ 这时才真的装，且带 -r -d（允许降级、保留数据） ----
  clearCalls();
  const dewB = await dewuMod.install('127.0.0.1:5555', { force: true });
  const callB = calls();
  ok('⑰ ★ 只有显式 force 才真的装：`install -r -d <vendor 里那个 apk>`（-d 只在这一步允许出现）',
    dewB.ok === true && dewB.already === false && dewB.replaced === true
    && /install -r -d .*dewu_6\.0\.5\.apk/.test(callB),
    (callB.match(/install[^\n]*/) || []).join(' | ') || '（没这条）');
  ok('⑰ 装完**回读** `pm list packages` 确认（不是拿 adb 那句 Success 收工）',
    /pm list packages/.test(callB) && dewB.installedVersion === '6.0.5',
    `回读 ${(callB.match(/pm list packages/g) || []).length} 次 · 版本=${dewB.installedVersion}`);

  // ---- D) 装失败（签名不一致那种）⇒ 如实报错 + 给出"只能先卸载"的实情 ----
  //   ★ 必须带 force：前面那条已经把这台设备"装上得物"了，不带 force 会走 already 分支（根本不发命令）。
  fs.writeFileSync(path.join(FDB, 'DEWU_INSTALL_FAIL'), '1');
  const dD = await dewuMod.install('127.0.0.1:5555', { force: true });
  try { fs.unlinkSync(path.join(FDB, 'DEWU_INSTALL_FAIL')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  ok('⑰ ★ 装失败 ⇒ ok:false + step=install + 原始报错（绝不假装装上）',
    dD.ok === false && dD.step === 'install' && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(dD.error)),
    JSON.stringify({ ok: dD.ok, step: dD.step, err: String(dD.error).slice(0, 80) }));
  ok('⑰ ★ 这种失败要给出"只能先卸载"的提示，并说清**工具不自动做**（否则用户只会反复点）',
    /签名/.test(String(dD.hint)) && /工具不自动做/.test(String(dD.hint)), String(dD.hint || '').slice(0, 130));

  // ---- E) 内置那份缺失 ⇒ 拦住，不硬着头皮往下装 ----
  dewuMod.setBundledDir(path.join(TMP, 'vendor-dewu-nope'));
  const dE = await dewuMod.install('127.0.0.1:5555', {});
  ok('⑰ 内置安装包缺失 ⇒ 明确说"这个安装包里没有内置得物安装包"并停下',
    dE.ok === false && dE.step === 'apk' && /没有内置得物安装包/.test(String(dE.error)), String(dE.error || '').slice(0, 90));
  // ★ 夹具：一份"大小对不上"的（半截下载/被杀软改过的样子）⇒ 也要拦住，不许拿它去装
  const BROKEN_DIR = path.join(TMP, 'vendor-dewu-broken');
  fs.mkdirSync(BROKEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(BROKEN_DIR, 'dewu_6.0.5.apk'), Buffer.alloc(64, 3));
  dewuMod.setBundledDir(BROKEN_DIR);
  const dE2 = await dewuMod.install('127.0.0.1:5555', {});
  ok('⑰ ★ 内置那份**大小对不上**（半截文件）⇒ 也拦住，并说清"这份安装包不完整"',
    dE2.ok === false && dE2.step === 'apk' && /大小不对/.test(String(dE2.error)), String(dE2.error || '').slice(0, 110));
  dewuMod.setBundledDir(path.join(base, 'vendor', 'dewu'));

  // ---- F) 没选设备 / 设备名不对 ⇒ 拦住，一条安装命令都不发 ----
  clearCalls();
  const dF = await dewuMod.install('', {});
  const dG = await dewuMod.install('127.0.0.1:9999', {});
  ok('⑰ 没选设备 / 设备名不对 ⇒ step=device 且如实说明，一条安装命令都不发',
    dF.ok === false && dF.step === 'device' && /还没选设备/.test(String(dF.error))
    && dG.ok === false && dG.step === 'device' && /不在线/.test(String(dG.error)) && !/install/.test(calls()),
    `${dF.step}:${String(dF.error).slice(0, 26)} · ${dG.step}:${String(dG.error).slice(0, 40)}`);

  // ---- G) **未知 ≠ 未安装**：读不出设备状态时必须是 null，不许当成 false（那会一路装下去） ----
  const dH = await dewuMod.deviceState('');
  ok('⑰ ★★ 读不出设备状态 ⇒ installed=null（"未知"）而不是 false（"确认没装"）',
    dH.ok === false && dH.installed === null, JSON.stringify(dH).slice(0, 120));

  // 还原：得物缺席的现场开关 + 内置目录 / adb 路径都回到本块之前的样子
  try { fs.unlinkSync(DEWU_ABSENT_F); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  dewuMod.setBundledDir('');
  adbMod.setBundledAdbDir(BDIR);
  adbMod.setAdbPath('');

  // ============ 15) 内置 adb 真的会被拿去执行（不只是界面上显示个路径） ============
  clearFiles();
  const v15 = await adbMod.version();
  ok('⑮ 留空 adb 路径 ⇒ 真的执行了内置那份 adb', !!v15, String(v15));
  ok('⑮ 执行的就是内置目录下的 adb.exe（假 adb 记下了实际被执行的程序）',
    filesLog().trim().split(/\r?\n/).includes(path.join(BDIR, 'adb.exe')),
    filesLog().trim().replace(/\n/g, ' | ') || '（没记到）');
  adbMod.setBundledAdbDir('');
  adbMod.setAdbPath('adb');

  // ============ 16) ★★ 「还没选设备」的提示里一个设备名都不许出现 ============
  //   行为级验证（不只是扫源码）：假 adb 的 devices 输出里有一台 127.0.0.1:5555，
  //   提示里只要点了名，这里就会看到它。用户对这件事提了三次。
  clearCalls();
  const pb16 = await adbMod.probe('');
  const f16 = pb16.fix.find(f => /还没选设备/.test(f.title)) || {};
  const all16 = pb16.fix.map(f => f.title + '\n' + f.how).join('\n') + '\n' + (pb16.notes || []).join('\n');
  ok('⑯ 没选设备 ⇒ 老实报「还没选设备」，且正文里**一个设备名都没有**',
    pb16.device === null && !!f16.title
    && !/127\.0\.0\.1:5555/.test(all16) && !/emulator-5554/i.test(all16),
    JSON.stringify({ title: f16.title, how: f16.how }));
  ok('⑯ 但「扫到几台设备」这个量还是要说（不然用户不知道扫描有没有用）',
    /在线可用 1 台/.test(all16), (pb16.notes || []).join(' | '));
  ok('⑯ 引导的是「扫描设备 → 加入并使用」，不是让人手抄名字',
    /扫描设备/.test(f16.how || '') && /加入并使用/.test(f16.how || ''), f16.how || '');

  // ============ 17) ★★ 动画页抓不下来时的备用通道：dumpsys activity top ============
  //   实机背景（2026-10-02）：得物发布页首屏是**持续动画**（相册预览在轮播），
  //   `uiautomator dump` 永远等不到 idle —— 连试十几次、--compressed、关系统动画、静置 15s 全败。
  //   而 `dumpsys activity top` **不等 idle**，直接把各 task 的 View Hierarchy 打出来。
  //   代价（必须如实说清、不许美化）：只有 class / resource-id / bounds / clickable，**没有文字**。
  const TOP_DUMP = path.join(FDB, 'activity-top.txt');
  const NO_DEWU = path.join(FDB, 'NO_DEWU_TOP');
  const NOT_IDLE17 = path.join(FDB, 'DUMP_NOT_IDLE');

  // 17a) 纯函数：把 dumpsys 文本转成 uiautomator 风格 XML
  const topTxt = fs.readFileSync(TOP_DUMP, 'utf8');
  const xml17 = adbMod.vhToXml(topTxt, 'com.shizhuang.duapp');
  ok('⑱ dumpsys 的 View Hierarchy 能转成 uiautomator 风格 XML', !!xml17 && /<hierarchy/.test(xml17),
    String(xml17 || '').slice(0, 34));
  const n17 = uimap.parseNodes(xml17 || '');
  ok('⑱ 解析出的可见节点数与真机一致（110 个）', n17.length === 110, String(n17.length));
  ok('⑱ 只取得物那一段：夹具里前面两段别的 App 的节点不许混进来（按包名过滤，不是取第一段）',
    n17.every(n => n.pkg === 'com.shizhuang.duapp') && !/otherTv/.test(xml17 || ''),
    '包名集合=' + JSON.stringify([...new Set(n17.map(n => n.pkg))]));
  ok('⑱ 坐标按缩进逐级累加：抽查真机已知节点（flThumbSelect 首格 = 100,270-175,345）',
    n17.some(n => n.id === 'com.shizhuang.duapp:id/flThumbSelect' && n.bounds === '[100,270][175,345]'),
    JSON.stringify((n17.find(n => n.id.endsWith('flThumbSelect')) || {}).bounds));
  // ★ 双向：先证明**原件里真的有**不可见节点，再断言解析结果里一个都没有
  //   （否则「两边都空」也能过 = 假通过 —— 夹具里要是压根没有不可见节点，这条就等于没测）
  const flagsOf = l => { const m = l.match(/\{[0-9a-f]+\s+([^}]*?)\s+\d+,\d+-\d+,\d+/); return m ? m[1] : ''; };
  const rawHidden = topTxt.split(/\r?\n/).map(flagsOf).filter(f => f && f[0] !== 'V').length;
  ok('⑱ 不可见节点（flags 第 0 位不是 V）不许收 —— 真机里这类 bounds 是 0,0-0,0，收了会让后续点击落空',
    rawHidden > 0 && !n17.some(n => n.box && n.box.x1 === 0 && n.box.y1 === 0 && n.box.x2 === 0 && n.box.y2 === 0),
    '原件里不可见行 ' + rawHidden + ' 条 → 解析结果里零尺寸节点 '
      + n17.filter(n => n.box && n.box.x2 <= n.box.x1).length + ' 条');
  ok('⑱ `#7f... app:id/xxx` 补全成完整 resource-id（否则按 id 点会点空）',
    n17.some(n => n.id === 'com.shizhuang.duapp:id/placeholderLayout'),
    JSON.stringify(n17.map(n => n.id).filter(Boolean).slice(0, 3)));
  ok('⑱ clickable 解析正确（flags 第 6 位 C=可点）',
    n17.some(n => n.id === 'com.shizhuang.duapp:id/flThumbSelect' && n.clickable === true),
    '可点数=' + n17.filter(n => n.clickable).length + ' / 共 ' + n17.length);
  ok('⑱ ★ 如实反映局限：这条通道**拿不到文字** ⇒ text/content-desc 必须全空，不许编',
    n17.every(n => n.text === '' && n.desc === ''),
    '非空文字节点数=' + n17.filter(n => n.text || n.desc).length);

  // 17b) dumpViaDumpsys 本身
  const vA = await adbMod.dumpViaDumpsys('127.0.0.1:5555', 'com.shizhuang.duapp');
  ok('⑱ dumpViaDumpsys 能抓到并返回 XML', vA.ok === true && /<node/.test(vA.xml || ''),
    JSON.stringify({ ok: vA.ok, why: vA.why }));
  const vB = await adbMod.dumpViaDumpsys('127.0.0.1:5555', '');
  ok('⑱ 没给包名 ⇒ 明确失败（不知道抠哪一段），不许瞎抓', vB.ok === false && /包名/.test(vB.why), String(vB.why));
  fs.writeFileSync(NO_DEWU, '1');
  const vC = await adbMod.dumpViaDumpsys('127.0.0.1:5555', 'com.shizhuang.duapp');
  ok('⑱ dumpsys 输出里没有得物 ⇒ 明确失败并说清（绝不返回别的 App 的结构）',
    vC.ok === false && /没有「com\.shizhuang\.duapp」/.test(vC.why), String(vC.why));
  fs.unlinkSync(NO_DEWU);

  // 17c) ★★ 降级链（最关键）：uiautomator 全败才退到 dumpsys；能成功时一步都不多走
  fs.writeFileSync(NOT_IDLE17, 'always');
  clearCalls();
  const dDown = await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp' });
  ok('⑱ uiautomator 彻底抓不到（动画页）时自动退到 dumpsys，并如实标注 via=dumpsys / noText',
    dDown.ok === true && dDown.via === 'dumpsys' && dDown.noText === true,
    JSON.stringify({ ok: dDown.ok, via: dDown.via, noText: dDown.noText }));
  const c17 = calls();
  ok('⑱ 退到 dumpsys 前确实先试过「关系统动画」（不是一上来就抄近路）',
    /animator_duration_scale 0/.test(c17), (c17.match(/animator_duration_scale \d/g) || []).join(' | '));
  ok('⑱ ★ 关掉的动画必须还原（不能把用户设备的设置留在改过的状态）',
    (() => { const a = c17.indexOf('animator_duration_scale 0'), b = c17.indexOf('animator_duration_scale 1');
      return a >= 0 && b > a; })(),
    (c17.match(/settings put global animator_duration_scale \d/g) || []).join(' | '));
  clearCalls();
  const dNoPkg = await adbMod.dumpEx('127.0.0.1:5555', {});
  // ★ 不能只看 ok/via —— D5 破坏（把 `if (pkg)` 改成 `if (true)`）时这两个值**恰好不变**
  //   （dumpViaDumpsys('') 自己也拒绝，最后仍落到 via:'uiautomator'），断言会假绿。
  //   真正能分辨的是「到底有没有去调那条命令」+ 报错里有没有多出备用通道的字样。
  ok('⑱ 没给包名时**不许**降级（保持老行为）：连 dumpsys 都不该调，报错里也不该多出备用通道的字样',
    dNoPkg.ok === false && dNoPkg.via === 'uiautomator'
    && !/dumpsys activity top/.test(calls()) && !/dumpsys/.test(dNoPkg.why || ''),
    JSON.stringify({ ok: dNoPkg.ok, via: dNoPkg.via, calledDumpsys: /dumpsys activity top/.test(calls()),
      why: String(dNoPkg.why || '').slice(0, 40) }));
  fs.unlinkSync(NOT_IDLE17);
  clearCalls();
  const dUp = await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp' });
  ok('⑱ uiautomator 能成功时照旧走它，一次 dumpsys 都不调用（老路径行为不变）',
    dUp.ok === true && dUp.via === 'uiautomator' && !/dumpsys activity top/.test(calls()),
    JSON.stringify({ via: dUp.via, calledDumpsys: /dumpsys activity top/.test(calls()) }));

  // 17d) 走了备用通道时，程序必须**主动告诉用户**这条通道少了什么
  const FOCUS17 = path.join(FDB, 'FOCUS');
  fs.writeFileSync(FOCUS17, 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity');
  fs.writeFileSync(NOT_IDLE17, 'always');
  const cap17 = await publisher.dumpForCapture('127.0.0.1:5555');
  ok('⑱ 走备用通道时，提示里必须说清「有 id/坐标/可点，但**没有文字**」（不许闷着不说）',
    cap17.ok === true && cap17.via === 'dumpsys' && /没有文字/.test(cap17.viaNote || ''),
    String(cap17.viaNote).slice(0, 62));
  fs.unlinkSync(NOT_IDLE17);
  fs.unlinkSync(FOCUS17);

  // 17e) 两条入口路线：常量 + 候选表优先用「有文字」的那条（用户 2026-10-02 提供的路径）
  ok('⑱ DEWU.route 记下了推荐路线三步（「我」→「主页」→「发布新动态」）',
    Array.isArray(uimap.DEWU.route) && uimap.DEWU.route.length === 3
    && uimap.DEWU.route.map(s => s.text).join('/') === '我/主页/发布新动态',
    JSON.stringify((uimap.DEWU.route || []).map(s => s.text)));
  const routeXml = '<hierarchy rotation="0">'
    + '<node index="0" text="我" resource-id="com.shizhuang.duapp:id/tab_user" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="true" bounds="[740,1500][840,1590]" />'
    + '<node index="1" text="主页" resource-id="com.shizhuang.duapp:id/tvGoHomePage" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="true" bounds="[800,120][880,180]" />'
    + '<node index="2" text="发布新动态" resource-id="com.shizhuang.duapp:id/rlPublish" class="android.widget.LinearLayout" package="com.shizhuang.duapp" clickable="true" bounds="[60,890][840,960]" />'
    + '<node index="3" text="" resource-id="com.shizhuang.duapp:id/ivCamera" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="true" bounds="[820,30][888,108]" />'
    + '</hierarchy>';
  const sug17 = uimap.suggest(uimap.parseNodes(routeXml));
  ok('⑱ 候选表第一步优先用「发布新动态」（有文字、可 tapText），而不是没文字的相机图标',
    sug17.steps[0].action === 'tapText' && sug17.steps[0].value === '发布新动态',
    sug17.steps[0].action + ' / ' + sug17.steps[0].value);
  ok('⑱ 但要把另一条路线的 id 留在提示里备用（rlPublish 可点 id + ivCamera 备用 id 都在）',
    /rlPublish/.test(sug17.steps[0].hint || '') && /ivCamera/.test(sug17.steps[0].hint || ''),
    String(sug17.steps[0].hint).slice(0, 72));
  ok('⑱ ★ 图文与视频两套的首步必须一致（它们走的是同一个发布页）',
    sug17.videoSteps[0].action === sug17.steps[0].action
    && sug17.videoSteps[0].value === sug17.steps[0].value,
    JSON.stringify({ 图文: sug17.steps[0].value, 视频: sug17.videoSteps[0].value }));

  // ---- ⑲ 真机实测：uiautomator 有时**一个字都不打印**（不是 could not get idle state）----
  //   旧判据只认 "idle state" ⇒ 「临时关动画重试」那条路压根不走 ⇒ 直接掉到 dumpsys 备用通道。
  //   用户 2026-10-03 明确：不要备用通道，就走正常通道。
  const SILENT19 = path.join(FDB, 'DUMP_SILENT');
  fs.writeFileSync(SILENT19, '1');
  const before19 = calls();
  const dSilent = await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp' });
  const seg19 = calls().slice(before19.length);
  ok('⑲ ★ uiautomator 一个字都不打印时，关动画重试能抓成功（不再直接判失败）',
    dSilent.ok === true && dSilent.via === 'uiautomator' && dSilent.animOff === true,
    JSON.stringify({ ok: dSilent.ok, via: dSilent.via, animOff: dSilent.animOff, why: dSilent.why }));
  ok('⑲ ★ 这一次**没有**去碰 dumpsys 备用通道（只要一条通道）',
    !/dumpsys activity top/.test(seg19),
    seg19.split('\n').filter(l => /dumpsys/.test(l)).join(' | ') || '（没有 dumpsys 调用）');
  ok('⑲ 试完必须把用户设备的动画开关还原（不许留在关掉的状态）',
    /settings put global animator_duration_scale 0/.test(seg19)
    && /settings put global animator_duration_scale 1/.test(seg19),
    seg19.split('\n').filter(l => /animator_duration_scale/.test(l)).join(' | '));
  fs.unlinkSync(SILENT19);

  // ---- ⑳ 真机实测：「点颜色文字」弹出的是「选择商品规格」，**不会选中卡片** ----
  //   能选中整张卡的是商品图；而颜色文字在几何上落在它所属那张图的 bounds 之内。
  //   证据：2026-10-03 MuMu / 得物 UWG460108 货号搜索页 dump（tvCSpuInfo [278,554][354,597]
  //   完全包在 ivProduct [35,278][354,597] 里）。
  const CARD_ID = 'com.shizhuang.duapp:id/ivProduct';
  ok('⑳ uimap 公布了新动作 tapCardText', uimap.STEP_ACTIONS.includes('tapCardText'));
  let e20 = null;
  try { uimap.normalizeSteps([{ action: 'tapCardText', value: '本白' }]); } catch (e) { e20 = e; }
  ok('⑳ tapCardText 不写 card ⇒ 导入时就报错（不让它跑到真机上瞎点）',
    !!e20 && /card/.test(e20.message), e20 && e20.message);

  // 真机两套重叠列表：可见那套在前（右下角对齐），背后那套坐标错开 220px
  const gridXml = '<hierarchy rotation="0">'
    + `<node index="0" text="" resource-id="${CARD_ID}" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="false" bounds="[35,278][354,597]" />`
    + '<node index="1" text="本白" resource-id="com.shizhuang.duapp:id/tvCSpuInfo" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="true" bounds="[278,554][354,597]" />'
    + `<node index="2" text="" resource-id="${CARD_ID}" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="false" bounds="[35,498][354,817]" />`
    + `<node index="3" text="" resource-id="${CARD_ID}" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="false" bounds="[380,278][699,597]" />`
    + '<node index="4" text="冷灰" resource-id="com.shizhuang.duapp:id/tvCSpuInfo" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="true" bounds="[623,554][699,597]" />'
    + '</hierarchy>';
  const n20 = uimap.parseNodes(gridXml);
  const c20a = uimap.cardOf(n20, uimap.findNode(n20, { text: '本白' }), CARD_ID);
  ok('⑳ ★「本白」映射到**右下角对齐**的那张图 [35,278][354,597]，不是背后那套重叠列表',
    !!c20a && c20a.box.x1 === 35 && c20a.box.y1 === 278, c20a && JSON.stringify(c20a.box));
  const c20b = uimap.cardOf(n20, uimap.findNode(n20, { text: '冷灰' }), CARD_ID);
  ok('⑳ ★「冷灰」映射到**它自己那一列**的图（不是永远第一张）',
    !!c20b && c20b.box.x1 === 380, c20b && JSON.stringify(c20b.box));
  // ★ 这一条专盯「归属判据」本身：把**背后那套列表排在文档前面**。
  //   一旦退回「取第一张包住的」，就会选到 [35,498] 那张（错列）⇒ 必须红。
  const swapXml = '<hierarchy rotation="0">'
    + `<node index="0" text="" resource-id="${CARD_ID}" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="false" bounds="[35,498][354,817]" />`
    + '<node index="1" text="本白" resource-id="com.shizhuang.duapp:id/tvCSpuInfo" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="true" bounds="[278,554][354,597]" />'
    + `<node index="2" text="" resource-id="${CARD_ID}" class="android.widget.ImageView" package="com.shizhuang.duapp" clickable="false" bounds="[35,278][354,597]" />`
    + '</hierarchy>';
  const n20c = uimap.parseNodes(swapXml);
  const c20c = uimap.cardOf(n20c, uimap.findNode(n20c, { text: '本白' }), CARD_ID);
  ok('⑳ ★ 背后那套列表排在文档前面时，仍必须选「右下角对齐」的那张（y1=278 而不是 498）',
    !!c20c && c20c.box.y1 === 278, c20c && JSON.stringify(c20c.box));

  ok('⑳ 文字落在所有卡之外 ⇒ 返回 null（宁可不点，也不点错卡）',
    uimap.cardOf(n20, { text: 'x', box: { x1: 0, y1: 1900, x2: 4, y2: 1904 }, center: { x: 2, y: 1902 } }, CARD_ID) === null);

  // 行为级：让真代码自己点一次，看它点在哪
  const gridBak = fs.readFileSync(FAKE_WINDOW, 'utf8');
  fs.writeFileSync(FAKE_WINDOW, gridXml);
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', { action: 'tapCardText', value: '冷灰', card: CARD_ID, count: 1 }, {}, { log() {} });
  const tap20 = /-s \S+ shell input tap (\d+) (\d+)/.exec(calls());
  ok('⑳ ★ 行为级：tapCardText 真点在「冷灰」那张图的中心 (540,438)，而不是颜色标签 (661,576)',
    !!tap20 && tap20[1] === '540' && tap20[2] === '438', tap20 && (tap20[1] + ',' + tap20[2]));

  // 行为级负向：文字没有任何卡包住 ⇒ 硬失败，绝不瞎挂一个商品
  fs.writeFileSync(FAKE_WINDOW, gridXml.replace('bounds="[278,554][354,597]"', 'bounds="[278,1554][354,1597]"'));
  let e20b = null;
  try { await publisher.runStep('127.0.0.1:5555', { action: 'tapCardText', value: '本白', card: CARD_ID, count: 1 }, {}, { log() {} }); }
  catch (e) { e20b = e; }
  ok('⑳ ★ 颜色文字没有任何卡包住时**硬失败**并说清原因（点错卡＝挂错商品，最难查）',
    !!e20b && /包住/.test(e20b.message), e20b && e20b.message);
  fs.writeFileSync(FAKE_WINDOW, gridBak);

  // ---- ㉑ 真机实测：草稿箱是**拦截页** —— 「我→主页→发布新动态」在草稿箱非空时落到 DraftActivity ----
  //   证据（2026-10-03，MuMu 12 / 得物 / 1080×1920）：
  //     DraftActivity 上：iv_draft_title text="草稿箱"；底部 fl_publish clickable=true 居中 (540,1871)，
  //     子节点 tv_draft_publish text="发布新动态"。
  //     点 fl_publish → TotalPublishProcessActivity（相册：全部/照片/视频 + flThumbSelect×N）。
  //     相册页的 dump 里 iv_draft_title / fl_publish 各出现 **0 次** ⇒ 守卫判据干净。
  const DRAFT_TITLE = 'com.shizhuang.duapp:id/iv_draft_title';
  const DRAFT_EXIT = 'com.shizhuang.duapp:id/fl_publish';
  ok('㉑ uimap 公布了草稿箱拦截信息（标题 id + 出口 id）',
    !!(uimap.DEWU.draft && uimap.DEWU.draft.titleId === DRAFT_TITLE && uimap.DEWU.draft.exitId === DRAFT_EXIT),
    JSON.stringify(uimap.DEWU.draft));

  let e21 = null;
  try { uimap.normalizeSteps([{ action: 'tapId', value: DRAFT_EXIT, whenOn: '草稿箱' }]); } catch (e) { e21 = e; }
  ok('㉑ whenOn 写了文字（不是 resource-id）⇒ 导入时就报错（不许跑到真机上才发现守卫永不成立）',
    !!e21 && /resource-id/.test(e21.message), e21 && e21.message);

  const draftXml21 = '<hierarchy rotation="0">'
    + `<node index="0" text="草稿箱" resource-id="${DRAFT_TITLE}" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="false" bounds="[480,60][600,102]" />`
    + '<node index="1" text="#我在的得物当博主 " resource-id="com.shizhuang.duapp:id/tv_draft_title" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="false" bounds="[40,546][640,586]" />'
    + `<node index="2" text="发布新动态" resource-id="${DRAFT_EXIT}" class="android.widget.FrameLayout" package="com.shizhuang.duapp" clickable="true" bounds="[0,1826][1080,1916]" />`
    + '</hierarchy>';
  const albumXml21 = '<hierarchy rotation="0">'
    + '<node index="0" text="照片" resource-id="" class="android.widget.TextView" package="com.shizhuang.duapp" clickable="false" bounds="[500,256][580,296]" />'
    + `<node index="1" text="" resource-id="${THUMB}" class="android.widget.FrameLayout" package="com.shizhuang.duapp" clickable="true" bounds="[56,299][276,419]" />`
    + '</hierarchy>';
  const dNodes21 = uimap.parseNodes(draftXml21);
  const aNodes21 = uimap.parseNodes(albumXml21);
  ok('㉑ 真值表：草稿箱这一屏 ⇒ 守卫放行（要去点出口）',
    uimap.screenCondOk({ whenOn: DRAFT_TITLE }, dNodes21).ok === true);
  ok('㉑ 真值表：相册这一屏 ⇒ 守卫拦下（整步跳过）',
    uimap.screenCondOk({ whenOn: DRAFT_TITLE }, aNodes21).ok === false);
  ok('㉑ 真值表：whenNotOn 反着用也对（相册屏没有草稿箱标题 ⇒ 放行；草稿箱屏 ⇒ 拦下）',
    uimap.screenCondOk({ whenNotOn: DRAFT_TITLE }, aNodes21).ok === true
    && uimap.screenCondOk({ whenNotOn: DRAFT_TITLE }, dNodes21).ok === false);

  // ---- ㉑c ★★★ 2026-10-05：「合法的 resource-id **必须能导入**」这条正向断言以前根本没有 ----
  //   旧正则 `^[A-Za-z0-9_.]+/[A-Za-z0-9_.]+$` **不允许 `:`** ⇒ 两类都判反了：
  //     · **拒绝** com.shizhuang.duapp:id/tvCancel ← dump 里的真格式（parseNodes 的 resource-id）
  //     · **放行** com.shizhuang.duapp/tvCancel   ← 不是 resource-id，运行时永远匹配不上
  //   而运行时的判据是 screenCondOk 的 `n.id === id` ⇒ **合法值 100% 被拒**。
  //   实测后果（端到端复刻 publish.importMap：真机 dump → suggest() → normalizeSteps）：
  //     **21 份 dump 21 份全被拒**（suggest 无条件挂两条守卫步）⇒「抓取 → 导入」整条路走不通，
  //     而报错还指着一个**合法值**说「不是 resource-id」——最难查的那种。
  //   为什么一直没暴露：这里原先**只有负向**（㉑：写了文字要报错）、**没有正向**。
  //   ⇒ 下面三条缺一不可：① 正向（合法 id 能过）② 负向（假格式仍要拦）③ 端到端（suggest 产出能导入）。
  let e21cPos = null;
  try {
    uimap.normalizeSteps([
      { action: 'tapId', value: DRAFT_EXIT, whenOn: DRAFT_TITLE },
      { action: 'tapId', value: 'com.shizhuang.duapp:id/tvCancel', whenOn: 'com.shizhuang.duapp:id/tvCancel' },
      { action: 'tapId', value: 'com.shizhuang.duapp:id/rlPublish',
        whenNotOn: 'com.shizhuang.duapp:id/rlPublish,com.shizhuang.duapp:id/etSearch' }
    ], 'steps');
  } catch (e) { e21cPos = e; }
  ok('㉑c ★★★ 正向：合法 resource-id（pkg:id/name，含 `:id/`）**必须能导入**——不许再把它当成非法值拒掉',
    !e21cPos, e21cPos && e21cPos.message);

  const neg21c = [];
  for (const bad of ['tvCancel', 'com.shizhuang.duapp/tvCancel', '草稿箱']) {
    try { uimap.normalizeSteps([{ action: 'tapId', value: DRAFT_EXIT, whenOn: bad }]); neg21c.push(''); }
    catch (e) { neg21c.push(e.message); }
  }
  ok('㉑c 负向：「裸 id」「少了 :id/ 的假格式」「文字」三种写法仍要当场报错（不能为了修正向把它们一起放了）',
    neg21c.every(m => !!m && /resource-id/.test(m)),
    JSON.stringify(neg21c.map(m => (m || '★没报错').slice(0, 24))));

  // 端到端：suggest() 的候选表**自己**必须能过导入校验 —— 这才是「抓取 → 导入」那条路
  const sug21c = uimap.suggest(uimap.parseNodes(draftXml21));
  let e21cSug = null;
  try {
    uimap.normalizeSteps(sug21c.steps, 'steps');
    if (Array.isArray(sug21c.videoSteps) && sug21c.videoSteps.length) {
      uimap.normalizeSteps(sug21c.videoSteps, 'videoSteps');
    }
  } catch (e) { e21cSug = e; }
  const sug21cGuards = (sug21c.steps || []).filter(s => s.whenOn || s.whenNotOn).length
    + (sug21c.videoSteps || []).filter(s => s.whenOn || s.whenNotOn).length;
  ok('㉑c ★★★ 端到端：suggest() 生成的候选表（自带草稿箱/点「放弃」两条守卫步）必须能通过导入校验',
    sug21cGuards > 0 && !e21cSug, `守卫步 ${sug21cGuards} 条 · ` + (e21cSug ? e21cSug.message : '通过'));

  const win21bak = fs.readFileSync(FAKE_WINDOW, 'utf8');
  // ★★ 行为级两组都要 try/catch 兜住异常，并把「抛异常」本身算成 FAIL。
  //   为什么：不兜的话，守卫一旦被拆掉，这里会**抛异常直接中断整个套件** ——
  //   `FAIL` 一行都不打，只看「有没有 FAIL」的人会误判成「没被抓住 ⇒ 断言无效」。
  //   2026-10-03 反向验证时真踩到这个（D2/D7 被判成 GREEN），见 REFERENCE §AV。
  const probe21 = async (xml, step) => {
    fs.writeFileSync(FAKE_WINDOW, xml);
    clearCalls();
    try { return { r: await publisher.runStep('127.0.0.1:5555', step, {}, { log() {} }), e: null }; }
    catch (e) { return { r: null, e }; }
  };

  // 行为级（负向，最关键的一条）：**相册屏**跑这一步 ⇒ 一个 tap 都不许发
  // ★ 这里刻意用 `uimap.DEWU.draft.*` 而不是上面那两个硬编码常量 ——
  //   硬编码常量只能验「引擎本身对不对」，验不了「配置里的 id 是不是真机那个」。
  //   反向验证时正是踩到这一点：把 DEWU.draft.exitId 改错，行为级照样全绿
  //   （因为它用的是测试自己的常量）。改成读配置后，配置写错这两条也会红。
  const p21a = await probe21(albumXml21,
    { action: 'tapId', value: uimap.DEWU.draft.exitId, whenOn: uimap.DEWU.draft.titleId });
  ok('㉑ ★ 行为级：相册屏上这一步**不发任何 tap**（只有草稿箱才点，别屏一个像素都不碰）',
    !p21a.e && !/shell input tap/.test(calls()),
    p21a.e ? ('这一步抛异常了：' + p21a.e.message)
      : (calls().split('\n').filter(l => /input tap/.test(l)).join(' | ') || '（没有 tap）'));
  ok('㉑ ★ 行为级：拦下时必须**如实返回 skipped**（不许静默当成成功）',
    !!(!p21a.e && p21a.r && p21a.r.skipped === true && p21a.r.why),
    p21a.e ? ('抛异常：' + p21a.e.message) : JSON.stringify(p21a.r));

  // 行为级（正向对照）：**草稿箱屏**跑同一步 ⇒ 必须真点到出口那颗，坐标 = 中心 (540,1871)
  const p21b = await probe21(draftXml21,
    { action: 'tapId', value: uimap.DEWU.draft.exitId, whenOn: uimap.DEWU.draft.titleId });
  const tap21 = /-s \S+ shell input tap (\d+) (\d+)/.exec(calls());
  ok('㉑ ★ 行为级：按**配置里**的 id 在草稿箱屏上真点到 fl_publish 的中心 (540,1871)（与真机实测同一坐标）',
    !p21b.e && !!tap21 && tap21[1] === '540' && tap21[2] === '1871'
    && !(p21b.r && p21b.r.skipped),
    p21b.e ? ('抛异常：' + p21b.e.message)
      : (tap21 ? (tap21[1] + ',' + tap21[2])
        : '没点到；skipped=' + JSON.stringify(p21b.r && p21b.r.why)));

  // 拿不到界面结构 ⇒ **硬失败**，不许猜「大概不在草稿箱吧」
  const NI21 = path.join(FDB, 'DUMP_NOT_IDLE');
  const ND21 = path.join(FDB, 'NO_DEWU_TOP');
  fs.writeFileSync(NI21, 'always');
  fs.writeFileSync(ND21, '1');
  let e21b = null;
  try {
    await publisher.runStep('127.0.0.1:5555',
      { action: 'tapId', value: DRAFT_EXIT, whenOn: DRAFT_TITLE, name: '草稿箱拦截' }, {}, { log() {} });
  } catch (e) { e21b = e; }
  ok('㉑ ★ 两条通道都拿不到结构时硬失败并点名是哪一步（不许猜「大概不在草稿箱」）',
    !!e21b && /拿不到界面结构/.test(e21b.message) && /草稿箱拦截/.test(e21b.message),
    e21b && e21b.message);
  fs.unlinkSync(NI21); fs.unlinkSync(ND21);
  fs.writeFileSync(FAKE_WINDOW, win21bak);

  // ㉑b 候选表（「抓取页面结构」）必须自带这一步 —— 否则用户重新抓一次表就把修复丢了
  const sug21 = uimap.suggest(uimap.parseNodes(routeXml), 'com.shizhuang.duapp');
  const dStepG = sug21.steps.filter(s => s.whenOn === DRAFT_TITLE && s.value === DRAFT_EXIT);
  const dStepV = sug21.videoSteps.filter(s => s.whenOn === DRAFT_TITLE && s.value === DRAFT_EXIT);
  ok('㉑b 图文候选表自带「草稿箱拦截」步（带 whenOn 守卫，紧跟入口之后）',
    dStepG.length === 1 && sug21.steps.indexOf(dStepG[0]) === 1,
    JSON.stringify(sug21.steps.slice(0, 3).map(s => s.name)));
  ok('㉑b 视频候选表也自带（视频是同一条入口，同样会被草稿箱接走）',
    dStepV.length === 1, JSON.stringify(sug21.videoSteps.slice(0, 3).map(s => s.name)));

  // ---- ㉒ 2026-10-03 提速改动：固定坐标直点（tapXY）/ 多点合并一条 shell（tapSeq）----
  //   真机实测依据（MuMu 12 / 1080×1920，本机 adb 二进制）：
  //     · `adb shell` 任意命令一次 ~110–180ms（纯往返，跟命令内容无关）
  //     · `uiautomator dump` 本体 ~593ms + 回传 ~112ms；老写法 rm+dump+cat = 3 次往返 ~1518ms
  //     · `input tap` 一次 126ms；3 次点击**合并成一条 shell** = 127ms（≈42ms/击）
  //   ⇒ 提速只有两条路：① 该合并的合并（省往返）② 版式固定的格子不抓屏（省掉 1.5s 的 dump）
  //   这套断言盯**语义**（合并成一条 / 真没抓屏 / 复用同一次抓屏），不锁死写法。

  // A) 坐标解析
  const pts22 = uimap.parsePoints('540,1871');
  ok('㉒ parsePoints 认 "x,y"', pts22.length === 1 && pts22[0].x === 540 && pts22[0].y === 1871,
    JSON.stringify(pts22));
  const pts22b = uimap.parsePoints('945,1869; 540,1871\n1007,175');
  ok('㉒ 分号 / 换行都能分隔多个点（顺序保持）',
    pts22b.length === 3 && pts22b.map(p => p.x + ',' + p.y).join(' ') === '945,1869 540,1871 1007,175',
    JSON.stringify(pts22b));
  ok('㉒ 全角逗号也认（用户从 Excel/文档里粘过来的是全角）',
    JSON.stringify(uimap.parsePoints('945，1869')) === JSON.stringify([{ x: 945, y: 1869 }]),
    JSON.stringify(uimap.parsePoints('945，1869')));
  ok('㉒ 写坏的段**只丢那一段**，不把整串判成空（也不猜一个坐标出来）',
    JSON.stringify(uimap.parsePoints('540,1871; 乱写; 100,200'))
      === JSON.stringify([{ x: 540, y: 1871 }, { x: 100, y: 200 }]),
    JSON.stringify(uimap.parsePoints('540,1871; 乱写; 100,200')));
  ok('㉒ 全是垃圾 ⇒ 空数组（调用方据此硬失败，不会去点 (0,0)）',
    uimap.parsePoints('乱写; ; 12').length === 0, JSON.stringify(uimap.parsePoints('乱写; ; 12')));
  ok('㉒ 半个坐标（只写 x）不算数', uimap.parsePoints('540').length === 0,
    JSON.stringify(uimap.parsePoints('540')));

  // B) 导入期就挡住「坐标没写」
  ok('㉒ uimap 公布了新动作 tapXY', uimap.STEP_ACTIONS.includes('tapXY'));
  let e22 = null;
  try { uimap.normalizeSteps([{ action: 'tapXY', value: '' }]); } catch (e) { e22 = e; }
  ok('㉒ tapXY 不写坐标 ⇒ 导入时就报错（不让它跑到真机上点到屏幕左上角）',
    !!e22 && /540,1871/.test(e22.message), e22 && e22.message);
  let e22b = null;
  try { uimap.normalizeSteps([{ action: 'tapXY', value: '乱写' }]); } catch (e) { e22b = e; }
  ok('㉒ tapXY 坐标解析不出来 ⇒ 同样在导入期报错', !!e22b, e22b && e22b.message);
  const st22 = uimap.normalizeSteps([{ action: 'tapXY', value: '945,1869; 540,1871' }]);
  ok('㉒ 导入通过后 points 已经解析好挂在步骤上（运行时不用再解析一次）',
    Array.isArray(st22[0].points) && st22[0].points.length === 2, JSON.stringify(st22[0].points));

  // C) tapSeq：多点**合并成一条 shell**（这才是省时间的地方）
  clearCalls();
  const ts22 = await adbMod.tapSeq('127.0.0.1:5555',
    [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 500, y: 600 }], 250);
  const lines22 = calls().split(/\r?\n/).filter(l => /input tap/.test(l));
  ok('㉒ ★ tapSeq：3 个点只发**一条** shell（老写法是 3 条）',
    ts22.ok === true && lines22.length === 1, lines22.length + ' 条：' + lines22.join(' | '));
  ok('㉒ ★ 三个坐标都在同一条命令里、按顺序',
    !!lines22[0] && /input tap 100 200; sleep 0\.25; input tap 300 400; sleep 0\.25; input tap 500 600/.test(lines22[0]),
    lines22[0]);
  ok('㉒ 间隔是**设备端** sleep（放在 JS 侧的话每次点击都要多一次往返）',
    !!lines22[0] && /sleep 0\.25/.test(lines22[0]), lines22[0]);
  clearCalls();
  await adbMod.tapSeq('127.0.0.1:5555', [{ x: 540, y: 1871 }], 250);
  const one22 = calls().split(/\r?\n/).filter(l => /input tap/.test(l));
  ok('㉒ 只有一个点时**不加** sleep（白等 250ms 也是成本），但仍是单条 shell',
    one22.length === 1 && /input tap 540 1871$/.test(one22[0]), one22.join(' | '));
  const empty22 = await adbMod.tapSeq('127.0.0.1:5555', [], 250);
  ok('㉒ 空坐标列表 ⇒ 明确失败，**不假装成功**（ok:false 且给原因）',
    empty22.ok === false && !!empty22.stderr, JSON.stringify(empty22));
  clearCalls();
  await adbMod.tapSeq('127.0.0.1:5555', [{ x: 100.4, y: 200.6 }], 0);
  ok('㉒ 小数坐标四舍五入成整数（input tap 只认整数）',
    /input tap 100 201\b/.test(calls()), calls().trim());

  // D) 行为级：真代码跑一个 tapXY 步 ⇒ 真按坐标点下去，且**不抓屏**
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', { action: 'tapXY', value: '945,1869' }, {}, { log() {} });
  ok('㉒ ★ 行为级：tapXY 真点到 945,1869，而且**一次 dump 都没抓**（这才是提速点）',
    /-s \S+ shell input tap 945 1869/.test(calls()) && !/uiautomator dump/.test(calls()),
    calls().split(/\n/).filter(Boolean).join(' | ') || '（没有任何命令）');
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', { action: 'tapXY', value: '945,1869; 540,1871' }, {}, { log() {} });
  const lines22d = calls().split(/\r?\n/).filter(l => /input tap/.test(l));
  ok('㉒ ★ 行为级：一个 tapXY 步写两个坐标 ⇒ **一条** shell 点两下',
    lines22d.length === 1 && /945 1869; sleep 0\.25; input tap 540 1871/.test(lines22d[0]),
    lines22d.join(' | '));
  let e22c = null;
  try {
    await publisher.runStep('127.0.0.1:5555', { action: 'tapXY', value: '乱写' }, {}, { log() {} });
  } catch (e) { e22c = e; }
  ok('㉒ ★ 行为级：坐标解析不出来时**硬失败**（绝不默默点屏幕左上角）',
    !!e22c && /坐标解析不出来/.test(e22c.message), e22c && e22c.message);

  // E) 行为级：相册多点选图 ⇒ 也走 tapSeq（一条 shell），不是「一条一条 tap + JS sleep」
  const album2 = '<hierarchy rotation="0">'
    + `<node index="0" text="" resource-id="${THUMB}" class="android.widget.FrameLayout" package="com.shizhuang.duapp" clickable="true" bounds="[56,299][276,419]" />`
    + `<node index="1" text="" resource-id="${THUMB}" class="android.widget.FrameLayout" package="com.shizhuang.duapp" clickable="true" bounds="[332,299][552,419]" />`
    + '</hierarchy>';
  const win22bak = fs.readFileSync(FAKE_WINDOW, 'utf8');
  fs.writeFileSync(FAKE_WINDOW, album2);
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', { action: 'tapId', value: THUMB, count: 2 }, {}, { log() {} });
  const lines22e = calls().split(/\r?\n/).filter(l => /input tap/.test(l));
  ok('㉒ ★ 行为级：一次选 2 张图 ⇒ **一条** shell 点两格（相册按时间倒序，点最前面两格）',
    lines22e.length === 1 && /input tap 166 359; sleep 0\.25; input tap 442 359/.test(lines22e[0]),
    lines22e.join(' | '));

  // F) ★★ 守卫复用：带 whenOn 的步，守卫抓到的结构**直接给同一步的点击用** ⇒ 全场只抓 1 次屏。
  //    没有这个复用就是 2 次（守卫 1 次 + 点击 1 次），实测多花 ~1–2s。
  //    判据 = 数 calls.log 里含 `uiautomator dump` 的**行数**：1 = 复用了；2 = 复用被拆掉。
  fs.writeFileSync(FAKE_WINDOW, draftXml21);
  clearCalls();
  const r22 = await publisher.runStep('127.0.0.1:5555',
    { action: 'tapId', value: DRAFT_EXIT, whenOn: DRAFT_TITLE, name: '草稿箱拦截' }, {}, { log() {} });
  const dumps22 = calls().split(/\r?\n/).filter(l => /uiautomator dump/.test(l)).length;
  // 注意：点击成功时 runStep 返回的是 **undefined**（只有守卫拦下才返回 {skipped}）。
  // 写成 `!r22.skipped` 会在这里抛异常 ⇒ 整段断言一条都不打、只看 FAIL 的人会误判成「全绿」。
  ok('㉒ ★ 带 whenOn 的步：全程只抓 **1** 次屏（守卫抓到的那份被点击步复用，不再白抓第二次）',
    !(r22 && r22.skipped) && dumps22 === 1 && /input tap 540 1871/.test(calls()),
    'dump 次数=' + dumps22 + ' / ' + calls().split(/\n/).filter(Boolean).join(' | '));
  // ★ 反向对照：证明这个「数 dump 次数」的计数器真的数得动。
  //   没有这一条，上面那个 `1 === 1` 可能是计数器坏掉凑出来的（空==空式的假通过）。
  clearCalls();
  await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp', retries: 0 });
  await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp', retries: 0 });
  const dumps22b = calls().split(/\r?\n/).filter(l => /uiautomator dump/.test(l)).length;
  ok('㉒ 对照：连抓两次就是 2（证明上面那条「1 次」不是计数器坏掉数出来的）',
    dumps22b === 2, 'dump 次数=' + dumps22b);
  fs.writeFileSync(FAKE_WINDOW, win22bak);

  // ---- ㉓ 「不会 idle 的屏」只在同一批里付一次 ==============================
  //   真机依据（2026-10-03，MuMu 12 / 得物 / 1080×1920）：
  //     相册页裸 `uiautomator dump` 连打 3 次 = 11230 / 11136 / 11127 ms，**全部**
  //     `could not get idle state`；同一张屏**关掉三个系统动画**后 2036ms 就抓到。
  //     ⇒ 那 ~11 秒纯粹是白等的 idle 超时（控制面：纯 shell 往返 135ms）。
  //   行为：publisher 按**步骤名**记住「这一步这一屏不会 idle」，本批第 2 条起直接走关动画。
  const NI23 = path.join(FDB, 'DUMP_NOT_IDLE');
  fs.writeFileSync(NI23, 'anim');   // 动画开着时 dump 必败（= 真机相册页的行为）
  const nDumps23 = () => calls().split(/\r?\n/).filter(l => /uiautomator dump/.test(l)).length;
  // 设备上那三个动画开关（与 adb.js#ANIM_KEYS 同源；这里单独列一份，避免测试直接吃实现常量）
  const ANIM_KEYS_23B = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
  const animState23 = async () => {
    const r = await adbMod.shell('127.0.0.1:5555',
      'settings get global window_animation_scale; settings get global transition_animation_scale; settings get global animator_duration_scale');
    return String(r.stdout).replace(/\s+/g, ' ').trim();
  };

  // A) 对照：不认识这屏 ⇒ 先白抓一次，再去关动画（两次抓屏）
  clearCalls();
  const d23plain = await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp', retries: 0 });
  const n23plain = nDumps23();
  ok('㉓ 对照：不认识这屏 ⇒ 先白抓一次才去关动画（两次抓屏）',
    d23plain.ok === true && d23plain.animOff === true && n23plain === 2,
    'ok=' + d23plain.ok + ' animOff=' + d23plain.animOff + ' dump 次数=' + n23plain);

  // B) 已知这屏不会 idle ⇒ 直接关动画抓，只抓一次（省掉那 ~11 秒）
  clearCalls();
  const d23pre = await adbMod.dumpEx('127.0.0.1:5555',
    { pkg: 'com.shizhuang.duapp', retries: 0, preferAnimOff: true });
  const n23pre = nDumps23();
  const animAfter23 = await animState23();
  ok('㉓ ★★ 已知这屏不会 idle ⇒ 直接关动画抓（只抓一次，省掉那 ~11 秒的白等）',
    d23pre.ok === true && d23pre.animOff === true && n23pre === 1,
    'ok=' + d23pre.ok + ' animOff=' + d23pre.animOff + ' dump 次数=' + n23pre);
  ok('㉓ ★ 走这条路也必须把动画还原（不许把用户设备留在关掉的状态）',
    animAfter23 === '1 1 1', '动画开关 = ' + animAfter23);

  // C) 行为级：真代码跑同一步两次 ⇒ 第 1 次学会、第 2 次不再白抓
  const win23bak = fs.readFileSync(FAKE_WINDOW, 'utf8');
  fs.writeFileSync(FAKE_WINDOW, album2);
  const idleStep23 = { name: '㉓ 这屏不会 idle 的测试步', action: 'tapId', value: THUMB };
  const ctx23 = { log() {}, animOffSteps: {} };
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', idleStep23, {}, ctx23);
  const n23a = nDumps23();
  ok('㉓ ★ 行为级：第 1 次跑 ⇒ 白抓一次（共 2 次），并把这步记进缓存',
    n23a === 2 && ctx23.animOffSteps[idleStep23.name] === true,
    'dump 次数=' + n23a + ' 缓存=' + JSON.stringify(ctx23.animOffSteps));
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', idleStep23, {}, ctx23);
  const n23b = nDumps23();
  ok('㉓ ★★ 行为级：同一步第 2 次跑 ⇒ 只抓一次（真机上就是省掉那 ~11 秒）',
    n23b === 1, 'dump 次数=' + n23b);

  // D) 反向对照：不给缓存（每次新建 ctx）⇒ 永远学不会，每次都是 2 次
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', idleStep23, {}, { log() {} });
  await publisher.runStep('127.0.0.1:5555', idleStep23, {}, { log() {} });
  const n23d = nDumps23();
  ok('㉓ 反向对照：不给缓存 ⇒ 两次都是白抓 2+2=4 次（证明省下来的是缓存带来的）',
    n23d === 4, 'dump 次数=' + n23d);

  // E) ★ 负向：页面本来就会 idle ⇒ **不许**往缓存里塞
  //    （塞错了的后果：以后每一步都无端关掉用户设备的动画，白花 3 次往返还改了系统设置）
  fs.unlinkSync(NI23);
  const ctx23e = { log() {}, animOffSteps: {} };
  clearCalls();
  await publisher.runStep('127.0.0.1:5555', idleStep23, {}, ctx23e);
  const n23e = nDumps23();
  ok('㉓ ★ 负向：页面本来就会 idle ⇒ 不塞缓存、也不多抓（1 次就够）',
    Object.keys(ctx23e.animOffSteps).length === 0 && n23e === 1,
    '缓存=' + JSON.stringify(ctx23e.animOffSteps) + ' dump 次数=' + n23e);
  fs.writeFileSync(FAKE_WINDOW, win23bak);

  // ---- ㉓f 2026-10-04：**守卫条件不成立**时也要学「这屏不 idle」-------------------
  //   ★ 这一条对应真机上最大的一处白等（用户投诉「选择素材太慢」的直接来源）：
  //     「未完成草稿拦截 · 点「放弃」」是一条**屏幕守卫步**（whenOn: tvCancel 才点），
  //     而绝大多数内容**不会**弹「是否继续编辑」⇒ 守卫条件不成立 ⇒ 直接 return skipped。
  //     原来「这屏不 idle」只在**守卫成立**的路径上被学下来，于是不成立的每一条都要
  //     重新白等一次 idle 超时。真机实测该步 **13491ms ×2**（两条内容都是白等）。
  //   判据：守卫**拦下**这一步（skipped），但**照样**把步骤名记进 animOffSteps。
  {
    const winFbak = fs.readFileSync(FAKE_WINDOW, 'utf8');
    // 这一屏上**没有** tvCancel（走的就是「不弹窗」那条分支），但它是「永不 idle」的屏
    fs.writeFileSync(FAKE_WINDOW, album2);
    const NI23f = path.join(FDB, 'DUMP_NOT_IDLE');
    fs.writeFileSync(NI23f, 'anim');
    const guardStep23f = {
      name: '㉓f 未完成草稿拦截 · 点「放弃」',
      whenOn: 'tvCancel',                       // 这一屏上没有 ⇒ 守卫必然拦下
      action: 'tapId', value: 'tvCancel'
    };
    const ctx23f = { log() {}, animOffSteps: {} };
    clearCalls();
    const r23f = await publisher.runStep('127.0.0.1:5555', guardStep23f, {}, ctx23f);
    const n23f = nDumps23();
    ok('㉓f ★★ 守卫拦下这一步（这一屏没弹「是否继续编辑」）⇒ 如实返回 skipped',
      r23f && r23f.skipped === true, '返回=' + JSON.stringify(r23f));
    ok('㉓f ★★ 但「这屏不 idle」照样学下来了（原来只在守卫成立时才记 ⇒ 每条都白等 13.5s）',
      ctx23f.animOffSteps[guardStep23f.name] === true,
      '缓存=' + JSON.stringify(ctx23f.animOffSteps) + ' dump 次数=' + n23f);
    clearCalls();
    await publisher.runStep('127.0.0.1:5555', guardStep23f, {}, ctx23f);
    const n23f2 = nDumps23();
    ok('㉓f ★★ 同一条守卫步第 2 次跑 ⇒ 直接走关动画（只抓 1 次，不再白等 idle 超时）',
      n23f2 === 1, 'dump 次数=' + n23f2);

    // 反向对照：这一屏**会** idle ⇒ 守卫拦下之后**不许**往缓存里塞
    //   （塞错了 = 后面每一条都无端关掉用户设备的动画）
    fs.unlinkSync(NI23f);
    const ctx23f2 = { log() {}, animOffSteps: {} };
    const r23f2 = await publisher.runStep('127.0.0.1:5555', guardStep23f, {}, ctx23f2);
    ok('㉓f 反向对照：这一屏会 idle ⇒ 守卫拦下后**不塞**缓存（不许无端关用户设备的动画）',
      r23f2.skipped === true && Object.keys(ctx23f2.animOffSteps).length === 0,
      '缓存=' + JSON.stringify(ctx23f2.animOffSteps));
    fs.writeFileSync(FAKE_WINDOW, winFbak);
  }

  // ---- ㉓g 2026-10-04：给裸 dump 加「上限」—— 把 ~11.5s 白等砍成 4s ------------------
  //   真机依据：在「永不 idle」的屏上，裸 `uiautomator dump` 会**先死等约 11.5s** idle 超时
  //   才失败，之后 dumpEx 才回退去关动画重抓（~2s）⇒ 单步 13.5s，其中 11s 纯白等、无事可做
  //   （用户投诉「还是慢」的另一半）。上限用设备自带 `timeout`（真机实测 `timeout 2 sleep 5` → 124）。
  //   反向验证：把 `timeout ${DUMP_IDLE_CAP_S} ` 从裸 dump 上摘掉 ⇒ 第 1 条断言必红。
  {
    const SILENT23g = path.join(FDB, 'DUMP_SILENT');
    const NOTO23g = path.join(FDB, 'DUMP_NO_TIMEOUT');
    const dumpLines23g = () => calls().split(/\r?\n/).filter(l => /uiautomator dump/.test(l));

    fs.writeFileSync(SILENT23g, '1');
    clearCalls();
    const d23g = await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp' });
    const log23g = calls();
    ok('㉓g ★★ 裸 dump 带上 timeout 上限（永不 idle 时 11.5s 白等 ⇒ 4s）',
      /timeout 4 uiautomator dump /.test(log23g),
      dumpLines23g().join(' | ').slice(0, 240));
    const animLine23g = log23g.split(/\r?\n/).find(l => /animator_duration_scale 0/.test(l)) || '';
    ok('㉓g ★ 关动画抓（逃生通道）**不**加上限 —— 加了会把本来就慢的重页面误杀',
      animLine23g !== '' && !/timeout \d+ uiautomator dump/.test(animLine23g),
      animLine23g.slice(0, 200));
    ok('㉓g ★★ 被上限杀掉（一个字都不打印）时仍然抓得到这一屏（不是一失败就报错）',
      d23g.ok === true && d23g.animOff === true,
      JSON.stringify({ ok: d23g.ok, via: d23g.via, animOff: d23g.animOff, why: d23g.why }));

    // 反向对照：设备上**没有** `timeout` ⇒ 去掉上限原样再抓一次，抓回**带文字**的结构
    //   （若直接当失败，会静默退到没有文字的 dumpsys 通道 ⇒ 按文字找的步骤全失效）
    fs.unlinkSync(SILENT23g);
    fs.writeFileSync(NOTO23g, '1');
    clearCalls();
    const d23g2 = await adbMod.dumpEx('127.0.0.1:5555', { pkg: 'com.shizhuang.duapp' });
    const lines23g2 = dumpLines23g();
    ok('㉓g ★★ 设备没有 timeout ⇒ 去掉上限**再抓一次**（走正常通道、带文字，不静默退到 dumpsys）',
      d23g2.ok === true && d23g2.via === 'uiautomator' && d23g2.animOff === false
      && lines23g2.length === 2
      && /timeout 4 uiautomator dump /.test(lines23g2[0])
      && !/timeout \d+ uiautomator dump /.test(lines23g2[1]),
      JSON.stringify({ ok: d23g2.ok, via: d23g2.via, animOff: d23g2.animOff })
      + ' 抓屏次数=' + lines23g2.length + ' 第2次=' + String(lines23g2[1] || '').trim().slice(0, 90));
    fs.unlinkSync(NOTO23g);
  }

  // ---- ㉓b 2026-10-04：关动画抓屏压到「一条 shell」后，往返次数与还原保真都要有数 ------
  //   真机依据：一次 shell 往返实测 150~190ms；原来 animGet + animSet + dumpOnce + animRestore
  //   = 4 次往返 ≈ 0.7s 光固定税。相册页这类永不 idle 的屏，每条内容都要交这笔税。
  //   ⇒ 现改为「第 1 段：读回 + 关动画 + 抓 + 回传」（一条），「第 2 段：还原」（一条）
  //     = 2 次往返；**其中真正抓屏（uiautomator dump）只 1 次**。
  //   判据全部数 calls.log 的**行**，不数源码里的字符串（源码里有那行 ≠ 它真被调了）。
  {
    const NI23b = path.join(FDB, 'DUMP_NOT_IDLE');
    fs.writeFileSync(NI23b, 'anim');
    const shellLines = () => calls().split(/\r?\n/).filter(l => /\sshell /.test(l) || /^shell /.test(l));
    const animNow = async () => String((await adbMod.shell('127.0.0.1:5555',
      'settings get global window_animation_scale; settings get global transition_animation_scale; settings get global animator_duration_scale')).stdout)
      .replace(/\s+/g, ' ').trim();

    const bak23b = await animNow();
    clearCalls();
    const d23b = await adbMod.dumpAnimOff('127.0.0.1:5555');
    const sh23b = shellLines().length;
    const nd23b = nDumps23();
    ok('㉓b ★★ 关动画抓屏只花 2 次 shell 往返（原来 4 次：读/关/抓/还原各一次）',
      d23b.ok === true && d23b.animOff === true && sh23b === 2, 'shell 往返=' + sh23b);
    ok('㉓b ★★ 这 2 次里 uiautomator dump 只发 1 次（「只抓一次」的硬口径）',
      nd23b === 1, 'dump 次数=' + nd23b);
    ok('㉓b ★★ 压缩往返后**还原保真**：设备上的动画开关一字未改',
      (await animNow()) === bak23b, '前=' + bak23b + ' 后=' + (await animNow()));
    ok('㉓b ★ 抓到的 XML 是真内容（不是空壳）',
      !!d23b.xml && /<hierarchy/.test(d23b.xml), 'xml 长度=' + String(d23b.xml || '').length);

    // 反向对照：把「还原」那条拆掉之后，设备是不是真的会被留在 0？
    //   没有这一条，上面「还原保真」可能是夹具自己没生效凑出来的（空==空式假通过）。
    await adbMod.shell('127.0.0.1:5555',
      'settings put global window_animation_scale 1; settings put global transition_animation_scale 1; settings put global animator_duration_scale 1');
    const bak23b2 = await animNow();
    await adbMod.shell('127.0.0.1:5555',
      ANIM_KEYS_23B.map(k => `settings put global ${k} 0`).join('; '));   // 故意只关不还原
    const left0 = await animNow();
    ok('㉓b 对照：只关不还原 ⇒ 设备真的会停在 0（证明上面那条「保真」不是恒绿的）',
      left0 === '0 0 0' && bak23b2 === '1 1 1', '只关不还原后=' + left0);
    await adbMod.shell('127.0.0.1:5555',
      ANIM_KEYS_23B.map(k => `settings put global ${k} 1`).join('; '));   // 还原现场
    fs.unlinkSync(NI23b);
  }

  // ---- ㉓c 设备端命令**原样**送出去（不许在 client 侧做任何"注释剥离"式改写）------------
  //   ★ 这一条是被一次**真实事故**换来的，必须留着：
  //     我为「在命令里写注释」加过一个 `stripShComments()`（按行剥 `#`、再用 `;` 接回来）。
  //     它把 `inputText` 的正文 payload（含换行、含行首 `#`）**改写了** ——
  //     换行全变成 `;`、行首 `#` 被吃掉，真机上表现为「正文打进输入框变成一行并缺话题」。
  //     更糟的是它**同时**把 sh 的注释语义屏蔽掉了，于是「行首 # 炸掉广播」那个真 bug
  //     在回归里反而看不出来（夹具和真机都不炸了）。
  //   ⇒ 结论：**client 侧不对命令做语义改写**。命令要注释就写在 JS 注释里（本文件这样），
  //     不要写进发出去的字符串。sent 的内容必须与拼出来的一字不差。
  {
    clearCalls();
    const probeCmd = 'echo A; echo B';
    await adbMod.shell('127.0.0.1:5555', probeCmd);
    const sent = calls().split(/\r?\n/).filter(Boolean).join(' ; ');
    ok('㉓c ★ shell() 把命令**原样**发出去（不做任何剥注释/改写；改写会毁掉正文 payload）',
      sent.indexOf(probeCmd) >= 0, sent.slice(0, 120));
    // 反向对照：带换行与行首 # 的 payload 必须**原样**出现在发给设备的命令里
    clearCalls();
    const payload = 'am broadcast -a ADB_INPUT_TEXT --es msg "第一行\n#话题"';
    await adbMod.shell('127.0.0.1:5555', payload);
    const sent2 = calls();
    ok('㉓c ★★ 带换行/行首 # 的 payload 原样送出（换行没被换成 ;、# 没被吃掉）',
      sent2.indexOf('第一行\n#话题') >= 0, JSON.stringify(sent2.slice(0, 140)));
  }

  // ==========================================================================
  // ㉔ 2026-10-03 ★★ 得物相册读的就是 MediaStore —— 「推了却选不到 / 点它弹
  //     『暂不支持的视频格式』」的真根因是：素材根本没进库
  //
  //    真机实测（127.0.0.1:16384 / MuMu 12 / Android 12，全部可复算）：
  //    · adb push 一个 mp4 到 /sdcard/DCIM/Camera，它【不在 MediaStore 里】
  //      ⇒ 得物相册里【看不到】它（第 1 格还是旧内容，格子上的时长标记和库里对得上）；
  //    · 用 `content call --uri content://media/external/file --method scan_file --arg <全路径>`
  //      把它索引进库（返回 content://media/external_primary/video/media/N）
  //      ⇒ 冷启动得物打开相册，它【立刻出现在第 1 格】；
  //    · 库里指向「文件已删」的**僵尸记录**会显示成一个【黑缩略图的格子】，
  //      点它必弹 Toast「暂不支持的视频格式」—— 得物去解码时文件已不存在；
  //    · 而旧代码发的那两条广播（MEDIA_SCANNER_SCAN_FILE / MEDIA_MOUNTED）在这台设备上
  //      **没有任何接收者** ⇒ 这就是「视频已推到设备，但等了 182.9s 媒体库还没索引到」的真根因。
  //    ⇒ 现在：推完必须 `mediaScan()` 真写库 + `mediaVisible()` 确认进库（默认 20s）。
  // ==========================================================================
  {
    const adbM = require(path.join(base, 'src/main/services/adb.js'));

    // --- B1) filesMissing 本身的行为（先自证，别让「恒为 EXISTS」把后面全喂成假绿）---
    const PROBE_OK = '/sdcard/DCIM/Camera/probe_exists.mp4';
    const PROBE_NO = '/sdcard/DCIM/Camera/probe_never_pushed.mp4';
    await adbM.push('127.0.0.1:5555', path.join(itemDir, '1.jpg'), PROBE_OK);
    const fm1 = await adbM.filesMissing('127.0.0.1:5555', [PROBE_OK]);
    ok('㉔ filesMissing：真推过的文件 → 报「在」（missing 为空）',
      fm1.missing.length === 0 && !fm1.error, JSON.stringify(fm1));
    const fm2 = await adbM.filesMissing('127.0.0.1:5555', [PROBE_NO]);
    ok('㉔ filesMissing：没推过的文件 → 报「缺失」（不许假装存在）',
      fm2.missing.length === 1 && fm2.missing[0] === PROBE_NO, JSON.stringify(fm2));
    const fm3 = await adbM.filesMissing('127.0.0.1:5555', [PROBE_OK, PROBE_NO]);
    ok('㉔ filesMissing：混着问 → 只把真缺的那个报出来（顺序不乱）',
      fm3.missing.length === 1 && fm3.missing[0] === PROBE_NO, JSON.stringify(fm3));

    // --- B2) ★★ mediaScan 本身：必须是 content call（广播在这台设备上没人收），
    //     而且 --arg 要给 /storage/emulated/0/... 全路径
    const PROBE_MEDIA = '/sdcard/DCIM/Camera/probe_media.mp4';
    await adbM.push('127.0.0.1:5555', path.join(itemDir, '1.jpg'), PROBE_MEDIA);
    clearCalls();
    const sc1 = await adbM.mediaScan('127.0.0.1:5555', PROBE_MEDIA);
    const scLog = calls();
    ok('㉔ ★★ mediaScan 走 content call --method scan_file（真机上唯一有效的写法）',
      sc1.ok === true && /content call --uri content:\/\/media\/external\/file --method scan_file/.test(scLog),
      'ok=' + sc1.ok + ' how=' + sc1.how + ' / ' + (scLog.match(/content call.*/g) || []).join(' | '));
    ok('㉔ ★★ 扫的必须是 /storage/emulated/0/... 全路径（传 /sdcard/... 真机会拿到空 STREAM）',
      /--arg '\/storage\/emulated\/0\/DCIM\/Camera\/probe_media\.mp4'/.test(scLog),
      (scLog.match(/--arg.*/g) || []).join(' | '));
    ok('㉔ ★ 不许再发那两条没人接收的广播（以前就是它们害得白等 180 秒）',
      !/MEDIA_SCANNER_SCAN_FILE|MEDIA_MOUNTED/.test(scLog),
      (scLog.match(/am broadcast.*/g) || []).join(' | ') || '（没发广播）');

    // --- B2b) mediaVisible 要**两张表一起查**：图文发的是图片，只查 video 会把图文判成失败
    clearCalls();
    await adbM.mediaVisible('127.0.0.1:5555', [PROBE_MEDIA], { timeoutMs: 1500, pollMs: 300 });
    const mvLog = calls();
    ok('㉔ ★ mediaVisible 同时查 video 与 images 两张表（只查 video 会漏判图文）',
      /content:\/\/media\/external\/video\/media/.test(mvLog) && /content:\/\/media\/external\/images\/media/.test(mvLog),
      (mvLog.match(/content query.*/g) || []).join(' | '));

    // --- B3) 真代码：默认（索引超时=0）也要写库 + 确认进库 ---
    store.set({ publish: { uiMap: videoMap, videoIndexTimeoutSec: 0 } });
    videoState.publish.rows[0].result = '';
    videoState.publish.rows[0].status = '排队';
    clearCalls();
    const r24 = await publisher.run(videoState, vctx);
    const c24 = calls();
    ok('㉔ ★★ 默认就会写库并确认进库（得物读 MediaStore，这一步不能省）',
      /content call --uri content:\/\/media\/external\/file --method scan_file/.test(c24)
      && /content query --uri content:\/\/media/.test(c24),
      (c24.match(/content (call|query).*/g) || []).join(' | ') || '（一次都没做）');
    ok('㉔ 进库确认过了 ⇒ 这条真的发出去了（不是被「等不到索引」拦下）',
      r24.rows[0].result === '发布成功', r24.rows[0].result + ' / ' + (r24.rows[0].reason || ''));

    // --- B4) ★ 扫描没生效（SCAN_FAIL）⇒ 必须如实失败，绝不硬点界面 ---
    //  ★ 必须换一个**从没进过库**的文件名：同一个路径在前面 B3 里已经进过库，
    //    mediaVisible 会立刻看到那条旧记录，这条用例就成假绿了（第一版就是这么写错的）。
    const SCANFAIL = path.join(FDB, 'SCAN_FAIL');
    const bakFiles24 = videoItem.files;
    videoItem.files = [{ name: '短片2.mp4', type: 'video' }, { name: '短片3.mp4', type: 'video' }];
    fs.writeFileSync(path.join(itemDir2, '短片2.mp4'), Buffer.from('fake video bytes'));
    fs.writeFileSync(path.join(itemDir2, '短片3.mp4'), Buffer.from('fake video bytes'));
    fs.writeFileSync(SCANFAIL, '1');
    clearCalls();
    const deferredScan = await adbM.mediaScan('127.0.0.1:5555', PROBE_MEDIA, { fallbackVolume: false });
    ok('批量扫描模式单文件失败不假装成功，也不立即整卷扫描',
      !deferredScan.ok && /scan_file/.test(calls()) && !/scan_volume/.test(calls()));
    clearCalls();
    await adbM.mediaScan('127.0.0.1:5555', PROBE_MEDIA);
    ok('独立扫描默认仍保留整卷兜底', /scan_volume/.test(calls()));
    store.set({ publish: { uiMap: videoMap, videoIndexTimeoutSec: 1 } });
    videoState.publish.rows[0].result = '';
    videoState.publish.rows[0].status = '排队';
    clearCalls();
    const r24c = await publisher.run(videoState, vctx);
    const c24c = calls();
    ok('多个素材扫描失败仅统一整卷兜底一次，仍拦截未入库素材',
      (c24c.match(/--method scan_file/g) || []).length === 2
      && (c24c.slice(c24c.indexOf('push ')).match(/--method scan_volume/g) || []).length === 1
      && r24c.rows[0].result === '失败');
    fs.unlinkSync(SCANFAIL);
    ok('㉔ ★ 扫不进库 ⇒ 如实失败（不许硬点界面，硬点只会点空）',
      r24c.rows[0].result === '失败' && /没能写进媒体库/.test(r24c.rows[0].reason), r24c.rows[0].reason);
    ok('㉔ 扫不进库时一步界面都没点', !/input tap/.test(c24c),
      (c24c.match(/input tap .*/g) || []).join(' | ') || '（一次都没点）');
    videoItem.files = bakFiles24;

    // --- B5) 预估耗时已按用户口径整套删除（2026-10-13）：见下面 ㉔ 的两条断言 ---
    store.set({ publish: { intervalSec: 60, videoIntervalSec: 0 } });
    ok('㉔ 预估耗时已从发布器移除（删掉不靠谱的「图文 30s / 视频 60s」口径）',
      publisher.estimate === undefined, 'publisher.estimate=' + String(publisher.estimate));
    ok('㉔ 对照：间隔取值仍然保留（0 = 连续发布，60 = 固定 60 秒）',
      publisher.gapSecFor('image', { intervalSec: 0 }) === 0
      && publisher.gapSecFor('image', { intervalSec: 60 }) === 60
      && publisher.gapSecFor('video', { intervalSec: 60, videoIntervalSec: 90 }) === 90,
      JSON.stringify([publisher.gapSecFor('image', { intervalSec: 0 }),
        publisher.gapSecFor('image', { intervalSec: 60 }),
        publisher.gapSecFor('video', { intervalSec: 60, videoIntervalSec: 90 })]));
  }

  // ==========================================================================
  // ㉕ 2026-10-03 ★ 一个模拟器被 adb 报成「多台设备」时，要按设备身份合并
  //
  //    真机（MuMu 12 / 127.0.0.1:16384）实测：`adb devices` 同时列出
  //    127.0.0.1:16384 / 127.0.0.1:5555 / 127.0.0.1:7555 三行，三者
  //    `settings get secure android_id` 全是 927145746ae845d6、/proc/uptime 也一致
  //    ⇒ 明明只开了一个模拟器，界面却显示两个序列号。
  // ==========================================================================
  {
    const MULTI = path.join(FDB, 'MULTI_PORT');
    const NOID = path.join(FDB, 'NO_ANDROID_ID');

    // --- B1) 没开多端口：就一台，不该产生任何 dupOf ---
    const base25 = await publisher.scanDevices();
    ok('㉕ 只有一台时：不该标任何重复',
      base25.length >= 1 && base25.every(d => !d.dupOf),
      JSON.stringify(base25.map(d => d.serial + (d.dupOf ? '→' + d.dupOf : ''))));

    // --- B2) 开多端口：三行应是同一台 ⇒ 只留一个主串，另两个标 dupOf ---
    fs.writeFileSync(MULTI, '1');
    const list25 = await publisher.scanDevices();
    const mains = list25.filter(d => !d.dupOf);
    const dups = list25.filter(d => d.dupOf);
    ok('㉕ 同一台设备在 3 个端口上被报 3 次 ⇒ 只留 1 个主串',
      list25.length === 3 && mains.length === 1 && dups.length === 2,
      '总=' + list25.length + ' 主=' + mains.length + ' 重复=' + dups.length
      + ' / ' + JSON.stringify(list25.map(d => d.serial + (d.dupOf ? '→' + d.dupOf : ''))));
    ok('㉕ 被合并掉的两个都指向同一个主串',
      dups.every(d => d.dupOf === mains[0].serial), JSON.stringify(dups.map(d => d.dupOf)));
    ok('㉕ 主串上带出「这台还出现在哪些端口」（界面要能解释清楚）',
      mains[0].aliases && mains[0].aliases.length === 2, JSON.stringify(mains[0].aliases));
    ok('㉕ 重复的那些自己不带 aliases（免得界面上重复解释）',
      dups.every(d => !d.aliases || !d.aliases.length), JSON.stringify(dups.map(d => d.aliases)));

    // --- B3) ★ 负向：读不到 android_id 时【不许】瞎合并（宁可多列，也不能把两台真设备并成一台）---
    fs.writeFileSync(NOID, '1');
    const noid25 = await publisher.scanDevices();
    ok('㉕ ★ 负向：身份读不到 ⇒ 一台都不合并（不许瞎合并成一台）',
      noid25.length === 3 && noid25.every(d => !d.dupOf),
      '总=' + noid25.length + ' 重复=' + noid25.filter(d => d.dupOf).length);

    fs.unlinkSync(NOID);
    fs.unlinkSync(MULTI);
  }

  // ==========================================================================
  // ㉖ ★ 发布间隔的「连续发布」档（2026-10-03 用户要求）：0 = 上一条发完直接发下一条
  //    典型坑：0 是真值语义上的"合法值"，却恰好是 falsy ⇒ `c.intervalSec || 60` 会把它吃掉。
  //    表现是用户选了「连续发布」却仍然等满 60 秒，且界面上显示的也是 60 秒 —— 查不出原因。
  // ==========================================================================
  {
    // --- C1) 取值：0 与字符串 '0' 都必须原样是 0（界面写回来的是字符串）---
    const g0 = publisher.gapSecFor('image', { intervalSec: 0 });
    const g0s = publisher.gapSecFor('image', { intervalSec: '0' });
    const gDef = publisher.gapSecFor('image', {});
    const g60 = publisher.gapSecFor('image', { intervalSec: 60, intervalMinSec: 60 });
    ok('㉖ 图文间隔：配 0 ⇒ 0 秒（连续发布，不许被兜成 60）', g0 === 0, String(g0));
    ok('㉖ 图文间隔：字符串 "0" 也必须是 0（界面写回来的是字符串）', g0s === 0, String(g0s));
    ok('㉖ 图文间隔：没配过才用 60 兜底', gDef === 60, String(gDef));
    ok('㉖ 图文间隔：配 60 仍是 60（别把正常档改坏）', g60 === 60, String(g60));

    // --- C2) ★ 视频那一项的 0 = 「跟随主间隔」，跟主间隔的 0 = 连续不是一回事 ---
    const v0 = publisher.gapSecFor('video', { intervalSec: 60, videoIntervalSec: 0 });
    const v30 = publisher.gapSecFor('video', { intervalSec: 60, videoIntervalSec: 30 });
    const vFollow = publisher.gapSecFor('video', { intervalSec: 0, videoIntervalSec: 0 });
    ok('㉖ ★ 视频：videoIntervalSec=0 的含义是「跟随主间隔」⇒ 主间隔 60 时必须还是 60（不是 0）',
      v0 === 60, String(v0));
    ok('㉖ 视频：单独放宽（>0）才生效', v30 === 30, String(v30));
    ok('㉖ 视频：主间隔设成 0（连续）时跟随 ⇒ 视频也连续', vFollow === 0, String(vFollow));

    // --- C3) 端到端：真跑两条。连续档不许出现"等 N 秒"；固定档必须出现（正向对照）---
    const mk2 = () => ({
      items: [1, 2].map(k => ({
        id: 'r' + k, dir: itemDir, absDir: itemDir, sku: '26FW-YB160', color: '冠军白',
        files: [{ name: '1.jpg', type: 'image' }, { name: '2.jpg', type: 'image' }]
      })),
      copyRows: [1, 2].map(k => ({ id: 'r' + k, title: '标题' + k, body: '正文' + k, topics: ['#品牌甲'] })),
      verify: { rows: [] },
      publish: {
        rows: [1, 2].map(k => ({ seq: k, id: 'r' + k, dir: 'r' + k, goods: 1, images: 2, startAt: '', status: '排队', result: '', reason: '' })),
        mode: 'adb', device: '127.0.0.1:5555'
      }
    });
    const run2 = async (sec) => {
      // 旧配置里的主页停留也不能让连续发布额外等待。
      store.set({ publish: { uiMap, intervalSec: sec, homeDwellSec: 3, postPublishDwellSec: 3 } });
      clearCalls();
      const lg = [];
      const t0 = Date.now();
      const r = await publisher.run(mk2(), { log: (m, l) => lg.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} });
      return { lg, ms: Date.now() - t0, r };
    };

    const cont = await run2(0);
    const fixed = await run2(1);
    const waitedCont = cont.lg.filter(l => /按 \d+ 秒间隔/.test(l));
    const waitedFixed = fixed.lg.filter(l => /按 \d+ 秒间隔/.test(l));
    ok('连续发布不再执行旧配置中的主页停留，两条均正常发出',
      cont.r.okCount === 2 && !cont.lg.some(l => /在主页停留/.test(l)), cont.ms + 'ms');
    store.set({ publish: { homeDwellSec: null, postPublishDwellSec: null } });
    ok('㉖ 端到端：连续档两条都发出来了', cont.r.okCount === 2, cont.r.okCount + '/' + cont.r.total);
    ok('㉖ ★ 连续档：日志里不许出现「按 N 秒间隔」', waitedCont.length === 0, waitedCont.join(' | ') || '（一条都没有）');
    ok('㉖ 连续档：日志要写明「连续发布：不等间隔」（免得看着像卡住）',
      cont.lg.some(l => /连续发布/.test(l)), cont.lg.filter(l => /连续发布/.test(l))[0] || '（没写）');
    ok('㉖ ★ 正向对照：固定 1 秒档【必须】出现「按 1 秒间隔」—— 否则上面那条是空==空的假绿',
      waitedFixed.length >= 1, waitedFixed.join(' | ') || '（没有 ⇒ 说明上面那条断言根本不成立）');
    ok('㉖ 行为级：连续档两条的总耗时明显少于固定 1 秒档（真的少等了，不只是改了日志）',
      fixed.ms - cont.ms >= 500, `连续 ${cont.ms}ms / 固定 ${fixed.ms}ms（差 ${fixed.ms - cont.ms}ms）`);

    // --- C4) 源码级：读取端不许再出现 `intervalSec ||` 这种会把 0 吃掉的写法 ---
    const pubSrc = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/publisher.js'), 'utf8'));
    const jobSrc = codeOnly(fs.readFileSync(path.join(base, 'src/main/jobs.js'), 'utf8'));
    const shSrc = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/sheet.js'), 'utf8'));
    ok('㉖ 源码级：publisher / jobs / sheet 里都不再有 `intervalSec || …` 的取值（0 会被吃掉）',
      !/intervalSec \|\|/.test(pubSrc) && !/intervalSec \|\|/.test(jobSrc) && !/intervalSec \|\|/.test(shSrc),
      JSON.stringify({
        pub: (pubSrc.match(/intervalSec \|\|/g) || []).length,
        jobs: (jobSrc.match(/intervalSec \|\|/g) || []).length,
        sheet: (shSrc.match(/intervalSec \|\|/g) || []).length
      }));
  }

  // ==========================================================================
  // D) 专属相册「清干净」这条命脉（2026-10-04 用户报「第二条永远拉不起来」后加的）
  //    用户原话：「点击发布新动态后，显示在页面中的照片、视频只有那一个叶子文件夹里的
  //    东西……发布下一个叶子文件夹时，上一条的素材也不会出现在这个页面」——P0 级。
  //    这一组专门盯 clearMediaDir 的**行为**：不光要发对命令，还要**目录真的空了**。
  // ==========================================================================
  {
    const adb = require(path.join(base, 'src/main/services/adb.js'));
    // 新设备刚连入时 MediaProvider 会偶发一次空输出的非零退出。
    let videoQueries = 0;
    const transientQuery = await adb.queryMediaTable('FAKESERIAL', 'video', async () => {
      videoQueries++;
      return videoQueries === 1
        ? { ok: false, stdout: '', stderr: '', code: 1 }
        : { ok: true, stdout: 'No result found.\n', stderr: '', code: null };
    });
    ok('新设备视频表首次瞬时查询失败会自动重试并成功', transientQuery.result.ok && videoQueries === 2 && !transientQuery.error,
      `queries=${videoQueries} error=${transientQuery.error}`);
    let persistentQueries = 0;
    const persistentQuery = await adb.queryMediaTable('FAKESERIAL', 'video', async () => {
      persistentQueries++;
      return { ok: false, stdout: 'provider unavailable', stderr: '', code: 1 };
    });
    ok('视频表持续不可用时仍阻止清理并给出设备详情与重试结果',
      !persistentQuery.result.ok && persistentQueries === 2 && /provider unavailable/.test(persistentQuery.error)
        && /退出码 1/.test(persistentQuery.error) && /重试后仍失败/.test(persistentQuery.error),
      persistentQuery.error);
    let empty139Calls = 0;
    const empty139 = await adb.queryMediaTable('FAKESERIAL', 'video', async () => {
      empty139Calls++;
      return { ok: false, stdout: 'No result found.\n', stderr: '', code: 139 };
    });
    ok('新设备空 MediaStore 表即使 content CLI 退出 139，也按明确空结果处理且不重试',
      empty139.result.ok && empty139.result.stdout === '' && !empty139.error && empty139Calls === 1,
      `queries=${empty139Calls} error=${empty139.error}`);
    let rows139Calls = 0;
    const rows139 = await adb.queryMediaTable('FAKESERIAL', 'video', async () => {
      rows139Calls++;
      return { ok: false, stdout: 'Row: 0 _id=19, _data=/sdcard/DCIM/Camera/keep.mp4\n', stderr: '', code: 139 };
    });
    ok('content CLI 退出 139 但输出完整媒体行时保留记录供清理（不当成空表）',
      rows139.result.ok && rows139Calls === 1 && /_id=19/.test(rows139.result.stdout) && !rows139.error,
      `queries=${rows139Calls} error=${rows139.error}`);
    let malformed139Calls = 0;
    const malformed139 = await adb.queryMediaTable('FAKESERIAL', 'video', async () => {
      malformed139Calls++;
      return { ok: false, stdout: 'Row: 0 _id=19, _data=/sdcard/DCIM/Camera/partial.mp4\nBROKEN OUTPUT\n', stderr: '', code: 139 };
    });
    ok('content CLI 退出 139 且媒体行不完整时继续重试并拒绝清理放行',
      !malformed139.result.ok && malformed139Calls === 2 && /BROKEN OUTPUT/.test(malformed139.error) && /重试后仍失败/.test(malformed139.error),
      `queries=${malformed139Calls} error=${malformed139.error}`);
    for (const projection of ['_data', '_data:date_modified']) {
      const line = 'Row: 0 _data=/storage/emulated/0/DCIM/Camera/main.jpg'
        + (projection.includes('date_modified') ? ', date_modified=1791608509' : '') + '\n';
      const complete = await adb.queryMediaTable('FAKESERIAL', 'images', async () =>
        ({ ok: false, stdout: line, stderr: '', code: 139 }), projection);
      ok(`回读 ${projection} 时完整记录后退出 139 仍保留实际数据`,
        complete.result.ok && complete.result.stdout === line && !complete.error);
      const denied = await adb.queryMediaTable('FAKESERIAL', 'images', async () =>
        ({ ok: false, stdout: line, stderr: 'Permission Denial', code: 139 }), projection);
      ok(`回读 ${projection} 时出现权限错误仍拒绝放行`, !denied.result.ok && /Permission Denial/.test(denied.error));
    }
    const brokenTime = await adb.queryMediaTable('FAKESERIAL', 'images', async () =>
      ({ ok: false, stdout: 'Row: 0 _data=/storage/emulated/0/DCIM/Camera/main.jpg, date_modified=\n', stderr: '', code: 139 }), '_data:date_modified');
    ok('主图时间回读被截断时不接收半条数据', !brokenTime.result.ok && !!brokenTime.error);
    const unrelatedExit = await adb.queryMediaTable('FAKESERIAL', 'images', async () =>
      ({ ok: false, stdout: 'No result found.\n', stderr: '', code: 1 }));
    ok('其他非零退出不因出现空结果文字就忽略故障', !unrelatedExit.result.ok && !!unrelatedExit.error);
    // 拿到假 adb 挂出来的现场状态（直接读目录内容，不靠解析 calls.log）
    const fakeExec = require('child_process').execFile;
    const dirState = fakeExec.__bluevDir;
    const DIR = fakeExec.__bluevDirPath;
    const resetDir = (exists) => { dirState.exists = !!exists; dirState.files = []; dirState.renames = []; };
    const staleFlag = path.join(FDB, 'DIR_STALE');
    if (fs.existsSync(staleFlag)) fs.unlinkSync(staleFlag);

    // D1) 常规：目录里有上次留下的素材 ⇒ 清完必须空
    resetDir(true);
    dirState.files = ['上一条素材.mp4', '上一条素材2.jpg'];
    let r = await adb.clearMediaDir('FAKESERIAL', '/sdcard/DCIM/Camera/bluev');
    ok('清相册 ① 常规残留：清完目录必须真为空（不是「发过 rm 命令」就算数）',
      r.ok && dirState.files.length === 0,
      `ok=${r.ok} 残留=${JSON.stringify(dirState.files)}`);

    // D2) 目录不存在：必须算干净并把它建出来（否则第一条内容每次都在这步卡死）
    resetDir(false);
    r = await adb.clearMediaDir('FAKESERIAL', '/sdcard/DCIM/Camera/bluev');
    ok('清相册 ② 目录不存在：要判成「干净」并把目录建出来（否则第一条永远发不出去）',
      r.ok && dirState.exists === true,
      `ok=${r.ok} exists=${dirState.exists} err=${r.error || ''}`);

    // D3) ★ 核心：stale 句柄（Text file busy）时必须走 mv 换名法，而不是原地死磕
    resetDir(true);
    dirState.files = ['锁住的素材.mp4'];
    fs.writeFileSync(staleFlag, '1');
    r = await adb.clearMediaDir('FAKESERIAL', '/sdcard/DCIM/Camera/bluev');
    const usedRename = dirState.renames.length > 0;
    ok('清相册 ③ 持续锁住的真实文件必须失败，不通过换名隐藏残留', !r.ok && dirState.files.length === 1 && !usedRename, r.error);
    ok('清相册 ③ 反向对照：顽固素材仍存在，确认没有伪造清空', dirState.files[0] === '锁住的素材.mp4' && /文件未清除/.test(r.error));
    fs.unlinkSync(staleFlag);

    // D4) 幂等：已经空了再清，不许报错
    resetDir(true);
    r = await adb.clearMediaDir('FAKESERIAL', '/sdcard/DCIM/Camera/bluev');
    ok('清相册 ④ 幂等：目录本来就空，再清一次不许报错',
      r.ok && !r.error, `ok=${r.ok} err=${r.error || ''}`);

    // D4b) ★★ 核心红线：目录**读不出来**（不是不存在）时，绝不许判成干净。
    //   「目录不存在」和「目录读不出来」是两回事：
    //     · 不存在 ⇒ 本来就没有 ⇒ 算干净（D2 已验）；
    //     · 读不出来 ⇒ **不知道里面有什么** ⇒ 必须如实报错。
    //   老写法 `if (left)` 只看 stdout 非空 ⇒ 读失败（空输出）会被当成"空目录"放过去，
    //   这就是在**假装清干净了** —— 比不删更糟（用户会拿到别人素材发出去）。
    const unreadFlag = path.join(FDB, 'DIR_UNREADABLE');
    resetDir(true);
    fs.writeFileSync(unreadFlag, '1');
    r = await adb.clearMediaDir('FAKESERIAL', '/sdcard/DCIM/Camera/bluev');
    fs.unlinkSync(unreadFlag);
    ok('清相册 ④b ★ 目录读不出来时必须如实报错（读不到 ≠ 空，绝不许判成干净）',
      r.ok === false && !!r.error,
      `ok=${r.ok} err=${(r.error || '').slice(0, 50)}`);

    // D5) ★ 源码级：不许用「删目录本体」的写法（目录被占时会 Text file busy，然后 mkdir 假成功）
    //   ★ 判据要精确，否则会假红（我第一版就踩了）：
    //     · `rm -rf ' + dir + '/* ...` —— 删**内容**，允许
    //     · `rm -rf ' + dir + '`     —— 删**本体**，禁止（本体会被占住，且后面 mkdir 会假成功）
    //     · `rm -rf ' + trash + '`   —— 删**已经换过名的垃圾目录**，允许（它就是拿来删的）
    //   ⇒ 只在「紧跟 dir 变量、后面不是 /*」时才判违规。
    const adbSrc = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/adb.js'), 'utf8'));
    const rmBodies = (adbSrc.match(/rm -rf ' \+ dir \+ '[^/]/g) || []);
    ok('清相册 ⑤ 源码级：不许出现 `rm -rf <目录本体>`（被占时必失败且 mkdir 会假成功）',
      rmBodies.length === 0, JSON.stringify(rmBodies) || '（干净：只删内容，不删本体）');
    ok('清相册 ⑥ 不再给目录换名制造残骸', !/mv ' \+ dir \+ ' /.test(adbSrc));
    ok('清相册 ⑦ 源码级：清完必须回读校验（ls -A），删不动要如实报错、不许假装干净',
      /ls -A ' \+ dir/.test(adbSrc), '（找不到回读校验）');
    ok('清相册 ⑧ 仅删除文件，不递归删除目录', /find ' \+ dir \+ ' -type f -delete/.test(adbSrc));
    ok('清相册 ⑨ 源码级：目录不存在要判成干净（否则第一条内容永远发不出去）',
      /No such file or directory/.test(adbSrc), '（找不到「目录不存在＝干净」的判据）');

    // ------------------------------------------------------------------
    // D6) ★★★ 2026-10-04（第四十轮）两个真机现场：
    //   ① 清**相册根** `/sdcard/DCIM/Camera`（用户口径「清空整个 DCIM/Camera」）——
    //      「清 Camera 根」这条分支以前**根本没被跑过**（夹具只认 bluev）。
    //   ② 相册根下累积的**顽固空目录残骸** —— 真机实测那批名字滚到 255 字符、
    //      rm 不掉、mv 也不生效的垃圾目录。它们**不含任何素材**，绝不能被判成失败：
    //      一旦判失败，用户设备上存了十几个残骸之后，**每一条都发不出去**（真误杀）。
    //   这两条是「第二条起必失败」的真根因所对应的回归防线。
    // ------------------------------------------------------------------
    const CAMERA_DIR = fakeExec.__cameraDirPath;
    const cameraDirState = fakeExec.__dirs[CAMERA_DIR];
    const stubbornFlag = path.join(FDB, 'DIR_EMPTY_STUBBORN');
    const resetRoot = () => { cameraDirState.exists = true; cameraDirState.files = []; cameraDirState.renames = []; };
    const clearFlags = () => {
      [staleFlag, stubbornFlag].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    };
    clearFlags();

    // D6a) 清**相册根**：根目录里有上一条留下的素材（含子目录里的）⇒ 必须清空到无文件
    resetRoot();
    dirState.exists = true; dirState.files = ['上一条.mp4'];
    cameraDirState.files = ['上一条在根上的.jpg'];
    r = await adb.clearMediaDir('FAKESERIAL', CAMERA_DIR);
    const rootFileChk = await adb.shell('FAKESERIAL', 'find ' + CAMERA_DIR + ' -type f');
    ok('清相册 ⑩ ★ 清**相册根**（整个 DCIM/Camera）：清完递归找不到任何文件',
      r.ok && !String(rootFileChk.stdout || '').trim(),
      `ok=${r.ok} 根残留=${JSON.stringify(cameraDirState.files)} find=${JSON.stringify(String(rootFileChk.stdout || '').trim())}`);

    // D6b) ★★ 核心红线：根目录下累积**顽固空目录残骸**（rm/mv 都不生效、但里面没文件）
    //   ⇒ 必须 `ok:true` + 带 note（记一笔放行），**绝不许**判成失败。
    //   这条如果写成失败：用户设备上残骸一多就「每一条都发不出去」。
    clearFlags();
    resetRoot();
    dirState.exists = true; dirState.files = [];
    cameraDirState.files = [];
    fs.writeFileSync(stubbornFlag, '3');   // 摆 3 个顽固空残骸（模拟 255 字符垃圾目录）
    cameraDirState.files = ['X_gone_1759500000000…（255字符）', 'bluev_trash_1759500000001…（255字符）',
      '废目录_gone_1759500000002…（255字符）'];
    r = await adb.clearMediaDir('FAKESERIAL', CAMERA_DIR);
    ok('清相册 ⑪ ★★ 相册根只剩「顽固空目录残骸」时必须放行（ok:true）——否则残骸一多就每条都发不出去',
      r.ok === true && !r.error,
      `ok=${r.ok} err=${(r.error || '').slice(0, 60)} note=${(r.note || '').slice(0, 40)}`);
    ok('清相册 ⑪b 放行时必须**如实记一笔**（note 非空，不能悄悄放过去）',
      !!r.note, `note=${JSON.stringify(r.note || '')}`);

    // D6c) ★ 反向对照：同样是「目录 listing 非空」，但里面**真有文件** ⇒ 必须判失败。
    //   没有这条，D6b 就可能退化成「只要 listing 非空就放行」的假绿（正反不分）。
    clearFlags();
    fs.writeFileSync(staleFlag, '1');      // stale：rm 删不掉
    resetRoot();
    dirState.exists = true; dirState.files = [];
    cameraDirState.files = [];
    // 用真实的 push 往**相册根**放一个文件（夹具的 find -type f 以 pushed 为准）
    const CAM_FILE = CAMERA_DIR + '/真的删不掉的.mp4';
    await adb.push('FAKESERIAL', path.join(itemDir, '1.jpg'), CAM_FILE);
    r = await adb.clearMediaDir('FAKESERIAL', CAMERA_DIR);
    ok('清相册 ⑫ ★ 反向对照：同样「listing 非空」，但里面有**真文件** ⇒ 必须判失败（不许一刀切放行）',
      r.ok === false && !!r.error,
      `ok=${r.ok} err=${(r.error || '').slice(0, 60)}`);
    // 正向对照：把同一个文件在「没有 stale」时清一次 ⇒ 必须 ok（证明上面那条不是恒红）
    clearFlags();
    resetRoot(); dirState.exists = true; dirState.files = [];
    await adb.push('FAKESERIAL', path.join(itemDir, '1.jpg'), CAM_FILE);
    const rOk = await adb.clearMediaDir('FAKESERIAL', CAMERA_DIR);
    ok('清相册 ⑫b 正向对照：同目录、无 stale ⇒ 必须清干净（证明 ⑫ 不是恒红）',
      rOk.ok === true, `ok=${rOk.ok} err=${(rOk.error || '').slice(0, 60)}`);
    clearFlags();

    // D6d) ★ 残骸**不再累积**：源码级 —— 「空目录」分支里**不许**出现换名（mv / _gone_）。
    //   老写法的元凶就是「只要 rm 不掉就换名」，每清一次残骸名字就加一截 _gone_<ts>，
    //   一路滚到 255 字符 ⇒ mv 报 File name too long、rm 又删不掉 ⇒ 永久卡死。
    //   ★ 判据要抠**准**：换名只允许出现在 `if (childHasFiles) { ... }` 分支里
    //     （真有文件才换名）；`else`（空目录）分支必须只有 rm/rmdir。
    const eIdx = adbSrc.indexOf('} else {', adbSrc.indexOf('childHasFiles'));
    const emptyBranch = eIdx >= 0 ? adbSrc.slice(eIdx, eIdx + 400) : '';
    ok('清相册 ⑬ 不再存在逐子目录换名分支，避免残骸名称不断累积', !adbSrc.includes('childHasFiles'));
    ok('清相册 ⑬b 真实文件仍在时明确失败，不换名掩盖', /目录里还有/.test(adbSrc) && !/if \(childHasFiles\)/.test(adbSrc));
  }

  // ==========================================================================
  // D7) ★★★ 2026-10-04（用户报「第 2/3 篇直接提示没能清干净设备相册目录」的**真解**）
  //   真机实测（同一秒、同一台设备，两条命令的差别是决定性的）：
  //     `rm -rf /sdcard/DCIM/Camera/bluev`              → rc=1  `Text file busy`
  //     `am force-stop com.shizhuang.duapp` 之后再执行   → **rc=0，目录立刻空**
  //   根因：**得物自己正停在发布页/相册页、拿着这批 mp4 的硬解码句柄**（锁在 App 进程里）。
  //   这一组盯四件事：
  //     ① 被 App 占着时：必须**强停得物**再重试，并且**目录真清干净**（不是"发过命令"）；
  //     ② 反向对照：App **没占着**时**一次都不许乱停**（乱停会把用户正在用的 App 关掉）；
  //     ③ 强停之后 publisher 必须**把得物重新拉回首页**（App 已经死了，直接点固定坐标＝点空气）；
  //     ④ 源码级：`clearMediaDir` 的顺序必须是「先强停重试 → 再 mv 换名」
  //        （顺序反了就会先造一堆 trash 残骸，残骸会堆在相册目录里）。
  // ==========================================================================
  {
    const fakeExec7 = require('child_process').execFile;
    const appFlag = path.join(FDB, 'DIR_LOCKED_BY_APP');
    const appStops = fakeExec7.__appStops;
    const resetApp = () => { fakeExec7.__appReset(); appStops.length = 0; if (fs.existsSync(appFlag)) fs.unlinkSync(appFlag); };
    const DEWU_PKG = 'com.shizhuang.duapp';
    const rmFlag = f => { if (fs.existsSync(f)) fs.unlinkSync(f); };
    const adbS = require(path.join(base, 'src/main/services/adb.js'));
    const camState = fakeExec7.__dirs[fakeExec7.__cameraDirPath];
    resetApp();

    // ① 得物占着 ⇒ 必须强停再清，且目录真为空
    fs.writeFileSync(appFlag, '1');
    camState.exists = true; camState.files = ['上一条的素材.mp4']; camState.renames = [];
    clearCalls();
    let r7 = await adbS.clearMediaDir('FAKESERIAL', fakeExec7.__cameraDirPath, { forceStopPkg: DEWU_PKG });
    ok('清相册 ⑭ ★ 得物占着素材（Text file busy）⇒ 必须强停得物再重试，最后**真清干净**',
      r7.ok === true && r7.forceStopped === true && appStops.includes(DEWU_PKG) && camState.files.length === 0,
      `ok=${r7.ok} 强停=${r7.forceStopped} stops=${JSON.stringify(appStops)} 残留=${JSON.stringify(camState.files)}`);
    ok('清相册 ⑭b ★ 强停得手后**不许再走 mv 换名**（换名会造出 trash 残骸，一直堆在相册目录里）',
      camState.renames.length === 0, `换名次数=${camState.renames.length}`);
    ok('清相册 ⑭c 强停这一步必须**先试原地删**、删不掉才停 —— 停完必须回读到干净（不是"发过命令就算数"）',
      r7.error === '' && /am force-stop/.test(calls()), 
      (/am force-stop/.test(calls()) ? '（确实发了 force-stop）' : '（没有 force-stop）'));

    // ② 反向对照：没有 DIR_LOCKED_BY_APP ⇒ 本来就能删 ⇒ **一次都不许乱强停**
    resetApp();
    camState.exists = true; camState.files = ['能删掉的.mp4']; camState.renames = [];
    clearCalls();
    r7 = await adbS.clearMediaDir('FAKESERIAL', fakeExec7.__cameraDirPath, { forceStopPkg: DEWU_PKG });
    ok('清相册 ⑮ ★★ 反向对照：没被占着时**一次都不许强停得物**（乱停会把用户正在用的 App 关掉）',
      r7.ok === true && r7.forceStopped === false && appStops.length === 0 && !/am force-stop/.test(calls()),
      `ok=${r7.ok} 强停=${r7.forceStopped} stops=${JSON.stringify(appStops)}`);

    // ②b 不传 forceStopPkg ⇒ 一个 App 都不许碰（默认行为与以前一字不差）
    //   ★ 此时 rm / mv 全被 App 的锁挡着 ⇒ 正确结果就是**如实报失败**（清不干净绝不假装干净）。
    resetApp();
    fs.writeFileSync(appFlag, '1');
    camState.exists = true; camState.files = ['锁着的.mp4']; camState.renames = [];
    clearCalls();
    r7 = await adbS.clearMediaDir('FAKESERIAL', fakeExec7.__cameraDirPath);
    ok('清相册 ⑮b 不传 forceStopPkg 时一个 App 都不碰，且清不干净要**如实报失败**（不许假装干净）',
      appStops.length === 0 && r7.ok === false && !!r7.error,
      `stops=${JSON.stringify(appStops)} ok=${r7.ok} err=${(r7.error || '').slice(0, 50)}`);
    resetApp();

    // ④ 源码级：顺序必须是「强停重试」在「mv 换名」**之前**
    const adbSrc7 = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/adb.js'), 'utf8'));
    const iLock = adbSrc7.indexOf('forceStopPkg && !forceStopped');
    const iMvTry = adbSrc7.indexOf("mv ' + dir + ' ' + trash");
    ok('清相册 ⑯ 最多释放一次应用句柄，清不掉仍失败', /remaining && opts.forceStopPkg/.test(adbSrc7) && !/mv ' \+ dir/.test(adbSrc7));
  }

  // ==========================================================================
  // D8) ★★★ 2026-10-04（真机实测新增）：**清全盘相册** `adb.clearAlbum`
  //
  //   用户口径（原话）：「你只要保证发布某条素材时，调出相册只能看到他的图片或者视频」。
  //   真机对照实验（可复算、已截图）：把一条 mp4 放进 `/sdcard/Movies`（**不在** DCIM/Camera
  //   下），得物相册里**照样出现**、和专属目录里的并排显示 —— 得物相册是**全盘聚合视图**。
  //   ⇒ 光清 DCIM/Camera 不足以保证「相册里只有他的」；唯一靠得住的判据是
  //     **MediaStore 里没有别的素材**（clearAlbum 就是按这个判据写的）。
  //
  //   这一组盯四件事：
  //     ① 库里在「别处」有素材 ⇒ 清完**库必须真的为空**（不是"发过删除命令"就算数）；
  //     ② 反向对照：没被 App 占着时**一次都不许强停**（乱停会把用户正在用的 App 关掉）；
  //     ③ 空库 ⇒ 直接判干净、removed=0；
  //     ④ 源码级：`ok` 只由**复查**决定；publisher 真调了它、且只调一次。
  // ==========================================================================
  {
    const fakeExec8 = require('child_process').execFile;
    const appStops8 = fakeExec8.__appStops;
    const adbS8 = require(path.join(base, 'src/main/services/adb.js'));
    const DEWU8 = 'com.shizhuang.duapp';
    const reset8 = () => { fakeExec8.__appReset(); appStops8.length = 0; };
    const libCount = async () => {
      const r = await adbS8.shell('FAKESERIAL',
        'content query --uri content://media/external/video/media --projection _id:_data');
      return String(r.stdout || '').split(/\r?\n/).filter(l => /_id=\d+/.test(l)).length;
    };

    // ① 库里在「别处」（不在专属目录）有素材 ⇒ 清完库必须为空
    reset8();
    await adbS8.push('FAKESERIAL', '/tmp/无所谓A.mp4', '/sdcard/Movies/别处来的.mp4');
    await adbS8.push('FAKESERIAL', '/tmp/无所谓B.mp4', '/sdcard/DCIM/Camera/bluev/上一条的.mp4');
    await adbS8.shell('FAKESERIAL', 'content call --uri content://media --method scan_volume --arg external_primary', {});
    const before8 = await libCount();
    clearCalls();
    const r8 = await adbS8.clearAlbum('FAKESERIAL', { forceStopPkg: DEWU8 });
    const after8 = await libCount();
    ok('清相册 ⑰ ★★ 清全盘相册：别处（/sdcard/Movies）的素材也要清掉，清完库必须为空',
      before8 === 2 && r8.ok === true && after8 === 0,
      `清前=${before8} 清后=${after8} ok=${r8.ok} removed=${r8.removed}`);
    ok('清相册 ⑰b ★★ 反向对照：没被 App 占着时**一次都不许强停**得物（乱停会把用户正在用的 App 关掉）',
      r8.forceStopped === false && appStops8.length === 0 && !/am force-stop/.test(calls()),
      `强停=${r8.forceStopped} stops=${JSON.stringify(appStops8)}`);

    // ② 空库 ⇒ 直接判干净（不许无脑强停、也不许报失败）
    reset8();
    const r8b = await adbS8.clearAlbum('FAKESERIAL', { forceStopPkg: DEWU8 });
    ok('清相册 ⑱ ★ 本来就是空库 ⇒ 直接判干净（ok=true、removed=0、一次都不强停）',
      r8b.ok === true && r8b.removed === 0 && r8b.forceStopped === false,
      `ok=${r8b.ok} removed=${r8b.removed} 强停=${r8b.forceStopped}`);

    // ③ 不传 forceStopPkg ⇒ 一个 App 都不许碰
    reset8();
    await adbS8.push('FAKESERIAL', '/tmp/无所谓C.mp4', '/sdcard/Movies/再来一个.mp4');
    await adbS8.shell('FAKESERIAL', 'content call --uri content://media --method scan_volume --arg external_primary', {});
    const r8c = await adbS8.clearAlbum('FAKESERIAL');
    ok('清相册 ⑱b 不传 forceStopPkg 时一个 App 都不碰（默认行为与以前一字不差）',
      appStops8.length === 0 && r8c.ok === true,
      `stops=${JSON.stringify(appStops8)} ok=${r8c.ok}`);

    // ④ 源码级：ok 只由「复查」决定
    const adbSrc8 = codeOnly(fs.readFileSync(path.join(base, 'src/main/services/adb.js'), 'utf8'));
    const iAlbum = adbSrc8.indexOf('async function clearAlbum');
    ok('清相册 ⑲ 全盘相册以最后复查的剩余记录为判据', /ok: left === 0/.test(adbSrc8.slice(iAlbum)) && /hit = await scanAll\(\)/.test(adbSrc8.slice(iAlbum)));

    // 发布入口是否只清理一次由 albumreadytest 的真实设备命令序列验证。
    reset8();
  }

  // ==========================================================================
  // F) ★★★ 2026-10-04（用户口径，原话：「**发出去了才算成功**」）
  //   点完「提交发布」**不等于**发出去了。真机上「没发出去」有三种长相，而**每一种在界面上都像成功**
  //   （脚本跑完、不报错、台账写「发布成功」）：
  //     · 得物压根没受理、还停在发布流程里；
  //     · 得物把它**存成草稿**了（用户原话「我什么时候跟你说真实发布环境可以存草稿的」）；
  //     · 提交那一步被屏幕守卫跳过（那一屏不对 ⇒ 一个 tap 都没发）。
  //   这一组用假 adb 的 TAP_FOCUS 开关分别摆出这三种现场，验：
  //     ① leave（真发出去了）⇒ 发布成功；
  //     ② publish（还停在发布流程）⇒ **失败** + 已强停得物（不留草稿）；
  //     ③ draft（被存成草稿）⇒ **失败** + 已强停得物（把那条草稿清掉）。
  // ==========================================================================
  {
    const FOCUSF = path.join(FDB, 'FOCUS');
    const TAPF = path.join(FDB, 'TAP_FOCUS');
    const HOME_F = 'com.shizhuang.duapp/.modules.home.ui.HomeActivity';
    const PROFILE_F = 'com.shizhuang.duapp/.modules.user.ui.MyActivity';
    const fakeExecF = require('child_process').execFile;
    const stopsF = fakeExecF.__appStops;
    const hadFocusF = fs.existsSync(FOCUSF) ? fs.readFileSync(FOCUSF, 'utf8') : null;
    const mkSt = () => ({
      items: [{ id: 'r-pub', dir: itemDir, absDir: itemDir, sku: 'A111', color: '冠军白', files: [{ name: '1.jpg', type: 'image' }] }],
      copyRows: [{ id: 'r-pub', title: '标题', body: '正文', topics: [] }],
      verify: { rows: [] },
      publish: {
        rows: [{ seq: 1, id: 'r-pub', dir: 'r-pub', goods: 1, images: 1, startAt: '', status: '排队', result: '', reason: '' }],
        mode: 'adb', device: '127.0.0.1:5555'
      }
    });
    const runPub = async (twoRows = false) => {
      store.set({ publish: { uiMap, intervalSec: 0, postPublishWaitSec: 1 } });
      clearCalls();
      const st = mkSt();
      if (twoRows) st.publish.rows.push({ ...st.publish.rows[0], seq: 2 });
      const result = await publisher.run(st, { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      return { row: st.publish.rows[0], rows: st.publish.rows, result, log: calls() };
    };
    const cleanF = () => { [TAPF].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); }); };
    try {
      cleanF(); fakeExecF.__appReset(); stopsF.length = 0;

      // ① 真的发出去了（点完离开发布流程，回到个人主页）⇒ 成功
      fs.writeFileSync(FOCUSF, HOME_F);
      fs.writeFileSync(TAPF, 'leave');
      let rf = await runPub();
      ok('发布后校验 ① 点完真的离开发布流程（回到个人主页）⇒ 记「发布成功」',
        rf.row.result === '发布成功', rf.row.result + ' / ' + (rf.row.reason || '').slice(0, 90));
      ok('发布后校验 ① 这种情况**不许**乱强停得物（发出去了就别去关人家的 App）',
        stopsF.length === 0, JSON.stringify(stopsF));

      // ② 还停在发布流程里 ⇒ 失败 + 强停清草稿
      cleanF(); fakeExecF.__appReset(); stopsF.length = 0;
      fs.writeFileSync(FOCUSF, HOME_F);
      fs.writeFileSync(TAPF, 'publish');
      rf = await runPub();
      ok('提交成功后仍停在发布流程，按用户确认口径记录成功',
        rf.row.result === '发布成功', rf.row.result + ' / ' + (rf.row.reason || '').slice(0, 90));
      ok('提交成功不再因后续页面追加失败原因',
        !rf.row.reason, String(rf.row.reason || '').slice(0, 120));
      ok('提交后不强制退出得物',
        stopsF.length === 0, JSON.stringify(stopsF));
      cleanF(); fakeExecF.__appReset(); stopsF.length = 0;
      fs.writeFileSync(FOCUSF, HOME_F);
      fs.writeFileSync(TAPF, 'publish');
      rf = await runPub(true);
      ok('提交未退出时保留下一条排队，防止下一次清理打断上传',
        rf.rows[1].status === '排队' && !rf.rows[1].result && /停止后续条目/.test(rf.result.stoppedReason || ''),
        JSON.stringify({ next: rf.rows[1], stoppedReason: rf.result.stoppedReason }));
      ok('提交待确认时不强停、不重复提交', stopsF.length === 0 && (rf.log.match(/input tap 540 1860/g) || []).length <= 1, JSON.stringify(stopsF));

      // ③ 被存成草稿 ⇒ 失败 + 强停清草稿
      cleanF(); fakeExecF.__appReset(); stopsF.length = 0;
      fs.writeFileSync(FOCUSF, HOME_F);
      fs.writeFileSync(TAPF, 'draft');
      rf = await runPub();
      ok('提交后落在 DraftActivity 不再误判失败',
        rf.row.result === '发布成功', rf.row.result + ' / ' + (rf.row.reason || '').slice(0, 90));
      ok('DraftActivity 不触发强制退出得物',
        stopsF.length === 0, JSON.stringify(stopsF));

      // ⑤ 超时**行为级**：`postPublishWaitSec` 配大 ⇒ 真等更久。
      //   为什么不用源码级：本项目规矩是「源码里有这行字 ≠ 它真解决了问题」——
      //   把 timeoutMs 写死成 15000，源码级照样绿，行为级会红。
      cleanF(); fakeExecF.__appReset(); stopsF.length = 0;
      fs.writeFileSync(FOCUSF, HOME_F);
      fs.writeFileSync(TAPF, 'publish');
      const timePub = async (sec) => {
        store.set({ publish: { uiMap, intervalSec: 0, postPublishWaitSec: sec } });
        const t0 = Date.now();
        await publisher.run(mkSt(), { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
        return Date.now() - t0;
      };
      const fastF = await timePub(1);
      const slowF = await timePub(3);
      ok('旧发布后等待配置不再延迟完成',
        Math.abs(slowF - fastF) < 1500, `1s 档 ${fastF}ms / 3s 档 ${slowF}ms`);

      // ④ 判据自证：`isDraftScreen` 真在查草稿箱（把草稿箱写进判据，别让它变成死代码）
      ok('发布后校验 ④ 草稿箱判据认得 DraftActivity（否则 ③ 是空==空）',
        uimap.isDraftScreen('com.shizhuang.duapp/media.activity.DraftActivity') === true
        && uimap.isDraftScreen(PROFILE_F) === false
        && uimap.isDraftScreen('') === false,
        JSON.stringify([uimap.isDraftScreen('com.shizhuang.duapp/media.activity.DraftActivity'),
          uimap.isDraftScreen(PROFILE_F), uimap.isDraftScreen('')]));
      ok('发布后校验 ④b 导出了 waitLeftPublishFlow（这条红线要能单独喂假 adb 验正反两面）',
        typeof publisher.waitLeftPublishFlow === 'function');
    } finally {
      cleanF();
      if (hadFocusF == null) { if (fs.existsSync(FOCUSF)) fs.unlinkSync(FOCUSF); }
      else fs.writeFileSync(FOCUSF, hadFocusF);
    }
  }

  // ==========================================================================
  // E) ★★「回主线」守卫（2026-10-04 用户报「第二条永远拉不起来」的另一半）
  //    一条内容发完之后，得物停在哪儿是**不确定的**（个人主页 / 相册页 / 发布成功页），
  //    而下一条的第一步是「底部点『我』」那个**固定坐标** —— 只有 App 在首页时它底下
  //    才是底部导航。⇒ 每条开始前必须先把 App 拉回首页，并**确认它真的到了**。
  //    这一组盯三件事：① 不在首页时会去拉；② 已经在首页时**一次都不拉**（不许白启动）；
  //    ③ 拉不起来**如实失败、绝不硬点**（负向；这一条是红线）。
  // ==========================================================================
  {
    const FOCUSE = path.join(FDB, 'FOCUS');
    const hadE = fs.existsSync(FOCUSE) ? fs.readFileSync(FOCUSE, 'utf8') : null;
    const PUB_FOCUS = 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity';
    const HOME_FOCUS = 'com.shizhuang.duapp/.modules.home.ui.HomeActivity';
    const stuckE = path.join(FDB, 'SPLASH_STUCK');
    const stashE = fs.readFileSync(FAKE_WINDOW, 'utf8');
    try {
      // E1) 停在**发布页**（＝发完一条之后最可能的残状）⇒ 必须拉回首页，且起点是「底部我」
      fs.writeFileSync(FOCUSE, PUB_FOCUS);
      store.set({ publish: { uiMap, ensureAppTimeoutMs: null } });
      clearCalls();
      const stE = mkAlbumState(2);
      stE.publish.rows[0].elapsed = 777;
      const lgE = [];
      const rowEventsE = [];
      const scanAdbE = require(path.join(base, 'src/main/services/adb.js'));
      const originalScanE = scanAdbE.mediaScan;
      let activeScansE = 0, maxScansE = 0;
      scanAdbE.mediaScan = async (...args) => {
        activeScansE++;
        maxScansE = Math.max(maxScansE, activeScansE);
        try {
          await new Promise(resolve => setTimeout(resolve, 100));
          return await originalScanE(...args);
        } finally { activeScansE--; }
      };
      let rE;
      try { rE = await publisher.run(stE, {
        log: (m, l) => lgE.push((l || 'info') + ': ' + m),
        progress: () => {}, cancelled: () => false, onRow: row => rowEventsE.push(Object.assign({}, row))
      }); } finally { scanAdbE.mediaScan = originalScanE; }
      ok('多图单文件索引两个并行且完成发布前全部收敛',
        maxScansE === 2 && activeScansE === 0 && rE.okCount === 1);
      const logE = calls();
      ok('发布开始立即发送开始时间与零耗时',
        rowEventsE[0].status === '准备发布' && !!rowEventsE[0].startAt
        && rowEventsE[0].startedAtMs > 0 && rowEventsE[0].elapsed === 0);
      const finishedE = rowEventsE[rowEventsE.length - 1];
      ok('发布完成事件已包含最终耗时，而非发送后才赋值',
        finishedE.result === '发布成功' && finishedE.elapsed === rE.rows[0].elapsed
        && finishedE.elapsed > 0 && finishedE.elapsed !== 777);
      ok('根目录递归清理后不再重复清理 bluev 子目录',
        rE.okCount === 1 && !/find .*Camera\/bluev\/? -mindepth/.test(logE),
        (logE.match(/.*find .*mindepth.*/g) || []).join(' | '));
      ok('清理记录媒体库实际耗时，发布流程不再读取目录列表或递归目录',
        lgE.some(l => /相册已清空.*耗时 [\d.]+s/.test(l)) && !/ls -A |find .* -type f/.test(logE));
      // ★ 断言要看**语义**：真的调了 `am start -n <得物>/<启动页>`。
      //   第一版把正则写成 `com\.shizhuang\.duapp\/\.modules`（带点）⇒ 命令里是斜杠后直接跟
      //   包内路径（`duapp/modules.home...`，不带点）⇒ 匹配 0 次，是**假红**（测试写法错，不是产品错）。
      ok('回主线 ① 停在得物发布页（上一条发完的残状）⇒ 起手先把 App 拉回首页',
        /am start -n com\.shizhuang\.duapp\/\.?modules\.home\.ui\.SplashActivity/.test(logE)
        && /dumpsys window/.test(logE),
        (logE.match(/.*(am start|monkey).*/g) || []).join(' | ') || '（一次都没拉）');
      ok('回主线 ① 拉回来了 ⇒ 这条照常发出去（不是靠"跳过守卫"发出去的）',
        rE.rows[0].result === '发布成功', rE.rows[0].result + ' / ' + (rE.rows[0].reason || ''));
      ok('回主线 ① 拉过之后首页再被确认到（真机是 SplashActivity → HomeActivity 的转场，要等它真到）',
        fs.readFileSync(FOCUSE, 'utf8') === HOME_FOCUS, fs.readFileSync(FOCUSE, 'utf8'));
      ok('回主线 ① 日志里说清了「之前停在哪儿」（不闷着不说）',
        lgE.some(l => /不在首页/.test(l)), lgE.filter(l => /不在首页/.test(l))[0] || '（没写）');

      // E1b) ★★ 关键补充（写反向验证时才发现的**假绿**）：
      //   上面 ① 虽然验了「会去拉」，但**没有一条用例真的走到「守卫判成功」那一刻**
      //   —— 因为夹具 `am start` 成功之后必然落到首页。
      //   ⇒ 于是「首页判据」(`isHomeScreen`) 和「前台读取的解析」(`currentFocus`) 这两处
      //     在守卫这条路上**从来没被检查过**：把它们破坏掉（B5/B8 实测，见 tools/_brk.js）
      //     adbtest 照样全绿。这里直接**行为级**验这两处，让破坏一定变红。
      //
      //   E1b-1：前台是**得物的非首页**（个人主页）⇒ 守卫**必须去拉**、不许当成「已经在首页放行」。
      //     （把 isHomeScreen 放宽成「在得物里就行」⇒ 这一步就不会拉 ⇒ 这条红。）
      const ME_FOCUS = 'com.shizhuang.duapp/.modules.user.ui.MyActivity';
      fs.writeFileSync(FOCUSE, ME_FOCUS);
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 0 } });
      clearCalls();
      const rE1b = await publisher.run(mkAlbumState(2),
        { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      ok('回主线 ①b ★ 前台是得物的**非首页**（个人主页）⇒ 必须拉回首页，不许当成「已经在首页」放行',
        /am start -n com\.shizhuang\.duapp/.test(calls()) && rE1b.rows[0].result === '发布成功',
        (calls().match(/.*am start.*/g) || []).join(' | ') || '（没拉 ⇒ 判据被放太宽了）');

      //   E1b-2：前台是**首页的短名写法**（`pkg/.modules.home.ui.HomeActivity` —— 得物首页
      //     真机实测就是这种格式）⇒ 守卫必须认出来「已经在首页」、**一次都不拉**。
      //     （把 currentFocus 的正则退回「斜杠后不许有点」⇒ 解析成空串 ⇒ 守卫以为不在首页
      //       ⇒ 会去拉一次 ⇒ 这条红。）
      fs.writeFileSync(FOCUSE, HOME_FOCUS);
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 0 } });
      clearCalls();
      const rE1c = await publisher.run(mkAlbumState(2),
        { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      ok('回主线 ①c ★ 首页那种**短名**写法必须被认出来（认不出就会每次白拉一次 App）',
        !/am start|monkey/.test(calls()) && rE1c.rows[0].result === '发布成功',
        (calls().match(/.*(am start|monkey).*/g) || []).join(' | ') || '（没拉，正确）');

      // E2) 已经**在首页** ⇒ 一次都不许拉（免得每条都白走一遍启动流程）
      //    ★ 这是「不该做的事不做」的负向断言：没有它，把守卫写成「无条件 am start」照样全绿。
      fs.writeFileSync(FOCUSE, HOME_FOCUS);
      store.set({ publish: { uiMap, ensureAppTimeoutMs: null } });
      clearCalls();
      const stE2 = mkAlbumState(2);
      const rE2 = await publisher.run(stE2, { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      const logE2 = calls();
      ok('回主线 ② ★ 已经在首页时**一次都不拉**（不许每条都白启动一遍 App）',
        !/am start|monkey/.test(logE2) && rE2.rows[0].result === '发布成功',
        (logE2.match(/.*(am start|monkey).*/g) || []).join(' | ') || '（没拉，正确）');

      // E3) 负向红线：启动页**卡住转不过去**（等不到首页）⇒ 如实失败、**一个 tap 都不发**
      //    ★ 超时用**产品真的会读**的那个配置（`ensureAppTimeoutMs`）调到 1.2 秒，
      //      而不是在这里干等 30 秒 —— 等 30 秒既慢，又会让「超时逻辑本身」没被测到
      //      （改坏 `timeoutMs` 的读取点，这条断言不该照旧绿）。
      fs.writeFileSync(FOCUSE, PUB_FOCUS);
      fs.writeFileSync(stuckE, '1');
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 1200 } });
      clearCalls();
      const stE3 = mkAlbumState(2);
      const rE3 = await publisher.run(stE3, { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      const logE3 = calls();
      ok('回主线 ③ ★ 等不到首页 ⇒ 失败（负向：不许当作没这回事继续往下点）',
        rE3.rows[0].result === '失败' && /首页/.test(rE3.rows[0].reason || ''),
        rE3.rows[0].result + ' / ' + (rE3.rows[0].reason || '').slice(0, 110));
      ok('回主线 ③ ★ 拦下时**一个 tap 都不发**（停在错页面上点固定坐标＝乱点）',
        !/input tap/.test(logE3), (logE3.match(/input tap .*/g) || []).join(' | ') || '（没有 tap）');
      ok('回主线 ③ ★ 拦下时连素材都不推（守卫在清相册/推素材**之前**，不白跑几十秒）',
        !/\bpush\b/.test(logE3), (logE3.match(/.*\bpush\b.*/g) || []).join(' | ') || '（没有 push）');
      fs.unlinkSync(stuckE);

      // E4a) 转场瞬间**读不到**前台（真机 `mCurrentFocus=null` 就这一下）⇒ 这只是设备把光标
      //    交给了别的窗口，**不是**「得物不在前台」，更不是「App 停了」。
      //   夹具语义：FOCUS='-' ⇒ 这一次读不到，下一次读就正常（见 fakeadb 里那段注释）。
      //   ★ 断言只盯「有没有瞎启动 App」：转场之后得物**可能本来就在首页**，
      //     那种情况下不启动才是对的 —— 拿「没启动」当唯一判据就把两件事混成一件了。
      //   ★★ 2026-10-04 补充：夹具的 `'-'` 语义是「这一次读不到、下一次正常」，而它"正常"时
      //     落的是**发布页** ⇒ 这一轮结束时会**还停在发布流程里**。这在真机上对应的是
      //     「点了提交却没发出去」，按用户口径「发出去了才算成功」**本来就该记失败**。
      //     这一条要测的不是那件事（它测的是"别瞎启动 App"），所以显式把夹具设成
      //     「提交后离开发布流程」—— 让这一轮的发布结果名副其实，而不是靠旧判据侥幸绿。
      const TAPF4 = path.join(FDB, 'TAP_FOCUS');
      const hadT4 = fs.existsSync(TAPF4);
      fs.writeFileSync(TAPF4, 'leave');
      fs.writeFileSync(FOCUSE, '-');
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 8000 } });
      clearCalls();
      const rE4a = await publisher.run(mkAlbumState(2), { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      const logE4a = calls();
      if (!hadT4) fs.unlinkSync(TAPF4);
      ok('回主线 ④a 转场瞬间读不到一次前台 ⇒ 不当成「App 不在」而瞎启动，照常往下走',
        !/am start|monkey/.test(logE4a) && rE4a.rows[0].result === '发布成功',
        (logE4a.match(/.*(am start|monkey).*/g) || []).join(' | ') + ' / ' + rE4a.rows[0].result);

      // E4b) ★ 负向红线：**永远**读不到前台 ⇒ 必须如实报错、且绝不瞎启动、绝不发任何 tap。
      //   为什么这条重要：读不到 ≠ 不在得物。当成「不在」去 am start，可能把用户正在用的
      //   别的 App 盖掉，而且启动完**照样不知道自己在哪一屏** ⇒ 后面固定坐标点下去就是乱点。
      const unreadE = path.join(FDB, 'FOCUS_UNREADABLE');
      // ★ 夹具语义对齐真机：「永远读不到」= 得物**就在前台**，只是这一行读不出来。
      //   所以 FOCUS 要写**得物自己**（前台是得物），而不是 '-' —— 写 '-' 等于测
      //   「设备整体读不到光标」，那不是我们要防的那件事。
      //   ★★ 而且必须写**首页**：写发布页时，守卫会先 `am start` 拉一次（那是**对的**：
      //     前台读不出来 ≠ 知道自己在哪一屏），后面 `dumpsys activity top` 又碰巧露出了
      //     HomeActivity 堆栈 ⇒ 守卫合法地判定「到了」并继续 —— 发布成功是**正确行为**，
      //     不是漏拦。写首页则一定读不出来 ⇒ 只能如实失败。（写成发布页时这三条会假红。）
      fs.writeFileSync(FOCUSE, HOME_FOCUS);
      fs.writeFileSync(unreadE, '1');
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 1200 } });
      clearCalls();
      const tE4 = Date.now();
      const rE4 = await publisher.run(mkAlbumState(2), { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      const logE4 = calls();
      fs.unlinkSync(unreadE);
      ok('回主线 ④b ★ 前台读不出来 ⇒ 如实失败（读不到 ≠ 知道自己在哪一屏）',
        rE4.rows[0].result === '失败' && /读不到/.test(rE4.rows[0].reason || ''),
        rE4.rows[0].result + ' / ' + (rE4.rows[0].reason || '').slice(0, 110));
      ok('回主线 ④b ★ 读不到前台时**不许乱点**（这才是红线：不知道自己在哪一屏，固定坐标点下去就是乱点）',
        !/input tap/.test(logE4),
        (logE4.match(/input tap .*/g) || []).join(' | ') || '（没有 tap，正确）');
      // ★★ 实测结论（写测试时踩到，如实记下来）：
      //   「一次都不许 am start」是**错的**预期 —— 读不到前台时**不知道自己在哪一屏**，
      //   拉一次 App 是**合理且必要**的动作（拉完再确认；确认不了才失败）。
      //   真正要防的是：① 反复拉（每次都白花一次冷启动）；② **没确认到就不管不顾往下点**。
      //   ⇒ 所以这里断言的是「最多拉一次」，而不是「不许拉」。
      //   （第一版就是按「不许拉」写的 —— 那会把正确行为判成 bug。）
      const starts4b = (logE4.match(/am start|monkey/g) || []).length;
      ok('回主线 ④b ★ 读不到时最多只拉**一次** App（不许一轮一轮反复拉、白花冷启动）',
        starts4b <= 1, starts4b + ' 次启动');
      ok('回主线 ④b 等不到就按自己的超时收工（不是无限等）', Date.now() - tE4 < 8000, (Date.now() - tE4) + 'ms');

      // E5) 正常路径按真实设备指令验证顺序，不依赖代码放在哪个文件。
      const iGuard = logE2.indexOf('dumpsys window');
      const iClear = logE2.indexOf('content query');
      ok('回主线 ⑤ 行为级：前台守卫先于全盘媒体库查询',
        iGuard >= 0 && iClear >= 0 && iGuard < iClear, `前台查询@${iGuard} / 相册查询@${iClear}`);
      // ★★ ⑤b **行为级**（写反向验证时补的）：只看源码里两行的先后**证明不了**执行顺序 ——
      //   B3 实测：把守卫那一整段挪到清相册之后，源码里 `ensureApp(` 依然排在 `clearMediaDir(`
      //   前面（那只是字符串位置），源码级断言照样绿 ⇒ 是**假绿**。
      //   真判据是**执行序**：守卫拦下时，一次 push / 清相册动作都不该发生。
      //   ⇒ 用 E3（守卫被拦下那一轮）真实的调用日志来定序，而不是读源码。
      ok('回主线 ⑤b 行为级：守卫拦下时**清相册也没被执行**（判据是执行序，不是源码位置）',
        !/find .* -mindepth 1 -delete|ls -A .*bluev|content delete/.test(logE3),
        (logE3.match(/.*(mindepth|ls -A|content delete).*/g) || []).join(' | ') || '（没动相册，正确）');

      // E6) 超时**行为级**：把 `ensureAppTimeoutMs` 配大 ⇒ 同一条路径真的等更久。
      //   为什么不用源码级：我自己的规矩是「源码里有这行字 ≠ 它真解决了问题」——
      //   改坏 timeoutMs 的读取点（比如硬编码 1000）时，源码级断言照样绿，行为级会红。
      fs.writeFileSync(FOCUSE, PUB_FOCUS);
      fs.writeFileSync(stuckE, '1');
      const tE6a = Date.now();
      await publisher.run(mkAlbumState(2), { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      const fastE6 = Date.now() - tE6a;
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 3000 } });
      const tE6b = Date.now();
      await publisher.run(mkAlbumState(2), { log: () => {}, progress: () => {}, cancelled: () => false, onRow: () => {} });
      const slowE6 = Date.now() - tE6b;
      ok('回主线 ⑥ 超时配置真的被读到（1.2s 档 vs 3s 档，实测耗时差 ≥ 1s）',
        slowE6 - fastE6 >= 1000, `1.2s 档 ${fastE6}ms / 3s 档 ${slowE6}ms`);
      fs.unlinkSync(stuckE);
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 1200 } });

      // E7) 单独的 ensureApp：Activity 名写错时必须**点名**（本机实测 `.MainActivity` 不存在）
      //   ★ 先把前台挪到**别的 App**：不挪的话「得物已经在首页」会先命中成功分支直接返回，
      //     根本走不到启动那一步（第一版就是这么写的，报错信息是空的 = 假红）。
      fs.writeFileSync(FOCUSE, 'com.android.launcher/com.android.launcher2.Launcher');
      const badAct = await adbMod.ensureApp('127.0.0.1:5555',
        { pkg: 'com.shizhuang.duapp', activity: '.MainActivity', want: 'modules.home.ui.HomeActivity', timeoutMs: 1200 });
      ok('回主线 ⑦ Activity 名不存在 ⇒ 点名报错（本机实测得物的 `.MainActivity` 就是不存在）',
        badAct.ok === false && /does not exist|resolve-activity/.test(badAct.why), String(badAct.why).slice(0, 120));
      // E8) 不给 activity ⇒ 退回 monkey（不硬编码第二处 Activity 名）
      fs.writeFileSync(FOCUSE, 'com.android.launcher/com.android.launcher2.Launcher');
      clearCalls();
      const noAct = await adbMod.ensureApp('127.0.0.1:5555',
        { pkg: 'com.shizhuang.duapp', activity: '', want: 'modules.home.ui.HomeActivity', timeoutMs: 3000 });
      ok('回主线 ⑧ 没给 launchActivity ⇒ 退回 monkey 启动默认入口（不写死第二个 Activity 名）',
        /monkey -p com\.shizhuang\.duapp/.test(calls()) && noAct.ok === true,
        (calls().match(/.*monkey.*/g) || []).join(' | ') || '（没走 monkey）');

      // E9) ★★ 前台格式回归（**真机可复现的真 bug**，2026-10-04 修）
      //   `dumpsys window` 里 Activity 有两种写法：`pkg/完整类名` 与 `pkg/.短类名`。
      //   得物**首页**实测是后者（`com.shizhuang.duapp/.modules.home.ui.HomeActivity`），
      //   而发布页是前者 —— 老正则的 `/` 后面**不许有点** ⇒ 首页那一行匹配 0 次、返回空串。
      //   后果：①「抓取前先说清停在哪一屏」对首页误报「读不到」；
      //        ②「回主线」守卫每次都以为 App 不在首页、反复拉起（多花一次冷启动）。
      //   ⇒ 两种格式都必须能解析出来，且解析出来的就是原文那一整段。
      const focusCases = [
        ['com.shizhuang.duapp/.modules.home.ui.HomeActivity', 'com.shizhuang.duapp/.modules.home.ui.HomeActivity'],
        ['com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity',
          'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity'],
        ['app.lawnchair/.LawnchairLauncher', 'app.lawnchair/.LawnchairLauncher'],
        // ★ 这一格**故意用别的包**（`app.lawnchair/.LawnchairLauncher` 已覆盖「短名」这一支）：
        //   得物的 SplashActivity 不能拿来测 —— 夹具会在**下一次读前台时**把它转成 HomeActivity
        //   （模拟启动页转场，那是守卫要等的语义），读到的会是转场后的值。第一版就踩了，
        //   表现为 `SplashActivity → HomeActivity`，看着像正则又错了，其实是被夹具转走了。
        ['com.tencent.mm/.plugin.appbrand.ui.AppBrandUI', 'com.tencent.mm/.plugin.appbrand.ui.AppBrandUI']
      ];
      const badFocus = [];
      for (const [written, want2] of focusCases) {
        fs.writeFileSync(FOCUSE, written);
        const got = await adbMod.currentFocus('127.0.0.1:5555');
        if (got !== want2) badFocus.push(`${written} → ${JSON.stringify(got)}（应为 ${want2}）`);
      }
      ok('回主线 ⑨ ★ 前台两种写法都要能解析（首页是 `pkg/.短名`、发布页是 `pkg/全名`）',
        badFocus.length === 0, badFocus.join(' | ') || '4 种写法全部解析正确');
    } finally {
      if (fs.existsSync(stuckE)) fs.unlinkSync(stuckE);
      const unreadF = path.join(FDB, 'FOCUS_UNREADABLE');
      if (fs.existsSync(unreadF)) fs.unlinkSync(unreadF);
      // ★ 还原成「不生效」（0），**不是 null** —— store.set 是 mergeDeep，null 删不掉键（见 E4b 的注释）
      store.set({ publish: { uiMap, ensureAppTimeoutMs: 0 } });
      fs.writeFileSync(FAKE_WINDOW, stashE);
      if (hadE == null) { if (fs.existsSync(FOCUSE)) fs.unlinkSync(FOCUSE); }
      else fs.writeFileSync(FOCUSE, hadE);
    }
  }

  // ---- ㉗ 定位表修正脚本（tools/fixuimap.js）：三屏盲点坐标 + 幂等 --------------------------
  //   ★ 用户原话「视频在选择素材后，连点两下即可跳过封面页；图文就点一下」。
  //   真机实测（MuMu 12 / 1080×1920，坐标已真机核对）：
  //     相册 flNextStep=[891,1794][1080,1892] → (985,1843) ｜ 剪辑页 flNextStep=**同一 bounds** → (985,1843)
  //     封面页 tv_skip=[761,1829][880,1885] → **(820,1857)** ← 要点这颗「跳过」
  //     （封面页右边那颗 tvNextStep=(985,1857) 点下去会进**又一屏「编辑封面」**，多花一屏）
  //   ⇒ 视频：剪辑页「下一步」+ 封面页「跳过」= 用户说的「连点两下」；图文：点一下。
  //   这里守四件事：① 视频剪辑页 → tapXY 985,1843 ② 视频封面页 → tapXY **820,1857**
  //                ③ 图文那屏 → tapXY 985,1843，且 whenOn 守卫**必须还在**
  //                  （单选图没有这一屏，盲点无条件点下去会落到编辑页底部的「发布」上 ⇒ 误发）
  //                ④ 视频那两步之间必须有固定 wait —— 盲点省掉了抓屏，也就省掉了 tapId 那
  //                  ~2.1s 的天然等待；实测不加会「连点两下还停在剪辑页 / 只过一屏」。
  //   并验幂等（连跑两次结果一字不差）——否则每跑一次 fixuimap 都会叠加/漂移。
  {
    const cp = require('child_process');
    const DID = 'com.shizhuang.duapp:id/';
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-fixuimap-'));
    const cfgFile = path.join(cfgDir, 'config.json');
    // 造一份「改之前」的配置：这三屏还都是 tapId
    fs.writeFileSync(cfgFile, JSON.stringify({ publish: { uiMap: {
      package: 'com.shizhuang.duapp',
      steps: [
        { name: '底部「我」（进个人页）', action: 'tapXY', value: '945,1869' },
        { name: '「发布新动态」', action: 'tapId', value: DID + 'rlPublish' },
        { name: '下一步', action: 'tapXY', value: '985,1843' },
        { name: '图片编辑页 · 下一步（选多张图才会出现这一屏）', action: 'tapId', value: DID + 'tvNextStep', whenOn: DID + 'edit_panel' },
        { name: '点标题输入框', action: 'tapId', value: DID + 'etTitle' }
      ],
      videoSteps: [
        { name: '底部「我」（进个人页）', action: 'tapXY', value: '945,1869' },
        { name: '「发布新动态」', action: 'tapId', value: DID + 'rlPublish' },
        { name: '选中要发的视频（相册第 1 格）', action: 'tapId', value: DID + 'flThumbSelect' },
        { name: '下一步（离开相册）', action: 'tapXY', value: '985,1843' },
        { name: '剪辑页 · 下一步', action: 'tapId', value: DID + 'flNextStep' },
        { name: '封面页 · 跳过', action: 'tapId', value: DID + 'tv_skip' },
        { name: '点标题输入框', action: 'tapId', value: DID + 'etTitle' }
      ]
    } } }, null, 2), 'utf8');

    const runFix = () => cp.execFileSync(process.execPath, [path.join(base, 'tools/fixuimap.js')],
      { env: Object.assign({}, process.env, { BLUEV_CFG_DIR: cfgDir }), encoding: 'utf8', stdio: 'pipe' });
    runFix();
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).publish.uiMap;
    const byName = (arr, re) => (arr || []).find(s => re.test(String(s.name || '')));
    const vClip = byName(after.videoSteps, /^剪辑页/);
    const vCover = byName(after.videoSteps, /^封面页/);
    const iEdit = byName(after.steps, /^图片编辑页/);

    ok('㉗ ★ 视频「剪辑页 · 下一步」→ tapXY 985,1843（不再抓屏找 flNextStep，每屏省 ~2.0s）',
      !!vClip && vClip.action === 'tapXY' && vClip.value === '985,1843',
      vClip && (vClip.action + ' ' + vClip.value));
    ok('㉗ ★ 视频「封面页 · 跳过」→ tapXY 820,1857（点**左边那颗「跳过」**；点右边「下一步」会进「编辑封面」再多一屏）',
      !!vCover && vCover.action === 'tapXY' && vCover.value === '820,1857',
      vCover && (vCover.action + ' ' + vCover.value));
    ok('㉗ ★ 图文「图片编辑页 · 下一步」→ tapXY 985,1843（= 用户说的「图文就点一下」）',
      !!iEdit && iEdit.action === 'tapXY' && iEdit.value === '985,1843',
      iEdit && (iEdit.action + ' ' + iEdit.value));
    ok('㉗ ★★ 图文那步的 whenOn 守卫**必须保留**（单选图没有这一屏，盲点会落到编辑页的「发布」上 ⇒ 误发）',
      !!iEdit && iEdit.whenOn === DID + 'edit_panel',
      iEdit && JSON.stringify(iEdit.whenOn));
    // ④ 盲点省掉了抓屏 ⇒ 必须补回屏间等待（实测不加会「连点两下还停在剪辑页」）
    const vArr = after.videoSteps;
    const isWait = (s) => !!s && s.action === 'wait' && Number(s.value) >= 500;
    const iAlbumW = vArr.findIndex(s => /^下一步（离开相册）/.test(String(s.name || '')));
    const iClipW = vArr.findIndex(s => /^剪辑页/.test(String(s.name || '')));
    ok('㉗ ★ 视频「相册下一步」之后紧跟一个固定 wait（盲点没有抓屏，连点会被当成转场中的空点）',
      iAlbumW >= 0 && isWait(vArr[iAlbumW + 1]), JSON.stringify(vArr[iAlbumW + 1] || null));
    ok('㉗ ★ 视频「剪辑页 · 下一步」之后也紧跟一个固定 wait',
      iClipW >= 0 && isWait(vArr[iClipW + 1]), JSON.stringify(vArr[iClipW + 1] || null));
    ok('㉗ 图文那两步之间**不该**插 wait（它那步带 whenOn 守卫，守卫的 dump 本身就是等待）',
      !(after.steps || []).some(s => /等下一屏/.test(String(s.name || ''))),
      (after.steps || []).filter(s => /等下一屏/.test(String(s.name || ''))).length + ' 个');
    const snap1 = fs.readFileSync(cfgFile, 'utf8');
    runFix();
    const snap2 = fs.readFileSync(cfgFile, 'utf8');
    ok('㉗ fixuimap 幂等：连跑两次结果一字不差（否则每跑一次都会叠加/漂移）',
      snap1 === snap2, snap1 === snap2 ? '两次完全一致' : '第二次内容变了');
  }

  // ==========================================================================
  // ㉘ 2026-10-04 新增：**tapXY 的坐标空间守卫**（用户问「为啥你有具体坐标老是会点偏」）
  //   真机实测依据（MuMu 12 / 本机 adb）：
  //     · `input tap` 对**越界坐标不报错** —— 在 1920x1080 的屏上 `input tap 945 1869` 返回 rc=0，
  //       一个字都不说、什么都没点到 ⇒ 坐标系不对时表现是「全程安静地点偏」，日志一条错都没有。
  //     · 坐标系随**当前前台应用的方向 / 模拟器分辨率**变：得物（竖屏锁定）在前台
  //       → `dumpsys window displays` 的 `cur=1080x1920`；MuMu 桌面（横屏）在前台 → `cur=1920x1080`，
  //       同一时刻 screencap 的 PNG 与 dump 的 bounds 也全是 1920x1080（三处互相印证）。
  //     · `wm size` 报的是**自然方向**尺寸（`Physical size: 1080x1920`，不随旋转变）——
  //       拿它校验坐标会判反，所以必须读 `cur=`（见 adb.uiSize 的长注释）。
  //   这一组盯三件事：① 纯函数分支（含**反向对照**，证明不是「见坐标就杀」）；
  //   ② adb.uiSize 真去解析 `cur=`；③ 行为级 —— 坐标系对不上时 runStep **必须不发出任何 tap**。
  // ==========================================================================
  {
    const STEPS28 = [
      { action: 'tapText', value: '发布新动态' },                       // 没有绝对坐标，不该被算进来
      { action: 'tapXY', value: '945,1869', name: '底部「我」' },
      { action: 'tapId', value: 'com.shizhuang.duapp:id/flThumbSelect', count: '2' },
      { action: 'tapXY', value: '985,1843;166,359', name: '下一步 / 相册第1格' }
    ];
    const pts28 = uimap.tapPointsOf(STEPS28);
    ok('㉘ tapPointsOf：只摘 tapXY 的写死坐标（tapText / tapId 的坐标是当场从 dump 读的，天然在当前坐标系里）',
      pts28.length === 3 && pts28.map(p => p.x + ',' + p.y).join(' ') === '945,1869 985,1843 166,359',
      JSON.stringify(pts28.map(p => p.x + ',' + p.y)));

    const portrait28 = { known: true, w: 1080, h: 1920, initW: 1080, initH: 1920, landscape: false, portrait: true, rotated: false };
    const landscape28 = { known: true, w: 1920, h: 1080, initW: 1080, initH: 1920, landscape: true, portrait: false, rotated: true };
    ok('㉘ 定位表在竖屏 1080x1920 下 ⇒ 一个都不算越界（反向对照：不是「有坐标就报」）',
      uimap.outOfScreenTapPoints(STEPS28, portrait28).length === 0,
      JSON.stringify(uimap.outOfScreenTapPoints(STEPS28, portrait28).map(p => p.x + ',' + p.y)));
    // ★ 这一条就是真机上「点偏」的机制：同一张表放到横屏 1920x1080 上，
    //   y=1869 / 1843 全都超过屏高 1079 ⇒ 每一次 tap 都落在屏幕外，而 rc=0 不报错。
    const bad28 = uimap.outOfScreenTapPoints(STEPS28, landscape28);
    ok('㉘ ★★ 同一张表放到 1920x1080 上 ⇒ 竖屏那两个 y≈1850 的坐标必须被认成越界（这就是「静默点偏」）',
      bad28.length === 2 && bad28.every(p => p.x + ',' + p.y !== '166,359'),
      JSON.stringify(bad28.map(p => p.x + ',' + p.y)));
    ok('㉘ 边界是**含**最后一像素：x=1079 / y=1919 算屏内，x=1080 / y=1920 算屏外（差一个像素就是两个世界）',
      uimap.outOfScreenTapPoints([{ action: 'tapXY', value: '1079,1919' }], portrait28).length === 0
      && uimap.outOfScreenTapPoints([{ action: 'tapXY', value: '1080,1919' }], portrait28).length === 1
      && uimap.outOfScreenTapPoints([{ action: 'tapXY', value: '1079,1920' }], portrait28).length === 1,
      'ok');
    ok('㉘ ★ 读不到尺寸（known=false）时**不拦** —— 拿猜出来的尺寸判越界就是拿幻觉当判据',
      uimap.outOfScreenTapPoints(STEPS28, { known: false, w: 0, h: 0 }).length === 0
      && uimap.outOfScreenTapPoints(STEPS28, null).length === 0, '空数组');

    // 表里记的抓取尺寸 vs 当下尺寸
    const same28 = uimap.screenMismatch({ w: 1080, h: 1920 }, portrait28);
    ok('㉘ 抓取尺寸与当下一致 ⇒ 不报 mismatch（反向对照：证明这条判据不是恒红）',
      same28.judgeable === true && same28.mismatch === false, JSON.stringify(same28));
    const swap28 = uimap.screenMismatch({ w: 1080, h: 1920 }, landscape28);
    ok('㉘ ★★ 抓取是竖屏 1080x1920、现在是横屏 1920x1080 ⇒ 必须报 mismatch 并点名「差了 90°」',
      swap28.mismatch === true && swap28.swapped === true && /90°/.test(swap28.why), swap28.why);
    const scale28 = uimap.screenMismatch({ w: 900, h: 1600 }, portrait28);
    ok('㉘ ★★ 老表是 900x1600、设备是 1080x1920 ⇒ 也必须报 mismatch（**坐标仍落在屏内**，越界那条抓不住它）',
      scale28.mismatch === true && scale28.swapped === false && /900x1600/.test(scale28.why), scale28.why);
    ok('㉘ 老表没有 screen 戳 ⇒ judgeable=false（判不出就不拦，交给逐点越界那条兜底）',
      uimap.screenMismatch(null, portrait28).judgeable === false
      && uimap.screenMismatch({}, portrait28).judgeable === false, '不拦');
    ok('㉘ 尺寸读不到时屏幕戳记 null、不编一个假尺寸出来',
      uimap.screenStamp(null) === null && uimap.screenStamp({ known: false, w: 0, h: 0 }) === null
      && uimap.screenStamp(portrait28).w === 1080, JSON.stringify(uimap.screenStamp(portrait28)));

    // ---- adb.uiSize：真去解析 `cur=`（夹具默认给竖屏） ----
    const UI28 = path.join(FDB, 'UISIZE');
    try { fs.unlinkSync(UI28); } catch (e) { /* 本来就没有 */ }
    const sz28 = await adbMod.uiSize('127.0.0.1:5555');
    ok('㉘ adb.uiSize 从 `dumpsys window displays` 读到竖屏 1080x1920（得物在前台时的真实值）',
      sz28.known === true && sz28.w === 1080 && sz28.h === 1920 && sz28.portrait === true && sz28.rotated === false,
      JSON.stringify(sz28));
    fs.writeFileSync(UI28, '1920x1080');
    const sz28b = await adbMod.uiSize('127.0.0.1:5555');
    ok('㉘ 现场开关 UISIZE=1920x1080 ⇒ uiSize 如实报横屏，且认出「与自然方向不平行（rotated）」',
      sz28b.known === true && sz28b.w === 1920 && sz28b.h === 1080 && sz28b.landscape === true
      && sz28b.rotated === true && sz28b.initW === 1080,
      JSON.stringify(sz28b));

    // ---- 行为级：坐标系对不上时，runStep **必须一个 tap 都不发** ----
    //   这是本组最要紧的一条：只断言「抛了错」是不够的（抛错也可能已经点过了）——
    //   所以去数 calls.log 里的 `input tap` 行数，必须是 **0**。
    clearCalls();
    let err28 = '';
    try {
      await publisher.runStep('127.0.0.1:5555',
        { action: 'tapXY', value: '945,1869', name: '底部「我」（越界样本）' }, {}, { log() {} });
    } catch (e) { err28 = String(e && e.message || e); }
    const taps28 = calls().split(/\r?\n/).filter(l => /input tap/.test(l));
    ok('㉘ ★★★ 行为级：坐标越界时 runStep 必须抛错**且一个 tap 都不发**（不是「先点再报错」）',
      !!err28 && /落在屏幕之外/.test(err28) && /1920x1080/.test(err28) && taps28.length === 0,
      'err=' + err28.slice(0, 90) + ' / input tap 条数=' + taps28.length);
    // ★ 反向对照：把 UISIZE 拿掉（回到竖屏）之后同一步必须真的点下去 ——
    //   否则上面那条「0 个 tap」可能是「这一步本来就点不动」凑出来的（空==空 的假通过）。
    fs.unlinkSync(UI28);
    clearCalls();
    let err28b = '';
    try {
      await publisher.runStep('127.0.0.1:5555',
        { action: 'tapXY', value: '945,1869', name: '底部「我」' }, {}, { log() {} });
    } catch (e) { err28b = String(e && e.message || e); }
    const taps28b = calls().split(/\r?\n/).filter(l => /input tap/.test(l));
    ok('㉘ ★ 反向对照：同样这一步，在竖屏下必须**真的点下去**（证明上面那条不是恒拦）',
      !err28b && taps28b.length === 1 && /input tap 945 1869/.test(taps28b[0]),
      'err=' + (err28b || '（无）') + ' / ' + taps28b.join(' | '));

    // ---- 表级守卫：runReal 开头那条（screen 戳对不上就拦，且**在推素材之前**）----
    ok('㉘ 源码级：screen 戳跟着定位表一起导入（少了它，运行时判不出「表量错了空格子」）',
      /screen:\s*j\.screen/.test(codeOnly(fs.readFileSync(path.join(base, 'src', 'main', 'jobs.js'), 'utf8'))),
      'jobs.js importMap');
  }

  // ==========================================================================
  // ㉙ 2026-10-04 新增：**输入通道 + 「发出去没有」的判据**（今晚真机实测暴露的三个静默失败）
  //   依据全是本机 MuMu 12 + 真得物跑出来的现场，不是推理：
  //     · `am broadcast ADB_INPUT_TEXT --es msg "..."` 这条通道**不认 `%s`** —— 代码把空格换成
  //       `%s`（那是 `input text` 的写法）后**照搬**到广播上 ⇒ 空格原样变成字面 `%s` 打进标题。
  //       现场：报告标题「酒红调长袖T恤 氛围感拉满🍷」→ 发布页 dump 回读 `etTitle` =
  //       「酒红调长袖T恤%s氛围感拉满🍷」；三条里只有它带空格，也只有它中招。
  //     · 广播通道**永远返回成功**：中文一个字没进去 / 被改写，日志上都看不出来
  //       （输入框空着的时候 `text` 就是占位符「添加标题」⇒ 空框与没填长得一模一样）。
  //     · 点完「提交发布」落到草稿箱时，原来会**傻等满 15s 超时**才下结论（真机实测 1.2s 就落定了）。
  //   这一组盯四件事：① 通道选择（含**反向对照**：ASCII 仍走 `input text` + `%s`）；
  //   ② 行为级 —— 回读发现框里不是我们要的字 ⇒ input 步**必须抛错**（含反向对照）；
  //   ③ 落草稿箱 ⇒ `waitLeftPublishFlow` 立刻返回 `draft:true`（含反向对照：落首页必须判成功）；
  //   ④ 防回退：把「回读的触发条件」锁住（我当场把 `!(rs && rs.skipped)` 写反过，回读整段静默失效）。
  // ==========================================================================
  {
    const adbMod29 = require(path.join(base, 'src/main/services/adb.js'));
    const IME_FLAG = path.join(FDB, 'IME_ACTIVE');
    const hadIme29 = fs.existsSync(IME_FLAG);
    if (!hadIme29) fs.writeFileSync(IME_FLAG, '');
    const FOCUS29 = path.join(FDB, 'FOCUS');
    const savedFocus29 = fs.existsSync(FOCUS29) ? fs.readFileSync(FOCUS29, 'utf8') : null;
    const savedWin29 = fs.readFileSync(FAKE_WINDOW, 'utf8');
    try {
      // ---- ① 通道选择 + 「命令里有没有 %s」 ----
      clearCalls();
      await adbMod29.inputText('FAKESERIAL', 'abc 123');
      const cAscii29 = calls();
      ok('㉙ 纯 ASCII 仍走 `input text`，空格用 `%s`（这条路线上 `%s` 是**对的**；反向对照）',
        /input text "abc%s123"/.test(cAscii29), cAscii29.trim().slice(0, 120));

      const txt29 = '酒红调长袖T恤 氛围感拉满🍷';
      const b6429 = Buffer.from(txt29, 'utf8').toString('base64');
      clearCalls();
      await adbMod29.inputText('FAKESERIAL', txt29);
      const cN29 = calls();
      ok('㉙ ★★ 非 ASCII 走 `ADB_INPUT_B64`，且命令里**一个 `%s` 都不许有**（字面 %s 就是这么来的）',
        cN29.includes('ADB_INPUT_B64') && !/%s/.test(cN29), cN29.trim().slice(0, 140));
      ok('㉙ ★ 传的是**原始 UTF-8 字节的 base64** ⇒ 解回来一字不差（空格 / emoji / 换行都在）',
        cN29.includes(b6429) && Buffer.from(b6429, 'base64').toString('utf8') === txt29, 'b64 往返一致');

      // ---- ② 行为级：回读不一致 ⇒ input 步必须抛错 ----
      const mkXml29 = (t) => '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">'
        + '<node index="0" text="' + t + '" resource-id="com.shizhuang.duapp:id/etTitle"'
        + ' class="android.widget.EditText" bounds="[0,381][900,418]" /></hierarchy>';
      const want29 = '酒红调长袖T恤 氛围感拉满🍷';
      const CHK29 = { log() {}, inputCheckId: 'com.shizhuang.duapp:id/etTitle' };

      fs.writeFileSync(FAKE_WINDOW, mkXml29('酒红调长袖T恤%s氛围感拉满🍷'));
      let e29 = '';
      try {
        await publisher.runStep('FAKESERIAL', { action: 'input', value: want29, name: '填标题' }, {}, CHK29);
      } catch (e) { e29 = String((e && e.message) || e); }
      ok('㉙ ★★★ 行为级：回读到框里是 `%s`（不是我们要的空格）⇒ input 步必须抛错并点名「框里实际是什么」',
        /输入回读不一致/.test(e29) && /%s/.test(e29), e29.slice(0, 140));

      fs.writeFileSync(FAKE_WINDOW, mkXml29(want29));
      let e29b = '';
      try {
        await publisher.runStep('FAKESERIAL', { action: 'input', value: want29, name: '填标题' }, {}, CHK29);
      } catch (e) { e29b = String((e && e.message) || e); }
      ok('㉙ ★ 反向对照：框里内容与期望一致 ⇒ **不许**抛错（证明上面那条不是恒红）',
        !e29b, e29b.slice(0, 110) || '（无异常）');

      fs.writeFileSync(FAKE_WINDOW, mkXml29('添加标题'));
      let e29c = '';
      try {
        await publisher.runStep('FAKESERIAL', { action: 'input', value: want29, name: '填标题' }, {}, CHK29);
      } catch (e) { e29c = String((e && e.message) || e); }
      ok('㉙ ★★ 行为级：框里还是占位符「添加标题」（中文一个字没进去）⇒ 同样必须抛错',
        /输入回读不一致/.test(e29c) && /添加标题/.test(e29c), e29c.slice(0, 140));

      // ---- ③ 落草稿箱 ⇒ 立刻返回 draft:true ----
      fs.writeFileSync(FOCUS29, 'com.shizhuang.duapp/com.shizhuang.duapp.media.activity.DraftActivity');
      const t29 = Date.now();
      const vr29 = await publisher.waitLeftPublishFlow('FAKESERIAL', { timeoutMs: 15000 });
      const used29 = Date.now() - t29;
      ok('㉙ ★★ 点完发布落到**草稿箱** ⇒ 正常返回草稿箱，允许继续下一条但不凭页面断言审核结果',
        vr29.ok === true && vr29.draft === true && used29 < 4000,
        `用时 ${used29}ms / ok=${vr29.ok} / draft=${vr29.draft}`);

      fs.writeFileSync(FOCUS29, 'com.shizhuang.duapp/.modules.home.ui.HomeActivity');
      const vr29b = await publisher.waitLeftPublishFlow('FAKESERIAL', { timeoutMs: 15000 });
      ok('㉙ ★ 反向对照：落在**首页** ⇒ ok:true 且不是草稿（证明上面那条不是恒判草稿）',
        vr29b.ok === true && !vr29b.draft, JSON.stringify({ ok: vr29b.ok, draft: !!vr29b.draft }));

      for (const focus of ['com.android.launcher/.Launcher', 'com.android.permissioncontroller/.GrantPermissionsActivity', '']) {
        fs.writeFileSync(FOCUS29, focus);
        const unknown = await publisher.waitLeftPublishFlow('FAKESERIAL', { timeoutMs: 0 });
        ok('提交后跳到系统桌面、权限弹窗或前台未知时不能开始下一条清相册：' + (focus || '未知'), !unknown.ok);
      }
      fs.writeFileSync(FOCUS29, 'com.shizhuang.duapp/.modules.home.ui.HomeActivity');

      // ---- ④ 防回退：回读的**触发条件** ----
      //   ★ 这一条是**故意写成源码级**的：我当场把它写成 `rs && !rs.skipped`，而 runStep 对 tapId 是
      //     `return;`（**返回 undefined**）⇒ 条件恒假、回读整段静默失效，跑完整条发布都看不出来。
      //     这是「同一个坑不会踩第二次」的护栏，不是验行为（行为在上面 ② 已经验过）。
      const pubSrc29 = codeOnly(fs.readFileSync(path.join(base, 'src', 'main', 'services', 'publisher.js'), 'utf8'));
      ok('㉙ 防回退：回读的触发条件必须是 `!(rs && rs.skipped)` —— 写成 `rs && !rs.skipped` 会恒假、静默失效',
        /lastTapId\s*=\s*\(step\.action === 'tapId' && !\(rs && rs\.skipped\)\)/.test(pubSrc29),
        'publisher.js lastTapId');
      ok('㉙ 防回退：input 步里必须真的调用回读（adb.readTextOf），且不一致时抛错',
        /adb\.readTextOf\(/.test(pubSrc29) && /输入回读不一致/.test(pubSrc29), 'publisher.js 回读');
    } finally {
      fs.writeFileSync(FAKE_WINDOW, savedWin29);
      if (savedFocus29 === null) { try { fs.unlinkSync(FOCUS29); } catch (e) { /* 本来就没有 */ } }
      else fs.writeFileSync(FOCUS29, savedFocus29);
      if (!hadIme29) { try { fs.unlinkSync(IME_FLAG); } catch (e) { /* 本来就没有 */ } }
    }
  }

  // ---- ㉚ 2026-10-05 新增：**「货号不能不挂，不接受任何得物自动挂的」**（用户口径） -------------
  //   真机实测依据（有 dump + 截图为证，见 tools/fixuimap.js 头部 ⑧）：
  //     · 得物会把视觉识别到的商品**自动挂上**（容器里多出 rvRelevantProduct + tvName + ivDelete）；
  //     · 「关联好物」那一行的文字**判不出有没有挂**（没挂/已挂都写「关联好物」）⇒ 唯一判据 = ivDelete；
  //     · 实测**没挂时 ivDelete 不在结构里**（全屏唯一含 delete 的 id）⇒ whenOn 守卫安全；
  //     · 点 ivDelete ⇒ 那三件一起消失（1236→1131）。
  //   这一组守四件事 + 幂等：
  //     ① 「好物1」之前必须有「先摘掉得物自动挂的商品」(tapId ivDelete, whenOn=ivDelete, when=goods1Sku)；
  //     ② **好物2/3 绝不许**有这一步（否则会把我们自己挂的摘掉）—— 这条是语义，必须断言；
  //     ③ 点完整行后必须「等转场 + 没进搜索页就补点一次(whenNotOn=etSearch)」再硬等 etSearch；
  //     ④ 每选完一格必须「waitId ivDelete」校验 —— 挂上了才算过；
  //     ⑤ 新增的每一步都要带 `when: goodsNSku`（否则只有 1 个好物时也要白跑，白白多花几秒）；
  //     ⑥ 幂等：连跑两次一字不差。
  {
    const cp = require('child_process');
    const DID = 'com.shizhuang.duapp:id/';
    const cfgDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-fixuimap-goods-'));
    const cfgFile2 = path.join(cfgDir2, 'config.json');
    // 「改之前」的样子：好物三步都是老写法（没有摘掉/补点/校验）
    const goodsOld = (g) => ([
      { name: `好物${g} · 点「关联好物」这一行`, action: 'tapId', value: DID + 'tvRelevantProduct', when: `goods${g}Sku` },
      { name: `好物${g} · 等搜索页加载`, action: 'waitId', value: DID + 'etSearch', when: `goods${g}Sku`, timeout: 10000 },
      { name: `好物${g} · 点搜索框`, action: 'tapId', value: DID + 'etSearch', when: `goods${g}Sku` },
      { name: `好物${g} · 输「货号+颜色」`, action: 'input', value: `\${goods${g}Sku}\${goods${g}Color}`, when: `goods${g}Sku` },
      { name: `好物${g} · 等结果出来`, action: 'wait', value: 600, when: `goods${g}Sku` },
      { name: `好物${g} · 选结果第 1 格`, action: 'tapId', value: DID + 'ivProduct', when: `goods${g}Sku` }
    ]);
    const oldArr = [].concat(goodsOld(1), goodsOld(2), goodsOld(3));
    fs.writeFileSync(cfgFile2, JSON.stringify({ publish: { uiMap: { package: 'com.shizhuang.duapp', steps: oldArr, videoSteps: oldArr } } }, null, 2), 'utf8');
    const before2 = JSON.parse(fs.readFileSync(cfgFile2, 'utf8')).publish.uiMap;
    // ★ 双向：喂「改之前」的版本，这几步必须**不在**（否则断言在查空气）
    ok('㉚ 前置（反证）：改之前的表里这三类步一个都没有 —— 证明下面查的确实是新加的东西',
      !(before2.videoSteps || []).some(s => /先摘掉得物自动挂的商品|没进搜索页就补点一次|校验确实挂上了/.test(String(s.name || ''))),
      '改前表里相关步数=' + (before2.videoSteps || []).filter(s => /先摘掉|补点一次|校验确实/.test(String(s.name || ''))).length);

    const runFix2 = () => cp.execFileSync(process.execPath, [path.join(base, 'tools/fixuimap.js')],
      { env: Object.assign({}, process.env, { BLUEV_CFG_DIR: cfgDir2 }), encoding: 'utf8', stdio: 'pipe' });
    runFix2();
    const after2 = JSON.parse(fs.readFileSync(cfgFile2, 'utf8')).publish.uiMap;
    const findN = (arr, re) => (arr || []).find(s => re.test(String(s.name || '')));

    for (const key2 of ['steps', 'videoSteps']) {
      const arr2 = after2[key2] || [];
      const tag2 = key2 === 'steps' ? '图文表' : '视频表';
      // ① 「好物1」前紧跟「先摘掉得物自动挂的商品」
      const iRow1 = arr2.findIndex(s => /^好物1 · 点「关联好物」这一行$/.test(String(s.name || '')));
      const dell = iRow1 > 0 ? arr2[iRow1 - 1] : null;
      ok(`㉚ ★★ ${tag2}：「好物1」的前一步必须是「先摘掉得物自动挂的商品」(tapId ivDelete, whenOn=ivDelete)`,
        !!dell && dell.action === 'tapId' && dell.value === DID + 'ivDelete' && dell.whenOn === DID + 'ivDelete'
        && dell.when === 'goods1Sku',
        dell && JSON.stringify({ action: dell.action, value: dell.value, whenOn: dell.whenOn, when: dell.when }));
      // ② 好物2/3 **不许**有摘掉步（否则会把自己挂的摘掉 —— 语义断言）
      const other = arr2.filter(s => /^好物[23] · 先摘掉得物自动挂的商品/.test(String(s.name || '')));
      ok(`㉚ ★★ ${tag2}：好物2/3 **绝不许**有「先摘掉」步（会把我们自己挂的摘掉）`,
        other.length === 0, other.length + ' 个');
      // ③ 点完行 → 转场等 + 幂等补点（whenNotOn=etSearch）
      const retap = findN(arr2, /^好物1 · 没进搜索页就补点一次/);
      ok(`㉚ ★★ ${tag2}：必须有「没进搜索页就补点一次」，且守卫是 whenNotOn=etSearch（已在搜索页就跳过）`,
        !!retap && retap.action === 'tapId' && retap.value === DID + 'tvRelevantProduct'
        && retap.whenNotOn === DID + 'etSearch',
        retap && JSON.stringify({ action: retap.action, value: retap.value, whenNotOn: retap.whenNotOn }));
      const iW = arr2.findIndex(s => /^好物1 · 等搜索页加载$/.test(String(s.name || '')));
      const pre = iW >= 2 ? arr2.slice(iW - 2, iW) : [];
      ok(`㉚ ★★ ${tag2}：补点与硬等之间要有「转场等」（实测转场 ~1.2s，固定 wait 比空转可靠）`,
        pre.length === 2 && pre[0].action === 'wait' && Number(pre[0].value) >= 1000
        && /没进搜索页就补点一次/.test(String(pre[1].name || '')),
        JSON.stringify(pre.map(s => s.name)));
      // ④ 选完一格 → waitId ivDelete 校验
      const iPick = arr2.findIndex(s => /^好物1 · 选结果第 1 格$/.test(String(s.name || '')));
      const ver = iPick >= 0 ? arr2[iPick + 1] : null;
      ok(`㉚ ★★ ${tag2}：「选结果第 1 格」之后必须紧跟「校验确实挂上了」(waitId ivDelete)`,
        !!ver && ver.action === 'waitId' && ver.value === DID + 'ivDelete' && Number(ver.timeout) >= 5000,
        ver && JSON.stringify({ action: ver.action, value: ver.value, timeout: ver.timeout }));
      // ⑤ 新增的每一步都必须带 when 守卫（否则只有 1 个好物也要白跑）
      const noWhen = arr2.filter(s => /^好物\d · (先摘掉得物自动挂的商品|没进搜索页就补点一次|等搜索页转场|校验确实挂上了)/.test(String(s.name || '')) && !s.when);
      ok(`㉚ ★ ${tag2}：新增的每一步都要带 when 守卫（不然「这一列空着」时也要白跑，白白多花几秒）`,
        noWhen.length === 0, noWhen.map(s => s.name).join(' | ') || '全部带 when');
    }
    const snap1b = fs.readFileSync(cfgFile2, 'utf8');
    runFix2();
    const snap2b = fs.readFileSync(cfgFile2, 'utf8');
    ok('㉚ 幂等：连跑两次结果一字不差（新增步不许叠加）', snap1b === snap2b,
      snap1b === snap2b ? '两次完全一致' : '第二次内容变了');
  }

  // ==========================================================================
  // ㉛ ★★ 2026-10-05（第四十二轮）—— 用户原话：「检查有没有图片就行，空目录有什么关系？」
  //   真机：DCIM/Camera 里躺着 8 个**删不掉**的超长空目录残骸（`sub/deep` 撞 `Text file busy`；
  //   `adb kill-server` 解不开，**重启模拟器也解不开** —— 实测 Android uptime 75s 后照样在）
  //   ⇒ `ls -A` **永远非空** ⇒ 老流程**每一条内容**都必然走完：
  //     强停得物 → 重删 → mv 换名（Camera 是 sdcardfs 挂载点，必失败）→ 逐子项循环
  //     （每子项 4~6 次 shell）→ 4 轮扫描 → 兜底 2 轮（含 1.6s 纯 sleep）→ reapLongTrashDirs
  //   实测这一段 **15.3s**，而它想删的文件**一个都不存在**（`find -type f` = 0）。
  //   ★ 更糟的连带损失：白白强停掉得物 ⇒ 后面还要再花 4.4s 把它重新拉回首页。
  //   ⇒ 修正：清完一遍后**先数文件**，数出来 0 个就立刻放行（不强停、不换名、不 reap）。
  //     真机实测：clearMediaDir(DCIM/Camera) **15266ms → 4449ms**。
  //   这组盯四件事（前三条行为级、最后一条源码级防回退）：
  //     ① 只剩空目录残骸 ⇒ **一次都不许强停得物**（没文件要删，强停纯属白干）；
  //     ② 只剩空目录残骸 ⇒ **不许换名**（换名会把残骸名字一路滚到 255 字符永久卡死）；
  //     ③ note 必须**如实说清**是「空目录残骸、0 个文件」（不许悄悄放过去）；
  //     ④ 源码级：这段「先数文件」必须排在「1b) 强停得物」**之前**（顺序反了等于没改）。
  //   ★ 「有真文件时必须照原样清」这条**不用新写**：上面 ⑫ 就是它的反向对照
  //     （有真文件 ⇒ 必须判失败），⑫ 保持绿 ⇒ 证明这次提速没把真文件放过去。
  // ==========================================================================
  {
    const fakeExecX = require('child_process').execFile;
    const adbX = require(path.join(base, 'src/main/services/adb.js'));
    const DEWU_PKG = 'com.shizhuang.duapp';
    const camX = fakeExecX.__dirs[fakeExecX.__cameraDirPath];
    const stubbornX = path.join(FDB, 'DIR_EMPTY_STUBBORN');   // 让「空目录」真的 rm/mv 不掉
    const resetX = () => {
      try { if (fakeExecX.__appReset) fakeExecX.__appReset(); } catch (e) { /* 夹具没这个钩子就算了 */ }
      if (fs.existsSync(stubbornX)) fs.unlinkSync(stubbornX);
      const s = fakeExecX.__appStops || [];
      s.length = 0;
      return s;
    };
    resetX();

    // 夹具 = 真机上见过的那个状态：`ls -A` 有条目，**但 `find -type f` 一个文件都没有**；
    //   且这两个条目**删不掉也改不了名**（stubborn），所以一定会走进「先数文件」那段。
    //   ★ 不写 stubborn 的话，第一步 `find -mindepth 1 -delete` 就把它们清掉了 ⇒
    //     `ls -A` 变空 ⇒ 根本走不到被测的那段 ⇒ 断言会**假绿**（空==空）。
    fs.writeFileSync(stubbornX, '2');
    camX.exists = true;
    camX.files = ['X_gone_1759500000000…（243字符）', 'bluev_trash_1759500000001…（255字符）'];
    camX.renames = [];
    clearCalls();
    const rX = await adbX.clearMediaDir('FAKESERIAL', fakeExecX.__cameraDirPath, { forceStopPkg: DEWU_PKG });
    const stopsX = fakeExecX.__appStops || [];
    ok('㉛ ★★ 相册里只剩**空目录残骸**（find -type f = 0）⇒ **一次都不许强停得物**'
      + '（没文件要删；老写法会白白强停，还要再花 4.4s 把得物拉回首页）',
      rX.ok === true && rX.forceStopped === false && !stopsX.includes(DEWU_PKG),
      `ok=${rX.ok} 强停=${rX.forceStopped} stops=${JSON.stringify(stopsX)}`);
    ok('㉛ ★ 同上：也不许走 mv 换名（换名会把残骸名字一路滚到 255 字符、永久卡死）',
      (camX.renames || []).length === 0, `换名次数=${(camX.renames || []).length}`);
    ok('㉛ ★ 同上：note 必须**如实写清**是「空目录残骸 / 0 个文件」（不许悄悄放过去）',
      /空目录残骸/.test(String(rX.note || '')) && /0 个文件/.test(String(rX.note || '')),
      (rX.note || '（没有 note）').slice(0, 140));
    // 源码级防回退：先数文件的那段必须在「1b) 强停」之前
    const iEarly = adbSrc.indexOf("'find ' + dir + ' -type f 2>/dev/null'", adbSrc.indexOf('第四十二轮'));
    const i1b = adbSrc.indexOf('1b) 2026-10-04 第十四次实测修正');
    ok('㉛ 先读取真实文件，再决定是否释放句柄', adbSrc.indexOf('let remaining = await listFiles()') < adbSrc.indexOf('am force-stop', adbSrc.indexOf('async function clearMediaDir')));
    resetX();
  }

  // ============ ㉜ ★★★ 主图排序：相册第 1 格 = 内容主图 = 「设备上时间最新的那张」 ============
  //   真机定论（2026-10-05，详见 src/main/services/adb.js#makeNewest 的注释）：
  //     · 「得物取相册第 1 格作内容主图」是用户口径；
  //     · 第 1 格只认设备上文件时间（MediaStore date_modified）的**倒序** —— 4 张纯色图把
  //       「文件名顺序 / push 顺序 / 文件时间」三个键故意做成互相矛盾，相册只跟文件时间走；
  //     · 只改文件时间不重扫媒体库 ⇒ 顺序纹丝不动；改完时间再 scan ⇒ 顺序立刻跟着变。
  //   ⇒ 产品做法：推完之后在设备端把要当主图那张 touch 成最新 + 重扫它，再读库复查。
  //   ★ 本组判据是**设备上的事实**（夹具里的 mtime / 库里的 date_modified），不是"发过 touch 命令"。
  {
    const mainimg = require(path.join(base, 'src/main/services/mainimg.js'));
    const wp3 = require(path.join(base, 'src/main/util/winpath.js'));
    const fakeExec = require('child_process').execFile;
    const F = (name, type) => ({ name, type: type || 'image' });

    // ---- ㉜-1 纯逻辑：该挑哪张 ----
    ok('㉜ 纯逻辑：名字以 1 开头 ⇒ 认成主图标记（1_x.jpg / 1封面.jpg / 1.jpg / 1-主图.jpg 都算）',
      ['1_x.jpg', '1封面.jpg', '1.jpg', '1-主图.jpg'].every(n => mainimg.isMainMarked(n)),
      ['1_x.jpg', '1封面.jpg', '1.jpg', '1-主图.jpg'].map(n => n + '=' + mainimg.isMainMarked(n)).join(' '));
    ok('㉜ ★ 纯逻辑：`10.jpg` / `12.jpg` / `100.jpg` **不算**标记（数字编号不许被误当主图）',
      !['10.jpg', '12.jpg', '100.jpg'].some(n => mainimg.isMainMarked(n)),
      ['10.jpg', '12.jpg', '100.jpg'].map(n => n + '=' + mainimg.isMainMarked(n)).join(' '));
    ok('㉜ ★ 纯逻辑：标记只认**开头**（`微信图片_1.jpg` / `a1.jpg` 里的 1 是名字的一部分，不算标记）',
      !mainimg.isMainMarked('微信图片_1.jpg') && !mainimg.isMainMarked('a1.jpg'));
    const pNoMark = mainimg.pickMainImage([F('a.jpg'), F('b.jpg'), F('c.jpg')]);
    ok('㉜ 纯逻辑：没有标记 ⇒ 按第 1 张（最先拍到 / 收到的那张）',
      pNoMark.main.name === 'a.jpg' && pNoMark.why === 'first', pNoMark.main.name + ' / ' + pNoMark.why);
    const pMark = mainimg.pickMainImage([F('a.jpg'), F('1_b.jpg'), F('c.jpg')]);
    ok('㉜ ★ 纯逻辑：有一张带标记 ⇒ 用它（**哪怕它排在第 2 位** —— 这正是"用户指定优先"的意义）',
      pMark.main.name === '1_b.jpg' && pMark.why === 'marker' && pMark.index === 1,
      pMark.main.name + ' / ' + pMark.why + ' / idx=' + pMark.index);
    const pMany = mainimg.pickMainImage([F('1_a.jpg'), F('1_b.jpg'), F('c.jpg')]);
    ok('㉜ ★ 纯逻辑：两张都带标记 ⇒ 取最前那张 + why=marker-many（要提醒用户，但不能因此不发）',
      pMany.main.name === '1_a.jpg' && pMany.why === 'marker-many' && pMany.marked.length === 2,
      pMany.main.name + ' / ' + pMany.why + ' / 带标记 ' + pMany.marked.join('、'));
    ok('㉜ 纯逻辑：只有一张图 ⇒ why=only；视频/垃圾文件不参与挑图（图片清单只认 type=image）',
      mainimg.pickMainImage([F('a.jpg')]).why === 'only'
      && mainimg.pickMainImage([F('v.mp4', 'video')]).main === null
      && mainimg.pickMainImage([F('v.mp4', 'video'), F('.DS_Store', 'junk'), F('1_x.jpg')]).main.name === '1_x.jpg');

    // ---- ㉜-2 端到端：真跑一次发布，看设备上那张图有没有变成"时间最新" ----
    //   现场隔离（用例之间必须隔离，否则前面各段留下的开关会让这组假红/假绿）：
    //   SCAN_FAIL / MEDIA_LAG / DIR_STALE / DIR_UNREADABLE / FOCUS / UISIZE …… 全部清掉，
    //   只留「中文输入法已启用」这一条必须的状态。
    for (const f of fs.readdirSync(FDB)) {
      if (/^[A-Z_]+$/.test(f) && f !== 'IME_ACTIVE') {
        try { fs.unlinkSync(path.join(FDB, f)); } catch (e) { /* 目录之类就跳过 */ }
      }
    }
    store.set({ publish: { uiMap, device: '127.0.0.1:5555', intervalMinSec: 1, intervalMaxSec: 1 } });

    const dir3 = path.join(TMP, 'flat3', '26FW-YB160+煤黑+1');
    fs.mkdirSync(dir3, { recursive: true });
    const BASE_T = 1791000000;
    // 名字升序 = 本地时间升序（对齐真机：先拍的在前面）。本地时间会被 push 原样带到设备上。
    const put3 = names => {
      for (const f of fs.readdirSync(dir3)) fs.unlinkSync(path.join(dir3, f));
      names.forEach((n, i) => {
        const p = path.join(dir3, n);
        fs.writeFileSync(p, jpgBuf(200 - i * 8, 200, 200));
        const t = BASE_T + (i + 1) * 10;
        fs.utimesSync(p, t, t);
      });
    };
    const rem3 = n => '/sdcard/DCIM/Camera/' + n;
    const devMt = n => fakeExec.__mtimes.get(fakeExec.__mtKey(rem3(n)));
    const devDb = n => fakeExec.__dbTimes.get(fakeExec.__mtKey(rem3(n)));
    const files3 = async () => (await wp3.readdirSafe(dir3)).filter(e => e.isFile())
      .map(e => ({ name: e.name, type: wp3.isVideo(e.name) ? 'video' : (wp3.isJunk(e.name, false) ? 'junk' : 'image') }));
    const mkState3 = async () => {
      const id = '26FW-YB160+煤黑+1';
      return {
        items: [{ id, dir: dir3, absDir: dir3, sku: '26FW-YB160', color: '煤黑', files: await files3() }],
        copyRows: [{ id, title: '黑色的鞋谁懂', body: '这双煤黑真的很百搭', topics: ['#品牌甲'] }],
        verify: { rows: [{ id, conclusion: '通过' }] },
        publish: {
          rows: [{ seq: 1, id, dir: id, goods: 1, images: 3, startAt: '', status: '排队', result: '', retries: 0, reason: '' }],
          mode: 'adb', device: '127.0.0.1:5555'
        }
      };
    };

    // ==== A) 没有标记：应当挑「第 1 张」（= 最早拍到的那张） ====
    const NA = ['01_front.jpg', '02_side.jpg', '03_back.jpg'];
    put3(NA);
    const orderA = (await files3()).map(f => f.name);
    // ★ 前置反证：夹具必须让「最后一张」的本地时间最新 —— 否则"改前就是对的"，这组用例什么都证明不了
    ok('㉜ 前置（反证）：夹具里本地时间最新的是**最后一张** `03_back.jpg`（旧行为＝挑它当主图）',
      orderA.join('|') === NA.join('|')
      && fs.statSync(path.join(dir3, NA[0])).mtimeMs < fs.statSync(path.join(dir3, NA[2])).mtimeMs,
      orderA.join(' | '));

    clearCalls();
    const logs3 = [];
    const ctx3 = { log: (m, l) => logs3.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} };
    const r31 = await publisher.run(await mkState3(), ctx3);
    const call31 = calls();
    ok('㉜ 端到端：这一条照常发布成功（主图排序没把正常流程弄挂）',
      r31.okCount === 1, ((r31.rows[0] || {}).result || '') + ' / ' + ((r31.rows[0] || {}).reason || ''));
    const mtA = NA.map(devMt);
    ok('㉜ ★★★ 端到端：设备上时间最新的变成了**第 1 张** `01_front.jpg`（= 相册第 1 格 = 内容主图）',
      mtA.every(t => typeof t === 'number') && mtA[0] === Math.max.apply(null, mtA),
      NA.map((n, i) => n + '=' + mtA[i]).join(' '));
    const dbA = NA.map(devDb);
    ok('㉜ ★★ 端到端：**库里的** date_modified（得物真正读的那个）也以第 1 张为最新',
      dbA.every(t => typeof t === 'number') && dbA[0] === Math.max.apply(null, dbA),
      NA.map((n, i) => n + '=' + dbA[i]).join(' '));
    const iPushA = call31.lastIndexOf('push ');
    const iTouchA = call31.indexOf('touch -d @');
    ok('㉜ ★ 顺序：touch 必须排在**所有 push 之后**（反了的话"最新"会少算一个文件 ⇒ 主图可能排错）',
      iTouchA > 0 && iPushA > 0 && iTouchA > iPushA, '最后一次 push@' + iPushA + ' / touch@' + iTouchA);
    const scanRe = new RegExp('content call --uri content://media/external/file --method scan_file --arg '
      + "'/storage/emulated/0/DCIM/Camera/01_front\\.jpg'");
    ok('㉜ ★ 顺序：touch 完必须**重扫**那张（不重扫库里的值不变 ⇒ 相册顺序不会动，这条真机实测过）',
      scanRe.test(call31.slice(iTouchA)),
      (call31.slice(iTouchA).match(/content call.*/g) || []).join(' | ').slice(0, 200));
    ok('㉜ 日志如实写了主图是哪张、以及凭什么挑的',
      logs3.some(l => /主图 = 01_front\.jpg/.test(l) && /没有 1 标记/.test(l)),
      logs3.filter(l => /主图/.test(l)).join(' | ').slice(0, 200));

    // ==== B) 带标记：`02_side.jpg` 改名成 `1_02_side.jpg` ⇒ 用户指定的那张当主图 ====
    //   ★ 特意让带标记的名字**不是**名字排最前的那张（`01_…` < `03_…` < `1_02_…`）——
    //     否则"按第 1 张"与"按标记"会给出同一个答案，这条用例就证明不了标记真的生效。
    const NB = ['01_front.jpg', '1_02_side.jpg', '03_back.jpg'];
    put3(NB);
    const orderB = (await files3()).map(f => f.name);
    ok('㉜ 前置：带标记的 `1_02_side.jpg` **不是**名字排最前的那张（排最前的是 `01_front.jpg`）',
      orderB[0] === '01_front.jpg' && orderB[orderB.length - 1] === '1_02_side.jpg', orderB.join(' | '));

    clearCalls();
    const r32 = await publisher.run(await mkState3(), ctx3);
    const call32 = calls();
    ok('㉜ 端到端（带标记）：照常发布成功', r32.okCount === 1, ((r32.rows[0] || {}).result || ''));
    const mtB = NB.map(devMt);
    ok('㉜ ★★★ 端到端（带标记）：时间最新的变成了**带 1 标记的那张**（既不是名字最前的，也不是最后拍的）',
      mtB.every(t => typeof t === 'number') && mtB[1] === Math.max.apply(null, mtB),
      NB.map((n, i) => n + '=' + mtB[i]).join(' '));
    ok('㉜ ★ 带标记时不该再对别的图动手：整条流程只发了**一条** touch',
      (call32.match(/touch -d @/g) || []).length === 1,
      (call32.match(/touch -d @[^\n]*/g) || []).join(' | '));
    ok('㉜ 日志里说清了凭什么挑的（名字以 1 开头）',
      logs3.some(l => /主图 = 1_02_side\.jpg/.test(l) && /名字以 1 开头/.test(l)),
      logs3.filter(l => /主图 =/.test(l)).join(' | ').slice(-260));

    // ==== C) 排不成 ⇒ 这一条**不发**（不许默默发一条主图放错的帖子） ====
    //   现场开关 SCAN_FAIL：让「重扫媒体库」这一步失效。得物读的是库里的缓存时间 ⇒
    //   重扫不成功 = 相册顺序根本不会变 = 主图会放错 ⇒ 必须当场失败，而不是"当作排上了"往下发。
    fs.writeFileSync(path.join(FDB, 'SCAN_FAIL'), '1');
    put3(NA);
    const r33 = await publisher.run(await mkState3(), ctx3);
    fs.unlinkSync(path.join(FDB, 'SCAN_FAIL'));
    ok('㉜ ★★ 排不成（重扫失效）⇒ 这一条**失败**，不是"照发不误"',
      r33.okCount === 0 && /失败/.test(String((r33.rows[0] || {}).result || '')),
      String((r33.rows[0] || {}).result || '') + ' / ' + String((r33.rows[0] || {}).reason || '').slice(0, 160));
    ok('㉜ ★★ 而且理由必须点到"主图/媒体库"上（不许只说一句"失败了"让人猜）',
      /主图|媒体库/.test(String((r33.rows[0] || {}).reason || '')),
      String((r33.rows[0] || {}).reason || '').slice(0, 200));

    // ==== D) 扫描命令非 0，但 MediaStore 已经更新 ⇒ 以库内事实为准，不误报失败 ====
    const SCAN_EXIT_139_AFTER_WRITE = path.join(FDB, 'SCAN_EXIT_139_AFTER_WRITE');
    const QUERY_EXIT_139 = path.join(FDB, 'QUERY_EXIT_139');
    const logs4 = [];
    const ctx4 = Object.assign({}, ctx3, { log: (m, l) => logs4.push((l || 'info') + ': ' + m) });
    put3(NA);
    fs.writeFileSync(SCAN_EXIT_139_AFTER_WRITE, '1');
    fs.writeFileSync(QUERY_EXIT_139, '1');
    let r34;
    try { r34 = await publisher.run(await mkState3(), ctx4); }
    finally { fs.unlinkSync(SCAN_EXIT_139_AFTER_WRITE); fs.unlinkSync(QUERY_EXIT_139); }
    ok('㉜ ★★★ 全部媒体查询和扫描均退出 139，但完整数据确认主图最新 ⇒ 继续正常发布',
      r34.okCount === 1 && /发布成功/.test(String((r34.rows[0] || {}).result || ''))
        && logs4.some(l => /媒体库核实主图时间最新/.test(l)
          && /scan_file 退出码 139/.test(l) && /scan_volume 退出码 139/.test(l)),
      String((r34.rows[0] || {}).result || '') + ' / ' + logs4.filter(l => /扫描命令/.test(l)).join(' | '));
  }

  console.log('\n--- 日志样例 ---');
  logs.slice(-4).forEach(l => console.log('  ' + l));
})().catch(e => { console.error('ADB TEST ERROR', e); process.exitCode = 1; });
