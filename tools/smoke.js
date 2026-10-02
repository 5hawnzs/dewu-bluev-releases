/* 端到端冒烟：在临时目录里跑完整流水线（不需要 GUI） */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-smoke-'));

const fake = {
  app: { getPath: () => TMP, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle() {}, on() {} },
  dialog: {}, shell: {}, nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  Notification: { isSupported: () => false },
  screen: {}, contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fake;
  return origLoad.apply(this, arguments);
};

// 工程根目录 = 本文件上一级；不写死绝对路径，换机器/换目录也能跑
const base = path.resolve(__dirname, '..');
const { PNG } = require(path.join(base, 'node_modules', 'pngjs'));
const jpeg = require(path.join(base, 'node_modules', 'jpeg-js'));

function pngBuf(r, g, b, size = 60) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; }
  return PNG.sync.write(png);
}
function jpgBuf(r, g, b, size = 120) {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return jpeg.encode({ data, width: size, height: size }, 92).data;
}

// ---- 造素材：多层嵌套 + 扁平命名 混合 ----
const src = path.join(TMP, '素材', '2026-09-品牌甲');
const mk = (rel, name, buf) => {
  const d = path.join(src, rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), buf);
};
mk(path.join('26FW-YB160', '冠军白', '1'), '1.png', pngBuf(245, 245, 247));   // 冠军白 → 转 JPG
mk(path.join('26FW-YB160', '冠军白', '1'), '2.jpg', jpgBuf(240, 240, 242));
mk(path.join('26FW-YB160', '冠军白', '2'), '1.jpg', jpgBuf(238, 238, 240));
mk(path.join('UF46FWT75EH1HF6', '领袖蓝', '1'), '1.jpg', jpgBuf(45, 70, 130));
mk(path.join('CK-Y208+流沙金'), '封面.png', pngBuf(196, 172, 128));
mk(path.join('CK-Y208+流沙金'), '.DS_Store', Buffer.from('junk'));
mk(path.join('abc+黑色+3'), 'x.heic', Buffer.from('not a real heic'));
mk(path.join('abc+黑色+3'), 'y.jpg', jpgBuf(28, 28, 30));

const store = require(path.join(base, 'src/main/store.js'));
const flatten = require(path.join(base, 'src/main/services/flatten.js'));
const compliance = require(path.join(base, 'src/main/services/compliance.js'));
const copywriter = require(path.join(base, 'src/main/services/copywriter.js'));
const verify = require(path.join(base, 'src/main/services/verify.js'));
const sheet = require(path.join(base, 'src/main/services/sheet.js'));
const publisher = require(path.join(base, 'src/main/services/publisher.js'));
const imaging = require(path.join(base, 'src/main/services/imaging.js'));

store.set({
  paths: { output: path.join(TMP, '输出/得物'), rejected: path.join(TMP, '素材/_rejected') },
  compliance: { maxImageMB: 0.0005, maxVideoSec: 600, isolateJunk: true },  // 故意压得很小，触发压缩分支
  publish: { intervalSec: 1, videoIntervalSec: 1, retry: 1 }   // 「演示节奏」开关已删：现在直接给 1 秒间隔
});

const logs = [];
const ctx = () => ({ log: (m, l) => logs.push((l || 'info') + ': ' + m), progress: () => {}, cancelled: () => false });
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

(async () => {
  console.log('图片引擎：' + imaging.engineName());

  // ① 素材整理
  const plan = await flatten.plan(src, ctx());
  ok('① 清单扫描', plan.total === 5, `${plan.total} 个叶子目录 / ${plan.fileTotal} 个文件`);
  const fl = await flatten.run(src, { keepOriginal: true, withStamp: true, mode: 'auto' }, ctx());
  ok('① 扁平化执行', fl.items.length === 5, fl.summary + ` · 链接 ${fl.links} 复制 ${fl.copies}`);
  ok('① 原素材完全不动', !fl.renamed && fs.existsSync(src));
  ok('① 扁平目录存在', fs.existsSync(fl.flatDir));
  const names = fl.items.map(i => i.dir).sort();
  ok('① 命名：嵌套层级用 _ 连接，单层保持原名', names.every(n => /_/.test(n) || /\+/.test(n)), names.join(' | '));

  // ② 合规检查
  const sc = await compliance.scan(fl.items, ctx());
  ok('② 扫描出报告', sc.stats.total === 8, JSON.stringify(sc.stats));
  ok('② 尺寸规则生效（等比缩放/尺寸不足）', sc.rows.some(r => r.action === '等比缩放' || r.action === '需更换图片'), sc.rows.filter(r=>r.action==='等比缩放').length + ' 张需缩放');
  ok('② 垃圾文件被识别', sc.rows.some(r => r.file === '.DS_Store' && r.status === 'isolate'));
  ok('② PNG 需转 JPG', sc.rows.filter(r => r.action === '转 JPG（白底填充）').length === 2);
  const fx = await compliance.fix(fl.items, sc.rows, ctx());
  ok('② 处理不崩溃', true, `转换 ${fx.converted} · 隔离 ${fx.isolated} · 失败 ${fx.failed}`);
  ok('② HEIC 缺解码器时降级为人工', fx.rows.some(r => r.file === 'x.heic' && r.status === 'manual'));
  const jpgOk = fs.readdirSync(path.join(fl.flatDir, names[0])).filter(f => /\.jpg$/.test(f)).length;
  ok('② PNG 已转成 JPG', jpgOk >= 1, `flat/${names[0]} → ${jpgOk} 个 jpg`);

  // ③ 文案生成
  const cp = await copywriter.generate(fl.items, ctx());
  ok('③ 生成条数', cp.rows.length === 5);
  ok('③ 标题格式轮换去重', new Set(cp.rows.map(r => r.format)).size === Math.min(5, 10), cp.rows.map(r => r.format).join(','));
  ok('③ 话题组合去重', new Set(cp.rows.map(r => r.topics.join('|'))).size === cp.rows.length);
  ok('③ 标题不为空', cp.rows.every(r => r.title && r.body));

  // ④ 货号颜色校验
  const vf = await verify.check(fl.items, ctx());
  ok('④ 校验有结论', vf.rows.length === 5, JSON.stringify(vf.stats));
  ok('④ 主色反查可用', vf.rows.some(r => r.imageColor && r.imageColor !== '—'), vf.rows.map(r => `${r.sku}:${r.imageColor}`).join(' | '));

  // ⑤ 发布单
  const state = { items: fl.items, copyRows: cp.rows, verify: vf };
  const sh = await sheet.exportSheet(state, { intervalSec: 60 });
  ok('⑤ xlsx 导出', fs.existsSync(sh.file) && sh.rowCount === 5 && sh.colCount === 26, `${sh.rowCount} 行 × ${sh.colCount} 列`);

  // ⑥ 发布（模拟节奏）
  const conn = await publisher.connect();
  ok('⑥ 连接降级为模拟通道', conn.mode === 'mock', conn.note);
  const pubRows = sh.rows.map((r, i) => ({ seq: i + 1, id: fl.items[i].id, dir: r[1], goods: 1, images: 4, startAt: '', status: '排队', result: '', retries: 0, reason: '' }));
  const pr = await publisher.run(Object.assign({}, state, { publish: { rows: pubRows } }), ctx());
  ok('⑥ 发布跑完', pr.total === 5, `成功 ${pr.okCount}/${pr.total}`);
  ok('⑥ 结果写入 jsonl', fs.existsSync(sheet.logFile()));
  const merged = await sheet.mergeResults(sh.file, pr.results);
  ok('⑥ 合并回写 Excel', merged.updated === 5, `更新 ${merged.updated} 行`);

  // ⑦ 货号颜色校验的「阻断」口径：**查不到 ≠ 有错**
  // 真实事故面：商品池只导了一部分时，池里没有的货号全被判 warn，而发布侧原来拿
  // `pass === false` 一把抓 ⇒ **整批一条都发不出去**，界面只显示「校验未通过」，
  // 与本文件与真机口径「接口查不到的货号仅告警不阻断」自相矛盾。
  const pool = require(path.join(base, 'src/main/services/pool.js'));
  const poolBefore = pool.get();
  try {
    // 故意造一份「不全 + 有一条对不上」的商品池：
    //   26FW-YB160(×2) 匹配 · UF46FWT75EH1HF6 匹配 · CK-Y208 颜色不匹配 · abc 查不到
    pool.save({
      source: '测试用（故意不全）', updatedAt: Date.now(),
      skus: { '26FW-YB160': ['冠军白'], 'UF46FWT75EH1HF6': ['领袖蓝'], 'CK-Y208': ['燕麦色'] }
    });
    const v2 = await verify.check(fl.items, ctx());
    const miss = v2.rows.filter(r => /未查到颜色信息/.test(r.conclusion));
    const mism = v2.rows.filter(r => r.conclusion === '颜色不匹配');
    ok('⑦ 查不到货号 = 只告警（level warn 且 block 不为真）',
      miss.length > 0 && miss.every(r => r.level === 'warn' && r.block === false),
      miss.map(r => `${r.sku}:${r.level}/block=${r.block}`).join(' '));
    ok('⑦ 颜色对不上 = 阻断（block 为真）',
      mism.length > 0 && mism.every(r => r.block === true),
      mism.map(r => `${r.sku}:block=${r.block}`).join(' '));
    ok('⑦ 统计里把「需人工」和「会被拦下」分开算', v2.stats.manual > v2.stats.blocked,
      JSON.stringify(v2.stats));
    // 升级前存在 project.json 里的旧数据没有 block 字段：必须按结论原文回推，
    // 否则「升级了但旧口径还拦着」，用户会以为没修
    ok('⑦ 旧数据（无 block 字段）按结论回推，不退回旧口径',
      verify.isBlocked({ pass: false, conclusion: '货号 1 未查到颜色信息，请核对' }) === false
      && verify.isBlocked({ pass: false, conclusion: '颜色不匹配' }) === true
      && verify.isBlocked({ pass: false, block: true, conclusion: '未查到颜色信息，请核对' }) === true,
      '未查到→放行 / 不匹配→拦 / 显式 block 优先');

    const sh2 = await sheet.exportSheet({ items: fl.items, copyRows: cp.rows, verify: v2 }, { intervalSec: 60 });
    const pubRows2 = sh2.rows.map((r, i) => ({
      seq: i + 1, id: fl.items[i].id, dir: r[1], goods: 1, images: 4, startAt: '', status: '排队',
      result: r[20] === '校验未通过' ? '校验未通过' : '', retries: 0, reason: r[21] || ''
    }));
    const st2 = sh2.rows.map((r, i) => ({ id: fl.items[i].id, col: r[20], note: r[21] }));
    const missIds = new Set(miss.map(r => r.id));
    const mismIds = new Set(mism.map(r => r.id));
    ok('⑦ 发布单：查不到的行是「待发布」（结论仍写清原因），对不上的行才是「校验未通过」',
      st2.filter(x => missIds.has(x.id)).every(x => x.col === '待发布' && /未查到颜色信息/.test(x.note || ''))
      && st2.filter(x => mismIds.has(x.id)).every(x => x.col === '校验未通过'),
      st2.map(x => `${x.id}:${x.col}`).join(' | '));

    const pr2 = await publisher.run(
      { items: fl.items, copyRows: cp.rows, verify: v2, publish: { rows: pubRows2 } }, ctx());
    const byId = new Map((pr2.rows || []).map(r => [String(r.id), r]));
    ok('⑦ 查不到的货号照常发布（旧版这里会整批静默不发）',
      [...missIds].every(id => (byId.get(String(id)) || {}).result === '发布成功'),
      [...missIds].map(id => `${id}:${(byId.get(String(id)) || {}).result}`).join(' '));
    ok('⑦ 对不上的货号被拦下、且理由是人话',
      [...mismIds].every(id => (byId.get(String(id)) || {}).result === '校验未通过'),
      [...mismIds].map(id => `${id}:${(byId.get(String(id)) || {}).result}/${(byId.get(String(id)) || {}).reason}`).join(' '));
  } finally {
    pool.save(poolBefore);   // 还原商品池，别把这份「故意不全」的池留给后面的断言/别的套件
  }

  // ⑧ 商品池导入：表头行不能被当成一条真货号
  //   实测本机 pool.json 里就躺着一条假货号「货号 → [颜色]」（导 CSV 时把表头一起吃了），
  //   界面于是显示「2 个货号」而实际只有 1 条。
  const csvFile = path.join(TMP, 'pool-test.csv');
  fs.writeFileSync(csvFile, '\uFEFF货号,颜色\n26FW-YB160,冠军白/冠军黑\nUF46FWT75EH1HF6,领袖蓝\n', 'utf8');
  const poolBefore2 = pool.get();
  try {
    const imp = pool.importFile(csvFile);
    const keys = Object.keys(imp.skus);
    ok('⑧ 导入 CSV 跳过表头（不把「货号」当数据）', !imp.skus['货号'] && keys.length === 2,
      `${keys.length} 个货号：${keys.join(' / ')}`);
    ok('⑧ 一个货号多颜色按 / 拆开',
      (imp.skus['26FW-YB160'] || []).join('|') === '冠军白|冠军黑',
      JSON.stringify(imp.skus['26FW-YB160']));
  } finally {
    pool.save(poolBefore2);
  }

  // ⑨ 必带话题写多个：分隔符 / 自动补 # / 超过 5 列要**告警**而不是静默丢
  //   实测（改前）：输入「#A #B」会整串当成**一个**话题塞进「话题1」——
  //   得物那边就是个不存在的话题，联想点选必然点不出来，而现场看起来像「话题选错了」。
  const cfgBefore = { requiredTopic: store.get('copy.requiredTopic'), extraTopics: store.get('copy.extraTopics') };
  try {
    ok('⑨ 多话题分隔符：空格 / 中英文逗号 / 顿号 / 分号 / 竖线 都认',
      ['#A #B', '#A，#B', '#A, #B', '#A、#B', '#A;#B', '#A|#B'].every(s => copywriter.parseTopics(s).join('|') === '#A|#B'),
      copywriter.parseTopics('#A #B').join('|'));
    ok('⑨ 漏写 # 自动补上；重复话题只留一个',
      copywriter.parseTopics('品牌甲, #男生穿搭, 品牌甲').join('|') === '#品牌甲|#男生穿搭',
      copywriter.parseTopics('品牌甲, #男生穿搭, 品牌甲').join('|'));

    store.set({ copy: { requiredTopic: '#品牌甲, #男生穿搭', extraTopics: 4 } });
    const plan9 = copywriter.buildPlan([{ id: 'x1', color: '黑' }]);
    const t9 = plan9.rows[0].topics;
    ok('⑨ 两个必带话题都进组合，且固定排在话题最前面',
      t9[0] === '#品牌甲' && t9[1] === '#男生穿搭', JSON.stringify(t9));
    ok('⑨ 必带 2 + 额外 4 = 6 超过 5 列 ⇒ 只给 5 个并明确告警（旧版静默丢掉第 6 个）',
      t9.length === 5 && /话题1~话题5/.test(plan9.warning || ''), `${t9.length} 个 · warning=${plan9.warning}`);

    store.set({ copy: { requiredTopic: '#品牌甲', extraTopics: 4 } });
    const plan9b = copywriter.buildPlan(Array.from({ length: 5 }, (_, i) => ({ id: 'y' + i, color: '黑' })));
    ok('⑨ 没超限就不该告警（否则天天「狼来了」）',
      plan9b.warning === null && plan9b.rows.every(r => r.topics.length === 5), `warning=${plan9b.warning}`);
    ok('⑨ 必带话题在每一篇里都在（不会被轮换挤掉）',
      plan9b.rows.every(r => r.topics[0] === '#品牌甲'), plan9b.rows.map(r => r.topics[0]).join(' '));
  } finally {
    store.set({ copy: cfgBefore });   // 还原配置，别影响后面的断言
  }

  console.log('\n--- 日志样例 ---');
  logs.slice(0, 12).forEach(l => console.log('  ' + l));
  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('SMOKE ERROR', e); process.exitCode = 1; });
