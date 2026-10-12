'use strict';
// 每个任务独立保留有限的设备命令元数据，不收集指令参数、输出、素材或凭据。
const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();
const allowed = new Set(['query', 'delete', 'scan', 'find', 'ls', 'rm', 'mkdir', 'mv', 'force-stop',
  'dump', 'focus', 'input', 'push', 'devices', 'connect', 'other']);
function create(client = {}) {
  return { version: String(client.version || '').slice(0, 24), build: Number(client.build) || 0,
    phase: '任务启动', row: 0, commands: [], failures: [], count: 0 };
}
function phase(name, row = 0) {
  const state = storage.getStore();
  if (state) { state.phase = String(name).slice(0, 60); state.row = Number(row) || 0; }
}
function category(args) {
  const cmd = String(args[args.length - 1] || '');
  if (cmd.startsWith('content query ')) return 'query';
  if (cmd.startsWith('content delete ')) return 'delete';
  if (cmd.startsWith('content call ')) return 'scan';
  if (cmd.startsWith('am force-stop ')) return 'force-stop';
  if (/uiautomator|dumpWindowHierarchy/.test(cmd)) return 'dump';
  if (/dumpsys (window|activity)/.test(cmd)) return 'focus';
  for (const verb of ['find', 'ls', 'rm', 'mkdir', 'mv', 'input']) if (cmd.startsWith(verb + ' ')) return verb;
  return args.includes('push') ? 'push' : ['devices', 'connect'].includes(args[0]) ? args[0] : 'other';
}
function record(args, result, ms, source) {
  try {
    const state = storage.getStore();
    if (!state) return;
    const entry = { op: category(args), ms: Math.max(0, Math.round(ms)), ok: !!result.ok,
      code: typeof result.code === 'number' ? result.code : null, killed: !!result.killed,
      signal: /^(SIGTERM|SIGKILL)$/.test(result.signal || '') ? result.signal : '',
      timeoutMs: Number(result.timeoutMs) || 0,
      source: ['bundled', 'configured', 'path', 'configured-missing'].includes(source) ? source : 'unknown',
      phase: state.phase, row: state.row };
    state.count++;
    state.commands.push(entry);
    if (state.commands.length > 6) state.commands.shift();
    if (!entry.ok) { state.failures.push(entry); if (state.failures.length > 4) state.failures.shift(); }
  } catch (_) { /* 诊断记录失败不能影响发布。 */ }
}
function snapshot(state) {
  return { version: state.version, build: state.build, phase: state.phase, row: state.row,
    count: state.count, commands: state.commands.slice(), failures: state.failures.slice() };
}
function format(value) {
  if (!value || !Number.isSafeInteger(value.build) || value.build <= 0) return '';
  const version = /^[0-9A-Za-z.+-]{1,24}$/.test(value.version || '') ? value.version : '?';
  const name = /^[\u4e00-\u9fffA-Za-z0-9 ·_-]{1,60}$/.test(value.phase || '') ? value.phase : '未知步骤';
  const encode = e => {
    if (!e || !allowed.has(e.op)) return '';
    const ms = Number.isFinite(e.ms) ? Math.max(0, Math.round(e.ms)) : 0;
    const code = typeof e.code === 'number' ? e.code : '?';
    const source = ['bundled', 'configured', 'path', 'configured-missing'].includes(e.source) ? e.source : '?';
    return e.op + ':' + ms + 'ms/rc=' + code + (e.killed ? '/killed' : '')
      + (/^(SIGTERM|SIGKILL)$/.test(e.signal || '') ? '/' + e.signal : '')
      + '/limit=' + (Number.isFinite(e.timeoutMs) ? Math.max(0, Math.round(e.timeoutMs)) : 0) + '/' + source;
  };
  const failures = (Array.isArray(value.failures) ? value.failures : []).slice(-3).map(encode).filter(Boolean);
  const recent = (Array.isArray(value.commands) ? value.commands : []).slice(-3).map(encode).filter(Boolean);
  return `[诊断 ${version}/${value.build} 步骤=${name} 行=${Number(value.row) || 0} 失败=${failures.join(',') || '无'} 最近=${recent.join(',') || '无'}]`.slice(0, 700);
}
module.exports = { create, run: (state, fn) => storage.run(state, fn), phase, record, snapshot, format };
