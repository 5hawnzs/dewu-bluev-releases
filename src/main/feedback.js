'use strict';
// 反馈复用任务记录的持久化和云端队列，不新增运行依赖。
const crypto = require('crypto');
const runlog = require('./services/runlog');
const cloudsync = require('./services/cloudsync');
const store = require('./store');
async function submit(text, user) {
  text = String(text || '').trim();
  if (!text || text.length > 1000) return { ok: false, error: '请填写 1–1000 字反馈内容' };
  const id = crypto.randomUUID();
  const entry = { eventId: id, jobId: id, kind: 'end', type: 'feedback.submit', label: '用户反馈', ok: true,
    feedback: text, batch: 'v1.1.1', brandId: store.get('activeBrandId') || '',
    userId: user?.id || '', username: user?.username || '', displayName: user?.displayName || '' };
  if (!runlog.append(entry)) return { ok: false, error: '反馈保存失败，请检查输出目录后重试' };
  let result;
  try { result = await cloudsync.syncOnce({ force: true }); }
  catch { result = { ok: false }; }
  const uploaded = result.ok && result.runUploaded > 0 && result.pendingRun === 0;
  return { ok: true, id, queued: !uploaded, message: uploaded ? '反馈已同步至发布进度看板' : '反馈已保存，等待联网后自动同步至看板' };
}
module.exports = { submit };
