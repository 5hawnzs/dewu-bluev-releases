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

  // ---- J 视频抽帧（frame.js）：真抽、真读产物 ----
  // ★ 立场与本套件一致：不许「文件存在 == 抽到了」。这里真去解产物，看它是不是一张能解的 JPEG、尺寸对不对。
  const frame = require(path.join(ROOT, 'src/main/services/frame.js'));
  const jpegjs = require(path.join(ROOT, 'node_modules', 'jpeg-js'));

  const rJ = await frame.framesOf(P('src.mp4'), { count: 1, maxSide: 240 });
  ok('J1) ★ 一个真 mp4 抽 1 帧 → 真拿到一张图', rJ.ok === true && rJ.images.length === 1,
    JSON.stringify({ ok: rJ.ok, n: rJ.images.length, t: rJ.times, e: rJ.errs }));
  let jDec = null;
  try { jDec = jpegjs.decode(Buffer.from(String(rJ.images[0].image_url.url).split(',')[1], 'base64')); } catch (e) { jDec = null; }
  ok('J2) ★ 抽出来那段 base64 真能解成一张 JPEG（不是空串/占位）',
    !!jDec && jDec.width > 0 && jDec.height > 0, jDec ? jDec.width + '×' + jDec.height : '解不开');
  ok('J3) 帧缩到 maxSide 内（240px）', !!jDec && Math.max(jDec.width, jDec.height) <= 240,
    jDec ? jDec.width + '×' + jDec.height : '—');
  ok('J4) 时长走 moov 读（mp4 不该为时长多起一次 ffmpeg）',
    Math.abs((rJ.duration || 0) - 2) < 0.6 && rJ.durationHow === 'moov', rJ.duration + 's · ' + rJ.durationHow);

  // mkv 不是 ISO-BMFF，moov 读不到 ⇒ 时长必须落到「用 ffmpeg 探一次」，而且照样抽得出帧
  ff(['-i', P('src.mp4'), '-c', 'copy', '-f', 'matroska', P('src.mkv')]);
  const rJ2 = await frame.framesOf(P('src.mkv'), { count: 2, maxSide: 240 });
  ok('J5) ★ mkv（moov 读不到）时时长落到 ffmpeg 探一次，而且照样抽得出帧',
    rJ2.ok === true && rJ2.durationHow === 'ffmpeg' && rJ2.images.length === 2,
    JSON.stringify({ ok: rJ2.ok, n: rJ2.images.length, how: rJ2.durationHow, d: rJ2.duration, e: rJ2.errs }));
  ok('J6) 2 帧是两个不同时间点（不是同一帧复制两份）', new Set(rJ2.times).size === 2, JSON.stringify(rJ2.times));

  // 空帧判据：**双向**都要钉 —— 只测「纯色被判空」＝只验负向，正片被误杀也照样绿
  const mkJpg = (fn, name) => {
    const N = 64, d = Buffer.alloc(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4, v = fn(x, y);
      d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = 255;
    }
    fs.writeFileSync(P(name), jpegjs.encode({ data: d, width: N, height: N }, 90).data);
  };
  mkJpg(() => [12, 12, 12], 'solid.jpg');
  mkJpg((x, y) => [x * 4, y * 4, 128], 'grad.jpg');
  ok('J7) 空帧判据：纯色图判成空帧（片头片尾的黑场/纯色标题卡就长这样）',
    (await frame.looksBlank(P('solid.jpg'))) === true);
  ok('J8) ★ 反向对照：有明暗层次的图**不许**被判成空帧（否则真在展示货的那一帧会被误杀）',
    (await frame.looksBlank(P('grad.jpg'))) === false);

  ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=1:r=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', P('black.mp4')]);
  const rJ3 = await frame.framesOf(P('black.mp4'), { count: 1, maxSide: 160 });
  ok('J9) ★ 整段黑场 ⇒ 一帧都不送，并说清是空帧',
    rJ3.ok === false && rJ3.images.length === 0 && /空帧/.test(rJ3.errs.join(' ')), JSON.stringify(rJ3.errs));

  // ffmpeg 不可用（手填路径不存在、又没内置）：如实说清原因、**不抛** —— 上游据此把那条标成
  // 「视频没抽出帧」照常往下跑，而不是把整批弄挂
  try {
    video.setFfmpegPath('D:/nope/ffmpeg.exe');
    video.setBundledFfmpegDir('');
    // ★ 这里必须 try/catch：坏版是**抛异常**的，不接住的话会冒到套件外层变成
    //   「VIDEOTEST ERROR」—— 一条 FAIL 都不打（上层只看 FAIL 行就等于没抓到），而且 J12 也不会跑。
    let rJ5 = null, j5err = '';
    try { rJ5 = await frame.framesOf(P('src.mp4'), { count: 1, maxSide: 160 }); }
    catch (e) { j5err = String((e && e.message) || e); }
    ok('J11) ★ ffmpeg 不可用时如实说清原因、**且不许抛异常**',
      !j5err && !!rJ5 && rJ5.ok === false && /ffmpeg 不可用/.test(rJ5.err),
      j5err ? ('抛异常了：' + j5err) : (rJ5 ? rJ5.err : '没返回'));
  } finally {
    video.setFfmpegPath('');
    video.setBundledFfmpegDir(VENDOR_FF);
  }
  ok('J12) 恢复后又能抽了（证明 J11 那次是「把 ffmpeg 摘掉」，不是永久改坏）',
    (await frame.framesOf(P('src.mp4'), { count: 1, maxSide: 160 })).ok === true);

  const junkBefore = fs.readdirSync(os.tmpdir()).filter(n => /^bluev-frame-/.test(n)).length;
  const rJ4 = await frame.framesOf(P('src.mp4'), { count: 2, maxSide: 160 });
  const junkAfter = fs.readdirSync(os.tmpdir()).filter(n => /^bluev-frame-/.test(n)).length;
  ok('J10) ★ 抽帧不留垃圾：临时目录用完即删（只比「有没有变多」，别把上一轮留下的算到这次头上）',
    junkAfter <= junkBefore, 'before=' + junkBefore + ' after=' + junkAfter + '（抽到 ' + rJ4.images.length + ' 帧）');

  // ==========================================================================
  // K) ★★★ 2026-10-04（用户报「第一篇素材是全黑 0 秒视频，哪来的」⇒ 本轮的**决定性对照实验**）
  //   **得物解不开 HEVC Main 10（10-bit）** —— 相册里那一格是**纯黑 + 一直转圈**，永远不出图。
  //   真机并排对照（同内容、同时长 00:14，同一台设备）：H.264 8-bit 出图 / 10-bit HEVC 全黑转圈。
  //   而 `.mp4` 里装着 10-bit HEVC 时，**扩展名判据会放行**（用户原话：「他在文件夹里的格式就是 mp4，
  //   怎么可能格式不对」—— 扩展名确实对，问题在**容器里那个编码**）。
  //   ⇒ 判据必须往容器里再看一层「**视频轨位深**」，光看扩展名 + 编码白名单（hvc1 就在白名单里）不够。
  //   这一组钉四件事：
  //     ① 纯函数 videoTrackInfo / decoderCompat 的分支 —— 特别是「hvc1 但 8-bit **必须放行**」
  //        这条**反向对照**（没有它，写成「见 hvc1 就杀」也照样绿）；
  //     ② 用内置 ffmpeg 真造 10-bit HEVC 与 8-bit HEVC，判据必须**分开**它们、且与 ffmpeg 原话一致；
  //     ③ toMp4 对 10-bit HEVC 必须**跳过无损转封装**直接落转码（转封装出来还是 10-bit，白干）；
  //     ④ 转码产物的位深必须是 **8-bit**（真解析产物，不看文件名、也不看日志说了什么）。
  // ==========================================================================
  {
    // ---- 手搓最小 moov：直接喂纯函数，把每个分支都点一遍（不碰文件系统） ----
    // ★ 布局要对齐真实的 box 结构，否则测的是"我编的格式"而不是真格式：
    //   · `stsdVideoCodecs` 在 moov 里找 'stsd'，读 **+16** 那 4 字节当编码 ⇒ 编码必须落在 stsd+16；
    //   · `boxContent` 找 'hvcC'/'avcC'，取**其后**的内容 ⇒ 配置内容紧跟在 4 字节类型名之后。
    const stsdOnly = (codec) => { const b = Buffer.alloc(20); b.write('stsd', 0, 'latin1'); b.write(codec, 16, 'latin1'); return b; };
    // HEVCDecoderConfigurationRecord：内容[1] = reserved(2)+tier(1)+profile_idc(5)；内容[17] = reserved(5)+bitDepthLumaMinus8(3)
    const hvcC = (profileIdc, bitDepthMinus8) => {
      const c = Buffer.alloc(22); c[0] = 1; c[1] = profileIdc & 0x1f; c[17] = bitDepthMinus8 & 0x07; c[18] = bitDepthMinus8 & 0x07;
      return Buffer.concat([Buffer.from('hvcC', 'latin1'), c]);
    };
    // AVCDecoderConfigurationRecord：内容[1] = AVCProfileIndication
    const avcC = (profileIdc) => { const c = Buffer.alloc(8); c[0] = 1; c[1] = profileIdc; return Buffer.concat([Buffer.from('avcC', 'latin1'), c]); };
    const infoOf = (moov) => video.videoTrackInfo(moov);
    const compatOf = (moov) => video.decoderCompat(video.videoTrackInfo(moov));

    const k1 = compatOf(Buffer.concat([stsdOnly('avc1'), avcC(100)]));
    ok('K1) H.264 High（8-bit）⇒ 得物吃（合格）', k1.ok === true, JSON.stringify(k1));
    const k2 = compatOf(Buffer.concat([stsdOnly('avc1'), avcC(110)]));
    ok('K2) H.264 High 10（10-bit）⇒ 得物不吃（判不合格）', k2.ok === false && /10-bit/.test(k2.why), JSON.stringify(k2));
    const k3 = compatOf(Buffer.concat([stsdOnly('hvc1'), hvcC(1, 0)]));
    ok('K3) ★★ 反向对照：HEVC **8-bit**（Main）⇒ **必须放行** —— 不是「见 hvc1 就杀」',
      k3.ok === true, JSON.stringify(k3));
    const k4 = compatOf(Buffer.concat([stsdOnly('hvc1'), hvcC(2, 2)]));
    ok('K4) ★★ HEVC Main 10（10-bit）⇒ 判不合格，且原因点名「得物解不开 10-bit」',
      k4.ok === false && /10-bit/.test(k4.why) && /黑格/.test(k4.why), JSON.stringify(k4));
    const k5 = compatOf(stsdOnly('hvc1'));
    ok('K5) 有 hvc1 但读不到 hvcC ⇒ 按编码白名单放行（不误杀；位深未知这件事如实写在 why 里）',
      k5.ok === true && /hvcC/.test(infoOf(stsdOnly('hvc1')).why), JSON.stringify({ ok: k5.ok, why: infoOf(stsdOnly('hvc1')).why }));
    const k6 = compatOf(stsdOnly('vp09'));
    ok('K6) 认不出的编码（vp09）⇒ fail-closed 判不合格', k6.ok === false, JSON.stringify(k6));
    const k7 = infoOf(Buffer.concat([stsdOnly('hvc1'), hvcC(2, 2)]));
    ok('K7) 位深是从 hvcC 真读出来的（10-bit / Main 10），不是猜的',
      k7.bitDepth === 10 && k7.bitDepthKnown === true && /Main 10/.test(k7.profileName), JSON.stringify(k7));
    ok('K8) codecLabel 说人话（`10-bit HEVC (Main 10)`），日志与合规报告都用它',
      video.codecLabel(k7) === '10-bit HEVC (Main 10)', video.codecLabel(k7));

    // ---- 真样本：内置 ffmpeg 现造 10-bit / 8-bit HEVC，判据必须分得开 ----
    ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', P('hevc10.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', P('hevc8.mp4')]);
    // ffmpeg 自己的原话（作为对照：我们判的必须与解码器说的**一致**，不是我们自说自话）
    const ffLine = (p) => {
      const r = require('child_process').spawnSync(FF, ['-hide_banner', '-i', p], { encoding: 'utf8' });
      return String((r.stderr || '')).split('\n').find(l => /Stream #0:0/.test(l)) || '';
    };
    const line10 = ffLine(P('hevc10.mp4')), line8 = ffLine(P('hevc8.mp4'));
    ok('K9) 前置：10-bit 样本的 ffmpeg 原话里确实是 `hevc (Main 10) … yuv420p10le`',
      /Main 10/.test(line10) && /yuv420p10le/.test(line10), line10.trim().slice(0, 110));
    ok('K9b) 前置：8-bit 样本的 ffmpeg 原话里确实是 `hevc (Main) … yuv420p`（不带 10）',
      /hevc \(Main\)/.test(line8) && !/10le/.test(line8), line8.trim().slice(0, 110));

    const p10 = await video.probeDecodable(P('hevc10.mp4'));
    const p8 = await video.probeDecodable(P('hevc8.mp4'));
    ok('K10) ★★★ probeDecodable：10-bit HEVC 判「得物解不开」（与 ffmpeg 原话一致）',
      p10.ok === false && p10.tenBit === true, JSON.stringify(p10));
    ok('K11) ★★★ probeDecodable：8-bit HEVC 判「得物吃」—— 反面对照，证明判据不是恒杀',
      p8.ok === true && p8.tenBit === false, JSON.stringify(p8));

    // ---- 转码路径：10-bit 必须落转码，产物必须变 8-bit ----
    const rK = await video.toMp4(P('hevc10.mp4'), P('hevc10_out.mp4'), { log: () => {} });
    ok('K12) ★★ toMp4 对 10-bit HEVC 必须**跳过无损转封装**、直接落转码（转封装出来还是 10-bit，白干）',
      rK.ok === true && rK.mode === 'transcode', JSON.stringify({ ok: rK.ok, mode: rK.mode, codec: rK.codec }));
    const pOut = await video.probeDecodable(P('hevc10_out.mp4'));
    ok('K13) ★★ 转码产物真解析出来是 **8-bit H.264**（位深必须真的降下来，不能只看文件名）',
      pOut.ok === true && pOut.bitDepth === 8 && /H\.264/.test(pOut.label), JSON.stringify(pOut));
    const lineOut = ffLine(P('hevc10_out.mp4'));
    ok('K13b) ★ 与 ffmpeg 原话对照：产物确实是 `h264 … yuv420p`',
      /h264/.test(lineOut) && /yuv420p\b/.test(lineOut), lineOut.trim().slice(0, 110));
  }

  // ==========================================================================
  // L) ★★ 2026-10-04（真机踩到，回头补的）：ffmpeg **起不来**时，错误必须是能看懂的话。
  //   现场：我用脚本直接调 toMp4、忘了先 `setBundledFfmpegDir`（app 启动时 index.js 会做）
  //   ⇒ execFile 报 ENOENT，而 **stderr 是空的**（ENOENT 只有 err.message）⇒
  //   界面显示「ffmpeg 转码失败：未知原因」，完全没法排查。
  //   这一组盯两件事：
  //     ① `explain()` 必须能认出「起不来」并指出去哪儿看；
  //     ② **端到端**：ffmpeg 路径真不存在时，抛的错就是那句话（不是「未知原因」）。
  // ==========================================================================
  {
    const e1 = video.explain('spawn ffmpeg ENOENT');
    ok('L1) ★ explain：ffmpeg 起不来（ENOENT）要翻成人话、并指出「设置 → 外部依赖」',
      /启动不了 ffmpeg/.test(e1) && /外部依赖/.test(e1), e1);
    const e2 = video.explain('ffmpeg: not recognized as an internal or external command');
    ok('L2) ★ explain：Windows 那句「不是内部或外部命令」也认得出',
      /启动不了 ffmpeg/.test(e2), e2);
    const e3 = video.explain('Invalid data found when processing input');
    ok('L3) 反向对照：真·文件损坏仍走原来那句（别把所有错都吞成「起不来」）',
      /不是能识别的视频文件/.test(e3), e3);

    // 端到端：把「手填」和「内置」两条路都掐断 ⇒ 只能走 PATH，而 PATH 里没有 ffmpeg
    const hadCfg = video.getFfmpegPath();
    const hadBundle = video.getBundledFfmpegDir();
    video.setFfmpegPath('');
    video.setBundledFfmpegDir('');
    let msg = '';
    try {
      await video.toMp4(P('h264.mp4'), P('never_out.mp4'), { log: () => {} });
    } catch (e) { msg = String(e && e.message || e); }
    video.setFfmpegPath(hadCfg);
    video.setBundledFfmpegDir(hadBundle);
    ok('L4) ★★ 端到端：ffmpeg 路径不存在时，抛的错必须说清「启动不了 ffmpeg」，**不许**是「未知原因」',
      /启动不了 ffmpeg/.test(msg) && !/未知原因/.test(msg), msg.slice(0, 170));
  }

  console.log('');
  console.log('==== ' + (fail ? ('FAIL ' + fail) : 'ALL PASS') + ' ====');
  console.log('TMP: ' + TMP);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('VIDEOTEST ERROR', e); process.exitCode = 2; });
