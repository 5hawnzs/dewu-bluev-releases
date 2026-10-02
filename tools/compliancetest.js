/* 合规检查的边界 + 「导出报告」
   1) 完全合格的 JPG 只能产出 1 条 ok，且 fix() 绝不能把它搬进 _rejected
      （曾经有一条隐患：合格图片后面又追加了一条「不支持的扩展名 → 隔离」，
        fix() 照着做会把好图搬走，而且报告里合格项与待隔离项同时出现）
   2) 「导出报告」要真的落文件：xlsx（汇总 + 明细两个工作表）与 csv（带 BOM）
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-comp-'));
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

// 工程根目录 = 本文件上一级
const base = path.resolve(__dirname, '..');
const jpeg = require(path.join(base, 'node_modules', 'jpeg-js'));
const { PNG } = require(path.join(base, 'node_modules', 'pngjs'));
const store = require(path.join(base, 'src/main/store.js'));
const compliance = require(path.join(base, 'src/main/services/compliance.js'));

function jpgBuf(r, g, b, size) {
  const d = Buffer.alloc(size * size * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return jpeg.encode({ data: d, width: size, height: size }, 90).data;
}
function pngBuf(size) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 200; png.data[i + 1] = 200; png.data[i + 2] = 200; png.data[i + 3] = 255; }
  return PNG.sync.write(png);
}

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

// 一个叶子目录：合格 JPG（400×400）+ 需转 JPG 的 PNG + 垃圾文件
const leaf = path.join(TMP, 'flat', '26FW-YB160+冠军白+1');
fs.mkdirSync(leaf, { recursive: true });
fs.writeFileSync(path.join(leaf, '1.jpg'), jpgBuf(240, 240, 242, 400));
fs.writeFileSync(path.join(leaf, '封面.png'), pngBuf(300));
fs.writeFileSync(path.join(leaf, '.DS_Store'), Buffer.from('junk'));

const items = [{
  id: '26FW-YB160+冠军白+1', dir: '26FW-YB160+冠军白+1', absDir: leaf,
  sku: '26FW-YB160', color: '冠军白',
  files: [{ name: '1.jpg', size: 0, type: 'image' }, { name: '封面.png', size: 0, type: 'image' }, { name: '.DS_Store', size: 0, type: 'junk' }]
}];
const rejectedDir = path.join(TMP, '素材', '_rejected');

(async () => {
  store.set({
    paths: { source: TMP, output: path.join(TMP, '输出'), rejected: rejectedDir },
    compliance: { maxImageMB: 10, maxVideoSec: 600, requireJpg: true, minPixels: 1764, minSide: 150, maxSide: 1500, autoScale: true, videoExtMustBeMp4: true }
  });
  const ctx = () => ({ log: () => {}, progress: () => {}, cancelled: () => false });

  // ---- ① 扫描：合格 JPG 只能有 1 条 ok ----
  const sc = await compliance.scan(items, ctx());
  ok('① 三类文件各一条（合格/待处理/隔离）', sc.stats.total === 3, JSON.stringify(sc.stats));
  ok('① 合格 JPG 记为 ok', sc.stats.ok === 1 && sc.stats.isolate === 1 && sc.stats.todo === 1, JSON.stringify(sc.stats));
  const jpgRows = sc.rows.filter(r => r.file === '1.jpg');
  ok('① 合格 JPG 只有一条记录', jpgRows.length === 1 && jpgRows[0].status === 'ok', JSON.stringify(jpgRows));
  ok('① 合格 JPG 没有第二重身份（不会被判隔离）', !sc.rows.some(r => r.file === '1.jpg' && r.status === 'isolate'));

  // ---- ② 处理：好图必须原地不动 ----
  const fx = await compliance.fix(items, sc.rows, ctx());
  ok('② 只处理该处理的（1 转 JPG + 1 隔离）', fx.converted === 1 && fx.isolated === 1 && fx.failed === 0, JSON.stringify({ converted: fx.converted, isolated: fx.isolated, failed: fx.failed }));
  ok('② 合格 JPG 仍在原位', fs.existsSync(path.join(leaf, '1.jpg')));
  ok('② 合格 JPG 没被搬进 _rejected', !fs.existsSync(path.join(rejectedDir, '26FW-YB160+冠军白+1', '1.jpg')));
  ok('② 垃圾文件确实进了 _rejected', fs.existsSync(path.join(rejectedDir, '26FW-YB160+冠军白+1', '.DS_Store')));
  ok('② PNG 已转成 JPG', fs.existsSync(path.join(leaf, '封面.jpg')));

  // ---- ③ 导出报告 ----
  const rep = await compliance.exportReport(
    { rows: sc.rows, stats: sc.stats, groups: [{ name: '26FW-YB160+冠军白+1', stats: sc.stats, rows: sc.rows }] },
    { format: 'both' }
  );
  ok('③ 导出 xlsx', !!rep.file && fs.existsSync(rep.file), rep.file && path.basename(rep.file));
  ok('③ 导出 csv', !!rep.csvFile && fs.existsSync(rep.csvFile), rep.csvFile && path.basename(rep.csvFile));
  const csv = fs.readFileSync(rep.csvFile, 'utf8');
  ok('③ csv 带 BOM（Windows 双击不乱码）', csv.charCodeAt(0) === 0xFEFF);
  ok('③ csv 内容含子文件夹与文件', csv.includes('26FW-YB160+冠军白+1') && csv.includes('1.jpg'));
  const ExcelJS = require(path.join(base, 'node_modules', 'exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(rep.file);
  ok('③ xlsx 有汇总与明细两个工作表', !!wb.getWorksheet('汇总') && !!wb.getWorksheet('明细'), wb.worksheets.map(w => w.name).join('、'));
  ok('③ 明细行数与报告一致', wb.getWorksheet('明细').rowCount === sc.rows.length + 1, wb.getWorksheet('明细').rowCount - 1 + ' 行');

  // ---- ④ 空报告要明确报错，不许静默成功 ----
  let empty = '';
  try { await compliance.exportReport({ rows: [] }, {}); } catch (e) { empty = e.message; }
  ok('④ 没有报告时明确报错', /没有可导出的报告/.test(empty), empty);

  // ---- ⑤ 视频：非 mp4 要变成「可自动处理」，fix() 真转出 mp4 且 type 仍是 video ----
  // 这一段是**集成路径**（合规检查 → 内置 ffmpeg → 回写条目清单），与 videotest.js 的
  // 「单模块能力」互补：那边证明转得动，这边证明**接对了**（状态是 todo、类型没被改成图片）。
  const { execFileSync } = require('child_process');
  const vmod = require(path.join(base, 'src/main/services/video.js'));
  const VENDOR_FF = path.join(base, 'vendor', 'ffmpeg');
  vmod.setBundledFfmpegDir(VENDOR_FF);
  ok('⑤ 前置：内置 ffmpeg 可用（否则本段只能验「需手动」那条路）', vmod.status().usable === true, JSON.stringify(vmod.status()));

  const vleaf = path.join(TMP, 'flat', 'MOV-001+黑+1');
  fs.mkdirSync(vleaf, { recursive: true });
  execFileSync(path.join(VENDOR_FF, 'ffmpeg.exe'),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'mov', path.join(vleaf, '片段.mov')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  ok('⑤ 造出一个真的 .mov 样本', fs.existsSync(path.join(vleaf, '片段.mov')));

  const vitems = [{
    id: 'MOV-001+黑+1', dir: 'MOV-001+黑+1', absDir: vleaf, sku: 'MOV-001', color: '黑',
    files: [{ name: '片段.mov', size: 0, type: 'video' }]
  }];
  const vsc = await compliance.scan(vitems, ctx());
  const vrow = vsc.rows[0] || {};
  ok('⑤ 非 mp4 视频被判成「可自动处理」（todo / 转 MP4），而不是「需手动转 MP4」',
    vrow.status === 'todo' && vrow.action === '转 MP4', JSON.stringify({ status: vrow.status, action: vrow.action, issue: vrow.issue }));
  ok('⑤ 「非 MP4」按扩展名计数 = 1、「视频超时」= 0（2 秒的片子没超 600 秒，报表口径不许撒谎）',
    vsc.stats.notMp4 === 1 && vsc.stats.videoLong === 0, JSON.stringify(vsc.stats));
  ok('⑤ 这一步 fix() 之前，目录里还没有 mp4', !fs.existsSync(path.join(vleaf, '片段.mp4')));

  const vfx = await compliance.fix(vitems, vsc.rows, ctx());
  ok('⑤ fix() 真的转出 .mp4', fs.existsSync(path.join(vleaf, '片段.mp4')) && vfx.converted === 1 && vfx.failed === 0,
    JSON.stringify({ converted: vfx.converted, failed: vfx.failed, exist: fs.existsSync(path.join(vleaf, '片段.mp4')) }));
  const vOut = await vmod.verifyMp4(path.join(vleaf, '片段.mp4'));
  ok('⑤ ★ 转出来的东西是**能读的 mp4**（解析产物核对，不看文件名）', vOut.ok === true, JSON.stringify(vOut));
  ok('⑤ 非 mp4 原文件在转成 mp4 后已被移除（目录里不留两份）', !fs.existsSync(path.join(vleaf, '片段.mov')));
  const vf = vitems[0].files[0];
  ok('⑤ ★★ 条目清单里 type 仍然是 video（曾经写死成 image ⇒ 发布时会拿图去发视频）',
    vf && vf.name === '片段.mp4' && vf.type === 'video', JSON.stringify(vf));

  // 已经有同名 .mp4 时**不许覆盖**（那是另一份素材），另起一个名字
  const v2leaf = path.join(TMP, 'flat', 'MOV-002+白+1');
  fs.mkdirSync(v2leaf, { recursive: true });
  fs.copyFileSync(path.join(vleaf, '片段.mp4'), path.join(v2leaf, '片段.mp4'));   // 先占住这个名字
  execFileSync(path.join(VENDOR_FF, 'ffmpeg.exe'),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'mov', path.join(v2leaf, '片段.mov')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const occ = fs.statSync(path.join(v2leaf, '片段.mp4')).size;
  const v2items = [{
    id: 'MOV-002+白+1', dir: 'MOV-002+白+1', absDir: v2leaf, sku: 'MOV-002', color: '白',
    files: [{ name: '片段.mov', size: 0, type: 'video' }]
  }];
  const v2sc = await compliance.scan(v2items, ctx());
  await compliance.fix(v2items, v2sc.rows, ctx());
  ok('⑤ 目录里已有同名 .mp4 时绝不覆盖，另起 -2 的名字',
    fs.existsSync(path.join(v2leaf, '片段-2.mp4')) && fs.statSync(path.join(v2leaf, '片段.mp4')).size === occ,
    fs.readdirSync(v2leaf).join(' '));

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('COMPLIANCE TEST ERROR', e); process.exitCode = 1; });
