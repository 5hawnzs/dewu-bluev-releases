'use strict';
const assert = require('assert'), Module = require('module');
const original = Module._load;
let saved, writable = true, result = { ok: true, runUploaded: 1, pendingRun: 0 };
Module._load = function(name, parent) {
  if (/feedback\.js$/.test(parent?.filename || '')) {
    if (name === './services/runlog') return { append: e => { saved = e; return writable; } };
    if (name === './services/cloudsync') return { syncOnce: async () => result };
    if (name === './store') return { get: () => '' };
  }
  return original.apply(this, arguments);
};
const feedback = require('../src/main/feedback');
(async () => {
  assert.equal((await feedback.submit('', {})).ok, false);
  assert.equal((await feedback.submit('字'.repeat(1001), {})).ok, false);
  const sent = await feedback.submit('发布后状态有误', { id: 'u1', username: '测试' });
  assert.equal(sent.queued, false, JSON.stringify(sent)); assert.equal(saved.feedback, '发布后状态有误');
  assert.equal(saved.userId, 'u1'); assert.equal(saved.type, 'feedback.submit');
  result = { ok: false }; assert.equal((await feedback.submit('断网反馈', {})).queued, true);
  writable = false; assert.equal((await feedback.submit('磁盘不可写', {})).ok, false);
  console.log('PASS 反馈校验、账号归属、成功同步、断网保留和写入失败');
})().catch(e => { console.error(e); process.exitCode = 1; });
