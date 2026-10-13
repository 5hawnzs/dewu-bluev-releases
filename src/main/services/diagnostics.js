'use strict';
// 每个任务独立保留有限的设备命令元数据，不收集指令参数、输出、素材或凭据。
const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();
const allowed = new Set(['query', 'delete', 'scan', 'find', 'ls', 'rm', 'mkdir', 'mv', 'force-stop',
  'dump', 'focus', 'input', 'push', 'devices', 'connect', 'other']);
// 仅提取固定错误类别与长度；设备原文可能包含路径、账号或输入内容，不能直接上云。
const outputKinds = new Set(['permission', 'segfault', 'offline', 'not-found', 'timeout', 'empty-result', 'media-rows', 'other', 'empty']);
function outputKind(result) {
  const value = String(result.stderr || '') + '\n' + (Buffer.isBuffer(result.stdout) ? '' : String(result.stdout || ''));
  if (/permission denied|permission denial|securityexception|not allowed/i.test(value)) return 'permission';
  if (/segmentation fault|segfault/i.test(value)) return 'segfault';
  if (/device offline|device .*not found|no devices|closed|disconnected/i.test(value)) return 'offline';
  if (/no such file|not found|inaccessible/i.test(value) && !/No result found/i.test(value)) return 'not-found';
  if (result.killed) return 'timeout';
  if (/No result found/i.test(value)) return 'empty-result';
  if (/Row: \d+/.test(value)) return 'media-rows';
  return value.trim() ? 'other' : 'empty';
}
function create(client = {}) {
  return { version: String(client.version || '').slice(0, 24), build: Number(client.build) || 0,
    phase: '任务启动', row: 0, commands: [], failures: [], count: 0,
    phaseAt: performance.now(), phaseCount: 0, onPhase: client.onPhase };
}
function flush(state) {
  if (!state || !state.phaseAt) return;
  const now = performance.now();
  const elapsedSec = Math.max(0, (now - state.phaseAt) / 1000);
  // 分阶段记录独立上传，批次再长也不会被末尾几条命令或摘要长度截掉。
  if (state.row > 0 && typeof state.onPhase === 'function') {
    try { state.onPhase({ phase: state.phase, row: state.row, elapsedSec,
      commandCount: state.count - state.phaseCount, version: state.version, build: state.build }); } catch (_) {}
  }
  state.phaseAt = now;
  state.phaseCount = state.count;
}
function phase(name, row = 0) {
  const state = storage.getStore();
  if (state) { flush(state); state.phase = String(name).slice(0, 60); state.row = Number(row) || 0; }
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
      output: outputKind(result), stdoutBytes: Buffer.byteLength(result.stdout || ''),
      stderrBytes: Buffer.byteLength(String(result.stderr || '')),
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
      + '/limit=' + (Number.isFinite(e.timeoutMs) ? Math.max(0, Math.round(e.timeoutMs)) : 0) + '/' + source
      + (outputKinds.has(e.output) ? '/out=' + e.output + '/bytes=' + (Number.isSafeInteger(e.stdoutBytes) ? e.stdoutBytes : 0)
        + ':' + (Number.isSafeInteger(e.stderrBytes) ? e.stderrBytes : 0) : '');
  };
  const failures = (Array.isArray(value.failures) ? value.failures : []).slice(-3).map(encode).filter(Boolean);
  const recent = (Array.isArray(value.commands) ? value.commands : []).slice(-3).map(encode).filter(Boolean);
  return `[诊断 ${version}/${value.build} 步骤=${name} 行=${Number(value.row) || 0} 失败=${failures.join(',') || '无'} 最近=${recent.join(',') || '无'}]`.slice(0, 700);
}
module.exports = { create, run: (state, fn) => storage.run(state, fn), phase, flush, record, snapshot, format };
