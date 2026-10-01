/* 真实（adb）发布通道的可执行验证：用假 adb 模拟一台在线设备
   覆盖：设备检查 / dump 解析与定位表 / 未配定位表必失败 / 图文条全流程 / 页面结构变了必失败 /
        **视频条**（推视频 → 等媒体库索引 → 走 videoSteps；没配 videoSteps 必失败；媒体库一直看不到也必失败）/
        **页面不 idle**（自动关动画兜底并还原；兜不住就明确失败；★ 抓不到时绝不返回上一页的残留结构）
   假 adb 在 child_process.execFile 这一层做替身（见 tools/fakeadb/adb.js 顶部的说明：
   Windows 的 execFile('adb') 只认 adb.exe，无扩展名的 bash 脚本跑不起来，故改为函数级替身）。 */
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
fs.cpSync(path.join(__dirname, 'fakeadb'), FDB, { recursive: true });
const FAKE_WINDOW = path.join(FDB, 'window.xml');
const CALLS = path.join(FDB, 'calls.log');
const calls = () => { try { return fs.readFileSync(CALLS, 'utf8'); } catch (e) { return ''; } };
const clearCalls = () => fs.writeFileSync(CALLS, '');

// ★ 必须在 require 被测模块之前替换：src/main/services/adb.js 在加载时就解构了 execFile
require('child_process').execFile = require(path.join(__dirname, 'fakeadb', 'adb.js')).makeFakeAdb(FDB);

const store = require(path.join(base, 'src/main/store.js'));
const publisher = require(path.join(base, 'src/main/services/pubublisher.js'.replace('pubublisher', 'publisher')));
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
  copyRows: [{ id: '26FW-YB160+冠军白+1', title: '白色的鞋谁懂', body: '这双冠军白真的很百搭', topics: ['#TW男装', '#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活'] }],
  verify: { rows: [{ id: '26FW-YB160+冠军白+1', conclusion: '通过' }] },
  publish: { rows: [{ seq: 1, id: '26FW-YB160+冠军白+1', dir: '26FW-YB160+冠军白+1', goods: 1, images: 2, startAt: '', status: '排队', result: '', retries: 0, reason: '' }], mode: 'adb', device: '127.0.0.1:5555' }
};

(async () => {
  store.set({
    paths: { source: TMP, output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    publish: { device: '127.0.0.1:5555', mock: false, intervalMinSec: 1, intervalMaxSec: 1, retry: 1, adbKeyboard: true }
  });

  // 1) 设备检查（界面上叫「检查能不能发布」；probe() 的返回体同时带 notes 与 fix 两套说法）
  clearCalls();
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
  ok('dump 解析出节点', nodes.length === 8, nodes.length + ' 个');
  const pub = uimap.findNode(nodes, { text: '发布' });
  ok('按文本定位到节点', !!pub && pub.center.x === 162 && pub.center.y === 160, pub && JSON.stringify(pub.center));
  const sug = uimap.suggest(nodes);
  ok('生成候选定位表', sug.steps.length > 5 && sug.package === 'com.shizhuang.duapp', sug.steps.length + ' 步');
  const filled = uimap.fill({ value: '${title}｜${topic1}' }, { title: '白色的鞋谁懂', topic1: '#TW男装' });
  ok('占位符替换', filled.value === '白色的鞋谁懂｜#TW男装', filled.value);

  // 失败恢复动作：只认真正会被执行的 action，不认识要说清可用值（不静默跳过）
  const rec = uimap.normalizeRecover([
    { name: '删除卡片', action: 'tapText', value: '删除' },
    { action: 'wait', value: 800 }
  ]);
  ok('恢复动作：合法步骤被规范化', rec.length === 2 && rec[0].value === '删除' && rec[1].value === 800, JSON.stringify(rec));
  let badAct = '';
  try { uimap.normalizeRecover([{ action: 'back' }]); } catch (e) { badAct = e.message; }
  ok('恢复动作：不认识的 action 报错并列出可用值', /不认识/.test(badAct) && /tapText/.test(badAct), badAct);
  let badVal = '';
  try { uimap.normalizeRecover([{ action: 'tapText', value: '   ' }]); } catch (e) { badVal = e.message; }
  ok('恢复动作：空 value 被拦住', /不能为空/.test(badVal), badVal);
  ok('恢复动作：空配置等价于「不配」', uimap.normalizeRecover(null).length === 0 && uimap.normalizeRecover(undefined).length === 0);

  // 3) 未配定位表 → 必须报错，不许假装成功
  store.set({ publish: { uiMap: null } });
  let threw = '';
  try { await publisher.run(state, {}); } catch (e) { threw = e.message; }
  ok('未配定位表直接失败', /UI 定位表/.test(threw), threw);

  // 4) 真实通道发布
  store.set({ publish: { uiMap } });
  clearCalls();
  const logs = [];
  const ctx = { log: (m, l) => logs.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false, onRow: () => {} };
  const r = await publisher.run(state, ctx);
  const log = calls();
  ok('真实通道跑完 1 条', r.mode === 'adb' && r.total === 1, `成功 ${r.okCount}/${r.total}`);
  ok('推图 2 张', (log.match(/push /g) || []).length === 2, (log.match(/push .*/g) || []).join(' | '));
  ok('触发媒体扫描', /MEDIA_SCANNER_SCAN_FILE/.test(log));
  ok('点击了「发布」按钮', (log.match(/input tap 162 160/g) || []).length >= 1);
  ok('点击了相册/下一步/关联好物', /input tap 162 280/.test(log) && /input tap 920 2250/.test(log) && /input tap 220 1540/.test(log));
  ok('中文标题走 ADBKeyboard 广播', /ADB_INPUT_TEXT --es msg "白色的鞋谁懂"/.test(log));
  ok('话题也真实输入', /ADB_INPUT_TEXT --es msg "#TW男装"/.test(log));
  ok('结果标为发布成功', r.rows[0].result === '发布成功', r.rows[0].result);

  // 5) 页面结构变了 → 必须失败 + 存截图，绝不能成功
  const backup = fs.readFileSync(FAKE_WINDOW, 'utf8');
  fs.writeFileSync(FAKE_WINDOW, backup.replace(/text="发布"/g, 'text="首页"'));
  state.publish.rows[0].result = '';
  const r2 = await publisher.run(state, ctx);
  fs.writeFileSync(FAKE_WINDOW, backup);
  ok('找不到节点时报失败', r2.rows[0].result === '失败', r2.rows[0].result + ' / ' + r2.rows[0].reason);
  ok('失败原因说明缺什么', /找不到/.test(r2.rows[0].reason), r2.rows[0].reason);
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
      { name: '关联好物', action: 'tapText', value: '关联好物' }
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
  ok('⑥ 推完真的去查了媒体库（content query）',
    /content query --uri content:\/\/media\/external\/video\/media/.test(vlog));
  ok('⑥ 媒体库等待被记进日志', vlogs.some(l => /已索引到视频/.test(l)), vlogs.filter(l => /索引/.test(l)).join(' | '));
  ok('⑥ videoSteps 的点击真的执行了（不是图文那 4 步）',
    /input tap 162 160/.test(vlog) && /input tap 162 280/.test(vlog) && /input tap 920 2250/.test(vlog) && /input tap 220 1540/.test(vlog));
  ok('⑥ 日志标的是 [视频]', vlogs.some(l => /\[视频\] 发布完成/.test(l)), vlogs.filter(l => /发布完成/.test(l)).join(' | '));

  // 7) 视频条但没配 videoSteps → 直接失败，绝不拿图文那套硬套
  //    注意：store.set 是**深合并**，只写 steps 的话上一份表的 videoSteps 会被留下来，
  //    所以这里显式给 videoSteps: []（真实导入路径里 publish.importMap 也会显式置空）
  store.set({ publish: { uiMap: { package: 'com.shizhuang.duapp', steps: uiMap.steps, videoSteps: [] } } });
  videoState.publish.rows[0].result = '';
  clearCalls();
  const rv2 = await publisher.run(videoState, vctx);
  const vlog2 = calls();
  ok('⑦ 没配 videoSteps 的视频条直接失败', rv2.rows[0].result === '失败', rv2.rows[0].result + ' / ' + rv2.rows[0].reason);
  ok('⑦ 失败原因说清缺的是 videoSteps', /videoSteps/.test(rv2.rows[0].reason), rv2.rows[0].reason);
  ok('⑦ 没有拿图文步骤硬点（推完素材就停住）', !/input tap/.test(vlog2), (vlog2.match(/input tap .*/g) || []).join(' | ') || '（一次都没点）');

  // 8) 视频推上去了但媒体库一直没索引到 → 明确失败，不许硬点（硬点只会点空）
  fs.writeFileSync(path.join(FDB, 'MEDIA_LAG'), '1');
  store.set({ publish: { uiMap: videoMap, videoIndexTimeoutSec: 1 } });
  videoState.publish.rows[0].result = '';
  clearCalls();
  const rv3 = await publisher.run(videoState, vctx);
  const vlog3 = calls();
  fs.unlinkSync(path.join(FDB, 'MEDIA_LAG'));
  ok('⑧ 媒体库一直看不到 → 失败，不硬点',
    rv3.rows[0].result === '失败' && /媒体库还没索引到/.test(rv3.rows[0].reason), rv3.rows[0].reason);
  ok('⑧ 等不到就一步界面都没点', !/input tap/.test(vlog3), (vlog3.match(/input tap .*/g) || []).join(' | ') || '（一次都没点）');

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
  ok('⑩ 关动画也抓不到时，发布明确失败并说明原因',
    r10.rows[0].result === '失败' && /idle/.test(r10.rows[0].reason),
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
  const seq = calls().split(/\r?\n/);
  const iRm = seq.findIndex(l => /shell rm -f \/sdcard\/bluev_window\.xml/.test(l));
  const iDump = seq.findIndex(l => /uiautomator dump/.test(l));
  ok('⑫ 抓取前先删远端文件（顺序：rm → dump）',
    iRm >= 0 && iDump >= 0 && iRm < iDump, `rm@${iRm} dump@${iDump}`);

  console.log('\n--- 日志样例 ---');
  logs.slice(-4).forEach(l => console.log('  ' + l));
})().catch(e => { console.error('ADB TEST ERROR', e); process.exitCode = 1; });
