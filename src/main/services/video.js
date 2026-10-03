'use strict';
/**
 * 视频 → MP4（得物只收 .mp4）
 *
 * 背景：达人给的素材经常不是 mp4 —— iPhone 直出是 `.mov`、iTunes 的是 `.m4v`、
 * 录屏软件可能给 `.avi` / `.webm` / `.mkv`。以前合规检查只能把它们标成
 * 「需手动转 MP4」丢给运营，发布链路上最烦的一块手工活。
 *
 * 这里把它们**真的转成 mp4**，而不是把扩展名一改了事：
 *   ① 先「无损转封装」(`-c copy`)：只换容器、不重编码 ⇒ 秒级完成，画质与体积都不变。
 *      能覆盖绝大多数真机情况（iPhone 的 H.264 / HEVC + AAC）。
 *   ② 产物**复用校验**一遍（ftyp 品牌 + moov/mvhd + 视频轨编码）：
 *      过不了说明容器里装的是 mp4 放不了的编码（ProRes、VP9、AV1…）⇒
 *   ③ 再「转码」(`libx264` + `aac`) 重编一遍，然后**再校验一次**。
 *
 * ★ 两条底线：
 *   - **绝不改个扩展名就当转好了**：校验不过就如实抛错，让上游标「需人工」。
 *   - **校验判据是白名单**：品牌必须在 mp4 系列、视频轨编码必须是 mp4 能装的，
 *     认不出的（例如 QuickTime 的 `qt`）一律算不合格 —— fail-closed，不做乐观假设。
 *
 * 与 adb 一致的三段解析：**用户手填（且文件真实存在）> 程序内置 > 系统 PATH**。
 * 解析写成纯函数（`exists` 可注入），测试不用碰文件系统就能跑全分支。
 *
 * ★ 2026-10-03：本模块同时是**全程序唯一的 ffmpeg 通道**（`runFfmpeg` 已导出）——
 *   视频抽帧（services/frame.js）也走这里。三段解析只能有一个入口：在别处再起一个
 *   execFile 就等于又写了一份「手填 > 内置 > PATH」，两份迟早不一致
 *   （用户手填的路径失效，抽帧却还傻傻去调系统 PATH，然后报一堆看不懂的错）。
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const wp = require('../util/winpath');
const imaging = require('./imaging');

const IS_WIN = process.platform === 'win32';
const FFMPEG_EXE = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

let ffmpegBin = '';   // 用户手填（'' = 没填）
let bundledDir = '';  // 内置 ffmpeg 所在目录（打包后 resources/ffmpeg；开发时仓库 vendor/ffmpeg）

function setFfmpegPath(p) { ffmpegBin = String(p == null ? '' : p).trim(); return ffmpegBin; }
function getFfmpegPath() { return ffmpegBin; }
function setBundledFfmpegDir(d) { bundledDir = String(d == null ? '' : d).trim(); return bundledDir; }
function getBundledFfmpegDir() { return bundledDir; }
function bundledFfmpegPath() { return bundledDir ? path.join(bundledDir, FFMPEG_EXE) : ''; }

/**
 * ★ 纯函数（不碰文件系统），专门为了能被测试直接喂输入：
 *   `resolveFfmpegChoice({ configured, bundled, exists })` → { path, source, configuredMissing, bundled }
 * source：`configured`（用你填的）/ `bundled`（用内置的）/ `path`（走系统 PATH）/
 *         `configured-missing`（你填的那个不存在，也**没有**可用的备选）
 */
function resolveFfmpegChoice({ configured = '', bundled = '', exists = () => false } = {}) {
  const cfg = String(configured || '').trim();
  const isBare = cfg === '' || /^ffmpeg(\.exe)?$/i.test(cfg);   // 只写「ffmpeg」= 走 PATH，不算手填路径
  const cfgIsPath = !!cfg && !isBare;
  const cfgMissing = cfgIsPath && !exists(cfg);
  if (cfgIsPath && !cfgMissing) return { path: cfg, source: 'configured', configuredMissing: false, bundled: '' };
  if (bundled && exists(bundled)) return { path: bundled, source: 'bundled', configuredMissing: cfgMissing, bundled };
  return { path: cfg || 'ffmpeg', source: cfgIsPath ? 'configured-missing' : 'path', configuredMissing: cfgMissing, bundled: '' };
}

function active() {
  return resolveFfmpegChoice({ configured: ffmpegBin, bundled: bundledFfmpegPath(), exists: fs.existsSync });
}

/**
 * 现在到底能不能转码 —— 合规检查据此决定「自动转」还是「标人工」。
 *   - 内置/手填且文件真在           ⇒ usable: true
 *   - 手填的路径不存在、又没内置     ⇒ usable: false（**确定**不行，别标成可自动处理）
 *   - 走系统 PATH                   ⇒ usable: true（**不确定**；真调用失败会在 fix() 里如实报出来，
 *                                      绝不假装成功 —— 所以这里给的是「可以试」而不是「一定行」）
 */
function status() {
  const a = active();
  return Object.assign({}, a, { usable: a.source !== 'configured-missing', exe: FFMPEG_EXE });
}

/** 内置那份的版本号（设置页照实显示）；拿不到就返回 null，不编。 */
async function version() {
  const r = await runFfmpeg(['-hide_banner', '-version'], { timeout: 20000 });
  if (!r.ok) return null;
  const m = String(r.stdout || '').match(/ffmpeg version (\S+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- mp4 结构校验

/** ffmpeg 的 mp4 复用器写出来的品牌就是这些；`qt`（QuickTime）**故意不在**里面 */
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42',
  'avc1', 'hvc1', 'hev1', 'mmp4', 'dash', 'msdh', 'msix', 'cmfc', 'cmfs'
]);
/** mp4 容器里允许出现的视频轨编码（白名单）。认不出的一律算不合格 */
const MP4_VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'hvc2', 'mp4v']);

/**
 * 从文件头顺着 box 链走，拿到 `ftyp` 品牌与 `moov` 内容。
 * 与 imaging.videoDurationSec 同一套走法（mdat 只按长度跳过，不读内容，所以很快），
 * 区别是这里还要把 ftyp 一起读出来。moov 上限 8MB（同 imaging）。
 */
async function readHead(src) {
  let fd = null;
  try {
    fd = await fs.promises.open(wp.toLong(src), 'r');
    const size = (await fd.stat()).size;
    let pos = 0, brand = '', compatible = [];
    const head = Buffer.alloc(16);
    while (pos < size - 8) {
      const { bytesRead } = await fd.read(head, 0, 8, pos);
      if (bytesRead < 8) break;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {                       // 64 位长度
        await fd.read(head, 0, 8, pos + 8);
        boxSize = Number(head.readBigUInt64BE(0));
        headerLen = 16;
      }
      if (boxSize < 8) break;
      if (type === 'ftyp') {
        const len = Math.min(boxSize - headerLen, 4096);
        const b = Buffer.alloc(len);
        await fd.read(b, 0, len, pos + headerLen);
        brand = b.toString('latin1', 0, 4);
        for (let i = 8; i + 4 <= len; i += 4) compatible.push(b.toString('latin1', i, i + 4));
      } else if (type === 'moov') {
        const len = Math.min(boxSize - headerLen, 8 * 1024 * 1024);
        const moov = Buffer.alloc(len);
        await fd.read(moov, 0, len, pos + headerLen);
        return { brand, compatible, moov, size };
      }
      pos += boxSize;
    }
    return { brand, compatible, moov: null, size };
  } catch (e) {
    return { brand: '', compatible: [], moov: null, size: 0, err: String(e && e.message || e) };
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * moov 里所有 `stsd` 的**首个 sample entry** 编码。
 * 一个 stsd box 的布局是 [size4][type4='stsd'][version+flags4][entry_count4][entry: size4][entry: type4]
 * ⇒ 「type」那 4 个字节的相对位置是 +16。音轨会给 `mp4a`，反正不在视频白名单里，不干扰判断。
 */
function stsdVideoCodecs(moov) {
  const out = [];
  if (!moov) return out;
  for (let i = 0; i + 20 <= moov.length; i++) {
    if (moov.toString('latin1', i, i + 4) !== 'stsd') continue;
    const code = moov.toString('latin1', i + 16, i + 20);
    if (/^[\x20-\x7e]{4}$/.test(code)) out.push(code);
  }
  return out;
}

/** 产物是不是一个**得物能吃的** mp4。★ 判据是白名单，认不出=不合格 */
async function verifyMp4(p) {
  const st = await wp.statSafe(p);
  if (!st || !st.size) return { ok: false, reason: '产物不存在或为空' };
  const h = await readHead(p);
  if (!h.moov) return { ok: false, reason: `读不到 moov（不是有效的 mp4/ISO-BMFF）${h.err ? '：' + h.err : ''}` };
  const brand = String(h.brand || '').trim();
  if (!brand) return { ok: false, reason: '读不到 ftyp 品牌' };
  if (brand === 'qt') return { ok: false, reason: 'ftyp 还是 QuickTime（qt），没真正换成 mp4 容器' };
  if (!MP4_BRANDS.has(brand)) return { ok: false, reason: `ftyp 品牌「${brand}」不是 mp4 系列` };
  const duration = imaging.findMvhd(h.moov);
  if (duration == null) return { ok: false, reason: 'moov/mvhd 读不到时长' };
  const codes = stsdVideoCodecs(h.moov);
  const codec = codes.find(c => MP4_VIDEO_CODECS.has(c));
  if (!codec) {
    return { ok: false, reason: `视频轨编码「${codes.join('/') || '认不出'}」不能放进 mp4（得转码）` };
  }
  return { ok: true, brand, compatible: h.compatible, codec, duration, bytes: st.size };
}

// ---------------------------------------------------------------- 调 ffmpeg

/** stderr 只取最后几行，避免整坨塞进界面 */
function errTail(s, n = 400) {
  const lines = String(s || '').replace(/\s+$/, '').split(/\r?\n/).filter(Boolean);
  return lines.slice(-3).join(' | ').slice(0, n);
}

/**
 * 把 ffmpeg 的 stderr 翻成人话，但**不丢掉原文**（原文才是排查依据）。
 * 这两类是最常撞上的：文件根本不是视频 / 里面没有视频轨。
 */
function explain(s) {
  const raw = errTail(s, 200);
  const t = String(s || '');
  if (/matches no streams|Failed to set value '0:v:0'/i.test(t)) {
    return `这个文件里没有可用的视频轨（ffmpeg: ${raw}）`;
  }
  if (/Invalid data found when processing input/i.test(t)) {
    return `不是能识别的视频文件：文件损坏或格式不受支持（ffmpeg: ${raw}）`;
  }
  return raw || '未知原因';
}

/**
 * 跑一次 ffmpeg。`cancelled` 每 500ms 查一次，为真就 kill 掉子进程（规范是超时 0 = 无限等）。
 */
function runFfmpeg(args, { timeout = 0, cancelled = null } = {}) {
  return new Promise(resolve => {
    const exe = active().path;
    let timer = null, done = false;
    const finish = r => { if (done) return; done = true; if (timer) clearInterval(timer); resolve(r); };
    let cp;
    try {
      cp = execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => finish({
          ok: !err, killed: !!(err && err.killed), code: err ? (err.code || null) : 0,
          signal: (err && err.signal) || null,
          stdout: String(stdout || ''), stderr: String(stderr || '')
        }));
    } catch (e) {
      return finish({ ok: false, code: null, stderr: String((e && e.message) || e), stdout: '' });
    }
    if (typeof cancelled === 'function') {
      timer = setInterval(() => { if (cancelled()) { try { cp.kill(); } catch (e) { /* 已经退出了 */ } } }, 500);
      if (timer.unref) timer.unref();
    }
  });
}

const rmQuiet = async p => { await fs.promises.unlink(wp.toLong(p)).catch(() => {}); };

/**
 * 把 `src` 转成 `dst`（.mp4）。成功返回 { mode: 'remux'|'transcode', codec, duration, bytes }。
 * 任何一步失败都**删掉半成品再抛错**，绝不把半截文件留在目录里让下游误以为转好了。
 */
async function toMp4(src, dst, opts = {}) {
  const log = opts.log || (() => {});
  const cancelled = typeof opts.cancelled === 'function' ? opts.cancelled : null;
  const st = status();
  if (st.source === 'configured-missing') {
    throw new Error(`你填的 ffmpeg 路径不存在：${st.path}（把它清空就能回退到程序内置的那份）`);
  }
  // ★ 进门前先看有没有被取消 —— 与 compliance 的「每轮开头检查」同一口径。
  //   少了这一句，用户刚点完「取消」，这一条照样会启动一次转换、照样落一个 mp4 出来。
  if (cancelled && cancelled()) throw new Error('已取消');
  try {
    await wp.mkdirp(path.dirname(dst));

    // ffmpeg 不认 Windows 的 \\?\ 长路径前缀，所以这里传普通绝对路径（不要 toLong）
    const common = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];

    // ① 无损转封装
    const r1 = await runFfmpeg(common.concat(['-c', 'copy', '-f', 'mp4', dst]),
      { timeout: opts.remuxTimeoutMs || 180000, cancelled });
    if (r1.ok) {
      const v1 = await verifyMp4(dst);
      if (v1.ok) {
        log(`转封装（无损、只换容器）：${v1.codec} · ${v1.duration}s · ${wp.humanSize(v1.bytes)}`);
        return { ok: true, mode: 'remux', codec: v1.codec, brand: v1.brand, duration: v1.duration, bytes: v1.bytes };
      }
      log(`转封装出来的 mp4 不合格（${v1.reason}）⇒ 改用转码`, 'warn');
    } else {
      log(`转封装失败（${r1.killed ? '超时或被取消' : explain(r1.stderr)}）⇒ 改用转码`, 'warn');
    }

    if (cancelled && cancelled()) throw new Error('已取消');

    // ② 转码兜底：ProRes / VP9 / AV1 这类容器里放不了的编码走这里
    const r2 = await runFfmpeg(common.concat([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', dst
    ]), { timeout: opts.transcodeTimeoutMs || 1800000, cancelled });
    if (!r2.ok) {
      throw new Error(`ffmpeg 转码失败：${r2.killed ? '超时或被取消' : explain(r2.stderr)}`);
    }
    const v2 = await verifyMp4(dst);
    if (!v2.ok) throw new Error(`转码产物校验没过：${v2.reason}`);
    if (cancelled && cancelled()) throw new Error('已取消');
    log(`转码（H.264/AAC）：${v2.duration}s · ${wp.humanSize(v2.bytes)}`);
    return { ok: true, mode: 'transcode', codec: v2.codec, brand: v2.brand, duration: v2.duration, bytes: v2.bytes };
  } catch (e) {
    await rmQuiet(dst);          // ★ 半成品一律清掉
    throw e;
  }
}

module.exports = {
  setFfmpegPath, getFfmpegPath, setBundledFfmpegDir, getBundledFfmpegDir, bundledFfmpegPath,
  resolveFfmpegChoice, status, version, toMp4, verifyMp4, readHead, stsdVideoCodecs,
  MP4_BRANDS, MP4_VIDEO_CODECS,
  // ★ 给 frame.js（视频抽帧）复用：**同一条 ffmpeg 通道、同一套三段解析**，别在别处另起 execFile。
  //   explain 一并导出 —— 抽帧失败时要把 ffmpeg 的原文翻成人话，措辞口径与转码那边保持一致。
  runFfmpeg, explain
};
