/* 真实（adb）发布通道的可执行验证：用假 adb 模拟一台在线设备
   覆盖：设备检查 / dump 解析与定位表 / 未配定位表必失败 / 图文条全流程 / 页面结构变了必失败 /
        **抓取前先说清停在哪一屏**（停在别的 App 上拦下 / 停在得物首页告警 / 读不到就照常抓）/
        **视频条**（推视频 → 等媒体库索引 → 走 videoSteps，没配 videoSteps 就复用图文 steps；媒体库一直看不到必失败）/
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
    publish: { device: '127.0.0.1:5555', intervalMinSec: 1, intervalMaxSec: 1 }
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
  const r = await publisher.run(state, ctx);
  const log = calls();
  ok('真实通道跑完 1 条', r.mode === 'adb' && r.total === 1, `成功 ${r.okCount}/${r.total}`);
  ok('推图 2 张', (log.match(/push /g) || []).length === 2, (log.match(/push .*/g) || []).join(' | '));
  ok('触发媒体扫描', /MEDIA_SCANNER_SCAN_FILE/.test(log));
  ok('点击了「发布」按钮', (log.match(/input tap 162 160/g) || []).length >= 1);
  ok('点击了相册/下一步/关联好物', /input tap 162 280/.test(log) && /input tap 920 2250/.test(log) && /input tap 220 1540/.test(log));
  ok('中文标题走 ADBKeyboard 广播', /ADB_INPUT_TEXT --es msg "白色的鞋谁懂"/.test(log));
  ok('话题也真实输入', /ADB_INPUT_TEXT --es msg "#品牌甲"/.test(log));
  ok('结果标为发布成功', r.rows[0].result === '发布成功', r.rows[0].result);

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
    /adb\.dumpEx\(serial, \{[^}]*pkg: uimap\.DEWU\.pkg[^}]*\}/.test(tapBranch) && tapBranch.length > 200,
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
  ok('⑧ 媒体库一直看不到 → 失败，不硬点',
    rv3.rows[0].result === '失败' && /媒体库还没索引到/.test(rv3.rows[0].reason), rv3.rows[0].reason);
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

  console.log('\n--- 日志样例 ---');
  logs.slice(-4).forEach(l => console.log('  ' + l));
})().catch(e => { console.error('ADB TEST ERROR', e); process.exitCode = 1; });
