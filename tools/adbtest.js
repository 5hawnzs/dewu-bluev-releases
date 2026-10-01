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
// 假 adb 还会单独记「实际被执行的可执行文件」——用来证明内置 adb 真的被拿去执行了
const FILES = path.join(FDB, 'files.log');
const filesLog = () => { try { return fs.readFileSync(FILES, 'utf8'); } catch (e) { return ''; } };
const clearFiles = () => fs.writeFileSync(FILES, '');

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
    // ★ 刻意**不写** `adbKeyboard` —— 这就是产线真实配置的样子：默认配置里没有这个键、
    //   界面上也没有开关。以前产线代码用 `!!c.adbKeyboard` 决定中文走不走广播 ⇒ 恒为假
    //   ⇒ 中文永远走 `input text`（实测打不进中文却返回 0）⇒ 会发出一条没标题没正文的帖子。
    //   现在这条判断改由「设备当前输入法」决定，配置里有没有这个键都不影响。
    publish: { device: '127.0.0.1:5555', mock: false, intervalMinSec: 1, intervalMaxSec: 1, retry: 1 }
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
  //    先让假设备进入「ADBKeyboard 已装进模拟器且是当前输入法」的状态 —— 中文要用它。
  const IME_ACTIVE = path.join(FDB, 'IME_ACTIVE');
  fs.writeFileSync(IME_ACTIVE, '1');
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

  // ============ 12b) ★ 中文输入：必须按「设备真实输入法状态」决定走哪条通道 ============
  const adbMod = require(path.join(base, 'src/main/services/adb.js'));
  // 这一组是本轮报障的直接回归：「设备检查说中文打不进去」背后其实还有一条更严重的
  // —— 产线代码把「走不走 ADBKeyboard 广播」交给配置项 publish.adbKeyboard，而那个键
  // **全仓没有任何地方会写它** ⇒ 恒为假 ⇒ 中文永远走 `input text`。
  // 实测（2026-10-02，MuMu 12 / Chrome 地址栏截图取证）：`input text "中文标题"` 一个字都进不去，
  // 但退出码 0、无任何输出；而 `am broadcast -a ADB_INPUT_TEXT --es msg "中文标题"` 能进去。
  // ⇒ 所以这里的断言是：**没启用输入法时中文必须明确失败，绝不许静默退化**。
  fs.unlinkSync(IME_ACTIVE);                       // 设备回到「装了 apk 但没启用」的状态
  const it1 = await adbMod.inputText('127.0.0.1:5555', '中文标题');
  ok('⑯ 设备没启用 ADBKeyboard ⇒ 中文输入明确失败（不假装成功）',
    it1.ok === false && it1.code === 'ime-not-active',
    JSON.stringify({ ok: it1.ok, code: it1.code, err: String(it1.stderr || '').slice(0, 60) }));
  ok('⑯ 失败原因说清「下一步点哪里」，不是一句「输入失败」',
    /一键装上中文输入法/.test(it1.stderr) && /ADBKeyboard/.test(it1.stderr),
    String(it1.stderr || '').slice(0, 90));

  clearCalls();
  const it2 = await adbMod.inputText('127.0.0.1:5555', 'abc123');
  ok('⑯ 纯 ASCII 不受影响 ⇒ 走 input text（不依赖设备输入法状态）',
    it2.ok === true && /input text "abc123"/.test(calls()) && !/ADB_INPUT_TEXT/.test(calls()),
    calls().trim().split(/\r?\n/).join(' | '));

  // 真跑一遍发布：设备没启用输入法时，整条必须**失败**（而不是发一条空帖子还报成功）
  clearCalls();
  Object.assign(state.publish.rows[0], { status: '排队', result: '', reason: '', retries: 0 });
  const rNoIme = await publisher.run(state, ctx);
  const logNoIme = calls();
  ok('⑯ 中文打不进去时，这一条如实标「失败」',
    rNoIme.rows[0].result === '失败', rNoIme.rows[0].result + ' / ' + rNoIme.rows[0].reason);
  ok('⑯ 失败原因点明是中文输入的问题（不是含糊的「未知」）',
    /中文|输入失败/.test(rNoIme.rows[0].reason), rNoIme.rows[0].reason);
  ok('⑯ ★ 绝不把中文塞给 `input text`（实测无效却返回成功，会发出没标题的帖子）',
    !/input text "白色的鞋谁懂"/.test(logNoIme) && !/input text "这双冠军白/.test(logNoIme),
    (logNoIme.match(/input text "[^"]*"/g) || []).join(' | ') || '（没有 input text 调用）');

  // 反向自证：把设备切成「已启用」，同一条发布必须走广播、并且真的成功
  fs.writeFileSync(IME_ACTIVE, '1');
  clearCalls();
  Object.assign(state.publish.rows[0], { status: '排队', result: '', reason: '', retries: 0 });
  const rIme = await publisher.run(state, ctx);
  ok('⑯ 设备启用了 ADBKeyboard ⇒ 中文走 ADB_INPUT_TEXT 广播，这一条发布成功',
    rIme.rows[0].result === '发布成功' && /ADB_INPUT_TEXT --es msg "白色的鞋谁懂"/.test(calls()),
    rIme.rows[0].result + ' / ' + (calls().match(/ADB_INPUT_TEXT --es msg "[^"]*"/g) || []).join(' | '));

  // 源码级反向断言：那条「配置说了算」的老写法不许回来
  const adbSrc = fs.readFileSync(path.join(base, 'src/main/services/adb.js'), 'utf8');
  const pubSrc = fs.readFileSync(path.join(base, 'src/main/services/publisher.js'), 'utf8');
  ok('⑯ 源码：inputText 不再从配置推导开关（老写法 `inputText(serial, text, { adbKeyboard = false })` 已消失）',
    !/inputText\(serial,\s*text,\s*\{\s*adbKeyboard/.test(adbSrc), '已改成按设备状态判定');
  ok('⑯ 源码：publisher 不再拿配置项决定中文怎么输（`c.adbKeyboard` / 传 `{ adbKeyboard }` 都已消失）',
    !/c\.adbKeyboard/.test(pubSrc) && !/inputText\(serial,\s*step\.value,\s*\{/.test(pubSrc),
    (pubSrc.match(/.*[aA]dbKeyboard.*/g) || []).map(s => s.trim()).join(' | '));
  ok('⑯ 源码：中文走广播这条路还在，且判定依据是设备当前输入法',
    /am broadcast -a ADB_INPUT_TEXT/.test(adbSrc) && /default_input_method/.test(adbSrc),
    '广播 + 设备输入法判定都在');

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
  fs.unlinkSync(IME_ACTIVE);                // 回到「装了这个 apk、但没设成当前输入法」的状态
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
  const pb2 = await adbMod.probe('127.0.0.1:5555');
  ok('⑬ 手填的不存在但有内置 ⇒ 退回内置，并且**在界面上说出来**（不静默替你换）',
    pb2.adbSource === 'bundled' && pb2.fix.some(f => /你填的 adb 路径不存在/.test(f.title)),
    JSON.stringify({ src: pb2.adbSource, titles: pb2.fix.map(f => f.title) }));
  ok('⑬ ★ 装了 ADBKeyboard 但没设成当前输入法 ⇒ 判「中文发不出去」(bad，不是「能发但影响体验」)，并挂「一键装上」按钮',
    pb2.fix.some(f => f.act && f.act.act === 'pub:installIme' && f.level === 'bad' && /中文发不出去/.test(f.title)),
    JSON.stringify(pb2.fix.filter(f => f.act)));
  ok('⑬ 这条还要说清「内置 ≠ 已装进模拟器」（否则用户会以为已经好了）',
    pb2.fix.some(f => f.act && /不等于/.test(f.how) && /装进模拟器/.test(f.how)),
    (pb2.fix.find(f => f.act) || {}).how || '');
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

  // ============ 15) 内置 adb 真的会被拿去执行（不只是界面上显示个路径） ============
  clearFiles();
  const v15 = await adbMod.version();
  ok('⑮ 留空 adb 路径 ⇒ 真的执行了内置那份 adb', !!v15, String(v15));
  ok('⑮ 执行的就是内置目录下的 adb.exe（假 adb 记下了实际被执行的程序）',
    filesLog().trim().split(/\r?\n/).includes(path.join(BDIR, 'adb.exe')),
    filesLog().trim().replace(/\n/g, ' | ') || '（没记到）');
  adbMod.setBundledAdbDir('');
  adbMod.setAdbPath('adb');

  console.log('\n--- 日志样例 ---');
  logs.slice(-4).forEach(l => console.log('  ' + l));
})().catch(e => { console.error('ADB TEST ERROR', e); process.exitCode = 1; });
