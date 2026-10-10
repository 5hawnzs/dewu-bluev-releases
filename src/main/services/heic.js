'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const wp = require('../util/winpath');
function available() {
  try { require.resolve('heic-decode'); return true; } catch (_) { return false; }
}
function decode(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'heic-worker.js'), {
      workerData: { file: wp.toLong(file) }, resourceLimits: { maxOldGenerationSizeMb: 384 }
    });
    let settled = false;
    const finish = (error, image) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(image);
    };
    const timer = setTimeout(() => finish(new Error('HEIC 解码超时，请缩小图片后重试')), 30000);
    worker.once('message', result => {
      if (result.error) return finish(new Error(result.error));
      finish(null, { width: result.width, height: result.height, data: Buffer.from(result.data), channels: 4 });
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error('HEIC 解码线程提前结束（' + code + '）')); });
  });
}
module.exports = { available, decode };
