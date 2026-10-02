'use strict';
/* 视频转 mp4（得物只收 mp4）
   ─────────────────────────────────────────────────────────────────────────
   这套件的立场：**每一件都要真读产物**，不许「文件存在 == 转成功」。
   所以样本全部用**内置 ffmpeg 现造**（testsrc 画面 + 正弦音），转完再解析产物核对
   ftyp 品牌 / 视频轨编码 / 时长 —— 空 == 空 的假通过在这里没有立足之地。

   覆盖：
     G  纯函数「三段解析」全分支（手填 > 内置 > PATH，含 configured-missing）
     A  已经是 mp4        → 无损转封装（remux）通过
     B  .mov (H.264/AAC)  → iPhone 的典型形态；转封装通过，品牌必须从 qt 变成 mp4 家族
     C  .mov (ProRes)     → mp4 容器放不下 ProRes ⇒ 必须**自动落转码**，不许直接报错
     D  .m4v              → mp4 家族，转封装通过
     E  坏文件            → 如实抛错，且**不留半成品**
     F  只有音频轨        → 如实抛错（别产出一个「没画面却叫 mp4」的文件）
     H  取消              → 立刻抛「已取消」，不留半成品
     I  verifyMp4 的鉴别力 → 对没转的 .mov 判不通过（证明判据真在查，不是空转）

   前置：vendor/ffmpeg/ffmpeg.exe 在仓库里（故意进 git，见 vendor/README.md）
*/
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/services/video.js'));

const VENDOR_FF = path.join(ROOT, 'vendor', 'ffmpeg');
const FF = path.join(VENDOR_FF, 'ffmpeg.exe');
video.setBundledFfmpegDir(VENDOR_FF);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-videotest-'));
const P = n => path.join(TMP, n);

let fail = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) fail++;
};
/** 造样本用的 ffmpeg 调用（同步，别把失败咽掉） */
const ff = args => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
const sizeOf = p => (fs.existsSync(p) ? fs.statSync(p).size : -1);

(async () => {
  console.log('TMP       = ' + TMP);
  console.log('ffmpeg    = ' + FF + '（' + (fs.existsSync(FF) ? (sizeOf(FF) / 1048576).toFixed(1) + ' MB' : '★ 不在') + '）');
  console.log('');

  // ---- 前置：内置那份必须真的在，且真能跑 ----
  if (!fs.existsSync(FF)) {
    ok('0) ★ 内置 ffmpeg 在仓库里（vendor/ffmpeg/ffmpeg.exe）', false, FF);
    console.log('\n==== FAIL（缺前置，后面的用例没法跑）====');
    process.exitCode = 1;
    return;
  }
  const st = video.status();
  ok('0) 状态判定为「用内置那份」且 usable', st.source === 'bundled' && st.usable === true, JSON.stringify(st));
  const ver = await video.version();
  ok('0) 内置 ffmpeg 真能跑起来并报出版本号', typeof ver === 'string' && /\d+\.\d+/.test(ver), String(ver));

  // ---- G 纯函数：三段解析全分支（不碰文件系统，喂输入即可） ----
  // ★ 假 exists 必须**同时认**「手填的」和「内置的」两个路径 —— 只认一个会造出假红
  const PRESENT = new Set(['D:/x/ffmpeg.exe', 'D:/b/ffmpeg.exe']);
  const E = p => PRESENT.has(p);
  const g1 = video.resolveFfmpegChoice({ configured: 'D:/x/ffmpeg.exe', bundled: 'D:/b/ffmpeg.exe', exists: E });
  ok('G1) 手填（存在）优先于内置', g1.source === 'configured' && g1.path === 'D:/x/ffmpeg.exe', JSON.stringify(g1));
  const g2 = video.resolveFfmpegChoice({ configured: 'D:/nope/ffmpeg.exe', bundled: 'D:/b/ffmpeg.exe', exists: E });
  ok('G2) 手填（不存在）回退到内置，且如实标 configuredMissing', g2.source === 'bundled' && g2.configuredMissing === true, JSON.stringify(g2));
  const g3 = video.resolveFfmpegChoice({ configured: '', bundled: 'D:/b/ffmpeg.exe', exists: E });
  ok('G3) 没手填 → 用内置', g3.source === 'bundled' && g3.configuredMissing === false, JSON.stringify(g3));
  const g4 = video.resolveFfmpegChoice({ configured: 'D:/nope/ffmpeg.exe', bundled: '', exists: E });
  ok('G4) 手填不存在且无内置 → configured-missing（usable=false，不许标成可自动处理）',
    g4.source === 'configured-missing' && g4.configuredMissing === true, JSON.stringify(g4));
  const g5 = video.resolveFfmpegChoice({ configured: '', bundled: '', exists: E });
  ok('G5) 什么都没有 → 走系统 PATH', g5.source === 'path' && g5.path === 'ffmpeg', JSON.stringify(g5));
  const g6 = video.resolveFfmpegChoice({ configured: 'ffmpeg', bundled: '', exists: E });
  ok('G6) 手填只写「ffmpeg」视为走 PATH，不算手填路径', g6.source === 'path' && g6.configuredMissing === false, JSON.stringify(g6));
  const g7 = video.resolveFfmpegChoice({ configured: 'FFMPEG.EXE', bundled: '', exists: E });
  ok('G7) 大小写不同也照样识别成「走 PATH」', g7.source === 'path', JSON.stringify(g7));

  // ---- 造基准样本 ----
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', P('src.mp4')]);
  ok('样本 ① 造出基准 mp4', sizeOf(P('src.mp4')) > 0, sizeOf(P('src.mp4')) + ' B');

  // ---- A 已经是 mp4：无损转封装 ----
  const rA = await video.toMp4(P('src.mp4'), P('A.mp4'), { log: () => {} });
  ok('A1) mp4 → mp4 走转封装（remux）', rA.ok === true && rA.mode === 'remux', JSON.stringify({ ok: rA.ok, mode: rA.mode, codec: rA.codec, dur: rA.duration }));
  const vA = await video.verifyMp4(P('A.mp4'));
  ok('A2) ★ 转完真去解析产物：是合法 mp4', vA.ok === true, JSON.stringify(vA));
  ok('A3) 产物确实落盘且非空', sizeOf(P('A.mp4')) > 0, sizeOf(P('A.mp4')) + ' B');

  // ---- B .mov（H.264/AAC）——iPhone 典型形态 ----
  ff(['-i', P('src.mp4'), '-c', 'copy', '-f', 'mov', P('src.mov')]);
  const headB = await video.readHead(P('src.mov'));
  ok('B1) 造出的 mov 的 ftyp 品牌确实是 qt（说明样本是对的）', String(headB.brand || '').trim() === 'qt', JSON.stringify(headB.brand));
  const vB0 = await video.verifyMp4(P('src.mov'));
  ok('B2) ★ 鉴别力自证：对**还没转**的 .mov 必须判不通过', vB0.ok === false, vB0.reason);
  const rB = await video.toMp4(P('src.mov'), P('B.mp4'), { log: () => {} });
  ok('B3) mov → mp4 转封装通过，且品牌不再是 qt', rB.ok === true && rB.mode === 'remux' && rB.brand !== 'qt', JSON.stringify({ mode: rB.mode, brand: rB.brand, codec: rB.codec }));
  ok('B4) 产物时长与源一致（约 2 秒）', Math.abs(rB.duration - 2) < 0.6, rB.duration + 's');
  const vB = await video.verifyMp4(P('B.mp4'));
  ok('B5) ★ 产物是合法 mp4 且视频轨是 h264', vB.ok === true && vB.codec === 'avc1', JSON.stringify(vB));

  // ---- C .mov（ProRes）⇒ 必须自动落转码 ----
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', '-f', 'mov', P('pro.mov')]);
  const vC0 = await video.verifyMp4(P('pro.mov'));
  ok('C1) ProRes 的 mov 校验不通过（ftyp=qt）', vC0.ok === false, vC0.reason);
  const rC = await video.toMp4(P('pro.mov'), P('C.mp4'), { log: () => {} });
  ok('C2) ★ ProRes mov → 自动落到「转码」而不是直接报错', rC.ok === true && rC.mode === 'transcode', JSON.stringify({ mode: rC.mode, codec: rC.codec }));
  const vC = await video.verifyMp4(P('C.mp4'));
  ok('C3) 转码产物是合法 mp4（avc1）', vC.ok === true && vC.codec === 'avc1', JSON.stringify(vC));

  // ---- D .m4v ----
  fs.copyFileSync(P('src.mp4'), P('src.m4v'));
  const rD = await video.toMp4(P('src.m4v'), P('D.mp4'), { log: () => {} });
  ok('D1) m4v → mp4 转封装通过', rD.ok === true && rD.mode === 'remux', JSON.stringify({ mode: rD.mode, codec: rD.codec }));

  // ---- E 坏文件：如实失败 + 不留半成品 ----
  fs.writeFileSync(P('bad.mov'), Buffer.from('this is definitely not a video file at all, just plain text'));
  let errE = '';
  try { await video.toMp4(P('bad.mov'), P('E.mp4'), { log: () => {} }); } catch (e) { errE = e.message; }
  ok('E1) ★ 坏文件必须抛错（不许假装成功）', !!errE, errE.slice(0, 160));
  ok('E2) ★ 失败后不留半成品 E.mp4', !fs.existsSync(P('E.mp4')), sizeOf(P('E.mp4')) + ' B');

  // ---- F 只有音频轨 ----
  ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-c:a', 'aac', '-f', 'mov', P('audioonly.mov')]);
  let errF = '';
  try { await video.toMp4(P('audioonly.mov'), P('F.mp4'), { log: () => {} }); } catch (e) { errF = e.message; }
  ok('F1) ★ 没有视频轨的文件也要如实失败（别产出「没画面却叫 mp4」的东西）', !!errF, errF.slice(0, 160));
  ok('F2) 失败后不留半成品 F.mp4', !fs.existsSync(P('F.mp4')));

  // ---- H 取消：立刻停手，不留半成品 ----
  let errH = '';
  try {
    await video.toMp4(P('src.mov'), P('H.mp4'), { cancelled: () => true, log: () => {} });
  } catch (e) { errH = e.message; }
  ok('H1) ★ 已取消时立刻抛错', /取消/.test(errH), errH.slice(0, 120));
  ok('H2) 取消后不留半成品 H.mp4', !fs.existsSync(P('H.mp4')));

  // ---- I 结构解析：readHead / stsdVideoCodecs 的鉴别力 ----
  const hMp4 = await video.readHead(P('src.mp4'));
  ok('I1) 能从 mp4 读出 moov 与视频轨编码', !!hMp4.moov && video.stsdVideoCodecs(hMp4.moov).includes('avc1'),
    JSON.stringify(video.stsdVideoCodecs(hMp4.moov)));
  const hPro = await video.readHead(P('pro.mov'));
  ok('I2) 能认出 ProRes 的编码（apch/apcn 等），不是只会认 h264',
    video.stsdVideoCodecs(hPro.moov).some(c => /^ap(c|4|5|n)/.test(c)),
    JSON.stringify(video.stsdVideoCodecs(hPro.moov)));
  const hBad = await video.readHead(P('bad.mov'));
  ok('I3) 坏文件读头得到空结果（不抛错、也不编造）', !hBad.moov, JSON.stringify(hBad && hBad.moov ? '有 moov' : '无 moov'));

  console.log('');
  console.log('==== ' + (fail ? ('FAIL ' + fail) : 'ALL PASS') + ' ====');
  console.log('TMP: ' + TMP);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('VIDEOTEST ERROR', e); process.exitCode = 2; });
