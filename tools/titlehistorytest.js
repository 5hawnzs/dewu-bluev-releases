'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-title-'));
const load = Module._load;
Module._load = function (name) { return name === 'electron' ? { app: { getPath: () => dir } } : load.apply(this, arguments); };
const h = require('../src/main/services/titlehistory');
let passed = 0;
function ok(label, value) { assert(value, label); console.log('PASS ' + label); passed++; }
try {
  const today = Date.parse('2026-10-13T05:00:00Z');
  ok('北京时间午夜边界', h.dayOf(Date.parse('2026-10-12T16:00:00Z')) === '2026-10-13');
  ok('首次标题登记', h.claim('通勤就穿白色Polo衫🌿', today).ok);
  ok('跨批次与品牌均不得重复，忽略标点空格大小写和emoji', !h.claim('通勤，就穿白色 polo 衫🧸', today).ok);
  ok('非相邻标题仍不可重复', h.claim('米白翻领搭配卡其裤', today).ok && !h.claim('通勤就穿白色Polo衫', today).ok);
  delete require.cache[require.resolve('../src/main/services/titlehistory')];
  const again = require('../src/main/services/titlehistory');
  ok('重启模块仍保留当天记录', !again.claim('通勤就穿白色Polo衫', today).ok);
  ok('第二天允许复用', h.claim('通勤就穿白色Polo衫', today + 86400000).ok);
  ok('保留有意义的数字', h.normalize('秋冬第1件') !== h.normalize('秋冬第2件'));
  fs.appendFileSync(h.file(today), '{坏记录}\n');
  let error = ''; try { h.claim('另一标题', today); } catch (e) { error = e.message; }
  ok('记录损坏不能静默绕过去重', /无法读取/.test(error));
  console.log(`PASS ${passed}`);
} finally { Module._load = load; fs.rmSync(dir, { recursive: true, force: true }); }
