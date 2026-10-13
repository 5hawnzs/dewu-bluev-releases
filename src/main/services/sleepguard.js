'use strict';
// 临时请求系统保持运行；允许显示器熄屏，不修改用户电源计划。
function create(getBlocker = () => require('electron').powerSaveBlocker) {
  const active = new Set();
  function acquire() {
    const blocker = getBlocker();
    if (!blocker) throw new Error('系统防睡眠接口不可用');
    const id = blocker.start('prevent-app-suspension');
    const entry = { id, blocker };
    active.add(entry);
    const release = () => {
      if (!active.has(entry)) return;
      if (blocker.isStarted(id)) blocker.stop(id);
      if (blocker.isStarted(id)) throw new Error('系统防睡眠请求未解除');
      active.delete(entry);
    };
    entry.release = release;
    if (!blocker.isStarted(id)) {
      release();
      throw new Error('系统未接受防睡眠请求');
    }
    return release;
  }
  function releaseAll() {
    const errors = [];
    for (const entry of [...active]) {
      try { entry.release(); } catch (error) { errors.push(error.message); }
    }
    return errors;
  }
  return { acquire, releaseAll, count: () => active.size };
}
module.exports = { ...create(), create };
