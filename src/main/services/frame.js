'use strict';
/**
 * 视频抽帧 —— 让「只有视频」的素材也能按画面写文案
 *
 * ★ 为什么要有（2026-10-03 用户原话）：
 *   「目前导入视频无法根据视频中的产品生成对应的文案」。
 *   根因：copywriter.imagePartsOf() 只挑 `f.type === 'image'` 的素材 ⇒ 视频叶子**一张图都送不出去**，
 *   模型只拿到「货号 + 颜色」，标题又变成套话壳（用户一眼看出是没看图写的）。
 *
 * ★★ 费用（用户拍板：「抽帧送模型，但是在尽可能少消耗模型费用的前提下做」）：
 *   **默认只抽 1 帧**。三处一起省：
 *     ① 张数是个**常数**（1，可配到 3），跟视频多长无关 —— 真花钱的是「送出去几张图」；
 *     ② 定位用 `-ss` 放在 `-i` **前面**（fast seek，不用把前面的画面整段解一遍）；
 *     ③ 抽出来直接缩到 imageMaxSide（`scale=...`），**不落用户素材目录** ——
 *        写系统临时目录、用完即删（素材目录里不该多出一堆 _frame.jpg）。
 *
 * ★ 时长从哪来：先走 imaging.videoDurationSec()（纯 JS 读 moov/mvhd，**不启 ffmpeg**）；
 *   读不到（mkv/webm 这类非 ISO-BMFF 容器）才用 ffmpeg 的 `-i` 探一次。
 *   两条都拿不到就**如实记 null、绝不编一个时长**，退成「抢首帧」。
 *
 * ★ 取哪一帧：planTimes() 默认取**片子中间**。首帧经常是黑场/标题卡，中间那帧更可能真在展示那件货。
 *   抽出来若是一张**空帧**（黑场 / 纯色 —— 片头片尾最常见），就地退到 0.2s 再抢一次；
 *   两次都是空帧就**一张都不送** —— 送一张黑图过去只会让模型瞎编，还白花钱。
 *   这一整段是本地解码，不产生任何接口费用。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const imaging = require('./imaging');
const video = require('./video');

/** 出厂抽几帧：1（省费用）。上限 3 —— 再多下去「每张图都值钱」这件事就没人管了。 */
const DEFAULT_FRAMES = 1;
const MAX_FRAMES = 3;
/** 空帧兜底的时间点（秒）：片头那一下往往还是黑场，往前一点点更容易抢到封面帧 */
const RETRY_AT = 0.2;

function clampFrames(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_FRAMES;
  return Math.max(0, Math.min(MAX_FRAMES, Math.round(v)));
}

/**
 * ★ 纯函数：算出「抽哪几个时间点」（秒）。不碰文件系统、不启 ffmpeg，测试直接喂输入。
 *   count=1 → 片子中间（50%）；count=2 → 33%/67%；count=3 → 25%/50%/75%
 *   ★ 时长读不到（null）→ 全是 0（只能抢首帧，总比一张都不送强），**这里绝不编造时长**。
 */
function planTimes(durationSec, count) {
  const n = clampFrames(count);
  if (n <= 0) return [];
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return new Array(n).fill(0);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(+(d * i / (n + 1)).toFixed(2));
  return out;
}

/**
 * 这一帧是不是「空帧」—— 全黑 / 全白 / 一整块纯色（片头片尾的黑场、纯色标题卡）。
 * 判据：采样点亮度的**极差**小于 contrastMin。真在展示货的那一帧（有背景、有主体）
 * 极差一定远大于 12，所以不会把能用的帧误杀。
 * ★ 读不出来时返回 false —— 宁可送一张读不了的，也不要把可能的正片帧丢掉。
 */
async function looksBlank(jpegPath, contrastMin) {
  const th = Number.isFinite(Number(contrastMin)) ? Number(contrastMin) : 12;
  let img = null;
  try { img = await imaging.readImage(jpegPath); } catch (e) { return false; }
  if (!img || !img.width || !img.height) return false;
  const { width, height, data } = img;
  const ch = img.channels || 4;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  let mn = 255, mx = 0, n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * ch;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (l < mn) mn = l;
      if (l > mx) mx = l;
      n++;
    }
  }
  if (!n) return false;
  return (mx - mn) < th;
}

/** ffmpeg 的 `-i` 会把时长打进 stderr；moov 读不到（mkv/webm）时用这条路兜底。拿不到返回 null。 */
async function probeDuration(src, cancelled) {
  const r = await video.runFfmpeg(['-hide_banner', '-nostdin', '-i', src], { timeout: 20000, cancelled });
  const m = String(r.stderr || '').match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  if (!m) return null;
  return +(+m[1] * 3600 + +m[2] * 60 + +m[3]).toFixed(2);
}

/** 抽一帧到 dst。`-ss` 放在 `-i` 前面 = fast seek（不用把前面的画面整段解一遍）。 */
async function grabOne(src, dst, at, maxSide, timeoutMs, cancelled) {
  const side = Math.max(160, Math.min(1568, Math.round(Number(maxSide) || 768)));
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-ss', String(at),
    '-i', src,
    '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', 'scale=' + side + ':' + side + ':force_original_aspect_ratio=decrease',
    '-q:v', '5',
    '-f', 'image2', dst
  ];
  const r = await video.runFfmpeg(args, { timeout: timeoutMs, cancelled });
  if (!r.ok) {
    const why = r.killed ? '超时或被取消' : (video.explain(r.stderr) || '未知原因');
    return { ok: false, err: at + 's 那一帧没抽出来（' + why + '）' };
  }
  const st = await fs.promises.stat(dst).catch(() => null);
  if (!st || !st.size) return { ok: false, err: at + 's 那一帧没抽出来（ffmpeg 报成功但没写出文件）' };
  return { ok: true, bytes: st.size };
}

const rmQuiet = async p => { await fs.promises.unlink(p).catch(() => {}); };

/**
 * 从一个视频里抽 `count` 帧，返回能直接塞进 messages 的 image_url 片段。
 * 返回 { ok, images, times, plan, duration, durationHow, errs, err }
 *   ★ ok=false 只表示「这次没能给出任何一帧」，**不是异常** —— 调用方（copywriter）据此
 *     如实把那条标成「视频没抽出帧」，**批次照常往下跑**（抽帧失败不该把整批弄挂）。
 *   ★ 想要这个视频的时长时用 `duration`（+`durationHow` 说清是 moov 读的还是 ffmpeg 探的），
 *     读不到就是 null，不许被当成 0。
 */
async function framesOf(src, opts = {}) {
  const count = clampFrames(opts.count === undefined ? DEFAULT_FRAMES : opts.count);
  const maxSide = opts.maxSide || 768;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000;
  const cancelled = typeof opts.cancelled === 'function' ? opts.cancelled : null;
  const errs = [];
  const empty = why => ({ ok: false, images: [], times: [], plan: [], duration: null, durationHow: '', errs: [why], err: why });

  if (count <= 0) return empty('抽帧张数设成了 0（这一步不做）');
  const st = video.status();
  if (st.source === 'configured-missing') {
    return empty('ffmpeg 不可用：你填的路径不存在（' + st.path + '），也没有可用的内置 ffmpeg');
  }
  if (cancelled && cancelled()) return empty('已取消');

  let duration = await imaging.videoDurationSec(src);
  let durationHow = duration == null ? '' : 'moov';
  if (duration == null) {
    duration = await probeDuration(src, cancelled);
    durationHow = duration == null ? '' : 'ffmpeg';
  }
  const plan = planTimes(duration, count);

  let dir = '';
  const images = [], times = [];
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bluev-frame-'));
    for (let i = 0; i < plan.length; i++) {
      if (cancelled && cancelled()) break;
      // 候选时间点：先按计划那个；抽到空帧（黑场/纯色）再往前抢一点点
      const cand = [plan[i]];
      if (plan[i] > 0.5) cand.push(RETRY_AT);
      for (const at of cand) {
        const dst = path.join(dir, 'f' + i + '.jpg');
        const g = await grabOne(src, dst, at, maxSide, timeoutMs, cancelled);
        if (!g.ok) { errs.push(g.err); continue; }
        if (await looksBlank(dst)) {
          await rmQuiet(dst);
          errs.push(at + 's 那一帧是空帧（黑场/纯色），没送');
          continue;
        }
        let b64 = '';
        try { b64 = (await fs.promises.readFile(dst)).toString('base64'); }
        catch (e) { errs.push('读不到抽出来的帧：' + ((e && e.message) || e)); continue; }
        images.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
        times.push(at);
        break;
      }
    }
  } catch (e) {
    errs.push(String((e && e.message) || e));
  } finally {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: images.length > 0, images, times, plan, duration, durationHow, errs,
    err: images.length ? '' : (errs[0] || '没抽出任何一帧')
  };
}

module.exports = {
  DEFAULT_FRAMES, MAX_FRAMES, RETRY_AT, clampFrames, planTimes, looksBlank, probeDuration, framesOf
};
