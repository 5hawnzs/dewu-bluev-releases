'use strict';
// 同一台电脑按北京时间记住当天生成过的标题，跨品牌、跨批次和重启生效。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
function dayOf(time = Date.now()) { return new Date(Number(time) + 8 * 3600000).toISOString().slice(0, 10); }
function normalize(title) {
  return String(title || '').normalize('NFKC').toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}\p{P}\p{Z}\s]/gu, '');
}
function file(time) { return path.join(app.getPath('userData'), 'title-history', dayOf(time) + '.jsonl'); }
function read(time) {
  try { return fs.readFileSync(file(time), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw new Error('当天标题记录无法读取，未跳过去重检查：' + e.message); }
}
function claim(title, time = Date.now()) {
  const key = normalize(title);
  if (!key) return { ok: false, reason: '标题没有可识别文字，请重新生成' };
  if (read(time).some(row => row.key === key)) return { ok: false, reason: '标题与本机今天已生成的标题重复，仅换 emoji、空格或标点也算重复' };
  // 同步读写让同进程并发批次无法同时占用同一个标题；写入失败不输出已生成。
  try {
    fs.mkdirSync(path.dirname(file(time)), { recursive: true });
    fs.appendFileSync(file(time), JSON.stringify({ key, title: String(title), ts: time }) + '\n');
  } catch (e) { throw new Error('当天标题记录无法保存，未将本条标为已生成：' + e.message); }
  return { ok: true };
}
module.exports = { dayOf, normalize, claim, read, file };
