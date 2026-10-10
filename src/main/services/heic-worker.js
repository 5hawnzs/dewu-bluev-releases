'use strict';
// HEVC 解码放在工作线程，避免大图阻塞登录与主界面。
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
(async () => {
  const stat = fs.statSync(workerData.file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('HEIC 文件超过 64 MB 或无法读取');
  // 优先从文件头拦下超大图，避免进入 WASM 后才分配完整像素缓冲。
  let sharp;
  try { sharp = require('sharp'); } catch (_) { /* 原生模块缺失时仍可用独立解码器 */ }
  if (sharp) {
    const metadata = await sharp(workerData.file, { limitInputPixels: 80 * 1024 * 1024 }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 80 * 1024 * 1024) {
      throw new Error('HEIC 图片尺寸无效或超过处理上限');
    }
  }
  const decode = require('heic-decode');
  const image = await decode({ buffer: fs.readFileSync(workerData.file) });
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 80 * 1024 * 1024 || image.data.byteLength !== width * height * 4) {
    throw new Error('HEIC 图片尺寸无效或超过处理上限');
  }
  const data = new Uint8Array(image.data);
  parentPort.postMessage({ width, height, data }, [data.buffer]);
})().catch(error => parentPort.postMessage({ error: 'HEIC 解码失败：' + error.message }));
