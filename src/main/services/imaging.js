'use strict';
/**
 * 图片 / 视频引擎
 * 优先用 sharp（原生，支持 HEIC、多核、libvips）；
 * Windows 上原生模块 ABI 不匹配时自动降级到纯 JS 引擎（jpeg-js + pngjs），
 * 保证「装完就能打开」，降级状态会在「设置」页显示。
 */
const fs = require('fs');
const path = require('path');
const wp = require('../util/winpath');
const colors = require('../util/colors');

let engine = 'unknown';
let sharp = null;

function init() {
  try {
    sharp = require('sharp');
    sharp.concurrency(2);              // PRD：按内存限流，避免 4000×4000 RGBA 开满把内存打爆
    // files:0 —— 关掉 libvips 的「输入文件缓存」。
    // 默认 files:20 会让 libvips 在处理完一张图后仍持有源文件句柄，
    // Windows 上紧接着 unlink 源文件必报 EPERM（合规「等比缩放 / 压缩 / 转 JPG」都是
    // 「先写临时文件 → 删原文件 → 改名」三步，会稳定踩到）。实测三组对照：
    //   默认(files:20) → unlink 失败；files:0 → 成功；cache(false) → 成功。
    // 内存缓存照留，性能不受影响（操作缓存 items 也保留）。
    sharp.cache({ memory: 64, files: 0 });
    engine = 'sharp';
  } catch (e) {
    sharp = null;
    engine = 'js';
  }
  return engine;
}
init();

function engineName() { return engine; }
function hasHeif() { return engine === 'sharp'; }

async function readImage(src) {
  if (sharp) {
    const { data, info } = await sharp(src, { failOn: 'none' }).rotate().ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data, channels: info.channels === 4 ? 4 : info.channels };
  }
  const buf = await fs.promises.readFile(wp.toLong(src));
  const e = wp.ext(src);
  if (e === '.png') {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data, channels: 4 };
  }
  if (e === '.jpg' || e === '.jpeg') {
    const jpeg = require('jpeg-js');
    const out = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
    return { width: out.width, height: out.height, data: out.data, channels: 4 };
  }
  throw new Error('当前图片引擎无法解码 ' + e + '（HEIC 需要 sharp / libheif）');
}

async function writeJpeg(rgba, width, height, dst, quality) {
  if (sharp) {
    await sharp(rgba, { raw: { width, height, channels: 4 } })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toFile(wp.toLong(dst));
    return;
  }
  const jpeg = require('jpeg-js');
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = Math.round(rgba[i] * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
  }
  const out = jpeg.encode({ data: rgb, width, height }, Math.round(quality));
  await fs.promises.writeFile(wp.toLong(dst), out.data);
}

/** 统一转 JPG（PNG 透明通道白底填充） */
async function convertToJpg(src, dst, { quality = 88 } = {}) {
  await wp.mkdirp(path.dirname(dst));
  if (sharp) {
    await sharp(src, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true }).toFile(wp.toLong(dst));
    return (await fs.promises.stat(wp.toLong(dst))).size;
  }
  const img = await readImage(src);
  await writeJpeg(img.data, img.width, img.height, dst, quality);
  return (await fs.promises.stat(wp.toLong(dst))).size;
}

/** 压到目标体积以内：质量二分，避免反复重编码（PRD: 一次到位） */
async function compressUnder(src, dst, maxBytes) {
  await wp.mkdirp(path.dirname(dst));
  let lo = 35, hi = 90, best = null;
  for (let i = 0; i < 5; i++) {
    const q = Math.round((lo + hi) / 2);
    const size = await convertToJpg(src, dst, { quality: q });
    if (size <= maxBytes) { best = { quality: q, size }; lo = q; if (hi - lo <= 4) break; }
    else { hi = q; if (!best) { /* 继续压 */ } }
    if (hi - lo <= 3) break;
  }
  if (!best) {
    // 二分失败说明画质需降得更狠，直接线性兜底
    for (const q of [60, 50, 42, 34, 28]) {
      const size = await convertToJpg(src, dst, { quality: q });
      if (size <= maxBytes) { best = { quality: q, size }; break; }
      best = { quality: q, size };
    }
  }
  return best;
}

/** 取图片主色：跳过近黑/近白背景像素，量化后取最大簇 */
async function dominantColor(src) {
  const img = await readImage(src);
  const { width, height, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  const buckets = new Map();
  let n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 200) continue;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 24) continue;                 // 近黑
      if (mn > 238 && mx > 245) continue;    // 近白白底
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key) || { r: 0, g: 0, b: 0, c: 0 };
      cur.r += r; cur.g += g; cur.b += b; cur.c++;
      buckets.set(key, cur); n++;
    }
  }
  if (!n) {
    // 全是近黑/近白（白底白鞋这类）：退回整体均值，避免拿不到主色
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 200) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
      }
    }
    if (!c) return null;
    const rgb = [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
    return { rgb, hex: colors.hex(rgb), name: colors.nearest(rgb).name, coarse: colors.coarse(rgb), fallback: true };
  }
  let top = null;
  for (const v of buckets.values()) if (!top || v.c > top.c) top = v;
  const rgb = [Math.round(top.r / top.c), Math.round(top.g / top.c), Math.round(top.b / top.c)];
  return { rgb, hex: colors.hex(rgb), name: colors.nearest(rgb).name, coarse: colors.coarse(rgb) };
}

/** 只读尺寸（不解码整图）：sharp 走 metadata，降级时解析 PNG/JPEG 头 */
async function sizeOf(src) {
  if (sharp) {
    try {
      const m = await sharp(src, { failOn: 'none' }).metadata();
      if (m.width && m.height) return { width: m.width, height: m.height };
    } catch (e) { /* 落到头部解析 */ }
  }
  try {
    const fd = await fs.promises.open(wp.toLong(src), 'r');
    const buf = Buffer.alloc(64);
    await fd.read(buf, 0, 64, 0);
    await fd.close();
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** 等比缩放到边长上限内（真机的「自动等比缩放」） */
async function fitWithin(src, dst, maxSide, quality = 90) {
  const dim = await sizeOf(src);
  if (!dim) throw new Error('读不到图片尺寸');
  const scale = Math.min(1, maxSide / Math.max(dim.width, dim.height));
  if (sharp) {
    await sharp(src, { failOn: 'none' }).rotate()
      .resize({ width: Math.round(dim.width * scale), height: Math.round(dim.height * scale), fit: 'inside' })
      .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toFile(wp.toLong(dst));
    return { width: Math.round(dim.width * scale), height: Math.round(dim.height * scale) };
  }
  const img = await readImage(src);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
    }
  }
  await writeJpeg(out, w, h, dst, quality);
  return { width: w, height: h };
}

/**
 * 读图 → 等比缩小 → JPEG base64（**不落盘**）。
 *
 * 用途：把素材图送给支持看图的模型（文案生成）。不落盘是有意的 ——
 * 这是临时数据，不该在用户的素材目录里多出一堆 `_ai_tmp.jpg`。
 * 缩到 maxSide 内是因为一张 4000px 的原图编码后能到几 MB，
 * 一张图就能把整批请求撑爆（而且模型也不需要那么大）。
 */
async function shrinkBase64(src, maxSide = 768, quality = 82) {
  if (sharp) {
    const buf = await sharp(src, { failOn: 'none' }).rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return buf.toString('base64');
  }
  // 纯 JS 引擎：解码 → 最近邻缩放 → 编码（和 fitWithin 同一套算法，只是出到内存）
  const jpeg = require('jpeg-js');
  const img = await readImage(src);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 3;
      rgb[di] = img.data[si]; rgb[di + 1] = img.data[si + 1]; rgb[di + 2] = img.data[si + 2];
    }
  }
  return jpeg.encode({ data: rgb, width: w, height: h }, quality).data.toString('base64');
}

/** 纯 JS 读 MP4/MOV 时长（moov → mvhd），拿不到返回 null，交给人工定夺 */async function videoDurationSec(src) {
  let fd = null;
  try {
    fd = await fs.promises.open(wp.toLong(src), 'r');
    const size = (await fd.stat()).size;
    let pos = 0;
    const head = Buffer.alloc(16);
    while (pos < size - 8) {
      const { bytesRead } = await fd.read(head, 0, 8, pos);
      if (bytesRead < 8) break;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        await fd.read(head, 0, 8, pos + 8);
        boxSize = Number(head.readBigUInt64BE(0));
        headerLen = 16;
      }
      if (boxSize < 8) break;
      if (type === 'moov') {
        const len = Math.min(boxSize - headerLen, 8 * 1024 * 1024);
        const moov = Buffer.alloc(len);
        await fd.read(moov, 0, len, pos + headerLen);
        return findMvhd(moov);
      }
      pos += boxSize;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

function findMvhd(buf) {
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf.toString('latin1', i, i + 4) !== 'mvhd') continue;
    const p = i + 4;
    try {
      const version = buf[p];
      if (version === 0) {
        const ts = buf.readUInt32BE(p + 12), dur = buf.readUInt32BE(p + 16);
        return ts ? +(dur / ts).toFixed(1) : null;
      }
      const ts = buf.readUInt32BE(p + 20), dur = Number(buf.readBigUInt64BE(p + 24));
      return ts ? +(dur / ts).toFixed(1) : null;
    } catch (e) { return null; }
  }
  return null;
}

module.exports = {
  engineName, hasHeif, init,
  convertToJpg, compressUnder, fitWithin, dominantColor, videoDurationSec, readImage, sizeOf,
  shrinkBase64,
  // 给 video.js 复用（校验转出来的 mp4 能不能读到时长）—— 同一套解析，别复制第二份
  findMvhd
};
