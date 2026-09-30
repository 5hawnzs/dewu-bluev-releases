'use strict';
/** 运行日志总线：环形缓存 + 实时推送到渲染层 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
const history = [];
const MAX = 500;
let win = null;

function attach(w) { win = w; }

function push(level, msg, meta) {
  const entry = { t: Date.now(), level, msg, meta: meta || null };
  history.push(entry);
  if (history.length > MAX) history.shift();
  bus.emit('log', entry);
  if (win && !win.isDestroyed()) win.webContents.send('log:entry', entry);
  return entry;
}

module.exports = {
  attach,
  history: () => history.slice(),
  info: (m, meta) => push('info', m, meta),
  ok: (m, meta) => push('ok', m, meta),
  warn: (m, meta) => push('warn', m, meta),
  error: (m, meta) => push('error', m, meta),
  bus
};
