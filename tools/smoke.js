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
const src = path.join(TMP, '素材', '2026-09-TW男装');
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
  paths: { source: path.join(TMP, '素材'), output: path.join(TMP, '输出/得物'), rejected: path.join(TMP, '素材/_rejected') },
  compliance: { maxImageMB: 0.0005, maxVideoSec: 600, isolateJunk: true },  // 故意压得很小，触发压缩分支
  publish: { mock: true, mockIntervalSec: 1, retry: 1 }
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

  console.log('\n--- 日志样例 ---');
  logs.slice(0, 12).forEach(l => console.log('  ' + l));
  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('SMOKE ERROR', e); process.exitCode = 1; });
