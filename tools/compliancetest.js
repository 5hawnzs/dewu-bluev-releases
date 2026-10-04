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
    paths: { output: path.join(TMP, '输出'), rejected: rejectedDir },
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

  // ---- ①b 尺寸口径（2026-10-05 用户口径：「超尺寸的图片没必要做等比缩放，只要不要低于下限
  //          就不用处理尺寸问题，除非后面我提示」；真机实测 3213×4284 原图能直接发布）----
  //   ★ 必须**双向**：默认态证明「超上限放行」，打开开关证明「上限能力还在、不是整段被删」。
  const sizeLeaf = path.join(TMP, 'flat', 'SIZE-001+白+1');
  fs.mkdirSync(sizeLeaf, { recursive: true });
  fs.writeFileSync(path.join(sizeLeaf, '大图.jpg'), jpgBuf(200, 200, 205, 3000));  // 3000×3000，远超 1500
  fs.writeFileSync(path.join(sizeLeaf, '小图.jpg'), jpgBuf(210, 210, 215, 120));   // 120×120，低于下限 150
  const sItems = [{
    id: 'SIZE-001+白+1', dir: 'SIZE-001+白+1', absDir: sizeLeaf, sku: 'SIZE-001', color: '白',
    files: [{ name: '大图.jpg', size: 0, type: 'image' }, { name: '小图.jpg', size: 0, type: 'image' }]
  }];
  const s1 = await compliance.scan(sItems, ctx());
  const big1 = s1.rows.find(r => r.file === '大图.jpg') || {};
  const small1 = s1.rows.find(r => r.file === '小图.jpg') || {};
  ok('①b 超尺寸图片不再被拦（默认不判上限：3000×3000 判合格）',
    big1.status === 'ok', JSON.stringify({ status: big1.status, action: big1.action, issue: big1.issue }));
  ok('①b 低于下限仍被拦，且口径是「需更换图片 / 交人工」（旧口径把它错标成「等比缩放」，而 fitWithin 只缩不放）',
    small1.status === 'manual' && small1.action === '需更换图片',
    JSON.stringify({ status: small1.status, action: small1.action, issue: small1.issue }));
  ok('①b 默认态 scaled=0 / tooSmall=1（界面那格恒 0 才够格被藏起来）',
    s1.stats.scaled === 0 && s1.stats.tooSmall === 1, JSON.stringify(s1.stats));

  store.set({ compliance: { enforceMaxSide: true } });   // ← 反向对照：把上限能力打开
  const s2 = await compliance.scan(sItems, ctx());
  const big2 = s2.rows.find(r => r.file === '大图.jpg') || {};
  ok('①b 反向对照：打开 enforceMaxSide 后同一张 3000×3000 必须变回「等比缩放 / todo」',
    big2.status === 'todo' && big2.action === '等比缩放' && s2.stats.scaled === 1,
    JSON.stringify({ status: big2.status, action: big2.action, scaled: s2.stats.scaled }));
  store.set({ compliance: { enforceMaxSide: false } });  // 复原，别把开关带进后面几组

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

  // ---- ⑥ ★★★ 2026-10-04（用户报「第一篇素材是全黑 0 秒视频，哪来的」）
  //   用户原话：「**我已经在合规检查转码了，而且他在文件夹里的格式就是 mp4，怎么可能格式不对？**」
  //   —— 扩展名确实对（就是 .mp4），问题在**容器里那个编码**：真机实测得物**解不开 HEVC Main 10
  //   （10-bit）**，相册里那一格是纯黑 + 一直转圈。用户第一条素材就是这一种
  //   （`82-326313100701-变装展示-7月份.mp4` = hvc1 / yuv420p10le / 10-bit / 39.9MB），
  //   同批另一条 H.264 8-bit 的缩略图正常。
  //   ⇒ 这一段是**集成路径**（合规检查 → 内置 ffmpeg → 回写条目清单）：证明扩展名是 .mp4、
  //     容器合法的素材，也能被**认出来**并**真转到 8-bit**（不是只标红、更不是只改个名字）。
  const v10leaf = path.join(TMP, 'flat', 'HEVC10-001+黑+1');
  fs.mkdirSync(v10leaf, { recursive: true });
  execFileSync(path.join(VENDOR_FF, 'ffmpeg.exe'),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', path.join(v10leaf, '片段.mp4')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  ok('⑥ 前置：造出一个**扩展名就是 .mp4**、但里面是 10-bit HEVC 的样本',
    fs.existsSync(path.join(v10leaf, '片段.mp4')) && (await vmod.probeDecodable(path.join(v10leaf, '片段.mp4'))).tenBit === true,
    JSON.stringify(await vmod.probeDecodable(path.join(v10leaf, '片段.mp4'))));
  const v10items = [{
    id: 'HEVC10-001+黑+1', dir: 'HEVC10-001+黑+1', absDir: v10leaf, sku: 'HEVC10-001', color: '黑',
    files: [{ name: '片段.mp4', size: 0, type: 'video' }]
  }];
  const v10sc = await compliance.scan(v10items, ctx());
  const v10row = v10sc.rows[0] || {};
  ok('⑥ ★★ 扩展名是 .mp4、但编码得物解不开 ⇒ 必须判成「可自动处理」并点名 10-bit（不许记成合格）',
    v10row.status === 'todo' && v10row.codecBad === true && /10-bit/.test(v10row.issue || ''),
    JSON.stringify({ status: v10row.status, action: v10row.action, issue: v10row.issue, codecBad: v10row.codecBad }));
  ok('⑥ 统计里单独列「编码不可解」= 1，且「非 MP4」= 0（两件事不许混成一列：扩展名没毛病）',
    v10sc.stats.codecBad === 1 && v10sc.stats.notMp4 === 0, JSON.stringify(v10sc.stats));

  const v10fx = await compliance.fix(v10items, v10sc.rows, ctx());
  const v10after = await vmod.probeDecodable(path.join(v10leaf, '片段.mp4'));
  ok('⑥ ★★ fix() 必须把这条**转成 8-bit**（文件名不变、就地替换，不是另存一份）',
    v10fx.converted === 1 && v10fx.failed === 0 && v10after.ok === true && v10after.bitDepth === 8,
    JSON.stringify({ converted: v10fx.converted, failed: v10fx.failed, after: v10after }));
  ok('⑥ 处置结果里写清了「原编码是什么」（让人看得懂为什么一条 .mp4 会被"转"一次）',
    /10-bit/.test(v10row.result || '') && /H\.264/.test(v10row.result || ''), String(v10row.result));
  ok('⑥ 条目清单里还是 video、还是同一个文件名（下游发布拿到的仍是这条视频）',
    v10items[0].files[0].name === '片段.mp4' && v10items[0].files[0].type === 'video',
    JSON.stringify(v10items[0].files[0]));
  ok('⑥ 目录里只有这一个文件（转码不留中间产物、不另起名字）',
    fs.readdirSync(v10leaf).length === 1, fs.readdirSync(v10leaf).join(' '));

  // ---- ⑦ ★★★ 2026-10-04（复核 ffmpeg 那轮实测出来的**第二个**缺口：音频轨）
  //   上一次只堵了「视频轨编码/位深」，**音频轨完全没看**。实测（见 videotest N 组的表）：
  //   `-c copy` 会把源音频原样搬进 mp4 —— ac3→`ac-3`、eac3→`ec-3`、opus→`Opus`、
  //   pcm→`ipcm`、flac→`fLaC`；而 `verifyMp4` 只看视频轨 ⇒ 判它"合格"。
  //   后果与 10-bit 黑格同一类：「视频能放、**没有声音**」，且工具一条错都不报。
  //   ⇒ 这一段钉**集成路径**：扩展名是 .mp4、视频轨完全正常的素材，只要音轨是 ac-3，
  //     就必须被认出来、并真被收拾成 AAC（视频轨不许被重编）。
  const aLeaf = path.join(TMP, 'flat', 'AC3-001+白+1');
  fs.mkdirSync(aLeaf, { recursive: true });
  execFileSync(path.join(VENDOR_FF, 'ffmpeg.exe'),
    ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'ac3', '-shortest', path.join(aLeaf, '片段.mp4')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const aBefore = await vmod.probeDecodable(path.join(aLeaf, '片段.mp4'));
  ok('⑦ 前置：造出一条**视频轨完全正常（8-bit H.264）、音轨是 ac-3** 的 .mp4',
    aBefore.ok === true && aBefore.audio === 'ac-3' && aBefore.audioSafe === false,
    JSON.stringify({ ok: aBefore.ok, codec: aBefore.codec, audio: aBefore.audio }));
  const aItems = [{
    id: 'AC3-001+白+1', dir: 'AC3-001+白+1', absDir: aLeaf, sku: 'AC3-001', color: '白',
    files: [{ name: '片段.mp4', size: 0, type: 'video' }]
  }];
  const aSc = await compliance.scan(aItems, ctx());
  const aRow = aSc.rows[0] || {};
  ok('⑦ ★★★ 音轨得物放不出声 ⇒ 必须判成「可自动处理」并点名 ac-3（不许因为视频正常就记成合格）',
    aRow.status === 'todo' && aRow.audioBad === true && /ac-3/.test(aRow.issue || ''),
    JSON.stringify({ status: aRow.status, action: aRow.action, issue: aRow.issue, audioBad: aRow.audioBad }));
  ok('⑦ 统计里单独列「音频不可解」= 1，且「编码不可解」= 0（视频是好的，两件事不许混成一列）',
    aSc.stats.audioBad === 1 && aSc.stats.codecBad === 0, JSON.stringify(aSc.stats));

  const aFx = await compliance.fix(aItems, aSc.rows, ctx());
  const aAfter = await vmod.probeDecodable(path.join(aLeaf, '片段.mp4'));
  ok('⑦ ★★★ fix() 必须真把音轨转成 AAC（就地替换，文件名不变）',
    aFx.converted === 1 && aFx.failed === 0 && aAfter.audio === 'mp4a' && aAfter.audioSafe === true,
    JSON.stringify({ converted: aFx.converted, failed: aFx.failed, audio: aAfter.audio }));
  ok('⑦ ★★ 视频轨**不许**被一起重编：转完仍是 Baseline（= `-c:v copy`，没有为一个音轨重编整条片子）',
    /Baseline/.test(String(aAfter.label || '')), aAfter.label);
  ok('⑦ 处置结果里写清「为什么这条本来就叫 .mp4 的素材会被转一次」',
    /音频/.test(aRow.result || '') && /ac-3/.test(aRow.result || '') && /AAC/.test(aRow.result || ''),
    String(aRow.result));
  ok('⑦ 目录里只有这一个文件（不留中间产物）', fs.readdirSync(aLeaf).length === 1, fs.readdirSync(aLeaf).join(' '));

  console.log('\nTMP: ' + TMP);
})().catch(e => { console.error('COMPLIANCE TEST ERROR', e); process.exitCode = 1; });
